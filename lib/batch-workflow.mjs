import {
  addLogtime,
  ApiError,
  fetchWorklogTasksForProject,
  getBookedProjectsForDate,
  getLogworkDay,
  getProjects
} from './api.mjs';
import { isAuthRequiredError } from './auth-errors.mjs';
import {
  listAvailableTaskNames,
  listSuggestedTaskNames,
  resolveWorklogTask
} from './worklog-task-resolver.mjs';
import { recordApplyResult, recordApplyResultSafely } from './apply-ledger.mjs';
import { parseWeeklyLogText } from './batch-parser.mjs';
import { loadLocalConfig } from './logwork-config.mjs';
import { buildSetupSuggestions } from './project-mapping-workflow.mjs';
import { resolveEntryProject } from './project-resolver.mjs';
import { createResourceOptimiserSession, queryLogwork } from './query-workflow.mjs';

export async function previewLogworkBatch({
  text,
  projectOverrides = {},
  cwd = process.cwd(),
  fetchProjects,
  fetchMembershipProjects,
  fetchWorklogTasks,
  fetchDayEntries,
  typeOfWork,
  defaultWorklogTask
}) {
  const config = await loadLocalConfig(cwd);
  const parsed = parseWeeklyLogText(text);
  const dates = [...new Set(parsed.entries.map((entry) => entry.date))];
  const projectsByDate = new Map();
  const projectFetcher = fetchProjects || createBookedProjectsFetcher();
  const membershipFetcher = fetchMembershipProjects || createMembershipProjectsFetcher();
  const worklogTaskFetcher = fetchWorklogTasks || createWorklogTasksFetcher();

  for (const date of dates) {
    projectsByDate.set(date, await projectFetcher(date));
  }

  const bookedPreview = buildLogworkBatchPreview({
    parsed,
    projectsByDate,
    projectOverrides,
    config
  });

  const preview = !bookedPreview.unresolvedEntries.length
    ? bookedPreview
    : buildLogworkBatchPreview({
      parsed,
      projectsByDate,
      membershipProjects: await membershipFetcher(),
      projectOverrides,
      config
    });

  const normalizedDefaultTask = String(defaultWorklogTask ?? '').trim();
  const enriched = await attachWorklogTaskTargets(preview, {
    fetchWorklogTasks: worklogTaskFetcher,
    defaultWorklogTask: normalizedDefaultTask
  });
  const output = normalizedDefaultTask
    ? {
      ...enriched,
      // The default task changes what gets written, so approval must not reuse
      // a batchId previewed with a different default.
      batchId: `${enriched.batchId}_${hash(`defaultWorklogTask:${normalizedDefaultTask}`)}`,
      defaultWorklogTask: normalizedDefaultTask
    }
    : enriched;
  // typeOfWork also changes what gets written, so it is folded into the
  // batchId the same way.
  const typed = typeOfWork
    ? { ...output, typeOfWork, batchId: `${output.batchId}_${hash(`typeOfWork:${typeOfWork}`)}`, summary: `${output.summary}\n\nType of work for every entry: ${typeOfWork}` }
    : output;
  return attachDuplicateWarnings(typed, {
    fetchDayEntries: fetchDayEntries || createDayEntriesFetcher()
  });
}

