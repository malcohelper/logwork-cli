---
type: pitch
pitch: P15
title: Local State Integrity
status: done
commit: af2502b
area: local-state
---

# P15 Local State Integrity

## Problem

Local state writes could leave partial or collided files. Project mapping config wrote directly to `.logwork-helper.json`, and manual drafts used a fixed `.tmp` path. Both are small files, but they influence write-path behavior and should be durable.

## Plan

- Extract a shared atomic file writer.
- Use unique temporary paths.
- Rename into place only after successful write.
- Clean up temporary files on failure.
- Preserve existing config and draft schemas.
- Reuse the helper for protocol result files.

## Executed

- Added `lib/atomic-file.mjs`.
- Updated project mapping config writes in `lib/logwork-config.mjs`.
- Updated manual draft writes in `lib/manual-drafts.mjs`.
- Reused the helper from `lib/protocol.mjs`.
- Added `test/atomic-file.test.mjs`.

## Definition Of Done

- Local state writes go through atomic temp-plus-rename.
- Rename failure cleans up temp files.
- Existing target content remains intact if write fails before rename.
- Project mapping and manual draft behavior remains compatible.

## Related Files

- `lib/atomic-file.mjs`
- `lib/logwork-config.mjs`
- `lib/manual-drafts.mjs`
- `lib/protocol.mjs`
- `test/atomic-file.test.mjs`

## Links

- [[problem-inventory|Problem Inventory]]
- [[P7-project-mapping-config-hygiene|P7 Project Mapping Config Hygiene]]
- [[P9-manual-draft-workspace-scope|P9 Manual Draft Workspace Scope]]
