import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
// Most tests run the client logic as macOS (platform: 'darwin'), which builds
// paths with posix separators; build the expected paths the same way so the
// suite also passes on Windows runners.
import { posix } from 'node:path';

const { dirname, join } = posix;
import {
  applyMcpClientPlan,
  claudeAddArgs,
  createMcpInstallContext,
  describeMcpPlan,
  formatBackupStamp,
  inspectMcpClients,
  mcpClientTargets,
  normalizeMcpInstallClient,
  parseCodexConfig,
  parseDottedKey,
  parseTomlValue,
  planMcpInstall,
  quoteCmdArg,
  rewriteCodexConfig,
  whichCommand
} from '../lib/mcp-install.mjs';
import { formatCodexToml } from '../lib/manual-mcp.mjs';

const LAUNCHER = '/Users/jane/.logwork-cli/bin/logwork-launch';
const LAUNCH = { command: LAUNCHER, argsPrefix: [], kind: 'launcher', stable: true };
const NOW = new Date(2026, 10, 9, 8, 30, 5);
const STAMP = '20261109083005';
const OLD_ENTRY = { command: '/Users/jane/.nvm/versions/node/v20.1.0/bin/node', args: ['/Users/jane/.logwork-cli/bin/logwork.mjs', 'mcp'] };

async function makeUserHome(...dirs) {
  const userHome = await mkdtemp(join(tmpdir(), 'logwork-mcp-install-'));
  for (const dir of dirs) {
    await mkdir(join(userHome, dir), { recursive: true });
  }
  return userHome;
}

function context(userHome, overrides = {}) {
  return createMcpInstallContext({
    platform: 'darwin',
    userHome,
    env: {},
    launch: LAUNCH,
    findCommand: async () => null,
    runCommand: async () => { throw new Error('no CLI in this test'); },
    now: () => NOW,
    ...overrides
  });
}

async function planFor(ctx, key) {
  const [plan] = await planMcpInstall(ctx, { clients: [key], explicit: true });
  return plan;
}

async function backups(file) {
  const names = await readdir(dirname(file));
  return names.filter((name) => name.startsWith(`${file.split(/[\\/]/).pop()}.logwork-backup-`));
}

// In-memory files for Windows paths, which the POSIX test host cannot create.
function memoryFs(files = {}, dirs = []) {
  const store = new Map(Object.entries(files));
  const dirSet = new Set(dirs);
  const missing = (path) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  return {
    store,
    api: {
      access: async (path) => {
        if (!store.has(path) && !dirSet.has(path)) {
          throw missing(path);
        }
      },
      readFile: async (path) => {
        if (!store.has(path)) {
          throw missing(path);
        }
        return store.get(path);
      },
      realpath: async (path) => path,
      stat: async () => ({ mode: 0o100644 }),
      copyFile: async (from, to) => { store.set(to, store.get(from)); },
      writeFile: async (path, content) => { store.set(path, content); }
    }
  };
}

test('client names, targets and backup stamps', () => {
  assert.equal(normalizeMcpInstallClient('Claude Code'), 'claude');
  assert.equal(normalizeMcpInstallClient('copilot'), 'vscode');
  assert.equal(normalizeMcpInstallClient('codex'), 'codex');
  assert.equal(normalizeMcpInstallClient('zed'), null);
  assert.equal(formatBackupStamp(NOW), STAMP);

  const mac = Object.fromEntries(mcpClientTargets({ platform: 'darwin', userHome: '/Users/jane', env: {} }).map((client) => [client.key, client.file]));
  assert.deepEqual(mac, {
    claude: '/Users/jane/.claude.json',
    cursor: '/Users/jane/.cursor/mcp.json',
    codex: '/Users/jane/.codex/config.toml',
    vscode: '/Users/jane/Library/Application Support/Code/User/mcp.json',
    antigravity: '/Users/jane/.gemini/antigravity/mcp_config.json'
  });
  const windows = Object.fromEntries(mcpClientTargets({ platform: 'win32', userHome: 'C:\\Users\\Jane', env: { APPDATA: 'D:\\Roaming' } }).map((client) => [client.key, client.file]));
  assert.equal(windows.vscode, 'D:\\Roaming\\Code\\User\\mcp.json');
  assert.equal(windows.cursor, 'C:\\Users\\Jane\\.cursor\\mcp.json');
  assert.equal(windows.codex, 'C:\\Users\\Jane\\.codex\\config.toml');
  assert.equal(mcpClientTargets({ platform: 'win32', userHome: 'C:\\Users\\Jane', env: {} }).find((client) => client.key === 'vscode').file, 'C:\\Users\\Jane\\AppData\\Roaming\\Code\\User\\mcp.json');
  assert.equal(mcpClientTargets({ platform: 'darwin', userHome: '/u', env: { CLAUDE_CONFIG_DIR: '/cfg' } })[0].file, '/cfg/.claude.json');
});

