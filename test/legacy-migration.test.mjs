import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCredentialTokenStorage, withLegacyService } from '../lib/credential-store.mjs';
import { MIGRATION_MARKER_FILE_NAME, migrateLegacyHome } from '../lib/legacy-migration.mjs';
import { CONFIG_FILE_NAME, LEGACY_CONFIG_FILE_NAME, projectConfigPath } from '../lib/paths.mjs';
import { removeLegacyReminderScheduler } from '../lib/reminder-scheduler.mjs';

function makeHomes() {
  const root = mkdtempSync(join(tmpdir(), 'logwork-migration-'));
  const legacyHome = join(root, '.logwork-helper');
  const home = join(root, '.logwork-cli');
  mkdirSync(legacyHome, { recursive: true });
  return { root, legacyHome, home };
}

test('migrateLegacyHome copies state files once and renames the mapping config', () => {
  const { legacyHome, home } = makeHomes();
  writeFileSync(join(legacyHome, LEGACY_CONFIG_FILE_NAME), '{"projectMappings":[]}');
  writeFileSync(join(legacyHome, 'apply-ledger.json'), '{"entries":[]}');
  writeFileSync(join(legacyHome, 'reminder.json'), '{"enabled":true}');
  writeFileSync(join(legacyHome, 'auth-cli.mjs'), '// old runtime code is not copied');

  const first = migrateLegacyHome({ home, legacyHome, env: {} });
  assert.equal(first.migrated, true);
  assert.deepEqual(first.files.sort(), [CONFIG_FILE_NAME, 'apply-ledger.json', 'reminder.json'].sort());
  assert.equal(readFileSync(join(home, CONFIG_FILE_NAME), 'utf8'), '{"projectMappings":[]}');
  assert.equal(existsSync(join(home, 'auth-cli.mjs')), false);
  assert.equal(existsSync(join(home, MIGRATION_MARKER_FILE_NAME)), true);
  assert.equal(existsSync(join(legacyHome, 'apply-ledger.json')), true, 'legacy home is left in place');

  writeFileSync(join(legacyHome, 'manual-drafts.json'), '{}');
  assert.deepEqual(migrateLegacyHome({ home, legacyHome, env: {} }), { migrated: false, reason: 'already_migrated' });
  assert.equal(existsSync(join(home, 'manual-drafts.json')), false);
});

test('migrateLegacyHome never overwrites newer files and skips custom homes', () => {
  const { legacyHome, home } = makeHomes();
  mkdirSync(home, { recursive: true });
  writeFileSync(join(legacyHome, 'apply-ledger.json'), 'old');
  writeFileSync(join(home, 'apply-ledger.json'), 'new');

  const result = migrateLegacyHome({ home, legacyHome, env: {} });
  assert.equal(result.migrated, false);
  assert.equal(readFileSync(join(home, 'apply-ledger.json'), 'utf8'), 'new');

  assert.equal(migrateLegacyHome({ home, legacyHome, env: { LOGWORK_HOME: home } }).reason, 'custom_home');
  assert.equal(migrateLegacyHome({ home, legacyHome, env: { LOGWORK_HELPER_HOME: home } }).reason, 'custom_home');
  assert.equal(migrateLegacyHome({ home: join(home, 'x'), legacyHome: join(home, 'missing'), env: {} }).reason, 'no_legacy_home');
});

test('project config keeps using a repo-level .logwork-helper.json until .logwork.json exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'logwork-project-config-'));
  assert.equal(projectConfigPath(dir), join(dir, CONFIG_FILE_NAME));

  writeFileSync(join(dir, LEGACY_CONFIG_FILE_NAME), '{}');
  assert.equal(projectConfigPath(dir), join(dir, LEGACY_CONFIG_FILE_NAME));

  writeFileSync(join(dir, CONFIG_FILE_NAME), '{}');
  assert.equal(projectConfigPath(dir), join(dir, CONFIG_FILE_NAME));
});

function fakeStore(initial = null) {
  const store = { value: initial, sets: [], deleted: false };
  store.storage = {
    get: async () => store.value,
    set: async (value) => {
      store.sets.push(value);
      store.value = value;
    },
    delete: async () => {
      store.deleted = true;
      store.value = null;
      return true;
    }
  };
  return store;
}

test('credential storage reads the legacy service once and copies the session forward', async () => {
  const stores = { 'logwork-cli': fakeStore(), 'logwork-helper': fakeStore('legacy-session') };
  const storage = withLegacyService({
    platform: 'darwin',
    service: 'logwork-cli',
    create: (name) => stores[name].storage
  });

  assert.equal(await storage.get(), 'legacy-session');
  assert.deepEqual(stores['logwork-cli'].sets, ['legacy-session']);
  assert.equal(await storage.get(), 'legacy-session');
  assert.equal(stores['logwork-cli'].sets.length, 1);

  await storage.delete();
  assert.equal(stores['logwork-cli'].deleted, true);
  assert.equal(stores['logwork-helper'].deleted, true, 'logout clears the legacy entry too');
});

test('credential storage on Windows uses the new service name and falls back to the legacy target', async () => {
  const calls = [];
  const storage = createCredentialTokenStorage({
    platform: 'win32',
    run: async (request) => {
      calls.push(request);
      if (request.action === 'get') {
        return request.target === 'logwork-helper:resourceoptimiser'
          ? { found: true, value: 'legacy-session' }
          : { found: false };
      }
      return { ok: true };
    }
  });

  assert.equal(await storage.get(), 'legacy-session');
  assert.deepEqual(calls.map((call) => `${call.action} ${call.target}`), [
    'get logwork-cli:resourceoptimiser',
    'get logwork-helper:resourceoptimiser',
    'set logwork-cli:resourceoptimiser'
  ]);
});

test('legacy reminder schedule is removed on Windows and ignored when absent', async () => {
  const calls = [];
  const removed = await removeLegacyReminderScheduler({
    platform: 'win32',
    run: async (command, args) => {
      calls.push([command, ...args].join(' '));
      return { code: 0, stdout: '', stderr: '' };
    }
  });
  assert.equal(removed, true);
  assert.deepEqual(calls, [
    'schtasks.exe /Query /TN Logwork Helper Reminder',
    'schtasks.exe /Delete /TN Logwork Helper Reminder /F'
  ]);

  const absent = await removeLegacyReminderScheduler({
    platform: 'win32',
    run: async () => ({ code: 1, stdout: '', stderr: 'not found' })
  });
  assert.equal(absent, false);

  const macAbsent = await removeLegacyReminderScheduler({
    platform: 'darwin',
    userHome: mkdtempSync(join(tmpdir(), 'logwork-launchagents-')),
    uid: 501,
    run: async () => {
      throw new Error('launchctl must not run when the legacy plist is absent');
    }
  });
  assert.equal(macAbsent, false);
});
