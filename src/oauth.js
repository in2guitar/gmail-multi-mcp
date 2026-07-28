// OAuth token store and access-token minting.
//
// Each Workspace org needs its OWN OAuth client, created as an "Internal" app in
// that org's GCP project. Internal apps skip Google verification and their refresh
// tokens do not expire. An External app in Testing mode expires refresh tokens after
// 7 days, and External + Published requires an annual CASA Tier-2 assessment because
// the Gmail scopes below are "restricted". So: one client per org, all Internal.
//
// Accounts are therefore keyed by client_id + refresh_token together, never globally.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export const STORE_DIR = process.env.GMAIL_MULTI_MCP_HOME || join(homedir(), '.gmail-multi-mcp');
export const STORE_PATH = join(STORE_DIR, 'accounts.json');

// gmail.compose covers drafts create/update/send AND message send.
// gmail.settings.basic is needed to read the send-as alias list, which we require
// before setting any From header.
export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.settings.basic',
];

const REQUIRED_FIELDS = ['email', 'client_id', 'client_secret', 'refresh_token'];

/** In-memory access-token cache: accountKey -> { token, expiresAt }. */
const tokenCache = new Map();

/** True when accounts came from the environment and there is no file to write back to. */
let storeIsReadOnly = false;

function parseAccounts(raw, source) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${source} is not valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${source} must be a JSON object keyed by account name`);
  }
  for (const [key, account] of Object.entries(parsed)) {
    const missing = REQUIRED_FIELDS.filter((f) => !account?.[f]);
    if (missing.length) {
      throw new Error(`Account "${key}" in ${source} is missing: ${missing.join(', ')}`);
    }
  }
  return parsed;
}

/**
 * Load the account map. Environment wins over the file so cloud routines can supply
 * credentials without a writable home directory.
 */
export async function loadAccounts() {
  const fromEnv = process.env.GMAIL_MULTI_ACCOUNTS;
  if (fromEnv) {
    storeIsReadOnly = true;
    // Accept raw JSON or base64, so the value survives shells that mangle quotes.
    const raw = fromEnv.trimStart().startsWith('{')
      ? fromEnv
      : Buffer.from(fromEnv, 'base64').toString('utf8');
    return parseAccounts(raw, 'GMAIL_MULTI_ACCOUNTS');
  }

  storeIsReadOnly = false;
  let raw;
  try {
    raw = await readFile(STORE_PATH, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        `No accounts configured. Expected ${STORE_PATH} or the GMAIL_MULTI_ACCOUNTS env var.\n` +
          `Run: npm run auth -- --account <name> --client-id <id> --client-secret <secret>`
      );
    }
    throw err;
  }
  return parseAccounts(raw, STORE_PATH);
}

/** Persist the account map to disk with owner-only permissions. */
export async function saveAccounts(accounts) {
  if (storeIsReadOnly) return; // credentials came from env; nothing to write back to
  await mkdir(STORE_DIR, { recursive: true, mode: 0o700 });
  await writeFile(STORE_PATH, JSON.stringify(accounts, null, 2), { mode: 0o600 });
}

/**
 * Exchange a refresh token for an access token, caching until shortly before expiry.
 *
 * Google can rotate the refresh token on this call. If we do not write the new one
 * back, the account silently stops working the next time the cache is cold — so a
 * rotated token is persisted immediately.
 */
export async function getAccessToken(accounts, key) {
  const account = accounts[key];
  if (!account) {
    throw new Error(`Unknown account "${key}". Configured: ${Object.keys(accounts).join(', ') || '(none)'}`);
  }

  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: account.client_id,
      client_secret: account.client_secret,
      refresh_token: account.refresh_token,
      grant_type: 'refresh_token',
    }),
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = payload.error_description || payload.error || `HTTP ${res.status}`;
    if (payload.error === 'invalid_grant') {
      throw new Error(
        `Refresh token for "${key}" (${account.email}) is no longer valid: ${detail}. ` +
          `Re-authorize with: npm run auth -- --account ${key}`
      );
    }
    throw new Error(`Token refresh failed for "${key}": ${detail}`);
  }

  if (payload.refresh_token && payload.refresh_token !== account.refresh_token) {
    account.refresh_token = payload.refresh_token;
    await saveAccounts(accounts);
  }

  tokenCache.set(key, {
    token: payload.access_token,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
  });
  return payload.access_token;
}
