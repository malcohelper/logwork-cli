#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ApiError } from './lib/api.mjs';
import { queryApplyLedger } from './lib/apply-ledger.mjs';
import {
  applyLogworkBatch,
  formatToolResponse,
  previewLogworkBatch
} from './lib/batch-workflow.mjs';
import { authRequiredPayload, isAuthRequiredError } from './lib/auth-errors.mjs';
import { startAuthLoginTerminal } from './lib/auth-terminal.mjs';
import { isMainModule } from './lib/entrypoint.mjs';
import {
  jiraAuthRequiredPayload,
  getStoredJiraSession,
  isJiraAuthRequiredError
} from './lib/jira-auth.mjs';
import { getJiraIssue } from './lib/jira-api.mjs';
import {
  applyJiraWorklogBatch,
  previewJiraWorklogBatch
} from './lib/jira-workflow.mjs';
import {
  listLogworkProjects,
  upsertProjectMapping
} from './lib/project-mapping-workflow.mjs';
import { readPackageVersion } from './lib/package-info.mjs';
import { queryLogwork } from './lib/query-workflow.mjs';
import { reconcileLogwork } from './lib/reconciliation-workflow.mjs';
import {
  applyRoLogworkEdit,
  createRoEditPreviewFingerprint,
  previewRoLogworkEdit
} from './lib/ro-edit-workflow.mjs';
import {
  applyRoLogworkResubmit,
  previewRoLogworkResubmit
} from './lib/ro-resubmit-workflow.mjs';
import {
  applyRoLogworkDelete,
  previewRoLogworkDelete
} from './lib/ro-delete-workflow.mjs';
import {
  disableLogworkReminder,
  enableLogworkReminder,
  getLogworkReminderStatus,
  testLogworkReminder
} from './lib/reminder-service.mjs';
import { checkForUpdates, installUpdate } from './lib/update-service.mjs';

const PREVIEW_TTL_MS = 60 * 60 * 1000;
const MAX_PREVIEWS = 100;
const previews = new Map();
const jiraPreviews = new Map();
const roEditPreviews = new Map();
const roResubmitPreviews = new Map();
const roDeletePreviews = new Map();

const server = new McpServer({
  name: 'logwork-helper',
  version: readPackageVersion()
});

server.registerTool('preview_logwork_batch', {
  description: 'Resource Optimiser only: parse a weekly logwork text block, resolve booked RO projects by date, and return an approval preview. Use Jira tools separately for Jira worklogs.',
  inputSchema: {
    text: z.string().min(1).describe('Weekly log block with headings like Monday, 01 Jun 2026 and entries like +2 Task.'),
    timezone: z.string().optional().describe('Reserved for future date parsing; current parser uses explicit dates in the text.'),
    projectOverrides: z.record(z.string(), z.union([z.string(), z.number()])).optional().describe('Map preview entry id to projectMemberId.'),
    typeOfWork: z.enum(['create', 'correct', 'improve', 'other']).optional().describe('Default type_of_work for new RO entries. Defaults to other.')
  }
}, withAuthRequiredHandling(async ({ text, projectOverrides = {}, typeOfWork }) => {
  prunePreviewCache(previews);
  const preview = await previewLogworkBatch({ text, projectOverrides, typeOfWork });
  setCachedPreview(previews, preview);
  return formatToolResponse(preview);
}));

