import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildManualApplyConfirmation,
  buildManualUnbookedConfirmation,
  getManualApplyBlocker,
  manualUnbookedEntryCount,
  totalPreviewHours
} from '../lib/manual-apply-state.mjs';

test('manual apply state reports blockers with existing user-facing copy', () => {
  assert.equal(getManualApplyBlocker(null), 'No preview available. Run /logwork first.');
  assert.equal(
    getManualApplyBlocker({ errors: [{ line: 1 }], unresolvedEntries: [] }),
    'Cannot apply preview with parse errors. Run /logwork again after fixing the text.'
  );
  assert.equal(
    getManualApplyBlocker({ errors: [], unresolvedEntries: [{ id: 'entry_1' }, { id: 'entry_2' }] }),
    'Cannot apply preview with 2 unresolved entries. Use /projects and /map, then /logwork again.'
  );
  assert.equal(getManualApplyBlocker(readyPreview()), null);
});

test('manual apply state formats confirmation prompts and totals', () => {
  const preview = readyPreview({
    entries: [
      { hours: 2 },
      { hours: 1.25 }
    ],
    unbookedEntries: [
      { id: 'entry_1' }
    ]
  });

  assert.equal(totalPreviewHours(preview), 3.25);
  assert.equal(buildManualApplyConfirmation(preview), 'Apply 2 logwork entries totaling 3.25h?');
  assert.equal(manualUnbookedEntryCount(preview), 1);
  assert.equal(buildManualUnbookedConfirmation(preview), 'This preview contains 1 unbooked entries. Submit them anyway?');
});

function readyPreview(overrides = {}) {
  return {
    errors: [],
    entries: [
      { hours: 2 }
    ],
    unresolvedEntries: [],
    unbookedEntries: [],
    ...overrides
  };
}
