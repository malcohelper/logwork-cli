# Logwork Helper

[npm version](https://www.npmjs.com/package/logwork-helper)
[npm downloads](https://www.npmjs.com/package/logwork-helper)
[license](LICENSE)

Local MCP server and terminal CLI for Resource Optimiser logwork and Jira self-hosted worklogs.

Logwork Helper lets Cursor, Codex, Google Antigravity, GitHub Copilot / VS Code, Claude Code, and other MCP clients work with Resource Optimiser from your machine. It can query logged work, safely edit the hours or task name of an existing RO logwork, reconcile RO and Jira by day, preview and submit approved Resource Optimiser logwork, preview and submit approved Jira worklogs, map ticket prefixes to Resource Optimiser projects, keep a sanitized local apply history, schedule native OS reminders, and run a guided terminal flow through `logwork`.

Credentials stay local. Resource Optimiser passwords and 2FA codes, and Jira Personal Access Tokens, are entered in Terminal only, never in MCP config or AI chat.

## Install

Requirements:

- macOS or Windows 10/11
- Node.js 22+
- npm

Install globally:

```bash
npm install -g logwork-helper
```

Prepare the local runtime used by MCP configs:

```bash
logwork-helper setup-user
```

This creates the local Logwork Helper runtime (`~/.logwork-helper` on macOS, `%USERPROFILE%\.logwork-helper` on Windows), installs runtime dependencies there, links the terminal commands, and prints copy-ready MCP config snippets using your real local path.

## Update

Check npm for a newer release:

```bash
logwork-helper update check
```

Install the latest release after an interactive confirmation:

```bash
logwork-helper update install
```

The `logwork` terminal UI also shows a short notice when a newer release is available. Checks are cached for 24 hours and network errors never block logwork. Updating preserves OS credentials, project mappings, drafts, and apply history. Restart the terminal session and reconnect MCP clients after an update.

## Authenticate

Log in to Resource Optimiser from Terminal:

```bash
logwork-helper auth login
```

Follow the prompts for email, password, 2FA device, and 2FA code. The helper stores only the final Resource Optimiser session in your OS credential store: macOS Keychain on macOS, or Windows Credential Manager on Windows.

Check auth status:

```bash
logwork-helper auth status

## API Notes

- Read today bookings: `GET /member-logtime/timesheet`
- Read default tasks: `GET /logwork/tasks/defaults?project_id=<id>`
- Write logwork entry: `POST /logwork/entries`
- Payload shape:

```json
{
  "worklog_task_id": 79,
  "type_of_work": "create",
  "effort_hours": 1,
  "logdate": "2026-11-05",
  "project_id": 720,
  "description": "SAP-37"
}
```

For Jira self-hosted worklogs, create a Jira Personal Access Token in Jira, then save it from Terminal:

```bash
logwork-helper jira login
```

The default Jira URL is `https://jira-vnv.vinova.sg`. Override it with:

```bash
logwork-helper jira login --base-url https://jira.example.com
```

Check or delete Jira auth without printing the token:

```bash
logwork-helper jira status
logwork-helper jira logout
```

## Set Up MCP

The easiest way to get the right config is from the terminal UI:

```bash
logwork
```

Then type:

```text
/mcp
```

Choose your MCP client and copy the printed config. Supported clients:

- Cursor
- Google Antigravity
- GitHub Copilot / VS Code
- Claude Code
- Codex

You can also jump directly:

```text
/mcp cursor
/mcp antigravity
/mcp copilot
/mcp claude-code
/mcp codex
```

After saving the config, restart or reload your IDE MCP tools.

MCP assistants can use `check_for_updates`, then call `apply_update` only after showing the exact version and receiving explicit approval. A successful MCP update requires reconnecting the MCP server.

## Reminder

Enable a smart native notification at 17:00, Monday-Friday:

```bash
logwork-helper reminder enable
```

Test and inspect it:

```bash
logwork-helper reminder test
logwork-helper reminder status
```

The default target is Both. Resource Optimiser compares today's logged and booked hours; Jira checks whether the current user has any worklog today. Complete days stay silent. macOS uses a user `launchd` agent and Windows uses Task Scheduler; neither schedule stores credentials.

Customize or disable it:

```bash
logwork-helper reminder enable --time 18:00 --target ro
logwork-helper reminder disable
```

## Reconcile RO And Jira

Compare Resource Optimiser and Jira without writing either system:

```bash
logwork-helper reconcile this-week
logwork-helper reconcile last-month --json
```

The report shows booked, RO, and Jira hours by day. It also flags daily or issue-level mismatches. A correction suggestion is included only when an RO task contains exactly one Jira issue key; applying a suggestion still requires the normal target-specific preview and approval flow.

Inside `logwork`, run `/reconcile` to pick a period or use `/reconcile this-week` directly. MCP clients can call the read-only `reconcile_logwork` tool.

Verify from your assistant:

```text
Check my logwork for this week.
```

Full client examples are in [docs/mcp-setup.md](docs/mcp-setup.md).

## Edit Existing RO Logwork

Use the logwork entry ID returned by `query_logwork` or `/query`:

```bash
logwork-helper edit 290364 --hours 0.5
logwork-helper edit 290364 --task-name "Updated task name (SCB-470)"
logwork-helper edit 290364 --hours 0.5 --task-name "Updated task name (SCB-470)"
```

The CLI reads the existing entry, previews the diff, and asks for confirmation. `--yes` is available for an already reviewed non-interactive command. Project and date are always preserved. Before writing, the helper re-reads the entry and blocks the update if it changed after preview; it then verifies the persisted result. RO entries created by Jira must be edited in Jira and are blocked by this flow.

Inside `logwork`, use:

```text
/edit-logwork 290364 --hours 0.5
/edit-logwork 290364 --task-name Updated task name (SCB-470)
```

MCP clients use `preview_ro_logwork_edit`, show the field-level diff, ask for approval, then call `apply_ro_logwork_edit` with the cached `previewId` and `confirm: true`.

## Daily Use

Ask your assistant:

```text
Check whether I have logged anything today.
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

To log work directly from Terminal:

```bash
logwork
```

Inside the terminal UI, `/logwork` opens a target picker. Use `/logwork ro` for Resource Optimiser, `/logwork jira` for Jira worklogs, or `/logwork both` to preview/apply both with separate approvals.

Useful terminal commands:

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

## More Docs

- [Integrated operations guide](docs/operations-guide.md): complete CLI/MCP feature matrix, RO/Jira/Both processing examples, mapping, reconciliation, history, reminders, updates, release flow, and OS validation.
- [MCP setup](docs/mcp-setup.md): full client configs, exposed tools, verification prompts, and common MCP workflows.
- [Security and auth](docs/security.md): Keycloak flow, Jira PAT flow, OS credential storage, stored files, and safety model.
- [Advanced usage](docs/advanced.md): environment overrides, manual REPL details, updates, troubleshooting, legacy git hook, and release checks.
- [Quick recipes](docs/recipes.md): copy-ready RO, Jira, Both, auth recovery, duplicate handling, mapping, and history workflows.
- [Release checklist](RELEASE.md): publish and manual verification checklist.

## License

This project is proprietary and not open source. See [LICENSE](LICENSE).
