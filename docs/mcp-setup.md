# MCP Setup

Use `/mcp` inside the `logwork` terminal UI when possible. It prints copy-ready config with your actual `mcp-server.mjs` path.

For the full RO/Jira/Both processing model, output examples, mapping behavior, reconciliation, history, reminders, and update flow, see the [integrated operations guide](operations-guide.md).

```bash
logwork
```

```text
/mcp
```

The examples below use `/Users/<user>` as a macOS placeholder. On Windows, use the path printed by setup or `/mcp`, usually `C:\\Users\\<user>\\.logwork-helper\\mcp-server.mjs` inside JSON/TOML strings.

## Cursor

Add this to Cursor MCP settings:

```json
{
  "mcpServers": {
    "logwork-helper": {
      "command": "node",
      "args": ["/Users/<user>/.logwork-helper/mcp-server.mjs"]
    }
  }
}
```

## Codex

Add this to `~/.codex/config.toml`, or to project `.codex/config.toml`:

```toml
[mcp_servers.logwork-helper]
command = "node"
args = ["/Users/<user>/.logwork-helper/mcp-server.mjs"]
startup_timeout_sec = 20
tool_timeout_sec = 120
```

## Google Antigravity

Add this to `~/.gemini/antigravity/mcp_config.json`:

```json
{
  "mcpServers": {
    "logwork-helper": {
      "command": "node",
      "args": ["/Users/<user>/.logwork-helper/mcp-server.mjs"]
    }
  }
}
```

## GitHub Copilot / VS Code

Add this to workspace `.vscode/mcp.json` or your VS Code user MCP config:

```json
{
  "servers": {
    "logworkHelper": {
      "type": "stdio",
      "command": "node",
      "args": ["/Users/<user>/.logwork-helper/mcp-server.mjs"]
    }
  }
}
```

## Claude Code

Add the server from Terminal:

```bash
claude mcp add --transport stdio logwork-helper -- node "/Users/<user>/.logwork-helper/mcp-server.mjs"
```

From Windows PowerShell:

```powershell
claude mcp add --transport stdio logwork-helper -- node 'C:\Users\<user>\.logwork-helper\mcp-server.mjs'
```

Or add this to project `.mcp.json`:

```json
{
  "mcpServers": {
    "logwork-helper": {
      "command": "node",
      "args": ["/Users/<user>/.logwork-helper/mcp-server.mjs"]
    }
  }
}
```

## Exposed Tools

After editing config, restart or reload the IDE. The MCP server should expose:

- `query_logwork`
- `reconcile_logwork`
- `query_apply_history`
- `check_for_updates`
- `apply_update`
- `get_logwork_reminder`
- `configure_logwork_reminder`
- `test_logwork_reminder`
- `preview_logwork_batch`
- `apply_logwork_batch`
- `preview_ro_logwork_edit`
- `apply_ro_logwork_edit`
- `list_logwork_projects`
- `upsert_project_mapping`
- `start_auth_login`
- `start_jira_auth`
- `get_jira_issue`
- `preview_jira_worklog_batch`
- `apply_jira_worklog_batch`

If an MCP tool says auth is required, ask your assistant to call `start_auth_login` or run this yourself:

```bash
logwork-helper auth login
```

On Windows, run the same command from PowerShell.

If a Jira MCP tool says auth is required, ask your assistant to call `start_jira_auth` or run this yourself:

```bash
logwork-helper jira login
```

The Jira login prompt accepts a Personal Access Token in Terminal only. It does not accept username/password or tokens through MCP.

Do not paste passwords, 2FA codes, Bearer tokens, cookies, or raw auth logs into AI chat.

Templates are also available in [examples/mcp](../examples/mcp/).

## Verify Setup

Use these prompts after your IDE sees `logwork-helper`:

```text
Check my logwork for this week.
```

```text
Which Resource Optimiser project should this repo log work to?
```

```text
Preview this logwork and ask for my approval before submitting:
Monday, 01 Jun 2026
+2 Maintenance mode management and status UI (SCB-213)
```

```text
Preview this Jira worklog and ask for my approval before submitting:
Monday, 01 Jun 2026
+2 Maintenance mode management and status UI (SCB-213)
```

```text
Set up the SCB ticket mapping to project 2621A-SIT-HTML BUILDER-PRJ.
```

