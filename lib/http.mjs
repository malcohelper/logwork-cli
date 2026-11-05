import { redactText } from './auth-redaction.mjs';

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export async function fetchWithPolicy(url, {
  fetchImpl = fetch,
  timeoutMs = 30_000,
  retries = 0,
  retryDelayMs = 250,
  idempotent = false,
  ...options
} = {}) {
  const attempts = idempotent ? Math.max(0, Number(retries) || 0) + 1 : 1;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || 30_000));
    const signal = mergeAbortSignals(options.signal, controller.signal);

    try {
      const response = await fetchImpl(url, {
        ...options,
        signal
      });
      clearTimeout(timeout);

      if (
        attempt < attempts &&
        RETRYABLE_STATUSES.has(response.status)
      ) {
        await discardResponseBody(response);
        await delay(retryDelayMs);
        continue;
      }

      return response;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;

      if (isAbortError(error)) {
        throw httpPolicyError(`HTTP request timed out for ${safeUrlLabel(url)} after ${Math.max(1, Number(timeoutMs) || 30_000)}ms.`, {
          code: 'HTTP_TIMEOUT',
          cause: error
        });
      }

      if (attempt < attempts) {
        await delay(retryDelayMs);
        continue;
      }

      throw httpPolicyError(`HTTP request failed for ${safeUrlLabel(url)}: ${error.message || String(error)}`, {
        code: 'HTTP_NETWORK_ERROR',
        cause: error
      });
    }
  }

  throw httpPolicyError(`HTTP request failed for ${safeUrlLabel(url)}: ${lastError?.message || 'unknown network error'}`, {
    code: 'HTTP_NETWORK_ERROR',
    cause: lastError
  });
}

export function redactedExcerpt(value, maxLength = 500) {
  let text = redactText(String(value || ''));
  text = text.replace(/("(?:password|otp|cookie|authorization|token|accessToken|refreshToken|access_token|refresh_token|code|session_code|state|nonce|tab_id|credentialId)"\s*:\s*)"[^"]*"/gi, '$1"<redacted>"');
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function mergeAbortSignals(signal, timeoutSignal) {
  if (!signal) {
    return timeoutSignal;
  }

  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([signal, timeoutSignal]);
  }

  return timeoutSignal;
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

function httpPolicyError(message, { code, cause } = {}) {
  const error = new Error(redactText(message));
  error.code = code;
  if (cause) {
    error.cause = cause;
  }
  return error;
}

async function discardResponseBody(response) {
  try {
    if (response?.body && typeof response.body.cancel === 'function') {
      await response.body.cancel();
      return;
    }

    if (typeof response?.arrayBuffer === 'function') {
      await response.arrayBuffer();
    }
  } catch {
    // Best-effort cleanup before retry; the retry itself is more important.
  }
}

function safeUrlLabel(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return 'unknown-url';
  }
}

function delay(ms) {
  const waitMs = Math.max(0, Number(ms) || 0);
  return waitMs ? new Promise((resolve) => setTimeout(resolve, waitMs)) : Promise.resolve();
}
