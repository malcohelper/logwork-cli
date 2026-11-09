import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { EOL, homedir, platform, release, type } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CONFIG } from './config.mjs';
import { getStoredAuthStatus } from './auth.mjs';
import { redactText } from './auth-redaction.mjs';
import { authDebugLogPath, sanitizeDiagnosticValue } from './auth-diagnostics.mjs';
import { configPath, loadLocalConfig } from './logwork-config.mjs';
import { checkLaunchCommand, formatLaunchCheckIssue, resolveLaunchCommand } from './launcher.mjs';
import { createMcpInstallContext, inspectMcpClients } from './mcp-install.mjs';
import { formatNodePathIssue, inspectNodePath, inspectScheduledCommand, loadRuntimeInfo } from './node-runtime.mjs';
import { helperHome, manualDraftsPath, runtimeInfoPath, userConfigPath } from './paths.mjs';
import { readReminderSchedulerNodePath } from './reminder-scheduler.mjs';

const DIAGNOSTICS_DIR_NAME = 'diagnostics';
const MAX_AUTH_DEBUG_CHARS = 20_000;
const MCP_SMOKE_TIMEOUT_MS = 5_000;
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function diagnosticsDir() {
  return resolve(helperHome(), DIAGNOSTICS_DIR_NAME);
}

export function diagnosticsReportPath(now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return resolve(diagnosticsDir(), `logwork-diagnostics-${stamp}.txt`);
}

export async function generateDiagnosticsReport({
  outputPath = diagnosticsReportPath(),
  now = () => new Date(),
  cwd = process.cwd(),
  includeMappingDetails = process.env.LOGWORK_DIAGNOSTICS_INCLUDE_MAPPINGS === '1',
  commandFinder = findCommandOnPath,
  authStatusFn = getStoredAuthStatus,
  mcpSmokeFn = runMcpSmoke,
  nodeRuntimeFn = collectNodeRuntimeCheck,
  mcpClientsFn = collectMcpClientCheck,
  readFileFn = readFile,
  statFn = stat,
  writeFileFn = writeFile,
  mkdirFn = mkdir
} = {}) {
  const sections = [];
  const packageInfo = await readPackageInfo({ readFileFn });
  const commandChecks = await collectCommandChecks(commandFinder);
  const authStatus = await safeCollect('auth status', async () => sanitizeAuthStatus(await authStatusFn()));
  const fileChecks = await collectFileChecks({ statFn, cwd });
  const configSnapshot = await safeCollect('config snapshot', () => collectConfigSnapshot({ cwd, includeMappingDetails }));
  const mcpSmoke = await safeCollect('mcp smoke', () => mcpSmokeFn({ cwd }));
  const nodeRuntime = await safeCollect('node runtime', () => nodeRuntimeFn());
  const mcpClients = await safeCollect('mcp clients', () => mcpClientsFn());
  const runtimeIssues = Array.isArray(nodeRuntime?.issues) ? nodeRuntime.issues : [];
  const mcpIssues = (Array.isArray(mcpClients) ? mcpClients : [])
    .filter((client) => client.status === 'stale' || client.legacy || client.localScopes)
    .map((client) => `MCP: ${formatMcpClientCheck(client)}. Fix: run \`logwork mcp install\`.`);
  const nodeIssues = [...runtimeIssues, ...mcpIssues];
  const authDebug = await readSanitizedAuthDebug({ readFileFn });

  sections.push(formatSection('logwork-cli Diagnostics', [
    `generatedAt: ${now().toISOString()}`,
    `packageVersion: ${packageInfo.version || 'unknown'}`,
    `cwd: ${cwd}`,
    `helperHome: ${helperHome()}`
  ]));

  sections.push(formatSection('Runtime', [
    `platform: ${platform()}`,
    `os: ${type()} ${release()}`,
    `node: ${process.version}`,
    `nodePath: ${process.execPath}`,
    `home: ${homedir()}`
  ]));

  sections.push(formatSection('Node Path', nodeRuntime?.ok === false
    ? formatObjectLines(nodeRuntime)
    : [
      `runtimeFile: ${nodeRuntime.runtimeFile}`,
      ...(nodeRuntime.launchCommand ? [
        `launchCommand: ${nodeRuntime.launchCommand}`,
        `launchStatus: ${nodeRuntime.launchStatus}`,
        `launchNode: ${nodeRuntime.launchNode || 'unknown'}`,
        `launchVersion: ${nodeRuntime.launchVersion || 'unknown'}`
      ] : []),
      `recordedNode: ${nodeRuntime.recordedNode || 'none (run logwork setup)'}${nodeRuntime.recordedVersion ? ` (${nodeRuntime.recordedVersion})` : ''}`,
      `recordedNodeStatus: ${nodeRuntime.recordedStatus}${nodeRuntime.recordedNote ? ` (${nodeRuntime.recordedNote})` : ''}`,
      `reminderNode: ${nodeRuntime.reminderNode || 'none (no reminder schedule)'}`,
      `reminderNodeStatus: ${nodeRuntime.reminderStatus}`,
      ...(runtimeIssues.length ? runtimeIssues.map((issue) => `warning: ${issue}`) : ['warnings: none'])
    ]));

  sections.push(formatSection('MCP Clients', Array.isArray(mcpClients)
    ? [
      ...(mcpClients.length ? mcpClients.map(formatMcpClientCheck) : ['none detected']),
      ...mcpIssues.map((issue) => `warning: ${issue}`)
    ]
    : formatObjectLines(mcpClients)));

  sections.push(formatSection('Commands', commandChecks.map((entry) => `${entry.command}: ${entry.available ? 'found' : 'missing'}${entry.path ? ` (${entry.path})` : ''}`)));
  sections.push(formatSection('Files', fileChecks.map((entry) => formatFileCheck(entry))));
  sections.push(formatSection('Config Snapshot', formatObjectLines(configSnapshot)));
  sections.push(formatSection('Auth Status', formatObjectLines(authStatus)));
  sections.push(formatSection('MCP Smoke', formatObjectLines(mcpSmoke)));
  sections.push(formatSection('Recent Auth Debug', authDebug ? [authDebug] : ['No auth-debug.log found.']));

  const report = sanitizeReport(`${sections.join(`${EOL}${EOL}`)}${EOL}`);
  await mkdirFn(dirname(outputPath), { recursive: true });
  await writeFileFn(outputPath, report, 'utf8');

  return {
    path: outputPath,
    report,
    nodeIssues: nodeIssues.map((issue) => sanitizeReport(issue)),
    summary: [
      ...nodeIssues.map((issue) => sanitizeReport(`Warning: ${issue}`)),
      `Diagnostics report written to ${outputPath}`
    ].join(EOL)
  };
}

