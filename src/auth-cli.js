#!/usr/bin/env node
// One-time authorization flow. Run once per account.
//
// Usage:
//   npm run auth -- --account indelible --client-id <id> --client-secret <secret>
//
// Each Workspace org needs its own OAuth client, created as an Internal app in that
// org's GCP project, with http://127.0.0.1:<port> as an authorized redirect URI.
// Internal apps skip Google verification and issue refresh tokens that do not expire.

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SCOPES, STORE_PATH, saveAccounts } from './oauth.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const PORT = Number(process.env.GMAIL_MULTI_AUTH_PORT || 8765);
const REDIRECT_URI = `http://127.0.0.1:${PORT}`;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const accountKey = arg('account');
const clientId = arg('client-id');
const clientSecret = arg('client-secret');

if (!accountKey || !clientId || !clientSecret) {
  console.error(
    'Usage: npm run auth -- --account <name> --client-id <id> --client-secret <secret>\n\n' +
      `Add ${REDIRECT_URI} as an authorized redirect URI on the OAuth client first.\n` +
      '(Override the port with GMAIL_MULTI_AUTH_PORT.)'
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

    try {
      if (process.platform === 'win32') {
        spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
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

const who = await fetch(USERINFO_URL, {
  headers: { Authorization: `Bearer ${tokens.access_token}` },
}).then((r) => r.json());

let existing = {};
try {
  existing = JSON.parse(await readFile(STORE_PATH, 'utf8'));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

existing[accountKey] = {
  email: who.email,
  client_id: clientId,
  client_secret: clientSecret,
  refresh_token: tokens.refresh_token,
};
await saveAccounts(existing);

console.log(`\nSaved account "${accountKey}" (${who.email}) to ${STORE_PATH}`);
console.log(`Configured accounts: ${Object.keys(existing).join(', ')}`);
