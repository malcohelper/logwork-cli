import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
// These tests run the client logic as macOS (platform: 'darwin'), which builds
// paths with posix separators; build the expected paths the same way so the
// suite also passes on Windows runners.
import { posix } from 'node:path';

const { join } = posix;
import { formatMcpInstallResults, parseMcpInstallArgs, prepareRuntimeLauncher, runMcpInstall, runMcpStatus } from '../commands/mcp.mjs';
import { formatSetupUserInstructions, installMcpClients } from '../commands/setup.mjs';
import { createMcpInstallContext } from '../lib/mcp-install.mjs';

const ENTRY = 'bin/logwork.mjs';
const LAUNCHER = '/Users/jane/.logwork-cli/bin/logwork-launch';
const LAUNCH = { command: LAUNCHER, argsPrefix: [], kind: 'launcher', stable: true };
const STALE = { mcpServers: { logwork: { command: '/gone/node', args: ['/x/logwork.mjs', 'mcp'] } } };

// A temp HOME (and Windows profile dirs), LOGWORK_HOME and an empty PATH, so
// the CLI never sees the real IDE configs or a real `claude` CLI.
async function isolatedEnv() {
  const root = await mkdtemp(join(tmpdir(), 'logwork-mcp-cli-'));
  const userHome = join(root, 'home');
  const helperHome = join(root, 'helper');
  const emptyPath = join(root, 'path');
  await mkdir(userHome);
  await mkdir(helperHome);
  await mkdir(emptyPath);
  return {
    userHome,
    helperHome,
    env: { HOME: userHome, USERPROFILE: userHome, APPDATA: join(userHome, 'AppData', 'Roaming'), LOGWORK_HOME: helperHome, PATH: emptyPath }
  };
}

function runCli(args, env) {
  return spawnSync(process.execPath, [ENTRY, ...args], { encoding: 'utf8', env });
}

function context(userHome, overrides = {}) {
  return createMcpInstallContext({
    platform: 'darwin',
    userHome,
    env: {},
    launch: LAUNCH,
    findCommand: async () => null,
    now: () => new Date(2026, 10, 9, 8, 30, 5),
    ...overrides
  });
}

