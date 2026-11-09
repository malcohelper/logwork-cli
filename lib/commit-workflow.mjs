import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { isAuthRequiredError } from './auth-errors.mjs';
import { CONFIG } from './config.mjs';
import { findRepoMapping, loadLocalConfig } from './logwork-config.mjs';
import { projectIdentityKey, sameProjectIdentity } from './project-identity.mjs';
import { resolveEntryProject } from './project-resolver.mjs';
import { normalizeQueryRange, queryLogwork } from './query-workflow.mjs';
import { addLocalDays, todayLocalDateISO } from './util.mjs';

// Builds a logwork draft from the user's own git commits:
//   commits (all branches, this author, in the period)
//   -> grouped per day by repo + ticket + kind of work
//   -> each group gets a default RO worklog task and a description
//   -> each group gets an RO project: a mapping whose repos list holds the
//      repo, else the project resolver (tickets, keywords, booked projects)
//   -> each project's remaining hours (RO booked - logged) are split across its
//      groups by how much work each group holds; unresolved groups share the
//      room of booked projects no group claimed (without RO: a standard day)
//   -> a "+<hours> <worklog task> | <description>" block for log_work.
// Nothing is written anywhere; the agent shows the draft, the user edits and
// approves it, then log_work previews and applies it as usual.

const TICKET_RE = /\b[A-Z][A-Z0-9]+-\d+\b/g;
// Prefixes that look like ticket keys but are standards or versions
// ("UTF-8", "ISO-8601", "SHA-256", "CVE-2024-1234").
const NOT_TICKET_PREFIXES = new Set(['UTF', 'ISO', 'SHA', 'RFC', 'HTTP', 'HTTPS', 'ES', 'ECMA', 'TLS', 'SSL', 'MD', 'AES', 'RSA', 'UTC', 'GMT', 'CVE', 'CWE', 'IPV', 'WCAG', 'PEP', 'JSR', 'ISBN', 'COVID', 'MP', 'H', 'X', 'IE', 'WIN', 'NODE', 'PHP', 'IOS']);
const MAX_TICKETS_IN_DESCRIPTION = 4;
const CONVENTIONAL_RE = /^(\w+)(?:\([^)]*\))?!?:\s*/;
const FIELD = '\x1f';
const RECORD = '\x1e';
const MAX_DESCRIPTION_LENGTH = 240;

// Default RO catalog task per kind of work. These are the shared default task
// names; a project with its own catalog may need a different name (list_tasks).
export const WORK_KINDS = Object.freeze({
  feature: { task: 'Feature Development', label: 'feature' },
  fix: { task: 'Bug Fix', label: 'fix' },
  refactor: { task: 'Code Review & Refactoring', label: 'refactor/review' },
  test: { task: 'Testing Activities', label: 'test' },
  release: { task: 'Deployment & Release', label: 'build/deploy' },
  design: { task: 'Requirements & Design', label: 'docs/design' },
  other: { task: 'Other Activities', label: 'other' }
});

const CONVENTIONAL_KINDS = new Map([
  ['feat', 'feature'], ['feature', 'feature'],
  ['fix', 'fix'], ['bugfix', 'fix'], ['hotfix', 'fix'], ['revert', 'fix'],
  ['refactor', 'refactor'], ['perf', 'refactor'], ['style', 'refactor'], ['review', 'refactor'],
  ['test', 'test'], ['tests', 'test'], ['e2e', 'test'],
  ['ci', 'release'], ['build', 'release'], ['release', 'release'], ['deploy', 'release'],
  ['docs', 'design'], ['doc', 'design'], ['design', 'design'], ['spec', 'design'],
  ['chore', 'other']
]);

