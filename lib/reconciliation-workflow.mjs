import { ApiError } from './api.mjs';
import {
  getJiraIssueWorklogs,
  searchJiraIssues
} from './jira-api.mjs';
import {
  createJiraAuthRequiredError,
  getStoredJiraSession
} from './jira-auth.mjs';
import {
  normalizeQueryRange,
  queryLogwork
} from './query-workflow.mjs';

export const RECONCILIATION_PERIODS = [
  'today',
  'yesterday',
  'this_week',
  'last_week',
  'this_month',
  'last_month'
];

const ISSUE_KEY_REGEX = /\b[A-Z][A-Z0-9]+-\d+\b/g;

export async function reconcileLogwork({
  period = 'this_week',
  cwd = process.cwd(),
  queryRo = queryLogwork,
  queryJira = queryJiraWorklogs
} = {}) {
  const normalizedPeriod = normalizeReconciliationPeriod(period);
  const range = normalizeQueryRange({ period: normalizedPeriod });
  const [ro, jira] = await Promise.all([
    queryRo({
      period: normalizedPeriod,
      cwd,
      includeEntries: true
    }),
    queryJira({ range })
  ]);
  const days = buildReconciliationDays({ ro, jira });
  const totals = buildReconciliationTotals({ ro, jira, days });
  const suggestions = days.flatMap((day) => day.suggestions);

  return {
    status: totals.mismatchDayCount ? 'mismatch' : 'matched',
    period: normalizedPeriod,
    range,
    totals,
    days,
    suggestions,
    summary: formatReconciliationSummary({
      period: normalizedPeriod,
      range,
      totals,
      days,
      suggestions
    })
  };
}

export async function queryJiraWorklogs({
  range,
  getSession = getStoredJiraSession,
  searchIssues = searchJiraIssues,
  fetchWorklogs
} = {}) {
  assertRange(range);
  const session = await getSession();
  const currentUser = session.user;
  if (!hasJiraUserIdentity(currentUser)) {
    throw createJiraAuthRequiredError('Stored Jira session has no user identity. Run `logwork-helper jira login` again.');
  }
  const issueSearcher = searchIssues;
  const worklogFetcher = fetchWorklogs || ((issueKey) => getJiraIssueWorklogs(session.token, issueKey, {
    baseUrl: session.baseUrl
  }));
  const jql = `worklogAuthor = currentUser() AND worklogDate >= "${range.from}" AND worklogDate < "${range.to}"`;

  try {
    const issues = await issueSearcher(session.token, {
      jql,
      fields: ['key', 'summary'],
      pageSize: 100
    }, {
      baseUrl: session.baseUrl
    });
    const worklogGroups = await mapWithConcurrency(issues, 5, async (issue) => ({
      issue,
      worklogs: await worklogFetcher(issue.key)
    }));
    const entries = worklogGroups.flatMap(({ issue, worklogs }) => (
      (worklogs || [])
        .filter((worklog) => isCurrentUserWorklog(worklog, currentUser, range))
        .map((worklog) => normalizeJiraReconciliationEntry(issue, worklog))
    )).sort(compareEntries);

    return {
      range,
      issueCount: issues.length,
      worklogCount: entries.length,
      hours: roundHours(entries.reduce((sum, entry) => sum + entry.hours, 0)),
      entries,
      issues: issues.map((issue) => ({
        key: issue.key,
        summary: issue.summary
      }))
    };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      throw createJiraAuthRequiredError();
    }
    throw error;
  }
}

