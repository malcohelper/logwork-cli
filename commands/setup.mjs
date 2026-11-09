import { constants as fsConstants, promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactText } from '../lib/auth-redaction.mjs';
import { credentialStoreLabel } from '../lib/credential-store.mjs';
import { npmInvocation } from '../lib/npm-command.mjs';
import { writeRuntimeInfo } from '../lib/node-runtime.mjs';
import { RUNTIME_INFO_FILE_NAME, helperHome } from '../lib/paths.mjs';
import { mcpArgs, resolveLaunchCommand, writeLauncher } from '../lib/launcher.mjs';
import {
  MCP_LAUNCHER_NOTE,
  MCP_NODE_PATH_NOTE,
  MCP_SERVER_NAME,
  formatClaudeMcpAddCommand,
  formatCodexToml,
  stdioMcpServersConfig,
  vscodeMcpConfig
} from '../lib/manual-mcp.mjs';
import { createMcpInstallContext, describeMcpPlan, planMcpInstall } from '../lib/mcp-install.mjs';
import { loadReminderConfig } from '../lib/reminder-config.mjs';
import { installReminderScheduler } from '../lib/reminder-scheduler.mjs';
import { formatMcpInstallResults, isInteractiveTerminal, runMcpInstall } from './mcp.mjs';

// Package name before the rename. Its global install provides a `logwork` bin
// that would block `npm link` of logwork-cli, so setup removes it first.
const LEGACY_PACKAGE_NAME = 'logwork-helper';
const PACKAGE_NAMES = ['logwork-cli', LEGACY_PACKAGE_NAME];

const EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules'
]);

// `logwork setup`: copy this package into ~/.logwork-cli, install its
// dependencies, link the `logwork` command, write the launcher, refresh a
// migrated reminder, and add or update the `logwork` entry in the MCP clients
// found on this machine.
export async function run(argv = []) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(formatSetupHelp());
    return 0;
  }
  const options = parseSetupUserArgs(argv);
  const sourceDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const targetDir = helperHome();
  await installUserRuntime({ options, sourceDir, targetDir });
  return 0;
}

export function formatSetupHelp() {
  return `Usage:
  logwork setup [--yes] [--no-mcp-install] [--login|--no-login]

Installs the runtime to ~/.logwork-cli, links the \`logwork\` command, and adds
the "logwork" MCP server to the clients it finds (Claude Code, Cursor, Codex,
VS Code, Google Antigravity), asking once per client. Each edited config is
backed up first. Settings, mappings and the login session from an older
logwork-helper install are carried over automatically.

Options:
  --yes, -y         Update every detected MCP client without asking
  --no-mcp-install  Do not touch MCP client configs
  --login           Log in to Resource Optimiser after installing
  --no-login        Do not ask to log in`;
}

export async function installUserRuntime({
  options,
  sourceDir,
  targetDir,
  mkdirFn = fs.mkdir,
  copyFn = copyRuntimeFiles,
  cleanupFn = sanitizeRuntimeMetadata,
  installFn = installDependencies,
  linkFn = linkGlobalBinaries,
  authFn = maybeRunAuthLogin,
  runtimeInfoFn = recordRuntimeInfo,
  launcherFn = writeRuntimeLauncher,
  reminderFn = refreshReminderSchedule,
  mcpInstallFn = installMcpClients,
  printFn = printMcpInstructions
}) {
  await mkdirFn(targetDir, { recursive: true });
  if (resolve(sourceDir) !== resolve(targetDir)) {
    await copyFn(sourceDir, targetDir, sourceDir);
  }
  const cleanupResult = await cleanupFn(targetDir);
  await installFn(targetDir);
  const linkResult = await linkFn(targetDir);
  const authResult = await authFn(targetDir, options);
  await runtimeInfoFn(targetDir);
  await launcherFn(targetDir);
  const reminderResult = await reminderFn(targetDir);
  const mcpResult = await mcpInstallFn(targetDir, options);
  await printFn(targetDir, authResult, linkResult, cleanupResult, reminderResult, mcpResult);

  return {
    targetDir,
    authResult,
    linkResult,
    cleanupResult,
    reminderResult,
    mcpResult
  };
}

