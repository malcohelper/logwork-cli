import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function isMainModule(importMetaUrl, argv = process.argv) {
  if (!argv[1]) {
    return false;
  }

  try {
    return importMetaUrl === pathToFileURL(realpathSync(argv[1])).href;
  } catch {
    return importMetaUrl === pathToFileURL(argv[1]).href;
  }
}