// Keyword fallback for non-conventional subjects, strongest signal first.
const KEYWORD_KINDS = [
  [/\b(fix|fixes|fixed|bug|hotfix|crash|regression)\b/i, 'fix'],
  [/\b(tests?|e2e|unit test|coverage|qa)\b/i, 'test'],
  [/\b(deploy|deployment|release|bump|pipeline|docker|helm|k8s|kubernetes)\b/i, 'release'],
  [/\b(refactor|cleanup|clean up|rename|review|lint|format)\b/i, 'refactor'],
  [/\b(docs?|readme|design|spec|requirements?|diagram)\b/i, 'design']
];

export function classifyCommit(subject = '', body = '') {
  const conventional = CONVENTIONAL_RE.exec(subject);
  if (conventional) {
    const kind = CONVENTIONAL_KINDS.get(conventional[1].toLowerCase());
    if (kind) {
      return kind;
    }
  }
  for (const text of [subject, body]) {
    for (const [pattern, kind] of KEYWORD_KINDS) {
      if (pattern.test(text)) {
        return kind;
      }
    }
  }
  return 'feature';
}

export function cleanSubject(subject = '') {
  return String(subject).replace(CONVENTIONAL_RE, '').trim();
}

export function parseGitLog(output = '') {
  const commits = [];
  for (const chunk of String(output).split(RECORD)) {
    if (!chunk.trim()) {
      continue;
    }
    const [hash, timestamp, authorName, authorEmail, subject, body = '', stats = ''] = chunk.split(FIELD);
    if (!hash || !timestamp) {
      continue;
    }
    let additions = 0;
    let deletions = 0;
    let files = 0;
    for (const line of stats.split(/\r?\n/)) {
      const match = /^(\d+|-)\t(\d+|-)\t/.exec(line.trim());
      if (match) {
        files += 1;
        additions += match[1] === '-' ? 0 : Number(match[1]);
        deletions += match[2] === '-' ? 0 : Number(match[2]);
      }
    }
    commits.push({
      hash: hash.trim(),
      timestamp: Number(timestamp),
      authorName: authorName.trim(),
      authorEmail: authorEmail.trim(),
      subject: subject.trim(),
      body: body.trim(),
      files,
      additions,
      deletions
    });
  }
  return commits;
}

export async function resolveGitRepoRoot(path, runGit = runGitCommand) {
  const root = String(await runGit(path, ['rev-parse', '--show-toplevel'])).trim();
  if (!root) {
    throw new Error('git did not report a repository root');
  }
  return resolve(root);
}

export async function readRepoCommits({ repo, from, to, author, runGit = runGitCommand }) {
  const root = await resolveGitRepoRoot(repo, runGit);
  const authorFilter = (author || (await runGit(root, ['config', 'user.email']).catch(() => ''))).trim();
  if (!authorFilter) {
    throw new Error(`No git author for ${root}. Set git config user.email or pass author.`);
  }
  // The period is matched on the author date in JS below. Git's --since and
  // --until use the committer date (so rebased or amended commits would fall
  // out of their real day) and --since stops the walk at the first older
  // commit (clock skew). --since-as-filter (git 2.37+) only filters, and a day
  // of slack covers time zones; older git falls back to a 31-day window.
  const sinceDate = addLocalDays(from, -1);
  const baseArgs = [
    'log',
    // Every local and remote branch (work often sits on feature branches) and
    // HEAD (a detached HEAD mid-rebase), but not refs/stash, whose "WIP on" /
    // "index on" commits are not work items.
    '--branches',
    '--remotes',
    'HEAD',
    '--no-merges',
    // Narrow by author in git (fixed string, so "." or "+" in an email is not
    // a regex); the exact match happens in JS.
    `--author=${authorFilter}`,
    '--fixed-strings',
    '--regexp-ignore-case',
    `--format=${RECORD}%H${FIELD}%at${FIELD}%an${FIELD}%ae${FIELD}%s${FIELD}%b${FIELD}`,
    '--numstat'
  ];
  let output;
  try {
    output = await runGit(root, [...baseArgs, `--since-as-filter=${sinceDate}T00:00:00`]);
  } catch (error) {
    if (!/since-as-filter|unrecognized argument|unknown option/i.test(error.message)) {
      throw error;
    }
    output = await runGit(root, [...baseArgs, `--since=${addLocalDays(from, -31)}T00:00:00`]);
  }
  const seen = new Set();
  const commits = parseGitLog(output)
    .filter((commit) => matchesAuthor(commit, authorFilter))
    .filter((commit) => !seen.has(commit.hash) && seen.add(commit.hash))
    .map((commit) => ({ ...commit, repo: root, date: todayLocalDateISO(new Date(commit.timestamp * 1000)) }))
    .filter((commit) => commit.date >= from && commit.date < to);
  return { root, author: authorFilter, commits };
}

