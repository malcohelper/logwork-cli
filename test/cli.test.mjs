import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseLoginArgs, runLoginCommand } from '../auth-cli.mjs';
import { parseJiraLoginArgs, runJiraLoginCommand } from '../jira-cli.mjs';
import { createAuthDiagnosticsRecorder } from '../lib/auth-diagnostics.mjs';
import {
  formatSetupUserInstructions,
  formatTerminalCommandInstructions,
  findCommandOnPath,
  installUserRuntime,
  linkGlobalBinaries,
  parseSetupUserArgs,
  sanitizeRuntimeMetadata
} from '../install-user.mjs';
import { isMainModule } from '../lib/entrypoint.mjs';
import { getStartupUpdateNotice, parseManualArgs } from '../manual-log.mjs';

test('package exposes logwork binary for manual REPL shortcut', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.bin.logwork, 'manual-log.mjs');
  assert.equal(packageJson.bin['logwork-helper-manual'], 'manual-log.mjs');
});

test('entrypoint detection supports direct paths, symlinks, and unrelated paths', {
  skip: process.platform === 'win32' ? 'Windows npm bins use command shims instead of POSIX symlinks.' : false
}, () => {
  const manualPath = new URL('../manual-log.mjs', import.meta.url).pathname;
  const manualUrl = pathToFileURL(realpathSync(manualPath)).href;
  const tmpDir = mkdtempSync(join(tmpdir(), 'logwork-entrypoint-'));
  const symlinkPath = join(tmpDir, 'logwork');
  symlinkSync(manualPath, symlinkPath);

  assert.equal(isMainModule(manualUrl, ['node', manualPath]), true);
  assert.equal(isMainModule(manualUrl, ['node', symlinkPath]), true);
  assert.equal(isMainModule(manualUrl, ['node', new URL('../package.json', import.meta.url).pathname]), false);
});

