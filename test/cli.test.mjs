import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseJiraLoginArgs, parseLoginArgs, runJiraLoginCommand, runLoginCommand } from '../commands/auth.mjs';
import { createAuthDiagnosticsRecorder } from '../lib/auth-diagnostics.mjs';
import {
  formatSetupUserInstructions,
  formatTerminalCommandInstructions,
  findCommandOnPath,
  installUserRuntime,
  linkGlobalBinaries,
  parseSetupUserArgs,
  sanitizeRuntimeMetadata
} from '../commands/setup.mjs';
import { parseQuickArgs } from '../commands/quick.mjs';
import { getStartupUpdateNotice } from '../commands/tui.mjs';
import { COMMANDS } from '../bin/logwork.mjs';
import { isMainModule } from '../lib/entrypoint.mjs';

const ENTRY = 'bin/logwork.mjs';
const NO_MIGRATION_ENV = { ...process.env, LOGWORK_HOME: mkdtempSync(join(tmpdir(), 'logwork-cli-home-')) };

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [ENTRY, ...args], {
    encoding: 'utf8',
    env: NO_MIGRATION_ENV,
    ...options
  });
}

test('package exposes a single logwork entry (plus logwork-cli for npx)', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.name, 'logwork-cli');
  assert.deepEqual(packageJson.bin, {
    logwork: 'bin/logwork.mjs',
    'logwork-cli': 'bin/logwork.mjs'
  });
  assert.match(packageJson.repository.url, /malcohelper\/logwork-cli/);
});

test('every command module exports the function the dispatcher calls', async () => {
  for (const command of COMMANDS) {
    const module = await command.load();
    assert.equal(typeof module[command.fn], 'function', `${command.name} -> ${command.fn}`);
  }
});

test('entrypoint detection supports direct paths, symlinks, and unrelated paths', {
  skip: process.platform === 'win32' ? 'Windows npm bins use command shims instead of POSIX symlinks.' : false
}, () => {
  const entryPath = new URL('../bin/logwork.mjs', import.meta.url).pathname;
  const entryUrl = pathToFileURL(realpathSync(entryPath)).href;
  const tmpDir = mkdtempSync(join(tmpdir(), 'logwork-entrypoint-'));
  const symlinkPath = join(tmpDir, 'logwork');
  symlinkSync(entryPath, symlinkPath);

  assert.equal(isMainModule(entryUrl, ['node', entryPath]), true);
  assert.equal(isMainModule(entryUrl, ['node', symlinkPath]), true);
  assert.equal(isMainModule(entryUrl, ['node', new URL('../package.json', import.meta.url).pathname]), false);
});

test('logwork starts through a symlink like an npm global bin and opens the terminal UI', {
  skip: process.platform === 'win32' ? 'Windows npm bins use command shims instead of POSIX symlinks.' : false
}, () => {
  const entryPath = new URL('../bin/logwork.mjs', import.meta.url).pathname;
  const tmpDir = mkdtempSync(join(tmpdir(), 'logwork-bin-'));
  const symlinkPath = join(tmpDir, 'logwork');
  symlinkSync(entryPath, symlinkPath);

  const help = spawnSync(process.execPath, [symlinkPath, '--help'], { encoding: 'utf8', env: NO_MIGRATION_ENV });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /logwork <command>/);

  const repl = spawnSync(process.execPath, [symlinkPath], {
    input: '/help\n',
    encoding: 'utf8',
    env: NO_MIGRATION_ENV
  });
  assert.equal(repl.status, 0);
  assert.match(repl.stdout, /Logwork terminal UI/);
  assert.match(repl.stdout, /\/logwork \[ro\|jira\|both\]\s+Create Resource Optimiser, Jira, or combined logwork/);
});

test('logwork --help lists every command and short examples', () => {
  const result = runCli(['--help']);
  assert.equal(result.status, 0);
  for (const name of ['query', 'quick', 'edit', 'delete', 'reconcile', 'history', 'login', 'logout', 'status', 'setup', 'mcp', 'reminder', 'update', 'doctor', 'release']) {
    assert.match(result.stdout, new RegExp(`\\n  ${name}\\s`), name);
  }
  assert.match(result.stdout, /logwork edit 304032 --task "Bug Fix" --desc/);
  assert.doesNotMatch(result.stdout, /logwork-helper/);
});

