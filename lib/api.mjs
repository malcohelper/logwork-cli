import { CONFIG } from './config.mjs';
import { fetchWithPolicy, redactedExcerpt } from './http.mjs';
import { addLocalDays, mapLimit, safeJsonParse, toApiLogDate } from './util.mjs';
import {
  mergeWorklogTaskLists,
  normalizeWorklogTask,
  resolveWorklogTask
} from './worklog-task-resolver.mjs';

const LOGWORK_TYPE_OF_WORK = new Set(['create', 'correct', 'improve', 'other']);

const NORMALIZATION_DIAGNOSTICS_KEY = 'normalization';
const MAX_DIAGNOSTIC_ITEMS = 25;

export class ApiError extends Error {
  constructor(message, { status, path, body } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

export async function apiFetch(token, path, options = {}) {
  const {
    fetchImpl,
    retries,
    retryDelayMs = CONFIG.httpRetryDelayMs,
    timeoutMs = CONFIG.httpTimeoutMs,
    cache: _worklogTaskCache,
    taskCache: _taskCacheAlias,
    ...requestOptions
  } = options;
  const method = requestOptions.method || 'GET';
  const response = await fetchWithPolicy(`${CONFIG.apiBase}${path}`, {
    ...requestOptions,
    fetchImpl,
    timeoutMs,
    retryDelayMs,
    retries: retries ?? CONFIG.httpReadRetries,
    idempotent: isIdempotentMethod(method),
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...requestOptions.headers
    }
  });

  const text = await response.text();
  const data = text ? safeJsonParse(text, text) : null;
  const safeBody = redactedExcerpt(text);

  if (response.status === 401) {
    throw new ApiError('API request returned 401 Unauthorized.', {
      status: response.status,
      path,
      body: safeBody
    });
  }

  if (!response.ok) {
    throw new ApiError(`API request failed: ${response.status} ${response.statusText} for ${path}. Body: ${safeBody}`, {
      status: response.status,
      path,
      body: safeBody
    });
  }

  return data;
}

function isIdempotentMethod(method) {
  return ['GET', 'HEAD', 'OPTIONS'].includes(String(method || 'GET').toUpperCase());
}

export function getNormalizationDiagnostics(value) {
  return value?.[NORMALIZATION_DIAGNOSTICS_KEY] || emptyNormalizationDiagnostics();
}

export async function getProjects(token, userId) {
  const qs = new URLSearchParams({
    f_user_id: String(userId),
    'f_project.stage_id': '!6'
  });

  const data = await apiFetch(token, `${CONFIG.projectMembersPath}?${qs}`);
  return unwrapRecords(data).map(normalizeProject).filter((project) => project.projectMemberId);
}

export async function getDayLogs(token, projectId, userId, localDateISO) {
  const qs = new URLSearchParams({
    f_project_id: String(projectId),
    f_user_id: String(userId),
    f_logdate: toApiLogDate(localDateISO)
  });

  try {
    const data = await apiFetch(token, `${CONFIG.memberLogtimePath}?${qs}`);
    const logs = unwrapRecords(data);
    const entries = normalizeLogtimeEntries(logs, {
      date: localDateISO,
      projectId
    });
    const normalization = getNormalizationDiagnostics(entries);

    return {
      projectId,
      totalHours: entries.reduce((sum, log) => sum + Number(log.hours || 0), 0),
      entries,
      logs,
      normalization,
      ok: true
    };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      throw error;
    }

    return {
      projectId,
      totalHours: null,
      logs: [],
      ok: false,
      error: error.message
    };
  }
}

export function normalizeLogtimeEntries(logs, defaults = {}) {
  const rows = unwrapRecords(logs);
  const diagnostics = createNormalizationDiagnostics('logtime_entries');
  diagnostics.rowsRead = rows.length;
  const entries = [];

  rows.forEach((log, index) => {
    if (!log || typeof log !== 'object') {
      addDroppedRow(diagnostics, 'invalid_log_entry', { index });
      return;
    }

    const context = { index, kind: 'logtime_entry' };
    const date = normalizeDateOnly(log.logdate ?? log.log_date ?? log.date) || defaults.date;
    const projectMemberId = readExplicitProjectMemberId(log) ?? defaults.projectMemberId;
    const projectId = readProjectId(log) ?? defaults.projectId;
    const hours = readNumber(log, ['logtimes', 'hours', 'time'], diagnostics, context);

    if (!date) {
      addDroppedRow(diagnostics, 'missing_date', { ...context, ...diagnosticProjectFields({ projectMemberId, projectId }) });
      return;
    }

    if (projectMemberId === undefined && projectId === undefined) {
      addDroppedRow(diagnostics, 'missing_project_identity', { ...context, date });
      return;
    }

    if (hours <= 0) {
      addDroppedRow(diagnostics, 'non_positive_hours', { ...context, date, ...diagnosticProjectFields({ projectMemberId, projectId }) });
      return;
    }

    diagnostics.rowsAccepted += 1;
    entries.push({
      id: log.id ?? log.logtime_id ?? log.logtimeId,
      date,
      projectMemberId,
      projectId,
      projectName: hasProjectName(log) ? readProjectName(log, readProjectId(log), diagnostics, context) : defaults.projectName,
      hours,
      taskName: log.task_name ?? log.taskName ?? log.name ?? log.title ?? ''
    });
  });

  return attachNormalizationDiagnostics(entries, diagnostics);
}