// macOS/Linux: <home>/bin/logwork-launch, which MCP configs and the reminder
// run. It must exist before the reminder is re-registered.
export async function writeRuntimeLauncher(targetDir, {
  nodePath = process.execPath,
  platform = process.platform,
  writeFn = writeLauncher
} = {}) {
  return writeFn({ home: targetDir, nodePath, platform });
}

// Adds or updates the `logwork` entry in the detected MCP clients:
// - --no-mcp-install: skipped;
// - --yes: every detected client, without asking;
// - a terminal: one yes/no per client that needs a change;
// - otherwise (npm exec from `logwork update`, CI): only the plan.
export async function installMcpClients(targetDir, options = {}, {
  interactive = isInteractiveTerminal(),
  ctx = createMcpInstallContext({ home: targetDir }),
  install = runMcpInstall,
  plan = planMcpInstall
} = {}) {
  if (options.mcpInstall === false) {
    return { mode: 'skipped', launch: ctx.launch };
  }
  try {
    if (options.yes || interactive) {
      const result = await install({ ctx, yes: Boolean(options.yes), interactive });
      return { mode: 'installed', launch: ctx.launch, results: result.results };
    }
    const plans = await plan(ctx);
    return { mode: 'planned', launch: ctx.launch, plans, lines: plans.flatMap((item) => describeMcpPlan(item, ctx)) };
  } catch (error) {
    return { mode: 'error', launch: ctx.launch, error: error.message };
  }
}

// Records the node that ran setup. The macOS/Linux launcher tries it first;
// on Windows the MCP configs and the reminder run it (or the nvm-windows
// symlink). doctor and reminder status compare it with the current Node.
// Best effort: a failed write must not fail the install.
export async function recordRuntimeInfo(targetDir, {
  nodePath = process.execPath,
  nodeVersion = process.version,
  writeFn = writeRuntimeInfo,
  readFileFn = fs.readFile
} = {}) {
  try {
    const manifest = JSON.parse(await readFileFn(join(targetDir, 'package.json'), 'utf8'));
    return await writeFn({
      path: join(targetDir, RUNTIME_INFO_FILE_NAME),
      nodePath,
      nodeVersion,
      version: manifest.version || null
    });
  } catch {
    return null;
  }
}

// A reminder enabled by an older install still points at the old runtime, or
// at a Node that nvm or Homebrew removed. Re-register it so the OS scheduler
// runs this runtime with the current node (and the legacy entry is removed by
// installReminderScheduler).
// The schedule runs the launcher (macOS) or a stable node.exe (Windows).
export async function refreshReminderSchedule(targetDir, {
  nodePath = process.execPath,
  loadConfig = loadReminderConfig,
  install = installReminderScheduler
} = {}) {
  try {
    const config = await loadConfig();
    if (!config?.enabled) {
      return null;
    }
    await install(config, { home: targetDir, nodePath });
    return { ok: true, nodePath };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// Copies only what the npm package ships (package.json "files", plus the
// manifest and lockfile). The target is also the state directory, so a git
// checkout's .env files, tests, archives or a repo-scope .logwork.json must
// never land there.
export async function copyRuntimeFiles(sourceDir, targetDir) {
  const manifest = JSON.parse(await fs.readFile(join(sourceDir, 'package.json'), 'utf8'));
  const listed = Array.isArray(manifest.files) ? manifest.files : [];
  const names = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', ...listed.map((item) => String(item).replace(/[\\/]+$/, ''))];
  for (const name of [...new Set(names)]) {
    const sourcePath = join(sourceDir, name);
    let stat;
    try {
      stat = await fs.stat(sourcePath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        // A lockfile from an earlier install that no longer matches this
        // package.json would make `npm ci` fail; let npm install write a new one.
        if (name === 'package-lock.json') {
          await fs.rm(join(targetDir, name), { force: true });
        }
        continue;
      }
      throw error;
    }
    if (stat.isDirectory()) {
      await fs.mkdir(join(targetDir, name), { recursive: true });
      await copyDirectory(sourcePath, targetDir, sourceDir);
    } else {
      await fs.mkdir(dirname(join(targetDir, name)), { recursive: true });
      await fs.copyFile(sourcePath, join(targetDir, name));
    }
  }
}

async function copyDirectory(sourceDir, targetDir, rootDir) {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry.name)) {
      continue;
    }

    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, relative(rootDir, sourcePath));

    if (entry.isDirectory()) {
      await fs.mkdir(targetPath, { recursive: true });
      await copyDirectory(sourcePath, targetDir, rootDir);
      continue;
    }

    if (!entry.isFile() && !entry.isSymbolicLink()) {
      continue;
    }

    await fs.mkdir(dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, targetPath);
  }
}

