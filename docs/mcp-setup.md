# MCP Setup

`logwork setup` prints copy-ready configs that use your real path. You can also open the terminal UI with `logwork` and type `/mcp`, or `/mcp <client>` for a single client.

For the full RO/Jira/Both processing model, mapping, reconciliation, history, reminders and updates, see the [operations guide](operations-guide.md).

Every client runs `node <home>/.logwork-cli/bin/logwork.mjs mcp` under the server name `logwork`.

The config uses an absolute `node` entry path instead of the `logwork` command. GUI IDEs often start without the npm global bin directory on `PATH`, so the bare command may not be found.

The examples use `/Users/<user>` as a macOS placeholder. On Windows, use the path printed by `logwork setup` or `/mcp`, usually `C:\\Users\\<user>\\.logwork-cli\\bin\\logwork.mjs` inside JSON or TOML strings.

## Cursor / Google Antigravity

Cursor MCP settings, or `~/.gemini/antigravity/mcp_config.json`:

```json
{
  "mcpServers": {
    "logwork": {
      "command": "node",
      "args": ["/Users/<user>/.logwork-cli/bin/logwork.mjs", "mcp"]
    }
  }
}
```

## Codex

`~/.codex/config.toml`, or project `.codex/config.toml`:

```toml
[mcp_servers.logwork]
command = "node"
args = ["/Users/<user>/.logwork-cli/bin/logwork.mjs", "mcp"]
startup_timeout_sec = 20
tool_timeout_sec = 120
```

## GitHub Copilot / VS Code

Workspace `.vscode/mcp.json`, or your VS Code user MCP config:

```json
{
  "servers": {
    "logwork": {
      "type": "stdio",
      "command": "node",
      "args": ["/Users/<user>/.logwork-cli/bin/logwork.mjs", "mcp"]
    }
  }
}
```

## Claude Code

```bash
claude mcp add --transport stdio logwork -- node "/Users/<user>/.logwork-cli/bin/logwork.mjs" mcp
```

From Windows PowerShell:

```powershell
claude mcp add --transport stdio logwork -- node 'C:\Users\<user>\.logwork-cli\bin\logwork.mjs' mcp
```

Or add the Cursor JSON above to the project `.mcp.json`.

Templates are also in [examples/mcp](../examples/mcp/).

If you used `logwork-helper` before, delete its old MCP entry. It points at `~/.logwork-helper/mcp-server.mjs`, which is the old runtime.

## Exposed Tools

After editing the config, restart or reload the IDE. The server exposes 15 tools. Each one has a title, a description, a described input schema, and MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), so IDEs and agents can tell read-only tools from writes.

The server also sends MCP `instructions` that explain the approval rules, the line format and the recommended call order. Most clients pass these to the model automatically.

**Writes are two calls to the same tool:**

1. Call the tool **without `confirm`**. It returns a preview: a `batchId` (for `log_work` and `log_jira_work`) or a `previewId` (for the entry tools), plus a `summary`. Show the summary to the user.
2. After explicit approval, call the same tool **again with only that id and `confirm: true`**.

The apply call writes the cached, approved preview as-is. If the apply call also carries content fields (such as `text`, `hours` or `description`), it is rejected rather than silently ignored. To change values, preview again.

Previews expire after 1 hour. They are also lost when the server restarts.

