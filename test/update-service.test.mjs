import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkForUpdates,
  compareVersions,
  formatUpdateNotice,
  installUpdate,
  isNewerVersion,
  parseSemver
} from '../lib/update-service.mjs';
import { parseUpdateArgs, runUpdateCli } from '../update-cli.mjs';

test('SemVer parsing and comparison reject unsafe or ambiguous versions', () => {
  assert.equal(parseSemver('1.2.3')?.raw, '1.2.3');
  assert.deepEqual(parseSemver('1.2.3-beta.2+build.7')?.prerelease, ['beta', 2]);
  assert.equal(parseSemver('v1.2.3'), null);
  assert.equal(parseSemver('01.2.3'), null);
  assert.equal(parseSemver('1.2.3-beta.01'), null);
  assert.equal(parseSemver('1.2.3;rm -rf /'), null);
  assert.equal(compareVersions('1.2.3-beta.2', '1.2.3-beta.10'), -1);
  assert.equal(compareVersions('1.2.3-beta', '1.2.3'), -1);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
  assert.equal(isNewerVersion('1.2.4', '1.2.3'), true);
});

test('update check fetches npm latest, writes cache, and reuses it for 24 hours', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'logwork-update-'));
  const cachePath = join(dir, 'update-state.json');
  const requests = [];
  const nowValue = Date.parse('2026-07-15T00:00:00.000Z');
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({
      name: 'logwork-helper',
      version: '0.1.11'
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  const first = await checkForUpdates({
    packageInfo: { name: 'logwork-helper', version: '0.1.10' },
    cachePath,
    fetchImpl,
    now: () => nowValue
  });
  const second = await checkForUpdates({
    packageInfo: { name: 'logwork-helper', version: '0.1.10' },
    cachePath,
    fetchImpl: async () => { throw new Error('cache should avoid network'); },
    now: () => nowValue + 60_000
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://registry.npmjs.org/logwork-helper/latest');
  assert.equal(first.status, 'update_available');
  assert.equal(first.source, 'registry');
  assert.equal(second.source, 'cache');
  assert.equal(second.latestVersion, '0.1.11');
  const stored = JSON.parse(await readFile(cachePath, 'utf8'));
  assert.deepEqual(stored, {
    packageName: 'logwork-helper',
    latestVersion: '0.1.11',
    checkedAt: '2026-07-15T00:00:00.000Z'
  });
});

test('update check can fall back to a valid stale cache without hiding the warning', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'logwork-update-stale-'));
  const cachePath = join(dir, 'update-state.json');
  await checkForUpdates({
    packageInfo: { name: 'logwork-helper', version: '0.1.10' },
    cachePath,
    fetchImpl: async () => new Response(JSON.stringify({
      name: 'logwork-helper',
      version: '0.1.11'
    }), { status: 200 }),
    now: () => Date.parse('2026-07-01T00:00:00.000Z')
  });

  const result = await checkForUpdates({
    force: true,
    packageInfo: { name: 'logwork-helper', version: '0.1.10' },
    cachePath,
    fetchImpl: async () => { throw new Error('offline token=secret'); },
    now: () => Date.parse('2026-07-15T00:00:00.000Z')
  });

  assert.equal(result.source, 'stale_cache');
  assert.equal(result.updateAvailable, true);
  assert.match(result.warning, /Registry check failed/);
  assert.doesNotMatch(result.warning, /secret/);
});

test('update install requires confirmation and executes only npm latest with argument arrays', async () => {
  const calls = [];
  const packageInfo = { name: 'logwork-helper', version: '0.1.10' };
  const checkForUpdatesFn = async (options) => {
    assert.equal(options.force, true);
    assert.equal(options.allowStaleOnError, false);
    return {
      latestVersion: '0.1.11',
      updateAvailable: true
    };
  };

  await assert.rejects(() => installUpdate({
    confirm: false,
    packageInfo,
    checkForUpdatesFn
  }), /requires confirm: true/);

  const result = await installUpdate({
    version: '0.1.11',
    confirm: true,
    packageInfo,
    checkForUpdatesFn,
    runCommand: async (executable, args, options) => {
      calls.push({ executable, args, options });
      return { code: 0, stdout: '', stderr: '' };
    },
    readInstalledVersion: async () => '0.1.11',
    stdio: 'pipe'
  });

  assert.equal(result.status, 'updated');
  assert.equal(result.restartRequired, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [
    'exec',
    '--yes',
    '--registry=https://registry.npmjs.org',
    '--package=logwork-helper@0.1.11',
    '--',
    'logwork-helper',
    'setup-user',
    '--no-login'
  ]);
  assert.equal(calls[0].options.stdio, 'pipe');

  await assert.rejects(() => installUpdate({
    version: '0.1.12',
    confirm: true,
    packageInfo,
    checkForUpdatesFn,
    runCommand: async () => { throw new Error('must not run'); }
  }), /Only the npm latest version/);
});

test('update install verifies the copied runtime version', async () => {
  await assert.rejects(() => installUpdate({
    confirm: true,
    packageInfo: { name: 'logwork-helper', version: '0.1.10' },
    checkForUpdatesFn: async () => ({ latestVersion: '0.1.11' }),
    runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
    readInstalledVersion: async () => '0.1.10'
  }), /Update verification failed/);
});

test('update CLI parses safe options and requires confirmation for non-TTY installs', async () => {
  assert.deepEqual(parseUpdateArgs(['check', '--force', '--json']), {
    command: 'check',
    force: true,
    json: true,
    yes: false,
    version: undefined,
    help: false
  });
  assert.equal(parseUpdateArgs(['install', '--version', '0.1.11', '--yes']).version, '0.1.11');
  assert.throws(() => parseUpdateArgs(['install', '--version', 'latest']), /exact SemVer/);

  await assert.rejects(() => runUpdateCli(['install'], {
    isTTY: false,
    checkForUpdatesFn: async () => ({
      latestVersion: '0.1.11',
      updateAvailable: true
    })
  }), /Re-run with --yes/);
});

test('update CLI supports JSON check and confirmed install', async () => {
  let output = '';
  let installOptions;
  const checkResult = {
    status: 'update_available',
    currentVersion: '0.1.10',
    latestVersion: '0.1.11',
    updateAvailable: true,
    releaseUrl: 'https://example.test/v0.1.11',
    summary: 'Update available.'
  };

  await runUpdateCli(['check', '--json'], {
    checkForUpdatesFn: async () => checkResult,
    output: { write(value) { output += value; } }
  });
  assert.equal(JSON.parse(output).latestVersion, '0.1.11');

  output = '';
  await runUpdateCli(['install', '--yes'], {
    checkForUpdatesFn: async () => checkResult,
    installUpdateFn: async (options) => {
      installOptions = options;
      return {
        status: 'updated',
        installedVersion: '0.1.11',
        summary: 'Updated.'
      };
    },
    output: { write(value) { output += value; } }
  });
  assert.equal(installOptions.confirm, true);
  assert.equal(installOptions.version, '0.1.11');
  assert.match(output, /Updated/);
});

test('startup update notice is concise and actionable', () => {
  assert.equal(formatUpdateNotice({ updateAvailable: false }), '');
  assert.equal(
    formatUpdateNotice({
      updateAvailable: true,
      currentVersion: '0.1.10',
      latestVersion: '0.1.11'
    }),
    'Update available: 0.1.10 -> 0.1.11. Run `logwork-helper update install`.'
  );
});