server.registerTool('apply_logwork_batch', {
  description: 'Resource Optimiser only: submit an approved RO logwork preview. Requires confirm: true and blocks unresolved entries. Does not write Jira worklogs.',
  inputSchema: {
    batchId: z.string().optional().describe('batchId returned by preview_logwork_batch. Required for apply.'),
    batch: z.any().optional().describe('Backward-compatible structured preview echo. When provided, it must match the cached preview for batchId.'),
    confirm: z.boolean().describe('Must be true after explicit user approval.'),
    allowUnbooked: z.boolean().optional().describe('Allow submitting entries resolved to a valid project membership without a booking for that date.'),
    projectOverrides: z.record(z.string(), z.union([z.string(), z.number()])).optional().describe('Deprecated for apply. Project overrides must be included during preview so approval covers the final project selection.')
  }
}, withAuthRequiredHandling(async ({ batchId, batch, confirm, allowUnbooked = false, projectOverrides = {} }) => {
  prunePreviewCache(previews);
  assertNoFinalProjectOverrides(projectOverrides);
  if (confirm !== true) {
    throw new Error('apply_logwork_batch requires confirm: true.');
  }
  const approvedBatch = consumeApprovedBatch({
    cache: previews,
    batchId,
    batch
  });

  const result = await applyLogworkBatch({
    batch: approvedBatch,
    confirm,
    allowUnbooked
  });
  return formatToolResponse(result);
}));

server.registerTool('preview_ro_logwork_edit', {
  description: 'Resource Optimiser only: read one existing RO logwork and preview changing its hours and/or task name. Project and date are always preserved. Jira-created entries are blocked.',
  inputSchema: {
    logworkId: z.union([z.string().min(1), z.number().int().positive()]).describe('Existing Resource Optimiser logwork id returned by query_logwork.'),
    hours: z.number().positive().optional().describe('Optional replacement hours. The existing value is preserved when omitted.'),
    taskName: z.string().min(1).max(1_000).optional().describe('Optional replacement task name. The existing value is preserved when omitted.')
  }
}, withAuthRequiredHandling(async ({ logworkId, hours, taskName }) => {
  prunePreviewCache(roEditPreviews);
  const preview = await previewRoLogworkEdit({
    logworkId,
    hours,
    taskName
  });
  setCachedRoEditPreview(roEditPreviews, preview);
  return formatToolResponse(preview);
}));

server.registerTool('apply_ro_logwork_edit', {
  description: 'Resource Optimiser only: apply an approved cached RO edit preview. Requires confirm: true, re-checks that the original logwork has not changed, and verifies the persisted result.',
  inputSchema: {
    previewId: z.string().optional().describe('previewId returned by preview_ro_logwork_edit. Required for apply.'),
    preview: z.any().optional().describe('Optional structured preview echo. When provided, it must match the cached preview for previewId.'),
    confirm: z.boolean().describe('Must be true after explicit user approval.')
  }
}, withAuthRequiredHandling(async ({ previewId, preview, confirm }) => {
  prunePreviewCache(roEditPreviews);
  if (confirm !== true) {
    throw new Error('apply_ro_logwork_edit requires confirm: true.');
  }
  const approvedPreview = consumeApprovedRoEditPreview({
    cache: roEditPreviews,
    previewId,
    preview
  });
  const result = await applyRoLogworkEdit({
    preview: approvedPreview,
    confirm
  });
  return formatToolResponse(result);
}));

server.registerTool('preview_ro_logwork_resubmit', {
  description: 'Resource Optimiser only: preview resubmitting a rejected logwork entry back to approved status.',
  inputSchema: {
    logworkId: z.union([z.string().min(1), z.number().int().positive()]),
    hours: z.number().positive().optional(),
    typeOfWork: z.enum(['create', 'correct', 'improve', 'other']).optional(),
    noteToPm: z.string().max(500).optional(),
    description: z.string().max(1_000).optional()
  }
}, withAuthRequiredHandling(async (input) => {
  prunePreviewCache(roResubmitPreviews);
  const preview = await previewRoLogworkResubmit(input);
  setCachedPreview(roResubmitPreviews, preview);
  return formatToolResponse(preview);
}));