// Exact author match: an email filter must equal the author email, a name
// filter must equal the author name (both case-insensitive). git --author is
// a substring match, so "me@x.com" alone would also match "jime@x.com".
export function matchesAuthor(commit, authorFilter) {
  const filter = String(authorFilter || '').trim().toLowerCase();
  if (!filter) {
    return true;
  }
  const email = String(commit.authorEmail || '').toLowerCase();
  const name = String(commit.authorName || '').toLowerCase();
  const bracketed = filter.match(/<([^>]+)>/);
  if (bracketed) {
    return email === bracketed[1].trim();
  }
  return filter.includes('@') ? email === filter : name === filter;
}

export function extractTickets(text = '') {
  return [...new Set((String(text).match(TICKET_RE) || [])
    .filter((key) => !NOT_TICKET_PREFIXES.has(key.slice(0, key.lastIndexOf('-')))))];
}

export function groupCommits(commits = []) {
  const groups = new Map();
  for (const commit of [...commits].sort((a, b) => a.timestamp - b.timestamp)) {
    const tickets = extractTickets(`${commit.subject}\n${commit.body}`);
    const kind = classifyCommit(commit.subject, commit.body);
    const key = [commit.repo, tickets[0] || '', kind].join('|');
    const group = groups.get(key) || {
      repo: commit.repo,
      repoName: commit.repo.split(/[\\/]/).filter(Boolean).pop() || commit.repo,
      tickets: [],
      kind,
      task: WORK_KINDS[kind].task,
      subjects: [],
      commitCount: 0,
      linesChanged: 0,
      hashes: []
    };
    group.tickets = [...new Set([...group.tickets, ...tickets])];
    const subject = cleanSubject(commit.subject);
    if (subject && !group.subjects.includes(subject)) {
      group.subjects.push(subject);
    }
    group.commitCount += 1;
    group.linesChanged += commit.additions + commit.deletions;
    group.hashes.push(commit.hash.slice(0, 8));
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    description: buildDescription(group),
    weight: group.commitCount + Math.min(3, group.linesChanged / 200)
  }));
}

