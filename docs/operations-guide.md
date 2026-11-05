# Integrated Operations Guide

This guide describes the complete Resource Optimiser and Jira workflow available through the terminal CLI and MCP server. It also covers project mapping, reconciliation, apply history, native reminders, self-update, and release checks.

## Initial Setup

Requirements:

- macOS or Windows 10/11.
- Node.js 20 or newer.
- npm.
- A Resource Optimiser account.
- A Jira Personal Access Token when Jira features are used.

Install and prepare the stable local runtime:

```bash
npm install -g logwork-helper
logwork-helper setup-user
```

Authenticate each target from Terminal:

```bash
logwork-helper auth login
logwork-helper jira login
```

Check both sessions without printing credentials:

```bash
logwork-helper auth status
logwork-helper jira status
```

Resource Optimiser credentials and Jira PATs are never accepted by MCP tools. The final sessions are stored in macOS Keychain or Windows Credential Manager.

## Capability Map

| Operation | Terminal CLI | `logwork` UI | MCP tool | Writes external data |
| --- | --- | --- | --- | --- |
| Query RO | - | `/query <period>` | `query_logwork` | No |
| Preview/apply RO | - | `/logwork ro` | `preview_logwork_batch`, `apply_logwork_batch` | Apply only |
| Edit existing RO logwork | `edit` | `/edit-logwork` | `preview_ro_logwork_edit`, `apply_ro_logwork_edit` | Apply only |
| Resubmit rejected RO | - | - | `preview_ro_logwork_resubmit`, `apply_ro_logwork_resubmit` | Apply only |
| Delete RO entry | `delete` | - | `preview_ro_logwork_delete`, `apply_ro_logwork_delete`, `delete_ro_logwork_entry` | Apply only |
| Preview/apply Jira | - | `/logwork jira` | `preview_jira_worklog_batch`, `apply_jira_worklog_batch` | Apply only |
| Preview/apply Both | - | `/logwork both` | Run both target flows separately | Apply only |
| Project mapping | - | `/projects`, `/map` | `list_logwork_projects`, `upsert_project_mapping` | Local config only |
| Reconcile RO/Jira | `reconcile` | `/reconcile` | `reconcile_logwork` | No |
| Apply history | `history` | `/history` | `query_apply_history` | No |
| Reminder | `reminder` | - | `get_logwork_reminder`, `configure_logwork_reminder`, `test_logwork_reminder` | OS schedule only |
| Update | `update` | Startup notice | `check_for_updates`, `apply_update` | Local runtime only |
| Release preflight | `release doctor` | - | - | No |

All apply, mapping, reminder configuration, reminder test, and update operations require explicit confirmation. Query, preview, reconciliation, history, status, and update check operations are read-only.

## Target Routing

### Resource Optimiser

Use the RO flow when the intent is Resource Optimiser logwork:

```text
/logwork ro
```

MCP uses:

1. `preview_logwork_batch`
2. `apply_logwork_batch`

RO resolves each task to a project using the approved preview override, local ticket/keyword mappings, booked projects, and available project memberships. Jira is not written by this flow.

Creating new RO logwork uses `POST /logwork/entries`. The helper resolves each batch task name to a Resource Optimiser worklog task (`GET /logwork/tasks` and `/logwork/tasks/defaults` for the matched project). The task name in your batch text must match the RO worklog task name exactly (case-insensitive). **Task name** (catalog) is not the same as **type of work** (`create`, `correct`, `improve`, `other`) on the log entry.

New entries default to `type_of_work: other` when the matched catalog task has no `type_of_work`. When the RO task row defines `type_of_work`, preview copies it onto the entry unless MCP `typeOfWork` overrides the whole batch.

Optional MCP `preview_logwork_batch` input `typeOfWork` applies to every line in the batch and overrides per-task catalog defaults.

### Staff API surface (F03 vs legacy)

| Intent | HTTP | Used by helper |
| --- | --- | --- |
| Create entry (approved) | `POST /logwork/entries` | `preview_logwork_batch` / `apply_logwork_batch` |
| List worklog tasks | `GET /logwork/tasks`, `/logwork/tasks/defaults` | Batch preview task resolution |
| Day view (status, lock) | `GET /logwork/day` | `query_logwork` entry enrichment |
| Weekly summary | `GET /logwork/weekly` | Available in API client; booked hours still come from legacy timesheet |
| Rejected list | `GET /logwork/rejected` | Optional query enrichment (`includeRejected` when wired) |
| Resubmit rejected | `PATCH /logwork/entries/:id/resubmit` | `preview_ro_logwork_resubmit`, `apply_ro_logwork_resubmit` |
| Delete submitted/approved | `DELETE /logwork/entries/:id` | `delete_ro_logwork_entry` (confirm required) |
| Booked + logged range | `GET /member-logtime/timesheet` | `query_logwork`, batch booked-project resolution |
| Day task detail | `GET /member-logtime` | `query_logwork` entry lines |
| Edit hours/task label | `PATCH /member-logtime` `update_data` | `preview_ro_logwork_edit`, `apply_ro_logwork_edit` |

