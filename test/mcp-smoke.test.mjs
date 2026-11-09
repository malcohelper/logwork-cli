import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { withEnv } from './helpers/env.mjs';
import {
  applyCachedJiraWork,
  assertNoFinalProjectOverrides,
  consumeApprovedBatch,
  consumeApprovedJiraBatch,
  consumeApprovedRoEditPreview,
  getCachedPreview,
  getCachedJiraPreview,
  getCachedRoEditPreview,
  resolveApprovedBatch,
  resolveApprovedJiraBatch,
  resolveApprovedRoEditPreview,
  setCachedPreview,
  setCachedJiraPreview,
  setCachedRoEditPreview
} from '../lib/mcp-server.mjs';

test('MCP server lists logwork tools over stdio', async () => {
  const helperHome = await mkdtemp(join(tmpdir(), 'logwork-cli-home-'));
  const client = new Client({
    name: 'logwork-test-client',
    version: '0.1.0'
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['bin/logwork.mjs', 'mcp'],
    cwd: process.cwd(),
    env: {
      LOGWORK_HOME: helperHome
    },
    stderr: 'pipe'
  });

  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion().name, 'logwork');
    const result = await client.listTools();
    const names = result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      'delete_entry',
      'draft_from_commits',
      'edit_entry',
      'get_history',
      'get_jira_issue',
      'get_logwork',
      'list_projects',
      'list_tasks',
      'log_jira_work',
      'log_work',
      'login',
      'map_project',
      'reconcile',
      'reminder',
      'resubmit_entry',
      'update'
    ]);
    const tools = Object.fromEntries(result.tools.map((tool) => [tool.name, tool]));
    const params = (name) => Object.keys(tools[name].inputSchema.properties || {}).sort();

    const instructions = client.getInstructions();
    assert.match(instructions, /\+<hours> <worklog task> \| <description>/);
    assert.match(instructions, /confirm: true/);
    assert.match(instructions, /get_logwork \(what is booked\/logged\) -> draft_from_commits/);
    assert.doesNotMatch(instructions, /preview_|apply_|start_auth_login/);

    for (const tool of result.tools) {
      assert.ok(tool.title, `${tool.name} has a title`);
      assert.ok(tool.description, `${tool.name} has a description`);
      assert.ok(tool.annotations, `${tool.name} has annotations`);
      assert.equal(typeof tool.annotations.readOnlyHint, 'boolean', `${tool.name} declares readOnlyHint`);
      for (const [param, schema] of Object.entries(tool.inputSchema.properties || {})) {
        assert.ok(schema.description, `${tool.name}.${param} has a description`);
        assert.ok(!['password', 'otp', 'pat', 'token', 'username'].includes(param), `${tool.name} never accepts ${param}`);
      }
    }

    for (const name of ['get_logwork', 'draft_from_commits', 'list_projects', 'list_tasks', 'get_jira_issue', 'reconcile', 'get_history']) {
      assert.equal(tools[name].annotations.readOnlyHint, true, `${name} is read-only`);
    }
    for (const name of ['edit_entry', 'delete_entry']) {
      assert.equal(tools[name].annotations.destructiveHint, true, `${name} is destructive`);
    }
    for (const name of ['log_work', 'log_jira_work', 'resubmit_entry']) {
      assert.equal(tools[name].annotations.readOnlyHint, false);
      assert.equal(tools[name].annotations.destructiveHint, false);
      assert.match(tools[name].description, /Two calls/);
      assert.equal(tools[name].inputSchema.properties.confirm.type, 'boolean');
    }

    assert.deepEqual(params('log_work'), ['allowUnbooked', 'batchId', 'confirm', 'defaultWorklogTask', 'projectOverrides', 'text', 'typeOfWork']);
    assert.match(tools.log_work.description, /Resource Optimiser only/);
    assert.match(tools.log_work.description, /Use log_jira_work for Jira/);
    assert.deepEqual(params('log_jira_work'), ['batchId', 'confirm', 'text']);
    assert.match(tools.log_jira_work.description, /Jira only/);
    assert.deepEqual(params('edit_entry'), ['confirm', 'description', 'hours', 'logworkId', 'previewId', 'taskName', 'typeOfWork']);
    assert.match(tools.edit_entry.description, /Project and date never change/);
    assert.match(tools.edit_entry.description, /replaces the entry/);
    assert.deepEqual(params('resubmit_entry'), ['confirm', 'description', 'hours', 'logworkId', 'noteToPm', 'previewId', 'typeOfWork']);
    assert.deepEqual(params('delete_entry'), ['confirm', 'logworkId', 'previewId']);
    assert.deepEqual(params('list_tasks'), ['projectId']);
    assert.deepEqual(params('get_logwork'), ['includeEntries', 'period', 'project']);
    assert.deepEqual(tools.get_logwork.inputSchema.properties.period.enum, ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month']);
    assert.deepEqual(params('reconcile'), ['period']);
    assert.deepEqual(tools.get_history.inputSchema.properties.target.enum, ['ro', 'jira', 'both']);
    assert.deepEqual(params('map_project'), ['confirm', 'keywords', 'projectMemberId', 'projectName', 'scope', 'tickets']);
    assert.deepEqual(tools.map_project.inputSchema.properties.scope.enum, ['user', 'project']);
    assert.deepEqual(params('login'), ['target']);
    assert.deepEqual(tools.login.inputSchema.properties.target.enum, ['ro', 'jira']);
    assert.deepEqual(params('reminder'), ['action', 'confirm', 'target', 'time']);
    assert.deepEqual(tools.reminder.inputSchema.properties.action.enum, ['status', 'enable', 'disable', 'test']);
    assert.deepEqual(params('update'), ['action', 'confirm', 'force', 'version']);
    assert.deepEqual(params('get_jira_issue'), ['issueKey']);
    assert.deepEqual(params('draft_from_commits'), ['author', 'period', 'repos', 'useBookings']);
    assert.match(tools.draft_from_commits.description, /draftText/);
    assert.match(instructions, /draft_from_commits/);
    assert.match(instructions, /never invent work/);

    const prompts = await client.listPrompts();
    assert.deepEqual(prompts.prompts.map((prompt) => prompt.name), ['log_from_commits']);
    const prompt = await client.getPrompt({ name: 'log_from_commits', arguments: { period: 'yesterday' } });
    assert.match(prompt.messages[0].content.text, /draft_from_commits/);
    assert.match(prompt.messages[0].content.text, /Period: yesterday/);

    const call = (name, args) => client.callTool({ name, arguments: args });

    const preview = await call('log_work', { text: 'not a valid weekly log' });
    assert.notEqual(preview.isError, true);
    assert.match(preview.content[0].text, /parse errors/);

    const applyWithText = await call('log_work', { text: 'Monday, 01 Jun 2026\n+1 Bug Fix | x', confirm: true });
    assert.equal(applyWithText.isError, true);
    assert.match(applyWithText.content[0].text, /do not pass text/);

    const applyWithoutId = await call('log_work', { confirm: true });
    assert.equal(applyWithoutId.isError, true);
    assert.match(applyWithoutId.content[0].text, /requires the batchId/);

    const previewWithoutText = await call('log_work', {});
    assert.equal(previewWithoutText.isError, true);
    assert.match(previewWithoutText.content[0].text, /log_work preview needs text/);

    const editWithoutId = await call('edit_entry', { hours: 1 });
    assert.equal(editWithoutId.isError, true);
    assert.match(editWithoutId.content[0].text, /edit_entry preview needs logworkId/);

    const editApplyWithChanges = await call('edit_entry', { previewId: 'ro_edit_x', hours: 2, confirm: true });
    assert.equal(editApplyWithChanges.isError, true);
    assert.match(editApplyWithChanges.content[0].text, /applies the approved preview as-is; do not pass hours/);

    const deleteUnknown = await call('delete_entry', { previewId: 'delete_1', confirm: true });
    assert.equal(deleteUnknown.isError, true);
    assert.match(deleteUnknown.content[0].text, /No cached delete_entry preview/);

    const rejectedUpdate = await call('update', { action: 'install', version: '0.1.11' });
    assert.equal(rejectedUpdate.isError, true);
    assert.match(rejectedUpdate.content[0].text, /requires confirm: true/);

    const rejectedReminder = await call('reminder', { action: 'enable', confirm: false });
    assert.equal(rejectedReminder.isError, true);
    assert.match(rejectedReminder.content[0].text, /requires confirm: true/);

    const jiraLogin = await call('login', { target: 'jira' });
    assert.notEqual(jiraLogin.isError, true);
    assert.match(jiraLogin.content[0].text, /logwork login jira/);
  } finally {
    await client.close();
  }
});

