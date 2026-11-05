import { stdin as defaultInput, stdout as defaultOutput } from 'node:process';
import { confirm, isCancel } from '@clack/prompts';
import { getStoredAuthStatus, loginResourceOptimiser } from './auth.mjs';
import { queryApplyLedger } from './apply-ledger.mjs';
import { isAuthRequiredError } from './auth-errors.mjs';
import { applyLogworkBatch, previewLogworkBatch } from './batch-workflow.mjs';
import {
  applyJiraWorklogBatch,
  previewJiraWorklogBatch
} from './jira-workflow.mjs';
import {
  getStoredJiraStatus,
  isJiraAuthRequiredError
} from './jira-auth.mjs';
import {
  buildLogworkText,
  buildProjectOverrides,
  formatHours,
  parseTaskLine
} from './manual-logwork-wizard.mjs';
import {
  BOTH_TARGET,
  jiraLoginInstruction,
  JIRA_TARGET,
  parseTargetToken,
  previewTargets,
  RO_TARGET,
  targetLabel
} from './manual-targets.mjs';
import { findManualCommand, formatManualHelp } from './manual-commands.mjs';
import {
  buildManualApplyConfirmation,
  buildManualUnbookedConfirmation,
  getManualApplyBlocker,
  manualUnbookedEntryCount
} from './manual-apply-state.mjs';
import { runManualInkApp } from './manual-ink-app.mjs';
import { createManualLineReader } from './manual-input.mjs';
import { generateDiagnosticsReport } from './diagnostics.mjs';
import {
  formatMcpClientOptions,
  formatMcpSetup,
  resolveMcpClient,
  resolveMcpClientSelection
} from './manual-mcp.mjs';
import {
  enrichRoPreviewWithJiraProjects,
  listLogworkProjects,
  upsertProjectMapping
} from './project-mapping-workflow.mjs';
import { queryLogwork } from './query-workflow.mjs';
import { parseRoEditArgs } from './ro-edit-args.mjs';
import {
  applyRoLogworkEdit,
  previewRoLogworkEdit
} from './ro-edit-workflow.mjs';
import {
  normalizeReconciliationPeriod,
  reconcileLogwork
} from './reconciliation-workflow.mjs';
import {
  projectIdentityKey,
  projectMatchesFilter,
  sameProjectIdentity
} from './project-identity.mjs';

export const MANUAL_HELP = formatManualHelp();

export function createManualSession() {
  return {
    activeTarget: RO_TARGET,
    previews: {
      [RO_TARGET]: null,
      [JIRA_TARGET]: null
    },
    logworkDraft: null
  };
}

export async function runManualRepl({
  input = defaultInput,
  output = defaultOutput,
  cwd = process.cwd(),
  workflows = defaultWorkflows(),
  prompts = createManualPrompts(),
  showIntro = true,
  updateNotice = ''
} = {}) {
  if (input?.isTTY && output?.isTTY) {
    await runManualInkApp({
      input,
      output,
      cwd,
      workflows,
      controller: {
        createManualSession,
        executeManualCommand,
        parseManualCommand
      },
      showIntro,
      updateNotice
    });
    return;
  }

  const lineReader = createManualLineReader({
    input,
    output
  });
  const session = createManualSession();
  const context = {
    cwd,
    workflows,
    prompts,
    print(message = '') {
      output.write(`${message}\n`);
    },
    readLine(prompt = '') {
      return lineReader.readLine(prompt);
    }
  };

  try {
    if (showIntro) {
      context.print('Logwork Helper manual session. Type /help for commands.');
      if (updateNotice) {
        context.print(updateNotice);
      }
    }

    while (true) {
      let line;
      try {
        line = await context.readLine('logwork> ');
      } catch (error) {
        if (error.code === 'ERR_USE_AFTER_CLOSE' || /closed|end of input|EOF/i.test(error.message)) {
          break;
        }
        throw error;
      }
      let command;
      try {
        command = parseManualCommand(line);
        const result = await executeManualCommand(command, session, context);
        if (result.exit) {
          break;
        }
      } catch (error) {
        context.print(`Error: ${error.message}`);
      }
    }
  } finally {
    lineReader.close();
  }
}

