import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, posix } from 'node:path';
import { atomicWriteFile } from './atomic-file.mjs';
import { resolveLaunchCommand, writeLauncher } from './launcher.mjs';
import { helperHome } from './paths.mjs';
import { normalizeReminderConfig } from './reminder-config.mjs';

export const MACOS_REMINDER_LABEL = 'sg.vinova.logwork-cli.reminder';
export const WINDOWS_REMINDER_TASK_NAME = 'Logwork Reminder';
// Linux: a systemd user timer plus the oneshot service it starts.
export const LINUX_REMINDER_UNIT = 'logwork-cli-reminder';
const LINUX_TIMER = `${LINUX_REMINDER_UNIT}.timer`;
const LINUX_SYSTEMD_DAYS = Object.freeze({ 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri' });
// Scheduler names used before the logwork-helper -> logwork-cli rename. They
// point at the old runtime, so installing or removing the reminder clears them.
export const LEGACY_MACOS_REMINDER_LABEL = 'sg.vinova.logwork-helper.reminder';
export const LEGACY_WINDOWS_REMINDER_TASK_NAME = 'Logwork Helper Reminder';
// The scheduler runs the launch command from lib/launcher.mjs with
// `reminder run --home <home>`: on macOS and Linux the <home>/bin/logwork-launch script
// (it finds Node itself), on Windows a stable node.exe plus
// <home>\bin\logwork.mjs.
export const REMINDER_RUNNER_RELATIVE_PATH = join('bin', 'logwork.mjs');

export async function installReminderScheduler(config, {
  platform = process.platform,
  nodePath = process.execPath,
  home = helperHome(),
  env = process.env,
  launch = resolveLaunchCommand({ platform, home, execPath: nodePath, env }),
  userHome = homedir(),
  uid = userInfo().uid,
  run = runCommand,
  writeFile = atomicWriteFile,
  accessRunner = fs.access,
  writeLauncherFn = writeLauncher
} = {}) {
  const normalized = normalizeReminderConfig({ ...config, enabled: true });
  const runnerPath = join(home, REMINDER_RUNNER_RELATIVE_PATH);
  try {
    await accessRunner(runnerPath);
  } catch {
    throw new Error(`Reminder runtime is missing at ${runnerPath}. Run \`logwork setup --no-login\` and retry.`);
  }
  if (launch.kind === 'launcher') {
    // `reminder enable` can run before `logwork setup` wrote the launcher.
    await writeLauncherFn({ home, nodePath, platform });
  }
  await removeLegacyReminderScheduler({ platform, userHome, uid, run });

  if (platform === 'darwin') {
    const plistPath = macosReminderPlistPath(userHome);
    await writeFile(plistPath, buildMacosReminderPlist({
      config: normalized,
      launch,
      home
    }));
    const domain = `gui/${uid}`;
    await run('/bin/launchctl', ['bootout', domain, plistPath]);
    const loaded = await run('/bin/launchctl', ['bootstrap', domain, plistPath]);
    assertCommandSuccess(loaded, 'launchctl bootstrap');
    return {
      platform,
      installed: true,
      scheduler: 'launchd',
      identifier: MACOS_REMINDER_LABEL,
      path: plistPath
    };
  }

  if (platform === 'win32') {
    const result = await run('schtasks.exe', buildWindowsReminderCreateArgs({
      config: normalized,
      launch,
      home
    }));
    assertCommandSuccess(result, 'schtasks /Create');
    return {
      platform,
      installed: true,
      scheduler: 'Task Scheduler',
      identifier: WINDOWS_REMINDER_TASK_NAME,
      path: null
    };
  }

  if (platform === 'linux') {
    const paths = linuxReminderUnitPaths({ userHome, env });
    await writeFile(paths.service, buildLinuxReminderService({ launch, home }));
    await writeFile(paths.timer, buildLinuxReminderTimer({ config: normalized }));
    const hint = { launch, home, config: normalized };
    assertSystemctl(await runSystemctl(run, ['daemon-reload']), 'systemctl --user daemon-reload', hint);
    assertSystemctl(await runSystemctl(run, ['enable', '--now', LINUX_TIMER]), `systemctl --user enable --now ${LINUX_TIMER}`, hint);
    return {
      platform,
      installed: true,
      scheduler: 'systemd user timer',
      identifier: LINUX_TIMER,
      path: paths.timer
    };
  }

  throw unsupportedReminderPlatform(platform);
}

export async function removeReminderScheduler({
  platform = process.platform,
  env = process.env,
  userHome = homedir(),
  uid = userInfo().uid,
  run = runCommand,
  removeFile = fs.rm
} = {}) {
  await removeLegacyReminderScheduler({ platform, userHome, uid, run, removeFile });
  if (platform === 'darwin') {
    const plistPath = macosReminderPlistPath(userHome);
    await run('/bin/launchctl', ['bootout', `gui/${uid}`, plistPath]);
    await removeFile(plistPath, { force: true });
    return {
      platform,
      installed: false,
      scheduler: 'launchd',
      identifier: MACOS_REMINDER_LABEL,
      path: plistPath
    };
  }

  if (platform === 'win32') {
    const existing = await run('schtasks.exe', ['/Query', '/TN', WINDOWS_REMINDER_TASK_NAME]);
    if (existing.code === 0) {
      const deleted = await run('schtasks.exe', ['/Delete', '/TN', WINDOWS_REMINDER_TASK_NAME, '/F']);
      assertCommandSuccess(deleted, 'schtasks /Delete');
    }
    return {
      platform,
      installed: false,
      scheduler: 'Task Scheduler',
      identifier: WINDOWS_REMINDER_TASK_NAME,
      path: null
    };
  }

  if (platform === 'linux') {
    const paths = linuxReminderUnitPaths({ userHome, env });
    // Best effort: without a user systemd there is nothing loaded to stop.
    await runSystemctl(run, ['disable', '--now', LINUX_TIMER]);
    await removeFile(paths.timer, { force: true });
    await removeFile(paths.service, { force: true });
    await runSystemctl(run, ['daemon-reload']);
    return {
      platform,
      installed: false,
      scheduler: 'systemd user timer',
      identifier: LINUX_TIMER,
      path: paths.timer
    };
  }

  throw unsupportedReminderPlatform(platform);
}

export async function getReminderSchedulerStatus({
  platform = process.platform,
  env = process.env,
  userHome = homedir(),
  uid = userInfo().uid,
  run = runCommand,
  accessFile = fs.access,
  readFile = fs.readFile
} = {}) {
  if (platform === 'darwin') {
    const plistPath = macosReminderPlistPath(userHome);
    const fileExists = await accessFile(plistPath).then(() => true).catch(() => false);
    const result = await run('/bin/launchctl', ['print', `gui/${uid}/${MACOS_REMINDER_LABEL}`]);
    return {
      platform,
      installed: fileExists && result.code === 0,
      scheduler: 'launchd',
      identifier: MACOS_REMINDER_LABEL,
      path: plistPath,
      nodePath: fileExists ? await readReminderSchedulerNodePath({ platform, userHome, run, readFile }) : null
    };
  }

  if (platform === 'win32') {
    const result = await run('schtasks.exe', ['/Query', '/TN', WINDOWS_REMINDER_TASK_NAME, '/FO', 'LIST']);
    return {
      platform,
      installed: result.code === 0,
      scheduler: 'Task Scheduler',
      identifier: WINDOWS_REMINDER_TASK_NAME,
      path: null,
      nodePath: result.code === 0 ? await readReminderSchedulerNodePath({ platform, userHome, run, readFile }) : null
    };
  }

  if (platform === 'linux') {
    const paths = linuxReminderUnitPaths({ userHome, env });
    const fileExists = await accessFile(paths.timer).then(() => true).catch(() => false);
    const enabled = fileExists ? await runSystemctl(run, ['is-enabled', LINUX_TIMER]) : { code: 1 };
    return {
      platform,
      installed: fileExists && enabled.code === 0,
      scheduler: 'systemd user timer',
      identifier: LINUX_TIMER,
      path: paths.timer,
      nodePath: fileExists ? await readReminderSchedulerNodePath({ platform, env, userHome, run, readFile }) : null
    };
  }

  throw unsupportedReminderPlatform(platform);
}

// The command the installed schedule runs: the first ProgramArguments entry of
// the launchd plist (the launcher, or a raw node path from an older install),
// or the <Command> of the Windows task (node.exe). Returns null when no
// schedule is installed or it cannot be read. Read-only.
export async function readReminderSchedulerNodePath({
  platform = process.platform,
  env = process.env,
  userHome = homedir(),
  run = runCommand,
  readFile = fs.readFile
} = {}) {
  try {
    if (platform === 'darwin') {
      const plist = await readFile(macosReminderPlistPath(userHome), 'utf8');
      return parseMacosPlistNodePath(plist);
    }
    if (platform === 'win32') {
      const result = await run('schtasks.exe', ['/Query', '/TN', WINDOWS_REMINDER_TASK_NAME, '/XML']);
      return result.code === 0 ? parseWindowsTaskNodePath(result.stdout) : null;
    }
    if (platform === 'linux') {
      const unit = await readFile(linuxReminderUnitPaths({ userHome, env }).service, 'utf8');
      return parseLinuxServiceNodePath(unit);
    }
  } catch {
    // Missing or unreadable schedule: nothing to compare.
  }
  return null;
}

export function parseMacosPlistNodePath(plist) {
  const match = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(String(plist || ''));
  return match ? unescapeXml(match[1]).trim() || null : null;
}

export function parseWindowsTaskNodePath(xml) {
  // schtasks may write the XML as UTF-16; decoded as UTF-8 that leaves NULs.
  const match = /<Command>([^<]*)<\/Command>/i.exec(String(xml || '').replaceAll('\0', ''));
  if (!match) {
    return null;
  }
  // schtasks keeps the quotes /TR put around a path with spaces.
  return unescapeXml(match[1]).trim().replace(/^"(.*)"$/, '$1') || null;
}

// `launch` is { command, argsPrefix }. Older callers pass nodePath + runnerPath.
function scheduleProgram({ launch, nodePath, runnerPath, home }) {
  const program = launch
    ? [launch.command, ...(launch.argsPrefix || [])]
    : [nodePath, runnerPath];
  return [...program, 'reminder', 'run', '--home', home];
}

export function buildMacosReminderPlist({ config, launch, nodePath, runnerPath, home }) {
  const normalized = normalizeReminderConfig({ ...config, enabled: true });
  const [hour, minute] = normalized.time.split(':').map(Number);
  const calendarEntries = normalized.days.map((weekday) => `    <dict>
      <key>Weekday</key><integer>${weekday}</integer>
      <key>Hour</key><integer>${hour}</integer>
      <key>Minute</key><integer>${minute}</integer>
    </dict>`).join('\n');
  const programArguments = scheduleProgram({ launch, nodePath, runnerPath, home })
    .map((part) => `    <string>${escapeXml(assertSafePath(part))}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escapeXml(MACOS_REMINDER_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(assertSafePath(home))}</string>
  <key>StartCalendarInterval</key>
  <array>
${calendarEntries}
  </array>
  <key>ProcessType</key><string>Background</string>
  <key>ThrottleInterval</key><integer>60</integer>
</dict>
</plist>
`;
}

export function buildWindowsReminderCreateArgs({ config, launch, nodePath, runnerPath, home }) {
  const normalized = normalizeReminderConfig({ ...config, enabled: true });
  const action = scheduleProgram({ launch, nodePath, runnerPath, home })
    .map(quoteWindowsActionPart)
    .join(' ');
  const dayNames = normalized.days.map((day) => ({
    1: 'MON',
    2: 'TUE',
    3: 'WED',
    4: 'THU',
    5: 'FRI'
  })[day]).join(',');

  return [
    '/Create',
    '/TN', WINDOWS_REMINDER_TASK_NAME,
    '/TR', action,
    '/SC', 'WEEKLY',
    '/D', dayNames,
    '/ST', normalized.time,
    '/IT',
    '/RL', 'LIMITED',
    '/F'
  ];
}

// systemd reads user units from $XDG_CONFIG_HOME/systemd/user (default
// ~/.config/systemd/user).
export function linuxReminderUnitPaths({ userHome = homedir(), env = process.env } = {}) {
  const configHome = env.XDG_CONFIG_HOME && posix.isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME
    : posix.join(userHome, '.config');
  const dir = posix.join(configHome, 'systemd', 'user');
  return {
    dir,
    service: posix.join(dir, `${LINUX_REMINDER_UNIT}.service`),
    timer: posix.join(dir, LINUX_TIMER)
  };
}

export function buildLinuxReminderService({ launch, nodePath, runnerPath, home }) {
  const execStart = scheduleProgram({ launch, nodePath, runnerPath, home })
    .map((part, index) => quoteSystemdArg(part, { executable: index === 0 }))
    .join(' ');
  return `# Generated by logwork-cli (\`logwork reminder enable\`); do not edit.
[Unit]
Description=Logwork reminder (logwork-cli)

[Service]
Type=oneshot
WorkingDirectory=${escapeSystemdSpecifiers(assertSafeSystemdPath(home))}
ExecStart=${execStart}
`;
}

// One OnCalendar line for all configured weekdays, e.g.
// "Mon,Tue,Wed,Thu,Fri *-*-* 17:00:00". A run missed while the machine was
// suspended fires on resume; one missed while it was off is skipped.
export function buildLinuxReminderTimer({ config }) {
  const normalized = normalizeReminderConfig({ ...config, enabled: true });
  const days = normalized.days.map((day) => LINUX_SYSTEMD_DAYS[day]).join(',');
  return `# Generated by logwork-cli (\`logwork reminder enable\`); do not edit.
[Unit]
Description=Logwork reminder schedule (logwork-cli)

[Timer]
OnCalendar=${days} *-*-* ${normalized.time}:00
AccuracySec=1min
Unit=${LINUX_REMINDER_UNIT}.service

[Install]
WantedBy=timers.target
`;
}

// The first ExecStart word of the service unit: the launcher (or node).
export function parseLinuxServiceNodePath(unit) {
  const match = /^ExecStart=\s*(?:"((?:[^"\\]|\\.)*)"|(\S+))/m.exec(String(unit || ''));
  if (!match) {
    return null;
  }
  const raw = match[1] !== undefined ? match[1].replace(/\\(.)/g, '$1') : match[2];
  return raw.replaceAll('%%', '%').trim() || null;
}

// ExecStart expands % specifiers everywhere and $ variables only in the
// arguments, not in the executable path.
function quoteSystemdArg(value, { executable = false } = {}) {
  const escaped = escapeSystemdSpecifiers(assertSafeSystemdPath(value));
  return `"${executable ? escaped : escaped.replaceAll('$', '$$$$')}"`;
}

// systemd refuses an executable path with a backslash ("special characters"),
// so reject it here rather than write a unit that never starts.
function assertSafeSystemdPath(value) {
  const path = assertSafePath(value);
  if (path.includes('\\')) {
    throw new Error('Reminder scheduler path contains unsupported characters.');
  }
  return path;
}

// WorkingDirectory= expands only % specifiers.
function escapeSystemdSpecifiers(value) {
  return String(value).replaceAll('%', '%%');
}

function runSystemctl(run, args) {
  return run('systemctl', ['--user', ...args]).catch((error) => ({
    code: 127,
    stdout: '',
    stderr: error?.code === 'ENOENT' ? 'systemctl was not found' : String(error?.message || error)
  }));
}

// Without a user systemd (WSL without systemd, containers, non-systemd
// distros) explain the cron alternative instead of a bare bus error.
function assertSystemctl(result, command, { launch, home, config }) {
  if (result.code === 0) {
    return;
  }
  throw new Error(`${command} failed with exit code ${result.code}: ${String(result.stderr || result.stdout || 'no output').trim()}. The Linux reminder needs a systemd user session. Without one, add this line with \`crontab -e\` instead: ${buildLinuxCronLine({ config, launch, home })}`);
}

// The cron equivalent of the timer, shown when systemd is unavailable.
export function buildLinuxCronLine({ config, launch, home }) {
  const normalized = normalizeReminderConfig({ ...config, enabled: true });
  const [hour, minute] = normalized.time.split(':').map(Number);
  const program = scheduleProgram({ launch, home })
    .map((part) => `'${String(part).replaceAll("'", "'\\''")}'`)
    .join(' ');
  return `${minute} ${hour} * * ${normalized.days.join(',')} ${program}`;
}

export function macosReminderPlistPath(userHome = homedir(), label = MACOS_REMINDER_LABEL) {
  return join(userHome, 'Library', 'LaunchAgents', `${label}.plist`);
}

export async function removeLegacyReminderScheduler({
  platform = process.platform,
  userHome = homedir(),
  uid = userInfo().uid,
  run = runCommand,
  removeFile = fs.rm
} = {}) {
  try {
    if (platform === 'darwin') {
      const plistPath = macosReminderPlistPath(userHome, LEGACY_MACOS_REMINDER_LABEL);
      const exists = await fs.access(plistPath).then(() => true).catch(() => false);
      if (!exists) {
        return false;
      }
      await run('/bin/launchctl', ['bootout', `gui/${uid}`, plistPath]);
      await removeFile(plistPath, { force: true });
      return true;
    }
    if (platform === 'win32') {
      const existing = await run('schtasks.exe', ['/Query', '/TN', LEGACY_WINDOWS_REMINDER_TASK_NAME]);
      if (existing.code !== 0) {
        return false;
      }
      await run('schtasks.exe', ['/Delete', '/TN', LEGACY_WINDOWS_REMINDER_TASK_NAME, '/F']);
      return true;
    }
  } catch {
    // Best effort: a leftover legacy schedule only fires the old runtime.
  }
  return false;
}

export function runCommand(command, args) {
  return new Promise((resolveValue, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolveValue({
        code: signal ? 1 : (code ?? 1),
        stdout,
        stderr
      });
    });
  });
}

function assertCommandSuccess(result, command) {
  if (result.code !== 0) {
    throw new Error(`${command} failed with exit code ${result.code}: ${String(result.stderr || result.stdout || 'no output').trim()}`);
  }
}

function quoteWindowsActionPart(value) {
  const path = assertSafePath(value);
  return /[\s&()^%!,;]/.test(path) ? `"${path}"` : path;
}

function assertSafePath(value) {
  const path = String(value || '');
  if (!path || /[\r\n"<>|]/.test(path)) {
    throw new Error('Reminder scheduler path contains unsupported characters.');
  }
  return path;
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function unescapeXml(value) {
  return String(value)
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function unsupportedReminderPlatform(platform) {
  return new Error(`Reminder scheduling is unsupported on ${platform}. Supported platforms are macOS, Windows and Linux.`);
}
