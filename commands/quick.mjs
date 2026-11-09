import { intro } from '@clack/prompts';
import { CONFIG } from '../lib/config.mjs';
import { getFreshToken, getUserIdFromJwt } from '../lib/auth.mjs';
import {
  addLogtime,
  ApiError,
  fetchWorklogTasksForProject,
  getTodayTimesheetProjects
} from '../lib/api.mjs';
import * as ui from '../lib/ui.mjs';
import { todayLocalDateISO } from '../lib/util.mjs';

const QUICK_API = { addLogtime, fetchWorklogTasksForProject, getTodayTimesheetProjects };

// `logwork quick [-m "what you did"]`: log one Resource Optimiser entry for
// today with guided prompts (project -> worklog task -> description -> hours).
// The second argument of run and the options of runQuickLog are test seams;
// the CLI uses the defaults.
export async function run(argv = [], {
  quickLog = runQuickLog,
  quickUi = ui,
  showIntro = intro,
  print = console.log
} = {}) {
  const { message, help } = parseQuickArgs(argv);
  if (help) {
    print(formatQuickHelp());
    return 0;
  }

  try {
    showIntro('Logwork quick');
    const result = await quickLog({ message });
    quickUi.showSuccess(result.dryRun
      ? 'DRY RUN: payload generated; no API write performed.'
      : 'Logwork submitted.');
    return 0;
  } catch (error) {
    quickUi.showError(error);
    return 1;
  }
}

export async function runQuickLog({
  message = '',
  quickUi = ui,
  openSession: open = openSession,
  api = QUICK_API,
  today = todayLocalDateISO
} = {}) {
  const localDateISO = today();
  let session = await open();

  let projects;
  try {
    projects = await loadBookedProjects(session, localDateISO, api);
  } catch (error) {
    if (!isUnauthorized(error)) {
      throw error;
    }
    session = await open({ forceLogin: true });
    projects = await loadBookedProjects(session, localDateISO, api);
  }

  const daySummaries = projects.map((project) => ({
    projectId: project.projectId,
    totalHours: project.loggedHours,
    ok: true
  }));
  const project = await quickUi.chooseProject(projects, daySummaries);
  const tasks = (await api.fetchWorklogTasksForProject(session.token, project.projectId)).map((task) => ({
    taskId: task.id,
    name: task.name,
    typeOfWork: task.typeOfWork || 'other',
    description: task.description,
    needsProjectId: task.projectId === null || task.projectId === undefined
  }));
  if (!tasks.length) {
    throw new Error(`No worklog tasks are available for ${project.projectName}.`);
  }
  const task = await quickUi.chooseTask(tasks);
  const description = await quickUi.chooseMessageSource(message);
  const hours = await quickUi.askHours(CONFIG.defaultHours);

  await quickUi.confirmSubmit({
    projectName: project.projectName,
    hours,
    taskName: task.name,
    description,
    localDateISO
  });

  const entry = {
    projectId: project.projectId,
    projectMemberId: project.projectMemberId,
    logtimes: hours,
    taskName: task.name,
    localDateISO,
    worklogTaskId: task.taskId,
    typeOfWork: task.typeOfWork,
    description,
    worklogNeedsProjectId: task.needsProjectId
  };

  try {
    return await api.addLogtime(session.token, entry);
  } catch (error) {
    if (!isUnauthorized(error)) {
      throw error;
    }
    session = await open({ forceLogin: true });
    return api.addLogtime(session.token, entry);
  }
}

export function parseQuickArgs(argv = []) {
  let message = '';
  let help = false;
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--message' || arg === '-m') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a value.`);
      }
      message = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--message=')) {
      message = arg.slice('--message='.length);
      continue;
    }
    positional.push(arg);
  }

  if (!message && positional.length) {
    message = positional.join(' ');
  }
  return { message, help };
}

export function formatQuickHelp() {
  return `Usage:
  logwork quick
  logwork quick -m "Fix login bug (SCB-12)"
  logwork quick "Fix login bug (SCB-12)"

Logs one Resource Optimiser entry for today. You pick a booked project, a worklog
task and the hours; the message becomes the entry description.

Options:
  -m, --message <text>  Description to prefill
  -h, --help            Show this help`;
}

async function openSession({ forceLogin = false } = {}) {
  const token = await getFreshToken({ forceLogin });
  return { token, userId: getUserIdFromJwt(token) };
}

async function loadBookedProjects(session, localDateISO, api) {
  const projects = await api.getTodayTimesheetProjects(session.token, session.userId, localDateISO);
  if (!projects.length) {
    throw new Error(`You have no booked project on ${localDateISO}.`);
  }
  return projects;
}

function isUnauthorized(error) {
  return error instanceof ApiError && error.status === 401;
}
