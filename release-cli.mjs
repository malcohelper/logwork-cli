#!/usr/bin/env node

import { isMainModule } from './lib/entrypoint.mjs';
import {
  formatReleaseDoctorReport,
  runReleaseDoctor
} from './lib/release-doctor.mjs';

export function parseReleaseArgs(args = []) {
  const [command, ...rest] = args;
  if (!command || command === '--help' || command === '-h') {
    return {
      type: 'help'
    };
  }

  if (command !== 'doctor') {
    throw new Error(`Unknown release command: ${command}`);
  }

  const options = {
    type: 'doctor',
    full: false
  };
  for (const arg of rest) {
    if (arg === '--full') {
      options.full = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      return {
        type: 'help'
      };
    }
    throw new Error(`Unknown release doctor option: ${arg}`);
  }

  return options;
}

export async function runReleaseCommand({
  args = process.argv.slice(2),
  stdout = console.log,
  stderr = console.error,
  runDoctor = runReleaseDoctor
} = {}) {
  const parsed = parseReleaseArgs(args);
  if (parsed.type === 'help') {
    stdout(formatReleaseHelp());
    return 0;
  }

  const result = await runDoctor({
    full: parsed.full
  });
  stdout(formatReleaseDoctorReport(result));
  if (!result.ok) {
    stderr('Release doctor found blocking issues.');
    return 1;
  }
  return 0;
}

function formatReleaseHelp() {
  return `Usage:
  logwork-helper release doctor [--full]

Checks release readiness before npm/GitHub publishing.

Commands:
  doctor    Check version, git state, npm auth, GitHub auth, tags, and artifacts

Options:
  --full    Also run npm test, npm audit, npm pack --dry-run, and git diff --check
`;
}

if (isMainModule(import.meta.url)) {
  runReleaseCommand().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
