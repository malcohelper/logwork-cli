# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`logwork-cli` (npm, repo `malcohelper/logwork-cli`, Node 22+, ESM `.mjs`, macOS and Windows) logs work hours to Resource Optimiser (RO) and self-hosted Jira. The package was renamed from `logwork-helper` in 1.0.0. The `logwork-helper` command no longer exists.

## Layout

- **`bin/logwork.mjs`** is the single entry. The npm bins `logwork` and `logwork-cli` both point here. Its `COMMANDS` table maps each command name to a lazily imported `commands/*.mjs` module and the function to call, and runs it **in-process**. There is no child process, so the cwd is preserved.
  - With no command (or only flags), it opens the Ink terminal UI (`commands/tui.mjs` → `lib/manual-repl.mjs`).
  - It runs `migrateLegacyHome()` before every command.
- **`commands/`**: one module per CLI command:
  - `query`
  - `quick`: in-process guided single entry, using `lib/ui.mjs`
  - `edit`, `delete`
  - `reconcile`, `history`
  - `auth`: `runLogin` / `runLogout` / `runStatus`, with target `ro|jira`
  - `setup`: copies the runtime to `~/.logwork-cli`, `npm ci`, removes the global `logwork-helper`, `npm link`, re-registers the reminder, prints MCP configs
  - `reminder`, `update`, `doctor`, `release`, `tui`
- **`lib/`**: shared workflows, API clients and OS integration. Notable modules:
  - `config.mjs`
  - `mcp-server.mjs`: exports `startMcpServer` and the preview-cache helpers.
  - `manual-mcp.mjs`: MCP config snippets.
  - `paths.mjs` and `legacy-migration.mjs`.
  - `api.mjs`: the Resource Optimiser client facade. It only re-exports the `ro-api-*` modules, so existing imports keep working:
    - `ro-api-http.mjs`: `apiFetch` and `ApiError`;
    - `ro-api-fields.mjs`: candidate field readers for loosely shaped responses;
    - `ro-api-diagnostics.mjs`: normalization diagnostics;
    - `ro-api-projects.mjs`: project memberships and legacy day logs;
    - `ro-api-timesheet.mjs`: timesheet ranges (booked and logged hours);
    - `ro-api-tasks.mjs`: the worklog task catalog;
    - `ro-api-entries.mjs`: logwork entry reads and the create, resubmit and delete writes.
  - `api-auth.mjs`: the API-only Keycloak login flow and token exchange. Helpers live in `api-auth-support.mjs` (safe errors, URL checks), `api-auth-http.mjs` (cookie session, checked redirects), `api-auth-forms.mjs` (Keycloak HTML forms) and `api-auth-tokens.mjs` (RO token extraction). It re-exports their public names.
  - `manual-ink-app.mjs`: the Ink app shell (`ManualApp`, `runManualInkApp`, state, command execution). Its actions live in hooks: `manual-ink-wizard.mjs` (logwork wizard flow), `manual-ink-draft-actions.mjs` (saved drafts) and `manual-ink-task-editor.mjs` (task lines and edit/remove). `manual-ink-interaction.mjs` renders the bottom interaction area, and `manual-ink-session.mjs` holds the session preview helpers. Views are in `manual-ink-ui.mjs` and `manual-ink-auth.mjs`; `manual-ink-app.mjs` re-exports them.
- `logwork mcp` (`node <home>/bin/logwork.mjs mcp`) is what IDE configs run, under the server name `logwork`.

The old git `commit-msg` hook, `install.mjs`, `hooks/`, `lib/protocol.mjs` and `lib/git-message.mjs` were removed.

## Commands

```bash
npm ci
npm test                                   # node --test, all suites in test/*.test.mjs
node --import ./test/helpers/setup.mjs --test test/batch-workflow.test.mjs   # single suite
npm run dry-run                            # terminal UI with LOGWORK_DRY_RUN=1
LOGWORK_DRY_RUN=1 node bin/logwork.mjs mcp # MCP server without RO or Jira writes
npm run lint                               # ESLint 9 flat config (eslint.config.mjs)
npm run test:coverage                      # npm test with built-in coverage and line/branch/function thresholds (CI, macOS)
npm run release:check                      # lint + tests + audit + pack + diff check
```

User-facing CLI:
- `logwork`, `logwork query`, `logwork quick`, `logwork edit`, `logwork delete`
- `logwork reconcile`, `logwork history`
- `logwork login|logout|status [ro|jira]`
- `logwork setup`, `logwork mcp`, `logwork reminder`, `logwork update`, `logwork doctor`, `logwork release`

