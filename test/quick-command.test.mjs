import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../lib/api.mjs';
import { formatQuickHelp, parseQuickArgs, run, runQuickLog } from '../commands/quick.mjs';

const TODAY = '2026-06-05';
const unauthorized = () => new ApiError('API request returned 401 Unauthorized.', { status: 401 });

const bookedProject = { projectMemberId: 11, projectId: 7, projectName: 'Course Builder', loggedHours: 1 };

function fakeUi(overrides = {}) {
  const calls = [];
  const ui = {
    calls,
    async chooseProject(projects, daySummaries) {
      calls.push({ step: 'project', projects, daySummaries });
      return projects[0];
    },
    async chooseTask(tasks) {
      calls.push({ step: 'task', tasks });
      return tasks[tasks.length - 1];
    },
    async chooseMessageSource(message) {
      calls.push({ step: 'message', message });
      return 'Implement maintenance mode UI';
    },
    async askHours(defaultHours) {
      calls.push({ step: 'hours', defaultHours });
      return 2;
    },
    async confirmSubmit(preview) {
      calls.push({ step: 'confirm', preview });
      return true;
    },
    showSuccess(message) {
      calls.push({ step: 'success', message });
    },
    showError(error) {
      calls.push({ step: 'error', message: error.message });
    },
    ...overrides
  };
  return ui;
}

function fakeApi({
  projects = [bookedProject],
  tasks = [
    { id: 3, name: 'Bug Fix', typeOfWork: 'correct', projectId: 7 },
    { id: 9, name: 'Feature Development', typeOfWork: '', description: 'New work', projectId: null }
  ],
  addLogtime = async () => ({ dryRun: false, entry: { id: 1 } })
} = {}) {
  const calls = { projects: [], tasks: [], addLogtime: [] };
  return {
    calls,
    async getTodayTimesheetProjects(token, userId, date) {
      calls.projects.push({ token, userId, date });
      return typeof projects === 'function' ? projects(calls.projects.length) : projects;
    },
    async fetchWorklogTasksForProject(token, projectId) {
      calls.tasks.push({ token, projectId });
      return tasks;
    },
    async addLogtime(token, entry) {
      calls.addLogtime.push({ token, entry });
      return addLogtime(calls.addLogtime.length);
    }
  };
}

function fakeOpenSession() {
  const calls = [];
  const open = async (options = {}) => {
    calls.push(options);
    return { token: `token-${calls.length}`, userId: 115 };
  };
  open.calls = calls;
  return open;
}

test('parseQuickArgs reads -m, --message, --message= and positional text', () => {
  assert.deepEqual(parseQuickArgs([]), { message: '', help: false });
  assert.deepEqual(parseQuickArgs(['-h']), { message: '', help: true });
  assert.deepEqual(parseQuickArgs(['--message', 'Fix (SCB-1)']), { message: 'Fix (SCB-1)', help: false });
  assert.deepEqual(parseQuickArgs(['--message=Fix']), { message: 'Fix', help: false });
  assert.deepEqual(parseQuickArgs(['Fix', 'login']), { message: 'Fix login', help: false });
  // An explicit message wins over positional words.
  assert.deepEqual(parseQuickArgs(['-m', 'Explicit', 'ignored']), { message: 'Explicit', help: false });
  assert.throws(() => parseQuickArgs(['-m']), /-m requires a value\./);
  assert.throws(() => parseQuickArgs(['--message', '']), /--message requires a value\./);
});

test('quick --help prints usage without opening a session', async () => {
  const printed = [];
  let logged = false;
  const code = await run(['--help'], {
    print: (text) => printed.push(text),
    quickLog: async () => {
      logged = true;
    }
  });
  assert.equal(code, 0);
  assert.equal(printed[0], formatQuickHelp());
  assert.equal(logged, false);
});

test('quick run reports success, dry run and failure', async () => {
  const intros = [];
  const ui = fakeUi();
  const messages = [];

  assert.equal(await run(['-m', 'Fix'], {
    quickUi: ui,
    showIntro: (title) => intros.push(title),
    quickLog: async ({ message }) => {
      messages.push(message);
      return { dryRun: false };
    }
  }), 0);
  assert.equal(await run([], { quickUi: ui, showIntro: () => {}, quickLog: async () => ({ dryRun: true }) }), 0);
  assert.equal(await run([], {
    quickUi: ui,
    showIntro: () => {},
    quickLog: async () => {
      throw new Error('You have no booked project on 2026-06-05.');
    }
  }), 1);

  assert.deepEqual(intros, ['Logwork quick']);
  assert.deepEqual(messages, ['Fix']);
  assert.deepEqual(ui.calls, [
    { step: 'success', message: 'Logwork submitted.' },
    { step: 'success', message: 'DRY RUN: payload generated; no API write performed.' },
    { step: 'error', message: 'You have no booked project on 2026-06-05.' }
  ]);
});

