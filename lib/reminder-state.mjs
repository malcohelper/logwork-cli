import { readFile } from 'node:fs/promises';
import { atomicWriteFile } from './atomic-file.mjs';
import { redactText } from './auth-redaction.mjs';
import { reminderStatePath } from './paths.mjs';

export async function loadReminderState({ path = reminderStatePath() } = {}) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return sanitizeReminderState(parsed);
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

export async function saveReminderState(state, { path = reminderStatePath() } = {}) {
  const sanitized = sanitizeReminderState(state);
  await atomicWriteFile(path, `${JSON.stringify(sanitized, null, 2)}\n`);
  return sanitized;
}

export function sanitizeReminderState(state = {}) {
  return {
    lastRunAt: cleanText(state.lastRunAt, 80),
    lastRunDate: cleanText(state.lastRunDate, 20),
    lastStatus: cleanText(state.lastStatus, 80),
    lastNotifiedDate: cleanText(state.lastNotifiedDate, 20),
    summary: cleanText(state.summary, 1_000),
    error: cleanText(state.error, 500)
  };
}

function cleanText(value, maxLength) {
  const text = redactText(String(value || '')).replace(/[\r\n]+/g, ' ').trim();
  return text.slice(0, maxLength);
}
