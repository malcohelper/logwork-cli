# Quick Recipes

These recipes cover the common end-user paths. Credentials are entered only in Terminal, never in MCP prompts or AI chat.

## Log Resource Optimiser Only

Terminal:

```bash
logwork
```

Then run `/logwork ro`, choose a date and project, and enter tasks:

```text
+2 Maintenance mode management (SCB-213)
+1 Update system page
```

Review the preview and approve the Resource Optimiser apply.

MCP prompt:

```text
Preview this Resource Optimiser logwork. Show the project and totals, then ask before applying:
Monday, 01 Jun 2026
+2 Maintenance mode management (SCB-213)
```

The assistant should use `preview_logwork_batch`, then `apply_logwork_batch` only after approval.

## Edit Existing Resource Optimiser Logwork

Find the RO logwork ID with `/query this-week` or ask the assistant to call `query_logwork`. Then use Terminal:

```bash
logwork-helper edit 290364 --hours 0.5
logwork-helper edit 290364 --task-name "Updated task name (SCB-470)"
```

Or ask MCP:

```text
Preview changing RO logwork 290364 to 0.5 hours. Keep project, date, and task name unchanged, then ask before applying.
```

The assistant uses `preview_ro_logwork_edit`, presents the diff, and calls `apply_ro_logwork_edit` only after approval. The edit is blocked if the original entry changed after preview or was created by Jira.

## Log Jira Only

Authenticate once:

```bash
logwork-helper jira login
```

Run `logwork`, then `/logwork jira`. Every task needs exactly one Jira issue key:

```text
+2 Maintenance mode management (SCB-213)
+1 Fix deployment regression (SCB-214)
```

The preview shows issue summary/status, duplicate state, configured started time, duration, and final comment. The assistant equivalent is `preview_jira_worklog_batch`, followed by `apply_jira_worklog_batch` after approval.

## Log Both

Run `logwork`, then `/logwork both`. Use the same date and tasks for both targets:

```text
+2 Maintenance mode management (SCB-213)
+1 Fix deployment regression (SCB-214)
```

Resource Optimiser and Jira previews remain separate. Approve Resource Optimiser first and Jira second. The flow is not atomic, so a failure on one target does not roll back the other target.

If RO cannot resolve a project, the terminal flow can rank RO memberships using the Jira project key/name and show a command such as:

```text
/map SCB 5234
```

Review the proposed project before confirming. Suggestions never write mappings automatically.

## Change Jira Started Time

macOS/Linux shell:

```bash
export LOGWORK_JIRA_STARTED_TIME=08:30
export LOGWORK_TIMEZONE=Asia/Singapore
logwork
```

Windows PowerShell:

```powershell
$env:LOGWORK_JIRA_STARTED_TIME = "08:30"
$env:LOGWORK_TIMEZONE = "Asia/Singapore"
logwork
```

Time must use 24-hour `HH:mm`; timezone must be an IANA name. The exact `started` value appears in Jira preview before approval.

## Recover From Missing Jira Auth

If preview says Jira auth is required:

```bash
logwork-helper jira login
logwork-helper jira status
```

Paste the PAT only into the Terminal prompt, then rerun preview. Do not paste the PAT into MCP input or chat.

## Handle Duplicate Jira Worklog

Duplicate Jira worklogs block the entire Jira apply. Preview identifies duplicates by the `#lh:<hash>` marker or matching issue/date/duration/normalized task comment.

Check Jira and the preview before continuing. If the work already exists, do not apply it again. If the task is genuinely different, change the task/date/duration as appropriate and rerun preview. There is no duplicate override.

## Recover From npm E401

An `E401` from `npm whoami` means the local npm login is missing, expired, or invalid:

```bash
npm logout --registry=https://registry.npmjs.org/
npm login --registry=https://registry.npmjs.org/
npm whoami
```

Before publishing, run:

```bash
logwork-helper release doctor --full
```

Do not paste npm passwords, tokens, or OTP values into chat.

## Inspect Apply History

All recent targets:

```bash
logwork-helper history
```

Jira only, last 10:

```bash
logwork-helper history --target jira --limit 10
```

Combined Both sessions:

```bash
logwork-helper history --target both
```

Inside the terminal UI, use `/history`, `/history ro`, `/history jira`, or `/history both`. With MCP, ask the assistant to use `query_apply_history`.

## Check And Install An Update

Terminal check:

```bash
logwork-helper update check
```

Terminal install with confirmation:

```bash
logwork-helper update install
```

MCP prompt:

```text
Check whether Logwork Helper has an update. Show me the current and latest versions, and ask before installing anything.
```

After approval, the assistant calls `apply_update` with the exact version and `confirm: true`. Restart or reload the IDE MCP connection after the update completes.

## Enable A Native Weekday Reminder

Default Both reminder at 17:00:

```bash
logwork-helper reminder enable
```

RO-only reminder at 18:00:

```bash
logwork-helper reminder enable --time 18:00 --target ro
```

Send a sample notification and inspect scheduler status:

```bash
logwork-helper reminder test
logwork-helper reminder status
```

MCP prompt:

```text
Enable a Both logwork reminder at 17:00 on weekdays. Explain the OS schedule and ask for approval before changing anything.
```

The notification remains silent when enabled checks are complete. Disable and remove the OS schedule with `logwork-helper reminder disable`.

## Reconcile RO And Jira

Terminal summary:

```bash
logwork-helper reconcile this-week
```

Machine-readable output:

```bash
logwork-helper reconcile last-month --json
```

Inside `logwork`:

```text
/reconcile
/reconcile this-week
```

MCP prompt:

```text
Compare my RO and Jira worklogs for this week. Explain each mismatch and do not apply corrections.
```

The assistant calls `reconcile_logwork`. When a correction is needed, it uses `preview_logwork_batch` or `preview_jira_worklog_batch` and asks for target-specific approval before applying.