test('runQuickLog walks project, task, message and hours, then adds the entry', async () => {
  const ui = fakeUi();
  const api = fakeApi();
  const open = fakeOpenSession();

  const result = await runQuickLog({ message: 'from -m', quickUi: ui, api, openSession: open, today: () => TODAY });

  assert.deepEqual(result, { dryRun: false, entry: { id: 1 } });
  assert.deepEqual(open.calls, [{}]);
  assert.deepEqual(api.calls.projects, [{ token: 'token-1', userId: 115, date: TODAY }]);
  assert.deepEqual(api.calls.tasks, [{ token: 'token-1', projectId: 7 }]);
  assert.deepEqual(ui.calls.map((call) => call.step), ['project', 'task', 'message', 'hours', 'confirm']);
  assert.deepEqual(ui.calls[0].daySummaries, [{ projectId: 7, totalHours: 1, ok: true }]);
  assert.deepEqual(ui.calls[1].tasks, [
    { taskId: 3, name: 'Bug Fix', typeOfWork: 'correct', description: undefined, needsProjectId: false },
    { taskId: 9, name: 'Feature Development', typeOfWork: 'other', description: 'New work', needsProjectId: true }
  ]);
  assert.equal(ui.calls[2].message, 'from -m');
  assert.equal(ui.calls[3].defaultHours, 1);
  assert.deepEqual(ui.calls[4].preview, {
    projectName: 'Course Builder',
    hours: 2,
    taskName: 'Feature Development',
    description: 'Implement maintenance mode UI',
    localDateISO: TODAY
  });
  assert.deepEqual(api.calls.addLogtime, [{
    token: 'token-1',
    entry: {
      projectId: 7,
      projectMemberId: 11,
      logtimes: 2,
      taskName: 'Feature Development',
      localDateISO: TODAY,
      worklogTaskId: 9,
      typeOfWork: 'other',
      description: 'Implement maintenance mode UI',
      worklogNeedsProjectId: true
    }
  }]);
});

test('runQuickLog logs in again once when loading projects returns 401', async () => {
  const api = fakeApi({
    projects: (call) => {
      if (call === 1) {
        throw unauthorized();
      }
      return [bookedProject];
    }
  });
  const open = fakeOpenSession();

  await runQuickLog({ quickUi: fakeUi(), api, openSession: open, today: () => TODAY });

  assert.deepEqual(open.calls, [{}, { forceLogin: true }]);
  assert.deepEqual(api.calls.projects.map((call) => call.token), ['token-1', 'token-2']);
  assert.equal(api.calls.addLogtime[0].token, 'token-2');
});

test('runQuickLog logs in again once when adding the entry returns 401', async () => {
  const api = fakeApi({
    addLogtime: (call) => {
      if (call === 1) {
        throw unauthorized();
      }
      return { dryRun: true };
    }
  });
  const open = fakeOpenSession();

  assert.deepEqual(await runQuickLog({ quickUi: fakeUi(), api, openSession: open, today: () => TODAY }), { dryRun: true });
  assert.deepEqual(open.calls, [{}, { forceLogin: true }]);
  assert.deepEqual(api.calls.addLogtime.map((call) => call.token), ['token-1', 'token-2']);
});

test('runQuickLog stops on other errors, no bookings, no tasks or a declined submit', async () => {
  const run = (overrides) => runQuickLog({
    quickUi: fakeUi(overrides.ui),
    api: fakeApi(overrides.api),
    openSession: fakeOpenSession(),
    today: () => TODAY
  });

  await assert.rejects(run({ api: { projects: () => { throw new Error('network down'); } } }), /network down/);
  await assert.rejects(run({ api: { projects: [] } }), /You have no booked project on 2026-06-05\./);
  await assert.rejects(run({ api: { tasks: [] } }), /No worklog tasks are available for Course Builder\./);
  await assert.rejects(run({ api: { addLogtime: () => { throw new Error('HOLIDAY_BLOCKED'); } } }), /HOLIDAY_BLOCKED/);

  const api = fakeApi();
  await assert.rejects(runQuickLog({
    quickUi: fakeUi({
      async confirmSubmit() {
        throw new Error('User declined final submit.');
      }
    }),
    api,
    openSession: fakeOpenSession(),
    today: () => TODAY
  }), /User declined final submit\./);
  assert.equal(api.calls.addLogtime.length, 0);
});
