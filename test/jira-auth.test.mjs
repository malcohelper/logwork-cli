import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getStoredJiraSession,
  getStoredJiraStatus,
  loginJira,
  logoutJira,
  normalizeStoredJiraSession
} from '../lib/jira-auth.mjs';

test('loginJira validates PAT and stores sanitized Jira session JSON', async () => {
  let storedValue = '';
  const result = await loginJira({
    baseUrl: 'https://jira.example.com/jira/',
    tokenProvider: {
      async requestToken({ baseUrl }) {
        assert.equal(baseUrl, 'https://jira.example.com/jira');
        return 'jira-pat-secret';
      }
    },
    validateToken: async (token, options) => {
      assert.equal(token, 'jira-pat-secret');
      assert.equal(options.baseUrl, 'https://jira.example.com/jira');
      return {
        name: 'malco',
        displayName: 'Malco',
        emailAddress: 'malco@example.com',
        active: true
      };
    },
    storage: {
      async set(value) {
        storedValue = value;
      }
    }
  });

  assert.match(result.summary, /Authenticated to Jira https:\/\/jira\.example\.com\/jira as Malco/);
  assert.doesNotMatch(result.summary, /jira-pat-secret/);
  assert.deepEqual(JSON.parse(storedValue), {
    baseUrl: 'https://jira.example.com/jira',
    token: 'jira-pat-secret',
    user: {
      name: 'malco',
      displayName: 'Malco',
      emailAddress: 'malco@example.com',
      active: true
    }
  });
});

test('stored Jira status and logout use injectable storage', async () => {
  let value = JSON.stringify({
    baseUrl: 'https://jira.example.com',
    token: 'stored-pat',
    user: {
      displayName: 'Stored User'
    }
  });
  const storage = {
    async get() {
      return value;
    },
    async delete() {
      const deleted = Boolean(value);
      value = null;
      return deleted;
    }
  };

  const status = await getStoredJiraStatus({ storage });
  assert.equal(status.authenticated, true);
  assert.match(status.summary, /Stored User/);
  assert.doesNotMatch(status.summary, /stored-pat/);
  assert.equal((await getStoredJiraSession({ storage })).token, 'stored-pat');

  const logout = await logoutJira({ storage });
  assert.equal(logout.deleted, true);
  assert.match(logout.summary, /Deleted stored Jira PAT/);

  const missing = await getStoredJiraStatus({ storage });
  assert.equal(missing.authenticated, false);
  assert.match(missing.summary, /jira login/);
});

test('normalizeStoredJiraSession rejects malformed stored values', () => {
  assert.equal(normalizeStoredJiraSession(''), null);
  assert.equal(normalizeStoredJiraSession('not-json'), null);
  assert.equal(normalizeStoredJiraSession(JSON.stringify({ token: '' })), null);
});