## Common MCP Workflows

### Query Logwork

Ask your assistant:

```text
Check whether I have logged anything today.
```

```text
Check whether I logged anything yesterday.
```

```text
List the days and projects I logged work for this week, including task details.
```

```text
List my logged work for last week.
```

```text
Summarize my logwork for this month.
```

The assistant should call `query_logwork`. This is read-only and does not need confirmation.

### Reconcile Resource Optimiser And Jira

Ask:

```text
Compare my Resource Optimiser and Jira worklogs for this week. Show daily differences and do not write anything.
```

The assistant should call `reconcile_logwork` with `period: "this_week"`. Supported periods are `today`, `yesterday`, `this_week`, `last_week`, `this_month`, and `last_month`; custom dates are intentionally not exposed.

The tool is read-only. It returns daily booked/RO/Jira totals, issue-level differences, entries that cannot be verified because they lack exactly one Jira key, and high-confidence correction suggestions. A suggestion is not an approved write. The assistant must use the existing target-specific preview tool and ask for approval before calling the matching apply tool.

### Preview Then Apply Resource Optimiser

Use weekly text like this:

```text
Monday, 01 Jun 2026
+2 Maintenance mode management and status UI (SCB-213, SCB-227)
+1 System page updates
Tuesday, 02 Jun 2026
+2.5 Password reset validation and UI improvements (SCB-228)
```

Expected flow:

1. Assistant calls `preview_logwork_batch`.
2. Assistant shows the summary, including the approval checklist with total hours, date range, and project breakdown, then asks for approval.
3. Assistant calls `apply_logwork_batch` with the returned `batchId` only after you approve.

`apply_logwork_batch` requires `confirm: true` and a cached `batchId` from the preview step. If the preview expired or changed, rerun `preview_logwork_batch` before applying.

Preview also checks that each task name matches an existing Resource Optimiser worklog task for the resolved project. If preview reports `task_not_found`, fix the task name in your batch text or create/select the matching worklog task in RO, then preview again. Apply uses `POST /logwork/entries`, so new logwork is created as approved (not submitted).

Use `preview_logwork_batch` and `apply_logwork_batch` only for Resource Optimiser. These tools do not write Jira worklogs.

### Edit Existing Resource Optimiser Logwork

First query RO logwork so the assistant has the entry ID, then ask:

```text
Change RO logwork 290364 from its current hours to 0.5 hours. Keep its project, date, and task name unchanged. Show me the diff and ask before applying.
```

Expected flow:

1. Assistant calls `preview_ro_logwork_edit` with `logworkId: 290364` and `hours: 0.5`.
2. Assistant shows the original and updated fields. Project and date must be shown as unchanged.
3. Assistant asks for explicit approval.
4. Assistant calls `apply_ro_logwork_edit` with the cached `previewId` and `confirm: true`.

To change only the task, provide `taskName` and omit `hours`. To change both, provide both fields. Apply blocks missing, expired, or mutated previews; re-reads the RO entry to detect concurrent edits; and verifies the saved value. Jira-created RO entries cannot be edited through this tool.

### Preview Then Apply Jira Worklogs

Jira worklogs are separate from Resource Optimiser logwork. Applying Resource Optimiser logwork does not write to Jira.

First authenticate Jira in Terminal:

```bash
logwork-helper jira login
```

Use the same weekly text format, but each Jira worklog entry must include exactly one Jira issue key:

```text
Monday, 01 Jun 2026
+2 Maintenance mode management and status UI (SCB-213)
Tuesday, 02 Jun 2026
+1 Fix regression after deploy (SCB-214)
```

Expected flow:

1. Assistant calls `preview_jira_worklog_batch`.
2. Assistant shows ready, duplicate, missing-ticket, multi-ticket, and lookup-failed counts; issue summary/status; and the final `started` and comment values, then asks for approval.
3. Assistant calls `apply_jira_worklog_batch` with the returned `batchId` only after you approve.

`apply_jira_worklog_batch` requires `confirm: true` and a cached `batchId` from `preview_jira_worklog_batch`. If the preview expired, changed, has no ticket, has multiple tickets, or detects duplicate Jira worklogs, rerun preview after fixing the text.