server.registerTool('apply_ro_logwork_resubmit', {
  description: 'Resource Optimiser only: apply a cached rejected-entry resubmit preview. Requires confirm: true.',
  inputSchema: {
    previewId: z.string().optional(),
    preview: z.any().optional(),
    confirm: z.boolean()
  }
}, withAuthRequiredHandling(async ({ previewId, preview, confirm }) => {
  prunePreviewCache(roResubmitPreviews);
  if (confirm !== true) {
    throw new Error('apply_ro_logwork_resubmit requires confirm: true.');
  }
  const approvedPreview = consumeApprovedRoEditPreview({
    cache: roResubmitPreviews,
    previewId,
    preview
  });
  const result = await applyRoLogworkResubmit({ preview: approvedPreview, confirm });
  return formatToolResponse(result);
}));

server.registerTool('preview_ro_logwork_delete', {
  description: 'Resource Optimiser only: preview soft-deleting a submitted or approved logwork entry. Rejected entries cannot be deleted.',
  inputSchema: {
    logworkId: z.union([z.string().min(1), z.number().int().positive()])
  }
}, withAuthRequiredHandling(async ({ logworkId }) => {
  prunePreviewCache(roDeletePreviews);
  const preview = await previewRoLogworkDelete({ logworkId });
  setCachedPreview(roDeletePreviews, preview);
  return formatToolResponse(preview);
}));

server.registerTool('apply_ro_logwork_delete', {
  description: 'Resource Optimiser only: apply a cached delete preview after explicit approval. Requires confirm: true.',
  inputSchema: {
    previewId: z.string().optional(),
    preview: z.any().optional(),
    confirm: z.boolean()
  }
}, withAuthRequiredHandling(async ({ previewId, preview, confirm }) => {
  prunePreviewCache(roDeletePreviews);
  if (confirm !== true) {
    throw new Error('apply_ro_logwork_delete requires confirm: true.');
  }
  const approvedPreview = consumeApprovedRoEditPreview({
    cache: roDeletePreviews,
    previewId,
    preview
  });
  const result = await applyRoLogworkDelete({ preview: approvedPreview, confirm });
  return formatToolResponse(result);
}));

server.registerTool('delete_ro_logwork_entry', {
  description: 'Resource Optimiser only: preview and soft-delete a submitted or approved logwork entry in one step. Requires confirm: true. Prefer preview_ro_logwork_delete + apply_ro_logwork_delete for two-step approval.',
  inputSchema: {
    logworkId: z.union([z.string().min(1), z.number().int().positive()]),
    confirm: z.boolean()
  }
}, withAuthRequiredHandling(async ({ logworkId, confirm }) => {
  if (confirm !== true) {
    throw new Error('delete_ro_logwork_entry requires confirm: true.');
  }
  const preview = await previewRoLogworkDelete({ logworkId });
  const result = await applyRoLogworkDelete({ preview, confirm: true });
  return formatToolResponse(result);
}));

server.registerTool('query_logwork', {
  description: 'Read-only query for logged/booked Resource Optimiser work by preset period and optional project filter.',
  inputSchema: {
    period: z.enum(['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month']).optional().describe('Preset query period. Defaults to today.'),
    project: z.union([z.string(), z.number()]).optional().describe('Project filter by projectMemberId, projectId, name, ticket prefix, or mapping keyword.'),
    includeEntries: z.boolean().optional().describe('Whether to include task-level log entries. Defaults to true.')
  }
}, withAuthRequiredHandling(async ({ period, project, includeEntries = true }) => {
  const result = await queryLogwork({
    period,
    project,
    includeEntries
  });
  return formatToolResponse(result);
}));

server.registerTool('reconcile_logwork', {
  description: 'Read-only: compare Resource Optimiser and Jira worklog hours by day for a preset period. Returns mismatches and high-confidence correction suggestions, but never writes either system.',
  inputSchema: {
    period: z.enum(['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month']).optional().describe('Preset reconciliation period. Defaults to this_week.')
  }
}, withRoAndJiraAuthRequiredHandling(async ({ period = 'this_week' }) => {
  const result = await reconcileLogwork({ period });
  return formatToolResponse(result);
}));

