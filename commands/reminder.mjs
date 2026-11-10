import { confirm, isCancel } from '@clack/prompts';
import {
  normalizeReminderRepos,
  normalizeReminderTime,
  REMINDER_TARGETS
} from '../lib/reminder-config.mjs';
import {
  disableLogworkReminder,
  enableLogworkReminder,
  getLogworkReminderStatus,
  testLogworkReminder
} from '../lib/reminder-service.mjs';
import { runScheduledReminder } from '../lib/reminder-workflow.mjs';

export function parseReminderArgs(args = []) {
  const [command = 'help', ...rest] = args;
  if (command === '--help' || command === '-h' || command === 'help') {
    return { command: 'help' };
  }
  if (!['enable', 'status', 'test', 'disable', 'run'].includes(command)) {
    throw new Error(`Unknown reminder command: ${command}.`);
  }

  const options = {
    command,
    time: undefined,
    target: undefined,
    yes: false,
    json: false,
    home: undefined,
    repos: undefined,
    help: false
  };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--time' || arg === '--target' || arg === '--home') {
      const value = rest[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a value.`);
      }
      options[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    if (arg === '--repo' || arg.startsWith('--repo=')) {
      const value = arg === '--repo' ? rest[index + 1] : arg.slice('--repo='.length);
      if (!value || (arg === '--repo' && value.startsWith('--'))) {
        throw new Error('--repo requires a path.');
      }
      if (options.repos === null) {
        throw new Error('--repo cannot be combined with --no-repos.');
      }
      options.repos = [...(options.repos || []), value];
      if (arg === '--repo') {
        index += 1;
      }
      continue;
    }
    if (arg === '--no-repos') {
      if (options.repos?.length) {
        throw new Error('--repo cannot be combined with --no-repos.');
      }
      options.repos = null;
      continue;
    }
    if (arg === '--yes' || arg === '-y') {
      options.yes = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    throw new Error(`Unknown reminder option: ${arg}`);
  }

  if (!['enable', 'test'].includes(command) && options.target) {
    throw new Error('--target is only valid with reminder enable or test.');
  }
  if (command !== 'enable' && options.time) {
    throw new Error('--time is only valid with reminder enable.');
  }
  if (command !== 'enable' && options.repos !== undefined) {
    throw new Error('--repo and --no-repos are only valid with reminder enable.');
  }
  if (Array.isArray(options.repos)) {
    // Resolve against the directory the command runs in; the scheduled run
    // starts in the helper home.
    options.repos = normalizeReminderRepos(options.repos);
  } else if (options.repos === null) {
    options.repos = [];
  }
  if (command !== 'run' && options.home) {
    throw new Error('--home is reserved for the OS reminder runner.');
  }
  if (!['enable', 'test', 'disable'].includes(command) && options.yes) {
    throw new Error('--yes is only valid with reminder enable, test, or disable.');
  }
  if (options.time) {
    options.time = normalizeReminderTime(options.time);
  }
  if (options.target) {
    options.target = options.target.toLowerCase();
    if (!REMINDER_TARGETS.includes(options.target)) {
      throw new Error('Reminder target must be ro, jira, or both.');
    }
  }
  if (command === 'run' && (options.yes || options.json || options.time || options.target)) {
    throw new Error('Reminder run only accepts the managed --home option.');
  }
  return options;
}

export async function runReminderCli(args = [], {
  enable = enableLogworkReminder,
  disable = disableLogworkReminder,
  status = getLogworkReminderStatus,
  test = testLogworkReminder,
  run = runScheduledReminder,
  promptConfirm = defaultConfirm,
  isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  print = console.log
} = {}) {
  const options = parseReminderArgs(args);
  if (options.command === 'help' || options.help) {
    print(formatReminderHelp());
    return null;
  }

  if (options.command === 'run') {
    if (options.home) {
      process.env.LOGWORK_HOME = options.home;
    }
    return run();
  }

  if (options.command === 'status') {
    const result = await status();
    printResult(result, options.json, print);
    return result;
  }

  const actionLabel = options.command === 'enable'
    ? `Enable ${options.target || 'both'} logwork reminder at ${options.time || '17:00'}, Monday-Friday?`
    : options.command === 'disable'
      ? 'Disable the logwork reminder and remove its OS schedule?'
      : `Send a ${options.target || 'configured'} test notification now?`;
  const approved = options.yes || await requireInteractiveConfirmation({
    isTTY,
    promptConfirm,
    message: actionLabel
  });
  if (!approved) {
    print('Reminder command cancelled.');
    return null;
  }

  let result;
  if (options.command === 'enable') {
    result = await enable({
      time: options.time,
      target: options.target,
      ...(options.repos !== undefined ? { repos: options.repos } : {}),
      confirm: true
    });
  } else if (options.command === 'disable') {
    result = await disable({ confirm: true });
  } else {
    result = await test({
      target: options.target,
      confirm: true
    });
  }
  printResult(result, options.json, print);
  return result;
}

export function formatReminderHelp() {
  return `Usage:
  logwork reminder enable [--time HH:mm] [--target ro|jira|both]
                          [--repo <path>]... [--no-repos] [--yes]
  logwork reminder status [--json]
  logwork reminder test [--target ro|jira|both] [--yes]
  logwork reminder disable [--yes]

The reminder runs Monday-Friday at 17:00 by default. It uses launchd on macOS, Task Scheduler on Windows and a systemd user timer on Linux. RO compares logged and booked hours; Jira checks whether the current user has a worklog today.

--repo (repeatable) sets the git repos whose commits today are counted per repo when RO hours are missing, as "Hôm nay 5 commit:" with one line per repo (for example "• teammates: 3"), and points to \`logwork commits today\` for a draft. Repos listed on project mappings are also used. --repo replaces the saved list; --no-repos clears it; without either the saved list is kept.

The schedule stores the absolute path of the Node that ran \`reminder enable\`. After upgrading or removing that Node (nvm, Homebrew), run \`logwork reminder enable\` or \`logwork setup\` again; \`logwork reminder status\` warns when the path is gone.`;
}

async function requireInteractiveConfirmation({ isTTY, promptConfirm, message }) {
  if (!isTTY) {
    throw new Error('Interactive confirmation is unavailable. Re-run with --yes.');
  }
  return promptConfirm(message);
}

async function defaultConfirm(message) {
  const result = await confirm({ message, initialValue: false });
  return !isCancel(result) && result === true;
}

function printResult(result, json, print) {
  print(json ? JSON.stringify(result, null, 2) : result.summary);
}
