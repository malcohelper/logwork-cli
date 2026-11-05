---
type: pitch
pitch: P17
title: Safer Apply UX
status: done
commit: 09745dc
area: apply-ux
---

# P17 Safer Apply UX

## Problem

Preview output listed entries, but users and assistants needed a compact approval view before write operations: total hours, date range, project breakdown, unresolved count, and unbooked requirements.

## Plan

- Add backward-compatible preview metadata.
- Add `approvalSummary` to previews.
- Add `submissionSummary` to apply results.
- Keep existing summary wording and fields.
- Keep write blocking behavior unchanged.

## Executed

- Updated `lib/batch-workflow.mjs`.
- Extended batch workflow tests for approval and submission summaries.
- Updated README preview-then-apply guidance.

## Definition Of Done

- Preview includes entry count, total hours, date range, project breakdown, unresolved count, and unbooked count.
- Preview summary includes approval checklist lines.
- Apply result includes submission summary.
- Existing ready, unresolved, unbooked, and MCP smoke flows remain compatible.

## Related Files

- `lib/batch-workflow.mjs`
- `test/batch-workflow.test.mjs`
- `README.md`

## Links

- [[problem-inventory|Problem Inventory]]
- [[P1-project-resolution-safety|P1 Project Resolution Safety]]
- [[P10-mcp-apply-provenance-hardening|P10 MCP Apply Provenance Hardening]]
