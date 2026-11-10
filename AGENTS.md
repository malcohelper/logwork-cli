# Repository Guidelines

## Project Structure & Module Organization

This is the `logwork-cli` npm package (repo `malcohelper/logwork-cli`): a Node.js 22+ ESM project for macOS, Windows, Linux and WSL with three surfaces over shared workflows. It provides a terminal UI, a CLI, and a local MCP server that log work to Resource Optimiser and Jira.

- `bin/logwork.mjs` is the only executable entry point (npm bins `logwork` and `logwork-cli`). It dispatches `logwork <command>` in-process to `commands/*.mjs`. With no command it opens the terminal UI; `logwork mcp` starts the MCP server.
- `skills/logwork/SKILL.md` is the agent procedure for logging from commits; it is served as the MCP prompt `log_from_commits` and installed by `logwork skill install`. Keep it tool-accurate when MCP tools change.
- `commands/` contains one module per CLI command (`query`, `commits`, `skill`, `quick`, `edit`, `delete`, `reconcile`, `history`, `auth` for login/logout/status, `setup`, `reminder`, `update`, `doctor`, `release`, `tui`).
- `lib/` contains reusable modules for API access, auth, project resolution, parsing, workflows, UI, OS integration, `config.mjs` (API paths, timeouts, defaults), `mcp-server.mjs`, and `legacy-migration.mjs` (one-time copy of state from the pre-rename `~/.logwork-helper`).
- `test/` contains Node test runner suites named `*.test.mjs`.
- `examples/mcp/` contains MCP client configuration templates.

## Logwork Entry Format And MCP Conventions

- RO entries are `+<hours> <worklog task> | <description>`: the task before `|` must be an RO catalog task (`list_tasks`), the text after `|` is sent as `description`. See `CLAUDE.md` for the resolution rules (`defaultWorklogTask`, `worklog_task_required`).
- Editing an existing RO entry is a replace (create corrected entry, then delete the original, with rollback); RO has no staff edit endpoint. Do not reintroduce the legacy `PATCH /member-logtime` for edits.
- MCP writes are two calls to one tool: without `confirm` it previews and caches by `batchId`/`previewId`; with the id and `confirm: true` it applies. Apply calls must reject content fields (`assertApplyOnly`). Do not split tools back into `preview_*`/`apply_*` pairs.
- Every MCP tool needs a `title`, `description`, `annotations`, and `.describe()` on each input; keep `SERVER_INSTRUCTIONS` and `test/mcp-smoke.test.mjs` in sync when adding or changing tools.

## Build, Test, and Development Commands

- `npm ci`: install dependencies from `package-lock.json`.
- `npm test`: run all tests with `node --test`.
- `npm start`: open the terminal UI (`node bin/logwork.mjs`).
- `npm run dry-run`: open the terminal UI with `LOGWORK_DRY_RUN=1` (no RO writes).
- `npm run mcp`: run the MCP stdio server.
- `npm run setup`: install the local runtime to `~/.logwork-cli` and print MCP configs.
- `npm run release:doctor` / `npm run release:check`: release preflight and gates.

## Coding Style & Naming Conventions

Use ESM syntax and `.mjs` files. Keep indentation at two spaces, prefer single quotes, and include semicolons. Functions and variables use `camelCase`; constants use `UPPER_SNAKE_CASE` when they represent regexes, maps, or fixed configuration. Keep shared behavior in `lib/` and command orchestration in `commands/`; register new commands in the `COMMANDS` table of `bin/logwork.mjs`. No formatter or linter is currently configured, so match nearby style.

## Testing Guidelines

Tests use the built-in `node:test` framework with `node:assert/strict`. Place new tests in `test/` with the pattern `feature-name.test.mjs`. Prefer focused tests for parsers, workflows, and API payload behavior. Run `npm test` before opening a PR. Use dry-run commands when validating logging flows that would otherwise call Resource Optimiser.

## Commit & Pull Request Guidelines

The current Git history is minimal (`Initial commit`, `add source`), so use concise imperative commit messages such as `add batch parser validation` or `fix MCP query range handling`. Pull requests should include a short summary, test results, and any manual validation performed. Link related issues when available. Include screenshots or terminal excerpts only for UI prompts or MCP client setup changes.

## Release Workflow

Releases are automated by `.github/workflows/release.yml`. Do not publish npm, tag, or create GitHub Releases by hand unless the workflow is broken.

1. Confirm `main` is clean and synced with `git status --short --branch`.
2. Add a `## [<version>] - <YYYY-MM-DD>` section to `CHANGELOG.md` with a concrete `### Summary` of user-facing changes, grouped by theme. This section becomes the GitHub Release description; `test/release-notes.test.mjs` fails if the current version has none.
3. Bump with `npm version <version> --no-git-tag-version` (updates `package.json` and `package-lock.json`).
4. Run `npm run release:check`.
5. Commit (`release v<version>`) and push `main` to `https://github.com/malcohelper/logwork-cli.git`.
6. CI (`ci.yml`, macOS + Windows) runs. When it passes on `main`, the Release workflow sees a version without a `v<version>` tag and:
   - publishes `logwork-cli@<version>` to npm with provenance (`NPM_TOKEN` repository secret),
   - creates tag `v<version>` and the GitHub Release with the CHANGELOG section as notes.
   Re-running the workflow is safe: published versions and existing releases are skipped.
7. Verify with `gh run list --workflow Release`, `npm view logwork-cli version`, and `gh release view v<version>`.

Never reuse a published version. Never put npm tokens in files, commits, or command arguments; the token lives only in the `NPM_TOKEN` GitHub secret. Do not include generated `.tgz` artifacts. If GitHub rejects a push because of workflow scope, use a GitHub credential with `workflow` scope rather than changing history.

## Security & Configuration Tips

Do not commit Resource Optimiser tokens, `.env` files, or machine-specific MCP paths. Auth stores only the final Resource Optimiser session in the OS credential store; project-scope mappings live in `.logwork.json` in the working repo (a legacy `.logwork-helper.json` is still read when no `.logwork.json` exists).
