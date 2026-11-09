import {
  ApiError,
  createLogworkEntry,
  deleteLogworkEntry,
  fetchWorklogTasksForProject,
  getLogworkDay
} from './api.mjs';
import { recordApplyResult, recordApplyResultSafely } from './apply-ledger.mjs';
import { createResourceOptimiserSession } from './query-workflow.mjs';
import { resolveWorklogTask } from './worklog-task-resolver.mjs';
import { createF03LogworkReader } from './ro-entry-reader.mjs';

// Resource Optimiser F03 has no staff endpoint for editing an entry
// (PATCH /logwork/pm/entries/:id/edit-approve is PM-only). An edit is
// therefore a replace: create the corrected entry with POST /logwork/entries,
// then delete the original with DELETE /logwork/entries/:id. Creating first
// means a failure never loses the original; if the delete fails, the new entry
// is rolled back so the day is left as it was.

const EDITABLE_STATUSES = new Set(['submitted', 'approved']);
const TYPE_OF_WORK = new Set(['create', 'correct', 'improve', 'other']);
const MAX_DESCRIPTION_LENGTH = 1_000;

export async function previewRoLogworkEdit({
  logworkId,
  hours,
  taskName,
  description,
  typeOfWork,
  fetchLogwork,
  fetchWorklogTasks
}) {
  const requested = normalizeRequestedChanges({ hours, taskName, description, typeOfWork });
  const reader = fetchLogwork || createF03LogworkReader();
  const current = await reader(assertIdentifier(logworkId, 'logworkId'));
  assertEditableLogwork(current);

  const original = sanitizeLogwork(current);
  const taskReader = fetchWorklogTasks || createWorklogTaskReader();
  const tasks = await taskReader(original.projectId);
  const task = requested.taskName === undefined
    ? resolveCurrentTask(original, tasks)
    : resolveWorklogTask({ taskName: requested.taskName, projectId: original.projectId, tasks });
  const taskChanged = String(task.worklogTaskId) !== String(original.worklogTaskId);

  const updated = {
    ...original,
    id: null,
    hours: requested.hours ?? original.hours,
    worklogTaskId: task.worklogTaskId,
    taskName: task.taskName,
    needsProjectId: task.needsProjectId,
    typeOfWork: requested.typeOfWork
      ?? (taskChanged ? task.typeOfWork : undefined)
      ?? (TYPE_OF_WORK.has(original.typeOfWork) ? original.typeOfWork : undefined)
      ?? task.typeOfWork
      ?? 'other',
    description: requested.description ?? original.description,
    status: '',
    isLocked: false
  };
  const changes = buildChanges(original, updated);
  if (!Object.values(changes).some(Boolean)) {
    throw new Error('The requested RO logwork edit does not change hours, worklog task, type of work, or description.');
  }

  const originalFingerprint = createLogworkRevisionFingerprint(current);
  const previewId = createPreviewId({ originalFingerprint, updated });
  const preview = {
    previewId,
    status: 'ready',
    strategy: 'replace',
    logworkId: original.id,
    original,
    updated,
    changes,
    warnings: buildWarnings(original, updated),
    originalFingerprint
  };
  preview.summary = formatRoEditPreviewSummary(preview);
  return preview;
}

