import { ApiError, getLogtimeById, resubmitLogworkEntry } from './api.mjs';
import { createResourceOptimiserSession } from './query-workflow.mjs';

export async function previewRoLogworkResubmit({
  logworkId,
  hours,
  typeOfWork,
  noteToPm,
  description,
  fetchLogwork
}) {
  const reader = fetchLogwork || createLogtimeReader();
  const current = await reader(assertIdentifier(logworkId, 'logworkId'));
  if (String(current.status || '').toLowerCase() !== 'rejected') {
    throw new Error('Only rejected RO logwork entries can be resubmitted through this flow.');
  }

  const effortHours = hours === undefined ? current.hours : Number(hours);
  if (!Number.isFinite(effortHours) || effortHours <= 0) {
    throw new Error('hours must be a positive number.');
  }

  const previewId = `resubmit_${current.id}_${effortHours}`;
  const preview = {
    previewId,
    status: 'ready',
    logworkId: current.id,
    original: current,
    updated: {
      hours: effortHours,
      typeOfWork: typeOfWork || current.typeOfWork || 'other',
      noteToPm: noteToPm ?? current.noteToPm ?? '',
      description: description ?? current.description ?? ''
    },
    originalFingerprint: createLogworkRevisionFingerprint(current)
  };
  preview.summary = [
    'RO logwork resubmit preview:',
    `- Entry: ${current.id}`,
    `- Hours: ${current.hours} -> ${effortHours}`,
    `- Status: rejected -> approved (after resubmit)`
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
    throw new Error('apply_ro_logwork_resubmit requires confirm: true.');
  }
  if (!preview || preview.status !== 'ready') {
    throw new Error('A valid preview from preview_ro_logwork_resubmit is required.');
  }

  const reader = fetchLogwork || createLogtimeReader();
  const writer = submitResubmit || createResubmitWriter();
  const current = await reader(preview.logworkId);
  if (createLogworkRevisionFingerprint(current) !== preview.originalFingerprint) {
    throw new Error('RO logwork changed after preview. Re-run preview_ro_logwork_resubmit before applying.');
  }

  const result = await writer({
    logworkId: preview.logworkId,
    effortHours: preview.updated.hours,
    typeOfWork: preview.updated.typeOfWork,
    noteToPm: preview.updated.noteToPm,
    description: preview.updated.description
  });

  return {
    status: 'resubmitted',
    logworkId: preview.logworkId,
    result,
    summary: `Resubmitted RO logwork ${preview.logworkId} with ${preview.updated.hours}h.`
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
  return JSON.stringify({
    id: logwork.id,
    hours: logwork.hours,
    status: logwork.status,
    taskName: logwork.taskName
  });
}