Legacy `PATCH` updates `task_name` text only; it does not remap `worklog_task_id`. Prefer F03 create/resubmit flows when task catalog alignment matters.

### Edit Existing Resource Optimiser Logwork

Use the logwork entry ID returned by an RO query:

```bash
logwork-helper edit 290364 --hours 0.5
logwork-helper edit 290364 --task-name "Updated task name (SCB-470)"
```

The terminal UI equivalent is:

```text
/edit-logwork 290364 --hours 0.5 --task-name Updated task name (SCB-470)
```

MCP uses two separate tools:

1. `preview_ro_logwork_edit` with `logworkId` and at least one of `hours` or `taskName`.
2. `apply_ro_logwork_edit` with the cached `previewId` and `confirm: true`.

The API write uses `PATCH /member-logtime/{projectMemberId}` and sends the logwork entry ID inside `update_data`. The helper reads the original entry and sends the complete merged values required by RO. Only hours and task name may change; project and date remain unchanged. Apply re-checks the original revision before PATCH and verifies the saved entry afterward. Entries owned by another user or created by Jira are blocked.

### Delete mistaken Resource Optimiser logwork

Use the entry ID from `query_logwork` or the RO UI. Only **submitted** or **approved** entries can be soft-deleted; **rejected** entries must be resubmitted or edited instead.

```bash
logwork-helper delete 290364
logwork-helper delete 290364 --yes --json
```

MCP (two-step, recommended):

1. `preview_ro_logwork_delete` with `logworkId`
2. `apply_ro_logwork_delete` with cached `previewId` and `confirm: true`

One-step shortcut: `delete_ro_logwork_entry` with `logworkId` and `confirm: true` (still previews and checks revision before DELETE).

The API call is `DELETE /logwork/entries/:id` (soft-delete via `deleted_date`).

### Jira

Use the Jira flow when the intent is a Jira worklog:

```text
/logwork jira
```

MCP uses:

1. `preview_jira_worklog_batch`
2. `apply_jira_worklog_batch`

Every entry must contain exactly one Jira issue key. RO is not written by this flow.

### Both

Use the combined terminal flow when the same date/tasks should be sent to both systems:

```text
/logwork both
```

The flow creates two independent previews and requests two approvals:

1. Preview and optionally apply Resource Optimiser.
2. Preview and optionally apply Jira.

The operation is not atomic. If RO succeeds and Jira fails, RO is not rolled back. Apply history records the result of each target with `flowTarget: both` so partial outcomes remain visible.

MCP has no unified Both tool. The assistant must call both preview tools, present both summaries, and request approval for each apply separately.

## Input Format

MCP and pasted weekly text use date headings followed by one task per line:

```text
Monday, 13 Jul 2026
+2 Maintenance mode management (SCB-213)
+1 Update system page (SCB-214)
Tuesday, 14 Jul 2026
+1.5 Fix password reset regression (SCB-215)
```

Rules:

- A date heading uses `Weekday, DD Mon YYYY`.
- A task uses `+<hours> <task text>`.
- Hours must be greater than zero and may be decimal.
- RO can accept entries without a Jira issue key when a project can still be resolved.
- Jira requires exactly one key such as `SCB-213` in every entry.
- Jira blocks entries with no key or multiple keys.

The terminal wizard selects one date for the current session. It accepts the same task line format without requiring a pasted date heading.

## Resource Optimiser Processing Example

Input:

```text
Monday, 13 Jul 2026
+2 Maintenance mode management (SCB-213)
+1 Update system page (SCB-214)
```

Processing:

1. Parse the date, hours, task text, and issue keys.
2. Load booked RO projects and project memberships for the date.
3. Apply user/project ticket and keyword mappings.
4. Mark each entry as resolved, resolved but unbooked, or unresolved.
5. Return an approval summary. No work is submitted during preview.

Illustrative ready preview:

```text
Logwork preview:
- 2026-07-13: +2h 2621A-SIT-HTML BUILDER-PRJ - Maintenance mode management (SCB-213) (via config_ticket, confidence 1)
- 2026-07-13: +1h 2621A-SIT-HTML BUILDER-PRJ - Update system page (SCB-214) (via config_ticket, confidence 1)
Approval checklist: 2 entries, 3h total, 2026-07-13.
Projects: 2621A-SIT-HTML BUILDER-PRJ: 3h.
Ready to apply.
```

After explicit approval, the apply result is similar to:

```text
Logwork submitted:
Submitted 2 entries, 3h total.
- 2026-07-13: +2h 2621A-SIT-HTML BUILDER-PRJ - Maintenance mode management (SCB-213)
- 2026-07-13: +1h 2621A-SIT-HTML BUILDER-PRJ - Update system page (SCB-214)
```

If a valid membership is not booked for the selected date, preview prefixes the entry with `UNBOOKED`. Applying it requires a second decision through `allowUnbooked: true`. An unresolved project always blocks apply.

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

The shorter `#lh:<hash>` marker replaces the old visible `[logwork-helper:...]` format. Existing worklogs with the legacy marker are still recognized during duplicate checks.

## Duplicate And Preview Safety

