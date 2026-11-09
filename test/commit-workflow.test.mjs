import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAuthRequiredError } from '../lib/auth-errors.mjs';
import {
  allocateHours,
  buildDescription,
  classifyCommit,
  draftLogworkFromCommits,
  extractTickets,
  formatDayHeading,
  groupCommits,
  parseGitLog,
  remainingHoursByDay
} from '../lib/commit-workflow.mjs';
import { parseWeeklyLogText } from '../lib/batch-parser.mjs';

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
        { projectName: 'Presale', bookedHours: 0, loggedHours: 1.5 },
        { projectName: 'FCS', bookedHours: 2.4, loggedHours: 0 },
        { projectName: 'Portal', bookedHours: 4, loggedHours: 4 },
        { projectName: 'Hosting', bookedHours: 4, loggedHours: 4 }
      ]
    }]
  });
  const day = byDay.get('2026-11-06');
  assert.equal(day.bookedHours, 10.4);
  assert.equal(day.loggedHours, 9.5);
  assert.equal(day.remainingHours, 2.4);
  assert.deepEqual(day.remainingByProject, [{ projectName: 'FCS', remainingHours: 2.4 }]);
  assert.deepEqual(day.projects.map((project) => [project.projectName, project.remainingHours]), [
    ['Presale', 0], ['FCS', 2.4], ['Portal', 0], ['Hosting', 0]
  ]);
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
      throw new Error('connect ETIMEDOUT');
    }
  });
  assert.equal(result.bookings, 'unavailable');
  assert.equal(result.days[0].hoursSource, 'standard_day');
  assert.equal(result.days[0].groups[0].hours, 8);
  assert.ok(result.repos.find((repo) => repo.error));
  assert.match(result.summary, /RO bookings unavailable/);
});

test('ticket keys skip standards and versions, and long ticket lists are capped', () => {
  assert.deepEqual(extractTickets('Fix UTF-8 handling in ISO-8601 parser for SHA-256 (SCB-12, CVE-2024-1234)'), ['SCB-12']);
  const many = Array.from({ length: 30 }, (_, index) => `ABC-${index + 1}`);
  const description = buildDescription({ repoName: 'app', tickets: many, subjects: ['Fix many bugs'] });
  assert.ok(description.length <= 240, `length ${description.length}`);
  assert.match(description, /^Fix many bugs \(ABC-1, ABC-2, ABC-3, ABC-4 \+26 more\)$/);
  assert.equal(
    buildDescription({ repoName: 'app', tickets: ['SCB-1'], subjects: ['Fix UTF-8 parsing SCB-1'] }),
    'Fix UTF-8 parsing (SCB-1)'
  );
});

test('author match is exact, so a similar email is not my work', async () => {
  const { dir, commit } = makeRepo();
  commit('a.txt', 'feat: mine', '2026-11-06T09:00:00');
  commit('b.txt', 'feat: jim work', '2026-11-06T10:00:00', 'Jim <jime@example.com>');
  commit('c.txt', 'feat: dotted', '2026-11-06T11:00:00', 'Dot <meXexample.com@other.org>');
  const result = await draftLogworkFromCommits({ from: '2026-11-06', to: '2026-11-07', repos: [dir], useBookings: false });
  assert.equal(result.commitCount, 1);
  assert.match(result.draftText, /\| mine$/m);
});

test('a rebased commit stays on its author day, and a repo given twice counts once', async () => {
  const { dir, commit } = makeRepo();
  commit('a.txt', 'feat: base', '2026-11-01T09:00:00');
  // Authored Monday, committed (rebased) Wednesday.
  writeFileSync(join(dir, 'r.txt'), 'rebased');
  git(dir, ['add', 'r.txt']);
  git(dir, ['commit', '-q', '-m', 'fix: rebased work (SAP-1)', '--date=2026-11-02T10:00:00'], { GIT_COMMITTER_DATE: '2026-11-04T10:00:00' });
  git(dir, ['worktree', 'add', '-q', join(dir, '..', `${dir.split(/[\\/]/).pop()}-wt`), '-b', 'wt']);

  const monday = await draftLogworkFromCommits({
    from: '2026-11-02',
    to: '2026-11-03',
    repos: [dir, join(dir, '.'), `${dir}-wt`],
    useBookings: false
  });
  assert.equal(monday.commitCount, 1);
  assert.equal(monday.repos.filter((repo) => !repo.error).length, 2, 'the worktree is listed but its commits are not counted again');
  assert.equal(monday.days[0].date, '2026-11-02');
  assert.equal(monday.days[0].groups[0].hours, 8);

  const wednesday = await draftLogworkFromCommits({ from: '2026-11-04', to: '2026-11-05', repos: [dir], useBookings: false });
  assert.equal(wednesday.status, 'no_commits');
});

