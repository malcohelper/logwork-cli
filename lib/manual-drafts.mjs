import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { atomicWriteFile } from './atomic-file.mjs';
import { withFileLock } from './file-lock.mjs';
import { manualDraftsPath } from './paths.mjs';

export async function loadManualDrafts({ path = manualDraftsPath(), cwd } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    return [];
  }

  const drafts = Array.isArray(parsed) ? parsed : parsed?.drafts;
  if (!Array.isArray(drafts)) {
    return [];
  }

  const normalizedCwd = normalizeCwd(cwd);
  return drafts
    .map((draft) => sanitizeManualDraft(draft))
    .filter(Boolean)
    .filter((draft) => !normalizedCwd || normalizeCwd(draft.cwd) === normalizedCwd)
    .sort(sortNewestFirst);
}

export async function saveManualDraft(draft, {
  path = manualDraftsPath(),
  cwd = process.cwd(),
  lockOptions = {}
} = {}) {
  return withFileLock(path, async () => {
    const drafts = await loadManualDrafts({ path });
    const now = new Date().toISOString();
    const existing = draft.id ? drafts.find((candidate) => candidate.id === draft.id) : null;
    const sanitized = sanitizeManualDraft({
      ...draft,
      id: draft.id || createDraftId(),
      cwd: draft.cwd || cwd,
      createdAt: existing?.createdAt || draft.createdAt || now,
      updatedAt: now
    });

    if (!sanitized) {
      throw new Error('Cannot save empty manual draft.');
    }

    const nextDrafts = [
      sanitized,
      ...drafts.filter((candidate) => candidate.id !== sanitized.id)
    ].sort(sortNewestFirst);

    await writeDrafts(nextDrafts, path);
    return sanitized;
  }, lockOptions);
}

export async function deleteManualDraft(id, {
  path = manualDraftsPath(),
  lockOptions = {}
} = {}) {
  return withFileLock(path, async () => {
    const drafts = await loadManualDrafts({ path });
    const nextDrafts = drafts.filter((draft) => draft.id !== id);
    await writeDrafts(nextDrafts, path);
    return drafts.length !== nextDrafts.length;
  }, lockOptions);
}

export function sanitizeManualDraft(draft = {}) {
  if (!draft || typeof draft !== 'object') {
    return null;
  }

  const tasks = Array.isArray(draft.tasks)
    ? draft.tasks
      .map((task) => ({
        hours: Number(task.hours),
        taskName: String(task.taskName || '').trim(),
        line: task.line ? String(task.line) : undefined
      }))
      .filter((task) => Number.isFinite(task.hours) && task.hours > 0 && task.taskName)
    : [];

  const project = sanitizeProject(draft.project || draft.selectedProject);
  const date = String(draft.date || '').trim();
  if (!date || !project || !tasks.length) {
    return null;
  }

  return {
    id: String(draft.id || createDraftId()),
    createdAt: String(draft.createdAt || new Date().toISOString()),
    updatedAt: String(draft.updatedAt || draft.createdAt || new Date().toISOString()),
    cwd: String(draft.cwd || process.cwd()),
    date,
    project,
    tasks,
    latestPreviewStatus: draft.latestPreviewStatus ? String(draft.latestPreviewStatus) : undefined
  };
}

export function formatManualDraftLabel(draft) {
  const taskCount = draft.tasks?.length || 0;
  const updated = draft.updatedAt ? ` · updated ${draft.updatedAt.slice(0, 10)}` : '';
  return `${draft.date} · ${draft.project?.projectName || 'Unknown project'} · ${taskCount} task${taskCount === 1 ? '' : 's'}${updated}`;
}

async function writeDrafts(drafts, path) {
  await atomicWriteFile(path, `${JSON.stringify({ drafts }, null, 2)}\n`);
}

function sanitizeProject(project = {}) {
  const projectName = String(project.projectName || '').trim();
  const projectMemberId = normalizeOptionalId(project.projectMemberId);
  const projectId = normalizeOptionalId(project.projectId);
  if (!projectName && projectMemberId === undefined && projectId === undefined) {
    return null;
  }

  return {
    projectMemberId,
    projectId,
    projectName: projectName || 'Unknown project',
    booked: project.booked === false ? false : project.booked === true ? true : undefined,
    bookedHours: Number.isFinite(Number(project.bookedHours)) ? Number(project.bookedHours) : undefined,
    loggedHours: Number.isFinite(Number(project.loggedHours)) ? Number(project.loggedHours) : undefined
  };
}

function normalizeOptionalId(value) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : String(value);
}

function createDraftId() {
  return `draft_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function sortNewestFirst(left, right) {
  return String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''));
}

function normalizeCwd(value) {
  const text = String(value || '').trim();
  return text ? resolve(text) : '';
}