test('manual binary starts through a symlink like an npm global bin', {
  skip: process.platform === 'win32' ? 'Windows npm bins use command shims instead of POSIX symlinks.' : false
}, () => {
  const manualPath = new URL('../manual-log.mjs', import.meta.url).pathname;
  const tmpDir = mkdtempSync(join(tmpdir(), 'logwork-bin-'));
  const symlinkPath = join(tmpDir, 'logwork');
  symlinkSync(manualPath, symlinkPath);

  const help = spawnSync(process.execPath, [symlinkPath, '--help'], {
    encoding: 'utf8'
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Preferred shortcut:\n  logwork/);

  const repl = spawnSync(process.execPath, [symlinkPath], {
    input: '/help\n',
    encoding: 'utf8'
  });
  assert.equal(repl.status, 0);
  assert.match(repl.stdout, /Logwork Helper manual session/);
  assert.match(repl.stdout, /\/logwork \[ro\|jira\|both\]\s+Create Resource Optimiser, Jira, or combined logwork/);
});

test('CLI dispatcher prints top-level help', () => {
  const result = spawnSync(process.execPath, ['cli.mjs', '--help'], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /logwork-helper setup-user/);
  assert.match(result.stdout, /logwork-helper auth login/);
  assert.match(result.stdout, /logwork-helper jira login/);
  assert.match(result.stdout, /logwork-helper release doctor --full/);
  assert.match(result.stdout, /logwork-helper update check/);
  assert.match(result.stdout, /logwork-helper reminder status/);
  assert.match(result.stdout, /logwork-helper reconcile this-week/);
  assert.match(result.stdout, /logwork-helper history --target jira/);
  assert.match(result.stdout, /logwork-helper doctor/);
  assert.match(result.stdout, /logwork-helper mcp/);
  assert.match(result.stdout, /\n  logwork\n/);
  assert.match(result.stdout, /Primary setup:/);
  assert.match(result.stdout, /Check my logwork for this week/);
});

test('CLI dispatcher prints command help without executing setup', () => {
  const result = spawnSync(process.execPath, ['cli.mjs', 'setup-user', '--help'], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /setup-user \[--login\|--no-login\]/);
  assert.match(result.stdout, /prints MCP configs/);
  assert.match(result.stdout, /Paste one printed MCP config into your IDE/);
  assert.match(result.stdout, /--login/);
  assert.equal(result.stderr, '');
});

test('CLI dispatcher prints API-only auth help', () => {
  const result = spawnSync(process.execPath, ['cli.mjs', 'auth', '--help'], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /logwork-helper auth login/);
  assert.match(result.stdout, /Keycloak API flow/);
  assert.doesNotMatch(result.stdout, /--browser/);
  assert.doesNotMatch(result.stdout, /auth record/);
});

test('CLI dispatcher prints Jira auth help', () => {
  const result = spawnSync(process.execPath, ['cli.mjs', 'jira', '--help'], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /logwork-helper jira login/);
  assert.match(result.stdout, /Personal Access Token/);
  assert.match(result.stdout, /never accept Jira tokens/);
});

test('CLI dispatcher prints diagnostics help', () => {
  const result = spawnSync(process.execPath, ['cli.mjs', 'diagnostics', '--help'], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /logwork-helper diagnostics/);
  assert.match(result.stdout, /sanitized support report/);
});

test('CLI dispatcher prints release help', () => {
  const result = spawnSync(process.execPath, ['cli.mjs', 'release', '--help'], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /logwork-helper release doctor \[--full\]/);
  assert.match(result.stdout, /npm auth/);
  assert.match(result.stdout, /npm pack --dry-run/);
});

test('CLI dispatcher prints apply history help', () => {
  const result = spawnSync(process.execPath, ['cli.mjs', 'history', '--help'], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /history \[--target ro\|jira\|both\]/);
  assert.match(result.stdout, /without credentials or raw API responses/);
});

test('CLI dispatcher prints update help without checking the network', () => {
  const result = spawnSync(process.execPath, ['cli.mjs', 'update', '--help'], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /update check \[--force\]/);
  assert.match(result.stdout, /update install \[--version <semver>\]/);
  assert.match(result.stdout, /preserves local state and OS credentials/);
  assert.equal(result.stderr, '');
});

test('CLI dispatcher prints reminder help without installing an OS schedule', () => {
  const result = spawnSync(process.execPath, ['cli.mjs', 'reminder', '--help'], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /reminder enable \[--time HH:mm\]/);
  assert.match(result.stdout, /reminder status \[--json\]/);
  assert.match(result.stdout, /launchd on macOS or Task Scheduler on Windows/);
  assert.equal(result.stderr, '');
});

test('CLI dispatcher prints reconcile help without querying RO or Jira', () => {
  const result = spawnSync(process.execPath, ['cli.mjs', 'reconcile', '--help'], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /reconcile \[today\|yesterday\|this-week/);
  assert.match(result.stdout, /Read-only comparison/);
  assert.match(result.stdout, /target-specific preview and approval/);
  assert.equal(result.stderr, '');
});

test('CLI dispatcher prints doctor help', () => {
  const result = spawnSync(process.execPath, ['cli.mjs', 'doctor', '--help'], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /logwork-helper doctor/);
  assert.match(result.stdout, /same checks as diagnostics/);
  assert.match(result.stdout, /passwords, OTPs, or tokens/);
});

test('CLI dispatcher runs diagnostics command and writes report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'logwork-diagnostics-cli-'));
  const result = spawnSync(process.execPath, ['cli.mjs', 'diagnostics'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      LOGWORK_HELPER_HOME: dir
    }
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Diagnostics report written to/);
  const reportPath = result.stdout.match(/Diagnostics report written to (.+)/)?.[1]?.trim();
  assert.ok(reportPath);
  assert.equal(existsSync(reportPath), true);
  assert.doesNotMatch(readFileSync(reportPath, 'utf8'), /eyJ/);
});

test('CLI dispatcher runs doctor command and writes sanitized report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'logwork-doctor-cli-'));
  const result = spawnSync(process.execPath, ['cli.mjs', 'doctor'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      LOGWORK_HELPER_HOME: dir
    }
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Diagnostics report written to/);
  const reportPath = result.stdout.match(/Diagnostics report written to (.+)/)?.[1]?.trim();
  assert.ok(reportPath);
  assert.equal(existsSync(reportPath), true);
  assert.doesNotMatch(readFileSync(reportPath, 'utf8'), /eyJ/);
});

