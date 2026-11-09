# logwork-cli

[npm version](https://www.npmjs.com/package/logwork-cli)
[license](LICENSE)

Log work to Resource Optimiser (RO) and self-hosted Jira from the terminal, from an MCP server for AI IDEs, or from a terminal UI.

One command, `logwork`, covers everything:

- `logwork`: the terminal UI.
- `logwork <command>`: one-shot commands such as `logwork query this-week` or `logwork edit 304032 --task "Bug Fix"`.
- `logwork mcp`: the MCP server that Cursor, Codex, Google Antigravity, GitHub Copilot / VS Code and Claude Code connect to.

Credentials stay local. Resource Optimiser passwords and 2FA codes, and Jira Personal Access Tokens, are entered in the terminal only. They never go into MCP config or AI chat.

## Install

Requirements: macOS or Windows 10/11, Node.js 22+, npm.

```bash
npm install -g logwork-cli
logwork setup
```

`logwork setup` does the following:
- installs the runtime to `~/.logwork-cli` (`%USERPROFILE%\.logwork-cli` on Windows),
- links the `logwork` command,
- offers to log in,
- prints copy-ready MCP configs that use your real local path.

## Upgrading from logwork-helper

The package was renamed from `logwork-helper` to `logwork-cli`, and the `logwork-helper` command no longer exists. Both packages install a `logwork` command, so remove the old one first (otherwise npm stops with `EEXIST`):

```bash
npm uninstall -g logwork-helper
npm install -g logwork-cli
logwork setup
```

Most of the move is automatic:

- **Old global package:** if it is still installed, `logwork setup` removes the global `logwork-helper` package before linking. You can also run `npx logwork-cli@latest setup` without uninstalling first.
- **`EEXIST ... bin/logwork` even after uninstalling:** the old package was linked from `~/.logwork-helper`. If that folder was deleted first, `npm uninstall` cannot remove its links. Remove the broken links, then install again:

  ```bash
  P="$(npm prefix -g)"
  rm -f "$P/bin/logwork" "$P"/bin/logwork-helper* "$P/lib/node_modules/logwork-helper"
  npm install -g logwork-cli && logwork setup
  ```

  `npx logwork-cli@latest setup` also removes those broken links (macOS).
- **Local state:** on the first run, settings, project mappings, drafts, apply history and the reminder config are copied from `~/.logwork-helper` to `~/.logwork-cli`. The old directory is left in place.
- **Login sessions:** your RO and Jira sessions are copied from the old Keychain / Credential Manager entry (`logwork-helper`) to the new one (`logwork-cli`), so you do not need to log in again.
- **Repo mappings:** a repo that has `.logwork-helper.json` keeps using it until a `.logwork.json` exists.
- **Reminder:** an enabled reminder is re-registered by `logwork setup`, and the old OS schedule is removed.

Two things you need to do yourself:

- **IDE config:** replace the old `logwork-helper` MCP entry with the new `logwork` entry printed by `logwork setup` or `/mcp`.
- **MCP tool names:** the tool names changed. See the [old → new tool name table](docs/mcp-setup.md#tool-name-changes-from-logwork-helper).

## Log In

```bash
logwork login              # Resource Optimiser: email, password, 2FA in this terminal
logwork login jira         # Jira Personal Access Token
logwork login jira --base-url https://jira.example.com
logwork status             # RO and Jira status, never prints tokens
logwork logout [ro|jira]
```

Sessions are stored in macOS Keychain or Windows Credential Manager. The default Jira URL is `https://jira-vnv.vinova.sg`.

## Commands

```text
logwork                 Open the terminal UI
logwork query [period]  Booked vs logged hours with entry ids (today, yesterday, this-week, last-week, this-month, last-month)
logwork commits [period] Draft logwork lines from your git commits (--repo, --author)
logwork quick [-m text] Log one entry for today with guided prompts
logwork edit <id> ...   Change an existing RO entry (replaces it)
logwork delete <id>     Delete a submitted or approved RO entry
logwork reconcile       Compare RO and Jira hours by day (read-only)
logwork history         Local apply history
logwork login|logout|status [ro|jira]
logwork skill install   Install the AI agent skill (Claude Code, Codex)
logwork setup           Install the runtime and print MCP configs
logwork mcp             Run the MCP stdio server (used by IDE configs)
logwork reminder ...    Weekday logwork reminder
logwork update ...      Check for or install a new version
logwork doctor          Write a sanitized diagnostics report
```

Add `--help` to any command for its options.

## Log Work From Your Commits

Most logwork is the work you committed. logwork turns your commits into draft lines, and the RO booking decides how many hours there are to fill.

```bash
logwork commits yesterday
logwork commits this-week --repo ~/code/portal --repo ~/code/api
```

How the draft is built:

- **Which commits:** your own (`git config user.email`, or `--author`) on every local and remote branch. Stashes and merge commits are skipped.
- **Grouping:** per day, by repo + ticket key + kind of work.
- **Worklog task:** chosen from the kind of work.

  | Commit | Worklog task |
  |---|---|
  | `feat` | Feature Development |
  | `fix`, hotfix | Bug Fix |
  | `refactor`, `perf`, review | Code Review & Refactoring |
  | `test` | Testing Activities |
  | `ci`, `build`, release, deploy | Deployment & Release |
  | `docs`, design | Requirements & Design |
  | `chore` | Other Activities |

  Conventional prefixes are used first, then keywords in the subject.
- **Hours:** each day's RO remaining time (booked − logged, per project) is split across the groups in 0.5h steps, weighted by commits and lines changed. Days without a booking get 0h. Without RO access, a weekday counts as 8h.

Nothing is written. Paste the draft into `/logwork`, or let your AI agent use it.

For agents:
- **MCP tool `draft_from_commits`** returns the same draft as `draftText`.
- **MCP prompt `log_from_commits`** gives an agent the full procedure:
  1. find gaps with `get_logwork`;
  2. draft from commits;
  3. check task names with `list_tasks`;
  4. rewrite vague descriptions;
  5. stay within booked hours;
  6. get your approval, then `log_work`.
- **Claude Code / Codex:** `logwork skill install` installs the same procedure as a skill, in `~/.claude/skills/logwork` and `~/.codex/skills/logwork`. For other agents, `logwork skill` prints it so you can paste it into your rules.

## Logwork Line Format

Every Resource Optimiser entry has a **worklog task** and a free-text **description**. The worklog task is an RO catalog item such as `Feature Development` or `Code Review & Refactoring`. Write each line as:

```text
Monday, 01 Jun 2026
+2 Feature Development | Implement maintenance mode management and status UI (SCB-213)
+1 Code Review & Refactoring | Review system page PR (SCB-214)
```

- **Before `|`:** the RO worklog task name, or `#<id>`. MCP clients can list valid names with `list_tasks`.
- **After `|`:** the description saved on the RO entry. Jira uses it as the worklog comment.
- **Lines without `|`:** these still work in two cases. If the whole text is a catalog task name, the entry is saved with no description and a warning. If the assistant passes `defaultWorklogTask`, that task is used and the text becomes the description.

The default tasks shared by all projects are:

| id | Task | type_of_work |
|---|---|---|
| 71 | Feature Development | create |
| 74 | Bug Fix | correct |
| 182 | Code Review & Refactoring | improve |
| 79 | Deployment & Release | create |
| 181 | Requirements & Design | create |
| 183 | Testing Activities | create |
| 111 | Other Activities | other |

## API Notes

- Read bookings: `GET /member-logtime/timesheet`
- Read worklog tasks: `GET /logwork/tasks?project_id=<id>` and `GET /logwork/tasks/defaults?project_id=<id>`
- Write an entry: `POST /logwork/entries`
- Delete an entry: `DELETE /logwork/entries/:id`
- Resubmit a rejected entry: `PATCH /logwork/entries/:id/resubmit`

```json
{
  "worklog_task_id": 71,
  "type_of_work": "create",
  "effort_hours": 2,
  "logdate": "2026-06-01",
  "project_id": 720,
  "description": "Implement maintenance mode management and status UI (SCB-213)"
}
```

`project_id` is sent only when the worklog task is a shared default task.

## Set Up MCP

`logwork setup` prints the configs. You can also open the terminal UI with `logwork` and type `/mcp` (or `/mcp cursor`, `/mcp antigravity`, `/mcp copilot`, `/mcp claude-code`, `/mcp codex`).

Every client runs the same thing, `<node> ~/.logwork-cli/bin/logwork.mjs mcp`, under the server name `logwork`. The printed configs use the absolute path of your Node binary, because IDEs started from the Dock or Finder often do not see nvm's `node` on `PATH`:

```json
{
  "mcpServers": {
    "logwork": {
      "command": "/Users/you/.nvm/versions/node/v24.1.0/bin/node",
      "args": ["/Users/you/.logwork-cli/bin/logwork.mjs", "mcp"]
    }
  }
}
```

For Claude Code, run:

```bash
claude mcp add --transport stdio logwork -- "$(which node)" ~/.logwork-cli/bin/logwork.mjs mcp
```

If you upgrade or remove that Node (`nvm uninstall`, `brew upgrade node`), re-run `logwork setup` and paste the new config. `logwork doctor` warns when the recorded Node path is gone.

Restart or reload the IDE's MCP tools after saving.

The server exposes 16 tools and one prompt (`log_from_commits`). It also sends `instructions` covering the approval rules, the line format and the recommended call order. Every write is **two calls to the same tool**:
1. Call the tool without `confirm`. It returns a preview with a `batchId` or `previewId` and a summary.
2. After the user approves, call the same tool again with only that id and `confirm: true`.

See [docs/mcp-setup.md](docs/mcp-setup.md#exposed-tools) for the tool table.

Verify from your assistant:

```text
Check my logwork for this week.
```

## Edit Existing RO Logwork

Get the entry id from `logwork query` (or `get_logwork` in MCP), then:

```bash
logwork edit 304032 --hours 0.5
logwork edit 304032 --desc "Fix date picker timezone (SAP-42)"
logwork edit 304032 --task "Bug Fix" --desc "Fix date picker timezone (SAP-42)"
logwork edit 304032 --task "#74" --type correct
```

Options:
- `--hours`
- `--task`: a worklog task from the project catalog, or `#<id>`.
- `--desc`
- `--type`: `create`, `correct`, `improve` or `other`. When the task changes and `--type` is omitted, the new task's catalog type is used.

The long forms `--task-name` and `--description` also work. Project and date are always preserved.

Resource Optimiser has no staff API for editing an entry; the edit endpoint is PM-only. So apply **replaces** the entry:

1. It re-reads the entry and stops if the entry changed after the preview.
2. It creates the corrected entry with `POST /logwork/entries`.
3. It deletes the original with `DELETE /logwork/entries/:id`.
4. It verifies the new entry.

If the create fails, the original is untouched. If the delete fails, the new entry is deleted again, so nothing changes.

Deleting on RO needs no approval, and a correctly formatted new entry is approved immediately, so the edit takes effect at once. The new entry gets a **new logwork id**.

Some entries cannot be edited this way:
- Only `submitted` or `approved` entries can be edited.
- Rejected entries are fixed with `resubmit_entry`.
- Entries on locked days, entries created by Jira, and entries owned by another user are blocked.

The CLI previews the diff and asks for confirmation. Use `--yes` for an already reviewed non-interactive command.

In the terminal UI: `/edit-logwork 304032 --task Bug Fix --desc Fix date picker timezone (SAP-42)`.

In MCP, call `edit_entry` with `logworkId` and the changes, show the summary, then call `edit_entry` with `previewId` and `confirm: true`. The result returns `originalLogworkId` and `newLogworkId`.

## Daily Use

Ask your assistant:

```text
Check whether I have logged anything today.
```

```text
Preview this logwork and ask for my approval before submitting:
Monday, 01 Jun 2026
+2 Feature Development | Maintenance mode management and status UI (SCB-213)
```

```text
Set up the SCB ticket mapping to project 2621A-SIT-HTML BUILDER-PRJ.
```

From the terminal:

```bash
logwork quick -m "Fix login bug (SCB-12)"   # one entry for today
logwork                                      # terminal UI
```

In the terminal UI, `/logwork` opens a target picker. `/logwork ro` writes Resource Optimiser entries, `/logwork jira` writes Jira worklogs, and `/logwork both` previews and applies both with separate approvals. Type `/` to see every command, for example:
- `/query this-week`
- `/reconcile`
- `/projects`
- `/map SCB 5234`
- `/history`
- `/diagnostics`

## Reminder

```bash
logwork reminder enable                 # 17:00 Monday-Friday, RO and Jira
logwork reminder enable --time 18:00 --target ro
logwork reminder enable --repo ~/code/app --repo ~/code/api   # add commit evidence
logwork reminder test
logwork reminder status
logwork reminder disable
```

For Resource Optimiser, the reminder compares today's logged and booked hours. For Jira, it checks whether you have any worklog today. Complete days stay silent.

With `--repo` (repeatable; `--no-repos` clears the list), a reminder about missing RO hours also counts your commits today in those repos and points you to a draft:

```text
Logwork hôm nay chưa hoàn tất
RO: 4/8h, còn thiếu 4h
Hôm nay: 5 commit trong 2 repo

Mở Terminal và chạy: logwork commits today (bản nháp từ commit)
```

Repos listed on project mappings are used too. Run outside a git repo, `logwork commits today` falls back to these repos. If reading commits fails, the reminder shows the plain message.

macOS uses a user `launchd` agent (`sg.vinova.logwork-cli.reminder`) and Windows uses Task Scheduler (`Logwork Reminder`). Neither schedule stores credentials. The schedule stores the absolute Node path; after upgrading or removing that Node, run `logwork reminder enable` (or `logwork setup`) again. `logwork reminder status` warns when that path no longer exists.

## Reconcile RO And Jira

```bash
logwork reconcile this-week
logwork reconcile last-month --json
```

This is read-only. It shows booked, RO and Jira hours by day and flags mismatches. A correction suggestion is included only when an RO entry contains exactly one Jira issue key. Applying a suggestion still goes through the normal preview and approval flow. MCP clients use the `reconcile` tool.

## Update

```bash
logwork update check
logwork update install
```

The terminal UI shows a short notice when a newer release is available. Checks are cached for 24 hours, and network errors never block logwork.

Updating keeps OS credentials, project mappings, drafts and apply history. Reconnect MCP clients after an update.

## More Docs

- [Operations guide](docs/operations-guide.md): CLI/MCP feature map, RO/Jira/Both processing, mapping, reconciliation, history, reminders, updates and OS validation.
- [MCP setup](docs/mcp-setup.md): client configs, the tool table, the old → new tool names, and common workflows.
- [Security and auth](docs/security.md): Keycloak flow, Jira PAT flow, OS credential storage, stored files and the safety model.
- [Advanced usage](docs/advanced.md): environment overrides, terminal UI details, troubleshooting and release checks.
- [Quick recipes](docs/recipes.md): copy-ready workflows.
- [Release checklist](RELEASE.md).

## License

This project is proprietary and not open source. See [LICENSE](LICENSE).
