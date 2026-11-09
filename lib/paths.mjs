import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export const HELPER_HOME_DIRNAME = '.logwork-cli';
export const CONFIG_FILE_NAME = '.logwork.json';
export const MANUAL_DRAFTS_FILE_NAME = 'manual-drafts.json';
export const APPLY_LEDGER_FILE_NAME = 'apply-ledger.json';
export const UPDATE_STATE_FILE_NAME = 'update-state.json';
export const REMINDER_CONFIG_FILE_NAME = 'reminder.json';
export const REMINDER_STATE_FILE_NAME = 'reminder-state.json';

// Names used before the package was renamed from logwork-helper to logwork-cli.
// lib/legacy-migration.mjs copies state from these locations on first run.
export const LEGACY_HELPER_HOME_DIRNAME = '.logwork-helper';
export const LEGACY_CONFIG_FILE_NAME = '.logwork-helper.json';

export function helperHome() {
  return resolve(customHelperHome() || resolve(homedir(), HELPER_HOME_DIRNAME));
}

export function customHelperHome(env = process.env) {
  return env.LOGWORK_HOME || env.LOGWORK_HELPER_HOME || '';
}

export function legacyHelperHome() {
  return resolve(homedir(), LEGACY_HELPER_HOME_DIRNAME);
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
  // A custom home (tests, separate profiles) keeps its state isolated from
  // the real ~/.logwork-helper.json.
  const custom = customHelperHome();
  return custom ? resolve(custom, LEGACY_CONFIG_FILE_NAME) : resolve(homedir(), LEGACY_CONFIG_FILE_NAME);
}

// Project-scope mappings live in the repo the user works in. A repo that still
// has the old .logwork-helper.json (and no .logwork.json) keeps using it, so
// committed mappings keep working without a rename.
export function projectConfigPath(cwd = process.cwd(), { exists = existsSync } = {}) {
  const current = resolve(cwd, CONFIG_FILE_NAME);
  const legacy = resolve(cwd, LEGACY_CONFIG_FILE_NAME);
  if (!exists(current) && exists(legacy)) {
    return legacy;
  }
  return current;
}
