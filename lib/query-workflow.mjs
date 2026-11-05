import { CONFIG } from '../config.mjs';
import { getFreshToken, getUserIdFromJwt } from './auth.mjs';
import {
  ApiError,
  combineNormalizationDiagnostics,
  getDayLogs,
  getLogworkDay,
  getLogworkRejected,
  getNormalizationDiagnostics,
  getTimesheetRangeResult
} from './api.mjs';
import { enrichEntriesWithLogworkF03 } from './logwork-f03-enrich.mjs';
import { loadLocalConfig } from './logwork-config.mjs';
import {
  normalizeProjectName,
  projectIdentityKey,
  projectMatchesFilter,
  projectMatchesMapping,
  sameProjectIdentity
} from './project-identity.mjs';
import { addLocalDays, todayLocalDateISO } from './util.mjs';

export async function queryLogwork({
  date,
  from,
  to,
  period,
  project,
  includeEntries = true,
  cwd = process.cwd(),
  fetchRange,
  fetchDayLogs,
  fetchLogworkDay,
  includeRejected = false
} = {}) {
  const range = normalizeQueryRange({ date, from, to, period });
  const config = await loadLocalConfig(cwd);
  const rangeFetcher = fetchRange || createTimesheetRangeFetcher();
  const dayLogsFetcher = fetchDayLogs || createDayLogsFetcher();
  const rangeResult = normalizeRangeResult(await rangeFetcher(range));
  const records = rangeResult.records;
  const filterResult = filterRecordsByProject(records, project, config);
  const filteredRecords = filterResult.records;
  const detail = includeEntries
    ? await collectEntries(filteredRecords, dayLogsFetcher)
    : { entries: [], missingDetailEntries: [] };

  const f03DayFetcher = fetchLogworkDay || createLogworkDayFetcher();
  const uniqueDates = [...new Set(filteredRecords.map((record) => record.date).filter(Boolean))];
  const f03Enrichment = await enrichEntriesWithLogworkF03(detail.entries, {
    dates: uniqueDates,
    fetchLogworkDay: async (date) => f03DayFetcher(date)
  });

  const rejectedEntries = includeRejected
    ? await createLogworkRejectedFetcher()()
    : [];

  const normalization = combineNormalizationDiagnostics(rangeResult.normalization, detail.normalization);
  const totals = buildTotals(filteredRecords);

  const payload = {
    range,
    totals,
    days: buildDays(filteredRecords, detail.entries),
    projects: buildProjects(filteredRecords),
    entries: f03Enrichment.entries,
    f03ByDate: f03Enrichment.f03ByDate,
    rejectedEntries,
    missingDetailEntries: detail.missingDetailEntries,
    normalization,
    unmatchedProjectFilter: filterResult.unmatchedProjectFilter,
    summary: formatQuerySummary(
      filteredRecords,
      detail.entries,
      range,
      filterResult.unmatchedProjectFilter,
      detail.missingDetailEntries,
      normalization,
      totals
    )
  };

  return payload;
}

export function normalizeQueryRange({ date, from, to, period } = {}) {
  if (date) {
    return {
      from: assertDateOnly(date, 'date'),
      to: addLocalDays(assertDateOnly(date, 'date'), 1)
    };
  }

  if (from || to) {
    const start = assertDateOnly(from || todayLocalDateISO(), 'from');
    const end = assertDateOnly(to || addLocalDays(start, 1), 'to');
    if (end <= start) {
      throw new Error('to must be after from.');
    }

    return { from: start, to: end };
  }

  if (period === 'this_week') {
    return currentWeekRange();
  }

  if (period === 'last_week') {
    return lastWeekRange();
  }

  if (period === 'this_month') {
    return currentMonthRange();
  }

  if (period === 'last_month') {
    return lastMonthRange();
  }

  const today = todayLocalDateISO();
  if (period === 'yesterday') {
    return {
      from: addLocalDays(today, -1),
      to: today
    };
  }

  return {
    from: today,
    to: addLocalDays(today, 1)
  };
}

