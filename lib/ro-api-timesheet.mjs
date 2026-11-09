// Timesheet range reads: booked and logged hours per day and project.
import { CONFIG } from './config.mjs';
import { addLocalDays, toApiLogDate } from './util.mjs';
import { apiFetch } from './ro-api-http.mjs';
import {
  addDroppedRow,
  addWarning,
  attachNormalizationDiagnostics,
  createNormalizationDiagnostics,
  diagnosticProjectFields,
  getNormalizationDiagnostics
} from './ro-api-diagnostics.mjs';
import {
  coerceHours,
  hasProjectName,
  isDateInRange,
  isDateKey,
  normalizeDateOnly,
  pickFirst,
  readAssignedHours,
  readDateLike,
  readLoggedHours,
  readNumber,
  readProjectId,
  readProjectMemberId,
  readProjectName
} from './ro-api-fields.mjs';

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

function hoursToAssignPercent(hours) {
  return Math.round((Number(hours || 0) / CONFIG.standardDayHours) * 100);
}

function hasObjectPayload(data) {
  return Boolean(data && typeof data === 'object' && Object.keys(data).length > 0);
}
