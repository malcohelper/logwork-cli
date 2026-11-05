import { CONFIG } from '../config.mjs';
import { authenticateWithApiSession, extractRoSession } from './api-auth.mjs';
import { createAuthRequiredError } from './auth-errors.mjs';
import { redactText } from './auth-redaction.mjs';
import { createCredentialEmailStorage, createCredentialTokenStorage } from './credential-store.mjs';
import { fetchWithPolicy } from './http.mjs';
import { safeJsonParse } from './util.mjs';

export function decodeJwt(token) {
  if (typeof token !== 'string') {
    throw new Error('JWT token is not a string.');
  }

  const parts = token.split('.');
  if (parts.length < 2) {
    throw new Error('Malformed JWT token.');
  }

  try {
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(payload);
  } catch (error) {
    throw new Error(`Unable to decode JWT payload: ${error.message}`);
  }
}

export function isJwtExpired(token, skewSeconds = 60) {
  try {
    const payload = decodeJwt(token);
    if (typeof payload.exp !== 'number') {
      return true;
    }

    const expiresAtMs = payload.exp * 1000;
    return expiresAtMs <= Date.now() + skewSeconds * 1000;
  } catch {
    return true;
  }
}

export function getUserIdFromJwt(token) {
  const payload = decodeJwt(token);
  const userId = payload.id ?? payload.user_id ?? payload.sub;

  if (userId === undefined || userId === null || String(userId).trim() === '') {
    throw new Error('Unable to find user id in JWT payload.');
  }

  return userId;
}

export function summarizeToken(token) {
  const payload = decodeJwt(token);
  return {
    userId: getUserIdFromJwt(token),
    email: payload.email || null,
    expiresAt: typeof payload.exp === 'number' ? new Date(payload.exp * 1000).toISOString() : null
  };
}

export async function getStoredAuthStatus({ storage = createCredentialTokenStorage() } = {}) {
  const session = normalizeStoredAuthSession(await storage.get());
  if (!session?.accessToken) {
    return {
      authenticated: false,
      expired: false,
      summary: 'Not authenticated. Run `logwork-helper auth login`.'
    };
  }

  if (isJwtExpired(session.accessToken)) {
    if (session.refreshToken) {
      return {
        authenticated: true,
        expired: true,
        refreshAvailable: true,
        summary: 'Stored Resource Optimiser access token is expired, but a refresh token is available. It will refresh automatically on the next request.'
      };
    }
    return {
      authenticated: false,
      expired: true,
      summary: 'Stored Resource Optimiser token is expired. Run `logwork-helper auth login`.'
    };
  }

  const details = summarizeToken(session.accessToken);
  return {
    authenticated: true,
    expired: false,
    refreshAvailable: Boolean(session.refreshToken),
    ...details,
    summary: `Authenticated as user ${details.userId}${details.email ? ` (${details.email})` : ''}. Token expires at ${details.expiresAt}.`
  };
}

export async function loginResourceOptimiser({
  credentialProvider,
  storage = createCredentialTokenStorage(),
  authenticator = authenticateWithApiSession
} = {}) {
  const session = normalizeAuthSession(await authenticator({ credentialProvider }));
  await validateAndStoreSession(session, storage);
  const details = summarizeToken(session.accessToken);
  return {
    ...details,
    summary: `Authenticated as user ${details.userId}${details.email ? ` (${details.email})` : ''}. Token expires at ${details.expiresAt}.`
  };
}

export async function logoutResourceOptimiser({
  storage = createCredentialTokenStorage(),
  emailStorage = createCredentialEmailStorage()
} = {}) {
  const deleted = await storage.delete();
  await emailStorage.delete().catch(() => {});
  return {
    deleted,
    summary: deleted ? 'Deleted stored Resource Optimiser token.' : 'No stored Resource Optimiser token found.'
  };
}

export async function getFreshToken({
  credentialProvider,
  forceLogin = false,
  interactive = true,
  storage = createCredentialTokenStorage(),
  authenticator = authenticateWithApiSession,
  refreshSession = refreshResourceOptimiserSession
} = {}) {
  if (!forceLogin) {
    const storedSession = normalizeStoredAuthSession(await storage.get());
    if (storedSession?.accessToken && !isJwtExpired(storedSession.accessToken)) {
      return storedSession.accessToken;
    }

    if (storedSession?.accessToken && storedSession.refreshToken) {
      try {
        const refreshed = normalizeAuthSession(await refreshSession({
          session: storedSession
        }));
        await validateAndStoreSession(refreshed, storage);
        return refreshed.accessToken;
      } catch {
        if (!interactive) {
          throw createAuthRequiredError();
        }
      }
    }
  }

  if (!interactive) {
    throw createAuthRequiredError();
  }

  const session = normalizeAuthSession(await authenticator({ credentialProvider }));
  await validateAndStoreSession(session, storage);
  return session.accessToken;
}

