// Logwork entries: reads (legacy GET, /logwork/day, weekly, rejected) and writes
// (create, resubmit, delete). Writes honor LOGWORK_DRY_RUN.
import { CONFIG, isDryRun } from './config.mjs';
import { resolveWorklogTask } from './worklog-task-resolver.mjs';
import { ApiError, apiFetch } from './ro-api-http.mjs';
import { fetchWorklogTasksForProject } from './ro-api-tasks.mjs';
import {
  assertLogtimeId,
  extractLogtimeRecord,
  normalizeDateOnly,
  preserveNumericId,
  unwrapRecords
} from './ro-api-fields.mjs';

const LOGWORK_TYPE_OF_WORK = new Set(['create', 'correct', 'improve', 'other']);

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

  if (isDryRun()) {
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

  if (isDryRun()) {
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

  if (isDryRun()) {
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