export async function applyRoLogworkEdit({
  preview,
  confirm,
  cwd = process.cwd(),
  fetchLogwork,
  fetchDayEntries,
  submitCreate,
  submitDelete,
  recordLedger
}) {
  if (confirm !== true) {
    throw new Error('Edit requires confirm: true.');
  }
  assertReadyPreview(preview);

  const injected = Boolean(fetchLogwork || submitCreate || submitDelete);
  const reader = fetchLogwork || createF03LogworkReader();
  const creator = submitCreate || createEntryWriter();
  const deleter = submitDelete || createDeleteWriter();
  const dayReader = fetchDayEntries || (injected ? null : createDayEntriesReader());
  const ledgerWriter = recordLedger === undefined
    ? (injected ? null : recordApplyResult)
    : recordLedger;

  const current = await reader(preview.logworkId);
  assertEditableLogwork(current);
  if (createLogworkRevisionFingerprint(current) !== preview.originalFingerprint) {
    throw new Error('RO logwork changed after preview. Preview the edit again before applying.');
  }

  const createRequest = {
    worklogTaskId: preview.updated.worklogTaskId,
    projectId: preview.updated.projectId,
    effortHours: preview.updated.hours,
    localDateISO: preview.updated.date,
    typeOfWork: preview.updated.typeOfWork,
    description: preview.updated.description,
    needsProjectId: preview.updated.needsProjectId
  };

  // Entry ids already on the target day, so a replacement found later by its
  // values is never confused with an older identical entry.
  const existingIds = await readDayEntryIds(dayReader, preview.updated.date);

  let createResult;
  try {
    createResult = await creator(createRequest);
  } catch (error) {
    // Writes are not retried, so a timeout is ambiguous: RO may have saved the
    // entry. Look for it before reporting that nothing changed.
    const savedId = await findCreatedEntryId({ dayReader, preview, existingIds });
    if (savedId === null) {
      error.message = existingIds
        ? `Could not create the replacement RO entry; the original entry ${preview.logworkId} is unchanged. ${error.message}`
        : `Could not create the replacement RO entry (${error.message}). The original entry ${preview.logworkId} is unchanged, but check ${preview.updated.date} (get_logwork or \`logwork query\`) in case RO saved a copy.`;
      error.applyLedger = await recordEditLedger({
        writer: ledgerWriter, preview, status: 'failed', entryStatus: 'failed', error: error.message, cwd
      });
      throw error;
    }
    createResult = { entry: { id: savedId } };
  }

  if (createResult?.dryRun) {
    const deleteResult = await deleter(preview.logworkId);
    const output = {
      previewId: preview.previewId,
      status: 'dry_run',
      dryRun: true,
      strategy: 'replace',
      changes: preview.changes,
      original: preview.original,
      updated: preview.updated,
      requests: [
        { method: createResult.method, path: createResult.path, body: createResult.body },
        { method: deleteResult?.method || 'DELETE', path: deleteResult?.path || `/logwork/entries/${preview.logworkId}` }
      ],
      summary: `Dry run: RO logwork ${preview.logworkId} was not changed. Apply would create the corrected entry, then delete entry ${preview.logworkId}.`
    };
    output.ledger = await recordEditLedger({
      writer: ledgerWriter, preview, status: 'dry_run', entryStatus: 'submitted', dryRun: true, cwd
    });
    return output;
  }

  let newLogworkId = createResult?.entry?.id ?? null;
  if (newLogworkId === null || newLogworkId === undefined) {
    newLogworkId = await findCreatedEntryId({ dayReader, preview, existingIds });
  }
  if (newLogworkId === null || newLogworkId === undefined) {
    const error = new Error(
      `RO accepted the replacement entry but did not return its id, so the original entry ${preview.logworkId} was NOT deleted. ` +
      `Check the entries for ${preview.updated.date} (get_logwork or \`logwork query\`) and delete the duplicate (delete_entry or \`logwork delete\`).`
    );
    error.applyLedger = await recordEditLedger({
      writer: ledgerWriter, preview, status: 'partial', entryStatus: 'failed', error: error.message, cwd
    });
    throw error;
  }

  try {
    await deleter(preview.logworkId);
  } catch (error) {
    // A failed DELETE may still have deleted the original (timeout). Roll the
    // replacement back only when the original is confirmed to still exist;
    // otherwise rolling back could leave neither entry.
    const originalState = await originalEntryState({ dayReader, preview });
    if (originalState === 'gone') {
      return finishReplace({ reader, preview, newLogworkId, ledgerWriter, cwd });
    }
    if (originalState === 'unknown') {
      const message = `Deleting the original RO entry ${preview.logworkId} failed (${error.message}) and its state could not be read. ` +
        `The replacement entry ${newLogworkId} was kept. Check ${preview.original?.date || preview.updated.date} (get_logwork or \`logwork query\`); if both entries exist, delete ${preview.logworkId}.`;
      const wrapped = new Error(message);
      wrapped.cause = error;
      wrapped.newLogworkId = newLogworkId;
      wrapped.rolledBack = false;
      wrapped.applyLedger = await recordEditLedger({
        writer: ledgerWriter, preview, status: 'partial', entryStatus: 'failed', error: message, newLogworkId, cwd
      });
      throw wrapped;
    }
    const rollback = await rollbackCreatedEntry({ deleter, newLogworkId });
    const message = rollback.ok
      ? `Could not delete the original RO entry ${preview.logworkId} (${error.message}). The replacement entry ${newLogworkId} was rolled back; nothing changed.`
      : `Could not delete the original RO entry ${preview.logworkId} (${error.message}), and rolling back the replacement entry ${newLogworkId} also failed (${rollback.error}). ` +
        `Both entries now exist; delete one (delete_entry or \`logwork delete\`).`;
    const wrapped = new Error(message);
    wrapped.cause = error;
    wrapped.newLogworkId = newLogworkId;
    wrapped.rolledBack = rollback.ok;
    wrapped.applyLedger = await recordEditLedger({
      writer: ledgerWriter,
      preview,
      status: rollback.ok ? 'failed' : 'partial',
      entryStatus: 'failed',
      error: message,
      newLogworkId,
      cwd
    });
    throw wrapped;
  }

  return finishReplace({ reader, preview, newLogworkId, ledgerWriter, cwd });
}

