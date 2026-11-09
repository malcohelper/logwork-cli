import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installUserRuntime,
  formatSetupUserInstructions,
  recordRuntimeInfo,
  refreshReminderSchedule
} from '../commands/setup.mjs';
import { collectNodeRuntimeCheck, generateDiagnosticsReport } from '../lib/diagnostics.mjs';
import {
  formatCodexToml,
  formatMcpSetup,
  stdioMcpServersConfig,
  vscodeMcpConfig
} from '../lib/manual-mcp.mjs';
import {
  formatNodePathIssue,
  inspectNodePath,
  inspectScheduledCommand,
  loadRuntimeInfo,
  writeRuntimeInfo
} from '../lib/node-runtime.mjs';
import {
  buildMacosReminderPlist,
  getReminderSchedulerStatus,
  installReminderScheduler,
  parseMacosPlistNodePath,
  parseWindowsTaskNodePath
} from '../lib/reminder-scheduler.mjs';
import { getLogworkReminderStatus } from '../lib/reminder-service.mjs';
import { withEnv } from './helpers/env.mjs';

const WINDOWS_NODE = 'C:\\Program Files\\nodejs\\node.exe';
const WINDOWS_ENTRY = 'C:\\Users\\Jane Doe\\.logwork-cli\\bin\\logwork.mjs';
const CONFIG = { enabled: true, time: '17:00', target: 'both', days: [1, 2, 3, 4, 5] };

test('MCP JSON configs use the absolute node path and survive a Windows path with spaces', () => {
  const stdio = JSON.parse(JSON.stringify(stdioMcpServersConfig(WINDOWS_ENTRY, { nodePath: WINDOWS_NODE })));
  assert.equal(stdio.mcpServers.logwork.command, WINDOWS_NODE);
  assert.deepEqual(stdio.mcpServers.logwork.args, [WINDOWS_ENTRY, 'mcp']);

  const vscode = JSON.parse(JSON.stringify(vscodeMcpConfig(WINDOWS_ENTRY, { nodePath: WINDOWS_NODE })));
  assert.equal(vscode.servers.logwork.type, 'stdio');
  assert.equal(vscode.servers.logwork.command, WINDOWS_NODE);

  // The printed snippet is valid JSON with escaped backslashes.
  const printed = formatMcpSetup({ client: 'cursor', serverPath: WINDOWS_ENTRY, nodePath: WINDOWS_NODE, platform: 'win32' });
  assert.match(printed, /"command": "C:\\\\Program Files\\\\nodejs\\\\node\.exe"/);
  const json = JSON.parse(printed.slice(printed.indexOf('{'), printed.lastIndexOf('}') + 1));
  assert.equal(json.mcpServers.logwork.command, WINDOWS_NODE);
  assert.match(printed, /re-run `logwork setup`/);

  // Defaults to the running node, never a bare "node".
  assert.equal(stdioMcpServersConfig('/x/logwork.mjs').mcpServers.logwork.command, process.execPath);
  assert.equal(vscodeMcpConfig('/x/logwork.mjs').servers.logwork.command, process.execPath);
});

test('Codex TOML quotes and escapes the absolute node path', () => {
  const toml = formatCodexToml(WINDOWS_ENTRY, { nodePath: WINDOWS_NODE });
  assert.match(toml, /^command = "C:\\\\Program Files\\\\nodejs\\\\node\.exe"$/m);
  assert.match(toml, /^args = \["C:\\\\Users\\\\Jane Doe\\\\\.logwork-cli\\\\bin\\\\logwork\.mjs", "mcp"\]$/m);
  assert.equal(decodeTomlBasicString(/^command = (".*")$/m.exec(toml)[1]), WINDOWS_NODE);

  const quoted = formatCodexToml('/x/logwork.mjs', { nodePath: '/opt/we"ird/node' });
  assert.equal(decodeTomlBasicString(/^command = (".*")$/m.exec(quoted)[1]), '/opt/we"ird/node');
  assert.match(formatCodexToml('/x/logwork.mjs'), new RegExp(`^command = "${escapeRegExp(process.execPath.replaceAll('\\', '\\\\'))}"$`, 'm'));
});

