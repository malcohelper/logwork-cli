import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { draftLogworkFromCommits } from '../lib/commit-workflow.mjs';
import { normalizeReconciliationPeriod } from '../lib/reconciliation-workflow.mjs';
import { loadReminderConfig } from '../lib/reminder-config.mjs';
import { collectReminderRepos } from '../lib/reminder-workflow.mjs';

// `logwork commits [period] [--repo path]... [--author x] [--no-bookings] [--json]`:
// turn your git commits into a logwork draft. Read-only.
export function parseCommitsArgs(args = []) {
  const options = { period: 'today', repos: [], author: undefined, useBookings: true, json: false, help: false };
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--no-bookings') {
      options.useBookings = false;
    } else if (arg === '--repo' || arg === '--author') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${arg} requires a value.`);
      }
      if (arg === '--repo') {
        options.repos.push(value);
      } else {
        options.author = value;
      }
      index += 1;
    } else if (arg.startsWith('--repo=')) {
      options.repos.push(arg.slice('--repo='.length));
    } else if (arg.startsWith('--author=')) {
      options.author = arg.slice('--author='.length);
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown commits option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) {
    throw new Error('commits accepts exactly one preset period.');
  }
  if (positional[0]) {
    options.period = normalizeReconciliationPeriod(positional[0]);
  }
  return options;
}

export async function run(args = [], {
  draft = draftLogworkFromCommits,
  print = console.log,
  cwd = process.cwd(),
  reminderRepos = loadReminderRepos
} = {}) {
  const options = parseCommitsArgs(args);
  if (options.help) {
    print(formatCommitsHelp());
    return 0;
  }
  // The reminder tells the user to run `logwork commits today` from a fresh
  // terminal, which starts outside any repo. There, fall back to the
  // reminder's repos instead of reporting no commits.
  let repos = options.repos;
  let fallbackNote = '';
  if (!repos.length && !isInsideGitWorkTree(cwd)) {
    const fallback = await reminderRepos().catch(() => []);
    if (fallback.length) {
      repos = fallback;
      fallbackNote = `Not in a git repo; using the reminder repos: ${fallback.join(', ')}`;
    }
  }
  const result = await draft({
    period: options.period,
    repos,
    author: options.author,
    useBookings: options.useBookings
  });
  if (options.json) {
    print(JSON.stringify(result, null, 2));
  } else {
    print(fallbackNote ? `${fallbackNote}\n\n${result.summary}` : result.summary);
  }
  return 0;
}

// True when dir or a parent holds .git (a directory, or a file for worktrees
// and submodules). No git process is started.
export function isInsideGitWorkTree(dir, { exists = existsSync } = {}) {
  let current = resolve(dir);
  for (;;) {
    if (exists(join(current, '.git'))) {
      return true;
    }
    const parent = dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

async function loadReminderRepos() {
  return collectReminderRepos({ config: await loadReminderConfig() });
}

export function formatCommitsHelp() {
  return `Usage:
  logwork commits [today|yesterday|this-week|last-week|this-month|last-month]
                  [--repo <path>]... [--author <email>] [--no-bookings] [--json]

Reads your commits (all branches, your git user.email) from each repo (default:
the current directory; outside a git repo, the repos set with
\`logwork reminder enable --repo\`) and drafts logwork lines:
  +<hours> <worklog task> | <description>

- Commits are grouped per day by repo, ticket key and kind of work.
- The kind of work picks the worklog task: feat -> Feature Development,
  fix -> Bug Fix, refactor/perf/review -> Code Review & Refactoring,
  test -> Testing Activities, ci/build/release -> Deployment & Release,
  docs/design -> Requirements & Design, chore -> Other Activities.
- Hours split the day's RO remaining time (booked - logged) by how much work
  each group holds. With --no-bookings or without login, a weekday is 8h.

Nothing is written. Review the draft, then paste it into /logwork or give it
to your AI agent (log_work).`;
}
