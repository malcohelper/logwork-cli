import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReconciliationDays,
  normalizeReconciliationPeriod,
  queryJiraWorklogs,
  reconcileLogwork
} from '../lib/reconciliation-workflow.mjs';
import {
  parseReconcileArgs,
  runReconcileCommand
} from '../reconcile-cli.mjs';

test('reconciliation accepts preset periods only', () => {
  assert.equal(normalizeReconciliationPeriod('this-week'), 'this_week');
  assert.equal(normalizeReconciliationPeriod('last_month'), 'last_month');
  assert.equal(normalizeReconciliationPeriod('week'), 'this_week');
  assert.throws(() => normalizeReconciliationPeriod('2026-07-15'), /preset|period/i);
  assert.deepEqual(parseReconcileArgs(['last-week', '--json']), {
    period: 'last_week',
    json: true,
    help: false
  });
  assert.throws(() => parseReconcileArgs(['today', 'yesterday']), /exactly one/);
  assert.throws(() => parseReconcileArgs(['--from', '2026-07-01']), /Unknown reconcile option/);
});

test('Jira reconciliation queries the range and keeps only current-user worklogs', async () => {
  let searchCall;
  const result = await queryJiraWorklogs({
    range: {
      from: '2026-07-14',
      to: '2026-07-21'
    },
    getSession: async () => ({
      token: 'pat-not-returned',
      baseUrl: 'https://jira.example.com',
      user: {
        name: 'malco',
        displayName: 'Malco'
      }
    }),
    searchIssues: async (token, input, options) => {
      searchCall = { token, input, options };
      return [
        { key: 'SCB-213', summary: 'Validate beneficiary' },
        { key: 'SCB-218', summary: 'Retry transaction' }
      ];
    },
    fetchWorklogs: async (issueKey) => issueKey === 'SCB-213'
      ? [
        jiraWorklog({ id: '1', date: '2026-07-14', hours: 1.5, author: 'malco', comment: 'Validate beneficiary\n\n#lh:abc12345' }),
        jiraWorklog({ id: '2', date: '2026-07-14', hours: 3, author: 'another-user', comment: 'Other user work' }),
        jiraWorklog({ id: '3', date: '2026-07-22', hours: 1, author: 'malco', comment: 'Outside range' })
      ]
      : [jiraWorklog({ id: '4', date: '2026-07-15', hours: 0.5, author: 'malco', comment: 'Retry transaction' })]
  });

  assert.equal(searchCall.token, 'pat-not-returned');
  assert.equal(searchCall.input.jql, 'worklogAuthor = currentUser() AND worklogDate >= "2026-07-14" AND worklogDate < "2026-07-21"');
  assert.deepEqual(searchCall.input.fields, ['key', 'summary']);
  assert.equal(searchCall.options.baseUrl, 'https://jira.example.com');
  assert.equal(result.worklogCount, 2);
  assert.equal(result.hours, 2);
  assert.deepEqual(result.entries.map((entry) => entry.id), ['1', '4']);
  assert.equal(result.entries[0].taskName, 'Validate beneficiary');
  assert.doesNotMatch(JSON.stringify(result), /pat-not-returned/);
});

