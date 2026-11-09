import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isInsideGitWorkTree, run as runCommits } from '../commands/commits.mjs';
import { parseReminderArgs, runReminderCli } from '../commands/reminder.mjs';
import {
  loadReminderConfig,
  normalizeReminderRepos,
  saveReminderConfig
} from '../lib/reminder-config.mjs';
import { enableLogworkReminder } from '../lib/reminder-service.mjs';
import {
  buildReminderNotification,
  checkLogworkReminder,
  collectReminderRepos,
  runScheduledReminder,
  sendTestReminderNotification,
  summarizeTodayCommits
} from '../lib/reminder-workflow.mjs';

const RO_INCOMPLETE = async () => ({ target: 'ro', status: 'incomplete', bookedHours: 8, loggedHours: 4, remainingHours: 4 });
const JIRA_INCOMPLETE = async () => ({ target: 'jira', status: 'incomplete', issueCount: 0, issues: [] });

test('reminder repos are normalized to unique absolute paths', async () => {
  const cwd = resolve(tmpdir(), 'work');
  assert.deepEqual(normalizeReminderRepos([
    'app',
    './app/',
    '~/code/api',
    '',
    '  ',
    resolve(tmpdir(), 'abs')
  ], { cwd, home: '/home/me' }), [
    resolve(cwd, 'app'),
    resolve('/home/me/code/api'),
    resolve(tmpdir(), 'abs')
  ]);
  assert.deepEqual(normalizeReminderRepos(undefined), []);
  assert.throws(() => normalizeReminderRepos('repo'), /list of paths/);
  assert.throws(() => normalizeReminderRepos(['a\nb']), /control characters/);
  assert.throws(() => normalizeReminderRepos(Array.from({ length: 21 }, (_, index) => `/r${index}`)), /limited to 20/);
  assert.equal(normalizeReminderRepos(['~'])[0], resolve(homedir()));

  const dir = await mkdtemp(join(tmpdir(), 'logwork-reminder-repos-'));
  const path = join(dir, 'reminder.json');
  await saveReminderConfig({ enabled: true, time: '17:00', target: 'ro', days: [1], repos: [dir, dir] }, { path });
  assert.deepEqual((await loadReminderConfig({ path })).repos, [resolve(dir)]);
});

test('reminder enable --repo is repeatable, --no-repos clears, and both are enable-only', async () => {
  const parsed = parseReminderArgs(['enable', '--repo', 'a', '--repo=b', '--yes']);
  assert.deepEqual(parsed.repos, [resolve('a'), resolve('b')]);
  assert.deepEqual(parseReminderArgs(['enable', '--no-repos', '--yes']).repos, []);
  assert.equal(parseReminderArgs(['enable', '--yes']).repos, undefined);
  assert.throws(() => parseReminderArgs(['status', '--repo', 'a']), /only valid with reminder enable/);
  assert.throws(() => parseReminderArgs(['enable', '--repo']), /requires a path/);
  assert.throws(() => parseReminderArgs(['enable', '--repo', 'a', '--no-repos']), /cannot be combined/);

  let enabledWith;
  await runReminderCli(['enable', '--repo', '/tmp/a', '--yes'], {
    enable: async (options) => { enabledWith = options; return { summary: 'ok' }; },
    print() {}
  });
  assert.deepEqual(enabledWith.repos, [resolve('/tmp/a')]);
  await runReminderCli(['enable', '--yes'], {
    enable: async (options) => { enabledWith = options; return { summary: 'ok' }; },
    print() {}
  });
  assert.equal('repos' in enabledWith, false, 'no --repo keeps the saved list');
});

test('reminder enable replaces repos only when given', async () => {
  const saved = [];
  const options = {
    confirm: true,
    loadConfig: async () => ({ enabled: false, time: '17:00', target: 'both', days: [1, 2, 3, 4, 5], repos: ['/kept'] }),
    installScheduler: async () => ({ installed: true, scheduler: 'test-scheduler' }),
    saveConfig: async (config) => { saved.push(config); return config; }
  };
  const kept = await enableLogworkReminder(options);
  assert.deepEqual(kept.config.repos, [resolve('/kept')]);
  assert.match(kept.summary, /Commit summary repos:/);
  const replaced = await enableLogworkReminder({ ...options, repos: ['/new'] });
  assert.deepEqual(replaced.config.repos, [resolve('/new')]);
  const cleared = await enableLogworkReminder({ ...options, repos: [] });
  assert.deepEqual(cleared.config.repos, []);
  assert.match(cleared.summary, /No reminder repos set/);
});