export function buildReconciliationDays({ ro = {}, jira = {} } = {}) {
  const roEntries = Array.isArray(ro.entries) ? ro.entries.map(normalizeRoEntry) : [];
  const jiraEntries = Array.isArray(jira.entries) ? jira.entries : [];
  const roDays = new Map((ro.days || []).map((day) => [day.date, day]));
  const dates = new Set([
    ...roDays.keys(),
    ...roEntries.map((entry) => entry.date),
    ...jiraEntries.map((entry) => entry.date)
  ]);

  return [...dates].sort().map((date) => {
    const dayRoEntries = roEntries.filter((entry) => entry.date === date);
    const dayJiraEntries = jiraEntries.filter((entry) => entry.date === date);
    const detailedRoHours = roundHours(dayRoEntries.reduce((sum, entry) => sum + entry.hours, 0));
    const roHours = roundHours(roDays.get(date)?.loggedHours ?? detailedRoHours);
    const jiraHours = roundHours(dayJiraEntries.reduce((sum, entry) => sum + entry.hours, 0));
    const bookedHours = roundHours(roDays.get(date)?.bookedHours || 0);
    const unverifiedRoHours = roundHours(Math.max(0, roHours - detailedRoHours));
    const issueComparisons = buildIssueComparisons(dayRoEntries, dayJiraEntries);
    const suggestions = buildCorrectionSuggestions(date, issueComparisons);
    const unmatchedRoEntries = dayRoEntries.filter((entry) => entry.issueKeys.length !== 1);
    const differenceHours = roundHours(jiraHours - roHours);

    return {
      date,
      bookedHours,
      roHours,
      jiraHours,
      differenceHours,
      missingOn: differenceHours < 0 ? 'jira' : differenceHours > 0 ? 'ro' : null,
      remainingBookedHours: roundHours(Math.max(0, bookedHours - roHours)),
      status: reconciliationDayStatus({
        bookedHours,
        roHours,
        jiraHours,
        issueComparisons,
        unmatchedRoEntries,
        unverifiedRoHours
      }),
      roEntries: dayRoEntries,
      jiraEntries: dayJiraEntries,
      issueComparisons,
      unmatchedRoEntries,
      unverifiedRoHours,
      suggestions
    };
  });
}

export function formatReconciliationSummary({
  period,
  range,
  totals,
  days,
  suggestions = []
} = {}) {
  const lines = [
    `RO / Jira reconciliation: ${formatPeriod(period)} (${range.from} to ${range.to}).`,
    '',
    'Date        Booked      RO    Jira    Diff  Status'
  ];
  if (!days.length) {
    lines.push('No Resource Optimiser or Jira worklogs found.');
  }
  for (const day of days) {
    lines.push([
      day.date,
      `${formatHours(day.bookedHours)}h`.padStart(7),
      `${formatHours(day.roHours)}h`.padStart(7),
      `${formatHours(day.jiraHours)}h`.padStart(7),
      formatSignedHours(day.differenceHours).padStart(7),
      formatDayStatus(day.status)
    ].join('  '));
  }
  lines.push('');
  lines.push(`Total: booked ${formatHours(totals.bookedHours)}h, RO ${formatHours(totals.roHours)}h, Jira ${formatHours(totals.jiraHours)}h, difference ${formatSignedHours(totals.differenceHours)}.`);
  lines.push(`Days: matched ${totals.matchedDayCount}, mismatched ${totals.mismatchDayCount}, incomplete ${totals.incompleteDayCount}, unverified ${totals.unverifiedDayCount}.`);

  if (suggestions.length) {
    lines.push('');
    lines.push('High-confidence correction suggestions:');
    for (const suggestion of suggestions) {
      lines.push(`- ${suggestion.date}: ${suggestion.target.toUpperCase()} +${formatHours(suggestion.hours)}h ${suggestion.issueKey} - ${suggestion.taskName}`);
    }
    lines.push('Create a normal target-specific preview before applying any suggestion.');
  }

  const unverifiedCount = days.reduce((sum, day) => sum + day.unmatchedRoEntries.length, 0);
  const missingDetailHours = roundHours(days.reduce((sum, day) => sum + day.unverifiedRoHours, 0));
  if (unverifiedCount || missingDetailHours) {
    lines.push('');
    if (unverifiedCount) {
      lines.push(`${unverifiedCount} RO entr${unverifiedCount === 1 ? 'y has' : 'ies have'} no single Jira issue key, so task-level reconciliation is unverified.`);
    }
    if (missingDetailHours) {
      lines.push(`${formatHours(missingDetailHours)}h of RO work has no task detail returned, so task-level reconciliation is unverified.`);
    }
  }
  return lines.join('\n');
}

