---
type: definition-of-done
project: logwork-helper
status: done
---

# Definition Of Done

## Global DoD

- Existing MCP/tool schemas remain backward compatible unless explicitly noted.
- No Resource Optimiser API contract changes.
- No secrets, tokens, passwords, OTPs, cookies, auth codes, or raw HTML are logged into docs or diagnostics.
- Each pitch is implemented in a local commit.
- No `git push` performed.
- Tests pass after each pitch.
- Working tree is clean after each commit.

## Verification Summary

| Pitch | Focused Verification | Full Verification |
| --- | --- | --- |
| P1 | resolver and batch workflow tests | `npm test` passed, 109 tests at the time |
| P2 | auth API form variant tests | `npm test` passed at the time |
| P3 | CLI/setup-user tests | `npm test` passed at the time |
| P4 | API/query workflow tests | `npm test` passed, 118 tests at the time |
| P5 | manual REPL tests | `npm test` passed, 119 tests at the time |
| P6 | MCP smoke tests | `npm test` passed, 120 tests |
| P7 | mapping/resolver/batch tests | `npm test` passed, 122 tests |
| P8 | diagnostics/CLI tests | `npm test` passed, 122 tests |
| P9 | manual REPL tests | `npm test` passed, 123 tests |
| P10 | MCP smoke/provenance tests | `npm test` passed, 126 tests |
| P11 | auth protocol tests | `npm test` passed, 130 tests |
| P12 | HTTP/API/auth focused tests | `npm test` passed, 134 tests |
| P13 | MCP/CLI/release tests | `npm test` passed, 137 tests |
| P14 | config/diagnostics/auth/API tests | `npm test` passed, 140 tests |
| P15 | atomic/project mapping/manual tests | `npm test` passed, 142 tests |
| P16 | CLI/diagnostics tests | `npm test` passed, 144 tests |
| P17 | batch/manual/MCP tests | `npm test` passed, 144 tests |
| P18 | API/query/fixture tests | `npm test` passed, 147 tests |
| P19 | manual apply/manual REPL tests | `npm test` passed, 149 tests |
| P20 | MCP apply, auth/origin, HTTP retry, diagnostics privacy, normalization fallback, env isolation tests | `npm test` passed, 158 tests; `git diff --check`, `npm pack --dry-run`, and `npm audit` passed |

## Final Local Commit Chain

1. `8b10644 improve project resolution safety`
2. `b6e4257 improve auth resilience`
3. `3c7dc5a improve setup onboarding`
4. `b6733a8 harden api normalization contract`
5. `9373443 improve manual UI maintainability`
6. `2f9e078 harden MCP preview approval safety`
7. `c0ab2ef harden project mapping config hygiene`
8. `52e9161 improve diagnostics config snapshot`
9. `4c075b8 scope manual drafts to workspace`
10. `6885adf harden MCP apply provenance`
11. `aabdaf8 harden auth protocol validation`
12. `61e75a4 add network reliability policy`
13. `75b936b add release engineering checks`
14. `5fc745f add environment config overrides`
15. `af2502b write local state atomically`
16. `9b2ba84 add doctor diagnostics command`
17. `09745dc add apply approval summaries`
18. `d8824a1 add resource optimiser fixture tests`
19. `f93ec55 extract manual apply state helpers`

## P20 Closure DoD

- Cached approval artifacts cannot be mutated into a different apply payload.
- Final apply overrides are rejected at the MCP apply boundary.
- Concurrent MCP apply for the same `batchId` cannot double-submit because cached approval is consumed before awaited submit work.
- Production external URLs require HTTPS; local HTTP is restricted to localhost/loopback overrides.
- Auth form, redirect, auth request, and token origins are compared against expected origins.
- Retryable HTTP response bodies are canceled or drained before retry.
- Mapping details are redacted by default in diagnostics, with explicit opt-in for full detail.
- `readNumber` fallback scanning was fixed after a focused fixture proved the bug.
- Per-file config/draft locks are deferred unless a concurrent-session test proves a real race.
- Explicit normalization return shape is deferred unless hidden diagnostics cause a concrete bug.
- Shared project identity and list navigation helpers are deferred unless P20 touches the same code for a proven bug.
- Diagnostics privacy tests cover config/env/auth/network fields.
- Env-mutating tests use reliable restore helpers.
- Full release gate passed; local-only commit is pending.
