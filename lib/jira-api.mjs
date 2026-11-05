import { CONFIG } from '../config.mjs';
import { ApiError } from './api.mjs';
import { fetchWithPolicy, redactedExcerpt } from './http.mjs';
import { safeJsonParse } from './util.mjs';

export async function jiraApiFetch(token, path, {
  baseUrl = CONFIG.jiraBaseUrl,
  fetchImpl = fetch,
  timeoutMs = CONFIG.httpTimeoutMs,
  retries = CONFIG.httpReadRetries,
  retryDelayMs = CONFIG.httpRetryDelayMs,
  method = 'GET',
  body,
  headers = {}
} = {}) {
  assertJiraToken(token);
  const url = buildJiraUrl(baseUrl, path);
  const response = await fetchWithPolicy(url.toString(), {
    fetchImpl,
    timeoutMs,
    retries,
    retryDelayMs,
    idempotent: isIdempotentMethod(method),
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  const data = text ? safeJsonParse(text, text) : null;
  const safeBody = redactedExcerpt(text);

  if (response.status === 401) {
    throw new ApiError('Jira request returned 401 Unauthorized. Run `logwork-helper jira login` with a valid PAT.', {
      status: response.status,
      path,
      body: safeBody
    });
  }

  if (!response.ok) {
    throw new ApiError(`Jira request failed: ${response.status} ${response.statusText} for ${path}. Body: ${safeBody}`, {
      status: response.status,
      path,
      body: safeBody
    });
  }

  return data;
}

export async function getJiraMyself(token, options = {}) {
  return normalizeJiraUser(await jiraApiFetch(token, '/rest/api/2/myself', options));
}

export async function getJiraIssue(token, issueKey, options = {}) {
  assertIssueKey(issueKey);
  return normalizeJiraIssue(await jiraApiFetch(token, `/rest/api/2/issue/${encodeURIComponent(issueKey)}`, options));
}

export async function getJiraIssueWorklogs(token, issueKey, options = {}) {
  assertIssueKey(issueKey);
  const { pageSize = 100, ...fetchOptions } = options;
  const worklogs = [];
  let startAt = 0;

  while (true) {
    const qs = new URLSearchParams({
      maxResults: String(pageSize),
      startAt: String(startAt)
    });
    const data = await jiraApiFetch(token, `/rest/api/2/issue/${encodeURIComponent(issueKey)}/worklog?${qs}`, fetchOptions);
    const page = Array.isArray(data?.worklogs) ? data.worklogs : [];
    worklogs.push(...page.map(normalizeJiraWorklog));

    startAt += page.length;
    const total = Number(data?.total);
    if (!page.length || !Number.isFinite(total) || startAt >= total) {
      break;
    }
  }

  return worklogs;
}

export async function searchJiraIssues(token, {
  jql,
  fields = ['key', 'summary'],
  pageSize = 100
} = {}, options = {}) {
  if (!String(jql || '').trim()) {
    throw new Error('Jira search requires JQL.');
  }
  const issues = [];
  let startAt = 0;

  while (true) {
    const qs = new URLSearchParams({
      jql: String(jql),
      fields: fields.join(','),
      maxResults: String(pageSize),
      startAt: String(startAt)
    });
    const data = await jiraApiFetch(token, `/rest/api/2/search?${qs}`, options);
    const page = Array.isArray(data?.issues) ? data.issues : [];
    issues.push(...page.map(normalizeJiraIssue));

    startAt += page.length;
    const total = Number(data?.total);
    if (!page.length || !Number.isFinite(total) || startAt >= total) {
      break;
    }
  }

  return issues;
}

export async function addJiraIssueWorklog(token, issueKey, worklog, options = {}) {
  assertIssueKey(issueKey);
  const qs = new URLSearchParams({ adjustEstimate: 'leave' });
  const path = `/rest/api/2/issue/${encodeURIComponent(issueKey)}/worklog?${qs}`;
  return normalizeJiraWorklog(await jiraApiFetch(token, path, {
    ...options,
    method: 'POST',
    retries: 0,
    body: worklog
  }));
}

export function normalizeJiraIssue(issue = {}) {
  const fields = issue.fields || {};
  return {
    id: issue.id ? String(issue.id) : undefined,
    key: issue.key ? String(issue.key) : undefined,
    summary: fields.summary ? String(fields.summary) : '',
    status: fields.status?.name ? String(fields.status.name) : '',
    issueType: fields.issuetype?.name ? String(fields.issuetype.name) : '',
    project: fields.project?.key || fields.project?.name
      ? {
        key: fields.project?.key ? String(fields.project.key) : undefined,
        name: fields.project?.name ? String(fields.project.name) : undefined
      }
      : null,
    assignee: fields.assignee ? normalizeJiraUser(fields.assignee) : null
  };
}

export function normalizeJiraUser(user = {}) {
  return {
    name: user.name ? String(user.name) : undefined,
    key: user.key ? String(user.key) : undefined,
    displayName: user.displayName ? String(user.displayName) : undefined,
    emailAddress: user.emailAddress ? String(user.emailAddress) : undefined,
    active: user.active === undefined ? undefined : Boolean(user.active)
  };
}

export function normalizeJiraWorklog(worklog = {}) {
  return {
    id: worklog.id ? String(worklog.id) : undefined,
    issueId: worklog.issueId ? String(worklog.issueId) : undefined,
    started: worklog.started ? String(worklog.started) : '',
    timeSpent: worklog.timeSpent ? String(worklog.timeSpent) : '',
    timeSpentSeconds: Number.isFinite(Number(worklog.timeSpentSeconds)) ? Number(worklog.timeSpentSeconds) : 0,
    comment: normalizeWorklogComment(worklog.comment),
    author: worklog.author ? normalizeJiraUser(worklog.author) : null
  };
}

export function buildJiraUrl(baseUrl, path) {
  const base = assertJiraBaseUrl(baseUrl);
  const basePath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  const relativePath = String(path || '').replace(/^\/+/, '');
  return new URL(relativePath, `${base.origin}${basePath}`);
}

export function assertJiraBaseUrl(rawUrl = CONFIG.jiraBaseUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Jira base URL must be a valid http(s) URL.');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Jira base URL must use HTTP or HTTPS.');
  }

  if (url.protocol === 'http:' && !isLocalHttpHost(url.hostname)) {
    throw new Error('Jira base URL must use HTTPS unless it points to localhost or loopback.');
  }

  return url;
}

function assertJiraToken(token) {
  if (!String(token || '').trim()) {
    throw new Error('Jira PAT token is required.');
  }
}

function assertIssueKey(issueKey) {
  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(String(issueKey || ''))) {
    throw new Error('Jira issueKey must look like ABC-123.');
  }
}

function normalizeWorklogComment(comment) {
  if (typeof comment === 'string') {
    return comment;
  }
  if (comment === undefined || comment === null) {
    return '';
  }
  const text = extractJiraText(comment).trim();
  if (text) {
    return text;
  }
  try {
    return JSON.stringify(comment);
  } catch {
    return String(comment);
  }
}

function extractJiraText(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(extractJiraText).filter(Boolean).join(' ');
  }
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') {
      return value.text;
    }
    if (Array.isArray(value.content)) {
      return extractJiraText(value.content);
    }
  }
  return '';
}

function isIdempotentMethod(method) {
  return ['GET', 'HEAD', 'OPTIONS'].includes(String(method || 'GET').toUpperCase());
}

function isLocalHttpHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.startsWith('127.');
}
