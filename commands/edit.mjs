import { confirm, isCancel } from '@clack/prompts';
import { parseRoEditArgs } from '../lib/ro-edit-args.mjs';
import {
  applyRoLogworkEdit,
  previewRoLogworkEdit
} from '../lib/ro-edit-workflow.mjs';

export async function runRoEditCommand(args = [], {
  preview = previewRoLogworkEdit,
  apply = applyRoLogworkEdit,
  promptConfirm = defaultConfirm,
  isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  print = console.log
} = {}) {
  const options = parseRoEditArgs(args);
  if (options.help) {
    print(formatRoEditHelp());
    return null;
  }

  if (options.json && !options.yes) {
    throw new Error('--json requires --yes so stdout remains valid JSON.');
  }

  const editPreview = await preview({
    logworkId: options.logworkId,
    hours: options.hours,
    taskName: options.taskName,
    description: options.description,
    typeOfWork: options.typeOfWork
  });
  if (!options.json) {
    print(editPreview.summary);
  }

  let approved = options.yes;
  if (!approved) {
    if (!isTTY) {
      throw new Error('Interactive confirmation is unavailable. Re-run with --yes.');
    }
    approved = await promptConfirm(`Apply RO logwork edit ${editPreview.previewId}?`);
  }
  if (!approved) {
    print('RO logwork edit cancelled.');
    return null;
  }

  const result = await apply({
    preview: editPreview,
    confirm: true
  });
  print(options.json ? JSON.stringify(result, null, 2) : result.summary);
  return result;
}

export function formatRoEditHelp() {
  return `Usage:
  logwork edit <id> [--hours <h>] [--task <task>] [--desc <text>] [--type <type>] [--yes] [--json]

Changes one Resource Optimiser entry. Project and date are preserved. Get the id
from \`logwork query\`.

RO has no staff edit API, so apply replaces the entry: it creates the corrected
entry, then deletes the original (the new entry gets a new id and is approved
immediately). If the delete fails, the new entry is rolled back. Only submitted
or approved entries can be edited; rejected entries are fixed with resubmit.

Options:
  --hours <h>      New hours (alias: --logtimes)
  --task <task>    New worklog task from the project catalog, or #<id> (alias: --task-name)
  --desc <text>    New description: what you did (alias: --description)
  --type <type>    New type of work: create, correct, improve, other
                   (follows the new task's catalog type when the task changes)
  -y, --yes        Apply without the confirmation prompt
  --json           Print the result as JSON (requires --yes)
  -h, --help       Show this help

Example:
  logwork edit 304032 --task "Bug Fix" --desc "Fix date picker timezone (SAP-42)"`;
}

async function defaultConfirm(message) {
  const result = await confirm({
    message,
    initialValue: false
  });
  return !isCancel(result) && result === true;
}
