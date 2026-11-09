# Integrated Operations Guide

This guide describes the complete Resource Optimiser and Jira workflow available through the terminal CLI and MCP server. It also covers project mapping, reconciliation, apply history, native reminders, self-update, and release checks.

## Initial Setup

Requirements:

- macOS or Windows 10/11.
- Node.js 22 or newer.
- npm.
- A Resource Optimiser account.
- A Jira Personal Access Token when Jira features are used.

Install and prepare the stable local runtime:

```bash
npm install -g logwork-cli
logwork setup
```

Upgrading from `logwork-helper`: run `npm uninstall -g logwork-helper` first. Both packages provide a `logwork` command, and npm refuses to overwrite it (`EEXIST`). If `~/.logwork-helper` was already deleted, the uninstall leaves broken links behind; remove them with `P="$(npm prefix -g)"; rm -f "$P/bin/logwork" "$P"/bin/logwork-helper* "$P/lib/node_modules/logwork-helper"`, or run `npx logwork-cli@latest setup`, which removes them.

Authenticate each target from Terminal:

```bash
logwork login
logwork login jira
```

Check both sessions without printing credentials:

```bash
logwork status
```

Upgrading from `logwork-helper`: see [Upgrading from logwork-helper](../README.md#upgrading-from-logwork-helper).

Resource Optimiser credentials and Jira PATs are never accepted by MCP tools. The final sessions are stored in macOS Keychain or Windows Credential Manager.

## Capability Map

| Operation | Terminal CLI | `logwork` UI | MCP tool | Writes external data |
| --- | --- | --- | --- | --- |
| Query RO | `logwork query` | `/query <period>` | `get_logwork` | No |
| Log RO | `logwork quick` (one entry) | `/logwork ro` | `log_work` | Apply call only |
| Edit existing RO entry | `logwork edit` | `/edit-logwork` | `edit_entry` | Apply call only |
| Resubmit rejected RO | - | - | `resubmit_entry` | Apply call only |
| Delete RO entry | `logwork delete` | - | `delete_entry` | Apply call only |
| Log Jira | - | `/logwork jira` | `log_jira_work` | Apply call only |
| Log Both | - | `/logwork both` | `log_work` + `log_jira_work` separately | Apply calls only |
| Project mapping | - | `/projects`, `/map`, `/map --repo` | `list_projects`, `map_project` | Local config only |
| RO worklog task catalog | - | - | `list_tasks` | No |
| Reconcile RO/Jira | `logwork reconcile` | `/reconcile` | `reconcile` | No |
| Apply history | `logwork history` | `/history` | `get_history` | No |
| Reminder | `logwork reminder` | - | `reminder` (`action`) | OS schedule only |
| Update | `logwork update` | Startup notice | `update` (`action`) | Local runtime only |
| Login | `logwork login\|logout\|status` | `/auth`, `/status` | `login` (explains terminal login) | OS credential store |
| Diagnostics | `logwork doctor` | `/diagnostics` | - | Local file only |
| Release preflight | `logwork release doctor` | - | - | No |

MCP writes are two calls to the same tool. The first call, without `confirm`, returns a preview with a `batchId` or `previewId`. The second call passes that id with `confirm: true`. An apply call that also carries content fields is rejected.

All apply, mapping, reminder configuration, reminder test, and update operations require explicit confirmation. Query, preview, reconciliation, history, status, and update check operations are read-only.

## Target Routing

### Resource Optimiser

Use the RO flow when the intent is Resource Optimiser logwork:

```text
/logwork ro
```

MCP uses:

1. `list_projects` and `list_tasks`, to choose a valid worklog task.
2. `log_work` with `text`, which returns the preview.
3. `log_work` with `batchId` and `confirm: true`, after approval.

RO resolves each task to a project using the approved preview override, local ticket/keyword mappings, booked projects, and available project memberships. Jira is not written by this flow.

Creating new RO logwork uses `POST /logwork/entries`. Every RO entry has two text parts:

- **Worklog task**: a catalog item from `GET /logwork/tasks` and `/logwork/tasks/defaults` for the matched project (for example `Feature Development`, `Code Review & Refactoring`). Sent as `worklog_task_id`.
- **Description**: free text describing the actual work (for example `Implement maintenance mode UI (SCB-213)`). Sent as `description`.

Write each line as `+<hours> <worklog task> | <description>`. The worklog task must match the RO catalog name exactly (case-insensitive) or be written as `#<id>`. A line without `|` is treated as a catalog task name when it matches one (no description is written and the preview warns); otherwise it becomes the description under MCP `defaultWorklogTask`, or the entry stays unresolved with reason `worklog_task_required` and `availableTaskNames`. **Worklog task** (catalog) is not the same as **type of work** (`create`, `correct`, `improve`, `other`) on the log entry.

New entries default to `type_of_work: other` when the matched catalog task has no `type_of_work`. When the RO task row defines `type_of_work`, preview copies it onto the entry unless MCP `typeOfWork` overrides the whole batch.

The optional `log_work` preview input `typeOfWork` applies to every line in the batch and overrides per-task catalog defaults.

The optional `log_work` preview input `defaultWorklogTask` (name or `#<id>`) supplies the worklog task for lines without `|` that are not catalog task names. The `batchId` includes this value and every description, so approval always covers the exact payload.

### Staff API surface (F03 vs legacy)

| Intent | HTTP | Used by helper |
| --- | --- | --- |
| Create entry (approved) | `POST /logwork/entries` | `log_work`, `logwork quick` |
| List worklog tasks | `GET /logwork/tasks`, `/logwork/tasks/defaults` | Batch preview task resolution |
| Day view (status, lock) | `GET /logwork/day` | `get_logwork` entry enrichment, edit reads |
| Weekly summary | `GET /logwork/weekly` | Available in API client; booked hours still come from legacy timesheet |
| Rejected list | `GET /logwork/rejected` | Optional query enrichment (`includeRejected` when wired) |
| Resubmit rejected | `PATCH /logwork/entries/:id/resubmit` | `resubmit_entry` |
| Delete submitted/approved | `DELETE /logwork/entries/:id` | `delete_entry`, `logwork delete` |
| Booked + logged range | `GET /member-logtime/timesheet` | `get_logwork`, batch booked-project resolution |
| Day task detail | `GET /member-logtime` | `get_logwork` entry lines |
| Edit hours/task/type/description | `POST /logwork/entries` then `DELETE /logwork/entries/:id` (replace) | `edit_entry`, `logwork edit` |

RO F03 has no staff edit endpoint. `PATCH /logwork/pm/entries/:id/edit-approve` is PM-only, so the helper edits by replacing the entry. The legacy `PATCH /member-logtime` `update_data` is no longer used by the edit flow. It only changed the `task_name` text and never remapped `worklog_task_id` or `description`.

### Edit Existing Resource Optimiser Logwork

Use the logwork entry ID returned by an RO query:

```bash
logwork edit 304032 --hours 0.5
logwork edit 304032 --task "Bug Fix" --desc "Fix date picker timezone (SAP-42)"
logwork edit 304032 --type improve
```

The long forms `--task-name` and `--description` are also accepted. The terminal UI equivalent is:

```text
/edit-logwork 304032 --hours 0.5 --task Bug Fix --desc Fix date picker timezone (SAP-42)
```

MCP uses two calls to `edit_entry`:

1. A preview call with `logworkId` and at least one of `hours`, `taskName` (catalog name or `#<id>`), `description`, or `typeOfWork`.
2. An apply call with the returned `previewId` and `confirm: true`.

How the edit is processed:

1. **Read.** The legacy `GET /member-logtime/:id` returns the date, owner, and Jira link. `GET /logwork/day?date=` returns the F03 fields: status, `worklog_task_id`, `type_of_work`, and `description`. The project-member list maps `project_member_id` to `project_id`.
2. **Resolve.** The worklog task is resolved against `GET /logwork/tasks` plus `/logwork/tasks/defaults` for the project. When the task changes and `typeOfWork` is omitted, the new task's catalog `type_of_work` is used. Otherwise the current type is kept.
3. **Apply.** It re-checks the original revision, then:
   - creates the corrected entry with `POST /logwork/entries`;
   - deletes the original with `DELETE /logwork/entries/:id`;
   - verifies the new entry.

   If the create fails, nothing changed. If the delete fails, the new entry is deleted again (rollback). If that rollback also fails, the error names both ids.

   If the create response has no id, the new entry is looked up in `/logwork/day`. If it still can't be found, the original is **not** deleted.

Deleting needs no PM approval and the new entry is approved immediately, so the edit takes effect at once. The `is_locked: true` flag RO puts on approved entries does not block the delete. Only a locked day (`isLocked` from `/logwork/day`) blocks an edit. The result returns `originalLogworkId` and `newLogworkId`. Project and date never change.

These entries are blocked:
- rejected entries (use resubmit),
- entries on locked days,
- entries owned by another user,
- entries created by Jira.

In dry run (`LOGWORK_DRY_RUN=1`), apply returns both requests without writing.

### Delete mistaken Resource Optimiser logwork

Use the entry ID from `logwork query`, `get_logwork`, or the RO UI. Only **submitted** or **approved** entries can be soft-deleted. **Rejected** entries must be resubmitted instead (`resubmit_entry`). Deleting needs no PM approval.

```bash
logwork delete 290364
logwork delete 290364 --yes --json
```

MCP uses two calls to `delete_entry`:

1. A preview call with `logworkId`.
2. An apply call with the returned `previewId` and `confirm: true`.

The apply call re-checks the entry revision before sending `DELETE`.

The API call is `DELETE /logwork/entries/:id` (soft-delete via `deleted_date`).

### Jira

Use the Jira flow when the intent is a Jira worklog:

```text
/logwork jira
```

MCP uses:

1. `log_jira_work` with `text`, which returns the preview.
2. `log_jira_work` with `batchId` and `confirm: true`, after approval.

Every entry must contain exactly one Jira issue key. RO is not written by this flow.

In dry run (`LOGWORK_DRY_RUN=1`), the Jira apply still reads Jira for the duplicate check but sends no worklog. It returns `status: "dry_run"` with the request each entry would send, and the summary starts with `DRY RUN`. Apply history records it as `dry_run`, not as submitted.

### Both

Use the combined terminal flow when the same date/tasks should be sent to both systems:

```text
/logwork both
```

The flow creates two independent previews and requests two approvals:

1. Preview and optionally apply Resource Optimiser.
2. Preview and optionally apply Jira.

The operation is not atomic. If RO succeeds and Jira fails, RO is not rolled back. Apply history records the result of each target with `flowTarget: both` so partial outcomes remain visible.

MCP has no unified Both tool. The assistant previews with both `log_work` and `log_jira_work`, presents both summaries, and requests approval for each apply separately.

## Input Format

MCP and pasted weekly text use date headings followed by one task per line:

```text
Monday, 13 Jul 2026
+2 Feature Development | Maintenance mode management (SCB-213)
+1 Feature Development | Update system page (SCB-214)
Tuesday, 14 Jul 2026
+1.5 Bug Fix | Fix password reset regression (SCB-215)
```

Rules:

- A date heading uses `Weekday, DD Mon YYYY`.
- A task uses `+<hours> <worklog task> | <description>`. Only the first `|` splits the line.
- For RO, `<worklog task>` must be an RO catalog task (`list_tasks`) and `<description>` is stored as the entry description.
- For Jira, `<worklog task>` is ignored and `<description>` becomes the worklog comment. Lines without `|` use the whole text.
- Hours must be greater than zero and may be decimal.
- RO can accept entries without a Jira issue key when a project can still be resolved.
- Jira requires exactly one key such as `SCB-213` in every entry.
- Jira blocks entries with no key or multiple keys.

The terminal wizard selects one date for the current session. It accepts the same task line format without requiring a pasted date heading.

## Resource Optimiser Processing Example

Input:

```text
Monday, 13 Jul 2026
+2 Feature Development | Maintenance mode management (SCB-213)
+1 Feature Development | Update system page (SCB-214)
```

Processing:

1. Parse the date, hours, worklog task, description, and issue keys.
2. Load booked RO projects and project memberships for the date.
3. Apply user/project ticket and keyword mappings (matched against the whole line).
4. Resolve the worklog task in the project catalog and attach `worklogTaskId` and `description`.
5. Mark each entry as resolved, resolved but unbooked, or unresolved.
6. Return an approval summary. No work is submitted during preview.

Illustrative ready preview:

```text
Logwork preview:
- 2026-07-13: +2h 2621A-SIT-HTML BUILDER-PRJ - Feature Development | Maintenance mode management (SCB-213) (via config_ticket, confidence 1)
- 2026-07-13: +1h 2621A-SIT-HTML BUILDER-PRJ - Feature Development | Update system page (SCB-214) (via config_ticket, confidence 1)
Approval checklist: 2 entries, 3h total, 2026-07-13.
Projects: 2621A-SIT-HTML BUILDER-PRJ: 3h.
Ready to apply.
```

After explicit approval, the apply result is similar to:

```text
Logwork submitted:
Submitted 2 entries, 3h total.
- 2026-07-13: +2h 2621A-SIT-HTML BUILDER-PRJ - Feature Development | Maintenance mode management (SCB-213)
- 2026-07-13: +1h 2621A-SIT-HTML BUILDER-PRJ - Feature Development | Update system page (SCB-214)
```

If a valid membership is not booked for the selected date, preview prefixes the entry with `UNBOOKED`. Applying it requires a second decision through `allowUnbooked: true`. An unresolved project always blocks apply.

Preview also reads the RO entries of each date. An entry with the same worklog task, hours and description as an existing entry (or an earlier line of the batch) gets a `WARNING possible duplicate` line. Applying it requires a separate decision: `allowDuplicates: true`, or a yes to the duplicate question in the terminal UI. Without it, nothing is written. If the day cannot be read, the preview notes that the duplicate check was skipped and does not block.

## Jira Processing Example

For each entry, Jira preview:

1. Extracts exactly one issue key.
2. Calls Jira to validate issue existence and access.
3. Loads existing issue worklogs.
4. Blocks duplicates by helper marker or by matching issue, date, duration, and normalized task comment.
5. Builds and stores the exact approved payload.

Illustrative ready preview:

```text
Jira worklog preview: ready. 2 entries, 3h total.
Counts: ready 2, duplicate 0, missing ticket 0, multiple tickets 0, lookup failed 0.
- 2026-07-13: +2h SCB-213 - Maintenance mode management (SCB-213) -> ready
  Issue: Maintenance mode management [In Progress]
  Started: 2026-07-13T09:00:00.000+0700
  Comment: Maintenance mode management (SCB-213) | #lh:8f3a91c0
- 2026-07-13: +1h SCB-214 - Update system page (SCB-214) -> ready
  Issue: System page update [To Do]
  Started: 2026-07-13T09:00:00.000+0700
  Comment: Update system page (SCB-214) | #lh:9b18d721
```

The marker hashes above are examples. The real hash is generated from the approved batch and entry identifiers.

The Jira REST payload for the first entry is equivalent to:

```json
{
  "started": "2026-07-13T09:00:00.000+0700",
  "timeSpentSeconds": 7200,
  "comment": "Maintenance mode management (SCB-213)\n\n#lh:8f3a91c0"
}
```

The request uses `adjustEstimate=leave`, so Jira remaining estimate is not changed. The default started time is 09:00 in `Asia/Ho_Chi_Minh`; it can be configured with `LOGWORK_JIRA_STARTED_TIME` and `LOGWORK_TIMEZONE`.

After approval, Jira reports each entry independently:

```text
Jira worklog apply: submitted 2, failed 0.
- 2026-07-13: SCB-213 +2h -> submitted
- 2026-07-13: SCB-214 +1h -> submitted
```

In Jira, the issue worklog displays the current Jira user, logged duration, started date/time, and the comment on two lines:

```text
Maintenance mode management (SCB-213)

#lh:8f3a91c0
```

The shorter `#lh:<hash>` marker replaces the old visible `[logwork-helper:...]` format from earlier versions. Existing worklogs with the legacy marker are still recognized during duplicate checks.

## Duplicate And Preview Safety

RO and Jira MCP previews are cached for one hour, with at most 100 previews per target, and are lost when the server restarts. Apply requires the cached `batchId` or `previewId`. A missing, expired, consumed, or modified preview must be generated again.

Jira duplicate detection is blocking and has no override. Apply rechecks worklogs immediately before the first write. If a duplicate appears after preview, the Jira batch is blocked before submission.

If a Jira API write fails after earlier entries were submitted, processing stops and the result identifies the submitted entries and the failed entry. Remaining entries are not attempted. The helper never reports a partial batch as fully successful.

## Project Mapping And Similar Content

RO project mapping can use:

- Jira ticket prefixes, for example `SCB`.
- Task keywords, for example `maintenance mode`.
- Explicit project selection during preview.
- Jira project key/name metadata in the terminal Both flow to rank RO memberships.
- Git repo roots (`repos`), for commit drafts.

A repo with no mapping is mapped once, in place, without ids:
- `logwork commits` in an interactive terminal asks `Which RO project does <repo> belong to?` with the likely project preselected, saves the choice and redoes the draft (`--no-prompt` turns this off).
- In the terminal UI, `/map --repo [path]` opens the same picker; `/map --repo [path] <project name>` maps by name (case-insensitive, then a unique part of the name; an ambiguous name opens the picker).
- MCP: `draft_from_commits` returns `repoSuggestions` per unmapped repo; the assistant confirms the top one by name and calls `map_project` with `projectName` and `repos`.

The likely project comes from ticket keys in the repo's commits that you logged to a project in the last 30 days, then the repo folder or git remote name against the project name (acronym in parentheses, initials, shared words), then the only project booked on the repo's commit days.

Example MCP sequence:

1. `get_jira_issue` reads `SCB-213` metadata.
2. `list_projects` lists valid RO memberships.
3. The assistant compares Jira project metadata and task wording with RO project names/mappings.
4. The assistant shows the proposed project and asks for approval.
5. `map_project` stores the selected ticket/keyword mapping with `confirm: true`.
6. The assistant reruns RO preview.

Example mapping:

```json
{
  "projectMappings": [
    {
      "projectName": "2621A-SIT-HTML BUILDER-PRJ",
      "projectMemberId": 5234,
      "tickets": ["SCB"],
      "keywords": ["maintenance mode", "system page"]
    }
  ]
}
```

Content similarity is a suggestion, not an automatic write. The built-in Both flow ranks exact/contained Jira project names, Jira project keys, and meaningful name-token overlap. An MCP assistant can also reason over issue/task text, but it must choose from real RO memberships and obtain confirmation before saving a mapping.

## Reconciliation

Reconciliation compares RO and Jira without writing either system:

```bash
logwork reconcile this-week
logwork reconcile last-month --json
```

Supported periods are `today`, `yesterday`, `this-week`, `last-week`, `this-month`, and `last-month`. Custom date inputs are intentionally not supported. The displayed `to` date is the exclusive end of the queried range.

Example summary:

```text
RO / Jira reconciliation: this week (2026-07-13 to 2026-07-20).

Date        Booked      RO    Jira    Diff  Status
2026-07-13       8h       7h       6h      -1h  Task mismatch
2026-07-14       8h       8h       8h       0h  Matched

Total: booked 16h, RO 15h, Jira 14h, difference -1h.
Days: matched 1, mismatched 1, incomplete 0, unverified 0.

High-confidence correction suggestions:
- 2026-07-13: JIRA +1h SCB-214 - Update system page (SCB-214)
Create a normal target-specific preview before applying any suggestion.
```

A correction suggestion is generated only when task-level evidence is strong, including exactly one Jira issue key. It is never applied directly. Use the normal target preview and approval flow.

## Apply History

RO and Jira workflow apply outcomes, including submitted, partial, failed, and preview-blocked batches, record a sanitized local result:

```bash
logwork history
logwork history --target jira --limit 10
logwork history --target both --json
```

Example:

```text
Apply history: 2 records.
- 2026-07-15T13:10:00.000Z: jira via both submitted, batch jira_abcd, submitted 2, failed 0, blocked 0, 3h.
- 2026-07-15T13:09:00.000Z: ro via both submitted, batch batch_efgh, submitted 2, failed 0, blocked 0, 3h.
```

The ledger stores sanitized task/project/issue/result metadata. It does not store tokens, cookies, raw API responses, passwords, or OTPs.

## Native OS Reminder

Enable the default Both reminder at 17:00, Monday-Friday:

```bash
logwork reminder enable
```

Other operations:

```bash
logwork reminder enable --time 18:00 --target ro
logwork reminder enable --repo ~/code/app --repo ~/code/api
logwork reminder enable --no-repos
logwork reminder status
logwork reminder test
logwork reminder disable
```

Behavior:

- RO compares today's logged hours with booked hours.
- Jira checks whether the current Jira user has any worklog today.
- A complete day stays silent.
- At most one notification is sent per configured workday.
- Missing auth produces an actionable notification without exposing API details.
- macOS uses a user `launchd` agent (`sg.vinova.logwork-cli.reminder`).
- Windows uses an interactive user Task Scheduler task (`Logwork Reminder`).
- The scheduler runs `<absolute node path> ~/.logwork-cli/bin/logwork.mjs reminder run --home ~/.logwork-cli`, using the Node that ran `reminder enable` or `logwork setup`.
- If that Node is removed or replaced (`nvm uninstall`, `brew upgrade node`), the schedule still looks installed but cannot run. `logwork reminder status` and `logwork doctor` warn about it; run `logwork reminder enable` or `logwork setup` to re-register it with the current Node.
- Enabling or disabling the reminder also removes a leftover `logwork-helper` schedule.

Commit evidence:

- `--repo <path>` (repeatable) saves git repos in `reminder.json` as absolute paths. MCP: `reminder` with `action: "enable"` and `repos`. `--repo` or `repos` replaces the saved list, `--no-repos` or `repos: []` clears it, and leaving them out keeps it.
- Repos listed in a project mapping's `repos` field are added.
- When RO hours are missing, the reminder reads your commits today in those repos (read-only, the same reader as `logwork commits`, without another RO query) and adds `Hôm nay: <n> commit trong <k> repo`. The action line then points to `logwork commits today`.
- Run outside a git repo, `logwork commits today` falls back to the reminder repos.
- With no repos, no commits today, or any error reading them (missing repo, git not on the scheduler's `PATH`, a 20-second timeout), the plain message is shown.
- The notification stays a plain OS notification on both platforms (macOS `display notification`, a Windows toast). It has no buttons; open a terminal and run the command shown.

Example Both notification:

```text
Logwork hôm nay chưa hoàn tất
RO: 6/8h, còn thiếu 2h
Jira: chưa có worklog hôm nay

Mở Terminal và chạy: logwork
```

With reminder repos and commits today:

```text
Logwork hôm nay chưa hoàn tất
RO: 4/8h, còn thiếu 4h
Jira: chưa có worklog hôm nay
Hôm nay: 5 commit trong 2 repo

Mở Terminal và chạy: logwork commits today (bản nháp từ commit)
```

`logwork reminder test` sends a sample in this format.

The notification text is localized in Vietnamese. The OS schedule stores only fixed Node/script paths and reads credentials from the OS credential store when it runs.

## End-User Updates

Check the running version against npm latest:

```bash
logwork update check
logwork update check --force
```

Install after confirmation:

```bash
logwork update install
```

For a non-interactive terminal, approve the exact published version:

```bash
logwork update install --version 0.1.11 --yes
```

The updater:

- Uses npm's official registry.
- Accepts only the package's current `latest` SemVer.
- Rechecks npm immediately before installation.
- Copies and verifies the stable local MCP runtime.
- Preserves credentials, mappings, drafts, history, and reminder config.

Restart the terminal and reconnect MCP after a successful update. MCP exposes the same process through `update` with `action: "check"`, then `action: "install"` with `confirm: true`.

## Maintainer Release Flow

Update both `package.json` and `package-lock.json` with npm:

```bash
npm version patch --no-git-tag-version
```

Use `minor` or `major` instead of `patch` when required by SemVer. Then run:

```bash
npm run release:check
```

Commit and sync the version change so the release doctor can verify a clean `main`:

```bash
git add package.json package-lock.json
git commit -m "bump version to <version>"
git push origin main
logwork release doctor --full
```

After the release doctor passes:

```bash
npm publish --access public
git tag v<version>
git push origin v<version>
gh release create v<version> --generate-notes --title "v<version>"
```

The release doctor checks package version consistency, self-dependencies, clean/synced `main`, npm registry/auth/latest, GitHub auth, tag/release state, tarball artifacts, tests, production audit, package dry run, and whitespace.

## Local State And Credentials

| State | macOS/Windows helper-home filename | Sensitive credentials |
| --- | --- | --- |
| Installed runtime | `.logwork-cli/` | No |
| User project mappings | `.logwork-cli/.logwork.json` | No |
| Manual drafts | `.logwork-cli/manual-drafts.json` | No |
| Apply history | `.logwork-cli/apply-ledger.json` | No |
| Update cache | `.logwork-cli/update-state.json` | No |
| Reminder config/state | `.logwork-cli/reminder.json`, `.logwork-cli/reminder-state.json` | No |
| Runtime Node record | `.logwork-cli/runtime.json` (Node path and version from `logwork setup`) | No |
| RO/Jira sessions | OS credential store, service `logwork-cli` | Yes |

The helper home is `~/.logwork-cli` on macOS and `%USERPROFILE%\.logwork-cli` on Windows. `LOGWORK_HOME` overrides it; the older `LOGWORK_HELPER_HOME` is still honored.

Migration from `logwork-helper` happens on the first run, unless `LOGWORK_HOME` (or `LOGWORK_HELPER_HOME`) is set:
- State files are copied once from `~/.logwork-helper`, and `.logwork-helper.json` is renamed to `.logwork.json` on the way. The old directory is left in place. A marker file (`.migrated-from-logwork-helper`) records the copy.
- Credentials still stored under the old service name (`logwork-helper`) are read once and copied to `logwork-cli`.
- Logging out clears both credential entries.

## Validation

Run the cross-platform suite:

```bash
npm run lint
npm test
npm run test:coverage   # same suite with coverage thresholds; CI runs it on macOS
git diff --check
npm pack --dry-run
```

Windows CI additionally runs a real Credential Manager lifecycle test:

```powershell
npm run test:windows-credential
```

That integration test stores, reads, and deletes a dedicated test credential. On non-Windows systems it is skipped by design.

Recommended end-user checks after installation:

1. Run `logwork --version` and `logwork update check --force`.
2. Run `logwork status`.
3. Open `logwork` and preview one RO task without applying.
4. Preview one Jira task with exactly one issue key without applying.
5. Run `logwork reconcile this-week`.
6. Run `logwork reminder test`, verify the native notification, then inspect `reminder status`.
7. Connect MCP and verify the tool list before testing read-only queries.

## Recovery Rules

- Missing RO auth: run `logwork login`.
- Missing Jira auth: run `logwork login jira`.
- Unresolved RO project: list memberships, confirm a mapping, and preview again.
- Jira duplicate: inspect the existing worklog; there is no override.
- Expired or consumed preview: preview again and request approval again.
- Partial Both result: inspect `/history both`, then preview only the missing target.
- npm `E401`: refresh npm login with `npm login --registry=https://registry.npmjs.org/`.
- Reminder config/scheduler mismatch: rerun `reminder enable` or `reminder disable`.
- Reminder or MCP Node path gone after a Node upgrade: run `logwork setup` (refreshes `runtime.json`, the reminder and the printed MCP configs), then paste the new MCP config.
- MCP after update: restart or reload the MCP connection.

For client configuration details, see [MCP setup](mcp-setup.md). For security boundaries and stored-data details, see [Security and auth](security.md). For copy-ready task recipes, see [Quick recipes](recipes.md).
