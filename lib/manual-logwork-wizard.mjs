import { addLocalDays, todayLocalDateISO } from './util.mjs';
import {
  projectIdentityKey,
  sameProjectIdentity
} from './project-identity.mjs';

const TASK_LINE_RE = /^\+(\d+(?:\.\d+)?)\s+(.+)$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SHORT_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function parseTaskLine(line) {
  const match = TASK_LINE_RE.exec(String(line || '').trim());
  if (!match) {
    throw new Error('Task must use format: +2 check ui/ux');
  }

  const hours = Number(match[1]);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error(`Invalid task hours: ${match[1]}`);
  }

  const taskName = match[2].trim();
  if (!taskName) {
    throw new Error('Task name is required.');
  }

  return {
    hours,
    taskName,
    line: `+${formatHours(hours)} ${taskName}`
  };
}

export function buildLogworkText({ date, tasks }) {
  return [
    formatDateHeading(date),
    ...tasks.map((task) => `+${formatHours(task.hours)} ${task.taskName}`)
  ].join('\n');
}

export function buildProjectOverrides({ date, tasks, projectMemberId }) {
  return Object.fromEntries(tasks.map((_, index) => [
    `${date}-${String(index + 1).padStart(2, '0')}`,
    projectMemberId
  ]));
}

export function buildWeekDateOptions(weekly) {
  const range = weekly?.range;
  if (!range?.from || !range?.to) {
    return [];
  }

  const byDate = new Map((weekly.days || []).map((day) => [day.date, day]));
  const options = [];
  for (let date = range.from; date < range.to; date = addLocalDays(date, 1)) {
    const day = byDate.get(date) || {
      date,
      bookedHours: 0,
      loggedHours: 0,
      projects: []
    };
    options.push({
      date,
      label: `${shortWeekday(date)} ${date} · ${formatHours(day.loggedHours)}h logged / ${formatHours(day.bookedHours)}h booked`,
      bookedHours: Number(day.bookedHours || 0),
      loggedHours: Number(day.loggedHours || 0),
      projects: day.projects || [],
      isToday: date === todayLocalDateISO()
    });
  }
  return options;
}

export function buildCurrentWeekDateOptions({
  today = todayLocalDateISO()
} = {}) {
  const todayDate = parseLocalDate(today);
  const mondayOffset = todayDate.getDay() === 0 ? -6 : 1 - todayDate.getDay();
  const monday = addLocalDays(today, mondayOffset);
  return Array.from({ length: 7 }, (_, index) => {
    const date = addLocalDays(monday, index);
    return {
      date,
      label: `${shortWeekday(date)} ${date}`,
      bookedHours: 0,
      loggedHours: 0,
      projects: [],
      isToday: date === today
    };
  });
}

export function buildProjectOptions({ projectsResult, weekly, date }) {
  const memberships = projectsResult?.projects || [];
  const day = (weekly?.days || []).find((candidate) => candidate.date === date);
  const bookedProjects = day?.projects || [];
  const options = [];
  const seen = new Set();

  for (const project of bookedProjects) {
    const membership = memberships.find((candidate) => sameProjectIdentity(candidate, project)) || project;
    const option = projectOption({
      ...membership,
      bookedHours: project.bookedHours,
      loggedHours: project.loggedHours
    }, { booked: true });
    options.push(option);
    seen.add(projectIdentityKey(option));
  }

  for (const project of memberships) {
    const key = projectIdentityKey(project);
    if (seen.has(key)) {
      continue;
    }
    options.push(projectOption(project, { booked: false }));
    seen.add(key);
  }

  return options;
}

export function formatDraftPreview({ target = 'ro', date, project, tasks, preview, previews }) {
  const lines = [
    `Date: ${date || 'not selected'}`,
    `Target: ${target}`,
    `Tasks: ${tasks.length} · Total: ${formatHours(totalTaskHours(tasks))}h`
  ];

  if (target === 'ro' || target === 'both') {
    lines.splice(2, 0, `Project: ${project?.projectName || 'not selected'}`);
  }

  if (project && project.booked === false) {
    lines.push('Project status: UNBOOKED for selected date');
  }

  if (tasks.length) {
    lines.push('');
    tasks.forEach((task, index) => {
      lines.push(`${index + 1}. +${formatHours(task.hours)} ${task.taskName}`);
    });
  }

  if (preview) {
    appendPreviewLines(lines, preview);
  }

  if (previews) {
    lines.push('');
    if (previews.ro) {
      lines.push(`RO preview: ${previews.ro.status}`);
    }
    if (previews.jira) {
      lines.push(`Jira preview: ${previews.jira.status}`);
      if (preview !== previews.jira) {
        appendJiraPreviewLines(lines, previews.jira, { target });
      }
    }
  }

  return lines.join('\n');
}