async function finishReplace({ reader, preview, newLogworkId, ledgerWriter, cwd }) {
  let verified;
  try {
    verified = sanitizeLogwork(await reader(newLogworkId));
    assertAppliedValues(verified, preview.updated);
  } catch (error) {
    const verificationError = new Error(
      `RO replaced entry ${preview.logworkId} with entry ${newLogworkId}, but verification failed: ${error.message}`
    );
    verificationError.cause = error;
    verificationError.newLogworkId = newLogworkId;
    verificationError.applyLedger = await recordEditLedger({
      writer: ledgerWriter,
      preview,
      status: 'verification_failed',
      entryStatus: 'failed',
      error: verificationError.message,
      newLogworkId,
      cwd
    });
    throw verificationError;
  }

  const output = {
    previewId: preview.previewId,
    status: 'replaced',
    dryRun: false,
    strategy: 'replace',
    originalLogworkId: preview.logworkId,
    newLogworkId,
    changes: preview.changes,
    original: preview.original,
    updated: verified,
    summary: formatRoEditApplySummary(preview, verified)
  };
  output.ledger = await recordEditLedger({
    writer: ledgerWriter, preview, status: 'replaced', entryStatus: 'submitted', newLogworkId, cwd
  });
  return output;
}

export function createRoEditPreviewFingerprint(preview = {}) {
  return JSON.stringify({
    previewId: textOrNull(preview.previewId),
    status: textOrNull(preview.status),
    strategy: textOrNull(preview.strategy),
    logworkId: idOrNull(preview.logworkId),
    original: logworkFingerprint(preview.original),
    updated: logworkFingerprint(preview.updated),
    changes: {
      hours: changeFingerprint(preview.changes?.hours),
      taskName: changeFingerprint(preview.changes?.taskName),
      typeOfWork: changeFingerprint(preview.changes?.typeOfWork),
      description: changeFingerprint(preview.changes?.description)
    },
    originalFingerprint: textOrNull(preview.originalFingerprint)
  });
}

export function formatRoEditPreviewSummary(preview) {
  const { original, changes } = preview;
  const lines = [
    `RO logwork edit ${preview.previewId} is ready.`,
    `- Logwork: ${preview.logworkId} (${original.status || 'unknown status'})`,
    `- Project: ${original.projectName || original.projectId} (unchanged)`,
    `- Date: ${original.date} (unchanged)`,
    `- Hours: ${formatChange(changes.hours, original.hours)}`,
    `- Worklog task: ${formatChange(changes.taskName, original.taskName)}`,
    `- Type of work: ${formatChange(changes.typeOfWork, original.typeOfWork)}`,
    `- Description: ${formatChange(changes.description, original.description || '(empty)', true)}`,
    `Apply replaces the entry: it creates a new RO entry with these values, then deletes entry ${preview.logworkId}. ` +
      'Deleting needs no approval, and the new entry is approved immediately; it gets a new id.'
  ];
  for (const warning of preview.warnings || []) {
    lines.push(`Warning: ${warning}`);
  }
  return lines.join('\n');
}