// Duplicate guard: an entry is a possible duplicate when RO already has an
// entry on the same date with the same worklog task (id, else name), the same
// hours and the same description (trimmed, whitespace collapsed, any case), or
// when an earlier line of this batch is identical. Apply refuses those entries
// unless allowDuplicates: true. A failed day read (other than auth) skips the
// check for that date and says so; it never blocks the preview.
export async function attachDuplicateWarnings(preview, { fetchDayEntries } = {}) {
  const entries = preview.entries || [];
  if (!entries.length || preview.errors?.length) {
    return preview;
  }

  const dates = [...new Set(entries.map((entry) => entry.date).filter(Boolean))].sort();
  const existingByDate = new Map();
  const skipped = [];
  for (const date of dates) {
    try {
      existingByDate.set(date, await fetchDayEntries(date));
    } catch (error) {
      if (isAuthRequiredError(error) || (error instanceof ApiError && error.status === 401)) {
        throw error;
      }
      skipped.push({ date, error: String(error?.message || error) });
    }
  }

  const seen = [];
  const flagged = entries.map((entry) => {
    const { possibleDuplicate: _previous, ...base } = entry;
    const existing = (existingByDate.get(entry.date) || [])
      .filter((candidate) => !candidate?.raw?.deleted_date && !candidate?.deletedDate)
      .find((candidate) => isSameLogwork(entry, candidate));
    const earlier = seen.find((candidate) => isSameLogwork(entry, candidate));
    seen.push(entry);
    if (existing) {
      return {
        ...base,
        possibleDuplicate: {
          source: 'ro',
          logworkId: existing.id ?? null,
          date: existing.date || entry.date,
          hours: Number(existing.hours),
          taskName: existingTaskName(existing),
          worklogTaskId: existing.worklogTaskId ?? null,
          description: existing.description || '',
          status: existing.status || '',
          projectName: existing.projectName || ''
        }
      };
    }
    if (earlier) {
      return {
        ...base,
        possibleDuplicate: {
          source: 'batch',
          logworkId: null,
          entryId: earlier.id,
          date: earlier.date,
          hours: earlier.hours,
          taskName: earlier.taskName,
          description: earlier.description || ''
        }
      };
    }
    return base;
  });

  const duplicateEntries = flagged.filter((entry) => entry.possibleDuplicate);
  const duplicateCheck = {
    status: skipped.length ? (skipped.length === dates.length ? 'skipped' : 'partial') : 'checked',
    checkedDates: dates.filter((date) => existingByDate.has(date)),
    ...(skipped.length ? { skippedDates: skipped } : {})
  };
  const summaryLines = [];
  if (duplicateEntries.length) {
    summaryLines.push(`Possible duplicates: ${duplicateEntries.length}. Apply requires allowDuplicates: true.`);
    summaryLines.push(...duplicateEntries.map(formatDuplicateWarning));
  }
  for (const item of skipped) {
    summaryLines.push(`Note: duplicate check skipped for ${item.date} (could not read RO entries: ${item.error}).`);
  }

  return {
    ...preview,
    entries: flagged,
    unresolvedEntries: flagged.filter((entry) => entry.status === 'unresolved'),
    unbookedEntries: flagged.filter((entry) => entry.status === 'resolved_unbooked'),
    duplicateEntries,
    duplicateCheck,
    approvalSummary: {
      ...preview.approvalSummary,
      possibleDuplicates: duplicateEntries.length,
      requiresAllowDuplicates: duplicateEntries.length > 0
    },
    summary: summaryLines.length ? `${preview.summary}\n${summaryLines.join('\n')}` : preview.summary
  };
}

function formatDuplicateWarning(entry) {
  const duplicate = entry.possibleDuplicate;
  const line = `${entry.id}: +${entry.hours}h ${formatTaskAndDescription(entry)}`;
  if (duplicate.source === 'batch') {
    return `- WARNING possible duplicate ${line} repeats line ${duplicate.entryId} of this batch.`;
  }
  const status = duplicate.status ? `, ${duplicate.status}` : '';
  const project = duplicate.projectName ? ` on ${duplicate.projectName}` : '';
  return `- WARNING possible duplicate ${line} matches existing RO logwork ${duplicate.logworkId ?? '(no id)'}${project}${status}.`;
}

function isSameLogwork(entry, other) {
  if (!other || (other.date && entry.date && other.date !== entry.date)) {
    return false;
  }
  if (Math.abs(Number(entry.hours) - Number(other.hours)) > 1e-9) {
    return false;
  }
  if (normalizeDuplicateText(entry.description) !== normalizeDuplicateText(other.description)) {
    return false;
  }
  const entryTaskId = entry.worklogTaskId;
  const otherTaskId = other.worklogTaskId;
  if (hasId(entryTaskId) && hasId(otherTaskId)) {
    return String(entryTaskId) === String(otherTaskId);
  }
  const entryTask = normalizeDuplicateText(entry.worklogTaskName || entry.taskName);
  return Boolean(entryTask) && entryTask === normalizeDuplicateText(existingTaskName(other));
}

function existingTaskName(entry) {
  const raw = entry?.raw || {};
  return entry?.worklogTaskName || raw.worklog_task_name || raw.worklog_task?.name || raw.worklogTask?.name || entry?.taskName || '';
}

