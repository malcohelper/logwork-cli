import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ApiError } from './api.mjs';
import { queryApplyLedger } from './apply-ledger.mjs';
import { readLogworkSkill } from './agent-skill.mjs';
import { draftLogworkFromCommits } from './commit-workflow.mjs';
import {
  applyLogworkBatch,
  formatDuplicateBlock,
  formatToolResponse,
  listWorklogTasks,
  previewLogworkBatch
} from './batch-workflow.mjs';
import { authRequiredPayload, isAuthRequiredError } from './auth-errors.mjs';
import { startAuthLoginTerminal } from './auth-terminal.mjs';
import { isMainModule } from './entrypoint.mjs';
import {
  jiraAuthRequiredPayload,
  getStoredJiraSession,
  isJiraAuthRequiredError
} from './jira-auth.mjs';
import { getJiraIssue } from './jira-api.mjs';
import {
  applyJiraWorklogBatch,
  previewJiraWorklogBatch
} from './jira-workflow.mjs';
import {
  listLogworkProjects,
  upsertProjectMapping
} from './project-mapping-workflow.mjs';
import { readPackageVersion } from './package-info.mjs';
import { queryLogwork } from './query-workflow.mjs';
import { reconcileLogwork } from './reconciliation-workflow.mjs';
import {
  applyRoLogworkEdit,
  createRoEditPreviewFingerprint,
  previewRoLogworkEdit
} from './ro-edit-workflow.mjs';
import {
  applyRoLogworkResubmit,
  previewRoLogworkResubmit
} from './ro-resubmit-workflow.mjs';
import {
  applyRoLogworkDelete,
  previewRoLogworkDelete
} from './ro-delete-workflow.mjs';
import {
  disableLogworkReminder,
  enableLogworkReminder,
  getLogworkReminderStatus,
  testLogworkReminder
} from './reminder-service.mjs';
import { checkForUpdates, installUpdate } from './update-service.mjs';

const PREVIEW_TTL_MS = 60 * 60 * 1000;
const MAX_PREVIEWS = 100;
const previews = new Map();
const jiraPreviews = new Map();
const roEditPreviews = new Map();
const roResubmitPreviews = new Map();
const roDeletePreviews = new Map();

export const SERVER_INSTRUCTIONS = `logwork logs work hours to Resource Optimiser (RO) and self-hosted Jira from the user's machine.

Safety rules:
- Writes are two calls to the same tool. Call it without confirm to get a preview (batchId or previewId plus a summary), show the summary to the user, wait for explicit approval, then call the same tool again with only that id and confirm: true. Never set confirm: true without approval.
- log_work previews flag possibleDuplicate entries (same date, worklog task, hours and description as an existing RO entry, or a repeated line). Show the warning; apply refuses them unless the user confirms it is new work and you call again with the same batchId and allowDuplicates: true. Never pass allowDuplicates or allowUnbooked without asking.
- Never ask for or pass passwords, OTP codes, or tokens. If a tool returns authRequired, call login (target "ro" or "jira") and ask the user to finish login in their terminal.

Logwork text format (log_work and log_jira_work):
  Monday, 01 Jun 2026
  +2 Feature Development | Implement maintenance mode UI (SCB-213)
  +1.5 Code Review & Refactoring | Review PR for system page (SCB-214)
- Day heading: "<Weekday>, <DD> <Mon> <YYYY>".
- Entry: "+<hours> <worklog task> | <description>". The worklog task must be an RO catalog task name (or "#<id>") from list_tasks; the description is free text written to RO and used as the Jira worklog comment. Always include a description.
- Lines without "|" are accepted only when the text is itself a catalog task name (no description is written), or when defaultWorklogTask is passed (the text then becomes the description).
- Jira needs exactly one issue key such as SCB-213 in the line.

Recommended RO flow: get_logwork (what is booked/logged) -> draft_from_commits (the user's git commits as draft lines plus projectOverrides) -> list_tasks(projectId) -> log_work(text, projectOverrides) -> user approval -> log_work(batchId, confirm: true).
Base every line on the user's commits or on what the user tells you; never invent work. The log_from_commits prompt has the full procedure.
Fixing existing RO entries (logworkId from get_logwork): submitted/approved entries -> edit_entry (hours, worklog task, type of work, description; apply replaces the entry with a new id, approved immediately); rejected entries -> resubmit_entry; removing an entry -> delete_entry.
If a preview entry is unresolved: worklog_task_required / task_not_found means fix the worklog task (see availableTaskNames); project reasons mean ask the user to pick a project (projectOverrides) or save a mapping with map_project.`;