test('setup fallback snippets on Windows use node.exe plus the entry; the refresh note only for an unstable node', () => {
  const output = formatSetupUserInstructions({
    targetDir: 'C:\\Users\\Jane Doe\\.logwork-cli',
    platform: 'win32',
    nodePath: WINDOWS_NODE,
    env: {}
  });
  assert.match(output, /runs: C:\\Program Files\\nodejs\\node\.exe C:\\Users\\Jane Doe\\\.logwork-cli\\bin\\logwork\.mjs mcp/);
  assert.equal((output.match(/"command": "C:\\\\Program Files\\\\nodejs\\\\node\.exe"/g) || []).length, 2);
  assert.match(output, /^command = "C:\\\\Program Files\\\\nodejs\\\\node\.exe"$/m);
  assert.match(output, /"C:\\\\Users\\\\Jane Doe\\\\\.logwork-cli\\\\bin\\\\logwork\.mjs"/);
  assert.match(output, /claude mcp add --transport stdio --scope user logwork -- 'C:\\Program Files\\nodejs\\node\.exe' 'C:\\Users\\Jane Doe\\\.logwork-cli\\bin\\logwork\.mjs' mcp/);
  // The installer location survives upgrades: no refresh note.
  assert.doesNotMatch(output, /re-run `logwork setup`/);
  assert.doesNotMatch(output, /"command": "node"/);

  const scoop = formatSetupUserInstructions({
    targetDir: 'C:\\Users\\Jane Doe\\.logwork-cli',
    platform: 'win32',
    nodePath: 'C:\\Users\\Jane Doe\\scoop\\apps\\nodejs\\22.11.0\\node.exe',
    env: {}
  });
  assert.match(scoop, /If Node is upgraded or moved .* re-run `logwork setup`/);
});

test('setup fallback snippets on macOS run the launcher with no refresh note', () => {
  const output = formatSetupUserInstructions({
    targetDir: '/Users/jane/.logwork-cli',
    platform: 'darwin',
    nodePath: '/Users/jane/.nvm/versions/node/v22.11.0/bin/node'
  });
  assert.match(output, /runs: \/Users\/jane\/\.logwork-cli\/bin\/logwork-launch mcp/);
  assert.match(output, /"command": "\/Users\/jane\/\.logwork-cli\/bin\/logwork-launch",\n\s+"args": \[\n\s+"mcp"\n\s+\]/);
  assert.match(output, /^args = \["mcp"\]$/m);
  assert.doesNotMatch(output, /\.nvm/);
  assert.doesNotMatch(output, /re-run `logwork setup`/);
  assert.match(output, /finds Node 22\+ itself/);
});

test('runtime file records node path, node version and package version atomically', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'logwork-runtime-'));
  const path = join(dir, 'runtime.json');
  const info = await writeRuntimeInfo({
    path,
    nodePath: '/usr/local/bin/node',
    nodeVersion: 'v24.1.0',
    version: '1.2.0',
    now: () => new Date('2026-11-09T08:00:00.000Z')
  });
  assert.deepEqual(info, {
    nodePath: '/usr/local/bin/node',
    nodeVersion: 'v24.1.0',
    installedAt: '2026-11-09T08:00:00.000Z',
    version: '1.2.0'
  });
  assert.deepEqual(await loadRuntimeInfo({ path }), info);
  assert.equal(await loadRuntimeInfo({ path: join(dir, 'missing.json') }), null);
  await writeFile(join(dir, 'bad.json'), '{not json');
  assert.equal(await loadRuntimeInfo({ path: join(dir, 'bad.json') }), null);
  await writeFile(join(dir, 'empty.json'), '{}');
  assert.equal(await loadRuntimeInfo({ path: join(dir, 'empty.json') }), null);

  // setup writes runtime.json in the helper home with the package version.
  const home = await mkdtemp(join(tmpdir(), 'logwork-runtime-home-'));
  await writeFile(join(home, 'package.json'), JSON.stringify({ name: 'logwork-cli', version: '9.8.7' }));
  const recorded = await recordRuntimeInfo(home, { nodePath: WINDOWS_NODE, nodeVersion: 'v22.11.0' });
  const saved = JSON.parse(await readFile(join(home, 'runtime.json'), 'utf8'));
  assert.equal(saved.nodePath, WINDOWS_NODE);
  assert.equal(saved.nodeVersion, 'v22.11.0');
  assert.equal(saved.version, '9.8.7');
  assert.ok(Date.parse(saved.installedAt));
  assert.deepEqual(recorded, saved);
  // A failed write never fails setup.
  assert.equal(await recordRuntimeInfo(home, { writeFn: async () => { throw new Error('EACCES'); } }), null);
});

