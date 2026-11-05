const SUGGESTION_LIMIT = 5;
const TYPE_OF_WORK = new Set(['create', 'correct', 'improve', 'other']);

export function readCatalogTypeOfWork(task) {
  const value = String(task?.typeOfWork ?? task?.type_of_work ?? '').trim();
  return TYPE_OF_WORK.has(value) ? value : undefined;
}

export function resolveWorklogTask({ taskName, projectId, tasks = [] }) {
  const normalizedName = String(taskName || '').trim();
  if (!normalizedName) {
    throw new Error('taskName must not be empty.');
  }

  const projectIdNumber = Number(projectId);
  if (!Number.isFinite(projectIdNumber) || projectIdNumber <= 0) {
    throw new Error('projectId must be a positive number.');
  }

  const comparable = normalizedName.toLocaleLowerCase();
  const matches = tasks.filter((task) => {
    const name = String(task?.name || '').trim();
    return name && name.toLocaleLowerCase() === comparable;
  });

  if (matches.length > 1) {
    const ids = matches.map((task) => task.id).join(', ');
    throw new Error(
      `Ambiguous worklog task name "${normalizedName}" for project ${projectIdNumber} (ids: ${ids}).`
    );
  }

  if (!matches.length) {
    const suggestions = suggestTaskNames(tasks, normalizedName);
    const hint = suggestions.length
      ? ` Similar tasks: ${suggestions.map((name) => `"${name}"`).join(', ')}.`
      : ' No similar tasks found for this project.';
    throw new Error(
      `No worklog task named "${normalizedName}" for project ${projectIdNumber}.${hint}`
    );
  }

  const task = matches[0];
  const taskProjectId = readTaskProjectId(task);
  const catalogTypeOfWork = readCatalogTypeOfWork(task);
  return {
    worklogTaskId: task.id,
    taskName: String(task.name || '').trim(),
    needsProjectId: taskProjectId === null || taskProjectId === undefined,
    ...(catalogTypeOfWork ? { typeOfWork: catalogTypeOfWork } : {})
  };
}

export function mergeWorklogTaskLists(projectTasks = [], defaultTasks = []) {
  const byId = new Map();
  for (const task of [...projectTasks, ...defaultTasks]) {
    if (task?.id !== undefined && task?.id !== null && !byId.has(task.id)) {
      byId.set(task.id, task);
    }
  }
  return [...byId.values()];
}

export function normalizeWorklogTask(record = {}) {
  const projectId = readTaskProjectId(record);
  return {
    id: record.id,
    name: String(record.name || '').trim(),
    projectId: projectId === undefined ? null : projectId,
    typeOfWork: record.type_of_work ?? record.typeOfWork ?? null,
    isDefault: Boolean(record.is_default ?? record.isDefault)
  };
}

function readTaskProjectId(task) {
  if (task?.project_id !== undefined && task?.project_id !== null) {
    return Number(task.project_id);
  }
  if (task?.project?.id !== undefined && task?.project?.id !== null) {
    return Number(task.project.id);
  }
  if (task?.projectId !== undefined && task?.projectId !== null) {
    return Number(task.projectId);
  }
  return null;
}

export function listSuggestedTaskNames(tasks, taskName, limit = SUGGESTION_LIMIT) {
  return suggestTaskNames(tasks, taskName, limit);
}

function suggestTaskNames(tasks, taskName, limit = SUGGESTION_LIMIT) {
  const needle = String(taskName || '').trim().toLocaleLowerCase();
  if (!needle) {
    return [];
  }

  return tasks
    .map((task) => String(task?.name || '').trim())
    .filter((name) => name && name.toLocaleLowerCase().includes(needle))
    .slice(0, limit);
}
