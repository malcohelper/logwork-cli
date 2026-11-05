---
type: pitch
pitch: P11
title: Auth Protocol Validation
status: done
commit: aabdaf8
area: auth
---

# P11 Auth Protocol Validation

## Problem

Auth resilience handled Keycloak form variants, but the protocol-level safety checks were still too light for production-scale use. A changed or hostile auth response could redirect off-domain, replay the wrong `state`, or return a token with an unexpected `nonce`.

## Plan

- Generate and verify Keycloak `state` and `nonce`.
- Validate auth redirect host and returned state.
- Validate Keycloak form action hosts before credential submission.
- Validate token nonce when present.
- Keep diagnostics sanitized and avoid logging credentials or raw auth artifacts.

## Executed

- Updated `lib/api-auth.mjs` with state/nonce generation and validation.
- Added host checks for form actions and auth redirects.
- Added nonce checks for Keycloak token payloads.
- Extended `test/auth-api.test.mjs` with negative protocol cases.

## Definition Of Done

- Auth rejects state mismatch.
- Auth rejects off-domain form actions before submitting credentials.
- Auth rejects off-domain redirects.
- Auth rejects Keycloak token nonce mismatch when nonce is present.
- Existing Keycloak form variant tests still pass.

## Related Files

- `lib/api-auth.mjs`
- `test/auth-api.test.mjs`

## Links

- [[problem-inventory|Problem Inventory]]
- [[P2-auth-resilience|P2 Auth Resilience]]
- [[P12-network-reliability-policy|P12 Network Reliability Policy]]