| Group | Tool | Kind | Purpose |
|---|---|---|---|
| Read | `get_logwork` | read-only | Booked vs logged RO hours by day and project, with entries (`logworkId`, worklog task, description, status). |
| Read | `list_projects` | read-only | RO memberships (`projectMemberId`, `projectId`, `projectName`) and local mappings. |
| Read | `list_tasks` | read-only | RO worklog task catalog for one `projectId`: id, name, type of work, and when to use each task. |
| Read | `get_jira_issue` | read-only | Jira issue key, summary and status. |
| Read | `reconcile` | read-only | Compare RO and Jira hours by day. Never writes. |
| Read | `get_history` | read-only (local) | Local apply history. Contains no credentials. |
| RO write | `log_work` | two-call write | Create new RO entries from a weekly block (worklog task + description). |
| RO write | `edit_entry` | two-call, destructive | Change hours, worklog task, type of work or description of a submitted or approved entry. Apply replaces the entry. |
| RO write | `resubmit_entry` | two-call write | Fix and resubmit a rejected entry (hours, type, description, note to PM). |
| RO write | `delete_entry` | two-call, destructive | Delete a submitted or approved entry. |
| Jira write | `log_jira_work` | two-call write | Create Jira worklogs. The description becomes the worklog comment. |
| Config | `map_project` | local write, `confirm` | Map ticket prefixes or keywords to an RO project (`.logwork.json`). |
| Config | `reminder` | `action`: status / enable / disable / test | Native OS reminder. Every action except `status` needs `confirm: true`. |
| Config | `update` | `action`: check / install | npm self-update. `install` needs `confirm: true`. |
| Auth | `login` | local | `target: "ro"` (default) opens or explains a terminal login. `target: "jira"` explains how to save a PAT. Never accepts credentials. |

### Tool Name Changes From logwork-helper

| logwork-helper (before 0.3.0) | logwork-cli |
|---|---|
| `preview_logwork_batch`, `apply_logwork_batch` | `log_work` |
| `query_logwork` | `get_logwork` |
| `list_logwork_projects` | `list_projects` |
| `list_worklog_tasks` | `list_tasks` |
| `preview_ro_logwork_edit`, `apply_ro_logwork_edit` | `edit_entry` |
| `preview_ro_logwork_resubmit`, `apply_ro_logwork_resubmit` | `resubmit_entry` |
| `preview_ro_logwork_delete`, `apply_ro_logwork_delete`, `delete_ro_logwork_entry` | `delete_entry` |
| `preview_jira_worklog_batch`, `apply_jira_worklog_batch` | `log_jira_work` |
| `reconcile_logwork` | `reconcile` |
| `query_apply_history` | `get_history` |
| `upsert_project_mapping` | `map_project` |
| `start_auth_login`, `start_jira_auth` | `login` (`target: "ro"` or `"jira"`) |
| `get_logwork_reminder`, `configure_logwork_reminder`, `test_logwork_reminder` | `reminder` (`action`) |
| `check_for_updates`, `apply_update` | `update` (`action`) |

The structured `batch` / `preview` echo parameters of the old apply tools are gone. Apply calls use only the id.

## Logwork Line Format

`log_work` and `log_jira_work` take the same text:

```text
Monday, 01 Jun 2026
+2 Feature Development | Implement maintenance mode management and status UI (SCB-213)
+1 Code Review & Refactoring | Review system page PR (SCB-227)
Tuesday, 02 Jun 2026
+2.5 Bug Fix | Password reset validation and UI improvements (SCB-228)
```

- **Day heading:** `<Weekday>, <DD> <Mon> <YYYY>`.
- **Entry:** `+<hours> <worklog task> | <description>`.
  - `<worklog task>` is a Resource Optimiser worklog task name from `list_tasks` (case-insensitive exact match), or `#<id>`.
  - `<description>` is free text. Resource Optimiser stores it as the entry `description`, and Jira uses it as the worklog comment. Only the first `|` splits the line; any later `|` stays in the description.
- **Lines without `|`** are still accepted:
  - If the whole text is a catalog task name, the entry is written without a description and the preview shows a warning.
  - Otherwise, pass `defaultWorklogTask` (for example `"Other Activities"`) to the `log_work` preview call, and the text becomes the description. Without it, the entry is unresolved with reason `worklog_task_required` and the preview lists `availableTaskNames`.
- **Jira lines** need exactly one issue key, such as `SCB-213`.

If a tool says auth is required, the assistant calls `login`, or you can run `logwork login` yourself. For Jira, the assistant calls `login` with `target: "jira"`, or you run `logwork login jira`.

The Jira prompt accepts a Personal Access Token in the terminal only. Neither login accepts credentials through MCP.

Do not paste passwords, 2FA codes, Bearer tokens, cookies, or raw auth logs into AI chat.

## Verify Setup