export function buildDescription(group) {
  const shown = group.tickets.slice(0, MAX_TICKETS_IN_DESCRIPTION);
  const more = group.tickets.length - shown.length;
  const ticketSuffix = shown.length ? ` (${shown.join(', ')}${more > 0 ? ` +${more} more` : ''})` : '';
  const room = Math.max(40, MAX_DESCRIPTION_LENGTH - ticketSuffix.length);
  const ticketSet = new Set(group.tickets);
  const subjects = group.subjects
    .map((subject) => subject.replace(TICKET_RE, (key) => (ticketSet.has(key) ? '' : key)).replace(/\s*[[(]\s*[)\]]\s*/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  let text = '';
  for (const subject of subjects) {
    const next = text ? `${text}; ${subject}` : subject;
    if (next.length > room) {
      text = text || subject.slice(0, Math.max(0, room - 1)).trim();
      break;
    }
    text = next;
  }
  return `${text || group.repoName}${ticketSuffix}`.replace(/\|/g, '/');
}

// Splits targetHours across groups by weight in hourStep increments. Every
// group that gets time gets at least one step; when the day has fewer steps than
// groups, the heaviest groups win and the rest get 0 (still listed).
export function allocateHours(groups, targetHours, step = CONFIG.hourStep || 0.5) {
  const totalSteps = Math.max(0, Math.floor((Number(targetHours) || 0) / step + 1e-9));
  const ordered = groups.map((group, index) => ({ index, weight: group.weight || 1 }))
    .sort((a, b) => b.weight - a.weight);
  const steps = new Array(groups.length).fill(0);
  if (!totalSteps || !groups.length) {
    return steps.map(() => 0);
  }
  const funded = ordered.slice(0, Math.min(totalSteps, ordered.length));
  for (const item of funded) {
    steps[item.index] = 1;
  }
  let remaining = totalSteps - funded.length;
  const totalWeight = funded.reduce((sum, item) => sum + item.weight, 0);
  const shares = funded.map((item) => ({ ...item, exact: (item.weight / totalWeight) * remaining }));
  for (const share of shares) {
    const whole = Math.floor(share.exact);
    steps[share.index] += whole;
    remaining -= whole;
  }
  shares.sort((a, b) => (b.exact - Math.floor(b.exact)) - (a.exact - Math.floor(a.exact)));
  for (let i = 0; remaining > 0; i = (i + 1) % shares.length) {
    steps[shares[i].index] += 1;
    remaining -= 1;
  }
  return steps.map((count) => Number((count * step).toFixed(2)));
}

export function formatDayHeading(localDateISO) {
  const [year, month, day] = localDateISO.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  const monthName = date.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
  return `${weekday}, ${String(day).padStart(2, '0')} ${monthName} ${year}`;
}

function isWeekend(localDateISO) {
  const [year, month, day] = localDateISO.split('-').map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 || weekday === 6;
}

// Remaining RO time per day: sum over projects of max(0, booked - logged), so
// over-logging one project does not hide a gap on another. projects keeps every
// booked project with its ids so commit groups can be allocated per project.
export function remainingHoursByDay(roResult) {
  const byDay = new Map();
  for (const day of roResult?.days || []) {
    const projects = (day.projects || []).map((project) => ({
      ...projectRef(project),
      bookedHours: Number(project.bookedHours || 0),
      loggedHours: Number(project.loggedHours || 0),
      remainingHours: roundHours(Math.max(0, Number(project.bookedHours || 0) - Number(project.loggedHours || 0)))
    }));
    const remaining = projects.length
      ? projects.reduce((sum, project) => sum + project.remainingHours, 0)
      : Math.max(0, Number(day.bookedHours || 0) - Number(day.loggedHours || 0));
    byDay.set(day.date, {
      bookedHours: Number(day.bookedHours || 0),
      loggedHours: Number(day.loggedHours || 0),
      remainingHours: roundHours(remaining),
      projects,
      remainingByProject: projects
        .filter((project) => project.remainingHours > 0)
        .map((project) => ({ ...projectRef(project), remainingHours: project.remainingHours }))
    });
  }
  return byDay;
}

// The project of one commit group: a mapping whose repos list holds the repo,
// else the shared resolver on the description and tickets against the day's
// booked projects and the ticket/keyword mappings, else null.
export function resolveGroupProject(group, { bookedProjects = [], config = {}, platform = process.platform } = {}) {
  const mapping = findRepoMapping(config.projectMappings, group.repo, platform);
  if (mapping) {
    const booked = bookedProjects.find((project) => sameProjectIdentity(project, mapping));
    return { ...projectRef(booked || mapping), source: 'repo_mapping' };
  }
  if (!bookedProjects.length) {
    return null;
  }
  const resolution = resolveEntryProject({
    entry: { id: group.repo, text: group.description, taskName: group.description, tickets: group.tickets },
    projects: bookedProjects,
    config
  });
  if (resolution.status !== 'resolved') {
    return null;
  }
  return { ...projectRef(resolution.project), source: 'resolver', reason: resolution.reason };
}

// Splits one day's RO room per project:
// - groups resolved to a project share that project's remaining hours;
// - unresolved groups share the remaining hours of booked projects that got
//   no resolved group;
// - nothing ever exceeds a project's remaining hours.
export function allocateDayByProject(groups, projects) {
  const hours = new Array(groups.length).fill(0);
  const byProject = new Map();
  const unresolved = [];
  groups.forEach((group, index) => {
    if (!group.project) {
      unresolved.push(index);
      return;
    }
    const key = projectIdentityKey(group.project);
    const entry = byProject.get(key) || { project: group.project, indexes: [] };
    entry.indexes.push(index);
    byProject.set(key, entry);
  });

  const claimed = new Set();
  const allocation = [];
  for (const { project, indexes } of byProject.values()) {
    const booked = projects.find((candidate) => sameProjectIdentity(candidate, project));
    if (booked) {
      claimed.add(booked);
    }
    const remainingHours = booked?.remainingHours ?? 0;
    const split = allocateHours(indexes.map((index) => groups[index]), remainingHours);
    indexes.forEach((index, position) => { hours[index] = split[position]; });
    allocation.push({
      ...projectRef(project),
      booked: Boolean(booked),
      remainingHours,
      allocatedHours: roundHours(split.reduce((sum, value) => sum + value, 0)),
      groupCount: indexes.length
    });
  }

  const unclaimedHours = roundHours(projects
    .filter((project) => !claimed.has(project))
    .reduce((sum, project) => sum + project.remainingHours, 0));
  if (unresolved.length) {
    const split = allocateHours(unresolved.map((index) => groups[index]), unclaimedHours);
    unresolved.forEach((index, position) => { hours[index] = split[position]; });
  }
  return {
    hours,
    allocation,
    unresolved: unresolved.length
      ? { groupCount: unresolved.length, roomHours: unclaimedHours, allocatedHours: roundHours(unresolved.reduce((sum, index) => sum + hours[index], 0)) }
      : null
  };
}

export async function draftLogworkFromCommits({
  period = 'today',
  from,
  to,
  repos,
  author,
  useBookings = true,
  cwd = process.cwd(),
  runGit = runGitCommand,
  queryRo = queryLogwork,
  loadConfig = loadLocalConfig,
  platform = process.platform
} = {}) {
  const range = from || to ? normalizeQueryRange({ from, to }) : normalizeQueryRange({ period });
  const repoPaths = [...new Set((repos?.length ? repos : [cwd]).map((repo) => resolve(cwd, expandHome(String(repo)))))];

  const repoResults = [];
  const commits = [];
  const seenRoots = new Set();
  // A commit counts once even when two paths reach it (a subfolder of the same
  // repo, or a git worktree of it).
  const seenHashes = new Set();
  for (const repo of repoPaths) {
    try {
      const result = await readRepoCommits({ repo, from: range.from, to: range.to, author, runGit });
      if (seenRoots.has(result.root)) {
        continue;
      }
      seenRoots.add(result.root);
      const fresh = result.commits.filter((commit) => !seenHashes.has(commit.hash) && seenHashes.add(commit.hash));
      repoResults.push({ path: result.root, author: result.author, commitCount: fresh.length });
      commits.push(...fresh);
    } catch (error) {
      repoResults.push({ path: repo, error: error.message, commitCount: 0 });
    }
  }

  let bookings = null;
  let bookingsError = '';
  if (useBookings) {
    try {
      bookings = remainingHoursByDay(await queryRo({ from: range.from, to: range.to, includeEntries: false, cwd }));
    } catch (error) {
      // A missing or expired RO login must reach the agent as authRequired;
      // falling back to an 8h day would hide hours that are already logged.
      if (isAuthRequiredError(error)) {
        throw error;
      }
      bookingsError = error.message;
    }
  }

  const config = commits.length ? await loadConfig(cwd) : { projectMappings: [] };

  const days = [];
  for (let date = range.from; date < range.to; date = addLocalDays(date, 1)) {
    const dayCommits = commits.filter((commit) => commit.date === date);
    if (!dayCommits.length) {
      continue;
    }
    const booking = bookings?.get(date);
    const bookedProjects = (booking?.projects || []).filter((project) => project.bookedHours > 0);
    const groups = groupCommits(dayCommits).map((group) => ({
      ...group,
      project: resolveGroupProject(group, { bookedProjects, config, platform })
    }));
    let targetHours;
    let hoursSource;
    if (booking) {
      targetHours = booking.remainingHours;
      hoursSource = booking.bookedHours ? 'ro_remaining' : 'ro_no_booking';
    } else if (bookings) {
      // RO answered but has no row for this day: nothing is booked.
      targetHours = 0;
      hoursSource = 'ro_no_booking';
    } else {
      targetHours = isWeekend(date) ? 0 : (CONFIG.standardDayHours || 8);
      hoursSource = isWeekend(date) ? 'weekend' : 'standard_day';
    }
    // Per-project split only when RO returned identifiable per-project rows
    // for the day; otherwise (RO unavailable, no booking, day-level totals or
    // nameless rows) the day's target is split across all groups as before.
    const perProject = Boolean(booking?.projects?.length) &&
      booking.projects.every((project) => projectIdentityKey(project) !== '');
    const split = perProject ? allocateDayByProject(groups, booking.projects) : null;
    const hours = split ? split.hours : allocateHours(groups, targetHours);
    days.push({
      date,
      targetHours,
      hoursSource,
      ...(booking ? { bookedHours: booking.bookedHours, loggedHours: booking.loggedHours, remainingByProject: booking.remainingByProject } : {}),
      ...(split ? { projectAllocation: split.allocation, unresolvedAllocation: split.unresolved } : {}),
      groups: groups.map((group, index) => ({
        hours: hours[index],
        task: group.task,
        kind: group.kind,
        description: group.description,
        tickets: group.tickets,
        repo: group.repoName,
        repoPath: group.repo,
        project: group.project,
        commitCount: group.commitCount,
        linesChanged: group.linesChanged,
        commits: group.hashes
      }))
    });
  }

  // log_work preview entry ids are "<date>-<NN>", NN counting entry lines
  // through the whole text (lib/batch-parser.mjs), so they are numbered here in
  // the same order the lines are written.
  const projectOverrides = {};
  let lineIndex = 0;
  const draftText = days
    .map((day) => {
      const lines = [];
      for (const group of day.groups.filter((item) => item.hours > 0)) {
        lineIndex += 1;
        const entryId = `${day.date}-${String(lineIndex).padStart(2, '0')}`;
        group.entryId = entryId;
        if (hasValue(group.project?.projectMemberId)) {
          projectOverrides[entryId] = group.project.projectMemberId;
        }
        lines.push(`+${group.hours} ${group.task} | ${group.description}`);
      }
      return lines.length ? [formatDayHeading(day.date), ...lines].join('\n') : '';
    })
    .filter(Boolean)
    .join('\n\n');

  const unmappedRepos = [...new Set(days.flatMap((day) => day.groups)
    .filter((group) => !group.project)
    .map((group) => group.repoPath))];

  const result = {
    status: !commits.length ? 'no_commits' : (draftText ? 'draft' : 'no_hours'),
    range,
    repos: repoResults,
    bookings: useBookings ? (bookings ? 'ro' : 'unavailable') : 'skipped',
    ...(bookingsError ? { bookingsError } : {}),
    commitCount: commits.length,
    days,
    draftText,
    projectOverrides,
    unmappedRepos
  };
  result.summary = formatCommitDraftSummary(result);
  return result;
}

export function formatCommitDraftSummary(result) {
  const lines = [];
  if (!result.commitCount) {
    lines.push(`No commits found from ${result.range.from} to ${addLocalDays(result.range.to, -1)}.`);
  } else {
    lines.push(`${result.commitCount} commit(s) from ${result.range.from} to ${addLocalDays(result.range.to, -1)}.`);
  }
  for (const repo of result.repos) {
    lines.push(repo.error ? `- ${repo.path}: ${repo.error}` : `- ${repo.path} (${repo.author}): ${repo.commitCount} commit(s)`);
  }
  if (result.bookings === 'unavailable') {
    lines.push(`RO bookings unavailable (${result.bookingsError || 'unknown error'}); hours assume a ${CONFIG.standardDayHours || 8}h weekday.`);
  }
  for (const day of result.days) {
    const source = {
      ro_remaining: `RO remaining ${day.targetHours}h (booked ${day.bookedHours}h, logged ${day.loggedHours}h)`,
      ro_no_booking: 'no RO booking: 0h suggested',
      weekend: 'weekend: 0h suggested',
      standard_day: `standard day ${day.targetHours}h`
    }[day.hoursSource];
    lines.push('', `${formatDayHeading(day.date)} - ${source}`);
    if (day.remainingByProject?.length) {
      lines.push(`  Room by project: ${day.remainingByProject.map((project) => `${projectLabel(project)} ${project.remainingHours}h`).join(', ')}`);
    }
    for (const project of day.projectAllocation || []) {
      if (project.allocatedHours === 0) {
        lines.push(`  No room on ${projectLabel(project)}${project.booked ? ` (remaining ${project.remainingHours}h)` : ' (not booked this day)'}: its ${project.groupCount} line(s) get 0h.`);
      }
    }
    if (day.unresolvedAllocation) {
      lines.push(`  ${day.unresolvedAllocation.groupCount} line(s) without a project share ${day.unresolvedAllocation.roomHours}h left on booked projects no other line claimed.`);
    }
    for (const group of day.groups) {
      const project = group.project
        ? `${projectLabel(group.project)} (${group.project.source === 'repo_mapping' ? 'repo mapping' : group.project.reason || group.project.source})`
        : 'project unresolved';
      lines.push(`  ${group.entryId ? `${group.entryId} ` : ''}+${group.hours} ${group.task} | ${group.description}  [${group.repo}, ${group.commitCount} commit(s)] -> ${project}`);
    }
  }
  if (result.draftText) {
    lines.push('', 'Draft for log_work (review with the user first; worklog task names must exist in list_tasks for the project):', '', result.draftText);
    if (Object.keys(result.projectOverrides || {}).length) {
      lines.push('', `Pass projectOverrides to log_work with this draftText unchanged (renumbered or edited lines need new ids): ${JSON.stringify(result.projectOverrides)}`);
    }
  }
  if (result.unmappedRepos?.length) {
    lines.push('', `No project for some lines from: ${result.unmappedRepos.join(', ')}. Ask the user which RO project each repo belongs to and offer map_project with repos so later drafts know it.`);
  }
  return lines.join('\n');
}

function projectRef(project = {}) {
  return {
    projectName: project.projectName || '',
    ...(hasValue(project.projectMemberId) ? { projectMemberId: project.projectMemberId } : {}),
    ...(hasValue(project.projectId) ? { projectId: project.projectId } : {})
  };
}

function projectLabel(project = {}) {
  return project.projectName || (hasValue(project.projectMemberId) ? `project member ${project.projectMemberId}` : 'unnamed project');
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function roundHours(value) {
  return Number(Number(value || 0).toFixed(2));
}

function expandHome(path) {
  return path === '~' || /^~[\\/]/.test(path) ? `${homedir()}${path.slice(1)}` : path;
}

function runGitCommand(cwd, args) {
  return new Promise((resolveValue, reject) => {
    const child = spawn('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolveValue(stdout);
        return;
      }
      reject(new Error(stderr.trim().split('\n')[0] || `git ${args[0]} failed with exit code ${code}`));
    });
  });
}