const server = new McpServer({
  name: 'logwork',
  version: readPackageVersion()
}, {
  instructions: SERVER_INSTRUCTIONS
});

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const LOCAL_READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
const LOCAL_WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const PERIOD_VALUES = ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month'];
const TWO_STEP = 'Two calls: (1) without confirm returns a preview with a summary; show it to the user. (2) after explicit approval, call again with only the returned id and confirm: true.';
const ENTRY_TEXT_DESCRIPTION = 'Preview call only. Weekly log block: day headings like "Monday, 01 Jun 2026", then one entry per line as "+<hours> <worklog task> | <description>", e.g. "+2 Feature Development | Implement maintenance mode UI (SCB-213)". Get valid worklog task names from list_tasks.';
const LOGWORK_ID_SCHEMA = z.union([z.string().min(1), z.number().int().positive()]).optional().describe('Preview call only. Existing Resource Optimiser logwork entry id (logworkId from get_logwork).');
const PREVIEW_ID_SCHEMA = z.string().optional().describe('Apply call only. previewId returned by the preview call.');
const BATCH_ID_SCHEMA = z.string().optional().describe('Apply call only. batchId returned by the preview call.');
const CONFIRM_SCHEMA = z.boolean().optional().describe('Omit (or false) to preview. Set true only on the apply call, after the user explicitly approved the preview.');
const TYPE_OF_WORK_SCHEMA = z.enum(['create', 'correct', 'improve', 'other']);

server.registerTool('get_logwork', {
  title: 'Get Resource Optimiser logwork',
  description: 'Read-only: booked vs logged Resource Optimiser hours by day and project for a preset period, with entries (logworkId, hours, worklog task, description, status). Use it to see what is missing before log_work, or to find a logworkId for edit_entry, resubmit_entry or delete_entry.',
  annotations: READ_ONLY,
  inputSchema: {
    period: z.enum(PERIOD_VALUES).optional().describe('Preset period. Defaults to today.'),
    project: z.union([z.string(), z.number()]).optional().describe('Project filter by projectMemberId, projectId, name, ticket prefix, or mapping keyword.'),
    includeEntries: z.boolean().optional().describe('Whether to include entry-level detail. Defaults to true.')
  }
}, withAuthRequiredHandling(async ({ period, project, includeEntries = true }) => {
  const result = await queryLogwork({ period, project, includeEntries });
  return formatToolResponse(result);
}));

server.registerTool('list_projects', {
  title: 'List RO projects and mappings',
  description: 'Read-only: Resource Optimiser project memberships (projectMemberId, projectId, projectName) and local ticket/keyword project mappings. Use projectId with list_tasks, and projectMemberId with log_work projectOverrides or map_project.',
  annotations: READ_ONLY,
  inputSchema: {}
}, withAuthRequiredHandling(async () => formatToolResponse(await listLogworkProjects())));

server.registerTool('list_tasks', {
  title: 'List RO worklog tasks',
  description: 'Read-only: the Resource Optimiser worklog task catalog (project tasks plus shared defaults) for one project, with id, name, type_of_work and a description of when to use each. Every RO entry needs one of these names (or "#<id>") before "|" in "+<hours> <worklog task> | <description>".',
  annotations: READ_ONLY,
  inputSchema: {
    projectId: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]).describe('Resource Optimiser projectId from list_projects, get_logwork, or a preview matchedProject.')
  }
}, withAuthRequiredHandling(async ({ projectId }) => formatToolResponse(await listWorklogTasks({ projectId }))));

server.registerTool('draft_from_commits', {
  title: 'Draft logwork from git commits',
  description: 'Read-only: read the user\'s own git commits (all branches, git user.email) in one or more repos for a period, group them per day by repo + ticket + kind of work, suggest an RO worklog task per group (feat -> Feature Development, fix -> Bug Fix, refactor/review -> Code Review & Refactoring, test -> Testing Activities, ci/build/release -> Deployment & Release, docs -> Requirements & Design), and resolve each group\'s RO project (a map_project mapping whose repos holds the repo, else ticket/keyword mappings and that day\'s bookings), and split each project\'s remaining RO hours (booked - logged) across its groups; groups without a project share the room of booked projects no group claimed. Returns draftText in the log_work line format plus projectOverrides (preview entry id -> projectMemberId) for every line with a project. Review it with the user, check task names with list_tasks, then pass draftText and projectOverrides unchanged to log_work. unmappedRepos lists repos whose lines got no project: offer map_project with repos.',
  annotations: READ_ONLY,
  inputSchema: {
    period: z.enum(PERIOD_VALUES).optional().describe('Preset period. Defaults to today.'),
    repos: z.array(z.string().min(1)).max(20).optional().describe('Absolute paths of the git repos the user worked in (for example the open workspace folders). Defaults to the MCP server working directory.'),
    author: z.string().min(1).optional().describe('Git author filter (email or name). Defaults to each repo\'s git config user.email.'),
    useBookings: z.boolean().optional().describe('Split hours by RO remaining booked time per day (default true). When false or RO is unavailable, a weekday counts as 8h.')
  }
}, withAuthRequiredHandling(async ({ period, repos, author, useBookings = true }) => {
  return formatToolResponse(await draftLogworkFromCommits({ period, repos, author, useBookings }));
}));

