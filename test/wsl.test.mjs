import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openWslTerminal,
  startAuthLoginTerminal
} from '../lib/auth-terminal.mjs';
import {
  createCredentialEmailStorage,
  createCredentialJiraStorage,
  createCredentialTokenStorage,
  credentialStoreLabel,
  wslCredentialRunner
} from '../lib/credential-store.mjs';
import { sendOsNotification, sendWslNotification } from '../lib/os-notification.mjs';
import {
  buildWslReminderCreateArgs,
  getReminderSchedulerStatus,
  installReminderScheduler,
  parseWslTaskLauncher,
  readReminderSchedulerNodePath,
  removeReminderScheduler,
  wslReminderTaskName
} from '../lib/reminder-scheduler.mjs';
import { powerShellScriptArgs, runPowerShellCredentialCommand } from '../lib/windows-credential-manager.mjs';
import { isWsl, windowsExecutable, wslDistroName, wslUserName } from '../lib/wsl.mjs';

const WSL_ENV = { WSL_DISTRO_NAME: 'Ubuntu-24.04', USER: 'jane', PATH: '/usr/bin:/mnt/c/Windows/System32' };
const LAUNCH = { command: '/home/jane/.logwork-cli/bin/logwork-launch', argsPrefix: [], kind: 'launcher' };
const HOME = '/home/jane/.logwork-cli';
const CONFIG = { enabled: true, time: '17:00', target: 'ro', days: [1, 2, 3, 4, 5] };
const POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';

function decodeEncodedCommand(args) {
  const index = args.indexOf('-EncodedCommand');
  assert.ok(index >= 0, 'uses -EncodedCommand');
  return Buffer.from(args[index + 1], 'base64').toString('utf16le');
}

