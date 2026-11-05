import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuthRequiredError } from '../lib/auth-errors.mjs';
import { createJiraAuthRequiredError } from '../lib/jira-auth.mjs';
import {
  defaultReminderConfig,
  loadReminderConfig,
  normalizeReminderConfig,
  saveReminderConfig
} from '../lib/reminder-config.mjs';
import {
  buildMacosReminderPlist,
  buildWindowsReminderCreateArgs,
  installReminderScheduler
} from '../lib/reminder-scheduler.mjs';
import {
  enableLogworkReminder,
  getLogworkReminderStatus
} from '../lib/reminder-service.mjs';
import {
  loadReminderState,
  saveReminderState
} from '../lib/reminder-state.mjs';
import {
  checkLogworkReminder,
  queryJiraWorklogDay,
  queryResourceOptimiserDay,
  runScheduledReminder,
  sendTestReminderNotification
} from '../lib/reminder-workflow.mjs';
import {
  runPowerShellToast,
  sendMacosNotification,
  sendOsNotification
} from '../lib/os-notification.mjs';
import { parseReminderArgs, runReminderCli } from '../reminder-cli.mjs';

test('reminder config defaults to weekdays at 17:00 for both targets', async () => {
  assert.deepEqual(defaultReminderConfig(), {
    enabled: false,
    time: '17:00',
    target: 'both',
    days: [1, 2, 3, 4, 5]
  });
  assert.throws(() => normalizeReminderConfig({ time: '25:00' }), /HH:mm/);
  assert.throws(() => normalizeReminderConfig({ target: 'email' }), /ro, jira, or both/);
  assert.throws(() => normalizeReminderConfig({ days: [0, 1] }), /Monday through Friday/);

  const dir = await mkdtemp(join(tmpdir(), 'logwork-reminder-config-'));
  const path = join(dir, 'reminder.json');
  await saveReminderConfig({ enabled: true, time: '18:05', target: 'ro', days: [1, 3, 5] }, { path });
  assert.deepEqual(await loadReminderConfig({ path }), {
    enabled: true,
    time: '18:05',
    target: 'ro',
    days: [1, 3, 5]
  });
});

test('reminder state is local, sanitized, and redacts token-shaped errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'logwork-reminder-state-'));
  const path = join(dir, 'reminder-state.json');
  await saveReminderState({
    lastRunAt: '2026-07-15T10:30:00.000Z',
    lastRunDate: '2026-07-15',
    lastStatus: 'notification_failed',
    error: 'token=secret-value\nsecond line'
  }, { path });
  const state = await loadReminderState({ path });
  assert.match(state.error, /token=<redacted>/);
  assert.doesNotMatch(await readFile(path, 'utf8'), /secret-value/);
  assert.doesNotMatch(state.error, /\n/);
});

test('macOS reminder plist schedules configured weekdays with stable runner paths', () => {
  const plist = buildMacosReminderPlist({
    config: { enabled: true, time: '17:00', target: 'both', days: [1, 2, 3, 4, 5] },
    nodePath: '/opt/homebrew/bin/node',
    runnerPath: '/Users/test/.logwork-helper/reminder-cli.mjs',
    home: '/Users/test/.logwork-helper'
  });
  assert.match(plist, /sg\.vinova\.logwork-helper\.reminder/);
  assert.equal((plist.match(/<key>Weekday<\/key>/g) || []).length, 5);
  assert.match(plist, /<key>Hour<\/key><integer>17<\/integer>/);
  assert.match(plist, /<key>Minute<\/key><integer>0<\/integer>/);
  assert.match(plist, /reminder-cli\.mjs/);
  assert.match(plist, /--home/);
});

test('Windows reminder task uses weekly weekdays and a fixed Node runner action', () => {
  const args = buildWindowsReminderCreateArgs({
    config: { enabled: true, time: '17:00', target: 'both', days: [1, 2, 3, 4, 5] },
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    runnerPath: 'C:\\Users\\test\\.logwork-helper\\reminder-cli.mjs',
    home: 'C:\\Users\\test\\.logwork-helper'
  });
  assert.deepEqual(args.slice(0, 4), ['/Create', '/TN', 'Logwork Helper Reminder', '/TR']);
  assert.match(args[4], /^"C:\\Program Files\\nodejs\\node\.exe"/);
  assert.match(args[4], /reminder-cli\.mjs/);
  assert.equal(args[args.indexOf('/SC') + 1], 'WEEKLY');
  assert.equal(args[args.indexOf('/D') + 1], 'MON,TUE,WED,THU,FRI');
  assert.equal(args[args.indexOf('/ST') + 1], '17:00');
  assert.ok(args.includes('/IT'));
  assert.ok(args.includes('/F'));
});