export async function getAllDayLogSummaries(token, projects, userId, localDateISO) {
  return mapLimit(projects, CONFIG.dayLogConcurrency, (project) => (
    getDayLogs(token, project.projectId, userId, localDateISO)
  ));
}

export async function getTimesheetRange(token, userId, { from, to }) {
  const { records } = await getTimesheetRangeResult(token, userId, { from, to });
  return records;
}

export async function getTimesheetRangeResult(token, userId, { from, to }) {
  const qs = new URLSearchParams({
    f_user_id: String(userId),
    f_from: toApiLogDate(from),
    f_to: toApiLogDate(to),
    f_timesheet_by_week: '0',
    f_time_off: '1'
  });

  const data = await apiFetch(token, `${CONFIG.timesheetPath}?${qs}`);
  return normalizeTimesheetRangeResult(data, { from, to });
}

export function normalizeTimesheetRange(data, { from, to } = {}) {
  return normalizeTimesheetRangeResult(data, { from, to }).records;
}

export function normalizeTimesheetRangeResult(data, { from, to } = {}) {
  const diagnostics = createNormalizationDiagnostics('unknown');
  const explicitRows = expandProjectTimesheetRows(data, { from, to }, diagnostics);
  const rows = explicitRows.length ? explicitRows : findTimesheetRowsInRange(data, { from, to });
  diagnostics.sourceShape = explicitRows.length ? 'project_timesheet' : 'range_scan';
  if (!rows.length && hasObjectPayload(data)) {
    addWarning(diagnostics, 'unknown_timesheet_shape');
  }
  const records = normalizeTimesheetRecords(rows, diagnostics);
  return {
    records,
    normalization: getNormalizationDiagnostics(records)
  };
}

export async function getBookedProjectsForDate(token, userId, localDateISO) {
  const { records } = await getTimesheetRangeResult(token, userId, {
    from: localDateISO,
    to: addLocalDays(localDateISO, 1)
  });
  return normalizeTimesheetProjects(records, localDateISO);
}

export async function getTodayTimesheetProjects(token, userId, localDateISO) {
  return getBookedProjectsForDate(token, userId, localDateISO);
}

export async function getLogtimeById(token, logtimeId, options = {}) {
  const path = `${CONFIG.memberLogtimePath}/${encodeURIComponent(assertLogtimeId(logtimeId, 'logtimeId'))}`;
  const data = await apiFetch(token, path, options);
  const record = extractLogtimeRecord(data);
  if (!record) {
    throw new ApiError(`Resource Optimiser did not return logwork ${logtimeId}.`, {
      path
    });
  }
  return normalizeEditableLogtime(record);
}

export async function getWorklogTasks(token, { projectId, search } = {}, options = {}) {
  const path = `${CONFIG.logworkTasksPath}${buildLogworkTasksQuery({ projectId, search })}`;
  const data = await apiFetch(token, path, options);
  return unwrapRecords(data).map(normalizeWorklogTask);
}

export async function getDefaultWorklogTasks(token, { projectId, search } = {}, options = {}) {
  const path = `${CONFIG.logworkDefaultTasksPath}${buildLogworkTasksQuery({ projectId, search })}`;
  const data = await apiFetch(token, path, options);
  return unwrapRecords(data).map(normalizeWorklogTask);
}

export async function fetchWorklogTasksForProject(token, projectId, options = {}) {
  const cacheKey = Number(projectId);
  const { cache, ...apiOptions } = options;
  if (cache instanceof Map && cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  const [projectTasks, defaultTasks] = await Promise.all([
    getWorklogTasks(token, { projectId: cacheKey }, apiOptions),
    getDefaultWorklogTasks(token, { projectId: cacheKey }, apiOptions)
  ]);
  const merged = mergeWorklogTaskLists(projectTasks, defaultTasks);
  if (cache instanceof Map) {
    cache.set(cacheKey, merged);
  }
  return merged;
}

export async function createLogworkEntry(token, {
  worklogTaskId,
  projectId,
  effortHours,
  localDateISO,
  typeOfWork = CONFIG.defaultTypeOfWork,
  description,
  needsProjectId = false
}, options = {}) {
  const normalizedTaskId = assertLogtimeId(worklogTaskId, 'worklogTaskId');
  const normalizedProjectId = assertPositiveProjectId(projectId);
  const normalizedHours = Number(effortHours);
  const normalizedTypeOfWork = String(typeOfWork || CONFIG.defaultTypeOfWork).trim();
  if (!Number.isFinite(normalizedHours) || normalizedHours <= 0) {
    throw new Error('effortHours must be a positive number.');
  }
  if (!LOGWORK_TYPE_OF_WORK.has(normalizedTypeOfWork)) {
    throw new Error(`typeOfWork must be one of: ${[...LOGWORK_TYPE_OF_WORK].join(', ')}.`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(localDateISO || ''))) {
    throw new Error('localDateISO must use YYYY-MM-DD format.');
  }

  const path = CONFIG.logworkEntriesPath;
  const body = {
    worklog_task_id: preserveNumericId(normalizedTaskId),
    effort_hours: normalizedHours,
    logdate: localDateISO,
    type_of_work: normalizedTypeOfWork
  };
  if (description !== undefined && description !== null && String(description).trim()) {
    body.description = String(description).trim();
  }
  if (needsProjectId) {
    body.project_id = preserveNumericId(normalizedProjectId);
  }

  if (process.env.LOGWORK_DRY_RUN === '1') {
    return {
      dryRun: true,
      method: 'POST',
      path,
      body
    };
  }

  try {
    const response = await apiFetch(token, path, {
      ...options,
      method: 'POST',
      body: JSON.stringify(body)
    });
    const record = extractLogtimeRecord(response);
    return {
      dryRun: false,
      entry: record ? normalizeEditableLogtime(record) : null,
      response
    };
  } catch (error) {
    throw mapLogworkEntryApiError(error);
  }
}

export async function getLogworkDay(token, { date, projectId } = {}, options = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    throw new Error('date must use YYYY-MM-DD format.');
  }
  const qs = new URLSearchParams({ date });
  if (projectId !== undefined && projectId !== null && projectId !== '') {
    qs.set('project_id', String(projectId));
  }
  const data = await apiFetch(token, `${CONFIG.logworkDayPath}?${qs}`, options);
  return normalizeLogworkDayPayload(unwrapLogworkObject(data));
}

