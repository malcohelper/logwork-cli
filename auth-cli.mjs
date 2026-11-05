#!/usr/bin/env node

import {
  getStoredAuthStatus,
  loginResourceOptimiser,
  logoutResourceOptimiser
} from './lib/auth.mjs';
import { authenticateWithApiSession } from './lib/api-auth.mjs';
import { createAuthDiagnosticsRecorder } from './lib/auth-diagnostics.mjs';
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
    parseLoginArgs(args);
    const result = await runLoginCommand();
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === 'status') {
    const result = await getStoredAuthStatus();
    console.log(result.summary);
    process.exitCode = result.authenticated ? 0 : 1;
    return;
  }

  if (command === 'logout') {
    const result = await logoutResourceOptimiser();
    console.log(result.summary);
    return;
  }

  throw new Error(`Unknown auth command: ${command}`);
}

export async function runLoginCommand({
  login = loginResourceOptimiser,
  createRecorder = createAuthDiagnosticsRecorder,
  stdout = console.log,
  stderr = console.error
} = {}) {
  stdout('Starting Resource Optimiser API auth. Secrets are requested in this terminal and are not stored.');
  const diagnosticsRecorder = createRecorder();

  try {
    const result = await login({
      authenticator: (options) => authenticateWithApiSession({
        ...options,
        diagnosticsRecorder
      })
    });
    stdout(result.summary);
    return {
      ok: true,
      result
    };
  } catch (error) {
    stderr(error.message);
    try {
      const written = await diagnosticsRecorder.writeFailure(error);
      stderr(`Auth failed. Sanitized diagnostics saved to ${written.path}. Attempt: ${written.attemptId}`);
    } catch (writeError) {
      stderr(`Auth failed. Unable to write sanitized diagnostics: ${writeError.message}`);
    }
    return {
      ok: false,
      error
    };
  }
}

function printHelp() {
  const storeLabel = credentialStoreLabel();
  console.log(`Usage:
  logwork-helper auth login
  logwork-helper auth status
  logwork-helper auth logout

Commands:
  login   Authenticate Resource Optimiser through Keycloak APIs and save token to ${storeLabel}
  status  Show stored auth status without printing token
  logout  Delete stored Resource Optimiser token from ${storeLabel}
`);
}

export function parseLoginArgs(args = []) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--api-mode') {
      continue;
    }

    if (arg === '--browser' || arg.startsWith('--browser=')) {
      throw new Error('Browser auth has been removed. Run `logwork-helper auth login` for API-only auth.');
    }

    if (arg === '--browser-mode') {
      throw new Error('Browser auth has been removed. Run `logwork-helper auth login` for API-only auth.');
    }

    if (arg === 'record') {
      throw new Error('Auth recording has been removed because auth is API-only.');
    }

    if (arg === '--help' || arg === '-h') {
      continue;
    }

    throw new Error(`Unknown auth login option: ${arg}`);
  }

  return { mode: 'api' };
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