test('reconciliation reports daily mismatches and high-confidence issue suggestions', async () => {
  let jiraRange;
  const result = await reconcileLogwork({
    period: 'this_week',
    cwd: '/workspace/example',
    queryRo: async (input) => {
      assert.equal(input.period, 'this_week');
      assert.equal(input.includeEntries, true);
      assert.equal(input.cwd, '/workspace/example');
      return {
        totals: { bookedHours: 16, loggedHours: 14 },
        days: [
          { date: '2026-07-13', bookedHours: 8, loggedHours: 8 },
          { date: '2026-07-14', bookedHours: 8, loggedHours: 6 }
        ],
        entries: [
          roEntry('2026-07-13', 8, 'Implement API (SCB-210)'),
          roEntry('2026-07-14', 2, 'Validate beneficiary (SCB-213)'),
          roEntry('2026-07-14', 4, 'Retry transaction (SCB-218)')
        ]
      };
    },
    queryJira: async ({ range }) => {
      jiraRange = range;
      return {
        hours: 12.5,
        entries: [
          jiraEntry('2026-07-13', 8, 'SCB-210', 'Implement API'),
          jiraEntry('2026-07-14', 0.5, 'SCB-213', 'Validate beneficiary'),
          jiraEntry('2026-07-14', 4, 'SCB-218', 'Retry transaction')
        ]
      };
    }
  });

  assert.deepEqual(jiraRange, {
    from: result.range.from,
    to: result.range.to
  });
  assert.equal(result.status, 'mismatch');
  assert.equal(result.totals.roHours, 14);
  assert.equal(result.totals.jiraHours, 12.5);
  assert.equal(result.totals.differenceHours, -1.5);
  assert.equal(result.totals.mismatchDayCount, 1);
  assert.equal(result.days[0].status, 'matched');
  assert.equal(result.days[1].status, 'missing_jira');
  assert.deepEqual(result.suggestions, [{
    date: '2026-07-14',
    target: 'jira',
    issueKey: 'SCB-213',
    hours: 1.5,
    taskName: 'Validate beneficiary (SCB-213)',
    confidence: 'high',
    requiresProjectResolution: false
  }]);
  assert.match(result.summary, /Missing Jira/);
  assert.match(result.summary, /JIRA \+1.5h SCB-213/);
  assert.match(result.summary, /target-specific preview/);
});

test('equal daily totals still report task mismatch and missing RO project resolution', () => {
  const [day] = buildReconciliationDays({
    ro: {
      totals: { bookedHours: 2, loggedHours: 2 },
      days: [{ date: '2026-07-15', bookedHours: 2, loggedHours: 2 }],
      entries: [roEntry('2026-07-15', 2, 'Task A (SCB-213)')]
    },
    jira: {
      hours: 2,
      entries: [jiraEntry('2026-07-15', 2, 'SCB-218', 'Task B')]
    }
  });
  assert.equal(day.status, 'entry_mismatch');
  assert.equal(day.differenceHours, 0);
  assert.deepEqual(day.suggestions.map((suggestion) => ({
    target: suggestion.target,
    issueKey: suggestion.issueKey,
    hours: suggestion.hours,
    requiresProjectResolution: suggestion.requiresProjectResolution
  })), [
    { target: 'jira', issueKey: 'SCB-213', hours: 2, requiresProjectResolution: false },
    { target: 'ro', issueKey: 'SCB-218', hours: 2, requiresProjectResolution: true }
  ]);
});

test('reconcile CLI defaults to this week and supports JSON output', async () => {
  const output = [];
  const result = await runReconcileCommand(['--json'], {
    reconcile: async (input) => ({
      status: 'matched',
      input,
      summary: 'Matched'
    }),
    print: (value) => output.push(value)
  });
  assert.deepEqual(result.input, { period: 'this_week' });
  assert.deepEqual(JSON.parse(output[0]), result);
});

function jiraWorklog({ id, date, hours, author, comment }) {
  return {
    id,
    started: `${date}T09:00:00.000+0700`,
    timeSpentSeconds: hours * 3600,
    comment,
    author: {
      name: author,
      displayName: author
    }
  };
}

function roEntry(date, hours, taskName) {
  return {
    id: `${date}-${taskName}`,
    date,
    projectMemberId: 5352,
    projectId: 100,
    projectName: 'SCB Project',
    hours,
    taskName
  };
}

function jiraEntry(date, hours, issueKey, taskName) {
  return {
    id: `${date}-${issueKey}`,
    date,
    issueKey,
    issueSummary: taskName,
    hours,
    timeSpentSeconds: hours * 3600,
    taskName,
    comment: taskName,
    started: `${date}T09:00:00.000+0700`
  };
}