export async function getLogworkWeekly(token, { weekStart } = {}, options = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(weekStart || ''))) {
    throw new Error('weekStart must use YYYY-MM-DD format.');
  }
  const qs = new URLSearchParams({ week_start: weekStart });
  const data = await apiFetch(token, `${CONFIG.logworkWeeklyPath}?${qs}`, options);
  return normalizeLogworkWeeklyPayload(unwrapLogworkObject(data));
}

export async function getLogworkRejected(token, options = {}) {
  const data = await apiFetch(token, CONFIG.logworkRejectedPath, options);
  return unwrapRecords(data).map(normalizeLogworkF03Entry);
}

export async function resubmitLogworkEntry(token, entryId, {
  effortHours,
  typeOfWork = CONFIG.defaultTypeOfWork,
  noteToPm,
  description
}, options = {}) {
  const id = assertLogtimeId(entryId, 'entryId');
  const normalizedHours = Number(effortHours);
  const normalizedTypeOfWork = String(typeOfWork || CONFIG.defaultTypeOfWork).trim();
  if (!Number.isFinite(normalizedHours) || normalizedHours <= 0) {
    throw new Error('effortHours must be a positive number.');
  }
  if (!LOGWORK_TYPE_OF_WORK.has(normalizedTypeOfWork)) {
    throw new Error(`typeOfWork must be one of: ${[...LOGWORK_TYPE_OF_WORK].join(', ')}.`);
  }

  const path = `${CONFIG.logworkEntriesPath}/${encodeURIComponent(String(id))}/resubmit`;
  const body = {
    effort_hours: normalizedHours,
    type_of_work: normalizedTypeOfWork
  };
  if (noteToPm !== undefined && String(noteToPm).trim()) {
    body.note_to_pm = String(noteToPm).trim();
  }
  if (description !== undefined && String(description).trim()) {
    body.description = String(description).trim();
  }

  if (process.env.LOGWORK_DRY_RUN === '1') {
    return { dryRun: true, method: 'PATCH', path, body };
  }

  try {
    const response = await apiFetch(token, path, {
      ...options,
      method: 'PATCH',
      body: JSON.stringify(body)
    });
    const record = extractLogtimeRecord(response);
    return {
      dryRun: false,
      entry: record ? normalizeLogworkF03Entry(record) : null,
      response
    };
  } catch (error) {
    throw mapLogworkEntryApiError(error);
  }
}

export async function deleteLogworkEntry(token, entryId, options = {}) {
  const id = assertLogtimeId(entryId, 'entryId');
  const path = `${CONFIG.logworkEntriesPath}/${encodeURIComponent(String(id))}`;

  if (process.env.LOGWORK_DRY_RUN === '1') {
    return { dryRun: true, method: 'DELETE', path };
  }

  try {
    const response = await apiFetch(token, path, {
      ...options,
      method: 'DELETE'
    });
    return { dryRun: false, response };
  } catch (error) {
    throw mapLogworkEntryApiError(error);
  }
}

export function normalizeLogworkF03Entry(record = {}) {
  const base = normalizeEditableLogtime(record);
  return {
    ...base,
    typeOfWork: record.type_of_work ?? record.typeOfWork ?? '',
    worklogTaskId: record.worklog_task_id ?? record.worklogTaskId ?? null,
    description: record.description ?? '',
    rejectionComment: record.rejection_comment ?? record.rejectionComment ?? '',
    noteToPm: record.note_to_pm ?? record.noteToPm ?? ''
  };
}

function normalizeLogworkDayPayload(payload = {}) {
  const entries = Array.isArray(payload.entries)
    ? payload.entries.map(normalizeLogworkF03Entry)
    : [];
  return {
    date: normalizeDateOnly(payload.date) || '',
    entries,
    isLocked: Boolean(payload.isLocked ?? payload.is_locked),
    isProjectClosed: Boolean(payload.isProjectClosed ?? payload.is_project_closed),
    leaveRequests: Array.isArray(payload.leaveRequests) ? payload.leaveRequests : []
  };
}