export function parseManualCommand(line) {
  const input = String(line || '').trim();
  if (!input) {
    return { type: 'noop' };
  }

  if (!input.startsWith('/')) {
    throw new Error(`Unknown command: ${input}. Type /help for commands.`);
  }

  const [rawCommand, ...parts] = input.split(/\s+/);
  const commandInfo = findManualCommand(rawCommand);
  const command = commandInfo?.name;

  if (command === '/help') {
    return { type: 'help' };
  }

  if (command === '/auth') {
    return parseTargetCommand('auth', parts, { allowBoth: false });
  }

  if (command === '/status') {
    return parseTargetCommand('status', parts, { allowBoth: false });
  }

  if (command === '/diagnostics') {
    return { type: 'diagnostics' };
  }

  if (command === '/history') {
    return parseTargetCommand('history', parts, { allowBoth: true });
  }

  if (command === '/projects') {
    return {
      type: 'projects',
      project: parts.join(' ').trim() || undefined
    };
  }

  if (command === '/logwork') {
    return parseLogworkCommand(parts);
  }

  if (command === '/edit-logwork') {
    const options = parseRoEditArgs(parts);
    if (options.yes || options.json) {
      throw new Error('/edit-logwork always previews and confirms interactively; --yes and --json are not supported here.');
    }
    return {
      type: 'edit_ro_logwork',
      logworkId: options.logworkId,
      hours: options.hours,
      taskName: options.taskName
    };
  }

  if (command === '/mcp') {
    const clientName = parts.join(' ').trim();
    if (!clientName) {
      return {
        type: 'mcp',
        client: undefined
      };
    }
    const client = resolveMcpClient(clientName);
    if (!client) {
      throw new Error('Unknown MCP client. Use: /mcp cursor | antigravity | copilot | claude-code | codex');
    }
    return {
      type: 'mcp',
      client: client.key
    };
  }

  if (command === '/apply') {
    return parseTargetCommand('apply', parts, { allowBoth: true });
  }

  if (command === '/query') {
    return {
      type: 'query',
      args: parseQueryArgs(parts.join(' ').trim())
    };
  }

  if (command === '/reconcile') {
    if (parts.length > 1) {
      throw new Error('Usage: /reconcile today | yesterday | this-week | last-week | this-month | last-month');
    }
    return {
      type: 'reconcile',
      period: parts[0] ? normalizeReconciliationPeriod(parts[0]) : undefined
    };
  }

  if (command === '/map') {
    return parseMapCommand(parts);
  }

  throw new Error(`Unknown command: ${rawCommand}. Type /help for commands.`);
}

