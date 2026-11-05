import { ApiError, deleteLogworkEntry, getLogtimeById } from './api.mjs';
import { createResourceOptimiserSession } from './query-workflow.mjs';

const DELETABLE_STATUSES = new Set(['submitted', 'approved']);

export async function previewRoLogworkDelete({
  logworkId,
  fetchLogwork
}) {
  const reader = fetchLogwork || createLogtimeReader();
  const current = await reader(assertIdentifier(logworkId, 'logworkId'));
  assertDeletableStatus(current);

  const preview = {
    previewId: `delete_${current.id}`,
    status: 'ready',
    logworkId: current.id,
    original: current,
    originalFingerprint: createLogworkRevisionFingerprint(current)
  };
  preview.summary = [
    'RO logwork delete preview:',
    `- Entry: ${current.id}`,
    `- Date: ${current.date || '(unknown)'}`,
    `- Project: ${current.projectName || current.projectId || '(unknown)'}`,
    `- Task: ${current.taskName || '(no task name)'}`,
    `- Hours: ${current.hours}`,
    `- Status: ${current.status} (will be soft-deleted)`,
    'Only submitted or approved entries can be deleted on Resource Optimiser.'
  ].join('\n');
  return preview;
}

export async function applyRoLogworkDelete({
  preview,
  confirm,
  fetchLogwork,
  submitDelete
}) {
  if (confirm !== true) {
    throw new Error('apply_ro_logwork_delete requires confirm: true.');
  }
  if (!preview || preview.status !== 'ready') {
    throw new Error('A valid preview from preview_ro_logwork_delete is required.');
  }

  const reader = fetchLogwork || createLogtimeReader();
  const writer = submitDelete || createDeleteWriter();
  const current = await reader(preview.logworkId);
  if (createLogworkRevisionFingerprint(current) !== preview.originalFingerprint) {
    throw new Error('RO logwork changed after preview. Re-run preview_ro_logwork_delete before applying.');
  }
  assertDeletableStatus(current);

  const result = await writer(preview.logworkId);
  return {
    status: 'deleted',
    logworkId: preview.logworkId,
    result,
    summary: `Deleted RO logwork entry ${preview.logworkId}.`
  };
}

function createLogtimeReader() {
  const session = createResourceOptimiserSession();
  return async (logworkId) => {
    const { token } = await session.get();
    try {
      return await getLogtimeById(token, logworkId);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) {
        throw error;
      }
      const refreshed = await session.get({ forceLogin: true });
      return getLogtimeById(refreshed.token, logworkId);
    }
  };
}

function createDeleteWriter() {
  const session = createResourceOptimiserSession();
  return async (logworkId) => {
    const { token } = await session.get();
    try {
      return await deleteLogworkEntry(token, logworkId);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) {
        throw error;
      }
      const refreshed = await session.get({ forceLogin: true });
      return deleteLogworkEntry(refreshed.token, logworkId);
    }
  };
}

function assertDeletableStatus(logwork) {
  const status = String(logwork?.status || '').toLowerCase();
  if (status === 'rejected') {
    throw new Error('Rejected entries cannot be deleted. Use preview_ro_logwork_resubmit or edit instead.');
  }
  if (!DELETABLE_STATUSES.has(status)) {
    throw new Error(`Only submitted or approved RO logwork entries can be deleted (status: ${status || 'unknown'}).`);
  }
}

function assertIdentifier(value, label) {
  const text = String(value ?? '').trim();
  if (!text) {
    throw new Error(`${label} is required.`);
  }
  return text;
}

function createLogworkRevisionFingerprint(logwork) {
  return JSON.stringify({
    id: logwork.id,
    hours: logwork.hours,
    status: logwork.status,
    taskName: logwork.taskName
  });
}
