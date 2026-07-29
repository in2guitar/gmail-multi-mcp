#!/usr/bin/env node
// Build the single-file server bundle.
//
// Why a bundle: this project lives in Google Drive, and Drive cannot hold a
// node_modules tree. Syncing ~3,500 dependency files truncated
// @modelcontextprotocol/sdk/package.json to 0 bytes, which broke module resolution
// with a misleading "Invalid package config". Drive also rejects directory junctions
// ("Incorrect function"), so node_modules cannot be redirected off the volume either.
//
// So dependencies are installed on local disk, bundled into one file, and only that
// file is written back to Drive. It needs nothing but Node to run, and there is no
// dependency tree left for sync to corrupt.
//
// src/auth-cli.js is deliberately NOT bundled — it imports only Node built-ins, so it
// runs from Drive as-is.

import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, copyFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const PROJECT = dirname(fileURLToPath(import.meta.url));
const BUILD = join(homedir(), '.node-deps', 'gmail-multi-mcp-build');
const OUTPUT = 'gmail-multi-mcp.mjs';

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.error(`\n${cmd} ${args.join(' ')} failed with status ${r.status}`);
    process.exit(1);
  }
}

console.log(`Staging build in ${BUILD}`);
rmSync(BUILD, { recursive: true, force: true });
mkdirSync(BUILD, { recursive: true });
cpSync(join(PROJECT, 'src'), join(BUILD, 'src'), { recursive: true });
copyFileSync(join(PROJECT, 'package.json'), join(BUILD, 'package.json'));

console.log('Installing dependencies on local disk...');
run('npm', ['install', '--silent'], BUILD);
run('npm', ['install', '--silent', '--no-save', 'esbuild'], BUILD);

console.log('Bundling...');
run(
  'npx',
  [
    'esbuild',
    'src/index.js',
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--target=node20',
    `--outfile=${OUTPUT}`,
  ],
  BUILD
);

copyFileSync(join(BUILD, OUTPUT), join(PROJECT, OUTPUT));
const { size } = statSync(join(PROJECT, OUTPUT));
console.log(`\nWrote ${join(PROJECT, OUTPUT)} (${(size / 1024 / 1024).toFixed(1)} MB)`);
console.log('Restart Claude Desktop to pick up the new build.');
