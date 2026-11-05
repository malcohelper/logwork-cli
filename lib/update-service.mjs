import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile } from './atomic-file.mjs';
import { redactText } from './auth-redaction.mjs';
import { fetchWithPolicy, redactedExcerpt } from './http.mjs';
import { readPackageInfo } from './package-info.mjs';
import { helperHome, updateStatePath } from './paths.mjs';

export const UPDATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const NPM_REGISTRY_ORIGIN = 'https://registry.npmjs.org';
export const UPDATE_PACKAGE_NAME = 'logwork-helper';

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseSemver(value) {
  const text = String(value || '').trim();
  const match = SEMVER_RE.exec(text);
  if (!match) {
    return null;
  }

  const prerelease = match[4]
    ? match[4].split('.').map((identifier) => (/^\d+$/.test(identifier) ? Number(identifier) : identifier))
    : [];
  if (match[4]?.split('.').some((identifier) => /^0\d+$/.test(identifier))) {
    return null;
  }

  return {
    raw: text,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
    build: match[5] || ''
  };
}

export function compareVersions(left, right) {
  const leftVersion = requireSemver(left, 'Current version');
  const rightVersion = requireSemver(right, 'Latest version');

  for (const key of ['major', 'minor', 'patch']) {
    if (leftVersion[key] !== rightVersion[key]) {
      return leftVersion[key] < rightVersion[key] ? -1 : 1;
    }
  }

  if (!leftVersion.prerelease.length && !rightVersion.prerelease.length) {
    return 0;
  }
  if (!leftVersion.prerelease.length) {
    return 1;
  }
  if (!rightVersion.prerelease.length) {
    return -1;
  }

  const length = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = leftVersion.prerelease[index];
    const rightIdentifier = rightVersion.prerelease[index];
    if (leftIdentifier === undefined) {
      return -1;
    }
    if (rightIdentifier === undefined) {
      return 1;
    }
    if (leftIdentifier === rightIdentifier) {
      continue;
    }
    if (typeof leftIdentifier === 'number' && typeof rightIdentifier !== 'number') {
      return -1;
    }
    if (typeof leftIdentifier !== 'number' && typeof rightIdentifier === 'number') {
      return 1;
    }
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }

  return 0;
}

export function isNewerVersion(latestVersion, currentVersion) {
  return compareVersions(latestVersion, currentVersion) > 0;
}

export async function checkForUpdates({
  force = false,
  allowStaleOnError = true,
  packageInfo = readPackageInfo(),
  cachePath = updateStatePath(),
  cacheTtlMs = UPDATE_CACHE_TTL_MS,
  fetchImpl = fetch,
  now = Date.now
} = {}) {
  const currentVersion = requireSemver(packageInfo.version, 'Installed package version').raw;
  const packageName = String(packageInfo.name || '').trim();
  if (packageName !== UPDATE_PACKAGE_NAME) {
    throw new Error(`Update checks are restricted to ${UPDATE_PACKAGE_NAME}.`);
  }

  const currentTime = Number(now());
  const cached = await readUpdateState(cachePath);
  if (!force && isFreshCache(cached, packageName, currentTime, cacheTtlMs)) {
    return buildUpdateResult({
      packageName,
      currentVersion,
      latestVersion: cached.latestVersion,
      checkedAt: cached.checkedAt,
      source: 'cache'
    });
  }

  try {
    const latest = await fetchLatestPackage({ packageName, fetchImpl });
    const checkedAt = new Date(currentTime).toISOString();
    const state = {
      packageName,
      latestVersion: latest.version,
      checkedAt
    };
    await atomicWriteFile(cachePath, `${JSON.stringify(state, null, 2)}\n`);
    return buildUpdateResult({
      packageName,
      currentVersion,
      latestVersion: latest.version,
      checkedAt,
      source: 'registry'
    });
  } catch (error) {
    if (allowStaleOnError && isValidCache(cached, packageName)) {
      return {
        ...buildUpdateResult({
          packageName,
          currentVersion,
          latestVersion: cached.latestVersion,
          checkedAt: cached.checkedAt,
          source: 'stale_cache'
        }),
        warning: `Registry check failed; showing the last cached result. ${redactText(error.message)}`
      };
    }
    throw error;
  }
}