export function filterRecordsByProject(records, projectFilter, config = {}) {
  if (projectFilter === undefined || projectFilter === null || String(projectFilter).trim() === '') {
    return {
      records,
      unmatchedProjectFilter: null
    };
  }

  const filter = String(projectFilter).trim();
  const matches = records.filter((record) => recordMatchesFilter(record, filter, config));
  const candidates = uniqueProjects(records);

  if (!matches.length) {
    return {
      records: [],
      unmatchedProjectFilter: {
        filter,
        candidates
      }
    };
  }

  return {
    records: matches,
    unmatchedProjectFilter: null
  };
}

export function buildTotals(records) {
  return records.reduce((totals, record) => ({
    bookedHours: roundHours(totals.bookedHours + Number(record.bookedHours || 0)),
    loggedHours: roundHours(totals.loggedHours + Number(record.loggedHours || 0)),
    projectCount: new Set([...totals.projectKeys, projectIdentityKey(record)]).size,
    dayCount: new Set([...totals.days, record.date]).size,
    projectKeys: [...new Set([...totals.projectKeys, projectIdentityKey(record)])],
    days: [...new Set([...totals.days, record.date])]
  }), {
    bookedHours: 0,
    loggedHours: 0,
    projectCount: 0,
    dayCount: 0,
    projectKeys: [],
    days: []
  });
}

export async function collectEntries(records, fetchDayLogs) {
  const entries = [];
  const missingDetailEntries = [];
  const normalizationItems = [];

  for (const record of records) {
    if (!record.loggedHours || !record.projectId) {
      continue;
    }

    const dayLogs = await fetchDayLogs({
      date: record.date,
      projectId: record.projectId,
      projectMemberId: record.projectMemberId,
      projectName: record.projectName
    });
    normalizationItems.push(dayLogs.normalization);

    const detailEntries = dayLogs.entries?.length
      ? dayLogs.entries
      : (dayLogs.logs || []).map((log) => sanitizeEntry(log, record));

    if (!detailEntries.length) {
      missingDetailEntries.push({
        date: record.date,
        projectMemberId: record.projectMemberId,
        projectId: record.projectId,
        projectName: record.projectName,
        loggedHours: record.loggedHours
      });
      continue;
    }

    for (const entry of detailEntries) {
      entries.push(sanitizeEntry(entry, record));
    }
  }

  return {
    entries,
    missingDetailEntries,
    normalization: combineNormalizationDiagnostics(...normalizationItems)
  };
}

export function createTimesheetRangeFetcher() {
  const session = createResourceOptimiserSession();
  return async (range) => {
    const { token, userId } = await session.get();
    try {
      return await getTimesheetRangeResult(token, userId, range);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) {
        throw error;
      }

      const refreshed = await session.get({ forceLogin: true });
      return getTimesheetRangeResult(refreshed.token, refreshed.userId, range);
    }
  };
}

export function createLogworkDayFetcher() {
  const session = createResourceOptimiserSession();
  return async (date) => {
    const { token } = await session.get();
    try {
      return await getLogworkDay(token, { date });
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) {
        throw error;
      }
      const refreshed = await session.get({ forceLogin: true });
      return getLogworkDay(refreshed.token, { date });
    }
  };
}

export function createLogworkRejectedFetcher() {
  const session = createResourceOptimiserSession();
  return async () => {
    const { token } = await session.get();
    try {
      return await getLogworkRejected(token);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) {
        throw error;
      }
      const refreshed = await session.get({ forceLogin: true });
      return getLogworkRejected(refreshed.token);
    }
  };
}

