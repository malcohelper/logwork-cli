import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getFreshToken,
  getStoredAuthStatus,
  loginResourceOptimiser,
  normalizeStoredAuthSession,
  refreshResourceOptimiserSession,
  serializeAuthSession
} from '../lib/auth.mjs';

test('auth session storage reads legacy plain JWT and JSON session values', () => {
  const legacyAccess = makeRoJwt({ exp: futureExp() });
  assert.deepEqual(normalizeStoredAuthSession(legacyAccess), {
    accessToken: legacyAccess,
    refreshToken: null,
    legacy: true
  });

  const refreshToken = makeRoJwt({ exp: futureExp() + 600 });
  assert.deepEqual(normalizeStoredAuthSession(JSON.stringify({
    accessToken: legacyAccess,
    refreshToken
  })), {
    accessToken: legacyAccess,
    refreshToken
  });
});

test('loginResourceOptimiser stores access and refresh token session JSON', async () => {
  const accessToken = makeRoJwt({ exp: futureExp() });
  const refreshToken = makeRoJwt({ exp: futureExp() + 600 });
  const storage = memoryStorage();

  const result = await loginResourceOptimiser({
    storage,
    authenticator: async () => ({
      accessToken,
      refreshToken
    })
  });

  assert.match(result.summary, /Authenticated as user 115/);
  assert.deepEqual(JSON.parse(storage.value()), {
    accessToken,
    refreshToken
  });
});

test('getStoredAuthStatus reports refresh availability for expired access token', async () => {
  const storage = memoryStorage(serializeAuthSession({
    accessToken: makeRoJwt({ exp: pastExp() }),
    refreshToken: makeRoJwt({ exp: futureExp() })
  }));

  const result = await getStoredAuthStatus({ storage });
  assert.equal(result.authenticated, true);
  assert.equal(result.expired, true);
  assert.equal(result.refreshAvailable, true);
  assert.match(result.summary, /refresh token is available/);
});

test('getFreshToken returns valid stored access token without refresh or login', async () => {
  const accessToken = makeRoJwt({ exp: futureExp() });
  const storage = memoryStorage(serializeAuthSession({
    accessToken,
    refreshToken: makeRoJwt({ exp: futureExp() + 600 })
  }));
  let refreshCalled = false;
  let loginCalled = false;

  const result = await getFreshToken({
    storage,
    refreshSession: async () => {
      refreshCalled = true;
    },
    authenticator: async () => {
      loginCalled = true;
    }
  });

  assert.equal(result, accessToken);
  assert.equal(refreshCalled, false);
  assert.equal(loginCalled, false);
});

test('getFreshToken refreshes expired access token and stores refreshed session', async () => {
  const oldAccessToken = makeRoJwt({ exp: pastExp() });
  const oldRefreshToken = makeRoJwt({ exp: futureExp() + 600 });
  const newAccessToken = makeRoJwt({ exp: futureExp(), email: 'new@example.com' });
  const newRefreshToken = makeRoJwt({ exp: futureExp() + 1200 });
  const storage = memoryStorage(serializeAuthSession({
    accessToken: oldAccessToken,
    refreshToken: oldRefreshToken
  }));

  const result = await getFreshToken({
    storage,
    refreshSession: async ({ session }) => {
      assert.equal(session.accessToken, oldAccessToken);
      assert.equal(session.refreshToken, oldRefreshToken);
      return {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken
      };
    },
    authenticator: async () => {
      throw new Error('login should not be called');
    }
  });

  assert.equal(result, newAccessToken);
  assert.deepEqual(JSON.parse(storage.value()), {
    accessToken: newAccessToken,
    refreshToken: newRefreshToken
  });
});

test('getFreshToken falls back to login when refresh fails in interactive mode', async () => {
  const loginAccessToken = makeRoJwt({ exp: futureExp(), email: 'login@example.com' });
  const loginRefreshToken = makeRoJwt({ exp: futureExp() + 600 });
  const storage = memoryStorage(serializeAuthSession({
    accessToken: makeRoJwt({ exp: pastExp() }),
    refreshToken: makeRoJwt({ exp: futureExp() })
  }));
  let loginCalled = false;

  const result = await getFreshToken({
    storage,
    refreshSession: async () => {
      throw new Error('refresh rejected');
    },
    authenticator: async () => {
      loginCalled = true;
      return {
        accessToken: loginAccessToken,
        refreshToken: loginRefreshToken
      };
    }
  });

  assert.equal(loginCalled, true);
  assert.equal(result, loginAccessToken);
  assert.deepEqual(JSON.parse(storage.value()), {
    accessToken: loginAccessToken,
    refreshToken: loginRefreshToken
  });
});