server.registerTool('query_apply_history', {
  description: 'Read the local apply result ledger for Resource Optimiser and Jira. Target both means entries applied from a combined Both flow. Never returns credentials or raw API responses.',
  inputSchema: {
    target: z.enum(['ro', 'jira', 'both']).optional().describe('Optional target filter.'),
    limit: z.number().int().min(1).max(100).optional().describe('Maximum records to return. Defaults to 20.')
  }
}, async ({ target, limit = 20 }) => {
  const result = await queryApplyLedger({ target, limit });
  return formatToolResponse(result);
});

server.registerTool('check_for_updates', {
  description: 'Read-only: compare the running Logwork Helper version with npm latest. Uses a 24-hour cache unless force is true.',
  inputSchema: {
    force: z.boolean().optional().describe('Ignore the local update cache and query npm now. Defaults to false.')
  }
}, async ({ force = false }) => {
  const result = await checkForUpdates({ force });
  return formatToolResponse(result);
});

server.registerTool('apply_update', {
  description: 'Install the exact npm latest Logwork Helper version after explicit approval. Preserves local state and credentials. Requires confirm: true; reconnect MCP after success.',
  inputSchema: {
    version: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/).optional().describe('Optional exact SemVer approved by the user. It must equal npm latest.'),
    confirm: z.boolean().describe('Must be true after explicit user approval.')
  }
}, async ({ version, confirm }) => {
  if (confirm !== true) {
    throw new Error('apply_update requires confirm: true.');
  }
  const result = await installUpdate({
    version,
    confirm,
    stdio: 'pipe'
  });
  return formatToolResponse(result);
});

server.registerTool('get_logwork_reminder', {
  description: 'Read-only: show the configured native macOS/Windows logwork reminder, OS scheduler status, and last background run.',
  inputSchema: {}
}, async () => formatToolResponse(await getLogworkReminderStatus()));

server.registerTool('configure_logwork_reminder', {
  description: 'Enable or disable the native OS logwork reminder after explicit approval. Uses launchd on macOS and Task Scheduler on Windows; no credentials are stored in the schedule.',
  inputSchema: {
    action: z.enum(['enable', 'disable']).describe('Whether to install/update or remove the OS reminder schedule.'),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().describe('Local OS time in 24-hour HH:mm format. Defaults to 17:00.'),
    target: z.enum(['ro', 'jira', 'both']).optional().describe('Reminder target. Defaults to both.'),
    confirm: z.boolean().describe('Must be true after explicit user approval.')
  }
}, async ({ action, time, target, confirm }) => {
  if (confirm !== true) {
    throw new Error('configure_logwork_reminder requires confirm: true.');
  }
  if (action === 'disable' && (time || target)) {
    throw new Error('time and target are only valid when enabling the reminder.');
  }
  const result = action === 'enable'
    ? await enableLogworkReminder({ time, target, confirm })
    : await disableLogworkReminder({ confirm });
  return formatToolResponse(result);
});

server.registerTool('test_logwork_reminder', {
  description: 'Send a native OS test notification after explicit approval. Does not query or write RO/Jira logwork.',
  inputSchema: {
    target: z.enum(['ro', 'jira', 'both']).optional().describe('Sample notification target. Defaults to the configured target.'),
    confirm: z.boolean().describe('Must be true after explicit user approval because this displays an OS notification.')
  }
}, async ({ target, confirm }) => {
  if (confirm !== true) {
    throw new Error('test_logwork_reminder requires confirm: true.');
  }
  return formatToolResponse(await testLogworkReminder({ target, confirm }));
});

server.registerTool('list_logwork_projects', {
  description: 'List Resource Optimiser project memberships and current local logwork project mappings without changing data.',
  inputSchema: {}
}, withAuthRequiredHandling(async () => {
  const result = await listLogworkProjects();
  return formatToolResponse(result);
}));