test('MCP apply rejects final project overrides at boundary', () => {
  assert.throws(() => assertNoFinalProjectOverrides({
    entry_1: 5352
  }), /belong to the log_work preview call/);
});

test('MCP preview cache expires old previews and caps stored batches', () => {
  const cache = new Map();
  const now = 1_000;

  setCachedPreview(cache, { batchId: 'expired' }, now);
  assert.equal(getCachedPreview(cache, 'expired', now + 60 * 60 * 1000), null);
  assert.equal(cache.has('expired'), false);

  for (let index = 0; index < 101; index += 1) {
    setCachedPreview(cache, { batchId: `batch-${index}` }, now);
  }

  assert.equal(cache.size, 100);
  assert.equal(getCachedPreview(cache, 'batch-0', now), null);
  assert.deepEqual(getCachedPreview(cache, 'batch-100', now), { batchId: 'batch-100' });
});

test('MCP preview cache clones previews and rejects mismatched approved batches', () => {
  const cache = new Map();
  const now = 1_000;
  const preview = createApprovedPreview();

  setCachedPreview(cache, preview, now);
  preview.entries[0].taskName = 'mutated before apply';

  const cached = getCachedPreview(cache, 'batch-safe', now);
  assert.equal(cached.entries[0].taskName, 'original task');
  cached.entries[0].taskName = 'mutated cached copy';
  assert.equal(getCachedPreview(cache, 'batch-safe', now).entries[0].taskName, 'original task');
  assert.equal(resolveApprovedBatch({ cache, batchId: 'batch-safe', now }).entries[0].taskName, 'original task');

  assert.throws(() => resolveApprovedBatch({
    cache,
    batchId: 'batch-safe',
    batch: {
      batchId: 'batch-other',
      entries: []
    },
    now
  }), /Approved batch mismatch/);
});