test('CLI dispatcher prints manual REPL help', () => {
  const result = spawnSync(process.execPath, ['cli.mjs', 'manual', '--help'], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Preferred shortcut:\n  logwork/);
  assert.match(result.stdout, /logwork-helper manual/);
  assert.match(result.stdout, /manual quick --message/);
  assert.match(result.stdout, /\/query yesterday/);
  assert.match(result.stdout, /\/query this-week/);
  assert.match(result.stdout, /\/query last-week/);
  assert.match(result.stdout, /\/query this-month/);
  assert.match(result.stdout, /\/query last-month/);
  assert.match(result.stdout, /\/logwork/);
  assert.match(result.stdout, /\/logwork ro/);
  assert.match(result.stdout, /\/logwork jira/);
  assert.match(result.stdout, /\/logwork both/);
  assert.match(result.stdout, /\/history/);
  assert.doesNotMatch(result.stdout, /\/apply/);
  assert.doesNotMatch(result.stdout, /\/exit/);
});

test('auth login parser is API-only and rejects browser auth options', () => {
  assert.deepEqual(parseLoginArgs([]), {
    mode: 'api'
  });
  assert.deepEqual(parseLoginArgs(['--api-mode']), {
    mode: 'api'
  });
  assert.throws(() => parseLoginArgs(['--browser-mode']), /Browser auth has been removed/);
  assert.throws(() => parseLoginArgs(['--browser', 'webkit']), /Browser auth has been removed/);
  assert.throws(() => parseLoginArgs(['--browser=webkit']), /Browser auth has been removed/);
});

test('auth login command writes sanitized diagnostics only on failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'logwork-auth-cli-'));
  const failureLogPath = join(dir, 'auth-debug.log');
  const stdout = [];
  const stderr = [];
  const failure = await runLoginCommand({
    login: async () => {
      const error = new Error(`Invalid OTP otp=654321 password=secret accessToken=${makeJwt()}`);
      error.code = 'API_AUTH_FAILED';
      throw error;
    },
    createRecorder: () => {
      const recorder = createAuthDiagnosticsRecorder({
        attemptId: 'attempt-cli',
        logPath: failureLogPath,
        now: () => '2026-06-09T00:00:00.000Z'
      });
      recorder.event('otp_reprompt', {
        status: 200,
        path: '/auth/realms/resource/login-actions/authenticate',
        formKinds: ['otp']
      });
      return recorder;
    },
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message)
  });

  assert.equal(failure.ok, false);
  assert.match(stdout[0], /Starting Resource Optimiser API auth/);
  assert.match(stderr.join('\n'), /Auth failed\. Sanitized diagnostics saved to/);
  assert.match(stderr.join('\n'), /Attempt: attempt-cli/);
  const log = readFileSync(failureLogPath, 'utf8');
  assert.match(log, /otp_reprompt/);
  assert.doesNotMatch(log, /654321/);
  assert.doesNotMatch(log, /secret/);
  assert.doesNotMatch(log, /eyJ/);

  const successLogPath = join(dir, 'success-debug.log');
  const success = await runLoginCommand({
    login: async () => ({
      summary: 'Authenticated as user 115.'
    }),
    createRecorder: () => createAuthDiagnosticsRecorder({
      attemptId: 'attempt-success',
      logPath: successLogPath
    }),
    stdout: () => {},
    stderr: () => {}
  });

  assert.equal(success.ok, true);
  assert.equal(existsSync(successLogPath), false);
});

test('Jira login parser supports base URL override only', () => {
  assert.deepEqual(parseJiraLoginArgs([]), {});
  assert.deepEqual(parseJiraLoginArgs(['--base-url', 'https://jira.example.com/jira']), {
    baseUrl: 'https://jira.example.com/jira'
  });
  assert.deepEqual(parseJiraLoginArgs(['--base-url=https://jira.example.com']), {
    baseUrl: 'https://jira.example.com'
  });
  assert.throws(() => parseJiraLoginArgs(['--base-url']), /requires a value/);
  assert.throws(() => parseJiraLoginArgs(['--token', 'secret']), /Unknown jira login option/);
});

