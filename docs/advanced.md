# Advanced Usage

This file keeps technical details out of the main README. Most users only need `npm install -g logwork-helper`, `logwork-helper setup-user --no-login`, `logwork-helper auth login`, and `/mcp`.

For one consolidated reference covering all newly integrated CLI and MCP workflows, see the [integrated operations guide](operations-guide.md).

## Environment Configuration

Defaults target the current Resource Optimiser / Vinova profile. For non-default deployments, configure the runtime with environment variables instead of editing source:

```bash
LOGWORK_HELPER_PROFILE=vinova
LOGWORK_API_BASE=https://api.resourceoptimiser.com/api/v1
LOGWORK_LOGIN_URL=https://app.resourceoptimiser.com/vinova
LOGWORK_JIRA_BASE_URL=https://jira-vnv.vinova.sg
LOGWORK_JIRA_STARTED_TIME=09:00
LOGWORK_TIMEZONE=Asia/Ho_Chi_Minh
LOGWORK_KEYCLOAK_AUTH_URL=https://keycloak.vinova.sg/auth/realms/resource/protocol/openid-connect/auth
LOGWORK_KEYCLOAK_TOKEN_URL=https://keycloak.vinova.sg/auth/realms/resource/protocol/openid-connect/token
LOGWORK_KEYCLOAK_REDIRECT_URI=https://app.resourceoptimiser.com/vinova/check-login
```

In Windows PowerShell, set the same values with `$env:NAME = "value"` before running Logwork Helper.

Supported overrides:

```text
LOGWORK_HELPER_PROFILE
LOGWORK_API_BASE
LOGWORK_LOGIN_URL
LOGWORK_JIRA_BASE_URL
LOGWORK_JIRA_STARTED_TIME
LOGWORK_TIMEZONE
LOGWORK_TOKEN_KEY
LOGWORK_ALLOWED_SAFARI_HOSTS
LOGWORK_KEYCLOAK_AUTH_URL
LOGWORK_KEYCLOAK_TOKEN_URL
LOGWORK_KEYCLOAK_CLIENT_ID
LOGWORK_KEYCLOAK_REDIRECT_URI
LOGWORK_KEYCLOAK_SCOPE
LOGWORK_KEYCLOAK_RESPONSE_MODE
LOGWORK_KEYCLOAK_RESPONSE_TYPE
LOGWORK_HTTP_TIMEOUT_MS
LOGWORK_HTTP_READ_RETRIES
LOGWORK_HTTP_RETRY_DELAY_MS
LOGWORK_DAY_LOG_CONCURRENCY
```

URL and numeric overrides are validated on startup. Invalid values fail fast so the helper does not log work against an unintended endpoint.

## Install Alternatives

The recommended install path is:

```bash
npm install -g logwork-helper
logwork-helper setup-user --no-login
```

One-off setup without a prior global install:

```bash
npx -y logwork-helper setup-user --no-login
```

Yarn global install:

```bash
yarn global add logwork-helper
logwork-helper setup-user --no-login
```

To install and start auth immediately:

```bash
logwork-helper setup-user --login
```

Use `--no-login` when installing in scripts or CI.

## Update

Check the currently running version against npm latest:

```bash
logwork-helper update check
```

Force a registry check instead of using the 24-hour cache:

```bash
logwork-helper update check --force
```

Install npm latest after an interactive confirmation:

```bash
logwork-helper update install
```

For scripts, pass `--yes`. To double-check an announced release before installation, pass its exact SemVer:

```bash
logwork-helper update install --version 0.1.11 --yes
```

The installer accepts only the version currently published under npm's `latest` tag. It invokes npm with a fixed package and argument list, copies the new runtime to `~/.logwork-helper`, and verifies the copied `package.json` version. Project mappings, drafts, apply history, update cache, and OS credential-store records are preserved.

The `logwork` terminal UI performs a cached check at startup and shows a one-line notice when an update exists. Registry failures are ignored in this startup path so offline use remains available.

MCP exposes `check_for_updates` and `apply_update`. `apply_update` requires `confirm: true`, does not accept a registry or arbitrary command, and performs a fresh npm check immediately before installation. Restart the terminal session and reconnect or reload the IDE MCP server after updating.

The previous manual update remains available as a recovery path:

```bash
npm update -g logwork-helper
logwork-helper setup-user --no-login
```

