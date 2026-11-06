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
