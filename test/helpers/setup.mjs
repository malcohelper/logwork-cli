// Test bootstrap, loaded with `node --import ./test/helpers/setup.mjs --test`.
//
// It makes every test process hermetic before any module under test reads the
// environment (lib/config.mjs builds CONFIG at import time):
// - clears every LOGWORK_* variable from the developer's shell, such as
//   LOGWORK_DRY_RUN, LOGWORK_HOME, LOGWORK_PROFILE or LOGWORK_API_BASE;
// - points LOGWORK_HOME at a fresh temp dir for this process, so user config,
//   drafts, the apply ledger and other local state never touch the real
//   ~/.logwork-cli, and the legacy-home migration stays off;
// - sets LOGWORK_WSL=0, so a developer (or CI) inside WSL gets the plain Linux
//   code paths; WSL tests pass `wsl: true` explicitly.
//
// Tests that set these variables themselves still win: they run after this file.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const name of Object.keys(process.env)) {
  if (name.startsWith('LOGWORK_')) {
    delete process.env[name];
  }
}

const testHome = mkdtempSync(join(tmpdir(), 'logwork-test-home-'));
process.env.LOGWORK_HOME = testHome;
process.env.LOGWORK_WSL = '0';

process.on('exit', () => {
  try {
    rmSync(testHome, { recursive: true, force: true });
  } catch {
    // Best effort: a leftover temp dir must not fail the run.
  }
});
