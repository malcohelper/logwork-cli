import { queryLogwork } from '../lib/query-workflow.mjs';
import { normalizeReconciliationPeriod } from '../lib/reconciliation-workflow.mjs';

// `logwork query [period] [--json]`: booked vs logged Resource Optimiser hours,
// with each entry's id, worklog task, description and status.
export function parseQueryArgs(args = []) {
  const options = { period: 'today', json: false, help: false };
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
      throw new Error(`Unknown query option: ${arg}`);
    }
    positional.push(arg);
  }
  if (positional.length > 1) {
    throw new Error('Query accepts exactly one preset period.');
  }
  if (positional[0]) {
    options.period = normalizeReconciliationPeriod(positional[0]);
  }
  return options;
}

export async function run(args = [], {
  query = queryLogwork,
  print = console.log
} = {}) {
  const options = parseQueryArgs(args);
  if (options.help) {
    print(formatQueryHelp());
    return 0;
  }
  const result = await query({ period: options.period, includeEntries: true });
  print(options.json ? JSON.stringify(result, null, 2) : result.summary);
  return 0;
}

export function formatQueryHelp() {
  return `Usage:
  logwork query [today|yesterday|this-week|last-week|this-month|last-month] [--json]

Shows booked vs logged Resource Optimiser hours per day and project, with each
entry's id (use it with \`logwork edit\` / \`logwork delete\`). Defaults to today.`;
}
