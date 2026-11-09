import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

// How to start npm as a child process on every platform.
// On Windows, npm is npm.cmd: spawn('npm') fails with ENOENT, and since the
// Node fix for CVE-2024-27980 spawn('npm.cmd') without a shell fails with
// EINVAL. Running npm's own npm-cli.js with the current node avoids the shell;
// when it cannot be found, fall back to npm.cmd through cmd.exe.
export function npmInvocation(args, {
  platform = process.platform,
  execPath = process.execPath,
  env = process.env,
  exists = existsSync
} = {}) {
  if (platform !== 'win32') {
    return { command: 'npm', args, shell: false };
  }
  const candidates = [
    env.npm_execpath && /npm-cli\.js$/i.test(env.npm_execpath) ? env.npm_execpath : null,
    join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  ].filter(Boolean);
  const cli = candidates.find((path) => exists(path));
  if (cli) {
    return { command: execPath, args: [cli, ...args], shell: false };
  }
  // cmd.exe joins the arguments unquoted; the arguments used here have no
  // spaces or shell metacharacters.
  return { command: 'npm.cmd', args, shell: true };
}
