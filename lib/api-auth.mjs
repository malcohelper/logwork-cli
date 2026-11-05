import { randomUUID } from 'node:crypto';
import { CONFIG } from '../config.mjs';
import { createTerminalCredentialProvider } from './terminal-auth-prompts.mjs';
import { redactText } from './auth-redaction.mjs';
import { fetchWithPolicy } from './http.mjs';

export async function authenticateWithApi({
  ...options
} = {}) {
  const session = await authenticateWithApiSession(options);
  return session.accessToken;
}

export async function authenticateWithApiSession({
  apiBase = CONFIG.apiBase,
  keycloakAuthUrl = CONFIG.keycloakAuthUrl,
  keycloakTokenUrl = CONFIG.keycloakTokenUrl,
  keycloakClientId = CONFIG.keycloakClientId,
  keycloakRedirectUri = CONFIG.keycloakRedirectUri,
  keycloakScope = CONFIG.keycloakScope,
  keycloakResponseMode = CONFIG.keycloakResponseMode,
  keycloakResponseType = CONFIG.keycloakResponseType,
  keycloakState = randomUUID(),
  keycloakNonce = randomUUID(),
  signinKeycloakPath = CONFIG.signinKeycloakPath,
  maxApiAuthSteps = CONFIG.maxApiAuthSteps,
  credentialProvider = createTerminalCredentialProvider(),
  fetchImpl = fetch,
  diagnosticsRecorder = null
} = {}) {
  const protocolContext = createAuthProtocolContext({
    apiBase,
    keycloakAuthUrl,
    keycloakTokenUrl,
    keycloakRedirectUri
  });
  const session = createHttpSession({
    fetchImpl,
    allowedOrigins: protocolContext.allowedOrigins,
    authorizationRedirectUri: keycloakRedirectUri
  });
  const authUrl = buildKeycloakAuthorizeUrl({
    keycloakAuthUrl,
    clientId: keycloakClientId,
    redirectUri: keycloakRedirectUri,
    scope: keycloakScope,
    responseMode: keycloakResponseMode,
    responseType: keycloakResponseType,
    state: keycloakState,
    nonce: keycloakNonce
  });
  recordAuthEvent(diagnosticsRecorder, 'authorize_request', {
    ...pageDiagnostics({
      url: authUrl,
      status: 'pending',
      body: ''
    })
  });
  const loginPage = await session.request(authUrl);
  recordAuthEvent(diagnosticsRecorder, 'authorize_response', pageDiagnostics(loginPage));

  let current = loginPage;
  const authContext = readAuthContext(authUrl);
  let apiAuthSteps = 0;
  while (!current.redirectCode) {
    if (apiAuthSteps >= maxApiAuthSteps) {
      throw safeApiAuthError(formatStepLimitDiagnostics(current, maxApiAuthSteps));
    }
    apiAuthSteps += 1;

    const form = selectNextKeycloakForm(current.body, current.url, {
      preferDevice: false
    });
    if (!form) {
      throw safeApiAuthError(formatMissingFormDiagnostics(current));
    }
    assertAllowedFormAction(form, protocolContext);

    recordAuthEvent(diagnosticsRecorder, 'keycloak_form_detected', {
      step: apiAuthSteps,
      kind: form.kind,
      deviceOptions: form.devices.length,
      ...pageDiagnostics(current)
    });

    if (form.kind === 'password-update') {
      if (typeof credentialProvider.requestPasswordUpdate !== 'function') {
        throw safeApiAuthError(
          'Keycloak requires a password update. Re-run `logwork-helper auth login` in an interactive terminal.'
        );
      }
      const passwords = await credentialProvider.requestPasswordUpdate();
      current = await submitPasswordUpdateForm(session, form, passwords);
      recordAuthEvent(diagnosticsRecorder, 'password_update_submit_result', pageDiagnostics(current));
      continue;
    }

    if (form.kind === 'credentials') {
      const credentials = await credentialProvider.requestCredentials();
      current = await submitCredentialsForm(session, form, credentials);
      recordAuthEvent(diagnosticsRecorder, 'credentials_submit_result', pageDiagnostics(current));
      continue;
    }

    if (form.kind === 'device') {
      const selectedDevice = await credentialProvider.requestDeviceSelection(form.devices);
      if (!selectedDevice) {
        throw safeApiAuthError('Keycloak requires device selection, but no device option was found.');
      }
      current = await submitDeviceForm(session, form, selectedDevice);
      recordAuthEvent(diagnosticsRecorder, 'device_submit_result', pageDiagnostics(current));
      continue;
    }

    if (form.kind === 'otp') {
      let selectedDevice = null;
      if (form.devices.length > 0) {
        selectedDevice = form.devices.length === 1
          ? form.devices[0]
          : await credentialProvider.requestDeviceSelection(form.devices);
      }
      const otp = await credentialProvider.requestOtp();
      current = await submitOtpForm(session, form, otp, selectedDevice);
      recordAuthEvent(diagnosticsRecorder, 'otp_submit_result', {
        otpFormHasDevices: form.devices.length > 0,
        selectedDeviceSubmitted: Boolean(selectedDevice),
        ...pageDiagnostics(current)
      });
      if (!current.redirectCode) {
        const nextForm = selectNextKeycloakForm(current.body, current.url, {
          preferDevice: false
        });
        if (nextForm?.kind === 'otp') {
          recordAuthEvent(diagnosticsRecorder, 'otp_reprompt', {
            otpFormHasDevices: form.devices.length > 0,
            selectedDeviceSubmitted: Boolean(selectedDevice),
            ...pageDiagnostics(current)
          });
        }
      }
      continue;
    }
  }

  const code = current.redirectCode;
  const redirectUri = authContext.redirectUri || current.redirectUri;
  if (!code || !redirectUri) {
    throw safeApiAuthError('Keycloak did not return an authorization code and redirect URI.');
  }
  assertExpectedAuthorizationRedirect(current, {
    expectedRedirectUri: authContext.redirectUri,
    expectedState: authContext.state
  });

  recordAuthEvent(diagnosticsRecorder, 'authorization_code_received', {
    ...pageDiagnostics(current),
    redirectUri
  });
  const keycloakToken = await exchangeAuthorizationCode(session, {
    keycloakTokenUrl,
    code,
    clientId: authContext.clientId || 'localhost',
    redirectUri,
    expectedNonce: authContext.nonce,
    expectedKeycloakOrigin: protocolContext.keycloakOrigin,
    browserOrigin: protocolContext.redirectOrigin,
    diagnosticsRecorder
  });
  const finalToken = await exchangeSigninKeycloakSession(session, {
    apiBase,
    signinKeycloakPath,
    accessToken: keycloakToken,
    browserOrigin: protocolContext.redirectOrigin,
    diagnosticsRecorder
  });

  return finalToken;
}