function normalizeLogworkWeeklyPayload(payload = {}) {
  return {
    weekStart: normalizeDateOnly(payload.weekStart ?? payload.week_start) || '',
    isLocked: Boolean(payload.isLocked ?? payload.is_locked),
    projects: Array.isArray(payload.projects) ? payload.projects : [],
    missingDays: Array.isArray(payload.missingDays) ? payload.missingDays : [],
    weeklyTotals: payload.weeklyTotals ?? payload.weekly_totals ?? null
  };
}

function unwrapLogworkObject(data) {
  if (data?.data && typeof data.data === 'object' && !Array.isArray(data.data)) {
    return data.data;
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return data;
  }
  return {};
}

export async function addLogtime(token, entry, options = {}) {
  const {
    projectMemberId: _projectMemberId,
    projectId,
    logtimes,
    taskName,
    localDateISO,
    typeOfWork,
    description,
    worklogTaskId,
    worklogNeedsProjectId,
    taskCache
  } = entry || {};

  const normalizedHours = Number(logtimes);
  const normalizedTaskName = String(taskName ?? '').trim();
  if (!Number.isFinite(normalizedHours) || normalizedHours <= 0) {
    throw new Error('logtimes must be a positive number.');
  }
  if (!normalizedTaskName) {
    throw new Error('taskName must not be empty.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(localDateISO || ''))) {
    throw new Error('localDateISO must use YYYY-MM-DD format.');
  }

  const normalizedProjectId = assertPositiveProjectId(projectId);
  let resolvedTaskId = worklogTaskId;
  let needsProjectId = worklogNeedsProjectId;

  if (resolvedTaskId === undefined || resolvedTaskId === null) {
    const tasks = await fetchWorklogTasksForProject(token, normalizedProjectId, {
      cache: taskCache,
      ...options
    });
    const resolution = resolveWorklogTask({
      taskName: normalizedTaskName,
      projectId: normalizedProjectId,
      tasks
    });
    resolvedTaskId = resolution.worklogTaskId;
    needsProjectId = resolution.needsProjectId;
  }

  return createLogworkEntry(token, {
    worklogTaskId: resolvedTaskId,
    projectId: normalizedProjectId,
    effortHours: normalizedHours,
    localDateISO,
    typeOfWork,
    description,
    needsProjectId: Boolean(needsProjectId)
  }, options);
}

function buildLogworkTasksQuery({ projectId, search }) {
  const qs = new URLSearchParams();
  if (projectId !== undefined && projectId !== null && projectId !== '') {
    qs.set('project_id', String(projectId));
  }
  if (search) {
    qs.set('search', String(search));
  }
  const query = qs.toString();
  return query ? `?${query}` : '';
}

function assertPositiveProjectId(projectId, label = 'projectId') {
  const normalized = Number(projectId);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
  return normalized;
}

function mapLogworkEntryApiError(error) {
  if (!(error instanceof ApiError)) {
    return error;
  }

  const bodyText = String(error.body || '');
  const knownMessages = [
    ['TASK_OR_PROJECT_NOT_FOUND', 'Worklog task or project was not found. Check project_id and worklog_task_id.'],
    ['HOLIDAY_BLOCKED', 'Logwork is blocked on this date (holiday).'],
    ['NOT_MEMBER_OF_PROJECT', 'You are not a member of this project.'],
    ['INVALID_EFFORT', 'Effort hours must be greater than 0.'],
    ['EFFORT_EXCEEDS_24', 'Effort cannot exceed 24 hours per entry.'],
    ['ENTRY_NOT_FOUND', 'Logwork entry was not found or is already deleted.'],
    ['FORBIDDEN', 'You can only delete or change logwork entries you created.']
  ];

  for (const [code, message] of knownMessages) {
    if (bodyText.includes(code)) {
      return new ApiError(message, {
        status: error.status,
        path: error.path,
        body: error.body
      });
    }
  }

  if (bodyText.includes('Can only delete unprocessed entries')) {
    return new ApiError('Only submitted or approved entries can be deleted. Rejected entries must be resubmitted or edited.', {
      status: error.status,
      path: error.path,
      body: error.body
    });
  }

  if (bodyText.includes('LOCKED') || bodyText.includes('locked')) {
    return new ApiError('This log date is locked and cannot be edited.', {
      status: error.status,
      path: error.path,
      body: error.body
    });
  }

  return error;
}

export function normalizeEditableLogtime(record = {}) {
  const hours = Number(record.logtimes ?? record.hours ?? record.effort_hours ?? record.time);
  return {
    id: record.id ?? record.logtime_id ?? record.logtimeId,
    projectMemberId: record.project_member_id ?? record.projectMemberId,
    projectId: record.project_id ?? record.projectId ?? record.project?.id,
    projectName: record.project_name ?? record.projectName ?? record.project?.name ?? '',
    date: normalizeDateOnly(record.logdate ?? record.log_date ?? record.date),
    hours: Number.isFinite(hours) ? hours : 0,
    taskName: record.task_name ?? record.taskName ?? record.name ?? record.title ?? '',
    createdBy: record.created_by ?? record.createdBy,
    updatedBy: record.updated_by ?? record.updatedBy,
    updatedDate: record.updated_date ?? record.updatedDate ?? '',
    jiraLogworkId: record.jira_logwork_id ?? record.jiraLogworkId ?? null,
    referrerUrl: record.referrer_url ?? record.referrerUrl ?? null,
    source: record.source ?? '',
    status: record.status ?? '',
    isLocked: Boolean(record.is_locked ?? record.isLocked),
    raw: record
  };
}

function normalizeProject(rec) {
  const projectId = rec.project_id ?? rec.project?.id ?? rec.project?.project_id;
  const projectMemberId = rec.id ?? rec.project_member_id;

  return {
    projectMemberId,
    projectId,
    projectName: rec.project?.name ?? rec.project_name ?? rec.name ?? projectFallbackName(projectId ?? projectMemberId),
    workloadPercent: rec.workload ?? rec.workload_percent ?? rec.assigned_percent ?? 0,
    raw: rec
  };
}

function normalizeTimesheetProjects(rows, localDateISO) {
  const byMember = new Map();

  for (const row of rows) {
    const projectMemberId = readProjectMemberId(row);
    const projectId = readProjectId(row);

    if (!projectMemberId && !projectId) {
      continue;
    }

    const key = String(projectMemberId ?? projectId);
    const projectName = readProjectName(row, projectId ?? projectMemberId);
    const assignedHours = Number(row.bookedHours ?? readAssignedHours(row));
    const loggedHours = Number(row.loggedHours ?? readLoggedHours(row));
    const existing = byMember.get(key);

    if (existing) {
      existing.assignedHours += assignedHours;
      existing.loggedHours += loggedHours;
      existing.workloadPercent = hoursToAssignPercent(existing.assignedHours);
      existing.raw.push(row);
      continue;
    }

    byMember.set(key, {
      projectMemberId: projectMemberId ?? row.project_member_id ?? row.id,
      projectId,
      projectName,
      assignedHours,
      loggedHours,
      workloadPercent: hoursToAssignPercent(assignedHours),
      localDateISO,
      raw: [row]
    });
  }

  return [...byMember.values()].filter((project) => project.assignedHours > 0);
}

function normalizeTimesheetRecords(rows, diagnostics = createNormalizationDiagnostics('range_scan')) {
  const byDayProject = new Map();
  diagnostics.rowsRead = rows.length;

  rows.forEach((row, index) => {
    const date = readDateLike(row);
    const projectMemberId = readProjectMemberId(row);
    const projectId = readProjectId(row);
    const context = {
      index,
      kind: 'timesheet_row',
      ...diagnosticProjectFields({ projectMemberId, projectId, projectName: hasProjectName(row) ? readProjectName(row, projectId ?? projectMemberId) : undefined })
    };

    if (!date) {
      addDroppedRow(diagnostics, 'missing_date', context);
      return;
    }

    if (projectMemberId === undefined && projectId === undefined) {
      addDroppedRow(diagnostics, 'missing_project_identity', { ...context, date });
      return;
    }

    const key = `${date}:${projectMemberId ?? projectId}`;
    const existing = byDayProject.get(key);
    const bookedHours = readTimesheetHours(row, ['bookedHours'], readAssignedHours, diagnostics, { ...context, date, metric: 'bookedHours' });
    const loggedHours = readTimesheetHours(row, ['loggedHours'], readLoggedHours, diagnostics, { ...context, date, metric: 'loggedHours' });
    const entries = readLogEntries(row, diagnostics, { ...context, date });
    diagnostics.rowsAccepted += 1;

    if (existing) {
      existing.bookedHours += bookedHours;
      existing.loggedHours += loggedHours;
      existing.entries.push(...entries);
      existing.raw.push(row);
      return;
    }

    byDayProject.set(key, {
      date,
      projectMemberId,
      projectId,
      projectName: readProjectName(row, projectId ?? projectMemberId, diagnostics, { ...context, date }),
      bookedHours,
      loggedHours,
      entries,
      raw: [row]
    });
  });

  return attachNormalizationDiagnostics([...byDayProject.values()].map((record) => ({
    ...record,
    bookedHours: Number(record.bookedHours.toFixed(2)),
    loggedHours: Number(record.loggedHours.toFixed(2))
  })), diagnostics);
}

function findTimesheetRowsForDate(data, localDateISO) {
  const rows = [];
  collectTimesheetRows(data, localDateISO, rows, new Set());
  return rows;
}

function expandProjectTimesheetRows(data, range, diagnostics = null) {
  const assignments = [];
  collectProjectAssignments(data, assignments, new Set());
  const rows = [];

  assignments.forEach((assignment, assignmentIndex) => {
    assignment.timesheet.forEach((day, dayIndex) => {
      const date = normalizeDateOnly(day.logdate ?? day.log_date ?? day.date);
      if (!isDateInRange(date, range)) {
        return;
      }

      const context = {
        index: rows.length,
        assignmentIndex,
        dayIndex,
        kind: 'project_timesheet_row',
        date,
        ...diagnosticProjectFields({
          projectMemberId: assignment.id,
          projectId: assignment.project?.id,
          projectName: assignment.project?.name
        })
      };

      rows.push({
        date,
        projectMemberId: assignment.id,
        project_member_id: assignment.id,
        projectId: assignment.project?.id,
        project_id: assignment.project?.id,
        projectName: assignment.project?.name,
        project_name: assignment.project?.name,
        bookedHours: readAssignedHours(day, diagnostics, { ...context, metric: 'bookedHours' }),
        loggedHours: readNumber(day, ['logtimes'], diagnostics, { ...context, metric: 'loggedHours' }),
        overtime: readNumber(day, ['overtime'], diagnostics, { ...context, metric: 'overtime' }),
        source: 'timesheet'
      });
    });
  });

  return rows;
}

function collectProjectAssignments(value, assignments, seen) {
  if (!value || typeof value !== 'object') {
    return;
  }

  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      collectProjectAssignments(item, assignments, seen);
    }
    return;
  }

  if (
    value.project &&
    typeof value.project === 'object' &&
    Array.isArray(value.timesheet)
  ) {
    assignments.push(value);
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === 'overall') {
      continue;
    }
    collectProjectAssignments(child, assignments, seen);
  }
}

