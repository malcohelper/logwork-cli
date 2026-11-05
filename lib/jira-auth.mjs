import { isCancel, password } from '@clack/prompts';
import { CONFIG } from '../config.mjs';
import { createCredentialJiraStorage } from './credential-store.mjs';
import { getJiraMyself, assertJiraBaseUrl } from './jira-api.mjs';
import { redactText } from './auth-redaction.mjs';
import { safeJsonParse } from './util.mjs';

export function createJiraAuthRequiredError(message = jiraAuthRequiredSummary()) {
  const error = new Error(message);
  error.code = 'JIRA_AUTH_REQUIRED';
  return error;
}

export function isJiraAuthRequiredError(error) {
  return error?.code === 'JIRA_AUTH_REQUIRED';
}

export function jiraAuthRequiredPayload(error) {
  return {
    status: 'jira_auth_required',
    authRequired: true,
    command: 'logwork-helper jira login',
    summary: error?.message || jiraAuthRequiredSummary()
  };
}

export async function loginJira({
  baseUrl = CONFIG.jiraBaseUrl,
  tokenProvider = createTerminalJiraTokenProvider(),
  storage = createCredentialJiraStorage(),
  validateToken = getJiraMyself
} = {}) {
  const normalizedBaseUrl = normalizeJiraBaseUrl(baseUrl);
  const token = String(await tokenProvider.requestToken({ baseUrl: normalizedBaseUrl }) || '').trim();
  if (!token) {
    throw new Error('Jira PAT token is required.');
  }

  const user = await validateToken(token, {
    baseUrl: normalizedBaseUrl
  });
  const session = normalizeJiraSession({
    baseUrl: normalizedBaseUrl,
    token,
    user
  });
  await storage.set(serializeJiraSession(session));

  return {
    ...session,
    summary: `Authenticated to Jira ${session.baseUrl} as ${formatJiraUser(session.user)}.`
  };
}

export async function getStoredJiraStatus({
  storage = createCredentialJiraStorage()
} = {}) {
  const session = normalizeStoredJiraSession(await storage.get());
  if (!session?.token) {
    return {
      authenticated: false,
      summary: 'Not authenticated to Jira. Run `logwork-helper jira login`.'
    };
  }

  return {
    authenticated: true,
    baseUrl: session.baseUrl,
    user: session.user,
    summary: `Authenticated to Jira ${session.baseUrl} as ${formatJiraUser(session.user)}.`
  };
}

export async function logoutJira({
  storage = createCredentialJiraStorage()
} = {}) {
  const deleted = await storage.delete();
  return {
    deleted,
    summary: deleted ? 'Deleted stored Jira PAT.' : 'No stored Jira PAT found.'
  };
}

export async function getStoredJiraSession({
  storage = createCredentialJiraStorage()
} = {}) {
  const session = normalizeStoredJiraSession(await storage.get());
  if (!session?.token) {
    throw createJiraAuthRequiredError();
  }
  return session;
}

export function createTerminalJiraTokenProvider({
  stdin = process.stdin,
  stdout = process.stdout
} = {}) {
  return {
    async requestToken({ baseUrl }) {
      ensureInteractive(stdin, stdout);
      return handleCancel(await password({
        message: `Jira PAT for ${baseUrl}:`,
        validate(value) {
          if (!String(value || '').trim()) {
            return 'Jira PAT token is required.';
          }
          return undefined;
        }
      }));
    }
  };
}

export function normalizeStoredJiraSession(rawValue) {
  if (!rawValue) {
    return null;
  }

  const parsed = safeJsonParse(String(rawValue), null);
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  try {
    return normalizeJiraSession(parsed);
  } catch {
    return null;
  }
}

export function normalizeJiraSession(session = {}) {
  const baseUrl = normalizeJiraBaseUrl(session.baseUrl || CONFIG.jiraBaseUrl);
  const token = String(session.token || '').trim();
  if (!token) {
    throw new Error('Jira session token is required.');
  }

  return {
    baseUrl,
    token,
    user: session.user && typeof session.user === 'object' ? sanitizeJiraUser(session.user) : null
  };
}

export function serializeJiraSession(session) {
  const normalized = normalizeJiraSession(session);
  return JSON.stringify({
    baseUrl: normalized.baseUrl,
    token: normalized.token,
    user: normalized.user
  });
}

export function formatJiraUser(user) {
  if (!user) {
    return 'unknown user';
  }
  return user.displayName || user.name || user.key || user.emailAddress || 'unknown user';
}

function sanitizeJiraUser(user) {
  return {
    name: textOrUndefined(user.name),
    key: textOrUndefined(user.key),
    displayName: textOrUndefined(user.displayName),
    emailAddress: textOrUndefined(user.emailAddress),
    active: user.active === undefined ? undefined : Boolean(user.active)
  };
}

function textOrUndefined(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return undefined;
  }
  return String(value);
}

function ensureInteractive(stdin, stdout) {
  if (!stdin?.isTTY || !stdout?.isTTY) {
    throw createJiraAuthRequiredError();
  }
}

function handleCancel(value) {
  if (isCancel(value)) {
    throw new Error('User cancelled Jira authentication.');
  }
  return value;
}

function normalizeJiraBaseUrl(value) {
  const url = assertJiraBaseUrl(value);
  const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return `${url.origin}${pathname}`;
}

function jiraAuthRequiredSummary() {
  return 'Jira authentication required. Run `logwork-helper jira login` in a terminal, paste a Jira Personal Access Token there, then retry this MCP tool.';
}

export function safeJiraAuthError(error) {
  return new Error(redactText(error?.message || String(error || 'Jira authentication failed.')));
}
