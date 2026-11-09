// `logwork mcp`: with no arguments, the MCP stdio server that every IDE config
// runs. Nothing may be written to stdout before the server starts, because
// stdout is the protocol channel. `install`, `status` and `--help` are
// dispatched first. The modules imported here never write to stdout.
import { constants as fsConstants, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { writeLauncher } from '../lib/launcher.mjs';
import { helperHome } from '../lib/paths.mjs';
import {
  MCP_INSTALL_CLIENT_KEYS,
  applyMcpClientPlan,
  createMcpInstallContext,
  describeMcpPlan,
  inspectMcpClients,
  normalizeMcpInstallClient,
  planMcpInstall
} from '../lib/mcp-install.mjs';

export async function run(argv = []) {
  if (!argv.length) {
    const { startMcpServer } = await import('../lib/mcp-server.mjs');
    return startMcpServer();
  }
  const [sub, ...rest] = argv;
  if (sub === '--help' || sub === '-h' || sub === 'help') {
    console.log(formatMcpHelp());
    return 0;
  }
  if (sub === 'install') {
    if (rest.includes('--help') || rest.includes('-h')) {
      console.log(formatMcpHelp());
      return 0;
    }
    return runMcpInstallCli(parseMcpInstallArgs(rest));
  }
  if (sub === 'status') {
    if (rest.includes('--help') || rest.includes('-h')) {
      console.log(formatMcpHelp());
      return 0;
    }
    if (rest.length) {
      throw new Error(`Unknown mcp status option: ${rest[0]}`);
    }
    return runMcpStatusCli();
  }
  throw new Error(`Unknown mcp command: ${sub}. Run \`logwork mcp --help\`.`);
}

export function formatMcpHelp() {
  return `Usage:
  logwork mcp                 Run the MCP stdio server (what IDE configs run)
  logwork mcp install [--client claude|cursor|codex|vscode|antigravity]... [--yes] [--dry-run]
  logwork mcp status

install  Adds or updates the "logwork" server in the MCP clients found on this
         machine (Claude Code, Cursor, Codex, VS Code, Google Antigravity).
         Asks once per client unless --yes. Each edited file is backed up next
         to itself first (<file>.logwork-backup-<timestamp>). An old
         "logwork-helper" entry is removed.
status   Shows each client and whether its "logwork" entry is current, stale
         or missing.

Options:
  --client <name>  Only this client (repeatable)
  --yes, -y        Update every selected client without asking
  --dry-run        Show the planned changes without writing anything`;
}

export function parseMcpInstallArgs(args = []) {
  const options = { clients: [], yes: false, dryRun: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--yes' || arg === '-y') {
      options.yes = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--client' || arg.startsWith('--client=')) {
      const value = arg === '--client' ? args[++index] : arg.slice('--client='.length);
      const key = normalizeMcpInstallClient(value);
      if (!key) {
        throw new Error(`Unknown MCP client: ${value || '(missing)'}. Use claude, cursor, codex, vscode or antigravity.`);
      }
      if (!options.clients.includes(key)) {
        options.clients.push(key);
      }
    } else {
      throw new Error(`Unknown mcp install option: ${arg}`);
    }
  }
  return options;
}

async function runMcpInstallCli(options) {
  const ctx = createMcpInstallContext();
  const warning = await prepareRuntimeLauncher(helperHome(), { dryRun: options.dryRun });
  if (warning) {
    console.error(warning);
  }
  const result = await runMcpInstall({ ...options, ctx, interactive: isInteractiveTerminal() });
  console.log(result.output);
  return result.results.some((item) => item.status === 'failed') ? 1 : 0;
}

async function runMcpStatusCli() {
  const result = await runMcpStatus({ ctx: createMcpInstallContext() });
  console.log(result.output);
  return 0;
}

// The configs point at <home>/bin/logwork-launch (macOS/Linux), which
// `logwork setup` writes. Write it here too, so `logwork mcp install` works
// without a fresh setup. Returns a warning when the runtime itself is missing.
export async function prepareRuntimeLauncher(home, {
  dryRun = false,
  platform = process.platform,
  access = fs.access,
  write = writeLauncher
} = {}) {
  const entry = join(home, 'bin', 'logwork.mjs');
  try {
    await access(entry, fsConstants.F_OK);
  } catch {
    return `Warning: the logwork runtime is missing at ${entry}. Run \`logwork setup\` so the configured command can start.`;
  }
  if (!dryRun && platform !== 'win32') {
    await write({ home, platform });
  }
  return '';
}

export function isInteractiveTerminal() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function clackConfirm(message) {
  const { confirm, isCancel } = await import('@clack/prompts');
  const answer = await confirm({ message, initialValue: true });
  return !isCancel(answer) && Boolean(answer);
}