test('MCP apply requires cached preview provenance', () => {
  const cache = new Map();
  const now = 1_000;
  const preview = createApprovedPreview();

  assert.throws(() => resolveApprovedBatch({
    cache,
    batch: preview,
    now
  }), /requires the batchId/);

  assert.throws(() => resolveApprovedBatch({
    cache,
    batchId: preview.batchId,
    batch: preview,
    now
  }), /No cached log_work preview/);

  setCachedPreview(cache, preview, now);
  assert.throws(() => resolveApprovedBatch({
    cache,
    batchId: preview.batchId,
    now: now + 60 * 60 * 1000
  }), /No cached log_work preview/);
});

test('MCP apply rejects mutated approved batch content', () => {
  const cache = new Map();
  const now = 1_000;
  const preview = createApprovedPreview();
  setCachedPreview(cache, preview, now);

  for (const mutate of [
    (batch) => { batch.entries[0].hours = 3; },
    (batch) => { batch.entries[0].taskName = 'forged task'; },
    (batch) => { batch.entries[0].status = 'resolved_unbooked'; },
    (batch) => { batch.entries[0].matchedProject.projectMemberId = 9999; }
  ]) {
    const mutated = structuredClone(preview);
    mutate(mutated);

    assert.throws(() => resolveApprovedBatch({
      cache,
      batchId: preview.batchId,
      batch: mutated,
      now
    }), /content changed/);
  }
});

test('MCP apply accepts matching batch echo but uses cached preview', () => {
  const cache = new Map();
  const now = 1_000;
  const preview = createApprovedPreview();
  setCachedPreview(cache, preview, now);

  const matchingEcho = structuredClone(preview);
  matchingEcho.summary = 'client display text changed';

  const approved = resolveApprovedBatch({
    cache,
    batchId: preview.batchId,
    batch: matchingEcho,
    now
  });

  assert.equal(approved.summary, preview.summary);
  matchingEcho.entries[0].taskName = 'mutated after approval';
  assert.equal(getCachedPreview(cache, preview.batchId, now).entries[0].taskName, preview.entries[0].taskName);
});

test('MCP apply consumes cached approval before submit work can await', () => {
  const cache = new Map();
  const now = 1_000;
  const preview = createApprovedPreview();
  setCachedPreview(cache, preview, now);

  const approved = consumeApprovedBatch({
    cache,
    batchId: preview.batchId,
    now
  });

  assert.equal(approved.entries[0].taskName, 'original task');
  assert.equal(getCachedPreview(cache, preview.batchId, now), null);
  assert.throws(() => consumeApprovedBatch({
    cache,
    batchId: preview.batchId,
    now
  }), /No cached log_work preview/);
});

