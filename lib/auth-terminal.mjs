import { spawn } from 'node:child_process';
import { dirname, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { helperHome } from './paths.mjs';

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
  run = runCommand
} = {}) {
  const command = buildAuthLoginShellCommand({ platform });
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
