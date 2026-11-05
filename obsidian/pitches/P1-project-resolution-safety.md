---
type: pitch
pitch: P1
title: Project Resolution Safety
status: done
commit: 8b10644
area: project-resolution
---

# P1 Project Resolution Safety

## Problem

Preview could auto-resolve a task to the only booked project even when local ticket or keyword mappings indicated another project. That created a false-positive write risk.

## Plan

- Keep explicit `projectOverrides` as highest priority.
- Prefer config ticket and keyword matches over single-booked fallback.
- Block single-booked fallback when it conflicts with a configured mapping.
- Preserve unbooked mapping behavior, requiring `allowUnbooked: true` before apply.
- Add resolution metadata to preview entries without removing existing fields.
- Keep candidates consistent across booked and membership projects.

## Executed

- Updated `lib/project-resolver.mjs` resolution policy.
- Updated `lib/batch-workflow.mjs` preview entries with `resolution` metadata.
- Added summary hints such as source and confidence.
- Extended resolver and batch workflow tests.

## Definition Of Done

- Single booked project still resolves when no mapping conflict exists.
- Config ticket match resolves across multiple booked projects.
- Single booked project becomes unresolved when task ticket maps elsewhere.
- Ambiguous matches stay unresolved.
- Unbooked mapped project stays `resolved_unbooked`.
- Invalid override returns `override_not_found` with deduped candidates.

## Related Files

- `lib/project-resolver.mjs`
- `lib/batch-workflow.mjs`
- `test/project-resolver.test.mjs`
- `test/batch-workflow.test.mjs`

## Links

- [[problem-inventory|Problem Inventory]]
- [[P6-mcp-preview-approval-safety|P6 MCP Preview Approval Safety]]
- [[P7-project-mapping-config-hygiene|P7 Project Mapping Config Hygiene]]
