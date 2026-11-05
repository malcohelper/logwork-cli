import { homedir } from 'node:os';
import { resolve } from 'node:path';

export const HELPER_HOME_DIRNAME = '.logwork-helper';
export const CONFIG_FILE_NAME = '.logwork-helper.json';
export const MANUAL_DRAFTS_FILE_NAME = 'manual-drafts.json';
export const APPLY_LEDGER_FILE_NAME = 'apply-ledger.json';
export const UPDATE_STATE_FILE_NAME = 'update-state.json';
export const REMINDER_CONFIG_FILE_NAME = 'reminder.json';
export const REMINDER_STATE_FILE_NAME = 'reminder-state.json';

export function helperHome() {
  return resolve(process.env.LOGWORK_HELPER_HOME || resolve(homedir(), HELPER_HOME_DIRNAME));
}

export function userConfigPath() {
  return resolve(helperHome(), CONFIG_FILE_NAME);
}

export function manualDraftsPath() {
  return resolve(helperHome(), MANUAL_DRAFTS_FILE_NAME);
}

export function applyLedgerPath() {
  return resolve(helperHome(), APPLY_LEDGER_FILE_NAME);
}

export function updateStatePath() {
  return resolve(helperHome(), UPDATE_STATE_FILE_NAME);
}

export function reminderConfigPath() {
  return resolve(helperHome(), REMINDER_CONFIG_FILE_NAME);
}

export function reminderStatePath() {
  return resolve(helperHome(), REMINDER_STATE_FILE_NAME);
}

export function legacyUserConfigPath() {
  return resolve(homedir(), CONFIG_FILE_NAME);
}

export function projectConfigPath(cwd = process.cwd()) {
  return resolve(cwd, CONFIG_FILE_NAME);
}