test('logwork rejects unknown commands and prints help', () => {
  const result = runCli(['unknown-command']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command: unknown-command/);
});

test('logwork --version prints the package version', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const result = runCli(['--version']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), packageJson.version);
});

const HELP_CASES = [
  [['setup', '--help'], [/logwork setup \[--login\|--no-login\]/, /prints\nMCP configs|MCP configs/, /carried over automatically/]],
  [['login', '--help'], [/logwork login \[ro\|jira\]/, /Personal Access Token/, /never in files or command arguments/]],
  [['status', '--help'], [/logwork status \[ro\|jira\]/]],
  [['doctor', '--help'], [/logwork doctor/, /sanitized support report/]],
  [['release', '--help'], [/logwork release doctor \[--full\]/, /npm pack --dry-run/]],
  [['history', '--help'], [/logwork history \[--target ro\|jira\|both\]/, /local apply result ledger/]],
  [['update', '--help'], [/update check \[--force\]/, /update install \[--version <semver>\]/]],
  [['reminder', '--help'], [/logwork reminder enable \[--time HH:mm\]/, /launchd on macOS and Task Scheduler on Windows/]],
  [['reconcile', '--help'], [/reconcile \[today\|yesterday\|this-week/]],
  [['query', '--help'], [/logwork query \[today\|yesterday/, /logwork edit/]],
  [['quick', '--help'], [/logwork quick -m/, /description/]],
  [['edit', '--help'], [/logwork edit <id>/, /--task <task>/, /--desc <text>/, /replaces the entry/]],
  [['delete', '--help'], [/logwork delete/]]
];

for (const [args, patterns] of HELP_CASES) {
  test(`logwork ${args.join(' ')} prints help without side effects`, () => {
    const result = runCli(args);
    assert.equal(result.status, 0, result.stderr);
    for (const pattern of patterns) {
      assert.match(result.stdout, pattern);
    }
    assert.doesNotMatch(result.stdout, /logwork-helper (auth|jira|setup-user|manual)/);
  });
}

test('logwork doctor writes a sanitized report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'logwork-doctor-cli-'));
  const result = runCli(['doctor'], { env: { ...process.env, LOGWORK_HOME: dir } });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Diagnostics report written to/);
  const reportPath = result.stdout.match(/Diagnostics report written to (.+)/)?.[1]?.trim();
  assert.ok(reportPath);
  assert.equal(existsSync(reportPath), true);
  assert.doesNotMatch(readFileSync(reportPath, 'utf8'), /eyJ/);
});

test('quick parser accepts -m, --message= and positional text', () => {
  assert.deepEqual(parseQuickArgs(['-m', 'Fix login']), { message: 'Fix login', help: false });
  assert.deepEqual(parseQuickArgs(['--message=Fix login']), { message: 'Fix login', help: false });
  assert.deepEqual(parseQuickArgs(['Fix', 'login']), { message: 'Fix login', help: false });
  assert.deepEqual(parseQuickArgs(['--help']), { message: '', help: true });
  assert.throws(() => parseQuickArgs(['-m']), /requires a value/);
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
  assert.throws(() => parseSetupUserArgs(['--unknown']), /Unknown setup option/);
});

test('setup-user runtime installs dependencies before linking global binaries', async () => {
  const calls = [];
  let printedLinkResult = null;
  let printedCleanupResult = null;

  await installUserRuntime({
    options: { loginMode: 'skip' },
    sourceDir: '/tmp/source-logwork-cli',
    targetDir: '/tmp/target-logwork-cli',
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
    reminderFn: async () => {
      calls.push('reminder');
      return null;
    },
    printFn: async (targetDir, authResult, linkResult, cleanupResult) => {
      calls.push('print');
      printedLinkResult = linkResult;
      printedCleanupResult = cleanupResult;
    }
  });

  assert.deepEqual(calls, ['mkdir', 'copy', 'cleanup', 'install', 'link', 'auth', 'reminder', 'print']);
  assert.deepEqual(printedLinkResult, {
    linked: true,
    commandAvailable: true
  });
  assert.deepEqual(printedCleanupResult, {
    changed: false,
    changes: []
  });
});