test('getFreshToken returns auth-required when non-interactive refresh fails', async () => {
  const storage = memoryStorage(serializeAuthSession({
    accessToken: makeRoJwt({ exp: pastExp() }),
    refreshToken: makeRoJwt({ exp: futureExp() })
  }));

  await assert.rejects(
    getFreshToken({
      storage,
      interactive: false,
      refreshSession: async () => {
        throw new Error('refresh rejected');
      },
      authenticator: async () => {
        throw new Error('login should not be called');
      }
    }),
    /Resource Optimiser authentication required/
  );
});

test('refreshResourceOptimiserSession calls refresh endpoint and preserves old refresh token when omitted', async () => {
  const oldAccessToken = makeRoJwt({ exp: pastExp() });
  const oldRefreshToken = makeRoJwt({ exp: futureExp() + 600 });
  const newAccessToken = makeRoJwt({ exp: futureExp() });
  const requests = [];

  const result = await refreshResourceOptimiserSession({
    session: {
      accessToken: oldAccessToken,
      refreshToken: oldRefreshToken
    },
    apiBase: 'https://api.resourceoptimiser.com/api/v1',
    refreshTokenPath: '/auth/refresh-token',
    fetchImpl: async (url, options) => {
      requests.push({
        url,
        method: options.method,
        authorization: options.headers.Authorization,
        body: JSON.parse(options.body)
      });
      return new Response(JSON.stringify({
        data: {
          auth: {
            accessToken: newAccessToken
          }
        }
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }
  });

  assert.deepEqual(requests, [{
    url: 'https://api.resourceoptimiser.com/api/v1/auth/refresh-token',
    method: 'POST',
    authorization: `Bearer ${oldAccessToken}`,
    body: {
      refreshToken: oldRefreshToken
    }
  }]);
  assert.deepEqual(result, {
    accessToken: newAccessToken,
    refreshToken: oldRefreshToken
  });
});

test('refreshResourceOptimiserSession diagnostics do not leak tokens', async () => {
  const oldAccessToken = makeRoJwt({ exp: pastExp() });
  const oldRefreshToken = makeRoJwt({ exp: futureExp() + 600 });
  await assert.rejects(
    refreshResourceOptimiserSession({
      session: {
        accessToken: oldAccessToken,
        refreshToken: oldRefreshToken
      },
      apiBase: 'https://api.resourceoptimiser.com/api/v1',
      refreshTokenPath: '/auth/refresh-token',
      fetchImpl: async () => new Response(JSON.stringify({
        refreshToken: oldRefreshToken,
        data: {
          user: {
            name: 'Example User'
          }
        }
      }), { status: 200 })
    }),
    (error) => {
      assert.match(error.message, /refresh-token did not return a usable API token/);
      assert.match(error.message, /JSON keys: refreshToken, data, data.user, data.user.name/);
      assert.equal(error.message.includes(oldAccessToken), false);
      assert.equal(error.message.includes(oldRefreshToken), false);
      return true;
    }
  );
});

test('refreshResourceOptimiserSession rejects non-local HTTP API base', async () => {
  await assert.rejects(
    refreshResourceOptimiserSession({
      session: {
        accessToken: makeRoJwt({ exp: pastExp() }),
        refreshToken: makeRoJwt({ exp: futureExp() })
      },
      apiBase: 'http://api.resourceoptimiser.com/api/v1',
      refreshTokenPath: '/auth/refresh-token',
      fetchImpl: async () => {
        throw new Error('fetch should not be called');
      }
    }),
    /must use HTTPS/
  );
});

function memoryStorage(initialValue = null) {
  let current = initialValue;
  return {
    async get() {
      return current;
    },
    async set(value) {
      current = value;
    },
    async delete() {
      const deleted = current !== null;
      current = null;
      return deleted;
    },
    value() {
      return current;
    }
  };
}

function makeJwt(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature'
  ].join('.');
}

function makeRoJwt(payload = {}) {
  return makeJwt({
    id: 115,
    email: 'user@example.com',
    db_url: 'rp_vinova_prod',
    ...payload
  });
}

function futureExp() {
  return Math.floor(Date.now() / 1000) + 60 * 60;
}

function pastExp() {
  return Math.floor(Date.now() / 1000) - 60;
}