Duplicate detection is blocking. A Jira worklog is duplicate when it has the same short helper marker (`#lh:<hash>`), or the same issue, date, duration, and normalized task comment. Legacy `[logwork-helper:...]` markers are still recognized. There is no override option in v1.

Jira worklog writes use:

```text
started: 09:00 Asia/Ho_Chi_Minh on the entry date
timeSpentSeconds: hours * 3600
comment: task name plus short helper marker, for example #lh:8f3a91c0
adjustEstimate: leave
```

Override the first two values with `LOGWORK_JIRA_STARTED_TIME=HH:mm` and `LOGWORK_TIMEZONE=<IANA timezone>`. Preview stores the exact payload that apply will submit.

### Preview Then Apply Both

For the same text, the assistant should run two separate previews:

1. `preview_logwork_batch` for Resource Optimiser.
2. `preview_jira_worklog_batch` for Jira.

The assistant should show both summaries, then request approval separately:

1. Apply Resource Optimiser with `apply_logwork_batch` and `confirm: true`.
2. Apply Jira with `apply_jira_worklog_batch` and `confirm: true`.

The two apply steps are intentionally not atomic. A Resource Optimiser apply never writes Jira, and a Jira apply never writes Resource Optimiser.

When an unresolved RO entry has Jira project metadata, the terminal Both flow ranks matching RO memberships and shows a proposed `/map` command. The suggestion never writes config until you explicitly confirm the mapping.

### Query Apply History

Ask your assistant:

```text
Show my last 10 Jira apply results.
```

The assistant should call `query_apply_history`. This reads the sanitized local ledger and never returns credentials or raw API responses. Filter `both` returns records created while using the combined Both flow.

### Check And Apply Updates

Ask your assistant:

```text
Check whether Logwork Helper has a newer version. Do not install it yet.
```

The assistant should call `check_for_updates` and show the current version, latest version, and release URL. This step is read-only.

To update through MCP:

1. Assistant calls `check_for_updates` and shows the exact target version.
2. Assistant asks for explicit approval.
3. Assistant calls `apply_update` with that `version` and `confirm: true`.
4. After success, restart or reload the IDE MCP connection before using other tools.

`apply_update` re-checks npm immediately before installing. It accepts only npm latest, preserves local state and OS credentials, and does not accept an arbitrary npm registry, package, or shell command.

### Configure Native Reminder

Ask your assistant:

```text
Show my current logwork reminder configuration. Do not change it.
```

The assistant calls `get_logwork_reminder`, which is read-only.

To configure it:

```text
Enable a Both logwork reminder at 17:00 on weekdays. Show the plan and ask before changing my OS schedule.
```

Expected flow:

1. Assistant explains that macOS uses launchd and Windows uses Task Scheduler.
2. Assistant asks for explicit approval.
3. Assistant calls `configure_logwork_reminder` with `action: "enable"`, the approved time/target, and `confirm: true`.
4. Assistant calls `get_logwork_reminder` to verify config and scheduler consistency.

`test_logwork_reminder` also requires `confirm: true` because it displays a native OS notification. Reminder tools never accept credentials, scheduler commands, executable paths, or arbitrary JQL.

### Set Up Project Mapping

You do not need to create `.logwork-helper.json` manually.

If preview cannot resolve a ticket like `SCB-213`, ask your assistant to list projects or choose the correct project. The assistant can call:

- `list_logwork_projects` to fetch your Resource Optimiser project memberships.
- `upsert_project_mapping` to save ticket/keyword mapping after approval.

Default mapping storage:

```text
~/.logwork-helper/.logwork-helper.json
```

Example mapping created by MCP:

```json
{
  "projectMappings": [
    {
      "projectName": "2621A-SIT-HTML BUILDER-PRJ",
      "projectMemberId": 5234,
      "tickets": ["SCB"],
      "keywords": ["question bank", "programme", "cluster"]
    }
  ]
}
```

This file stores matching hints only. It never stores Resource Optimiser tokens.

### Allow Unbooked Logging

If a task matches one of your Resource Optimiser project memberships but is not booked for that date, preview marks it as `UNBOOKED`.

Only allow this when the matched project is correct. Applying unbooked entries requires both:

```json
{
  "confirm": true,
  "allowUnbooked": true
}
```
