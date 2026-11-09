// Ranks the user's RO projects for a git repo that has no project mapping yet,
// so the user (or an agent) can confirm the likely project instead of typing a
// projectMemberId. Pure: every input is passed in.
//
// Evidence, strongest first:
//   1. ticket history: a ticket key from this repo's commits appears in one of
//      the user's own RO entries (description or task) of the last 30 days;
//   2. name similarity: the repo folder name or git remote matches the project
//      name, its acronym in parentheses, or the initials of its words;
//   3. single booked project: the repo's commit days had exactly one booked
//      project.
import { extractTickets } from './commit-workflow.mjs';
import { projectIdentityKey, sameProjectIdentity } from './project-identity.mjs';

export const MAX_REPO_SUGGESTIONS = 5;

const SCORE_TICKET = 60;
const SCORE_TICKET_EXTRA = 5;
const SCORE_TICKET_MAX = 80;
const SCORE_ACRONYM = 30;
const SCORE_INITIALS = 25;
const SCORE_TOKEN = 15;
const SCORE_TOKEN_EXTRA = 5;
const SCORE_TOKEN_MAX = 28;
const SCORE_SINGLE_BOOKED = 15;
const MAX_TICKET_REASONS = 3;

// Words that say nothing about which project a repo belongs to.
export const NAME_STOP_WORDS = new Set([
  'app', 'apps', 'web', 'website', 'api', 'apis', 'fe', 'be', 'frontend', 'front', 'backend', 'back', 'end',
  'service', 'services', 'svc', 'mobile', 'the', 'a', 'an', 'of', 'and', 'for', 'project', 'projects', 'prj',
  'sit', 'uat', 'prod', 'dev', 'staging', 'stg', 'team', 'repo', 'git', 'src', 'main', 'client', 'server',
  'android', 'ios', 'ui', 'v1', 'v2', 'v3', 'new', 'old', 'core', 'common',
  // Remote URL noise.
  'github', 'gitlab', 'bitbucket', 'com', 'org', 'net', 'io', 'www', 'http', 'https', 'ssh', 'scm', 'azure',
  'visualstudio', 'vs', 'tfs'
]);

// Lowercase tokens of a name: split on -_./ (and any other non-alphanumeric
// character) and on camelCase / PascalCase boundaries.
export function tokenizeName(value = '') {
  return String(value)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter(Boolean);
}

export function meaningfulTokens(value = '') {
  return tokenizeName(value).filter((token) => token.length >= 2 && !NAME_STOP_WORDS.has(token) && !/^\d+$/.test(token));
}

// What a repo name can match in a project name: its meaningful tokens, the
// acronyms in parentheses ("GKE Fair Chem System (FCS)" -> fcs), and the
// initials of its words, with and without stop words ("gfcs").
export function projectNameKeys(projectName = '') {
  const name = String(projectName);
  const acronyms = [...name.matchAll(/\(([^)]+)\)/g)]
    .flatMap((match) => tokenizeName(match[1]))
    .filter((token) => token.length >= 2);
  const words = tokenizeName(name.replace(/\([^)]*\)/g, ' ')).filter((token) => !/^\d+$/.test(token));
  const initials = new Set();
  for (const list of [words, words.filter((word) => !NAME_STOP_WORDS.has(word))]) {
    if (list.length >= 2) {
      initials.add(list.map((word) => word[0]).join(''));
    }
  }
  return {
    tokens: [...new Set(meaningfulTokens(name))],
    acronyms: [...new Set(acronyms)],
    initials: [...initials].filter((value) => value.length >= 2)
  };
}

// The path part of a git remote ("git@host:org/repo.git",
// "https://host/org/repo.git", "ssh://git@host:22/org/repo") without the host
// and the .git suffix.
export function remoteRepoPath(remoteUrl = '') {
  const text = String(remoteUrl || '').trim();
  if (!text) {
    return '';
  }
  let path = text;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/?(.*)$/i.exec(text);
  const scp = /^[^@/\s]+@[^:/\s]+:(.*)$/.exec(text);
  if (scheme) {
    path = scheme[1];
  } else if (scp) {
    path = scp[1];
  }
  return path.replace(/\.git\/?$/i, '').replace(/^\/+|\/+$/g, '');
}

// RO entries from queryLogwork(includeEntries: true) as history items.
export function historyFromQueryResult(queryResult) {
  return (Array.isArray(queryResult?.entries) ? queryResult.entries : [])
    .map((entry) => ({
      date: entry.date || '',
      projectName: entry.projectName || '',
      ...(hasValue(entry.projectMemberId) ? { projectMemberId: entry.projectMemberId } : {}),
      ...(hasValue(entry.projectId) ? { projectId: entry.projectId } : {}),
      text: [entry.taskName, entry.description].filter(Boolean).join(' ')
    }))
    .filter((entry) => entry.text && (entry.projectName || hasValue(entry.projectMemberId) || hasValue(entry.projectId)));
}

// Booked projects (bookedHours > 0) per date from a queryLogwork result.
export function bookedProjectsByDateFromQuery(queryResult) {
  const byDate = {};
  for (const day of Array.isArray(queryResult?.days) ? queryResult.days : []) {
    byDate[day.date] = (day.projects || []).filter((project) => Number(project.bookedHours || 0) > 0);
  }
  return byDate;
}

