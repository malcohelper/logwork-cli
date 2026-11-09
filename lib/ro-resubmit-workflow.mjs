import { ApiError, resubmitLogworkEntry } from './api.mjs';
import { createResourceOptimiserSession } from './query-workflow.mjs';
import { assertOwnUnlockedRoEntry, createF03LogworkReader, createRoEntryRevisionFingerprint } from './ro-entry-reader.mjs';

export async function previewRoLogworkResubmit({
  logworkId,
  hours,
  typeOfWork,
  noteToPm,
  description,
  fetchLogwork
}) {
  const reader = fetchLogwork || createF03LogworkReader();
  const current = await reader(assertIdentifier(logworkId, 'logworkId'));
  if (String(current.status || '').toLowerCase() !== 'rejected') {
    throw new Error('Only rejected RO logwork entries can be resubmitted through this flow.');
  }
  assertOwnUnlockedRoEntry(current, 'resubmit');

  const effortHours = hours === undefined ? current.hours : Number(hours);
  if (!Number.isFinite(effortHours) || effortHours <= 0 || effortHours > 24) {
    throw new Error('hours must be a positive number up to 24.');
  }

  const updated = {
    hours: effortHours,
    typeOfWork: typeOfWork || current.typeOfWork || 'other',
    noteToPm: noteToPm ?? current.noteToPm ?? '',
    description: description ?? current.description ?? ''
  };
  const originalFingerprint = createLogworkRevisionFingerprint(current);
  // Every field that will be sent is part of the id, so two different
  // previews of the same entry never share (and overwrite) one cache slot.
  const previewId = `resubmit_${current.id}_${hash(JSON.stringify({ updated, originalFingerprint }))}`;
  const preview = {
    previewId,
    status: 'ready',
    logworkId: current.id,
    original: current,
    updated,
    originalFingerprint
  };
  const changeLine = (label, from, to) => (String(from ?? '') === String(to ?? '') ? `- ${label}: ${to || '(empty)'}` : `- ${label}: ${from || '(empty)'} -> ${to || '(empty)'}`);
  preview.summary = [
    'RO logwork resubmit preview:',
    `- Entry: ${current.id} (${current.date || 'unknown date'}, ${current.taskName || 'unknown task'})`,
    changeLine('Hours', current.hours, effortHours),
    changeLine('Type of work', current.typeOfWork, updated.typeOfWork),
    changeLine('Description', current.description, updated.description),
    `- Note to PM: ${updated.noteToPm || '(none)'}`,
    '- Status: rejected -> resubmitted'
  ].join('\n');
  return preview;
}

export async function applyRoLogworkResubmit({
  preview,
  confirm,
  fetchLogwork,
  submitResubmit
}) {
  if (confirm !== true) {
    throw new Error('Resubmit requires confirm: true.');
  }
  if (!preview || preview.status !== 'ready') {
    throw new Error('A valid resubmit preview is required (resubmit_entry without confirm).');
  }

  const reader = fetchLogwork || createF03LogworkReader();
  const writer = submitResubmit || createResubmitWriter();
  const current = await reader(preview.logworkId);
  if (createLogworkRevisionFingerprint(current) !== preview.originalFingerprint) {
    throw new Error('RO logwork changed after preview. Preview the resubmit again before applying.');
  }

  const result = await writer({
    logworkId: preview.logworkId,
    effortHours: preview.updated.hours,
    typeOfWork: preview.updated.typeOfWork,
    noteToPm: preview.updated.noteToPm,
    description: preview.updated.description
  });

  if (result?.dryRun) {
    return {
      status: 'dry_run',
      dryRun: true,
      logworkId: preview.logworkId,
      result,
      summary: `Dry run: RO logwork ${preview.logworkId} was not resubmitted.`
    };
  }

  return {
    status: 'resubmitted',
    logworkId: preview.logworkId,
    result,
    summary: `Resubmitted RO logwork ${preview.logworkId} with ${preview.updated.hours}h.`
  };
}

function createResubmitWriter() {
  const session = createResourceOptimiserSession();
  return async (payload) => {
    const { token } = await session.get();
    try {
      return await resubmitLogworkEntry(token, payload.logworkId, {
        effortHours: payload.effortHours,
        typeOfWork: payload.typeOfWork,
        noteToPm: payload.noteToPm,
        description: payload.description
      });
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) {
        throw error;
      }
      const refreshed = await session.get({ forceLogin: true });
      return resubmitLogworkEntry(refreshed.token, payload.logworkId, {
        effortHours: payload.effortHours,
        typeOfWork: payload.typeOfWork,
        noteToPm: payload.noteToPm,
        description: payload.description
      });
    }
  };
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

function hash(value) {
  let hashValue = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hashValue ^= value.charCodeAt(index);
    hashValue = Math.imul(hashValue, 16777619);
  }
  return (hashValue >>> 0).toString(36);
}
