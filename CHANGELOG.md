# Changelog

Each version needs a `## [x.y.z]` section here before its version bump is
pushed to `main`. The release workflow uses that section as the GitHub Release
description.

## [1.0.0] - 2026-11-07

### Summary
- **Renamed to `logwork-cli`** (npm package and GitHub repo `malcohelper/logwork-cli`). One command, `logwork`, replaces `logwork`, `logwork-helper` and the other old binaries.
- **Shorter CLI**: `logwork query`, `quick`, `edit`, `delete`, `reconcile`, `history`, `login|logout|status [ro|jira]`, `setup`, `mcp`, `reminder`, `update`, `doctor`. Run `logwork` alone for the terminal UI.
- **Simpler MCP**: 15 tools instead of 25. Each write is one tool called twice: first without `confirm` to preview, then with the returned id and `confirm: true`. Tools: `get_logwork`, `list_projects`, `list_tasks`, `log_work`, `edit_entry`, `resubmit_entry`, `delete_entry`, `log_jira_work`, `get_jira_issue`, `reconcile`, `get_history`, `map_project`, `login`, `reminder`, `update`.
- **Logwork with description**: entries are written as `+<hours> <worklog task> | <description>`. The worklog task comes from the RO catalog (`list_tasks`) and the description is sent to RO.
- **Edit any field**: `edit_entry` / `logwork edit` change hours, worklog task, type of work and description. RO has no staff edit API, so the entry is replaced (create, then delete, with rollback).

### Upgrading from logwork-helper
- Run `npm install -g logwork-cli && logwork setup`. Setup removes the old global `logwork-helper` package.
- Settings, mappings, apply history and the reminder config are copied from `~/.logwork-helper` to `~/.logwork-cli` on first run. The login session is copied from the old Keychain / Credential Manager entry, so you do not need to log in again.
- Replace the `logwork-helper` MCP entry in your IDE with the config printed by `logwork setup`. MCP tool names changed; see the mapping table in `docs/mcp-setup.md`.

### Fixes
- `delete_entry` / `resubmit_entry` read the entry status from `/logwork/day`; before, the legacy read had no status, so deletes and resubmits were always refused.
- The MCP apply step for resubmit and delete found its cached preview again (it was cached under the wrong key).
- Dry runs of delete and resubmit now say "Dry run" instead of reporting a real write.

### Removed
- The git `commit-msg` hook (`install-hook`) and the legacy `PATCH /member-logtime` edit path.
