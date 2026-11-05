#!/usr/bin/env node

import { constants as fsConstants, promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactText } from './lib/auth-redaction.mjs';
import { credentialStoreLabel } from './lib/credential-store.mjs';
import { isMainModule } from './lib/entrypoint.mjs';
import { helperHome } from './lib/paths.mjs';

const EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules'
]);

async function main() {
  const options = parseSetupUserArgs(process.argv.slice(2));
  const sourceDir = dirname(fileURLToPath(import.meta.url));
  const targetDir = helperHome();
  await installUserRuntime({ options, sourceDir, targetDir });
}

export async function installUserRuntime({
  options,
  sourceDir,
  targetDir,
  mkdirFn = fs.mkdir,
  copyFn = copyDirectory,
  cleanupFn = sanitizeRuntimeMetadata,
  installFn = installDependencies,
  linkFn = linkGlobalBinaries,
  authFn = maybeRunAuthLogin,
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
  await printFn(targetDir, authResult, linkResult, cleanupResult);

  return {
    targetDir,
    authResult,
    linkResult,
    cleanupResult
  };
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
    const child = spawn(command, args, options);

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
    if (isStaleSelfDependency(json.dependencies?.['logwork-helper'])) {
      delete json.dependencies['logwork-helper'];
      changes.push('package.json dependencies.logwork-helper');
    }
    return json;
  });

  await updateJsonFile(packageLockPath, {
    readFileFn,
    writeFileFn,
    changes
  }, (json) => {
    if (isStaleSelfDependency(json.packages?.['']?.dependencies?.['logwork-helper'])) {
      delete json.packages[''].dependencies['logwork-helper'];
      changes.push('package-lock.json packages[""].dependencies.logwork-helper');
    }
    if (json.packages?.['node_modules/logwork-helper']) {
      delete json.packages['node_modules/logwork-helper'];
      changes.push('package-lock.json packages["node_modules/logwork-helper"]');
    }
    if (json.dependencies?.['node_modules/logwork-helper']) {
      delete json.dependencies['node_modules/logwork-helper'];
      changes.push('package-lock.json dependencies["node_modules/logwork-helper"]');
    }
    if (isStaleSelfDependency(json.dependencies?.['logwork-helper']?.version)) {
      delete json.dependencies['logwork-helper'];
      changes.push('package-lock.json dependencies.logwork-helper');
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
  return typeof value === 'string' && /^file:.*logwork-helper.*\.tgz$/i.test(value);
}

export async function linkGlobalBinaries(targetDir, {
  runner = runCommand,
  commandFinder = findCommandOnPath
} = {}) {
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
    throw new Error(`Unknown setup-user option: ${arg}`);
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
  const { getStoredAuthStatus } = await import('./lib/auth.mjs');
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
    const child = spawn(process.execPath, [resolve(targetDir, 'auth-cli.mjs'), 'login'], {
      cwd: targetDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        LOGWORK_HELPER_HOME: targetDir
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

function printMcpInstructions(targetDir, authResult = null, linkResult = null, cleanupResult = null) {
  console.log(formatSetupUserInstructions({
    targetDir,
    authResult,
    linkResult,
    cleanupResult
  }));
}

export function formatSetupUserInstructions({
  targetDir,
  authResult = null,
  linkResult = null,
  cleanupResult = null,
  platform = process.platform
} = {}) {
  const serverPath = resolve(targetDir, 'mcp-server.mjs');
  const storeLabel = credentialStoreLabel({ platform });
  const sections = [
    `Logwork Helper installed to ${targetDir}.`,
    '',
    'Install status',
    `- Runtime: ${targetDir}`,
    `- Dependencies: installed`,
    cleanupResult?.changed
      ? '- Runtime metadata: removed stale local logwork-helper tarball dependency'
      : '- Runtime metadata: ready',
    `- Auth: ${formatAuthStatus(authResult)}`,
    '',
    formatTerminalCommandInstructions(linkResult),
    '',
    'Next steps',
    ...formatNextSteps(authResult),
    '',
    'MCP config',
    '',
    'Cursor / Antigravity mcp_config.json:',
    JSON.stringify({
      mcpServers: {
        'logwork-helper': {
          command: 'node',
          args: [serverPath]
        }
      }
    }, null, 2),
    '',
    'Codex config.toml:',
    `[mcp_servers.logwork-helper]\ncommand = "node"\nargs = ["${serverPath}"]`,
    '',
    'GitHub Copilot / VS Code mcp.json:',
    JSON.stringify({
      servers: {
        logworkHelper: {
          type: 'stdio',
          command: 'node',
          args: [serverPath]
        }
      }
    }, null, 2),
    '',
    'Verify',
    '- Restart or reload your IDE MCP tools after pasting config.',
    '- In the IDE, ask: Check my logwork for this week.',
    '- If tools are missing, check the server path points to the mcp-server.mjs path above.',
    '',
    'Safety',
    '- Do not paste passwords, 2FA codes, Bearer tokens, cookies, or raw curl auth logs into AI chat.',
    `- MCP config only needs command and args; tokens stay in ${storeLabel}.`,
    '- Project mappings are stored separately and never store Resource Optimiser tokens.',
    '',
    'Optional Git hook install:',
    `  ${formatGitHookInstallCommand(targetDir, platform)}`
  ];

  return sections.join('\n');
}

function formatGitHookInstallCommand(targetDir, platform) {
  if (platform === 'win32') {
    return 'logwork-helper install-hook C:\\path\\to\\project-repo';
  }
  return `${resolve(targetDir, 'setup.sh')} /path/to/project-repo`;
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
    steps.push(`${index}. Authenticate Resource Optimiser:`);
    steps.push('   logwork-helper auth login');
    index += 1;
  }
  steps.push(`${index}. Paste one MCP config below into your IDE.`);
  steps.push(`${index + 1}. Restart or reload your IDE MCP tools.`);
  steps.push(`${index + 2}. Verify with: Check my logwork for this week.`);
  return steps;
}

export function formatTerminalCommandInstructions(linkResult = null) {
  const commands = [
    'Terminal commands installed:',
    '  logwork',
    '  logwork-helper auth login',
    '  logwork-helper mcp'
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
    '  npm install -g logwork-helper'
  ].join('\n');
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
