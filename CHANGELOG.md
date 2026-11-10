# Changelog

Each version needs a `## [x.y.z]` section here before its version bump is
pushed to `main`. The release workflow uses that section as the GitHub Release
description.

## [1.5.0] - 2026-11-10

### Added
- **WSL support.** Inside WSL, logwork uses the Windows side through interop instead of Linux services WSL usually lacks:
  - Login sessions go to Windows Credential Manager, under the same entries a Windows install uses, so one login covers both. The value is JSON on stdin of `powershell.exe` and the script goes as `-EncodedCommand`, never in argv. An older `logwork-helper` session in the Windows vault is picked up.
  - The reminder is a Windows Task Scheduler task, `Logwork Reminder (WSL <distro>)`, that runs `wsl.exe -d <distro> -u <user> --exec ~/.logwork-cli/bin/logwork-launch reminder run`. It fires even when no WSL terminal is open. The notification is a Windows toast.
  - The MCP `login` tool opens a Windows console window running WSL for the password and 2FA.
  - WSL is detected from `WSL_DISTRO_NAME`, `WSL_INTEROP` or the kernel release. `LOGWORK_WSL=0` keeps the plain Linux behavior (secret-tool, systemd, notify-send).
  - CI runs the suite in Ubuntu 24.04 on WSL, plus real Credential Manager and Task Scheduler round trips through interop.

## [1.4.0] - 2026-11-10

### Added
- **Linux support.** logwork-cli now installs and runs on Linux (`os` includes `linux`; CI runs on Ubuntu):
  - Login sessions go to the freedesktop Secret Service (GNOME Keyring, KWallet, KeePassXC) through libsecret's `secret-tool`. The value passes on stdin/stdout, never argv, and there is no plaintext fallback: without a Secret Service, login stops with install instructions (`sudo apt install libsecret-tools gnome-keyring`).
  - The reminder is a systemd user timer (`~/.config/systemd/user/logwork-cli-reminder.timer`) that runs the `logwork-launch` launcher, and the notification uses `notify-send` (`libnotify-bin`). Without a user systemd, `logwork reminder enable` prints the equivalent `crontab` line.
  - The launcher also finds Node from Linuxbrew, `$FNM_DIR` / `$XDG_DATA_HOME/fnm` and `/usr/bin/node`.
  - MCP client setup uses the Linux config paths (`~/.config/Code/User/mcp.json` for VS Code) and finds VS Code installed from Flathub (`~/.var/app/com.visualstudio.code/...`).
  - The MCP `login` tool opens a terminal window on a Linux desktop (`$TERMINAL`, `x-terminal-emulator`, GNOME Terminal, Konsole, xfce4-terminal, kitty, Alacritty, WezTerm, xterm), like it opens Terminal on macOS. Without a desktop it prints the command.
  - When `npm link` cannot write a root-owned global npm folder (Node from apt/dnf), `logwork setup` names the folder and offers nvm, a user npm prefix or `sudo npm install -g`. `logwork update` notes when the `logwork` command comes from such a separate install, which it cannot update.

### Changed
- **Reminder lists the repos.** Instead of "Hôm nay: 5 commit trong 2 repo", the reminder shows "Hôm nay 5 commit:" with one line per repo ("• teammates: 3"), busiest first. At most three repos are listed; the rest show as "• +N repo khác".
- **Shorter reminder.** The "Logwork hôm nay chưa hoàn tất" header line is gone (the title already says Logwork), so the banner shows the RO/Jira status and the commits first. `logwork reminder test` uses the title "Logwork (thử nghiệm)" and shows the new format.

## [1.3.1] - 2026-11-10

### Changed
- **MIT license.** logwork-cli is now open source under the MIT license (`LICENSE`, `package.json`). Earlier versions were published as proprietary.
- **README.** The "API Notes" section with the raw Resource Optimiser endpoints is removed; the README describes behavior, not internal API calls.

## [1.3.0] - 2026-11-09

### Added
- **Map repos without ids.**
  - `logwork commits` asks once per unmapped repo which RO project it belongs to. The likely project is preselected; pick it with Enter, or skip.
  - The answer is saved, and the draft is redone with per-project hours.
  - Suggestions come from:
    - ticket keys already logged to a project in the last 30 days;
    - the repo folder or git remote name matching the project name (including its acronym);
    - a single booked project on those days.
  - `/map --repo` in the terminal UI opens the same picker, or takes a project name.
  - `draft_from_commits` returns `repoSuggestions`, so agents ask "is this repo FCS?" instead of asking for ids.
- **Automatic MCP setup.**
  - `logwork setup` offers to add the `logwork` server to the IDEs it finds: Claude Code, Cursor, Codex, VS Code and Google Antigravity. It backs up each file first and removes old `logwork-helper` entries.
  - `logwork mcp install` does the same later.
  - `logwork mcp status` shows which clients are missing, stale or up to date.
  - Files with comments are never rewritten; their snippet is printed instead.

### Changed
- **Stable launcher (macOS).** MCP configs and the reminder run `~/.logwork-cli/bin/logwork-launch`, which finds Node 22+ itself: the recorded Node, then PATH, nvm, Volta, fnm and Homebrew. Upgrading or switching Node no longer breaks them.
- **Windows Node path.** On Windows the configs use a stable `node.exe` path (the nvm-windows symlink when present).
- **Doctor.** `logwork doctor` adds "MCP Clients" and checks the launcher.

## [1.2.0] - 2026-11-09

