import { CONFIG } from '../config.mjs';
import { addLocalDays, mapLimit, safeJsonParse, toApiLogDate } from './util.mjs';

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
  const response = await fetch(`${CONFIG.apiBase}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...options.headers
    }
  });

  const text = await response.text();
  const data = text ? safeJsonParse(text, text) : null;

  if (response.status === 401) {
    throw new ApiError('API request returned 401 Unauthorized.', {
      status: response.status,
      path,
      body: excerpt(text)
    });
  }

  if (!response.ok) {
    throw new ApiError(`API request failed: ${response.status} ${response.statusText} for ${path}. Body: ${excerpt(text)}`, {
      status: response.status,
      path,
      body: excerpt(text)
    });
  }

  return data;
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
    f_logdate: localDateISO
  });

  try {
    const data = await apiFetch(token, `${CONFIG.memberLogtimePath}?${qs}`);
    const logs = unwrapRecords(data);

    return {
      projectId,
      totalHours: logs.reduce((sum, log) => sum + Number(log.logtimes ?? log.hours ?? log.time ?? 0), 0),
      logs,
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

export async function getAllDayLogSummaries(token, projects, userId, localDateISO) {
  return mapLimit(projects, CONFIG.dayLogConcurrency, (project) => (
    getDayLogs(token, project.projectId, userId, localDateISO)
  ));
}

export async function getTodayTimesheetProjects(token, userId, localDateISO) {
  const qs = new URLSearchParams({
    f_user_id: String(userId),
    f_from: toApiLogDate(localDateISO),
    f_to: toApiLogDate(addLocalDays(localDateISO, 1)),
    f_timesheet_by_week: '0',
    f_time_off: '1'
  });

  const data = await apiFetch(token, `${CONFIG.timesheetPath}?${qs}`);
  const rows = findTimesheetRowsForDate(data, localDateISO);
  return normalizeTimesheetProjects(rows, localDateISO);
}

export async function addLogtime(token, {
  projectMemberId,
  logtimes,
  taskName,
  localDateISO
}) {
  const path = memberLogtimeWritePath(projectMemberId);
  const body = {
    add_data: [
      {
        project_member_id: projectMemberId,
        logtimes,
        task_name: taskName,
        logdate: toApiLogDate(localDateISO)
      }
    ]
  };

  if (process.env.LOGWORK_DRY_RUN === '1') {
    return {
      dryRun: true,
      method: CONFIG.memberLogtimeMethod,
      path,
      body
    };
  }

  return apiFetch(token, path, {
    method: CONFIG.memberLogtimeMethod,
    body: JSON.stringify(body)
  });
}

function memberLogtimeWritePath(projectMemberId) {
  return `${CONFIG.memberLogtimePath}/${encodeURIComponent(String(projectMemberId))}`;
}

function normalizeProject(rec) {
  const projectId = rec.project_id ?? rec.project?.id ?? rec.project?.project_id;

  return {
    projectMemberId: rec.id ?? rec.project_member_id,
    projectId,
    projectName: rec.project?.name ?? rec.project_name ?? rec.name ?? `Project ${projectId}`,
    workloadPercent: rec.workload ?? rec.workload_percent ?? rec.assigned_percent ?? 0,
    raw: rec
  };
}

function normalizeTimesheetProjects(rows, localDateISO) {
  const byMember = new Map();

  for (const row of rows) {
    const projectMemberId = pickFirst(row, [
      'project_member_id',
      'projectMemberId',
      'project_member.id',
      'projectMember.id',
      'id'
    ]);
    const projectId = pickFirst(row, [
      'project_id',
      'projectId',
      'project.id',
      'project.project_id',
      'projectMember.project_id',
      'project_member.project_id'
    ]);

    if (!projectMemberId && !projectId) {
      continue;
    }

    const key = String(projectMemberId ?? projectId);
    const projectName = pickFirst(row, [
      'project.name',
      'project_name',
      'projectName',
      'name',
      'projectMember.project.name',
      'project_member.project.name'
    ]) ?? `Project ${projectId ?? projectMemberId}`;
    const assignedHours = readAssignedHours(row);
    const loggedHours = readLoggedHours(row);
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

function findTimesheetRowsForDate(data, localDateISO) {
  const rows = [];
  collectTimesheetRows(data, localDateISO, rows, new Set());
  return rows;
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

function readAssignedHours(row) {
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
  ]);
}

function readLoggedHours(row) {
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
  ]);
}

function readNumber(row, paths) {
  for (const path of paths) {
    const value = pickFirst(row, [path]);
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) {
      return number;
    }
  }

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

function excerpt(text) {
  return String(text || '').slice(0, 500);
}