server.registerTool('upsert_project_mapping', {
  description: 'Create or update a local ticket/keyword-to-project mapping after explicit user approval.',
  inputSchema: {
    projectMemberId: z.union([z.string(), z.number()]).optional().describe('Resource Optimiser project_member_id chosen from list_logwork_projects or preview setupSuggestions.'),
    projectName: z.string().optional().describe('Project name to match against user project memberships when projectMemberId is not provided.'),
    tickets: z.array(z.string()).min(1).describe('Ticket prefixes to map, for example ["SCB"].'),
    keywords: z.array(z.string()).optional().describe('Optional task keywords to map to the project.'),
    scope: z.enum(['user', 'project']).optional().describe('Where to write the mapping. Defaults to user: ~/.logwork-helper/.logwork-helper.json.'),
    confirm: z.boolean().describe('Must be true after explicit user approval because this writes .logwork-helper.json.')
  }
}, withAuthRequiredHandling(async ({ projectMemberId, projectName, tickets, keywords = [], scope = 'user', confirm }) => {
  const result = await upsertProjectMapping({
    projectMemberId,
    projectName,
    tickets,
    keywords,
    scope,
    confirm
  });
  return formatToolResponse(result);
}));

server.registerTool('start_auth_login', {
  description: 'Resource Optimiser auth only: start or explain a local RO auth login session. No credentials are accepted by this MCP tool.',
  inputSchema: {}
}, async () => {
  const result = await startAuthLoginTerminal();
  return formatToolResponse(result);
});

server.registerTool('start_jira_auth', {
  description: 'Explain how to start a local Jira PAT login session. No Jira token or password is accepted by this MCP tool.',
  inputSchema: {}
}, async () => formatToolResponse({
  status: 'jira_auth_required',
  authRequired: true,
  command: 'logwork-helper jira login',
  summary: 'Run `logwork-helper jira login` in a terminal and paste a Jira Personal Access Token there, then retry the MCP tool.'
}));

server.registerTool('get_jira_issue', {
  description: 'Read a Jira issue by key from the configured self-hosted Jira instance.',
  inputSchema: {
    issueKey: z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/).describe('Jira issue key, for example SCB-213.')
  }
}, withJiraAuthRequiredHandling(async ({ issueKey }) => {
  const session = await getStoredJiraSession();
  const issue = await getJiraIssue(session.token, issueKey, {
    baseUrl: session.baseUrl
  });
  return formatToolResponse({
    status: 'ok',
    issue,
    summary: `${issue.key}: ${issue.summary} (${issue.status || 'unknown status'})`
  });
}));

server.registerTool('preview_jira_worklog_batch', {
  description: 'Jira only: parse a weekly logwork text block, validate Jira issue keys, detect duplicate Jira worklogs, and return an approval preview. Use RO tools separately for Resource Optimiser.',
  inputSchema: {
    text: z.string().min(1).describe('Weekly log block with headings like Monday, 01 Jun 2026 and entries like +2 Task (SCB-213).')
  }
}, withJiraAuthRequiredHandling(async ({ text }) => {
  prunePreviewCache(jiraPreviews);
  const preview = await previewJiraWorklogBatch({ text });
  setCachedJiraPreview(jiraPreviews, preview);
  return formatToolResponse(preview);
}));