test('MCP Jira preview cache expires old previews and caps stored batches', () => {
  const cache = new Map();
  const now = 1_000;

  setCachedJiraPreview(cache, { batchId: 'expired' }, now);
  assert.equal(getCachedJiraPreview(cache, 'expired', now + 60 * 60 * 1000), null);
  assert.equal(cache.has('expired'), false);

  for (let index = 0; index < 101; index += 1) {
    setCachedJiraPreview(cache, { batchId: `jira-batch-${index}` }, now);
  }

  assert.equal(cache.size, 100);
  assert.equal(getCachedJiraPreview(cache, 'jira-batch-0', now), null);
  assert.deepEqual(getCachedJiraPreview(cache, 'jira-batch-100', now), { batchId: 'jira-batch-100' });
});

test('MCP Jira apply requires cached preview provenance', () => {
  const cache = new Map();
  const now = 1_000;
  const preview = createApprovedJiraPreview();

  assert.throws(() => resolveApprovedJiraBatch({
    cache,
    batch: preview,
    now
  }), /requires the batchId/);

  assert.throws(() => resolveApprovedJiraBatch({
    cache,
    batchId: preview.batchId,
    batch: preview,
    now
  }), /No cached log_jira_work preview/);

  setCachedJiraPreview(cache, preview, now);
  assert.throws(() => resolveApprovedJiraBatch({
    cache,
    batchId: preview.batchId,
    now: now + 60 * 60 * 1000
  }), /No cached log_jira_work preview/);
});

test('MCP Jira apply rejects mutated approved batch content', () => {
  const cache = new Map();
  const now = 1_000;
  const preview = createApprovedJiraPreview();
  setCachedJiraPreview(cache, preview, now);

  for (const mutate of [
    (batch) => { batch.entries[0].hours = 3; },
    (batch) => { batch.entries[0].taskName = 'forged task'; },
    (batch) => { batch.entries[0].status = 'duplicate'; },
    (batch) => { batch.entries[0].issue.summary = 'forged issue'; },
    (batch) => { batch.entries[0].duplicate = { id: 'new-duplicate' }; }
  ]) {
    const mutated = structuredClone(preview);
    mutate(mutated);

    assert.throws(() => resolveApprovedJiraBatch({
      cache,
      batchId: preview.batchId,
      batch: mutated,
      now
    }), /content changed/);
  }
});

test('MCP Jira apply accepts matching batch echo and consumes cached preview', () => {
  const cache = new Map();
  const now = 1_000;
  const preview = createApprovedJiraPreview();
  setCachedJiraPreview(cache, preview, now);

  const matchingEcho = structuredClone(preview);
  matchingEcho.summary = 'client display text changed';

  const approved = resolveApprovedJiraBatch({
    cache,
    batchId: preview.batchId,
    batch: matchingEcho,
    now
  });

  assert.equal(approved.summary, preview.summary);
  const consumed = consumeApprovedJiraBatch({
    cache,
    batchId: preview.batchId,
    now
  });
  assert.equal(consumed.entries[0].issueKey, 'SCB-213');
  assert.equal(getCachedJiraPreview(cache, preview.batchId, now), null);
});

test('MCP RO edit cache expires, rejects mutations, and consumes approved preview', () => {
  const cache = new Map();
  const now = 1_000;
  const preview = createApprovedRoEditPreview();

  setCachedRoEditPreview(cache, preview, now);
  assert.equal(getCachedRoEditPreview(cache, preview.previewId, now).updated.hours, 0.5);

  const mutated = structuredClone(preview);
  mutated.updated.taskName = 'forged task';
  assert.throws(() => resolveApprovedRoEditPreview({
    cache,
    previewId: preview.previewId,
    preview: mutated,
    now
  }), /changed after preview/);

  const approved = consumeApprovedRoEditPreview({
    cache,
    previewId: preview.previewId,
    preview,
    now
  });
  assert.equal(approved.original.taskName, 'original task');
  assert.equal(getCachedRoEditPreview(cache, preview.previewId, now), null);

  setCachedRoEditPreview(cache, preview, now);
  assert.equal(getCachedRoEditPreview(cache, preview.previewId, now + 60 * 60 * 1000), null);
});

