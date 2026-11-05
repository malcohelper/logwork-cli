import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  deleteLogworkEntry,
  getLogworkDay,
  getLogworkRejected,
  normalizeLogworkF03Entry,
  resubmitLogworkEntry
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

test('normalizeLogworkF03Entry maps staff metadata fields', () => {
  const entry = normalizeLogworkF03Entry({
    id: 42,
    status: 'rejected',
    type_of_work: 'correct',
    worklog_task_id: 10,
    description: 'Fix typo',
    rejection_comment: 'Too vague',
    note_to_pm: 'Retrying',
    effort_hours: 1.5,
    task_name: 'Maintenance'
  });

  assert.equal(entry.id, 42);
  assert.equal(entry.status, 'rejected');
  assert.equal(entry.typeOfWork, 'correct');
  assert.equal(entry.worklogTaskId, 10);
  assert.equal(entry.description, 'Fix typo');
  assert.equal(entry.rejectionComment, 'Too vague');
  assert.equal(entry.noteToPm, 'Retrying');
  assert.equal(entry.hours, 1.5);
});

test('getLogworkDay normalizes lock flag and nested entries', async () => {
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = new URL(url);
    return new Response(JSON.stringify({
      data: {
        date: '2026-06-01',
        is_locked: true,
        entries: [{
          id: 1,
          status: 'approved',
          type_of_work: 'other',
          worklog_task_id: 5,
          effort_hours: 2,
          task_name: 'Task A'
        }]
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  const day = await getLogworkDay('token', { date: '2026-06-01', projectId: 643 });
  assert.equal(requestedUrl.searchParams.get('date'), '2026-06-01');
  assert.equal(requestedUrl.searchParams.get('project_id'), '643');
  assert.equal(day.isLocked, true);
  assert.equal(day.entries[0].worklogTaskId, 5);
});

test('getLogworkRejected maps list payload', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: [{ id: 9, status: 'rejected', effort_hours: 1, task_name: 'X' }]
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });

  const rows = await getLogworkRejected('token');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'rejected');
});

test('resubmitLogworkEntry dry-run builds PATCH body', async () => {
  process.env.LOGWORK_DRY_RUN = '1';
  const result = await resubmitLogworkEntry('token', 99, {
    effortHours: 2,
    typeOfWork: 'improve',
    noteToPm: 'Please review',
    description: 'Updated scope'
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.method, 'PATCH');
  assert.match(result.path, /\/logwork\/entries\/99\/resubmit$/);
  assert.deepEqual(result.body, {
    effort_hours: 2,
    type_of_work: 'improve',
    note_to_pm: 'Please review',
    description: 'Updated scope'
  });
});

test('deleteLogworkEntry dry-run issues DELETE', async () => {
  process.env.LOGWORK_DRY_RUN = '1';
  const result = await deleteLogworkEntry('token', 77);
  assert.equal(result.dryRun, true);
  assert.equal(result.method, 'DELETE');
  assert.match(result.path, /\/logwork\/entries\/77$/);
});
