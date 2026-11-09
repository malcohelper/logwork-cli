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

test('setup checklist prints every snippet with the absolute node path and the refresh note', () => {
  const output = formatSetupUserInstructions({
    targetDir: 'C:\\Users\\Jane Doe\\.logwork-cli',
    platform: 'win32',
    nodePath: WINDOWS_NODE
  });
  assert.match(output, /runs: C:\\Program Files\\nodejs\\node\.exe C:\\Users\\Jane Doe\\\.logwork-cli\\bin\\logwork\.mjs mcp/);
  assert.equal((output.match(/"command": "C:\\\\Program Files\\\\nodejs\\\\node\.exe"/g) || []).length, 2);
  assert.match(output, /^command = "C:\\\\Program Files\\\\nodejs\\\\node\.exe"$/m);
  assert.match(output, /"C:\\\\Users\\\\Jane Doe\\\\\.logwork-cli\\\\bin\\\\logwork\.mjs"/);
  assert.match(output, /If Node is upgraded or moved .* re-run `logwork setup`/);
  assert.doesNotMatch(output, /"command": "node"/);
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
    reminderFn: async () => { order.push('reminder'); return null; },
    printFn: async () => {}
  });
  assert.deepEqual(order, ['runtime', 'reminder']);
});

test('setup re-registers an enabled reminder with the current node path', async () => {
  let plist = '';
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
      writeFile: async (_path, content) => { plist = content; },
      run: async () => ({ code: 0, stdout: '', stderr: '' })
    })
  });
  assert.deepEqual(result, { ok: true, nodePath: newNode });
  assert.equal(parseMacosPlistNodePath(plist), newNode);

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
  assert.match(formatNodePathIssue('reminder', { status: 'stale', recordedPath: old, currentPath: current }), /current Node is .*`logwork reminder enable`/);
  assert.match(formatNodePathIssue('runtime', { status: 'missing', recordedPath: old }), /no longer exists.*`logwork setup`/);
  assert.match(formatNodePathIssue('runtime', { status: 'stale', recordedPath: old, currentPath: current }), /`logwork setup`/);
  assert.equal(formatNodePathIssue('runtime', { status: 'ok' }), '');
});

test('reminder status warns when the scheduled node path is gone or stale', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'logwork-reminder-node-'));
  const base = {
    loadConfig: async () => CONFIG,
    loadState: async () => null
  };
  const missing = await getLogworkReminderStatus({
    ...base,
    schedulerStatus: async () => ({ installed: true, scheduler: 'launchd', nodePath: join(dir, 'removed', 'node') })
  });
  assert.equal(missing.nodeCheck.status, 'missing');
  assert.match(missing.summary, /OS scheduler: launchd installed/);
  assert.match(missing.summary, /Warning: Reminder: the OS schedule runs Node at .*removed.* no longer exists.*`logwork reminder enable`/);

  const stale = await getLogworkReminderStatus({
    ...base,
    schedulerStatus: async () => ({ installed: true, scheduler: 'launchd', nodePath: '/old/node' }),
    inspectNode: async (path) => ({ status: 'stale', recordedPath: path, currentPath: '/new/node' })
  });
  assert.match(stale.summary, /runs Node at \/old\/node, but the current Node is \/new\/node/);

  const healthy = await getLogworkReminderStatus({
    ...base,
    schedulerStatus: async () => ({ installed: true, scheduler: 'launchd', nodePath: process.execPath })
  });
  assert.equal(healthy.nodeCheck.status, 'ok');
  assert.doesNotMatch(healthy.summary, /Warning/);
});

test('doctor reports a missing or stale node path with the fix and stays sanitized', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'logwork-doctor-node-'));
  await withEnv({ LOGWORK_HOME: dir, LOGWORK_HELPER_HOME: undefined }, async () => {
    const check = await collectNodeRuntimeCheck({
      loadRuntime: async () => ({ nodePath: join(dir, 'v22', 'node'), nodeVersion: 'v22.11.0' }),
      readSchedulerNodePath: async () => '/old/node?access_token=secret-value',
      inspect: async (path) => (path.startsWith('/old')
        ? { status: 'stale', recordedPath: path, currentPath: '/new/node' }
        : { status: 'missing', recordedPath: path, currentPath: '/new/node' })
    });
    assert.equal(check.recordedStatus, 'missing');
    assert.equal(check.reminderStatus, 'stale');
    assert.equal(check.issues.length, 2);

    const outputPath = join(dir, 'diagnostics', 'report.txt');
    const result = await generateDiagnosticsReport({
      outputPath,
      cwd: dir,
      commandFinder: async () => ({ available: false, path: null }),
      authStatusFn: async () => ({ authenticated: false }),
      mcpSmokeFn: async () => ({ ok: true, toolCount: 0, tools: [] }),
      nodeRuntimeFn: async () => check
    });
    const report = await readFile(outputPath, 'utf8');
    assert.match(report, /# Node Path/);
    assert.match(report, /recordedNodeStatus: missing/);
    assert.match(report, /reminderNodeStatus: stale/);
    assert.match(report, /warning: Runtime: .*no longer exists.*`logwork setup`/);
    assert.match(result.summary, /Warning: Reminder: .*`logwork reminder enable`/);
    assert.match(result.summary, /Diagnostics report written to/);
    assert.doesNotMatch(report, /secret-value/);
    assert.doesNotMatch(result.summary, /secret-value/);

    // Healthy runtime: no warnings.
    const healthy = await generateDiagnosticsReport({
      outputPath,
      cwd: dir,
      commandFinder: async () => ({ available: false, path: null }),
      authStatusFn: async () => ({ authenticated: false }),
      mcpSmokeFn: async () => ({ ok: true, toolCount: 0, tools: [] }),
      nodeRuntimeFn: () => collectNodeRuntimeCheck({
        loadRuntime: async () => ({ nodePath: process.execPath, nodeVersion: process.version }),
        readSchedulerNodePath: async () => null
      })
    });
    assert.match(healthy.report, /recordedNodeStatus: ok/);
    assert.match(healthy.report, /warnings: none/);
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
