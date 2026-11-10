import { existsSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { posix } from 'node:path';

// Windows Subsystem for Linux. A WSL distro usually has no keyring, no
// notification server and no long-running systemd (the distro stops when no
// terminal is open), but it can run Windows programs through interop. So under
// WSL, logwork uses the Windows side: Credential Manager and toasts through
// powershell.exe, and a Task Scheduler task that starts the distro with wsl.exe.
//
// LOGWORK_WSL=0 turns this off (plain Linux behavior: secret-tool, systemd,
// notify-send), for a WSL setup that has its own keyring and systemd.

export const WSL_DISABLE_ENV = 'LOGWORK_WSL';

const SYSTEM32 = ['Windows', 'System32'];
export const WINDOWS_EXECUTABLES = Object.freeze({
  'powershell.exe': [...SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'],
  'schtasks.exe': [...SYSTEM32, 'schtasks.exe'],
  'wsl.exe': [...SYSTEM32, 'wsl.exe']
});

export function isWsl({
  platform = process.platform,
  env = process.env,
  readOsRelease = readKernelRelease
} = {}) {
  if (platform !== 'linux' || env[WSL_DISABLE_ENV] === '0') {
    return false;
  }
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) {
    return true;
  }
  return /microsoft/i.test(readOsRelease());
}

// The distro name Task Scheduler passes to `wsl.exe -d`.
export function wslDistroName({ env = process.env } = {}) {
  const name = String(env.WSL_DISTRO_NAME || '').trim();
  if (!name) {
    throw new Error('WSL_DISTRO_NAME is not set. Run this from a WSL shell (wsl.exe), not through sudo or a stripped environment.');
  }
  return name;
}

export function wslUserName({ env = process.env, info = userInfo } = {}) {
  return String(env.USER || info().username || '').trim();
}

// Path to a Windows program inside WSL: first on PATH (interop appends the
// Windows PATH by default), then under the C: drive mount. Returns the bare
// name when neither is found, so spawn reports a clear ENOENT.
export function windowsExecutable(name, {
  env = process.env,
  exists = existsSync,
  mountRoots = ['/mnt/', '/']
} = {}) {
  for (const entry of String(env.PATH || '').split(':').filter(Boolean)) {
    const candidate = posix.join(entry, name);
    if (exists(candidate)) {
      return candidate;
    }
  }
  const relative = WINDOWS_EXECUTABLES[name];
  if (relative) {
    for (const root of mountRoots) {
      const candidate = posix.join(root, 'c', ...relative);
      if (exists(candidate)) {
        return candidate;
      }
    }
  }
  return name;
}

export const WSL_INTEROP_HINT = 'Under WSL, logwork stores credentials in Windows Credential Manager and shows Windows notifications through powershell.exe. Make sure WSL interop is on (`[interop] enabled=true` in /etc/wsl.conf, the default), or set LOGWORK_WSL=0 to use a Linux keyring (secret-tool) instead.';

function readKernelRelease() {
  try {
    return readFileSync('/proc/sys/kernel/osrelease', 'utf8');
  } catch {
    return '';
  }
}