server.registerTool('log_work', {
  title: 'Log work to Resource Optimiser',
  description: `Resource Optimiser only: create new RO entries (worklog task + hours + date + type of work + description) from a weekly logwork block. ${TWO_STEP} The preview resolves the project (bookings, mappings, ticket prefixes) and worklog task per line; unresolved lines block apply. It also reads each date's RO entries and flags possibleDuplicate lines (same date, worklog task, hours and description, or a repeated line); apply refuses them unless allowDuplicates: true. Use log_jira_work for Jira.`,
  annotations: WRITE,
  inputSchema: {
    text: z.string().min(1).optional().describe(ENTRY_TEXT_DESCRIPTION),
    projectOverrides: z.record(z.string(), z.union([z.string(), z.number()])).optional().describe('Preview call only. Map preview entry id (e.g. "2026-06-01-01") to the projectMemberId the user chose for an unresolved entry, or pass the projectOverrides returned by draft_from_commits with its draftText unchanged.'),
    defaultWorklogTask: z.string().min(1).optional().describe('Preview call only. Worklog task name (or "#<id>") for lines without "|" whose text is not a catalog task; that text becomes the description. Example: "Feature Development".'),
    typeOfWork: TYPE_OF_WORK_SCHEMA.optional().describe('Preview call only. Override type_of_work for every entry. When omitted, each entry takes its worklog task type, else "other".'),
    batchId: BATCH_ID_SCHEMA,
    allowUnbooked: z.boolean().optional().describe('Apply call only. Allow entries resolved to a project membership without a booking on that date.'),
    allowDuplicates: z.boolean().optional().describe('Apply call only. Allow entries the preview flagged as possibleDuplicate (same date, worklog task, hours and description as an existing RO entry or an earlier line). Pass true only after the user confirmed they are new work.'),
    confirm: CONFIRM_SCHEMA
  }
}, withAuthRequiredHandling(async ({ text, projectOverrides, defaultWorklogTask, typeOfWork, batchId, allowUnbooked = false, allowDuplicates = false, confirm }) => {
  prunePreviewCache(previews);
  if (confirm === true) {
    assertApplyOnly('log_work', { text, projectOverrides, defaultWorklogTask, typeOfWork });
    // Check allowUnbooked and allowDuplicates before the preview is consumed,
    // so the agent can retry the same batchId with the flag set.
    const pending = resolveApprovedBatch({ cache: previews, batchId });
    assertUnbookedAllowed(pending, allowUnbooked);
    assertDuplicatesAllowed(pending, allowDuplicates);
    const approvedBatch = consumeApprovedBatch({ cache: previews, batchId });
    return formatToolResponse(await applyLogworkBatch({ batch: approvedBatch, confirm, allowUnbooked, allowDuplicates }));
  }
  requirePreviewInput('log_work', { text });
  const preview = await previewLogworkBatch({ text, projectOverrides: projectOverrides || {}, typeOfWork, defaultWorklogTask });
  setCachedPreview(previews, preview);
  return formatToolResponse(preview);
}));

server.registerTool('edit_entry', {
  title: 'Edit an RO entry',
  description: `Resource Optimiser only: change the hours, worklog task, type of work and/or description of one submitted or approved entry (logworkId from get_logwork). Project and date never change. ${TWO_STEP} RO has no staff edit API, so apply replaces the entry: it creates the corrected entry, then deletes the original (rolled back if the delete fails). The new entry gets a new id and is approved immediately. Rejected entries use resubmit_entry; Jira-created entries are blocked.`,
  annotations: DESTRUCTIVE,
  inputSchema: {
    logworkId: LOGWORK_ID_SCHEMA,
    hours: z.number().positive().max(24).optional().describe('Preview call only. New hours; kept when omitted.'),
    taskName: z.string().min(1).max(1_000).optional().describe('Preview call only. New worklog task: an exact catalog name from list_tasks (for example "Bug Fix") or "#<id>". This is the RO task category, not the description. Kept when omitted.'),
    description: z.string().min(1).max(1_000).optional().describe('Preview call only. New description: what was done, ideally with ticket keys (for example "Fix date picker timezone (SAP-42)"). Kept when omitted.'),
    typeOfWork: TYPE_OF_WORK_SCHEMA.optional().describe('Preview call only. New type of work. When omitted it is kept, or follows the new task catalog type when taskName changes the task.'),
    previewId: PREVIEW_ID_SCHEMA,
    confirm: CONFIRM_SCHEMA
  }
}, withAuthRequiredHandling(async ({ logworkId, hours, taskName, description, typeOfWork, previewId, confirm }) => {
  prunePreviewCache(roEditPreviews);
  if (confirm === true) {
    assertApplyOnly('edit_entry', { hours, taskName, description, typeOfWork });
    const approvedPreview = consumeApprovedRoEditPreview({ cache: roEditPreviews, previewId, toolName: 'edit_entry' });
    return formatToolResponse(await applyRoLogworkEdit({ preview: approvedPreview, confirm }));
  }
  requirePreviewInput('edit_entry', { logworkId });
  const preview = await previewRoLogworkEdit({ logworkId, hours, taskName, description, typeOfWork });
  setCachedRoEditPreview(roEditPreviews, preview);
  return formatToolResponse(preview);
}));

