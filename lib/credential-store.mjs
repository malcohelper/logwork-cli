import {
  createKeychainEmailStorage,
  createKeychainTokenStorage,
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_EMAIL_ACCOUNT,
  KEYCHAIN_SERVICE,
  LEGACY_KEYCHAIN_SERVICE
} from './keychain.mjs';
import {
  createWindowsCredentialEmailStorage,
  createWindowsCredentialTokenStorage
} from './windows-credential-manager.mjs';

export const SUPPORTED_CREDENTIAL_PLATFORMS = Object.freeze(['darwin', 'win32']);

export function credentialStoreLabel({ platform = process.platform } = {}) {
  if (platform === 'darwin') {
    return 'macOS Keychain';
  }
  if (platform === 'win32') {
    return 'Windows Credential Manager';
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
  run
} = {}) {
  const create = (name) => {
    if (platform === 'darwin') {
      return createKeychainTokenStorage({ service: name, account, ...(run ? { run } : {}) });
    }
    if (platform === 'win32') {
      return createWindowsCredentialTokenStorage({ service: name, account, ...(run ? { run } : {}) });
    }
    return createUnsupportedCredentialStorage(platform);
  };
  return withLegacyService({ platform, service, create });
}

export function createCredentialEmailStorage({
  platform = process.platform,
  service = KEYCHAIN_SERVICE,
  account = KEYCHAIN_EMAIL_ACCOUNT,
  run
} = {}) {
  const create = (name) => {
    if (platform === 'darwin') {
      return createKeychainEmailStorage({ service: name, account, ...(run ? { run } : {}) });
    }
    if (platform === 'win32') {
      return createWindowsCredentialEmailStorage({ service: name, account, ...(run ? { run } : {}) });
    }
    return createUnsupportedCredentialStorage(platform);
  };
  return withLegacyService({ platform, service, create });
}

// Sessions saved before the logwork-helper -> logwork-cli rename live under the
// legacy service name. On a miss, read the legacy entry once and copy it to the
// new service so nobody has to log in again. Delete clears both entries.
export function withLegacyService({ platform, service, create, legacyService = LEGACY_KEYCHAIN_SERVICE }) {
  const primary = create(service);
  if (service !== KEYCHAIN_SERVICE || !SUPPORTED_CREDENTIAL_PLATFORMS.includes(platform)) {
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
  run
} = {}) {
  return createCredentialTokenStorage({
    platform,
    service,
    account,
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
  return new Error(`Unsupported operating system for logwork credential storage: ${platform}. Supported platforms are macOS and Windows.`);
}
