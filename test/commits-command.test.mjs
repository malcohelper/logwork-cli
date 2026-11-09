import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatCommitsHelp, isInsideGitWorkTree, parseCommitsArgs, run } from '../commands/commits.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

function fakeDraft(result = { summary: 'Draft summary', lines: ['+2 Feature Development | x'] }) {
  const calls = [];
  const draft = async (options) => {
    calls.push(options);
    return result;
  };
  draft.calls = calls;
  return draft;
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'logwork-commits-'));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('parseCommitsArgs defaults to today, the current repo and bookings on', () => {
  assert.deepEqual(parseCommitsArgs([]), {
    period: 'today',
    repos: [],
    author: undefined,
    useBookings: true,
    json: false,
    help: false
  });
});

test('parseCommitsArgs reads the period, repos, author and flags', () => {
  assert.deepEqual(parseCommitsArgs([
    'this-week',
    '--repo', '/a',
    '--repo=/b',
    '--author', 'me@example.com',
    '--no-bookings',
    '--json',
    '-h'
  ]), {
    period: 'this_week',
    repos: ['/a', '/b'],
    author: 'me@example.com',
    useBookings: false,
    json: true,
    help: true
  });
  assert.equal(parseCommitsArgs(['--author=you@example.com']).author, 'you@example.com');
  assert.equal(parseCommitsArgs(['week']).period, 'this_week');
});

test('parseCommitsArgs rejects missing values, unknown options and extra periods', () => {
  assert.throws(() => parseCommitsArgs(['--repo']), /--repo requires a value\./);
  assert.throws(() => parseCommitsArgs(['--author', '--json']), /--author requires a value\./);
  assert.throws(() => parseCommitsArgs(['--since', 'x']), /Unknown commits option: --since/);
  assert.throws(() => parseCommitsArgs(['today', 'yesterday']), /exactly one preset period/);
  assert.throws(() => parseCommitsArgs(['fortnight']), /Reconciliation period must be/);
});

test('commits --help prints usage and drafts nothing', async () => {
  const printed = [];
  const draft = fakeDraft();
  assert.equal(await run(['--help'], { draft, print: (text) => printed.push(text) }), 0);
  assert.deepEqual(printed, [formatCommitsHelp()]);
  assert.equal(draft.calls.length, 0);
});

test('commits inside a git repo drafts from the current repo and prints the summary', async () => {
  const printed = [];
  const draft = fakeDraft();
  let reminderRead = false;

  assert.equal(await run(['yesterday', '--no-bookings'], {
    draft,
    print: (text) => printed.push(text),
    cwd: REPO_ROOT,
    reminderRepos: async () => {
      reminderRead = true;
      return ['/elsewhere'];
    }
  }), 0);

  assert.deepEqual(draft.calls, [{ period: 'yesterday', repos: [], author: undefined, useBookings: false }]);
  assert.deepEqual(printed, ['Draft summary']);
  assert.equal(reminderRead, false);
});

test('commits outside a git repo falls back to the reminder repos', async () => {
  await withTempDir(async (dir) => {
    const printed = [];
    const draft = fakeDraft();

    await run([], { draft, print: (text) => printed.push(text), cwd: dir, reminderRepos: async () => ['/repo/a', '/repo/b'] });

    assert.deepEqual(draft.calls[0].repos, ['/repo/a', '/repo/b']);
    assert.deepEqual(printed, ['Not in a git repo; using the reminder repos: /repo/a, /repo/b\n\nDraft summary']);
  });
});

test('commits outside a git repo without reminder repos drafts with no repos', async () => {
  await withTempDir(async (dir) => {
    for (const reminderRepos of [async () => [], async () => { throw new Error('no reminder config'); }]) {
      const printed = [];
      const draft = fakeDraft();
      await run([], { draft, print: (text) => printed.push(text), cwd: dir, reminderRepos });
      assert.deepEqual(draft.calls[0].repos, []);
      assert.deepEqual(printed, ['Draft summary']);
    }
  });
});

test('commits with --repo never reads the reminder repos', async () => {
  await withTempDir(async (dir) => {
    const draft = fakeDraft();
    await run(['--repo', '/explicit'], {
      draft,
      print: () => {},
      cwd: dir,
      reminderRepos: async () => {
        throw new Error('should not be read');
      }
    });
    assert.deepEqual(draft.calls[0].repos, ['/explicit']);
  });
});

test('commits --json prints the whole draft result', async () => {
  const printed = [];
  const result = { summary: 'S', lines: [], days: [] };
  await run(['--json'], { draft: fakeDraft(result), print: (text) => printed.push(text), cwd: REPO_ROOT });
  assert.deepEqual(JSON.parse(printed[0]), result);
});

test('isInsideGitWorkTree walks up to a .git entry', () => {
  const root = resolve('/work');
  const repo = join(root, 'repo');
  const seen = [];
  const exists = (path) => {
    seen.push(path);
    return path === join(repo, '.git');
  };

  assert.equal(isInsideGitWorkTree(join(repo, 'src', 'lib'), { exists }), true);
  assert.deepEqual(seen, [join(repo, 'src', 'lib', '.git'), join(repo, 'src', '.git'), join(repo, '.git')]);
  assert.equal(isInsideGitWorkTree(join(root, 'other'), { exists }), false);
  assert.equal(isInsideGitWorkTree(REPO_ROOT), true);
});