server.registerTool('resubmit_entry', {
  title: 'Resubmit a rejected RO entry',
  description: `Resource Optimiser only: fix and resubmit one rejected entry (status rejected in get_logwork) with optional new hours, type of work, description and a note to the PM. ${TWO_STEP}`,
  annotations: WRITE,
  inputSchema: {
    logworkId: LOGWORK_ID_SCHEMA,
    hours: z.number().positive().max(24).optional().describe('Preview call only. New hours; defaults to the rejected entry hours.'),
    typeOfWork: TYPE_OF_WORK_SCHEMA.optional().describe('Preview call only. New type of work; defaults to the rejected entry value.'),
    noteToPm: z.string().max(500).optional().describe('Preview call only. Note to the project manager explaining the fix.'),
    description: z.string().max(1_000).optional().describe('Preview call only. New description; defaults to the rejected entry description.'),
    previewId: PREVIEW_ID_SCHEMA,
    confirm: CONFIRM_SCHEMA
  }
}, withAuthRequiredHandling(async ({ logworkId, hours, typeOfWork, noteToPm, description, previewId, confirm }) => {
  prunePreviewCache(roResubmitPreviews);
  if (confirm === true) {
    assertApplyOnly('resubmit_entry', { hours, typeOfWork, noteToPm, description });
    const approvedPreview = consumeApprovedRoEditPreview({ cache: roResubmitPreviews, previewId, toolName: 'resubmit_entry' });
    return formatToolResponse(await applyRoLogworkResubmit({ preview: approvedPreview, confirm }));
  }
  requirePreviewInput('resubmit_entry', { logworkId });
  const preview = await previewRoLogworkResubmit({ logworkId, hours, typeOfWork, noteToPm, description });
  setCachedRoEditPreview(roResubmitPreviews, preview);
  return formatToolResponse(preview);
}));

server.registerTool('delete_entry', {
  title: 'Delete an RO entry',
  description: `Resource Optimiser only: delete one submitted or approved entry (logworkId from get_logwork). Deleting needs no PM approval. Rejected entries cannot be deleted; use resubmit_entry. ${TWO_STEP}`,
  annotations: DESTRUCTIVE,
  inputSchema: {
    logworkId: LOGWORK_ID_SCHEMA,
    previewId: PREVIEW_ID_SCHEMA,
    confirm: CONFIRM_SCHEMA
  }
}, withAuthRequiredHandling(async ({ logworkId, previewId, confirm }) => {
  prunePreviewCache(roDeletePreviews);
  if (confirm === true) {
    const approvedPreview = consumeApprovedRoEditPreview({ cache: roDeletePreviews, previewId, toolName: 'delete_entry' });
    return formatToolResponse(await applyRoLogworkDelete({ preview: approvedPreview, confirm }));
  }
  requirePreviewInput('delete_entry', { logworkId });
  const preview = await previewRoLogworkDelete({ logworkId });
  setCachedRoEditPreview(roDeletePreviews, preview);
  return formatToolResponse(preview);
}));

server.registerTool('log_jira_work', {
  title: 'Log work to Jira',
  description: `Jira only: create Jira worklogs from a weekly logwork block. Each line needs exactly one issue key; the description after "|" (or the whole text) becomes the worklog comment, and duplicates are detected. ${TWO_STEP} Use log_work for Resource Optimiser.`,
  annotations: WRITE,
  inputSchema: {
    text: z.string().min(1).optional().describe(`${ENTRY_TEXT_DESCRIPTION} Each line must contain exactly one Jira issue key such as SCB-213.`),
    batchId: BATCH_ID_SCHEMA,
    confirm: CONFIRM_SCHEMA
  }
}, withJiraAuthRequiredHandling(async ({ text, batchId, confirm }) => {
  prunePreviewCache(jiraPreviews);
  if (confirm === true) {
    assertApplyOnly('log_jira_work', { text });
    const approvedBatch = consumeApprovedJiraBatch({ cache: jiraPreviews, batchId });
    return formatToolResponse(await applyJiraWorklogBatch({ batch: approvedBatch, confirm }));
  }
  requirePreviewInput('log_jira_work', { text });
  const preview = await previewJiraWorklogBatch({ text });
  setCachedJiraPreview(jiraPreviews, preview);
  return formatToolResponse(preview);
}));

server.registerTool('get_jira_issue', {
  title: 'Get Jira issue',
  description: 'Read-only: read a Jira issue (key, summary, status, project) from the configured self-hosted Jira. Useful to write an accurate logwork description.',
  annotations: READ_ONLY,
  inputSchema: {
    issueKey: z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/).describe('Jira issue key, for example SCB-213.')
  }
}, withJiraAuthRequiredHandling(async ({ issueKey }) => {
  const session = await getStoredJiraSession();
  const issue = await getJiraIssue(session.token, issueKey, { baseUrl: session.baseUrl });
  return formatToolResponse({
    status: 'ok',
    issue,
    summary: `${issue.key}: ${issue.summary} (${issue.status || 'unknown status'})`
  });
}));

server.registerTool('reconcile', {
  title: 'Compare RO and Jira',
  description: 'Read-only: compare Resource Optimiser and Jira worklog hours by day for a preset period. Returns mismatches and correction suggestions, but never writes either system.',
  annotations: READ_ONLY,
  inputSchema: {
    period: z.enum(PERIOD_VALUES).optional().describe('Preset period. Defaults to this_week.')
  }
}, withRoAndJiraAuthRequiredHandling(async ({ period = 'this_week' }) => formatToolResponse(await reconcileLogwork({ period }))));

