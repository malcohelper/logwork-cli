import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const PACKAGE_NAME = 'logwork-helper';
const PACK_CACHE_PATH = '/private/tmp/logwork-helper-npm-cache';

export async function runReleaseDoctor({
  cwd = process.cwd(),
  full = false,
  runCommand = runCommandDefault,
  readFileFn = readFile,
  readdirFn = readdir
} = {}) {
  const checks = [];
  const packageState = await readPackageState({ cwd, readFileFn });
  checks.push(packageState.check);

  const version = packageState.packageJson?.version;
  checks.push(checkSelfDependency(packageState));
  checks.push(await checkGitStatus({ cwd, runCommand }));
  checks.push(await checkNpmRegistry({ cwd, runCommand }));
  checks.push(await checkNpmAuth({ cwd, runCommand }));

  if (version) {
    checks.push(await checkNpmVersion({ cwd, runCommand, version }));
    checks.push(await checkGitTag({ cwd, runCommand, version }));
    checks.push(await checkGitHubAuth({ cwd, runCommand }));
    checks.push(await checkGitHubRelease({ cwd, runCommand, version, packageJson: packageState.packageJson }));
  } else {
    checks.push(skipCheck('npm version', 'Skipped because package version could not be read.'));
    checks.push(skipCheck('git tag', 'Skipped because package version could not be read.'));
    checks.push(skipCheck('github auth', 'Skipped because package version could not be read.'));
    checks.push(skipCheck('github release', 'Skipped because package version could not be read.'));
  }

  checks.push(await checkTarballArtifacts({ cwd, readdirFn }));

  if (full) {
    checks.push(await checkCommand({
      name: 'git diff --check',
      cwd,
      runCommand,
      command: 'git',
      args: ['diff', '--check'],
      gitSafe: true
    }));
    checks.push(await checkCommand({
      name: 'npm test',
      cwd,
      runCommand,
      command: 'npm',
      args: ['test']
    }));
    checks.push(await checkCommand({
      name: 'npm audit',
      cwd,
      runCommand,
      command: 'npm',
      args: ['run', 'audit:prod']
    }));
    checks.push(await checkCommand({
      name: 'npm pack',
      cwd,
      runCommand,
      command: 'npm',
      args: ['pack', '--dry-run', '--cache', PACK_CACHE_PATH]
    }));
  } else {
    checks.push(skipCheck('full gates', 'Run `logwork-helper release doctor --full` before publishing to execute tests, audit, pack, and diff checks.'));
  }

  return buildReleaseDoctorResult({
    packageName: packageState.packageJson?.name || PACKAGE_NAME,
    version,
    full,
    checks
  });
}

export function formatReleaseDoctorReport(result) {
  const lines = [
    `Release doctor: ${result.status}`,
    `Package: ${result.packageName}@${result.version || 'unknown'}`,
    `Mode: ${result.full ? 'full' : 'fast'}`,
    ''
  ];

  for (const check of result.checks) {
    lines.push(`[${check.status.toUpperCase()}] ${check.name}: ${check.summary}`);
    if (check.details) {
      lines.push(`  ${check.details}`);
    }
  }

  if (result.nextSteps.length) {
    lines.push('');
    lines.push('Next steps:');
    for (const step of result.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return lines.join('\n');
}

export async function runCommandDefault(command, args = [], {
  cwd = process.cwd(),
  gitSafe = false
} = {}) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      ...(gitSafe ? { GIT_CONFIG_GLOBAL: '/dev/null' } : {})
    };
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      resolve({
        code: 127,
        stdout,
        stderr: error.message
      });
    });
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr
      });
    });
  });
}

async function readPackageState({ cwd, readFileFn }) {
  try {
    const packageJson = JSON.parse(await readFileFn(join(cwd, 'package.json'), 'utf8'));
    const packageLock = JSON.parse(await readFileFn(join(cwd, 'package-lock.json'), 'utf8'));
    const mismatches = [];
    if (packageLock.version !== packageJson.version) {
      mismatches.push(`package-lock version is ${packageLock.version || 'missing'}`);
    }
    if (packageLock.packages?.['']?.version !== packageJson.version) {
      mismatches.push(`package-lock root package version is ${packageLock.packages?.['']?.version || 'missing'}`);
    }
    if (mismatches.length) {
      return {
        packageJson,
        packageLock,
        check: failCheck('package version', `package.json is ${packageJson.version}, but ${mismatches.join(', ')}.`)
      };
    }
    return {
      packageJson,
      packageLock,
      check: okCheck('package version', `package.json and package-lock agree on ${packageJson.version}.`)
    };
  } catch (error) {
    return {
      packageJson: null,
      packageLock: null,
      check: failCheck('package version', `Unable to read package metadata: ${error.message}`)
    };
  }
}

