import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { CONFIG } from '../config.mjs';
import { nowIso } from './util.mjs';

const REQUIRED_ARGS = ['repo', 'msgFile', 'lock', 'result', 'nonce', 'terminalTitle'];

export function parseArgs(argv) {
  const args = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const key = toCamelCase(arg.slice(2));
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${arg}`);
    }

    args[key] = value;
    i += 1;
  }

  for (const key of REQUIRED_ARGS) {
    if (typeof args[key] !== 'string' || args[key].trim() === '') {
      throw new Error(`Missing required argument --${toKebabCase(key)}`);
    }
  }

  return args;
}

export async function atomicWriteFile(filePath, content) {
  await fs.mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmpPath, filePath);
}

export async function writeResult({ resultPath, nonce, status, reason }) {
  const allowed = new Set(Object.values(CONFIG.resultValues));
  if (!allowed.has(status)) {
    throw new Error(`Invalid result status: ${status}`);
  }

  const body = JSON.stringify({
    nonce,
    status,
    reason: String(reason || status),
    timestamp: nowIso()
  }, null, 2);

  await atomicWriteFile(resultPath, `${body}\n`);
}

export async function removeLock(lockPath) {
  await fs.rm(lockPath, { force: true });
}

export function installSignalHandlers({ lock: lockPath, result: resultPath, nonce }) {
  let handling = false;

  const handler = (signal) => {
    if (handling) {
      process.exit(signal === 'SIGINT' ? 130 : 1);
    }

    handling = true;
    writeResult({
      resultPath,
      nonce,
      status: CONFIG.resultValues.abort,
      reason: `received ${signal}`
    })
      .catch(() => {})
      .finally(() => removeLock(lockPath).catch(() => {}))
      .finally(() => {
        process.exit(signal === 'SIGINT' ? 130 : 1);
      });
  };

  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);
  process.once('SIGHUP', handler);
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function toKebabCase(value) {
  return value.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}
