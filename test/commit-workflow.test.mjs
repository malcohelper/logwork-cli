import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  allocateHours,
  buildDescription,
  classifyCommit,
  draftLogworkFromCommits,
  formatDayHeading,
  groupCommits,
  parseGitLog,
  remainingHoursByDay
} from '../lib/commit-workflow.mjs';

test('commits are classified by conventional type, then subject keywords, then body', () => {
  assert.equal(classifyCommit('feat(auth): add SSO login'), 'feature');
  assert.equal(classifyCommit('fix: date picker timezone'), 'fix');
  assert.equal(classifyCommit('perf: cache task list'), 'refactor');
  assert.equal(classifyCommit('test(e2e): cover logout'), 'test');
  assert.equal(classifyCommit('ci: publish on tag'), 'release');
  assert.equal(classifyCommit('docs: update README'), 'design');
  assert.equal(classifyCommit('chore: tidy deps'), 'other');
  assert.equal(classifyCommit('Hotfix crash on empty list'), 'fix');
  assert.equal(classifyCommit('release v1.0.0: rename package'), 'release');
  assert.equal(classifyCommit('Add filters to report page', 'Fixes the export too'), 'fix');
  assert.equal(classifyCommit('Add filters to report page'), 'feature');
});

test('git log output is parsed with numstat totals', () => {
  const output = [
    '\x1eaaa111\x1f1762416000\x1fMalco\x1fmalco@example.com\x1ffeat: add SSO (STM-4)\x1fbody text\x1f',
    '10\t2\tsrc/a.js',
    '-\t-\tlogo.png',
    '',
    '\x1ebbb222\x1f1762419600\x1fMalco\x1fmalco@example.com\x1ffix: logout (STM-5)\x1f\x1f',
    '1\t1\tsrc/b.js'
  ].join('\n');
  const commits = parseGitLog(output);
  assert.equal(commits.length, 2);
  assert.deepEqual(
    { hash: commits[0].hash, files: commits[0].files, additions: commits[0].additions, deletions: commits[0].deletions, body: commits[0].body },
    { hash: 'aaa111', files: 2, additions: 10, deletions: 2, body: 'body text' }
  );
  assert.equal(commits[1].subject, 'fix: logout (STM-5)');
});

test('commits group per repo + ticket + kind and build descriptions without "|"', () => {
  const base = { repo: '/code/portal', additions: 10, deletions: 0, body: '' };
  const groups = groupCommits([
    { ...base, hash: 'a1', timestamp: 1, subject: 'feat: login form (SAP-1)' },
    { ...base, hash: 'a2', timestamp: 2, subject: 'feat: login API | wiring (SAP-1)' },
    { ...base, hash: 'a3', timestamp: 3, subject: 'fix: login redirect (SAP-1)' },
    { ...base, hash: 'a4', timestamp: 4, subject: 'chore: bump deps' }
  ]);
  assert.equal(groups.length, 3);
  const feature = groups.find((group) => group.kind === 'feature');
  assert.equal(feature.task, 'Feature Development');
  assert.equal(feature.commitCount, 2);
  assert.equal(feature.description, 'login form; login API / wiring (SAP-1)');
  assert.equal(groups.find((group) => group.kind === 'fix').task, 'Bug Fix');
  assert.equal(groups.find((group) => group.kind === 'other').description, 'bump deps');
  assert.ok(buildDescription({ subjects: ['x'.repeat(500)], tickets: ['SAP-1'], repoName: 'r' }).length <= 240);
});

test('hours are split in 0.5h steps by weight, every funded group gets a step', () => {
  assert.deepEqual(allocateHours([{ weight: 3 }, { weight: 1 }], 4), [3, 1]);
  assert.deepEqual(allocateHours([{ weight: 1 }, { weight: 1 }, { weight: 1 }], 1), [0.5, 0.5, 0]);
  assert.deepEqual(allocateHours([{ weight: 5 }, { weight: 1 }], 2.4), [1.5, 0.5]);
  assert.deepEqual(allocateHours([{ weight: 1 }], 0), [0]);
  const split = allocateHours([{ weight: 2 }, { weight: 2 }, { weight: 1 }], 8);
  assert.equal(split.reduce((sum, hours) => sum + hours, 0), 8);
});