test('WSL is detected from the environment or the kernel release, and LOGWORK_WSL=0 turns it off', () => {
  assert.equal(isWsl({ platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' }, readOsRelease: () => '' }), true);
  assert.equal(isWsl({ platform: 'linux', env: { WSL_INTEROP: '/run/WSL/1_interop' }, readOsRelease: () => '' }), true);
  assert.equal(isWsl({ platform: 'linux', env: {}, readOsRelease: () => '5.15.153.1-microsoft-standard-WSL2' }), true);
  assert.equal(isWsl({ platform: 'linux', env: {}, readOsRelease: () => '4.4.0-19041-Microsoft' }), true);
  assert.equal(isWsl({ platform: 'linux', env: {}, readOsRelease: () => '6.8.0-1017-azure' }), false);
  assert.equal(isWsl({ platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu', LOGWORK_WSL: '0' }, readOsRelease: () => 'microsoft' }), false);
  assert.equal(isWsl({ platform: 'win32', env: { WSL_DISTRO_NAME: 'Ubuntu' } }), false);
  assert.equal(isWsl({ platform: 'darwin', env: {}, readOsRelease: () => 'microsoft' }), false);
});

test('WSL helpers find Windows programs and name the distro and user', () => {
  const exists = (path) => path === '/mnt/c/Windows/System32/schtasks.exe' || path === '/opt/win/powershell.exe';
  assert.equal(windowsExecutable('powershell.exe', { env: { PATH: '/usr/bin:/opt/win' }, exists }), '/opt/win/powershell.exe');
  assert.equal(windowsExecutable('schtasks.exe', { env: { PATH: '/usr/bin' }, exists }), '/mnt/c/Windows/System32/schtasks.exe');
  assert.equal(windowsExecutable('wsl.exe', { env: { PATH: '' }, exists: () => false }), 'wsl.exe');
  assert.equal(wslDistroName({ env: WSL_ENV }), 'Ubuntu-24.04');
  assert.throws(() => wslDistroName({ env: {} }), /WSL_DISTRO_NAME is not set/);
  assert.equal(wslUserName({ env: { USER: 'jane' } }), 'jane');
  assert.equal(wslUserName({ env: {}, info: () => ({ username: 'bob' }) }), 'bob');
});

test('PowerShell scripts can go as -EncodedCommand (UTF-16LE base64)', () => {
  assert.deepEqual(powerShellScriptArgs('Write-Output 1'), ['-Command', 'Write-Output 1']);
  const script = "$x = 'ünïcode \"quotes\"'\nWrite-Output $x";
  assert.equal(decodeEncodedCommand(powerShellScriptArgs(script, { encoded: true })), script);
});

test('WSL credentials use the Windows Credential Manager targets shared with a Windows install', async () => {
  const vault = new Map();
  const calls = [];
  const run = async (request) => {
    calls.push(request);
    if (request.action === 'set') {
      vault.set(request.target, request.value);
      return { ok: true };
    }
    if (request.action === 'get') {
      return vault.has(request.target) ? { found: true, value: vault.get(request.target) } : { found: false };
    }
    return { deleted: vault.delete(request.target) };
  };
  const token = createCredentialTokenStorage({ platform: 'linux', wsl: true, run });
  const email = createCredentialEmailStorage({ platform: 'linux', wsl: true, run });
  const jira = createCredentialJiraStorage({ platform: 'linux', wsl: true, run });
  await token.set('session');
  await email.set('me@example.com');
  await jira.set('pat');
  assert.deepEqual([...vault.keys()].sort(), ['logwork-cli:jira', 'logwork-cli:resourceoptimiser', 'logwork-cli:resourceoptimiser-email']);
  assert.equal(await token.get(), 'session');

  // The shared Windows vault may still hold a logwork-helper session.
  vault.clear();
  vault.set('logwork-helper:resourceoptimiser', 'old-session');
  assert.equal(await createCredentialTokenStorage({ platform: 'linux', wsl: true, run }).get(), 'old-session');
  assert.equal(vault.get('logwork-cli:resourceoptimiser'), 'old-session', 'copied forward');
  assert.ok(calls.every((call) => !JSON.stringify(call).includes('secret-tool')));

  assert.equal(credentialStoreLabel({ platform: 'linux', wsl: true }), 'Windows Credential Manager (from WSL)');
  assert.equal(credentialStoreLabel({ platform: 'linux', wsl: false }), 'Linux Secret Service (libsecret)');
});

test('WSL credential runner calls powershell.exe with an encoded script and explains interop failures', async () => {
  let seen;
  const runner = wslCredentialRunner({
    env: { PATH: '/mnt/c/Windows/System32/WindowsPowerShell/v1.0' },
    runner: async (request, options) => { seen = { request, options }; return { found: false }; }
  });
  await runner({ action: 'get', target: 'logwork-cli:resourceoptimiser', username: 'resourceoptimiser' });
  assert.equal(seen.options.encoded, true);
  assert.match(seen.options.command, /powershell\.exe$/);

  const failing = wslCredentialRunner({ env: {}, runner: async () => { throw new Error('spawn powershell.exe ENOENT'); } });
  await assert.rejects(failing({ action: 'get' }), /ENOENT.*WSL interop.*LOGWORK_WSL=0/);

  // The real runner sends the request on stdin, never in argv.
  let spawned;
  let stdinText = '';
  const fakeChild = {
    stdout: { setEncoding() {}, on(event, fn) { if (event === 'data') { queueMicrotask(() => fn('{"found":false}')); } } },
    stderr: { setEncoding() {}, on() {} },
    stdin: { end(value) { stdinText = value; } },
    on(event, fn) { if (event === 'close') { setTimeout(() => fn(0), 5); } }
  };
  await runPowerShellCredentialCommand({ action: 'get', target: 't', username: 'u', value: 'never-in-argv' }, {
    command: POWERSHELL,
    encoded: true,
    spawnFn: (command, args) => { spawned = { command, args }; return fakeChild; }
  });
  assert.equal(spawned.command, POWERSHELL);
  assert.match(decodeEncodedCommand(spawned.args), /CredRead|Credential/i);
  assert.ok(!spawned.args.some((arg) => arg.includes('never-in-argv')));
  assert.match(stdinText, /never-in-argv/);
});

test('WSL notifications are Windows toasts through powershell.exe', async () => {
  const routed = [];
  await sendOsNotification({
    title: 'Logwork',
    message: 'RO: 6/8h',
    platform: 'linux',
    wsl: true,
    wslNotifier: async (value) => { routed.push(value); },
    linuxNotifier: async () => { throw new Error('notify-send must not run under WSL'); }
  });
  assert.deepEqual(routed, [{ title: 'Logwork', message: 'RO: 6/8h' }]);

  let call;
  await sendWslNotification({ title: 'Logwork', message: 'x' }, {
    env: { PATH: '/mnt/c/Windows/System32/WindowsPowerShell/v1.0' },
    run: async (notification, options) => { call = { notification, options }; }
  });
  assert.equal(call.options.encoded, true);
  assert.match(call.options.command, /powershell\.exe$/);
  await assert.rejects(
    sendWslNotification({ title: 'Logwork', message: 'x' }, { env: {}, run: async () => { throw new Error('toast failed'); } }),
    /toast failed.*WSL interop/
  );
});

test('WSL reminder task starts the distro with wsl.exe at the configured time', () => {
  const args = buildWslReminderCreateArgs({ config: CONFIG, launch: LAUNCH, home: HOME, distro: 'Ubuntu-24.04', user: 'jane' });
  assert.equal(args[args.indexOf('/TN') + 1], 'Logwork Reminder (WSL Ubuntu-24.04)');
  assert.equal(
    args[args.indexOf('/TR') + 1],
    'wsl.exe -d Ubuntu-24.04 -u jane --exec /home/jane/.logwork-cli/bin/logwork-launch reminder run --home /home/jane/.logwork-cli'
  );
  assert.equal(args[args.indexOf('/D') + 1], 'MON,TUE,WED,THU,FRI');
  assert.equal(args[args.indexOf('/ST') + 1], '17:00');
  assert.ok(args.includes('/IT'));

  assert.throws(
    () => buildWslReminderCreateArgs({ config: CONFIG, launch: LAUNCH, home: '/home/jane/my logwork', distro: 'Ubuntu', user: 'jane' }),
    /cannot use a path or name with spaces/
  );
  const long = `/home/jane/${'x'.repeat(200)}`;
  assert.throws(
    () => buildWslReminderCreateArgs({ config: CONFIG, launch: { command: `${long}/bin/logwork-launch`, argsPrefix: [] }, home: long, distro: 'Ubuntu', user: 'jane' }),
    /at most 261/
  );
  assert.equal(wslReminderTaskName({ env: WSL_ENV }), 'Logwork Reminder (WSL Ubuntu-24.04)');
});

test('WSL reminder install, status, launcher path and removal go through schtasks.exe', async () => {
  const calls = [];
  const xml = '<Task><Actions><Exec><Command>wsl.exe</Command><Arguments>-d Ubuntu-24.04 -u jane --exec /home/jane/.logwork-cli/bin/logwork-launch reminder run --home /home/jane/.logwork-cli</Arguments></Exec></Actions></Task>';
  const run = async (command, args) => {
    calls.push([command.split('/').pop(), ...args].join(' '));
    if (args.includes('/XML')) {
      return { code: 0, stdout: xml.split('').join('\0'), stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const options = { platform: 'linux', wsl: true, env: WSL_ENV, userHome: '/home/jane', uid: 1000, run };
  const installed = await installReminderScheduler(CONFIG, {
    ...options,
    home: HOME,
    launch: LAUNCH,
    accessRunner: async () => {},
    writeLauncherFn: async () => {},
    writeFile: async () => { throw new Error('no systemd units under WSL'); }
  });
  assert.equal(installed.scheduler, 'Windows Task Scheduler (WSL)');
  assert.equal(installed.identifier, 'Logwork Reminder (WSL Ubuntu-24.04)');
  assert.match(calls[0], /^schtasks\.exe \/Create \/TN Logwork Reminder \(WSL Ubuntu-24\.04\) \/TR wsl\.exe -d Ubuntu-24\.04 -u jane --exec/);
  assert.ok(!calls.some((call) => call.startsWith('systemctl')));

  const status = await getReminderSchedulerStatus(options);
  assert.equal(status.installed, true);
  assert.equal(status.nodePath, LAUNCH.command);
  assert.equal(await readReminderSchedulerNodePath(options), LAUNCH.command);

  calls.length = 0;
  const removed = await removeReminderScheduler(options);
  assert.equal(removed.installed, false);
  assert.deepEqual(calls, [
    'schtasks.exe /Query /TN Logwork Reminder (WSL Ubuntu-24.04)',
    'schtasks.exe /Delete /TN Logwork Reminder (WSL Ubuntu-24.04) /F'
  ]);

  await assert.rejects(
    installReminderScheduler(CONFIG, {
      ...options,
      home: HOME,
      launch: LAUNCH,
      accessRunner: async () => {},
      writeLauncherFn: async () => {},
      run: async () => ({ code: 1, stdout: '', stderr: 'ERROR: Access is denied.' })
    }),
    /schtasks\.exe \/Create failed with exit code 1: ERROR: Access is denied\./
  );
  assert.equal(parseWslTaskLauncher('<Arguments>-d U --exec "/a/launch" x</Arguments>'), '/a/launch');
  assert.equal(parseWslTaskLauncher('<Exec><Command>node.exe</Command></Exec>'), null);
});

test('WSL login opens a Windows console running the login script in the distro', async () => {
  const home = await mkdtemp(join(tmpdir(), 'logwork-wsl-login-'));
  let ran;
  const opened = await openWslTerminal("cd '/home/jane/.logwork-cli' && '/usr/bin/node' 'bin/logwork.mjs' 'login'", {
    env: WSL_ENV,
    home,
    run: async (command, args) => { ran = { command, args }; }
  });
  assert.equal(opened, 'wsl.exe');
  const script = await readFile(join(home, 'login-terminal.sh'), 'utf8');
  assert.match(script, /^#!\/bin\/sh\ncd '\/home\/jane\/\.logwork-cli' && '\/usr\/bin\/node' 'bin\/logwork\.mjs' 'login'\nprintf '\\nPress Enter to close this window\. '\nread logwork_done\n$/);
  assert.match(ran.command, /powershell\.exe$/);
  assert.equal(
    decodeEncodedCommand(ran.args),
    `Start-Process -FilePath 'wsl.exe' -ArgumentList @('-d','Ubuntu-24.04','-u','jane','--exec','sh','${home}/login-terminal.sh')`
  );

  // A name that would need quoting is not passed to PowerShell.
  assert.equal(await openWslTerminal('x', { env: { ...WSL_ENV, WSL_DISTRO_NAME: "it's" }, home, run: async () => { throw new Error('must not run'); } }), null);

  const result = await startAuthLoginTerminal({
    platform: 'linux',
    wsl: true,
    env: WSL_ENV,
    command: 'logwork login',
    openWsl: async () => 'wsl.exe'
  });
  assert.equal(result.status, 'auth_login_started');
  assert.match(result.summary, /Windows terminal window running WSL/);

  // If Windows cannot open it, fall back to a Linux terminal or the printed command.
  const fallback = await startAuthLoginTerminal({
    platform: 'linux',
    wsl: true,
    env: WSL_ENV,
    command: 'logwork login',
    openWsl: async () => { throw new Error('interop off'); },
    findCommand: async () => null
  });
  assert.equal(fallback.status, 'auth_required');
});

// Real interop, inside a WSL distro on Windows (CI: setup-wsl). Uses Windows
// Credential Manager and Task Scheduler through powershell.exe / schtasks.exe.
const REAL_WSL = process.env.TEST_WSL_INTEROP === '1';
const realSkip = REAL_WSL ? false : 'Real WSL interop tests run only inside WSL with TEST_WSL_INTEROP=1.';

test('WSL interop: Windows Credential Manager round trip through powershell.exe', { skip: realSkip }, async () => {
  const service = `logwork-cli-wsl-test-${Date.now()}`;
  const storage = createCredentialTokenStorage({ platform: 'linux', wsl: true, service, account: 'resourceoptimiser-test' });
  const secret = `session-${Date.now()} "quoted" ünïcode`;
  try {
    assert.equal(await storage.get(), null);
    await storage.set(secret);
    assert.equal(await storage.get(), secret);
    assert.equal(await storage.delete(), true);
    assert.equal(await storage.get(), null);
  } finally {
    await storage.delete().catch(() => {});
  }
});

test('WSL interop: a Task Scheduler task is created, read back and deleted through schtasks.exe', { skip: realSkip }, async () => {
  const env = { ...process.env, WSL_DISTRO_NAME: `${process.env.WSL_DISTRO_NAME}-logwork-test-${process.pid}` };
  const options = { platform: 'linux', wsl: true, env };
  try {
    const installed = await installReminderScheduler(CONFIG, {
      ...options,
      home: HOME,
      launch: LAUNCH,
      accessRunner: async () => {},
      writeLauncherFn: async () => {}
    });
    assert.equal(installed.installed, true);
    const status = await getReminderSchedulerStatus(options);
    assert.equal(status.installed, true);
    assert.equal(status.nodePath, LAUNCH.command);
  } finally {
    const removed = await removeReminderScheduler(options);
    assert.equal(removed.installed, false);
  }
  assert.equal((await getReminderSchedulerStatus(options)).installed, false);
  // Sanity: the distro really is WSL.
  assert.match(execFileSync('uname', ['-r'], { encoding: 'utf8' }), /microsoft/i);
});
