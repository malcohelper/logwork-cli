import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readPackageInfo, readPackageVersion } from '../lib/package-info.mjs';

test('package info helper reads package metadata from one source', () => {
  const info = readPackageInfo({
    readFile: () => JSON.stringify({
      name: 'logwork-helper',
      version: '1.2.3'
    })
  });

  assert.deepEqual(info, {
    name: 'logwork-helper',
    version: '1.2.3'
  });
  assert.equal(readPackageVersion({
    readFile: () => JSON.stringify({
      name: 'logwork-helper',
      version: '1.2.3'
    })
  }), '1.2.3');
});

test('MCP server version is sourced from package metadata', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const serverSource = readFileSync(new URL('../mcp-server.mjs', import.meta.url), 'utf8');

  assert.equal(readPackageVersion(), packageJson.version);
  assert.match(serverSource, /version:\s*readPackageVersion\(\)/);
  assert.doesNotMatch(serverSource, /version:\s*['"]0\.1\.0['"]/);
});

test('release gate scripts are available', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

  assert.equal(packageJson.scripts['audit:prod'], 'npm audit --omit=dev --audit-level=moderate');
  assert.equal(packageJson.scripts['pack:check'], 'npm pack --dry-run');
  assert.equal(packageJson.scripts['release:doctor'], 'node release-cli.mjs doctor --full');
  assert.match(packageJson.scripts['test:windows-credential'], /credential-store\.test\.mjs/);
  assert.match(packageJson.scripts['release:check'], /npm test/);
  assert.match(packageJson.scripts['release:check'], /npm run audit:prod/);
  assert.match(packageJson.scripts['release:check'], /npm run pack:check/);
  assert.match(packageJson.scripts['release:check'], /git diff --check/);
  assert.ok(packageJson.files.includes('RELEASE.md'));
  assert.ok(packageJson.files.includes('release-cli.mjs'));
  assert.ok(packageJson.files.includes('reminder-cli.mjs'));
  assert.ok(packageJson.files.includes('history-cli.mjs'));
  assert.ok(packageJson.files.includes('update-cli.mjs'));
});
