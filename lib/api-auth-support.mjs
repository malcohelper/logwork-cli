// Shared helpers for the API-only Keycloak login: safe errors, URL and origin
// checks, authorization-response URL readers and best-effort auth diagnostics.
import { redactText } from './auth-redaction.mjs';

export function assertSecureUrl(rawUrl, label) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw safeApiAuthError(`${label} must be a valid URL.`);
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw safeApiAuthError(`${label} must use HTTP or HTTPS.`);
  }

  if (url.protocol === 'http:' && !isLocalHttpHost(url.hostname)) {
    throw safeApiAuthError(`${label} must use HTTPS unless it points to localhost or loopback.`);
  }

  return url;
}

export function originFromUrl(rawUrl) {
  return assertSecureUrl(rawUrl, 'Origin URL').origin;
}

export function recordAuthEvent(recorder, name, details = {}) {
  try {
    recorder?.event?.(name, details);
  } catch {
    // Diagnostics must never break auth.
  }
}

export function safeUrlParts(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return {
      host: url.host,
      path: url.pathname
    };
  } catch {
    return {
      host: 'unknown-host',
      path: '/unknown-path'
    };
  }
}

export function readAuthorizationCode(rawUrl) {
  const url = new URL(rawUrl);
  return url.searchParams.get('code') || new URLSearchParams(url.hash.replace(/^#/, '')).get('code');
}

export function readAuthorizationState(rawUrl) {
  const url = new URL(rawUrl);
  return url.searchParams.get('state') || new URLSearchParams(url.hash.replace(/^#/, '')).get('state');
}

export function sameRedirectTarget(rawUrl, expectedRawUrl) {
  if (!expectedRawUrl) {
    return false;
  }

  try {
    const url = new URL(rawUrl);
    const expected = new URL(expectedRawUrl);
    return url.origin === expected.origin && url.pathname === expected.pathname;
  } catch {
    return false;
  }
}

function isLocalHttpHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.startsWith('127.');
}

export function stripHash(rawUrl) {
  const url = new URL(rawUrl);
  url.hash = '';
  return url.toString();
}

export function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw safeApiAuthError('Auth endpoint returned non-JSON response.');
  }
}

export function safeApiAuthError(message) {
  const error = new Error(redactText(message));
  error.code = 'API_AUTH_FAILED';
  return error;
}
