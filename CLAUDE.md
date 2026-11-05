# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A macOS-only Git `commit-msg` hook plus an interactive Node.js (ESM, Node 20+) CLI that logs work hours to Resource Optimiser. It reads the user's auth token from Safari `localStorage` via `osascript`, lists only projects booked for today, and POSTs a logwork entry for a chosen default task. The only runtime dependency is `@clack/prompts`. User-facing prompt text is in Vietnamese; keep that convention when editing `lib/ui.mjs`.

## Commands

There is no build step, linter, or test suite.

```bash
npm ci                                   # install deps
npm run log [-- "Task message"]          # manual log flow (no commit needed)
npm run log:dry-run                      # same, but never calls the write API
node install.mjs [--dry-run] <repo>      # install hook into a target repo
./setup.sh <repo>                        # npm ci + install.mjs, with prereq checks
LOGWORK_DRY_RUN=1 git commit             # exercise the hook without writing logtime
```

`LOGWORK_DRY_RUN=1` is checked only in `createLogworkEntry` (`lib/api.mjs`): it still reads the token and calls the read APIs, but skips the POST. Everything that touches Safari/Terminal requires macOS with `osascript`, so the end-to-end flow cannot run in a Linux container.

## Architecture

### Hook ↔ helper protocol (the non-obvious part)

The commit hook cannot run an interactive TUI inside a GUI Git client, so it hands off to a separate Terminal window and waits on files:

1. `install.mjs` renders `hooks/commit-msg.template` into the target repo's hooks dir, substituting `__NODE_BIN__` (absolute `process.execPath` at install time, which is why setup must be re-run after changing Node versions), `__HELPER_DIR__`, `__EXISTING_HOOK__`, `__HOOK_TIMEOUT_MS__`, and `__POLL_MS__` (the last two come from `config.mjs`). Any pre-existing non-managed hook is renamed to `commit-msg.logwork-backup.<timestamp>` and chained to run first. A hook is recognized as managed by the marker comment `Logwork Helper managed commit-msg hook`.
2. At commit time the hook writes a lock file (`.git/logwork.lock`) containing a nonce, opens Terminal via AppleScript running `logwork-helper.mjs` with `--repo --msg-file --lock --result --nonce --terminal-title`, then polls until the lock disappears or the timeout hits.
3. `logwork-helper.mjs` always, in `finally`, writes `.git/logwork.result` (JSON `{nonce, status, reason, timestamp}`, atomic write via `lib/protocol.mjs`) and removes the lock. It then closes its Terminal window on `ok`/`skip` or focuses it on `abort`.
4. The hook verifies the result nonce matches and exits 0 for `ok`/`skip`, 1 otherwise. If node dies without writing a result, a shell fallback in the Terminal command writes an `abort` result.

`manual-log.mjs` reuses the same helper by faking this protocol: it creates a temp dir with a fake `COMMIT_EDITMSG`, lock, and result file, spawns the helper inline (`--close-terminal false`), and maps the result to its exit code. When changing helper arguments or result semantics, update the hook template, `manual-log.mjs`, and `lib/protocol.mjs` (`REQUIRED_ARGS`, `writeResult`) together. The allowed statuses live in `CONFIG.resultValues`.

### Auth

`lib/auth.mjs#getFreshToken` reads the JWT from Safari tabs whose host is in `CONFIG.allowedSafariHosts` (`lib/macos.mjs` uses JXA `doJavaScript`). If it is missing or expired, it opens the login URL in Safari and polls until a fresh token appears. The user id comes from the JWT payload (`id`/`user_id`/`sub`). On any API 401, `logwork-helper.mjs` forces a re-login and retries once. The token must never be logged, passed via argv, or written to lock/result files.

### API layer

`lib/api.mjs` talks to `CONFIG.apiBase`. The live flow uses `getTodayTimesheetProjects` (GET `/member-logtime/timesheet`), `getDefaultTasks` (GET `/logwork/tasks/defaults?project_id=`), and `createLogworkEntry` (POST `/logwork/entries`). The entry body is `{worklog_task_id, type_of_work, effort_hours, logdate, project_id, description}`. The task list has 7 shared defaults (`create`, `correct`, `improve`, `other` types), and the user picks one before the hours and description prompts. The timesheet response shape is not pinned down, so `collectTimesheetRows` walks the whole JSON tree for rows matching today's date (via date fields or date-named keys), and `pickFirst`/`readNumber` try long lists of candidate field names. Extend those candidate lists rather than hard-coding one shape. Projects are grouped by `project_member_id`, and those with zero booked hours are dropped. Assigned percent is booked hours divided by `CONFIG.standardDayHours` (8). `getProjects`, `getDayLogs`, and `getAllDayLogSummaries` are currently unused by the main flow.

Dates are local calendar dates (`YYYY-MM-DD` from `todayLocalDateISO`). The timesheet GET still needs the `T00:00:00.000Z` form from `toApiLogDate`, but the logwork POST sends the plain `YYYY-MM-DD` date, as the web app does.

### Commit message

`lib/git-message.mjs` strips `#` comment lines and everything after the verbose-commit scissors line, then uses the first paragraph as the default task name (falling back to `Work update`).