function normalizeRequestedChanges({ hours, taskName, description, typeOfWork }) {
  if (hours === undefined && taskName === undefined && description === undefined && typeOfWork === undefined) {
    throw new Error('Provide hours, taskName, description, and/or typeOfWork for the RO logwork edit.');
  }

  let normalizedHours;
  if (hours !== undefined) {
    normalizedHours = Number(hours);
    if (!Number.isFinite(normalizedHours) || normalizedHours <= 0) {
      throw new Error('hours must be a positive number.');
    }
    normalizedHours = Number(normalizedHours.toFixed(2));
    if (normalizedHours <= 0) {
      throw new Error('hours must be at least 0.01 after rounding.');
    }
    if (normalizedHours > 24) {
      throw new Error('hours cannot exceed 24 per entry.');
    }
  }

  let normalizedTaskName;
  if (taskName !== undefined) {
    normalizedTaskName = String(taskName).trim();
    if (!normalizedTaskName) {
      throw new Error('taskName must not be empty.');
    }
    if (normalizedTaskName.length > 1_000) {
      throw new Error('taskName must not exceed 1000 characters.');
    }
  }

  let normalizedDescription;
  if (description !== undefined) {
    normalizedDescription = String(description).trim();
    if (!normalizedDescription) {
      throw new Error('description must not be empty.');
    }
    if (normalizedDescription.length > MAX_DESCRIPTION_LENGTH) {
      throw new Error(`description must not exceed ${MAX_DESCRIPTION_LENGTH} characters.`);
    }
  }

  let normalizedTypeOfWork;
  if (typeOfWork !== undefined) {
    normalizedTypeOfWork = String(typeOfWork).trim();
    if (!TYPE_OF_WORK.has(normalizedTypeOfWork)) {
      throw new Error(`typeOfWork must be one of: ${[...TYPE_OF_WORK].join(', ')}.`);
    }
  }

  return {
    hours: normalizedHours,
    taskName: normalizedTaskName,
    description: normalizedDescription,
    typeOfWork: normalizedTypeOfWork
  };
}

function resolveCurrentTask(original, tasks) {
  const match = tasks.find((task) => String(task?.id) === String(original.worklogTaskId));
  if (!match) {
    throw new Error(
      `The current worklog task ${original.worklogTaskId ?? '(none)'} of RO logwork ${original.id} is not in the project's task catalog. ` +
      'Pass taskName with a task from list_tasks.'
    );
  }
  return resolveWorklogTask({ taskName: `#${match.id}`, projectId: original.projectId, tasks });
}

function assertEditableLogwork(logwork) {
  const entry = sanitizeLogwork(logwork);
  if (!entry.id || !entry.date || entry.hours <= 0) {
    throw new Error('Resource Optimiser returned an incomplete logwork entry; edit is blocked.');
  }
  if (!entry.projectId) {
    throw new Error(`Could not find the project of RO logwork ${entry.id}; edit is blocked.`);
  }
  if (
    logwork?.currentUserId !== undefined &&
    logwork?.createdBy !== undefined &&
    String(logwork.currentUserId) !== String(logwork.createdBy)
  ) {
    throw new Error('Editing another user\'s RO logwork is not supported.');
  }
  if (
    logwork?.jiraLogworkId !== null &&
    logwork?.jiraLogworkId !== undefined &&
    String(logwork.jiraLogworkId).trim() !== ''
  ) {
    throw new Error('This RO logwork was created by Jira and must be edited in Jira.');
  }
  if (String(logwork?.source || '').toLowerCase() === 'jira') {
    throw new Error('This RO logwork was created by Jira and must be edited in Jira.');
  }
  if (logwork?.dayLocked) {
    throw new Error(`Logwork for ${entry.date} is locked on Resource Optimiser and cannot be edited.`);
  }
  const status = entry.status.toLowerCase();
  if (status === 'rejected') {
    throw new Error('Rejected entries cannot be edited by replace. Use resubmit_entry to fix hours, type of work, or description.');
  }
  if (!EDITABLE_STATUSES.has(status)) {
    throw new Error(`Only submitted or approved RO logwork entries can be edited (status: ${status || 'unknown'}).`);
  }
}

function assertReadyPreview(preview) {
  if (!preview || preview.status !== 'ready' || !preview.previewId || !preview.originalFingerprint) {
    throw new Error('A valid edit preview is required (edit_entry without confirm).');
  }
  if (!preview.updated || !preview.original || !preview.logworkId || !preview.updated.worklogTaskId) {
    throw new Error('RO logwork edit preview is incomplete. Preview the edit again.');
  }
}

