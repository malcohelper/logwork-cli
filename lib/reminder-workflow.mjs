import { basename } from 'node:path';
import { isAuthRequiredError } from './auth-errors.mjs';
import { redactText } from './auth-redaction.mjs';
import { draftLogworkFromCommits } from './commit-workflow.mjs';
import { withFileLock } from './file-lock.mjs';
import { searchJiraIssues } from './jira-api.mjs';
import {
  getStoredJiraSession,
  isJiraAuthRequiredError
} from './jira-auth.mjs';
import { loadLocalConfig } from './logwork-config.mjs';
import { sendOsNotification } from './os-notification.mjs';
import { helperHome, reminderStatePath } from './paths.mjs';
import { queryLogwork } from './query-workflow.mjs';
import { loadReminderConfig, normalizeReminderRepos } from './reminder-config.mjs';
import {
  loadReminderState,
  saveReminderState
} from './reminder-state.mjs';
import { todayLocalDateISO } from './util.mjs';

const DEFAULT_ACTION_LINE = 'Mở Terminal và chạy: logwork';
const COMMITS_ACTION_LINE = 'Mở Terminal và chạy: logwork commits today (bản nháp từ commit)';
const COMMIT_SUMMARY_TIMEOUT_MS = 20_000;
// Repos listed under the commit line; the rest are folded into "+N repo khác"
// so the list fits a notification banner.
const MAX_NAMED_REPOS = 3;

// repos: git repos whose commits back up a missing-RO reminder. Without repos,
// or when reading them fails, the message is the plain RO/Jira one.
export async function checkLogworkReminder({
  target = 'both',
  date = todayLocalDateISO(),
  repos = [],
  queryRo = queryResourceOptimiserDay,
  queryJira = queryJiraWorklogDay,
  summarizeCommits = summarizeTodayCommits
} = {}) {
  const checks = {};
  const jobs = [];

  if (target === 'ro' || target === 'both') {
    jobs.push(runReminderCheck('ro', () => queryRo({ date })).then((result) => {
      checks.ro = result;
    }));
  }
  if (target === 'jira' || target === 'both') {
    jobs.push(runReminderCheck('jira', () => queryJira({ date })).then((result) => {
      checks.jira = result;
    }));
  }
  if (!jobs.length) {
    throw new Error('Reminder target must be ro, jira, or both.');
  }
  await Promise.all(jobs);

  const problemLines = buildProblemLines(checks);
  const notify = problemLines.length > 0;
  let commits = null;
  if (notify && checks.ro?.status === 'incomplete' && repos?.length) {
    // Commit evidence is a bonus: any failure keeps the plain message.
    try {
      commits = await summarizeCommits({ date, repos });
    } catch (error) {
      commits = { status: 'unavailable', error: redactText(error.message || String(error)).slice(0, 300) };
    }
  }
  const notification = notify ? buildReminderNotification({ problemLines, commits }) : null;

  return {
    date,
    target,
    status: notify ? 'notification_required' : 'complete',
    notify,
    checks,
    ...(commits ? { commits } : {}),
    notification,
    summary: notify
      ? `Logwork reminder requires attention: ${problemLines.join(' | ')}`
      : `Logwork reminder check is complete for ${date}; no notification is needed.`
  };
}

export async function queryResourceOptimiserDay({
  date,
  query = queryLogwork
} = {}) {
  const result = await query({
    date,
    includeEntries: false
  });
  const bookedHours = roundHours(result?.totals?.bookedHours);
  const loggedHours = roundHours(result?.totals?.loggedHours);
  const remainingHours = roundHours(Math.max(0, bookedHours - loggedHours));
  let status = 'complete';
  if (bookedHours === 0 && loggedHours === 0) {
    status = 'not_expected';
  } else if (remainingHours > 0) {
    status = 'incomplete';
  }
  return {
    target: 'ro',
    status,
    bookedHours,
    loggedHours,
    remainingHours
  };
}

export async function queryJiraWorklogDay({
  date,
  getSession = getStoredJiraSession,
  searchIssues = searchJiraIssues
} = {}) {
  assertDateOnly(date);
  const session = await getSession();
  const jql = `worklogAuthor = currentUser() AND worklogDate = "${date}"`;
  const issues = await searchIssues(session.token, {
    jql,
    fields: ['key', 'summary'],
    pageSize: 100
  }, {
    baseUrl: session.baseUrl
  });
  return {
    target: 'jira',
    status: issues.length ? 'complete' : 'incomplete',
    issueCount: issues.length,
    issues: issues.map((issue) => ({
      key: issue.key,
      summary: issue.summary
    }))
  };
}

