import {
  createKeychainEmailStorage,
  createKeychainTokenStorage,
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_EMAIL_ACCOUNT,
  KEYCHAIN_SERVICE
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
  if (platform === 'darwin') {
    return createKeychainTokenStorage({ service, account, ...(run ? { run } : {}) });
  }
  if (platform === 'win32') {
    return createWindowsCredentialTokenStorage({ service, account, ...(run ? { run } : {}) });
  }
  return createUnsupportedCredentialStorage(platform);
}

export function createCredentialEmailStorage({
  platform = process.platform,
  service = KEYCHAIN_SERVICE,
  account = KEYCHAIN_EMAIL_ACCOUNT,
  run
} = {}) {
  if (platform === 'darwin') {
    return createKeychainEmailStorage({ service, account, ...(run ? { run } : {}) });
  }
  if (platform === 'win32') {
    return createWindowsCredentialEmailStorage({ service, account, ...(run ? { run } : {}) });
  }
  return createUnsupportedCredentialStorage(platform);
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
  return new Error(`Unsupported operating system for Logwork Helper credential storage: ${platform}. Supported platforms are macOS and Windows.`);
}