test('only clients whose config directory or CLI exists are detected', async () => {
  const userHome = await makeUserHome();
  const ctx = context(userHome);
  assert.deepEqual(await planMcpInstall(ctx), []);
  const explicit = await planFor(ctx, 'cursor');
  assert.equal(explicit.action, 'not_detected');
  assert.equal((await applyMcpClientPlan(explicit, ctx)).status, 'not_detected');
  assert.deepEqual(await readdir(userHome), [], 'nothing is created for a missing client');
});

test('Cursor: creates mcp.json when only the config directory exists', async () => {
  const userHome = await makeUserHome('.cursor');
  const ctx = context(userHome);
  const plan = await planFor(ctx, 'cursor');
  assert.equal(plan.action, 'add');
  assert.deepEqual(describeMcpPlan(plan, ctx), [
    `Cursor (${join(userHome, '.cursor', 'mcp.json')}): would add the logwork entry`,
    `  + command: ${LAUNCHER}`,
    '  + args: ["mcp"]',
    '  (new file)'
  ]);
  const result = await applyMcpClientPlan(plan, ctx);
  assert.equal(result.status, 'added');
  assert.equal(result.backup, null);
  const text = await readFile(join(userHome, '.cursor', 'mcp.json'), 'utf8');
  assert.equal(text, `${JSON.stringify({ mcpServers: { logwork: { command: LAUNCHER, args: ['mcp'] } } }, null, 2)}\n`);
});

