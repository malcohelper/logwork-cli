import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithPolicy } from '../lib/http.mjs';

test('fetchWithPolicy aborts requests after timeout', async () => {
  await assert.rejects(
    fetchWithPolicy('https://example.test/slow', {
      timeoutMs: 1,
      fetchImpl: async (_url, options = {}) => new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      })
    }),
    (error) => {
      assert.equal(error.code, 'HTTP_TIMEOUT');
      assert.match(error.message, /timed out/);
      return true;
    }
  );
});

test('fetchWithPolicy cancels retryable response bodies before retry', async () => {
  let calls = 0;
  let canceled = false;
  const body = new ReadableStream({
    cancel() {
      canceled = true;
    }
  });

  const response = await fetchWithPolicy('https://example.test/retry', {
    retries: 1,
    retryDelayMs: 0,
    idempotent: true,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(body, { status: 503 });
      }
      return new Response('ok', { status: 200 });
    }
  });

  assert.equal(response.status, 200);
  assert.equal(calls, 2);
  assert.equal(canceled, true);
});
