import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isSensitiveName, redactText, sanitizeUrl } from './auth-redaction.mjs';
import { helperHome } from './paths.mjs';

export const AUTH_DEBUG_LOG_FILE_NAME = 'auth-debug.log';

export function authDebugLogPath() {
  return resolve(helperHome(), AUTH_DEBUG_LOG_FILE_NAME);
}

export function createAuthDiagnosticsRecorder({
  attemptId = randomUUID(),
  logPath = authDebugLogPath(),
  now = () => new Date().toISOString()
} = {}) {
  const createdAt = now();
  const events = [];

  function event(name, details = {}) {
    events.push({
      at: now(),
      name: String(name || 'unknown'),
      details: sanitizeDiagnosticValue(details)
    });
  }

  function snapshot(error) {
    return {
      attemptId,
      createdAt,
      failedAt: now(),
      error: sanitizeDiagnosticValue({
        name: error?.name || 'Error',
        code: error?.code || null,
        message: error?.message || String(error || 'Unknown auth error')
      }),
      events: [...events]
    };
  }

  async function writeFailure(error) {
    const payload = snapshot(error);
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return {
      attemptId,
      path: logPath,
      payload
    };
  }

  return {
    attemptId,
    logPath,
    events,
    event,
    snapshot,
    writeFailure
  };
}

export function sanitizeDiagnosticValue(value, key = '') {
  if (isSensitiveName(key)) {
    return '<redacted>';
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return sanitizeDiagnosticString(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 40).map((item) => sanitizeDiagnosticValue(item));
  }

  if (typeof value === 'object') {
    const output = {};
    for (const [entryKey, entryValue] of Object.entries(value).slice(0, 80)) {
      output[entryKey] = sanitizeDiagnosticValue(entryValue, entryKey);
    }
    return output;
  }

  return sanitizeDiagnosticString(String(value));
}

function sanitizeDiagnosticString(value) {
  const text = String(value || '');
  if (/<\/?(html|body|form|input|script|style)\b/i.test(text)) {
    return '<html-redacted>';
  }

  let sanitized = text;
  if (/^https?:\/\//i.test(text)) {
    try {
      sanitized = sanitizeUrl(text);
    } catch {
      sanitized = text;
    }
  }

  sanitized = redactText(sanitized);
  return sanitized.length > 500 ? `${sanitized.slice(0, 500)}…` : sanitized;
}
