import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_DELAY_MS = 25;

export async function withFileLock(filePath, operation, {
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  mkdirFn = fs.mkdir,
  rmFn = fs.rm,
  now = Date.now,
  delayFn = delay
} = {}) {
  if (typeof operation !== 'function') {
    throw new Error('withFileLock requires an operation function.');
  }

  await mkdirFn(dirname(filePath), { recursive: true });
  const lockPath = `${filePath}.lock`;
  const startedAt = now();

  while (true) {
    try {
      await mkdirFn(lockPath);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
      if (now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for file lock: ${filePath}`);
      }
      await delayFn(retryDelayMs);
    }
  }

  try {
    return await operation();
  } finally {
    await rmFn(lockPath, { recursive: true, force: true }).catch(() => {});
  }
}
