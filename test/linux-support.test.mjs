import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  createCredentialEmailStorage,
  createCredentialTokenStorage
} from '../lib/credential-store.mjs';
import {
  createSecretServiceValueStorage,
  runSecretTool
} from '../lib/linux-secret-service.mjs';
import {
  linuxNotificationEnv,
  runNotifySend,
  sendLinuxNotification,
  sendOsNotification
} from '../lib/os-notification.mjs';
import {
  buildLinuxCronLine,
  buildLinuxReminderService,
  buildLinuxReminderTimer,
  getReminderSchedulerStatus,
  installReminderScheduler,
  linuxReminderUnitPaths,
  parseLinuxServiceNodePath,
  readReminderSchedulerNodePath,
  removeReminderScheduler
} from '../lib/reminder-scheduler.mjs';

const LAUNCH = { command: '/home/u/.logwork-cli/bin/logwork-launch', argsPrefix: [], kind: 'launcher' };
const HOME = '/home/u/.logwork-cli';
const CONFIG = { enabled: true, time: '17:30', target: 'both', days: [1, 2, 3, 4, 5] };

// A fake secret-tool keyed by the attribute list.
function fakeSecretTool() {
  const store = new Map();
  const calls = [];
  const run = async (args, { input } = {}) => {
    calls.push({ args, input });
    const [action, ...rest] = args;
    const attrs = rest.filter((arg) => !arg.startsWith('--label=')).join('|');
    if (action === 'lookup') {
      return store.has(attrs) ? { code: 0, stdout: store.get(attrs), stderr: '' } : { code: 1, stdout: '', stderr: '' };
    }
    if (action === 'store') {
      store.set(attrs, input);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (action === 'clear') {
      store.delete(attrs);
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 2, stdout: '', stderr: 'unknown' };
  };
  return { run, calls, store };
}

test('Linux Secret Service storage sets, gets and deletes with the secret only on stdin', async () => {
  const tool = fakeSecretTool();
  const storage = createSecretServiceValueStorage({ service: 'logwork-cli', account: 'resourceoptimiser', run: tool.run });

  assert.equal(await storage.get(), null);
  await storage.set('refresh-token-secret');
  assert.equal(await storage.get(), 'refresh-token-secret');
  assert.equal(await storage.delete(), true);
  assert.equal(await storage.get(), null);
  assert.equal(await storage.delete(), false);

  const store = tool.calls.find((call) => call.args[0] === 'store');
  assert.deepEqual(store.args, ['store', '--label=logwork-cli (resourceoptimiser)', 'service', 'logwork-cli', 'account', 'resourceoptimiser']);
  assert.equal(store.input, 'refresh-token-secret');
  for (const call of tool.calls) {
    assert.ok(!call.args.some((arg) => arg.includes('refresh-token-secret')), 'secret never in argv');
  }
});

test('Linux Secret Service lookup strips one trailing newline and errors carry only stderr', async () => {
  const withNewline = createSecretServiceValueStorage({ run: async () => ({ code: 0, stdout: 'abc\n', stderr: '' }) });
  assert.equal(await withNewline.get(), 'abc');

  const locked = createSecretServiceValueStorage({
    run: async () => ({ code: 1, stdout: 'leaked-secret', stderr: 'Cannot autolaunch D-Bus without X11 $DISPLAY' })
  });
  await assert.rejects(locked.get(), (error) => {
    assert.match(error.message, /secret-tool lookup failed with exit code 1: Cannot autolaunch D-Bus/);
    assert.match(error.message, /libsecret-tools/);
    assert.doesNotMatch(error.message, /leaked-secret/);
    return true;
  });

  const failingStore = createSecretServiceValueStorage({ run: async () => ({ code: 1, stdout: '', stderr: 'No such interface' }) });
  await assert.rejects(failingStore.set('x'), /secret-tool store failed/);
});

test('a missing secret-tool binary reports the install hint', async () => {
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn secret-tool ENOENT'), { code: 'ENOENT' })));
    return child;
  };
  await assert.rejects(runSecretTool(['lookup', 'service', 's'], { spawnFn }), (error) => {
    assert.equal(error.code, 'SECRET_TOOL_MISSING');
    assert.match(error.message, /secret-tool was not found.*sudo apt install libsecret-tools/);
    return true;
  });
});