// Plans, asks (unless --yes), applies and formats. Returns
// { plans, results, output, pending } where pending lists the clients that
// still need a change when nothing was applied (dry run or not interactive).
export async function runMcpInstall({
  ctx,
  clients = [],
  yes = false,
  dryRun = false,
  interactive = false,
  confirmFn = clackConfirm
} = {}) {
  const explicit = clients.length > 0;
  const plans = await planMcpInstall(ctx, {
    clients: explicit ? clients : MCP_INSTALL_CLIENT_KEYS,
    explicit
  });
  const header = `MCP server "logwork" runs: ${formatCommandLine(ctx)}`;
  const pending = plans.filter((plan) => plan.action === 'add' || plan.action === 'update');

  if (!plans.length) {
    return {
      plans,
      results: [],
      pending,
      output: [header, 'No MCP clients found (Claude Code, Cursor, Codex, VS Code, Google Antigravity). Use `/mcp` in the terminal UI for copy-ready configs.'].join('\n')
    };
  }

  if (dryRun || (!yes && !interactive)) {
    const lines = [header, dryRun ? 'Dry run: nothing was written.' : 'Not an interactive terminal: nothing was written.'];
    for (const plan of plans) {
      lines.push(...describeMcpPlan(plan, ctx));
    }
    if (pending.length && !dryRun) {
      lines.push('Run `logwork mcp install --yes` to apply these changes.');
    }
    return { plans, results: [], pending, output: lines.join('\n') };
  }

  const results = [];
  for (const plan of plans) {
    if ((plan.action === 'add' || plan.action === 'update') && !yes) {
      const verb = plan.action === 'add' ? 'Add' : 'Update';
      const where = plan.kind === 'claude' && plan.cliPath ? 'with the claude CLI' : plan.file;
      const accepted = await confirmFn(`${verb} the logwork MCP server in ${plan.label} (${where})?`);
      if (!accepted) {
        results.push({ key: plan.key, label: plan.label, file: plan.file, status: 'skipped' });
        continue;
      }
    }
    results.push(await applyMcpClientPlan(plan, ctx));
  }
  return { plans, results, pending, output: [header, ...formatMcpInstallResults(results)].join('\n') };
}

export function formatMcpInstallResults(results) {
  const lines = [];
  for (const result of results) {
    switch (result.status) {
      case 'added':
      case 'updated':
        lines.push(`- ${result.label}: ${result.status}${result.via ? ` (${result.via})` : ` (${result.file})`}${result.backup ? `; backup ${result.backup}` : ''}`);
        break;
      case 'up_to_date':
        lines.push(`- ${result.label}: already up to date`);
        break;
      case 'skipped':
        lines.push(`- ${result.label}: skipped`);
        break;
      case 'not_detected':
        lines.push(`- ${result.label}: not detected; skipped`);
        break;
      default:
        lines.push(`- ${result.label}: could not update automatically (${result.reason || 'unknown error'}). Add this manually${result.file ? ` to ${result.file}` : ''}:`);
        lines.push(...String(result.snippet || '').split('\n').map((line) => `    ${line}`));
    }
  }
  if (results.some((result) => result.status === 'added' || result.status === 'updated')) {
    lines.push('Restart or reload the updated clients to pick up the change.');
  }
  return lines;
}

export async function runMcpStatus({ ctx } = {}) {
  const clients = await inspectMcpClients(ctx);
  const lines = [`MCP server "logwork" should run: ${formatCommandLine(ctx)}`];
  const commandExists = await ctx.fs.access(ctx.launch.command).then(() => true, () => false);
  if (!commandExists) {
    lines.push(`Warning: ${ctx.launch.command} is missing, so these entries cannot start. Run \`logwork setup\`.`);
  }
  for (const client of clients) {
    lines.push(...formatClientStatus(client));
  }
  const needsWork = clients.some((client) => client.detected && (client.status !== 'current' || client.legacy || (client.localScopes || []).length));
  if (!clients.some((client) => client.detected)) {
    lines.push('No MCP clients found. Use `/mcp` in the terminal UI for copy-ready configs.');
  } else if (needsWork) {
    lines.push('Run `logwork mcp install` to fix the entries above.');
  }
  return { clients, output: lines.join('\n') };
}

function formatClientStatus(client) {
  if (!client.detected) {
    return [`- ${client.label}: not detected`];
  }
  const where = client.kind === 'claude' && client.cliPath ? `${client.file}; claude CLI found` : client.file;
  const state = {
    current: 'current',
    missing: 'missing',
    stale: `stale: ${client.reason}`,
    unreadable: `unreadable: ${client.reason}`
  }[client.status] || client.status;
  const lines = [`- ${client.label} (${where}): ${state}`];
  if (client.legacy) {
    lines.push('    leftover "logwork-helper" entry (old runtime)');
  }
  for (const stray of client.localScopes || []) {
    lines.push(`    local-scope "${stray.name}" entry for ${stray.project}: ${stray.reason || 'stale'}`);
  }
  return lines;
}

function formatCommandLine(ctx) {
  return [ctx.launch.command, ...ctx.launch.argsPrefix, 'mcp'].join(' ');
}
