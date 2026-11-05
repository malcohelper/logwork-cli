import {
  addLogtime,
  ApiError,
  fetchWorklogTasksForProject,
  getBookedProjectsForDate,
  getProjects
} from './api.mjs';
import { listSuggestedTaskNames, resolveWorklogTask } from './worklog-task-resolver.mjs';
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
  typeOfWork
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

  const enriched = await attachWorklogTaskTargets(preview, {
    fetchWorklogTasks: worklogTaskFetcher
  });
  return typeOfWork ? { ...enriched, typeOfWork } : enriched;
}

export async function attachWorklogTaskTargets(preview, { fetchWorklogTasks } = {}) {
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
    try {
      const tasks = await fetchWorklogTasks(projectId, taskCache);
      const resolution = resolveWorklogTask({
        taskName: entry.taskName,
        projectId,
        tasks
      });
      entries.push({
        ...entry,
        worklogTaskId: resolution.worklogTaskId,
        worklogNeedsProjectId: resolution.needsProjectId,
        ...(resolution.typeOfWork ? { typeOfWork: resolution.typeOfWork } : {}),
        taskResolution: {
          status: 'resolved',
          reason: 'worklog_task_match',
          worklogTaskId: resolution.worklogTaskId,
          ...(resolution.typeOfWork ? { typeOfWork: resolution.typeOfWork } : {})
        }
      });
    } catch (error) {
      const classified = classifyWorklogTaskError(error);
      let suggestedTaskNames = [];
      if (classified.reason === 'task_not_found') {
        try {
          const tasks = await fetchWorklogTasks(projectId, taskCache);
          suggestedTaskNames = listSuggestedTaskNames(tasks, entry.taskName);
        } catch {
          suggestedTaskNames = [];
        }
      }
      entries.push({
        ...entry,
        status: 'unresolved',
        reason: classified.reason,
        confidence: 0,
        worklogTaskId: undefined,
        worklogNeedsProjectId: undefined,
        suggestedTaskNames,
        taskResolution: {
          status: 'unresolved',
          reason: classified.reason,
          error: classified.message,
          suggestedTaskNames
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
  cwd = process.cwd(),
  fetchProjects,
  fetchMembershipProjects,
  submitEntry,
  verifyLogwork,
  recordLedger,
  ledgerContext = {}
}) {
  if (confirm !== true) {
    throw new Error('apply_logwork_batch requires confirm: true.');
  }

  const preview = batch?.entries
    ? applyOverridesToBatch(batch, projectOverrides)
    : await previewLogworkBatch({
      text: batch?.text,
      projectOverrides,
      cwd,
      fetchProjects,
      fetchMembershipProjects
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
        projectName: entry.matchedProject.projectName,
        status: 'failed',
        dryRun: false,
        ok: false,
        error: error.message
      });
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
    entries: entries.map((entry) => [entry.id, entry.date, entry.hours, entry.taskName]),
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
    lines.push(`- ${entry.date}: ${prefix}+${entry.hours}h ${project} - ${entry.taskName}${hint ? ` (${hint})` : ''}`);
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
    if (setupSuggestions.length) {
      lines.push('Choose a project and call upsert_project_mapping, then preview again.');
    }
  } else if (unbooked) {
    lines.push(`Unbooked entries: ${unbooked}. Apply requires allowUnbooked: true.`);
  } else {
    lines.push('Ready to apply.');
  }
  return lines.join('\n');
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
    ...results.map((result) => `- ${result.date}: +${result.hours}h ${result.projectName} - ${result.taskName}`)
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
  if (
    message.startsWith('No worklog task named')
    || message.startsWith('Ambiguous worklog task')
  ) {
    return { reason: 'task_not_found', message };
  }
  return { reason: 'task_lookup_failed', message };
}