test('Jira login command validates via injected auth and redacts failures', async () => {
  const stdout = [];
  const stderr = [];
  const success = await runJiraLoginCommand({
    baseUrl: 'https://jira.example.com',
    login: async ({ baseUrl }) => {
      assert.equal(baseUrl, 'https://jira.example.com');
      return {
        summary: 'Authenticated to Jira https://jira.example.com as Jira User.'
      };
    },
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message)
  });

  assert.equal(success.ok, true);
  assert.match(stdout.join('\n'), /Starting Jira PAT auth/);
  assert.match(stdout.join('\n'), /Authenticated to Jira/);
  assert.deepEqual(stderr, []);

  const failure = await runJiraLoginCommand({
    login: async () => {
      throw new Error('Jira rejected token=jira-pat-secret');
    },
    stdout: () => {},
    stderr: (message) => stderr.push(message)
  });

  assert.equal(failure.ok, false);
  assert.match(stderr.join('\n'), /token=<redacted>/);
  assert.doesNotMatch(stderr.join('\n'), /jira-pat-secret/);
});

test('setup-user parser supports login flags', () => {
  assert.deepEqual(parseSetupUserArgs(['--login']), { loginMode: 'required' });
  assert.deepEqual(parseSetupUserArgs(['--no-login']), { loginMode: 'skip' });
  assert.deepEqual(parseSetupUserArgs([]), { loginMode: 'prompt' });
  assert.throws(() => parseSetupUserArgs(['--unknown']), /Unknown setup-user option/);
});

test('setup-user runtime installs dependencies before linking global binaries', async () => {
  const calls = [];
  let printedLinkResult = null;
  let printedCleanupResult = null;

  await installUserRuntime({
    options: { loginMode: 'skip' },
    sourceDir: '/tmp/source-logwork-helper',
    targetDir: '/tmp/target-logwork-helper',
    mkdirFn: async () => calls.push('mkdir'),
    copyFn: async () => calls.push('copy'),
    cleanupFn: async () => {
      calls.push('cleanup');
      return { changed: false, changes: [] };
    },
    installFn: async () => calls.push('install'),
    linkFn: async () => {
      calls.push('link');
      return {
        linked: true,
        commandAvailable: true
      };
    },
    authFn: async () => {
      calls.push('auth');
      return null;
    },
    printFn: async (targetDir, authResult, linkResult, cleanupResult) => {
      calls.push('print');
      printedLinkResult = linkResult;
      printedCleanupResult = cleanupResult;
    }
  });

  assert.deepEqual(calls, ['mkdir', 'copy', 'cleanup', 'install', 'link', 'auth', 'print']);
  assert.deepEqual(printedLinkResult, {
    linked: true,
    commandAvailable: true
  });
  assert.deepEqual(printedCleanupResult, {
    changed: false,
    changes: []
  });
});

test('setup-user cleanup removes stale local self tarball dependencies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'logwork-stale-metadata-'));
  const packagePath = join(dir, 'package.json');
  const lockPath = join(dir, 'package-lock.json');
  const stale = 'file:logwork-helper-0.1.5.tgz';
  await import('node:fs/promises').then(async ({ writeFile }) => {
    await writeFile(packagePath, JSON.stringify({
      name: 'logwork-helper',
      dependencies: {
        '@clack/prompts': '^1.5.0',
        'logwork-helper': stale
      }
    }, null, 2));
    await writeFile(lockPath, JSON.stringify({
      name: 'logwork-helper',
      packages: {
        '': {
          dependencies: {
            '@clack/prompts': '^1.5.0',
            'logwork-helper': stale
          }
        },
        'node_modules/logwork-helper': {
          version: stale
        }
      },
      dependencies: {
        'logwork-helper': {
          version: stale
        },
        'node_modules/logwork-helper': {
          version: stale
        }
      }
    }, null, 2));
  });

  const result = await sanitizeRuntimeMetadata(dir);
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  const lockJson = JSON.parse(readFileSync(lockPath, 'utf8'));

  assert.equal(result.changed, true);
  assert.equal(packageJson.dependencies['logwork-helper'], undefined);
  assert.equal(lockJson.packages[''].dependencies['logwork-helper'], undefined);
  assert.equal(lockJson.packages['node_modules/logwork-helper'], undefined);
  assert.equal(lockJson.dependencies['logwork-helper'], undefined);
  assert.equal(lockJson.dependencies['node_modules/logwork-helper'], undefined);
});

