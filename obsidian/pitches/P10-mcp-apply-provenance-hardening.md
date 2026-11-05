---
type: pitch
pitch: P10
title: MCP Apply Provenance Hardening
status: done
commit: 6885adf
area: mcp
---

# P10 MCP Apply Provenance Hardening

## Problem

P6 protected against mismatched `batchId` and preview content, but MCP still accepted a full `batch` object as part of apply input. That left a risky write-path shape: an assistant could send a full preview-like object without relying on the cached preview provenance created by `preview_logwork_batch`.

## Plan

- Enforce provenance at the `mcp-server.mjs` boundary, where the preview cache exists.
- Require a cached `batchId` for MCP apply.
- Keep the full `batch` input backward compatible as an optional echo only.
- If a full `batch` is provided, fingerprint it and require it to match the cached preview.
- Use the cached preview as the source of truth for apply.
- Avoid moving this enforcement into `applyLogworkBatch`, because manual REPL uses an in-memory `session.lastPreview`.

## Executed

- Hardened `resolveApprovedBatch` in `mcp-server.mjs`.
- Updated MCP smoke tests for missing, expired, mismatched, mutated, and matching batch echo cases.
- Updated README guidance so MCP apply uses returned `batchId`.

## Definition Of Done

- MCP apply rejects full-batch apply without `batchId`.
- MCP apply rejects missing or expired cached previews.
- MCP apply rejects mutated approved batch content.
- Matching batch echo remains accepted for compatibility, but apply uses the cached preview.
- Manual REPL apply path remains unaffected.

## Related Files

- `mcp-server.mjs`
- `test/mcp-smoke.test.mjs`
- `README.md`

## Links

- [[problem-inventory|Problem Inventory]]
- [[P6-mcp-preview-approval-safety|P6 MCP Preview Approval Safety]]
- [[P17-safer-apply-ux|P17 Safer Apply UX]]
