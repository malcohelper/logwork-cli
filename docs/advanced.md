# Advanced Usage

This file keeps technical details out of the main README. Most users only need `npm install -g logwork-cli`, `logwork setup`, `logwork login`, and `/mcp`.

For one consolidated reference covering all newly integrated CLI and MCP workflows, see the [integrated operations guide](operations-guide.md).

## Environment Configuration

Defaults target the current Resource Optimiser / Vinova profile. For non-default deployments, configure the runtime with environment variables instead of editing source:

```bash
LOGWORK_PROFILE=vinova
LOGWORK_API_BASE=https://api.resourceoptimiser.com/api/v1
LOGWORK_LOGIN_URL=https://app.resourceoptimiser.com/vinova
LOGWORK_JIRA_BASE_URL=https://jira-vnv.vinova.sg
LOGWORK_JIRA_STARTED_TIME=09:00
LOGWORK_TIMEZONE=Asia/Ho_Chi_Minh
LOGWORK_KEYCLOAK_AUTH_URL=https://keycloak.vinova.sg/auth/realms/resource/protocol/openid-connect/auth
LOGWORK_KEYCLOAK_TOKEN_URL=https://keycloak.vinova.sg/auth/realms/resource/protocol/openid-connect/token
LOGWORK_KEYCLOAK_REDIRECT_URI=https://app.resourceoptimiser.com/vinova/check-login
```

In Windows PowerShell, set the same values with `$env:NAME = "value"` before running `logwork`.

Supported overrides:

```text
LOGWORK_PROFILE            (LOGWORK_HELPER_PROFILE still accepted)
LOGWORK_HOME               (local state directory; LOGWORK_HELPER_HOME still accepted)
LOGWORK_DRY_RUN=1          (RO and Jira writes return the request instead of calling the API)
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
npm install -g logwork-cli
logwork setup --no-login
```

One-off setup without a prior global install:

```bash
npx -y logwork-cli setup --no-login
```

Yarn global install:

```bash
yarn global add logwork-cli
logwork setup --no-login
```

To install and start auth immediately:

```bash
logwork setup --login
```

Use `--no-login` when installing in scripts or CI.

`logwork setup` copies the package into `~/.logwork-cli`, runs `npm ci --omit=dev` there, removes a globally installed `logwork-helper` package (its `logwork` bin would block linking), runs `npm link`, re-registers an enabled reminder, and prints MCP configs.

## Update

```bash
logwork update check             # uses a 24-hour cache
logwork update check --force     # query npm now
logwork update install           # interactive confirmation
logwork update install --version 0.3.1 --yes
```

The installer accepts only the version currently published under npm's `latest` tag. It runs `npm exec --package=logwork-cli@<version> -- logwork setup --no-login` with a fixed argument list. Then it verifies the copied `package.json` version in `~/.logwork-cli`.

Project mappings, drafts, apply history, update cache, and OS credential-store records are preserved.

The `logwork` terminal UI performs a cached check at startup and shows a one-line notice when an update exists. Registry failures are ignored in this startup path, so offline use still works.

MCP exposes the same update through the `update` tool:
- `action: "check"` is read-only.
- `action: "install"` requires `confirm: true`. It does not accept a registry or an arbitrary command, and it re-checks npm immediately before installing.

Reconnect or reload the IDE MCP server after updating.

Manual recovery path:

```bash
npm install -g logwork-cli@latest
logwork setup --no-login
```

## Native Logwork Reminder

Enable the default weekday reminder:

```bash
logwork reminder enable
```

Defaults:

- Local OS time `17:00`.
- Monday-Friday.
- Target `both`.
- At most one notification per day.
- No notification when all enabled checks are complete.

Customize the time or target:

```bash
logwork reminder enable --time 18:00 --target ro
logwork reminder enable --time 17:45 --target jira
```

Inspect, test, or remove the reminder:

```bash
logwork reminder status
logwork reminder test
logwork reminder disable
```

How the reminder is scheduled:
- **macOS:** it writes `~/Library/LaunchAgents/sg.vinova.logwork-cli.reminder.plist` and loads it with `launchctl`.
- **Windows:** it creates the interactive user task `Logwork Reminder` with `schtasks.exe`.

Both schedulers run `node ~/.logwork-cli/bin/logwork.mjs reminder run --home ~/.logwork-cli`. That command reads credentials from macOS Keychain or Windows Credential Manager when it runs. Enabling or disabling the reminder also removes the old `logwork-helper` schedule (`sg.vinova.logwork-helper.reminder` / `Logwork Helper Reminder`) if one is still present.

Resource Optimiser is incomplete when today's logged hours are lower than booked hours. A day with no RO bookings and no RO logs is treated as not expected. Jira is incomplete when JQL finds no issue with a worklog by `currentUser()` on today's date. Auth or check failures produce an actionable notification without including the underlying API response.

The `test` command sends a sample notification immediately and does not query or write RO/Jira. On macOS, allow notifications when prompted. On Windows, ensure app notifications are enabled for PowerShell because the lightweight WinRT toast is delivered through the built-in PowerShell host.

## Reconcile Resource Optimiser And Jira

Use the same preset periods as `/query`:

```bash
logwork reconcile today
logwork reconcile this-week
logwork reconcile last-week --json
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

MCP exposes the same workflow as `reconcile`. To correct a mismatch, preview it with `log_work`, `edit_entry` or `log_jira_work`, inspect the preview, and apply each target separately after approval.

## Terminal UI

If you want to log work directly from Terminal without an MCP client, use the React + Ink manual session:

```bash
logwork
```

Prompt preview:

```text
Logwork
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
/edit-logwork 304032 --task Bug Fix --desc Fix date picker (SAP-42)
/mcp
/projects
/projects 5234
/map SCB 5234
/history
/diagnostics
```

`/logwork` opens a target picker for Resource Optimiser, Jira, or Both. `/logwork ro` starts the Resource Optimiser wizard: pick a day in the current week, pick a Resource Optimiser project, then enter one task per line as `+<hours> <worklog task> | <description>`. The worklog task must be a Resource Optimiser catalog task for that project; the description is stored on the RO entry:

```text
+2 Feature Development | check ui/ux
+1.5 Feature Development | polish reset password state
```

`/logwork jira` starts the Jira worklog wizard: pick a day, then enter tasks with exactly one Jira issue key:

```text
+2 Feature Development | check ui/ux (SCB-213)
+1.5 Feature Development | polish reset password state (SCB-214)
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

Resource Optimiser drafts saved with `/save` are stored locally at `~/.logwork-cli/manual-drafts.json` on macOS or `%USERPROFILE%\.logwork-cli\manual-drafts.json` on Windows. Drafts never contain tokens, passwords, or OTPs.

Successful, partial, failed, and blocked apply outcomes are recorded in `~/.logwork-cli/apply-ledger.json`. The ledger contains only sanitized batch, entry, project, issue, status, and timestamp metadata. Read it with:

```bash
logwork history
logwork history --target jira --limit 10
logwork history --target both
```

Inside `logwork`, use `/history`, `/history ro`, `/history jira`, or `/history both`. The `both` filter means records created while using the combined Both flow.

## Troubleshooting

- **IDE does not show tools:** restart or reload the MCP client. Check that the config runs `node ~/.logwork-cli/bin/logwork.mjs mcp` (on Windows, `%USERPROFILE%\.logwork-cli\bin\logwork.mjs`) and that the server name is `logwork`.
- **Tools show old names such as `preview_logwork_batch`:** the IDE is still connected to the old `logwork-helper` entry. Replace that entry with the config printed by `logwork setup`; the [tool name table](mcp-setup.md#tool-name-changes-from-logwork-helper) lists the renames.
- **`logwork: command not found` after `logwork setup`:** open a new terminal first. If it still fails, run `npm install -g logwork-cli`, or make sure your npm global bin directory is on `PATH`.
- **`npm link` fails with `EEXIST` on `logwork`:** an old global `logwork-helper` package still owns the bin. Run `npm rm -g logwork-helper`, then `logwork setup` again.
- **Not authenticated to Resource Optimiser:** run `logwork login`, or ask the assistant to call `login`. Enter secrets only in the terminal.
- **Not authenticated to Jira:** run `logwork login jira`, or ask the assistant to call `login` with `target: "jira"`. Paste the Jira PAT only in the terminal.
- **Auth error after 2FA:** retry `logwork login`. If it still fails, run `logwork doctor` and send only the generated sanitized report.
- **Jira worklog preview is blocked:** every Jira entry must include exactly one issue key, such as `SCB-213`. Duplicate Jira worklogs block the apply and cannot be overridden.
- **Apply says no cached preview:** previews expire after 1 hour and are lost when the MCP server restarts. Preview again.
- **No project matched:** ask the assistant to call `list_projects`, choose the correct project, then call `map_project`.
- **Never paste Bearer tokens, cookies, passwords, OTPs, or raw curl auth logs:** auth is handled locally, and the MCP config should only contain `command` and `args`.

## Dry Run

`LOGWORK_DRY_RUN=1` makes every Resource Optimiser and Jira write return the request (`{ dryRun: true, method, path, body }`) instead of calling the API. The request never contains the token or the `Authorization` header. Reads still hit the API: Jira issue lookup and the duplicate-worklog check still call Jira, and RO previews still read RO.

What a dry run reports:

- RO apply summaries start with `DRY RUN`; edit, resubmit and delete return `status: "dry_run"`.
- Jira apply (`log_jira_work` with `confirm: true`, or the terminal UI `/apply`) returns `status: "dry_run"`, `dryRun: true`, one `dry_run` result per entry with its `request`, and a summary that starts with `DRY RUN (LOGWORK_DRY_RUN=1)`.
- Apply history records a Jira dry run with status `dry_run` and `dryRun: true` entries. They are not counted as submitted.
- The terminal UI status bar shows `DRY RUN`.

```bash
LOGWORK_DRY_RUN=1 logwork quick -m "Dry run task"
LOGWORK_DRY_RUN=1 logwork edit 304032 --desc "Dry run" --yes
npm run dry-run                     # terminal UI, RO and Jira writes stubbed
LOGWORK_DRY_RUN=1 logwork mcp       # MCP server, RO and Jira writes stubbed
```

In Windows PowerShell:

```powershell
$env:LOGWORK_DRY_RUN = "1"; logwork quick -m "Dry run task"
```

## Release Checks

Before publishing or tagging a release, run:

```bash
logwork release doctor --full
npm run release:check
```

The release doctor checks version consistency, git state, npm/GitHub auth, npm latest, tag/release state, local tarball artifacts, tests, audit, package dry run, and whitespace checks. See [RELEASE.md](../RELEASE.md) for the full checklist and manual verification steps.

## GitHub About Metadata

Suggested repository description:

```text
Log work to Resource Optimiser and Jira from the terminal, an MCP server for AI IDEs, and a terminal UI.
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