test('setup-user cleanup leaves clean metadata unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'logwork-clean-metadata-'));
  const packagePath = join(dir, 'package.json');
  const text = JSON.stringify({
    name: 'logwork-helper',
    dependencies: {
      '@clack/prompts': '^1.5.0'
    }
  }, null, 2);
  await import('node:fs/promises').then(({ writeFile }) => writeFile(packagePath, text));

  const result = await sanitizeRuntimeMetadata(dir);

  assert.equal(result.changed, false);
  assert.deepEqual(result.changes, []);
  assert.equal(readFileSync(packagePath, 'utf8'), text);
});

test('global binary link failure is reported without throwing', async () => {
  const calls = [];
  const result = await linkGlobalBinaries('/tmp/logwork-helper', {
    runner: async (command, args) => {
      calls.push([command, args]);
      throw new Error('EACCES: permission denied');
    },
    commandFinder: async () => true
  });

  assert.deepEqual(calls, [['npm', ['link']]]);
  assert.equal(result.linked, false);
  assert.equal(result.commandAvailable, false);
  assert.match(result.error, /EACCES/);
});

test('global binary link warns when logwork is not visible on PATH', async () => {
  const calls = [];
  const result = await linkGlobalBinaries('/tmp/logwork-helper', {
    runner: async (command, args) => {
      calls.push([command, args]);
    },
    commandFinder: async () => false
  });

  assert.deepEqual(calls, [['npm', ['link']]]);
  assert.equal(result.linked, true);
  assert.equal(result.commandAvailable, false);
  assert.match(result.warning, /not visible on PATH/);
});

test('PATH command finder supports Windows npm shims', async () => {
  const checked = [];
  const result = await findCommandOnPath('logwork', {
    platform: 'win32',
    envPath: 'C:\\Tools;C:\\Users\\example\\AppData\\Roaming\\npm',
    accessFn: async (path) => {
      checked.push(path);
      if (path.endsWith('logwork.cmd')) {
        return;
      }
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    }
  });

  assert.equal(result, true);
  assert.equal(checked.some((path) => path.endsWith('logwork.cmd')), true);
});

test('setup-user output explains terminal commands and fallback install', () => {
  assert.match(formatTerminalCommandInstructions({
    linked: true,
    commandAvailable: true
  }), /Terminal commands installed:\n  logwork\n  logwork-helper auth login/);

  assert.match(formatTerminalCommandInstructions({
    linked: false,
    commandAvailable: false,
    error: 'ELINKGLOBAL'
  }), /Fallback:\n  npm install -g logwork-helper/);
  assert.doesNotMatch(formatTerminalCommandInstructions({
    linked: false,
    commandAvailable: false,
    error: 'ELINKGLOBAL'
  }), /npm link --global/);
});

test('setup-user checklist omits auth retry after successful login', () => {
  const output = formatSetupUserInstructions({
    targetDir: '/tmp/target-logwork-helper',
    authResult: { ok: true },
    linkResult: {
      linked: true,
      commandAvailable: true
    },
    cleanupResult: {
      changed: false,
      changes: []
    }
  });

  assert.match(output, /Install status/);
  assert.match(output, /Next steps/);
  assert.match(output, /MCP config/);
  assert.match(output, /Verify/);
  assert.match(output, /Safety/);
  assert.match(output, /- Auth: completed/);
  assert.doesNotMatch(nextStepsSection(output), /logwork-helper auth login/);
  assert.match(output, /Cursor \/ Antigravity mcp_config\.json:/);
  assert.match(output, /Codex config\.toml:/);
  assert.match(output, /GitHub Copilot \/ VS Code mcp\.json:/);
  assert.match(output, /target-logwork-helper/);
  assert.match(output, /mcp-server\.mjs/);
});

test('setup-user checklist uses Windows credential store and hook command on Windows', () => {
  const output = formatSetupUserInstructions({
    targetDir: 'C:\\Users\\example\\.logwork-helper',
    platform: 'win32',
    authResult: null,
    linkResult: {
      linked: true,
      commandAvailable: true
    },
    cleanupResult: {
      changed: false,
      changes: []
    }
  });

  assert.match(output, /Windows Credential Manager/);
  assert.match(output, /logwork-helper install-hook C:\\path\\to\\project-repo/);
  assert.doesNotMatch(output, /setup\.sh/);
});

