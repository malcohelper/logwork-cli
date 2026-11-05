#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPackageVersion } from './lib/package-info.mjs';

const helperDir = dirname(fileURLToPath(import.meta.url));

const COMMANDS = new Map([
  ['setup-user', {
    script: 'install-user.mjs',
    description: 'Install Logwork Helper and print the onboarding checklist plus MCP configs.',
    help: `Usage:
  logwork-helper setup-user [--login|--no-login]

Installs the local helper runtime, links terminal commands, prints MCP configs, and shows the next verification steps.

Options:
  --login     Run Resource Optimiser auth login after installing
  --no-login  Do not prompt for auth login after installing

After setup:
  1. Authenticate if setup did not complete auth for you.
  2. Paste one printed MCP config into your IDE.
  3. Restart or reload the IDE MCP tools.
  4. Ask: Check my logwork for this week.`
  }],
  ['install-user', {
    script: 'install-user.mjs',
    description: 'Alias for setup-user.'
  }],
  ['mcp', {
    script: 'mcp-server.mjs',
    description: 'Run the local MCP stdio server.'
  }],
  ['auth', {
    script: 'auth-cli.mjs',
    description: 'Manage Resource Optimiser authentication.',
    help: `Usage:
  logwork-helper auth login
  logwork-helper auth status
  logwork-helper auth logout

Authentication uses the Resource Optimiser / Keycloak API flow and does not open a browser.`
  }],
  ['jira', {
    script: 'jira-cli.mjs',
    description: 'Manage Jira Personal Access Token authentication.',
    help: `Usage:
  logwork-helper jira login [--base-url <url>]
  logwork-helper jira status
  logwork-helper jira logout

Authentication uses a Jira Personal Access Token entered in Terminal. MCP tools never accept Jira tokens.`
  }],
  ['diagnostics', {
    script: 'diagnostics-cli.mjs',
    description: 'Write a sanitized support diagnostics report.',
    help: `Usage:
  logwork-helper diagnostics

Writes a sanitized support report under the local helper diagnostics directory.
Send only the generated file to developers; do not send raw curl logs, cookies, passwords, OTPs, or tokens.`
  }],
  ['release', {
    script: 'release-cli.mjs',
    description: 'Check release readiness before npm and GitHub publishing.',
    help: `Usage:
  logwork-helper release doctor [--full]

Checks version, git state, npm auth, npm latest, GitHub auth, tags, releases, and local release artifacts.

Options:
  --full    Also run npm test, npm audit, npm pack --dry-run, and git diff --check`
  }],
  ['history', {
    script: 'history-cli.mjs',
    description: 'Show the local RO/Jira apply result ledger.',
    help: `Usage:
  logwork-helper history [--target ro|jira|both] [--limit <count>] [--json]

Shows recent apply outcomes without credentials or raw API responses.
Target both filters entries that came from the combined Both flow.`
  }],
  ['edit', {
    script: 'edit-logwork-cli.mjs',
    description: 'Preview and edit an existing Resource Optimiser logwork.',
    help: `Usage:
  logwork-helper edit <logwork-id> --hours <hours> [--yes] [--json]
  logwork-helper edit <logwork-id> --task-name <text> [--yes] [--json]
  logwork-helper edit <logwork-id> --hours <hours> --task-name <text> [--yes] [--json]

Project and date are preserved. The write requires interactive confirmation or --yes.`
  }],
  ['delete', {
    script: 'delete-logwork-cli.mjs',
    description: 'Preview and soft-delete a submitted or approved Resource Optimiser logwork entry.',
    help: `Usage:
  logwork-helper delete <logwork-id> [--yes] [--json]

Soft-deletes via DELETE /logwork/entries/:id. Only submitted or approved entries. Requires confirmation or --yes.`
  }],
  ['reconcile', {
    script: 'reconcile-cli.mjs',
    description: 'Compare Resource Optimiser and Jira worklogs by preset period.',
    help: `Usage:
  logwork-helper reconcile [today|yesterday|this-week|last-week|this-month|last-month] [--json]

Read-only comparison of RO and Jira hours by day. High-confidence correction suggestions must still use the existing target-specific preview and approval flow.`
  }],
  ['update', {
    script: 'update-cli.mjs',
    description: 'Check for and install Logwork Helper updates from npm.',
    help: `Usage:
  logwork-helper update check [--force] [--json]
  logwork-helper update install [--version <semver>] [--yes] [--json]

Checks npm latest with a 24-hour cache. Install accepts only the exact latest SemVer, preserves local state and OS credentials, and requires confirmation.`
  }],
  ['reminder', {
    script: 'reminder-cli.mjs',
    description: 'Manage native macOS/Windows logwork reminders.',
    help: `Usage:
  logwork-helper reminder enable [--time HH:mm] [--target ro|jira|both] [--yes]
  logwork-helper reminder status [--json]
  logwork-helper reminder test [--target ro|jira|both] [--yes]
  logwork-helper reminder disable [--yes]

Schedules a smart Monday-Friday reminder through launchd on macOS or Task Scheduler on Windows.`
  }],
  ['doctor', {
    script: 'diagnostics-cli.mjs',
    description: 'Alias for diagnostics; write a sanitized setup health report.',
    help: `Usage:
  logwork-helper doctor

Runs the same checks as diagnostics and writes a sanitized support report under the local helper diagnostics directory.
Send only the generated file to developers; do not send raw curl logs, cookies, passwords, OTPs, or tokens.`
  }],
  ['manual', {
    script: 'manual-log.mjs',
    description: 'Open the manual terminal logwork REPL.',
    help: `Usage:
  logwork
  logwork-helper manual
  logwork-helper manual quick --message "Task name"

Preferred shortcut:
  logwork

Commands inside the REPL:
  Type / for live command suggestions.
  /help
  /query today
  /query yesterday
  /query this-week
  /query last-week
  /query this-month
  /query last-month
  /reconcile
  /reconcile this-week
  /logwork
  /logwork ro
  /logwork jira
  /logwork both
  /edit-logwork 290364 --hours 0.5
  /mcp
  /projects
  /projects 5234
  /map SCB 5234
  /diagnostics
  /history
  Press Esc to exit`
  }],
  ['log', {
    script: 'manual-log.mjs',
    description: 'Alias for manual terminal REPL.'
  }],
  ['install-hook', {
    script: 'install.mjs',
    description: 'Install the commit-msg hook into a Git repository.'
  }],
  ['install', {
    script: 'install.mjs',
    description: 'Alias for install-hook.'
  }],
  ['hook', {
    script: 'logwork-helper.mjs',
    description: 'Run the commit-msg hook helper.'
  }]
]);

