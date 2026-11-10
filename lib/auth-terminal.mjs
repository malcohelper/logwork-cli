import { spawn } from 'node:child_process';
import { dirname, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { whichCommand } from './mcp-install.mjs';
import { helperHome } from './paths.mjs';

// Linux terminal emulators tried in order, with the flag that runs a command.
// $TERMINAL (when set) goes first with -e, the common convention.
export const LINUX_TERMINALS = Object.freeze([
  { name: 'x-terminal-emulator', args: ['-e'] },
  { name: 'gnome-terminal', args: ['--'] },
  { name: 'konsole', args: ['-e'] },
  { name: 'xfce4-terminal', args: ['-x'] },
  { name: 'kgx', args: ['--'] },
  { name: 'kitty', args: [] },
  { name: 'alacritty', args: ['-e'] },
  { name: 'wezterm', args: ['start', '--'] },
  { name: 'xterm', args: ['-e'] }
]);

export function buildAuthLoginArgs(target = 'ro') {
  return target === 'jira' ? ['login', 'jira'] : ['login'];
}

export function buildAuthLoginShellCommand({
  nodePath = process.execPath,
  authCliPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'logwork.mjs'),
  home = helperHome(),
  platform = process.platform
} = {}) {
  const args = buildAuthLoginArgs();
  const authCliDir = dirnameForPlatform(dirnameForPlatform(authCliPath, platform), platform);
  if (platform === 'win32') {
    return [
      `Set-Location -LiteralPath ${quotePowerShellArg(authCliDir)}`,
      `$env:LOGWORK_HOME = ${quotePowerShellArg(home)}`,
      `& ${quotePowerShellArg(nodePath)} ${quotePowerShellArg(authCliPath)} ${args.map(quotePowerShellArg).join(' ')}`
    ].join('; ');
  }

  return [
    `cd ${quotePosixArg(authCliDir)}`,
    `LOGWORK_HOME=${quotePosixArg(home)} ${quotePosixArg(nodePath)} ${quotePosixArg(authCliPath)} ${args.map(quotePosixArg).join(' ')}`
  ].join(' && ');
}

export async function startAuthLoginTerminal({
  platform = process.platform,
  run = runCommand,
  env = process.env,
  findCommand = (name) => whichCommand(name, { platform, env }),
  launchDetached = spawnDetached,
  command = buildAuthLoginShellCommand({ platform })
} = {}) {
  if (platform === 'linux') {
    const opened = await openLinuxTerminal(command, { env, findCommand, launchDetached });
    if (opened) {
      return {
        status: 'auth_login_started',
        command: 'logwork login',
        terminalCommand: command,
        terminal: opened,
        summary: `Opened a terminal window (${opened}) for the Resource Optimiser login. Enter email/password and 2FA there, then retry the MCP tool.`
      };
    }
  }
  if (platform !== 'darwin') {
    const shellName = platform === 'win32' ? 'PowerShell' : 'terminal';
    return {
      status: 'auth_required',
      command: 'logwork login',
      terminalCommand: command,
      summary: `Run this command in ${shellName} to authenticate Resource Optimiser:\n${command}`
    };
  }

  await run('/usr/bin/osascript', [
    '-e',
    'tell application "Terminal"',
    '-e',
    `do script ${JSON.stringify(command)}`,
    '-e',
    'activate',
    '-e',
    'end tell'
  ]);

  return {
    status: 'auth_login_started',
    command: 'logwork login',
    terminalCommand: command,
    summary: 'Opened a macOS Terminal auth session. Enter Resource Optimiser email/password and 2FA there, then retry the MCP tool.'
  };
}

// Opens the first available terminal emulator running the login command, and
// keeps the window open afterwards so the result stays readable. Needs a
// graphical session; returns the terminal name, or null when none could start.
export async function openLinuxTerminal(command, {
  env = process.env,
  findCommand,
  launchDetached = spawnDetached
} = {}) {
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return null;
  }
  const script = `${command}; printf '\\nPress Enter to close this window. '; read logwork_done`;
  const candidates = [
    ...(env.TERMINAL ? [{ name: String(env.TERMINAL), args: ['-e'] }] : []),
    ...LINUX_TERMINALS
  ];
  const tried = new Set();
  for (const terminal of candidates) {
    if (tried.has(terminal.name)) {
      continue;
    }
    tried.add(terminal.name);
    const executable = await findCommand(terminal.name).catch(() => null);
    if (!executable) {
      continue;
    }
    try {
      await launchDetached(executable, [...terminal.args, 'sh', '-c', script], { env });
      return terminal.name;
    } catch {
      // Try the next terminal.
    }
  }
  return null;
}

// Starts a GUI program without waiting for it: resolves once it has spawned.
function spawnDetached(command, args, { env } = {}) {
  return new Promise((resolveValue, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', env });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolveValue();
    });
  });
}

function runCommand(command, args) {
  return new Promise((resolveValue, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolveValue();
        return;
      }
      reject(new Error(`${command} failed with exit code ${code}: ${stderr.trim() || 'no stderr'}`));
    });
  });
}

function quotePosixArg(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function quotePowerShellArg(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function dirnameForPlatform(value, platform) {
  return platform === 'win32' ? win32.dirname(value) : dirname(value);
}
