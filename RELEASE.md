# Release Checklist

Use this checklist before publishing or tagging a production release.

The complete end-user update and maintainer publish flows are documented in the [integrated operations guide](docs/operations-guide.md).

## Version And Publish Sequence

Publishing is automated. Pushing a version bump to `main` is the release:

```bash
# 1. Add "## [<version>] - <date>" with a ### Summary to CHANGELOG.md
npm version <version> --no-git-tag-version
npm run release:check
git add -A
git commit -m "release v<version>"
git push origin main
```

After CI passes on `main`, `.github/workflows/release.yml`:

1. reads the version from `package.json`;
2. publishes `logwork-cli@<version>` to npm with provenance, using the `NPM_TOKEN` repository secret (skipped if already published);
3. creates tag `v<version>` and a GitHub Release whose description is the `CHANGELOG.md` section (skipped if the tag exists).

Check the result:

```bash
gh run list --workflow Release --limit 3
npm view logwork-cli version
gh release view v<version>
```

To retry a failed release, re-run the Release workflow (or `gh workflow run Release`). Use `minor` or `major` instead of `patch` when required by SemVer. Never reuse an already published version.

### npm token

The workflow uses the `NPM_TOKEN` repository secret (an npm automation or granular token with publish rights to `logwork-cli`). Set or rotate it with `gh secret set NPM_TOKEN --repo malcohelper/logwork-cli` and paste the token at the prompt. Never put the token in files, commits or command arguments. Preferred long term: configure npm Trusted Publishing for this repo and workflow on npmjs.com, then delete the secret; `npm publish --provenance` in the workflow already runs with `id-token: write`.

## Required Gates

Run the local release gate:

```bash
npm run release:check
```

Before publishing, run the release preflight doctor:

```bash
logwork release doctor --full
```

This checks version consistency, git cleanliness, npm auth, npm latest version, GitHub auth, tag/release state, local tarball artifacts, tests, audit, pack dry-run, and diff whitespace.

The gate must pass all of the following:

- `npm test`
- `npm audit --omit=dev --audit-level=moderate`
- `npm pack --dry-run`
- `git diff --check`

## Manual Verification

- Install from the packed tarball in a temporary directory.
- Run `logwork setup --no-login`.
- Confirm the printed MCP config uses server name `logwork` and `node ~/.logwork-cli/bin/logwork.mjs mcp`.
- Run `logwork --help` and `logwork --version`.
- Run `logwork update check --force` against the published npm version.
- Run `logwork mcp` through an MCP client smoke test and confirm it lists the 16 tools (`get_logwork`, `draft_from_commits`, `list_projects`, `list_tasks`, `log_work`, `edit_entry`, `resubmit_entry`, `delete_entry`, `log_jira_work`, `get_jira_issue`, `reconcile`, `get_history`, `map_project`, `login`, `reminder`, `update`).
- Confirm the `update` tool requires `confirm: true` for `action: "install"`, and `reconcile` takes preset periods only with no credential or confirmation fields.
- Run `logwork reconcile this-week` and confirm it reports RO/Jira daily totals without writing either system.
- On a machine with an older `logwork-helper` install, confirm the first run copies state to `~/.logwork-cli` and `logwork status` shows the existing session without a new login.
- Confirm the Windows CI job passes the dedicated `Verify Windows Credential Manager integration` step.
- Run `logwork reminder test`, confirm a native notification appears, then verify `logwork reminder status` and clean up with `logwork reminder disable`.
- Run `logwork status` and confirm no token is printed.

## Safety Checks

- Do not include Resource Optimiser tokens, `.env` files, diagnostics reports, or machine-specific MCP configs in the package.
- Confirm `logwork --version` and the MCP server version match `package.json`.
- Confirm `README.md` and onboarding output describe the same primary setup flow.
- Confirm no untracked release artifacts are included except intentional documentation.

## Rollback

- Keep the previous npm package version available.
- If a release introduces auth, MCP, or apply-path regressions, roll back by instructing users to install the previous known-good npm version.
- Do not publish a replacement with the same version; publish a new patch version after the fix is verified.
