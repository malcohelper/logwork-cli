---
type: pitch
pitch: P6
title: MCP Preview Approval Safety
status: done
commit: 2f9e078
area: mcp
---

# P6 MCP Preview Approval Safety

## Problem

`apply_logwork_batch` accepted both `batchId` and full `batch`. If they disagreed, apply could use the wrong approval artifact. Preview cache also stored object references, allowing mutation in-process.

## Plan

- Add a resolver for approved batches.
- Reject mismatched `batchId` and `batch.batchId`.
- Clone preview data when setting and getting the preview cache.
- Keep MCP tool schema unchanged.
- Add tests for cache cloning and mismatch rejection.

## Executed

- Updated `mcp-server.mjs` with `resolveApprovedBatch` and preview cloning.
- Extended `test/mcp-smoke.test.mjs`.

## Definition Of Done

- Expired preview cache behavior remains unchanged.
- Cache still caps stored previews.
- Cached previews cannot be mutated by caller-held references.
- Apply rejects mismatched approved batches before submit.

## Related Files

- `mcp-server.mjs`
- `test/mcp-smoke.test.mjs`

## Links

- [[problem-inventory|Problem Inventory]]
- [[P1-project-resolution-safety|P1 Project Resolution Safety]]
