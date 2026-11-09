import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFile } from './atomic-file.mjs';
import { helperHome } from './paths.mjs';
import { normalizeReminderConfig } from './reminder-config.mjs';

export const MACOS_REMINDER_LABEL = 'sg.vinova.logwork-cli.reminder';
export const WINDOWS_REMINDER_TASK_NAME = 'Logwork Reminder';
// Scheduler names used before the logwork-helper -> logwork-cli rename. They
// point at the old runtime, so installing or removing the reminder clears them.
export const LEGACY_MACOS_REMINDER_LABEL = 'sg.vinova.logwork-helper.reminder';
export const LEGACY_WINDOWS_REMINDER_TASK_NAME = 'Logwork Helper Reminder';
// The scheduler runs `node <home>/bin/logwork.mjs reminder run --home <home>`.
export const REMINDER_RUNNER_RELATIVE_PATH = join('bin', 'logwork.mjs');

export async function installReminderScheduler(config, {
  platform = process.platform,
  nodePath = process.execPath,
  home = helperHome(),
  userHome = homedir(),
  uid = userInfo().uid,
  run = runCommand,
  writeFile = atomicWriteFile,
  accessRunner = fs.access
} = {}) {
  const normalized = normalizeReminderConfig({ ...config, enabled: true });
  const runnerPath = join(home, REMINDER_RUNNER_RELATIVE_PATH);
  try {
    await accessRunner(runnerPath);
  } catch {
    throw new Error(`Reminder runtime is missing at ${runnerPath}. Run \`logwork setup --no-login\` and retry.`);
  }
  await removeLegacyReminderScheduler({ platform, userHome, uid, run });

  if (platform === 'darwin') {
    const plistPath = macosReminderPlistPath(userHome);
    await writeFile(plistPath, buildMacosReminderPlist({
      config: normalized,
      nodePath,
      runnerPath,
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
      nodePath,
      runnerPath,
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

  throw unsupportedReminderPlatform(platform);
}

export async function removeReminderScheduler({
  platform = process.platform,
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

  throw unsupportedReminderPlatform(platform);
}

export async function getReminderSchedulerStatus({
  platform = process.platform,
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

  throw unsupportedReminderPlatform(platform);
}

// The node binary the installed schedule runs: the first ProgramArguments
// entry of the launchd plist, or the <Command> of the Windows task. Returns
// null when no schedule is installed or it cannot be read. Read-only.
export async function readReminderSchedulerNodePath({
  platform = process.platform,
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

export function buildMacosReminderPlist({ config, nodePath, runnerPath, home }) {
  const normalized = normalizeReminderConfig({ ...config, enabled: true });
  const [hour, minute] = normalized.time.split(':').map(Number);
  const calendarEntries = normalized.days.map((weekday) => `    <dict>
      <key>Weekday</key><integer>${weekday}</integer>
      <key>Hour</key><integer>${hour}</integer>
      <key>Minute</key><integer>${minute}</integer>
    </dict>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escapeXml(MACOS_REMINDER_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(assertSafePath(nodePath))}</string>
    <string>${escapeXml(assertSafePath(runnerPath))}</string>
    <string>reminder</string>
    <string>run</string>
    <string>--home</string>
    <string>${escapeXml(assertSafePath(home))}</string>
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

export function buildWindowsReminderCreateArgs({ config, nodePath, runnerPath, home }) {
  const normalized = normalizeReminderConfig({ ...config, enabled: true });
  const action = [nodePath, runnerPath, 'reminder', 'run', '--home', home]
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
  return new Error(`Reminder scheduling is unsupported on ${platform}. Supported platforms are macOS and Windows.`);
}
