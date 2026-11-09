// Readers for loosely shaped Resource Optimiser responses. Each reader tries a list
// of candidate field paths; extend those lists rather than hard-coding one shape.
import { addWarning, diagnosticProjectFields } from './ro-api-diagnostics.mjs';

export function readProjectMemberId(row) {
  const explicit = readExplicitProjectMemberId(row);

  if (explicit !== undefined) {
    return explicit;
  }

  if (looksLikeProjectMemberRow(row)) {
    return row.id;
  }

  return undefined;
}

export function readExplicitProjectMemberId(row) {
  return pickFirst(row, [
    'project_member_id',
    'projectMemberId',
    'project_member.id',
    'projectMember.id'
  ]);
}

export function readProjectId(row) {
  return pickFirst(row, [
    'project_id',
    'projectId',
    'project.id',
    'project.project_id',
    'projectMember.project_id',
    'project_member.project_id'
  ]);
}

export function readProjectName(row, fallbackId, diagnostics = null, context = {}) {
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

export function projectFallbackName(fallbackId) {
  return fallbackId !== undefined && fallbackId !== null && String(fallbackId).trim() !== ''
    ? `Project ${fallbackId}`
    : 'Unknown project';
}

export function hasProjectName(row) {
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

export function readAssignedHours(row, diagnostics = null, context = {}) {
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

export function readLoggedHours(row, diagnostics = null, context = {}) {
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

export function readNumber(row, paths, diagnostics = null, context = {}) {
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

export function coerceHours(value, diagnostics = null, context = {}) {
  const number = Number(value);
  if (Number.isFinite(number) && number >= 0) {
    return number;
  }

  addWarning(diagnostics, 'invalid_hours', context);
  return 0;
}

export function readDateLike(row) {
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

export function normalizeDateOnly(value) {
  if (!value) {
    return '';
  }

  const text = String(value);
  const match = text.match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : '';
}

export function isDateKey(key, localDateISO) {
  return normalizeDateOnly(key) === localDateISO;
}

export function isDateInRange(localDateISO, { from, to } = {}) {
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

export function pickFirst(row, paths) {
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

export function unwrapRecords(data) {
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

export function extractLogtimeRecord(data, collectionKey) {
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

export function assertLogtimeId(value, name) {
  const normalized = String(value ?? '').trim();
  if (!normalized || !/^[A-Za-z0-9_-]+$/.test(normalized)) {
    throw new Error(`${name} must be a valid Resource Optimiser identifier.`);
  }
  return normalized;
}

export function preserveNumericId(value) {
  return /^\d+$/.test(value) && Number.isSafeInteger(Number(value))
    ? Number(value)
    : value;
}