function findTimesheetRowsInRange(data, { from, to } = {}) {
  const rows = [];
  collectTimesheetRowsInRange(data, { from, to }, rows, new Set());
  return rows;
}

function collectTimesheetRowsInRange(value, range, rows, seen) {
  if (!value || typeof value !== 'object') {
    return;
  }

  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      collectTimesheetRowsInRange(item, range, rows, seen);
    }
    return;
  }

  const directDate = readDateLike(value);
  if (isDateInRange(directDate, range) && looksLikeTimesheetRow(value)) {
    rows.push(value);
  } else if (!directDate && looksLikeTimesheetRow(value)) {
    rows.push(value);
  }

  for (const [key, child] of Object.entries(value)) {
    if (Array.isArray(child)) {
      const keyDate = normalizeDateOnly(key);
      if (isDateInRange(keyDate, range)) {
        for (const item of child) {
          if (item && typeof item === 'object') {
            rows.push({ ...item, date: readDateLike(item) || keyDate });
          }
        }
        continue;
      }

      for (const item of child) {
        if (item && typeof item === 'object') {
          const itemDate = readDateLike(item);
          if (isDateInRange(itemDate, range) && looksLikeTimesheetRow(item)) {
            rows.push(item);
            continue;
          }
        }

        collectTimesheetRowsInRange(item, range, rows, seen);
      }
      continue;
    }

    if (child && typeof child === 'object') {
      const keyDate = normalizeDateOnly(key);
      if (isDateInRange(keyDate, range)) {
        rows.push({ ...child, date: readDateLike(child) || keyDate });
        continue;
      }

      collectTimesheetRowsInRange(child, range, rows, seen);
    }
  }
}