test('setup-user checklist gives auth retry only when auth is skipped or fails', () => {
  const skipped = formatSetupUserInstructions({
    targetDir: '/tmp/target-logwork-helper',
    authResult: null,
    linkResult: {
      linked: true,
      commandAvailable: true
    },
    cleanupResult: {
      changed: false,
      changes: []
    }
  });

  assert.match(skipped, /- Auth: not run/);
  assert.match(nextStepsSection(skipped), /logwork-helper auth login/);

  const failed = formatSetupUserInstructions({
    targetDir: '/tmp/target-logwork-helper',
    authResult: {
      ok: false,
      error: `Invalid password=secret accessToken=${makeJwt()}`
    },
    linkResult: {
      linked: true,
      commandAvailable: true
    },
    cleanupResult: {
      changed: false,
      changes: []
    }
  });

  assert.match(failed, /- Auth: not completed/);
  assert.match(failed, /password=<redacted>/);
  assert.doesNotMatch(failed, /password=secret/);
  assert.doesNotMatch(failed, /eyJ/);
  assert.match(nextStepsSection(failed), /logwork-helper auth login/);
});

test('setup-user checklist preserves link warnings and fallback install guidance', () => {
  const missingPath = formatSetupUserInstructions({
    targetDir: '/tmp/target-logwork-helper',
    linkResult: {
      linked: true,
      commandAvailable: false,
      warning: '`logwork` was linked, but it is not visible on PATH in this shell.'
    }
  });

  assert.match(missingPath, /Warning: `logwork` was linked, but it is not visible on PATH/);

  const failedLink = formatSetupUserInstructions({
    targetDir: '/tmp/target-logwork-helper',
    linkResult: {
      linked: false,
      commandAvailable: false,
      error: 'ELINKGLOBAL'
    }
  });

  assert.match(failedLink, /Terminal command link did not complete/);
  assert.match(failedLink, /Fallback:\n  npm install -g logwork-helper/);
  assert.doesNotMatch(failedLink, /npm link --global/);
});

test('manual parser defaults to REPL and keeps quick compatibility', () => {
  assert.deepEqual(parseManualArgs([]), {
    mode: 'repl',
    message: '',
    help: false
  });
  assert.deepEqual(parseManualArgs(['quick', '--message', 'Fix login bug']), {
    mode: 'quick',
    message: 'Fix login bug',
    help: false
  });
  assert.deepEqual(parseManualArgs(['--message', 'Fix login bug']), {
    mode: 'quick',
    message: 'Fix login bug',
    help: false
  });
  assert.deepEqual(parseManualArgs(['Fix login bug']), {
    mode: 'quick',
    message: 'Fix login bug',
    help: false
  });
});

test('manual startup update notice is actionable and never blocks on check failure', async () => {
  const notice = await getStartupUpdateNotice({
    checkForUpdatesFn: async () => ({
      updateAvailable: true,
      currentVersion: '0.1.10',
      latestVersion: '0.1.11'
    })
  });
  assert.match(notice, /0\.1\.10 -> 0\.1\.11/);
  assert.match(notice, /logwork-helper update install/);

  assert.equal(await getStartupUpdateNotice({
    checkForUpdatesFn: async () => { throw new Error('offline'); }
  }), '');
});

test('CLI dispatcher rejects browser auth options before login', () => {
  const result = spawnSync(process.execPath, ['cli.mjs', 'auth', 'login', '--browser', 'internet-explorer'], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Browser auth has been removed/);
});

test('CLI dispatcher rejects removed auth record command', () => {
  const result = spawnSync(process.execPath, ['cli.mjs', 'auth', 'record'], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown auth command: record/);
});

test('CLI dispatcher rejects unknown commands', () => {
  const result = spawnSync(process.execPath, ['cli.mjs', 'unknown-command'], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command: unknown-command/);
});

function makeJwt() {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ id: 115, exp: 1781495600 })).toString('base64url'),
    'signature'
  ].join('.');
}

function nextStepsSection(output) {
  return String(output).match(/Next steps\n([\s\S]*?)\n\nMCP config/)?.[1] || '';
}