export async function executeManualCommand(command, session, context) {
  const {
    cwd = process.cwd(),
    workflows = defaultWorkflows(),
    prompts = createManualPrompts(),
    print = console.log,
    readLine
  } = context;

  if (command.type === 'noop') {
    return { exit: false };
  }

  if (command.type === 'help') {
    print(MANUAL_HELP);
    return { exit: false };
  }

  if (command.type === 'auth') {
    const target = command.target || await readAuthTarget({ readLine, print });
    if (target === JIRA_TARGET) {
      print(jiraLoginInstruction());
      return { exit: false };
    }
    const result = await workflows.loginResourceOptimiser();
    print(result.summary);
    return { exit: false };
  }

  if (command.type === 'status') {
    if (command.target === RO_TARGET) {
      const result = await workflows.getStoredAuthStatus();
      print(result.summary);
      return { exit: false };
    }
    if (command.target === JIRA_TARGET) {
      const result = await workflows.getStoredJiraStatus();
      print(result.summary);
      return { exit: false };
    }

    const ro = await workflows.getStoredAuthStatus();
    const jira = await workflows.getStoredJiraStatus();
    print([
      'Auth status:',
      `- Resource Optimiser: ${ro.summary}`,
      `- Jira: ${jira.summary}`
    ].join('\n'));
    return { exit: false };
  }

  if (command.type === 'diagnostics') {
    const result = await workflows.generateDiagnosticsReport({ cwd });
    print(result.summary);
    print('Send this sanitized file to the developer. Do not send raw curl logs, cookies, passwords, OTPs, or tokens.');
    return { exit: false };
  }

  if (command.type === 'history') {
    const result = await workflows.queryApplyLedger({
      target: command.target,
      cwd,
      limit: 20
    });
    print(result.summary);
    return { exit: false };
  }

  if (command.type === 'query') {
    const result = await runWithInlineAuth(() => workflows.queryLogwork({
      ...command.args,
      cwd,
      includeEntries: true
    }), { workflows, print });
    print(result.summary);
    return { exit: false };
  }

  if (command.type === 'reconcile') {
    const result = await runWithJiraAuthInstructions(() => runWithInlineAuth(() => workflows.reconcileLogwork({
      period: command.period || 'this_week',
      cwd
    }), { workflows, print }));
    print(result.summary);
    return { exit: false };
  }

  if (command.type === 'projects') {
    const result = await runWithInlineAuth(async () => {
      const projectsResult = await workflows.listLogworkProjects({ cwd });
      const weekly = await workflows.queryLogwork({
        period: 'this_week',
        project: command.project,
        cwd,
        includeEntries: false
      });
      return { projectsResult, weekly };
    }, { workflows, print });
    print(formatProjects(result.projectsResult, result.weekly, command.project));
    return { exit: false };
  }

  if (command.type === 'map') {
    const ok = await prompts.confirm(`Map ${command.tickets.join(', ')} to projectMemberId ${command.projectMemberId}?`);
    if (!ok) {
      print('Mapping cancelled.');
      return { exit: false };
    }

    const result = await runWithInlineAuth(() => workflows.upsertProjectMapping({
      projectMemberId: command.projectMemberId,
      tickets: command.tickets,
      keywords: [],
      scope: 'user',
      confirm: true,
      cwd
    }), { workflows, print });
    print(result.summary);
    return { exit: false };
  }

  if (command.type === 'logwork') {
    const target = command.target || (command.text ? RO_TARGET : await readLogworkTarget({ readLine, print }));
    const text = command.text || await readPasteBlock({ readLine, print, target });
    const previews = await previewManualText({
      target,
      text,
      projectOverrides: command.projectOverrides || {},
      cwd,
      workflows,
      print
    });
    setSessionPreviews(session, target, previews);
    print(formatManualPreviewSummaries(target, previews));
    return { exit: false };
  }

  if (command.type === 'edit_ro_logwork') {
    const editPreview = await runWithInlineAuth(() => workflows.previewRoLogworkEdit({
      logworkId: command.logworkId,
      hours: command.hours,
      taskName: command.taskName
    }), { workflows, print });
    print(editPreview.summary);
    const confirmed = await prompts.confirm(`Apply RO logwork edit ${editPreview.previewId}?`, false);
    if (!confirmed) {
      print('RO logwork edit cancelled.');
      return { exit: false };
    }
    const result = await runWithInlineAuth(() => workflows.applyRoLogworkEdit({
      preview: editPreview,
      confirm: true,
      cwd
    }), { workflows, print });
    print(result.summary);
    return { exit: false };
  }

  if (command.type === 'mcp') {
    const client = command.client || await readMcpClient({ readLine, print });
    print(formatMcpSetup({ client }));
    return { exit: false };
  }

  if (command.type === 'apply') {
    await applyManualTarget({
      target: command.target || session.activeTarget || RO_TARGET,
      session,
      cwd,
      workflows,
      prompts,
      print
    });
    return { exit: false };
  }

  throw new Error(`Unsupported command type: ${command.type}`);
}

async function readMcpClient({ readLine, print }) {
  if (typeof readLine !== 'function') {
    throw new Error('/mcp requires an interactive terminal or a client name, for example: /mcp cursor');
  }

  print(formatMcpClientOptions());
  while (true) {
    const answer = await readLine('mcp client> ');
    const client = resolveMcpClientSelection(answer);
    if (client) {
      return client.key;
    }
    print('Unknown MCP client. Choose a number or type: cursor, antigravity, copilot, claude-code, codex.');
  }
}

