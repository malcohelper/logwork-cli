export const SENSITIVE_FIELD_NAMES = new Set([
  'access_token',
  'accesstoken',
  'authorization',
  'auth_session_id',
  'auth_session_id_legacy',
  'code',
  'cookie',
  'credential',
  'credentialid',
  'execution',
  'kc_restart',
  'nonce',
  'otp',
  'password',
  'refresh_token',
  'session_code',
  'state',
  'tab_id',
  'token'
]);

export function sanitizeUrl(rawUrl) {
  const url = new URL(rawUrl);
  for (const key of [...url.searchParams.keys()]) {
    if (isSensitiveName(key)) {
      url.searchParams.set(key, '<redacted>');
    } else {
      url.searchParams.set(key, '<value>');
    }
  }
  url.hash = url.hash ? '#<redacted>' : '';
  return url.toString();
}

export function sanitizeHeaders(headers = {}) {
  const sanitized = {};
  for (const [key, value] of Object.entries(headers)) {
    sanitized[key] = isSensitiveName(key) ? '<redacted>' : String(value);
  }
  return sanitized;
}

export function sanitizeFormBody(body = '') {
  const params = new URLSearchParams(String(body || ''));
  return [...params.keys()].map((name) => ({
    name,
    redacted: isSensitiveName(name)
  }));
}

export function sanitizeJsonKeys(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }
  return Object.keys(value).map((name) => ({
    name,
    redacted: isSensitiveName(name)
  }));
}

export function isSensitiveName(name) {
  const normalized = String(name || '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
  if (SENSITIVE_FIELD_NAMES.has(normalized)) {
    return true;
  }
  return /token|password|cookie|authorization|session|nonce|state|code|otp|credential/i.test(String(name || ''));
}

export function redactText(value) {
  let text = String(value || '');
  text = text.replace(/(password|otp|code|accessToken|access_token|token|session_code|state|nonce|tab_id)=([^&\s]+)/gi, '$1=<redacted>');
  text = text.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer <redacted>');
  text = text.replace(/eyJ[A-Za-z0-9._-]+/g, '<jwt-redacted>');
  return text;
}