export async function installUpdate({
  version,
  confirm,
  checkForUpdatesFn = checkForUpdates,
  runCommand = runUpdateCommand,
  readInstalledVersion = readRuntimeVersion,
  packageInfo = readPackageInfo(),
  stdio = 'pipe'
} = {}) {
  if (confirm !== true) {
    throw new Error('Update installation requires confirm: true.');
  }
  if (packageInfo.name !== UPDATE_PACKAGE_NAME) {
    throw new Error(`Update installation is restricted to ${UPDATE_PACKAGE_NAME}.`);
  }

  const requestedVersion = version === undefined
    ? null
    : requireSemver(version, 'Requested update version').raw;
  const update = await checkForUpdatesFn({
    force: true,
    allowStaleOnError: false,
    packageInfo
  });
  const targetVersion = requestedVersion || update.latestVersion;

  if (targetVersion !== update.latestVersion) {
    throw new Error(`Only the npm latest version can be installed. Requested ${targetVersion}; latest is ${update.latestVersion}.`);
  }
  if (!isNewerVersion(targetVersion, packageInfo.version)) {
    return {
      status: 'up_to_date',
      previousVersion: packageInfo.version,
      installedVersion: packageInfo.version,
      latestVersion: update.latestVersion,
      restartRequired: false,
      summary: `Logwork Helper ${packageInfo.version} is already up to date.`
    };
  }

  const executable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = [
    'exec',
    '--yes',
    `--registry=${NPM_REGISTRY_ORIGIN}`,
    `--package=${packageInfo.name}@${targetVersion}`,
    '--',
    'logwork-helper',
    'setup-user',
    '--no-login'
  ];
  const commandResult = await runCommand(executable, args, { stdio });
  if (commandResult.code !== 0) {
    const detail = redactedExcerpt(commandResult.stderr || commandResult.stdout || 'npm update command failed.');
    throw new Error(`Update installation failed with exit code ${commandResult.code}. ${detail}`);
  }

  const installedVersion = await readInstalledVersion();
  if (installedVersion !== targetVersion) {
    throw new Error(`Update verification failed: expected ${targetVersion}, found ${installedVersion || 'no installed version'}.`);
  }

  return {
    status: 'updated',
    previousVersion: packageInfo.version,
    installedVersion,
    latestVersion: update.latestVersion,
    restartRequired: true,
    command: `${executable} exec --yes --registry=${NPM_REGISTRY_ORIGIN} --package=${packageInfo.name}@${targetVersion} -- logwork-helper setup-user --no-login`,
    summary: `Updated Logwork Helper from ${packageInfo.version} to ${installedVersion}. Restart the terminal session and reconnect MCP clients.`
  };
}

export function formatUpdateNotice(result) {
  if (!result?.updateAvailable) {
    return '';
  }
  return `Update available: ${result.currentVersion} -> ${result.latestVersion}. Run \`logwork-helper update install\`.`;
}

async function fetchLatestPackage({ packageName, fetchImpl }) {
  const url = `${NPM_REGISTRY_ORIGIN}/${encodeURIComponent(packageName)}/latest`;
  const response = await fetchWithPolicy(url, {
    fetchImpl,
    timeoutMs: 3_000,
    retries: 1,
    retryDelayMs: 150,
    idempotent: true,
    headers: {
      accept: 'application/json'
    }
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`npm registry returned HTTP ${response.status}. ${redactedExcerpt(body, 200)}`);
  }

  const body = await response.json();
  if (body?.name && body.name !== packageName) {
    throw new Error('npm registry returned metadata for an unexpected package.');
  }
  return {
    version: requireSemver(body?.version, 'npm latest version').raw
  };
}

function buildUpdateResult({ packageName, currentVersion, latestVersion, checkedAt, source }) {
  const validLatest = requireSemver(latestVersion, 'Cached latest version').raw;
  const updateAvailable = isNewerVersion(validLatest, currentVersion);
  return {
    status: updateAvailable ? 'update_available' : 'up_to_date',
    packageName,
    currentVersion,
    latestVersion: validLatest,
    updateAvailable,
    checkedAt,
    source,
    releaseUrl: `https://github.com/tructran2598/logwork-helper/releases/tag/v${validLatest}`,
    summary: updateAvailable
      ? `Logwork Helper ${validLatest} is available; current version is ${currentVersion}.`
      : `Logwork Helper ${currentVersion} is up to date (npm latest: ${validLatest}).`
  };
}

async function readUpdateState(path) {
  try {
    const value = JSON.parse(await fs.readFile(path, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

function isFreshCache(cached, packageName, currentTime, cacheTtlMs) {
  if (!isValidCache(cached, packageName)) {
    return false;
  }
  const checkedAt = Date.parse(cached.checkedAt);
  return Number.isFinite(checkedAt) && currentTime - checkedAt >= 0 && currentTime - checkedAt < cacheTtlMs;
}

function isValidCache(cached, packageName) {
  return Boolean(
    cached &&
    cached.packageName === packageName &&
    parseSemver(cached.latestVersion) &&
    Number.isFinite(Date.parse(cached.checkedAt))
  );
}

function requireSemver(value, label) {
  const parsed = parseSemver(value);
  if (!parsed) {
    throw new Error(`${label} must be an exact SemVer value such as 1.2.3.`);
  }
  return parsed;
}

function runUpdateCommand(executable, args, { stdio = 'pipe' } = {}) {
  return new Promise((resolveValue, reject) => {
    const child = spawn(executable, args, {
      cwd: helperHome(),
      env: process.env,
      stdio: stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';

    if (stdio !== 'inherit') {
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => { stdout += chunk; });
      child.stderr?.on('data', (chunk) => { stderr += chunk; });
    }

    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolveValue({
        code: signal ? 1 : (code ?? 1),
        stdout,
        stderr
      });
    });
  });
}

async function readRuntimeVersion() {
  try {
    const packageJson = JSON.parse(await fs.readFile(join(helperHome(), 'package.json'), 'utf8'));
    return parseSemver(packageJson?.version)?.raw || null;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}