## Native Logwork Reminder

Enable the default weekday reminder:

```bash
logwork-helper reminder enable
```

Defaults:

- Local OS time `17:00`.
- Monday-Friday.
- Target `both`.
- At most one notification per day.
- No notification when all enabled checks are complete.

Customize the time or target:

```bash
logwork-helper reminder enable --time 18:00 --target ro
logwork-helper reminder enable --time 17:45 --target jira
```

Inspect, test, or remove the reminder:

```bash
logwork-helper reminder status
logwork-helper reminder test
logwork-helper reminder disable
```

On macOS the helper writes `~/Library/LaunchAgents/sg.vinova.logwork-helper.reminder.plist` and loads it with `launchctl`. On Windows it creates the interactive user task `Logwork Helper Reminder` with `schtasks.exe`. Both schedulers run the stable `~/.logwork-helper/reminder-cli.mjs run` entrypoint, which reads credentials from macOS Keychain or Windows Credential Manager at execution time.

Resource Optimiser is incomplete when today's logged hours are lower than booked hours. A day with no RO bookings and no RO logs is treated as not expected. Jira is incomplete when JQL finds no issue with a worklog by `currentUser()` on today's date. Auth or check failures produce an actionable notification without including the underlying API response.

The `test` command sends a sample notification immediately and does not query or write RO/Jira. On macOS, allow notifications when prompted. On Windows, ensure app notifications are enabled for PowerShell because the lightweight WinRT toast is delivered through the built-in PowerShell host.

## Reconcile Resource Optimiser And Jira

Use the same preset periods as `/query`:

```bash
logwork-helper reconcile today
logwork-helper reconcile this-week
logwork-helper reconcile last-week --json
```

The command queries RO task details and Jira worklogs authored by the authenticated Jira user. Jira issues are discovered with an exclusive date-range JQL query, then each issue's worklogs are filtered again by author and started date. The result includes booked, RO, and Jira hours by day; total and issue-level differences; missing task-detail diagnostics; and high-confidence correction suggestions.

A suggestion is high confidence only when an RO entry contains exactly one issue key such as `SCB-213`. Jira-to-RO suggestions still require project resolution. Reconciliation is read-only and never calls either apply workflow.

Inside the terminal UI, `/reconcile` opens a period picker. Direct commands are also available:

```text
/reconcile today
/reconcile yesterday
/reconcile this-week
/reconcile last-week
/reconcile this-month
/reconcile last-month
```

MCP exposes the same workflow as `reconcile_logwork`. To correct a mismatch, create a normal `preview_logwork_batch` or `preview_jira_worklog_batch`, inspect it, and apply the target separately after approval.

## Manual Terminal REPL

If you want to log work directly from Terminal without an MCP client, use the React + Ink manual session:

```bash
logwork
```

Compatibility commands still work:

```bash
logwork-helper manual
logwork-helper log
```

Prompt preview:

```text
Logwork Helper
cwd: /path/to/repo

logwork > /
> /help        Show this help
  /auth        Authenticate Resource Optimiser or show Jira login command
  /status      Show Resource Optimiser and Jira auth status
  /diagnostics Write a sanitized report
  /query       Query logwork by preset period
  /logwork     Create Resource Optimiser, Jira, or combined logwork
  /mcp         Show copy-ready MCP setup
```

Useful commands inside the session:

```text
/query today
/query yesterday
/query this-week
/query last-week
/query this-month
/query last-month
/reconcile
/reconcile this-week
/logwork
/logwork ro
/logwork jira
/logwork both
/edit-logwork 290364 --hours 0.5
/mcp
/projects
/projects 5234
/map SCB 5234
/history
/diagnostics
```

`/logwork` opens a target picker for Resource Optimiser, Jira, or Both. `/logwork ro` starts the Resource Optimiser wizard: pick a day in the current week, pick a Resource Optimiser project, then enter one task per line:

```text
+2 check ui/ux
+1.5 polish reset password state
```

`/logwork jira` starts the Jira worklog wizard: pick a day, then enter tasks with exactly one Jira issue key:

```text
+2 check ui/ux (SCB-213)
+1.5 polish reset password state (SCB-214)
```

`/logwork both` uses one date/task draft, builds separate Resource Optimiser and Jira previews, then asks for separate approvals when applying.