server.registerTool('get_history', {
  title: 'Local apply history',
  description: 'Read-only: the local history of applied RO and Jira writes (date, hours, task, description, project, status). Target both means entries applied from a combined RO + Jira flow. Never returns credentials or raw API responses.',
  annotations: LOCAL_READ_ONLY,
  inputSchema: {
    target: z.enum(['ro', 'jira', 'both']).optional().describe('Optional target filter.'),
    limit: z.number().int().min(1).max(100).optional().describe('Maximum records to return. Defaults to 20.')
  }
}, async ({ target, limit = 20 }) => formatToolResponse(await queryApplyLedger({ target, limit })));

server.registerTool('map_project', {
  title: 'Save a project mapping',
  description: 'Save a local ticket-prefix/keyword/git repo -> RO project mapping so future log_work previews resolve the project automatically and draft_from_commits allocates a repo\'s commits to its project. Pass tickets, repos, or both. Writes .logwork.json; requires confirm: true after the user approved the mapping.',
  annotations: { ...LOCAL_WRITE, idempotentHint: true },
  inputSchema: {
    projectMemberId: z.union([z.string(), z.number()]).optional().describe('RO projectMemberId from list_projects or preview setupSuggestions.'),
    projectName: z.string().optional().describe('Project name to match against the user\'s memberships when projectMemberId is not given.'),
    tickets: z.array(z.string()).optional().describe('Ticket prefixes to map, for example ["SCB"]. At least one ticket prefix or repo is required.'),
    keywords: z.array(z.string()).optional().describe('Optional task keywords to map to the project.'),
    repos: z.array(z.string().min(1)).max(20).optional().describe('Absolute paths of git repos whose commits belong to this project (a subfolder is stored as its repo root). draft_from_commits uses them to pick the project per commit.'),
    scope: z.enum(['user', 'project']).optional().describe('user (default): ~/.logwork-cli/.logwork.json for this machine. project: .logwork.json in the current repo.'),
    confirm: z.boolean().describe('Must be true, and only after explicit user approval.')
  }
}, withAuthRequiredHandling(async ({ projectMemberId, projectName, tickets = [], keywords = [], repos = [], scope = 'user', confirm }) => {
  const result = await upsertProjectMapping({ projectMemberId, projectName, tickets, keywords, repos, scope, confirm });
  return formatToolResponse(result);
}));

server.registerTool('login', {
  title: 'Start login',
  description: 'Call when a tool returns authRequired (target "ro") or jira_auth_required (target "jira"). For RO it opens or explains a terminal login where the user types email, password and 2FA; for Jira it explains how to save a Personal Access Token from the terminal. This tool never accepts credentials.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    target: z.enum(['ro', 'jira']).optional().describe('ro (default): Resource Optimiser. jira: Jira Personal Access Token.')
  }
}, async ({ target = 'ro' }) => {
  if (target === 'jira') {
    return formatToolResponse({
      status: 'jira_auth_required',
      authRequired: true,
      command: 'logwork login jira',
      summary: 'Run `logwork login jira` in a terminal and paste a Jira Personal Access Token there, then retry the tool.'
    });
  }
  return formatToolResponse(await startAuthLoginTerminal());
});

server.registerTool('reminder', {
  title: 'Logwork reminder',
  description: 'The native macOS/Windows weekday logwork reminder. action "status" is read-only. "enable", "disable" and "test" (shows a sample notification) change the OS scheduler or display a notification and require confirm: true after explicit user approval. No credentials are stored in the schedule.',
  annotations: LOCAL_WRITE,
  inputSchema: {
    action: z.enum(['status', 'enable', 'disable', 'test']).describe('status: show config and scheduler state. enable/disable: install or remove the schedule. test: send a sample notification.'),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().describe('enable only. Local time in 24-hour HH:mm. Defaults to 17:00.'),
    target: z.enum(['ro', 'jira', 'both']).optional().describe('enable/test only. What to check. Defaults to both (enable) or the configured target (test).'),
    confirm: z.boolean().optional().describe('Required (true) for enable, disable and test, after explicit user approval.')
  }
}, async ({ action, time, target, confirm }) => {
  if (action === 'status') {
    return formatToolResponse(await getLogworkReminderStatus());
  }
  if (confirm !== true) {
    throw new Error(`reminder action "${action}" requires confirm: true after user approval.`);
  }
  if (action !== 'enable' && time) {
    throw new Error('time is only valid when enabling the reminder.');
  }
  if (action === 'disable' && target) {
    throw new Error('target is not valid when disabling the reminder.');
  }
  if (action === 'enable') {
    return formatToolResponse(await enableLogworkReminder({ time, target, confirm }));
  }
  if (action === 'disable') {
    return formatToolResponse(await disableLogworkReminder({ confirm }));
  }
  return formatToolResponse(await testLogworkReminder({ target, confirm }));
});

server.registerTool('update', {
  title: 'Check or install logwork-cli updates',
  description: 'action "check" (read-only) compares the running version with npm latest (24-hour cache unless force). action "install" installs that exact latest version, keeping local state and credentials; it requires confirm: true after explicit approval, and MCP must be reconnected afterwards.',
  annotations: WRITE,
  inputSchema: {
    action: z.enum(['check', 'install']).optional().describe('check (default) or install.'),
    force: z.boolean().optional().describe('check only. Ignore the local cache and query npm now.'),
    version: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/).optional().describe('install only. Exact SemVer the user approved; must equal npm latest.'),
    confirm: z.boolean().optional().describe('install only. Must be true after explicit user approval.')
  }
}, async ({ action = 'check', force = false, version, confirm }) => {
  if (action === 'check') {
    return formatToolResponse(await checkForUpdates({ force }));
  }
  if (confirm !== true) {
    throw new Error('update action "install" requires confirm: true after user approval.');
  }
  return formatToolResponse(await installUpdate({ version, confirm, stdio: 'pipe' }));
});