RO and Jira MCP previews are cached for one hour, with at most 100 previews per target. Apply requires the cached `batchId`. A missing, expired, consumed, or modified preview must be generated again.

Jira duplicate detection is blocking and has no override. Apply rechecks worklogs immediately before the first write. If a duplicate appears after preview, the Jira batch is blocked before submission.

If a Jira API write fails after earlier entries were submitted, processing stops and the result identifies the submitted entries and the failed entry. Remaining entries are not attempted. The helper never reports a partial batch as fully successful.

## Project Mapping And Similar Content

RO project mapping can use:

- Jira ticket prefixes, for example `SCB`.
- Task keywords, for example `maintenance mode`.
- Explicit project selection during preview.
- Jira project key/name metadata in the terminal Both flow to rank RO memberships.

Example MCP sequence:

1. `get_jira_issue` reads `SCB-213` metadata.
2. `list_logwork_projects` lists valid RO memberships.
3. The assistant compares Jira project metadata and task wording with RO project names/mappings.
4. The assistant shows the proposed project and asks for approval.
5. `upsert_project_mapping` stores the selected ticket/keyword mapping with `confirm: true`.
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
logwork-helper reconcile this-week
logwork-helper reconcile last-month --json
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
logwork-helper history
logwork-helper history --target jira --limit 10
logwork-helper history --target both --json
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
logwork-helper reminder enable
```

Other operations:

```bash
logwork-helper reminder enable --time 18:00 --target ro
logwork-helper reminder status
logwork-helper reminder test
logwork-helper reminder disable
```

Behavior:

- RO compares today's logged hours with booked hours.
- Jira checks whether the current Jira user has any worklog today.
- A complete day stays silent.
- At most one notification is sent per configured workday.
- Missing auth produces an actionable notification without exposing API details.
- macOS uses a user `launchd` agent.
- Windows uses an interactive user Task Scheduler task.

Example Both notification:

```text
Logwork hôm nay chưa hoàn tất
RO: 6/8h, còn thiếu 2h
Jira: chưa có worklog hôm nay

Mở Terminal và chạy: logwork
```

The notification text is localized in Vietnamese. The OS schedule stores only fixed Node/script paths and reads credentials from the OS credential store when it runs.

## End-User Updates

Check the running version against npm latest:

```bash
logwork-helper update check
logwork-helper update check --force
```

Install after confirmation:

```bash
logwork-helper update install
```

For a non-interactive terminal, approve the exact published version:

```bash
logwork-helper update install --version 0.1.11 --yes
```

The updater:

- Uses npm's official registry.
- Accepts only the package's current `latest` SemVer.
- Rechecks npm immediately before installation.
- Copies and verifies the stable local MCP runtime.
- Preserves credentials, mappings, drafts, history, and reminder config.

Restart the terminal and reconnect MCP after a successful update. MCP exposes the same process through `check_for_updates` and confirmed `apply_update`.

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
logwork-helper release doctor --full
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
| Installed runtime | `.logwork-helper/` | No |
| User project mappings | `.logwork-helper/.logwork-helper.json` | No |
| Manual drafts | `.logwork-helper/manual-drafts.json` | No |
| Apply history | `.logwork-helper/apply-ledger.json` | No |
| Update cache | `.logwork-helper/update-state.json` | No |
| Reminder config/state | `.logwork-helper/reminder.json`, `.logwork-helper/reminder-state.json` | No |
| RO/Jira sessions | OS credential store | Yes |

The helper home is `~/.logwork-helper` on macOS and `%USERPROFILE%\.logwork-helper` on Windows.

## Validation

Run the cross-platform suite:

```bash
npm test
git diff --check
npm pack --dry-run
```

Windows CI additionally runs a real Credential Manager lifecycle test:

```powershell
npm run test:windows-credential
```

That integration test stores, reads, and deletes a dedicated test credential. On non-Windows systems it is skipped by design.

Recommended end-user checks after installation:

1. Run `logwork-helper --version` and `logwork-helper update check --force`.
2. Run RO and Jira auth status commands.
3. Open `logwork` and preview one RO task without applying.
4. Preview one Jira task with exactly one issue key without applying.
5. Run `logwork-helper reconcile this-week`.
6. Run `logwork-helper reminder test`, verify the native notification, then inspect `reminder status`.
7. Connect MCP and verify the tool list before testing read-only queries.

## Recovery Rules

- Missing RO auth: run `logwork-helper auth login`.
- Missing Jira auth: run `logwork-helper jira login`.
- Unresolved RO project: list memberships, confirm a mapping, and preview again.
- Jira duplicate: inspect the existing worklog; there is no override.
- Expired or consumed preview: preview again and request approval again.
- Partial Both result: inspect `/history both`, then preview only the missing target.
- npm `E401`: refresh npm login with `npm login --registry=https://registry.npmjs.org/`.
- Reminder config/scheduler mismatch: rerun `reminder enable` or `reminder disable`.
- MCP after update: restart or reload the MCP connection.

For client configuration details, see [MCP setup](mcp-setup.md). For security boundaries and stored-data details, see [Security and auth](security.md). For copy-ready task recipes, see [Quick recipes](recipes.md).