function collectTimesheetRows(value, localDateISO, rows, seen) {
  if (!value || typeof value !== 'object') {
    return;
  }

  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      collectTimesheetRows(item, localDateISO, rows, seen);
    }
    return;
  }

  const directDate = readDateLike(value);
  if (directDate === localDateISO && looksLikeTimesheetRow(value)) {
    rows.push(value);
  }

  for (const [key, child] of Object.entries(value)) {
    if (Array.isArray(child)) {
      if (isDateKey(key, localDateISO)) {
        for (const item of child) {
          if (item && typeof item === 'object') {
            rows.push({ ...value, ...item });
          }
        }
        continue;
      }

      for (const item of child) {
        if (item && typeof item === 'object' && readDateLike(item) === localDateISO && looksLikeTimesheetRow({ ...value, ...item })) {
          rows.push({ ...value, ...item });
          continue;
        }

        collectTimesheetRows(item, localDateISO, rows, seen);
      }
      continue;
    }

    if (child && typeof child === 'object') {
      if (isDateKey(key, localDateISO)) {
        rows.push({ ...value, ...child });
        continue;
      }

      collectTimesheetRows(child, localDateISO, rows, seen);
    }
  }
}

function looksLikeTimesheetRow(row) {
  return readAssignedHours(row) > 0 || readLoggedHours(row) > 0 || Boolean(pickFirst(row, [
    'project_member_id',
    'projectMemberId',
    'project_id',
    'projectId'
  ]));
}

function readProjectMemberId(row) {
  const explicit = readExplicitProjectMemberId(row);

  if (explicit !== undefined) {
    return explicit;
  }

  if (looksLikeProjectMemberRow(row)) {
    return row.id;
  }

  return undefined;
}

function readExplicitProjectMemberId(row) {
  return pickFirst(row, [
    'project_member_id',
    'projectMemberId',
    'project_member.id',
    'projectMember.id'
  ]);
}

function readProjectId(row) {
  return pickFirst(row, [
    'project_id',
    'projectId',
    'project.id',
    'project.project_id',
    'projectMember.project_id',
    'project_member.project_id'
  ]);
}

function readProjectName(row, fallbackId, diagnostics = null, context = {}) {
  const projectName = pickFirst(row, [
    'project.name',
    'project_name',
    'projectName',
    'name',
    'projectMember.project.name',
    'project_member.project.name'
  ]);

  if (projectName !== undefined) {
    return projectName;
  }

  if (fallbackId !== undefined && fallbackId !== null && String(fallbackId).trim() !== '') {
    addWarning(diagnostics, 'fallback_project_name', {
      ...context,
      ...diagnosticProjectFields({ projectMemberId: readProjectMemberId(row), projectId: readProjectId(row) })
    });
    return projectFallbackName(fallbackId);
  }

  addWarning(diagnostics, 'fallback_project_name', context);
  return 'Unknown project';
}