export async function refreshResourceOptimiserSession({
  session,
  apiBase = CONFIG.apiBase,
  refreshTokenPath = CONFIG.refreshTokenPath,
  fetchImpl = fetch,
  timeoutMs = CONFIG.httpTimeoutMs
} = {}) {
  if (!session?.accessToken || !session.refreshToken) {
    throw new Error('No refresh token is available.');
  }

  assertSecureUrl(apiBase, 'Resource Optimiser API endpoint');
  const browserOrigin = originFromUrl(CONFIG.loginUrl);
  const response = await fetchWithPolicy(`${apiBase}${refreshTokenPath}`, {
    fetchImpl,
    timeoutMs,
    retries: 0,
    idempotent: false,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      Origin: browserOrigin,
      Referer: `${browserOrigin}/`
    },
    body: JSON.stringify({
      refreshToken: session.refreshToken
    })
  });
  const text = await response.text();
  const data = text ? safeJsonParse(text, text) : null;

  if (!response.ok) {
    throw new Error(redactText(`Resource Optimiser refresh-token failed with HTTP ${response.status}.`));
  }

  const refreshed = extractRoSession(data, response.headers);
  if (!refreshed?.accessToken) {
    throw new Error(redactText(`Resource Optimiser refresh-token did not return a usable API token. Status: ${response.status}. JSON keys: ${collectJsonKeyPaths(data).join(', ') || '(none)'}`));
  }

  return {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken || session.refreshToken
  };
}

function assertSecureUrl(rawUrl, label) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${label} must use HTTP or HTTPS.`);
  }

  if (url.protocol === 'http:' && !isLocalHttpHost(url.hostname)) {
    throw new Error(`${label} must use HTTPS unless it points to localhost or loopback.`);
  }

  return url;
}

function originFromUrl(rawUrl) {
  return assertSecureUrl(rawUrl, 'Origin URL').origin;
}

function isLocalHttpHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.startsWith('127.');
}

export function normalizeStoredAuthSession(rawValue) {
  if (!rawValue) {
    return null;
  }

  const value = String(rawValue).trim();
  if (!value) {
    return null;
  }

  try {
    return normalizeAuthSession(JSON.parse(value));
  } catch {
    if (value.split('.').length >= 3) {
      return {
        accessToken: value,
        refreshToken: null,
        legacy: true
      };
    }
    return null;
  }
}

export function normalizeAuthSession(value) {
  if (typeof value === 'string') {
    return {
      accessToken: value,
      refreshToken: null
    };
  }

  if (!value || typeof value !== 'object') {
    return {
      accessToken: null,
      refreshToken: null
    };
  }

  return {
    accessToken: value.accessToken || value.token || null,
    refreshToken: value.refreshToken || value.refresh_token || null
  };
}

export function serializeAuthSession(session) {
  return JSON.stringify({
    accessToken: session.accessToken,
    refreshToken: session.refreshToken || null
  });
}

async function validateAndStoreSession(session, storage) {
  if (!session?.accessToken || isJwtExpired(session.accessToken)) {
    throw new Error('Resource Optimiser auth did not return a valid API token.');
  }

  getUserIdFromJwt(session.accessToken);
  await storage.set(serializeAuthSession(session));
}

function collectJsonKeyPaths(value, path = '', seen = new Set(), output = []) {
  if (!value || typeof value !== 'object' || seen.has(value)) {
    return output;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    value.slice(0, 5).forEach((item, index) => {
      collectJsonKeyPaths(item, `${path}[${index}]`, seen, output);
    });
    return output;
  }

  for (const key of Object.keys(value)) {
    const nextPath = path ? `${path}.${key}` : key;
    output.push(nextPath);
    if (output.length >= 40) {
      return output;
    }
    collectJsonKeyPaths(value[key], nextPath, seen, output);
  }
  return output;
}