Inside `/logwork`, press Enter on an empty input to apply the ready preview. Use `/remove` to open a multi-select task remover, `/edit` to replace a task, `/save` to persist a local draft, or `Esc` to cancel with confirmation.

While the `task >` prompt is active, type `/` to see task-only actions:

```text
/save        Save this draft locally
/drafts      Resume or delete saved drafts
/diagnostics Write a sanitized support report
/remove      Select tasks to delete
/edit        Select one task and replace it
/clear       Clear current task list
/back        Return to project picker
/cancel      Discard this logwork session
```

Resource Optimiser drafts saved with `/save` are stored locally at `~/.logwork-helper/manual-drafts.json` on macOS or `%USERPROFILE%\.logwork-helper\manual-drafts.json` on Windows. Drafts never contain tokens, passwords, or OTPs.

Successful, partial, failed, and blocked apply outcomes are recorded in `~/.logwork-helper/apply-ledger.json`. The ledger contains only sanitized batch, entry, project, issue, status, and timestamp metadata. Read it with:

```bash
logwork-helper history
logwork-helper history --target jira --limit 10
logwork-helper history --target both
```

Inside `logwork`, use `/history`, `/history ro`, `/history jira`, or `/history both`. The `both` filter means records created while using the combined Both flow.

## Troubleshooting

- **IDE does not show tools**: restart or reload the MCP client and check the server path points to `~/.logwork-helper/mcp-server.mjs` on macOS or `%USERPROFILE%\.logwork-helper\mcp-server.mjs` on Windows.
- **`logwork: command not found` after `setup-user`**: open a new terminal first. If it still fails, run `npm install -g logwork-helper` or ensure your npm global bin directory is on `PATH`.
- **`npm error ELINKGLOBAL` during `setup-user`**: update to `logwork-helper@0.1.6` or newer, then rerun setup. The installer uses `npm link`, not `npm link --global`.
- **`query_logwork` or `allowUnbooked` missing**: reload the MCP tool cache or restart the IDE.
- **Not authenticated to Resource Optimiser**: run `logwork-helper auth login`, or ask the assistant to call `start_auth_login`; enter secrets only in Terminal.
- **Not authenticated to Jira**: run `logwork-helper jira login`, or ask the assistant to call `start_jira_auth`; paste the Jira PAT only in Terminal.
- **Auth error after 2FA**: retry `logwork-helper auth login`. If it still fails, run `logwork-helper diagnostics` and send only the generated sanitized report.
- **Jira worklog preview is blocked**: every Jira entry must include exactly one issue key, such as `SCB-213`. Duplicate Jira worklogs are blocking and cannot be overridden in v1.
- **Support needs logs**: run `logwork-helper doctor` or `logwork-helper diagnostics`; the report is saved under the helper diagnostics directory.
- **No project matched**: ask the assistant to call `list_logwork_projects`, choose the correct project, then call `upsert_project_mapping`.
- **Do not paste Bearer tokens, cookies, passwords, OTPs, or raw curl auth logs**: auth is handled locally and MCP config should only contain `command` and `args`.

## Legacy CLI

Git hook and quick manual workflows still exist for compatibility, but they are not required for MCP users.

Quick manual log:

```bash
logwork-helper manual quick --message "Fix login bug"
```

Optional Git hook install:

```bash
~/.logwork-helper/setup.sh /path/to/repo-that-you-commit-in
```

On Windows, use:

```powershell
logwork-helper install-hook C:\path\to\repo-that-you-commit-in
```

Dry run:

```bash
LOGWORK_DRY_RUN=1 logwork-helper manual quick --message "Dry run task"
```

In Windows PowerShell:

```powershell
$env:LOGWORK_DRY_RUN = "1"; logwork-helper manual quick --message "Dry run task"
```

## Release Checks

Before publishing or tagging a release, run:

```bash
logwork-helper release doctor --full
npm run release:check
```

The release doctor checks version consistency, git state, npm/GitHub auth, npm latest, tag/release state, local tarball artifacts, tests, audit, package dry run, and whitespace checks. See [RELEASE.md](../RELEASE.md) for the full checklist and manual verification steps.

## GitHub About Metadata

Suggested repository description:

```text
Local-first MCP server and terminal CLI for safe Resource Optimiser logwork automation.
```

Suggested topics:

```text
resource-optimiser
logwork
mcp-server
nodejs
macos
windows
keycloak
codex
cursor
vscode
claude-code
```
