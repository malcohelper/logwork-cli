#!/usr/bin/env node

import { confirm, isCancel } from '@clack/prompts';
import { isMainModule } from './lib/entrypoint.mjs';
import {
  checkForUpdates,
  installUpdate,
  parseSemver
} from './lib/update-service.mjs';

export function parseUpdateArgs(argv) {
  const args = [...argv];
  let command = 'check';
  let force = false;
  let json = false;
  let yes = false;
  let version;
  let help = false;

  if (args[0] && !args[0].startsWith('-')) {
    command = args.shift();
  }
  if (!['check', 'install'].includes(command)) {
    throw new Error(`Unknown update command: ${command}. Use check or install.`);
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--force') {
      force = true;
      continue;
    }
    if (arg === '--yes' || arg === '-y') {
      yes = true;
      continue;
    }
    if (arg === '--version') {
      version = args[index + 1];
      if (!version) {
        throw new Error('--version requires an exact SemVer value.');
      }
      index += 1;
      continue;
    }
    if (arg.startsWith('--version=')) {
      version = arg.slice('--version='.length);
      continue;
    }
    throw new Error(`Unknown update option: ${arg}`);
  }

  if (command === 'check' && (yes || version)) {
    throw new Error('--yes and --version are only valid with update install.');
  }
  if (command === 'install' && force) {
    throw new Error('--force is only valid with update check; install always checks npm again.');
  }
  if (version && !parseSemver(version)) {
    throw new Error('--version must be an exact SemVer value such as 1.2.3.');
  }

  return { command, force, json, yes, version, help };
}

export async function runUpdateCli(argv, {
  checkForUpdatesFn = checkForUpdates,
  installUpdateFn = installUpdate,
  promptConfirm = defaultConfirm,
  isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  output = process.stdout
} = {}) {
  const options = parseUpdateArgs(argv);
  if (options.help) {
    output.write(`${formatUpdateHelp()}\n`);
    return 0;
  }

  if (options.command === 'check') {
    const result = await checkForUpdatesFn({ force: options.force });
    printResult(output, result, options.json);
    return 0;
  }

  const latest = await checkForUpdatesFn({
    force: true,
    allowStaleOnError: false
  });
  const targetVersion = options.version || latest.latestVersion;
  if (targetVersion !== latest.latestVersion) {
    throw new Error(`Only the npm latest version can be installed. Requested ${targetVersion}; latest is ${latest.latestVersion}.`);
  }
  if (!latest.updateAvailable) {
    printResult(output, latest, options.json);
    return 0;
  }

  let approved = options.yes;
  if (!approved) {
    if (!isTTY) {
      throw new Error('Interactive confirmation is unavailable. Re-run with --yes to install the update.');
    }
    approved = await promptConfirm(`Install Logwork Helper ${targetVersion}?`);
  }
  if (!approved) {
    output.write('Update cancelled.\n');
    return 0;
  }

  const result = await installUpdateFn({
    version: targetVersion,
    confirm: true,
    stdio: options.json ? 'pipe' : 'inherit'
  });
  printResult(output, result, options.json);
  return 0;
}

export function formatUpdateHelp() {
  return `Usage:
  logwork-helper update check [--force] [--json]
  logwork-helper update install [--version <semver>] [--yes] [--json]

Commands:
  check    Compare the installed version with npm latest. Results are cached for 24 hours.
  install  Re-check npm latest, install that exact version, and verify the local runtime.

Options:
  --force              Ignore the update cache when checking
  --version <semver>   Install only when this exact version is npm latest
  -y, --yes            Skip the interactive install confirmation
  --json               Print structured JSON output
  -h, --help           Show this help`;
}

async function defaultConfirm(message) {
  const result = await confirm({
    message,
    initialValue: false
  });
  return !isCancel(result) && result === true;
}

function printResult(output, result, json) {
  if (json) {
    output.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  output.write(`${result.summary}\n`);
  if (result.updateAvailable) {
    output.write(`Release: ${result.releaseUrl}\n`);
    output.write('Install: logwork-helper update install\n');
  }
  if (result.warning) {
    output.write(`Warning: ${result.warning}\n`);
  }
}

if (isMainModule(import.meta.url)) {
  runUpdateCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