function normalizeDuplicateText(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function hasId(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

export const LOGWORK_LINE_FORMAT = '+<hours> <worklog task> | <description>';

export async function listWorklogTasks({ projectId, fetchWorklogTasks } = {}) {
  const normalizedProjectId = Number(projectId);
  if (!Number.isFinite(normalizedProjectId) || normalizedProjectId <= 0) {
    throw new Error('projectId must be a positive Resource Optimiser project id (see list_projects).');
  }
  const fetcher = fetchWorklogTasks || createWorklogTasksFetcher();
  const tasks = (await fetcher(normalizedProjectId)).map((task) => ({
    id: task.id,
    name: String(task.name || '').trim(),
    typeOfWork: task.typeOfWork ?? task.type_of_work ?? null,
    description: String(task.description || '').trim(),
    projectSpecific: task.projectId !== null && task.projectId !== undefined,
    isDefault: Boolean(task.isDefault ?? task.is_default)
  })).filter((task) => task.name);

  return {
    projectId: normalizedProjectId,
    tasks,
    lineFormat: LOGWORK_LINE_FORMAT,
    summary: [
      `Found ${tasks.length} worklog task${tasks.length === 1 ? '' : 's'} for project ${normalizedProjectId}.`,
      ...tasks.map((task) => `- #${task.id} ${task.name}${task.typeOfWork ? ` (${task.typeOfWork})` : ''}${task.description ? `: ${task.description}` : ''}`),
      `Write logwork lines as "${LOGWORK_LINE_FORMAT}", for example "+2 Feature Development | Implement maintenance mode UI (SCB-213)". Pick the task whose description best matches the work.`
    ].join('\n')
  };
}

// Resolves which Resource Optimiser worklog task (catalog item) and which free-text
// description each entry writes:
// - "+2 Code Review & Refactoring | Review PR #12 (SCB-1)": explicit task + description.
// - "+2 Code Review": whole text matches a catalog task, so no description.
// - "+2 Review PR #12 (SCB-1)": no catalog match, so the text becomes the
//   description and defaultWorklogTask supplies the task; without a default the
//   entry stays unresolved with reason worklog_task_required.
export async function attachWorklogTaskTargets(preview, { fetchWorklogTasks, defaultWorklogTask = '' } = {}) {
  if (!fetchWorklogTasks) {
    return preview;
  }

  const taskCache = new Map();
  const entries = [];

  for (const entry of preview.entries || []) {
    if (entry.status !== 'resolved' && entry.status !== 'resolved_unbooked') {
      entries.push(entry);
      continue;
    }

    const projectId = entry.matchedProject?.projectId;
    let tasks = [];
    try {
      tasks = await fetchWorklogTasks(projectId, taskCache);
      const { resolution, description, reason } = resolveEntryWorklogTask({
        entry,
        projectId,
        tasks,
        defaultWorklogTask
      });
      entries.push({
        ...entry,
        taskName: resolution.taskName || entry.taskName,
        description,
        descriptionMissing: !description,
        worklogTaskId: resolution.worklogTaskId,
        worklogTaskName: resolution.taskName || entry.taskName,
        worklogNeedsProjectId: resolution.needsProjectId,
        ...(resolution.typeOfWork ? { typeOfWork: resolution.typeOfWork } : {}),
        taskResolution: {
          status: 'resolved',
          reason,
          worklogTaskId: resolution.worklogTaskId,
          worklogTaskName: resolution.taskName || entry.taskName,
          ...(resolution.typeOfWork ? { typeOfWork: resolution.typeOfWork } : {})
        }
      });
    } catch (error) {
      const classified = classifyWorklogTaskError(error);
      const suggestedTaskNames = classified.reason === 'task_not_found'
        ? listSuggestedTaskNames(tasks, entry.taskName)
        : [];
      const availableTaskNames = classified.reason === 'task_lookup_failed'
        ? []
        : listAvailableTaskNames(tasks);
      entries.push({
        ...entry,
        status: 'unresolved',
        reason: classified.reason,
        confidence: 0,
        worklogTaskId: undefined,
        worklogNeedsProjectId: undefined,
        suggestedTaskNames,
        availableTaskNames,
        taskResolution: {
          status: 'unresolved',
          reason: classified.reason,
          error: classified.message,
          suggestedTaskNames,
          availableTaskNames
        },
        resolution: {
          ...(entry.resolution || {}),
          status: 'unresolved',
          reason: classified.reason,
          confidence: 0,
          autoResolved: false,
          requiresUserChoice: true,
          requiresAllowUnbooked: false,
          candidates: entry.resolution?.candidates || []
        }
      });
    }
  }

  const unresolvedEntries = entries.filter((entry) => entry.status === 'unresolved');
  const unbookedEntries = entries.filter((entry) => entry.status === 'resolved_unbooked');
  const approvalSummary = buildApprovalSummary(entries, preview.errors || []);
  const setupSuggestions = preview.setupSuggestions || [];

  return {
    ...preview,
    entries,
    unresolvedEntries,
    unbookedEntries,
    approvalSummary,
    status: getBatchStatus(preview.errors || [], unresolvedEntries, unbookedEntries),
    summary: formatPreviewSummary(entries, preview.errors || [], setupSuggestions, approvalSummary)
  };
}

function resolveEntryWorklogTask({ entry, projectId, tasks, defaultWorklogTask }) {
  if (entry.taskExplicit) {
    return {
      resolution: resolveWorklogTask({ taskName: entry.taskName, projectId, tasks }),
      description: entry.description || '',
      reason: 'worklog_task_match'
    };
  }

  try {
    return {
      resolution: resolveWorklogTask({ taskName: entry.taskName, projectId, tasks }),
      description: '',
      reason: 'worklog_task_match'
    };
  } catch (error) {
    if (!String(error?.message || '').startsWith('No worklog task named')) {
      throw error;
    }
  }

  const text = entry.text ?? entry.taskName;
  if (!defaultWorklogTask) {
    throw new WorklogTaskRequiredError(
      `"${text}" is not a Resource Optimiser worklog task for project ${projectId}. ` +
      'Write the line as "+<hours> <worklog task> | <description>" or pass defaultWorklogTask.'
    );
  }
  return {
    resolution: resolveWorklogTask({ taskName: defaultWorklogTask, projectId, tasks }),
    description: text,
    reason: 'default_worklog_task'
  };
}

class WorklogTaskRequiredError extends Error {
  constructor(message) {
    super(message);
    this.code = 'worklog_task_required';
  }
}

export function buildLogworkBatchPreview({
  parsed,
  projectsByDate,
  membershipProjects = [],
  projectOverrides = {},
  config = {}
}) {
  const batchId = createBatchId(parsed.entries, projectOverrides);
  const entries = parsed.entries.map((entry) => {
    const projects = projectsByDate instanceof Map
      ? projectsByDate.get(entry.date) || []
      : projectsByDate?.[entry.date] || [];
    const resolution = resolveEntryProject({
      entry,
      projects,
      membershipProjects,
      projectOverrides,
      config
    });

    const matchedProject = resolution.status === 'resolved' || resolution.status === 'resolved_unbooked' ? {
      projectMemberId: resolution.project.projectMemberId,
      projectId: resolution.project.projectId,
      projectName: resolution.project.projectName
    } : null;

    return {
      ...entry,
      status: resolution.status,
      reason: resolution.reason,
      confidence: resolution.confidence,
      matchedProject,
      booked: Boolean(resolution.booked),
      requiresAllowUnbooked: Boolean(resolution.requiresAllowUnbooked),
      candidates: resolution.candidates,
      resolution: buildResolutionMetadata(resolution)
    };
  });
  const unresolvedEntries = entries.filter((entry) => entry.status === 'unresolved');
  const unbookedEntries = entries.filter((entry) => entry.status === 'resolved_unbooked');
  const setupSuggestions = buildSetupSuggestions(unresolvedEntries, membershipProjects);
  const approvalSummary = buildApprovalSummary(entries, parsed.errors);

  return {
    batchId,
    status: getBatchStatus(parsed.errors, unresolvedEntries, unbookedEntries),
    errors: parsed.errors,
    entries,
    unresolvedEntries,
    unbookedEntries,
    setupSuggestions,
    totalsByDate: totalsBy(entries, (entry) => entry.date),
    totalsByProject: totalsBy(entries.filter((entry) => entry.matchedProject), (entry) => entry.matchedProject.projectName),
    approvalSummary,
    summary: formatPreviewSummary(entries, parsed.errors, setupSuggestions, approvalSummary)
  };
}

export async function applyLogworkBatch({
  batch,
  confirm,
  projectOverrides = {},
  allowUnbooked = false,
  allowDuplicates = false,
  cwd = process.cwd(),
  fetchProjects,
  fetchMembershipProjects,
  fetchDayEntries,
  submitEntry,
  verifyLogwork,
  recordLedger,
  ledgerContext = {}
}) {
  if (confirm !== true) {
    throw new Error('Apply requires confirm: true.');
  }

  const preview = batch?.entries
    ? applyOverridesToBatch(batch, projectOverrides)
    : await previewLogworkBatch({
      text: batch?.text,
      projectOverrides,
      cwd,
      fetchProjects,
      fetchMembershipProjects,
      fetchDayEntries
    });

  if (preview.errors?.length) {
    throw new Error(`Cannot apply batch with parse errors: ${preview.errors.map((error) => error.message).join('; ')}`);
  }

  if (preview.unresolvedEntries?.length) {
    throw new Error(`Cannot apply batch with ${preview.unresolvedEntries.length} unresolved entries.`);
  }

  const unbookedEntries = preview.entries.filter((entry) => entry.requiresAllowUnbooked);
  if (unbookedEntries.length && allowUnbooked !== true) {
    const blocked = unbookedEntries
      .map((entry) => `${entry.id}: +${entry.hours}h ${entry.taskName} -> ${entry.matchedProject?.projectName || 'unknown project'}`)
      .join('; ');
    throw new Error(`Cannot apply ${unbookedEntries.length} unbooked entries without allowUnbooked: true. ${blocked}`);
  }

  const duplicateEntries = preview.entries.filter((entry) => entry.possibleDuplicate);
  if (duplicateEntries.length && allowDuplicates !== true) {
    throw new Error(`Nothing was written. ${formatDuplicateBlock(duplicateEntries)} Apply requires allowDuplicates: true.`);
  }

  const results = [];
  const taskCache = new Map();
  const entrySubmitter = submitEntry || createLogtimeSubmitter(taskCache);
  const ledgerWriter = recordLedger === undefined
    ? (!submitEntry && !verifyLogwork ? recordApplyResult : null)
    : recordLedger;
  for (const entry of preview.entries) {
    try {
      const entryTypeOfWork = preview.typeOfWork || entry.typeOfWork;
      const result = await entrySubmitter({
        projectMemberId: entry.matchedProject.projectMemberId,
        projectId: entry.matchedProject.projectId,
        logtimes: entry.hours,
        taskName: entry.taskName,
        ...(entry.description ? { description: entry.description } : {}),
        localDateISO: entry.date,
        worklogTaskId: entry.worklogTaskId,
        worklogNeedsProjectId: entry.worklogNeedsProjectId,
        ...(entryTypeOfWork ? { typeOfWork: entryTypeOfWork } : {}),
        taskCache
      });

      results.push({
        entryId: entry.id,
        date: entry.date,
        hours: entry.hours,
        taskName: entry.taskName,
        description: entry.description || '',
        projectName: entry.matchedProject.projectName,
        status: 'approved',
        dryRun: Boolean(result?.dryRun),
        ok: true,
        result
      });
    } catch (error) {
      results.push({
        entryId: entry.id,
        date: entry.date,
        hours: entry.hours,
        taskName: entry.taskName,
        description: entry.description || '',
        projectName: entry.matchedProject.projectName,
        status: 'failed',
        dryRun: false,
        ok: false,
        error: error.message
      });
      // Earlier entries are already in RO. Say so plainly: re-applying the same
      // text would log them twice.
      const written = results.filter((result) => result.ok);
      const notTried = preview.entries.slice(results.length).map((item) => item.id);
      error.message = `Entry ${entry.id} (+${entry.hours}h ${entry.taskName}) failed: ${error.message}` +
        (written.length
          ? ` Already written to RO: ${written.map((result) => `${result.entryId} (+${result.hours}h ${result.taskName})`).join(', ')}. Do not apply this batch again; preview only the entries that were not written.`
          : ' Nothing was written.') +
        (notTried.length ? ` Not attempted: ${notTried.join(', ')}.` : '');
      error.partialResults = results;
      error.applyLedger = await recordRoApplyLedger({
        writer: ledgerWriter,
        preview,
        results,
        status: results.some((result) => result.status === 'approved') ? 'partial_failed' : 'failed',
        cwd,
        ledgerContext
      });
      throw error;
    }
  }

  const output = {
    batchId: preview.batchId,
    status: 'submitted',
    dryRun: results.some((result) => result.dryRun),
    results,
    submissionSummary: buildSubmissionSummary(results),
    verification: await buildApplyVerification({
      preview,
      results,
      cwd,
      verifyLogwork
    }),
    summary: formatApplySummary(results)
  };
  output.ledger = await recordRoApplyLedger({
    writer: ledgerWriter,
    preview,
    results,
    status: output.status,
    cwd,
    ledgerContext
  });
  return output;
}

export function formatToolResponse(payload) {
  return {
    content: [
      {
        type: 'text',
        text: `${payload.summary}\n\n${JSON.stringify(payload, null, 2)}`
      }
    ],
    structuredContent: payload
  };
}

function createBookedProjectsFetcher() {
  const session = createResourceOptimiserSession();
  return async (localDateISO) => {
    const { token, userId } = await session.get();
    try {
      return await getBookedProjectsForDate(token, userId, localDateISO);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) {
        throw error;
      }

      const refreshed = await session.get({ forceLogin: true });
      return getBookedProjectsForDate(refreshed.token, refreshed.userId, localDateISO);
    }
  };
}

export function formatDuplicateBlock(entries) {
  const list = entries.map((entry) => {
    const duplicate = entry.possibleDuplicate || {};
    const target = duplicate.source === 'batch'
      ? `line ${duplicate.entryId}`
      : `RO logwork ${duplicate.logworkId ?? '(no id)'}`;
    return `${entry.id} (+${entry.hours}h ${entry.taskName}) matches ${target}`;
  }).join('; ');
  return `${entries.length} entr${entries.length === 1 ? 'y looks' : 'ies look'} already logged: ${list}.`;
}

// Existing RO entries for one date, from GET /logwork/day, with one forced
// re-login on a 401.
function createDayEntriesFetcher() {
  const session = createResourceOptimiserSession();
  return async (localDateISO) => {
    const { token } = await session.get();
    try {
      return (await getLogworkDay(token, { date: localDateISO })).entries || [];
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) {
        throw error;
      }

      const refreshed = await session.get({ forceLogin: true });
      return (await getLogworkDay(refreshed.token, { date: localDateISO })).entries || [];
    }
  };
}