// Checks the launch command IDE configs and the reminder run (it must exist
// and start a usable Node), the node recorded by `logwork setup`
// (runtime.json) and the command in the installed reminder schedule.
// Read-only: it only runs the launch command with --version.
export async function collectNodeRuntimeCheck({
  launch = resolveLaunchCommand(),
  loadRuntime = loadRuntimeInfo,
  readSchedulerNodePath = readReminderSchedulerNodePath,
  inspect = inspectNodePath,
  inspectScheduled = (path) => inspectScheduledCommand(path, { launch }),
  checkLaunch = () => checkLaunchCommand(launch)
} = {}) {
  const runtime = await loadRuntime().catch(() => null);
  const reminderNode = await readSchedulerNodePath().catch(() => null);
  const launchCheck = await checkLaunch().catch((error) => ({ status: 'failed', command: launch.command, kind: launch.kind, detail: error.message }));
  const recorded = runtime?.nodePath
    ? await inspect(runtime.nodePath)
    : { status: 'unknown' };
  const reminder = reminderNode
    ? await inspectScheduled(reminderNode)
    : { status: 'unknown' };
  // With the launcher, a gone or switched recorded node is not fatal: the
  // launcher falls back to another Node 22+.
  const launcherCovers = launch.kind === 'launcher' && launchCheck?.status === 'ok';
  const recordedNote = launcherCovers && (recorded.status === 'missing' || recorded.status === 'stale')
    ? `the launcher uses ${launchCheck.node || 'another Node'}; run \`logwork setup\` to record it`
    : '';
  const issues = [
    formatLaunchCheckIssue(launchCheck),
    launcherCovers ? '' : formatNodePathIssue('runtime', recorded),
    formatNodePathIssue('reminder', reminder)
  ].filter(Boolean);
  return {
    runtimeFile: runtimeInfoPath(),
    launchCommand: [launch.command, ...launch.argsPrefix].join(' '),
    launchStatus: launchCheck?.status || 'unknown',
    launchNode: launchCheck?.node || '',
    launchVersion: launchCheck?.version || '',
    recordedNode: runtime?.nodePath || '',
    recordedVersion: runtime?.nodeVersion || '',
    recordedStatus: recorded.status,
    recordedNote,
    reminderNode: reminderNode || '',
    reminderStatus: reminder.status,
    issues
  };
}

