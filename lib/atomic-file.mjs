import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

export async function atomicWriteFile(filePath, content, {
  encoding = 'utf8',
  mode = 0o600,
  mkdirFn = fs.mkdir,
  writeFileFn = fs.writeFile,
  renameFn = fs.rename,
  rmFn = fs.rm,
  now = Date.now,
  random = Math.random
} = {}) {
  await mkdirFn(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${now()}.${random().toString(36).slice(2, 10)}`;

  try {
    await writeFileFn(tmpPath, content, { encoding, mode });
    await renameFn(tmpPath, filePath);
  } catch (error) {
    await rmFn(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}