function projectFallbackName(fallbackId) {
  return fallbackId !== undefined && fallbackId !== null && String(fallbackId).trim() !== ''
    ? `Project ${fallbackId}`
    : 'Unknown project';
}

function hasProjectName(row) {
  return pickFirst(row, [
    'project.name',
    'project_name',
    'projectName',
    'name',
    'projectMember.project.name',
    'project_member.project.name'
  ]) !== undefined;
}

function looksLikeProjectMemberRow(row) {
  return row && typeof row === 'object' && row.id !== undefined && (
    row.project_id !== undefined ||
    row.projectId !== undefined ||
    row.project !== undefined ||
    row.project_name !== undefined ||
    row.projectName !== undefined ||
    row.assign_hours !== undefined ||
    row.assigned_hours !== undefined ||
    row.booked_hours !== undefined
  );
}

function readAssignedHours(row, diagnostics = null, context = {}) {
  return readNumber(row, [
    'assign_hours',
    'assigned_hours',
    'assignedHours',
    'booking_hours',
    'booked_hours',
    'bookedHours',
    'workload_hours',
    'workloadHours',
    'assign_percent',
    'assignPercent',
    'hours_per_day',
    'hoursPerDay',
    'timesheet',
    'logtime',
    'logtimes_plan',
    'planned_hours',
    'plannedHours',
    'effort',
    'man_day'
  ], diagnostics, context);
}

function readLoggedHours(row, diagnostics = null, context = {}) {
  return readNumber(row, [
    'logged_hours',
    'loggedHours',
    'actual_hours',
    'actualHours',
    'logtimes',
    'log_times',
    'logTimes',
    'logged',
    'total_logtimes',
    'totalLoggedHours',
    'total_logged_hours',
    'spent_hours',
    'spentHours'
  ], diagnostics, context);
}

function readLogEntries(row, diagnostics = null, context = {}) {
  const rawEntries = pickFirst(row, [
    'logs',
    'logtimes_data',
    'logtimesData',
    'log_times',
    'logTimes',
    'items',
    'children'
  ]);

  if (!Array.isArray(rawEntries)) {
    return [];
  }

  const entries = [];
  rawEntries.forEach((entry, entryIndex) => {
    if (!entry || typeof entry !== 'object') {
      addDroppedRow(diagnostics, 'invalid_log_entry', {
        ...context,
        entryIndex
      });
      return;
    }

    const entryContext = {
      ...context,
      entryIndex,
      kind: 'embedded_log_entry'
    };
    const date = normalizeDateOnly(entry.logdate ?? entry.log_date ?? entry.date ?? row.logdate ?? row.date);
    const projectMemberId = readProjectMemberId(entry) ?? readProjectMemberId(row);
    const projectId = readProjectId(entry) ?? readProjectId(row);
    const hours = readNumber(entry, ['logtimes', 'hours', 'time'], diagnostics, { ...entryContext, metric: 'hours' });

    if (!date) {
      addDroppedRow(diagnostics, 'missing_date', { ...entryContext, ...diagnosticProjectFields({ projectMemberId, projectId }) });
      return;
    }

    if (projectMemberId === undefined && projectId === undefined) {
      addDroppedRow(diagnostics, 'missing_project_identity', { ...entryContext, date });
      return;
    }

    if (hours <= 0) {
      addDroppedRow(diagnostics, 'non_positive_hours', { ...entryContext, date, ...diagnosticProjectFields({ projectMemberId, projectId }) });
      return;
    }

    entries.push({
      id: entry.id ?? entry.logtime_id ?? entry.logtimeId,
      date,
      projectMemberId,
      projectId,
      projectName: hasProjectName(entry) ? readProjectName(entry, readProjectId(entry), diagnostics, entryContext) : readProjectName(row, readProjectId(row) ?? readProjectMemberId(row), diagnostics, entryContext),
      hours,
      taskName: entry.task_name ?? entry.taskName ?? entry.name ?? entry.title ?? '',
      raw: entry
    });
  });

  return entries;
}

function readTimesheetHours(row, directPaths, fallbackReader, diagnostics, context) {
  const directValue = pickFirst(row, directPaths);
  if (directValue !== undefined) {
    return coerceHours(directValue, diagnostics, {
      ...context,
      field: directPaths[0]
    });
  }

  return fallbackReader(row, diagnostics, context);
}

function readNumber(row, paths, diagnostics = null, context = {}) {
  for (const path of paths) {
    const value = pickFirst(row, [path]);
    if (value !== undefined) {
      const number = Number(value);
      if (Number.isFinite(number) && number > 0) {
        return number;
      }
      if (Number.isFinite(number) && number === 0) {
        continue;
      }
      addWarning(diagnostics, 'invalid_hours', {
        ...context,
        field: path
      });
    }
  }

  return 0;
}

function coerceHours(value, diagnostics = null, context = {}) {
  const number = Number(value);
  if (Number.isFinite(number) && number >= 0) {
    return number;
  }

  addWarning(diagnostics, 'invalid_hours', context);
  return 0;
}

function hoursToAssignPercent(hours) {
  return Math.round((Number(hours || 0) / CONFIG.standardDayHours) * 100);
}

