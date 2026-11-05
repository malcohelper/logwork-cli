---
type: pitch
pitch: P2
title: Auth Resilience
status: done
commit: b6e4257
area: auth
---

# P2 Auth Resilience

## Problem

Keycloak auth pages can vary in form shape and field names. The helper needed to remain robust while keeping diagnostics safe.

## Plan

- Harden Keycloak form detection for credentials, device selection, and OTP variants.
- Avoid leaking password, OTP, cookies, tokens, auth codes, raw HTML, or dynamic Keycloak URL parameters.
- Add fixtures for variant form names and repeated auth pages.
- Keep auth tool schemas unchanged.

## Executed

- Updated `lib/api-auth.mjs` to support more Keycloak form variants.
- Added safe diagnostic paths for unsupported or repeated auth form states.
- Extended `test/auth-api.test.mjs` with credential, device, OTP, and sanitized diagnostic fixtures.

## Definition Of Done

- Variant credential and OTP field names are accepted.
- Mixed OTP/device form paths are handled.
- Repeated OTP/device pages fail safely.
- Unsupported forms report sanitized diagnostics.
- No credential material appears in diagnostics or test assertions.

## Related Files

- `lib/api-auth.mjs`
- `test/auth-api.test.mjs`

## Links

- [[problem-inventory|Problem Inventory]]
- [[P8-diagnostics-config-snapshot|P8 Diagnostics Config Snapshot]]
