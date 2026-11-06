import test from 'node:test';
import assert from 'node:assert/strict';
import { getLogtimeById } from '../lib/api.mjs';
import {
  applyRoLogworkEdit,
  previewRoLogworkEdit
} from '../lib/ro-edit-workflow.mjs';

const ORIGINAL = Object.freeze({
  id: 304032,
  projectMemberId: 5879,
  projectId: 720,
  projectName: 'SIT - AI Access Portal P1.0',
  date: '2026-11-06',
  hours: 1,
  worklogTaskId: 183,
  taskName: 'Testing Activities',
  typeOfWork: 'improve',
  description: 'Stabilise CI unit tests (SAP-42)',
  createdBy: 115,
  currentUserId: 115,
  updatedDate: '',
  jiraLogworkId: null,
  source: 'manual',
  status: 'approved',
  dayLocked: false
});

const TASKS = Object.freeze([
  { id: 71, name: 'Feature Development', type_of_work: 'create', project_id: null },
  { id: 74, name: 'Bug Fix', type_of_work: 'correct', project_id: null },
  { id: 183, name: 'Testing Activities', type_of_work: 'create', project_id: null },
  { id: 900, name: 'Portal QA', type_of_work: 'improve', project_id: 720 }
]);

const fetchWorklogTasks = async () => TASKS.map((task) => ({ ...task }));

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

test('RO edit preview changes only requested fields and preserves project, date, task, and type', async () => {
  const preview = await previewRoLogworkEdit({
    logworkId: ORIGINAL.id,
    hours: 0.5,
    fetchLogwork: async () => ({ ...ORIGINAL }),
    fetchWorklogTasks
  });

  assert.equal(preview.status, 'ready');
  assert.equal(preview.strategy, 'replace');
  assert.deepEqual(preview.changes.hours, { from: 1, to: 0.5 });
  assert.equal(preview.changes.taskName, null);
  assert.equal(preview.changes.typeOfWork, null);
  assert.equal(preview.changes.description, null);
  assert.equal(preview.updated.worklogTaskId, 183);
  assert.equal(preview.updated.typeOfWork, 'improve');
  assert.equal(preview.updated.description, ORIGINAL.description);
  assert.equal(preview.updated.needsProjectId, true);
  assert.equal(preview.updated.projectId, ORIGINAL.projectId);
  assert.equal(preview.updated.date, ORIGINAL.date);
  assert.match(preview.summary, /creates a new RO entry/);
  assert.match(preview.summary, /deletes entry 304032/);
});

test('RO edit preview changes worklog task, description, and takes the new task type', async () => {
  const preview = await previewRoLogworkEdit({
    logworkId: ORIGINAL.id,
    taskName: 'bug fix',
    description: 'Fix date picker timezone (SAP-42)',
    fetchLogwork: async () => ({ ...ORIGINAL }),
    fetchWorklogTasks
  });

  assert.deepEqual(preview.changes.taskName, { from: 'Testing Activities', to: 'Bug Fix' });
  assert.deepEqual(preview.changes.typeOfWork, { from: 'improve', to: 'correct' });
  assert.deepEqual(preview.changes.description, {
    from: 'Stabilise CI unit tests (SAP-42)',
    to: 'Fix date picker timezone (SAP-42)'
  });
  assert.equal(preview.updated.worklogTaskId, 74);

  const byId = await previewRoLogworkEdit({
    logworkId: ORIGINAL.id,
    taskName: '#900',
    typeOfWork: 'other',
    fetchLogwork: async () => ({ ...ORIGINAL }),
    fetchWorklogTasks
  });
  assert.equal(byId.updated.worklogTaskId, 900);
  assert.equal(byId.updated.needsProjectId, false);
  assert.equal(byId.updated.typeOfWork, 'other');
});