test('secret-tool runner writes the value to stdin and collects stdout', async () => {
  let spawned;
  let stdinText = '';
  const spawnFn = (command, args, options) => {
    spawned = { command, args, options };
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.on('data', (chunk) => { stdinText += chunk; });
    child.stdin.on('finish', () => {
      child.stdout.end('done');
      child.stderr.end();
      setImmediate(() => child.emit('close', 0, null));
    });
    return child;
  };
  const result = await runSecretTool(['store', 'service', 's'], { input: 'top-secret', spawnFn });
  assert.equal(spawned.command, 'secret-tool');
  assert.deepEqual(spawned.args, ['store', 'service', 's']);
  assert.equal(spawned.options.stdio[0], 'pipe');
  assert.equal(stdinText, 'top-secret');
  assert.deepEqual(result, { code: 0, stdout: 'done', stderr: '' });
});

test('platform credential storage on Linux uses secret-tool with separate accounts and no legacy lookup', async () => {
  const tool = fakeSecretTool();
  const token = createCredentialTokenStorage({ platform: 'linux', run: tool.run });
  const email = createCredentialEmailStorage({ platform: 'linux', run: tool.run });
  await token.set('session');
  await email.set('me@example.com');
  assert.equal(await token.get(), 'session');
  assert.equal(await email.get(), 'me@example.com');
  assert.deepEqual([...tool.store.keys()].sort(), [
    'service|logwork-cli|account|resourceoptimiser',
    'service|logwork-cli|account|resourceoptimiser-email'
  ]);

  const empty = fakeSecretTool();
  assert.equal(await createCredentialTokenStorage({ platform: 'linux', run: empty.run }).get(), null);
  assert.ok(!empty.calls.some((call) => call.args.includes('logwork-helper')), 'Linux never had logwork-helper entries');
});

