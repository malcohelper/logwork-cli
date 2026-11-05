import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  addLogtime,
  createLogworkEntry,
  fetchWorklogTasksForProject,
  getDefaultWorklogTasks,
  getWorklogTasks
} from '../lib/api.mjs';

const originalFetch = globalThis.fetch;
const originalDryRun = process.env.LOGWORK_DRY_RUN;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalDryRun === undefined) {
    delete process.env.LOGWORK_DRY_RUN;
  } else {
    process.env.LOGWORK_DRY_RUN = originalDryRun;
  }
});

test('getWorklogTasks requests project scoped tasks', async () => {
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = new URL(url);
    return new Response(JSON.stringify({
      data: [{ id: 10, name: 'Task A', project_id: 643 }]
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  const tasks = await getWorklogTasks('token', { projectId: 643, search: 'Task' });
  assert.equal(requestedUrl.pathname, '/api/v1/logwork/tasks');
  assert.equal(requestedUrl.searchParams.get('project_id'), '643');
  assert.equal(requestedUrl.searchParams.get('search'), 'Task');
  assert.equal(tasks[0].id, 10);
  assert.equal(tasks[0].name, 'Task A');
});

test('getDefaultWorklogTasks requests defaults endpoint', async () => {
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = new URL(url);
    return new Response(JSON.stringify({
      data: [{ id: 20, name: 'Other', project_id: null, is_default: true }]
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  const tasks = await getDefaultWorklogTasks('token', { projectId: 643 });
  assert.equal(requestedUrl.pathname, '/api/v1/logwork/tasks/defaults');
  assert.equal(tasks[0].id, 20);
});

test('createLogworkEntry dry-run posts approved-entry payload', async () => {
  process.env.LOGWORK_DRY_RUN = '1';
  const result = await createLogworkEntry('token', {
    worklogTaskId: 10,
    projectId: 643,
    effortHours: 2,
    localDateISO: '2026-06-01',
    typeOfWork: 'other',
    needsProjectId: true
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.method, 'POST');
  assert.equal(result.path, '/logwork/entries');
  assert.deepEqual(result.body, {
    worklog_task_id: 10,
    effort_hours: 2,
    logdate: '2026-06-01',
    type_of_work: 'other',
    project_id: 643
  });
});

test('fetchWorklogTasksForProject caches merged tasks per project', async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/defaults')) {
      return new Response(JSON.stringify({ data: [{ id: 2, name: 'Default', project_id: null }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ data: [{ id: 1, name: 'Project task', project_id: 643 }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  const cache = new Map();
  const first = await fetchWorklogTasksForProject('token', 643, { cache });
  const second = await fetchWorklogTasksForProject('token', 643, { cache });
  assert.equal(first.length, 2);
  assert.equal(second.length, 2);
  assert.equal(calls.length, 2);
});

test('fetchWorklogTasksForProject does not pass task cache Map into fetch cache option', async () => {
  const fetchOptions = [];
  globalThis.fetch = async (_url, init = {}) => {
    fetchOptions.push(init);
    return new Response(JSON.stringify({ data: [{ id: 1, name: 'Task', project_id: 643 }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  await fetchWorklogTasksForProject('token', 643, { cache: new Map() });
  assert.ok(fetchOptions.length >= 1);
  for (const init of fetchOptions) {
    assert.notEqual(init.cache instanceof Map, true);
    assert.equal(init.cache, undefined);
  }
});

test('addLogtime resolves task name then creates logwork entry', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body });
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/defaults')) {
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (pathname.endsWith('/tasks')) {
      return new Response(JSON.stringify({
        data: [{ id: 55, name: 'Maintenance mode', project_id: 643 }]
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ data: { id: 999, status: 'approved' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  const result = await addLogtime('token', {
    projectMemberId: 5352,
    projectId: 643,
    logtimes: 2,
    taskName: 'Maintenance mode',
    localDateISO: '2026-06-01'
  });

  const postCall = calls.find((call) => call.method === 'POST');
  assert.ok(postCall);
  assert.equal(new URL(postCall.url).pathname, '/api/v1/logwork/entries');
  assert.deepEqual(JSON.parse(postCall.body), {
    worklog_task_id: 55,
    effort_hours: 2,
    logdate: '2026-06-01',
    type_of_work: 'other'
  });
  assert.equal(result.entry?.id, 999);
});
