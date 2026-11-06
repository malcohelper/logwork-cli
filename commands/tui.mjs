import { resolve } from 'node:path';
import { runManualRepl } from '../lib/manual-repl.mjs';
import { checkForUpdates, formatUpdateNotice } from '../lib/update-service.mjs';

// `logwork` with no command: the Ink terminal UI.
export async function run(argv = []) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(formatTuiHelp());
    return 0;
  }
  if (argv.length) {
    throw new Error(`Unknown option: ${argv[0]}. Run \`logwork --help\` for commands.`);
  }

  const updateNotice = process.stdin.isTTY && process.stdout.isTTY
    ? await getStartupUpdateNotice()
    : '';
  await runManualRepl({
    cwd: resolve(process.cwd()),
    updateNotice
  });
  return undefined;
}

export async function getStartupUpdateNotice({ checkForUpdatesFn = checkForUpdates } = {}) {
  try {
    return formatUpdateNotice(await checkForUpdatesFn());
  } catch {
    return '';
  }
}

export function formatTuiHelp() {
  return `Usage:
  logwork

Opens the terminal UI. Type / for live command suggestions, Esc to exit.

Common commands inside the UI:
  /query this-week          Booked vs logged hours with entry ids
  /logwork                  Paste or write a weekly block, preview, then apply
  /edit-logwork 304032 --task Bug Fix --desc Fix date picker (SAP-42)
  /reconcile this-week      Compare RO and Jira
  /projects                 List RO projects
  /map SCB 5234             Map a ticket prefix to a project
  /mcp                      Show MCP config for an IDE
  /history                  Local apply history

Run \`logwork --help\` for the CLI commands.`;
}
