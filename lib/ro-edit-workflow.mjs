import {
  ApiError,
  getLogtimeById,
  updateLogtime
} from './api.mjs';
import { recordApplyResult, recordApplyResultSafely } from './apply-ledger.mjs';
import { createResourceOptimiserSession } from './query-workflow.mjs';

export async function previewRoLogworkEdit({
  logworkId,
  hours,
  taskName,
  fetchLogwork
}) {
  const requested = normalizeRequestedChanges({ hours, taskName });
  const reader = fetchLogwork || createLogtimeReader();
  const current = await reader(assertIdentifier(logworkId, 'logworkId'));
  assertEditableLogwork(current);

  const original = sanitizeLogwork(current);
  const updated = {
    ...original,
    hours: requested.hours ?? original.hours,
    taskName: requested.taskName ?? original.taskName
  };
  if (!updated.taskName) {
    throw new Error('taskName must be provided because the existing RO logwork task name is empty.');
  }
  const changes = buildChanges(original, updated);
  if (!changes.hours && !changes.taskName) {
    throw new Error('The requested RO logwork edit does not change hours or taskName.');
  }

  const originalFingerprint = createLogworkRevisionFingerprint(current);
  const previewId = createPreviewId({ originalFingerprint, updated });
  const preview = {
    previewId,
    status: 'ready',
    logworkId: original.id,
    original,
    updated,
    changes,
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
  submitUpdate,
  recordLedger
}) {
  if (confirm !== true) {
    throw new Error('apply_ro_logwork_edit requires confirm: true.');
  }
  assertReadyPreview(preview);

  const reader = fetchLogwork || createLogtimeReader();
  const writer = submitUpdate || createLogtimeUpdater();
  const ledgerWriter = recordLedger === undefined
    ? (!fetchLogwork && !submitUpdate ? recordApplyResult : null)
    : recordLedger;
  const current = await reader(preview.logworkId);
  assertEditableLogwork(current);
  if (createLogworkRevisionFingerprint(current) !== preview.originalFingerprint) {
    throw new Error('RO logwork changed after preview. Re-run preview_ro_logwork_edit before applying.');
  }

  let writeResult;
  try {
    writeResult = await writer({
      id: current.id,
      projectMemberId: current.projectMemberId,
      logtimes: preview.updated.hours,
      taskName: preview.updated.taskName,
      localDateISO: current.date
    });
  } catch (error) {
    error.applyLedger = await recordEditLedger({
      writer: ledgerWriter,
      preview,
      status: 'failed',
      entryStatus: 'failed',
      error: error.message,
      cwd
    });
    throw error;
  }

  if (writeResult?.dryRun) {
    const output = {
      previewId: preview.previewId,
      status: 'dry_run',
      dryRun: true,
      changes: preview.changes,
      original: preview.original,
      updated: preview.updated,
      request: {
        method: writeResult.method,
        path: writeResult.path,
        body: writeResult.body
      },
      summary: `Dry run: RO logwork ${preview.logworkId} was not changed.`
    };
    output.ledger = await recordEditLedger({
      writer: ledgerWriter,
      preview,
      status: 'dry_run',
      entryStatus: 'submitted',
      dryRun: true,
      cwd
    });
    return output;
  }

  let verified;
  try {
    verified = sanitizeLogwork(await reader(preview.logworkId));
    assertAppliedValues(verified, preview.updated);
  } catch (error) {
    const verificationError = new Error(`RO accepted the edit request, but verification failed: ${error.message}`);
    verificationError.cause = error;
    verificationError.applyLedger = await recordEditLedger({
      writer: ledgerWriter,
      preview,
      status: 'verification_failed',
      entryStatus: 'failed',
      error: verificationError.message,
      cwd
    });
    throw verificationError;
  }

  const output = {
    previewId: preview.previewId,
    status: 'updated',
    dryRun: false,
    changes: preview.changes,
    original: preview.original,
    updated: verified,
    summary: formatRoEditApplySummary(preview, verified)
  };
  output.ledger = await recordEditLedger({
    writer: ledgerWriter,
    preview,
    status: 'updated',
    entryStatus: 'submitted',
    cwd
  });
  return output;
}

export function createRoEditPreviewFingerprint(preview = {}) {
  return JSON.stringify({
    previewId: textOrNull(preview.previewId),
    status: textOrNull(preview.status),
    logworkId: idOrNull(preview.logworkId),
    original: logworkFingerprint(preview.original),
    updated: logworkFingerprint(preview.updated),
    changes: {
      hours: changeFingerprint(preview.changes?.hours),
      taskName: changeFingerprint(preview.changes?.taskName)
    },
    originalFingerprint: textOrNull(preview.originalFingerprint)
  });
}

