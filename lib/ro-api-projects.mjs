// Project memberships and per-project day logs from the legacy member-logtime API.
import { CONFIG } from './config.mjs';
import { mapLimit, toApiLogDate } from './util.mjs';
import { ApiError, apiFetch } from './ro-api-http.mjs';
import {
  addDroppedRow,
  attachNormalizationDiagnostics,
  createNormalizationDiagnostics,
  diagnosticProjectFields,
  getNormalizationDiagnostics
} from './ro-api-diagnostics.mjs';
import {
  hasProjectName,
  normalizeDateOnly,
  projectFallbackName,
  readExplicitProjectMemberId,
  readNumber,
  readProjectId,
  readProjectName,
  unwrapRecords
} from './ro-api-fields.mjs';

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
