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
    projectsPromise ||= getProjects(token, userId);
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
