import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  getNormalizationDiagnostics,
  normalizeLogtimeEntries,
  normalizeTimesheetRange
} from '../lib/api.mjs';

test('Resource Optimiser assign_hours timesheet fixture normalizes booked hours', async () => {
  const payload = await readFixture('timesheet-assign-hours-shape.json');
  const records = normalizeTimesheetRange(payload, {
    from: '2026-06-01',
    to: '2026-06-02'
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].bookedHours, 8);
  assert.equal(records[0].loggedHours, 8);
});

test('Resource Optimiser project timesheet fixture normalizes booked/logged records', async () => {
  const payload = await readFixture('timesheet-project-shape.json');
  const records = normalizeTimesheetRange(payload, {
    from: '2026-06-01',
    to: '2026-06-03'
  });

  assert.deepEqual(records.map((record) => ({
    date: record.date,
    projectMemberId: record.projectMemberId,
    projectId: record.projectId,
    projectName: record.projectName,
    bookedHours: record.bookedHours,
    loggedHours: record.loggedHours
  })), [
    {
      date: '2026-06-01',
      projectMemberId: 5234,
      projectId: 643,
      projectName: '2621A-SIT-HTML BUILDER-PRJ',
      bookedHours: 8,
      loggedHours: 8
    },
    {
      date: '2026-06-02',
      projectMemberId: 5234,
      projectId: 643,
      projectName: '2621A-SIT-HTML BUILDER-PRJ',
      bookedHours: 8,
      loggedHours: 0
    },
    {
      date: '2026-06-01',
      projectMemberId: 7777,
      projectId: 888,
      projectName: 'Internal Operations',
      bookedHours: 2,
      loggedHours: 1.5
    }
  ]);

  assert.deepEqual(getNormalizationDiagnostics(records), {
    status: 'ok',
    sourceShape: 'project_timesheet',
    rowsRead: 3,
    rowsAccepted: 3,
    droppedRowCount: 0,
    warningCount: 0,
    warnings: [],
    droppedRows: []
  });
});

test('Resource Optimiser malformed timesheet fixture reports warning diagnostics', async () => {
  const payload = await readFixture('timesheet-malformed-range.json');
  const records = normalizeTimesheetRange(payload, {
    from: '2026-06-01',
    to: '2026-06-02'
  });
  const diagnostics = getNormalizationDiagnostics(records);

  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record.projectMemberId), [1111, 3333]);
  assert.equal(records[0].bookedHours, 0);
  assert.equal(records[0].loggedHours, 0);
  assert.equal(diagnostics.status, 'warning');
  assert.equal(diagnostics.sourceShape, 'range_scan');
  assert.equal(diagnostics.rowsRead, 4);
  assert.equal(diagnostics.rowsAccepted, 2);
  assert.deepEqual(diagnostics.warnings.map((warning) => warning.reason), [
    'invalid_hours',
    'invalid_hours'
  ]);
  assert.deepEqual(diagnostics.droppedRows.map((row) => row.reason).sort(), [
    'missing_date',
    'missing_project_identity'
  ]);
});

test('Resource Optimiser day-log fixture normalizes valid task detail and reports drops', async () => {
  const payload = await readFixture('day-log-detail.json');
  const entries = normalizeLogtimeEntries(payload);
  const diagnostics = getNormalizationDiagnostics(entries);

  assert.deepEqual(entries, [
    {
      id: 1,
      date: '2026-06-01',
      projectMemberId: undefined,
      projectId: 643,
      projectName: '2621A-SIT-HTML BUILDER-PRJ',
      hours: 1.5,
      taskName: 'Question bank cleanup'
    }
  ]);
  assert.equal(diagnostics.status, 'warning');
  assert.equal(diagnostics.rowsRead, 4);
  assert.equal(diagnostics.rowsAccepted, 1);
  assert.deepEqual(diagnostics.warnings.map((warning) => warning.reason), ['invalid_hours']);
  assert.deepEqual(diagnostics.droppedRows.map((row) => row.reason).sort(), [
    'missing_date',
    'missing_project_identity',
    'non_positive_hours'
  ]);
});

async function readFixture(name) {
  const text = await readFile(new URL(`./fixtures/resource-optimiser/${name}`, import.meta.url), 'utf8');
  return JSON.parse(text);
}