test('an RO login error is raised instead of assuming an 8h day', async () => {
  const { dir, commit } = makeRepo();
  commit('a.txt', 'feat: thing', '2026-11-05T10:00:00');
  await assert.rejects(
    draftLogworkFromCommits({
      from: '2026-11-05',
      to: '2026-11-06',
      repos: [dir],
      queryRo: async () => { throw createAuthRequiredError(); }
    }),
    (error) => error.code === 'AUTH_REQUIRED'
  );
});

test('status is no_hours when commits exist but no day has room', async () => {
  const { dir, commit } = makeRepo();
  commit('a.txt', 'feat: weekend', '2026-11-07T10:00:00');
  const result = await draftLogworkFromCommits({ from: '2026-11-07', to: '2026-11-08', repos: [dir], useBookings: false });
  assert.equal(result.status, 'no_hours');
  assert.equal(result.draftText, '');
});

function repoRoot(dir) {
  return git(dir, ['rev-parse', '--show-toplevel']).trim();
}

const projectA = { projectMemberId: 101, projectId: 11, projectName: 'Alpha Portal' };
const projectB = { projectMemberId: 202, projectId: 22, projectName: 'Beta Mobile' };
const projectC = { projectMemberId: 303, projectId: 33, projectName: 'Gamma Ops' };

test('draft allocates each project its own remaining hours and returns projectOverrides matching the parser ids', async () => {
  const appRepo = makeRepo();
  appRepo.commit('a1.txt', 'feat: dashboard widgets', '2026-11-05T09:00:00');
  appRepo.commit('a2.txt', 'fix: chart legend', '2026-11-05T10:00:00');
  appRepo.commit('a3.txt', 'feat: export report', '2026-11-06T09:00:00');
  const sharedRepo = makeRepo();
  sharedRepo.commit('b1.txt', 'feat: offline sync (BETA-7)', '2026-11-05T11:00:00');
  sharedRepo.commit('b2.txt', 'chore: tidy scripts', '2026-11-05T12:00:00');
  sharedRepo.commit('b3.txt', 'feat: push settings (BETA-8)', '2026-11-06T11:00:00');

  const result = await draftLogworkFromCommits({
    from: '2026-11-05',
    to: '2026-11-07',
    repos: [appRepo.dir, sharedRepo.dir],
    loadConfig: async () => ({
      projectMappings: [
        { ...projectA, tickets: [], keywords: [], repos: [repoRoot(appRepo.dir)] },
        { ...projectB, tickets: ['BETA'], keywords: [] }
      ]
    }),
    queryRo: async () => ({
      days: [
        {
          date: '2026-11-05',
          bookedHours: 10,
          loggedHours: 1,
          projects: [
            { ...projectA, bookedHours: 4, loggedHours: 1 },
            { ...projectB, bookedHours: 4, loggedHours: 0 },
            { ...projectC, bookedHours: 2.4, loggedHours: 0 }
          ]
        },
        {
          // Alpha is full on Friday; Beta still has room.
          date: '2026-11-06',
          bookedHours: 6,
          loggedHours: 4,
          projects: [
            { ...projectA, bookedHours: 4, loggedHours: 4 },
            { ...projectB, bookedHours: 2, loggedHours: 0 }
          ]
        }
      ]
    })
  });

  assert.equal(result.status, 'draft');
  const [thursday, friday] = result.days;
  const byProject = (day, name) => day.groups.filter((group) => group.project?.projectName === name);
  const sum = (groups) => groups.reduce((total, group) => total + group.hours, 0);

  // Alpha (repo mapping) gets its 3h room, Beta (ticket mapping) its 4h, and
  // the unresolved chore shares the 2.4h left on Gamma, rounded down to 2h.
  assert.deepEqual(byProject(thursday, 'Alpha Portal').map((group) => group.project.source), ['repo_mapping', 'repo_mapping']);
  assert.equal(sum(byProject(thursday, 'Alpha Portal')), 3);
  assert.equal(byProject(thursday, 'Beta Mobile')[0].project.source, 'resolver');
  assert.equal(byProject(thursday, 'Beta Mobile')[0].project.reason, 'config_ticket');
  assert.equal(sum(byProject(thursday, 'Beta Mobile')), 4);
  const unresolved = thursday.groups.filter((group) => !group.project);
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].hours, 2);
  assert.deepEqual(thursday.unresolvedAllocation, { groupCount: 1, roomHours: 2.4, allocatedHours: 2 });

  // A full project gets 0h and the summary says so; nothing exceeds its room.
  assert.equal(sum(byProject(friday, 'Alpha Portal')), 0);
  assert.equal(sum(byProject(friday, 'Beta Mobile')), 2);
  assert.match(result.summary, /No room on Alpha Portal \(remaining 0h\): its 1 line\(s\) get 0h\./);
  assert.match(result.summary, /-> Alpha Portal \(repo mapping\)/);
  assert.match(result.summary, /-> Beta Mobile \(config_ticket\)/);
  assert.match(result.summary, /-> project unresolved/);
  for (const day of result.days) {
    for (const allocation of day.projectAllocation) {
      assert.ok(allocation.allocatedHours <= allocation.remainingHours, `${allocation.projectName} stays within its room`);
    }
  }

  // Every resolved line maps to its projectMemberId under the id log_work's
  // parser gives that line; unresolved and 0h lines have no override.
  const parsed = parseWeeklyLogText(result.draftText);
  assert.deepEqual(parsed.errors, []);
  const groupsByLine = result.days.flatMap((day) => day.groups.filter((group) => group.hours > 0));
  assert.equal(parsed.entries.length, groupsByLine.length);
  parsed.entries.forEach((entry, index) => {
    const group = groupsByLine[index];
    assert.equal(entry.id, group.entryId);
    assert.equal(entry.description, group.description);
    assert.equal(result.projectOverrides[entry.id], group.project?.projectMemberId);
  });
  assert.equal(Object.keys(result.projectOverrides).length, parsed.entries.filter((entry, index) => groupsByLine[index].project).length);
  assert.ok(parsed.entries.some((entry) => entry.date === '2026-11-06'), 'ids continue across days');
  assert.match(result.summary, /Pass projectOverrides to log_work/);

  // git prints C:/... on Windows; drafts store the resolved form (C:\...).
  assert.deepEqual(result.unmappedRepos, [resolve(repoRoot(sharedRepo.dir))]);
  assert.match(result.summary, /offer map_project with repos/);
});

