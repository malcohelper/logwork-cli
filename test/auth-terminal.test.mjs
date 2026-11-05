import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAuthLoginShellCommand,
  startAuthLoginTerminal
} from '../lib/auth-terminal.mjs';

test('auth login shell command uses POSIX syntax on macOS', () => {
  const command = buildAuthLoginShellCommand({
    platform: 'darwin',
    nodePath: '/usr/local/bin/node',
    authCliPath: '/Users/example/.logwork-helper/auth-cli.mjs',
    home: '/Users/example/.logwork-helper'
  });

  assert.equal(command, "cd '/Users/example/.logwork-helper' && LOGWORK_HELPER_HOME='/Users/example/.logwork-helper' '/usr/local/bin/node' '/Users/example/.logwork-helper/auth-cli.mjs' 'login'");
});

test('auth login shell command uses PowerShell syntax on Windows', () => {
  const command = buildAuthLoginShellCommand({
    platform: 'win32',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    authCliPath: 'C:\\Users\\example\\.logwork-helper\\auth-cli.mjs',
    home: 'C:\\Users\\example\\.logwork-helper'
  });

  assert.equal(command, "Set-Location -LiteralPath 'C:\\Users\\example\\.logwork-helper'; $env:LOGWORK_HELPER_HOME = 'C:\\Users\\example\\.logwork-helper'; & 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Users\\example\\.logwork-helper\\auth-cli.mjs' 'login'");
});

test('startAuthLoginTerminal returns PowerShell instructions on Windows', async () => {
  const result = await startAuthLoginTerminal({
    platform: 'win32',
    run: async () => {
      throw new Error('should not open a terminal on Windows');
    }
  });

  assert.equal(result.status, 'auth_required');
  assert.equal(result.command, 'logwork-helper auth login');
  assert.match(result.summary, /PowerShell/);
  assert.match(result.terminalCommand, /Set-Location -LiteralPath/);
});