`LOGWORK_DRY_RUN=1` (checked with `isDryRun()` from `lib/config.mjs`) makes the RO write functions in `lib/ro-api-entries.mjs` (re-exported by `lib/api.mjs`) and every non-GET `jiraApiFetch` call in `lib/jira-api.mjs` return `{ dryRun: true, method, path, body }` instead of calling the API, with no token or headers. Reads still hit the API. The Jira apply then reports `status: 'dry_run'` and records `dry_run` entries in the apply ledger.

`LOGWORK_HOME` relocates local state; `LOGWORK_HELPER_HOME` is still honored. The test bootstrap `test/helpers/setup.mjs` (loaded with `--import` by every test script) clears all `LOGWORK_*` variables from the shell and sets `LOGWORK_HOME` to a fresh temp dir per test process, so tests never read the real `~/.logwork-cli` and the legacy migration stays off. Tests may still set these variables themselves.

## Logwork entry model (important)

An RO entry is created with `POST /logwork/entries`. The body has:
- `worklog_task_id`: a catalog task from `GET /logwork/tasks` + `/logwork/tasks/defaults` for the project;
- `effort_hours`;
- `logdate` (`YYYY-MM-DD`);
- `type_of_work` (`create|correct|improve|other`);
- `description`: free text;
- `project_id`: only when the task is a shared default.

Batch text (MCP, terminal paste, and wizard) uses:

```text
Monday, 01 Jun 2026
+2 Feature Development | Implement maintenance mode UI (SCB-213)
```

- **Parsing:** `lib/batch-parser.mjs` splits on the first `|` into `taskName` (worklog task) and `description`, with `taskExplicit: true`. Without `|`, `taskName` is the whole text, `description` is empty, and `taskExplicit` is false. `text` keeps the full line, and `tickets` are extracted from it.
- **Task resolution:** `lib/batch-workflow.mjs#attachWorklogTaskTargets` resolves the worklog task per entry.
  - With `|`: the task is resolved by name, or by `#<id>`, in `worklog-task-resolver.mjs`.
  - Without `|`: if the whole text is a catalog task, it is used and the entry gets `descriptionMissing: true`. Otherwise `defaultWorklogTask` supplies the task and the text becomes the description. With no default, the entry is unresolved with reason `worklog_task_required` and `availableTaskNames`.
- **Batch ids:** `createBatchId` hashes the full line text, so a description change produces a new `batchId`. `defaultWorklogTask` is also folded into the `batchId`.
- **Project resolution:** `lib/project-resolver.mjs` scores the full line (`entry.text`) against mappings, ticket prefixes and booked projects. It leaves an entry unresolved rather than guessing.
- **Jira:** `lib/jira-workflow.mjs` uses `description` (or the whole text) as the worklog comment and ignores the RO task part.

## MCP server conventions

The server exposes 16 tools and one prompt:
- **Read:** `get_logwork`, `draft_from_commits`, `list_projects`, `list_tasks`, `get_jira_issue`, `reconcile`, `get_history`
- **Write:** `log_work`, `edit_entry`, `resubmit_entry`, `delete_entry`, `log_jira_work`, `map_project`
- **Other:** `login` (`target`), `reminder` (`action`), `update` (`action`)
- **Prompt:** `log_from_commits`. It serves `skills/logwork/SKILL.md` (read by `lib/agent-skill.mjs`), the single source of the agent procedure that `logwork skill install` also copies to `~/.claude/skills` and `~/.codex/skills`.

`lib/commit-workflow.mjs` builds the commit draft:
- reads `git log --branches --remotes` for the author;
- groups commits per day by repo + ticket + kind of work;
- maps the kind of work to a default worklog task with `WORK_KINDS`;
- resolves each group's project: a mapping whose `repos` holds the repo root (`findRepoMapping`), else `resolveEntryProject` against that day's booked projects;
- gives each project's groups that project's remaining hours (booked minus logged) in 0.5h steps with `allocateHours`; unresolved groups share the room of booked projects no group claimed. Without RO it splits a standard day across all groups;
- returns `projectOverrides` keyed by the log_work entry ids. The parser numbers `<date>-<NN>` through the whole text, not per date.

It never writes.