### Added
- **Commit drafts per project.** A project mapping can list git repos (`map_project` with `repos`, or `/map --repo` in the terminal UI). `draft_from_commits` / `logwork commits` pick each group's project from the repo mapping, else ticket/keyword mappings and that day's bookings. They split each project's own remaining hours (booked - logged), so no project is overbooked. The draft returns `projectOverrides` to pass to `log_work` unchanged, and `unmappedRepos` to map next.
- **Duplicate guard in `log_work`.** The preview flags lines that match an existing RO entry (same date, worklog task, hours and description) or an earlier line in the batch. Apply then needs `allowDuplicates: true`; the terminal UI asks, defaulting to no.
- **Commit-aware reminder.** When RO time is missing, the reminder adds today's commit count (for example "Hôm nay: 5 commit trong 2 repo") and suggests `logwork commits today`. Repos come from `logwork reminder enable --repo <path>` (or the MCP `reminder` tool) and from project mappings.
- **Jira dry-run.** `LOGWORK_DRY_RUN=1` now also stubs Jira writes and reports a dry run; reads still hit Jira.

### Changed
- **Absolute Node path in MCP configs.** Printed configs use the absolute Node path instead of `node`, so IDEs started from the Dock (nvm installs) can start the server.
- **Runtime file.** `logwork setup` records the Node it ran with in `runtime.json`.
- **Stale Node warnings.** `logwork doctor` and `logwork reminder status` warn when the recorded Node, or the reminder's Node, is missing or stale.
- **Internals:** `lib/api.mjs`, `lib/api-auth.mjs` and `lib/manual-ink-app.mjs` are split into smaller modules; the old import paths still work.
- **Quality:**
  - ESLint and test coverage thresholds run in CI.
  - The test suite is hermetic: it ignores `LOGWORK_*` variables in the shell and never touches the real home.
  - New tests cover the RO entry reader, prompts, terminal auth and `quick`.

## [1.1.1] - 2026-11-09

### Fixed
- **Security (release workflow):** only a CI run for a push to this repo's `main` can publish. Previously a fork pull request from a branch named `main` could reach the publish job. Workflow values now go through `env:` instead of being inlined in scripts, and the checkout no longer keeps credentials.
- **Security (macOS Keychain):** sessions and Jira tokens are written through stdin (`security -i`) and never appear in process arguments.
- **Windows:** `logwork setup`, `logwork update install` and `logwork release doctor` failed to start npm (ENOENT / EINVAL). npm now runs through its own `npm-cli.js`.
- **Setup:** copies only the packaged files into `~/.logwork-cli`, so a git checkout's `.env`, tests or repo `.logwork.json` never land in the state directory. A lockfile left by an older install is removed so `npm ci` does not fail after a dependency change.
- **Edit by replace:** a timeout on the create or delete call no longer loses or duplicates the entry. The day is re-read: a replacement that RO saved is used, and the replacement is rolled back only when the original is confirmed to still exist.
- **log_work:**
  - When an entry fails partway, the error lists the entries already written so the batch is not applied twice.
  - Hours above 24 per entry or per day, and a heading whose weekday does not match its date, are rejected at preview.
  - A `typeOfWork` override now changes the `batchId` and is shown in the preview.
  - A confirm that is missing `allowUnbooked` keeps the preview so the same `batchId` can be retried.
- **resubmit_entry:** the preview id covers every field sent, so two previews of one entry no longer overwrite each other. The summary shows the hours, type, description and note changes. Hours are capped at 24.
- **delete_entry / resubmit_entry:** refuse Jira-created entries, other users' entries and locked days, like `edit_entry`. Apply also re-checks the date, description and type of work.
- **draft_from_commits / logwork commits:**
  - Commits are matched on the author date, so rebased or amended commits stay on the day they were written.
  - The author match is exact, so `me@x.com` no longer picks up `jime@x.com`.
  - A repo reached through two paths (a subfolder or a worktree) is counted once.
  - Standards such as `UTF-8` and `ISO-8601` are no longer read as ticket keys.
  - Commits on a detached HEAD are included.
  - An RO login error returns `authRequired` instead of assuming 8h days.
  - Each day lists the remaining hours per project, and `status` is `no_hours` when nothing can be logged.
- **Setup:** removes broken global links left by a `logwork-helper` install whose `~/.logwork-helper` folder was deleted. Those links made `npm install -g logwork-cli` and `npm link` fail with `EEXIST`.
- **Docs:** upgrading from `logwork-helper` needs `npm uninstall -g logwork-helper` first, because both packages own the `logwork` command.

## [1.1.0] - 2026-11-07

### Summary
- **Log work from your commits.** `logwork commits [period] [--repo ...]` and the MCP tool `draft_from_commits` read your own commits (all branches, your git author) and draft `+<hours> <worklog task> | <description>` lines:
  - commits are grouped per day by repo, ticket and kind of work;
  - the kind of work picks the worklog task (feat -> Feature Development, fix -> Bug Fix, refactor/review -> Code Review & Refactoring, test -> Testing Activities, ci/release -> Deployment & Release, docs -> Requirements & Design);
  - each day's RO remaining booked hours are split across the groups in 0.5h steps.
- **Agent skill.** New MCP prompt `log_from_commits` and `logwork skill install` (Claude Code and Codex). Both carry the procedure agents follow for accurate logwork:
  1. find the gaps;
  2. draft from commits;
  3. check task names;
  4. rewrite vague descriptions;
  5. stay within booked hours;
  6. get the user's approval before `log_work`.
- MCP server instructions now point agents at the commit-based flow and forbid inventing work.

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
