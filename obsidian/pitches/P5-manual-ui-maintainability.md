---
type: pitch
pitch: P5
title: Manual UI Maintainability
status: done
commit: 9373443
area: manual-cli
---

# P5 Manual UI Maintainability

## Problem

`lib/manual-ink-app.mjs` had grown into a large mixed state-machine and rendering file. Future manual REPL changes were risky because UI components, auth prompts, and workflow state lived together.

## Plan

- Keep `ManualApp` and workflow state in `manual-ink-app.mjs`.
- Extract presentational Ink components into a dedicated UI module.
- Extract auth prompt/provider components into a dedicated auth module.
- Re-export old component names from `manual-ink-app.mjs` for compatibility.
- Add tests to lock old import surface.

## Executed

- Added `lib/manual-ink-ui.mjs`.
- Added `lib/manual-ink-auth.mjs`.
- Reduced `lib/manual-ink-app.mjs` to app orchestration plus re-exports.
- Added compatibility tests in `test/manual-repl.test.mjs`.

## Definition Of Done

- Existing tests importing from `manual-ink-app.mjs` still pass.
- Manual UI components render the same visible output.
- Auth prompt masking remains intact.
- Focused manual suite and full suite passed.

## Related Files

- `lib/manual-ink-app.mjs`
- `lib/manual-ink-ui.mjs`
- `lib/manual-ink-auth.mjs`
- `test/manual-repl.test.mjs`

## Links

- [[problem-inventory|Problem Inventory]]
- [[P3-product-surface-onboarding|P3 Product Surface / Onboarding]]
- [[P9-manual-draft-workspace-scope|P9 Manual Draft Workspace Scope]]
