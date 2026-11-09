import { ApiError, deleteLogworkEntry } from './api.mjs';
import { createResourceOptimiserSession } from './query-workflow.mjs';
import { assertOwnUnlockedRoEntry, createF03LogworkReader, createRoEntryRevisionFingerprint } from './ro-entry-reader.mjs';

const DELETABLE_STATUSES = new Set(['submitted', 'approved']);

export async function previewRoLogworkDelete({
  logworkId,
  fetchLogwork
}) {
  const reader = fetchLogwork || createF03LogworkReader();
  const current = await reader(assertIdentifier(logworkId, 'logworkId'));
  assertDeletableStatus(current);
  assertOwnUnlockedRoEntry(current, 'delete');

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
    throw new Error('Delete requires confirm: true.');
  }
  if (!preview || preview.status !== 'ready') {
    throw new Error('A valid delete preview is required (delete_entry without confirm).');
  }

  const reader = fetchLogwork || createF03LogworkReader();
  const writer = submitDelete || createDeleteWriter();
  const current = await reader(preview.logworkId);
  if (createLogworkRevisionFingerprint(current) !== preview.originalFingerprint) {
    throw new Error('RO logwork changed after preview. Preview the delete again before applying.');
  }
  assertDeletableStatus(current);

  const result = await writer(preview.logworkId);
  if (result?.dryRun) {
    return {
      status: 'dry_run',
      dryRun: true,
      logworkId: preview.logworkId,
      result,
      summary: `Dry run: RO logwork entry ${preview.logworkId} was not deleted.`
    };
  }
  return {
    status: 'deleted',
    logworkId: preview.logworkId,
    result,
    summary: `Deleted RO logwork entry ${preview.logworkId}.`
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
    throw new Error('Rejected entries cannot be deleted. Use resubmit_entry instead.');
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
  return createRoEntryRevisionFingerprint(logwork);
}
