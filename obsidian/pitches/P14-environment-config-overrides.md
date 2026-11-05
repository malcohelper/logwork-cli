---
type: pitch
pitch: P14
title: Environment Config Overrides
status: done
commit: 5fc745f
area: configuration
---

# P14 Environment Config Overrides

## Problem

Runtime endpoints and auth URLs were hardcoded for the default Resource Optimiser / Vinova profile. That made non-default deployments or support diagnostics harder, and bad local edits could silently point the helper at unintended endpoints.

## Plan

- Keep production defaults unchanged.
- Add validated environment overrides for API, login, Keycloak, timeout, retry, and concurrency settings.
- Fail fast on invalid URL or numeric config.
- Include safe config profile and host context in diagnostics.
- Document supported environment variables.

## Executed

- Reworked `config.mjs` around `buildConfig(env)`.
- Added URL and numeric validation.
- Added safe runtime config snapshot fields in diagnostics.
- Added config and diagnostics tests.
- Updated README with environment override guidance.

## Definition Of Done

- Default `vinova` profile remains unchanged.
- Env overrides are explicit and validated.
- Invalid URLs and invalid numeric values throw on startup.
- Diagnostics include safe profile/host/HTTP policy context.
- No secrets or raw env values are added to diagnostics.

## Related Files

- `config.mjs`
- `lib/diagnostics.mjs`
- `test/config.test.mjs`
- `test/diagnostics.test.mjs`
- `README.md`

## Links

- [[problem-inventory|Problem Inventory]]
- [[P8-diagnostics-config-snapshot|P8 Diagnostics Config Snapshot]]
- [[P13-release-engineering-checks|P13 Release Engineering Checks]]