function installDependencies(targetDir) {
  return resolveInstallArgs(targetDir)
    .then((args) => runCommand('npm', args, {
      cwd: targetDir,
      stdio: 'inherit'
    }));
}

function runCommand(command, args, options = {}) {
  return new Promise((resolveValue, reject) => {
    const invocation = command === 'npm' ? npmInvocation(args) : { command, args, shell: false };
    const child = spawn(invocation.command, invocation.args, { ...options, shell: invocation.shell });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolveValue();
        return;
      }

      reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}.`));
    });
  });
}

async function resolveInstallArgs(targetDir) {
  try {
    await fs.access(join(targetDir, 'package-lock.json'));
    return ['ci', '--omit=dev'];
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    return ['install', '--omit=dev'];
  }
}

export async function sanitizeRuntimeMetadata(targetDir, {
  readFileFn = fs.readFile,
  writeFileFn = fs.writeFile
} = {}) {
  const changes = [];
  const packagePath = join(targetDir, 'package.json');
  const packageLockPath = join(targetDir, 'package-lock.json');

  await updateJsonFile(packagePath, {
    readFileFn,
    writeFileFn,
    changes
  }, (json) => {
    for (const name of PACKAGE_NAMES) {
      if (isStaleSelfDependency(json.dependencies?.[name])) {
        delete json.dependencies[name];
        changes.push(`package.json dependencies.${name}`);
      }
    }
    return json;
  });

  await updateJsonFile(packageLockPath, {
    readFileFn,
    writeFileFn,
    changes
  }, (json) => {
    for (const name of PACKAGE_NAMES) {
      if (isStaleSelfDependency(json.packages?.['']?.dependencies?.[name])) {
        delete json.packages[''].dependencies[name];
        changes.push(`package-lock.json packages[""].dependencies.${name}`);
      }
      if (json.packages?.[`node_modules/${name}`]) {
        delete json.packages[`node_modules/${name}`];
        changes.push(`package-lock.json packages["node_modules/${name}"]`);
      }
      if (json.dependencies?.[`node_modules/${name}`]) {
        delete json.dependencies[`node_modules/${name}`];
        changes.push(`package-lock.json dependencies["node_modules/${name}"]`);
      }
      if (isStaleSelfDependency(json.dependencies?.[name]?.version)) {
        delete json.dependencies[name];
        changes.push(`package-lock.json dependencies.${name}`);
      }
    }
    return json;
  });

  return {
    changed: changes.length > 0,
    changes
  };
}

async function updateJsonFile(path, { readFileFn, writeFileFn }, update) {
  let text;
  try {
    text = await readFileFn(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return;
    }
    throw error;
  }

  const json = JSON.parse(text);
  const before = JSON.stringify(json);
  const updated = update(json);
  const after = JSON.stringify(updated);
  if (before !== after) {
    await writeFileFn(path, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
  }
}

function isStaleSelfDependency(value) {
  return typeof value === 'string' && /^file:.*logwork-(helper|cli).*\.tgz$/i.test(value);
}

const LEGACY_GLOBAL_LINKS = [
  'bin/logwork',
  'bin/logwork-helper',
  'bin/logwork-helper-install',
  'bin/logwork-helper-manual',
  'bin/logwork-helper-mcp',
  'bin/logwork-helper-setup-user',
  'lib/node_modules/logwork-helper'
];

// The old package was installed with `npm link` from ~/.logwork-helper. When
// that folder is deleted first, its global links dangle: `npm rm -g` cannot
// read the package any more and leaves bin/logwork behind, which then blocks
// `npm install -g logwork-cli` and `npm link` with EEXIST. Remove only links
// that point into a logwork-helper path that no longer exists.
export async function removeDanglingLegacyLinks(globalPrefix, {
  platform = process.platform,
  lstatFn = fs.lstat,
  statFn = fs.stat,
  readlinkFn = fs.readlink,
  unlinkFn = fs.unlink
} = {}) {
  const removed = [];
  if (!globalPrefix || platform === 'win32') {
    return removed;
  }
  for (const relativePath of LEGACY_GLOBAL_LINKS) {
    const path = join(globalPrefix, relativePath);
    try {
      if (!(await lstatFn(path)).isSymbolicLink()) {
        continue;
      }
      if (!/logwork-helper/.test(await readlinkFn(path))) {
        continue;
      }
      try {
        await statFn(path);
        continue;
      } catch {
        // Dangling: the target is gone.
      }
      await unlinkFn(path);
      removed.push(path);
    } catch {
      // Missing or unreadable: nothing to clean.
    }
  }
  return removed;
}

function readNpmGlobalPrefix(cwd) {
  return new Promise((resolveValue) => {
    const invocation = npmInvocation(['prefix', '-g']);
    const child = spawn(invocation.command, invocation.args, { cwd, shell: invocation.shell, stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('error', () => resolveValue(''));
    child.on('close', (code) => resolveValue(code === 0 ? stdout.trim() : ''));
  });
}

export async function linkGlobalBinaries(targetDir, {
  runner = runCommand,
  commandFinder = findCommandOnPath,
  prefixReader = readNpmGlobalPrefix,
  legacyLinkCleaner = removeDanglingLegacyLinks
} = {}) {
  // Best effort: drop the pre-rename global package so its `logwork` bin does
  // not block linking this one. A no-op when it is not installed.
  await runner('npm', ['rm', '-g', LEGACY_PACKAGE_NAME], {
    cwd: targetDir,
    stdio: 'ignore'
  }).catch(() => {});
  await Promise.resolve()
    .then(() => prefixReader(targetDir))
    .then((prefix) => legacyLinkCleaner(prefix))
    .catch(() => []);

  try {
    await runner('npm', ['link'], {
      cwd: targetDir,
      stdio: 'inherit'
    });
  } catch (error) {
    return {
      linked: false,
      commandAvailable: false,
      error: error.message
    };
  }

  const commandAvailable = await commandFinder('logwork');
  return {
    linked: true,
    commandAvailable,
    warning: commandAvailable
      ? null
      : '`logwork` was linked, but it is not visible on PATH in this shell.'
  };
}

export async function findCommandOnPath(commandName, {
  platform = process.platform,
  envPath = process.env.PATH || '',
  accessFn = fs.access
} = {}) {
  const pathEntries = envPath.split(platform === 'win32' ? ';' : delimiter).filter(Boolean);
  const names = platform === 'win32'
    ? [commandName, `${commandName}.cmd`, `${commandName}.exe`, `${commandName}.bat`]
    : [commandName];
  for (const pathEntry of pathEntries) {
    for (const name of names) {
      const candidate = resolve(pathEntry, name);
      try {
        await accessFn(candidate, fsConstants.X_OK);
        return true;
      } catch {
        // Keep searching PATH.
      }
    }
  }

  return false;
}

export function parseSetupUserArgs(args = []) {
  let loginMode = 'prompt';
  let yes = false;
  let mcpInstall = true;

  for (const arg of args) {
    if (arg === '--login') {
      loginMode = 'required';
      continue;
    }
    if (arg === '--no-login') {
      loginMode = 'skip';
      continue;
    }
    if (arg === '--yes' || arg === '-y') {
      yes = true;
      continue;
    }
    if (arg === '--no-mcp-install') {
      mcpInstall = false;
      continue;
    }
    throw new Error(`Unknown setup option: ${arg}`);
  }

  return { loginMode, yes, mcpInstall };
}

async function maybeRunAuthLogin(targetDir, { loginMode }) {
  if (loginMode === 'skip') {
    return null;
  }

  const shouldRun = loginMode === 'required' || await shouldPromptLogin();
  if (!shouldRun) {
    return null;
  }

  try {
    await runAuthLogin(targetDir);
    return { ok: true };
  } catch (error) {
    if (loginMode === 'required') {
      throw error;
    }
    return {
      ok: false,
      error: error.message
    };
  }
}

async function shouldPromptLogin() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }

  const { confirm, isCancel } = await import('@clack/prompts');
  const { getStoredAuthStatus } = await import('../lib/auth.mjs');
  const status = await getStoredAuthStatus().catch(() => ({ authenticated: false }));
  if (status.authenticated) {
    return false;
  }

  const answer = await confirm({
    message: 'Log in to Resource Optimiser now?',
    initialValue: true
  });
  if (isCancel(answer)) {
    return false;
  }

  return Boolean(answer);
}

function runAuthLogin(targetDir) {
  return new Promise((resolveValue, reject) => {
    const child = spawn(process.execPath, [resolve(targetDir, 'bin', 'logwork.mjs'), 'login'], {
      cwd: targetDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        LOGWORK_HOME: targetDir
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolveValue();
        return;
      }
      reject(new Error(`Resource Optimiser auth login failed with exit code ${code}.`));
    });
  });
}

function printMcpInstructions(targetDir, authResult = null, linkResult = null, cleanupResult = null, reminderResult = null, mcpResult = null) {
  console.log(formatSetupUserInstructions({
    targetDir,
    authResult,
    linkResult,
    cleanupResult,
    reminderResult,
    mcpResult
  }));
}

export function formatSetupUserInstructions({
  targetDir,
  authResult = null,
  linkResult = null,
  cleanupResult = null,
  reminderResult = null,
  mcpResult = null,
  platform = process.platform,
  nodePath = process.execPath,
  env = process.env,
  launch = mcpResult?.launch || resolveLaunchCommand({ platform, home: targetDir, execPath: nodePath, env })
} = {}) {
  const storeLabel = credentialStoreLabel({ platform });
  const mcp = formatMcpSection({ mcpResult, launch, platform });
  const sections = [
    `logwork-cli installed to ${targetDir}.`,
    '',
    'Install status',
    `- Runtime: ${targetDir}`,
    '- Dependencies: installed',
    cleanupResult?.changed
      ? '- Runtime metadata: removed stale local tarball dependency'
      : '- Runtime metadata: ready',
    `- Auth: ${formatAuthStatus(authResult)}`,
    ...(reminderResult ? [`- Reminder: ${reminderResult.ok ? 're-registered for this runtime' : `not refreshed (${redactText(reminderResult.error || 'unknown error')}); run \`logwork reminder enable\``}`] : []),
    '',
    formatTerminalCommandInstructions(linkResult),
    '',
    'Next steps',
    ...formatNextSteps(authResult, mcp.manual),
    '',
    ...mcp.lines,
    '',
    'AI agent skill (log work from your commits)',
    '- Claude Code / Codex: run `logwork skill install`.',
    '- Other MCP clients: use the MCP prompt "log_from_commits".',
    '',
    'Verify',
    '- Restart or reload your IDE MCP tools after a config change.',
    '- In the IDE, ask: Check my logwork for this week.',
    '- `logwork mcp status` shows which clients have a current "logwork" entry.',
    '',
    'Safety',
    '- Do not paste passwords, 2FA codes, Bearer tokens, cookies, or raw curl auth logs into AI chat.',
    `- MCP config only needs command and args; tokens stay in ${storeLabel}.`,
    '- Project mappings are stored separately and never store Resource Optimiser tokens.'
  ];

  return sections.join('\n');
}

// The MCP part of the setup summary. `manual` is true when the user still has
// to paste a config somewhere.
function formatMcpSection({ mcpResult, launch, platform }) {
  const header = `MCP server "${MCP_SERVER_NAME}" runs: ${[launch.command, ...mcpArgs(launch)].join(' ')}`;
  if (mcpResult?.mode === 'installed' && mcpResult.results?.length) {
    const failed = mcpResult.results.some((result) => result.status === 'failed');
    return {
      manual: failed,
      lines: [header, 'MCP clients', ...formatMcpInstallResults(mcpResult.results)]
    };
  }
  if (mcpResult?.mode === 'planned') {
    const pending = (mcpResult.plans || []).some((plan) => plan.action === 'add' || plan.action === 'update');
    if (mcpResult.plans?.length) {
      return {
        manual: false,
        lines: [
          header,
          'MCP clients (not changed: this is not an interactive terminal)',
          ...(mcpResult.lines || []),
          ...(pending ? ['To apply: run `logwork mcp install` (asks per client) or `logwork mcp install --yes`.'] : [])
        ]
      };
    }
  }
  if (mcpResult?.mode === 'skipped') {
    return {
      manual: false,
      lines: [header, 'MCP clients: not changed (--no-mcp-install). Run `logwork mcp install` to add or update them, or `logwork mcp status` to check.']
    };
  }
  // No client found, an error, or an older caller: print every snippet.
  const lines = [header];
  if (mcpResult?.mode === 'error') {
    lines.push(`MCP clients: could not update automatically (${redactText(mcpResult.error || 'unknown error')}).`);
  } else if (mcpResult) {
    lines.push('MCP clients: none found (Claude Code, Cursor, Codex, VS Code, Google Antigravity).');
  }
  lines.push(...formatManualMcpSnippets(launch, { platform }));
  return { manual: true, lines };
}

export function formatManualMcpSnippets(launch, { platform = process.platform } = {}) {
  const note = launch.stable ? (launch.kind === 'launcher' ? MCP_LAUNCHER_NOTE : '') : MCP_NODE_PATH_NOTE;
  return [
    'Manual MCP config (paste into your client):',
    ...(note ? [note] : []),
    '',
    'Cursor / Antigravity / Claude Code (.mcp.json):',
    JSON.stringify(stdioMcpServersConfig(launch), null, 2),
    '',
    'Claude Code CLI:',
    formatClaudeMcpAddCommand(launch, { platform }),
    '',
    'Codex config.toml:',
    formatCodexToml(launch),
    '',
    'GitHub Copilot / VS Code mcp.json:',
    JSON.stringify(vscodeMcpConfig(launch), null, 2),
    '',
    'An old "logwork-helper" MCP entry can be deleted; it points at the old runtime.'
  ];
}

function formatAuthStatus(authResult) {
  if (authResult?.ok) {
    return 'completed';
  }
  if (authResult?.ok === false) {
    return `not completed (${redactText(authResult.error || 'unknown error')})`;
  }
  return 'not run';
}

function formatNextSteps(authResult, manualMcp = true) {
  const steps = [];
  let index = 1;
  if (!authResult?.ok) {
    steps.push(`${index}. Log in to Resource Optimiser:`);
    steps.push('   logwork login');
    index += 1;
  }
  if (manualMcp) {
    steps.push(`${index}. Paste the MCP config below into your IDE (or run \`logwork mcp install\`).`);
    index += 1;
  }
  steps.push(`${index}. Restart or reload your IDE MCP tools.`);
  steps.push(`${index + 1}. Verify with: Check my logwork for this week.`);
  return steps;
}

export function formatTerminalCommandInstructions(linkResult = null) {
  const commands = [
    'Terminal command installed:',
    '  logwork            open the terminal UI',
    '  logwork login      log in to Resource Optimiser',
    '  logwork --help     list all commands'
  ];

  if (!linkResult || (linkResult.linked === true && linkResult.commandAvailable === true)) {
    return commands.join('\n');
  }

  if (linkResult.linked === true && linkResult.commandAvailable === false) {
    return [
      ...commands,
      '',
      `Warning: ${linkResult.warning}`,
      'If `logwork` is not found, open a new terminal or ensure npm global bin is on PATH.'
    ].join('\n');
  }

  return [
    'Terminal command link did not complete.',
    `Reason: ${linkResult.error}`,
    '',
    'Fallback:',
    '  npm install -g logwork-cli'
  ].join('\n');
}