// The `logwork` entry of each MCP client config (what `logwork mcp status`
// shows). Read-only.
export async function collectMcpClientCheck({
  ctx = createMcpInstallContext()
} = {}) {
  const clients = await inspectMcpClients(ctx);
  return clients.filter((client) => client.detected).map((client) => ({
    label: client.label,
    status: client.status,
    reason: client.reason,
    legacy: client.legacy,
    localScopes: (client.localScopes || []).length
  }));
}

function formatMcpClientCheck(client) {
  const extra = [
    client.reason,
    client.legacy ? 'leftover logwork-helper entry' : '',
    client.localScopes ? `${client.localScopes} stale local-scope entries` : ''
  ].filter(Boolean).join('; ');
  return `${client.label}: ${client.status}${extra ? ` (${extra})` : ''}`;
}

async function readPackageInfo({ readFileFn }) {
  try {
    const packagePath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return JSON.parse(await readFileFn(packagePath, 'utf8'));
  } catch {
    return {};
  }
}

async function collectCommandChecks(commandFinder) {
  const commands = ['node', 'npm', 'logwork'];
  const output = [];
  for (const command of commands) {
    output.push({ command, ...await commandFinder(command) });
  }
  return output;
}

async function collectFileChecks({ statFn, cwd }) {
  const files = [
    { label: 'userConfig', path: userConfigPath() },
    { label: 'projectConfig', path: configPath(cwd, 'project') },
    { label: 'manualDrafts', path: manualDraftsPath() },
    { label: 'authDebugLog', path: authDebugLogPath() }
  ];

  const output = [];
  for (const file of files) {
    try {
      const info = await statFn(file.path);
      output.push({
        ...file,
        exists: true,
        size: info.size,
        modifiedAt: info.mtime?.toISOString?.() || null
      });
    } catch (error) {
      output.push({
        ...file,
        exists: false,
        error: error.code === 'ENOENT' ? null : error.message
      });
    }
  }
  return output;
}

async function collectConfigSnapshot({ cwd, includeMappingDetails = false }) {
  const config = await loadLocalConfig(cwd);
  const mappings = config.projectMappings || [];
  return {
    profile: CONFIG.profile,
    apiHost: hostFromUrl(CONFIG.apiBase),
    loginHost: hostFromUrl(CONFIG.loginUrl),
    keycloakHost: hostFromUrl(CONFIG.keycloakAuthUrl),
    allowedSafariHosts: CONFIG.allowedSafariHosts,
    httpTimeoutMs: CONFIG.httpTimeoutMs,
    httpReadRetries: CONFIG.httpReadRetries,
    userConfigPath: configPath(cwd, 'user'),
    projectConfigPath: configPath(cwd, 'project'),
    mappingCount: mappings.length,
    mappingTicketCount: mappings.reduce((sum, mapping) => sum + (mapping.tickets || []).length, 0),
    mappingKeywordCount: mappings.reduce((sum, mapping) => sum + (mapping.keywords || []).length, 0),
    mappingDetails: includeMappingDetails ? mappings.map((mapping) => ({
      projectMemberId: mapping.projectMemberId ?? null,
      projectName: mapping.projectName || '',
      tickets: mapping.tickets || [],
      keywordCount: (mapping.keywords || []).length
    })) : '<redacted; set LOGWORK_DIAGNOSTICS_INCLUDE_MAPPINGS=1 to include mapping details>'
  };
}

function hostFromUrl(value) {
  try {
    return new URL(value).host;
  } catch {
    return 'invalid';
  }
}

