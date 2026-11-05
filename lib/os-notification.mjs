import { spawn } from 'node:child_process';
import { runOsascript } from './macos.mjs';

export async function sendOsNotification({
  title = 'Logwork Helper',
  message,
  platform = process.platform,
  macNotifier = sendMacosNotification,
  windowsNotifier = sendWindowsNotification
} = {}) {
  const notification = normalizeNotification({ title, message });
  if (platform === 'darwin') {
    await macNotifier(notification);
  } else if (platform === 'win32') {
    await windowsNotifier(notification);
  } else {
    throw new Error(`OS notifications are unsupported on ${platform}. Supported platforms are macOS and Windows.`);
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