export function createDayLogsFetcher() {
  const session = createResourceOptimiserSession();
  return async ({ date, projectId }) => {
    const { token, userId } = await session.get();
    try {
      return await getDayLogs(token, projectId, userId, date);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) {
        throw error;
      }

      const refreshed = await session.get({ forceLogin: true });
      return getDayLogs(refreshed.token, projectId, refreshed.userId, date);
    }
  };
}

export function createResourceOptimiserSession() {
  let cached = null;

  return {
    async get({ forceLogin = false } = {}) {
      if (cached && !forceLogin) {
        return cached;
      }

      const token = await getFreshToken({
        interactive: false,
        forceLogin
      });
      cached = {
        token,
        userId: getUserIdFromJwt(token)
      };
      return cached;
    }
  };
}

function buildDays(records, entries) {
  const byDate = new Map();
  for (const record of records) {
    const existing = byDate.get(record.date) || {
      date: record.date,
      bookedHours: 0,
      loggedHours: 0,
      projects: []
    };
    existing.bookedHours = roundHours(existing.bookedHours + Number(record.bookedHours || 0));
    existing.loggedHours = roundHours(existing.loggedHours + Number(record.loggedHours || 0));
    existing.projects.push({
      ...projectSummary(record),
      entries: entries.filter((entry) => (
        entry.date === record.date &&
        sameProjectIdentity(entry, record)
      ))
    });
    byDate.set(record.date, existing);
  }

  for (const day of byDate.values()) {
    day.entries = entries.filter((entry) => entry.date === day.date);
  }

  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function buildProjects(records) {
  const byProject = new Map();
  for (const record of records) {
    const key = projectIdentityKey(record);
    const existing = byProject.get(key) || {
      projectMemberId: record.projectMemberId,
      projectId: record.projectId,
      projectName: record.projectName,
      bookedHours: 0,
      loggedHours: 0,
      dates: []
    };
    existing.bookedHours = roundHours(existing.bookedHours + Number(record.bookedHours || 0));
    existing.loggedHours = roundHours(existing.loggedHours + Number(record.loggedHours || 0));
    existing.dates = [...new Set([...existing.dates, record.date])].sort();
    byProject.set(key, existing);
  }

  return [...byProject.values()].sort((left, right) => left.projectName.localeCompare(right.projectName));
}

function recordMatchesFilter(record, filter, config) {
  if (projectMatchesFilter(record, filter)) {
    return true;
  }

  return (config.projectMappings || []).some((mapping) => {
    if (!projectMatchesMapping(record, mapping, { fallbackToName: true })) {
      return false;
    }

    const normalizedFilter = normalizeProjectName(filter);
    return (mapping.tickets || []).some((ticket) => normalizeProjectName(ticket) === normalizedFilter) ||
      (mapping.keywords || []).some((keyword) => {
        const normalizedKeyword = normalizeProjectName(keyword);
        return normalizedKeyword &&
          (normalizedKeyword.includes(normalizedFilter) || normalizedFilter.includes(normalizedKeyword));
      });
  });
}

function uniqueProjects(records) {
  return buildProjects(records).map((project) => ({
    projectMemberId: project.projectMemberId,
    projectId: project.projectId,
    projectName: project.projectName
  }));
}

function sanitizeEntry(entry, record) {
  const hours = Number(entry.hours ?? entry.logtimes ?? entry.time ?? 0);
  return {
    id: entry.id ?? entry.logtime_id ?? entry.logtimeId,
    date: entry.date || normalizeDateOnly(entry.logdate ?? entry.log_date) || record.date,
    projectMemberId: entry.projectMemberId ?? entry.project_member_id ?? record.projectMemberId,
    projectId: entry.projectId ?? entry.project_id ?? record.projectId,
    projectName: entry.projectName ?? entry.project_name ?? record.projectName,
    hours: Number.isFinite(hours) && hours > 0 ? hours : 0,
    taskName: entry.taskName ?? entry.task_name ?? entry.name ?? entry.title ?? ''
  };
}

function projectSummary(record) {
  return {
    projectMemberId: record.projectMemberId,
    projectId: record.projectId,
    projectName: record.projectName,
    bookedHours: record.bookedHours,
    loggedHours: record.loggedHours
  };
}

function assertDateOnly(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${name} must use YYYY-MM-DD format.`);
  }

  return value;
}

function currentWeekRange(date = new Date()) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = start.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  start.setDate(start.getDate() + diffToMonday);
  const end = new Date(start);
  end.setDate(start.getDate() + 7);

  return {
    from: formatLocalDate(start),
    to: formatLocalDate(end)
  };
}

function lastWeekRange(date = new Date()) {
  const current = currentWeekRange(date);
  return {
    from: addLocalDays(current.from, -7),
    to: current.from
  };
}

function currentMonthRange(date = new Date()) {
  const start = new Date(date.getFullYear(), date.getMonth(), 1);
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 1);

  return {
    from: formatLocalDate(start),
    to: formatLocalDate(end)
  };
}

function lastMonthRange(date = new Date()) {
  const start = new Date(date.getFullYear(), date.getMonth() - 1, 1);
  const end = new Date(date.getFullYear(), date.getMonth(), 1);

  return {
    from: formatLocalDate(start),
    to: formatLocalDate(end)
  };
}

function formatLocalDate(date) {
  return [
    String(date.getFullYear()).padStart(4, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function normalizeDateOnly(value) {
  if (!value) {
    return '';
  }

  return String(value).match(/\d{4}-\d{2}-\d{2}/)?.[0] || '';
}

function roundHours(value) {
  return Number(Number(value || 0).toFixed(2));
}

function normalizeRangeResult(result) {
  if (Array.isArray(result)) {
    return {
      records: result,
      normalization: getNormalizationDiagnostics(result)
    };
  }

  if (result && Array.isArray(result.records)) {
    return {
      records: result.records,
      normalization: result.normalization || getNormalizationDiagnostics(result.records)
    };
  }

  return {
    records: [],
    normalization: getNormalizationDiagnostics(result)
  };
}

function formatQuerySummary(
  records,
  entries,
  range,
  unmatchedProjectFilter,
  missingDetailEntries = [],
  normalization = null,
  totals = buildTotals(records)
) {
  if (unmatchedProjectFilter) {
    return `No logwork projects matched "${unmatchedProjectFilter.filter}" from ${range.from} to ${range.to}.`;
  }

  const lines = [
    `Logwork from ${range.from} to ${range.to}: ${totals.loggedHours}h logged / ${totals.bookedHours}h booked.`
  ];

  if (totals.bookedHours === 0 && totals.loggedHours > 0) {
    lines.push('Booked hours are 0 but logged hours exist; check timesheet normalization warnings before assuming no booking.');
    const warningReasons = [...new Set((normalization?.warnings || []).map((warning) => warning.reason).filter(Boolean))];
    if (warningReasons.length) {
      lines.push(`Timesheet warnings: ${warningReasons.join(', ')}.`);
    }
  }

  for (const day of buildDays(records, entries)) {
    lines.push(day.date);
    for (const project of day.projects) {
      lines.push(`- ${project.projectName}: ${project.loggedHours}h logged / ${project.bookedHours}h booked`);
      for (const entry of project.entries) {
        const id = entry.id === undefined || entry.id === null || entry.id === ''
          ? ''
          : ` [logworkId: ${entry.id}]`;
        const statusSuffix = entry.status ? ` (${entry.status})` : '';
        lines.push(`  -${id} +${entry.hours}h ${entry.taskName || '(no task name)'}${statusSuffix}`);
      }
    }
  }

  if (missingDetailEntries.length) {
    lines.push('Missing detail entries:');
    for (const missing of missingDetailEntries) {
      lines.push(`- ${missing.date}: ${missing.projectName} has ${missing.loggedHours}h logged but no task detail returned.`);
    }
  }

  return lines.join('\n');
}
