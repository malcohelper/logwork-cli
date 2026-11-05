import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyRoLogworkDelete,
  previewRoLogworkDelete
} from '../lib/ro-delete-workflow.mjs';

const approvedEntry = {
  id: 290364,
  status: 'approved',
  hours: 2,
  taskName: 'Maintenance mode',
  date: '2026-06-05',
  projectName: 'Course Builder',
  projectId: 100
};

test('previewRoLogworkDelete rejects rejected entries', async () => {
  await assert.rejects(
    previewRoLogworkDelete({
      logworkId: 1,
      fetchLogwork: async () => ({ ...approvedEntry, status: 'rejected' })
    }),
    /cannot be deleted/
  );
});

test('previewRoLogworkDelete and apply delete with fingerprint guard', async () => {
  const preview = await previewRoLogworkDelete({
    logworkId: approvedEntry.id,
    fetchLogwork: async () => approvedEntry
  });

  assert.equal(preview.status, 'ready');
  assert.match(preview.summary, /290364/);
  assert.match(preview.summary, /soft-deleted/);

  const deletes = [];
  const result = await applyRoLogworkDelete({
    preview,
    confirm: true,
    fetchLogwork: async () => approvedEntry,
    submitDelete: async (logworkId) => {
      deletes.push(logworkId);
      return { dryRun: true };
    }
  });

  assert.equal(result.status, 'deleted');
  assert.deepEqual(deletes, [approvedEntry.id]);

  await assert.rejects(
    applyRoLogworkDelete({
      preview,
      confirm: true,
      fetchLogwork: async () => ({ ...approvedEntry, hours: 1 }),
      submitDelete: async () => ({})
    }),
    /changed after preview/
  );
});
