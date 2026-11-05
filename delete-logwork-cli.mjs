#!/usr/bin/env node

import { confirm, isCancel } from '@clack/prompts';
import { isMainModule } from './lib/entrypoint.mjs';
import { parseRoDeleteArgs } from './lib/ro-delete-args.mjs';
import {
  applyRoLogworkDelete,
  previewRoLogworkDelete
} from './lib/ro-delete-workflow.mjs';

export async function runRoDeleteCommand(args = [], {
  preview = previewRoLogworkDelete,
  apply = applyRoLogworkDelete,
  promptConfirm = defaultConfirm,
  isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  print = console.log
} = {}) {
  const options = parseRoDeleteArgs(args);
  if (options.help) {
    print(formatRoDeleteHelp());
    return null;
  }

  if (options.json && !options.yes) {
    throw new Error('--json requires --yes so stdout remains valid JSON.');
  }

  const deletePreview = await preview({ logworkId: options.logworkId });
  if (!options.json) {
    print(deletePreview.summary);
  }

  let approved = options.yes;
  if (!approved) {
    if (!isTTY) {
      throw new Error('Interactive confirmation is unavailable. Re-run with --yes.');
    }
    approved = await promptConfirm(`Delete RO logwork entry ${deletePreview.logworkId}?`);
  }
  if (!approved) {
    print('RO logwork delete cancelled.');
    return null;
  }

  const result = await apply({
    preview: deletePreview,
    confirm: true
  });
  print(options.json ? JSON.stringify(result, null, 2) : result.summary);
  return result;
}

export function formatRoDeleteHelp() {
  return `Usage:
  logwork-helper delete <logwork-id> [--yes] [--json]

Soft-deletes one Resource Optimiser logwork entry (submitted or approved only).
The command previews the entry, checks for concurrent changes, then calls DELETE /logwork/entries/:id.

Options:
  -y, --yes             Delete without interactive confirmation
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
  runRoDeleteCommand(process.argv.slice(2)).catch((error) => {
    console.error(`RO delete error: ${error.message}`);
    process.exitCode = 1;
  });
}