Use these prompts after your IDE sees the `logwork` server:

```text
Check my logwork for this week.
```

```text
Which Resource Optimiser project should this repo log work to?
```

```text
Log 2 hours today for SCB-213 "maintenance mode UI" as Feature Development, with a clear description. Preview first and wait for my approval.
```

```text
Set up the SCB ticket mapping to project 2621A-SIT-HTML BUILDER-PRJ.
```

## Common MCP Workflows

### Query Logwork

Ask your assistant:

```text
List the days and projects I logged work for this week, including entry details.
```

The assistant calls `get_logwork`. Supported periods are `today`, `yesterday`, `this_week`, `last_week`, `this_month` and `last_month`. This is read-only.

### Reconcile Resource Optimiser And Jira

```text
Compare my Resource Optimiser and Jira worklogs for this week. Show daily differences and do not write anything.
```

The assistant calls `reconcile` with `period: "this_week"`. Custom dates are intentionally not exposed.

The result includes:
- daily booked, RO and Jira totals;
- issue-level differences;
- entries that cannot be verified because they do not contain exactly one Jira key;
- high-confidence correction suggestions.

A suggestion is not an approved write. It still goes through the two-call write of `log_work`, `edit_entry` or `log_jira_work`.

### Log Work To Resource Optimiser

1. Optional: call `get_logwork` to see booked and logged hours.
2. Call `list_projects`, then `list_tasks` with the `projectId`, to pick valid worklog task names.
3. Call `log_work` with `text`.
4. Show the summary and ask for approval. The summary shows each line as `project - worklog task | description`, plus an approval checklist with the total hours, date range and per-project breakdown.
5. Call `log_work` with `batchId` and `confirm: true`. Add `allowUnbooked: true` only if the user agreed to log to a project that is not booked on that date.

The `batchId` changes whenever a description or `defaultWorklogTask` changes, so an approval always covers the exact text that will be written. If an entry is unresolved, re-preview with `projectOverrides` (preview entry id → `projectMemberId`), or save a mapping with `map_project`.

Each preview entry contains:
- `taskName`: the resolved RO worklog task;
- `worklogTaskId`;
- `description`;
- `descriptionMissing`;
- `taskResolution.reason`.

| `taskResolution.reason` / entry `reason` | Meaning | Fix |
|---|---|---|
| `worklog_task_match` | Task resolved from the text before `\|` (or the whole line). | None. |
| `default_worklog_task` | The line had no `\|`, so `defaultWorklogTask` was used and the line became the description. | None. |
| `worklog_task_required` | The line had no `\|` and is not a catalog task. | Add `<task> \|`, or pass `defaultWorklogTask`. See `availableTaskNames`. |
| `task_not_found` | The task before `\|` is not in the catalog. | Use a name from `suggestedTaskNames` or `availableTaskNames`. |
| `task_lookup_failed` | The catalog request failed. | Retry, or check auth. |

Apply sends `POST /logwork/entries` with `worklog_task_id`, `effort_hours`, `logdate`, `type_of_work` and `description`, plus `project_id` when the task is a shared default. New entries are approved immediately. `log_work` never writes Jira.

### Edit, Resubmit, Or Delete An Existing RO Entry

Get the `logworkId` from `get_logwork` first.

```text
RO logwork 304032 should be a Bug Fix with description "Fix date picker timezone (SAP-42)". Keep hours, project, and date. Show me the diff and ask before applying.
```

1. Call `edit_entry` with `logworkId: 304032`, `taskName: "Bug Fix"` and `description: "Fix date picker timezone (SAP-42)"`.
2. Show the original and updated fields. Project and date are shown as unchanged.
3. Ask for explicit approval.
4. Call `edit_entry` with the returned `previewId` and `confirm: true`.

The optional changes are:
- `hours`
- `taskName`: a catalog name from `list_tasks`, or `#<id>`.
- `description`
- `typeOfWork`

Pass at least one. Omitted fields keep their current value. The exception is `typeOfWork`: if it is omitted and the task changes, it follows the new task's catalog type.

