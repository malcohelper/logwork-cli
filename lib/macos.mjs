import { spawn } from 'node:child_process';

export async function runOsascript(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/osascript', ['-e', script, ...args], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }

      const error = new Error(`osascript failed with exit code ${code}: ${stderr.trim() || 'no stderr'}`);
      error.code = code;
      error.stderr = stderr;
      reject(error);
    });
  });
}

export async function focusTerminalWindowByTitle(title) {
  const script = String.raw`
on run argv
  set targetTitle to item 1 of argv
  tell application "Terminal"
    activate
    repeat with terminalWindow in windows
      repeat with terminalTab in tabs of terminalWindow
        if (custom title of terminalTab contains targetTitle) or (name of terminalTab contains targetTitle) then
          set selected tab of terminalWindow to terminalTab
          set index of terminalWindow to 1
          return "focused"
        end if
      end repeat
    end repeat
  end tell
  return "not-found"
end run`;

  return runOsascript(script, [title]);
}

export async function closeTerminalWindowByTitle(title) {
  const script = String.raw`
on run argv
  set targetTitle to item 1 of argv
  tell application "Terminal"
    repeat with terminalWindow in windows
      repeat with terminalTab in tabs of terminalWindow
        if (custom title of terminalTab contains targetTitle) or (name of terminalTab contains targetTitle) then
          close terminalWindow
          return "closed"
        end if
      end repeat
    end repeat
  end tell
  return "not-found"
end run`;

  return runOsascript(script, [title]);
}

export async function setTerminalTitle(title) {
  process.stdout.write(`\u001b]0;${title}\u0007`);
}