server.registerPrompt('log_from_commits', {
  title: 'Log work from my commits',
  description: 'Step-by-step procedure for logging accurate Resource Optimiser (and optionally Jira) work from the user\'s git commits.',
  argsSchema: {
    period: z.string().optional().describe('today, yesterday, this_week, last_week, this_month or last_month. Defaults to today.'),
    repos: z.string().optional().describe('Comma-separated absolute repo paths. Defaults to the open workspace.')
  }
}, ({ period, repos }) => ({
  messages: [{
    role: 'user',
    content: {
      type: 'text',
      text: [
        readLogworkSkill(),
        '',
        `Period: ${period || 'today'}.`,
        repos ? `Repos: ${repos}.` : 'Repos: the folders open in this workspace (ask me if there are others).',
        'Start with get_logwork, then draft_from_commits.'
      ].join('\n')
    }
  }]
}));

export async function startMcpServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (isMainModule(import.meta.url)) {
  startMcpServer().catch((error) => {
    console.error('logwork MCP server error:', error);
    process.exit(1);
  });
}

// Apply calls carry only the id + confirm. Content fields on an apply call are
// rejected instead of ignored, so an agent never believes a changed value was
// applied when the cached (approved) preview is what gets written.
function assertApplyOnly(toolName, fields) {
  const extra = Object.entries(fields).filter(([, value]) => value !== undefined).map(([key]) => key);
  if (extra.length) {
    throw new Error(`${toolName} with confirm: true applies the approved preview as-is; do not pass ${extra.join(', ')}. To change values, call ${toolName} without confirm to preview again.`);
  }
}

function requirePreviewInput(toolName, fields) {
  const missing = Object.entries(fields).filter(([, value]) => value === undefined || value === null || value === '').map(([key]) => key);
  if (missing.length) {
    throw new Error(`${toolName} preview needs ${missing.join(', ')}. To apply an approved preview, pass its id with confirm: true.`);
  }
}

export function setCachedPreview(cache, preview, now = Date.now()) {
  prunePreviewCache(cache, now);
  const cachedPreview = clonePreview(preview);
  cache.set(cachedPreview.batchId, {
    preview: cachedPreview,
    fingerprint: createPreviewFingerprint(cachedPreview),
    expiresAt: now + PREVIEW_TTL_MS
  });
  prunePreviewCache(cache, now);
}

export function getCachedPreview(cache, batchId, now = Date.now()) {
  const cached = getCachedPreviewRecord(cache, batchId, now);
  return cached ? clonePreview(cached.preview) : null;
}

export function setCachedJiraPreview(cache, preview, now = Date.now()) {
  prunePreviewCache(cache, now);
  const cachedPreview = clonePreview(preview);
  cache.set(cachedPreview.batchId, {
    preview: cachedPreview,
    fingerprint: createJiraPreviewFingerprint(cachedPreview),
    expiresAt: now + PREVIEW_TTL_MS
  });
  prunePreviewCache(cache, now);
}

export function getCachedJiraPreview(cache, batchId, now = Date.now()) {
  const cached = getCachedPreviewRecord(cache, batchId, now);
  return cached ? clonePreview(cached.preview) : null;
}

export function setCachedRoEditPreview(cache, preview, now = Date.now()) {
  prunePreviewCache(cache, now);
  const cachedPreview = clonePreview(preview);
  cache.set(cachedPreview.previewId, {
    preview: cachedPreview,
    fingerprint: createRoEditPreviewFingerprint(cachedPreview),
    expiresAt: now + PREVIEW_TTL_MS
  });
  prunePreviewCache(cache, now);
}

export function getCachedRoEditPreview(cache, previewId, now = Date.now()) {
  const cached = getCachedPreviewRecord(cache, previewId, now);
  return cached ? clonePreview(cached.preview) : null;
}

function getCachedPreviewRecord(cache, batchId, now = Date.now()) {
  const cached = cache.get(batchId);
  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= now) {
    cache.delete(batchId);
    return null;
  }

  return cached;
}

export function prunePreviewCache(cache, now = Date.now()) {
  for (const [batchId, cached] of cache.entries()) {
    if (cached.expiresAt <= now) {
      cache.delete(batchId);
    }
  }

  while (cache.size > MAX_PREVIEWS) {
    const oldestBatchId = cache.keys().next().value;
    if (oldestBatchId === undefined) {
      break;
    }
    cache.delete(oldestBatchId);
  }
}

