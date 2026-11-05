---
type: pitch
pitch: P3
title: Product Surface Focus / Onboarding
status: done
commit: 3c7dc5a
area: onboarding
---

# P3 Product Surface / Onboarding

## Problem

First-run setup output was too raw. Users needed a post-install checklist showing what worked, what remains, which MCP config to paste, how to verify, and what not to paste into AI chat.

## Plan

- Restructure `setup-user` output into grouped sections.
- Avoid redundant auth retry instruction when `--login` succeeds.
- Preserve retry guidance when auth is skipped or fails.
- Keep MCP config snippets for Cursor/Antigravity, Codex, and VS Code/Copilot.
- Refresh CLI help and README so install, auth, paste config, reload IDE, verify is the primary path.

## Executed

- Updated `install-user.mjs` installer output.
- Updated `cli.mjs` help copy.
- Updated `README.md` Quick Start and MCP Setup sections.
- Extended CLI tests around success, skipped auth, failed auth, link fallback, and MCP config snippets.

## Definition Of Done

- Successful login does not tell the user to run auth login again.
- Skipped or failed auth shows exact retry command.
- Link warnings and fallback command output remain.
- MCP snippets include resolved `mcp-server.mjs` path.
- No new commands or tool schemas were introduced.

## Related Files

- `install-user.mjs`
- `cli.mjs`
- `README.md`
- `test/cli.test.mjs`

## Links

- [[problem-inventory|Problem Inventory]]
- [[P5-manual-ui-maintainability|P5 Manual UI Maintainability]]
