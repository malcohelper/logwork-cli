import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig, CONFIG } from '../config.mjs';

test('CONFIG keeps the default Vinova Resource Optimiser profile', () => {
  assert.equal(CONFIG.profile, 'vinova');
  assert.equal(CONFIG.apiBase, 'https://api.resourceoptimiser.com/api/v1');
  assert.equal(CONFIG.loginUrl, 'https://app.resourceoptimiser.com/vinova');
  assert.equal(CONFIG.jiraBaseUrl, 'https://jira-vnv.vinova.sg');
  assert.equal(CONFIG.jiraStartedTime, '09:00');
  assert.equal(CONFIG.timezone, 'Asia/Ho_Chi_Minh');
  assert.deepEqual(CONFIG.allowedSafariHosts, ['app.resourceoptimiser.com']);
  assert.equal(CONFIG.keycloakHost, 'keycloak.vinova.sg');
});

test('buildConfig applies validated environment overrides', () => {
  const config = buildConfig({
    LOGWORK_HELPER_PROFILE: 'staging',
    LOGWORK_API_BASE: 'https://api.staging.example.com/api/v1',
    LOGWORK_LOGIN_URL: 'https://app.staging.example.com/acme',
    LOGWORK_JIRA_BASE_URL: 'https://jira.staging.example.com',
    LOGWORK_JIRA_STARTED_TIME: '08:30',
    LOGWORK_TIMEZONE: 'Asia/Singapore',
    LOGWORK_TOKEN_KEY: 'acme_access_token',
    LOGWORK_ALLOWED_SAFARI_HOSTS: 'app.staging.example.com, app2.staging.example.com,app.staging.example.com',
    LOGWORK_KEYCLOAK_AUTH_URL: 'https://keycloak.staging.example.com/auth',
    LOGWORK_KEYCLOAK_TOKEN_URL: 'https://keycloak.staging.example.com/token',
    LOGWORK_KEYCLOAK_CLIENT_ID: 'acme-localhost',
    LOGWORK_KEYCLOAK_REDIRECT_URI: 'https://app.staging.example.com/acme/check-login',
    LOGWORK_HTTP_TIMEOUT_MS: '45000',
    LOGWORK_HTTP_READ_RETRIES: '4',
    LOGWORK_HTTP_RETRY_DELAY_MS: '1000',
    LOGWORK_DAY_LOG_CONCURRENCY: '2'
  });

  assert.equal(config.profile, 'staging');
  assert.equal(config.apiBase, 'https://api.staging.example.com/api/v1');
  assert.equal(config.loginUrl, 'https://app.staging.example.com/acme');
  assert.equal(config.jiraBaseUrl, 'https://jira.staging.example.com');
  assert.equal(config.jiraStartedTime, '08:30');
  assert.equal(config.timezone, 'Asia/Singapore');
  assert.equal(config.tokenKey, 'acme_access_token');
  assert.deepEqual(config.allowedSafariHosts, [
    'app.staging.example.com',
    'app2.staging.example.com'
  ]);
  assert.equal(config.keycloakHost, 'keycloak.staging.example.com');
  assert.equal(config.keycloakClientId, 'acme-localhost');
  assert.equal(config.keycloakRedirectUri, 'https://app.staging.example.com/acme/check-login');
  assert.equal(config.httpTimeoutMs, 45_000);
  assert.equal(config.httpReadRetries, 4);
  assert.equal(config.httpRetryDelayMs, 1_000);
  assert.equal(config.dayLogConcurrency, 2);
});

test('buildConfig fails fast for invalid URL and numeric overrides', () => {
  assert.throws(() => buildConfig({
    LOGWORK_API_BASE: 'ftp://api.example.com'
  }), /LOGWORK_API_BASE must be a valid http\(s\) URL/);

  assert.throws(() => buildConfig({
    LOGWORK_API_BASE: 'http://api.example.com/api/v1'
  }), /LOGWORK_API_BASE must use HTTPS unless it points to localhost or loopback/);

  assert.equal(buildConfig({
    LOGWORK_API_BASE: 'http://localhost:3000/api/v1'
  }).apiBase, 'http://localhost:3000/api/v1');

  assert.throws(() => buildConfig({
    LOGWORK_HTTP_TIMEOUT_MS: '0'
  }), /LOGWORK_HTTP_TIMEOUT_MS must be a positive integer/);

  assert.throws(() => buildConfig({
    LOGWORK_HTTP_READ_RETRIES: '-1'
  }), /LOGWORK_HTTP_READ_RETRIES must be a non-negative integer/);

  assert.throws(() => buildConfig({
    LOGWORK_JIRA_STARTED_TIME: '25:00'
  }), /LOGWORK_JIRA_STARTED_TIME must use 24-hour HH:mm format/);

  assert.throws(() => buildConfig({
    LOGWORK_TIMEZONE: 'Mars/Olympus'
  }), /LOGWORK_TIMEZONE must be a valid IANA timezone/);
});
