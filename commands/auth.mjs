import {
  getStoredAuthStatus,
  loginResourceOptimiser,
  logoutResourceOptimiser
} from '../lib/auth.mjs';
import { authenticateWithApiSession } from '../lib/api-auth.mjs';
import { createAuthDiagnosticsRecorder } from '../lib/auth-diagnostics.mjs';
import { credentialStoreLabel } from '../lib/credential-store.mjs';
import {
  getStoredJiraStatus,
  loginJira,
  logoutJira,
  safeJiraAuthError
} from '../lib/jira-auth.mjs';

// `logwork login|logout|status [ro|jira]`. Resource Optimiser is the default
// target. Secrets are only ever typed in this terminal and stored in the OS
// credential store; they are never accepted as arguments.

export async function runLogin(argv = []) {
  const { target, args } = splitTarget(argv);
  if (wantsHelp(args)) {
    console.log(formatAuthHelp());
    return 0;
  }
  if (target === 'jira') {
    const result = await runJiraLoginCommand(parseJiraLoginArgs(args));
    return result.ok ? 0 : 1;
  }
  parseLoginArgs(args);
  const result = await runLoginCommand();
  return result.ok ? 0 : 1;
}

export async function runLogout(argv = []) {
  const { target, args } = splitTarget(argv);
  if (wantsHelp(args)) {
    console.log(formatAuthHelp());
    return 0;
  }
  assertNoArgs(args, 'logout');
  const result = target === 'jira' ? await logoutJira() : await logoutResourceOptimiser();
  console.log(result.summary);
  return 0;
}

export async function runStatus(argv = []) {
  if (wantsHelp(argv)) {
    console.log(formatAuthHelp());
    return 0;
  }
  const { target, args } = splitTarget(argv);
  assertNoArgs(args, 'status');
  const targets = argv.length ? [target] : ['ro', 'jira'];
  let authenticated = true;
  for (const item of targets) {
    const result = item === 'jira' ? await getStoredJiraStatus() : await getStoredAuthStatus();
    console.log(`${item === 'jira' ? 'Jira' : 'Resource Optimiser'}: ${result.summary}`);
    if (item === 'ro' && !result.authenticated) {
      authenticated = false;
    }
  }
  return authenticated ? 0 : 1;
}

export function formatAuthHelp() {
  const storeLabel = credentialStoreLabel();
  return `Usage:
  logwork login [ro|jira] [--base-url <url>]
  logwork logout [ro|jira]
  logwork status [ro|jira]

Targets:
  ro    Resource Optimiser (default). Email, password and 2FA are asked in this terminal.
  jira  Jira Personal Access Token, pasted in this terminal.

Sessions are stored in ${storeLabel}, never in files or command arguments.

Options:
  --base-url <url>  Jira base URL for \`login jira\`. Defaults to https://jira-vnv.vinova.sg`;
}

function splitTarget(argv = []) {
  const [first, ...rest] = argv;
  if (first === 'ro' || first === 'jira') {
    return { target: first, args: rest };
  }
  return { target: 'ro', args: argv };
}

function wantsHelp(args) {
  return args.includes('--help') || args.includes('-h');
}

function assertNoArgs(args, command) {
  if (args.length) {
    throw new Error(`Unknown ${command} option: ${args[0]}`);
  }
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

export function parseLoginArgs(args = []) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--api-mode') {
      continue;
    }

    if (arg === '--browser' || arg.startsWith('--browser=')) {
      throw new Error('Browser auth has been removed. Run `logwork login` for API-only auth.');
    }

    if (arg === '--browser-mode') {
      throw new Error('Browser auth has been removed. Run `logwork login` for API-only auth.');
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