function createMembershipProjectsFetcher() {
  const session = createResourceOptimiserSession();
  return async () => {
    const { token, userId } = await session.get();
    try {
      return await getProjects(token, userId);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) {
        throw error;
      }

      const refreshed = await session.get({ forceLogin: true });
      return getProjects(refreshed.token, refreshed.userId);
    }
  };
}

function createLogtimeSubmitter(taskCache = new Map()) {
  const session = createResourceOptimiserSession();
  return async (entry) => {
    const payload = {
      ...entry,
      taskCache: entry.taskCache || taskCache
    };
    const { token } = await session.get();
    try {
      return await addLogtime(token, payload);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) {
        throw error;
      }

      const refreshed = await session.get({ forceLogin: true });
      return addLogtime(refreshed.token, payload);
    }
  };
}

function createWorklogTasksFetcher() {
  const session = createResourceOptimiserSession();
  const cache = new Map();
  return async (projectId, taskCache = cache) => {
    const { token } = await session.get();
    try {
      return await fetchWorklogTasksForProject(token, projectId, { cache: taskCache });
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) {
        throw error;
      }

      const refreshed = await session.get({ forceLogin: true });
      return fetchWorklogTasksForProject(refreshed.token, projectId, { cache: taskCache });
    }
  };
}

function applyOverridesToBatch(batch, projectOverrides) {
  if (!projectOverrides || !Object.keys(projectOverrides).length) {
    return batch;
  }

  const entries = (batch.entries || []).map((entry) => {
    if (!Object.hasOwn(projectOverrides, entry.id)) {
      return entry;
    }

    const candidates = (entry.candidates || []).map((candidate) => ({
      projectMemberId: candidate.projectMemberId,
      projectId: candidate.projectId,
      projectName: candidate.projectName,
      booked: candidate.booked
    }));
    if (entry.matchedProject) {
      candidates.push({
        ...entry.matchedProject,
        booked: Boolean(entry.booked)
      });
    }

    const preview = buildLogworkBatchPreview({
      parsed: {
        entries: [entry],
        errors: []
      },
      projectsByDate: new Map([[entry.date, candidates.filter((candidate) => candidate.booked)]]),
      membershipProjects: candidates,
      projectOverrides,
      config: { projectMappings: [] }
    });
    return preview.entries[0];
  });

  const unresolvedEntries = entries.filter((entry) => entry.status === 'unresolved');
  const unbookedEntries = entries.filter((entry) => entry.status === 'resolved_unbooked');
  const setupSuggestions = buildSetupSuggestions(unresolvedEntries, entries.flatMap((entry) => entry.candidates || []));
  const approvalSummary = buildApprovalSummary(entries, batch.errors || []);
  return {
    ...batch,
    status: getBatchStatus(batch.errors || [], unresolvedEntries, unbookedEntries),
    entries,
    unresolvedEntries,
    unbookedEntries,
    setupSuggestions,
    totalsByDate: totalsBy(entries, (entry) => entry.date),
    totalsByProject: totalsBy(entries.filter((entry) => entry.matchedProject), (entry) => entry.matchedProject.projectName),
    approvalSummary,
    summary: formatPreviewSummary(entries, batch.errors || [], setupSuggestions, approvalSummary)
  };
}

