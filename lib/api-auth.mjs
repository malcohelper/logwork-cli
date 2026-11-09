import { randomUUID } from 'node:crypto';
import { CONFIG } from './config.mjs';
import { createTerminalCredentialProvider } from './terminal-auth-prompts.mjs';
import {
  assertSecureUrl,
  originFromUrl,
  readAuthorizationState,
  recordAuthEvent,
  safeApiAuthError,
  safeJson,
  safeUrlParts,
  sameRedirectTarget
} from './api-auth-support.mjs';
import { createHttpSession } from './api-auth-http.mjs';
import {
  parseHtmlForms,
  readBodyHint,
  readTitle,
  selectNextKeycloakForm,
  submitCredentialsForm,
  submitDeviceForm,
  submitOtpForm,
  submitPasswordUpdateForm,
  summarizeFormShapes
} from './api-auth-forms.mjs';
import {
  collectJsonKeyPaths,
  decodeJwtPayload,
  extractRoSession
} from './api-auth-tokens.mjs';

export { createHttpSession, requestWithRedirects } from './api-auth-http.mjs';
export {
  findKeycloakAuthUrl,
  parseHtmlForms,
  selectNextKeycloakForm,
  submitCredentialsForm,
  submitDeviceForm,
  submitOtpForm,
  submitPasswordUpdateForm
} from './api-auth-forms.mjs';
export { extractRoSession, extractRoToken } from './api-auth-tokens.mjs';

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
          'Keycloak requires a password update. Re-run `logwork login` in an interactive terminal.'
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
    'Retry with `logwork login`. If this keeps failing, inspect sanitized JSON key diagnostics and Keycloak form shape.'
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
    'Retry with `logwork login`. If this keeps failing, inspect sanitized diagnostics and Keycloak form shape.'
  ].filter(Boolean).join(' ');
}

function formatSigninKeycloakDiagnostics(response, data) {
  const keys = collectJsonKeyPaths(data);
  return [
    'Resource Optimiser signinKeyCloak did not return a usable API token.',
    `Status: ${response.status || 'unknown'}`,
    `JSON keys: ${keys.length ? keys.join(', ') : '(none)'}`,
    'Retry with `logwork login`. If this keeps failing, inspect sanitized JSON key diagnostics from the error.'
  ].join(' ');
}
