---
type: pitch
pitch: P19
title: Manual UI Cleanup Phase 2
status: done
commit: f93ec55
area: manual-ui
---

# P19 Manual UI Cleanup Phase 2

## Problem

Manual REPL apply logic mixed UI orchestration with blocker messages, confirmation text, unbooked checks, and total-hour calculations. That made future manual UI changes more error-prone.

## Plan

- Extract pure apply-state helpers.
- Keep user-facing messages unchanged.
- Reuse existing hour formatting.
- Keep manual REPL command behavior unchanged.
- Add focused tests for the extracted helpers.

## Executed

- Added `lib/manual-apply-state.mjs`.
- Updated `lib/manual-repl.mjs` to call the helper functions.
- Added `test/manual-apply-state.test.mjs`.

## Definition Of Done

- Manual apply blockers are covered by pure unit tests.
- Manual apply confirmation text is covered by pure unit tests.
- Manual REPL integration tests still pass.
- No command names, prompts, or workflow behavior changed intentionally.

## Related Files

- `lib/manual-apply-state.mjs`
- `lib/manual-repl.mjs`
- `test/manual-apply-state.test.mjs`

## Links

- [[problem-inventory|Problem Inventory]]
- [[P5-manual-ui-maintainability|P5 Manual UI Maintainability]]
- [[P9-manual-draft-workspace-scope|P9 Manual Draft Workspace Scope]]
