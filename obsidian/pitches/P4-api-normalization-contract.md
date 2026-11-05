---
type: pitch
pitch: P4
title: API Normalization Contract
original_label: Pitch P3 API Normalization Contract
status: done
commit: b6733a8
area: api-normalization
---

# P4 API Normalization Contract

Original conversation label: Pitch P3 API Normalization Contract. The vault uses P4 to keep the nine executed pitches in a unique sequence.

## Problem

Resource Optimiser API data could be malformed, negative, missing project identity, or shaped differently than expected. The helper needed diagnostics instead of silently producing incorrect totals.

## Plan

- Attach non-enumerable normalization diagnostics to normalized arrays.
- Expose diagnostics from query workflows while preserving existing query fields.
- Drop malformed rows and warn on invalid hours.
- Report unknown timesheet envelopes and fallback project names.
- Avoid NaN or negative hours in sanitized entries.

## Executed

- Added normalization diagnostics in `lib/api.mjs`.
- Added `getNormalizationDiagnostics` and `combineNormalizationDiagnostics`.
- Updated `lib/query-workflow.mjs` to expose merged diagnostics.
- Added tests for malformed range rows, detail rows, unknown envelopes, and fallback project names.

## Definition Of Done

- Malformed/negative/non-finite hours do not corrupt totals.
- Missing dates and missing project identity are reported as dropped rows.
- Query output remains backward compatible.
- Diagnostics are visible for support and tests.

## Related Files

- `lib/api.mjs`
- `lib/query-workflow.mjs`
- `test/api-timesheet-range.test.mjs`
- `test/query-workflow.test.mjs`

## Links

- [[problem-inventory|Problem Inventory]]
- [[P1-project-resolution-safety|P1 Project Resolution Safety]]
- [[P8-diagnostics-config-snapshot|P8 Diagnostics Config Snapshot]]