function createApprovedPreview() {
  return {
    batchId: 'batch-safe',
    status: 'ready',
    errors: [],
    entries: [
      {
        id: 'entry_1',
        date: '2026-06-01',
        hours: 2,
        taskName: 'original task',
        tickets: ['SCB-213'],
        status: 'resolved',
        reason: 'single_booked_project',
        confidence: 0.95,
        matchedProject: {
          projectMemberId: 5352,
          projectId: 1,
          projectName: 'Course Builder'
        },
        booked: true,
        requiresAllowUnbooked: false
      }
    ],
    summary: 'Logwork preview:\n- 2026-06-01: +2h Course Builder - original task'
  };
}

test('MCP log_jira_work apply in dry run states the dry run and sends no worklog', async () => {
  const cache = new Map();
  const now = Date.now();
  const preview = createApprovedJiraPreview();
  setCachedJiraPreview(cache, preview, now);
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('dry run must not call Jira');
  };

  try {
    const response = await withEnv({ LOGWORK_DRY_RUN: '1' }, () => applyCachedJiraWork({
      cache,
      batchId: preview.batchId,
      confirm: true,
      now,
      applyOptions: {
        getSession: async () => ({ baseUrl: 'https://jira.example.com', token: 'pat-secret' }),
        fetchWorklogs: async () => [],
        recordLedger: null
      }
    }));

    assert.equal(fetchCalls, 0);
    assert.match(response.content[0].text, /^DRY RUN \(LOGWORK_DRY_RUN=1\)/);
    assert.equal(response.structuredContent.status, 'dry_run');
    assert.equal(response.structuredContent.dryRun, true);
    assert.equal(response.structuredContent.results[0].request.method, 'POST');
    assert.doesNotMatch(response.content[0].text, /pat-secret|authorization|bearer/i);
    assert.equal(getCachedJiraPreview(cache, preview.batchId, now), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function createApprovedJiraPreview() {
  return {
    batchId: 'jira-batch-safe',
    status: 'ready',
    errors: [],
    entries: [
      {
        id: 'entry_1',
        batchId: 'jira-batch-safe',
        date: '2026-06-01',
        hours: 2,
        taskName: 'original task',
        tickets: ['SCB-213'],
        issueKey: 'SCB-213',
        issue: {
          key: 'SCB-213',
          summary: 'Maintenance mode',
          status: 'In Progress',
          issueType: 'Task'
        },
        status: 'ready',
        reason: 'single_issue_key'
      }
    ],
    summary: 'Jira worklog preview: ready. 1 entries, 2h total.'
  };
}

function createApprovedRoEditPreview() {
  return {
    previewId: 'ro_edit_safe',
    status: 'ready',
    logworkId: 290364,
    original: {
      id: 290364,
      projectMemberId: 5234,
      projectId: 2621,
      projectName: 'Course Builder',
      date: '2026-07-15',
      hours: 1,
      taskName: 'original task',
      status: 'submitted',
      source: 'manual'
    },
    updated: {
      id: 290364,
      projectMemberId: 5234,
      projectId: 2621,
      projectName: 'Course Builder',
      date: '2026-07-15',
      hours: 0.5,
      taskName: 'original task',
      status: 'submitted',
      source: 'manual'
    },
    changes: {
      hours: { from: 1, to: 0.5 },
      taskName: null
    },
    originalFingerprint: 'source-revision',
    summary: 'RO edit ready.'
  };
}

test('MCP resubmit and delete previews are cached by previewId (regression)', () => {
  const cache = new Map();
  const now = 1_000;
  const deletePreview = {
    previewId: 'delete_304032',
    status: 'ready',
    logworkId: 304032,
    original: { id: 304032, hours: 1, status: 'approved', taskName: 'Bug Fix' },
    originalFingerprint: 'fp',
    summary: 'RO logwork delete preview'
  };
  setCachedRoEditPreview(cache, deletePreview, now);
  const approved = consumeApprovedRoEditPreview({ cache, previewId: 'delete_304032', toolName: 'delete_entry', now });
  assert.equal(approved.logworkId, 304032);
  assert.throws(() => consumeApprovedRoEditPreview({ cache, previewId: 'delete_304032', toolName: 'delete_entry', now }), /No cached delete_entry preview/);
});