export function normalizeReconciliationPeriod(value = 'this_week') {
  const normalized = String(value || 'this_week').trim().toLowerCase().replace(/-/g, '_');
  const aliases = {
    week: 'this_week',
    month: 'this_month'
  };
  const period = aliases[normalized] || normalized;
  if (!RECONCILIATION_PERIODS.includes(period)) {
    throw new Error('Reconciliation period must be today, yesterday, this-week, last-week, this-month, or last-month.');
  }
  return period;
}

function buildReconciliationTotals({ ro, jira, days }) {
  const bookedHours = roundHours(ro?.totals?.bookedHours ?? days.reduce((sum, day) => sum + day.bookedHours, 0));
  const roHours = roundHours(ro?.totals?.loggedHours ?? days.reduce((sum, day) => sum + day.roHours, 0));
  const jiraHours = roundHours(jira?.hours ?? days.reduce((sum, day) => sum + day.jiraHours, 0));
  return {
    bookedHours,
    roHours,
    jiraHours,
    differenceHours: roundHours(jiraHours - roHours),
    dayCount: days.length,
    matchedDayCount: days.filter((day) => day.status.startsWith('matched')).length,
    mismatchDayCount: days.filter((day) => ['missing_jira', 'missing_ro', 'entry_mismatch'].includes(day.status)).length,
    incompleteDayCount: days.filter((day) => day.remainingBookedHours > 0).length,
    unverifiedDayCount: days.filter((day) => day.status === 'matched_unverified').length,
    suggestionCount: days.reduce((sum, day) => sum + day.suggestions.length, 0)
  };
}

function buildIssueComparisons(roEntries, jiraEntries) {
  const issueKeys = new Set([
    ...roEntries.flatMap((entry) => entry.issueKeys.length === 1 ? entry.issueKeys : []),
    ...jiraEntries.map((entry) => entry.issueKey).filter(Boolean)
  ]);
  return [...issueKeys].sort().map((issueKey) => {
    const matchingRo = roEntries.filter((entry) => entry.issueKeys.length === 1 && entry.issueKeys[0] === issueKey);
    const matchingJira = jiraEntries.filter((entry) => entry.issueKey === issueKey);
    const roHours = roundHours(matchingRo.reduce((sum, entry) => sum + entry.hours, 0));
    const jiraHours = roundHours(matchingJira.reduce((sum, entry) => sum + entry.hours, 0));
    return {
      issueKey,
      roHours,
      jiraHours,
      differenceHours: roundHours(jiraHours - roHours),
      roEntries: matchingRo,
      jiraEntries: matchingJira
    };
  });
}

function buildCorrectionSuggestions(date, comparisons) {
  return comparisons.flatMap((comparison) => {
    if (comparison.differenceHours === 0) {
      return [];
    }
    const target = comparison.differenceHours < 0 ? 'jira' : 'ro';
    const sourceEntries = target === 'jira' ? comparison.roEntries : comparison.jiraEntries;
    const taskName = preferredTaskName(sourceEntries, comparison.issueKey);
    return [{
      date,
      target,
      issueKey: comparison.issueKey,
      hours: roundHours(Math.abs(comparison.differenceHours)),
      taskName,
      confidence: 'high',
      requiresProjectResolution: target === 'ro'
    }];
  });
}

function preferredTaskName(entries, issueKey) {
  const entry = [...entries].sort((left, right) => right.hours - left.hours)[0];
  const taskName = String(entry?.taskName || entry?.issueSummary || '').trim();
  return taskName || issueKey;
}

