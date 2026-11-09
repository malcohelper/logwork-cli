import { spawn } from 'node:child_process';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { atomicWriteFile } from './atomic-file.mjs';
import { mcpArgs, pathApi, resolveLaunchCommand } from './launcher.mjs';
import {
  MCP_SERVER_NAME,
  formatClaudeMcpAddCommand,
  formatCodexToml,
  stdioMcpServersConfig,
  vscodeMcpConfig
} from './manual-mcp.mjs';

// Installs or updates the `logwork` MCP server entry in the clients the user
// has. Every file edit reads, parses and merges, touches only the `logwork`
// entry (and removes a legacy `logwork-helper` entry), backs the file up next
// to itself first and writes atomically. Anything that does not parse cleanly
// is left alone and reported with a manual snippet.

export const LEGACY_SERVER_NAME = 'logwork-helper';
export const MCP_INSTALL_CLIENT_KEYS = ['claude', 'cursor', 'codex', 'vscode', 'antigravity'];
const SERVER_NAMES = [MCP_SERVER_NAME, LEGACY_SERVER_NAME];
const CLIENT_ALIASES = {
  'claude-code': 'claude',
  copilot: 'vscode',
  'vs-code': 'vscode',
  'github-copilot': 'vscode',
  'google-antigravity': 'antigravity'
};

