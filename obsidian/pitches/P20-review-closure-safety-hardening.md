---
type: pitch
pitch: P20
title: Review Closure / Safety Hardening
status: done
commit: 96e3c1c
area: safety-hardening
---

# P20 Review Closure / Safety Hardening

## Problem

P10-P19 closed the main production-readiness gaps, but a final release-review pass should harden the write path and support surface against edge cases a production reviewer would still challenge:

- Approval immutability is stronger, but needs explicit closure tests around cached preview fingerprints and approval artifacts.
- Concurrent apply requests could race against the preview cache or submit the same batch twice.
- Auth/network URL validation exists, but HTTPS/origin rules need a final audit so non-local production traffic cannot silently downgrade or drift.
- Local state writes are atomic, but lock semantics around apply and local write paths are not yet a first-class safety primitive.
- Diagnostics are sanitized, but privacy regression tests should cover newer config, network, and auth fields.
- Tests mutate env in several places; isolation should be made explicit so pitch-level and CI runs cannot leak state across test files.

## Source Review Checklist

This pitch exists because the post-P1-P19 review left the following open safety items:

- P10: remove `projectOverrides` from `apply_logwork_batch`, or fingerprint final overrides.
- P10: consume or mark cached preview before `await submit` to avoid double apply.
- P11/P14: enforce HTTPS and compare origin for auth form, redirect, and token flow.
- P12: isolate retry tests from env config.
- P12: cancel/drain retryable HTTP response body before retry.
- P15: add per-file lock for config and drafts if concurrent sessions are supported.
- P8/P16: redact mapping details by default in diagnostics; full detail should require opt-in.
- P4/P18: fix `readNumber` so it continues scanning fallback fields after an invalid value.
- P4: consider explicit `{ records, normalization }` instead of hidden non-enumerable diagnostics.
- P5/P19: extract shared project identity and list navigation helpers.

## Scope Decision

P20 should be a minimal closure hardening pitch, not a general refactor pitch. Every implemented item should start with a focused failing test. If a focused failing test is not clear within a short review window, record the item as deferred with rationale instead of building a generalized abstraction.

## Must Do

- Approval immutability:
  - Add focused tests for cached preview mutation and final apply arguments.
  - Decide one narrow policy for `projectOverrides` in `apply_logwork_batch`: remove it from apply, or include final overrides in the immutable fingerprint.

- Concurrent apply:
  - Consume or mark cached preview before awaiting submit work.
  - Add the smallest MCP-boundary in-flight guard needed to prevent double submit for the same `batchId`.
  - Clean up in-flight state after success and failure.

- HTTPS and origin hardening:
  - Enforce HTTPS for production API, login, Keycloak auth, token, and redirect URLs.
  - Allow HTTP only for explicit localhost or loopback development overrides.
  - Compare auth form action, redirect, and token flow origins against expected origins.

- HTTP retry hygiene:
  - Cancel or drain retryable HTTP response bodies before retry.
  - Keep non-idempotent writes non-retryable.

- Diagnostics privacy:
  - Redact mapping details by default in diagnostics.
  - Keep any full-detail diagnostics path explicit and opt-in.

- Test env isolation:
  - Add a small env restore helper.
  - Migrate high-risk tests that mutate `process.env`.
  - Keep retry tests isolated from env-derived config.

## Deferred With Rationale

- Per-file locks for config/drafts:
  - Defer unless a focused concurrent-session test reproduces corruption or lost update.
  - Rationale: P15 already made writes atomic. Adding a lock system without a proven race adds complexity and failure modes.

- Explicit `{ records, normalization }` return shape:
  - Defer unless hidden diagnostics cause a concrete bug or test gap.
  - Rationale: changing normalization return shape can break internal callers and tests. Current hidden diagnostics are awkward but compatible.

- Shared project identity helpers:
  - Defer unless P20 touches repeated identity logic directly.
  - Rationale: extracting helpers without active behavior change risks churn and abstraction mismatch.

- Shared list navigation helpers:
  - Defer unless a specific manual/Ink navigation bug is being fixed.
  - Rationale: list navigation extraction is maintainability work, not closure safety.

- Generic lock framework:
  - Defer.
  - Rationale: P20 only needs a narrow MCP apply guard if tests prove duplicate apply risk. A reusable lock abstraction would be overengineering.

- `readNumber` fallback scanning:
  - Implemented after a focused fixture proved a valid fallback value was ignored after an invalid first field.
  - Rationale: this stayed limited to the proven fallback bug and did not change the normalization return shape.

## Pre-Execution Review

- Risk: medium-high because this touches write-path concurrency and auth/config validation.
- Compatibility: keep MCP schemas and CLI commands backward compatible.
- Blast radius: MCP apply, config validation, diagnostics, HTTP retry behavior, and tests.
- Constraint: provenance enforcement should remain at `mcp-server.mjs` where preview cache exists; do not blindly push MCP-only checks into `applyLogworkBatch`.
- Constraint: concurrency guard must not block manual REPL in-memory apply.
- Constraint: do not introduce a normalization return-shape change in P20 unless the current shape is proven unsafe by a failing test.
- Constraint: prefer deletion or narrow checks over new abstractions.

## Execution Checklist

