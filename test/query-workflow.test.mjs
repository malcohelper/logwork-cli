import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterRecordsByProject,
  collectEntries,
  normalizeQueryRange,
  queryLogwork
} from '../lib/query-workflow.mjs';
import {
  normalizeTimesheetRange,
  normalizeTimesheetRangeResult
} from '../lib/api.mjs';

async function stubFetchLogworkDay() {
  return { entries: [], isLocked: false };
}

const records = [
  {
    date: '2026-06-05',
    projectMemberId: 5352,
    projectId: 100,
    projectName: 'Course Builder',
    bookedHours: 4,
    loggedHours: 2,
    entries: []
  },
  {
    date: '2026-06-05',
    projectMemberId: 7777,
    projectId: 200,
    projectName: 'Internal',
    bookedHours: 2,
    loggedHours: 0,
    entries: []
  }
];

test('normalizeQueryRange defaults single date to exclusive next day', () => {
  assert.deepEqual(normalizeQueryRange({ date: '2026-06-05' }), {
    from: '2026-06-05',
    to: '2026-06-06'
  });
});

test('normalizeQueryRange supports this_week as Monday to next Monday', (context) => {
  const OriginalDate = globalThis.Date;
  class MockDate extends OriginalDate {
    constructor(...args) {
      if (args.length === 0) {
        super('2026-06-03T10:00:00+07:00');
        return;
      }
      super(...args);
    }
  }
  globalThis.Date = MockDate;
  context.after(() => {
    globalThis.Date = OriginalDate;
  });

  assert.deepEqual(normalizeQueryRange({ period: 'this_week' }), {
    from: '2026-06-01',
    to: '2026-06-08'
  });
});

test('normalizeQueryRange supports yesterday as previous local day', (context) => {
  const OriginalDate = globalThis.Date;
  class MockDate extends OriginalDate {
    constructor(...args) {
      if (args.length === 0) {
        super('2026-06-03T10:00:00+07:00');
        return;
      }
      super(...args);
    }
  }
  globalThis.Date = MockDate;
  context.after(() => {
    globalThis.Date = OriginalDate;
  });

  assert.deepEqual(normalizeQueryRange({ period: 'yesterday' }), {
    from: '2026-06-02',
    to: '2026-06-03'
  });
});

test('normalizeQueryRange supports week and month preset periods', (context) => {
  const OriginalDate = globalThis.Date;
  class MockDate extends OriginalDate {
    constructor(...args) {
      if (args.length === 0) {
        super('2026-06-16T10:00:00+07:00');
        return;
      }
      super(...args);
    }
  }
  globalThis.Date = MockDate;
  context.after(() => {
    globalThis.Date = OriginalDate;
  });

  assert.deepEqual(normalizeQueryRange({ period: 'last_week' }), {
    from: '2026-06-08',
    to: '2026-06-15'
  });
  assert.deepEqual(normalizeQueryRange({ period: 'this_month' }), {
    from: '2026-06-01',
    to: '2026-07-01'
  });
  assert.deepEqual(normalizeQueryRange({ period: 'last_month' }), {
    from: '2026-05-01',
    to: '2026-06-01'
  });
});

test('queryLogwork filters by project id/name/ticket mapping and falls back for entries', async () => {
  const fetchedDayLogs = [];
  const result = await queryLogwork({
    date: '2026-06-05',
    project: 'SCB',
    cwd: '/private/tmp/no-config-here',
    fetchRange: async () => records,
    fetchLogworkDay: stubFetchLogworkDay,
    fetchDayLogs: async (args) => {
      fetchedDayLogs.push(args);
      return {
        ok: true,
        logs: [
          {
            id: 10,
            logdate: '2026-06-05T00:00:00.000Z',
            project_id: 100,
            logtimes: 2,
            task_name: 'Maintenance mode'
          }
        ]
      };
    }
  });

  assert.equal(result.unmatchedProjectFilter.filter, 'SCB');

  const mapped = filterRecordsByProject(records, 'SCB', {
    projectMappings: [{ projectName: 'Course Builder', tickets: ['SCB'] }]
  });
  assert.equal(mapped.records.length, 1);
  assert.equal(mapped.records[0].projectMemberId, 5352);

  const byName = await queryLogwork({
    date: '2026-06-05',
    project: 'Course',
    cwd: '/private/tmp/no-config-here',
    fetchRange: async () => records,
    fetchLogworkDay: stubFetchLogworkDay,
    fetchDayLogs: async (args) => {
      fetchedDayLogs.push(args);
      return {
        ok: true,
        logs: [{ logtimes: 2, task_name: 'Maintenance mode' }]
      };
    }
  });

  assert.equal(byName.totals.loggedHours, 2);
  assert.equal(byName.entries.length, 1);
  assert.equal(byName.days[0].projects[0].entries[0].taskName, 'Maintenance mode');
  assert.match(byName.summary, /2026-06-05\n- Course Builder: 2h logged \/ 4h booked\n  - \+2h Maintenance mode/);
  assert.equal(fetchedDayLogs.at(-1).projectId, 100);
});

test('queryLogwork skips fallback when includeEntries is false', async () => {
  let fallbackCalls = 0;
  const result = await queryLogwork({
    date: '2026-06-05',
    includeEntries: false,
    fetchRange: async () => records,
    fetchDayLogs: async () => {
      fallbackCalls += 1;
      return { ok: true, logs: [] };
    }
  });

  assert.equal(result.entries.length, 0);
  assert.equal(fallbackCalls, 0);
});