export function normalizeMcpInstallClient(value) {
  const key = String(value || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  const resolved = CLIENT_ALIASES[key] || key;
  return MCP_INSTALL_CLIENT_KEYS.includes(resolved) ? resolved : null;
}

// Builds the shared context. Every root (home, APPDATA), file operation and
// command runner can be replaced, so tests never touch the real machine.
export function createMcpInstallContext({
  platform = process.platform,
  userHome = homedir(),
  env = process.env,
  launch,
  home,
  fsApi = {},
  findCommand,
  runCommand = runCliCommand,
  now = () => new Date()
} = {}) {
  return {
    platform,
    userHome,
    env,
    launch: launch || resolveLaunchCommand({ platform, ...(home ? { home } : {}), env }),
    fs: {
      readFile: fs.readFile,
      stat: fs.stat,
      realpath: fs.realpath,
      copyFile: fs.copyFile,
      access: fs.access,
      writeFile: atomicWriteFile,
      ...fsApi
    },
    findCommand: findCommand || ((name) => whichCommand(name, { platform, env })),
    runCommand,
    now
  };
}

export function mcpClientTargets({ platform, userHome, env = {} }) {
  const path = pathApi(platform);
  const claudeDir = env.CLAUDE_CONFIG_DIR || userHome;
  return [
    {
      key: 'claude',
      label: 'Claude Code',
      kind: 'claude',
      file: path.join(claudeDir, '.claude.json'),
      rootKey: 'mcpServers',
      entryType: 'stdio'
    },
    {
      key: 'cursor',
      label: 'Cursor',
      kind: 'json',
      file: path.join(userHome, '.cursor', 'mcp.json'),
      detectPath: path.join(userHome, '.cursor'),
      rootKey: 'mcpServers',
      entryType: null
    },
    {
      key: 'codex',
      label: 'Codex',
      kind: 'toml',
      file: path.join(userHome, '.codex', 'config.toml'),
      detectPath: path.join(userHome, '.codex')
    },
    {
      key: 'vscode',
      label: 'VS Code',
      kind: 'json',
      file: path.join(vscodeUserDir({ platform, userHome, env }), 'mcp.json'),
      detectPath: vscodeUserDir({ platform, userHome, env }),
      rootKey: 'servers',
      entryType: 'stdio'
    },
    {
      key: 'antigravity',
      label: 'Google Antigravity',
      kind: 'json',
      file: path.join(userHome, '.gemini', 'antigravity', 'mcp_config.json'),
      detectPath: path.join(userHome, '.gemini', 'antigravity'),
      rootKey: 'mcpServers',
      entryType: null
    }
  ];
}

function vscodeUserDir({ platform, userHome, env }) {
  const path = pathApi(platform);
  if (platform === 'darwin') {
    return path.join(userHome, 'Library', 'Application Support', 'Code', 'User');
  }
  if (platform === 'win32') {
    return path.join(env.APPDATA || path.join(userHome, 'AppData', 'Roaming'), 'Code', 'User');
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(userHome, '.config'), 'Code', 'User');
}

// ---------------------------------------------------------------------------
// Status

// Inspects every client (or the selected ones). Read-only.
export async function inspectMcpClients(ctx, { clients = MCP_INSTALL_CLIENT_KEYS } = {}) {
  const targets = mcpClientTargets(ctx).filter((client) => clients.includes(client.key));
  const output = [];
  for (const client of targets) {
    output.push(await inspectMcpClient(client, ctx));
  }
  return output;
}

export async function inspectMcpClient(client, ctx) {
  const base = {
    key: client.key,
    label: client.label,
    kind: client.kind,
    file: client.file,
    rootKey: client.rootKey,
    entryType: client.entryType,
    detected: false,
    status: 'not_detected',
    reason: '',
    legacy: false,
    existing: null
  };
  if (client.kind === 'claude') {
    base.cliPath = await ctx.findCommand('claude');
  }
  const fileExists = await pathExists(client.file, ctx);
  if (client.kind === 'claude') {
    base.detected = Boolean(base.cliPath) || fileExists;
  } else {
    base.detected = await pathExists(client.detectPath, ctx);
  }
  if (!base.detected) {
    return base;
  }

  let text = null;
  if (fileExists) {
    try {
      text = await ctx.fs.readFile(client.file, 'utf8');
    } catch (error) {
      return { ...base, status: 'unreadable', reason: `cannot read ${client.file}: ${error.message}` };
    }
  }

  if (client.kind === 'toml') {
    const parsed = parseCodexConfig(text || '');
    if (!parsed.ok) {
      return { ...base, status: 'unreadable', reason: parsed.error, text };
    }
    const existing = parsed.servers[MCP_SERVER_NAME];
    return {
      ...base,
      ...await classifyEntry(existing ? { command: existing.command, args: existing.args, unparsed: existing.unparsed } : null, ctx),
      legacy: Boolean(parsed.servers[LEGACY_SERVER_NAME]),
      existing: existing || null,
      text,
      parsed
    };
  }

  const json = parseJsonConfig(text, client.rootKey);
  if (!json.ok) {
    return { ...base, status: 'unreadable', reason: json.error, text };
  }
  const servers = json.value[client.rootKey] || {};
  const existing = servers[MCP_SERVER_NAME] || null;
  const result = {
    ...base,
    ...await classifyEntry(existing, ctx),
    legacy: Object.hasOwn(servers, LEGACY_SERVER_NAME),
    existing,
    text,
    json: json.value
  };
  if (client.kind === 'claude') {
    result.localScopes = await inspectClaudeLocalScopes(json.value, ctx);
  }
  return result;
}

// Claude Code local-scope entries (`claude mcp add` without --scope, which the
// old docs suggested) live under projects[<dir>].mcpServers and win over the
// user scope, so a stale one would shadow the new entry.
async function inspectClaudeLocalScopes(json, ctx) {
  const projects = json?.projects && typeof json.projects === 'object' ? json.projects : {};
  const output = [];
  for (const [project, value] of Object.entries(projects)) {
    const servers = value?.mcpServers;
    if (!servers || typeof servers !== 'object') {
      continue;
    }
    for (const name of SERVER_NAMES) {
      if (!Object.hasOwn(servers, name)) {
        continue;
      }
      const check = name === LEGACY_SERVER_NAME
        ? { status: 'stale', reason: 'old logwork-helper entry' }
        : await classifyEntry(servers[name], ctx);
      if (check.status !== 'current') {
        output.push({ project, name, reason: check.reason });
      }
    }
  }
  return output;
}

async function classifyEntry(entry, ctx) {
  if (!entry) {
    return { status: 'missing', reason: '' };
  }
  if (entry.unparsed || typeof entry !== 'object') {
    return { status: 'stale', reason: 'the entry could not be read' };
  }
  const command = String(entry.command || '');
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  const expectedArgs = mcpArgs(ctx.launch);
  if (samePath(command, ctx.launch.command, ctx.platform) && args.length === expectedArgs.length && args.every((arg, index) => samePath(arg, expectedArgs[index], ctx.platform))) {
    return { status: 'current', reason: '' };
  }
  const commandLine = [command, ...args].join(' ');
  if (/logwork-helper|mcp-server\.mjs/i.test(commandLine)) {
    return { status: 'stale', reason: 'points at the old logwork-helper runtime' };
  }
  // Split on both separators: a config may hold a Windows path even when the
  // check runs elsewhere, and vice versa.
  if (/^node(\.exe)?$/i.test(String(command).split(/[\\/]/).pop()) || command === 'node') {
    if (command !== 'node' && !await pathExists(command, ctx)) {
      return { status: 'stale', reason: `runs Node at ${command}, which no longer exists` };
    }
    return {
      status: 'stale',
      reason: ctx.launch.kind === 'launcher'
        ? `runs Node directly (${command}) instead of the logwork launcher`
        : `runs a different Node (${command})`
    };
  }
  return { status: 'stale', reason: `runs a different command (${command || 'none'})` };
}

// ---------------------------------------------------------------------------
// Install

// Works out what `logwork mcp install` would change. Read-only.
export async function planMcpInstall(ctx, { clients = MCP_INSTALL_CLIENT_KEYS, explicit = false } = {}) {
  const inspected = await inspectMcpClients(ctx, { clients });
  return inspected
    .filter((client) => client.detected || explicit)
    .map((client) => ({ ...client, action: planAction(client) }));
}

function planAction(client) {
  if (!client.detected) {
    return 'not_detected';
  }
  if (client.status === 'unreadable') {
    return 'manual';
  }
  const stray = client.legacy || (client.localScopes || []).length > 0;
  if (client.status === 'current' && !stray) {
    return 'none';
  }
  return client.status === 'missing' ? 'add' : 'update';
}

// Applies one planned client change. Returns a result with status:
// added | updated | up_to_date | failed | not_detected.
export async function applyMcpClientPlan(plan, ctx) {
  const result = { key: plan.key, label: plan.label, file: plan.file };
  if (plan.action === 'not_detected') {
    return { ...result, status: 'not_detected' };
  }
  if (plan.action === 'none') {
    return { ...result, status: 'up_to_date' };
  }
  if (plan.action === 'manual') {
    return { ...result, status: 'failed', reason: plan.reason, snippet: manualSnippet(plan.key, ctx) };
  }
  const changed = plan.action === 'add' ? 'added' : 'updated';
  try {
    if (plan.kind === 'claude' && plan.cliPath) {
      await applyClaudeCli(plan, ctx);
      return { ...result, status: changed, via: 'claude mcp' };
    }
    const content = renderUpdatedConfig(plan, ctx);
    if (content === null) {
      return { ...result, status: 'failed', reason: 'the existing config has an unusual layout', snippet: manualSnippet(plan.key, ctx) };
    }
    const backup = await writeConfigFile(plan.file, content, ctx, { existed: plan.text !== null && plan.text !== undefined });
    return { ...result, status: changed, backup };
  } catch (error) {
    return { ...result, status: 'failed', reason: error.message, snippet: manualSnippet(plan.key, ctx) };
  }
}

// The new file content for a JSON or TOML client, or null when it cannot be
// produced safely.
export function renderUpdatedConfig(plan, ctx) {
  if (plan.kind === 'toml') {
    return rewriteCodexConfig(plan.text || '', formatCodexToml(ctx.launch));
  }
  const json = plan.json ? structuredClone(plan.json) : {};
  const rootKey = plan.kind === 'claude' ? 'mcpServers' : plan.rootKey;
  if (json[rootKey] === undefined) {
    json[rootKey] = {};
  }
  const servers = json[rootKey];
  servers[MCP_SERVER_NAME] = buildJsonEntry(plan, ctx, servers[MCP_SERVER_NAME]);
  delete servers[LEGACY_SERVER_NAME];
  if (plan.kind === 'claude') {
    for (const stray of plan.localScopes || []) {
      delete json.projects?.[stray.project]?.mcpServers?.[stray.name];
    }
  }
  return `${JSON.stringify(json, null, 2)}\n`;
}

function buildJsonEntry(plan, ctx, previous) {
  const base = previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {};
  const entry = { ...base };
  const type = plan.kind === 'claude' ? 'stdio' : plan.entryType;
  if (type) {
    entry.type = type;
  }
  entry.command = ctx.launch.command;
  entry.args = mcpArgs(ctx.launch);
  if (plan.kind === 'claude' && entry.env === undefined) {
    entry.env = {};
  }
  // Keep a stable key order for new entries: type, command, args, then the rest.
  const ordered = {};
  for (const key of ['type', 'command', 'args']) {
    if (entry[key] !== undefined) {
      ordered[key] = entry[key];
    }
  }
  return { ...ordered, ...entry };
}

async function applyClaudeCli(plan, ctx) {
  const run = (args, options = {}) => ctx.runCommand(plan.cliPath, args, { platform: ctx.platform, ...options });
  // A missing entry makes `remove` fail; that is fine.
  await run(['mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME]).catch(() => null);
  if (plan.legacy) {
    await run(['mcp', 'remove', '--scope', 'user', LEGACY_SERVER_NAME]).catch(() => null);
  }
  for (const stray of plan.localScopes || []) {
    if (await pathExists(stray.project, ctx)) {
      await run(['mcp', 'remove', '--scope', 'local', stray.name], { cwd: stray.project }).catch(() => null);
    }
  }
  const added = await run(claudeAddArgs(ctx.launch));
  if (!added || added.code !== 0) {
    throw new Error(`claude mcp add failed${added ? ` with exit code ${added.code}` : ''}: ${String(added?.stderr || added?.stdout || 'no output').trim().split(/\r?\n/)[0]}`);
  }
}

export function claudeAddArgs(launch) {
  return ['mcp', 'add', '--scope', 'user', MCP_SERVER_NAME, '--', launch.command, ...mcpArgs(launch)];
}

async function writeConfigFile(file, content, ctx, { existed }) {
  let target = file;
  let mode = 0o600;
  let backup = null;
  if (existed) {
    // Write through a symlinked config (dotfile managers) instead of replacing the link.
    target = await ctx.fs.realpath(file).catch(() => file);
    const info = await ctx.fs.stat(target).catch(() => null);
    if (info?.mode) {
      mode = info.mode & 0o777;
    }
    backup = `${file}.logwork-backup-${formatBackupStamp(ctx.now())}`;
    await ctx.fs.copyFile(target, backup);
  }
  await ctx.fs.writeFile(target, content, { mode });
  return backup;
}

export function formatBackupStamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

// Diff-like lines for --dry-run and the non-interactive setup summary.
export function describeMcpPlan(plan, ctx) {
  const lines = [];
  const target = plan.kind === 'claude' && plan.cliPath ? 'claude CLI' : plan.file;
  const verb = {
    add: 'would add the logwork entry',
    update: 'would update the logwork entry',
    none: 'already up to date',
    manual: `could not update automatically (${plan.reason})`,
    not_detected: 'not detected; skipped'
  }[plan.action] || plan.action;
  lines.push(`${plan.label} (${target}): ${verb}`);
  if (plan.action !== 'add' && plan.action !== 'update') {
    return lines;
  }
  if (plan.kind === 'claude' && plan.cliPath) {
    lines.push(`  $ claude mcp remove --scope user ${MCP_SERVER_NAME}`);
    if (plan.legacy) {
      lines.push(`  $ claude mcp remove --scope user ${LEGACY_SERVER_NAME}`);
    }
    for (const stray of plan.localScopes || []) {
      lines.push(`  $ (cd ${stray.project}) claude mcp remove --scope local ${stray.name}`);
    }
    lines.push(`  $ ${formatClaudeMcpAddCommand(ctx.launch, { platform: ctx.platform })}`);
    return lines;
  }
  if (plan.status === 'stale' && plan.existing && !plan.existing.unparsed) {
    lines.push(`  - command: ${plan.existing.command}`);
    lines.push(`  - args: ${JSON.stringify(plan.existing.args || [])}`);
  }
  if (plan.status !== 'current') {
    lines.push(`  + command: ${ctx.launch.command}`);
    lines.push(`  + args: ${JSON.stringify(mcpArgs(ctx.launch))}`);
  }
  if (plan.legacy) {
    lines.push(`  - remove the "${LEGACY_SERVER_NAME}" entry`);
  }
  for (const stray of plan.localScopes || []) {
    lines.push(`  - remove the local-scope "${stray.name}" entry for ${stray.project}`);
  }
  if (plan.text !== null && plan.text !== undefined) {
    lines.push(`  backup: ${plan.file}.logwork-backup-<timestamp>`);
  } else {
    lines.push('  (new file)');
  }
  return lines;
}

export function manualSnippet(key, ctx) {
  const launch = ctx.launch;
  if (key === 'codex') {
    return formatCodexToml(launch);
  }
  if (key === 'vscode') {
    return JSON.stringify(vscodeMcpConfig(launch), null, 2);
  }
  if (key === 'claude') {
    return formatClaudeMcpAddCommand(launch, { platform: ctx.platform });
  }
  return JSON.stringify(stdioMcpServersConfig(launch), null, 2);
}

// ---------------------------------------------------------------------------
// JSON

export function parseJsonConfig(text, rootKey) {
  if (text === null || text === undefined || !String(text).trim()) {
    return { ok: true, value: {} };
  }
  let value;
  try {
    value = JSON.parse(String(text).replace(/^\uFEFF/, ''));
  } catch {
    return { ok: false, error: 'the file is not plain JSON; it may contain comments or trailing commas' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'the file is not a JSON object' };
  }
  const servers = value[rootKey];
  if (servers !== undefined && (!servers || typeof servers !== 'object' || Array.isArray(servers))) {
    return { ok: false, error: `"${rootKey}" is not an object` };
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// TOML (Codex). Edited as text: no TOML dependency. Anything unusual is
// refused rather than guessed.

export function parseCodexConfig(text) {
  const scan = scanToml(text);
  if (!scan.ok) {
    return scan;
  }
  const servers = {};
  for (const name of SERVER_NAMES) {
    const blocks = scan.blocks.filter((block) => isServerPath(block.path, name));
    if (!blocks.length) {
      continue;
    }
    if (blocks.some((block) => block.array)) {
      return { ok: false, error: `[[mcp_servers.${name}]] array tables are not supported` };
    }
    const main = blocks.find((block) => block.path.length === 2);
    const values = main ? readTomlKeyValues(scan.lines.slice(main.start + 1, main.end)) : {};
    const command = typeof values.command === 'string' ? values.command : null;
    const args = Array.isArray(values.args) && values.args.every((item) => typeof item === 'string') ? values.args : null;
    servers[name] = {
      command: command || '',
      args: args || [],
      unparsed: !main || command === null || (values.args !== undefined && args === null),
      blocks
    };
  }
  return { ok: true, lines: scan.lines, eol: scan.eol, blocks: scan.blocks, servers };
}

// Replaces every [mcp_servers.logwork] table (with its sub-tables such as
// [mcp_servers.logwork.env]) by `tableText` at the position of the first one,
// or appends it; removes every [mcp_servers.logwork-helper] table. Returns
// null when the file cannot be edited safely.
export function rewriteCodexConfig(text, tableText) {
  const parsed = parseCodexConfig(text);
  if (!parsed.ok) {
    return null;
  }
  const { lines, eol } = parsed;
  const remove = new Set();
  let insertAt = -1;
  for (const name of SERVER_NAMES) {
    for (const block of parsed.servers[name]?.blocks || []) {
      for (let index = block.start; index < block.end; index += 1) {
        remove.add(index);
      }
      if (name === MCP_SERVER_NAME && (insertAt === -1 || block.start < insertAt)) {
        insertAt = block.start;
      }
    }
  }
  const tableLines = String(tableText).split(/\r?\n/);
  const output = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (index === insertAt) {
      output.push(...tableLines);
    }
    if (!remove.has(index)) {
      output.push(lines[index]);
    }
  }
  if (insertAt === -1) {
    while (output.length && output[output.length - 1].trim() === '') {
      output.pop();
    }
    if (output.length) {
      output.push('');
    }
    output.push(...tableLines);
  }
  // Collapse the blank lines a removed table can leave behind.
  const collapsed = output.filter((line, index) => !(line.trim() === '' && index > 0 && output[index - 1].trim() === ''));
  while (collapsed.length && collapsed[collapsed.length - 1].trim() === '') {
    collapsed.pop();
  }
  return `${collapsed.join(eol)}${eol}`;
}

function isServerPath(path, name) {
  return path.length >= 2 && path[0] === 'mcp_servers' && path[1] === name;
}

function scanToml(text) {
  const source = String(text || '').replace(/^\uFEFF/, '');
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') {
    lines.pop();
  }
  const headers = [];
  let multiline = null;
  let table = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (multiline) {
      if (countOccurrences(line, multiline) % 2 === 1) {
        multiline = null;
      }
      continue;
    }
    const header = /^\s*(\[\[?)([^\]]*)(\]\]?)\s*(#.*)?$/.exec(line);
    if (header && line.trim().startsWith('[') && (header[1].length === header[3].length)) {
      const path = parseDottedKey(header[2]);
      if (!path) {
        if (/logwork/.test(header[2])) {
          return { ok: false, error: `unusual table header: ${line.trim()}` };
        }
        table = [];
        headers.push({ index, path: [], array: header[1] === '[[' });
        continue;
      }
      headers.push({ index, path, array: header[1] === '[[' });
      table = path;
      continue;
    }
    if (/^\s*\[/.test(line) && /logwork/.test(line)) {
      return { ok: false, error: `unusual table header: ${line.trim()}` };
    }
    for (const delimiter of ['"""', "'''"]) {
      if (countOccurrences(line, delimiter) % 2 === 1) {
        multiline = delimiter;
        break;
      }
    }
    const assignment = /^\s*([A-Za-z0-9_\-."' ]+?)\s*=/.exec(line);
    if (!assignment) {
      continue;
    }
    const keyPath = parseDottedKey(assignment[1]);
    if (!keyPath) {
      continue;
    }
    const full = [...table, ...keyPath];
    if (full.length === 1 && full[0] === 'mcp_servers') {
      return { ok: false, error: 'mcp_servers is defined as an inline table' };
    }
    for (const name of SERVER_NAMES) {
      if (isServerPath(full, name) && !isServerPath(table, name)) {
        return { ok: false, error: `mcp_servers.${name} is defined outside its own [mcp_servers.${name}] table` };
      }
    }
  }
  if (multiline) {
    return { ok: false, error: 'unterminated multi-line string' };
  }
  const blocks = headers.map((header, position) => {
    let end = position + 1 < headers.length ? headers[position + 1].index : lines.length;
    // Comments and blank lines right before the next header belong to it.
    while (end > header.index + 1 && /^\s*(#.*)?$/.test(lines[end - 1])) {
      end -= 1;
    }
    return { start: header.index, end, path: header.path, array: header.array };
  });
  return { ok: true, lines, eol, blocks };
}

function countOccurrences(line, needle) {
  let count = 0;
  let from = 0;
  while ((from = line.indexOf(needle, from)) !== -1) {
    count += 1;
    from += needle.length;
  }
  return count;
}

// `a.b."c d".'e'` -> ['a', 'b', 'c d', 'e']; null when it is not a plain key.
export function parseDottedKey(value) {
  const source = String(value);
  const segments = [];
  let index = 0;
  const skipSpace = () => {
    while (index < source.length && /[ \t]/.test(source[index])) {
      index += 1;
    }
  };
  while (true) {
    skipSpace();
    if (source[index] === '"') {
      const parsed = readBasicString(source, index);
      if (!parsed) {
        return null;
      }
      segments.push(parsed.value);
      index = parsed.end;
    } else if (source[index] === "'") {
      const end = source.indexOf("'", index + 1);
      if (end === -1) {
        return null;
      }
      segments.push(source.slice(index + 1, end));
      index = end + 1;
    } else {
      const match = /^[A-Za-z0-9_-]+/.exec(source.slice(index));
      if (!match) {
        return null;
      }
      segments.push(match[0]);
      index += match[0].length;
    }
    skipSpace();
    if (index >= source.length) {
      return segments;
    }
    if (source[index] !== '.') {
      return null;
    }
    index += 1;
  }
}

function readTomlKeyValues(lines) {
  const values = {};
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(lines[index]);
    if (!match) {
      continue;
    }
    let raw = match[2];
    // A multi-line array: read until its closing bracket.
    if (raw.trim().startsWith('[')) {
      while (!arrayClosed(raw) && index + 1 < lines.length) {
        index += 1;
        raw += `\n${lines[index]}`;
      }
    }
    const parsed = parseTomlValue(raw);
    values[match[1]] = parsed === undefined ? Symbol.for('unparsed') : parsed;
  }
  return values;
}

function arrayClosed(raw) {
  return parseTomlValue(raw) !== undefined;
}

// Strings and arrays of strings only; undefined for anything else.
export function parseTomlValue(raw) {
  const source = String(raw);
  let index = 0;
  const skip = () => {
    while (index < source.length) {
      if (/\s|,/.test(source[index]) && source[index] !== undefined) {
        index += 1;
      } else if (source[index] === '#') {
        while (index < source.length && source[index] !== '\n') {
          index += 1;
        }
      } else {
        break;
      }
    }
  };
  const readValue = () => {
    if (source[index] === '"') {
      if (source.startsWith('"""', index)) {
        return undefined;
      }
      const parsed = readBasicString(source, index);
      if (!parsed) {
        return undefined;
      }
      index = parsed.end;
      return parsed.value;
    }
    if (source[index] === "'") {
      if (source.startsWith("'''", index)) {
        return undefined;
      }
      const end = source.indexOf("'", index + 1);
      if (end === -1) {
        return undefined;
      }
      const value = source.slice(index + 1, end);
      index = end + 1;
      return value;
    }
    if (source[index] === '[') {
      index += 1;
      const items = [];
      while (true) {
        skip();
        if (index >= source.length) {
          return undefined;
        }
        if (source[index] === ']') {
          index += 1;
          return items;
        }
        const item = readValue();
        if (item === undefined) {
          return undefined;
        }
        items.push(item);
      }
    }
    return undefined;
  };
  while (index < source.length && /[ \t]/.test(source[index])) {
    index += 1;
  }
  const value = readValue();
  if (value === undefined) {
    return undefined;
  }
  const rest = source.slice(index).trim();
  if (rest && !rest.startsWith('#')) {
    return undefined;
  }
  return value;
}

function readBasicString(source, start) {
  let value = '';
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === '"') {
      return { value, end: index + 1 };
    }
    if (char === '\n') {
      return null;
    }
    if (char === '\\') {
      const next = source[index + 1];
      const simple = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }[next];
      if (simple !== undefined) {
        value += simple;
        index += 2;
        continue;
      }
      if (next === 'u' || next === 'U') {
        const length = next === 'u' ? 4 : 8;
        const hex = source.slice(index + 2, index + 2 + length);
        if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== length) {
          return null;
        }
        value += String.fromCodePoint(Number.parseInt(hex, 16));
        index += 2 + length;
        continue;
      }
      return null;
    }
    value += char;
    index += 1;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers

async function pathExists(path, ctx) {
  if (!path) {
    return false;
  }
  try {
    await ctx.fs.access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function samePath(left, right, platform) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// Finds a command on PATH and returns its absolute path, or null.
export async function whichCommand(name, {
  platform = process.platform,
  env = process.env,
  access = fs.access
} = {}) {
  const path = pathApi(platform);
  const pathValue = env.PATH || env.Path || '';
  const entries = pathValue.split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const names = platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name] : [name];
  for (const entry of entries) {
    for (const candidate of names) {
      const full = path.join(entry, candidate);
      try {
        await access(full, platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
        return full;
      } catch {
        // Keep searching PATH.
      }
    }
  }
  return null;
}

// Runs a CLI and collects its output. A Windows .cmd/.bat shim (npm installs)
// must go through cmd.exe; arguments are quoted for it.
export function runCliCommand(command, args, { platform = process.platform, cwd } = {}) {
  let file = command;
  let argv = args;
  const options = { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true };
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    file = 'cmd.exe';
    argv = ['/d', '/s', '/c', `"${[command, ...args].map(quoteCmdArg).join(' ')}"`];
    options.windowsVerbatimArguments = true;
  }
  return new Promise((resolveValue, reject) => {
    const child = spawn(file, argv, options);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolveValue({ code: signal ? 1 : (code ?? 1), stdout, stderr }));
  });
}

export function quoteCmdArg(value) {
  const text = String(value);
  if (/["%!^&|<>\r\n]/.test(text)) {
    throw new Error(`Cannot pass ${JSON.stringify(text)} to cmd.exe safely.`);
  }
  return /[\s()]/.test(text) || text === '' ? `"${text}"` : text;
}