test('setup records the runtime before it re-registers the reminder', async () => {
  const order = [];
  await installUserRuntime({
    options: { loginMode: 'skip' },
    sourceDir: '/same',
    targetDir: '/same',
    mkdirFn: async () => {},
    cleanupFn: async () => ({ changed: false }),
    installFn: async () => {},
    linkFn: async () => ({ linked: true, commandAvailable: true }),
    authFn: async () => null,
    runtimeInfoFn: async () => { order.push('runtime'); },
    launcherFn: async () => { order.push('launcher'); },
    reminderFn: async () => { order.push('reminder'); return null; },
    mcpInstallFn: async () => { order.push('mcp'); return { mode: 'skipped' }; },
    printFn: async () => {}
  });
  assert.deepEqual(order, ['runtime', 'launcher', 'reminder', 'mcp']);
});

test('setup re-registers an enabled reminder that runs the launcher', async () => {
  let plist = '';
  let launcher = null;
  const newNode = '/Users/test/.nvm/versions/node/v24.1.0/bin/node';
  const result = await refreshReminderSchedule('/Users/test/.logwork-cli', {
    nodePath: newNode,
    loadConfig: async () => CONFIG,
    install: (config, options) => installReminderScheduler(config, {
      ...options,
      platform: 'darwin',
      userHome: '/Users/test',
      uid: 501,
      accessRunner: async () => {},
      writeLauncherFn: async (value) => { launcher = value; },
      writeFile: async (_path, content) => { plist = content; },
      run: async () => ({ code: 0, stdout: '', stderr: '' })
    })
  });
  assert.deepEqual(result, { ok: true, nodePath: newNode });
  assert.equal(parseMacosPlistNodePath(plist), '/Users/test/.logwork-cli/bin/logwork-launch');
  assert.match(plist, /logwork-launch<\/string>\n\s+<string>reminder<\/string>\n\s+<string>run<\/string>/);
  assert.doesNotMatch(plist, /\.nvm|logwork\.mjs/);
  assert.deepEqual(launcher, { home: '/Users/test/.logwork-cli', nodePath: newNode, platform: 'darwin' });

  // Windows: the task runs node.exe (the nvm-windows symlink here) plus the entry.
  let createArgs = null;
  await installReminderScheduler(CONFIG, {
    platform: 'win32',
    home: 'C:\\Users\\test\\.logwork-cli',
    nodePath: 'C:\\Users\\test\\AppData\\Roaming\\nvm\\v22.11.0\\node.exe',
    env: { NVM_HOME: 'C:\\Users\\test\\AppData\\Roaming\\nvm', NVM_SYMLINK: 'C:\\nvm4w\\nodejs' },
    accessRunner: async () => {},
    writeLauncherFn: async () => { throw new Error('no launcher on Windows'); },
    run: async (command, args) => {
      if (args[0] === '/Create') {
        createArgs = args;
      }
      return { code: args[0] === '/Query' ? 1 : 0, stdout: '', stderr: '' };
    }
  });
  assert.equal(createArgs[createArgs.indexOf('/TR') + 1], 'C:\\nvm4w\\nodejs\\node.exe C:\\Users\\test\\.logwork-cli\\bin\\logwork.mjs reminder run --home C:\\Users\\test\\.logwork-cli');

  assert.equal(await refreshReminderSchedule('/x', { loadConfig: async () => ({ ...CONFIG, enabled: false }) }), null);
});

