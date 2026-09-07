#!/usr/bin/env node

import { exec } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getPackageJson() {
  const pkgPath = path.resolve(__dirname, '../package.json');
  if (fs.existsSync(pkgPath)) {
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  }
  return { version: '0.1.0' };
}

function printHelp() {
  console.log(`
wacli-mission-control - Local WhatsApp operator console powered by wacli

Usage:
  npx wacli-mission-control [options]
  wacli-mission-control [options]

Options:
  -p, --port <number>    Port to listen on (default: 3002, or env PORT)
  --no-sync              Disable automatic wacli sync supervisor
  -o, --open             Open browser automatically after startup
  -v, --version          Show version number
  -h, --help             Show this help message

Environment Variables:
  PORT                   Port to listen on (default: 3002)
  WACLI_DISABLE_SYNC     Set to 1 to disable sync supervisor

Mission Control always binds 127.0.0.1. It holds a live WhatsApp session and
authenticates nothing, so "the request came from this machine" is the whole of
its access control.
`);
}

function openBrowser(url) {
  const startCmd =
    process.platform === 'darwin'
      ? `open "${url}"`
      : process.platform === 'win32'
      ? `start "${url}"`
      : `xdg-open "${url}"`;

  exec(startCmd, (err) => {
    if (err) {
      console.warn(`Failed to open browser automatically: ${err.message}`);
    }
  });
}

const args = process.argv.slice(2);
let openAfterStart = false;
let port = process.env.PORT ? Number(process.env.PORT) : 3002;

/**
 * Not configurable, and deliberately so. The server binds this and nothing
 * else, so a `--host` flag could only ever have moved the banner — which is
 * exactly what it used to do: `--host 0.0.0.0` printed a URL, and opened a
 * browser at, an address the server was never listening on. The loopback bind
 * is the console's access control, not a default worth overriding.
 */
const HOST = '127.0.0.1';

for (let i = 0; i < args.length; i++) {
  const arg = args[i];

  if (arg === '--help' || arg === '-h') {
    printHelp();
    process.exit(0);
  }

  if (arg === '--version' || arg === '-v') {
    const pkg = getPackageJson();
    console.log(`wacli-mission-control v${pkg.version}`);
    process.exit(0);
  }

  if (arg === '--port' || arg === '-p') {
    const val = Number(args[++i]);
    if (isNaN(val) || val <= 0 || val > 65535) {
      console.error(`Invalid port: ${args[i]}`);
      process.exit(1);
    }
    port = val;
    process.env.PORT = String(port);
  } else if (arg.startsWith('--port=')) {
    const val = Number(arg.split('=')[1]);
    if (isNaN(val) || val <= 0 || val > 65535) {
      console.error(`Invalid port: ${arg}`);
      process.exit(1);
    }
    port = val;
    process.env.PORT = String(port);
  } else if (arg === '--no-sync') {
    process.env.WACLI_DISABLE_SYNC = '1';
  } else if (arg === '--open' || arg === '-o') {
    openAfterStart = true;
  }
}

// Locate and import compiled API entrypoint
const possibleEntrypoints = [
  path.resolve(__dirname, '../apps/api/dist/index.js'),
  path.resolve(__dirname, './apps/api/dist/index.js'),
];

let entrypoint = null;
for (const p of possibleEntrypoints) {
  if (fs.existsSync(p)) {
    entrypoint = p;
    break;
  }
}

if (!entrypoint) {
  console.error('Error: compiled backend not found. Please run "npm run build" first.');
  process.exit(1);
}

// Start server
const url = `http://${HOST}:${port}`;
console.log(`
┌──────────────────────────────────────────────────────────────┐
│                    wacli Mission Control                     │
│          Local WhatsApp operator console for wacli           │
├──────────────────────────────────────────────────────────────┤
│  ➜  Console UI:  ${url.padEnd(41)} │
│  ➜  API Health:  ${`${url}/api/health`.padEnd(41)} │
└──────────────────────────────────────────────────────────────┘
`);

try {
  await import(entrypoint);
  if (openAfterStart) {
    setTimeout(() => openBrowser(url), 500);
  }
} catch (err) {
  console.error('Failed to start wacli-mission-control:', err);
  process.exit(1);
}
