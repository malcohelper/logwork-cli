import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
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
} from '../mcp-server.mjs';

test('MCP server lists logwork tools over stdio', async () => {
  const helperHome = await mkdtemp(join(tmpdir(), 'logwork-helper-home-'));
  const client = new Client({
    name: 'logwork-helper-test-client',
    version: '0.1.0'
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['mcp-server.mjs'],
    cwd: process.cwd(),
    env: {
      LOGWORK_HELPER_HOME: helperHome
    },
    stderr: 'pipe'
  });

  try {
    await client.connect(transport);
    const result = await client.listTools();
    const names = result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      'apply_jira_worklog_batch',
      'apply_logwork_batch',
      'apply_ro_logwork_delete',
      'apply_ro_logwork_edit',
      'apply_ro_logwork_resubmit',
      'apply_update',
      'check_for_updates',
      'configure_logwork_reminder',
      'delete_ro_logwork_entry',
      'get_jira_issue',
      'get_logwork_reminder',
      'list_logwork_projects',
      'preview_jira_worklog_batch',
      'preview_logwork_batch',
      'preview_ro_logwork_delete',
      'preview_ro_logwork_edit',
      'preview_ro_logwork_resubmit',
      'query_apply_history',
      'query_logwork',
      'reconcile_logwork',
      'start_auth_login',
      'start_jira_auth',
      'test_logwork_reminder',
      'upsert_project_mapping'
    ]);
    const applyTool = result.tools.find((tool) => tool.name === 'apply_logwork_batch');
    assert.match(applyTool.description, /Resource Optimiser only/);
    assert.match(applyTool.description, /Does not write Jira/);
    assert.equal(applyTool.inputSchema.properties.allowUnbooked.type, 'boolean');
    assert.equal(applyTool.inputSchema.properties.projectOverrides.type, 'object');
    const setupTool = result.tools.find((tool) => tool.name === 'upsert_project_mapping');
    assert.equal(setupTool.inputSchema.properties.confirm.type, 'boolean');
    assert.deepEqual(setupTool.inputSchema.properties.scope.enum, ['user', 'project']);
    const queryTool = result.tools.find((tool) => tool.name === 'query_logwork');
    assert.deepEqual(queryTool.inputSchema.properties.period.enum, ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month']);
    assert.equal(queryTool.inputSchema.properties.date, undefined);
    assert.equal(queryTool.inputSchema.properties.from, undefined);
    assert.equal(queryTool.inputSchema.properties.to, undefined);
    const roEditPreviewTool = result.tools.find((tool) => tool.name === 'preview_ro_logwork_edit');
    assert.match(roEditPreviewTool.description, /Project and date are always preserved/);
    assert.deepEqual(Object.keys(roEditPreviewTool.inputSchema.properties).sort(), ['hours', 'logworkId', 'taskName']);
    const roEditApplyTool = result.tools.find((tool) => tool.name === 'apply_ro_logwork_edit');
    assert.deepEqual(Object.keys(roEditApplyTool.inputSchema.properties).sort(), ['confirm', 'preview', 'previewId']);
    assert.equal(roEditApplyTool.inputSchema.properties.confirm.type, 'boolean');
    const reconciliationTool = result.tools.find((tool) => tool.name === 'reconcile_logwork');
    assert.match(reconciliationTool.description, /Read-only/);
    assert.deepEqual(reconciliationTool.inputSchema.properties.period.enum, ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month']);
    assert.equal(reconciliationTool.inputSchema.properties.date, undefined);
    assert.equal(reconciliationTool.inputSchema.properties.from, undefined);
    assert.equal(reconciliationTool.inputSchema.properties.to, undefined);
    assert.equal(reconciliationTool.inputSchema.properties.confirm, undefined);
    assert.equal(reconciliationTool.inputSchema.properties.token, undefined);
    const historyTool = result.tools.find((tool) => tool.name === 'query_apply_history');
    assert.deepEqual(historyTool.inputSchema.properties.target.enum, ['ro', 'jira', 'both']);
    assert.equal(historyTool.inputSchema.properties.token, undefined);
    const updateCheckTool = result.tools.find((tool) => tool.name === 'check_for_updates');
    assert.deepEqual(Object.keys(updateCheckTool.inputSchema.properties), ['force']);
    const applyUpdateTool = result.tools.find((tool) => tool.name === 'apply_update');
    assert.deepEqual(Object.keys(applyUpdateTool.inputSchema.properties).sort(), ['confirm', 'version']);
    assert.equal(applyUpdateTool.inputSchema.properties.confirm.type, 'boolean');
    assert.equal(applyUpdateTool.inputSchema.properties.command, undefined);
    assert.equal(applyUpdateTool.inputSchema.properties.registry, undefined);
    assert.equal(applyUpdateTool.inputSchema.properties.token, undefined);
    const reminderStatusTool = result.tools.find((tool) => tool.name === 'get_logwork_reminder');
    assert.deepEqual(reminderStatusTool.inputSchema.properties, {});
    const reminderConfigTool = result.tools.find((tool) => tool.name === 'configure_logwork_reminder');
    assert.deepEqual(reminderConfigTool.inputSchema.properties.action.enum, ['enable', 'disable']);
    assert.deepEqual(reminderConfigTool.inputSchema.properties.target.enum, ['ro', 'jira', 'both']);
    assert.equal(reminderConfigTool.inputSchema.properties.confirm.type, 'boolean');
    assert.equal(reminderConfigTool.inputSchema.properties.command, undefined);
    assert.equal(reminderConfigTool.inputSchema.properties.path, undefined);
    assert.equal(reminderConfigTool.inputSchema.properties.token, undefined);
    const reminderTestTool = result.tools.find((tool) => tool.name === 'test_logwork_reminder');
    assert.deepEqual(Object.keys(reminderTestTool.inputSchema.properties).sort(), ['confirm', 'target']);
    const authTool = result.tools.find((tool) => tool.name === 'start_auth_login');
    assert.deepEqual(authTool.inputSchema.properties, {});
    assert.equal(authTool.inputSchema.properties.password, undefined);
    assert.equal(authTool.inputSchema.properties.otp, undefined);
    const jiraAuthTool = result.tools.find((tool) => tool.name === 'start_jira_auth');
    assert.deepEqual(jiraAuthTool.inputSchema.properties, {});
    const jiraIssueTool = result.tools.find((tool) => tool.name === 'get_jira_issue');
    assert.deepEqual(Object.keys(jiraIssueTool.inputSchema.properties), ['issueKey']);
    const jiraPreviewTool = result.tools.find((tool) => tool.name === 'preview_jira_worklog_batch');
    assert.match(jiraPreviewTool.description, /Jira only/);
    assert.deepEqual(Object.keys(jiraPreviewTool.inputSchema.properties), ['text']);
    const jiraApplyTool = result.tools.find((tool) => tool.name === 'apply_jira_worklog_batch');
    assert.match(jiraApplyTool.description, /Does not write Resource Optimiser/);
    assert.deepEqual(Object.keys(jiraApplyTool.inputSchema.properties).sort(), ['batch', 'batchId', 'confirm']);
    assert.equal(jiraApplyTool.inputSchema.properties.confirm.type, 'boolean');
    for (const tool of [roEditPreviewTool, roEditApplyTool, jiraAuthTool, jiraIssueTool, jiraPreviewTool, jiraApplyTool]) {
      assert.equal(tool.inputSchema.properties.password, undefined);
      assert.equal(tool.inputSchema.properties.pat, undefined);
      assert.equal(tool.inputSchema.properties.token, undefined);
      assert.equal(tool.inputSchema.properties.username, undefined);
    }

    const preview = await client.callTool({
      name: 'preview_logwork_batch',
      arguments: {
        text: 'not a valid weekly log'
      }
    });
    assert.notEqual(preview.isError, true);
    assert.match(preview.content[0].text, /parse errors/);

    const rejectedUpdate = await client.callTool({
      name: 'apply_update',
      arguments: {
        version: '0.1.11',
        confirm: false
      }
    });
    assert.equal(rejectedUpdate.isError, true);
    assert.match(rejectedUpdate.content[0].text, /requires confirm: true/);

    const rejectedReminder = await client.callTool({
      name: 'configure_logwork_reminder',
      arguments: {
        action: 'enable',
        confirm: false
      }
    });
    assert.equal(rejectedReminder.isError, true);
    assert.match(rejectedReminder.content[0].text, /requires confirm: true/);

    const rejectedRoEdit = await client.callTool({
      name: 'apply_ro_logwork_edit',
      arguments: {
        previewId: 'ro_edit_test',
        confirm: false
      }
    });
    assert.equal(rejectedRoEdit.isError, true);
    assert.match(rejectedRoEdit.content[0].text, /requires confirm: true/);
  } finally {
    await client.close();
  }
});

test('MCP apply rejects final project overrides at boundary', () => {
  assert.throws(() => assertNoFinalProjectOverrides({
    entry_1: 5352
  }), /no longer accepts final projectOverrides/);
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
  }), /requires batchId/);

  assert.throws(() => resolveApprovedBatch({
    cache,
    batchId: preview.batchId,
    batch: preview,
    now
  }), /Missing cached preview/);

  setCachedPreview(cache, preview, now);
  assert.throws(() => resolveApprovedBatch({
    cache,
    batchId: preview.batchId,
    now: now + 60 * 60 * 1000
  }), /Missing cached preview/);
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
  }), /Missing cached preview/);
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
  }), /requires batchId/);

  assert.throws(() => resolveApprovedJiraBatch({
    cache,
    batchId: preview.batchId,
    batch: preview,
    now
  }), /Missing cached Jira preview/);

  setCachedJiraPreview(cache, preview, now);
  assert.throws(() => resolveApprovedJiraBatch({
    cache,
    batchId: preview.batchId,
    now: now + 60 * 60 * 1000
  }), /Missing cached Jira preview/);
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