// Every candidate with its score and reasons, highest score first; ties keep
// the candidates' order. A candidate without evidence scores 0.
export function rankRepoProjects({
  repoPath = '',
  repoGroups = [],
  candidates = [],
  history = [],
  remoteUrl = '',
  bookedProjectsByDate = {}
} = {}) {
  const projects = uniqueProjects(candidates);
  const tickets = [...new Set(repoGroups.flatMap((group) => group.tickets || []))];
  const repoName = String(repoPath).split(/[\\/]/).filter(Boolean).pop() || '';
  const nameSources = [
    { label: 'repo name', tokens: meaningfulTokens(repoName) },
    { label: 'git remote', tokens: meaningfulTokens(remoteRepoPath(remoteUrl)) }
  ].filter((source) => source.tokens.length);
  const singleBooked = singleBookedProject(repoGroups, bookedProjectsByDate);

  const ranked = projects.map((project, index) => {
    const reasons = [];
    let score = 0;

    const ticketHits = ticketEvidence(project, tickets, history);
    if (ticketHits.length) {
      score += Math.min(SCORE_TICKET_MAX, SCORE_TICKET + SCORE_TICKET_EXTRA * (ticketHits.length - 1));
      reasons.push(...ticketHits.slice(0, MAX_TICKET_REASONS)
        .map((hit) => `ticket ${hit.ticket} was logged to this project on ${hit.date}`));
    }

    const name = nameEvidence(project, nameSources);
    if (name) {
      score += name.score;
      reasons.push(name.reason);
    }

    if (singleBooked && sameProjectIdentity(singleBooked.project, project)) {
      score += SCORE_SINGLE_BOOKED;
      reasons.push(`the only project booked on this repo's commit days (${formatDates(singleBooked.dates)})`);
    }

    return { ...projectRef(project), score, reasons, index };
  });

  return ranked
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ index: _index, ...item }) => item);
}

// The top suggestions (score > 0), at most MAX_REPO_SUGGESTIONS.
export function suggestRepoProjects(input = {}) {
  return rankRepoProjects(input)
    .filter((item) => item.score > 0)
    .slice(0, MAX_REPO_SUGGESTIONS);
}

// Picker order: suggestions first (top one first), then every other candidate
// in its original order. Each item: { project, suggestion | null }.
export function orderProjectsForPicker(candidates = [], suggestions = []) {
  const items = suggestions.map((suggestion) => ({ project: projectRef(suggestion), suggestion }));
  for (const project of uniqueProjects(candidates)) {
    if (!items.some((item) => sameProjectIdentity(item.project, project))) {
      items.push({ project: projectRef(project), suggestion: null });
    }
  }
  return items;
}

export function formatSuggestionReason(suggestion) {
  return (suggestion?.reasons || []).join('; ');
}

function ticketEvidence(project, tickets, history) {
  if (!tickets.length || !history.length) {
    return [];
  }
  const hits = [];
  for (const ticket of tickets) {
    const dates = history
      .filter((entry) => sameProjectIdentity(entry, project) && extractTickets(entry.text).includes(ticket))
      .map((entry) => entry.date)
      .filter(Boolean)
      .sort();
    if (dates.length) {
      hits.push({ ticket, date: dates.at(-1) });
    }
  }
  return hits.sort((left, right) => right.date.localeCompare(left.date));
}

function nameEvidence(project, sources) {
  if (!sources.length) {
    return null;
  }
  const keys = projectNameKeys(project.projectName);
  let best = null;
  const consider = (candidate) => {
    if (!best || candidate.score > best.score) {
      best = candidate;
    }
  };
  for (const source of sources) {
    const acronym = keys.acronyms.find((value) => source.tokens.includes(value));
    if (acronym) {
      consider({ score: SCORE_ACRONYM, reason: `${source.label} matches ${acronym.toUpperCase()}` });
    }
    const initials = keys.initials.find((value) => source.tokens.includes(value));
    if (initials) {
      consider({ score: SCORE_INITIALS, reason: `${source.label} matches the initials ${initials.toUpperCase()} of the project name` });
    }
    const shared = [...new Set(source.tokens.filter((token) => keys.tokens.includes(token)))];
    if (shared.length) {
      consider({
        score: Math.min(SCORE_TOKEN_MAX, SCORE_TOKEN + SCORE_TOKEN_EXTRA * (shared.length - 1)),
        reason: `${source.label} shares ${shared.map((token) => `"${token}"`).join(', ')} with the project name`
      });
    }
  }
  return best;
}

function singleBookedProject(repoGroups, bookedProjectsByDate) {
  const dates = [...new Set(repoGroups.map((group) => group.date).filter(Boolean))].sort();
  if (!dates.length) {
    return null;
  }
  const projects = [];
  for (const date of dates) {
    for (const project of bookedProjectsByDate?.[date] || []) {
      if (!projects.some((known) => sameProjectIdentity(known, project))) {
        projects.push(project);
      }
    }
  }
  return projects.length === 1 ? { project: projects[0], dates } : null;
}

function uniqueProjects(projects) {
  const seen = new Set();
  const results = [];
  for (const project of Array.isArray(projects) ? projects : []) {
    if (!project || !(project.projectName || hasValue(project.projectMemberId) || hasValue(project.projectId))) {
      continue;
    }
    const key = projectIdentityKey(project);
    if (seen.has(key) || results.some((known) => sameProjectIdentity(known, project))) {
      continue;
    }
    seen.add(key);
    results.push(project);
  }
  return results;
}

function projectRef(project = {}) {
  return {
    projectName: project.projectName || '',
    ...(hasValue(project.projectMemberId) ? { projectMemberId: project.projectMemberId } : {}),
    ...(hasValue(project.projectId) ? { projectId: project.projectId } : {})
  };
}

function formatDates(dates) {
  return dates.length > 3 ? `${dates.slice(0, 3).join(', ')} +${dates.length - 3} more` : dates.join(', ');
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}
