import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFile } from '../lib/atomic-file.mjs';

test('atomicWriteFile writes through a unique temporary file and leaves no temp files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'logwork-atomic-'));
  const target = join(dir, 'state.json');

  await atomicWriteFile(target, '{"ok":true}\n', {
    now: () => 1_000,
    random: () => 0.123456789
  });

  assert.equal(await readFile(target, 'utf8'), '{"ok":true}\n');
  assert.deepEqual(await readdir(dir), ['state.json']);
});

test('atomicWriteFile removes temp file and preserves existing target when rename fails', async () => {
  const target = join('tmp', 'state.json');
  const files = new Map([
    [target, 'old']
  ]);
  let tempPath;

  await assert.rejects(
    () => atomicWriteFile(target, 'new', {
      mkdirFn: async () => {},
      writeFileFn: async (path, content) => {
        tempPath = path;
        files.set(path, content);
      },
      renameFn: async () => {
        throw new Error('rename failed');
      },
      rmFn: async (path) => {
        files.delete(path);
      },
      now: () => 1_000,
      random: () => 0.5
    }),
    /rename failed/
  );

  assert.equal(files.get(target), 'old');
  assert.equal(files.has(tempPath), false);
});
