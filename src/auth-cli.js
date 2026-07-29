#!/usr/bin/env node
// One-time authorization flow. Run once per account.
//
// Usage — run it with no arguments and answer the prompts:
//   node src/auth-cli.js
//
// Flags also work for non-interactive use, but call node directly, NOT
// `npm run auth --`: npm's PowerShell shim strips flag names and forwards only
// their values, so the script sees positional junk and bails.
//   node src/auth-cli.js --account work --client-id <id> --client-secret <secret>
//
// Each Workspace org needs its own OAuth client, created as an Internal app in that
// org's GCP project, with http://127.0.0.1:<port> as an authorized redirect URI.
// Internal apps skip Google verification and issue refresh tokens that do not expire.

import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SCOPES, STORE_PATH, saveAccounts } from './oauth.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// Ask Gmail who this is, NOT the oauth2 userinfo endpoint: userinfo needs the
// userinfo.email/openid scope, which we deliberately do not request, so it returns
// nothing and leaves the account record without an email.
const PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';
const PORT = Number(process.env.GMAIL_MULTI_AUTH_PORT || 8765);
const REDIRECT_URI = `http://127.0.0.1:${PORT}`;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

/**
 * Terminal prompts, reading one line at a time.
 *
 * Anything missing from argv is asked for here rather than required as a flag: npm's
 * PowerShell shim strips flag NAMES and forwards only their values, so
 * `npm run auth -- --account x` arrives as `auth-cli.js x`. Prompting sidesteps shell
 * quoting entirely, and keeps the client secret out of shell history.
 *
 * Two failure modes to avoid, both hit during development:
 *   - Draining stdin up front (`for await (const line of rl)`) blocks until EOF,
 *     which never arrives in an interactive session — the script hangs with no
 *     prompt and no listener.
 *   - Repeated `rl.question` over a pipe loses input, because readline emits every
 *     buffered line the moment it arrives and questions asked later find nothing.
 *
 * Pulling the async iterator on demand handles both: readline applies backpressure,
 * so nothing is discarded and nothing waits for EOF. The cost is that typed input is
 * always echoed — there is no masked entry. Values still never reach shell history,
 * which was the point.
 */
function makePrompter() {
  const isTty = Boolean(process.stdin.isTTY);
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: isTty });
  const lines = rl[Symbol.asyncIterator]();

  const ask = async (question) => {
    process.stdout.write(question);
    const { value, done } = await lines.next();
    if (done) throw new Error('Input ended before all values were supplied. Nothing was saved.');
    const answer = String(value ?? '').trim();
    if (!isTty) process.stdout.write(`${answer}\n`); // echo for logs when piped
    return answer;
  };

  return { ask, close: () => rl.close() };
}

let accountKey = arg('account');
let clientId = arg('client-id');
let clientSecret = arg('client-secret');

if (!accountKey || !clientId || !clientSecret) {
  console.log(
    `\nAuthorizing a Google Workspace account for gmail-multi-mcp.\n` +
      `Create the OAuth client first: Internal app, Desktop type.\n` +
      `Values are read from this prompt, so nothing lands in shell history.\n`
  );
  // One interface for every question — tearing one down between prompts can discard
  // input that is already buffered.
  const p = makePrompter();
  try {
    if (!accountKey) accountKey = await p.ask('Short account key (e.g. work): ');
    if (!clientId) clientId = await p.ask('Client ID (ends .apps.googleusercontent.com): ');
    if (!clientSecret) clientSecret = await p.ask('Client secret: ');
  } finally {
    p.close();
  }
}

if (!accountKey || !clientId || !clientSecret) {
  console.error('\nAll three values are required. Nothing was saved.');
  process.exit(1);
}

if (!clientId.endsWith('.apps.googleusercontent.com')) {
  console.error(
    `\nThat client ID looks wrong — it should end in ".apps.googleusercontent.com".\n` +
      `Got: ${clientId}\nNothing was saved.`
  );
  process.exit(1);
}

const state = randomBytes(16).toString('hex');
const authUrl = new URL(AUTH_URL);
authUrl.searchParams.set('client_id', clientId);
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', SCOPES.join(' '));
authUrl.searchParams.set('access_type', 'offline');
authUrl.searchParams.set('prompt', 'consent'); // force a refresh token even on re-auth
authUrl.searchParams.set('state', state);

