import { constants as fsConstants, promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactText } from '../lib/auth-redaction.mjs';
import { credentialStoreLabel } from '../lib/credential-store.mjs';
import { npmInvocation } from '../lib/npm-command.mjs';
import { helperHome } from '../lib/paths.mjs';
import {
  MCP_SERVER_NAME,
  defaultMcpServerPath,
  formatCodexToml,
  stdioMcpServersConfig,
  vscodeMcpConfig
} from '../lib/manual-mcp.mjs';
import { loadReminderConfig } from '../lib/reminder-config.mjs';
import { installReminderScheduler } from '../lib/reminder-scheduler.mjs';

// Package name before the rename. Its global install provides a `logwork` bin
// that would block `npm link` of logwork-cli, so setup removes it first.
const LEGACY_PACKAGE_NAME = 'logwork-helper';
const PACKAGE_NAMES = ['logwork-cli', LEGACY_PACKAGE_NAME];

const EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules'
]);

// `logwork setup`: copy this package into ~/.logwork-cli, install its
// dependencies, link the `logwork` command, refresh a migrated reminder, and
// print the MCP configs.
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
  logwork setup [--login|--no-login]

Installs the runtime to ~/.logwork-cli, links the \`logwork\` command, and prints
MCP configs for Cursor, Antigravity, Claude Code, Codex and VS Code.
Settings, mappings and the login session from an older logwork-helper install
are carried over automatically.

Options:
  --login     Log in to Resource Optimiser after installing
  --no-login  Do not ask to log in`;
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
  reminderFn = refreshReminderSchedule,
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
  const reminderResult = await reminderFn(targetDir);
  await printFn(targetDir, authResult, linkResult, cleanupResult, reminderResult);

  return {
    targetDir,
    authResult,
    linkResult,
    cleanupResult,
    reminderResult
  };
}

// A reminder enabled by an older install still points at the old runtime.
// Re-register it so the OS scheduler runs this runtime (and the legacy entry
// is removed by installReminderScheduler).
async function refreshReminderSchedule(targetDir) {
  try {
    const config = await loadReminderConfig();
    if (!config?.enabled) {
      return null;
    }
    await installReminderScheduler(config, { home: targetDir });
    return { ok: true };
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

  for (const arg of args) {
    if (arg === '--login') {
      loginMode = 'required';
      continue;
    }
    if (arg === '--no-login') {
      loginMode = 'skip';
      continue;
    }
    throw new Error(`Unknown setup option: ${arg}`);
  }

  return { loginMode };
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

function printMcpInstructions(targetDir, authResult = null, linkResult = null, cleanupResult = null, reminderResult = null) {
  console.log(formatSetupUserInstructions({
    targetDir,
    authResult,
    linkResult,
    cleanupResult,
    reminderResult
  }));
}

export function formatSetupUserInstructions({
  targetDir,
  authResult = null,
  linkResult = null,
  cleanupResult = null,
  reminderResult = null,
  platform = process.platform
} = {}) {
  const entryPath = resolve(targetDir, 'bin', 'logwork.mjs');
  const storeLabel = credentialStoreLabel({ platform });
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
    ...formatNextSteps(authResult),
    '',
    `MCP config (server name "${MCP_SERVER_NAME}", runs: node ${entryPath} mcp)`,
    '',
    'Cursor / Antigravity / Claude Code (.mcp.json):',
    JSON.stringify(stdioMcpServersConfig(entryPath), null, 2),
    '',
    'Codex config.toml:',
    formatCodexToml(entryPath),
    '',
    'GitHub Copilot / VS Code mcp.json:',
    JSON.stringify(vscodeMcpConfig(entryPath), null, 2),
    '',
    'AI agent skill (log work from your commits)',
    '- Claude Code / Codex: run `logwork skill install`.',
    '- Other MCP clients: use the MCP prompt "log_from_commits".',
    '',
    'Verify',
    '- Restart or reload your IDE MCP tools after pasting config.',
    '- In the IDE, ask: Check my logwork for this week.',
    '- An old "logwork-helper" MCP entry can be deleted; it points at the old runtime.',
    '',
    'Safety',
    '- Do not paste passwords, 2FA codes, Bearer tokens, cookies, or raw curl auth logs into AI chat.',
    `- MCP config only needs command and args; tokens stay in ${storeLabel}.`,
    '- Project mappings are stored separately and never store Resource Optimiser tokens.'
  ];

  return sections.join('\n');
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

function formatNextSteps(authResult) {
  const steps = [];
  let index = 1;
  if (!authResult?.ok) {
    steps.push(`${index}. Log in to Resource Optimiser:`);
    steps.push('   logwork login');
    index += 1;
  }
  steps.push(`${index}. Paste one MCP config below into your IDE.`);
  steps.push(`${index + 1}. Restart or reload your IDE MCP tools.`);
  steps.push(`${index + 2}. Verify with: Check my logwork for this week.`);
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
