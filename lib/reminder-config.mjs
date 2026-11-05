import { readFile } from 'node:fs/promises';
import { atomicWriteFile } from './atomic-file.mjs';
import { reminderConfigPath } from './paths.mjs';

export const REMINDER_TARGETS = Object.freeze(['ro', 'jira', 'both']);
export const WEEKDAY_NUMBERS = Object.freeze([1, 2, 3, 4, 5]);
export const DEFAULT_REMINDER_TIME = '17:00';
export const DEFAULT_REMINDER_TARGET = 'both';

export function defaultReminderConfig() {
  return {
    enabled: false,
    time: DEFAULT_REMINDER_TIME,
    target: DEFAULT_REMINDER_TARGET,
    days: [...WEEKDAY_NUMBERS]
  };
}

export async function loadReminderConfig({ path = reminderConfigPath() } = {}) {
  try {
    return normalizeReminderConfig(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) {
      return defaultReminderConfig();
    }
    throw error;
  }
}

export async function saveReminderConfig(config, { path = reminderConfigPath() } = {}) {
  const normalized = normalizeReminderConfig(config);
  await atomicWriteFile(path, `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

export function normalizeReminderConfig(config = {}) {
  const defaults = defaultReminderConfig();
  const time = normalizeReminderTime(config.time ?? defaults.time);
  const target = String(config.target ?? defaults.target).trim().toLowerCase();
  if (!REMINDER_TARGETS.includes(target)) {
    throw new Error('Reminder target must be ro, jira, or both.');
  }

  const days = normalizeReminderDays(config.days ?? defaults.days);
  return {
    enabled: Boolean(config.enabled),
    time,
    target,
    days
  };
}

export function normalizeReminderTime(value) {
  const time = String(value || '').trim();
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
    throw new Error('Reminder time must use 24-hour HH:mm format.');
  }
  return time;
}

export function normalizeReminderDays(value) {
  if (!Array.isArray(value) || !value.length) {
    throw new Error('Reminder days must contain at least one weekday.');
  }
  const days = [...new Set(value.map(Number))].sort((left, right) => left - right);
  if (days.some((day) => !Number.isInteger(day) || day < 1 || day > 5)) {
    throw new Error('Reminder days must be weekdays Monday through Friday.');
  }
  return days;
}
