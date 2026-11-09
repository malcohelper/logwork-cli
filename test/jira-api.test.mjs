import test from 'node:test';
import assert from 'node:assert/strict';
import { withEnv } from './helpers/env.mjs';
import {
  addJiraIssueWorklog,
  getJiraIssueWorklogs,
  getJiraMyself,
  isJiraDryRunResult,
  jiraApiFetch,
  searchJiraIssues
} from '../lib/jira-api.mjs';

test('jiraApiFetch sends Bearer PAT and preserves Jira context path', async () => {
  const data = await jiraApiFetch('pat-secret', '/rest/api/2/myself', {
    baseUrl: 'https://jira.example.com/jira',
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://jira.example.com/jira/rest/api/2/myself');
      assert.equal(options.headers.Authorization, 'Bearer pat-secret');
      assert.equal(options.method, 'GET');
      return jsonResponse({
        name: 'malco',
        displayName: 'Malco',
        active: true
      });
    }
  });

  assert.equal(data.displayName, 'Malco');
});

test('getJiraMyself normalizes user and redacts token-shaped error bodies', async () => {
  const user = await getJiraMyself('pat-secret', {
    baseUrl: 'https://jira.example.com',
    fetchImpl: async () => jsonResponse({
      name: 'malco',
      displayName: 'Malco',
      active: true
    })
  });
  assert.deepEqual(user, {
    name: 'malco',
    key: undefined,
    displayName: 'Malco',
    emailAddress: undefined,
    active: true
  });

  await assert.rejects(
    () => getJiraMyself('pat-secret', {
      baseUrl: 'https://jira.example.com',
      fetchImpl: async () => jsonResponse({
        accessToken: 'should-not-print'
      }, { status: 500, statusText: 'Server Error' })
    }),
    (error) => {
      assert.match(error.message, /Jira request failed/);
      assert.doesNotMatch(error.message, /should-not-print/);
      return true;
    }
  );
});

test('addJiraIssueWorklog posts adjustEstimate leave payload', async () => {
  const result = await addJiraIssueWorklog('pat-secret', 'SCB-213', {
    started: '2026-06-01T09:00:00.000+0700',
    timeSpentSeconds: 7200,
    comment: 'Task'
  }, {
    baseUrl: 'https://jira.example.com',
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://jira.example.com/rest/api/2/issue/SCB-213/worklog?adjustEstimate=leave');
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), {
        started: '2026-06-01T09:00:00.000+0700',
        timeSpentSeconds: 7200,
        comment: 'Task'
      });
      return jsonResponse({
        id: '10001',
        started: '2026-06-01T09:00:00.000+0700',
        timeSpentSeconds: 7200,
        comment: 'Task'
      }, { status: 201, statusText: 'Created' });
    }
  });

  assert.equal(result.id, '10001');
});

test('getJiraIssueWorklogs paginates and normalizes object comments', async () => {
  const urls = [];
  const result = await getJiraIssueWorklogs('pat-secret', 'SCB-213', {
    baseUrl: 'https://jira.example.com',
    pageSize: 2,
    fetchImpl: async (url, options) => {
      urls.push(url);
      assert.equal(options.method, 'GET');
      if (url.endsWith('startAt=0')) {
        return jsonResponse({
          startAt: 0,
          maxResults: 2,
          total: 3,
          worklogs: [
            {
              id: '10001',
              started: '2026-06-01T09:00:00.000+0700',
              timeSpentSeconds: 3600,
              comment: {
                type: 'doc',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'Investigate issue' }]
                  }
                ]
              }
            },
            {
              id: '10002',
              started: '2026-06-01T10:00:00.000+0700',
              timeSpentSeconds: 1800,
              comment: 'Follow up'
            }
          ]
        });
      }
      return jsonResponse({
        startAt: 2,
        maxResults: 2,
        total: 3,
        worklogs: [
          {
            id: '10003',
            started: '2026-06-01T11:00:00.000+0700',
            timeSpentSeconds: 900,
            comment: 'Wrap up'
          }
        ]
      });
    }
  });

  assert.deepEqual(urls, [
    'https://jira.example.com/rest/api/2/issue/SCB-213/worklog?maxResults=2&startAt=0',
    'https://jira.example.com/rest/api/2/issue/SCB-213/worklog?maxResults=2&startAt=2'
  ]);
  assert.deepEqual(result.map((worklog) => worklog.id), ['10001', '10002', '10003']);
  assert.equal(result[0].comment, 'Investigate issue');
});

