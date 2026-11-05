import test from 'node:test';
import assert from 'node:assert/strict';
import {
  apiFetch,
  getDayLogs,
  getNormalizationDiagnostics,
  getTimesheetRange,
  getTimesheetRangeResult,
  normalizeLogtimeEntries,
  normalizeTimesheetRange,
  normalizeTimesheetRangeResult
} from '../lib/api.mjs';

test('apiFetch retries idempotent read failures and returns successful response', async () => {
  let calls = 0;
  const data = await apiFetch('token', '/retry-read', {
    retries: 1,
    retryDelayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response('temporary outage', { status: 503, statusText: 'Service Unavailable' });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
  });

  assert.equal(calls, 2);
  assert.deepEqual(data, { ok: true });
});

test('apiFetch does not retry non-idempotent writes', async () => {
  let calls = 0;

  await assert.rejects(
    apiFetch('token', '/write', {
      method: 'PATCH',
      body: JSON.stringify({ ok: true }),
      retries: 5,
      retryDelayMs: 0,
      fetchImpl: async () => {
        calls += 1;
        return new Response('temporary outage', { status: 503, statusText: 'Service Unavailable' });
      }
    }),
    /503/
  );

  assert.equal(calls, 1);
});

test('apiFetch redacts sensitive response bodies in errors', async () => {
  const sensitiveToken = makeJwt({ id: 115 });

  await assert.rejects(
    apiFetch('token', '/bad', {
      fetchImpl: async () => new Response(JSON.stringify({
        accessToken: sensitiveToken,
        password: 'secret-password',
        detail: 'failed'
      }), { status: 500, statusText: 'Internal Server Error' })
    }),
    (error) => {
      assert.match(error.message, /Body:/);
      assert.equal(error.message.includes(sensitiveToken), false);
      assert.equal(error.message.includes('secret-password'), false);
      assert.equal(error.body.includes(sensitiveToken), false);
      assert.equal(error.body.includes('secret-password'), false);
      return true;
    }
  );
});

