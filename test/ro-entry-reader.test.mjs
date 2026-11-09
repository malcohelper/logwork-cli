import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../lib/api.mjs';
import {
  assertOwnUnlockedRoEntry,
  createF03LogworkReader,
  createRoEntryRevisionFingerprint
} from '../lib/ro-entry-reader.mjs';

const DATE = '2026-06-05';

function legacyEntry(overrides = {}) {
  return {
    id: 290364,
    projectMemberId: 11,
    projectId: undefined,
    projectName: '',
    date: DATE,
    hours: 2,
    taskName: 'Legacy task name',
    createdBy: 115,
    jiraLogworkId: null,
    source: 'manual',
    status: '',
    ...overrides
  };
}

function f03Entry(overrides = {}) {
  return {
    id: 290364,
    projectMemberId: undefined,
    projectId: null,
    projectName: '',
    hours: 2,
    taskName: 'Feature Development',
    status: 'approved',
    worklogTaskId: 9,
    typeOfWork: 'create',
    description: 'Implement maintenance mode UI',
    source: '',
    createdBy: 999,
    ...overrides
  };
}

function fakeSession({ tokens = ['token-1', 'token-2'] } = {}) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async get(options = {}) {
      calls.push(options);
      if (options.forceLogin) {
        index += 1;
      }
      return { token: tokens[Math.min(index, tokens.length - 1)], userId: 115 };
    }
  };
}

function fakeReads({
  legacy = legacyEntry(),
  day = { entries: [f03Entry()], isLocked: false },
  projects = [{ projectMemberId: 11, projectId: 7, projectName: 'Course Builder' }]
} = {}) {
  const calls = { getLogtimeById: [], getLogworkDay: [], getProjects: [] };
  return {
    calls,
    async getLogtimeById(token, id) {
      calls.getLogtimeById.push({ token, id });
      return typeof legacy === 'function' ? legacy(calls.getLogtimeById.length, token) : legacy;
    },
    async getLogworkDay(token, query) {
      calls.getLogworkDay.push({ token, query });
      return day;
    },
    async getProjects(token, userId) {
      calls.getProjects.push({ token, userId });
      return typeof projects === 'function' ? projects(calls.getProjects.length, token) : projects;
    }
  };
}

test('F03 reader merges the legacy entry, the /logwork/day entry and the project list', async () => {
  const reads = fakeReads();
  const reader = createF03LogworkReader({ session: fakeSession(), reads });

  const entry = await reader(290364);

  assert.deepEqual(reads.calls.getLogtimeById, [{ token: 'token-1', id: 290364 }]);
  assert.deepEqual(reads.calls.getLogworkDay, [{ token: 'token-1', query: { date: DATE } }]);
  assert.deepEqual(reads.calls.getProjects, [{ token: 'token-1', userId: 115 }]);
  assert.equal(entry.id, 290364);
  assert.equal(entry.date, DATE);
  // F03 fields win when they are set...
  assert.equal(entry.status, 'approved');
  assert.equal(entry.taskName, 'Feature Development');
  assert.equal(entry.worklogTaskId, 9);
  assert.equal(entry.typeOfWork, 'create');
  assert.equal(entry.description, 'Implement maintenance mode UI');
  // ...but empty F03 values never blank out legacy ones.
  assert.equal(entry.source, 'manual');
  // The owner comes from the legacy record, the project from the member list.
  assert.equal(entry.createdBy, 115);
  assert.equal(entry.projectMemberId, 11);
  assert.equal(entry.projectId, 7);
  assert.equal(entry.projectName, 'Course Builder');
  assert.equal(entry.dayLocked, false);
  assert.equal(entry.currentUserId, 115);
});

test('F03 reader prefers project fields already on the entries over the member list', async () => {
  const reads = fakeReads({
    legacy: legacyEntry({ projectId: 3, projectName: 'Legacy project' }),
    day: { entries: [f03Entry({ projectMemberId: 12, projectId: 4, projectName: 'F03 project' })], isLocked: true }
  });
  const entry = await createF03LogworkReader({ session: fakeSession(), reads })(290364);

  assert.equal(entry.projectMemberId, 12);
  assert.equal(entry.projectId, 4);
  assert.equal(entry.projectName, 'F03 project');
  assert.equal(entry.dayLocked, true);
});

test('F03 reader falls back to null project id and empty name when nothing matches', async () => {
  const reads = fakeReads({ projects: [] });
  const entry = await createF03LogworkReader({ session: fakeSession(), reads })(290364);

  assert.equal(entry.projectId, null);
  assert.equal(entry.projectName, '');
  assert.equal(entry.createdBy, 115);
});

test('F03 reader uses the F03 owner when the legacy record has none', async () => {
  const reads = fakeReads({ legacy: legacyEntry({ createdBy: undefined }) });
  const entry = await createF03LogworkReader({ session: fakeSession(), reads })(290364);
  assert.equal(entry.createdBy, 999);
});

test('F03 reader refuses an entry without a date or missing from its day', async () => {
  await assert.rejects(
    createF03LogworkReader({ session: fakeSession(), reads: fakeReads({ legacy: legacyEntry({ date: '' }) }) })(42),
    /did not return a date for logwork 42/
  );
  await assert.rejects(
    createF03LogworkReader({ session: fakeSession(), reads: fakeReads({ day: { entries: [f03Entry({ id: 1 })] } }) })(290364),
    /RO logwork 290364 was not found on 2026-06-05; it may have been deleted/
  );
  await assert.rejects(
    createF03LogworkReader({ session: fakeSession(), reads: fakeReads({ day: {} }) })(290364),
    /was not found/
  );
});

