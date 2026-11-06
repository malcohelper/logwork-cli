#!/usr/bin/env node

import { isMainModule } from '../lib/entrypoint.mjs';
import { migrateLegacyHome } from '../lib/legacy-migration.mjs';
import { readPackageVersion } from '../lib/package-info.mjs';

// One entry point for every surface:
//   logwork               -> terminal UI
//   logwork <command> ... -> CLI command (loaded on demand, run in-process)
//   logwork mcp           -> MCP stdio server for IDEs and agent CLIs
export const COMMANDS = [
  { name: 'query', usage: 'query [today|yesterday|this-week|last-week|this-month|last-month] [--json]', summary: 'Show booked vs logged hours with entry ids', load: () => import('../commands/query.mjs'), fn: 'run' },
  { name: 'quick', usage: 'quick [-m "what you did"]', summary: 'Log one entry for today with guided prompts', load: () => import('../commands/quick.mjs'), fn: 'run' },
  { name: 'edit', usage: 'edit <id> [--hours h] [--task name|#id] [--desc text] [--type type]', summary: 'Change an existing RO entry (replaces it)', load: () => import('../commands/edit.mjs'), fn: 'runRoEditCommand' },
  { name: 'delete', usage: 'delete <id>', summary: 'Delete a submitted or approved RO entry', load: () => import('../commands/delete.mjs'), fn: 'runRoDeleteCommand' },
  { name: 'reconcile', usage: 'reconcile [period] [--json]', summary: 'Compare RO and Jira hours by day', load: () => import('../commands/reconcile.mjs'), fn: 'runReconcileCommand' },
  { name: 'history', usage: 'history [--target ro|jira|both] [--limit n] [--json]', summary: 'Show the local apply history', load: () => import('../commands/history.mjs'), fn: 'runHistoryCommand' },
  { name: 'login', usage: 'login [ro|jira] [--base-url url]', summary: 'Log in to Resource Optimiser (default) or Jira', load: () => import('../commands/auth.mjs'), fn: 'runLogin' },
  { name: 'logout', usage: 'logout [ro|jira]', summary: 'Remove the stored RO (default) or Jira session', load: () => import('../commands/auth.mjs'), fn: 'runLogout' },
  { name: 'status', usage: 'status', summary: 'Show RO and Jira login status', load: () => import('../commands/auth.mjs'), fn: 'runStatus' },
  { name: 'setup', usage: 'setup [--login|--no-login]', summary: 'Install the runtime and print MCP configs', load: () => import('../commands/setup.mjs'), fn: 'run' },
  { name: 'mcp', usage: 'mcp', summary: 'Run the MCP stdio server (used by IDE configs)', load: () => import('../lib/mcp-server.mjs'), fn: 'startMcpServer' },
  { name: 'reminder', usage: 'reminder enable|disable|status|test', summary: 'Manage the weekday logwork reminder', load: () => import('../commands/reminder.mjs'), fn: 'runReminderCli' },
  { name: 'update', usage: 'update [check|install]', summary: 'Check for or install a new version', load: () => import('../commands/update.mjs'), fn: 'runUpdateCli' },
  { name: 'doctor', usage: 'doctor', summary: 'Write a sanitized diagnostics report', load: () => import('../commands/doctor.mjs'), fn: 'run' },
  { name: 'release', usage: 'release doctor [--full]', summary: 'Maintainers: check release readiness', load: () => import('../commands/release.mjs'), fn: 'run' }
];

export async function run(argv = process.argv.slice(2)) {
  const [first, ...rest] = argv;

  if (first === '--version' || first === '-v') {
    console.log(readPackageVersion());
    return 0;
  }
  if (first === '--help' || first === '-h' || first === 'help') {
    console.log(formatHelp());
    return 0;
  }

  if (first !== 'mcp') {
    reportMigration(migrateLegacyHome());
  }

  if (!first || first.startsWith('-')) {
    const tui = await import('../commands/tui.mjs');
    return tui.run(argv);
  }

  const command = COMMANDS.find((item) => item.name === first);
  if (!command) {
    console.error(`Unknown command: ${first}\n`);
    console.error(formatHelp());
    return 1;
  }

  if (command.name === 'mcp') {
    migrateLegacyHome();
  }
  const module = await command.load();
  const result = await module[command.fn](rest);
  return typeof result === 'number' ? result : undefined;
}

export function formatHelp() {
  const width = Math.max(...COMMANDS.map((command) => command.name.length));
  return `Usage:
  logwork                 Open the terminal UI
  logwork <command>       Run one command (add --help for its options)

Commands:
${COMMANDS.map((command) => `  ${command.name.padEnd(width)}  ${command.summary}`).join('\n')}

Examples:
  logwork setup
  logwork login
  logwork query this-week
  logwork quick -m "Fix login bug (SCB-12)"
  logwork edit 304032 --task "Bug Fix" --desc "Fix date picker timezone (SAP-42)"

Options:
  -h, --help     Show help
  -v, --version  Show version`;
}

function reportMigration(result) {
  if (result?.migrated) {
    console.error(`Moved local settings from ${result.from} to ${result.to}.`);
  }
}

if (isMainModule(import.meta.url)) {
  run().then((code) => {
    if (typeof code === 'number') {
      process.exitCode = code;
    }
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