async function readLogworkTarget({ readLine, print }) {
  if (typeof readLine !== 'function') {
    throw new Error('/logwork requires a target when not using the interactive picker: /logwork ro | jira | both');
  }

  print('Choose logwork target: ro, jira, or both.');
  while (true) {
    const target = parseTargetToken(await readLine('target> '));
    if (target) {
      return target;
    }
    print('Unknown target. Use: ro, jira, or both.');
  }
}

async function readAuthTarget({ readLine, print }) {
  if (typeof readLine !== 'function') {
    throw new Error('/auth requires a target when not using the interactive picker: /auth ro | jira');
  }

  print('Choose auth target: ro or jira.');
  while (true) {
    const target = parseTargetToken(await readLine('auth target> '), { allowBoth: false });
    if (target) {
      return target;
    }
    print('Unknown target. Use: ro or jira.');
  }
}

export function createManualPrompts() {
  return {
    async confirm(message, initialValue = true) {
      const answer = await confirm({
        message,
        initialValue
      });
      if (isCancel(answer)) {
        throw new Error('User cancelled Logwork Helper manual session.');
      }
      return Boolean(answer);
    }
  };
}

async function readPasteBlock({ readLine, print, target = RO_TARGET }) {
  if (typeof readLine !== 'function') {
    throw new Error('/logwork requires an interactive terminal.');
  }

  print(`Paste ${targetLabel(target)} weekly logwork text. Finish with /end on its own line.`);
  const lines = [];
  while (true) {
    const line = await readLine('');
    if (line.trim() === '/end') {
      break;
    }
    lines.push(line);
  }

  const text = lines.join('\n').trim();
  if (!text) {
    throw new Error('Preview text is empty.');
  }
  return text;
}

async function previewManualText({
  target,
  text,
  projectOverrides = {},
  cwd,
  workflows,
  print
}) {
  const previews = {};
  if (previewTargets(target).includes(RO_TARGET)) {
    previews[RO_TARGET] = await runWithInlineAuth(() => workflows.previewLogworkBatch({
      text,
      projectOverrides,
      cwd
    }), { workflows, print });
  }
  if (previewTargets(target).includes(JIRA_TARGET)) {
    previews[JIRA_TARGET] = await runWithJiraAuthInstructions(() => workflows.previewJiraWorklogBatch({
      text
    }));
  }
  if (target === BOTH_TARGET && previews[RO_TARGET] && previews[JIRA_TARGET]) {
    previews[RO_TARGET] = enrichRoPreviewWithJiraProjects(previews[RO_TARGET], previews[JIRA_TARGET]);
  }
  return previews;
}

function setSessionPreviews(session, target, previews) {
  session.activeTarget = target;
  session.previews = {
    ...(session.previews || {}),
    ...previews
  };
}

function getSessionPreview(session, target) {
  return session.previews?.[target] || null;
}

function clearSessionPreview(session, target) {
  if (session.previews) {
    session.previews[target] = null;
  }
}

function clearSessionDraftIfNoPreviews(session) {
  if (!session.previews?.[RO_TARGET] && !session.previews?.[JIRA_TARGET]) {
    session.logworkDraft = null;
  }
}

function formatManualPreviewSummaries(target, previews) {
  return previewTargets(target)
    .map((previewTarget) => {
      const preview = previews[previewTarget];
      return [
        `${targetLabel(previewTarget)} preview:`,
        preview?.summary || 'No preview returned.'
      ].join('\n');
    })
    .join('\n\n');
}

async function applyManualTarget({
  target,
  flowTarget = target,
  session,
  cwd,
  workflows,
  prompts,
  print
}) {
  if (target === BOTH_TARGET) {
    let appliedAny = false;
    for (const previewTarget of [RO_TARGET, JIRA_TARGET]) {
      const applied = await applyManualTarget({
        target: previewTarget,
        flowTarget: BOTH_TARGET,
        session,
        cwd,
        workflows,
        prompts,
        print
      });
      appliedAny = appliedAny || applied;
    }
    if (!appliedAny && !getSessionPreview(session, RO_TARGET) && !getSessionPreview(session, JIRA_TARGET)) {
      print('No preview available. Run /logwork first.');
    }
    return appliedAny;
  }

  if (target === JIRA_TARGET) {
    return applyManualJiraPreview({
      flowTarget,
      session,
      workflows,
      prompts,
      print
    });
  }

  return applyManualRoPreview({
    flowTarget,
    session,
    cwd,
    workflows,
    prompts,
    print
  });
}

