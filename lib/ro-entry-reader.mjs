import { ApiError, getLogtimeById, getLogworkDay, getProjects } from './api.mjs';
import { createResourceOptimiserSession } from './query-workflow.mjs';

// Reads one existing RO entry with the fields edit, resubmit and delete need. The legacy
// GET /member-logtime/:id gives the date, owner and Jira link; /logwork/day
// gives the F03 fields (status, worklog task, type of work, description); the
// project-member list maps project_member_id to project_id.
export function createF03LogworkReader() {
  const session = createResourceOptimiserSession();
  let projectsPromise = null;
  return async (logworkId) => withRoSessionRetry(session, async ({ token, userId }) => {
    const legacy = await getLogtimeById(token, logworkId);
    if (!legacy.date) {
      throw new Error(`Resource Optimiser did not return a date for logwork ${logworkId}.`);
    }
    const day = await getLogworkDay(token, { date: legacy.date });
    const f03 = (day.entries || []).find((entry) => String(entry.id) === String(legacy.id));
    if (!f03) {
      throw new Error(`RO logwork ${logworkId} was not found on ${legacy.date}; it may have been deleted.`);
    }
    // Cache only a successful load: a cached rejection (say a 401) would make
    // the retry after a forced login fail the same way.
    projectsPromise ||= getProjects(token, userId).catch((error) => {
      projectsPromise = null;
      throw error;
    });
    const projects = await projectsPromise;
    const projectMemberId = f03.projectMemberId ?? legacy.projectMemberId;
    const project = projects.find((item) => String(item.projectMemberId) === String(projectMemberId));
    return {
      ...legacy,
      ...withoutEmpty(f03),
      id: legacy.id,
      date: legacy.date,
      projectMemberId,
      projectId: f03.projectId ?? legacy.projectId ?? project?.projectId ?? null,
      projectName: f03.projectName || legacy.projectName || project?.projectName || '',
      createdBy: legacy.createdBy ?? f03.createdBy,
      dayLocked: Boolean(day.isLocked),
      currentUserId: userId
    };
  });
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

function withoutEmpty(record = {}) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => (
    value !== undefined && value !== null && value !== ''
  )));
}

// Guards shared by delete and resubmit (edit has its own, stricter set): the
// entry must be the user's own, not synced from Jira, and on an unlocked day.
export function assertOwnUnlockedRoEntry(logwork, action) {
  if (
    logwork?.currentUserId !== undefined &&
    logwork?.createdBy !== undefined &&
    String(logwork.currentUserId) !== String(logwork.createdBy)
  ) {
    throw new Error(`Cannot ${action} another user's RO logwork.`);
  }
  const jiraId = logwork?.jiraLogworkId;
  if ((jiraId !== null && jiraId !== undefined && String(jiraId).trim() !== '') || String(logwork?.source || '').toLowerCase() === 'jira') {
    throw new Error(`This RO logwork was created by Jira; ${action} it in Jira so both systems stay in step.`);
  }
  if (logwork?.dayLocked) {
    throw new Error(`Logwork for ${logwork.date || 'this day'} is locked on Resource Optimiser; cannot ${action} it.`);
  }
}

// What a preview was approved against; apply refuses if any of it changed.
export function createRoEntryRevisionFingerprint(logwork) {
  return JSON.stringify({
    id: logwork.id,
    date: logwork.date ?? null,
    hours: logwork.hours,
    status: logwork.status,
    taskName: logwork.taskName,
    worklogTaskId: logwork.worklogTaskId ?? null,
    typeOfWork: logwork.typeOfWork ?? null,
    description: logwork.description ?? null
  });
}
