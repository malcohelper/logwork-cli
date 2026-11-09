// Worklog task catalog: project tasks plus shared default tasks.
import { CONFIG } from './config.mjs';
import { apiFetch } from './ro-api-http.mjs';
import { unwrapRecords } from './ro-api-fields.mjs';
import {
  mergeWorklogTaskLists,
  normalizeWorklogTask
} from './worklog-task-resolver.mjs';

export async function getWorklogTasks(token, { projectId, search } = {}, options = {}) {
  const path = `${CONFIG.logworkTasksPath}${buildLogworkTasksQuery({ projectId, search })}`;
  const data = await apiFetch(token, path, options);
  return unwrapRecords(data).map(normalizeWorklogTask);
}

export async function getDefaultWorklogTasks(token, { projectId, search } = {}, options = {}) {
  const path = `${CONFIG.logworkDefaultTasksPath}${buildLogworkTasksQuery({ projectId, search })}`;
  const data = await apiFetch(token, path, options);
  return unwrapRecords(data).map(normalizeWorklogTask);
}

export async function fetchWorklogTasksForProject(token, projectId, options = {}) {
  const cacheKey = Number(projectId);
  const { cache, ...apiOptions } = options;
  if (cache instanceof Map && cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  const [projectTasks, defaultTasks] = await Promise.all([
    getWorklogTasks(token, { projectId: cacheKey }, apiOptions),
    getDefaultWorklogTasks(token, { projectId: cacheKey }, apiOptions)
  ]);
  const merged = mergeWorklogTaskLists(projectTasks, defaultTasks);
  if (cache instanceof Map) {
    cache.set(cacheKey, merged);
  }
  return merged;
}

function buildLogworkTasksQuery({ projectId, search }) {
  const qs = new URLSearchParams();
  if (projectId !== undefined && projectId !== null && projectId !== '') {
    qs.set('project_id', String(projectId));
  }
  if (search) {
    qs.set('search', String(search));
  }
  const query = qs.toString();
  return query ? `?${query}` : '';
}
