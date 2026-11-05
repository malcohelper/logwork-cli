#!/usr/bin/env node

import {
  getStoredJiraStatus,
  loginJira,
  logoutJira,
  safeJiraAuthError
} from './lib/jira-auth.mjs';
import { credentialStoreLabel } from './lib/credential-store.mjs';
import { isMainModule } from './lib/entrypoint.mjs';

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  if (command === 'login') {
    const options = parseJiraLoginArgs(args);
    const result = await runJiraLoginCommand(options);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === 'status') {
    const result = await getStoredJiraStatus();
    console.log(result.summary);
    process.exitCode = result.authenticated ? 0 : 1;
    return;
  }

  if (command === 'logout') {
    const result = await logoutJira();
    console.log(result.summary);
    return;
  }

  throw new Error(`Unknown jira command: ${command}`);
}

export async function runJiraLoginCommand({
  baseUrl,
  login = loginJira,
  stdout = console.log,
  stderr = console.error
} = {}) {
  stdout('Starting Jira PAT auth. Paste the token in this terminal; it is stored only in the OS credential store.');

  try {
    const result = await login({
      ...(baseUrl ? { baseUrl } : {})
    });
    stdout(result.summary);
    return {
      ok: true,
      result
    };
  } catch (error) {
    const safeError = safeJiraAuthError(error);
    stderr(safeError.message);
    return {
      ok: false,
      error: safeError
    };
  }
}

export function parseJiraLoginArgs(args = []) {
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--help' || arg === '-h') {
      continue;
    }

    if (arg === '--base-url') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--base-url requires a value.');
      }
      options.baseUrl = value;
      index += 1;
      continue;
    }

    if (arg.startsWith('--base-url=')) {
      const value = arg.slice('--base-url='.length);
      if (!value) {
        throw new Error('--base-url requires a value.');
      }
      options.baseUrl = value;
      continue;
    }

    throw new Error(`Unknown jira login option: ${arg}`);
  }

  return options;
}

function printHelp() {
  const storeLabel = credentialStoreLabel();
  console.log(`Usage:
  logwork-helper jira login [--base-url <url>]
  logwork-helper jira status
  logwork-helper jira logout

Commands:
  login   Save a Jira Personal Access Token to ${storeLabel}
  status  Show stored Jira auth status without printing token
  logout  Delete stored Jira PAT from ${storeLabel}

Options:
  --base-url <url>  Jira base URL. Defaults to https://jira-vnv.vinova.sg
`);
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