function checkSelfDependency({ packageJson, packageLock }) {
  if (!packageJson) {
    return skipCheck('self dependency', 'Skipped because package.json could not be read.');
  }

  const dependencyFields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
  const offenders = [];
  for (const field of dependencyFields) {
    if (packageJson[field]?.[PACKAGE_NAME]) {
      offenders.push(`package.json ${field}.${PACKAGE_NAME}`);
    }
  }

  if (packageLock?.packages?.['']?.dependencies?.[PACKAGE_NAME]) {
    offenders.push(`package-lock root dependencies.${PACKAGE_NAME}`);
  }
  if (packageLock?.packages?.[`node_modules/${PACKAGE_NAME}`]) {
    offenders.push(`package-lock node_modules/${PACKAGE_NAME}`);
  }
  if (packageLock?.dependencies?.[PACKAGE_NAME]) {
    offenders.push(`package-lock dependencies.${PACKAGE_NAME}`);
  }

  if (offenders.length) {
    return failCheck('self dependency', `Remove stale local package references: ${offenders.join(', ')}.`);
  }

  return okCheck('self dependency', 'No local self-dependency is present.');
}

async function checkGitStatus({ cwd, runCommand }) {
  const result = await runCommand('git', ['status', '--short', '--branch'], { cwd, gitSafe: true });
  if (result.code !== 0) {
    return failCheck('git status', 'Unable to read git status.', sanitizeCommandOutput(result));
  }

  const lines = result.stdout.trim().split('\n').filter(Boolean);
  const branch = lines[0] || '';
  const dirty = lines.slice(1);
  if (!branch.startsWith('## main')) {
    return failCheck('git status', `Release must run from main. Current branch line: ${branch || 'unknown'}.`);
  }
  if (/\[(ahead|behind|gone)/.test(branch)) {
    return failCheck('git status', `main must be synced before publishing. Current branch line: ${branch}.`);
  }
  if (dirty.length) {
    return failCheck('git status', `Worktree has ${dirty.length} pending changes. Commit or clean them before publishing.`);
  }

  return okCheck('git status', 'main is clean and synced.');
}

async function checkNpmRegistry({ cwd, runCommand }) {
  const result = await runCommand('npm', ['config', 'get', 'registry'], { cwd });
  if (result.code !== 0) {
    return failCheck('npm registry', 'Unable to read npm registry.', sanitizeCommandOutput(result));
  }

  const registry = result.stdout.trim();
  if (registry !== 'https://registry.npmjs.org/') {
    return failCheck('npm registry', `Expected https://registry.npmjs.org/ but got ${registry || 'empty'}.`);
  }

  return okCheck('npm registry', registry);
}

async function checkNpmAuth({ cwd, runCommand }) {
  const result = await runCommand('npm', ['whoami'], { cwd });
  if (result.code !== 0) {
    return failCheck('npm auth', 'npm is not authenticated. Run `npm login --registry=https://registry.npmjs.org/`.', safeNpmAuthError(result));
  }

  return okCheck('npm auth', `Logged in as ${result.stdout.trim()}.`);
}

async function checkNpmVersion({ cwd, runCommand, version }) {
  const result = await runCommand('npm', ['view', PACKAGE_NAME, 'version'], { cwd });
  if (result.code !== 0) {
    return warnCheck('npm latest', 'Unable to read npm latest version.', sanitizeCommandOutput(result));
  }

  const latest = result.stdout.trim();
  const comparison = compareSemver(version, latest);
  if (comparison === null) {
    return warnCheck('npm latest', `Unable to compare local ${version} with npm latest ${latest}.`);
  }
  if (comparison <= 0) {
    return failCheck('npm latest', `Local version ${version} is not newer than npm latest ${latest}. Bump version before publishing.`);
  }

  return okCheck('npm latest', `Local version ${version} is newer than npm latest ${latest}.`);
}

async function checkGitTag({ cwd, runCommand, version }) {
  const tag = `v${version}`;
  const local = await runCommand('git', ['tag', '--list', tag], { cwd, gitSafe: true });
  const remote = await runCommand('git', ['ls-remote', '--tags', 'origin', tag], { cwd, gitSafe: true });
  if (local.code !== 0) {
    return failCheck('git tag', `Unable to inspect local tag ${tag}.`, sanitizeCommandOutput(local));
  }
  if (remote.code !== 0) {
    return warnCheck('git tag', `Unable to inspect remote tag ${tag}.`, sanitizeCommandOutput(remote));
  }

  const exists = Boolean(local.stdout.trim() || remote.stdout.trim());
  if (exists) {
    return warnCheck('git tag', `${tag} already exists locally or on origin. Do not recreate it.`);
  }

  return okCheck('git tag', `${tag} does not exist yet.`);
}

async function checkGitHubAuth({ cwd, runCommand }) {
  const result = await runCommand('gh', ['auth', 'status'], { cwd });
  if (result.code !== 0) {
    return failCheck('github auth', 'GitHub CLI is not authenticated or lacks required scopes.', sanitizeCommandOutput(result));
  }

  const output = `${result.stdout}\n${result.stderr}`;
  if (!/repo/.test(output)) {
    return warnCheck('github auth', 'GitHub CLI is authenticated, but repo scope was not visible in auth status output.');
  }
  if (!/workflow/.test(output)) {
    return warnCheck('github auth', 'GitHub CLI is authenticated, but workflow scope was not visible in auth status output.');
  }

  return okCheck('github auth', 'GitHub CLI auth is available with repo/workflow scope.');
}

async function checkGitHubRelease({ cwd, runCommand, version, packageJson }) {
  const repo = parseGitHubRepo(packageJson?.repository?.url || packageJson?.homepage || '');
  if (!repo) {
    return warnCheck('github release', 'Unable to infer GitHub repo from package metadata.');
  }

  const tag = `v${version}`;
  const result = await runCommand('gh', ['release', 'view', tag, '--repo', repo], { cwd });
  if (result.code === 0) {
    return warnCheck('github release', `Release ${tag} already exists on ${repo}.`);
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (/release not found/i.test(output) || /Not Found/i.test(output)) {
    return okCheck('github release', `Release ${tag} does not exist yet on ${repo}.`);
  }

  return warnCheck('github release', `Unable to verify release ${tag} on ${repo}.`, sanitizeCommandOutput(result));
}

async function checkTarballArtifacts({ cwd, readdirFn }) {
  try {
    const files = await readdirFn(cwd);
    const artifacts = files.filter((file) => file.endsWith('.tgz'));
    if (artifacts.length) {
      return warnCheck('tarball artifacts', `Remove generated tarballs before release: ${artifacts.join(', ')}.`);
    }
    return okCheck('tarball artifacts', 'No root .tgz artifacts found.');
  } catch (error) {
    return warnCheck('tarball artifacts', `Unable to inspect root directory: ${error.message}`);
  }
}

async function checkCommand({ name, cwd, runCommand, command, args, gitSafe = false }) {
  const result = await runCommand(command, args, { cwd, gitSafe });
  if (result.code !== 0) {
    return failCheck(name, `${name} failed.`, sanitizeCommandOutput(result));
  }
  return okCheck(name, `${name} passed.`);
}

function buildReleaseDoctorResult({ packageName, version, full, checks }) {
  const failed = checks.filter((check) => check.status === 'fail');
  const warned = checks.filter((check) => check.status === 'warn');
  const status = failed.length ? 'failed' : warned.length ? 'warning' : 'ok';
  const nextSteps = [];

  if (failed.some((check) => check.name === 'npm auth')) {
    nextSteps.push('Run `npm login --registry=https://registry.npmjs.org/`, then retry `npm whoami`.');
  }
  if (!full) {
    nextSteps.push('Run `logwork-helper release doctor --full` before publishing.');
  }
  if (status === 'ok' && full) {
    nextSteps.push('Publish with `npm publish --access public`, then verify with `npm view logwork-helper version`.');
  }

  return {
    packageName,
    version,
    full,
    status,
    ok: failed.length === 0,
    checks,
    nextSteps
  };
}

function okCheck(name, summary, details = '') {
  return createCheck('ok', name, summary, details);
}

function warnCheck(name, summary, details = '') {
  return createCheck('warn', name, summary, details);
}

function failCheck(name, summary, details = '') {
  return createCheck('fail', name, summary, details);
}

function skipCheck(name, summary, details = '') {
  return createCheck('skip', name, summary, details);
}

function createCheck(status, name, summary, details = '') {
  return {
    status,
    name,
    summary,
    ...(details ? { details } : {})
  };
}

function sanitizeCommandOutput(result) {
  return [result.stdout, result.stderr]
    .join('\n')
    .replace(/\/\/registry\.npmjs\.org\/:_authToken=[^\s]+/g, '//registry.npmjs.org/:_authToken=[REDACTED]')
    .replace(/npm_[A-Za-z0-9_-]+/g, '[REDACTED_NPM_TOKEN]')
    .replace(/gho_[A-Za-z0-9_]+/g, '[REDACTED_GITHUB_TOKEN]')
    .trim();
}

function safeNpmAuthError(result) {
  const output = sanitizeCommandOutput(result);
  return output.replace(/A complete log of this run can be found in:.+/g, 'npm wrote a local debug log; do not paste it into chat.');
}

function parseGitHubRepo(value) {
  const text = String(value || '');
  const match = text.match(/github\.com[:/]([^/\s]+)\/([^/\s#]+?)(?:\.git)?(?:[#/].*)?$/);
  if (!match) {
    return '';
  }
  return `${match[1]}/${match[2]}`;
}

function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) {
    return null;
  }

  for (let index = 0; index < 3; index += 1) {
    if (a[index] > b[index]) {
      return 1;
    }
    if (a[index] < b[index]) {
      return -1;
    }
  }
  return 0;
}

function parseSemver(value) {
  const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) {
    return null;
  }
  return match.slice(1).map((part) => Number(part));
}