test('scheduler node path is read back from the launchd plist and the Windows task XML', async () => {
  const plist = buildMacosReminderPlist({
    config: CONFIG,
    nodePath: '/opt/homebrew/Cellar/node/24.1.0/bin/node',
    runnerPath: '/Users/test/.logwork-cli/bin/logwork.mjs',
    home: '/Users/test/.logwork-cli'
  });
  assert.equal(parseMacosPlistNodePath(plist), '/opt/homebrew/Cellar/node/24.1.0/bin/node');
  assert.equal(parseMacosPlistNodePath('<plist></plist>'), null);

  const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task><Actions Context="Author"><Exec>
  <Command>"C:\\Program Files\\nodejs\\node.exe"</Command>
  <Arguments>C:\\Users\\test\\.logwork-cli\\bin\\logwork.mjs reminder run --home C:\\Users\\test\\.logwork-cli</Arguments>
</Exec></Actions></Task>`;
  assert.equal(parseWindowsTaskNodePath(xml), WINDOWS_NODE);
  assert.equal(parseWindowsTaskNodePath('<Command>C:\\nvm\\v22&amp;x\\node.exe</Command>'), 'C:\\nvm\\v22&x\\node.exe');
  assert.equal(parseWindowsTaskNodePath(Buffer.from(xml, 'utf16le').toString('utf8')), WINDOWS_NODE, 'UTF-16 output read as UTF-8');

  const darwin = await getReminderSchedulerStatus({
    platform: 'darwin',
    userHome: '/Users/test',
    uid: 501,
    accessFile: async () => {},
    readFile: async () => plist,
    run: async () => ({ code: 0, stdout: '', stderr: '' })
  });
  assert.equal(darwin.installed, true);
  assert.equal(darwin.nodePath, '/opt/homebrew/Cellar/node/24.1.0/bin/node');

  const calls = [];
  const windows = await getReminderSchedulerStatus({
    platform: 'win32',
    run: async (command, args) => {
      calls.push(args);
      return { code: 0, stdout: args.includes('/XML') ? xml : 'TaskName: \\Logwork Reminder', stderr: '' };
    }
  });
  assert.equal(windows.nodePath, WINDOWS_NODE);
  assert.ok(calls.every((args) => args[0] === '/Query'), 'status only queries the task');
});

test('node path inspection detects missing and stale paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'logwork-node-path-'));
  const current = join(dir, 'v24', 'node');
  const old = join(dir, 'v22', 'node');
  await mkdir(join(dir, 'v24'));
  await mkdir(join(dir, 'v22'));
  await writeFile(current, '');
  await writeFile(old, '');

  assert.equal((await inspectNodePath(join(dir, 'gone', 'node'), { currentPath: current })).status, 'missing');
  assert.equal((await inspectNodePath(old, { currentPath: current })).status, 'stale');
  assert.equal((await inspectNodePath(current, { currentPath: current })).status, 'ok');
  assert.equal((await inspectNodePath(old, { currentPath: join(dir, 'nowhere') })).status, 'differs');
  assert.equal((await inspectNodePath('', { currentPath: current })).status, 'unknown');
  if (process.platform !== 'win32') {
    const link = join(dir, 'node-link');
    await symlink(current, link);
    assert.equal((await inspectNodePath(link, { currentPath: current })).status, 'ok', 'a symlink to the current node is not stale');
  }

  assert.match(formatNodePathIssue('reminder', { status: 'missing', recordedPath: old }), /no longer exists.*`logwork reminder enable`/);
  assert.match(formatNodePathIssue('reminder', { status: 'stale', recordedPath: old, currentPath: current }), /current command is .*`logwork reminder enable`/);
  assert.match(formatNodePathIssue('reminder', { status: 'legacy', recordedPath: old }), /directly instead of the logwork launcher.*re-run `logwork setup`/);
  assert.match(formatNodePathIssue('runtime', { status: 'missing', recordedPath: old }), /no longer exists.*`logwork setup`/);
  assert.match(formatNodePathIssue('runtime', { status: 'stale', recordedPath: old, currentPath: current }), /`logwork setup`/);
  assert.equal(formatNodePathIssue('runtime', { status: 'ok' }), '');
});

test('reminder status classifies the scheduled command: launcher, legacy raw node, missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'logwork-reminder-node-'));
  const launcher = join(dir, 'bin', 'logwork-launch');
  await mkdir(join(dir, 'bin'));
  await writeFile(launcher, '');
  const oldNode = join(dir, 'old-node');
  await writeFile(oldNode, '');
  const launch = { command: launcher, argsPrefix: [], kind: 'launcher', stable: true };
  const base = {
    loadConfig: async () => CONFIG,
    loadState: async () => null,
    inspectNode: (path) => inspectScheduledCommand(path, { launch, platform: 'darwin' })
  };

  const missing = await getLogworkReminderStatus({
    ...base,
    schedulerStatus: async () => ({ installed: true, scheduler: 'launchd', nodePath: join(dir, 'removed', 'node') })
  });
  assert.equal(missing.nodeCheck.status, 'missing');
  assert.match(missing.summary, /OS scheduler: launchd installed/);
  assert.match(missing.summary, /Warning: Reminder: the OS schedule runs Node at .*removed.* no longer exists.*`logwork reminder enable`/);

  const legacy = await getLogworkReminderStatus({
    ...base,
    schedulerStatus: async () => ({ installed: true, scheduler: 'launchd', nodePath: oldNode })
  });
  assert.equal(legacy.nodeCheck.status, 'legacy');
  assert.match(legacy.summary, /directly instead of the logwork launcher.*re-run `logwork setup`/);

  const otherLauncher = await getLogworkReminderStatus({
    ...base,
    schedulerStatus: async () => ({ installed: true, scheduler: 'launchd', nodePath: join(dir, 'gone', 'bin', 'logwork-launch') })
  });
  assert.equal(otherLauncher.nodeCheck.status, 'missing');
  assert.match(otherLauncher.summary, /runs the logwork launcher at .*gone/);

  const healthy = await getLogworkReminderStatus({
    ...base,
    schedulerStatus: async () => ({ installed: true, scheduler: 'launchd', nodePath: launcher }),
    checkLaunch: async () => ({ status: 'ok', kind: 'launcher', command: launcher, node: '/opt/homebrew/bin/node', version: '1.2.0' })
  });
  assert.equal(healthy.nodeCheck.status, 'ok');
  assert.match(healthy.summary, /Launcher: runs Node \/opt\/homebrew\/bin\/node\./);
  assert.doesNotMatch(healthy.summary, /Warning/);

  const broken = await getLogworkReminderStatus({
    ...base,
    schedulerStatus: async () => ({ installed: true, scheduler: 'launchd', nodePath: launcher }),
    checkLaunch: async () => ({ status: 'no_node', kind: 'launcher', command: launcher })
  });
  assert.match(broken.summary, /Warning: Launcher: found no usable Node\.js 22\+/);

  // Windows: the task runs node.exe; compared with the current launch command.
  const windowsLaunch = { command: WINDOWS_NODE, argsPrefix: [WINDOWS_ENTRY], kind: 'node', stable: true };
  const windowsCurrent = await inspectScheduledCommand(WINDOWS_NODE.toUpperCase(), { launch: windowsLaunch, platform: 'win32', exists: async () => true });
  assert.equal(windowsCurrent.status, 'ok');
  const windowsStale = await inspectScheduledCommand('C:\\nvm\\v22.1.0\\node.exe', {
    launch: windowsLaunch,
    platform: 'win32',
    inspect: async (path, options) => ({ status: 'stale', recordedPath: path, currentPath: options.currentPath })
  });
  assert.equal(windowsStale.status, 'stale');
  assert.match(formatNodePathIssue('reminder', windowsStale), /runs Node at C:\\nvm.*current command is C:\\Program Files/);
});

test('doctor reports the launcher, a missing or stale node path with the fix, and stays sanitized', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'logwork-doctor-node-'));
  await withEnv({ LOGWORK_HOME: dir, LOGWORK_HELPER_HOME: undefined }, async () => {
    const windowsLaunch = { command: WINDOWS_NODE, argsPrefix: [WINDOWS_ENTRY], kind: 'node', stable: true };
    const check = await collectNodeRuntimeCheck({
      launch: windowsLaunch,
      checkLaunch: async () => ({ status: 'ok', kind: 'node', command: WINDOWS_NODE, node: WINDOWS_NODE, version: '1.2.0' }),
      loadRuntime: async () => ({ nodePath: join(dir, 'v22', 'node'), nodeVersion: 'v22.11.0' }),
      readSchedulerNodePath: async () => '/old/node?access_token=secret-value',
      inspect: async (path) => ({ status: 'missing', recordedPath: path, currentPath: '/new/node' }),
      inspectScheduled: async (path) => ({ status: 'stale', recordedPath: path, currentPath: '/new/node', kind: 'node' })
    });
    assert.equal(check.recordedStatus, 'missing');
    assert.equal(check.reminderStatus, 'stale');
    assert.equal(check.launchStatus, 'ok');
    assert.equal(check.issues.length, 2);

    const outputPath = join(dir, 'diagnostics', 'report.txt');
    const result = await generateDiagnosticsReport({
      outputPath,
      cwd: dir,
      commandFinder: async () => ({ available: false, path: null }),
      authStatusFn: async () => ({ authenticated: false }),
      mcpSmokeFn: async () => ({ ok: true, toolCount: 0, tools: [] }),
      nodeRuntimeFn: async () => check,
      mcpClientsFn: async () => [
        { label: 'Cursor', status: 'stale', reason: 'runs Node at /gone/node, which no longer exists', legacy: true, localScopes: 0 },
        { label: 'Codex', status: 'current', reason: '', legacy: false, localScopes: 0 }
      ]
    });
    const report = await readFile(outputPath, 'utf8');
    assert.match(report, /# Node Path/);
    assert.match(report, /launchCommand: C:\\Program Files\\nodejs\\node\.exe C:\\Users/);
    assert.match(report, /launchStatus: ok/);
    assert.match(report, /recordedNodeStatus: missing/);
    assert.match(report, /reminderNodeStatus: stale/);
    assert.match(report, /warning: Runtime: .*no longer exists.*`logwork setup`/);
    assert.match(report, /# MCP Clients\nCursor: stale \(runs Node at \/gone\/node, which no longer exists; leftover logwork-helper entry\)\nCodex: current/);
    assert.match(result.summary, /Warning: Reminder: .*`logwork reminder enable`/);
    assert.match(result.summary, /Warning: MCP: Cursor: stale .*`logwork mcp install`/);
    assert.match(result.summary, /Diagnostics report written to/);
    assert.doesNotMatch(report, /secret-value/);
    assert.doesNotMatch(result.summary, /secret-value/);

    // macOS launcher: a gone recorded node is covered by the launcher fallback.
    const launcherPath = join(dir, 'bin', 'logwork-launch');
    const covered = await collectNodeRuntimeCheck({
      launch: { command: launcherPath, argsPrefix: [], kind: 'launcher', stable: true },
      checkLaunch: async () => ({ status: 'ok', kind: 'launcher', command: launcherPath, node: '/opt/homebrew/bin/node', version: '1.2.0' }),
      loadRuntime: async () => ({ nodePath: join(dir, 'v22', 'node'), nodeVersion: 'v22.11.0' }),
      readSchedulerNodePath: async () => null
    });
    assert.equal(covered.recordedStatus, 'missing');
    assert.match(covered.recordedNote, /launcher uses \/opt\/homebrew\/bin\/node/);
    assert.deepEqual(covered.issues, []);

    const brokenLauncher = await collectNodeRuntimeCheck({
      launch: { command: launcherPath, argsPrefix: [], kind: 'launcher', stable: true },
      loadRuntime: async () => null,
      readSchedulerNodePath: async () => null
    });
    assert.equal(brokenLauncher.launchStatus, 'missing');
    assert.match(brokenLauncher.issues[0], /Launcher: .*logwork-launch is missing.*`logwork setup`/);

    // Healthy runtime: no warnings.
    const healthy = await generateDiagnosticsReport({
      outputPath,
      cwd: dir,
      commandFinder: async () => ({ available: false, path: null }),
      authStatusFn: async () => ({ authenticated: false }),
      mcpSmokeFn: async () => ({ ok: true, toolCount: 0, tools: [] }),
      mcpClientsFn: async () => [],
      nodeRuntimeFn: () => collectNodeRuntimeCheck({
        launch: { command: launcherPath, argsPrefix: [], kind: 'launcher', stable: true },
        checkLaunch: async () => ({ status: 'ok', kind: 'launcher', command: launcherPath, node: process.execPath, version: '1.2.0' }),
        loadRuntime: async () => ({ nodePath: process.execPath, nodeVersion: process.version }),
        readSchedulerNodePath: async () => null
      })
    });
    assert.match(healthy.report, /recordedNodeStatus: ok/);
    assert.match(healthy.report, /launchNode: /);
    assert.match(healthy.report, /warnings: none/);
    assert.match(healthy.report, /# MCP Clients\nnone detected/);
    assert.deepEqual(healthy.nodeIssues, []);
    assert.doesNotMatch(healthy.summary, /Warning/);
  });
});

function decodeTomlBasicString(literal) {
  return JSON.parse(literal);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
