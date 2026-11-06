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
    authCliPath: '/Users/example/.logwork-cli/bin/logwork.mjs',
    home: '/Users/example/.logwork-cli'
  });

  assert.equal(command, "cd '/Users/example/.logwork-cli' && LOGWORK_HOME='/Users/example/.logwork-cli' '/usr/local/bin/node' '/Users/example/.logwork-cli/bin/logwork.mjs' 'login'");
});

test('auth login shell command uses PowerShell syntax on Windows', () => {
  const command = buildAuthLoginShellCommand({
    platform: 'win32',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    authCliPath: 'C:\\Users\\example\\.logwork-cli\\bin\\logwork.mjs',
    home: 'C:\\Users\\example\\.logwork-cli'
  });

  assert.equal(command, "Set-Location -LiteralPath 'C:\\Users\\example\\.logwork-cli'; $env:LOGWORK_HOME = 'C:\\Users\\example\\.logwork-cli'; & 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Users\\example\\.logwork-cli\\bin\\logwork.mjs' 'login'");
});

test('startAuthLoginTerminal returns PowerShell instructions on Windows', async () => {
  const result = await startAuthLoginTerminal({
    platform: 'win32',
    run: async () => {
      throw new Error('should not open a terminal on Windows');
    }
  });

  assert.equal(result.status, 'auth_required');
  assert.equal(result.command, 'logwork login');
  assert.match(result.summary, /PowerShell/);
  assert.match(result.terminalCommand, /Set-Location -LiteralPath/);
});