function readDateLike(row) {
  const value = pickFirst(row, [
    'logdate',
    'log_date',
    'date',
    'day',
    'workdate',
    'work_date',
    'timesheet_date'
  ]);

  return normalizeDateOnly(value);
}

function normalizeDateOnly(value) {
  if (!value) {
    return '';
  }

  const text = String(value);
  const match = text.match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : '';
}

function isDateKey(key, localDateISO) {
  return normalizeDateOnly(key) === localDateISO;
}

function isDateInRange(localDateISO, { from, to } = {}) {
  if (!localDateISO) {
    return false;
  }

  if (from && localDateISO < from) {
    return false;
  }

  if (to && localDateISO >= to) {
    return false;
  }

  return true;
}

function pickFirst(row, paths) {
  for (const path of paths) {
    const value = getPath(row, path);
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }

  return undefined;
}

function getPath(row, path) {
  return path.split('.').reduce((current, part) => {
    if (current === undefined || current === null) {
      return undefined;
    }

    return current[part];
  }, row);
}

function unwrapRecords(data) {
  if (Array.isArray(data)) {
    return data;
  }

  if (Array.isArray(data?.data)) {
    return data.data;
  }

  if (Array.isArray(data?.data?.data)) {
    return data.data.data;
  }

  if (Array.isArray(data?.records)) {
    return data.records;
  }

  if (Array.isArray(data?.items)) {
    return data.items;
  }

  return [];
}

function extractLogtimeRecord(data, collectionKey) {
  const candidates = collectionKey
    ? [data?.data?.[collectionKey], data?.[collectionKey]]
    : [data?.data?.data, data?.data, data?.record, data?.item, data];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      const record = candidate.find((item) => item && typeof item === 'object');
      if (record) {
        return record;
      }
      continue;
    }
    if (candidate && typeof candidate === 'object' && (
      candidate.id !== undefined ||
      candidate.logtime_id !== undefined ||
      candidate.logtimeId !== undefined
    )) {
      return candidate;
    }
  }

  return null;
}

function assertLogtimeId(value, name) {
  const normalized = String(value ?? '').trim();
  if (!normalized || !/^[A-Za-z0-9_-]+$/.test(normalized)) {
    throw new Error(`${name} must be a valid Resource Optimiser identifier.`);
  }
  return normalized;
}

function preserveNumericId(value) {
  return /^\d+$/.test(value) && Number.isSafeInteger(Number(value))
    ? Number(value)
    : value;
}

function createNormalizationDiagnostics(sourceShape = 'unknown') {
  return {
    status: 'ok',
    sourceShape,
    rowsRead: 0,
    rowsAccepted: 0,
    droppedRowCount: 0,
    warningCount: 0,
    warnings: [],
    droppedRows: []
  };
}

function emptyNormalizationDiagnostics() {
  return createNormalizationDiagnostics('unknown');
}

function attachNormalizationDiagnostics(value, diagnostics) {
  Object.defineProperty(value, NORMALIZATION_DIAGNOSTICS_KEY, {
    value: finalizeNormalizationDiagnostics(diagnostics),
    enumerable: false,
    configurable: true
  });
  return value;
}

function finalizeNormalizationDiagnostics(diagnostics) {
  const warningCount = diagnostics.warnings.length;
  const droppedRowCount = diagnostics.droppedRows.length;
  return {
    ...diagnostics,
    status: warningCount || droppedRowCount ? 'warning' : 'ok',
    warningCount,
    droppedRowCount
  };
}

export function combineNormalizationDiagnostics(...items) {
  const diagnostics = createNormalizationDiagnostics('combined');
  for (const item of items) {
    const current = item?.warnings || item?.droppedRows
      ? item
      : getNormalizationDiagnostics(item);
    if (!current) {
      continue;
    }
    diagnostics.rowsRead += Number(current.rowsRead || 0);
    diagnostics.rowsAccepted += Number(current.rowsAccepted || 0);
    for (const warning of current.warnings || []) {
      pushDiagnostic(diagnostics.warnings, warning);
    }
    for (const dropped of current.droppedRows || []) {
      pushDiagnostic(diagnostics.droppedRows, dropped);
    }
  }
  return finalizeNormalizationDiagnostics(diagnostics);
}

function addWarning(diagnostics, reason, details = {}) {
  if (!diagnostics) {
    return;
  }
  pushDiagnostic(diagnostics.warnings, compactDiagnostic({
    reason,
    ...details
  }));
}

function addDroppedRow(diagnostics, reason, details = {}) {
  if (!diagnostics) {
    return;
  }
  pushDiagnostic(diagnostics.droppedRows, compactDiagnostic({
    reason,
    ...details
  }));
}

function pushDiagnostic(items, item) {
  if (items.length < MAX_DIAGNOSTIC_ITEMS) {
    items.push(item);
  }
}

function compactDiagnostic(details) {
  return Object.fromEntries(Object.entries(details).filter(([, value]) => (
    value !== undefined &&
    value !== null &&
    value !== ''
  )));
}

function diagnosticProjectFields({ projectMemberId, projectId, projectName } = {}) {
  return compactDiagnostic({
    projectMemberId,
    projectId,
    projectName
  });
}

function hasObjectPayload(data) {
  return Boolean(data && typeof data === 'object' && Object.keys(data).length > 0);
}
