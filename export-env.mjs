#!/usr/bin/env node
// Copy the account credentials to the clipboard as base64, for pasting into the
// GMAIL_MULTI_ACCOUNTS environment variable on a Claude Code cloud environment.
//
// Cloud sessions cannot see ~/.gmail-multi-mcp/accounts.json, so credentials reach
// them through that variable instead. Base64 rather than raw JSON so the value
// survives any shell or form field that would otherwise mangle the quotes.
//
// The value is never printed — it goes straight to the clipboard.

import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const STORE = join(homedir(), '.gmail-multi-mcp', 'accounts.json');

let raw;
try {
  raw = await readFile(STORE, 'utf8');
} catch {
  console.error(`No credentials found at ${STORE}. Run "npm run auth" first.`);
  process.exit(1);
}

const accounts = JSON.parse(raw);
const b64 = Buffer.from(raw, 'utf8').toString('base64');

const clip =
  process.platform === 'win32'
    ? spawnSync('powershell', ['-NoProfile', '-Command', 'Set-Clipboard -Value $input'], { input: b64 })
    : process.platform === 'darwin'
      ? spawnSync('pbcopy', [], { input: b64 })
      : spawnSync('xclip', ['-selection', 'clipboard'], { input: b64 });

console.log(`Accounts: ${Object.keys(accounts).join(', ')}`);
console.log(`Encoded ${b64.length} characters.`);

if (clip.status === 0) {
  console.log('\nCopied to clipboard. Paste it as the value of GMAIL_MULTI_ACCOUNTS');
  console.log('on your cloud environment at claude.ai/code.');
} else {
  console.error('\nCould not reach the clipboard. Writing to a file instead:');
  const out = join(homedir(), '.gmail-multi-mcp', 'cloud-env-value.txt');
  await (await import('node:fs/promises')).writeFile(out, b64, { mode: 0o600 });
  console.error(`  ${out}`);
  console.error('Delete that file once you have pasted the value.');
}