test('RO edit preview rejects unknown tasks and entries whose task left the catalog', async () => {
  await assert.rejects(() => previewRoLogworkEdit({
    logworkId: ORIGINAL.id,
    taskName: 'Development',
    fetchLogwork: async () => ({ ...ORIGINAL }),
    fetchWorklogTasks
  }), /No worklog task named "Development"/);

  await assert.rejects(() => previewRoLogworkEdit({
    logworkId: ORIGINAL.id,
    hours: 2,
    fetchLogwork: async () => ({ ...ORIGINAL, worklogTaskId: 5 }),
    fetchWorklogTasks
  }), /not in the project's task catalog/);
});

test('RO edit apply creates the replacement first, deletes the original, and verifies', async () => {
  const calls = [];
  const entries = new Map([[ORIGINAL.id, { ...ORIGINAL }]]);
  const fetchLogwork = async (id) => {
    const entry = entries.get(Number(id));
    if (!entry) throw new Error(`missing ${id}`);
    return { ...entry };
  };
  const preview = await previewRoLogworkEdit({
    logworkId: ORIGINAL.id,
    hours: 0.5,
    taskName: 'Bug Fix',
    description: 'Fix date picker timezone (SAP-42)',
    fetchLogwork,
    fetchWorklogTasks
  });

  const result = await applyRoLogworkEdit({
    preview,
    confirm: true,
    fetchLogwork,
    submitCreate: async (request) => {
      calls.push(['create', request]);
      entries.set(304100, {
        ...ORIGINAL,
        id: 304100,
        hours: request.effortHours,
        worklogTaskId: request.worklogTaskId,
        taskName: 'Bug Fix',
        typeOfWork: request.typeOfWork,
        description: request.description,
        status: 'submitted'
      });
      return { dryRun: false, entry: { id: 304100 } };
    },
    submitDelete: async (id) => {
      calls.push(['delete', id]);
      entries.delete(Number(id));
      return { dryRun: false };
    },
    recordLedger: null
  });

  assert.deepEqual(calls, [
    ['create', {
      worklogTaskId: 74,
      projectId: 720,
      effortHours: 0.5,
      localDateISO: '2026-11-06',
      typeOfWork: 'correct',
      description: 'Fix date picker timezone (SAP-42)',
      needsProjectId: true
    }],
    ['delete', 304032]
  ]);
  assert.equal(result.status, 'replaced');
  assert.equal(result.originalLogworkId, 304032);
  assert.equal(result.newLogworkId, 304100);
  assert.equal(result.updated.hours, 0.5);
  assert.equal(result.updated.description, 'Fix date picker timezone (SAP-42)');
  assert.match(result.summary, /Replaced RO logwork 304032 with new entry 304100/);
});

test('RO edit apply finds the new entry id from the day when create returns none', async () => {
  const created = { ...ORIGINAL, id: 304101, hours: 2, status: 'submitted' };
  const entries = new Map([[ORIGINAL.id, { ...ORIGINAL }], [created.id, created]]);
  const fetchLogwork = async (id) => ({ ...entries.get(Number(id)) });
  const preview = await previewRoLogworkEdit({
    logworkId: ORIGINAL.id,
    hours: 2,
    fetchLogwork,
    fetchWorklogTasks
  });
  const result = await applyRoLogworkEdit({
    preview,
    confirm: true,
    fetchLogwork,
    fetchDayEntries: async () => [{ ...ORIGINAL }, { ...created }],
    submitCreate: async () => ({ dryRun: false, entry: null }),
    submitDelete: async () => ({ dryRun: false }),
    recordLedger: null
  });
  assert.equal(result.newLogworkId, 304101);
});

test('RO edit apply rolls back the replacement when deleting the original fails', async () => {
  const deleted = [];
  const fetchLogwork = async () => ({ ...ORIGINAL });
  const preview = await previewRoLogworkEdit({
    logworkId: ORIGINAL.id,
    hours: 2,
    fetchLogwork,
    fetchWorklogTasks
  });

  await assert.rejects(() => applyRoLogworkEdit({
    preview,
    confirm: true,
    fetchLogwork,
    submitCreate: async () => ({ dryRun: false, entry: { id: 304102 } }),
    submitDelete: async (id) => {
      deleted.push(id);
      if (id === ORIGINAL.id) throw new Error('This log date is locked and cannot be edited.');
      return { dryRun: false };
    },
    recordLedger: null
  }), (error) => {
    assert.match(error.message, /Could not delete the original RO entry 304032/);
    assert.match(error.message, /304102 was rolled back; nothing changed/);
    assert.equal(error.rolledBack, true);
    return true;
  });
  assert.deepEqual(deleted, [304032, 304102]);
});

test('RO edit apply keeps the original when create fails', async () => {
  let deleteCalled = false;
  const fetchLogwork = async () => ({ ...ORIGINAL });
  const preview = await previewRoLogworkEdit({
    logworkId: ORIGINAL.id,
    hours: 2,
    fetchLogwork,
    fetchWorklogTasks
  });
  await assert.rejects(() => applyRoLogworkEdit({
    preview,
    confirm: true,
    fetchLogwork,
    submitCreate: async () => {
      throw new Error('Logwork is blocked on this date (holiday).');
    },
    submitDelete: async () => {
      deleteCalled = true;
    },
    recordLedger: null
  }), /original entry 304032 is unchanged/);
  assert.equal(deleteCalled, false);
});

test('RO edit apply dry run returns both requests without writing', async () => {
  const fetchLogwork = async () => ({ ...ORIGINAL });
  const preview = await previewRoLogworkEdit({
    logworkId: ORIGINAL.id,
    description: 'Stabilise CI and e2e tests (SAP-42, SAP-45)',
    fetchLogwork,
    fetchWorklogTasks
  });
  const result = await applyRoLogworkEdit({
    preview,
    confirm: true,
    fetchLogwork,
    submitCreate: async (request) => ({ dryRun: true, method: 'POST', path: '/logwork/entries', body: request }),
    submitDelete: async (id) => ({ dryRun: true, method: 'DELETE', path: `/logwork/entries/${id}` }),
    recordLedger: null
  });
  assert.equal(result.status, 'dry_run');
  assert.deepEqual(result.requests.map((request) => `${request.method} ${request.path}`), [
    'POST /logwork/entries',
    'DELETE /logwork/entries/304032'
  ]);
  assert.equal(result.requests[0].body.description, 'Stabilise CI and e2e tests (SAP-42, SAP-45)');
});

test('RO edit apply blocks stale previews before any write', async () => {
  let current = { ...ORIGINAL };
  let wrote = false;
  const fetchLogwork = async () => ({ ...current });
  const preview = await previewRoLogworkEdit({
    logworkId: current.id,
    hours: 0.5,
    fetchLogwork,
    fetchWorklogTasks
  });
  current = { ...current, description: 'Changed in the web app' };

  await assert.rejects(() => applyRoLogworkEdit({
    preview,
    confirm: true,
    fetchLogwork,
    submitCreate: async () => {
      wrote = true;
    },
    submitDelete: async () => {
      wrote = true;
    },
    recordLedger: null
  }), /changed after preview/);
  assert.equal(wrote, false);
});

test('RO edit blocks no-op, rejected, locked, other users, Jira-created entries, and missing confirmation', async () => {
  const run = (overrides, args = { hours: 0.5 }) => previewRoLogworkEdit({
    logworkId: ORIGINAL.id,
    ...args,
    fetchLogwork: async () => ({ ...ORIGINAL, ...overrides }),
    fetchWorklogTasks
  });

  await assert.rejects(() => run({}, { hours: ORIGINAL.hours }), /does not change/);
  await assert.rejects(() => run({ status: 'rejected' }), /resubmit_entry/);
  await assert.rejects(() => run({ dayLocked: true }), /is locked/);
  await assert.rejects(() => run({ currentUserId: 999 }), /another user's/);
  await assert.rejects(() => run({ jiraLogworkId: 1234 }), /created by Jira/);
  await assert.rejects(() => run({}, {}), /Provide hours, taskName, description, and\/or typeOfWork/);
  await assert.rejects(() => run({}, { typeOfWork: 'fix' }), /typeOfWork must be one of/);

  const preview = await run({});
  await assert.rejects(() => applyRoLogworkEdit({
    preview,
    confirm: false,
    fetchLogwork: async () => ({ ...ORIGINAL }),
    submitCreate: async () => {},
    submitDelete: async () => {}
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
