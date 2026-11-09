import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import { chmod, mkdir, mkdtemp, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LAUNCHER_PRINT_NODE_ENV,
  buildPosixLauncherScript,
  checkLaunchCommand,
  formatLaunchCheckIssue,
  isNvmWindowsNode,
  launcherPath,
  mcpArgs,
  resolveLaunchCommand,
  writeLauncher
} from '../lib/launcher.mjs';

const POSIX = process.platform !== 'win32';

// A stand-in for bin/logwork.mjs: prints the node it runs on and its args, or
// a version for --version.
const FAKE_ENTRY = `if (process.argv[2] === '--version') { console.log('9.9.9'); } else { console.log(JSON.stringify({ node: process.execPath, args: process.argv.slice(2) })); }\n`;

async function makeHome() {
  // A space and a quote in the path: everything in the script must be quoted.
  const root = await mkdtemp(join(tmpdir(), 'logwork launcher-'));
  const home = join(root, "it's home", '.logwork-cli');
  await mkdir(join(home, 'bin'), { recursive: true });
  await writeFile(join(home, 'bin', 'logwork.mjs'), FAKE_ENTRY);
  const emptyPath = join(root, 'empty-path');
  await mkdir(emptyPath);
  const userHome = join(root, 'user home');
  await mkdir(userHome);
  return { root, home, emptyPath, userHome };
}

function runLauncher(path, args, env) {
  return spawnSync(path, args, { encoding: 'utf8', env });
}

