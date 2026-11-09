import { promises as fs } from 'node:fs';
import { basename } from 'node:path';
import { atomicWriteFile } from './atomic-file.mjs';
import { LAUNCHER_FILE_NAME, resolveLaunchCommand } from './launcher.mjs';
import { runtimeInfoPath } from './paths.mjs';

// `logwork setup` records the node it ran with here. On macOS/Linux the
// generated launcher (lib/launcher.mjs) tries that node first and falls back
// to another Node 22+, so IDE configs and the reminder survive upgrades. On
// Windows the configs and the task store a node.exe path, which `logwork
// doctor` and `logwork reminder status` compare with this record.

export async function writeRuntimeInfo({
  path = runtimeInfoPath(),
  nodePath = process.execPath,
  nodeVersion = process.version,
  version = null,
  now = () => new Date(),
  writeFile = atomicWriteFile
} = {}) {
  const info = {
    nodePath: String(nodePath || ''),
    nodeVersion: String(nodeVersion || ''),
    installedAt: now().toISOString(),
    version: version ? String(version) : null
  };
  await writeFile(path, `${JSON.stringify(info, null, 2)}\n`);
  return info;
}

export async function loadRuntimeInfo({
  path = runtimeInfoPath(),
  readFile = fs.readFile
} = {}) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.nodePath !== 'string' || !parsed.nodePath) {
    return null;
  }
  return {
    nodePath: parsed.nodePath,
    nodeVersion: typeof parsed.nodeVersion === 'string' ? parsed.nodeVersion : '',
    installedAt: typeof parsed.installedAt === 'string' ? parsed.installedAt : '',
    version: typeof parsed.version === 'string' ? parsed.version : null
  };
}

// ok: the recorded node is the current one (same file after symlinks).
// missing: the recorded node no longer exists.
// stale: it exists but differs from the current, working node.
export async function inspectNodePath(recordedPath, {
  currentPath = process.execPath,
  platform = process.platform,
  exists = pathExists,
  realpath = fs.realpath
} = {}) {
  const recorded = String(recordedPath || '');
  if (!recorded) {
    return { status: 'unknown', recordedPath: '', currentPath };
  }
  if (!await exists(recorded)) {
    return { status: 'missing', recordedPath: recorded, currentPath };
  }
  const [left, right] = await Promise.all([
    realpath(recorded).catch(() => recorded),
    realpath(currentPath).catch(() => currentPath)
  ]);
  const same = platform === 'win32'
    ? String(left).toLowerCase() === String(right).toLowerCase()
    : left === right;
  if (same) {
    return { status: 'ok', recordedPath: recorded, currentPath };
  }
  if (!await exists(currentPath)) {
    // Not stale: there is no working node to switch to.
    return { status: 'differs', recordedPath: recorded, currentPath };
  }
  return { status: 'stale', recordedPath: recorded, currentPath };
}

// Compares the command an installed OS schedule runs with the current launch
// command. Statuses:
// ok: it runs the current launch command (and that command exists).
// missing: the command (launcher or node) no longer exists.
// legacy: macOS/Linux schedule from an older install that runs a raw Node
//   path instead of the launcher.
// stale: it runs another launcher or another node.
export async function inspectScheduledCommand(commandPath, {
  launch = resolveLaunchCommand(),
  platform = process.platform,
  exists = pathExists,
  inspect = inspectNodePath
} = {}) {
  const recorded = String(commandPath || '');
  const currentPath = launch.command;
  if (!recorded) {
    return { status: 'unknown', recordedPath: '', currentPath };
  }
  const same = platform === 'win32'
    ? recorded.toLowerCase() === String(currentPath).toLowerCase()
    : recorded === currentPath;
  if (same) {
    return { status: await exists(recorded) ? 'ok' : 'missing', recordedPath: recorded, currentPath, kind: launch.kind };
  }
  if (launch.kind === 'launcher') {
    if (basename(recorded) === LAUNCHER_FILE_NAME) {
      return { status: await exists(recorded) ? 'stale' : 'missing', recordedPath: recorded, currentPath, kind: 'launcher' };
    }
    return { status: await exists(recorded) ? 'legacy' : 'missing', recordedPath: recorded, currentPath, kind: 'node' };
  }
  const checked = await inspect(recorded, { currentPath, platform });
  return { ...checked, currentPath, kind: 'node' };
}

// source "runtime": the node recorded by `logwork setup` (Windows MCP configs
// use it). source "reminder": the command in the installed OS schedule.
export function formatNodePathIssue(source, inspection) {
  const { status, recordedPath, currentPath, kind } = inspection || {};
  if (source === 'reminder') {
    const what = kind === 'launcher' ? 'the logwork launcher at' : 'Node at';
    if (status === 'missing') {
      return `Reminder: the OS schedule runs ${what} ${recordedPath}, which no longer exists, so the reminder cannot run. Fix: run \`logwork reminder enable\` (or \`logwork setup\`) to re-register it.`;
    }
    if (status === 'legacy') {
      return `Reminder: the OS schedule runs Node at ${recordedPath} directly instead of the logwork launcher, so a Node upgrade will break it. Fix: re-run \`logwork setup\` (or \`logwork reminder enable\`).`;
    }
    if (status === 'stale') {
      return `Reminder: the OS schedule runs ${what} ${recordedPath}, but the current command is ${currentPath}. Fix: run \`logwork reminder enable\` (or \`logwork setup\`) to re-register it.`;
    }
    return '';
  }
  if (status === 'missing') {
    return `Runtime: \`logwork setup\` recorded Node at ${recordedPath}, which no longer exists, so IDE MCP configs that use it cannot start. Fix: run \`logwork setup\`; it updates the MCP configs it can edit.`;
  }
  if (status === 'stale') {
    return `Runtime: \`logwork setup\` recorded Node at ${recordedPath}, but the current Node is ${currentPath}. Fix: if you switched Node on purpose, run \`logwork setup\`; it updates the MCP configs it can edit.`;
  }
  return '';
}

async function pathExists(path) {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}