// Counts today's commits in the given repos with the read-only commit draft
// (no RO query: the reminder already has the RO totals). Throws when no repo
// could be read, so the caller falls back to the plain message.
export async function summarizeTodayCommits({
  date,
  repos,
  draft = draftLogworkFromCommits,
  cwd = helperHome(),
  timeoutMs = COMMIT_SUMMARY_TIMEOUT_MS
} = {}) {
  const result = await withTimeout(
    draft({ from: date, repos, useBookings: false, cwd }),
    timeoutMs,
    'Reading commits timed out.'
  );
  const repoResults = Array.isArray(result?.repos) ? result.repos : [];
  const readable = repoResults.filter((repo) => !repo.error);
  if (!readable.length) {
    throw new Error('None of the reminder repos could be read.');
  }
  const active = readable
    .map((repo) => ({ name: repoDisplayName(repo.path), commitCount: Number(repo.commitCount || 0) }))
    .filter((repo) => repo.commitCount > 0)
    .sort((a, b) => b.commitCount - a.commitCount || a.name.localeCompare(b.name));
  return {
    status: 'ok',
    commitCount: Number(result.commitCount || 0),
    repoCount: active.length,
    repos: active,
    readRepoCount: readable.length,
    failedRepoCount: repoResults.length - readable.length
  };
}

// Reminder repos plus any `repos` listed on project mappings in the local
// config. Mapping repos are optional and read defensively.
export async function collectReminderRepos({
  config,
  loadMappings = loadLocalConfig,
  cwd = helperHome()
} = {}) {
  const repos = [...(Array.isArray(config?.repos) ? config.repos : [])];
  let mappings = [];
  try {
    mappings = (await loadMappings(cwd))?.projectMappings || [];
  } catch {
    mappings = [];
  }
  for (const mapping of Array.isArray(mappings) ? mappings : []) {
    if (!Array.isArray(mapping?.repos)) {
      continue;
    }
    for (const repo of mapping.repos) {
      try {
        repos.push(...normalizeReminderRepos([repo], { cwd }));
      } catch {
        // Skip a malformed mapping path.
      }
    }
  }
  return [...new Set(repos)];
}

// No header line: the title already says Logwork, and the banner shows only a
// few lines, so the RO/Jira status and the commits come first.
export function buildReminderNotification({ title = 'Logwork', problemLines = [], commits = null } = {}) {
  const hasCommits = commits?.status === 'ok' && commits.commitCount > 0;
  return {
    title,
    message: [
      ...problemLines,
      ...(hasCommits ? formatCommitLines(commits) : []),
      '',
      hasCommits ? COMMITS_ACTION_LINE : DEFAULT_ACTION_LINE
    ].join('\n')
  };
}

// "Hôm nay 5 commit:" then one "  • <repo>: <n>" line per repo, busiest
// first. Without per-repo counts (an older summary shape) it falls back to the
// plain totals line.
export function formatCommitLines(commits) {
  const repos = Array.isArray(commits?.repos)
    ? commits.repos.filter((repo) => repo?.name && Number(repo.commitCount) > 0)
    : [];
  if (!repos.length) {
    return [`Hôm nay: ${commits.commitCount} commit trong ${commits.repoCount} repo`];
  }
  const named = repos.slice(0, MAX_NAMED_REPOS).map((repo) => `  • ${repo.name}: ${repo.commitCount}`);
  const rest = repos.length - named.length;
  return [
    `Hôm nay ${commits.commitCount} commit:`,
    ...named,
    ...(rest > 0 ? [`  • +${rest} repo khác`] : [])
  ];
}

function repoDisplayName(repoPath) {
  const trimmed = String(repoPath || '').replace(/[\\/]+$/, '');
  return basename(trimmed) || trimmed || 'repo';
}

