import test from 'node:test';
import assert from 'node:assert/strict';
import { npmInvocation } from '../lib/npm-command.mjs';

test('npm runs directly on macOS and Linux', () => {
  assert.deepEqual(npmInvocation(['ci'], { platform: 'darwin' }), { command: 'npm', args: ['ci'], shell: false });
});

test('on Windows npm runs as node npm-cli.js, without a shell', () => {
  const execPath = 'C:\\Program Files\\nodejs\\node.exe';
  const result = npmInvocation(['link'], {
    platform: 'win32',
    execPath,
    env: {},
    exists: (path) => /npm-cli\.js$/.test(path)
  });
  assert.equal(result.command, execPath);
  assert.match(result.args[0], /node_modules[\\/]npm[\\/]bin[\\/]npm-cli\.js$/);
  assert.deepEqual(result.args.slice(1), ['link']);
  assert.equal(result.shell, false);
});

test('on Windows npm falls back to npm.cmd through the shell', () => {
  const result = npmInvocation(['ci'], { platform: 'win32', execPath: 'C:\\node\\node.exe', env: {}, exists: () => false });
  assert.deepEqual(result, { command: 'npm.cmd', args: ['ci'], shell: true });
});