function assertAppliedValues(actual, expected) {
  const mismatches = [];
  if (actual.date !== expected.date) mismatches.push('date');
  if (Number(actual.hours) !== Number(expected.hours)) mismatches.push('hours');
  if (String(actual.worklogTaskId) !== String(expected.worklogTaskId)) mismatches.push('worklog task');
  if (String(actual.projectId) !== String(expected.projectId)) mismatches.push('project');
  if ((actual.description || '') !== (expected.description || '')) mismatches.push('description');
  if (actual.typeOfWork && actual.typeOfWork !== expected.typeOfWork) mismatches.push('type of work');
  if (mismatches.length) {
    throw new Error(`the new RO entry does not match the approved preview (${mismatches.join(', ')})`);
  }
}

function buildWarnings(original, updated) {
  const warnings = [];
  if (!updated.description) {
    warnings.push('The entry has no description. Pass description to add one.');
  }
  return warnings;
}

function sanitizeLogwork(logwork = {}) {
  return {
    id: logwork.id ?? null,
    projectMemberId: logwork.projectMemberId ?? null,
    projectId: logwork.projectId ?? null,
    projectName: String(logwork.projectName || ''),
    date: String(logwork.date || ''),
    hours: Number(logwork.hours || 0),
    worklogTaskId: logwork.worklogTaskId ?? null,
    taskName: String(logwork.taskName || ''),
    typeOfWork: String(logwork.typeOfWork || ''),
    description: String(logwork.description || ''),
    status: String(logwork.status || ''),
    source: String(logwork.source || ''),
    isLocked: Boolean(logwork.isLocked)
  };
}

function buildChanges(original, updated) {
  const diff = (from, to) => (from === to ? null : { from, to });
  return {
    hours: Number(original.hours) === Number(updated.hours)
      ? null
      : { from: original.hours, to: updated.hours },
    taskName: String(original.worklogTaskId) === String(updated.worklogTaskId)
      ? null
      : { from: original.taskName, to: updated.taskName },
    typeOfWork: diff(original.typeOfWork, updated.typeOfWork),
    description: diff(original.description, updated.description)
  };
}

function createLogworkRevisionFingerprint(logwork = {}) {
  return JSON.stringify({
    ...logworkFingerprint(sanitizeLogwork(logwork)),
    updatedDate: textOrNull(logwork.updatedDate),
    jiraLogworkId: idOrNull(logwork.jiraLogworkId),
    dayLocked: Boolean(logwork.dayLocked)
  });
}

function createPreviewId({ originalFingerprint, updated }) {
  return `ro_edit_${hash(JSON.stringify({ originalFingerprint, updated: logworkFingerprint(updated) }))}`;
}

function logworkFingerprint(logwork) {
  if (!logwork || typeof logwork !== 'object') {
    return null;
  }
  return {
    id: idOrNull(logwork.id),
    projectMemberId: idOrNull(logwork.projectMemberId),
    projectId: idOrNull(logwork.projectId),
    projectName: textOrNull(logwork.projectName),
    date: textOrNull(logwork.date),
    hours: numberOrNull(logwork.hours),
    worklogTaskId: idOrNull(logwork.worklogTaskId),
    taskName: textOrNull(logwork.taskName),
    needsProjectId: logwork.needsProjectId === undefined ? null : Boolean(logwork.needsProjectId),
    typeOfWork: textOrNull(logwork.typeOfWork),
    description: textOrNull(logwork.description),
    status: textOrNull(logwork.status),
    source: textOrNull(logwork.source)
  };
}

function changeFingerprint(change) {
  if (!change || typeof change !== 'object') {
    return null;
  }
  return {
    from: change.from ?? null,
    to: change.to ?? null
  };
}

async function readDayEntryIds(dayReader, date) {
  if (!dayReader) {
    return null;
  }
  try {
    return new Set((await dayReader(date) || []).map((entry) => String(entry.id)));
  } catch {
    return null;
  }
}

async function originalEntryState({ dayReader, preview }) {
  const ids = await readDayEntryIds(dayReader, preview.original?.date || preview.updated.date);
  if (!ids) {
    return 'unknown';
  }
  return ids.has(String(preview.logworkId)) ? 'present' : 'gone';
}