server.registerTool('apply_jira_worklog_batch', {
  description: 'Jira only: submit an approved Jira worklog preview. Requires confirm: true and a cached batchId from preview_jira_worklog_batch. Does not write Resource Optimiser logwork.',
  inputSchema: {
    batchId: z.string().optional().describe('batchId returned by preview_jira_worklog_batch. Required for apply.'),
    batch: z.any().optional().describe('Backward-compatible structured preview echo. When provided, it must match the cached preview for batchId.'),
    confirm: z.boolean().describe('Must be true after explicit user approval.')
  }
}, withJiraAuthRequiredHandling(async ({ batchId, batch, confirm }) => {
  prunePreviewCache(jiraPreviews);
  if (confirm !== true) {
    throw new Error('apply_jira_worklog_batch requires confirm: true.');
  }
  const approvedBatch = consumeApprovedJiraBatch({
    cache: jiraPreviews,
    batchId,
    batch
  });
  const result = await applyJiraWorklogBatch({
    batch: approvedBatch,
    confirm
  });
  return formatToolResponse(result);
}));

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error('Logwork Helper MCP server error:', error);
    process.exit(1);
  });
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
    throw new Error('apply_logwork_batch requires batchId from preview_logwork_batch. Re-run preview_logwork_batch and apply using the returned batchId.');
  }

  if (batch?.batchId && batch.batchId !== batchId) {
    throw new Error(`Approved batch mismatch: batchId ${batchId} does not match batch.batchId ${batch.batchId}. Re-run preview_logwork_batch before applying.`);
  }

  const cached = getCachedPreviewRecord(cache, batchId, now);
  if (!cached) {
    throw new Error('Missing cached preview for batchId. Re-run preview_logwork_batch and apply using the returned batchId.');
  }

  if (batch && createPreviewFingerprint(batch) !== cached.fingerprint) {
    throw new Error('Approved batch content changed after preview. Re-run preview_logwork_batch and apply using the returned batchId.');
  }

  return clonePreview(cached.preview);
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
    throw new Error('apply_jira_worklog_batch requires batchId from preview_jira_worklog_batch. Re-run preview_jira_worklog_batch and apply using the returned batchId.');
  }

  if (batch?.batchId && batch.batchId !== batchId) {
    throw new Error(`Approved Jira batch mismatch: batchId ${batchId} does not match batch.batchId ${batch.batchId}. Re-run preview_jira_worklog_batch before applying.`);
  }

  const cached = getCachedPreviewRecord(cache, batchId, now);
  if (!cached) {
    throw new Error('Missing cached Jira preview for batchId. Re-run preview_jira_worklog_batch and apply using the returned batchId.');
  }

  if (batch && createJiraPreviewFingerprint(batch) !== cached.fingerprint) {
    throw new Error('Approved Jira batch content changed after preview. Re-run preview_jira_worklog_batch and apply using the returned batchId.');
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
  now = Date.now()
}) {
  if (!previewId) {
    throw new Error('apply_ro_logwork_edit requires previewId from preview_ro_logwork_edit. Re-run preview_ro_logwork_edit and apply using the returned previewId.');
  }
  if (preview?.previewId && preview.previewId !== previewId) {
    throw new Error(`Approved RO edit mismatch: previewId ${previewId} does not match preview.previewId ${preview.previewId}. Re-run preview_ro_logwork_edit before applying.`);
  }

  const cached = getCachedPreviewRecord(cache, previewId, now);
  if (!cached) {
    throw new Error('Missing cached RO edit preview for previewId. Re-run preview_ro_logwork_edit before applying.');
  }
  if (preview && createRoEditPreviewFingerprint(preview) !== cached.fingerprint) {
    throw new Error('Approved RO edit preview changed after preview. Re-run preview_ro_logwork_edit before applying.');
  }
  return clonePreview(cached.preview);
}

export function consumeApprovedRoEditPreview({
  cache,
  previewId,
  preview,
  now = Date.now()
}) {
  const approvedPreview = resolveApprovedRoEditPreview({
    cache,
    previewId,
    preview,
    now
  });
  cache.delete(previewId);
  return approvedPreview;
}

export function assertNoFinalProjectOverrides(projectOverrides = {}) {
  if (!projectOverrides || typeof projectOverrides !== 'object' || !Object.keys(projectOverrides).length) {
    return;
  }

  throw new Error('apply_logwork_batch no longer accepts final projectOverrides. Re-run preview_logwork_batch with projectOverrides so the approved batchId covers the final project selection.');
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
      requiresAllowUnbooked: booleanOrNull(entry?.requiresAllowUnbooked)
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
