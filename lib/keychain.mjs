import { spawn } from 'node:child_process';

export const KEYCHAIN_SERVICE = 'logwork-cli';
// Service name used before the rename; read once and copied to KEYCHAIN_SERVICE.
export const LEGACY_KEYCHAIN_SERVICE = 'logwork-helper';
export const KEYCHAIN_ACCOUNT = 'resourceoptimiser';
export const KEYCHAIN_EMAIL_ACCOUNT = 'resourceoptimiser-email';

export function createKeychainTokenStorage({
  service = KEYCHAIN_SERVICE,
  account = KEYCHAIN_ACCOUNT,
  run = runSecurity
} = {}) {
  return createKeychainValueStorage({ service, account, run });
}

export function createKeychainEmailStorage({
  service = KEYCHAIN_SERVICE,
  account = KEYCHAIN_EMAIL_ACCOUNT,
  run = runSecurity
} = {}) {
  return createKeychainValueStorage({ service, account, run });
}

export function createKeychainValueStorage({
  service = KEYCHAIN_SERVICE,
  account = KEYCHAIN_ACCOUNT,
  run = runSecurity
} = {}) {
  return {
    async get() {
      try {
        const result = await run(['find-generic-password', '-s', service, '-a', account, '-w']);
        return result.stdout.trim() || null;
      } catch (error) {
        if (isNotFoundError(error)) {
          return null;
        }
        throw error;
      }
    },

    async set(token) {
      // The value goes in on stdin (security's interactive mode, as hex), never
      // in argv where `ps` could show it.
      await run(['-i'], { input: formatAddPasswordCommand({ service, account, value: token }) });
    },

    async delete() {
      try {
        await run(['delete-generic-password', '-s', service, '-a', account]);
        return true;
      } catch (error) {
        if (isNotFoundError(error)) {
          return false;
        }
        throw error;
      }
    }
  };
}

export function formatAddPasswordCommand({ service, account, value }) {
  for (const [label, text] of [['service', service], ['account', account]]) {
    if (!/^[A-Za-z0-9._@+-]+$/.test(String(text))) {
      throw new Error(`Unsupported Keychain ${label} name: ${text}`);
    }
  }
  const hex = Buffer.from(String(value), 'utf8').toString('hex');
  return `add-generic-password -U -s "${service}" -a "${account}" -X ${hex}\n`;
}

function runSecurity(args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/security', args, {
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
    });
    if (input !== undefined) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const error = new Error(`security ${args[0]} failed with exit code ${code}: ${stderr.trim() || 'no stderr'}`);
      error.code = code;
      error.stderr = stderr;
      reject(error);
    });
  });
}

function isNotFoundError(error) {
  const text = `${error?.message || ''}\n${error?.stderr || ''}`.toLowerCase();
  return error?.code === 44 || text.includes('could not be found') || text.includes('not found');
}
