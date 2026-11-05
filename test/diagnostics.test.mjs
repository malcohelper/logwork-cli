import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  diagnosticsReportPath,
  generateDiagnosticsReport
} from '../lib/diagnostics.mjs';
import { withEnv } from './helpers/env.mjs';

function makeJwt() {
  return 'eyJhbGciOiJIUzI1NiJ9.eyJpZCI6MTE1LCJlbWFpbCI6Im1hcnRpbkB2aW5vdmEuY29tLnNnIn0.signature';
}

test('generateDiagnosticsReport writes sanitized support report', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'logwork-diagnostics-'));
  await withEnv({ LOGWORK_HELPER_HOME: dir }, async () => {
    await mkdir(dir, { recursive: true });
    const cwd = join(dir, 'project');
    await mkdir(cwd, { recursive: true });
    await writeFile(join(dir, '.logwork-helper.json'), JSON.stringify({
      projectMappings: [
        {
          projectName: 'Course Builder',
          projectMemberId: 5234,
          tickets: ['SCB'],
          keywords: ['support keyword']
        }
      ]
    }), 'utf8');
    await writeFile(join(cwd, '.logwork-helper.json'), JSON.stringify({
      projectMappings: [
        {
          projectName: 'Operations',
          projectMemberId: 7777,
          tickets: ['OPS'],
          keywords: []
        }
      ]
    }), 'utf8');
    await writeFile(join(dir, 'auth-debug.log'), JSON.stringify({
      password: 'secret-password',
      otp: '654321',
      cookie: 'AUTH_SESSION_ID=abc',
      url: 'https://keycloak.vinova.sg/auth?session_code=s1&state=s2&nonce=s3&tab_id=t4&code=abc',
      token: makeJwt(),
      html: '<html><body><input name="password"></body></html>'
    }, null, 2));

    const outputPath = join(dir, 'diagnostics', 'report.txt');
    const result = await generateDiagnosticsReport({
      outputPath,
      now: () => new Date('2026-06-09T00:00:00.000Z'),
      cwd,
      commandFinder: async (command) => ({
        available: command === 'node',
        path: command === 'node' ? '/usr/bin/node' : null
      }),
      authStatusFn: async () => ({
        authenticated: true,
        expired: false,
        refreshAvailable: true,
        userId: 115,
        email: 'martin@vinova.com.sg',
        expiresAt: '2026-06-15T00:00:00.000Z',
        summary: 'Authenticated as user 115 (martin@vinova.com.sg). Token expires at 2026-06-15T00:00:00.000Z.'
      }),
      mcpSmokeFn: async () => ({
        ok: true,
        toolCount: 2,
        tools: ['query_logwork', 'preview_logwork_batch']
      })
    });

    assert.equal(result.path, outputPath);
    assert.match(result.summary, /Diagnostics report written to/);
    const report = await readFile(outputPath, 'utf8');
    assert.match(report, /Logwork Helper Diagnostics/);
    assert.match(report, /packageVersion:/);
    assert.match(report, /query_logwork/);
    assert.match(report, /Config Snapshot/);
    assert.match(report, /profile: vinova/);
    assert.match(report, /apiHost: api\.resourceoptimiser\.com/);
    assert.match(report, /keycloakHost: keycloak\.vinova\.sg/);
    assert.match(report, /mappingCount: 2/);
    assert.match(report, /mappingTicketCount: 2/);
    assert.match(report, /mappingKeywordCount: 1/);
    assert.match(report, /mappingDetails: <redacted; set LOGWORK_DIAGNOSTICS_INCLUDE_MAPPINGS=1 to include mapping details>/);
    assert.doesNotMatch(report, /"tickets":\["SCB"\]/);
    assert.doesNotMatch(report, /"tickets":\["OPS"\]/);
    assert.doesNotMatch(report, /Course Builder/);
    assert.doesNotMatch(report, /Operations/);
    assert.match(report, /projectConfig: exists/);
    assert.match(report, /Auth Status/);
    assert.doesNotMatch(report, /secret-password/);
    assert.doesNotMatch(report, /654321/);
    assert.doesNotMatch(report, /AUTH_SESSION_ID=abc/);
    assert.doesNotMatch(report, /session_code=s1/);
    assert.doesNotMatch(report, /state=s2/);
    assert.doesNotMatch(report, /nonce=s3/);
    assert.doesNotMatch(report, /tab_id=t4/);
    assert.doesNotMatch(report, /eyJ/);
    assert.doesNotMatch(report, /<html>/);
  });
});

test('generateDiagnosticsReport can include mapping details with explicit opt-in', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'logwork-diagnostics-mapping-opt-in-'));
  await withEnv({ LOGWORK_HELPER_HOME: dir }, async () => {
    await mkdir(dir, { recursive: true });
    const cwd = join(dir, 'project');
    await mkdir(cwd, { recursive: true });
    await writeFile(join(dir, '.logwork-helper.json'), JSON.stringify({
      projectMappings: [
        {
          projectName: 'Course Builder',
          projectMemberId: 5234,
          tickets: ['SCB'],
          keywords: ['support keyword']
        }
      ]
    }), 'utf8');

    const outputPath = join(dir, 'diagnostics', 'report.txt');
    await generateDiagnosticsReport({
      outputPath,
      cwd,
      includeMappingDetails: true,
      commandFinder: async () => ({ available: false, path: null }),
      authStatusFn: async () => ({ authenticated: false }),
      mcpSmokeFn: async () => ({ ok: true, toolCount: 0, tools: [] })
    });

    const report = await readFile(outputPath, 'utf8');
    assert.match(report, /Course Builder/);
    assert.match(report, /"tickets":\["SCB"\]/);
  });
});

test('diagnosticsReportPath writes inside helper diagnostics directory', () => {
  const dir = join(tmpdir(), 'logwork-helper-home-test');
  return withEnv({ LOGWORK_HELPER_HOME: dir }, async () => {
    const path = diagnosticsReportPath(new Date('2026-06-09T01:02:03.004Z'));
    assert.equal(path, join(dir, 'diagnostics', 'logwork-diagnostics-2026-06-09T01-02-03-004Z.txt'));
  });
});
