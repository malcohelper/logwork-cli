---
type: pitch
pitch: P9
title: Manual Draft Workspace Scope
status: done
commit: 4c075b8
area: manual-drafts
---

# P9 Manual Draft Workspace Scope

## Problem

Manual drafts persisted `cwd`, but draft pickers loaded every saved draft. Opening the manual CLI in another repository could show unrelated drafts and lead to wrong-context preview/apply decisions.

## Plan

- Add optional `cwd` filtering to `loadManualDrafts`.
- Keep default behavior backward compatible: no `cwd` means load all drafts.
- Pass current `cwd` from Ink manual draft pickers.
- Keep saved draft persistence and delete behavior unchanged.
- Add tests for current-workspace filtering.

## Executed

- Updated `lib/manual-drafts.mjs` with workspace filter.
- Updated `lib/manual-ink-app.mjs` draft load/reload calls to pass `cwd`.
- Extended `test/manual-repl.test.mjs`.

## Definition Of Done

- Current repo sees only its drafts in the manual UI.
- Other repo drafts are hidden from the picker.
- Raw `loadManualDrafts({ path })` still returns all drafts.
- Manual REPL tests and full suite pass.

## Related Files

- `lib/manual-drafts.mjs`
- `lib/manual-ink-app.mjs`
- `test/manual-repl.test.mjs`

## Links

- [[problem-inventory|Problem Inventory]]
- [[P5-manual-ui-maintainability|P5 Manual UI Maintainability]]