export function formatRoEditPreviewSummary(preview) {
  return [
    `RO logwork edit ${preview.previewId} is ready.`,
    `- Logwork: ${preview.logworkId}`,
    `- Project: ${preview.original.projectName || preview.original.projectMemberId} (unchanged)`,
    `- Date: ${preview.original.date} (unchanged)`,
    `- Hours: ${formatChange(preview.changes.hours, preview.original.hours)}`,
    `- Task: ${formatChange(preview.changes.taskName, preview.original.taskName)}`
  ].join('\n');
}

function normalizeRequestedChanges({ hours, taskName }) {
  if (hours === undefined && taskName === undefined) {
    throw new Error('Provide hours and/or taskName for the RO logwork edit.');
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

  return {
    hours: normalizedHours,
    taskName: normalizedTaskName
  };
}

function assertEditableLogwork(logwork) {
  const entry = sanitizeLogwork(logwork);
  if (!entry.id || !entry.projectMemberId || !entry.date || entry.hours <= 0) {
    throw new Error('Resource Optimiser returned an incomplete logwork entry; edit is blocked.');
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
}

function assertReadyPreview(preview) {
  if (!preview || preview.status !== 'ready' || !preview.previewId || !preview.originalFingerprint) {
    throw new Error('A valid preview from preview_ro_logwork_edit is required.');
  }
  if (!preview.updated || !preview.original || !preview.logworkId) {
    throw new Error('RO logwork edit preview is incomplete. Re-run preview_ro_logwork_edit.');
  }
}

function assertAppliedValues(actual, expected) {
  if (
    String(actual.id) !== String(expected.id) ||
    String(actual.projectMemberId) !== String(expected.projectMemberId) ||
    actual.date !== expected.date ||
    Number(actual.hours) !== Number(expected.hours) ||
    actual.taskName !== expected.taskName
  ) {
    throw new Error('the persisted RO logwork does not match the approved preview');
  }
}

function sanitizeLogwork(logwork = {}) {
  return {
    id: logwork.id ?? null,
    projectMemberId: logwork.projectMemberId ?? null,
    projectId: logwork.projectId ?? null,
    projectName: String(logwork.projectName || ''),
    date: String(logwork.date || ''),
    hours: Number(logwork.hours || 0),
    taskName: String(logwork.taskName || ''),
    status: String(logwork.status || ''),
    source: String(logwork.source || '')
  };
}

function buildChanges(original, updated) {
  return {
    hours: Number(original.hours) === Number(updated.hours)
      ? null
      : { from: original.hours, to: updated.hours },
    taskName: original.taskName === updated.taskName
      ? null
      : { from: original.taskName, to: updated.taskName }
  };
}

function createLogworkRevisionFingerprint(logwork = {}) {
  return JSON.stringify({
    ...logworkFingerprint(sanitizeLogwork(logwork)),
    updatedDate: textOrNull(logwork.updatedDate),
    jiraLogworkId: idOrNull(logwork.jiraLogworkId),
    source: textOrNull(logwork.source)
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
    taskName: textOrNull(logwork.taskName),
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

function createLogtimeReader() {
  const session = createResourceOptimiserSession();
  return async (logworkId) => {
    const current = await withRoSessionRetry(session, ({ token }) => getLogtimeById(token, logworkId));
    const { userId } = await session.get();
    return {
      ...current,
      currentUserId: userId
    };
  };
}

function createLogtimeUpdater() {
  const session = createResourceOptimiserSession();
  return (entry) => withRoSessionRetry(session, ({ token }) => updateLogtime(token, entry));
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
  cwd
}) {
  return recordApplyResultSafely(writer, {
    target: 'ro',
    flowTarget: 'ro',
    batchId: preview.previewId,
    status,
    cwd,
    summary: `Updated RO logwork ${preview.logworkId}.`,
    entries: [
      {
        entryId: preview.logworkId,
        date: preview.updated.date,
        hours: preview.updated.hours,
        taskName: preview.updated.taskName,
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
    preview.changes.taskName ? 'task name updated' : ''
  ].filter(Boolean).join(', ');
  return `Updated RO logwork ${verified.id}: ${changed}. Project and date were unchanged.`;
}

function formatChange(change, current) {
  if (!change) {
    return `${current} (unchanged)`;
  }
  return `${change.from} -> ${change.to}`;
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