async function applyManualRoPreview({
  flowTarget,
  session,
  cwd,
  workflows,
  prompts,
  print
}) {
  const preview = getSessionPreview(session, RO_TARGET);
  const blocker = getManualApplyBlocker(preview);
  if (blocker) {
    print(blocker);
    return false;
  }

  const confirmed = await prompts.confirm(buildManualApplyConfirmation(preview));
  if (!confirmed) {
    print('Resource Optimiser apply cancelled.');
    return false;
  }

  let allowUnbooked = false;
  if (manualUnbookedEntryCount(preview)) {
    allowUnbooked = await prompts.confirm(buildManualUnbookedConfirmation(preview));
    if (!allowUnbooked) {
      print('Resource Optimiser apply cancelled because unbooked entries were not approved.');
      return false;
    }
  }

  const result = await runWithInlineAuth(() => workflows.applyLogworkBatch({
    batch: preview,
    confirm: true,
    allowUnbooked,
    cwd,
    ledgerContext: { flowTarget }
  }), { workflows, print });
  print(result.summary);
  if (result.verification?.summary) {
    print('');
    print(result.verification.summary);
  }
  clearSessionPreview(session, RO_TARGET);
  clearSessionDraftIfNoPreviews(session);
  return true;
}

async function applyManualJiraPreview({
  flowTarget,
  session,
  workflows,
  prompts,
  print
}) {
  const preview = getSessionPreview(session, JIRA_TARGET);
  const blocker = getManualJiraApplyBlocker(preview);
  if (blocker) {
    print(blocker);
    return false;
  }

  const confirmed = await prompts.confirm(buildManualJiraApplyConfirmation(preview));
  if (!confirmed) {
    print('Jira apply cancelled.');
    return false;
  }

  const result = await runWithJiraAuthInstructions(() => workflows.applyJiraWorklogBatch({
    batch: preview,
    confirm: true,
    ledgerContext: { flowTarget }
  }));
  print(result.summary);
  clearSessionPreview(session, JIRA_TARGET);
  clearSessionDraftIfNoPreviews(session);
  return true;
}

function getManualJiraApplyBlocker(preview) {
  if (!preview) {
    return 'No Jira preview available. Run /logwork jira first.';
  }
  if (preview.errors?.length) {
    return 'Cannot apply Jira preview with parse errors.';
  }
  const blocked = (preview.entries || []).filter((entry) => entry.status !== 'ready');
  if (blocked.length) {
    return `Cannot apply Jira preview with ${blocked.length} blocked entries.`;
  }
  if (!(preview.entries || []).length) {
    return 'Cannot apply Jira preview with no entries.';
  }
  return '';
}

function buildManualJiraApplyConfirmation(preview) {
  const entries = preview.entries || [];
  const hours = entries.reduce((sum, entry) => sum + Number(entry.hours || 0), 0);
  const issues = [...new Set(entries.map((entry) => entry.issueKey).filter(Boolean))];
  return `Apply Jira worklog preview with ${entries.length} entries, ${formatHours(hours)}h total, issues ${issues.join(', ') || 'unknown'}?`;
}

export async function previewManualLogworkDraft({
  date,
  project,
  tasks,
  cwd = process.cwd(),
  workflows = defaultWorkflows(),
  print = console.log
}) {
  const text = buildLogworkText({ date, tasks });
  const projectOverrides = buildProjectOverrides({
    date,
    tasks,
    projectMemberId: project.projectMemberId
  });
  return runWithInlineAuth(() => workflows.previewLogworkBatch({
    text,
    projectOverrides,
    cwd
  }), { workflows, print });
}

