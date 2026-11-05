---
type: problem-inventory
project: logwork-helper
status: done
---

# Problem Inventory

This inventory captures the problem set that drove the twenty-one executed or implemented safety, reliability, release, and product-surface pitches.

## P0 Product Risks

1. Project resolution could auto-select the wrong project when booked projects and configured mappings disagreed.
2. Auth flows depended on Keycloak form shapes that may drift.
3. First-run onboarding was too raw and made users decide too much from ungrouped output.
4. Resource Optimiser API payloads could change shape or include malformed data without enough diagnostics.
5. Manual CLI UI lived in one large file, making future changes risky.
6. MCP preview approval cache could apply stale or mismatched approval artifacts.
7. Mapping config could accumulate dirty or duplicate data and affect resolution silently.
8. Diagnostics report did not show enough safe config context for support.
9. Manual drafts were stored globally and could appear in the wrong repository context.
10. MCP apply needed stricter provenance enforcement at the boundary where preview cache exists.
11. Auth protocol validation needed explicit state, nonce, redirect, and form-action checks.
12. Network behavior needed consistent timeout, retry, and redacted error policy.
13. Release readiness needed repeatable CI and local release gates.
14. Runtime endpoints and profiles needed safe, validated overrides.
15. Local config, draft, and protocol state writes needed atomicity.
16. Setup health checks needed a discoverable `doctor` command.
17. Apply UX needed compact approval totals and project breakdowns before writes.
18. API normalization needed file-based fixtures for Resource Optimiser contract drift.
19. Manual apply UI logic needed pure helper extraction for maintainability.
20. Final release closure needed hardening around approval immutability, duplicate apply prevention, HTTPS/origin policy, diagnostics privacy, retry hygiene, normalization fallback, and test env isolation.
21. Deferred cleanup needed per-file config/draft locks, shared project/list helpers, and an explicit normalization result API without breaking existing callers.

## Safety Principles

- Preview must explain why a project was selected.
- Apply must never submit unresolved, mismatched, or unapproved entries.
- Diagnostics must help support without leaking credentials, tokens, raw HTML, OTPs, cookies, or auth codes.
- Config and draft state must be normalized before it influences write paths.
- MCP and CLI schemas remain backward compatible unless explicitly planned otherwise.
- Network failures should be bounded by timeout/retry policy and should not duplicate writes.
- Release gates should be repeatable locally and in CI.
- Local state writes should be atomic because local state influences write decisions.
- Approval artifacts should be immutable from preview through apply.
- Concurrent write attempts should be rejected or serialized explicitly.
- Production network origins should not silently downgrade from HTTPS.
- Tests that mutate process-wide state must restore it reliably.
- Compatibility cleanup should prefer additive APIs before breaking existing call contracts.

## Pitch Coverage

- P1 covered problem 1.
- P2 covered problem 2.
- P3 covered problem 3.
- P4 covered problem 4.
- P5 covered problem 5.
- P6 covered problem 6.
- P7 covered problem 7.
- P8 covered problem 8.
- P9 covered problem 9.
- P10 covered problem 10.
- P11 covered problem 11.
- P12 covered problem 12.
- P13 covered problem 13.
- P14 covered problem 14.
- P15 covered problem 15.
- P16 covered problem 16.
- P17 covered problem 17.
- P18 covered problem 18.
- P19 covered problem 19.
- P20 covered problem 20.
- P21 covered problem 21 and closed the prioritized P20 deferred cleanup items.