test('F03 reader logs in again and retries once on a 401', async () => {
  const session = fakeSession();
  const reads = fakeReads({
    legacy: (call) => {
      if (call === 1) {
        throw new ApiError('API request returned 401 Unauthorized.', { status: 401 });
      }
      return legacyEntry();
    }
  });

  const entry = await createF03LogworkReader({ session, reads })(290364);

  assert.deepEqual(session.calls, [{}, { forceLogin: true }]);
  assert.deepEqual(reads.calls.getLogtimeById.map((call) => call.token), ['token-1', 'token-2']);
  assert.equal(entry.status, 'approved');
});

test('F03 reader does not retry other errors', async () => {
  const session = fakeSession();
  const reads = fakeReads({
    legacy: () => {
      throw new ApiError('API request failed: 500', { status: 500 });
    }
  });

  await assert.rejects(createF03LogworkReader({ session, reads })(1), /500/);
  assert.deepEqual(session.calls, [{}]);
  assert.equal(reads.calls.getLogtimeById.length, 1);

  const plain = fakeSession();
  await assert.rejects(
    createF03LogworkReader({ session: plain, reads: fakeReads({ legacy: () => { throw new Error('boom'); } }) })(1),
    /boom/
  );
  assert.deepEqual(plain.calls, [{}]);
});

test('F03 reader does not cache a rejected project list, so the 401 retry reloads it', async () => {
  const session = fakeSession();
  const reads = fakeReads({
    projects: (call) => {
      if (call === 1) {
        return Promise.reject(new ApiError('API request returned 401 Unauthorized.', { status: 401 }));
      }
      return [{ projectMemberId: 11, projectId: 7, projectName: 'Course Builder' }];
    }
  });

  const entry = await createF03LogworkReader({ session, reads })(290364);

  assert.deepEqual(reads.calls.getProjects.map((call) => call.token), ['token-1', 'token-2']);
  assert.equal(entry.projectId, 7);
});

test('F03 reader caches a successful project list across reads', async () => {
  const reads = fakeReads();
  const reader = createF03LogworkReader({ session: fakeSession(), reads });

  await reader(290364);
  await reader(290364);

  assert.equal(reads.calls.getLogtimeById.length, 2);
  assert.equal(reads.calls.getProjects.length, 1);
});

test('assertOwnUnlockedRoEntry accepts the user\'s own unlocked manual entry', () => {
  assert.doesNotThrow(() => assertOwnUnlockedRoEntry({ currentUserId: 115, createdBy: '115', date: DATE }, 'delete'));
  // Unknown owner or user cannot be checked, so they do not block.
  assert.doesNotThrow(() => assertOwnUnlockedRoEntry({ createdBy: 1 }, 'delete'));
  assert.doesNotThrow(() => assertOwnUnlockedRoEntry({ currentUserId: 1 }, 'delete'));
  assert.doesNotThrow(() => assertOwnUnlockedRoEntry({ jiraLogworkId: '  ' }, 'delete'));
  assert.doesNotThrow(() => assertOwnUnlockedRoEntry(undefined, 'delete'));
});

test('assertOwnUnlockedRoEntry refuses other users, Jira-synced entries and locked days', () => {
  assert.throws(
    () => assertOwnUnlockedRoEntry({ currentUserId: 115, createdBy: 7 }, 'delete'),
    /Cannot delete another user's RO logwork\./
  );
  assert.throws(
    () => assertOwnUnlockedRoEntry({ jiraLogworkId: 55 }, 'resubmit'),
    /created by Jira; resubmit it in Jira/
  );
  assert.throws(
    () => assertOwnUnlockedRoEntry({ source: 'JIRA' }, 'delete'),
    /created by Jira; delete it in Jira/
  );
  assert.throws(
    () => assertOwnUnlockedRoEntry({ dayLocked: true, date: DATE }, 'delete'),
    /Logwork for 2026-06-05 is locked on Resource Optimiser; cannot delete it\./
  );
  assert.throws(
    () => assertOwnUnlockedRoEntry({ dayLocked: true }, 'delete'),
    /Logwork for this day is locked/
  );
});

test('createRoEntryRevisionFingerprint covers exactly the fields a preview approves', () => {
  const base = { id: 1, date: DATE, hours: 2, status: 'approved', taskName: 'Task', worklogTaskId: 9, typeOfWork: 'create', description: 'd' };
  const fingerprint = createRoEntryRevisionFingerprint(base);

  assert.equal(createRoEntryRevisionFingerprint({ ...base, projectName: 'ignored' }), fingerprint);
  for (const [field, value] of Object.entries({ date: '2026-06-06', hours: 3, status: 'rejected', taskName: 'Other', worklogTaskId: 10, typeOfWork: 'other', description: 'e' })) {
    assert.notEqual(createRoEntryRevisionFingerprint({ ...base, [field]: value }), fingerprint, field);
  }
  assert.deepEqual(JSON.parse(createRoEntryRevisionFingerprint({ id: 2, hours: 1, status: 's', taskName: 't' })), {
    id: 2,
    date: null,
    hours: 1,
    status: 's',
    taskName: 't',
    worklogTaskId: null,
    typeOfWork: null,
    description: null
  });
});
