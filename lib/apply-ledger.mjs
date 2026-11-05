import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { atomicWriteFile } from './atomic-file.mjs';
import { withFileLock } from './file-lock.mjs';
import { applyLedgerPath } from './paths.mjs';

const DEFAULT_MAX_RECORDS = 500;
const VALID_TARGETS = new Set(['ro', 'jira']);
const VALID_FLOW_TARGETS = new Set(['ro', 'jira', 'both']);

export async function recordApplyResult(input, {
  path = applyLedgerPath(),
  maxRecords = DEFAULT_MAX_RECORDS,
  lockOptions = {},
  now = () => new Date(),
  random = Math.random
} = {}) {
  const record = sanitizeApplyRecord({
    ...input,
    id: input?.id || createRecordId(now(), random),
    timestamp: input?.timestamp || now().toISOString()
  });
  if (!record) {
    throw new Error('Cannot record apply result without a valid target and batchId.');
  }

  return withFileLock(path, async () => {
    const current = await loadApplyLedger({ path });
    const records = [record, ...current]
      .filter((candidate, index, all) => all.findIndex((other) => other.id === candidate.id) === index)
      .sort(sortNewestFirst)
      .slice(0, normalizeMaxRecords(maxRecords));
    await atomicWriteFile(path, `${JSON.stringify({ records }, null, 2)}\n`);
    return record;
  }, lockOptions);
}

export async function loadApplyLedger({ path = applyLedgerPath() } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) {
      return [];
    }
    throw error;
  }

  const records = Array.isArray(parsed) ? parsed : parsed?.records;
  return (Array.isArray(records) ? records : [])
    .map(sanitizeApplyRecord)
    .filter(Boolean)
    .sort(sortNewestFirst);
}

export async function queryApplyLedger({
  target,
  limit = 20,
  cwd,
  path = applyLedgerPath()
} = {}) {
  const normalizedTarget = normalizeQueryTarget(target);
  const normalizedCwd = normalizeCwd(cwd);
  const records = (await loadApplyLedger({ path }))
    .filter((record) => !normalizedTarget || (
      normalizedTarget === 'both'
        ? record.flowTarget === 'both'
        : record.target === normalizedTarget
    ))
    .filter((record) => !normalizedCwd || normalizeCwd(record.cwd) === normalizedCwd)
    .slice(0, normalizeLimit(limit));

  return {
    status: 'ok',
    filters: {
      target: normalizedTarget || null,
      cwd: normalizedCwd || null,
      limit: normalizeLimit(limit)
    },
    records,
    summary: formatApplyLedgerSummary(records)
  };
}

export function sanitizeApplyRecord(record = {}) {
  const target = String(record.target || '').toLowerCase();
  const flowTarget = String(record.flowTarget || target).toLowerCase();
  const batchId = cleanText(record.batchId, 160);
  if (!VALID_TARGETS.has(target) || !VALID_FLOW_TARGETS.has(flowTarget) || !batchId) {
    return null;
  }

  const entries = (Array.isArray(record.entries) ? record.entries : [])
    .map(sanitizeEntry)
    .filter(Boolean);

  return {
    id: cleanText(record.id, 160) || createRecordId(new Date(), Math.random),
    timestamp: normalizeTimestamp(record.timestamp),
    target,
    flowTarget,
    batchId,
    status: cleanText(record.status, 80) || 'unknown',
    cwd: cleanText(record.cwd, 1_000) || '',
    summary: buildRecordSummary(entries, record.summary),
    entries
  };
}

export function formatApplyLedgerSummary(records = []) {
  const lines = [`Apply history: ${records.length} record${records.length === 1 ? '' : 's'}.`];
  for (const record of records) {
    const flow = record.flowTarget === 'both' ? `${record.target} via both` : record.target;
    lines.push(`- ${record.timestamp}: ${flow} ${record.status}, batch ${record.batchId}, submitted ${record.summary.submittedCount}, failed ${record.summary.failedCount}, blocked ${record.summary.blockedCount}, ${formatHours(record.summary.totalHours)}h.`);
  }
  return lines.join('\n');
}

export async function recordApplyResultSafely(writer, input) {
  if (typeof writer !== 'function') {
    return { status: 'disabled', recorded: false };
  }
  try {
    const record = await writer(input);
    return {
      status: 'recorded',
      recorded: true,
      recordId: record?.id || null
    };
  } catch (error) {
    return {
      status: 'failed',
      recorded: false,
      error: cleanText(error.message, 500) || 'Unknown ledger error'
    };
  }
}

function sanitizeEntry(entry = {}) {
  const hours = Number(entry.hours);
  const entryId = cleanText(entry.entryId || entry.id, 160);
  if (!entryId && !entry.date && !entry.taskName) {
    return null;
  }
  return {
    entryId: entryId || '',
    date: cleanText(entry.date, 20) || '',
    hours: Number.isFinite(hours) ? Number(hours.toFixed(2)) : 0,
    taskName: cleanText(entry.taskName, 1_000) || '',
    projectName: cleanText(entry.projectName || entry.matchedProject?.projectName, 500) || '',
    issueKey: cleanText(entry.issueKey, 80) || '',
    status: cleanText(entry.status, 80) || (entry.ok === true ? 'submitted' : 'unknown'),
    error: cleanText(entry.error, 500) || '',
    dryRun: Boolean(entry.dryRun)
  };
}

function buildRecordSummary(entries, summary = {}) {
  return {
    entryCount: entries.length,
    submittedCount: countStatus(entries, ['submitted']),
    failedCount: countStatus(entries, ['failed']),
    blockedCount: countStatus(entries, ['blocked', 'duplicate', 'unresolved']),
    totalHours: Number(entries.reduce((sum, entry) => sum + Number(entry.hours || 0), 0).toFixed(2)),
    message: cleanText(typeof summary === 'string' ? summary : summary?.message, 1_000) || ''
  };
}

function countStatus(entries, statuses) {
  return entries.filter((entry) => statuses.includes(entry.status)).length;
}

function normalizeQueryTarget(value) {
  const target = String(value || '').trim().toLowerCase();
  if (!target) {
    return '';
  }
  if (!VALID_FLOW_TARGETS.has(target)) {
    throw new Error('History target must be ro, jira, or both.');
  }
  return target;
}

function normalizeLimit(value) {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error('History limit must be an integer from 1 to 500.');
  }
  return limit;
}

function normalizeMaxRecords(value) {
  const max = Number(value);
  return Number.isInteger(max) && max > 0 ? max : DEFAULT_MAX_RECORDS;
}

function normalizeTimestamp(value) {
  const date = new Date(value || 0);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function normalizeCwd(value) {
  const text = String(value || '').trim();
  return text ? resolve(text) : '';
}

function createRecordId(date, random) {
  return `apply_${date.getTime()}_${random().toString(36).slice(2, 10)}`;
}

function cleanText(value, maxLength) {
  const text = String(value || '')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer <redacted>')
    .replace(/(token|password|secret|otp)\s*[=:]\s*[^\s,;]+/gi, '$1=<redacted>')
    .trim();
  return text ? text.slice(0, maxLength) : '';
}

function sortNewestFirst(left, right) {
  return String(right.timestamp || '').localeCompare(String(left.timestamp || ''));
}

function formatHours(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(2)));
}