test('scheduler installation tolerates missing old macOS job and requires bootstrap success', async () => {
  const calls = [];
  let writtenPath;
  const result = await installReminderScheduler({
    enabled: true,
    time: '17:00',
    target: 'both',
    days: [1, 2, 3, 4, 5]
  }, {
    platform: 'darwin',
    nodePath: '/usr/local/bin/node',
    home: '/Users/test/.logwork-helper',
    userHome: '/Users/test',
    uid: 501,
    accessRunner: async () => {},
    writeFile: async (path) => { writtenPath = path; },
    run: async (command, args) => {
      calls.push({ command, args });
      return { code: args[0] === 'bootout' ? 113 : 0, stdout: '', stderr: '' };
    }
  });
  assert.match(writtenPath, /Library\/LaunchAgents/);
  assert.equal(calls[0].args[0], 'bootout');
  assert.equal(calls[1].args[0], 'bootstrap');
  assert.equal(result.installed, true);
});

test('OS notification adapter routes macOS and Windows without interpolating messages into scripts', async () => {
  const calls = [];
  await sendOsNotification({
    title: 'Logwork "Helper"',
    message: 'RO: 6/8h',
    platform: 'darwin',
    macNotifier: async (notification) => { calls.push(notification); }
  });
  assert.deepEqual(calls[0], {
    title: 'Logwork "Helper"',
    message: 'RO: 6/8h'
  });

  let script;
  let args;
  await sendMacosNotification(calls[0], {
    run: async (scriptValue, argsValue) => {
      script = scriptValue;
      args = argsValue;
    }
  });
  assert.doesNotMatch(script, /6\/8h/);
  assert.deepEqual(args, ['Logwork "Helper"', 'RO: 6/8h']);
});

