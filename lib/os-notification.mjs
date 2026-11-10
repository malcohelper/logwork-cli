import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runOsascript } from './macos.mjs';

export async function sendOsNotification({
  title = 'Logwork',
  message,
  platform = process.platform,
  macNotifier = sendMacosNotification,
  windowsNotifier = sendWindowsNotification,
  linuxNotifier = sendLinuxNotification
} = {}) {
  const notification = normalizeNotification({ title, message });
  if (platform === 'darwin') {
    await macNotifier(notification);
  } else if (platform === 'win32') {
    await windowsNotifier(notification);
  } else if (platform === 'linux') {
    await linuxNotifier(notification);
  } else {
    throw new Error(`OS notifications are unsupported on ${platform}. Supported platforms are macOS, Windows and Linux.`);
  }

  return {
    status: 'sent',
    platform,
    title: notification.title,
    message: notification.message
  };
}

export async function sendMacosNotification({ title, message }, {
  run = runOsascript
} = {}) {
  const script = String.raw`
on run argv
  display notification (item 2 of argv) with title (item 1 of argv)
end run`;
  await run(script, [title, message]);
}

export async function sendWindowsNotification({ title, message }, {
  run = runPowerShellToast
} = {}) {
  await run({ title, message });
}

export function runPowerShellToast(notification, {
  command = 'powershell.exe',
  spawnFn = spawn
} = {}) {
  return new Promise((resolveValue, reject) => {
    const child = spawnFn(command, [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command', WINDOWS_TOAST_SCRIPT
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Windows notification failed with exit code ${code}: ${stderr.trim() || 'no stderr'}`));
        return;
      }
      resolveValue(stdout.trim());
    });
    child.stdin.end(JSON.stringify(notification));
  });
}

export const LINUX_NOTIFY_HINT = 'Linux notifications need `notify-send` (libnotify) and a desktop session. Install it with `sudo apt install libnotify-bin` (Debian/Ubuntu) or `sudo dnf install libnotify` (Fedora).';

// Linux desktop notification with libnotify's notify-send. Title and message
// are plain text arguments (never credentials).
export async function sendLinuxNotification({ title, message }, {
  run = runNotifySend,
  env = process.env
} = {}) {
  const result = await run(['--app-name=Logwork', title, message], { env: linuxNotificationEnv(env) });
  if (result.code !== 0) {
    throw new Error(`notify-send failed with exit code ${result.code}: ${String(result.stderr || '').trim() || 'no stderr'}. ${LINUX_NOTIFY_HINT}`);
  }
}

// A systemd user service normally has DBUS_SESSION_BUS_ADDRESS. When it does
// not (some distros, cron), point it at the standard per-user bus socket.
export function linuxNotificationEnv(env = process.env, { exists = existsSync } = {}) {
  if (env.DBUS_SESSION_BUS_ADDRESS || !env.XDG_RUNTIME_DIR) {
    return env;
  }
  const socket = join(env.XDG_RUNTIME_DIR, 'bus');
  return exists(socket) ? { ...env, DBUS_SESSION_BUS_ADDRESS: `unix:path=${socket}` } : env;
}

export function runNotifySend(args, {
  env = process.env,
  command = 'notify-send',
  spawnFn = spawn
} = {}) {
  return new Promise((resolveValue, reject) => {
    const child = spawnFn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let stderr = '';
    child.stdout.resume();
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      reject(error?.code === 'ENOENT' ? new Error(`notify-send was not found. ${LINUX_NOTIFY_HINT}`) : error);
    });
    child.on('close', (code, signal) => {
      resolveValue({ code: signal ? 1 : (code ?? 1), stderr });
    });
  });
}

function normalizeNotification({ title, message }) {
  const normalizedTitle = String(title || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 100);
  const normalizedMessage = String(message || '').trim().slice(0, 1_000);
  if (!normalizedTitle || !normalizedMessage) {
    throw new Error('Notification title and message are required.');
  }
  return {
    title: normalizedTitle,
    message: normalizedMessage
  };
}

const WINDOWS_TOAST_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null

$template = [Windows.UI.Notifications.ToastTemplateType]::ToastText02
$toastXml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent($template)
$textNodes = $toastXml.GetElementsByTagName('text')
$textNodes.Item(0).AppendChild($toastXml.CreateTextNode([string]$request.title)) | Out-Null
$textNodes.Item(1).AppendChild($toastXml.CreateTextNode([string]$request.message)) | Out-Null
$toast = [Windows.UI.Notifications.ToastNotification]::new($toastXml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('PowerShell').Show($toast)
@{ ok = $true } | ConvertTo-Json -Compress
`;