function executable(path) {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

test('POSIX launch command is the launcher in the helper home with no args prefix', () => {
  const launch = resolveLaunchCommand({ platform: 'darwin', home: '/Users/jane/.logwork-cli', execPath: '/x/node', env: {} });
  assert.deepEqual(launch, { command: '/Users/jane/.logwork-cli/bin/logwork-launch', argsPrefix: [], kind: 'launcher', stable: true });
  assert.deepEqual(mcpArgs(launch), ['mcp']);
  assert.equal(launcherPath('/h'), '/h/bin/logwork-launch');
  assert.equal(resolveLaunchCommand({ platform: 'linux', home: '/home/j/.logwork-cli' }).command, '/home/j/.logwork-cli/bin/logwork-launch');
});

test('Windows launch command prefers the nvm-windows symlink, else the running node.exe', () => {
  const home = 'C:\\Users\\Jane Doe\\.logwork-cli';
  const entry = 'C:\\Users\\Jane Doe\\.logwork-cli\\bin\\logwork.mjs';
  const nvmNode = 'C:\\Users\\Jane Doe\\AppData\\Roaming\\nvm\\v22.11.0\\node.exe';

  const symlinked = resolveLaunchCommand({
    platform: 'win32',
    home,
    execPath: nvmNode,
    env: { NVM_HOME: 'C:\\Users\\Jane Doe\\AppData\\Roaming\\nvm', NVM_SYMLINK: 'C:\\nvm4w\\nodejs' }
  });
  assert.deepEqual(symlinked, { command: 'C:\\nvm4w\\nodejs\\node.exe', argsPrefix: [entry], kind: 'nvm-symlink', stable: true });
  assert.deepEqual(mcpArgs(symlinked), [entry, 'mcp']);

  // Windows environment names are case-insensitive; NVM_HOME is optional when
  // the path is a recognizable nvm version folder.
  assert.equal(resolveLaunchCommand({ platform: 'win32', home, execPath: nvmNode, env: { Nvm_Symlink: 'D:\\node' } }).command, 'D:\\node\\node.exe');

  // nvm-windows without its symlink: the version folder is not stable.
  const unlinked = resolveLaunchCommand({ platform: 'win32', home, execPath: nvmNode, env: {} });
  assert.deepEqual(unlinked, { command: nvmNode, argsPrefix: [entry], kind: 'node', stable: false });

  // The official installer location is stable across upgrades.
  const installer = resolveLaunchCommand({ platform: 'win32', home, execPath: 'C:\\Program Files\\nodejs\\node.exe', env: { NVM_SYMLINK: 'C:\\nvm4w\\nodejs' } });
  assert.deepEqual(installer, { command: 'C:\\Program Files\\nodejs\\node.exe', argsPrefix: [entry], kind: 'node', stable: true });

  assert.equal(isNvmWindowsNode('C:\\tools\\nvm\\v24.1.0\\node.exe', {}), true);
  assert.equal(isNvmWindowsNode('C:\\Program Files\\nodejs\\node.exe', { NVM_HOME: 'C:\\tools\\nvm' }), false);
});

test('launcher script embeds quoted paths and checks Node candidates in order', () => {
  const script = buildPosixLauncherScript({ home: "/Users/O'Neil/.logwork cli", nodePath: '/Users/O\'Neil/.nvm/versions/node/v22.11.0/bin/node' });
  assert.match(script, /^#!\/bin\/sh\n/);
  assert.match(script, /^LOGWORK_ENTRY='\/Users\/O'\\''Neil\/\.logwork cli\/bin\/logwork\.mjs'$/m);
  assert.match(script, /^LOGWORK_RECORDED_NODE='\/Users\/O'\\''Neil\/\.nvm\/versions\/node\/v22\.11\.0\/bin\/node'$/m);
  assert.match(script, /process\.versions\.node\.split\("\."\)\[0\]>=22/);
  assert.match(script, /exec "\$logwork_node" "\$LOGWORK_ENTRY" "\$@"/);
  assert.match(script, /exit 127\n$/);
  const order = ['LOGWORK_RECORDED_NODE" ] && [ -f', 'command -v node', 'logwork_newest_nvm_node "${NVM_DIR', '.volta/bin/node', 'fnm/aliases/default/bin/node', '/opt/homebrew/bin/node', '/usr/local/bin/node'];
  const positions = order.map((needle) => script.indexOf(needle));
  assert.ok(positions.every((position) => position > 0), `all candidates present: ${positions}`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'candidates are tried in order');
});

test('writeLauncher writes an executable script on POSIX and nothing on Windows', { skip: !POSIX }, async () => {
  const { home } = await makeHome();
  const written = await writeLauncher({ home, nodePath: '/nowhere/node', platform: process.platform });
  assert.equal(written.path, launcherPath(home));
  assert.equal((await stat(written.path)).mode & 0o777, 0o755);
  assert.equal(await writeLauncher({ home, platform: 'win32', writeFile: () => { throw new Error('must not write'); } }), null);
});

test('launcher falls back to node on PATH when the recorded node is gone, and passes args through', { skip: !POSIX }, async () => {
  const { home, root, userHome } = await makeHome();
  await writeLauncher({ home, nodePath: join(root, 'removed', 'v22.0.0', 'bin', 'node') });
  const pathDir = join(root, 'path with space');
  await mkdir(pathDir);
  await symlink(process.execPath, join(pathDir, 'node'));
  const env = { PATH: pathDir, HOME: userHome };

  const result = runLauncher(launcherPath(home), ['mcp', 'two words', "it's"], env);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.args, ['mcp', 'two words', "it's"]);
  assert.equal(await realpath(output.node), await realpath(process.execPath));

  const picked = runLauncher(launcherPath(home), [], { ...env, [LAUNCHER_PRINT_NODE_ENV]: '1' });
  assert.equal(picked.status, 0);
  assert.equal(picked.stdout.trim(), join(pathDir, 'node'));
});

test('launcher prefers the recorded node without a version check', { skip: !POSIX }, async () => {
  const { home, emptyPath, userHome } = await makeHome();
  await writeLauncher({ home, nodePath: process.execPath });
  const result = runLauncher(launcherPath(home), [], { PATH: emptyPath, HOME: userHome, [LAUNCHER_PRINT_NODE_ENV]: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), process.execPath);
});

test('launcher picks the newest nvm Node 22+ by version, not by name', { skip: !POSIX }, async () => {
  const { home, root, emptyPath, userHome } = await makeHome();
  await writeLauncher({ home, nodePath: join(root, 'gone', 'node') });
  const versions = join(userHome, '.nvm', 'versions', 'node');
  for (const version of ['v9.11.2', 'v18.20.0', 'v22.3.0', 'v23.10.1']) {
    await mkdir(join(versions, version, 'bin'), { recursive: true });
  }
  // Too old by name: never chosen. v9 sorts after v23 as text.
  await writeFile(join(versions, 'v9.11.2', 'bin', 'node'), '#!/bin/sh\nexit 1\n');
  await chmod(join(versions, 'v9.11.2', 'bin', 'node'), 0o755);
  await writeFile(join(versions, 'v18.20.0', 'bin', 'node'), '#!/bin/sh\nexit 1\n');
  await chmod(join(versions, 'v18.20.0', 'bin', 'node'), 0o755);
  await symlink(process.execPath, join(versions, 'v22.3.0', 'bin', 'node'));
  await symlink(process.execPath, join(versions, 'v23.10.1', 'bin', 'node'));

  const result = runLauncher(launcherPath(home), [], { PATH: emptyPath, HOME: userHome, [LAUNCHER_PRINT_NODE_ENV]: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), join(versions, 'v23.10.1', 'bin', 'node'));

  // NVM_DIR wins over ~/.nvm when it holds a newer usable version.
  const nvmDir = join(root, 'custom nvm');
  await mkdir(join(nvmDir, 'versions', 'node', 'v24.0.0', 'bin'), { recursive: true });
  await symlink(process.execPath, join(nvmDir, 'versions', 'node', 'v24.0.0', 'bin', 'node'));
  const custom = runLauncher(launcherPath(home), [], { PATH: emptyPath, HOME: userHome, NVM_DIR: nvmDir, [LAUNCHER_PRINT_NODE_ENV]: '1' });
  assert.equal(custom.stdout.trim(), join(nvmDir, 'versions', 'node', 'v24.0.0', 'bin', 'node'));
});

test('launcher exits 127 with one clear line when no usable Node exists', {
  skip: !POSIX || executable('/opt/homebrew/bin/node') || executable('/usr/local/bin/node')
}, async () => {
  const { home, root, emptyPath, userHome } = await makeHome();
  await writeLauncher({ home, nodePath: join(root, 'gone', 'node') });
  const result = runLauncher(launcherPath(home), ['mcp'], { PATH: emptyPath, HOME: userHome });
  assert.equal(result.status, 127);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim().split('\n').length, 1);
  assert.match(result.stderr, /no usable Node\.js 22\+ found.*`logwork setup`/);
});

test('launch check reports the node the launcher picks and the logwork version', { skip: !POSIX }, async () => {
  const { home, userHome } = await makeHome();
  await writeLauncher({ home, nodePath: process.execPath });
  const launch = resolveLaunchCommand({ platform: process.platform, home });
  const check = await checkLaunchCommand(launch, { env: { PATH: '', HOME: userHome, LOGWORK_HOME: '/elsewhere' } });
  assert.deepEqual(check, { command: launch.command, kind: 'launcher', status: 'ok', node: process.execPath, version: '9.9.9' });
  assert.equal(formatLaunchCheckIssue(check), '');

  await chmod(launch.command, 0o644);
  const notExecutable = await checkLaunchCommand(launch);
  assert.equal(notExecutable.status, 'not_executable');
  assert.match(formatLaunchCheckIssue(notExecutable), /not executable.*`logwork setup`/);

  const missing = await checkLaunchCommand({ ...launch, command: join(home, 'bin', 'gone') });
  assert.equal(missing.status, 'missing');
  assert.match(formatLaunchCheckIssue(missing), /is missing.*`logwork setup`/);
});

test('launch check classifies a launcher with no Node and a failing --version', async () => {
  const launch = { command: '/h/bin/logwork-launch', argsPrefix: [], kind: 'launcher', stable: true };
  const access = async () => {};
  const noNode = await checkLaunchCommand(launch, { platform: 'darwin', access, run: async () => ({ code: 127, stdout: '', stderr: 'logwork: no usable Node.js 22+ found.' }) });
  assert.equal(noNode.status, 'no_node');
  assert.match(formatLaunchCheckIssue(noNode), /no usable Node\.js 22\+/);

  const windows = { command: 'C:\\Program Files\\nodejs\\node.exe', argsPrefix: ['C:\\h\\bin\\logwork.mjs'], kind: 'node', stable: true };
  const calls = [];
  const failed = await checkLaunchCommand(windows, {
    platform: 'win32',
    access,
    run: async (command, args) => { calls.push([command, ...args]); return { code: 1, stdout: '', stderr: 'Cannot find module' }; }
  });
  assert.equal(failed.status, 'failed');
  assert.deepEqual(calls, [['C:\\Program Files\\nodejs\\node.exe', 'C:\\h\\bin\\logwork.mjs', '--version']]);
  assert.match(formatLaunchCheckIssue(failed), /--version failed \(Cannot find module\)/);
  assert.match(formatLaunchCheckIssue({ status: 'missing', kind: 'node', command: 'C:\\n\\node.exe' }), /Node: C:\\n\\node\.exe no longer exists/);
});
