---
type: index
project: logwork-helper
status: active
created: 2026-06-10
---

# Logwork Helper Documentation Vault

This vault documents the twenty-one completed safety, reliability, release, and product-surface pitches, plus current release and operator documentation for Logwork Helper.

## Navigation

- [[problem-inventory|Problem Inventory]]
- [[pitch-timeline|Pitch Timeline]]
- [[definition-of-done|Definition of Done]]
- [[review-report|Multi-Phase Review Report]]

## Product And Release Notes

- [[releases/v0.1.10|v0.1.10 - Jira Self-hosted And RO/Jira Target Flow]]
- [[changes/uncommitted-after-v0.1.10|Uncommitted Changes After v0.1.10]]
- [[guides/cli-mcp-operations|CLI And MCP Operations Guide]]

## Pitch Map

| Pitch | Area | Commit | Status | Main Outcome |
| --- | --- | --- | --- | --- |
| [[pitches/P1-project-resolution-safety|P1 Project Resolution Safety]] | project resolution | `8b10644` | done | Safer preview resolution and conflict metadata. |
| [[pitches/P2-auth-resilience|P2 Auth Resilience]] | auth | `b6e4257` | done | Keycloak form variants and safe auth diagnostics. |
| [[pitches/P3-product-surface-onboarding|P3 Product Surface / Onboarding]] | onboarding | `3c7dc5a` | done | Setup checklist, clearer help, README alignment. |
| [[pitches/P4-api-normalization-contract|P4 API Normalization Contract]] | API normalization | `b6733a8` | done | Original label: Pitch P3 API normalization. Diagnostics for malformed Resource Optimiser data. |
| [[pitches/P5-manual-ui-maintainability|P5 Manual UI Maintainability]] | manual CLI UI | `9373443` | done | Split large Ink app into UI/auth modules. |
| [[pitches/P6-mcp-preview-approval-safety|P6 MCP Preview Approval Safety]] | MCP apply safety | `2f9e078` | done | Batch mismatch guard and cloned preview cache. |
| [[pitches/P7-project-mapping-config-hygiene|P7 Project Mapping Config Hygiene]] | config/mapping | `c0ab2ef` | done | Normalized, deduped, merged mapping config. |
| [[pitches/P8-diagnostics-config-snapshot|P8 Diagnostics Config Snapshot]] | diagnostics | `52e9161` | done | Sanitized config snapshot in support report. |
| [[pitches/P9-manual-draft-workspace-scope|P9 Manual Draft Workspace Scope]] | manual drafts | `4c075b8` | done | Draft picker scoped to current workspace. |
| [[pitches/P10-mcp-apply-provenance-hardening|P10 MCP Apply Provenance Hardening]] | MCP apply safety | `6885adf` | done | MCP apply must use cached preview provenance. |
| [[pitches/P11-auth-protocol-validation|P11 Auth Protocol Validation]] | auth | `aabdaf8` | done | State, nonce, redirect, and form-action validation. |
| [[pitches/P12-network-reliability-policy|P12 Network Reliability Policy]] | networking | `61e75a4` | done | Shared timeout, retry, and redacted error policy. |
| [[pitches/P13-release-engineering-checks|P13 Release Engineering Checks]] | release | `75b936b` | done | CI, release checklist, release scripts, package version source. |
| [[pitches/P14-environment-config-overrides|P14 Environment Config Overrides]] | configuration | `5fc745f` | done | Validated env/profile overrides and safe diagnostics context. |
| [[pitches/P15-local-state-integrity|P15 Local State Integrity]] | local state | `af2502b` | done | Atomic writes for config, drafts, and protocol state. |
| [[pitches/P16-doctor-diagnostics-command|P16 Doctor Diagnostics Command]] | diagnostics | `9b2ba84` | done | `doctor` alias for sanitized setup health reports. |
| [[pitches/P17-safer-apply-ux|P17 Safer Apply UX]] | apply UX | `09745dc` | done | Approval and submission summaries for safer writes. |
| [[pitches/P18-integration-fixture-suite|P18 Integration Fixture Suite]] | testing | `d8824a1` | done | File-based Resource Optimiser normalization fixtures. |
| [[pitches/P19-manual-ui-cleanup-phase-2|P19 Manual UI Cleanup Phase 2]] | manual UI | `f93ec55` | done | Extracted manual apply-state helpers. |
| [[pitches/P20-review-closure-safety-hardening|P20 Review Closure / Safety Hardening]] | safety hardening | `96e3c1c` | done | Final closure hardening for approval immutability, duplicate apply prevention, origins, diagnostics privacy, retry hygiene, and test env isolation. |
| [[pitches/P21-deferred-cleanup-locks-and-helpers|P21 Deferred Cleanup / Locks And Helpers]] | deferred cleanup | `876f3da` | done | Per-file config/draft locks, shared project/list helpers, and explicit normalization result APIs. |

## Architecture Threads

- Safety before writes: [[pitches/P1-project-resolution-safety]], [[pitches/P6-mcp-preview-approval-safety]], [[pitches/P10-mcp-apply-provenance-hardening]], [[pitches/P17-safer-apply-ux]], [[pitches/P20-review-closure-safety-hardening]]
- Auth and supportability: [[pitches/P2-auth-resilience]], [[pitches/P8-diagnostics-config-snapshot]], [[pitches/P11-auth-protocol-validation]], [[pitches/P16-doctor-diagnostics-command]]
- Product surface clarity: [[pitches/P3-product-surface-onboarding]], [[pitches/P5-manual-ui-maintainability]], [[pitches/P19-manual-ui-cleanup-phase-2]]
- Data correctness: [[pitches/P4-api-normalization-contract]], [[pitches/P7-project-mapping-config-hygiene]], [[pitches/P18-integration-fixture-suite]], [[pitches/P21-deferred-cleanup-locks-and-helpers]]
- Release and operations: [[pitches/P12-network-reliability-policy]], [[pitches/P13-release-engineering-checks]], [[pitches/P14-environment-config-overrides]], [[pitches/P15-local-state-integrity]], [[pitches/P21-deferred-cleanup-locks-and-helpers]]

## Current Git State At Time Of Documentation

- Branch: `main`
- Released baseline: tag `v0.1.10`, commit `ec79dbe`
- Snapshot date: 2026-07-15
- Before this documentation update: 30 tracked files modified and 21 untracked files, 51 files total
- Package version in the worktree: `0.1.10`
- The post-`v0.1.10` worktree is not committed or published
