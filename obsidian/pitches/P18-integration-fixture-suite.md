---
type: pitch
pitch: P18
title: Integration Fixture Suite
status: done
commit: d8824a1
area: testing
---

# P18 Integration Fixture Suite

## Problem

API normalization had strong focused tests, but important Resource Optimiser response shapes were still embedded inline. That made contract drift harder to review and harder to extend with real-world samples.

## Plan

- Add file-based Resource Optimiser fixtures.
- Cover project-timesheet shape.
- Cover malformed range rows and diagnostics.
- Cover day-log detail rows and dropped-row diagnostics.
- Keep runtime code unchanged.

## Executed

- Added fixtures under `test/fixtures/resource-optimiser/`.
- Added `test/resource-optimiser-fixtures.test.mjs`.
- Verified normalized records and diagnostics for each fixture.

## Definition Of Done

- Project timesheet fixture normalizes booked/logged records.
- Malformed range fixture reports warnings and dropped rows.
- Day-log detail fixture accepts valid tasks and reports invalid rows.
- Full test suite includes fixture contract coverage.

## Related Files

- `test/fixtures/resource-optimiser/day-log-detail.json`
- `test/fixtures/resource-optimiser/timesheet-malformed-range.json`
- `test/fixtures/resource-optimiser/timesheet-project-shape.json`
- `test/resource-optimiser-fixtures.test.mjs`

## Links

- [[problem-inventory|Problem Inventory]]
- [[P4-api-normalization-contract|P4 API Normalization Contract]]
- [[P12-network-reliability-policy|P12 Network Reliability Policy]]