const code = await new Promise((resolve, reject) => {
  const srv = createServer((req, res) => {
    const url = new URL(req.url, REDIRECT_URI);
    if (url.pathname !== '/') {
      res.writeHead(404).end();
      return;
    }
    const err = url.searchParams.get('error');
    const got = url.searchParams.get('code');
    const gotState = url.searchParams.get('state');

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (err) {
      res.end(`<p>Authorization failed: ${err}. You can close this tab.</p>`);
      srv.close();
      reject(new Error(`Authorization failed: ${err}`));
      return;
    }
    if (gotState !== state) {
      res.end('<p>State mismatch — possible CSRF. You can close this tab.</p>');
      srv.close();
      reject(new Error('State parameter mismatch'));
      return;
    }
    res.end('<p>Authorized. You can close this tab and return to the terminal.</p>');
    srv.close();
    resolve(got);
  });

  // Never hang silently: a stalled wait here is indistinguishable from a hung script.
  const timeout = setTimeout(() => {
    srv.close();
    reject(
      new Error(
        `No redirect received within 5 minutes on ${REDIRECT_URI}.\n` +
          `If the browser showed an error, that error is the real problem — not this timeout.\n` +
          `If it showed "site can't be reached", make sure no OLD browser tab from a ` +
          `previous attempt was reused; each run needs the freshly opened URL.`
      )
    );
  }, 5 * 60 * 1000);
  timeout.unref?.();

  srv.on('close', () => clearTimeout(timeout));

  srv.on('error', (e) => {
    reject(
      e.code === 'EADDRINUSE'
        ? new Error(
            `Port ${PORT} is already in use. Close whatever is using it, or set ` +
              `GMAIL_MULTI_AUTH_PORT to a free port and add that redirect URI if your ` +
              `client is a Web application type.`
          )
        : e
    );
  });

  srv.listen(PORT, '127.0.0.1', async () => {
    const url = authUrl.toString();

    // The URL is long enough to wrap in a terminal, and a half-copied URL is the most
    // common reason this step fails. So open it directly and leave a file as a fallback
    // rather than relying on copy-paste.
    const linkFile = join(tmpdir(), 'gmail-multi-mcp-auth-url.txt');
    await writeFile(linkFile, url, 'utf8').catch(() => {});

    console.log(`\nOpening your browser. Sign in as the account you are adding.\n`);
    console.log(`If it does not open, the URL is saved as a single line here:`);
    console.log(`  ${linkFile}\n`);
    console.log(`Waiting for the redirect on ${REDIRECT_URI} ...`);

    // NEVER route the URL through `cmd /c start`. cmd treats & as a command separator,
    // so the URL is cut at the first query parameter and the browser receives only
    // client_id — Google then rejects it with "Required parameter is missing:
    // response_type". Quoting does not save it either, because Node's argument
    // escaping and cmd's metacharacter layer disagree. rundll32 is exec'd directly
    // with no shell in between, so the URL arrives intact.
    try {
      if (process.platform === 'win32') {
        spawn('rundll32', ['url.dll,FileProtocolHandler', url], {
          detached: true,
          stdio: 'ignore',
        }).unref();
      } else if (process.platform === 'darwin') {
        spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
      }
    } catch {
      console.log('\n(Could not launch a browser automatically — open the file above.)');
    }
  });
});

const tokenRes = await fetch(TOKEN_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
  }),
});
const tokens = await tokenRes.json();
if (!tokenRes.ok) {
  throw new Error(`Token exchange failed: ${tokens.error_description || tokens.error}`);
}
if (!tokens.refresh_token) {
  throw new Error(
    'Google returned no refresh token. Revoke the app at ' +
      'https://myaccount.google.com/permissions and run this again.'
  );
}

const profileRes = await fetch(PROFILE_URL, {
  headers: { Authorization: `Bearer ${tokens.access_token}` },
});
const who = await profileRes.json().catch(() => ({}));
if (!profileRes.ok || !who.emailAddress) {
  throw new Error(
    `Authorized, but could not read the mailbox address: ` +
      `${who?.error?.message || `HTTP ${profileRes.status}`}. Nothing was saved.`
  );
}

let existing = {};
try {
  existing = JSON.parse(await readFile(STORE_PATH, 'utf8'));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

existing[accountKey] = {
  email: who.emailAddress,
  client_id: clientId,
  client_secret: clientSecret,
  refresh_token: tokens.refresh_token,
};
await saveAccounts(existing);

console.log(`\nSaved account "${accountKey}" (${who.emailAddress}) to ${STORE_PATH}`);
console.log(`Configured accounts: ${Object.keys(existing).join(', ')}`);