test('reminder message adds commit evidence when RO hours are missing', async () => {
  let summarized;
  const result = await checkLogworkReminder({
    target: 'both',
    date: '2026-11-09',
    repos: ['/r1', '/r2'],
    queryRo: RO_INCOMPLETE,
    queryJira: JIRA_INCOMPLETE,
    summarizeCommits: async (input) => {
      summarized = input;
      return { status: 'ok', commitCount: 5, repoCount: 2, readRepoCount: 2, failedRepoCount: 0 };
    }
  });
  assert.deepEqual(summarized, { date: '2026-11-09', repos: ['/r1', '/r2'] });
  assert.equal(result.commits.commitCount, 5);
  assert.equal(result.notification.message, [
    'Logwork hôm nay chưa hoàn tất',
    'RO: 4/8h, còn thiếu 4h',
    'Jira: chưa có worklog hôm nay',
    'Hôm nay: 5 commit trong 2 repo',
    '',
    'Mở Terminal và chạy: logwork commits today (bản nháp từ commit)'
  ].join('\n'));
});

test('reminder message stays the same without repos, without commits, or when RO is not missing', async () => {
  const plain = [
    'Logwork hôm nay chưa hoàn tất',
    'RO: 4/8h, còn thiếu 4h',
    '',
    'Mở Terminal và chạy: logwork'
  ].join('\n');
  let calls = 0;
  const summarizeCommits = async () => { calls += 1; return { status: 'ok', commitCount: 0, repoCount: 0 }; };

  const noRepos = await checkLogworkReminder({ target: 'ro', date: '2026-11-09', queryRo: RO_INCOMPLETE, summarizeCommits });
  assert.equal(noRepos.notification.message, plain);
  assert.equal(calls, 0);
  assert.equal('commits' in noRepos, false);

  const noCommits = await checkLogworkReminder({ target: 'ro', date: '2026-11-09', repos: ['/r'], queryRo: RO_INCOMPLETE, summarizeCommits });
  assert.equal(noCommits.notification.message, plain);
  assert.equal(calls, 1);

  const jiraOnly = await checkLogworkReminder({
    target: 'both',
    date: '2026-11-09',
    repos: ['/r'],
    queryRo: async () => ({ target: 'ro', status: 'complete', bookedHours: 8, loggedHours: 8, remainingHours: 0 }),
    queryJira: JIRA_INCOMPLETE,
    summarizeCommits
  });
  assert.equal(calls, 1, 'commits are read only when RO hours are missing');
  assert.doesNotMatch(jiraOnly.notification.message, /commit/);
});

test('commit read failures fall back to the plain reminder message', async () => {
  const result = await checkLogworkReminder({
    target: 'ro',
    date: '2026-11-09',
    repos: ['/r'],
    queryRo: RO_INCOMPLETE,
    summarizeCommits: async () => { throw new Error('git failed token=secret-value'); }
  });
  assert.equal(result.notify, true);
  assert.equal(result.commits.status, 'unavailable');
  assert.doesNotMatch(result.commits.error, /secret-value/);
  assert.match(result.notification.message, /Mở Terminal và chạy: logwork$/);
  assert.doesNotMatch(result.notification.message, /commit/);

  await assert.rejects(() => summarizeTodayCommits({
    date: '2026-11-09',
    repos: ['/r'],
    draft: async () => ({ commitCount: 0, repos: [{ path: '/r', error: 'not a git repository', commitCount: 0 }] })
  }), /could be read/);
  await assert.rejects(() => summarizeTodayCommits({
    date: '2026-11-09',
    repos: ['/r'],
    timeoutMs: 10,
    draft: () => new Promise(() => {})
  }), /timed out/);
});

test('summarizeTodayCommits counts my commits today in real repos without querying RO', async () => {
  const today = '2026-11-09';
  const first = makeRepo();
  first.commit('a.txt', 'feat: one (SCB-1)', `${today}T09:00:00`);
  first.commit('b.txt', 'fix: two (SCB-2)', `${today}T10:00:00`);
  first.commit('c.txt', 'feat: yesterday', '2026-11-08T10:00:00');
  const second = makeRepo();
  second.commit('a.txt', 'docs: three', `${today}T11:00:00`);
  second.commit('b.txt', 'feat: not mine', `${today}T12:00:00`, 'Other <other@example.com>');
  const idle = makeRepo();
  idle.commit('a.txt', 'chore: old', '2026-11-01T10:00:00');
  const missing = join(tmpdir(), 'logwork-no-such-repo-for-test');

  const summary = await summarizeTodayCommits({
    date: today,
    repos: [first.dir, second.dir, idle.dir, missing]
  });
  assert.deepEqual(summary, {
    status: 'ok',
    commitCount: 3,
    repoCount: 2,
    readRepoCount: 3,
    failedRepoCount: 1
  });
});

