---
type: pitch
pitch: P12
title: Network Reliability Policy
status: done
commit: 61e75a4
area: networking
---

# P12 Network Reliability Policy

## Problem

Resource Optimiser and Keycloak calls needed a consistent timeout, retry, and redaction policy. Without this, read calls could fail transiently, write calls could be accidentally retried, and API error bodies could leak sensitive content.

## Plan

- Add a shared `fetchWithPolicy` helper.
- Apply timeouts consistently.
- Retry idempotent/read calls only.
- Do not retry non-idempotent writes or refresh-token mutation.
- Redact sensitive response excerpts in errors.
- Keep Resource Optimiser API paths and payloads unchanged.

## Executed

- Added `lib/http.mjs`.
- Wired `lib/api.mjs`, `lib/api-auth.mjs`, and `lib/auth.mjs` into the network policy.
- Added config defaults for timeout, read retries, and retry delay.
- Added HTTP and API tests for retry, non-retry, timeout, and redaction behavior.

## Definition Of Done

- Read calls retry transient failures.
- Write calls do not retry automatically.
- Refresh-token flow uses timeout but no retry.
- API error excerpts are redacted.
- Full suite and release checks pass.

## Related Files

- `lib/http.mjs`
- `lib/api.mjs`
- `lib/api-auth.mjs`
- `lib/auth.mjs`
- `config.mjs`
- `test/http.test.mjs`
- `test/api-timesheet-range.test.mjs`

## Links

- [[problem-inventory|Problem Inventory]]
- [[P4-api-normalization-contract|P4 API Normalization Contract]]
- [[P11-auth-protocol-validation|P11 Auth Protocol Validation]]