test('searchJiraIssues encodes JQL and paginates reminder issue matches', async () => {
  const urls = [];
  const issues = await searchJiraIssues('pat-secret', {
    jql: 'worklogAuthor = currentUser() AND worklogDate = "2026-07-15"',
    fields: ['key', 'summary'],
    pageSize: 1
  }, {
    baseUrl: 'https://jira.example.com',
    fetchImpl: async (url) => {
      urls.push(url);
      const startAt = new URL(url).searchParams.get('startAt');
      return jsonResponse({
        total: 2,
        issues: [{
          id: startAt === '0' ? '1' : '2',
          key: startAt === '0' ? 'SCB-213' : 'SCB-214',
          fields: { summary: startAt === '0' ? 'First' : 'Second' }
        }]
      });
    }
  });
  assert.equal(new URL(urls[0]).searchParams.get('jql'), 'worklogAuthor = currentUser() AND worklogDate = "2026-07-15"');
  assert.deepEqual(issues.map((issue) => issue.key), ['SCB-213', 'SCB-214']);
});

test('addJiraIssueWorklog returns the request without calling Jira in dry run', async () => {
  let fetchCalls = 0;
  const worklog = {
    started: '2026-06-01T09:00:00.000+0700',
    timeSpentSeconds: 7200,
    comment: 'Task\n\n#lh:abcdef12'
  };
  const result = await withEnv({ LOGWORK_DRY_RUN: '1' }, () => addJiraIssueWorklog('pat-secret', 'SCB-213', worklog, {
    baseUrl: 'https://jira.example.com',
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('dry run must not call Jira');
    }
  }));

  assert.equal(fetchCalls, 0);
  assert.equal(isJiraDryRunResult(result), true);
  assert.deepEqual(result, {
    dryRun: true,
    method: 'POST',
    path: '/rest/api/2/issue/SCB-213/worklog?adjustEstimate=leave',
    body: worklog
  });
  assertNoCredentials(result);
});

test('jiraApiFetch stubs every non-GET method in dry run but still reads', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(options.method);
    return jsonResponse({ id: '10001' });
  };

  await withEnv({ LOGWORK_DRY_RUN: '1' }, async () => {
    const put = await jiraApiFetch('pat-secret', '/rest/api/2/issue/SCB-213/worklog/10001', {
      baseUrl: 'https://jira.example.com',
      fetchImpl,
      method: 'PUT',
      body: { timeSpentSeconds: 3600 }
    });
    assert.deepEqual(put, {
      dryRun: true,
      method: 'PUT',
      path: '/rest/api/2/issue/SCB-213/worklog/10001',
      body: { timeSpentSeconds: 3600 }
    });

    const del = await jiraApiFetch('pat-secret', '/rest/api/2/issue/SCB-213/worklog/10001', {
      baseUrl: 'https://jira.example.com',
      fetchImpl,
      method: 'DELETE'
    });
    assert.deepEqual(del, {
      dryRun: true,
      method: 'DELETE',
      path: '/rest/api/2/issue/SCB-213/worklog/10001'
    });

    const property = await jiraApiFetch('pat-secret', '/rest/api/2/issue/SCB-213/properties/lh', {
      baseUrl: 'https://jira.example.com',
      fetchImpl,
      method: 'put',
      body: { value: 1 }
    });
    assert.equal(property.method, 'PUT');
    for (const result of [put, del, property]) {
      assertNoCredentials(result);
    }
    assert.deepEqual(calls, []);

    const read = await jiraApiFetch('pat-secret', '/rest/api/2/issue/SCB-213', {
      baseUrl: 'https://jira.example.com',
      fetchImpl
    });
    assert.deepEqual(read, { id: '10001' });
    assert.deepEqual(calls, ['GET']);
  });
});

test('jiraApiFetch writes normally when LOGWORK_DRY_RUN is not 1', async () => {
  let fetchCalls = 0;
  const result = await withEnv({ LOGWORK_DRY_RUN: '0' }, () => addJiraIssueWorklog('pat-secret', 'SCB-213', {
    started: '2026-06-01T09:00:00.000+0700',
    timeSpentSeconds: 3600,
    comment: 'Task'
  }, {
    baseUrl: 'https://jira.example.com',
    fetchImpl: async () => {
      fetchCalls += 1;
      return jsonResponse({ id: '10002', timeSpentSeconds: 3600 }, { status: 201, statusText: 'Created' });
    }
  }));

  assert.equal(fetchCalls, 1);
  assert.equal(result.id, '10002');
  assert.equal(isJiraDryRunResult(result), false);
});

function assertNoCredentials(value) {
  const text = JSON.stringify(value);
  assert.doesNotMatch(text, /pat-secret/);
  assert.doesNotMatch(text, /authorization/i);
  assert.doesNotMatch(text, /bearer/i);
  assert.equal('headers' in value, false);
}

function jsonResponse(value, { status = 200, statusText = 'OK' } = {}) {
  return new Response(JSON.stringify(value), {
    status,
    statusText,
    headers: {
      'Content-Type': 'application/json'
    }
  });
}
