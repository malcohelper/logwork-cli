#!/usr/bin/env node

import { isMainModule } from './lib/entrypoint.mjs';
import {
  normalizeReconciliationPeriod,
  reconcileLogwork
} from './lib/reconciliation-workflow.mjs';

export function parseReconcileArgs(args = []) {
  const options = {
    period: 'this_week',
    json: false,
    help: false
  };
  const positional = [];
  for (const arg of args) {
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown reconcile option: ${arg}`);
    }
    positional.push(arg);
  }
  if (positional.length > 1) {
    throw new Error('Reconcile accepts exactly one preset period.');
  }
  if (positional[0]) {
    options.period = normalizeReconciliationPeriod(positional[0]);
  }
  return options;
}

export async function runReconcileCommand(args = [], {
  reconcile = reconcileLogwork,
  print = console.log
} = {}) {
  const options = parseReconcileArgs(args);
  if (options.help) {
    print(formatReconcileHelp());
    return null;
  }
  const result = await reconcile({ period: options.period });
  print(options.json ? JSON.stringify(result, null, 2) : result.summary);
  return result;
}

export function formatReconcileHelp() {
  return `Usage:
  logwork-helper reconcile [today|yesterday|this-week|last-week|this-month|last-month] [--json]

Compares Resource Optimiser and Jira worklog hours by day. This command is read-only. Correction suggestions must still go through the existing target-specific preview and approval flow.`;
}

if (isMainModule(import.meta.url)) {
  runReconcileCommand(process.argv.slice(2)).catch((error) => {
    console.error(`Reconciliation error: ${error.message}`);
    process.exitCode = 1;
  });
}
