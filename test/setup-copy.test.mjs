import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyRuntimeFiles } from '../commands/setup.mjs';

test('setup copies only packaged files and drops a stale lockfile', async () => {
  const source = mkdtempSync(join(tmpdir(), 'logwork-setup-src-'));
  const target = mkdtempSync(join(tmpdir(), 'logwork-setup-dst-'));
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'logwork-cli', files: ['bin/', 'lib/', 'README.md'] }));
  mkdirSync(join(source, 'bin'));
  writeFileSync(join(source, 'bin', 'logwork.mjs'), '// bin');
  mkdirSync(join(source, 'lib', 'nested'), { recursive: true });
  writeFileSync(join(source, 'lib', 'nested', 'x.mjs'), '// x');
  writeFileSync(join(source, 'README.md'), 'readme');
  writeFileSync(join(source, '.env'), 'SECRET=1');
  writeFileSync(join(source, '.logwork.json'), '{"repo":"mapping"}');
  mkdirSync(join(source, 'test'));
  writeFileSync(join(source, 'test', 'a.test.mjs'), '');
  writeFileSync(join(target, '.logwork.json'), '{"user":"mapping"}');
  writeFileSync(join(target, 'package-lock.json'), '{"stale":true}');

  await copyRuntimeFiles(source, target);

  assert.ok(existsSync(join(target, 'bin', 'logwork.mjs')));
  assert.ok(existsSync(join(target, 'lib', 'nested', 'x.mjs')));
  assert.ok(existsSync(join(target, 'README.md')));
  assert.ok(!existsSync(join(target, '.env')));
  assert.ok(!existsSync(join(target, 'test')));
  assert.equal(readFileSync(join(target, '.logwork.json'), 'utf8'), '{"user":"mapping"}');
  assert.ok(!existsSync(join(target, 'package-lock.json')), 'a lockfile the source does not ship is removed');
});

test('setup removes only dangling links left by a deleted logwork-helper install', { skip: process.platform === 'win32' }, async () => {
  const { removeDanglingLegacyLinks } = await import('../commands/setup.mjs');
  const { symlinkSync, lstatSync } = await import('node:fs');
  const prefix = mkdtempSync(join(tmpdir(), 'logwork-prefix-'));
  mkdirSync(join(prefix, 'bin'));
  mkdirSync(join(prefix, 'lib', 'node_modules'), { recursive: true });
  const gone = join(prefix, 'home', '.logwork-helper');
  symlinkSync(join(gone, 'manual-log.mjs'), join(prefix, 'bin', 'logwork'));
  symlinkSync(join(gone, 'cli.mjs'), join(prefix, 'bin', 'logwork-helper'));
  symlinkSync(gone, join(prefix, 'lib', 'node_modules', 'logwork-helper'));
  // A working link and an unrelated dangling link are left alone.
  const alive = join(prefix, 'logwork-helper-alive.mjs');
  writeFileSync(alive, '');
  symlinkSync(alive, join(prefix, 'bin', 'logwork-helper-mcp'));
  symlinkSync(join(prefix, 'nowhere', 'other.mjs'), join(prefix, 'bin', 'logwork-helper-manual'));

  const removed = await removeDanglingLegacyLinks(prefix, { platform: 'darwin' });

  assert.equal(removed.length, 3);
  assert.ok(!existsSync(join(prefix, 'bin', 'logwork')) && !lstatExists(join(prefix, 'bin', 'logwork')));
  assert.ok(lstatSync(join(prefix, 'bin', 'logwork-helper-mcp')).isSymbolicLink());
  assert.ok(lstatSync(join(prefix, 'bin', 'logwork-helper-manual')).isSymbolicLink());

  function lstatExists(path) {
    try {
      lstatSync(path);
      return true;
    } catch {
      return false;
    }
  }
});