function appendPreviewLines(lines, preview) {
  lines.push('');
  lines.push(`Preview: ${preview.status}`);
  if (preview.errors?.length) {
    for (const error of preview.errors) {
      lines.push(`- Parse error: ${error.message}`);
    }
  }
  if (preview.unresolvedEntries?.length) {
    for (const entry of preview.unresolvedEntries) {
      lines.push(`- Unresolved: +${formatHours(entry.hours)} ${entry.taskName} (${entry.reason})`);
    }
  }
  if (preview.unbookedEntries?.length) {
    lines.push(`- Unbooked entries: ${preview.unbookedEntries.length}; /apply requires extra confirmation`);
  }
  const jiraBlocked = (preview.entries || []).filter((entry) => entry.status && entry.status !== 'ready' && !entry.matchedProject);
  if (jiraBlocked.length) {
    lines.push(`- Blocked Jira entries: ${jiraBlocked.length}`);
  }
  if (preview.totals?.readyCount !== undefined) {
    appendJiraPreviewLines(lines, preview);
  }
}

function appendJiraPreviewLines(lines, preview, { target = 'jira' } = {}) {
  const totals = preview.totals || {};
  lines.push(`- Jira counts: ready ${totals.readyCount || 0}, duplicate ${totals.duplicateCount || 0}, missing ticket ${totals.missingIssueCount || 0}, multiple tickets ${totals.multipleIssueCount || 0}, lookup failed ${totals.lookupFailedCount || 0}`);
  const missing = (preview.entries || []).filter((entry) => entry.reason === 'missing_issue_key');
  if (missing.length) {
    lines.push(`- Warning: ${missing.length} task${missing.length === 1 ? '' : 's'} missing a Jira ticket${target === 'both' ? '; Both apply is blocked' : ''}.`);
  }
  for (const entry of preview.entries || []) {
    if (entry.issue) {
      lines.push(`- ${entry.issueKey}: ${entry.issue.summary || 'No summary'} [${entry.issue.status || 'unknown status'}]`);
    }
    if (entry.worklog?.comment) {
      lines.push(`  Comment: ${String(entry.worklog.comment).replace(/\s*\n\s*/g, ' | ')}`);
    }
  }
}

export function totalTaskHours(tasks) {
  return tasks.reduce((sum, task) => sum + Number(task.hours || 0), 0);
}

export function toggleTaskSelection(selectedIndexes, index) {
  const selected = new Set([...selectedIndexes].map(Number));
  if (selected.has(index)) {
    selected.delete(index);
  } else {
    selected.add(index);
  }
  return [...selected].sort((left, right) => left - right);
}

export function removeDraftTasks(tasks, selectedIndexes) {
  const selected = new Set([...selectedIndexes].map(Number));
  return tasks.filter((_, index) => !selected.has(index));
}

export function replaceDraftTask(tasks, index, task) {
  return tasks.map((currentTask, currentIndex) => currentIndex === index ? task : currentTask);
}

export function canApplyPreview(preview, {
  target = 'ro'
} = {}) {
  if (!preview) {
    return {
      ok: false,
      reason: 'Build a preview before applying.'
    };
  }

  if (preview.errors?.length) {
    return {
      ok: false,
      reason: 'Cannot apply preview with parse errors.'
    };
  }

  if (target === 'jira') {
    const blocked = (preview.entries || []).filter((entry) => entry.status !== 'ready');
    if (blocked.length) {
      return {
        ok: false,
        reason: `Cannot apply Jira preview with ${blocked.length} blocked entries.`
      };
    }
    if (!(preview.entries || []).length) {
      return {
        ok: false,
        reason: 'Cannot apply Jira preview with no entries.'
      };
    }
  }

  if (preview.unresolvedEntries?.length) {
    return {
      ok: false,
      reason: `Cannot apply preview with ${preview.unresolvedEntries.length} unresolved entries.`
    };
  }

  return {
    ok: true,
    reason: ''
  };
}

export function formatDateHeading(localDateISO) {
  const date = parseLocalDate(localDateISO);
  return `${WEEKDAYS[date.getDay()]}, ${String(date.getDate()).padStart(2, '0')} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

export function formatHours(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(2))).replace(/\.0$/, '');
}

function projectOption(project, { booked }) {
  const bookedText = booked
    ? `${formatHours(project.loggedHours)}h logged / ${formatHours(project.bookedHours)}h booked`
    : 'UNBOOKED';
  return {
    projectMemberId: project.projectMemberId,
    projectId: project.projectId,
    projectName: project.projectName,
    booked,
    bookedHours: project.bookedHours,
    loggedHours: project.loggedHours,
    label: `${project.projectName} · memberId ${project.projectMemberId ?? 'unknown'} · ${bookedText}`
  };
}

function shortWeekday(localDateISO) {
  return SHORT_WEEKDAYS[parseLocalDate(localDateISO).getDay()] || localDateISO;
}

function parseLocalDate(localDateISO) {
  const [year, month, day] = String(localDateISO).split('-').map(Number);
  return new Date(year, month - 1, day);
}
