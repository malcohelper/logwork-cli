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
    prompt: true,
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
    '--no-prompt',
    '--json',
    '-h'
  ]), {
    period: 'this_week',
    repos: ['/a', '/b'],
    author: 'me@example.com',
    useBookings: false,
    json: true,
    prompt: false,
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

const FCS = { projectMemberId: 501, projectId: 51, projectName: 'GKE Fair Chem System (FCS)' };
const PORTAL = { projectMemberId: 502, projectId: 52, projectName: 'Customer Portal' };

function unmappedDraft() {
  const first = {
    summary: 'First draft',
    unmappedRepos: ['/work/fcs-web', '/work/other'],
    repoSuggestions: { '/work/fcs-web': [{ ...FCS, score: 30, reasons: ['repo name matches FCS'] }], '/work/other': [] },
    projectCandidates: [FCS, PORTAL]
  };
  const second = { summary: 'Second draft', unmappedRepos: ['/work/other'], repoSuggestions: {}, projectCandidates: [FCS, PORTAL] };
  return fakeDraftSequence([first, second]);
}

function fakeDraftSequence(results) {
  const calls = [];
  const draft = async (options) => {
    calls.push(options);
    return results[Math.min(calls.length - 1, results.length - 1)];
  };
  draft.calls = calls;
  return draft;
}

test('commits asks once per unmapped repo, saves the choice and redrafts', async () => {
  const printed = [];
  const draft = unmappedDraft();
  const asked = [];
  const saved = [];
  await run(['this-week', '--repo', '/work/fcs-web'], {
    draft,
    cwd: REPO_ROOT,
    print: (text) => printed.push(text),
    isInteractive: () => true,
    chooseProject: async (input) => {
      asked.push(input);
      return input.repoName === 'fcs-web' ? input.suggestions[0] : null;
    },
    saveMapping: async (args) => {
      saved.push(args);
      return { summary: 'ok' };
    }
  });

  assert.deepEqual(asked.map((input) => input.repoName), ['fcs-web', 'other']);
  assert.deepEqual(asked[0].candidates, [FCS, PORTAL]);
  assert.deepEqual(saved, [{ repos: ['/work/fcs-web'], projectMemberId: 501, scope: 'user', confirm: true, cwd: REPO_ROOT }]);
  assert.equal(draft.calls.length, 2);
  assert.deepEqual(draft.calls[1], draft.calls[0]);
  assert.deepEqual(printed, [
    'First draft',
    'Mapped fcs-web to GKE Fair Chem System (FCS). Later drafts use it automatically.',
    'Skipped other; it will be asked again next time.',
    '\nUpdated draft:\n\nSecond draft'
  ]);
});

test('commits does not redraft when every repo is skipped or a mapping fails', async () => {
  for (const saveMapping of [null, async () => { throw new Error('Project member 501 was not found in your memberships'); }]) {
    const printed = [];
    const draft = unmappedDraft();
    await run([], {
      draft,
      cwd: REPO_ROOT,
      print: (text) => printed.push(text),
      isInteractive: () => true,
      chooseProject: async (input) => (saveMapping ? input.candidates[0] : null),
      saveMapping: saveMapping || (async () => { throw new Error('must not save'); })
    });
    assert.equal(draft.calls.length, 1);
    if (saveMapping) {
      assert.match(printed[1], /Could not map fcs-web: Project member 501 was not found/);
    } else {
      assert.match(printed.at(-1), /Skipped other/);
    }
  }
});

test('commits never prompts with --no-prompt, --json, a non-interactive terminal or no candidates', async () => {
  const chooseProject = async () => { throw new Error('must not prompt'); };
  for (const [args, interactive] of [[['--no-prompt'], true], [['--json'], true], [[], false]]) {
    const draft = unmappedDraft();
    await run(args, { draft, cwd: REPO_ROOT, print: () => {}, isInteractive: () => interactive, chooseProject });
    assert.equal(draft.calls.length, 1, args.join(' ') || 'non-tty');
  }
  const noCandidates = fakeDraftSequence([{ summary: 'S', unmappedRepos: ['/work/x'], repoSuggestions: {}, projectCandidates: [] }]);
  await run([], { draft: noCandidates, cwd: REPO_ROOT, print: () => {}, isInteractive: () => true, chooseProject });
  assert.equal(noCandidates.calls.length, 1);
});

test('commits maps by project name when a candidate has no projectMemberId', async () => {
  const saved = [];
  const draft = fakeDraftSequence([{ summary: 'S', unmappedRepos: ['/work/x'], repoSuggestions: {}, projectCandidates: [{ projectName: 'Booked Only' }] }, { summary: 'T' }]);
  await run([], {
    draft,
    cwd: REPO_ROOT,
    print: () => {},
    isInteractive: () => true,
    chooseProject: async (input) => input.candidates[0],
    saveMapping: async (args) => { saved.push(args); }
  });
  assert.deepEqual(saved[0], { repos: ['/work/x'], projectName: 'Booked Only', scope: 'user', confirm: true, cwd: REPO_ROOT });
});
