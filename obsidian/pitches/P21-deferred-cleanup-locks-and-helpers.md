---
type: pitch
pitch: P21
title: Deferred Cleanup / Locks And Helpers
status: done
commit: 876f3da
area: deferred-cleanup
---

# P21 Deferred Cleanup / Locks And Helpers

## Problem

P20 intentionally deferred several non-blocking cleanup items. After P1-P20 integration, the remaining useful work was narrow enough to handle safely:

- Config and manual drafts had atomic writes, but read-modify-write flows could still lose updates across concurrent sessions.
- Project identity, filter, and mapping comparisons were repeated across manual UI, query, resolver, and config modules.
- Timesheet normalization diagnostics were still attached through hidden non-enumerable metadata, which kept compatibility but made the internal contract awkward.
- Changing the legacy normalization return shape directly would have high blast radius because tests, fixtures, and compatibility callers expect arrays.
- Ink list navigation duplicated wraparound index math across picker components.

## Scope

Process item 1, item 2, and item 3 from the deferred cleanup list:

1. Per-file locks for config/drafts.
2. Maintainability/design cleanup for project identity and list navigation.
3. Explicit normalization result shape while keeping legacy array-return callers compatible.
4. Normalization return-shape blast-radius containment.

## Checklist

### Item 1: Per-File Locks For Config/Drafts

- [x] Add a narrow `withFileLock(filePath, operation)` helper using an atomic lock directory.
- [x] Add timeout and retry delay controls so callers cannot wait forever.
- [x] Wrap `upsertProjectMappingConfig` read-merge-write in the config file lock.
- [x] Wrap `saveManualDraft` read-update-write in the draft file lock.
- [x] Wrap `deleteManualDraft` read-update-write in the draft file lock.
- [x] Keep existing atomic write behavior for the final file replace.
- [x] Add focused tests proving config and draft writes wait when the file lock is already held.

### Item 2: Maintainability / Design Cleanup

- [x] Add shared project identity helpers for normalized names, identity keys, same-project comparison, filter matching, and mapping matching.
- [x] Migrate manual wizard project option logic to the shared helper.
- [x] Migrate manual REPL project chart/filter logic to the shared helper.
- [x] Migrate Ink UI same-project export to the shared helper without breaking existing imports.
- [x] Migrate query workflow project filtering and grouping to the shared helper.
- [x] Migrate resolver mapping match and candidate key generation where semantics match exactly.
- [x] Add shared list navigation helpers for wraparound previous/next index logic.
- [x] Migrate Ink date/project/draft/task pickers and auth device picker to shared list navigation.
- [x] Add focused helper tests.

### Item 3: Explicit Normalization Result Shape

- [x] Add `normalizeTimesheetRangeResult(data, range)` returning `{ records, normalization }`.
- [x] Add `getTimesheetRangeResult(token, userId, range)` returning the explicit result shape.
- [x] Keep `normalizeTimesheetRange()` returning records for backward compatibility.
- [x] Keep `getTimesheetRange()` returning records for backward compatibility.
- [x] Migrate default query range fetcher to the explicit result API.
- [x] Keep query workflow compatible with injected fetchers that still return arrays.
- [x] Add focused tests for explicit normalization metadata and query workflow consumption.

### Item 4: Normalization Return-Shape Blast Radius

- [x] Audit all `normalizeTimesheetRange`, `getTimesheetRange`, and `getNormalizationDiagnostics` call sites.
- [x] Keep legacy array-return functions stable instead of changing them to return objects.
- [x] Migrate production booked-project lookup to the explicit result API.
- [x] Add a test that `getTimesheetRangeResult` preserves the existing query contract while returning `{ records, normalization }`.
- [x] Add a test that `normalizeTimesheetRange` still returns an array and keeps diagnostics non-enumerable.
- [x] Document the compatibility decision so future cleanup does not accidentally introduce a broad breaking change.

## Execution Result

Implemented:

- `lib/file-lock.mjs` serializes per-file local state writes with bounded lock waits.
- Config mapping upserts and manual draft saves/deletes now serialize the whole read-modify-write sequence.
- `lib/project-identity.mjs` centralizes project identity comparison, keying, filters, and mapping matches.
- `lib/list-navigation.mjs` centralizes wraparound picker navigation.
- `lib/api.mjs` now exposes explicit timesheet normalization result APIs while preserving the legacy array-return APIs.
- `lib/query-workflow.mjs` now consumes explicit normalization results by default and adapts legacy array results.
- Booked-project lookup now uses `getTimesheetRangeResult` internally, so production code no longer depends on the hidden diagnostics return shape.

Deferred:

- Generic lock framework remains intentionally deferred. Current code only needs narrow per-file local state locking.

## Verification

- `node --test test/local-state-locks.test.mjs` passed.
- `node --test test/project-identity.test.mjs` passed.
- `node --test test/api-timesheet-range.test.mjs test/query-workflow.test.mjs test/manual-repl.test.mjs test/project-resolver.test.mjs` passed.
- `node --test test/batch-workflow.test.mjs test/resource-optimiser-fixtures.test.mjs` passed.
- `npm test` passed: 167/167.

## Definition Of Done

- Config and draft read-modify-write operations are serialized per target file.
- Final writes remain atomic.
- Project identity logic has one shared implementation for the migrated modules.
- Ink picker navigation has one shared implementation.
- Query workflow no longer needs hidden array metadata from the default range fetcher.
- Booked-project lookup no longer needs hidden array metadata from its range fetcher.
- Legacy normalization APIs remain backward compatible.
- Focused tests and full `npm test` pass.
- Local implementation commit created: `876f3da`.
- No `git push` is performed.

## Related Files

- `lib/file-lock.mjs`
- `lib/logwork-config.mjs`
- `lib/manual-drafts.mjs`
- `lib/project-identity.mjs`
- `lib/list-navigation.mjs`
- `lib/api.mjs`
- `lib/query-workflow.mjs`
- `lib/manual-logwork-wizard.mjs`
- `lib/manual-repl.mjs`
- `lib/manual-ink-ui.mjs`
- `lib/manual-ink-auth.mjs`
- `lib/project-resolver.mjs`
- `test/local-state-locks.test.mjs`
- `test/project-identity.test.mjs`
- `test/api-timesheet-range.test.mjs`
- `test/query-workflow.test.mjs`

## Links

- [[problem-inventory|Problem Inventory]]
- [[P4-api-normalization-contract|P4 API Normalization Contract]]
- [[P5-manual-ui-maintainability|P5 Manual UI Maintainability]]
- [[P15-local-state-integrity|P15 Local State Integrity]]
- [[P20-review-closure-safety-hardening|P20 Review Closure / Safety Hardening]]