1. Review current P4, P8, P10, P11, P12, P14, P15, P16, P17, P18, and P19 code paths.
2. Write focused failing tests for approval mutation and duplicate apply.
3. Decide and implement final `projectOverrides` apply policy.
4. Consume or mark cached preview before awaited submit work.
5. Implement minimal MCP-boundary in-flight guard only if required by the duplicate apply test.
6. Harden URL scheme/origin validation without breaking explicit localhost/loopback overrides.
7. Cancel or drain retryable HTTP response bodies before retry.
8. Redact mapping details by default in diagnostics, with opt-in if needed.
9. Add env restore helper and migrate high-risk env mutation tests.
10. Add a focused `readNumber` fallback test; implement only if it proves the bug.
11. Record deferred items with rationale in this note.
12. Run focused tests.
13. Run full `npm test`.
14. Run `git diff --check`.
15. Run `npm pack --dry-run`.
16. Run production dependency audit.
17. Post-execution review against this DoD.
18. Commit local-only, no push.

## Execution Result

Implemented:

- MCP apply now rejects final `projectOverrides`; overrides must be part of preview so approval covers final project selection.
- MCP apply consumes the cached preview before awaited submit work, preventing duplicate submit for the same `batchId`.
- Production URLs now require HTTPS; HTTP is allowed only for localhost or loopback development overrides.
- Auth form action, redirect, auth request, and Keycloak token endpoint origins are validated against expected origins.
- Refresh-token API base follows the same HTTPS policy.
- Retryable HTTP responses are canceled or drained before retry.
- Diagnostics redact mapping details by default and expose full mapping details only through explicit opt-in.
- `readNumber` continues scanning fallback fields after invalid values, with warning diagnostics preserved.
- Retry tests no longer depend on env-derived retry defaults.
- Tests that mutate `process.env` use restore helpers or file-level env restoration.

Deferred:

- Per-file locks for config/drafts remain deferred because no focused concurrent-session test reproduced corruption or lost update.
- Explicit `{ records, normalization }` return shape remains deferred because the current hidden diagnostics shape did not cause a concrete bug in P20.
- Shared project identity and list navigation helpers remain deferred because P20 did not touch those paths for a proven bug.
- Generic lock framework remains deferred; consuming cached approval at the MCP boundary closed the duplicate apply risk without a new abstraction.

Verification:

- `npm test` passed: 158/158.
- `git diff --check` passed.
- `npm pack --dry-run --cache /private/tmp/logwork-helper-npm-cache` passed.
- `npm audit --omit=dev --audit-level=moderate --cache /private/tmp/logwork-helper-npm-cache` passed with 0 vulnerabilities.

Commit status:

- Pending local commit.
- No push performed.

## Definition Of Done

- Cached approval artifacts cannot be mutated into a different apply payload.
- Final apply overrides are either removed from MCP apply or included in the immutable approval fingerprint.
- Two concurrent MCP apply calls for the same `batchId` cannot both submit.
- Cached preview is consumed before submit, so there is no long-lived apply lock/in-flight state to clean up.
- Production external URLs require HTTPS.
- Auth form action, redirect, and token flow origins are validated against expected origins.
- Explicit local development override supports only localhost or loopback HTTP.
- Retryable HTTP responses are canceled or drained before retry.
- Retry tests are isolated from process-wide env config.
- Diagnostics redact mapping details by default; any full-detail mode is explicit.
- Diagnostics reports and error messages do not leak tokens, cookies, passwords, OTPs, auth codes, Keycloak state, nonce, tab IDs, raw HTML, or sensitive env values.
- `readNumber` fallback scanning is fixed because a focused fixture proved the bug.
- Per-file config/draft locks, explicit normalization return shape, shared project identity helpers, and list navigation helpers are deferred unless a focused failing test proves they are needed.
- Tests that mutate env restore it reliably.
- Focused tests and full `npm test` pass.
- `git diff --check`, `npm pack --dry-run`, and `npm audit --omit=dev --audit-level=moderate` pass.
- Local commit is pending.
- No `git push` is performed.

## Related Files

- `mcp-server.mjs`
- `config.mjs`
- `lib/diagnostics.mjs`
- `lib/http.mjs`
- `lib/api.mjs`
- `lib/api-auth.mjs`
- `lib/atomic-file.mjs`
- `lib/manual-apply-state.mjs`
- `lib/project-resolver.mjs`
- `test/mcp-smoke.test.mjs`
- `test/config.test.mjs`
- `test/diagnostics.test.mjs`
- `test/http.test.mjs`
- `test/auth-api.test.mjs`
- `test/api-timesheet-range.test.mjs`
- `test/resource-optimiser-fixtures.test.mjs`
- `test/manual-apply-state.test.mjs`

## Links

- [[problem-inventory|Problem Inventory]]
- [[P4-api-normalization-contract|P4 API Normalization Contract]]
- [[P5-manual-ui-maintainability|P5 Manual UI Maintainability]]
- [[P8-diagnostics-config-snapshot|P8 Diagnostics Config Snapshot]]
- [[P10-mcp-apply-provenance-hardening|P10 MCP Apply Provenance Hardening]]
- [[P11-auth-protocol-validation|P11 Auth Protocol Validation]]
- [[P12-network-reliability-policy|P12 Network Reliability Policy]]
- [[P14-environment-config-overrides|P14 Environment Config Overrides]]
- [[P15-local-state-integrity|P15 Local State Integrity]]
- [[P16-doctor-diagnostics-command|P16 Doctor Diagnostics Command]]
- [[P17-safer-apply-ux|P17 Safer Apply UX]]
- [[P19-manual-ui-cleanup-phase-2|P19 Manual UI Cleanup Phase 2]]
