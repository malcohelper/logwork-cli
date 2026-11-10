import { spawn } from 'node:child_process';

// Linux credential storage through the freedesktop Secret Service (GNOME
// Keyring, KWallet, KeePassXC, ...) with libsecret's `secret-tool`. Entries are
// keyed by the attributes `service` and `account`, like the macOS Keychain and
// Windows Credential Manager entries. The secret goes in on stdin and comes
// back on stdout, never through argv.

export const SECRET_TOOL_COMMAND = 'secret-tool';

export const LINUX_SECRET_SERVICE_HINT = 'Linux credential storage needs `secret-tool` (libsecret) and a running Secret Service such as GNOME Keyring or KWallet. Install it with `sudo apt install libsecret-tools gnome-keyring` (Debian/Ubuntu) or `sudo dnf install libsecret gnome-keyring` (Fedora), then log in to a desktop session.';

export function createSecretServiceValueStorage({
  service = 'logwork-cli',
  account = 'resourceoptimiser',
  run = runSecretTool
} = {}) {
  const attributes = ['service', String(service), 'account', String(account)];

  async function lookup() {
    const result = await run(['lookup', ...attributes]);
    if (result.code === 0) {
      // secret-tool adds a newline only when stdout is a terminal; strip one
      // anyway so a hand-made entry still matches.
      return result.stdout.replace(/\r?\n$/, '') || null;
    }
    // A missing entry exits 1 with nothing on stderr.
    if (result.code === 1 && !String(result.stderr || '').trim()) {
      return null;
    }
    throw secretToolError('lookup', result);
  }

  return {
    get: lookup,

    async set(value) {
      const result = await run(
        ['store', `--label=logwork-cli (${account})`, ...attributes],
        { input: String(value) }
      );
      if (result.code !== 0) {
        throw secretToolError('store', result);
      }
    },

    async delete() {
      const existed = (await lookup()) !== null;
      if (!existed) {
        return false;
      }
      const result = await run(['clear', ...attributes]);
      if (result.code !== 0) {
        throw secretToolError('clear', result);
      }
      return true;
    }
  };
}

// Resolves { code, stdout, stderr }. A missing secret-tool binary rejects with
// the install hint instead of a bare ENOENT.
export function runSecretTool(args, {
  input,
  command = SECRET_TOOL_COMMAND,
  spawnFn = spawn
} = {}) {
  return new Promise((resolveValue, reject) => {
    let child;
    try {
      child = spawnFn(command, args, {
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
      });
    } catch (error) {
      reject(missingSecretToolError(error));
      return;
    }
    if (input !== undefined) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => reject(missingSecretToolError(error)));
    child.on('close', (code, signal) => {
      resolveValue({ code: signal ? 1 : (code ?? 1), stdout, stderr });
    });
  });
}

function missingSecretToolError(error) {
  if (error?.code === 'ENOENT') {
    const wrapped = new Error(`secret-tool was not found. ${LINUX_SECRET_SERVICE_HINT}`);
    wrapped.code = 'SECRET_TOOL_MISSING';
    return wrapped;
  }
  return error;
}

// Only stderr goes into the message: stdout of a lookup is the secret itself.
function secretToolError(action, result) {
  const detail = String(result.stderr || '').trim().slice(0, 300) || 'no stderr';
  const error = new Error(`secret-tool ${action} failed with exit code ${result.code}: ${detail}. ${LINUX_SECRET_SERVICE_HINT}`);
  error.code = result.code;
  error.stderr = result.stderr;
  return error;
}
