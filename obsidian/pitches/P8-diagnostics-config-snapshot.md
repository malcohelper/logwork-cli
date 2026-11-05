---
type: pitch
pitch: P8
title: Diagnostics Config Snapshot
status: done
commit: 52e9161
area: diagnostics
---

# P8 Diagnostics Config Snapshot

## Problem

Diagnostics were safe and redacted, but support lacked enough config context to debug mapping and onboarding issues. File existence alone was not enough.

## Plan

- Add a sanitized `Config Snapshot` section to diagnostics reports.
- Include user and project config paths.
- Include mapping count and compact mapping summaries.
- Include project config in file checks.
- Keep redaction and safe formatting for arrays and objects.

## Executed

- Updated `lib/diagnostics.mjs`.
- Extended `test/diagnostics.test.mjs` with user and project mapping fixtures.

## Definition Of Done

- Report includes config snapshot and mapping count.
- Report includes safe ticket summaries.
- Report still redacts passwords, OTPs, cookies, auth codes, tokens, URL state, nonce, tab IDs, and raw HTML.
- Diagnostics CLI remains compatible.

## Related Files

- `lib/diagnostics.mjs`
- `test/diagnostics.test.mjs`

## Links

- [[problem-inventory|Problem Inventory]]
- [[P2-auth-resilience|P2 Auth Resilience]]
- [[P7-project-mapping-config-hygiene|P7 Project Mapping Config Hygiene]]