test('queryLogwork exposes normalization warnings without changing query fields', async () => {
  const normalizedRecords = normalizeTimesheetRange({
    data: [
      {
        date: '2026-06-05',
        project_member_id: 5352,
        project_id: 100,
        project_name: 'Course Builder',
        booked_hours: 'bad-hours',
        logged_hours: 0
      }
    ]
  }, {
    from: '2026-06-05',
    to: '2026-06-06'
  });

  const result = await queryLogwork({
    date: '2026-06-05',
    includeEntries: false,
    cwd: '/private/tmp/no-config-here',
    fetchRange: async () => normalizedRecords
  });

  assert.deepEqual(Object.keys(result).sort(), [
    'days',
    'entries',
    'f03ByDate',
    'missingDetailEntries',
    'normalization',
    'projects',
    'range',
    'rejectedEntries',
    'summary',
    'totals',
    'unmatchedProjectFilter'
  ]);
  assert.equal(result.totals.bookedHours, 0);
  assert.equal(result.days[0].projects[0].bookedHours, 0);
  assert.equal(result.normalization.status, 'warning');
  assert.deepEqual(result.normalization.warnings.map((warning) => warning.reason), ['invalid_hours']);
});

test('queryLogwork accepts explicit range records and normalization result', async () => {
  const rangeResult = normalizeTimesheetRangeResult({
    data: [
      {
        date: '2026-06-05',
        project_member_id: 5352,
        project_id: 100,
        project_name: 'Course Builder',
        booked_hours: 4,
        logged_hours: 'bad-hours'
      }
    ]
  }, {
    from: '2026-06-05',
    to: '2026-06-06'
  });

  const result = await queryLogwork({
    date: '2026-06-05',
    includeEntries: false,
    cwd: '/private/tmp/no-config-here',
    fetchRange: async () => rangeResult
  });

  assert.equal(result.totals.bookedHours, 4);
  assert.equal(result.totals.loggedHours, 0);
  assert.equal(result.normalization.status, 'warning');
  assert.deepEqual(result.normalization.warnings.map((warning) => warning.reason), ['invalid_hours']);
});

test('collectEntries fetches detail logs for records with logged hours even when timesheet has entries', async () => {
  const calls = [];
  const detail = await collectEntries([
    {
      ...records[0],
      entries: [{ logtimes: 99, task_name: 'Timesheet stale entry' }]
    }
  ], async (args) => {
    calls.push(args);
    return {
      entries: [
        {
          date: '2026-06-05',
          projectId: 100,
          projectName: 'Course Builder',
          hours: 2,
          taskName: 'Detail API task'
        }
      ]
    };
  });

  assert.equal(calls.length, 1);
  assert.equal(detail.entries[0].taskName, 'Detail API task');
  assert.deepEqual(detail.missingDetailEntries, []);
});

test('collectEntries reports missing detail entries when logged hours have no task detail', async () => {
  const detail = await collectEntries([
    records[0]
  ], async () => ({ entries: [] }));

  assert.equal(detail.entries.length, 0);
  assert.deepEqual(detail.missingDetailEntries, [
    {
      date: '2026-06-05',
      projectMemberId: 5352,
      projectId: 100,
      projectName: 'Course Builder',
      loggedHours: 2
    }
  ]);
});

test('queryLogwork lists detailed project logs from real timesheet shape only for logged days', async () => {
  const detailCalls = [];
  const timesheetRecords = [
    {
      date: '2026-06-01',
      projectMemberId: 5234,
      projectId: 643,
      projectName: '2621A-SIT-HTML BUILDER-PRJ',
      bookedHours: 8,
      loggedHours: 8,
      entries: []
    },
    {
      date: '2026-06-02',
      projectMemberId: 5234,
      projectId: 643,
      projectName: '2621A-SIT-HTML BUILDER-PRJ',
      bookedHours: 8,
      loggedHours: 0,
      entries: []
    }
  ];

  const result = await queryLogwork({
    from: '2026-06-01',
    to: '2026-06-03',
    fetchRange: async () => timesheetRecords,
    fetchLogworkDay: stubFetchLogworkDay,
    fetchDayLogs: async (args) => {
      detailCalls.push(args);
      return {
        entries: [
          {
            id: 1,
            date: '2026-06-01',
            projectId: 643,
            projectName: '2621A-SIT-HTML BUILDER-PRJ',
            hours: 3,
            taskName: 'Maintenance mode'
          },
          {
            id: 2,
            date: '2026-06-01',
            projectId: 643,
            projectName: '2621A-SIT-HTML BUILDER-PRJ',
            hours: 5,
            taskName: 'Question set UI'
          }
        ]
      };
    }
  });

  assert.deepEqual(detailCalls, [
    {
      date: '2026-06-01',
      projectId: 643,
      projectMemberId: 5234,
      projectName: '2621A-SIT-HTML BUILDER-PRJ'
    }
  ]);
  assert.equal(result.days.length, 2);
  assert.equal(result.days[0].projects[0].entries.length, 2);
  assert.equal(result.days[0].projects[0].entries[0].taskName, 'Maintenance mode');
  assert.equal(result.days[1].projects[0].entries.length, 0);
  assert.match(result.summary, /2026-06-01\n- 2621A-SIT-HTML BUILDER-PRJ: 8h logged \/ 8h booked\n  - \[logworkId: 1\] \+3h Maintenance mode\n  - \[logworkId: 2\] \+5h Question set UI/);
});