export function addDraftTask({ draft, line }) {
  const task = parseTaskLine(line);
  return {
    ...draft,
    tasks: [...(draft.tasks || []), task]
  };
}

export function removeDraftTask({ draft, index }) {
  const taskIndex = Number(index) - 1;
  if (!Number.isInteger(taskIndex) || taskIndex < 0 || taskIndex >= (draft.tasks || []).length) {
    throw new Error(`No task found at index ${index}.`);
  }
  return {
    ...draft,
    tasks: draft.tasks.filter((_, currentIndex) => currentIndex !== taskIndex)
  };
}

async function runWithInlineAuth(action, { workflows, print }) {
  try {
    return await action();
  } catch (error) {
    if (!isAuthRequiredError(error)) {
      throw error;
    }
    print('Resource Optimiser authentication required. Starting terminal auth...');
    const result = await workflows.loginResourceOptimiser();
    print(result.summary);
    return action();
  }
}

async function runWithJiraAuthInstructions(action) {
  try {
    return await action();
  } catch (error) {
    if (!isJiraAuthRequiredError(error)) {
      throw error;
    }
    throw new Error(jiraLoginInstruction());
  }
}

function parseQueryArgs(value) {
  if (!value || value === 'today') {
    return { period: 'today' };
  }

  if (value === 'yesterday') {
    return { period: 'yesterday' };
  }

  if (value === 'this-week' || value === 'this_week' || value === 'week') {
    return { period: 'this_week' };
  }

  if (value === 'last-week' || value === 'last_week') {
    return { period: 'last_week' };
  }

  if (value === 'this-month' || value === 'this_month' || value === 'month') {
    return { period: 'this_month' };
  }

  if (value === 'last-month' || value === 'last_month') {
    return { period: 'last_month' };
  }

  throw new Error('Usage: /query today | yesterday | this-week | last-week | this-month | last-month');
}

function parseLogworkCommand(parts) {
  const first = parts[0];
  const target = parseTargetToken(first);
  if (!target) {
    return {
      type: 'logwork',
      text: parts.join(' ').trim() || undefined
    };
  }

  return {
    type: 'logwork',
    target,
    text: parts.slice(1).join(' ').trim() || undefined
  };
}

function parseTargetCommand(type, parts, {
  allowBoth
} = {}) {
  if (!parts.length) {
    return {
      type
    };
  }

  const target = parseTargetToken(parts[0], { allowBoth });
  if (!target) {
    throw new Error(`Usage: /${type} ${allowBoth ? 'ro | jira | both' : 'ro | jira'}`);
  }
  if (parts.length > 1) {
    throw new Error(`Usage: /${type} ${allowBoth ? 'ro | jira | both' : 'ro | jira'}`);
  }

  return {
    type,
    target
  };
}

function parseMapCommand(parts) {
  if (parts.length < 2) {
    throw new Error('Usage: /map <TICKET_PREFIX[,PREFIX...]> <projectMemberId>');
  }

  const tickets = parts[0]
    .split(',')
    .map((ticket) => ticket.trim().toUpperCase())
    .filter(Boolean);
  const projectMemberId = parts[1];

  if (!tickets.length || !projectMemberId) {
    throw new Error('Usage: /map <TICKET_PREFIX[,PREFIX...]> <projectMemberId>');
  }

  return {
    type: 'map',
    tickets,
    projectMemberId
  };
}

export function formatProjects(result, weekly = null, projectFilter = undefined) {
  const lines = [result.summary];
  const projects = filterProjects(result.projects || [], projectFilter);
  const chartedProjectKeys = new Set();
  const chartBlocks = formatWeeklyProjectCharts(projects, weekly, projectFilter, chartedProjectKeys);

  if (chartBlocks.length) {
    lines.push('');
    lines.push('This week:');
    lines.push(...chartBlocks);
  } else if (projectFilter) {
    lines.push('');
    lines.push(`No weekly booking/logwork chart found for "${projectFilter}".`);
  }

  const otherProjects = projects.filter((project) => !chartedProjectKeys.has(projectIdentityKey(project)));
  if (otherProjects.length) {
    lines.push('');
    lines.push(chartBlocks.length ? 'Other memberships:' : 'Projects:');
    for (const project of otherProjects) {
      lines.push(`- ${project.projectMemberId}: ${project.projectName} (projectId: ${project.projectId ?? 'unknown'})`);
    }
  }

  if (result.mappings?.length) {
    lines.push('');
    lines.push('Mappings:');
    for (const mapping of result.mappings) {
      lines.push(`- ${mapping.tickets.join(', ')} -> ${mapping.projectName}${mapping.projectMemberId ? ` (${mapping.projectMemberId})` : ''}`);
    }
  }

  return lines.join('\n');
}

