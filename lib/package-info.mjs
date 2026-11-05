import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export function readPackageInfo({ packagePath = join(PACKAGE_ROOT, 'package.json'), readFile = readFileSync } = {}) {
  const packageJson = JSON.parse(readFile(packagePath, 'utf8'));
  return {
    name: packageJson.name,
    version: packageJson.version
  };
}

export function readPackageVersion(options = {}) {
  return readPackageInfo(options).version;
}
