#!/usr/bin/env node

import { confirm, isCancel } from '@clack/prompts';
import { isMainModule } from './lib/entrypoint.mjs';
import { parseRoEditArgs } from './lib/ro-edit-args.mjs';
import {
  applyRoLogworkEdit,
  previewRoLogworkEdit
} from './lib/ro-edit-workflow.mjs';

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
    taskName: options.taskName
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
  logwork-helper edit <logwork-id> --hours <hours> [--yes] [--json]
  logwork-helper edit <logwork-id> --task-name <text> [--yes] [--json]
  logwork-helper edit <logwork-id> --hours <hours> --task-name <text> [--yes] [--json]

Edits one existing Resource Optimiser logwork. Project and date are always preserved.
The command previews the diff, checks for concurrent changes before PATCH, and verifies the saved result.

Options:
  --hours <hours>       Replacement hours; --logtimes is accepted as an alias
  --task-name <text>    Replacement task name; --task is accepted as an alias
  -y, --yes             Apply without interactive confirmation
  --json                Print structured JSON; requires --yes
  -h, --help            Show this help`;
}

async function defaultConfirm(message) {
  const result = await confirm({
    message,
    initialValue: false
  });
  return !isCancel(result) && result === true;
}

if (isMainModule(import.meta.url)) {
  runRoEditCommand(process.argv.slice(2)).catch((error) => {
    console.error(`RO edit error: ${error.message}`);
    process.exitCode = 1;
  });
}