export function buildKeycloakAuthorizeUrl({
  keycloakAuthUrl = CONFIG.keycloakAuthUrl,
  clientId = CONFIG.keycloakClientId,
  redirectUri = CONFIG.keycloakRedirectUri,
  scope = CONFIG.keycloakScope,
  responseMode = CONFIG.keycloakResponseMode,
  responseType = CONFIG.keycloakResponseType,
  state = randomUUID(),
  nonce = randomUUID()
} = {}) {
  const url = new URL(keycloakAuthUrl);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('response_mode', responseMode);
  url.searchParams.set('response_type', responseType);
  url.searchParams.set('scope', scope);
  url.searchParams.set('nonce', nonce);
  return url.toString();
}

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

export function findKeycloakAuthUrl(html, baseUrl) {
  const matches = String(html || '').match(/https:\/\/keycloak\.vinova\.sg\/auth\/realms\/resource\/protocol\/openid-connect\/auth[^"' <]+/i);
  if (matches?.[0]) {
    return decodeHtml(matches[0]);
  }

  const href = findAttributeValue(html, 'href', /keycloak\.vinova\.sg\/auth\/realms\/resource\/protocol\/openid-connect\/auth/i);
  if (href) {
    return new URL(decodeHtml(href), baseUrl).toString();
  }

  return null;
}

export function selectNextKeycloakForm(html, baseUrl, { preferDevice = false } = {}) {
  const forms = parseHtmlForms(html, baseUrl);
  const passwordUpdate = forms.find((form) => form.kind === 'password-update');
  const credentials = forms.find((form) => form.kind === 'credentials');
  const otp = forms.find((form) => form.kind === 'otp');
  const device = forms.find((form) => form.kind === 'device' || form.devices.length > 0);

  if (passwordUpdate) {
    return passwordUpdate;
  }
  if (credentials) {
    return credentials;
  }
  if (otp) {
    return otp;
  }
  if (preferDevice && device) {
    return {
      ...device,
      kind: 'device'
    };
  }
  if (device) {
    return device;
  }

  return forms.find((form) => form.kind === 'credentials')
    || null;
}

export function parseHtmlForms(html, baseUrl) {
  const forms = [];
  const source = String(html || '');
  const regex = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let match;
  while ((match = regex.exec(source))) {
    const attrs = match[1];
    const inner = match[2];
    const action = resolveActionUrl(decodeHtml(readAttr(attrs, 'action') || ''), baseUrl);
    const method = (readAttr(attrs, 'method') || 'GET').toUpperCase();
    const fields = readInputFields(inner);
    const devices = readDeviceOptions(inner);
    const kind = classifyForm(fields, devices);
    forms.push({ action, method, fields, devices, kind });
  }
  return forms;
}

export async function submitCredentialsForm(session, form, { email, password }) {
  const body = bodyFromForm(form);
  body.set(usernameFieldName(form) || 'username', email);
  body.set(passwordFieldName(form) || 'password', password);
  return postForm(session, form.action, body);
}

export async function submitPasswordUpdateForm(session, form, {
  newPassword,
  confirmPassword
}) {
  const fieldNames = passwordUpdateFieldNames(form);
  if (!fieldNames) {
    throw safeApiAuthError('Keycloak password update form did not contain the expected password fields.');
  }
  if (!newPassword || newPassword !== confirmPassword) {
    throw safeApiAuthError('New Resource Optimiser passwords must be non-empty and match.');
  }

  const body = bodyFromForm(form);
  body.set(fieldNames.newPassword, newPassword);
  body.set(fieldNames.confirmPassword, confirmPassword);
  return postForm(session, form.action, body);
}

export async function submitDeviceForm(session, form, device) {
  const body = bodyFromForm(form);
  body.set(device.name, device.value);
  return postForm(session, form.action, body);
}

export async function submitOtpForm(session, form, otp, selectedDevice = null) {
  const body = bodyFromForm(form);
  if (selectedDevice?.name && selectedDevice.value !== undefined) {
    body.set(selectedDevice.name, selectedDevice.value);
  }
  body.set(otpFieldName(form) || 'otp', otp);
  return postForm(session, form.action, body);
}

export async function exchangeAuthorizationCode(session, {
  keycloakTokenUrl,
  code,
  clientId,
  redirectUri,
  expectedNonce = null,
  expectedKeycloakOrigin = null,
  browserOrigin = originFromUrl(redirectUri),
  diagnosticsRecorder = null
}) {
  assertExpectedOrigin(keycloakTokenUrl, expectedKeycloakOrigin, 'Keycloak token endpoint');
  assertSecureUrl(keycloakTokenUrl, 'Keycloak token endpoint');
  const body = new URLSearchParams({
    code,
    grant_type: 'authorization_code',
    client_id: clientId,
    redirect_uri: redirectUri
  });
  const response = await session.request(keycloakTokenUrl, {
    method: 'POST',
    headers: {
      Accept: '*/*',
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: browserOrigin,
      Referer: `${browserOrigin}/`
    },
    body
  });
  let data;
  try {
    data = safeJson(response.body);
  } catch (error) {
    recordAuthEvent(diagnosticsRecorder, 'keycloak_token_response', {
      status: response.status || 'unknown',
      jsonKeys: [],
      error: error.message
    });
    throw error;
  }
  recordAuthEvent(diagnosticsRecorder, 'keycloak_token_response', {
    status: response.status || 'unknown',
    jsonKeys: collectJsonKeyPaths(data)
  });
  const token = data.access_token || data.accessToken;
  if (!token) {
    throw safeApiAuthError('Keycloak token endpoint did not return an access token.');
  }
  assertExpectedTokenNonce(token, expectedNonce);
  return token;
}

export async function exchangeSigninKeycloak(session, {
  ...options
}) {
  const finalSession = await exchangeSigninKeycloakSession(session, options);
  return finalSession.accessToken;
}

export async function exchangeSigninKeycloakSession(session, {
  apiBase,
  signinKeycloakPath,
  accessToken,
  browserOrigin = 'https://app.resourceoptimiser.com',
  diagnosticsRecorder = null
}) {
  assertSecureUrl(apiBase, 'Resource Optimiser API endpoint');
  const response = await session.request(`${apiBase}${signinKeycloakPath}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      Origin: browserOrigin,
      Referer: `${browserOrigin}/`
    },
    body: JSON.stringify({ accessToken })
  });
  let data;
  try {
    data = safeJson(response.body);
  } catch (error) {
    recordAuthEvent(diagnosticsRecorder, 'signin_keycloak_response', {
      status: response.status || 'unknown',
      jsonKeys: [],
      error: error.message
    });
    throw error;
  }
  recordAuthEvent(diagnosticsRecorder, 'signin_keycloak_response', {
    status: response.status || 'unknown',
    jsonKeys: collectJsonKeyPaths(data)
  });
  const finalSession = extractRoSession(data, response.headers);
  if (!finalSession?.accessToken) {
    throw safeApiAuthError(formatSigninKeycloakDiagnostics(response, data));
  }
  return finalSession;
}

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

export function readAuthContext(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return {};
  }
  return {
    clientId: url.searchParams.get('client_id'),
    redirectUri: url.searchParams.get('redirect_uri'),
    state: url.searchParams.get('state'),
    nonce: url.searchParams.get('nonce')
  };
}

function createAuthProtocolContext({
  apiBase,
  keycloakAuthUrl,
  keycloakTokenUrl,
  keycloakRedirectUri
}) {
  const apiBaseUrl = assertSecureUrl(apiBase, 'Resource Optimiser API endpoint');
  const keycloakAuth = assertSecureUrl(keycloakAuthUrl, 'Keycloak auth endpoint');
  const keycloakToken = assertSecureUrl(keycloakTokenUrl, 'Keycloak token endpoint');
  const redirectUri = assertSecureUrl(keycloakRedirectUri, 'Resource Optimiser redirect URI');
  if (keycloakAuth.origin !== keycloakToken.origin) {
    throw safeApiAuthError('Keycloak token endpoint origin did not match the authorization endpoint origin.');
  }

  return {
    allowedOrigins: [
      apiBaseUrl.origin,
      keycloakAuth.origin,
      keycloakToken.origin,
      redirectUri.origin
    ],
    keycloakOrigin: keycloakAuth.origin,
    redirectOrigin: redirectUri.origin,
    redirectUri: keycloakRedirectUri
  };
}

function assertAllowedFormAction(form, context) {
  const actionUrl = assertSecureUrl(form.action, 'Keycloak form action');
  if (actionUrl.origin !== context.keycloakOrigin) {
    throw safeApiAuthError(`Blocked Keycloak form submission to unexpected origin: ${actionUrl.origin || 'unknown-origin'}.`);
  }
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

function assertExpectedAuthorizationRedirect(response, {
  expectedRedirectUri,
  expectedState
}) {
  if (!sameRedirectTarget(response.url, expectedRedirectUri)) {
    throw safeApiAuthError('Authorization code redirect URI did not match the requested callback.');
  }

  const state = readAuthorizationState(response.url);
  if (!expectedState || state !== expectedState) {
    throw safeApiAuthError('Authorization response state did not match the requested state.');
  }
}

function assertExpectedTokenNonce(token, expectedNonce) {
  if (!expectedNonce) {
    return;
  }

  const payload = decodeJwtPayload(token);
  if (!payload || payload.nonce === undefined || payload.nonce === null) {
    return;
  }

  if (String(payload.nonce) !== String(expectedNonce)) {
    throw safeApiAuthError('Keycloak token nonce did not match the requested nonce.');
  }
}

function assertExpectedOrigin(rawUrl, expectedOrigin, label) {
  if (!expectedOrigin) {
    return;
  }

  const url = assertSecureUrl(rawUrl, label);
  if (url.origin !== expectedOrigin) {
    throw safeApiAuthError(`${label} origin did not match the expected authorization origin.`);
  }
}

function assertSecureUrl(rawUrl, label) {
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

function originFromUrl(rawUrl) {
  return assertSecureUrl(rawUrl, 'Origin URL').origin;
}

function postForm(session, action, body) {
  return session.request(action, {
    method: 'POST',
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });
}

function recordAuthEvent(recorder, name, details = {}) {
  try {
    recorder?.event?.(name, details);
  } catch {
    // Diagnostics must never break auth.
  }
}

function pageDiagnostics(response = {}) {
  const url = safeUrlParts(response.url);
  const forms = parseHtmlForms(response.body, response.url);
  const kinds = forms.map((form) => form.kind).filter(Boolean);
  const title = readTitle(response.body);
  const bodyHint = readBodyHint(response.body);
  return {
    host: url.host,
    path: url.path,
    status: response.status || 'unknown',
    forms: forms.length,
    formKinds: kinds,
    title: title || undefined,
    hint: bodyHint || undefined,
    redirectCodeReceived: Boolean(response.redirectCode)
  };
}

function formatMissingFormDiagnostics(response) {
  const url = safeUrlParts(response.url);
  const forms = parseHtmlForms(response.body, response.url);
  const kinds = forms.map((form) => form.kind).filter(Boolean);
  const formSummary = summarizeFormShapes(forms);
  const title = readTitle(response.body);
  const bodyHint = readBodyHint(response.body);
  return [
    'Unable to find a supported Keycloak login, password update, device, or 2FA form.',
    `Current page: ${url.host}${url.path}`,
    `Status: ${response.status || 'unknown'}`,
    `Forms: ${forms.length}${kinds.length ? ` (${kinds.join(', ')})` : ''}`,
    formSummary ? `Fields: ${formSummary}` : null,
    title ? `Title: ${title}` : null,
    bodyHint ? `Hint: ${bodyHint}` : null,
    'Retry with `logwork-helper auth login`. If this keeps failing, inspect sanitized JSON key diagnostics and Keycloak form shape.'
  ].filter(Boolean).join(' ');
}

function formatStepLimitDiagnostics(response, maxApiAuthSteps) {
  const url = safeUrlParts(response.url);
  const forms = parseHtmlForms(response.body, response.url);
  const kinds = forms.map((form) => form.kind).filter(Boolean);
  const formSummary = summarizeFormShapes(forms);
  return [
    `API-only auth stopped after ${maxApiAuthSteps} Keycloak form steps to avoid an infinite loop.`,
    `Current page: ${url.host}${url.path}`,
    `Status: ${response.status || 'unknown'}`,
    `Forms: ${forms.length}${kinds.length ? ` (${kinds.join(', ')})` : ''}`,
    formSummary ? `Fields: ${formSummary}` : null,
    'Retry with `logwork-helper auth login`. If this keeps failing, inspect sanitized diagnostics and Keycloak form shape.'
  ].filter(Boolean).join(' ');
}

function formatSigninKeycloakDiagnostics(response, data) {
  const keys = collectJsonKeyPaths(data);
  return [
    'Resource Optimiser signinKeyCloak did not return a usable API token.',
    `Status: ${response.status || 'unknown'}`,
    `JSON keys: ${keys.length ? keys.join(', ') : '(none)'}`,
    'Retry with `logwork-helper auth login`. If this keeps failing, inspect sanitized JSON key diagnostics from the error.'
  ].join(' ');
}

function safeUrlParts(rawUrl) {
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

function readTitle(html) {
  const match = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripTags(decodeHtml(match[1])).slice(0, 120) : null;
}

function readBodyHint(html) {
  const bodyMatch = String(html || '').match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = String(bodyMatch ? bodyMatch[1] : html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  const hint = stripTags(decodeHtml(body)).slice(0, 160);
  return hint || null;
}

function resolveActionUrl(action, baseUrl) {
  if (!action) {
    return baseUrl ? new URL(baseUrl).toString() : '';
  }
  if (!baseUrl) {
    return action;
  }
  return new URL(action, baseUrl).toString();
}

function bodyFromForm(form) {
  const body = new URLSearchParams();
  for (const field of form.fields) {
    if (field.name && field.value !== undefined) {
      body.set(field.name, field.value);
    }
  }
  return body;
}

function readBearerHeader(headers) {
  const value = headers?.get?.('authorization') || headers?.get?.('Authorization') || '';
  const match = String(value).match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function collectJwtCandidates(value, seen = new Set()) {
  if (typeof value === 'string') {
    return value.split('.').length >= 3 ? [value] : [];
  }
  if (!value || typeof value !== 'object' || seen.has(value)) {
    return [];
  }
  seen.add(value);

  const candidates = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      candidates.push(...collectJwtCandidates(item, seen));
    }
    return candidates;
  }

  for (const item of Object.values(value)) {
    candidates.push(...collectJwtCandidates(item, seen));
  }
  return candidates;
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

function decodeJwtPayload(token) {
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

function classifyForm(fields, devices) {
  if (passwordUpdateFieldNames({ fields })) {
    return 'password-update';
  }
  if (passwordFieldName({ fields })) {
    return 'credentials';
  }
  if (otpFieldName({ fields })) {
    return 'otp';
  }
  if (devices.length > 0) {
    return 'device';
  }
  return 'unknown';
}

function readInputFields(html) {
  const fields = [];
  const regex = /<input\b([^>]*)>/gi;
  let match;
  while ((match = regex.exec(String(html || '')))) {
    const attrs = match[1];
    fields.push({
      name: decodeHtml(readAttr(attrs, 'name') || ''),
      id: decodeHtml(readAttr(attrs, 'id') || ''),
      type: decodeHtml(readAttr(attrs, 'type') || 'text'),
      value: decodeHtml(readAttr(attrs, 'value') || ''),
      autocomplete: decodeHtml(readAttr(attrs, 'autocomplete') || ''),
      inputmode: decodeHtml(readAttr(attrs, 'inputmode') || ''),
      placeholder: decodeHtml(readAttr(attrs, 'placeholder') || ''),
      ariaLabel: decodeHtml(readAttr(attrs, 'aria-label') || '')
    });
  }
  return fields.filter((field) => field.name);
}

function otpFieldName(form) {
  return form.fields.find(isOtpInputField)?.name;
}

function usernameFieldName(form) {
  return fieldName(form, ['username', 'email', 'login', 'user', 'userid', 'user_id']) ||
    form.fields.find((field) => isTextInputField(field) && fieldHint(field, /user|email|login|account|identifier/))?.name ||
    form.fields.find((field) => isTextInputField(field) && !isOtpInputField(field))?.name;
}

function passwordFieldName(form) {
  return fieldName(form, ['password', 'passwd', 'pass', 'pwd']) ||
    form.fields.find((field) => String(field.type || '').toLowerCase() === 'password')?.name;
}

function passwordUpdateFieldNames(form) {
  const passwordFields = form.fields.filter(
    (field) => String(field.type || '').toLowerCase() === 'password'
  );
  if (passwordFields.length < 2) {
    return null;
  }

  const newPassword = fieldName(form, [
    'password-new',
    'new-password',
    'newPassword',
    'passwordNew'
  ]) || passwordFields.find((field) => fieldHint(field, /(?:new.*password|password.*new)/i))?.name;
  const confirmPassword = fieldName(form, [
    'password-confirm',
    'confirm-password',
    'confirmPassword',
    'passwordConfirm',
    'password-repeat',
    'repeat-password'
  ]) || passwordFields.find((field) => fieldHint(field, /confirm|repeat/i))?.name;

  if (newPassword && confirmPassword && newPassword !== confirmPassword) {
    return { newPassword, confirmPassword };
  }

  return {
    newPassword: passwordFields[0].name,
    confirmPassword: passwordFields[1].name
  };
}

function fieldName(form, candidates) {
  const lower = new Set(candidates.map((candidate) => candidate.toLowerCase()));
  return form.fields.find((field) => lower.has(String(field.name || '').toLowerCase()))?.name;
}

function isTextInputField(field) {
  const type = String(field.type || 'text').toLowerCase();
  return ['text', 'email', 'search', 'tel', 'url', ''].includes(type);
}

function isOtpInputField(field) {
  const name = String(field.name || '').toLowerCase();
  const type = String(field.type || 'text').toLowerCase();
  if (['hidden', 'radio', 'checkbox', 'submit', 'button'].includes(type)) {
    return false;
  }

  if (/^(otp|totp|mfa|mfa_code|two_factor|twofactor|authenticator_code|authenticatorCode)$/i.test(name)) {
    return true;
  }

  if (/(otp|totp|mfa|2fa|two[_-]?factor|authenticator|verification)/i.test(name)) {
    return true;
  }

  if (name !== 'code') {
    return false;
  }

  return fieldHint(field, /otp|totp|one-time|one time|verification|authenticator|2fa|mfa|sms|pin|numeric|number/);
}

function fieldHint(field, pattern) {
  const hint = [
    field.id,
    field.autocomplete,
    field.inputmode,
    field.placeholder,
    field.ariaLabel
  ].map((value) => String(value || '').toLowerCase()).join(' ');

  return pattern.test(hint);
}

function readDeviceOptions(html) {
  const devices = [];
  const radioRegex = /<input\b([^>]*type=["']?radio["']?[^>]*)>/gi;
  let radioMatch;
  while ((radioMatch = radioRegex.exec(String(html || '')))) {
    const attrs = radioMatch[1];
    const name = decodeHtml(readAttr(attrs, 'name') || '');
    const value = decodeHtml(readAttr(attrs, 'value') || '');
    const id = decodeHtml(readAttr(attrs, 'id') || '');
    if (!name || !value) {
      continue;
    }
    devices.push({
      type: 'radio',
      name,
      value,
      label: readLabelFor(html, id) || readWrappingLabelForInput(html, attrs) || value
    });
  }

  const selectRegex = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
  let selectMatch;
  while ((selectMatch = selectRegex.exec(String(html || '')))) {
    const name = decodeHtml(readAttr(selectMatch[1], 'name') || '');
    if (!name) {
      continue;
    }
    const optionRegex = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
    let optionMatch;
    while ((optionMatch = optionRegex.exec(selectMatch[2]))) {
      const value = decodeHtml(readAttr(optionMatch[1], 'value') || '');
      const label = stripTags(decodeHtml(optionMatch[2]));
      if (value) {
        devices.push({ type: 'select', name, value, label: label || value });
      }
    }
  }

  return devices;
}

function readLabelFor(html, id) {
  if (!id) {
    return null;
  }
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(html || '').match(new RegExp(`<label\\b[^>]*for=["']${escapedId}["'][^>]*>([\\s\\S]*?)<\\/label>`, 'i'));
  return match ? stripTags(decodeHtml(match[1])) : null;
}

function readWrappingLabelForInput(html, inputAttrs) {
  const inputValue = readAttr(inputAttrs, 'value');
  const labels = String(html || '').match(/<label\b[^>]*>[\s\S]*?<\/label>/gi) || [];
  for (const label of labels) {
    const inputMatch = label.match(/<input\b([^>]*)>/i);
    if (!inputMatch) {
      continue;
    }
    const labelInputValue = readAttr(inputMatch[1], 'value');
    const labelInputName = readAttr(inputMatch[1], 'name');
    if (
      inputValue !== null &&
      labelInputValue === inputValue &&
      labelInputName === readAttr(inputAttrs, 'name')
    ) {
      return stripTags(decodeHtml(label));
    }
  }
  return null;
}

function summarizeFormShapes(forms) {
  return forms
    .slice(0, 3)
    .map((form, index) => {
      const fields = form.fields
        .slice(0, 8)
        .map((field) => `${field.name || '(unnamed)'}:${field.type || 'text'}`)
        .join(',');
      const devices = form.devices.length ? ` devices=${form.devices.length}` : '';
      return `form${index + 1}{kind=${form.kind || 'unknown'} fields=[${fields}]${devices}}`;
    })
    .join(' ');
}

function readAttr(attrs, name) {
  const match = String(attrs || '').match(new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function findAttributeValue(html, attr, pattern) {
  const regex = new RegExp(`${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'gi');
  let match;
  while ((match = regex.exec(String(html || '')))) {
    const value = match[1] ?? match[2] ?? match[3] ?? '';
    if (pattern.test(value)) {
      return value;
    }
  }
  return null;
}

function readAuthorizationCode(rawUrl) {
  const url = new URL(rawUrl);
  return url.searchParams.get('code') || new URLSearchParams(url.hash.replace(/^#/, '')).get('code');
}

function readAuthorizationState(rawUrl) {
  const url = new URL(rawUrl);
  return url.searchParams.get('state') || new URLSearchParams(url.hash.replace(/^#/, '')).get('state');
}

function sameRedirectTarget(rawUrl, expectedRawUrl) {
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

function stripHash(rawUrl) {
  const url = new URL(rawUrl);
  url.hash = '';
  return url.toString();
}

function isRedirect(status) {
  return [301, 302, 303, 307, 308].includes(status);
}

function isIdempotentMethod(method) {
  return ['GET', 'HEAD', 'OPTIONS'].includes(String(method || 'GET').toUpperCase());
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw safeApiAuthError('Auth endpoint returned non-JSON response.');
  }
}

function safeApiAuthError(message) {
  const error = new Error(redactText(message));
  error.code = 'API_AUTH_FAILED';
  return error;
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function stripTags(value) {
  return String(value || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
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
