# Quick Recipes

These recipes cover the common end-user paths. Credentials are entered only in Terminal, never in MCP prompts or AI chat.

## Log Resource Optimiser Only

Terminal:

```bash
logwork
```

Then run `/logwork ro`, choose a date and project, and enter tasks as `+<hours> <worklog task> | <description>`. The part before `|` must be a Resource Optimiser worklog task (for example `Feature Development`); the part after `|` is the description saved on the entry:

```text
+2 Feature Development | Maintenance mode management (SCB-213)
+1 Feature Development | Update system page
```

Review the preview and approve the Resource Optimiser apply.

MCP prompt:

```text
Preview this Resource Optimiser logwork. Show the project and totals, then ask before applying:
Monday, 01 Jun 2026
+2 Feature Development | Maintenance mode management (SCB-213)
```

The assistant calls `log_work` with the text to preview. Only after you approve does it call `log_work` again with the returned `batchId` and `confirm: true`.

For a single entry today from the terminal, you can also run `logwork quick -m "Maintenance mode management (SCB-213)"`.

If you do not know the worklog task names, ask:

```text
List the Resource Optimiser worklog tasks for my booked project today, then log 2h for SCB-213 "maintenance mode management" with a proper description. Preview first.
```

The assistant uses `list_projects` and `list_tasks`, writes `+2 <task> | <description>`, and previews. If you write lines without `|`, the assistant can pass `defaultWorklogTask` (for example `Feature Development`) so each line becomes the description.

## Edit Existing Resource Optimiser Logwork

Find the RO logwork ID with `logwork query this-week`, `/query this-week`, or by asking the assistant to call `get_logwork`. Then use Terminal:

```bash
logwork edit 304032 --hours 0.5
logwork edit 304032 --desc "Fix date picker timezone (SAP-42)"
logwork edit 304032 --task "Bug Fix" --type correct
```

Or ask MCP:

```text
Preview changing RO logwork 304032 to 0.5 hours with description "Fix date picker timezone (SAP-42)". Keep project, date, and worklog task unchanged, then ask before applying.
```

The assistant calls `edit_entry` to preview and presents the diff. Only after you approve does it call `edit_entry` again with the `previewId` and `confirm: true`.

Apply replaces the entry: it creates the corrected entry, then deletes the original, so the entry gets a new id. If the delete fails, the new entry is rolled back.

The edit is blocked when the original entry:
- changed after the preview,
- is rejected (use `resubmit_entry` instead),
- is on a locked day, or
- was created by Jira.

## Log Jira Only

Authenticate once:

```bash
logwork login jira
```

Run `logwork`, then `/logwork jira`. Every task needs exactly one Jira issue key:

```text
+2 Feature Development | Maintenance mode management (SCB-213)
+1 Bug Fix | Fix deployment regression (SCB-214)
```

The preview shows issue summary/status, duplicate state, configured started time, duration, and final comment. The assistant equivalent is `log_jira_work`: a preview call, then a call with `batchId` and `confirm: true` after approval.

## Log Both

Run `logwork`, then `/logwork both`. Use the same date and tasks for both targets:

```text
+2 Feature Development | Maintenance mode management (SCB-213)
+1 Bug Fix | Fix deployment regression (SCB-214)
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
logwork login jira
logwork status jira
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
logwork release doctor --full
```

Do not paste npm passwords, tokens, or OTP values into chat.

## Inspect Apply History

All recent targets:

```bash
logwork history
```

Jira only, last 10:

```bash
logwork history --target jira --limit 10
```

Combined Both sessions:

```bash
logwork history --target both
```

Inside the terminal UI, use `/history`, `/history ro`, `/history jira`, or `/history both`. With MCP, ask the assistant to use `get_history`.

## Check And Install An Update

Terminal check:

```bash
logwork update check
```

Terminal install with confirmation:

```bash
logwork update install
```

MCP prompt:

```text
Check whether logwork-cli has an update. Show me the current and latest versions, and ask before installing anything.
```

The assistant calls `update` with `action: "check"`. After approval, it calls `update` with `action: "install"`, the exact version, and `confirm: true`. Restart or reload the IDE MCP connection after the update completes.

## Enable A Native Weekday Reminder

Default Both reminder at 17:00:

```bash
logwork reminder enable
```

RO-only reminder at 18:00:

```bash
logwork reminder enable --time 18:00 --target ro
```

Add commit evidence from your repos (shown when RO hours are missing):

```bash
logwork reminder enable --repo ~/code/app --repo ~/code/api
```

Send a sample notification and inspect scheduler status:

```bash
logwork reminder test
logwork reminder status
```

MCP prompt:

```text
Enable a Both logwork reminder at 17:00 on weekdays. Explain the OS schedule and ask for approval before changing anything.
```

The assistant calls `reminder` with `action: "enable"` and `confirm: true` after approval. The notification remains silent when enabled checks are complete. Disable and remove the OS schedule with `logwork reminder disable`.

## Reconcile RO And Jira

Terminal summary:

```bash
logwork reconcile this-week
```

Machine-readable output:

```bash
logwork reconcile last-month --json
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

The assistant calls `reconcile`. When a correction is needed, it previews with `log_work`, `edit_entry` or `log_jira_work` and asks for target-specific approval before applying.