test('RO remaining time is summed per project so over-logging does not hide gaps', () => {
  const byDay = remainingHoursByDay({
    days: [{
      date: '2026-11-06',
      bookedHours: 10.4,
      loggedHours: 9.5,
      projects: [
        { bookedHours: 0, loggedHours: 1.5 },
        { bookedHours: 2.4, loggedHours: 0 },
        { bookedHours: 4, loggedHours: 4 },
        { bookedHours: 4, loggedHours: 4 }
      ]
    }]
  });
  assert.deepEqual(byDay.get('2026-11-06'), { bookedHours: 10.4, loggedHours: 9.5, remainingHours: 2.4 });
  assert.equal(formatDayHeading('2026-11-06'), 'Friday, 06 Nov 2026');
});

function git(cwd, args, env = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'logwork-commits-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'me@example.com']);
  git(dir, ['config', 'user.name', 'Me']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  const commit = (file, message, when, author = 'Me <me@example.com>') => {
    writeFileSync(join(dir, file), `${message}\n`.repeat(20));
    git(dir, ['add', file]);
    git(dir, ['commit', '-q', '-m', message, `--author=${author}`, `--date=${when}`], { GIT_COMMITTER_DATE: when });
  };
  return { dir, commit };
}

test('draftLogworkFromCommits reads a real repo, keeps only my commits, and fills RO remaining hours', async () => {
  const { dir, commit } = makeRepo();
  commit('a.txt', 'feat: SSO login with ADFS (STM-4)', '2026-11-06T09:00:00');
  commit('b.txt', 'feat: SSO callback (STM-4)', '2026-11-06T11:00:00');
  commit('c.txt', 'fix: date picker timezone (SAP-42)', '2026-11-06T15:00:00');
  commit('d.txt', 'feat: someone else', '2026-11-06T16:00:00', 'Other <other@example.com>');
  commit('e.txt', 'feat: weekend hack (STM-9)', '2026-11-07T10:00:00');
  git(dir, ['checkout', '-q', '-b', 'feature/x']);
  commit('f.txt', 'test: SSO e2e (STM-4)', '2026-11-06T17:00:00');
  git(dir, ['checkout', '-q', 'main']);
  writeFileSync(join(dir, 'a.txt'), 'stashed change');
  git(dir, ['stash', '-q']);

  const result = await draftLogworkFromCommits({
    from: '2026-11-06',
    to: '2026-11-08',
    repos: [dir],
    queryRo: async ({ from, to }) => {
      assert.deepEqual({ from, to }, { from: '2026-11-06', to: '2026-11-08' });
      return {
        days: [
          { date: '2026-11-06', bookedHours: 8, loggedHours: 2, projects: [{ bookedHours: 8, loggedHours: 2 }] }
        ]
      };
    }
  });

  assert.equal(result.status, 'draft');
  assert.equal(result.commitCount, 5, 'other authors and stash commits are excluded, feature branches included');
  const friday = result.days.find((day) => day.date === '2026-11-06');
  assert.equal(friday.hoursSource, 'ro_remaining');
  assert.equal(friday.groups.reduce((sum, group) => sum + group.hours, 0), 6);
  assert.deepEqual(friday.groups.map((group) => group.task).sort(), ['Bug Fix', 'Feature Development', 'Testing Activities']);
  const saturday = result.days.find((day) => day.date === '2026-11-07');
  assert.equal(saturday.hoursSource, 'ro_no_booking');
  assert.equal(saturday.groups[0].hours, 0);

  assert.match(result.draftText, /^Friday, 06 Nov 2026\n/);
  assert.match(result.draftText, /\+\d+(\.5)? Feature Development \| SSO login with ADFS; SSO callback \(STM-4\)/);
  assert.doesNotMatch(result.draftText, /Saturday|weekend hack|someone else/);
  assert.match(result.summary, /RO remaining 6h \(booked 8h, logged 2h\)/);
});

test('draftLogworkFromCommits falls back to an 8h weekday and reports repo errors', async () => {
  const { dir, commit } = makeRepo();
  commit('a.txt', 'Add report export (SAP-7)', '2026-11-05T10:00:00');
  const missing = join(tmpdir(), 'logwork-no-such-repo-xyz');
  const result = await draftLogworkFromCommits({
    from: '2026-11-05',
    to: '2026-11-06',
    repos: [dir, missing],
    queryRo: async () => {
      throw new Error('Resource Optimiser authentication required.');
    }
  });
  assert.equal(result.bookings, 'unavailable');
  assert.equal(result.days[0].hoursSource, 'standard_day');
  assert.equal(result.days[0].groups[0].hours, 8);
  assert.ok(result.repos.find((repo) => repo.error));
  assert.match(result.summary, /RO bookings unavailable/);
});
