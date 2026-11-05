import { isAuthRequiredError } from './auth-errors.mjs';
import { redactText } from './auth-redaction.mjs';
import { withFileLock } from './file-lock.mjs';
import { searchJiraIssues } from './jira-api.mjs';
import {
  getStoredJiraSession,
  isJiraAuthRequiredError
} from './jira-auth.mjs';
import { sendOsNotification } from './os-notification.mjs';
import { reminderStatePath } from './paths.mjs';
import { queryLogwork } from './query-workflow.mjs';
import { loadReminderConfig } from './reminder-config.mjs';
import {
  loadReminderState,
  saveReminderState
} from './reminder-state.mjs';
import { todayLocalDateISO } from './util.mjs';

export async function checkLogworkReminder({
  target = 'both',
  date = todayLocalDateISO(),
  queryRo = queryResourceOptimiserDay,
  queryJira = queryJiraWorklogDay
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
  const notification = notify ? {
    title: 'Logwork Helper',
    message: [
      'Logwork hôm nay chưa hoàn tất',
      ...problemLines,
      '',
      'Mở Terminal và chạy: logwork'
    ].join('\n')
  } : null;

  return {
    date,
    target,
    status: notify ? 'notification_required' : 'complete',
    notify,
    checks,
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

export async function runScheduledReminder({
  loadConfig = loadReminderConfig,
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

    const checkResult = await check({
      target: config.target,
      date
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
  const notification = {
    title: 'Logwork Helper',
    message: [
      'Đây là notification thử nghiệm',
      ...lines,
      '',
      'Mở Terminal và chạy: logwork'
    ].join('\n')
  };
  const result = await notify(notification);
  return {
    status: 'sent',
    target,
    notification,
    platform: result?.platform || process.platform,
    summary: `Sent a test Logwork Helper notification for ${target}.`
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
    lines.push('RO: chưa đăng nhập, chạy logwork-helper auth login');
  } else if (checks.ro?.status === 'unavailable') {
    lines.push('RO: không thể kiểm tra trạng thái');
  }

  if (checks.jira?.status === 'incomplete') {
    lines.push('Jira: chưa có worklog hôm nay');
  } else if (checks.jira?.status === 'auth_required') {
    lines.push('Jira: chưa đăng nhập, chạy logwork-helper jira login');
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

function assertDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) {
    throw new Error('Reminder date must use YYYY-MM-DD format.');
  }
}
