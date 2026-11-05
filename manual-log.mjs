#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config.mjs';
import { isMainModule } from './lib/entrypoint.mjs';
import { runManualRepl } from './lib/manual-repl.mjs';
import { checkForUpdates, formatUpdateNotice } from './lib/update-service.mjs';
import { safeJsonParse, nowIso } from './lib/util.mjs';

const helperDir = dirname(fileURLToPath(import.meta.url));

async function main() {
  const { message, help, mode } = parseManualArgs(process.argv.slice(2));
  if (help) {
    printHelp();
    return;
  }

  if (mode === 'repl') {
    const updateNotice = process.stdin.isTTY && process.stdout.isTTY
      ? await getStartupUpdateNotice()
      : '';
    await runManualRepl({
      cwd: resolve(process.cwd()),
      updateNotice
    });
    return;
  }

  await runQuickManual({ message });
}

export async function getStartupUpdateNotice({ checkForUpdatesFn = checkForUpdates } = {}) {
  try {
    return formatUpdateNotice(await checkForUpdatesFn());
  } catch {
    return '';
  }
}

export async function runQuickManual({ message = '' } = {}) {
  const runDir = await fs.mkdtemp(join(tmpdir(), 'logwork-manual-'));
  const nonce = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const msgFile = join(runDir, 'COMMIT_EDITMSG');
  const lockFile = join(runDir, 'logwork.lock');
  const resultFile = join(runDir, 'logwork.result');
  const terminalTitle = `Logwork Helper Manual ${nonce}`;

  await fs.writeFile(msgFile, `${message || 'Work update'}\n`, 'utf8');
  await fs.writeFile(lockFile, JSON.stringify({
    nonce,
    pid: process.pid,
    created_at: nowIso(),
    manual: true
  }, null, 2), 'utf8');

  const helperArgs = [
    join(helperDir, 'logwork-helper.mjs'),
    '--repo', resolve(process.cwd()),
    '--msg-file', msgFile,
    '--lock', lockFile,
    '--result', resultFile,
    '--nonce', nonce,
    '--terminal-title', terminalTitle,
    '--close-terminal', 'false'
  ];

  const exitCode = await runNode(helperArgs);
  const result = await readResult(resultFile);

  if (!result) {
    process.exitCode = exitCode || 1;
    return;
  }

  if (result.nonce !== nonce) {
    console.error('Logwork Helper: result nonce mismatch.');
    process.exitCode = 1;
    return;
  }

  process.exitCode = result.status === CONFIG.resultValues.ok || result.status === CONFIG.resultValues.skip
    ? 0
    : 1;
}

export function parseManualArgs(argv) {
  if (argv[0] === 'quick') {
    return {
      ...parseQuickArgs(argv.slice(1)),
      mode: 'quick'
    };
  }

  if (argv.length === 0) {
    return {
      mode: 'repl',
      message: '',
      help: false
    };
  }

  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    return {
      mode: 'repl',
      message: '',
      help: true
    };
  }

  return {
    ...parseQuickArgs(argv),
    mode: 'quick'
  };
}

function parseQuickArgs(argv) {
  let message = '';
  let help = false;
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }

    if (arg === '--message' || arg === '-m') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error(`${arg} requires a value.`);
      }
      message = value;
      i += 1;
      continue;
    }

    if (arg.startsWith('--message=')) {
      message = arg.slice('--message='.length);
      continue;
    }

    positional.push(arg);
  }

  if (!message && positional.length) {
    message = positional.join(' ');
  }

  return { message, help };
}

function runNode(args) {
  return new Promise((resolveValue, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: helperDir,
      stdio: 'inherit',
      env: process.env
    });

    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (signal) {
        resolveValue(1);
        return;
      }
      resolveValue(code ?? 1);
    });
  });
}

async function readResult(resultFile) {
  try {
    const text = await fs.readFile(resultFile, 'utf8');
    return safeJsonParse(text, null);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function printHelp() {
  console.log(`Usage:
  logwork
  logwork-helper manual
  logwork-helper manual quick --message "Fix login bug"
  logwork-helper manual quick "Fix login bug"

Preferred shortcut:
  logwork

Options:
  -h, --help              Show this help

Quick mode options:
  -m, --message <text>    Default task message

REPL commands:
  Type / for live command suggestions.
  /help
  /query today
  /query yesterday
  /query this-week
  /query last-week
  /query this-month
  /query last-month
  /logwork
  /logwork ro
  /logwork jira
  /logwork both
  /edit-logwork 290364 --hours 0.5
  /mcp
  /projects
  /projects 5234
  /map SCB 5234

Updates:
  logwork-helper update check
  logwork-helper update install

Press Esc to exit the manual CLI.
`);
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
