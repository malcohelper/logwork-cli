import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getLogtimeById,
  updateLogtime
} from '../lib/api.mjs';
import {
  applyRoLogworkEdit,
  previewRoLogworkEdit
} from '../lib/ro-edit-workflow.mjs';

const ORIGINAL = Object.freeze({
  id: 290364,
  projectMemberId: 5234,
  projectId: 2621,
  projectName: '2621A-SIT-HTML BUILDER-PRJ',
  date: '2026-07-15',
  hours: 1,
  taskName: 'Hide View history (SCB-470)',
  createdBy: 115,
  currentUserId: 115,
  updatedDate: '2026-07-16T02:27:50.299Z',
  jiraLogworkId: null,
  source: 'manual',
  status: 'submitted'
});

test('RO update API sends the captured update_data contract and normalizes response', async () => {
  let request;
  const result = await updateLogtime('test-token', {
    id: 290364,
    projectMemberId: 5234,
    logtimes: 0.5,
    taskName: 'Hide View history (SCB-470)',
    localDateISO: '2026-07-15'
  }, {
    retries: 0,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse({
        code: 200,
        success: true,
        data: {
          update: [{
            id: 290364,
            project_member_id: 5234,
            logtimes: 0.5,
            task_name: 'Hide View history (SCB-470)',
            logdate: '2026-07-15T00:00:00.000Z',
            project_name: '2621A-SIT-HTML BUILDER-PRJ',
            source: 'manual',
            status: 'submitted'
          }]
        }
      });
    }
  });

  assert.equal(request.url, 'https://api.resourceoptimiser.com/api/v1/member-logtime/5234');
  assert.equal(request.options.method, 'PATCH');
  assert.deepEqual(JSON.parse(request.options.body), {
    update_data: [{
      id: 290364,
      project_member_id: 5234,
      logtimes: 0.5,
      task_name: 'Hide View history (SCB-470)',
      logdate: '2026-07-15T00:00:00.000Z'
    }]
  });
  assert.equal(result.entry.id, 290364);
  assert.equal(result.entry.hours, 0.5);
  assert.equal(result.entry.date, '2026-07-15');
});

test('RO get-by-id normalizes an editable logwork response', async () => {
  const entry = await getLogtimeById('test-token', 290364, {
    retries: 0,
    fetchImpl: async () => jsonResponse({
      data: {
        id: 290364,
        project_member_id: 5234,
        logtimes: 1.5,
        task_name: 'Maintenance',
        logdate: '2026-07-15T00:00:00.000Z',
        created_by: 115,
        jira_logwork_id: null
      }
    })
  });

  assert.deepEqual({
    id: entry.id,
    projectMemberId: entry.projectMemberId,
    hours: entry.hours,
    taskName: entry.taskName,
    date: entry.date,
    createdBy: entry.createdBy
  }, {
    id: 290364,
    projectMemberId: 5234,
    hours: 1.5,
    taskName: 'Maintenance',
    date: '2026-07-15',
    createdBy: 115
  });
});

test('RO edit preview changes only requested fields and preserves project and date', async () => {
  const preview = await previewRoLogworkEdit({
    logworkId: 290364,
    hours: 0.5,
    fetchLogwork: async () => ({ ...ORIGINAL })
  });

  assert.equal(preview.status, 'ready');
  assert.deepEqual(preview.changes.hours, { from: 1, to: 0.5 });
  assert.equal(preview.changes.taskName, null);
  assert.equal(preview.updated.taskName, ORIGINAL.taskName);
  assert.equal(preview.updated.projectMemberId, ORIGINAL.projectMemberId);
  assert.equal(preview.updated.date, ORIGINAL.date);
});

test('RO edit can replace an empty existing task name', async () => {
  const preview = await previewRoLogworkEdit({
    logworkId: 290364,
    taskName: 'Restored task name',
    fetchLogwork: async () => ({ ...ORIGINAL, taskName: '' })
  });

  assert.deepEqual(preview.changes.taskName, {
    from: '',
    to: 'Restored task name'
  });
});

test('RO edit apply stale-checks, submits full merged entry, and verifies result', async () => {
  let current = { ...ORIGINAL };
  let submitted;
  const fetchLogwork = async () => ({ ...current });
  const preview = await previewRoLogworkEdit({
    logworkId: current.id,
    hours: 0.5,
    taskName: 'Hide View history when page has one revision (SCB-470)',
    fetchLogwork
  });

  const result = await applyRoLogworkEdit({
    preview,
    confirm: true,
    fetchLogwork,
    submitUpdate: async (entry) => {
      submitted = entry;
      current = {
        ...current,
        hours: entry.logtimes,
        taskName: entry.taskName,
        updatedDate: '2026-07-16T04:40:09.206Z'
      };
      return { dryRun: false };
    },
    recordLedger: null
  });

  assert.deepEqual(submitted, {
    id: 290364,
    projectMemberId: 5234,
    logtimes: 0.5,
    taskName: 'Hide View history when page has one revision (SCB-470)',
    localDateISO: '2026-07-15'
  });
  assert.equal(result.status, 'updated');
  assert.equal(result.updated.hours, 0.5);
  assert.equal(result.updated.date, ORIGINAL.date);
  assert.equal(result.updated.projectMemberId, ORIGINAL.projectMemberId);
});

test('RO edit apply blocks stale previews before calling update API', async () => {
  let current = { ...ORIGINAL };
  let submitted = false;
  const fetchLogwork = async () => ({ ...current });
  const preview = await previewRoLogworkEdit({
    logworkId: current.id,
    hours: 0.5,
    fetchLogwork
  });
  current = {
    ...current,
    hours: 2,
    updatedDate: '2026-07-16T05:00:00.000Z'
  };

  await assert.rejects(() => applyRoLogworkEdit({
    preview,
    confirm: true,
    fetchLogwork,
    submitUpdate: async () => {
      submitted = true;
    },
    recordLedger: null
  }), /changed after preview/);
  assert.equal(submitted, false);
});

test('RO edit blocks no-op, missing confirmation, other users, and Jira-created entries', async () => {
  await assert.rejects(() => previewRoLogworkEdit({
    logworkId: ORIGINAL.id,
    hours: ORIGINAL.hours,
    fetchLogwork: async () => ({ ...ORIGINAL })
  }), /does not change/);

  await assert.rejects(() => previewRoLogworkEdit({
    logworkId: ORIGINAL.id,
    hours: 0.5,
    fetchLogwork: async () => ({ ...ORIGINAL, currentUserId: 999 })
  }), /another user's/);

  await assert.rejects(() => previewRoLogworkEdit({
    logworkId: ORIGINAL.id,
    taskName: 'Changed',
    fetchLogwork: async () => ({ ...ORIGINAL, jiraLogworkId: 1234 })
  }), /created by Jira/);

  const preview = await previewRoLogworkEdit({
    logworkId: ORIGINAL.id,
    hours: 0.5,
    fetchLogwork: async () => ({ ...ORIGINAL })
  });
  await assert.rejects(() => applyRoLogworkEdit({
    preview,
    confirm: false,
    fetchLogwork: async () => ({ ...ORIGINAL }),
    submitUpdate: async () => {}
  }), /requires confirm: true/);
});

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json'
    }
  });
}