test('Linux notifications go through notify-send with plain arguments', async () => {
  const routed = [];
  await sendOsNotification({
    title: 'Logwork',
    message: 'RO: 6/8h',
    platform: 'linux',
    linuxNotifier: async (value) => { routed.push(value); }
  });
  assert.deepEqual(routed, [{ title: 'Logwork', message: 'RO: 6/8h' }]);

  let call;
  await sendLinuxNotification({ title: 'Logwork', message: 'RO: 6/8h\nHôm nay 2 commit:' }, {
    env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
    run: async (args, options) => { call = { args, options }; return { code: 0, stderr: '' }; }
  });
  assert.deepEqual(call.args, ['--app-name=Logwork', 'Logwork', 'RO: 6/8h\nHôm nay 2 commit:']);
  assert.equal(call.options.env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/1000/bus');

  await assert.rejects(
    sendLinuxNotification({ title: 'Logwork', message: 'x' }, { env: {}, run: async () => ({ code: 1, stderr: 'no server' }) }),
    /notify-send failed with exit code 1: no server.*libnotify-bin/
  );
  await assert.rejects(
    sendOsNotification({ title: 'Logwork', message: 'x', platform: 'aix' }),
    /unsupported on aix.*macOS, Windows and Linux/
  );
});

test('Linux notification env falls back to the per-user D-Bus socket', () => {
  const exists = (path) => path === '/run/user/1000/bus';
  assert.equal(
    linuxNotificationEnv({ XDG_RUNTIME_DIR: '/run/user/1000' }, { exists }).DBUS_SESSION_BUS_ADDRESS,
    'unix:path=/run/user/1000/bus'
  );
  const set = { XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/custom' };
  assert.equal(linuxNotificationEnv(set, { exists }), set);
  assert.equal(linuxNotificationEnv({ XDG_RUNTIME_DIR: '/run/user/2000' }, { exists }).DBUS_SESSION_BUS_ADDRESS, undefined);
});

test('a missing notify-send binary reports the install hint', async () => {
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn notify-send ENOENT'), { code: 'ENOENT' })));
    return child;
  };
  await assert.rejects(runNotifySend(['x'], { spawnFn }), /notify-send was not found.*libnotify-bin/);
});

test('Linux reminder units: weekday OnCalendar, oneshot service running the launcher', () => {
  const timer = buildLinuxReminderTimer({ config: CONFIG });
  assert.match(timer, /^OnCalendar=Mon,Tue,Wed,Thu,Fri \*-\*-\* 17:30:00$/m);
  assert.match(timer, /^Unit=logwork-cli-reminder\.service$/m);
  assert.match(timer, /^WantedBy=timers\.target$/m);
  assert.match(buildLinuxReminderTimer({ config: { ...CONFIG, days: [1, 3, 5] } }), /^OnCalendar=Mon,Wed,Fri /m);

  const service = buildLinuxReminderService({ launch: LAUNCH, home: HOME });
  assert.match(service, /^Type=oneshot$/m);
  assert.match(service, /^WorkingDirectory=\/home\/u\/\.logwork-cli$/m);
  assert.match(service, /^ExecStart="\/home\/u\/\.logwork-cli\/bin\/logwork-launch" "reminder" "run" "--home" "\/home\/u\/\.logwork-cli"$/m);
  assert.equal(parseLinuxServiceNodePath(service), LAUNCH.command);
});

test('Linux reminder service escapes systemd specifiers and variables, and rejects backslashes', () => {
  const home = '/home/u/My 100% $HOME dir';
  const service = buildLinuxReminderService({ launch: { command: `${home}/bin/logwork-launch`, argsPrefix: [] }, home });
  assert.match(service, /^WorkingDirectory=\/home\/u\/My 100%% \$HOME dir$/m);
  // $ is expanded only in arguments, so the executable path keeps a single $.
  assert.ok(service.includes('ExecStart="/home/u/My 100%% $HOME dir/bin/logwork-launch" "reminder" "run" "--home" "/home/u/My 100%% $$HOME dir"'));
  assert.equal(parseLinuxServiceNodePath(service), `${home}/bin/logwork-launch`);
  assert.equal(parseLinuxServiceNodePath('ExecStart=/usr/bin/node /x/logwork.mjs reminder run'), '/usr/bin/node');
  assert.equal(parseLinuxServiceNodePath('[Service]\n'), null);
  assert.throws(() => buildLinuxReminderService({ launch: { command: '/a"b', argsPrefix: [] }, home: HOME }), /unsupported characters/);
  // systemd refuses an executable path with a backslash.
  assert.throws(() => buildLinuxReminderService({ launch: LAUNCH, home: '/home/u/a\\b' }), /unsupported characters/);
});

test('Linux reminder unit paths follow XDG_CONFIG_HOME', () => {
  assert.equal(linuxReminderUnitPaths({ userHome: '/home/u', env: {} }).timer, '/home/u/.config/systemd/user/logwork-cli-reminder.timer');
  assert.equal(linuxReminderUnitPaths({ userHome: '/home/u', env: { XDG_CONFIG_HOME: '/cfg' } }).service, '/cfg/systemd/user/logwork-cli-reminder.service');
  assert.equal(linuxReminderUnitPaths({ userHome: '/home/u', env: { XDG_CONFIG_HOME: 'relative' } }).dir, '/home/u/.config/systemd/user');
});

test('Linux reminder install writes both units, reloads and enables the timer', async () => {
  const written = {};
  const calls = [];
  const result = await installReminderScheduler(CONFIG, {
    platform: 'linux',
    home: HOME,
    env: {},
    launch: LAUNCH,
    userHome: '/home/u',
    uid: 1000,
    accessRunner: async () => {},
    writeLauncherFn: async () => {},
    writeFile: async (path, content) => { written[path] = content; },
    run: async (command, args) => { calls.push([command, ...args].join(' ')); return { code: 0, stdout: '', stderr: '' }; }
  });
  assert.deepEqual(Object.keys(written).sort(), [
    '/home/u/.config/systemd/user/logwork-cli-reminder.service',
    '/home/u/.config/systemd/user/logwork-cli-reminder.timer'
  ]);
  assert.deepEqual(calls, [
    'systemctl --user daemon-reload',
    'systemctl --user enable --now logwork-cli-reminder.timer'
  ]);
  assert.equal(result.scheduler, 'systemd user timer');
  assert.equal(result.identifier, 'logwork-cli-reminder.timer');
  assert.equal(result.installed, true);
});

test('Linux reminder install without a user systemd explains the cron alternative', async () => {
  const options = {
    platform: 'linux',
    home: HOME,
    env: {},
    launch: LAUNCH,
    userHome: '/home/u',
    uid: 1000,
    accessRunner: async () => {},
    writeLauncherFn: async () => {},
    writeFile: async () => {}
  };
  await assert.rejects(
    installReminderScheduler(CONFIG, {
      ...options,
      run: async () => ({ code: 1, stdout: '', stderr: 'Failed to connect to bus: No medium found' })
    }),
    (error) => {
      assert.match(error.message, /systemctl --user daemon-reload failed with exit code 1: Failed to connect to bus/);
      assert.match(error.message, /needs a systemd user session/);
      assert.match(error.message, /30 17 \* \* 1,2,3,4,5 '\/home\/u\/\.logwork-cli\/bin\/logwork-launch' 'reminder' 'run' '--home'/);
      return true;
    }
  );
  await assert.rejects(
    installReminderScheduler(CONFIG, {
      ...options,
      run: async () => { throw Object.assign(new Error('spawn systemctl ENOENT'), { code: 'ENOENT' }); }
    }),
    /exit code 127: systemctl was not found/
  );
  assert.equal(
    buildLinuxCronLine({ config: { ...CONFIG, time: '09:05', days: [1, 5] }, launch: { command: "/it's/launch", argsPrefix: [] }, home: '/h' }),
    "5 9 * * 1,5 '/it'\\''s/launch' 'reminder' 'run' '--home' '/h'"
  );
});

test('Linux reminder status, node path and removal', async () => {
  const service = buildLinuxReminderService({ launch: LAUNCH, home: HOME });
  const calls = [];
  const run = async (command, args) => {
    calls.push(args.join(' '));
    return { code: 0, stdout: 'enabled\n', stderr: '' };
  };
  const status = await getReminderSchedulerStatus({
    platform: 'linux',
    env: {},
    userHome: '/home/u',
    run,
    accessFile: async () => {},
    readFile: async (path) => {
      assert.equal(path, '/home/u/.config/systemd/user/logwork-cli-reminder.service');
      return service;
    }
  });
  assert.equal(status.installed, true);
  assert.equal(status.nodePath, LAUNCH.command);
  assert.ok(calls.includes('--user is-enabled logwork-cli-reminder.timer'));

  const missing = await getReminderSchedulerStatus({
    platform: 'linux',
    env: {},
    userHome: '/home/u',
    run: async () => { throw new Error('must not run'); },
    accessFile: async () => { throw new Error('ENOENT'); }
  });
  assert.equal(missing.installed, false);
  assert.equal(missing.nodePath, null);

  assert.equal(await readReminderSchedulerNodePath({
    platform: 'linux',
    env: {},
    userHome: '/home/u',
    readFile: async () => { throw new Error('ENOENT'); }
  }), null);

  const removed = [];
  const removeCalls = [];
  const result = await removeReminderScheduler({
    platform: 'linux',
    env: {},
    userHome: '/home/u',
    uid: 1000,
    run: async (command, args) => { removeCalls.push(args.join(' ')); return { code: 1, stdout: '', stderr: 'not loaded' }; },
    removeFile: async (path) => { removed.push(path); }
  });
  assert.equal(result.installed, false);
  assert.deepEqual(removeCalls, ['--user disable --now logwork-cli-reminder.timer', '--user daemon-reload']);
  assert.deepEqual(removed, [
    '/home/u/.config/systemd/user/logwork-cli-reminder.timer',
    '/home/u/.config/systemd/user/logwork-cli-reminder.service'
  ]);
});

// Real libsecret round trip. CI runs it on Linux inside a D-Bus session with an
// unlocked GNOME Keyring (npm run test:linux-credential).
test('Linux Secret Service stores, reads, and deletes a test credential', {
  skip: process.platform !== 'linux' || process.env.TEST_LINUX_SECRET_SERVICE !== '1'
    ? 'Secret Service integration test only runs on Linux with TEST_LINUX_SECRET_SERVICE=1.'
    : false
}, async () => {
  const storage = createSecretServiceValueStorage({
    service: `logwork-cli-test-${Date.now()}-${process.pid}`,
    account: 'resourceoptimiser-test'
  });
  const secret = `session-${Date.now()} with spaces and ünicode`;
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
