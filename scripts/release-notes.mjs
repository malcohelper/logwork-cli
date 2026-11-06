#!/usr/bin/env node
// Prints the CHANGELOG.md section for one version, for use as the GitHub
// Release description. Exits non-zero when the section is missing so a release
// never goes out without a description.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export function extractReleaseNotes(changelog, version) {
  const lines = String(changelog).split(/\r?\n/);
  const heading = new RegExp(`^## \\[?v?${version.replace(/\./g, '\\.')}\\]?(\\s|$)`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) {
    return null;
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^## /.test(line));
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
  return body || null;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const version = process.argv[2];
  if (!version) {
    console.error('Usage: node scripts/release-notes.mjs <version>');
    process.exit(2);
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const notes = extractReleaseNotes(readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8'), version);
  if (!notes) {
    console.error(`CHANGELOG.md has no "## [${version}]" section. Add release notes before bumping the version.`);
    process.exit(1);
  }
  process.stdout.write(`${notes}\n`);
}