test('setup cleanup removes stale local self tarball dependencies', async () => {
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

  assert.deepEqual(calls, [['npm', ['rm', '-g', 'logwork-helper']], ['npm', ['link']]]);
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

  assert.deepEqual(calls, [['npm', ['rm', '-g', 'logwork-helper']], ['npm', ['link']]]);
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
  }), /Terminal command installed:\n  logwork +open the terminal UI\n  logwork login/);

  assert.match(formatTerminalCommandInstructions({
    linked: false,
    commandAvailable: false,
    error: 'ELINKGLOBAL'
  }), /Fallback:\n  npm install -g logwork-cli/);
  assert.doesNotMatch(formatTerminalCommandInstructions({
    linked: false,
    commandAvailable: false,
    error: 'ELINKGLOBAL'
  }), /npm link --global/);
});

test('setup-user checklist omits auth retry after successful login', () => {
  const output = formatSetupUserInstructions({
    targetDir: '/tmp/target-logwork-cli',
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
  assert.doesNotMatch(nextStepsSection(output), /logwork login/);
  assert.match(output, /Cursor \/ Antigravity \/ Claude Code \(\.mcp\.json\):/);
  assert.match(output, /Codex config\.toml:/);
  assert.match(output, /GitHub Copilot \/ VS Code mcp\.json:/);
  assert.match(output, /target-logwork-cli/);
  assert.match(output, /"logwork": \{/);
  assert.match(output, /bin\/logwork\.mjs",\n\s+"mcp"/);
});

test('setup checklist uses the Windows credential store on Windows', () => {
  const output = formatSetupUserInstructions({
    targetDir: 'C:\\Users\\example\\.logwork-cli',
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
  assert.doesNotMatch(output, /install-hook|setup\.sh/);
});

test('setup-user checklist gives auth retry only when auth is skipped or fails', () => {
  const skipped = formatSetupUserInstructions({
    targetDir: '/tmp/target-logwork-cli',
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
  assert.match(nextStepsSection(skipped), /logwork login/);

  const failed = formatSetupUserInstructions({
    targetDir: '/tmp/target-logwork-cli',
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
  assert.match(nextStepsSection(failed), /logwork login/);
});

test('setup-user checklist preserves link warnings and fallback install guidance', () => {
  const missingPath = formatSetupUserInstructions({
    targetDir: '/tmp/target-logwork-cli',
    linkResult: {
      linked: true,
      commandAvailable: false,
      warning: '`logwork` was linked, but it is not visible on PATH in this shell.'
    }
  });

  assert.match(missingPath, /Warning: `logwork` was linked, but it is not visible on PATH/);

  const failedLink = formatSetupUserInstructions({
    targetDir: '/tmp/target-logwork-cli',
    linkResult: {
      linked: false,
      commandAvailable: false,
      error: 'ELINKGLOBAL'
    }
  });

  assert.match(failedLink, /Terminal command link did not complete/);
  assert.match(failedLink, /Fallback:\n  npm install -g logwork-cli/);
  assert.doesNotMatch(failedLink, /npm link --global/);
});

test('terminal UI startup update notice is actionable and never blocks on check failure', async () => {
  const notice = await getStartupUpdateNotice({
    checkForUpdatesFn: async () => ({
      updateAvailable: true,
      currentVersion: '0.1.10',
      latestVersion: '0.1.11'
    })
  });
  assert.match(notice, /0\.1\.10 -> 0\.1\.11/);
  assert.match(notice, /logwork update install/);

  assert.equal(await getStartupUpdateNotice({
    checkForUpdatesFn: async () => { throw new Error('offline'); }
  }), '');
});

test('logwork login rejects browser auth options before prompting', () => {
  const result = runCli(['login', '--browser', 'internet-explorer']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Browser auth has been removed/);
});

test('logwork logout rejects unknown options', () => {
  const result = runCli(['logout', 'record']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown logout option: record/);
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