async function main() {
  const argv = process.argv.slice(2);
  const firstArg = argv[0];

  if (!firstArg || firstArg === '--help' || firstArg === '-h') {
    printHelp();
    return;
  }

  if (firstArg === '--version' || firstArg === '-v') {
    console.log(readPackageVersion());
    return;
  }

  const command = COMMANDS.get(firstArg);
  if (command) {
    const commandArgs = argv.slice(1);
    if (commandArgs.includes('--help') || commandArgs.includes('-h')) {
      printCommandHelp(firstArg, command);
      return;
    }

    process.exitCode = await runScript(command.script, commandArgs);
    return;
  }

  if (firstArg.startsWith('--')) {
    process.exitCode = await runScript('logwork-helper.mjs', argv);
    return;
  }

  console.error(`Unknown command: ${firstArg}`);
  console.error('');
  printHelp();
  process.exitCode = 1;
}

function runScript(script, args) {
  return new Promise((resolveValue, reject) => {
    const child = spawn(process.execPath, [join(helperDir, script), ...args], {
      cwd: helperDir,
      stdio: 'inherit',
      env: process.env
    });

    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (signal) {
        resolveValue(1);
        return;
      }

      resolveValue(code ?? 1);
    });
  });
}

function printHelp() {
  console.log(`Usage:
  logwork-helper setup-user
  logwork-helper auth login
  logwork-helper jira login
  logwork-helper release doctor --full
  logwork-helper update check
  logwork-helper reminder status
  logwork-helper reconcile this-week
  logwork-helper history --target jira
  logwork-helper edit 290364 --hours 0.5
  logwork-helper diagnostics
  logwork-helper doctor
  logwork-helper mcp
  logwork
  logwork-helper manual
  logwork-helper manual quick --message "Task name"
  logwork-helper install-hook /path/to/repo
  logwork-helper hook --repo <repo> --msg-file <file> --lock <file> --result <file> --nonce <id> --terminal-title <title>

Primary setup:
  1. Run: logwork-helper setup-user
  2. Authenticate Resource Optimiser and Jira if needed.
  3. Paste one printed MCP config into your IDE.
  4. Restart or reload the IDE MCP tools.
  5. Ask: Check my logwork for this week.

Commands:
${formatCommands()}

Options:
  -h, --help     Show help
  -v, --version  Show version
`);
}

function printCommandHelp(name, command) {
  if (command.help) {
    console.log(`${command.help}\n`);
    return;
  }

  console.log(`Usage:
  logwork-helper ${name}

${command.description}
`);
}

function formatCommands() {
  return [...COMMANDS.entries()]
    .map(([name, command]) => `  ${name.padEnd(13)} ${command.description}`)
    .join('\n');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