async function findCreatedEntryId({ dayReader, preview, existingIds = null }) {
  if (!dayReader) {
    return null;
  }
  try {
    const entries = await dayReader(preview.updated.date);
    const candidates = (entries || []).filter((entry) => (
      String(entry.id) !== String(preview.logworkId) &&
      (!existingIds || !existingIds.has(String(entry.id))) &&
      String(entry.worklogTaskId) === String(preview.updated.worklogTaskId) &&
      Number(entry.hours) === Number(preview.updated.hours) &&
      (entry.description || '') === (preview.updated.description || '') &&
      (!preview.updated.projectMemberId || String(entry.projectMemberId) === String(preview.updated.projectMemberId))
    ));
    if (!candidates.length) {
      return null;
    }
    return candidates
      .map((entry) => entry.id)
      .sort((a, b) => Number(b) - Number(a))[0];
  } catch {
    return null;
  }
}

async function rollbackCreatedEntry({ deleter, newLogworkId }) {
  try {
    await deleter(newLogworkId);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function createDayEntriesReader() {
  const session = createResourceOptimiserSession();
  return (date) => withRoSessionRetry(session, async ({ token }) => (await getLogworkDay(token, { date })).entries || []);
}

function createWorklogTaskReader() {
  const session = createResourceOptimiserSession();
  return (projectId) => withRoSessionRetry(session, ({ token }) => fetchWorklogTasksForProject(token, projectId));
}

function createEntryWriter() {
  const session = createResourceOptimiserSession();
  return (request) => withRoSessionRetry(session, ({ token }) => createLogworkEntry(token, request));
}

function createDeleteWriter() {
  const session = createResourceOptimiserSession();
  return (logworkId) => withRoSessionRetry(session, ({ token }) => deleteLogworkEntry(token, logworkId));
}

async function withRoSessionRetry(session, action) {
  const current = await session.get();
  try {
    return await action(current);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) {
      throw error;
    }
    return action(await session.get({ forceLogin: true }));
  }
}

async function recordEditLedger({
  writer,
  preview,
  status,
  entryStatus,
  error = '',
  dryRun = false,
  newLogworkId = null,
  cwd
}) {
  const replaced = newLogworkId === null ? '' : ` with ${newLogworkId}`;
  return recordApplyResultSafely(writer, {
    target: 'ro',
    flowTarget: 'ro',
    batchId: preview.previewId,
    status,
    cwd,
    summary: `Replaced RO logwork ${preview.logworkId}${replaced}.`,
    entries: [
      {
        entryId: newLogworkId ?? preview.logworkId,
        date: preview.updated.date,
        hours: preview.updated.hours,
        taskName: preview.updated.taskName,
        description: preview.updated.description,
        projectName: preview.updated.projectName,
        status: entryStatus,
        error,
        dryRun
      }
    ]
  });
}

function formatRoEditApplySummary(preview, verified) {
  const changed = [
    preview.changes.hours ? `hours ${preview.changes.hours.from} -> ${preview.changes.hours.to}` : '',
    preview.changes.taskName ? `task ${preview.changes.taskName.from} -> ${preview.changes.taskName.to}` : '',
    preview.changes.typeOfWork ? `type ${preview.changes.typeOfWork.from || '(none)'} -> ${preview.changes.typeOfWork.to}` : '',
    preview.changes.description ? 'description updated' : ''
  ].filter(Boolean).join(', ');
  return `Replaced RO logwork ${preview.logworkId} with new entry ${verified.id}: ${changed}. Project and date were unchanged.`;
}

function formatChange(change, current, quote = false) {
  const show = (value) => (quote ? `"${value || ''}"` : `${value}`);
  if (!change) {
    return `${quote && current === '(empty)' ? current : show(current)} (unchanged)`;
  }
  return `${show(change.from)} -> ${show(change.to)}`;
}


function assertIdentifier(value, name) {
  const normalized = String(value ?? '').trim();
  if (!normalized || !/^[A-Za-z0-9_-]+$/.test(normalized)) {
    throw new Error(`${name} must be a valid Resource Optimiser identifier.`);
  }
  return normalized;
}

function textOrNull(value) {
  return value === undefined || value === null ? null : String(value);
}

function idOrNull(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  return typeof value === 'number' ? value : String(value);
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function hash(value) {
  let hashValue = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hashValue ^= value.charCodeAt(index);
    hashValue = Math.imul(hashValue, 16777619);
  }
  return (hashValue >>> 0).toString(16);
}
