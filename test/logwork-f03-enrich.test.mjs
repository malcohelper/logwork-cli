import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichEntriesWithLogworkF03 } from '../lib/logwork-f03-enrich.mjs';

test('enrichEntriesWithLogworkF03 merges status by logwork id', async () => {
  const entries = [
    { id: 10, date: '2026-06-05', hours: 2, taskName: 'A' },
    { id: 11, date: '2026-06-05', hours: 1, taskName: 'B' }
  ];

  const result = await enrichEntriesWithLogworkF03(entries, {
    dates: ['2026-06-05'],
    fetchLogworkDay: async () => ({
      isLocked: true,
      entries: [
        { id: 10, status: 'submitted', typeOfWork: 'create', worklogTaskId: 5 },
        { id: 11, status: 'approved', typeOfWork: 'other', worklogTaskId: 6 }
      ]
    })
  });

  assert.equal(result.f03ByDate['2026-06-05'].isLocked, true);
  assert.equal(result.entries[0].status, 'submitted');
  assert.equal(result.entries[0].typeOfWork, 'create');
  assert.equal(result.entries[1].worklogTaskId, 6);
});