test('a repo mapped to a project with no booking that day gets 0h', async () => {
  const { dir, commit } = makeRepo();
  commit('a.txt', 'feat: widgets', '2026-11-05T09:00:00');
  const result = await draftLogworkFromCommits({
    from: '2026-11-05',
    to: '2026-11-06',
    repos: [dir],
    loadConfig: async () => ({ projectMappings: [{ ...projectA, tickets: [], keywords: [], repos: [repoRoot(dir)] }] }),
    queryRo: async () => ({
      days: [{ date: '2026-11-05', bookedHours: 8, loggedHours: 0, projects: [{ ...projectB, bookedHours: 8, loggedHours: 0 }] }]
    })
  });
  assert.equal(result.days[0].groups[0].project.projectMemberId, 101);
  assert.equal(result.days[0].groups[0].hours, 0);
  assert.equal(result.status, 'no_hours');
  assert.match(result.summary, /No room on Alpha Portal \(not booked this day\)/);
});

test('without RO the draft keeps the standard day split but still names mapped projects', async () => {
  const { dir, commit } = makeRepo();
  commit('a.txt', 'feat: widgets', '2026-11-05T09:00:00');
  commit('b.txt', 'fix: legend', '2026-11-05T10:00:00');
  const result = await draftLogworkFromCommits({
    from: '2026-11-05',
    to: '2026-11-06',
    repos: [dir],
    loadConfig: async () => ({ projectMappings: [{ ...projectA, tickets: [], keywords: [], repos: [repoRoot(dir)] }] }),
    queryRo: async () => {
      throw new Error('connect ETIMEDOUT');
    }
  });
  const day = result.days[0];
  assert.equal(day.hoursSource, 'standard_day');
  assert.equal(day.projectAllocation, undefined);
  assert.equal(day.groups.reduce((sum, group) => sum + group.hours, 0), 8);
  assert.ok(day.groups.every((group) => group.project?.source === 'repo_mapping'));
  assert.deepEqual(Object.values(result.projectOverrides), [101, 101]);
});
