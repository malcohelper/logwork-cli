import {
  createKeychainEmailStorage,
  createKeychainTokenStorage,
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_EMAIL_ACCOUNT,
  KEYCHAIN_SERVICE,
  LEGACY_KEYCHAIN_SERVICE
} from './keychain.mjs';
import { createSecretServiceValueStorage } from './linux-secret-service.mjs';
import {
  createWindowsCredentialEmailStorage,
  createWindowsCredentialTokenStorage,
  runPowerShellCredentialCommand
} from './windows-credential-manager.mjs';
import { isWsl, windowsExecutable, WSL_INTEROP_HINT } from './wsl.mjs';

export const SUPPORTED_CREDENTIAL_PLATFORMS = Object.freeze(['darwin', 'win32', 'linux']);
// Platforms that had releases under the old logwork-helper service name.
const LEGACY_SERVICE_PLATFORMS = Object.freeze(['darwin', 'win32']);

export function credentialStoreLabel({ platform = process.platform, wsl = isWsl({ platform }) } = {}) {
  if (platform === 'darwin') {
    return 'macOS Keychain';
  }
  if (platform === 'win32') {
    return 'Windows Credential Manager';
  }
  if (platform === 'linux' && wsl) {
    return 'Windows Credential Manager (from WSL)';
  }
  if (platform === 'linux') {
    return 'Linux Secret Service (libsecret)';
  }
  return 'OS credential store';
}

export function assertSupportedCredentialPlatform(platform = process.platform) {
  if (!SUPPORTED_CREDENTIAL_PLATFORMS.includes(platform)) {
    throw unsupportedCredentialStoreError(platform);
  }
}

export function createCredentialTokenStorage({
  platform = process.platform,
  service = KEYCHAIN_SERVICE,
  account = KEYCHAIN_ACCOUNT,
  wsl = isWsl({ platform }),
  run
} = {}) {
  const create = (name) => {
    if (platform === 'darwin') {
      return createKeychainTokenStorage({ service: name, account, ...(run ? { run } : {}) });
    }
    if (platform === 'win32') {
      return createWindowsCredentialTokenStorage({ service: name, account, ...(run ? { run } : {}) });
    }
    if (platform === 'linux' && wsl) {
      return createWindowsCredentialTokenStorage({ service: name, account, run: run || wslCredentialRunner() });
    }
    if (platform === 'linux') {
      return createSecretServiceValueStorage({ service: name, account, ...(run ? { run } : {}) });
    }
    return createUnsupportedCredentialStorage(platform);
  };
  return withLegacyService({ platform, service, create, wsl });
}

export function createCredentialEmailStorage({
  platform = process.platform,
  service = KEYCHAIN_SERVICE,
  account = KEYCHAIN_EMAIL_ACCOUNT,
  wsl = isWsl({ platform }),
  run
} = {}) {
  const create = (name) => {
    if (platform === 'darwin') {
      return createKeychainEmailStorage({ service: name, account, ...(run ? { run } : {}) });
    }
    if (platform === 'win32') {
      return createWindowsCredentialEmailStorage({ service: name, account, ...(run ? { run } : {}) });
    }
    if (platform === 'linux' && wsl) {
      return createWindowsCredentialEmailStorage({ service: name, account, run: run || wslCredentialRunner() });
    }
    if (platform === 'linux') {
      return createSecretServiceValueStorage({ service: name, account, ...(run ? { run } : {}) });
    }
    return createUnsupportedCredentialStorage(platform);
  };
  return withLegacyService({ platform, service, create, wsl });
}

// WSL: the same Windows Credential Manager entries as a Windows install
// (target logwork-cli:<account>), reached through powershell.exe. A login on
// either side is visible to the other.
export function wslCredentialRunner({ env = process.env, runner = runPowerShellCredentialCommand } = {}) {
  return async (request) => {
    try {
      return await runner(request, { command: windowsExecutable('powershell.exe', { env }), encoded: true });
    } catch (error) {
      throw new Error(`${error.message} ${WSL_INTEROP_HINT}`);
    }
  };
}

// Sessions saved before the logwork-helper -> logwork-cli rename live under the
// legacy service name. On a miss, read the legacy entry once and copy it to the
// new service so nobody has to log in again. Delete clears both entries.
export function withLegacyService({ platform, service, create, wsl = false, legacyService = LEGACY_KEYCHAIN_SERVICE }) {
  const primary = create(service);
  // WSL shares the Windows vault, which may still hold logwork-helper entries.
  if (service !== KEYCHAIN_SERVICE || !(LEGACY_SERVICE_PLATFORMS.includes(platform) || (platform === 'linux' && wsl))) {
    return primary;
  }
  const legacy = create(legacyService);
  return {
    async get() {
      const value = await primary.get();
      if (value) {
        return value;
      }
      const legacyValue = await legacy.get().catch(() => null);
      if (legacyValue) {
        await primary.set(legacyValue).catch(() => {});
      }
      return legacyValue || null;
    },
    set(value) {
      return primary.set(value);
    },
    async delete() {
      const result = await primary.delete();
      await legacy.delete().catch(() => {});
      return result;
    }
  };
}

export function createCredentialJiraStorage({
  platform = process.platform,
  service = KEYCHAIN_SERVICE,
  account = 'jira',
  wsl,
  run
} = {}) {
  return createCredentialTokenStorage({
    platform,
    service,
    account,
    ...(wsl !== undefined ? { wsl } : {}),
    ...(run ? { run } : {})
  });
}

function createUnsupportedCredentialStorage(platform) {
  return {
    async get() {
      throw unsupportedCredentialStoreError(platform);
    },
    async set() {
      throw unsupportedCredentialStoreError(platform);
    },
    async delete() {
      throw unsupportedCredentialStoreError(platform);
    }
  };
}

function unsupportedCredentialStoreError(platform) {
  return new Error(`Unsupported operating system for logwork credential storage: ${platform}. Supported platforms are macOS, Windows and Linux.`);
}
