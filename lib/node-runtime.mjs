import { promises as fs } from 'node:fs';
import { atomicWriteFile } from './atomic-file.mjs';
import { runtimeInfoPath } from './paths.mjs';

// The node binary that runs the MCP server and the reminder is stored as an
// absolute path (IDE configs, the launchd plist, the Windows task). With nvm,
// Homebrew or a Node installer upgrade that path can disappear or stop being
// the node the user runs. `logwork setup` records it here so `logwork doctor`
// and `logwork reminder status` can tell when it went stale.

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

// source "runtime": the node recorded by `logwork setup` (used by the printed
// MCP configs). source "reminder": the node in the installed OS schedule.
export function formatNodePathIssue(source, inspection) {
  const { status, recordedPath, currentPath } = inspection || {};
  if (source === 'reminder') {
    if (status === 'missing') {
      return `Reminder: the OS schedule runs Node at ${recordedPath}, which no longer exists, so the reminder cannot run. Fix: run \`logwork reminder enable\` (or \`logwork setup\`) to re-register it with the current Node.`;
    }
    if (status === 'stale') {
      return `Reminder: the OS schedule runs Node at ${recordedPath}, but the current Node is ${currentPath}. Fix: run \`logwork reminder enable\` to re-register it with the current Node.`;
    }
    return '';
  }
  if (status === 'missing') {
    return `Runtime: \`logwork setup\` recorded Node at ${recordedPath}, which no longer exists, so IDE MCP configs that use it cannot start. Fix: run \`logwork setup\` and paste the new MCP config "command" into your IDE.`;
  }
  if (status === 'stale') {
    return `Runtime: \`logwork setup\` recorded Node at ${recordedPath}, but the current Node is ${currentPath}. Fix: if you switched Node on purpose, run \`logwork setup\` and update the MCP config "command" in your IDE.`;
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
