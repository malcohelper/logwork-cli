// Token extraction from Resource Optimiser and Keycloak responses: picks the RO
// JWT (not the Keycloak one) and lists JSON key paths for sanitized diagnostics.

export function extractRoToken(data, headers) {
  return extractRoSession(data, headers)?.accessToken || null;
}

export function extractRoSession(data, headers) {
  const accessToken = extractRoAccessToken(data, headers);
  if (!accessToken) {
    return null;
  }
  return {
    accessToken,
    refreshToken: extractRoRefreshToken(data)
  };
}

function extractRoAccessToken(data, headers) {
  const candidates = [
    readBearerHeader(headers),
    ...collectJwtCandidatesByKey(data, isAccessTokenKey)
  ].filter(Boolean);
  return candidates.find(isResourceOptimiserJwt) || null;
}

function extractRoRefreshToken(data) {
  const candidates = collectJwtCandidatesByKey(data, isRefreshTokenKey).filter(Boolean);
  return candidates.find(isResourceOptimiserJwt) || null;
}

function readBearerHeader(headers) {
  const value = headers?.get?.('authorization') || headers?.get?.('Authorization') || '';
  const match = String(value).match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function collectJwtCandidatesByKey(value, keyMatcher, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) {
    return [];
  }
  seen.add(value);

  const candidates = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      candidates.push(...collectJwtCandidatesByKey(item, keyMatcher, seen));
    }
    return candidates;
  }

  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && keyMatcher(key) && item.split('.').length >= 3) {
      candidates.push(item);
    }
    candidates.push(...collectJwtCandidatesByKey(item, keyMatcher, seen));
  }
  return candidates;
}

function isAccessTokenKey(key) {
  return /^(access[_-]?token|token|jwt)$/i.test(String(key || ''));
}

function isRefreshTokenKey(key) {
  return /^refresh[_-]?token$/i.test(String(key || ''));
}

export function collectJsonKeyPaths(value, path = '', seen = new Set(), output = []) {
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

function isResourceOptimiserJwt(token) {
  const payload = decodeJwtPayload(token);
  if (!payload) {
    return false;
  }
  if (isKeycloakJwtPayload(payload)) {
    return false;
  }
  return Boolean(
    payload.id !== undefined
      || typeof payload.email === 'string'
      || typeof payload.db_url === 'string'
      || typeof payload.dbUrl === 'string'
      || typeof payload.user_id === 'number'
      || typeof payload.userId === 'number'
  );
}

function isKeycloakJwtPayload(payload) {
  const issuer = String(payload.iss || '').toLowerCase();
  return issuer.includes('keycloak')
    || payload.azp === 'localhost'
    || payload.realm_access !== undefined
    || payload.resource_access !== undefined;
}

export function decodeJwtPayload(token) {
  const [, payload] = String(token || '').split('.');
  if (!payload) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