function reconciliationDayStatus({
  bookedHours,
  roHours,
  jiraHours,
  issueComparisons,
  unmatchedRoEntries,
  unverifiedRoHours
}) {
  const difference = roundHours(jiraHours - roHours);
  if (difference < 0) {
    return 'missing_jira';
  }
  if (difference > 0) {
    return 'missing_ro';
  }
  if (issueComparisons.some((comparison) => comparison.differenceHours !== 0)) {
    return 'entry_mismatch';
  }
  if ((unmatchedRoEntries.length || unverifiedRoHours > 0) && (roHours > 0 || jiraHours > 0)) {
    return 'matched_unverified';
  }
  if (bookedHours > roHours) {
    return 'matched_incomplete';
  }
  return 'matched';
}

function normalizeRoEntry(entry = {}) {
  const taskName = String(entry.taskName || '');
  return {
    id: entry.id,
    date: String(entry.date || ''),
    projectMemberId: entry.projectMemberId,
    projectId: entry.projectId,
    projectName: String(entry.projectName || ''),
    hours: roundHours(entry.hours),
    taskName,
    issueKeys: extractIssueKeys(taskName)
  };
}

function normalizeJiraReconciliationEntry(issue, worklog) {
  return {
    id: worklog.id,
    date: normalizeDateOnly(worklog.started),
    issueKey: issue.key,
    issueSummary: issue.summary || '',
    hours: roundHours(Number(worklog.timeSpentSeconds || 0) / 3600),
    timeSpentSeconds: Number(worklog.timeSpentSeconds || 0),
    taskName: stripJiraWorklogMarkers(worklog.comment) || issue.summary || issue.key,
    comment: String(worklog.comment || ''),
    started: String(worklog.started || '')
  };
}

function isCurrentUserWorklog(worklog, currentUser, range) {
  const date = normalizeDateOnly(worklog.started);
  return date >= range.from && date < range.to && sameJiraUser(worklog.author, currentUser);
}

function sameJiraUser(left, right) {
  for (const field of ['key', 'name', 'emailAddress']) {
    const leftValue = normalizeIdentity(left?.[field]);
    const rightValue = normalizeIdentity(right?.[field]);
    if (leftValue && rightValue && leftValue === rightValue) {
      return true;
    }
  }
  const leftDisplay = normalizeIdentity(left?.displayName);
  const rightDisplay = normalizeIdentity(right?.displayName);
  return Boolean(leftDisplay && rightDisplay && leftDisplay === rightDisplay);
}

function hasJiraUserIdentity(user) {
  return ['key', 'name', 'emailAddress', 'displayName'].some((field) => normalizeIdentity(user?.[field]));
}

function extractIssueKeys(value) {
  return [...new Set(String(value || '').toUpperCase().match(ISSUE_KEY_REGEX) || [])];
}

function stripJiraWorklogMarkers(value) {
  return String(value || '')
    .replace(/\s*#lh:[a-f0-9]{6,16}\s*/gi, ' ')
    .replace(/\s*\[logwork-helper:[^\]]+\]\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function assertRange(range) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(range?.from || '')) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(String(range?.to || '')) ||
      range.to <= range.from) {
    throw new Error('Jira reconciliation requires a valid exclusive date range.');
  }
}

function normalizeDateOnly(value) {
  return String(value || '').match(/\d{4}-\d{2}-\d{2}/)?.[0] || '';
}

function normalizeIdentity(value) {
  return String(value || '').trim().toLowerCase();
}

function compareEntries(left, right) {
  return left.date.localeCompare(right.date) || String(left.issueKey || '').localeCompare(String(right.issueKey || ''));
}

function formatDayStatus(status) {
  return ({
    matched: 'Matched',
    matched_incomplete: 'Matched, incomplete',
    matched_unverified: 'Matched, unverified tasks',
    missing_jira: 'Missing Jira',
    missing_ro: 'Missing RO',
    entry_mismatch: 'Task mismatch'
  })[status] || status;
}

function formatPeriod(period) {
  return String(period || '').replace(/_/g, ' ');
}

function formatSignedHours(value) {
  const number = roundHours(value);
  return `${number > 0 ? '+' : ''}${formatHours(number)}h`;
}

function formatHours(value) {
  return Number(value || 0).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

function roundHours(value) {
  return Number(Number(value || 0).toFixed(2));
}
