const DEFAULT_PROFILE = 'vinova';

const BASE_CONFIG = {
  profile: DEFAULT_PROFILE,
  apiBase: 'https://api.resourceoptimiser.com/api/v1',
  loginUrl: 'https://app.resourceoptimiser.com/vinova',
  tokenKey: 'vinova_access_token',
  jiraBaseUrl: 'https://jira-vnv.vinova.sg',
  jiraStartedTime: '09:00',
  timezone: 'Asia/Ho_Chi_Minh',

  projectMembersPath: '/project-members/by-user',
  memberLogtimePath: '/member-logtime',
  memberLogtimeMethod: 'PATCH',
  logworkEntriesPath: '/logwork/entries',
  logworkTasksPath: '/logwork/tasks',
  logworkDefaultTasksPath: '/logwork/tasks/defaults',
  logworkDayPath: '/logwork/day',
  logworkWeeklyPath: '/logwork/weekly',
  logworkRejectedPath: '/logwork/rejected',
  defaultTypeOfWork: 'other',
  timesheetPath: '/member-logtime/timesheet',
  signinKeycloakPath: '/auth/signinKeyCloak',
  refreshTokenPath: '/auth/refresh-token',
  keycloakAuthUrl: 'https://keycloak.vinova.sg/auth/realms/resource/protocol/openid-connect/auth',
  keycloakTokenUrl: 'https://keycloak.vinova.sg/auth/realms/resource/protocol/openid-connect/token',
  keycloakClientId: 'localhost',
  keycloakRedirectUri: 'https://app.resourceoptimiser.com/vinova/check-login',
  keycloakScope: 'openid',
  keycloakResponseMode: 'fragment',
  keycloakResponseType: 'code',

  pollMs: 500,
  hookTimeoutMs: 5 * 60 * 1000,
  loginPollMs: 2000,
  loginTimeoutMs: 5 * 60 * 1000,
  maxApiAuthSteps: 12,
  httpTimeoutMs: 30 * 1000,
  httpReadRetries: 2,
  httpRetryDelayMs: 250,

  defaultHours: 1,
  standardDayHours: 8,
  hourStep: 0.5,
  dayLogConcurrency: 5,

  resultValues: {
    ok: 'ok',
    skip: 'skip',
    abort: 'abort'
  }
};

export const CONFIG = buildConfig(process.env);

export function buildConfig(env = {}) {
  const profile = readStringEnv(env, 'LOGWORK_HELPER_PROFILE') || DEFAULT_PROFILE;
  const config = {
    ...BASE_CONFIG,
    profile,
    apiBase: readUrlEnv(env, 'LOGWORK_API_BASE') || BASE_CONFIG.apiBase,
    loginUrl: readUrlEnv(env, 'LOGWORK_LOGIN_URL') || BASE_CONFIG.loginUrl,
    tokenKey: readStringEnv(env, 'LOGWORK_TOKEN_KEY') || BASE_CONFIG.tokenKey,
    jiraBaseUrl: readUrlEnv(env, 'LOGWORK_JIRA_BASE_URL') || BASE_CONFIG.jiraBaseUrl,
    jiraStartedTime: readTimeEnv(env, 'LOGWORK_JIRA_STARTED_TIME') || BASE_CONFIG.jiraStartedTime,
    timezone: readTimeZoneEnv(env, 'LOGWORK_TIMEZONE') || BASE_CONFIG.timezone,
    keycloakAuthUrl: readUrlEnv(env, 'LOGWORK_KEYCLOAK_AUTH_URL') || BASE_CONFIG.keycloakAuthUrl,
    keycloakTokenUrl: readUrlEnv(env, 'LOGWORK_KEYCLOAK_TOKEN_URL') || BASE_CONFIG.keycloakTokenUrl,
    keycloakClientId: readStringEnv(env, 'LOGWORK_KEYCLOAK_CLIENT_ID') || BASE_CONFIG.keycloakClientId,
    keycloakRedirectUri: readUrlEnv(env, 'LOGWORK_KEYCLOAK_REDIRECT_URI') || BASE_CONFIG.keycloakRedirectUri,
    keycloakScope: readStringEnv(env, 'LOGWORK_KEYCLOAK_SCOPE') || BASE_CONFIG.keycloakScope,
    keycloakResponseMode: readStringEnv(env, 'LOGWORK_KEYCLOAK_RESPONSE_MODE') || BASE_CONFIG.keycloakResponseMode,
    keycloakResponseType: readStringEnv(env, 'LOGWORK_KEYCLOAK_RESPONSE_TYPE') || BASE_CONFIG.keycloakResponseType,
    httpTimeoutMs: readPositiveIntegerEnv(env, 'LOGWORK_HTTP_TIMEOUT_MS') || BASE_CONFIG.httpTimeoutMs,
    httpReadRetries: readNonNegativeIntegerEnv(env, 'LOGWORK_HTTP_READ_RETRIES') ?? BASE_CONFIG.httpReadRetries,
    httpRetryDelayMs: readNonNegativeIntegerEnv(env, 'LOGWORK_HTTP_RETRY_DELAY_MS') ?? BASE_CONFIG.httpRetryDelayMs,
    dayLogConcurrency: readPositiveIntegerEnv(env, 'LOGWORK_DAY_LOG_CONCURRENCY') || BASE_CONFIG.dayLogConcurrency
  };

  const configuredHosts = readCsvEnv(env, 'LOGWORK_ALLOWED_SAFARI_HOSTS');
  config.allowedSafariHosts = configuredHosts || [hostFromUrl(config.loginUrl, 'LOGWORK_LOGIN_URL')];
  config.keycloakHost = hostFromUrl(config.keycloakAuthUrl, 'LOGWORK_KEYCLOAK_AUTH_URL');

  return Object.freeze({
    ...config,
    allowedSafariHosts: Object.freeze([...config.allowedSafariHosts]),
    resultValues: Object.freeze({ ...config.resultValues })
  });
}

function readStringEnv(env, key) {
  const value = env[key];
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }
  return String(value).trim();
}

function readUrlEnv(env, key) {
  const value = readStringEnv(env, key);
  if (!value) {
    return null;
  }
  validateUrl(value, key);
  return value;
}

function readCsvEnv(env, key) {
  const value = readStringEnv(env, key);
  if (!value) {
    return null;
  }
  const entries = value.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    throw new Error(`${key} must include at least one value.`);
  }

  return [...new Set(entries)];
}

function readPositiveIntegerEnv(env, key) {
  const value = readStringEnv(env, key);
  if (!value) {
    return null;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${key} must be a positive integer.`);
  }
  return number;
}

function readNonNegativeIntegerEnv(env, key) {
  const value = readStringEnv(env, key);
  if (!value) {
    return null;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${key} must be a non-negative integer.`);
  }
  return number;
}

function readTimeEnv(env, key) {
  const value = readStringEnv(env, key);
  if (!value) {
    return null;
  }
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error(`${key} must use 24-hour HH:mm format.`);
  }
  return value;
}

function readTimeZoneEnv(env, key) {
  const value = readStringEnv(env, key);
  if (!value) {
    return null;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
  } catch {
    throw new Error(`${key} must be a valid IANA timezone.`);
  }
  return value;
}

function hostFromUrl(value, label) {
  return validateUrl(value, label).host;
}

function validateUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid http(s) URL.`);
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${label} must be a valid http(s) URL.`);
  }

  if (url.protocol === 'http:' && !isLocalHttpHost(url.hostname)) {
    throw new Error(`${label} must use HTTPS unless it points to localhost or loopback.`);
  }

  return url;
}

function isLocalHttpHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.startsWith('127.');
}