test('Windows notification runner sends UTF-8 JSON through PowerShell stdin', async () => {
  let stdinText = '';
  const child = fakeChildProcess((value) => { stdinText = value; });
  await runPowerShellToast({
    title: 'Logwork Helper',
    message: 'Còn thiếu 2h'
  }, {
    spawnFn(command, args, options) {
      assert.equal(command, 'powershell.exe');
      assert.deepEqual(args.slice(0, 4), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']);
      assert.equal(options.windowsHide, true);
      return child;
    }
  });
  assert.deepEqual(JSON.parse(stdinText), {
    title: 'Logwork Helper',
    message: 'Còn thiếu 2h'
  });
});

test('smart reminder compares RO hours and detects Jira worklog presence', async () => {
  assert.deepEqual(await queryResourceOptimiserDay({
    date: '2026-07-15',
    query: async () => ({ totals: { bookedHours: 8, loggedHours: 6 } })
  }), {
    target: 'ro',
    status: 'incomplete',
    bookedHours: 8,
    loggedHours: 6,
    remainingHours: 2
  });

  let searchInput;
  const jira = await queryJiraWorklogDay({
    date: '2026-07-15',
    getSession: async () => ({ token: 'pat', baseUrl: 'https://jira.example.com' }),
    searchIssues: async (token, input, options) => {
      searchInput = { token, input, options };
      return [{ key: 'SCB-213', summary: 'Task' }];
    }
  });
  assert.equal(jira.status, 'complete');
  assert.equal(jira.issueCount, 1);
  assert.equal(searchInput.input.jql, 'worklogAuthor = currentUser() AND worklogDate = "2026-07-15"');
  assert.equal(searchInput.options.baseUrl, 'https://jira.example.com');
});

test('smart Both reminder builds one concise notification for missing RO and Jira worklogs', async () => {
  const result = await checkLogworkReminder({
    target: 'both',
    date: '2026-07-15',
    queryRo: async () => ({ target: 'ro', status: 'incomplete', bookedHours: 8, loggedHours: 6, remainingHours: 2 }),
    queryJira: async () => ({ target: 'jira', status: 'incomplete', issueCount: 0, issues: [] })
  });
  assert.equal(result.notify, true);
  assert.match(result.notification.message, /RO: 6\/8h, còn thiếu 2h/);
  assert.match(result.notification.message, /Jira: chưa có worklog hôm nay/);
  assert.match(result.notification.message, /Mở Terminal và chạy: logwork/);
});

test('smart reminder stays silent when enabled targets are complete', async () => {
  const result = await checkLogworkReminder({
    target: 'both',
    date: '2026-07-15',
    queryRo: async () => ({ target: 'ro', status: 'complete', bookedHours: 8, loggedHours: 8, remainingHours: 0 }),
    queryJira: async () => ({ target: 'jira', status: 'complete', issueCount: 1, issues: [{ key: 'SCB-213' }] })
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.notify, false);
  assert.equal(result.notification, null);
});

test('smart reminder converts missing credentials into actionable notification text', async () => {
  const result = await checkLogworkReminder({
    target: 'both',
    queryRo: async () => { throw createAuthRequiredError(); },
    queryJira: async () => { throw createJiraAuthRequiredError(); }
  });
  assert.equal(result.checks.ro.status, 'auth_required');
  assert.equal(result.checks.jira.status, 'auth_required');
  assert.match(result.notification.message, /logwork-helper auth login/);
  assert.match(result.notification.message, /logwork-helper jira login/);
});

test('scheduled reminder notifies once per day and persists sanitized status', async () => {
  const states = [];
  const notifications = [];
  const now = () => new Date(2026, 6, 15, 17, 30, 0);
  const baseOptions = {
    loadConfig: async () => ({ enabled: true, time: '17:00', target: 'both', days: [1, 2, 3, 4, 5] }),
    loadState: async () => null,
    saveState: async (state) => { states.push(state); },
    check: async () => ({
      status: 'notification_required',
      notify: true,
      notification: { title: 'Logwork Helper', message: 'Missing logwork' },
      summary: 'Missing logwork'
    }),
    notify: async (notification) => { notifications.push(notification); },
    now,
    statePath: join(await mkdtemp(join(tmpdir(), 'logwork-reminder-run-')), 'state.json')
  };
  const first = await runScheduledReminder(baseOptions);
  assert.equal(first.status, 'notified');
  assert.equal(notifications.length, 1);
  assert.equal(states[0].lastNotifiedDate, '2026-07-15');

  const second = await runScheduledReminder({
    ...baseOptions,
    loadState: async () => states[0]
  });
  assert.equal(second.status, 'already_notified');
  assert.equal(notifications.length, 1);
});

test('scheduled reminder skips disabled config and non-workdays', async () => {
  const disabled = await runScheduledReminder({
    loadConfig: async () => ({ enabled: false, time: '17:00', target: 'both', days: [1, 2, 3, 4, 5] }),
    statePath: join(await mkdtemp(join(tmpdir(), 'logwork-reminder-disabled-')), 'state.json')
  });
  assert.equal(disabled.status, 'disabled');

  let saved;
  const weekend = await runScheduledReminder({
    loadConfig: async () => ({ enabled: true, time: '17:00', target: 'both', days: [1, 2, 3, 4, 5] }),
    saveState: async (state) => { saved = state; },
    now: () => new Date(2026, 6, 18, 17, 30, 0),
    statePath: join(await mkdtemp(join(tmpdir(), 'logwork-reminder-weekend-')), 'state.json')
  });
  assert.equal(weekend.status, 'skipped_non_workday');
  assert.equal(saved.lastStatus, 'skipped_non_workday');
});

test('reminder service requires confirmation and reports scheduler consistency', async () => {
  await assert.rejects(() => enableLogworkReminder({ confirm: false }), /requires confirm: true/);
  let saved;
  const enabled = await enableLogworkReminder({
    time: '18:00',
    target: 'jira',
    confirm: true,
    loadConfig: async () => defaultReminderConfig(),
    installScheduler: async () => ({ installed: true, scheduler: 'test-scheduler' }),
    saveConfig: async (config) => { saved = config; return config; }
  });
  assert.equal(saved.enabled, true);
  assert.equal(enabled.config.time, '18:00');
  assert.equal(enabled.config.target, 'jira');

  const status = await getLogworkReminderStatus({
    loadConfig: async () => saved,
    loadState: async () => ({ lastRunAt: '2026-07-15T10:30:00.000Z', lastStatus: 'complete' }),
    schedulerStatus: async () => ({ installed: true, scheduler: 'test-scheduler' })
  });
  assert.equal(status.consistent, true);
  assert.match(status.summary, /Monday-Friday at 18:00/);
});

test('reminder test notification and CLI require explicit confirmation', async () => {
  let notification;
  const sent = await sendTestReminderNotification({
    target: 'both',
    notify: async (value) => {
      notification = value;
      return { platform: 'darwin' };
    }
  });
  assert.equal(sent.status, 'sent');
  assert.match(notification.message, /Đây là notification thử nghiệm/);

  assert.equal(parseReminderArgs(['enable', '--time', '18:00', '--target', 'jira', '--yes']).target, 'jira');
  assert.throws(() => parseReminderArgs(['enable', '--time', '28:00']), /HH:mm/);
  assert.throws(() => parseReminderArgs(['status', '--target', 'ro']), /only valid/);
  await assert.rejects(() => runReminderCli(['test'], {
    isTTY: false
  }), /Re-run with --yes/);

  let tested;
  await runReminderCli(['test', '--target', 'ro', '--yes'], {
    test: async (options) => {
      tested = options;
      return { status: 'sent', summary: 'Sent.' };
    },
    print() {}
  });
  assert.deepEqual(tested, { target: 'ro', confirm: true });
});

function fakeChildProcess(onStdin) {
  const child = {
    stdout: fakeStream(),
    stderr: fakeStream(),
    stdin: {
      end(value) {
        onStdin(value);
        queueMicrotask(() => {
          child.stdout.emitData('{"ok":true}');
          child.on_close(0);
        });
      }
    },
    on(event, handler) {
      child[`on_${event}`] = handler;
    }
  };
  return child;
}

function fakeStream() {
  return {
    setEncoding() {},
    on(event, handler) {
      this[`on_${event}`] = handler;
    },
    emitData(value) {
      this.on_data?.(value);
    }
  };
}