export function resolveApprovedBatch({
  cache,
  batchId,
  batch,
  now = Date.now()
}) {
  if (!batchId) {
    throw new Error('log_work with confirm: true requires the batchId returned by its preview call. Preview again and apply using the returned batchId.');
  }

  if (batch?.batchId && batch.batchId !== batchId) {
    throw new Error(`Approved batch mismatch: batchId ${batchId} does not match batch.batchId ${batch.batchId}. Preview log_work again before applying.`);
  }

  const cached = getCachedPreviewRecord(cache, batchId, now);
  if (!cached) {
    throw new Error('No cached log_work preview for this batchId (expired after 1 hour, already used by an earlier confirm call, or the server restarted; an earlier confirm may have failed without writing, so check get_logwork before assuming it was applied). Preview again and apply using the returned batchId.');
  }

  if (batch && createPreviewFingerprint(batch) !== cached.fingerprint) {
    throw new Error('Approved batch content changed after preview. Preview log_work again and apply using the returned batchId.');
  }

  return clonePreview(cached.preview);
}

export function assertDuplicatesAllowed(batch, allowDuplicates) {
  const duplicates = (batch?.entries || []).filter((entry) => entry.possibleDuplicate);
  if (duplicates.length && allowDuplicates !== true) {
    throw new Error(`Nothing was written. ${formatDuplicateBlock(duplicates)} Ask the user whether this is new work, then call log_work again with the same batchId, confirm: true and allowDuplicates: true.`);
  }
}

export function assertUnbookedAllowed(batch, allowUnbooked) {
  const unbooked = (batch?.entries || []).filter((entry) => entry.requiresAllowUnbooked);
  if (unbooked.length && allowUnbooked !== true) {
    throw new Error(`Nothing was written. ${unbooked.length} entr${unbooked.length === 1 ? 'y has' : 'ies have'} no booking on that date (${unbooked.map((entry) => entry.id).join(', ')}). Ask the user, then call log_work again with the same batchId, confirm: true and allowUnbooked: true.`);
  }
}

export function consumeApprovedBatch({
  cache,
  batchId,
  batch,
  now = Date.now()
}) {
  const approvedBatch = resolveApprovedBatch({
    cache,
    batchId,
    batch,
    now
  });
  cache.delete(batchId);
  return approvedBatch;
}

export function resolveApprovedJiraBatch({
  cache,
  batchId,
  batch,
  now = Date.now()
}) {
  if (!batchId) {
    throw new Error('log_jira_work with confirm: true requires the batchId returned by its preview call. Preview again and apply using the returned batchId.');
  }

  if (batch?.batchId && batch.batchId !== batchId) {
    throw new Error(`Approved Jira batch mismatch: batchId ${batchId} does not match batch.batchId ${batch.batchId}. Preview log_jira_work again before applying.`);
  }

  const cached = getCachedPreviewRecord(cache, batchId, now);
  if (!cached) {
    throw new Error('No cached log_jira_work preview for this batchId (expired after 1 hour, already used by an earlier confirm call, or the server restarted; an earlier confirm may have failed without writing, so check get_logwork before assuming it was applied). Preview again and apply using the returned batchId.');
  }

  if (batch && createJiraPreviewFingerprint(batch) !== cached.fingerprint) {
    throw new Error('Approved Jira batch content changed after preview. Preview log_jira_work again and apply using the returned batchId.');
  }

  return clonePreview(cached.preview);
}

export function consumeApprovedJiraBatch({
  cache,
  batchId,
  batch,
  now = Date.now()
}) {
  const approvedBatch = resolveApprovedJiraBatch({
    cache,
    batchId,
    batch,
    now
  });
  cache.delete(batchId);
  return approvedBatch;
}

export function resolveApprovedRoEditPreview({
  cache,
  previewId,
  preview,
  toolName = 'edit_entry',
  now = Date.now()
}) {
  if (!previewId) {
    throw new Error(`${toolName} with confirm: true requires the previewId returned by its preview call. Preview again and apply using the returned previewId.`);
  }
  if (preview?.previewId && preview.previewId !== previewId) {
    throw new Error(`Approved preview mismatch: previewId ${previewId} does not match preview.previewId ${preview.previewId}. Preview ${toolName} again before applying.`);
  }

  const cached = getCachedPreviewRecord(cache, previewId, now);
  if (!cached) {
    throw new Error(`No cached ${toolName} preview for this previewId (expired after 1 hour, already used by an earlier confirm call, or the server restarted; an earlier confirm may have failed without writing, so check get_logwork before assuming it was applied). Preview again before applying.`);
  }
  if (preview && createRoEditPreviewFingerprint(preview) !== cached.fingerprint) {
    throw new Error(`Approved ${toolName} preview changed after preview. Preview again before applying.`);
  }
  return clonePreview(cached.preview);
}

export function consumeApprovedRoEditPreview({
  cache,
  previewId,
  preview,
  toolName = 'edit_entry',
  now = Date.now()
}) {
  const approvedPreview = resolveApprovedRoEditPreview({
    cache,
    previewId,
    preview,
    toolName,
    now
  });
  cache.delete(previewId);
  return approvedPreview;
}

export function assertNoFinalProjectOverrides(projectOverrides = {}) {
  if (!projectOverrides || typeof projectOverrides !== 'object' || !Object.keys(projectOverrides).length) {
    return;
  }

  throw new Error('projectOverrides belong to the log_work preview call, so the approved batchId covers the final project selection. Preview again with projectOverrides.');
}

