---
type: pitch
pitch: P7
title: Project Mapping Config Hygiene
status: done
commit: c0ab2ef
area: config
---

# P7 Project Mapping Config Hygiene

## Problem

Project mappings influence auto-resolution. Dirty mapping config could keep duplicate ticket prefixes, untrimmed IDs, or duplicate mappings across legacy/user/project sources.

## Plan

- Normalize mappings at load time.
- Drop mappings without project identity.
- Trim optional IDs.
- Uppercase and dedupe ticket prefixes.
- Dedupe keywords.
- Merge duplicate mappings across legacy, user, and project config sources instead of overwriting ticket/keyword context.

## Executed

- Updated `lib/logwork-config.mjs`.
- Added config normalization and merge tests in `test/project-mapping-workflow.test.mjs`.

## Definition Of Done

- `normalizeConfig` cleans arrays and drops identity-free mappings.
- Duplicate mappings across sources merge tickets and keywords.
- Project-level config can still override display project name.
- Mapping workflow and resolver tests remain green.

## Related Files

- `lib/logwork-config.mjs`
- `test/project-mapping-workflow.test.mjs`

## Links

- [[problem-inventory|Problem Inventory]]
- [[P1-project-resolution-safety|P1 Project Resolution Safety]]
- [[P8-diagnostics-config-snapshot|P8 Diagnostics Config Snapshot]]