async function buildApplyVerification({ preview, results, cwd, verifyLogwork }) {
  if (results.some((result) => result.dryRun)) {
    return null;
  }

  const dates = [...new Set(preview.entries.map((entry) => entry.date))].sort();
  if (!dates.length) {
    return null;
  }

  const from = dates[0];
  const to = addOneDay(dates[dates.length - 1]);
  const verifier = verifyLogwork || ((args) => queryLogwork({
    ...args,
    cwd,
    includeEntries: false
  }));

  return verifier({ from, to, includeEntries: false });
}

function addOneDay(localDateISO) {
  const [year, month, day] = localDateISO.split('-').map(Number);
  const date = new Date(year, month - 1, day + 1);
  return [
    String(date.getFullYear()).padStart(4, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function createBatchId(entries, projectOverrides) {
  const source = JSON.stringify({
    entries: entries.map((entry) => [entry.id, entry.date, entry.hours, entry.text ?? entry.taskName]),
    projectOverrides
  });
  return `batch_${hash(source)}`;
}

function getBatchStatus(errors, unresolvedEntries, unbookedEntries) {
  if (errors.length) {
    return 'invalid';
  }

  if (unresolvedEntries.length) {
    return 'unresolved';
  }

  if (unbookedEntries.length) {
    return 'ready_with_unbooked';
  }

  return 'ready';
}

function hash(value) {
  let hashValue = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hashValue ^= value.charCodeAt(index);
    hashValue = Math.imul(hashValue, 16777619);
  }
  return (hashValue >>> 0).toString(16);
}

function totalsBy(entries, keyFn) {
  return entries.reduce((totals, entry) => {
    const key = keyFn(entry);
    totals[key] = Number((Number(totals[key] || 0) + Number(entry.hours || 0)).toFixed(2));
    return totals;
  }, {});
}

function buildApprovalSummary(entries, errors = []) {
  const unresolvedEntries = entries.filter((entry) => entry.status === 'unresolved');
  const unbookedEntries = entries.filter((entry) => entry.status === 'resolved_unbooked');
  const dates = [...new Set(entries.map((entry) => entry.date).filter(Boolean))].sort();
  const projectMap = new Map();

  for (const entry of entries) {
    const key = entry.matchedProject?.projectMemberId
      ? `member:${entry.matchedProject.projectMemberId}`
      : entry.matchedProject?.projectName
        ? `name:${entry.matchedProject.projectName}`
        : 'unresolved';
    const existing = projectMap.get(key) || {
      projectMemberId: entry.matchedProject?.projectMemberId ?? null,
      projectId: entry.matchedProject?.projectId ?? null,
      projectName: entry.matchedProject?.projectName || 'UNRESOLVED',
      hours: 0,
      entries: 0,
      unbookedEntries: 0,
      unresolvedEntries: 0
    };

    existing.hours = Number((existing.hours + Number(entry.hours || 0)).toFixed(2));
    existing.entries += 1;
    if (entry.status === 'resolved_unbooked') {
      existing.unbookedEntries += 1;
    }
    if (entry.status === 'unresolved') {
      existing.unresolvedEntries += 1;
    }
    projectMap.set(key, existing);
  }

  return {
    entryCount: entries.length,
    totalHours: Number(entries.reduce((total, entry) => total + Number(entry.hours || 0), 0).toFixed(2)),
    dateRange: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
    projectCount: [...projectMap.values()].filter((project) => project.projectName !== 'UNRESOLVED').length,
    projects: [...projectMap.values()],
    unresolvedEntries: unresolvedEntries.length,
    unbookedEntries: unbookedEntries.length,
    requiresUserChoice: unresolvedEntries.length > 0,
    requiresAllowUnbooked: unbookedEntries.length > 0,
    confirmRequired: true,
    canApply: !errors.length && unresolvedEntries.length === 0
  };
}

function buildResolutionMetadata(resolution) {
  const autoResolved = resolution.status === 'resolved' || resolution.status === 'resolved_unbooked';
  return {
    status: resolution.status,
    reason: resolution.reason,
    confidence: resolution.confidence,
    booked: Boolean(resolution.booked),
    autoResolved,
    requiresUserChoice: resolution.status === 'unresolved',
    requiresAllowUnbooked: Boolean(resolution.requiresAllowUnbooked),
    candidates: resolution.candidates || []
  };
}

function formatPreviewSummary(entries, errors, setupSuggestions = [], approvalSummary = buildApprovalSummary(entries, errors)) {
  if (errors.length) {
    return [
      'Logwork preview has parse errors:',
      ...errors.map((error) => `- line ${error.line}: ${error.message}`)
    ].join('\n');
  }

  const lines = ['Logwork preview:'];
  for (const entry of entries) {
    const project = entry.matchedProject?.projectName || 'UNRESOLVED';
    const prefix = entry.status === 'resolved_unbooked' ? 'UNBOOKED: ' : '';
    const hint = formatResolutionHint(entry);
    lines.push(`- ${entry.date}: ${prefix}+${entry.hours}h ${project} - ${formatTaskAndDescription(entry)}${hint ? ` (${hint})` : ''}`);
  }
  lines.push(...formatApprovalSummaryLines(approvalSummary));
  const unresolved = entries.filter((entry) => entry.status === 'unresolved').length;
  const unbooked = entries.filter((entry) => entry.status === 'resolved_unbooked').length;
  if (unresolved) {
    lines.push(`Unresolved entries: ${unresolved}`);
    const taskFailures = entries.filter((entry) => entry.reason === 'task_not_found').length;
    if (taskFailures) {
      lines.push('Some entries need a worklog task name that exactly matches Resource Optimiser.');
    }
    const taskRequired = entries.filter((entry) => entry.reason === 'worklog_task_required');
    if (taskRequired.length) {
      const names = taskRequired[0].availableTaskNames || [];
      lines.push('Some entries need a worklog task. Use "+<hours> <worklog task> | <description>" or pass defaultWorklogTask, then preview again.');
      if (names.length) {
        lines.push(`Available worklog tasks: ${names.join(', ')}.`);
      }
    }
    if (setupSuggestions.length) {
      lines.push('Choose a project and call map_project, then preview again.');
    }
  } else if (unbooked) {
    lines.push(`Unbooked entries: ${unbooked}. Apply requires allowUnbooked: true.`);
  } else {
    lines.push('Ready to apply.');
  }
  const missingDescriptions = entries.filter((entry) => entry.status !== 'unresolved' && entry.descriptionMissing).length;
  if (missingDescriptions) {
    lines.push(`Warning: ${missingDescriptions} entr${missingDescriptions === 1 ? 'y has' : 'ies have'} no description. Use "+<hours> <worklog task> | <description>" to add one.`);
  }
  return lines.join('\n');
}

function formatTaskAndDescription(entry) {
  const description = entry.description || '';
  return description ? `${entry.taskName} | ${description}` : entry.taskName;
}

function formatApprovalSummaryLines(approvalSummary) {
  if (!approvalSummary.entryCount) {
    return [];
  }

  const dateText = approvalSummary.dateRange
    ? `${approvalSummary.dateRange.from}${approvalSummary.dateRange.to === approvalSummary.dateRange.from ? '' : ` to ${approvalSummary.dateRange.to}`}`
    : 'unknown dates';
  const projects = approvalSummary.projects
    .map((project) => `${project.projectName}: ${formatHours(project.hours)}h`)
    .join('; ');

  return [
    `Approval checklist: ${approvalSummary.entryCount} entr${approvalSummary.entryCount === 1 ? 'y' : 'ies'}, ${formatHours(approvalSummary.totalHours)}h total, ${dateText}.`,
    `Projects: ${projects || 'none'}.`
  ];
}

function formatResolutionHint(entry) {
  const reason = entry.reason || entry.resolution?.reason;
  if (!reason) {
    return '';
  }

  const confidence = Number(entry.confidence ?? entry.resolution?.confidence);
  const confidenceText = Number.isFinite(confidence)
    ? `, confidence ${formatConfidence(confidence)}`
    : '';
  const prefix = entry.status === 'unresolved' ? 'needs user choice' : 'via';
  return `${prefix} ${reason}${confidenceText}`;
}

function formatConfidence(confidence) {
  return Number(confidence).toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function formatApplySummary(results) {
  const submissionSummary = buildSubmissionSummary(results);
  return [
    results.some((result) => result.dryRun) ? 'DRY RUN: logwork payloads generated.' : 'Logwork submitted:',
    `Submitted ${submissionSummary.entryCount} entr${submissionSummary.entryCount === 1 ? 'y' : 'ies'}, ${formatHours(submissionSummary.totalHours)}h total.`,
    ...results.map((result) => `- ${result.date}: +${result.hours}h ${result.projectName} - ${formatTaskAndDescription(result)}`)
  ].join('\n');
}

function buildSubmissionSummary(results) {
  return {
    entryCount: results.length,
    totalHours: Number(results.reduce((total, result) => total + Number(result.hours || 0), 0).toFixed(2)),
    dryRun: results.some((result) => result.dryRun),
    dates: [...new Set(results.map((result) => result.date).filter(Boolean))].sort(),
    projects: Object.entries(totalsBy(results, (result) => result.projectName || 'Unknown project'))
      .map(([projectName, hours]) => ({ projectName, hours }))
  };
}

function recordRoApplyLedger({ writer, preview, results, status, cwd, ledgerContext }) {
  return recordApplyResultSafely(writer, {
    target: 'ro',
    flowTarget: ledgerContext.flowTarget || 'ro',
    batchId: preview.batchId,
    status,
    cwd,
    entries: results
  });
}

function formatHours(hours) {
  return Number(hours).toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function classifyWorklogTaskError(error) {
  const message = String(error?.message || error || 'Task lookup failed.');
  if (error?.code === 'worklog_task_required') {
    return { reason: 'worklog_task_required', message };
  }
  if (
    message.startsWith('No worklog task named')
    || message.startsWith('Ambiguous worklog task')
  ) {
    return { reason: 'task_not_found', message };
  }
  return { reason: 'task_lookup_failed', message };
}