test('Cursor: merges with other servers, replaces a stale entry, removes logwork-helper, backs up once, then is a no-op', async () => {
  const userHome = await makeUserHome('.cursor');
  const file = join(userHome, '.cursor', 'mcp.json');
  const original = `${JSON.stringify({
    mcpServers: {
      github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
      logwork: { ...OLD_ENTRY, env: { LOGWORK_PROFILE: 'staging' } },
      'logwork-helper': { command: 'node', args: ['/Users/jane/.logwork-helper/mcp-server.mjs'] }
    },
    theme: 'dark'
  }, null, 4)}\n`;
  await writeFile(file, original);
  const ctx = context(userHome);

  const [status] = await inspectMcpClients(ctx, { clients: ['cursor'] });
  assert.equal(status.status, 'stale');
  assert.match(status.reason, /runs Node at .*v20\.1\.0.*no longer exists/);
  assert.equal(status.legacy, true);

  const plan = await planFor(ctx, 'cursor');
  assert.equal(plan.action, 'update');
  const description = describeMcpPlan(plan, ctx).join('\n');
  assert.match(description, /would update the logwork entry/);
  assert.match(description, /- command: \/Users\/jane\/\.nvm/);
  assert.match(description, /\+ command: \/Users\/jane\/\.logwork-cli\/bin\/logwork-launch/);
  assert.match(description, /- remove the "logwork-helper" entry/);
  assert.match(description, /backup: .*mcp\.json\.logwork-backup-<timestamp>/);

  const result = await applyMcpClientPlan(plan, ctx);
  assert.equal(result.status, 'updated');
  assert.equal(result.backup, `${file}.logwork-backup-${STAMP}`);
  assert.equal(await readFile(result.backup, 'utf8'), original);

  const updatedText = await readFile(file, 'utf8');
  assert.match(updatedText, /^\{\n {2}"mcpServers": \{\n {4}"github"/, '2-space JSON');
  const updated = JSON.parse(updatedText);
  assert.deepEqual(updated.mcpServers.github, { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] });
  assert.deepEqual(updated.mcpServers.logwork, { command: LAUNCHER, args: ['mcp'], env: { LOGWORK_PROFILE: 'staging' } });
  assert.equal(updated.mcpServers['logwork-helper'], undefined);
  assert.equal(updated.theme, 'dark');

  // Second run: identical entry, nothing to do, no second backup.
  const again = await planFor(context(userHome, { now: () => new Date(2026, 10, 9, 9, 0, 0) }), 'cursor');
  assert.equal(again.action, 'none');
  assert.equal(again.status, 'current');
  assert.deepEqual(describeMcpPlan(again, ctx), [`Cursor (${file}): already up to date`]);
  assert.equal((await applyMcpClientPlan(again, ctx)).status, 'up_to_date');
  assert.deepEqual(await backups(file), [`mcp.json.logwork-backup-${STAMP}`]);
  assert.equal(await readFile(file, 'utf8'), updatedText);
});

test('JSON with comments is never written: report and manual snippet instead', async () => {
  const userHome = await makeUserHome('.cursor', join('Library', 'Application Support', 'Code', 'User'));
  const cursorFile = join(userHome, '.cursor', 'mcp.json');
  const jsonc = '{\n  // my servers\n  "mcpServers": {},\n}\n';
  await writeFile(cursorFile, jsonc);
  const vscodeFile = join(userHome, 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
  await writeFile(vscodeFile, '{ "servers": [] }');
  const ctx = context(userHome);

  const [cursor, vscode] = await planMcpInstall(ctx, { clients: ['cursor', 'vscode'] });
  assert.equal(cursor.status, 'unreadable');
  assert.equal(cursor.action, 'manual');
  assert.match(describeMcpPlan(cursor, ctx)[0], /could not update automatically \(the file is not plain JSON/);
  const result = await applyMcpClientPlan(cursor, ctx);
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /not plain JSON/);
  assert.deepEqual(JSON.parse(result.snippet), { mcpServers: { logwork: { command: LAUNCHER, args: ['mcp'] } } });
  assert.equal(await readFile(cursorFile, 'utf8'), jsonc);
  assert.deepEqual(await backups(cursorFile), []);

  assert.equal(vscode.action, 'manual');
  assert.match(vscode.reason, /"servers" is not an object/);
  const vscodeResult = await applyMcpClientPlan(vscode, ctx);
  assert.deepEqual(JSON.parse(vscodeResult.snippet), { servers: { logwork: { type: 'stdio', command: LAUNCHER, args: ['mcp'] } } });
});

test('VS Code and Antigravity: user-level files with their own shapes', async () => {
  const userHome = await makeUserHome(join('Library', 'Application Support', 'Code', 'User'), join('.gemini', 'antigravity'));
  const vscodeFile = join(userHome, 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
  await writeFile(vscodeFile, JSON.stringify({ servers: { other: { type: 'http', url: 'https://x' } }, inputs: [] }));
  const ctx = context(userHome);
  const plans = await planMcpInstall(ctx);
  assert.deepEqual(plans.map((plan) => [plan.key, plan.action]), [['vscode', 'add'], ['antigravity', 'add']]);
  for (const plan of plans) {
    await applyMcpClientPlan(plan, ctx);
  }
  const vscode = JSON.parse(await readFile(vscodeFile, 'utf8'));
  assert.deepEqual(vscode, { servers: { other: { type: 'http', url: 'https://x' }, logwork: { type: 'stdio', command: LAUNCHER, args: ['mcp'] } }, inputs: [] });
  assert.equal((await backups(vscodeFile)).length, 1);
  const antigravity = JSON.parse(await readFile(join(userHome, '.gemini', 'antigravity', 'mcp_config.json'), 'utf8'));
  assert.deepEqual(antigravity, { mcpServers: { logwork: { command: LAUNCHER, args: ['mcp'] } } });
});

test('a symlinked config is updated through the link', { skip: process.platform === 'win32' }, async () => {
  const userHome = await makeUserHome('.cursor', 'dotfiles');
  const real = join(userHome, 'dotfiles', 'cursor-mcp.json');
  await writeFile(real, JSON.stringify({ mcpServers: {} }));
  await symlink(real, join(userHome, '.cursor', 'mcp.json'));
  const ctx = context(userHome);
  const result = await applyMcpClientPlan(await planFor(ctx, 'cursor'), ctx);
  assert.equal(result.status, 'added');
  assert.ok((await lstat(join(userHome, '.cursor', 'mcp.json'))).isSymbolicLink(), 'the link stays a link');
  assert.equal(JSON.parse(await readFile(real, 'utf8')).mcpServers.logwork.command, LAUNCHER);
});

const CODEX_ORIGINAL = `model = "o3"

[mcp_servers.other]
command = "npx"
args = ["-y", "other"]

# logwork server
[mcp_servers.logwork]
command = "/Users/jane/.nvm/versions/node/v20.1.0/bin/node"
args = [
  "/Users/jane/.logwork-cli/bin/logwork.mjs",
  "mcp",
]
startup_timeout_sec = 20

[mcp_servers.logwork.env]
FOO = "bar"

[profiles.fast]
model = "o4-mini"

[mcp_servers.logwork-helper]
command = "node"
args = ["/Users/jane/.logwork-helper/mcp-server.mjs"]
`;

test('Codex: replaces the logwork table with its sub-tables, keeps neighbours, drops logwork-helper', async () => {
  const userHome = await makeUserHome('.codex');
  const file = join(userHome, '.codex', 'config.toml');
  await writeFile(file, CODEX_ORIGINAL);
  const ctx = context(userHome);

  const plan = await planFor(ctx, 'codex');
  assert.equal(plan.status, 'stale');
  assert.equal(plan.legacy, true);
  assert.equal(plan.existing.command, '/Users/jane/.nvm/versions/node/v20.1.0/bin/node');
  assert.deepEqual(plan.existing.args, ['/Users/jane/.logwork-cli/bin/logwork.mjs', 'mcp']);

  const result = await applyMcpClientPlan(plan, ctx);
  assert.equal(result.status, 'updated');
  assert.equal(await readFile(`${file}.logwork-backup-${STAMP}`, 'utf8'), CODEX_ORIGINAL);
  assert.equal(await readFile(file, 'utf8'), `model = "o3"

[mcp_servers.other]
command = "npx"
args = ["-y", "other"]

# logwork server
[mcp_servers.logwork]
command = "${LAUNCHER}"
args = ["mcp"]
startup_timeout_sec = 20
tool_timeout_sec = 120

[profiles.fast]
model = "o4-mini"
`);

  const again = await planFor(ctx, 'codex');
  assert.equal(again.action, 'none');
  assert.equal((await applyMcpClientPlan(again, ctx)).status, 'up_to_date');
  assert.equal((await backups(file)).length, 1);
});

test('Codex: appends to a config without the table and creates a missing config.toml', async () => {
  const userHome = await makeUserHome('.codex');
  const file = join(userHome, '.codex', 'config.toml');
  const ctx = context(userHome);

  const created = await applyMcpClientPlan(await planFor(ctx, 'codex'), ctx);
  assert.equal(created.status, 'added');
  assert.equal(await readFile(file, 'utf8'), `${formatCodexToml(LAUNCH)}\n`);

  // A """ string that contains a fake header is data, not a table.
  const original = 'model = "o3"\ninstructions = """\n[mcp_servers.logwork]\n"""\n\n\n';
  await writeFile(file, original);
  const appended = await applyMcpClientPlan(await planFor(ctx, 'codex'), ctx);
  assert.equal(appended.status, 'added');
  assert.equal(await readFile(file, 'utf8'), `model = "o3"\ninstructions = """\n[mcp_servers.logwork]\n"""\n\n${formatCodexToml(LAUNCH)}\n`);
});

test('Codex: CRLF files keep CRLF and quoted headers are recognized', () => {
  const crlf = '[mcp_servers."logwork"]\r\ncommand = "old"\r\nargs = ["mcp"]\r\n\r\n[other]\r\nkey = 1\r\n';
  const parsed = parseCodexConfig(crlf);
  assert.equal(parsed.servers.logwork.command, 'old');
  const rewritten = rewriteCodexConfig(crlf, formatCodexToml(LAUNCH));
  assert.equal(rewritten, `${formatCodexToml(LAUNCH).split('\n').join('\r\n')}\r\n\r\n[other]\r\nkey = 1\r\n`);
});

test('Codex: unusual TOML is refused and left untouched', async () => {
  const cases = [
    ['[mcp_servers]\nlogwork = { command = "node" }\n', /outside its own \[mcp_servers\.logwork\] table/],
    ['mcp_servers.logwork.command = "node"\n', /outside its own/],
    ['mcp_servers = { other = { command = "x" } }\n', /inline table/],
    ['[[mcp_servers.logwork]]\ncommand = "x"\n', /array tables/],
    ['x = """\nunterminated\n', /unterminated multi-line string/],
    ['[mcp_servers.logwork.env]\nA = "1"\n[mcp_servers."logwork\n', /unusual table header/],
    ['[mcp_servers.logwork x]\ncommand = "x"\n', /unusual table header/]
  ];
  const userHome = await makeUserHome('.codex');
  const file = join(userHome, '.codex', 'config.toml');
  const ctx = context(userHome);
  for (const [text, reason] of cases) {
    await writeFile(file, text);
    const plan = await planFor(ctx, 'codex');
    assert.equal(plan.action, 'manual', text);
    assert.match(plan.reason, reason);
    const result = await applyMcpClientPlan(plan, ctx);
    assert.equal(result.status, 'failed');
    assert.match(result.snippet, /^\[mcp_servers\.logwork\]$/m);
    assert.equal(await readFile(file, 'utf8'), text);
  }
  assert.deepEqual(await backups(file), []);
  assert.equal(rewriteCodexConfig('[mcp_servers]\nlogwork = {}\n', 'x'), null);
});

test('TOML helpers parse keys, strings and arrays', () => {
  assert.deepEqual(parseDottedKey('mcp_servers . "log work".\'x\''), ['mcp_servers', 'log work', 'x']);
  assert.equal(parseDottedKey('a..b'), null);
  assert.equal(parseDottedKey('"open'), null);
  assert.equal(parseTomlValue('"C:\\\\Program Files\\\\nodejs\\\\node.exe" # comment'), 'C:\\Program Files\\nodejs\\node.exe');
  assert.equal(parseTomlValue('"\\u00e9\\t"'), '\u00e9\t');
  assert.equal(parseTomlValue("'literal\\path'"), 'literal\\path');
  assert.deepEqual(parseTomlValue('[ "a", \'b\', ]'), ['a', 'b']);
  assert.equal(parseTomlValue('20'), undefined);
  assert.equal(parseTomlValue('"a" trailing'), undefined);
  assert.equal(parseTomlValue('"""x"""'), undefined);
  // A logwork table whose command is not a string is stale, not current.
  const parsed = parseCodexConfig('[mcp_servers.logwork]\ncommand = 42\n');
  assert.equal(parsed.servers.logwork.unparsed, true);
});

test('Windows: JSON and TOML keep backslashes, paths compare case-insensitively', async () => {
  const userHome = 'C:\\Users\\Jane Doe';
  const winLaunch = { command: 'C:\\Program Files\\nodejs\\node.exe', argsPrefix: ['C:\\Users\\Jane Doe\\.logwork-cli\\bin\\logwork.mjs'], kind: 'node', stable: true };
  const cursorFile = 'C:\\Users\\Jane Doe\\.cursor\\mcp.json';
  const codexFile = 'C:\\Users\\Jane Doe\\.codex\\config.toml';
  const vscodeDir = 'C:\\Users\\Jane Doe\\AppData\\Roaming\\Code\\User';
  const memory = memoryFs({
    [cursorFile]: JSON.stringify({ mcpServers: { logwork: { command: 'c:\\program files\\nodejs\\NODE.EXE', args: ['c:\\users\\jane doe\\.logwork-cli\\bin\\logwork.mjs', 'mcp'] } } }),
    [codexFile]: '[mcp_servers.logwork]\ncommand = "C:\\\\nvm\\\\v20.0.0\\\\node.exe"\nargs = ["C:\\\\Users\\\\Jane Doe\\\\.logwork-cli\\\\bin\\\\logwork.mjs", "mcp"]\n'
  }, ['C:\\Users\\Jane Doe\\.cursor', 'C:\\Users\\Jane Doe\\.codex', vscodeDir]);
  const ctx = createMcpInstallContext({
    platform: 'win32',
    userHome,
    env: { APPDATA: 'C:\\Users\\Jane Doe\\AppData\\Roaming' },
    launch: winLaunch,
    fsApi: memory.api,
    findCommand: async () => null,
    now: () => NOW
  });

  const plans = await planMcpInstall(ctx);
  const byKey = Object.fromEntries(plans.map((plan) => [plan.key, plan]));
  assert.equal(byKey.cursor.action, 'none', 'same path in another case is current');
  assert.equal(byKey.codex.status, 'stale');
  assert.match(byKey.codex.reason, /runs Node at C:\\nvm\\v20\.0\.0\\node\.exe, which no longer exists/);
  assert.equal(byKey.vscode.action, 'add');

  await applyMcpClientPlan(byKey.codex, ctx);
  await applyMcpClientPlan(byKey.vscode, ctx);
  const toml = memory.store.get(codexFile);
  assert.match(toml, /^command = "C:\\\\Program Files\\\\nodejs\\\\node\.exe"$/m);
  assert.match(toml, /^args = \["C:\\\\Users\\\\Jane Doe\\\\\.logwork-cli\\\\bin\\\\logwork\.mjs", "mcp"\]$/m);
  assert.deepEqual(parseCodexConfig(toml).servers.logwork.args, [...winLaunch.argsPrefix, 'mcp']);
  assert.equal(memory.store.get(`${codexFile}.logwork-backup-${STAMP}`).includes('v20.0.0'), true);
  const vscode = JSON.parse(memory.store.get(`${vscodeDir}\\mcp.json`));
  assert.deepEqual(vscode.servers.logwork, { type: 'stdio', command: winLaunch.command, args: [...winLaunch.argsPrefix, 'mcp'] });
});

test('Claude Code with the CLI: remove then add at user scope, clear legacy and stale local-scope entries', async () => {
  const userHome = await makeUserHome('project-a');
  const projectA = join(userHome, 'project-a');
  const claudeFile = join(userHome, '.claude.json');
  const original = JSON.stringify({
    numStartups: 3,
    mcpServers: { logwork: OLD_ENTRY, 'logwork-helper': { command: 'node', args: ['/x/mcp-server.mjs'] } },
    projects: {
      [projectA]: { mcpServers: { logwork: OLD_ENTRY, other: { command: 'x' } } },
      [join(userHome, 'gone-project')]: { mcpServers: { 'logwork-helper': { command: 'node' } } },
      [join(userHome, 'fine')]: { mcpServers: { logwork: { command: LAUNCHER, args: ['mcp'] } } }
    }
  });
  await writeFile(claudeFile, original);
  const calls = [];
  const ctx = context(userHome, {
    findCommand: async (name) => (name === 'claude' ? '/usr/local/bin/claude' : null),
    runCommand: async (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      return { code: 0, stdout: '', stderr: '' };
    }
  });

  const plan = await planFor(ctx, 'claude');
  assert.equal(plan.action, 'update');
  assert.equal(plan.cliPath, '/usr/local/bin/claude');
  assert.deepEqual(plan.localScopes.map((item) => [item.project, item.name]), [
    [projectA, 'logwork'],
    [join(userHome, 'gone-project'), 'logwork-helper']
  ]);
  const description = describeMcpPlan(plan, ctx).join('\n');
  assert.match(description, /Claude Code \(claude CLI\): would update/);
  assert.match(description, /\$ claude mcp add --transport stdio --scope user logwork -- '\/Users\/jane\/\.logwork-cli\/bin\/logwork-launch' mcp/);

  const result = await applyMcpClientPlan(plan, ctx);
  assert.equal(result.status, 'updated');
  assert.equal(result.via, 'claude mcp');
  assert.deepEqual(calls, [
    { command: '/usr/local/bin/claude', args: ['mcp', 'remove', '--scope', 'user', 'logwork'], cwd: undefined },
    { command: '/usr/local/bin/claude', args: ['mcp', 'remove', '--scope', 'user', 'logwork-helper'], cwd: undefined },
    { command: '/usr/local/bin/claude', args: ['mcp', 'remove', '--scope', 'local', 'logwork'], cwd: projectA },
    { command: '/usr/local/bin/claude', args: ['mcp', 'add', '--scope', 'user', 'logwork', '--', LAUNCHER, 'mcp'], cwd: undefined }
  ]);
  assert.equal(await readFile(claudeFile, 'utf8'), original, 'the CLI owns ~/.claude.json');
  assert.deepEqual(await backups(claudeFile), []);
  assert.deepEqual(claudeAddArgs({ command: 'C:\\n\\node.exe', argsPrefix: ['C:\\h\\logwork.mjs'] }), ['mcp', 'add', '--scope', 'user', 'logwork', '--', 'C:\\n\\node.exe', 'C:\\h\\logwork.mjs', 'mcp']);

  // A failing `claude mcp add` is reported with the manual command.
  const failing = context(userHome, {
    findCommand: async () => '/usr/local/bin/claude',
    runCommand: async (_command, args) => ({ code: args[1] === 'add' ? 1 : 0, stdout: '', stderr: 'MCP server logwork already exists\nmore' })
  });
  const failed = await applyMcpClientPlan(await planFor(failing, 'claude'), failing);
  assert.equal(failed.status, 'failed');
  assert.match(failed.reason, /claude mcp add failed with exit code 1: MCP server logwork already exists$/);
  assert.match(failed.snippet, /^claude mcp add --transport stdio --scope user logwork -- /);
});

test('Claude Code without the CLI edits ~/.claude.json, and is skipped when neither exists', async () => {
  const userHome = await makeUserHome();
  const claudeFile = join(userHome, '.claude.json');
  const ctx = context(userHome);
  assert.deepEqual(await planMcpInstall(ctx), []);

  await writeFile(claudeFile, JSON.stringify({
    numStartups: 3,
    mcpServers: { other: { type: 'stdio', command: 'x', args: [], env: {} } },
    projects: { '/p': { mcpServers: { logwork: OLD_ENTRY } } }
  }));
  const plan = await planFor(ctx, 'claude');
  assert.equal(plan.action, 'add');
  const result = await applyMcpClientPlan(plan, ctx);
  assert.equal(result.status, 'added');
  assert.ok(result.backup.endsWith(`.claude.json.logwork-backup-${STAMP}`));
  const json = JSON.parse(await readFile(claudeFile, 'utf8'));
  assert.equal(json.numStartups, 3);
  assert.deepEqual(json.mcpServers.logwork, { type: 'stdio', command: LAUNCHER, args: ['mcp'], env: {} });
  assert.deepEqual(json.mcpServers.other, { type: 'stdio', command: 'x', args: [], env: {} });
  assert.deepEqual(json.projects['/p'].mcpServers, {}, 'the stale local-scope entry is removed');
  assert.equal((await planFor(ctx, 'claude')).action, 'none');
});

test('status classifies current, stale (old runtime, other command), missing, legacy-only and unreadable', async () => {
  const userHome = await makeUserHome('.cursor', '.codex', join('.gemini', 'antigravity'), join('Library', 'Application Support', 'Code', 'User'));
  await writeFile(join(userHome, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { logwork: { command: LAUNCHER, args: ['mcp'] }, 'logwork-helper': {} } }));
  await writeFile(join(userHome, '.claude.json'), JSON.stringify({ mcpServers: { logwork: { command: 'node', args: ['/Users/jane/.logwork-helper/mcp-server.mjs'] } } }));
  await writeFile(join(userHome, '.gemini', 'antigravity', 'mcp_config.json'), JSON.stringify({ mcpServers: { logwork: { command: '/opt/other/logwork', args: ['mcp'] } } }));
  await writeFile(join(userHome, 'Library', 'Application Support', 'Code', 'User', 'mcp.json'), '{,}');
  const clients = await inspectMcpClients(context(userHome));
  const byKey = Object.fromEntries(clients.map((client) => [client.key, client]));
  assert.equal(byKey.cursor.status, 'current');
  assert.equal(byKey.cursor.legacy, true);
  assert.equal(byKey.claude.status, 'stale');
  assert.match(byKey.claude.reason, /old logwork-helper runtime/);
  assert.equal(byKey.antigravity.status, 'stale');
  assert.match(byKey.antigravity.reason, /different command \(\/opt\/other\/logwork\)/);
  assert.equal(byKey.codex.status, 'missing');
  assert.equal(byKey.vscode.status, 'unreadable');

  const nodeOnPath = await inspectMcpClients(context(userHome, { launch: LAUNCH }), { clients: ['cursor'] });
  assert.equal(nodeOnPath[0].status, 'current');
  await writeFile(join(userHome, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { logwork: { command: process.execPath, args: ['/x/logwork.mjs', 'mcp'] } } }));
  const [raw] = await inspectMcpClients(context(userHome), { clients: ['cursor'] });
  assert.match(raw.reason, /runs Node directly .* instead of the logwork launcher/);
});

test('PATH lookup and cmd.exe quoting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'logwork-which-'));
  await writeFile(join(dir, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  if (process.platform !== 'win32') {
    assert.equal(await whichCommand('claude', { platform: 'darwin', env: { PATH: `/nonexistent:${dir}` } }), join(dir, 'claude'));
  }
  assert.equal(await whichCommand('claude', { platform: 'darwin', env: { PATH: '' } }), null);
  const seen = [];
  const found = await whichCommand('claude', {
    platform: 'win32',
    env: { Path: 'C:\\a;C:\\npm' },
    access: async (path) => { seen.push(path); if (path !== 'C:\\npm\\claude.cmd') { throw new Error('ENOENT'); } }
  });
  assert.equal(found, 'C:\\npm\\claude.cmd');
  assert.deepEqual(seen.slice(0, 2), ['C:\\a\\claude.exe', 'C:\\a\\claude.cmd']);
  assert.equal(quoteCmdArg('C:\\Program Files\\nodejs\\node.exe'), '"C:\\Program Files\\nodejs\\node.exe"');
  assert.equal(quoteCmdArg('mcp'), 'mcp');
  assert.throws(() => quoteCmdArg('a"b'), /cmd\.exe/);
});

test('Linux VS Code: the Flatpak config folder is used when ~/.config/Code is missing', async () => {
  const userHome = '/home/jane';
  const flatpakDir = '/home/jane/.var/app/com.visualstudio.code/config/Code/User';
  const memory = memoryFs({}, [flatpakDir]);
  const ctx = context(userHome, { platform: 'linux', fsApi: memory.api });
  const plan = await planFor(ctx, 'vscode');
  assert.equal(plan.label, 'VS Code (Flatpak)');
  assert.equal(plan.file, `${flatpakDir}/mcp.json`);
  assert.equal(plan.action, 'add');
  assert.equal((await applyMcpClientPlan(plan, ctx)).status, 'added');
  assert.deepEqual(JSON.parse(memory.store.get(`${flatpakDir}/mcp.json`)).servers.logwork, { type: 'stdio', command: LAUNCHER, args: ['mcp'] });

  // With both installed, the regular folder wins.
  const both = memoryFs({}, [flatpakDir, '/home/jane/.config/Code/User']);
  const regular = await planFor(context(userHome, { platform: 'linux', fsApi: both.api }), 'vscode');
  assert.equal(regular.label, 'VS Code');
  assert.equal(regular.file, '/home/jane/.config/Code/User/mcp.json');

  // Neither: not detected, at the regular path.
  const none = await planFor(context(userHome, { platform: 'linux', fsApi: memoryFs().api }), 'vscode');
  assert.equal(none.action, 'not_detected');
  assert.equal(none.file, '/home/jane/.config/Code/User/mcp.json');
});