test('getTimesheetRange builds expected query params', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = new URL(url);
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    await getTimesheetRange('token', 115, {
      from: '2026-05-18',
      to: '2026-06-29'
    });

    assert.equal(requestedUrl.pathname, '/api/v1/member-logtime/timesheet');
    assert.equal(requestedUrl.searchParams.get('f_user_id'), '115');
    assert.equal(requestedUrl.searchParams.get('f_from'), '2026-05-18T00:00:00.000Z');
    assert.equal(requestedUrl.searchParams.get('f_to'), '2026-06-29T00:00:00.000Z');
    assert.equal(requestedUrl.searchParams.get('f_timesheet_by_week'), '0');
    assert.equal(requestedUrl.searchParams.get('f_time_off'), '1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('getTimesheetRangeResult builds expected query params and returns explicit normalization shape', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = new URL(url);
    return new Response(JSON.stringify({
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
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    const result = await getTimesheetRangeResult('token', 115, {
      from: '2026-06-05',
      to: '2026-06-06'
    });

    assert.equal(requestedUrl.pathname, '/api/v1/member-logtime/timesheet');
    assert.equal(requestedUrl.searchParams.get('f_user_id'), '115');
    assert.equal(requestedUrl.searchParams.get('f_from'), '2026-06-05T00:00:00.000Z');
    assert.equal(requestedUrl.searchParams.get('f_to'), '2026-06-06T00:00:00.000Z');
    assert.deepEqual(Object.keys(result).sort(), ['normalization', 'records']);
    assert.equal(result.records.length, 1);
    assert.equal(result.normalization.status, 'warning');
    assert.deepEqual(result.normalization.warnings.map((warning) => warning.reason), ['invalid_hours']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('normalizeTimesheetRange returns day/project records and totals duplicate rows', () => {
  const records = normalizeTimesheetRange({
    data: [
      {
        date: '2026-06-05',
        project_member_id: 5352,
        project_id: 100,
        project_name: 'Course Builder',
        booked_hours: 4,
        logged_hours: 2,
        logs: [{ id: 1, logtimes: 2, task_name: 'A' }]
      },
      {
        logdate: '2026-06-05T00:00:00.000Z',
        project_member_id: 5352,
        project_id: 100,
        project_name: 'Course Builder',
        booked_hours: 2,
        logged_hours: 1
      },
      {
        date: '2026-06-06',
        project_member_id: 9999,
        project_id: 200,
        project_name: 'Internal',
        booked_hours: 1,
        logged_hours: 0
      }
    ]
  }, {
    from: '2026-06-05',
    to: '2026-06-07'
  });

  assert.equal(records.length, 2);
  assert.deepEqual(records[0], {
    date: '2026-06-05',
    projectMemberId: 5352,
    projectId: 100,
    projectName: 'Course Builder',
    bookedHours: 6,
    loggedHours: 3,
    entries: [
      {
        id: 1,
        date: '2026-06-05',
        projectMemberId: 5352,
        projectId: 100,
        projectName: 'Course Builder',
        hours: 2,
        taskName: 'A',
        raw: { id: 1, logtimes: 2, task_name: 'A' }
      }
    ],
    raw: [
      {
        date: '2026-06-05',
        project_member_id: 5352,
        project_id: 100,
        project_name: 'Course Builder',
        booked_hours: 4,
        logged_hours: 2,
        logs: [{ id: 1, logtimes: 2, task_name: 'A' }]
      },
      {
        logdate: '2026-06-05T00:00:00.000Z',
        project_member_id: 5352,
        project_id: 100,
        project_name: 'Course Builder',
        booked_hours: 2,
        logged_hours: 1
      }
    ]
  });
});

test('normalizeTimesheetRangeResult returns explicit records and normalization metadata', () => {
  const result = normalizeTimesheetRangeResult({
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

  assert.deepEqual(Object.keys(result).sort(), ['normalization', 'records']);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].bookedHours, 0);
  assert.equal(result.normalization.status, 'warning');
  assert.deepEqual(result.normalization.warnings.map((warning) => warning.reason), ['invalid_hours']);
  assert.deepEqual(getNormalizationDiagnostics(result.records), result.normalization);
});

test('normalizeTimesheetRange keeps legacy array return shape for compatibility', () => {
  const records = normalizeTimesheetRange({
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

  assert.equal(Array.isArray(records), true);
  assert.deepEqual(Object.keys(records), ['0']);
  assert.equal(getNormalizationDiagnostics(records).status, 'warning');
});

test('normalizeTimesheetRange expands real project timesheet shape and ignores overall', () => {
  const records = normalizeTimesheetRange({
    data: [
      {
        id: 5234,
        user_id: 115,
        project: {
          id: 643,
          name: '2621A-SIT-HTML BUILDER-PRJ',
          is_internal: false
        },
        timesheet: [
          {
            logdate: '2026-06-01T00:00:00.000Z',
            logtimes: 8,
            assign_percent: 8,
            overtime: 0
          },
          {
            logdate: '2026-06-02T00:00:00.000Z',
            logtimes: 0,
            assign_percent: 8,
            overtime: 0
          }
        ]
      }
    ],
    overall: [
      {
        logdate: '2026-06-01T00:00:00.000Z',
        logtimes: 99,
        assign_percent: 99,
        overtime: 0
      }
    ]
  }, {
    from: '2026-06-01',
    to: '2026-06-03'
  });

  assert.deepEqual(records, [
    {
      date: '2026-06-01',
      projectMemberId: 5234,
      projectId: 643,
      projectName: '2621A-SIT-HTML BUILDER-PRJ',
      bookedHours: 8,
      loggedHours: 8,
      entries: [],
      raw: [
        {
          date: '2026-06-01',
          projectMemberId: 5234,
          project_member_id: 5234,
          projectId: 643,
          project_id: 643,
          projectName: '2621A-SIT-HTML BUILDER-PRJ',
          project_name: '2621A-SIT-HTML BUILDER-PRJ',
          bookedHours: 8,
          loggedHours: 8,
          overtime: 0,
          source: 'timesheet'
        }
      ]
    },
    {
      date: '2026-06-02',
      projectMemberId: 5234,
      projectId: 643,
      projectName: '2621A-SIT-HTML BUILDER-PRJ',
      bookedHours: 8,
      loggedHours: 0,
      entries: [],
      raw: [
        {
          date: '2026-06-02',
          projectMemberId: 5234,
          project_member_id: 5234,
          projectId: 643,
          project_id: 643,
          projectName: '2621A-SIT-HTML BUILDER-PRJ',
          project_name: '2621A-SIT-HTML BUILDER-PRJ',
          bookedHours: 8,
          loggedHours: 0,
          overtime: 0,
          source: 'timesheet'
        }
      ]
    }
  ]);
});

test('normalizeTimesheetRange reports dropped rows and malformed hour diagnostics', () => {
  const records = normalizeTimesheetRange({
    data: [
      {
        date: '2026-06-01',
        project_member_id: 1111,
        project_name: 'Malformed Hours',
        booked_hours: 'not-a-number',
        logged_hours: -2
      },
      {
        date: '2026-06-01',
        booked_hours: 2,
        logged_hours: 1
      },
      {
        project_member_id: 2222,
        booked_hours: 1
      },
      {
        date: '2026-06-01',
        project_member_id: 3333,
        project_name: 'Valid Project',
        booked_hours: 2,
        logged_hours: 1
      }
    ]
  }, {
    from: '2026-06-01',
    to: '2026-06-02'
  });

  assert.equal(records.length, 2);
  assert.equal(records[0].projectMemberId, 1111);
  assert.equal(records[0].bookedHours, 0);
  assert.equal(records[0].loggedHours, 0);
  assert.equal(records[1].projectMemberId, 3333);
  assert.equal(records[1].bookedHours, 2);
  assert.equal(records[1].loggedHours, 1);

  const diagnostics = getNormalizationDiagnostics(records);
  assert.equal(diagnostics.status, 'warning');
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

test('normalizeTimesheetRange scans fallback hour fields after invalid values', () => {
  const records = normalizeTimesheetRange({
    data: [
      {
        date: '2026-06-01',
        project_member_id: 1111,
        project_name: 'Fallback Hours',
        assign_hours: 'not-a-number',
        assigned_hours: 6,
        logged_hours: 'also-bad',
        logtimes: 2
      }
    ]
  }, {
    from: '2026-06-01',
    to: '2026-06-02'
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].bookedHours, 6);
  assert.equal(records[0].loggedHours, 2);
  assert.deepEqual(getNormalizationDiagnostics(records).warnings.map((warning) => warning.field), [
    'assign_hours',
    'logged_hours'
  ]);
});

test('normalizeTimesheetRange reports unknown API envelope without throwing away context silently', () => {
  const records = normalizeTimesheetRange({
    data: {
      unexpected: true
    }
  }, {
    from: '2026-06-01',
    to: '2026-06-02'
  });

  assert.deepEqual(records, []);
  assert.deepEqual(getNormalizationDiagnostics(records), {
    status: 'warning',
    sourceShape: 'range_scan',
    rowsRead: 0,
    rowsAccepted: 0,
    droppedRowCount: 0,
    warningCount: 1,
    warnings: [
      {
        reason: 'unknown_timesheet_shape'
      }
    ],
    droppedRows: []
  });
});

test('getDayLogs builds expected detail query params', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = new URL(url);
    return new Response(JSON.stringify({
      data: [{ id: 1, logtimes: 2, task_name: 'Task A' }]
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    const result = await getDayLogs('token', 643, 115, '2026-06-01');

    assert.equal(requestedUrl.pathname, '/api/v1/member-logtime');
    assert.equal(requestedUrl.searchParams.get('f_user_id'), '115');
    assert.equal(requestedUrl.searchParams.get('f_project_id'), '643');
    assert.equal(requestedUrl.searchParams.get('f_logdate'), '2026-06-01T00:00:00.000Z');
    assert.equal(result.entries[0].taskName, 'Task A');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('normalizeLogtimeEntries returns sanitized task entries', () => {
  const entries = normalizeLogtimeEntries([
    {
      id: 99,
      logdate: '2026-06-01T00:00:00.000Z',
      project_id: 643,
      project_name: 'Course Builder',
      logtimes: 1.5,
      task_name: 'Question bank cleanup',
      token: 'must-not-appear'
    }
  ], {
    date: '2026-06-01'
  });

  assert.deepEqual(entries, [
    {
      id: 99,
      date: '2026-06-01',
      projectMemberId: undefined,
      projectId: 643,
      projectName: 'Course Builder',
      hours: 1.5,
      taskName: 'Question bank cleanup'
    }
  ]);
});

test('normalizeLogtimeEntries reports dropped malformed detail rows', () => {
  const entries = normalizeLogtimeEntries([
    {
      id: 1,
      logdate: '2026-06-01T00:00:00.000Z',
      project_id: 643,
      logtimes: 1,
      task_name: 'Valid detail'
    },
    {
      id: 2,
      logdate: '2026-06-01T00:00:00.000Z',
      project_id: 643,
      logtimes: 'bad-hours',
      task_name: 'Bad hours'
    },
    {
      id: 3,
      logdate: '2026-06-01T00:00:00.000Z',
      logtimes: 1,
      task_name: 'Missing project'
    },
    {
      id: 4,
      project_id: 643,
      logtimes: 1,
      task_name: 'Missing date'
    }
  ]);

  assert.deepEqual(entries.map((entry) => entry.id), [1]);
  const diagnostics = getNormalizationDiagnostics(entries);
  assert.equal(diagnostics.rowsRead, 4);
  assert.equal(diagnostics.rowsAccepted, 1);
  assert.deepEqual(diagnostics.warnings.map((warning) => warning.reason), ['invalid_hours']);
  assert.deepEqual(diagnostics.droppedRows.map((row) => row.reason).sort(), [
    'missing_date',
    'missing_project_identity',
    'non_positive_hours'
  ]);
});

test('normalizeTimesheetRange avoids Project undefined fallback names', () => {
  const records = normalizeTimesheetRange([
    {
      date: '2026-06-01',
      project_member_id: 5234,
      bookedHours: 8,
      loggedHours: 2,
      logs: [
        {
          id: 1,
          logtimes: 2,
          task_name: 'Fallback project name task'
        }
      ]
    }
  ], {
    from: '2026-06-01',
    to: '2026-06-02'
  });

  assert.equal(records[0].projectName, 'Project 5234');
  assert.equal(records[0].entries[0].projectName, 'Project 5234');
  assert.equal(getNormalizationDiagnostics(records).warnings.filter((warning) => (
    warning.reason === 'fallback_project_name'
  )).length, 2);
});

function makeJwt(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature'
  ].join('.');
}