export async function runScheduledReminder({
  loadConfig = loadReminderConfig,
  collectRepos = collectReminderRepos,
  loadState = loadReminderState,
  saveState = saveReminderState,
  check = checkLogworkReminder,
  notify = sendOsNotification,
  now = () => new Date(),
  statePath = reminderStatePath(),
  lockOptions = {}
} = {}) {
  return withFileLock(statePath, async () => {
    const config = await loadConfig();
    const current = now();
    const date = todayLocalDateISO(current);
    const runAt = current.toISOString();

    if (!config.enabled) {
      return {
        status: 'disabled',
        notified: false,
        summary: 'Logwork reminder is disabled.'
      };
    }
    if (!config.days.includes(current.getDay())) {
      const result = {
        status: 'skipped_non_workday',
        notified: false,
        summary: 'Logwork reminder skipped because today is not a configured workday.'
      };
      await saveState(buildState(result, { date, runAt }));
      return result;
    }

    const previous = await loadState();
    if (previous?.lastNotifiedDate === date) {
      const result = {
        status: 'already_notified',
        notified: false,
        summary: `Logwork reminder already notified on ${date}.`
      };
      await saveState(buildState(result, {
        date,
        runAt,
        lastNotifiedDate: previous.lastNotifiedDate
      }));
      return result;
    }

    const repos = await collectRepos({ config }).catch(() => []);
    const checkResult = await check({
      target: config.target,
      date,
      repos
    });
    if (!checkResult.notify) {
      const result = {
        ...checkResult,
        notified: false
      };
      await saveState(buildState(result, { date, runAt }));
      return result;
    }

    try {
      await notify(checkResult.notification);
    } catch (error) {
      const result = {
        status: 'notification_failed',
        notified: false,
        summary: 'Logwork reminder was required but the OS notification failed.',
        error: redactText(error.message)
      };
      await saveState(buildState(result, { date, runAt }));
      throw error;
    }

    const result = {
      ...checkResult,
      status: 'notified',
      notified: true
    };
    await saveState(buildState(result, {
      date,
      runAt,
      lastNotifiedDate: date
    }));
    return result;
  }, lockOptions);
}

export async function sendTestReminderNotification({
  target = 'both',
  notify = sendOsNotification
} = {}) {
  const lines = [];
  if (target === 'ro' || target === 'both') {
    lines.push('RO: 6/8h, còn thiếu 2h');
  }
  if (target === 'jira' || target === 'both') {
    lines.push('Jira: chưa có worklog hôm nay');
  }
  if (!lines.length) {
    throw new Error('Reminder target must be ro, jira, or both.');
  }
  // Sample data in the real message format, including the commit line a
  // reminder with repos shows when RO hours are missing.
  const notification = buildReminderNotification({
    title: 'Logwork (thử nghiệm)',
    problemLines: lines,
    commits: target === 'jira' ? null : {
      status: 'ok',
      commitCount: 5,
      repoCount: 2,
      repos: [{ name: 'teammates', commitCount: 3 }, { name: 'logwork-cli', commitCount: 2 }]
    }
  });
  const result = await notify(notification);
  return {
    status: 'sent',
    target,
    notification,
    platform: result?.platform || process.platform,
    summary: `Sent a test logwork notification for ${target}.`
  };
}

async function runReminderCheck(target, operation) {
  try {
    return await operation();
  } catch (error) {
    const authRequired = target === 'ro'
      ? isAuthRequiredError(error)
      : isJiraAuthRequiredError(error);
    return {
      target,
      status: authRequired ? 'auth_required' : 'unavailable',
      error: authRequired ? '' : redactText(error.message).slice(0, 500)
    };
  }
}

function buildProblemLines(checks) {
  const lines = [];
  if (checks.ro?.status === 'incomplete') {
    lines.push(`RO: ${formatHours(checks.ro.loggedHours)}/${formatHours(checks.ro.bookedHours)}h, còn thiếu ${formatHours(checks.ro.remainingHours)}h`);
  } else if (checks.ro?.status === 'auth_required') {
    lines.push('RO: chưa đăng nhập, chạy logwork login');
  } else if (checks.ro?.status === 'unavailable') {
    lines.push('RO: không thể kiểm tra trạng thái');
  }

  if (checks.jira?.status === 'incomplete') {
    lines.push('Jira: chưa có worklog hôm nay');
  } else if (checks.jira?.status === 'auth_required') {
    lines.push('Jira: chưa đăng nhập, chạy logwork login jira');
  } else if (checks.jira?.status === 'unavailable') {
    lines.push('Jira: không thể kiểm tra trạng thái');
  }
  return lines;
}

function buildState(result, { date, runAt, lastNotifiedDate = '' }) {
  return {
    lastRunAt: runAt,
    lastRunDate: date,
    lastStatus: result.status,
    lastNotifiedDate,
    summary: result.summary,
    error: result.error || ''
  };
}

function roundHours(value) {
  return Number(Number(value || 0).toFixed(2));
}

function formatHours(value) {
  return Number(value || 0).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

function assertDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) {
    throw new Error('Reminder date must use YYYY-MM-DD format.');
  }
}