export function createPreviewFingerprint(preview = {}) {
  return JSON.stringify({
    batchId: textOrNull(preview.batchId),
    status: textOrNull(preview.status),
    errors: arrayOrEmpty(preview.errors).map((error) => ({
      line: valueOrNull(error?.line),
      message: textOrNull(error?.message)
    })),
    entries: arrayOrEmpty(preview.entries).map((entry) => ({
      id: textOrNull(entry?.id),
      date: textOrNull(entry?.date),
      hours: numberOrNull(entry?.hours),
      taskName: textOrNull(entry?.taskName),
      tickets: arrayOrEmpty(entry?.tickets).map((ticket) => String(ticket)),
      status: textOrNull(entry?.status),
      reason: textOrNull(entry?.reason),
      confidence: numberOrNull(entry?.confidence),
      matchedProject: projectFingerprint(entry?.matchedProject),
      booked: booleanOrNull(entry?.booked),
      requiresAllowUnbooked: booleanOrNull(entry?.requiresAllowUnbooked),
      possibleDuplicate: entry?.possibleDuplicate
        ? textOrNull(entry.possibleDuplicate.logworkId ?? entry.possibleDuplicate.entryId)
        : null
    }))
  });
}

export function createJiraPreviewFingerprint(preview = {}) {
  return JSON.stringify({
    batchId: textOrNull(preview.batchId),
    status: textOrNull(preview.status),
    errors: arrayOrEmpty(preview.errors).map((error) => ({
      line: valueOrNull(error?.line),
      message: textOrNull(error?.message)
    })),
    entries: arrayOrEmpty(preview.entries).map((entry) => ({
      id: textOrNull(entry?.id),
      date: textOrNull(entry?.date),
      hours: numberOrNull(entry?.hours),
      taskName: textOrNull(entry?.taskName),
      tickets: arrayOrEmpty(entry?.tickets).map((ticket) => String(ticket)),
      issueKey: textOrNull(entry?.issueKey),
      status: textOrNull(entry?.status),
      reason: textOrNull(entry?.reason),
      issue: jiraIssueFingerprint(entry?.issue),
      worklog: jiraWorklogPayloadFingerprint(entry?.worklog),
      duplicate: jiraDuplicateFingerprint(entry?.duplicate)
    }))
  });
}

function clonePreview(preview) {
  if (typeof structuredClone === 'function') {
    return structuredClone(preview);
  }
  return JSON.parse(JSON.stringify(preview));
}

function projectFingerprint(project) {
  if (!project || typeof project !== 'object') {
    return null;
  }

  return {
    projectMemberId: idOrNull(project.projectMemberId),
    projectId: idOrNull(project.projectId),
    projectName: textOrNull(project.projectName)
  };
}

function jiraIssueFingerprint(issue) {
  if (!issue || typeof issue !== 'object') {
    return null;
  }

  return {
    key: textOrNull(issue.key),
    summary: textOrNull(issue.summary),
    status: textOrNull(issue.status),
    issueType: textOrNull(issue.issueType),
    project: issue.project && typeof issue.project === 'object' ? {
      key: textOrNull(issue.project.key),
      name: textOrNull(issue.project.name)
    } : null
  };
}

function jiraWorklogPayloadFingerprint(worklog) {
  if (!worklog || typeof worklog !== 'object') {
    return null;
  }

  return {
    started: textOrNull(worklog.started),
    timeSpentSeconds: numberOrNull(worklog.timeSpentSeconds),
    comment: textOrNull(worklog.comment)
  };
}

function jiraDuplicateFingerprint(worklog) {
  if (!worklog || typeof worklog !== 'object') {
    return null;
  }

  return {
    id: textOrNull(worklog.id),
    started: textOrNull(worklog.started),
    timeSpentSeconds: numberOrNull(worklog.timeSpentSeconds),
    comment: textOrNull(worklog.comment)
  };
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function textOrNull(value) {
  return value === undefined || value === null ? null : String(value);
}

function idOrNull(value) {
  return value === undefined || value === null || String(value).trim() === ''
    ? null
    : String(value);
}

function valueOrNull(value) {
  return value === undefined ? null : value;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function booleanOrNull(value) {
  return value === undefined || value === null ? null : Boolean(value);
}

function withAuthRequiredHandling(handler) {
  return async (args) => {
    try {
      return await handler(args);
    } catch (error) {
      if (isAuthRequiredError(error)) {
        return formatToolResponse(authRequiredPayload(error));
      }
      throw error;
    }
  };
}

function withJiraAuthRequiredHandling(handler) {
  return async (args) => {
    try {
      return await handler(args);
    } catch (error) {
      if (isJiraAuthRequiredError(error) || (error instanceof ApiError && error.status === 401)) {
        return formatToolResponse(jiraAuthRequiredPayload(error));
      }
      throw error;
    }
  };
}

function withRoAndJiraAuthRequiredHandling(handler) {
  return async (args) => {
    try {
      return await handler(args);
    } catch (error) {
      if (isAuthRequiredError(error)) {
        return formatToolResponse(authRequiredPayload(error));
      }
      if (isJiraAuthRequiredError(error) || (error instanceof ApiError && error.status === 401)) {
        return formatToolResponse(jiraAuthRequiredPayload(error));
      }
      throw error;
    }
  };
}