async function readSanitizedAuthDebug({ readFileFn }) {
  try {
    const content = await readFileFn(authDebugLogPath(), 'utf8');
    const tail = content.slice(-MAX_AUTH_DEBUG_CHARS);
    return sanitizeDiagnosticText(tail);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return '';
    }
    return `Unable to read auth debug log: ${sanitizeDiagnosticValue(error.message)}`;
  }
}

function sanitizeAuthStatus(status) {
  if (!status || typeof status !== 'object') {
    return { available: false };
  }
  return {
    authenticated: Boolean(status.authenticated),
    expired: Boolean(status.expired),
    refreshAvailable: Boolean(status.refreshAvailable),
    userId: status.userId || null,
    email: status.email || null,
    expiresAt: status.expiresAt || null,
    summary: status.summary || ''
  };
}

async function safeCollect(label, fn) {
  try {
    return await fn();
  } catch (error) {
    return {
      ok: false,
      label,
      error: sanitizeDiagnosticValue(error.message || String(error))
    };
  }
}

export async function runMcpSmoke({ timeoutMs = MCP_SMOKE_TIMEOUT_MS } = {}) {
  const client = new Client({
    name: 'logwork-diagnostics',
    version: '0.1.0'
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(PACKAGE_ROOT, 'bin', 'logwork.mjs'), 'mcp'],
    cwd: PACKAGE_ROOT,
    env: {
      ...process.env,
      LOGWORK_HOME: helperHome()
    },
    stderr: 'pipe'
  });

  let timeout;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('MCP connect timed out.')), timeoutMs);
      })
    ]);
    const result = await Promise.race([
      client.listTools(),
      new Promise((_, reject) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => reject(new Error('MCP tools/list timed out.')), timeoutMs);
      })
    ]);
    return {
      ok: true,
      toolCount: result.tools.length,
      tools: result.tools.map((tool) => tool.name).sort()
    };
  } finally {
    clearTimeout(timeout);
    await client.close().catch(() => {});
  }
}

async function findCommandOnPath(commandName) {
  const pathEntries = (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
  const names = process.platform === 'win32' ? [commandName, `${commandName}.cmd`, `${commandName}.exe`] : [commandName];
  for (const pathEntry of pathEntries) {
    for (const name of names) {
      const candidate = resolve(pathEntry, name);
      try {
        await stat(candidate);
        await access(candidate, fsConstants.X_OK);
        return { available: true, path: candidate };
      } catch {
        // Keep searching.
      }
    }
  }
  return { available: false, path: null };
}

function formatSection(title, lines = []) {
  return [`# ${title}`, ...lines.map((line) => String(line))].join(EOL);
}

function formatObjectLines(value) {
  if (!value || typeof value !== 'object') {
    return [String(value ?? '')];
  }
  return Object.entries(value).map(([key, entryValue]) => `${key}: ${formatValue(entryValue)}`);
}

function formatValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item && typeof item === 'object') {
        return JSON.stringify(sanitizeDiagnosticValue(item));
      }
      return String(sanitizeDiagnosticValue(item));
    }).join(', ');
  }
  if (value && typeof value === 'object') {
    return JSON.stringify(sanitizeDiagnosticValue(value));
  }
  return String(sanitizeDiagnosticValue(value));
}

function formatFileCheck(entry) {
  if (!entry.exists) {
    return `${entry.label}: missing (${entry.path})${entry.error ? ` error=${entry.error}` : ''}`;
  }
  return `${entry.label}: exists (${entry.path}) size=${entry.size} modifiedAt=${entry.modifiedAt}`;
}

function sanitizeReport(report) {
  return redactText(String(report || ''));
}

function sanitizeDiagnosticText(value) {
  let text = redactText(String(value || ''));
  text = text.replace(/("(?:password|otp|cookie|authorization|token|accessToken|refreshToken|access_token|refresh_token|code|session_code|state|nonce|tab_id|credentialId)"\s*:\s*)"[^"]*"/gi, '$1"<redacted>"');
  text = text.replace(/<\/?(html|body|form|input|script|style)\b[^>]*>/gi, '<html-redacted>');
  return text;
}