RO has no staff edit endpoint. `PATCH /logwork/pm/entries/:id/edit-approve` exists but is PM-only. So apply **replaces** the entry:

1. It re-reads the entry and blocks if the entry changed after the preview.
2. It creates the corrected entry with `POST /logwork/entries`.
3. It deletes the original with `DELETE /logwork/entries/:id`.
4. It verifies the new entry.

If the create fails, the original is untouched. If the delete fails, the new entry is rolled back.

Deleting needs no approval, and the new entry is approved immediately, so the edit takes effect at once. Because the entry id changes, the result returns both `originalLogworkId` and `newLogworkId`.

Which tool to use:

| Entry | Tool |
|---|---|
| Rejected, needs fixing | `resubmit_entry`: change hours, type of work, description, or add a note to the PM. |
| No longer needed | `delete_entry`: works only on submitted or approved entries. |
| On a locked day, created by Jira, or owned by another user | Edit is blocked. |

`edit_entry` and `delete_entry` carry `destructiveHint: true`.

### Log Work To Jira

Jira worklogs are separate from Resource Optimiser logwork. Log in first with `logwork login jira`.

Each line must include exactly one Jira issue key. The RO worklog task before `|` is ignored by Jira. A line without `|` uses the whole text as the comment.

1. Call `log_jira_work` with `text`.
2. Show the summary and ask for approval. The summary includes the ready, duplicate, missing-ticket, multi-ticket and lookup-failed counts; the issue summary and status; and the final `started` and comment values.
3. Call `log_jira_work` with `batchId` and `confirm: true`.

Duplicates block apply, and there is no override option. A worklog counts as a duplicate when it has the same short marker (`#lh:<hash>`), or the same issue, date, duration and normalized comment. Legacy `[logwork-helper:...]` markers in older comments are still recognized.

Each worklog is written with these values:

```text
started: 09:00 Asia/Ho_Chi_Minh on the entry date
timeSpentSeconds: hours * 3600
comment: description (text after "|", or the whole line) plus short marker, for example #lh:8f3a91c0
adjustEstimate: leave
```

Override `started` with `LOGWORK_JIRA_STARTED_TIME=HH:mm` and the timezone with `LOGWORK_TIMEZONE=<IANA timezone>`.

### Both

For the same text, run both previews: `log_work` and `log_jira_work`. Show both summaries, then apply each one with its own approval.

The two applies are intentionally not atomic. `log_work` never writes Jira, and `log_jira_work` never writes Resource Optimiser.

### History, Updates, Reminder

- **History:** `get_history` reads the sanitized local ledger. The `both` filter returns records created by the combined Both flow.
- **Updates:**
  1. Call `update` with `action: "check"` (read-only) and show the target version.
  2. After approval, call `update` with `action: "install"`, `version` and `confirm: true`.
  3. Reconnect MCP afterwards.

  Install re-checks npm, accepts only npm latest, and never accepts a registry, package or shell command.
- **Reminder:**
  - `reminder` with `action: "status"` is read-only.
  - `enable` (with optional `time` and `target`), `disable` and `test` need `confirm: true` after approval.
  - macOS uses launchd and Windows uses Task Scheduler.
  - Reminder tools never accept credentials, scheduler commands or executable paths.

### Project Mapping

You do not need to create the mapping file by hand. When a preview cannot resolve a ticket like `SCB-213`, the assistant calls `list_projects`. After you approve, it calls `map_project` with `tickets`, an optional `keywords`, and `confirm: true`.

Mappings are stored in one of two places:
- **User scope (default):** `~/.logwork-cli/.logwork.json`.
- **Project scope:** `.logwork.json` in the current repo. A repo that still has `.logwork-helper.json` keeps using that file until a `.logwork.json` exists.

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

This file stores matching hints only. It never stores tokens.

### Allow Unbooked Logging

Sometimes a line matches one of your project memberships, but that project is not booked for the date. The preview then marks the entry `UNBOOKED`.

Only allow this when the matched project is correct. Apply with:

```json
{ "batchId": "<from preview>", "confirm": true, "allowUnbooked": true }
```
