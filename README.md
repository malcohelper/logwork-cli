# Logwork Helper

macOS Git `commit-msg` hook plus an interactive Node.js CLI for logging work to Resource Optimiser.

The helper reads the Resource Optimiser token from Safari `localStorage`, shows only projects booked for today, and submits logtime to the selected booked project.

## Requirements

- macOS
- Node.js 20+
- npm
- Safari
- Logged-in Resource Optimiser session in Safari

## Quick Setup

```bash
git clone <your-logwork-helper-repo-url>
cd logwork-helper
./setup.sh /path/to/repo-that-you-commit-in
```

Keep this `logwork-helper` folder on disk after setup. The installed Git hook calls the helper from this folder.

## Safari Setup

Enable Safari JavaScript from Apple Events:

```text
Safari -> Settings -> Advanced -> Show features for web developers
Develop -> Allow JavaScript from Apple Events
```

Then quit and reopen Safari once. If macOS asks for Automation permissions, allow Terminal or your Git client to control Safari and Terminal.

## Manual Setup

Use this if you do not want to run `setup.sh`:

```bash
npm ci
node install.mjs /path/to/repo-that-you-commit-in
```

The installer backs up an existing `commit-msg` hook and chains it before Logwork Helper.

## Usage

Commit normally from Terminal, VS Code, or GitLens. The `commit-msg` hook opens a Terminal window and waits for the helper result.

Result behavior:

```text
ok    => commit allowed
skip  => commit allowed
abort => commit blocked
```

## Manual Log

Run the same log-work flow without making a Git commit:

```bash
npm run log
npm run log -- "Fix login bug"
node manual-log.mjs --message "Fix login bug"
```

The project picker only shows projects with a Resource Optimiser timesheet booking for today. Assigned percent is calculated as booked hours per day divided by 8 hours.

## Dry Run

```bash
LOGWORK_DRY_RUN=1 git commit
npm run log:dry-run
```

Dry run builds the payload but does not call the write API.

## Update

```bash
cd logwork-helper
git pull
npm ci
./setup.sh /path/to/repo-that-you-commit-in
```

Re-run setup after changing Node versions because the hook captures the absolute Node path at install time.

## Uninstall

In the target Git repo:

```bash
cd /path/to/repo-that-you-commit-in
ls .git/hooks/commit-msg.logwork-backup.*
```

If a backup exists, restore it:

```bash
mv .git/hooks/commit-msg.logwork-backup.<timestamp> .git/hooks/commit-msg
chmod +x .git/hooks/commit-msg
```

If there was no previous hook, remove the Logwork Helper hook:

```bash
rm .git/hooks/commit-msg
```

## Troubleshooting

- **No projects shown**: you are not booked in Resource Optimiser today.
- **Safari localStorage error**: confirm `Develop -> Allow JavaScript from Apple Events`, then quit and reopen Safari.
- **macOS Automation prompt**: allow Terminal or your Git client to control Safari and Terminal in `System Settings -> Privacy & Security -> Automation`.
- **Hook timeout**: the hook removes stale lock files automatically; retry the commit after fixing the visible error.
- **Existing commit hook**: the installer backs it up as `commit-msg.logwork-backup.<timestamp>` and runs it first.
- **Token safety**: the token is read locally from Safari and is never printed, passed through argv, or written to lock/result files.

## API Notes

- Read today bookings: `GET /member-logtime/timesheet`
- Write logtime: `PATCH /member-logtime/:project_member_id`
- Payload shape:

```json
{
  "add_data": [
    {
      "project_member_id": 5352,
      "logtimes": 0.5,
      "task_name": "Fix login bug",
      "logdate": "2026-06-05T00:00:00.000Z"
    }
  ]
}
```