export function formatWeeklyProjectCharts(projects, weekly, projectFilter, chartedProjectKeys = new Set()) {
  if (!weekly?.projects?.length) {
    return [];
  }

  const lines = [];
  const weeklyProjects = weekly.projects.filter((project) => (
    !projectFilter || projectMatchesFilter(project, projectFilter)
  ));

  for (const weeklyProject of weeklyProjects) {
    const membership = projects.find((project) => sameProjectIdentity(project, weeklyProject)) || weeklyProject;
    const key = projectIdentityKey(membership);
    chartedProjectKeys.add(key);
    if (lines.length) {
      lines.push('');
    }
    lines.push(...formatProjectChart({
      project: {
        ...membership,
        bookedHours: weeklyProject.bookedHours,
        loggedHours: weeklyProject.loggedHours
      },
      days: projectDays(weekly?.days || [], weeklyProject)
    }));
  }

  return lines;
}

export function formatProjectChart({ project, days = [], width = 20 }) {
  const bookedHours = Number(project.bookedHours || 0);
  const loggedHours = Number(project.loggedHours || 0);
  const ratio = bookedHours > 0 ? loggedHours / bookedHours : (loggedHours > 0 ? 1 : 0);
  const filled = Math.max(0, Math.min(width, Math.round(Math.min(ratio, 1) * width)));
  const percent = bookedHours > 0 ? `${Math.round(ratio * 100)}%` : (loggedHours > 0 ? 'unbooked' : '0%');
  const over = bookedHours > 0 && loggedHours > bookedHours
    ? ` (+${formatHours(loggedHours - bookedHours)}h over)`
    : '';

  return [
    project.projectName,
    `memberId: ${project.projectMemberId ?? 'unknown'} · projectId: ${project.projectId ?? 'unknown'}`,
    `This week: ${formatHours(loggedHours)}h logged / ${formatHours(bookedHours)}h booked${over}`,
    `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}] ${percent}`,
    formatDayChips(days)
  ];
}

function projectDays(days, project) {
  return days
    .map((day) => {
      const matching = (day.projects || []).find((candidate) => sameProjectIdentity(candidate, project));
      if (!matching) {
        return null;
      }
      return {
        date: day.date,
        bookedHours: matching.bookedHours,
        loggedHours: matching.loggedHours
      };
    })
    .filter(Boolean);
}

function formatDayChips(days) {
  if (!days.length) {
    return 'No booking/logwork found this week.';
  }

  return days.map((day) => (
    `${weekdayName(day.date)} ${formatHours(day.loggedHours)}/${formatHours(day.bookedHours)}`
  )).join('  ');
}

function weekdayName(localDateISO) {
  const [year, month, day] = String(localDateISO).split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()] || localDateISO;
}

function filterProjects(projects, projectFilter) {
  if (!projectFilter) {
    return projects;
  }
  return projects.filter((project) => projectMatchesFilter(project, projectFilter));
}

function defaultWorkflows() {
  return {
    queryLogwork,
    reconcileLogwork,
    previewLogworkBatch,
    applyLogworkBatch,
    previewRoLogworkEdit,
    applyRoLogworkEdit,
    previewJiraWorklogBatch,
    applyJiraWorklogBatch,
    listLogworkProjects,
    upsertProjectMapping,
    loginResourceOptimiser,
    getStoredAuthStatus,
    getStoredJiraStatus,
    queryApplyLedger,
    generateDiagnosticsReport
  };
}
