---
type: pitch
pitch: P13
title: Release Engineering Checks
status: done
commit: 75b936b
area: release
---

# P13 Release Engineering Checks

## Problem

The project had passing tests, but release readiness depended on local discipline. There was no CI workflow, no repeatable release checklist, and the MCP server version was hardcoded separately from `package.json`.

## Plan

- Add CI for Node 20 on macOS.
- Run tests, production audit, package dry-run, and whitespace checks.
- Add local release scripts.
- Add a release checklist document.
- Source MCP server version from package metadata.

## Executed

- Added `.github/workflows/ci.yml`.
- Added `RELEASE.md`.
- Added release scripts in `package.json`.
- Added `lib/package-info.mjs`.
- Updated `mcp-server.mjs` and `cli.mjs` to use package metadata.
- Added `test/release.test.mjs`.

## Definition Of Done

- CI checks install, test, audit, pack, and whitespace.
- `npm run release:check` exists for local verification.
- MCP server version comes from `package.json`.
- Release checklist documents manual verification and rollback expectations.

## Related Files

- `.github/workflows/ci.yml`
- `RELEASE.md`
- `package.json`
- `lib/package-info.mjs`
- `mcp-server.mjs`
- `cli.mjs`
- `test/release.test.mjs`

## Links

- [[definition-of-done|Definition Of Done]]
- [[P10-mcp-apply-provenance-hardening|P10 MCP Apply Provenance Hardening]]
