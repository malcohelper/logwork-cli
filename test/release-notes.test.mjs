import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractReleaseNotes } from '../scripts/release-notes.mjs';

const CHANGELOG = `# Changelog

## [1.1.0] - 2026-11-08

### Summary
- New thing

## [1.0.0] - 2026-11-07

### Summary
- First
`;

test('release notes extract exactly one version section', () => {
  assert.equal(extractReleaseNotes(CHANGELOG, '1.1.0'), '### Summary\n- New thing');
  assert.equal(extractReleaseNotes(CHANGELOG, '1.0.0'), '### Summary\n- First');
  assert.equal(extractReleaseNotes(CHANGELOG, '1.0'), null);
  assert.equal(extractReleaseNotes(CHANGELOG, '2.0.0'), null);
});

test('the current package version has release notes in CHANGELOG.md', () => {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  assert.ok(extractReleaseNotes(changelog, version), `CHANGELOG.md needs a "## [${version}]" section`);
});
