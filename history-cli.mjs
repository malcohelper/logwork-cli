#!/usr/bin/env node

import { queryApplyLedger } from './lib/apply-ledger.mjs';
import { isMainModule } from './lib/entrypoint.mjs';

export function parseHistoryArgs(args = []) {
  const options = {
    target: undefined,
    limit: 20,
    json: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--target') {
      options.target = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--limit') {
      options.limit = Number(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      return { help: true };
    }
    throw new Error(`Unknown history option: ${arg}`);
  }

  return options;
}

export async function runHistoryCommand(args = [], {
  query = queryApplyLedger,
  print = console.log
} = {}) {
  const options = parseHistoryArgs(args);
  if (options.help) {
    printHistoryHelp(print);
    return null;
  }

  const result = await query({
    target: options.target,
    limit: options.limit
  });
  print(options.json ? JSON.stringify(result, null, 2) : result.summary);
  return result;
}

function printHistoryHelp(print = console.log) {
  print(`Usage:
  logwork-helper history [--target ro|jira|both] [--limit <count>] [--json]

Shows the local apply result ledger. Target both means entries applied from a combined Both flow.`);
}

async function main() {
  await runHistoryCommand(process.argv.slice(2));
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(`History error: ${error.message}`);
    process.exitCode = 1;
  });
}
