# Repository Guidelines

## Project Structure & Module Organization

This is a private Node.js 20+ ESM project for a macOS/Windows Git `commit-msg` hook, interactive CLI, and local MCP server that log work to Resource Optimiser.

- `logwork-helper.mjs`, `manual-log.mjs`, `mcp-server.mjs`, and `install.mjs` are executable entry points.
- `lib/` contains reusable modules for API access, auth, project resolution, parsing, workflows, UI, and OS integration.
- `test/` contains Node test runner suites named `*.test.mjs`.
- `hooks/` contains the Git hook template installed into target repositories.
- `examples/mcp/` contains MCP client configuration templates.
- `config.mjs` centralizes API paths, timeouts, defaults, and allowed Safari hosts.

## Build, Test, and Development Commands

- `npm ci`: install dependencies from `package-lock.json`.
- `npm test`: run all tests with `node --test`.
- `npm run start`: run the commit-message helper directly.
- `npm run dry-run`: run the helper without writing logtime.
- `npm run log`: start the manual log workflow.
- `npm run log:dry-run`: preview manual logging without API writes.
- `npm run install-hook -- /path/to/repo`: install the `commit-msg` hook into another repository.

## Coding Style & Naming Conventions

Use ESM syntax and `.mjs` files. Keep indentation at two spaces, prefer single quotes, and include semicolons. Functions and variables use `camelCase`; constants use `UPPER_SNAKE_CASE` when they represent regexes, maps, or fixed configuration. Keep shared behavior in `lib/` and entry-point orchestration in the root executables. No formatter or linter is currently configured, so match nearby style.

## Testing Guidelines

Tests use the built-in `node:test` framework with `node:assert/strict`. Place new tests in `test/` with the pattern `feature-name.test.mjs`. Prefer focused tests for parsers, workflows, and API payload behavior. Run `npm test` before opening a PR. Use dry-run commands when validating logging flows that would otherwise call Resource Optimiser.

## Commit & Pull Request Guidelines

The current Git history is minimal (`Initial commit`, `add source`), so use concise imperative commit messages such as `add batch parser validation` or `fix MCP query range handling`. Pull requests should include a short summary, test results, and any manual validation performed. Link related issues when available. Include screenshots or terminal excerpts only for UI prompts, hook behavior, or MCP client setup changes.

## Release Workflow

Use `RELEASE.md` as the deeper checklist, but follow this operational order when publishing a new version:

1. Confirm `main` is clean and synced with `git status --short --branch`.
2. Run release gates with `npm run release:check`. At minimum, run `git diff --check`, `npm test`, and `npm pack --dry-run --cache /private/tmp/logwork-helper-npm-cache`.
3. Commit all release-prep, documentation, and package metadata changes before the version bump.
4. Bump the version with `npm version <version> --no-git-tag-version`.
5. Re-run pack and diff checks, then commit with `bump version to <version>`.
6. Push `main` to `origin/main`, not `malcohelper`, unless the user explicitly requests another remote.
7. Publish npm with `npm whoami`, then `npm publish --access public`. If npm returns `EOTP`, ask the user for the current OTP and retry with `npm publish --access public --otp=<code>`.
8. Verify npm with `npm view logwork-helper version`.
9. Create an annotated tag with `git tag -a v<version> -m "v<version>"`, push it with `git push origin v<version>`, then create the GitHub Release with `gh release create v<version> --repo tructran2598/logwork-helper --title v<version> --generate-notes --verify-tag`.
10. Edit the GitHub Release notes so the top has a concrete `## Summary` section with the main user-facing changes, grouped by module or theme. Do not leave the release body as only a changelog link, and do not include a full compare link unless the user explicitly asks for it.
11. Verify the release, the remote tag, and final clean status.

Never publish with a dirty worktree. Never run `npm version` again after the version bump commit already exists. Do not include generated `.tgz` artifacts. If GitHub rejects a push because of workflow scope, use a GitHub credential with `workflow` scope rather than changing history. If global Git config has invalid signing fields, use `GIT_CONFIG_GLOBAL=/dev/null` for Git commands.

## Security & Configuration Tips

Do not commit Resource Optimiser tokens, `.env` files, or machine-specific MCP paths. Auth stores only the final Resource Optimiser session in the OS credential store; keep MCP `cwd` pointed at this repository so optional `.logwork-helper.json` project mappings resolve predictably.
