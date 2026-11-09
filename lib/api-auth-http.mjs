// Cookie-carrying HTTP session for the Keycloak login. Redirects are followed by
// hand so every hop is checked against the allowed origins and the code callback.
import { CONFIG } from './config.mjs';
import { fetchWithPolicy } from './http.mjs';
import {
  assertSecureUrl,
  readAuthorizationCode,
  safeApiAuthError,
  sameRedirectTarget,
  stripHash
} from './api-auth-support.mjs';

export function createHttpSession({
  fetchImpl = fetch,
  allowedHosts = [],
  allowedOrigins = [],
  authorizationRedirectUri = null
} = {}) {
  const jar = new CookieJar();

  return {
    jar,
    async request(url, options = {}) {
      return requestWithRedirects({
        fetchImpl,
        jar,
        url,
        options,
        allowedHosts,
        allowedOrigins,
        authorizationRedirectUri
      });
    }
  };
}

export async function requestWithRedirects({
  fetchImpl,
  jar,
  url,
  options = {},
  maxRedirects = 10,
  allowedHosts = [],
  allowedOrigins = [],
  authorizationRedirectUri = null,
  timeoutMs = CONFIG.httpTimeoutMs,
  retryDelayMs = CONFIG.httpRetryDelayMs,
  retries = CONFIG.httpReadRetries
}) {
  let currentUrl = new URL(url).toString();
  let method = options.method || 'GET';
  let body = options.body;
  const headers = new Headers(options.headers || {});
  const allowedHostSet = new Set(allowedHosts.filter(Boolean).map((host) => String(host).toLowerCase()));
  const allowedOriginSet = new Set(allowedOrigins.filter(Boolean).map((origin) => String(origin).toLowerCase()));

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    assertSecureUrl(currentUrl, 'Auth request');
    const cookie = jar.header(currentUrl);
    if (cookie) {
      headers.set('Cookie', cookie);
    }
    const response = await fetchWithPolicy(currentUrl, {
      ...options,
      fetchImpl,
      timeoutMs,
      retryDelayMs,
      retries,
      idempotent: isIdempotentMethod(method),
      method,
      body,
      headers,
      redirect: 'manual'
    });
    jar.store(currentUrl, response.headers);

    if (isRedirect(response.status)) {
      const location = response.headers.get('location');
      if (!location) {
        throw safeApiAuthError('Redirect response did not include a location header.');
      }
      const nextUrl = new URL(location, currentUrl).toString();
      assertAllowedRedirect(nextUrl, {
        allowedHosts: allowedHostSet,
        allowedOrigins: allowedOriginSet,
        authorizationRedirectUri
      });
      const redirectCode = readAuthorizationCode(nextUrl);
      if (redirectCode) {
        return {
          url: nextUrl,
          status: response.status,
          headers: response.headers,
          body: '',
          redirectCode,
          redirectUri: stripHash(nextUrl)
        };
      }
      currentUrl = nextUrl;
      method = 'GET';
      body = undefined;
      headers.delete('Content-Type');
      continue;
    }

    const text = await response.text();
    if (!response.ok) {
      throw safeApiAuthError(`API auth request failed with HTTP ${response.status}.`);
    }
    return {
      url: currentUrl,
      status: response.status,
      headers: response.headers,
      body: text
    };
  }

  throw safeApiAuthError('Too many redirects during API auth.');
}

function assertAllowedRedirect(rawUrl, { allowedHosts, allowedOrigins, authorizationRedirectUri }) {
  const url = assertSecureUrl(rawUrl, 'Auth redirect');
  const origin = url.origin.toLowerCase();
  const host = url.host.toLowerCase();
  const originAllowed = allowedOrigins?.size
    ? allowedOrigins.has(origin)
    : allowedHosts.has(host);
  if (!originAllowed) {
    throw safeApiAuthError(`Blocked auth redirect to unexpected origin: ${url.origin || 'unknown-origin'}.`);
  }

  if (readAuthorizationCode(rawUrl) && !sameRedirectTarget(rawUrl, authorizationRedirectUri)) {
    throw safeApiAuthError('Blocked authorization code redirect to unexpected Resource Optimiser callback.');
  }
}

function isRedirect(status) {
  return [301, 302, 303, 307, 308].includes(status);
}

function isIdempotentMethod(method) {
  return ['GET', 'HEAD', 'OPTIONS'].includes(String(method || 'GET').toUpperCase());
}

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  store(rawUrl, headers) {
    const url = new URL(rawUrl);
    const values = getSetCookieValues(headers);
    for (const value of values) {
      const [pair] = value.split(';');
      const [name, cookieValue] = pair.split('=');
      if (name && cookieValue !== undefined) {
        this.cookies.set(`${url.hostname}:${name.trim()}`, `${name.trim()}=${cookieValue.trim()}`);
      }
    }
  }

  header(rawUrl) {
    const url = new URL(rawUrl);
    return [...this.cookies.entries()]
      .filter(([key]) => key.startsWith(`${url.hostname}:`))
      .map(([, value]) => value)
      .join('; ');
  }
}

function getSetCookieValues(headers) {
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }
  const value = headers.get?.('set-cookie');
  return value ? splitSetCookie(value) : [];
}

function splitSetCookie(value) {
  return String(value)
    .split(/,(?=\s*[^;,\s]+=)/)
    .map((item) => item.trim())
    .filter(Boolean);
}
