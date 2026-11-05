---
type: pitch
pitch: P16
title: Doctor Diagnostics Command
status: done
commit: 9b2ba84
area: diagnostics
---

# P16 Doctor Diagnostics Command

## Problem

Diagnostics existed, but `diagnostics` is a support-oriented name. Users often expect a `doctor` command for setup health checks, especially after onboarding or MCP tool visibility problems.

## Plan

- Add `logwork-helper doctor` as an alias for diagnostics.
- Reuse the existing sanitized diagnostics implementation.
- Update top-level help and command help.
- Update README troubleshooting copy.
- Add CLI tests for help and execution.

## Executed

- Added `doctor` command to `cli.mjs`.
- Extended CLI tests in `test/cli.test.mjs`.
- Updated README support guidance.

## Definition Of Done

- `logwork-helper doctor --help` works.
- `logwork-helper doctor` writes the same sanitized support report as diagnostics.
- No new MCP tools are added.
- No auth or token storage behavior changes.

## Related Files

- `cli.mjs`
- `test/cli.test.mjs`
- `README.md`

## Links

- [[problem-inventory|Problem Inventory]]
- [[P8-diagnostics-config-snapshot|P8 Diagnostics Config Snapshot]]
- [[P14-environment-config-overrides|P14 Environment Config Overrides]]