test('logwork mcp with no args still serves tools/list and writes nothing else to stdout', async () => {
  const { env } = await isolatedEnv();
  const child = spawn(process.execPath, [ENTRY, 'mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  const lines = [];
  const waitForLines = (count) => new Promise((resolveValue, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out; stdout: ${stdout}`)), 10_000);
    const check = () => {
      const parts = stdout.split('\n');
      lines.splice(0, lines.length, ...parts.slice(0, -1));
      if (lines.length >= count) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolveValue();
      }
    };
    const onData = (chunk) => { stdout += chunk; check(); };
    child.stdout.on('data', onData);
    check();
  });
  try {
    const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    await waitForLines(1);
    // The very first stdout line is the JSON-RPC answer: no banner, no notice.
    const initialized = JSON.parse(lines[0]);
    assert.equal(initialized.id, 1);
    assert.equal(initialized.result.serverInfo.name, 'logwork');
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/list', params: {} });
    await waitForLines(2);
    const tools = JSON.parse(lines[1]);
    assert.equal(tools.id, 2);
    assert.ok(tools.result.tools.some((tool) => tool.name === 'log_work'));
    assert.equal(lines.length, 2, 'only protocol messages on stdout');
  } finally {
    child.kill();
  }
});

test('logwork mcp status and install --dry-run read a temp home and never write', async () => {
  const { userHome, helperHome, env } = await isolatedEnv();
  await mkdir(join(userHome, '.cursor'));
  const cursorFile = join(userHome, '.cursor', 'mcp.json');
  const original = JSON.stringify(STALE);
  await writeFile(cursorFile, original);

  const status = runCli(['mcp', 'status'], env);
  assert.equal(status.status, 0, status.stderr);
  const launcher = process.platform === 'win32' ? helperHome : join(helperHome, 'bin', 'logwork-launch');
  assert.ok(status.stdout.includes(launcher));
  assert.match(status.stdout, /- Cursor \(.*mcp\.json\): stale: runs Node at \/gone\/node, which no longer exists/);
  assert.match(status.stdout, /- Codex: not detected/);
  assert.match(status.stdout, /Run `logwork mcp install`/);

  const dryRun = runCli(['mcp', 'install', '--dry-run'], env);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /Dry run: nothing was written\./);
  assert.match(dryRun.stdout, /Cursor \(.*\): would update the logwork entry\n {2}- command: \/gone\/node/);

  // Not a terminal and no --yes: plan only.
  const plain = runCli(['mcp', 'install'], env);
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /Not an interactive terminal: nothing was written\./);
  assert.match(plain.stdout, /Run `logwork mcp install --yes`/);

  assert.equal(await readFile(cursorFile, 'utf8'), original);
  assert.deepEqual(await readdir(join(userHome, '.cursor')), ['mcp.json']);

  const badClient = runCli(['mcp', 'install', '--client', 'zed'], env);
  assert.equal(badClient.status, 1);
  assert.match(badClient.stderr, /Unknown MCP client: zed/);
  const badCommand = runCli(['mcp', 'nope'], env);
  assert.equal(badCommand.status, 1);
  assert.match(badCommand.stderr, /Unknown mcp command: nope/);
});

test('mcp install args: repeatable --client with aliases, --yes, --dry-run', () => {
  assert.deepEqual(parseMcpInstallArgs([]), { clients: [], yes: false, dryRun: false });
  assert.deepEqual(parseMcpInstallArgs(['--client', 'claude-code', '--client=copilot', '--client', 'claude', '-y', '--dry-run']), { clients: ['claude', 'vscode'], yes: true, dryRun: true });
  assert.throws(() => parseMcpInstallArgs(['--client']), /Unknown MCP client: \(missing\)/);
  assert.throws(() => parseMcpInstallArgs(['--force']), /Unknown mcp install option: --force/);
});

test('mcp install asks once per client that needs a change and honours the answers', async () => {
  const userHome = await mkdtemp(join(tmpdir(), 'logwork-mcp-ask-'));
  await mkdir(join(userHome, '.cursor'));
  await mkdir(join(userHome, '.codex'));
  await mkdir(join(userHome, '.gemini', 'antigravity'), { recursive: true });
  await writeFile(join(userHome, '.gemini', 'antigravity', 'mcp_config.json'), JSON.stringify({ mcpServers: { logwork: { command: LAUNCHER, args: ['mcp'] } } }));
  const questions = [];
  const result = await runMcpInstall({
    ctx: context(userHome),
    interactive: true,
    confirmFn: async (message) => {
      questions.push(message);
      return !message.includes('Cursor');
    }
  });
  assert.deepEqual(questions, [
    `Add the logwork MCP server in Cursor (${join(userHome, '.cursor', 'mcp.json')})?`,
    `Add the logwork MCP server in Codex (${join(userHome, '.codex', 'config.toml')})?`
  ], 'an up-to-date client is not asked about');
  assert.deepEqual(result.results.map((item) => [item.key, item.status]), [['cursor', 'skipped'], ['codex', 'added'], ['antigravity', 'up_to_date']]);
  assert.deepEqual(await readdir(join(userHome, '.cursor')), []);
  assert.match(result.output, /^MCP server "logwork" runs: \/Users\/jane\/\.logwork-cli\/bin\/logwork-launch mcp$/m);
  assert.match(result.output, /- Cursor: skipped\n- Codex: added \(.*config\.toml\)\n- Google Antigravity: already up to date\nRestart or reload the updated clients/);

  // --yes selects only the named client and never asks.
  const yes = await runMcpInstall({ ctx: context(userHome), clients: ['cursor'], yes: true, confirmFn: async () => { throw new Error('must not ask'); } });
  assert.deepEqual(yes.results.map((item) => [item.key, item.status]), [['cursor', 'added']]);

  const none = await runMcpInstall({ ctx: context(await mkdtemp(join(tmpdir(), 'logwork-mcp-none-'))), yes: true });
  assert.match(none.output, /No MCP clients found/);
});

test('install results print the manual snippet only for clients that could not be updated', () => {
  const lines = formatMcpInstallResults([
    { label: 'Cursor', status: 'updated', file: '/u/.cursor/mcp.json', backup: '/u/.cursor/mcp.json.logwork-backup-20261109083005' },
    { label: 'Claude Code', status: 'added', via: 'claude mcp' },
    { label: 'VS Code', status: 'failed', file: '/u/vscode/mcp.json', reason: 'the file is not plain JSON', snippet: '{\n  "servers": {}\n}' },
    { label: 'Codex', status: 'up_to_date' },
    { label: 'X', status: 'not_detected' }
  ]);
  assert.deepEqual(lines, [
    '- Cursor: updated (/u/.cursor/mcp.json); backup /u/.cursor/mcp.json.logwork-backup-20261109083005',
    '- Claude Code: added (claude mcp)',
    '- VS Code: could not update automatically (the file is not plain JSON). Add this manually to /u/vscode/mcp.json:',
    '    {',
    '      "servers": {}',
    '    }',
    '- Codex: already up to date',
    '- X: not detected; skipped',
    'Restart or reload the updated clients to pick up the change.'
  ]);
});

test('mcp status lists every client with its state, leftovers and local-scope entries', async () => {
  const userHome = await mkdtemp(join(tmpdir(), 'logwork-mcp-status-'));
  await mkdir(join(userHome, '.cursor'));
  await writeFile(join(userHome, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { logwork: { command: LAUNCHER, args: ['mcp'] }, 'logwork-helper': {} } }));
  await writeFile(join(userHome, '.claude.json'), JSON.stringify({ projects: { '/p': { mcpServers: { logwork: STALE.mcpServers.logwork } } } }));
  const { output, clients } = await runMcpStatus({ ctx: context(userHome, { findCommand: async () => '/bin/claude' }) });
  assert.equal(clients.length, 5);
  assert.match(output, new RegExp(`- Claude Code \\(${join(userHome, '.claude.json').replace(/[\\.]/g, '\\$&')}; claude CLI found\\): missing\\n {4}local-scope "logwork" entry for /p: runs Node at /gone/node, which no longer exists`));
  assert.match(output, /- Cursor \(.*\): current\n {4}leftover "logwork-helper" entry \(old runtime\)/);
  assert.match(output, /- VS Code: not detected/);
  assert.match(output, /Run `logwork mcp install` to fix the entries above\./);
  assert.match(output, /^Warning: \/Users\/jane\/\.logwork-cli\/bin\/logwork-launch is missing, so these entries cannot start\. Run `logwork setup`\.$/m);

  const empty = await runMcpStatus({ ctx: context(await mkdtemp(join(tmpdir(), 'logwork-mcp-status-empty-'))) });
  assert.match(empty.output, /No MCP clients found/);
});

test('setup MCP step: --yes installs, --no-mcp-install skips, non-TTY only plans', async () => {
  const userHome = await mkdtemp(join(tmpdir(), 'logwork-setup-mcp-'));
  await mkdir(join(userHome, '.cursor'));
  const cursorFile = join(userHome, '.cursor', 'mcp.json');
  await writeFile(cursorFile, JSON.stringify(STALE));

  const skipped = await installMcpClients('/h', { mcpInstall: false }, { interactive: true, ctx: context(userHome), install: () => { throw new Error('must not install'); } });
  assert.equal(skipped.mode, 'skipped');

  const planned = await installMcpClients('/h', { yes: false }, { interactive: false, ctx: context(userHome) });
  assert.equal(planned.mode, 'planned');
  assert.match(planned.lines.join('\n'), /Cursor \(.*\): would update the logwork entry/);
  assert.equal(await readFile(cursorFile, 'utf8'), JSON.stringify(STALE));

  const installed = await installMcpClients('/h', { yes: true }, { interactive: false, ctx: context(userHome) });
  assert.equal(installed.mode, 'installed');
  assert.deepEqual(installed.results.map((item) => [item.key, item.status]), [['cursor', 'updated']]);
  assert.equal(JSON.parse(await readFile(cursorFile, 'utf8')).mcpServers.logwork.command, LAUNCHER);

  // Interactive without --yes goes through the per-client prompt.
  let asked = 0;
  await installMcpClients('/h', {}, {
    interactive: true,
    ctx: context(userHome),
    install: async (options) => { asked += 1; assert.equal(options.interactive, true); assert.equal(options.yes, false); return { results: [] }; }
  });
  assert.equal(asked, 1);

  const failed = await installMcpClients('/h', { yes: true }, { ctx: context(userHome), install: async () => { throw new Error('boom'); } });
  assert.deepEqual({ mode: failed.mode, error: failed.error }, { mode: 'error', error: 'boom' });
});

test('setup summary per MCP mode: results, plan, skipped, none found', () => {
  const base = { targetDir: '/Users/jane/.logwork-cli', platform: 'darwin', authResult: { ok: true } };
  const installed = formatSetupUserInstructions({
    ...base,
    mcpResult: {
      mode: 'installed',
      launch: LAUNCH,
      results: [
        { label: 'Cursor', status: 'updated', file: '/u/.cursor/mcp.json', backup: '/u/.cursor/mcp.json.logwork-backup-1' },
        { label: 'Codex', status: 'up_to_date' }
      ]
    }
  });
  assert.match(installed, /MCP server "logwork" runs: \/Users\/jane\/\.logwork-cli\/bin\/logwork-launch mcp\nMCP clients\n- Cursor: updated/);
  assert.match(installed, /- Codex: already up to date/);
  assert.doesNotMatch(installed, /Manual MCP config|"mcpServers"/, 'no snippet dump when every client was handled');
  assert.doesNotMatch(installed, /Paste the MCP config/);

  const withFailure = formatSetupUserInstructions({
    ...base,
    mcpResult: { mode: 'installed', launch: LAUNCH, results: [{ label: 'VS Code', status: 'failed', reason: 'not plain JSON', snippet: '{"servers":{}}' }] }
  });
  assert.match(withFailure, /- VS Code: could not update automatically \(not plain JSON\)\. Add this manually:\n {4}\{"servers":\{\}\}/);
  assert.doesNotMatch(withFailure, /Manual MCP config/);

  const planned = formatSetupUserInstructions({
    ...base,
    mcpResult: { mode: 'planned', launch: LAUNCH, plans: [{ action: 'update' }], lines: ['Cursor (/u/.cursor/mcp.json): would update the logwork entry'] }
  });
  assert.match(planned, /MCP clients \(not changed: this is not an interactive terminal\)\nCursor \(\/u\/\.cursor\/mcp\.json\): would update the logwork entry\nTo apply: run `logwork mcp install`/);

  const skipped = formatSetupUserInstructions({ ...base, mcpResult: { mode: 'skipped', launch: LAUNCH } });
  assert.match(skipped, /MCP clients: not changed \(--no-mcp-install\)\. Run `logwork mcp install`/);
  assert.doesNotMatch(skipped, /"mcpServers"/);

  const none = formatSetupUserInstructions({ ...base, mcpResult: { mode: 'installed', launch: LAUNCH, results: [] } });
  assert.match(none, /MCP clients: none found/);
  assert.match(none, /Manual MCP config \(paste into your client\):/);
  assert.match(none, /"command": "\/Users\/jane\/\.logwork-cli\/bin\/logwork-launch"/);
  assert.match(none, /Paste the MCP config below into your IDE/);

  const error = formatSetupUserInstructions({ ...base, mcpResult: { mode: 'error', launch: LAUNCH, error: 'EACCES token=abc' } });
  assert.match(error, /could not update automatically \(EACCES token=<redacted>\)/);
  assert.match(error, /Manual MCP config/);
});

test('mcp install writes the launcher for an installed runtime and warns when there is none', async () => {
  const home = await mkdtemp(join(tmpdir(), 'logwork-mcp-runtime-'));
  const writes = [];
  const write = async (options) => { writes.push(options); };
  assert.match(await prepareRuntimeLauncher(home, { write }), /runtime is missing at .*logwork\.mjs.*`logwork setup`/);
  assert.deepEqual(writes, []);

  await mkdir(join(home, 'bin'));
  await writeFile(join(home, 'bin', 'logwork.mjs'), '');
  assert.equal(await prepareRuntimeLauncher(home, { write, dryRun: true, platform: 'darwin' }), '');
  assert.equal(await prepareRuntimeLauncher(home, { write, platform: 'win32' }), '');
  assert.deepEqual(writes, [], 'no write on a dry run or on Windows');
  assert.equal(await prepareRuntimeLauncher(home, { write, platform: 'darwin' }), '');
  assert.deepEqual(writes, [{ home, platform: 'darwin' }]);
});
