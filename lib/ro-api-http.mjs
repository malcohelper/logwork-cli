// Resource Optimiser HTTP plumbing: the authenticated JSON fetch and its error type.
import { CONFIG } from './config.mjs';
import { fetchWithPolicy, redactedExcerpt } from './http.mjs';
import { safeJsonParse } from './util.mjs';

export class ApiError extends Error {
  constructor(message, { status, path, body } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

export async function apiFetch(token, path, options = {}) {
  const {
    fetchImpl,
    retries,
    retryDelayMs = CONFIG.httpRetryDelayMs,
    timeoutMs = CONFIG.httpTimeoutMs,
    cache: _worklogTaskCache,
    taskCache: _taskCacheAlias,
    ...requestOptions
  } = options;
  const method = requestOptions.method || 'GET';
  const response = await fetchWithPolicy(`${CONFIG.apiBase}${path}`, {
    ...requestOptions,
    fetchImpl,
    timeoutMs,
    retryDelayMs,
    retries: retries ?? CONFIG.httpReadRetries,
    idempotent: isIdempotentMethod(method),
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...requestOptions.headers
    }
  });

  const text = await response.text();
  const data = text ? safeJsonParse(text, text) : null;
  const safeBody = redactedExcerpt(text);

  if (response.status === 401) {
    throw new ApiError('API request returned 401 Unauthorized.', {
      status: response.status,
      path,
      body: safeBody
    });
  }

  if (!response.ok) {
    throw new ApiError(`API request failed: ${response.status} ${response.statusText} for ${path}. Body: ${safeBody}`, {
      status: response.status,
      path,
      body: safeBody
    });
  }

  return data;
}

function isIdempotentMethod(method) {
  return ['GET', 'HEAD', 'OPTIONS'].includes(String(method || 'GET').toUpperCase());
}
