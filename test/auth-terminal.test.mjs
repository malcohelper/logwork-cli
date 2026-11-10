import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAuthLoginShellCommand,
  openLinuxTerminal,
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

const LINUX_COMMAND = "cd '/home/jane/.logwork-cli' && LOGWORK_HOME='/home/jane/.logwork-cli' '/usr/bin/node' '/home/jane/.logwork-cli/bin/logwork.mjs' 'login'";

test('startAuthLoginTerminal opens a Linux terminal window that stays open after login', async () => {
  const launched = [];
  const result = await startAuthLoginTerminal({
    platform: 'linux',
    env: { DISPLAY: ':0' },
    command: LINUX_COMMAND,
    findCommand: async (name) => (name === 'gnome-terminal' ? '/usr/bin/gnome-terminal' : null),
    launchDetached: async (command, args) => { launched.push({ command, args }); },
    run: async () => { throw new Error('osascript is macOS only'); }
  });
  assert.equal(result.status, 'auth_login_started');
  assert.equal(result.terminal, 'gnome-terminal');
  assert.match(result.summary, /Opened a terminal window \(gnome-terminal\)/);
  assert.equal(launched.length, 1);
  assert.equal(launched[0].command, '/usr/bin/gnome-terminal');
  assert.deepEqual(launched[0].args.slice(0, 3), ['--', 'sh', '-c']);
  assert.equal(launched[0].args[3], `${LINUX_COMMAND}; printf '\\nPress Enter to close this window. '; read logwork_done`);
});

test('Linux terminal choice: $TERMINAL first, skips ones that fail to start', async () => {
  const tried = [];
  const opened = await openLinuxTerminal('logwork login', {
    env: { WAYLAND_DISPLAY: 'wayland-0', TERMINAL: 'foot' },
    findCommand: async (name) => (['foot', 'konsole', 'xterm'].includes(name) ? `/usr/bin/${name}` : null),
    launchDetached: async (command, args) => {
      tried.push([command, args[0]]);
      if (command.endsWith('foot')) {
        throw new Error('cannot open display');
      }
    }
  });
  assert.equal(opened, 'konsole');
  assert.deepEqual(tried, [['/usr/bin/foot', '-e'], ['/usr/bin/konsole', '-e']]);
});

test('Linux login falls back to printed instructions without a desktop or a terminal', async () => {
  const headless = await startAuthLoginTerminal({
    platform: 'linux',
    env: {},
    command: LINUX_COMMAND,
    findCommand: async () => { throw new Error('must not look for terminals without a display'); },
    launchDetached: async () => { throw new Error('must not launch'); }
  });
  assert.equal(headless.status, 'auth_required');
  assert.match(headless.summary, /Run this command in terminal/);
  assert.equal(headless.terminalCommand, LINUX_COMMAND);

  const noTerminal = await startAuthLoginTerminal({
    platform: 'linux',
    env: { DISPLAY: ':0' },
    command: LINUX_COMMAND,
    findCommand: async () => null,
    launchDetached: async () => { throw new Error('must not launch'); }
  });
  assert.equal(noTerminal.status, 'auth_required');
});