Rules:
- Every tool sets `title`, `description`, `annotations` (the `READ_ONLY`, `WRITE`, `DESTRUCTIVE` and `LOCAL_*` constants) and a `.describe()` on every input param. `test/mcp-smoke.test.mjs` enforces this and the exact tool list, so update both when adding a tool.
- `SERVER_INSTRUCTIONS` (exported from `lib/mcp-server.mjs`) is sent as MCP `instructions`. Keep it in sync with the line format and approval rules.
- Writes are **two calls to the same tool**.
  - Without `confirm`, the tool previews and caches the result by `batchId` or `previewId` (TTL 1h). Every input that changes what gets written must be part of that id (see `createBatchId`, the `defaultWorklogTask` / `typeOfWork` suffixes, the resubmit hash). RO edit, resubmit and delete previews are cached with `setCachedRoEditPreview`; their apply re-reads the entry and refuses when its revision fingerprint changed.
  - With the id and `confirm: true`, the tool consumes the cached preview and applies it.
  - Apply calls must reject content fields (`assertApplyOnly`), and preview calls must have their required inputs (`requirePreviewInput`).
  - `log_work` preview flags `possibleDuplicate` entries (`attachDuplicateWarnings`, reading `/logwork/day` per date; injectable as `fetchDayEntries`). Apply refuses them unless `allowDuplicates: true`; like `allowUnbooked`, the check runs before the cached preview is consumed.
  - Do not split tools back into `preview_*` / `apply_*` pairs.
- MCP tools never accept passwords, OTPs or tokens. Auth errors return `authRequired` and point to the `login` tool or to `logwork login` / `logwork login jira`.

## Auth and local state

- **RO auth** (`lib/api-auth.mjs` and its `api-auth-*` helpers, `lib/auth.mjs`) runs the Keycloak login over HTTP from the terminal: email, password, 2FA. The session, including the refresh token, is stored in macOS Keychain or Windows Credential Manager (`lib/credential-store.mjs`) under service `logwork-cli`. On a 401, workflows force a re-login and retry once.
- **Jira** uses a PAT saved via `logwork login jira`.
- **Local files** live under `~/.logwork-cli`:
  - project mappings in `.logwork.json` (`tickets`, `keywords`, optional `repos` of git repo roots; user scope; or project scope in the cwd, where a legacy `.logwork-helper.json` is used until a `.logwork.json` exists);
  - drafts;
  - the apply ledger (`lib/apply-ledger.mjs`, sanitized);
  - diagnostics;
  - the update cache;
  - the reminder config (including optional commit-summary `repos`);
  - `runtime.json`, written by `logwork setup` (`lib/node-runtime.mjs`): the absolute node path and version. MCP configs and the reminder schedule store an absolute node path (`process.execPath`); `logwork doctor` and `logwork reminder status` warn when it is gone or stale.
- **Migration from logwork-helper:**
  - `lib/legacy-migration.mjs` copies state files once from `~/.logwork-helper`, renaming `.logwork-helper.json` to `.logwork.json`. It writes the marker `.migrated-from-logwork-helper`, never overwrites existing files, and is skipped when a custom home is set.
  - `credential-store.mjs#withLegacyService` reads the old `logwork-helper` service on a miss and copies the value forward. `delete` clears both services.
  - `reminder-scheduler.mjs` removes the legacy launchd label and Windows task whenever it installs or removes a schedule.
- Never log tokens, put them in argv, or write them to state files (`lib/auth-redaction.mjs`). The macOS Keychain write goes through `security -i` on stdin for this reason.
- Start npm with `lib/npm-command.mjs#npmInvocation`; plain `spawn('npm')` fails on Windows.

## Other notes

- `lib/ro-api-fields.mjs` (used by `ro-api-projects.mjs` and `ro-api-timesheet.mjs`) normalizes loosely shaped RO responses with candidate field lists. Extend those lists rather than hard-coding one shape.
- RO has no staff edit endpoint (`PATCH /logwork/pm/entries/:id/edit-approve` is PM-only), so `lib/ro-edit-workflow.mjs` edits by replace:
  - It reads the entry from three sources: legacy `GET /member-logtime/:id` (date, owner), `GET /logwork/day` (status, `worklog_task_id`, type, description), and the project-member list (`project_id`).
  - It creates the corrected entry with `POST /logwork/entries`, then deletes the original with `DELETE /logwork/entries/:id`. If the delete fails, it rolls the new entry back. The new entry gets a new id.
  - Deleting needs no approval, and new entries are approved immediately, so an edit takes effect at once. The per-entry `is_locked` flag on approved entries does not block deletion; only the day-level `isLocked` does.
  - Only `submitted` and `approved` entries can be edited. Rejected entries use resubmit (`PATCH /logwork/entries/:id/resubmit`).
  - The legacy `PATCH /member-logtime` is no longer used by any flow, and the client no longer has a function for it.
- Dates are local calendar dates.
- Docs to keep in sync with behavior: `README.md`, `docs/mcp-setup.md` (tool table, old → new tool names, line format), `docs/operations-guide.md`, `docs/recipes.md`, `docs/advanced.md`, `docs/security.md`, `RELEASE.md`.
