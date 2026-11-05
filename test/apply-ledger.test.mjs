import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadApplyLedger,
  queryApplyLedger,
  recordApplyResult,
  recordApplyResultSafely
} from '../lib/apply-ledger.mjs';
import { parseHistoryArgs, runHistoryCommand } from '../history-cli.mjs';

test('apply ledger stores sanitized local outcomes and filters Both flows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'logwork-ledger-'));
  const path = join(dir, 'apply-ledger.json');

  await recordApplyResult({
    id: 'record-ro',
    timestamp: '2026-07-15T02:00:00.000Z',
    target: 'ro',
    flowTarget: 'both',
    batchId: 'batch-ro',
    status: 'partial_failed',
    cwd: '/workspace/project',
    entries: [
      { entryId: 'one', date: '2026-07-15', hours: 2, taskName: 'Ready', status: 'submitted' },
      { entryId: 'two', date: '2026-07-15', hours: 1, taskName: 'Failed', status: 'failed', error: 'token=secret Bearer abc.def' }
    ]
  }, { path });
  await recordApplyResult({
    id: 'record-jira',
    timestamp: '2026-07-15T03:00:00.000Z',
    target: 'jira',
    batchId: 'batch-jira',
    status: 'submitted',
    cwd: '/workspace/project',
    entries: [
      { entryId: 'jira-one', date: '2026-07-15', hours: 1, taskName: 'Jira task', issueKey: 'SCB-213', status: 'submitted' }
    ]
  }, { path });

  const records = await loadApplyLedger({ path });
  assert.deepEqual(records.map((record) => record.id), ['record-jira', 'record-ro']);
  assert.equal(records[1].summary.submittedCount, 1);
  assert.equal(records[1].summary.failedCount, 1);
  assert.equal(records[1].entries[1].error, 'token=<redacted> Bearer <redacted>');
  assert.doesNotMatch(await readFile(path, 'utf8'), /abc\.def|token=secret/);

  const both = await queryApplyLedger({ path, target: 'both' });
  assert.deepEqual(both.records.map((record) => record.id), ['record-ro']);
  assert.match(both.summary, /ro via both partial_failed/);

  const jira = await queryApplyLedger({ path, target: 'jira', cwd: '/workspace/project', limit: 1 });
  assert.deepEqual(jira.records.map((record) => record.id), ['record-jira']);
});

test('apply ledger caps records and reports non-blocking writer failures', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'logwork-ledger-cap-'));
  const path = join(dir, 'apply-ledger.json');

  for (let index = 0; index < 3; index += 1) {
    await recordApplyResult({
      id: `record-${index}`,
      timestamp: `2026-07-15T0${index}:00:00.000Z`,
      target: 'ro',
      batchId: `batch-${index}`,
      status: 'submitted',
      entries: []
    }, { path, maxRecords: 2 });
  }

  assert.deepEqual((await loadApplyLedger({ path })).map((record) => record.id), ['record-2', 'record-1']);
  assert.deepEqual(await recordApplyResultSafely(async () => {
    throw new Error('disk unavailable');
  }, {}), {
    status: 'failed',
    recorded: false,
    error: 'disk unavailable'
  });
});

test('history CLI parses filters and renders ledger summary or JSON', async () => {
  assert.deepEqual(parseHistoryArgs(['--target', 'jira', '--limit', '5', '--json']), {
    target: 'jira',
    limit: 5,
    json: true
  });
  const printed = [];
  await runHistoryCommand(['--target', 'ro'], {
    query: async (args) => ({
      status: 'ok',
      args,
      summary: 'Apply history: 0 records.'
    }),
    print: (line) => printed.push(line)
  });
  assert.equal(printed[0], 'Apply history: 0 records.');
});
