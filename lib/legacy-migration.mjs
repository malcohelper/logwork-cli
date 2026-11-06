import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  APPLY_LEDGER_FILE_NAME,
  CONFIG_FILE_NAME,
  LEGACY_CONFIG_FILE_NAME,
  MANUAL_DRAFTS_FILE_NAME,
  REMINDER_CONFIG_FILE_NAME,
  REMINDER_STATE_FILE_NAME,
  UPDATE_STATE_FILE_NAME,
  customHelperHome,
  helperHome,
  legacyHelperHome
} from './paths.mjs';

export const MIGRATION_MARKER_FILE_NAME = '.migrated-from-logwork-helper';

// Local state files that move from ~/.logwork-helper to ~/.logwork-cli.
// The runtime code itself is not copied; `logwork setup` installs it fresh.
const STATE_FILES = [
  [LEGACY_CONFIG_FILE_NAME, CONFIG_FILE_NAME],
  [MANUAL_DRAFTS_FILE_NAME, MANUAL_DRAFTS_FILE_NAME],
  [APPLY_LEDGER_FILE_NAME, APPLY_LEDGER_FILE_NAME],
  [UPDATE_STATE_FILE_NAME, UPDATE_STATE_FILE_NAME],
  [REMINDER_CONFIG_FILE_NAME, REMINDER_CONFIG_FILE_NAME],
  [REMINDER_STATE_FILE_NAME, REMINDER_STATE_FILE_NAME]
];

// Copies state from the pre-rename home once. The old directory is left in
// place so an older install keeps working; existing new files are never
// overwritten. Skipped when LOGWORK_HOME (or the legacy LOGWORK_HELPER_HOME)
// points somewhere explicit.
export function migrateLegacyHome({
  home = helperHome(),
  legacyHome = legacyHelperHome(),
  env = process.env,
  fs = { copyFileSync, existsSync, mkdirSync, writeFileSync }
} = {}) {
  if (customHelperHome(env)) {
    return { migrated: false, reason: 'custom_home' };
  }
  const marker = join(home, MIGRATION_MARKER_FILE_NAME);
  if (fs.existsSync(marker)) {
    return { migrated: false, reason: 'already_migrated' };
  }
  if (!fs.existsSync(legacyHome)) {
    return { migrated: false, reason: 'no_legacy_home' };
  }

  try {
    fs.mkdirSync(home, { recursive: true });
    const files = [];
    for (const [from, to] of STATE_FILES) {
      const source = join(legacyHome, from);
      const target = join(home, to);
      if (fs.existsSync(source) && !fs.existsSync(target)) {
        fs.copyFileSync(source, target);
        files.push(to);
      }
    }
    fs.writeFileSync(marker, `${JSON.stringify({ from: legacyHome, files, at: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
    return { migrated: files.length > 0, from: legacyHome, to: home, files };
  } catch (error) {
    return { migrated: false, reason: 'error', error: error.message };
  }
}
