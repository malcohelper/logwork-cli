import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyRoLogworkResubmit,
  previewRoLogworkResubmit
} from '../lib/ro-resubmit-workflow.mjs';

const rejectedEntry = {
  id: 290364,
  status: 'rejected',
  hours: 2,
  taskName: 'Maintenance mode',
  typeOfWork: 'other',
  noteToPm: '',
  description: ''
};

test('previewRoLogworkResubmit rejects non-rejected entries', async () => {
  await assert.rejects(
    previewRoLogworkResubmit({
      logworkId: 1,
      fetchLogwork: async () => ({ ...rejectedEntry, status: 'approved' })
    }),
    /Only rejected/
  );
});

test('previewRoLogworkResubmit and apply use fingerprint guard', async () => {
  const preview = await previewRoLogworkResubmit({
    logworkId: rejectedEntry.id,
    hours: 3,
    typeOfWork: 'correct',
    fetchLogwork: async () => rejectedEntry
  });

  assert.equal(preview.status, 'ready');
  assert.equal(preview.updated.hours, 3);
  assert.match(preview.summary, /rejected -> approved/);

  const writes = [];
  const result = await applyRoLogworkResubmit({
    preview,
    confirm: true,
    fetchLogwork: async () => rejectedEntry,
    submitResubmit: async (payload) => {
      writes.push(payload);
      return { dryRun: true };
    }
  });

  assert.equal(result.status, 'resubmitted');
  assert.deepEqual(writes[0], {
    logworkId: rejectedEntry.id,
    effortHours: 3,
    typeOfWork: 'correct',
    noteToPm: '',
    description: ''
  });

  await assert.rejects(
    applyRoLogworkResubmit({
      preview,
      confirm: true,
      fetchLogwork: async () => ({ ...rejectedEntry, hours: 1 }),
      submitResubmit: async () => ({})
    }),
    /changed after preview/
  );
});
