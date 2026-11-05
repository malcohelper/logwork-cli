import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAuthDiagnosticsRecorder,
  sanitizeDiagnosticValue
} from '../lib/auth-diagnostics.mjs';

test('auth diagnostics writes sanitized failure report only when requested', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'logwork-auth-diagnostics-'));
  const logPath = join(dir, 'auth-debug.log');
  const recorder = createAuthDiagnosticsRecorder({
    attemptId: 'attempt-1',
    logPath,
    now: () => '2026-06-09T00:00:00.000Z'
  });

  recorder.event('authorize_request', {
    url: 'https://keycloak.vinova.sg/auth?state=raw-state&nonce=raw-nonce&client_id=localhost',
    password: 'secret-password',
    otp: '654321',
    token: makeJwt()
  });
  recorder.event('signin_keycloak_response', {
    status: 200,
    jsonKeys: ['accessToken', 'data.user.name'],
    html: '<form><input name="password" value="secret-password"></form>'
  });

  await assert.rejects(() => stat(logPath), /ENOENT/);
  const error = new Error(`Failed with password=secret-password otp=654321 accessToken=${makeJwt()}`);
  error.code = 'API_AUTH_FAILED';
  const written = await recorder.writeFailure(error);

  assert.equal(written.path, logPath);
  assert.equal(written.attemptId, 'attempt-1');
  const log = await readFile(logPath, 'utf8');
  assert.match(log, /"attemptId": "attempt-1"/);
  assert.match(log, /"name": "authorize_request"/);
  assert.match(log, /"name": "signin_keycloak_response"/);
  assert.match(log, /"status": 200/);
  assert.match(log, /"accessToken"/);
  assert.doesNotMatch(log, /secret-password/);
  assert.doesNotMatch(log, /654321/);
  assert.doesNotMatch(log, /raw-state/);
  assert.doesNotMatch(log, /raw-nonce/);
  assert.doesNotMatch(log, /eyJ/);
  assert.doesNotMatch(log, /<form/);
});

test('sanitizeDiagnosticValue redacts sensitive nested fields and raw HTML', () => {
  const sanitized = sanitizeDiagnosticValue({
    safe: 'value',
    url: 'https://example.test/path?code=auth-code&tab_id=tab&client_id=localhost',
    nested: {
      Cookie: 'AUTH_SESSION_ID=raw',
      body: '<html><script>const token = "raw"</script></html>',
      message: `Bearer ${makeJwt()}`
    }
  });

  assert.equal(sanitized.safe, 'value');
  assert.match(sanitized.url, /code=<redacted>/);
  assert.match(sanitized.url, /client_id=%3Cvalue%3E/);
  assert.equal(sanitized.nested.Cookie, '<redacted>');
  assert.equal(sanitized.nested.body, '<html-redacted>');
  assert.equal(sanitized.nested.message, 'Bearer <redacted>');
});

function makeJwt() {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ id: 115, exp: 1781495600 })).toString('base64url'),
    'signature'
  ].join('.');
}
