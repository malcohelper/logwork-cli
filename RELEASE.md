# Release Checklist

Use this checklist before publishing or tagging a production release.

The complete end-user update and maintainer publish flows are documented in the [integrated operations guide](docs/operations-guide.md).

## Version And Publish Sequence

Bump `package.json` and `package-lock.json` together:

```bash
npm version patch --no-git-tag-version
npm run release:check
```

Commit and sync the version before running the release doctor, because the doctor requires a clean, synchronized `main` branch:

```bash
git add package.json package-lock.json
git commit -m "bump version to <version>"
git push origin main
logwork-helper release doctor --full
```

After the doctor passes, publish npm and create the matching GitHub release:

```bash
npm publish --access public
git tag v<version>
git push origin v<version>
gh release create v<version> --generate-notes --title "v<version>"
```

Use `minor` or `major` instead of `patch` when required by SemVer. Never reuse an already published version.

## Required Gates

Run the local release gate:

```bash
npm run release:check
```

Before publishing, run the release preflight doctor:

```bash
logwork-helper release doctor --full
```

This checks version consistency, git cleanliness, npm auth, npm latest version, GitHub auth, tag/release state, local tarball artifacts, tests, audit, pack dry-run, and diff whitespace.

The gate must pass all of the following:

- `npm test`
- `npm audit --omit=dev --audit-level=moderate`
- `npm pack --dry-run`
- `git diff --check`

## Manual Verification

- Install from the packed tarball in a temporary directory.
- Run `logwork-helper setup-user --no-login`.
- Confirm the printed MCP config uses the resolved `~/.logwork-helper/mcp-server.mjs` path.
- Run `logwork-helper --help`.
- Run `logwork-helper update check --force` against the published npm version.
- Run `logwork-helper mcp` through an MCP client smoke test.
- Confirm MCP lists `check_for_updates` and `apply_update`, and that `apply_update` requires `confirm: true`.
- Confirm MCP lists read-only `reconcile_logwork` with preset periods only and no credential or confirmation fields.
- Run `logwork-helper reconcile this-week` and confirm it reports RO/Jira daily totals without writing either system.
- Confirm the Windows CI job passes the dedicated `Verify Windows Credential Manager integration` step.
- Run `logwork-helper reminder test`, confirm a native notification appears, then verify `reminder status` and clean up with `reminder disable`.
- Run `logwork-helper auth status` and confirm no token is printed.

## Safety Checks

- Do not include Resource Optimiser tokens, `.env` files, diagnostics reports, or machine-specific MCP configs in the package.
- Confirm `mcp-server.mjs` reports the same version as `package.json`.
- Confirm `README.md` and onboarding output describe the same primary setup flow.
- Confirm no untracked release artifacts are included except intentional documentation.

## Rollback

- Keep the previous npm package version available.
- If a release introduces auth, MCP, or apply-path regressions, roll back by instructing users to install the previous known-good npm version.
- Do not publish a replacement with the same version; publish a new patch version after the fix is verified.