test('scheduled reminder reads config and mapping repos and passes them to the check', async () => {
  const repos = await collectReminderRepos({
    config: { repos: ['/configured'] },
    cwd: '/home/me',
    loadMappings: async () => ({
      projectMappings: [
        { projectName: 'A' },
        { projectName: 'B', repos: 'not-a-list' },
        { projectName: 'C', repos: ['/mapped', '/configured', 'relative', 'bad\npath'] },
        null
      ]
    })
  });
  assert.deepEqual(repos, ['/configured', resolve('/mapped'), resolve('/configured'), resolve('/home/me', 'relative')].filter((value, index, all) => all.indexOf(value) === index));
  assert.deepEqual(await collectReminderRepos({ config: {}, loadMappings: async () => { throw new Error('bad config'); } }), []);

  let checkedWith;
  const result = await runScheduledReminder({
    loadConfig: async () => ({ enabled: true, time: '17:00', target: 'ro', days: [1, 2, 3, 4, 5], repos: ['/configured'] }),
    collectRepos: async ({ config }) => [...config.repos, '/mapped'],
    loadState: async () => null,
    saveState: async () => {},
    check: async (input) => {
      checkedWith = input;
      return { status: 'complete', notify: false, notification: null, summary: 'ok' };
    },
    now: () => new Date(2026, 10, 9, 17, 0, 0),
    statePath: join(await mkdtemp(join(tmpdir(), 'logwork-reminder-repos-run-')), 'state.json')
  });
  assert.equal(result.status, 'complete');
  assert.deepEqual(checkedWith, { target: 'ro', date: '2026-11-09', repos: ['/configured', '/mapped'] });

  // A failing repo lookup never stops the reminder.
  const fallback = await runScheduledReminder({
    loadConfig: async () => ({ enabled: true, time: '17:00', target: 'ro', days: [1, 2, 3, 4, 5], repos: [] }),
    collectRepos: async () => { throw new Error('boom'); },
    loadState: async () => null,
    saveState: async () => {},
    check: async (input) => {
      checkedWith = input;
      return { status: 'complete', notify: false, notification: null, summary: 'ok' };
    },
    now: () => new Date(2026, 10, 9, 17, 0, 0),
    statePath: join(await mkdtemp(join(tmpdir(), 'logwork-reminder-repos-fail-')), 'state.json')
  });
  assert.equal(fallback.status, 'complete');
  assert.deepEqual(checkedWith.repos, []);
});

test('reminder test notification shows the commit message format', async () => {
  let notification;
  await sendTestReminderNotification({
    target: 'both',
    notify: async (value) => { notification = value; return { platform: 'darwin' }; }
  });
  assert.match(notification.message, /^Đây là notification thử nghiệm\nRO: 6\/8h, còn thiếu 2h\nJira: chưa có worklog hôm nay\nHôm nay: 5 commit trong 2 repo\n\nMở Terminal và chạy: logwork commits today/);

  await sendTestReminderNotification({
    target: 'jira',
    notify: async (value) => { notification = value; return {}; }
  });
  assert.doesNotMatch(notification.message, /commit/);
  assert.equal(buildReminderNotification({ problemLines: ['x'] }).title, 'Logwork');
});

test('logwork commits falls back to the reminder repos outside a git repo', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'logwork-not-a-repo-'));
  const repo = makeRepo();
  assert.equal(isInsideGitWorkTree(outside), false);
  assert.equal(isInsideGitWorkTree(join(repo.dir)), true);

  const calls = [];
  const printed = [];
  const draft = async (input) => { calls.push(input); return { summary: 'draft' }; };
  await runCommits(['today', '--no-bookings'], {
    draft,
    cwd: outside,
    reminderRepos: async () => ['/r1', '/r2'],
    print: (line) => printed.push(line)
  });
  assert.deepEqual(calls[0].repos, ['/r1', '/r2']);
  assert.match(printed[0], /using the reminder repos: \/r1, \/r2\n\ndraft/);

  await runCommits(['today'], { draft, cwd: repo.dir, reminderRepos: async () => ['/r1'], print() {} });
  assert.deepEqual(calls[1].repos, [], 'inside a repo the current directory is used');

  await runCommits(['today', '--repo', '/explicit'], { draft, cwd: outside, reminderRepos: async () => ['/r1'], print() {} });
  assert.deepEqual(calls[2].repos, ['/explicit']);

  await runCommits(['today'], { draft, cwd: outside, reminderRepos: async () => [], print() {} });
  assert.deepEqual(calls[3].repos, []);
});

function git(cwd, args, env = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'logwork-reminder-commits-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'me@example.com']);
  git(dir, ['config', 'user.name', 'Me']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  const commit = (file, message, when, author = 'Me <me@example.com>') => {
    writeFileSync(join(dir, file), `${message}\n`);
    git(dir, ['add', file]);
    git(dir, ['commit', '-q', '-m', message, `--author=${author}`, `--date=${when}`], { GIT_COMMITTER_DATE: when });
  };
  return { dir, commit };
}
