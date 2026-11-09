import { formatHours } from './manual-logwork-wizard.mjs';

export function getManualApplyBlocker(preview) {
  if (!preview) {
    return 'No preview available. Run /logwork first.';
  }

  if (preview.errors?.length) {
    return 'Cannot apply preview with parse errors. Run /logwork again after fixing the text.';
  }

  if (preview.unresolvedEntries?.length) {
    return `Cannot apply preview with ${preview.unresolvedEntries.length} unresolved entries. Use /projects and /map, then /logwork again.`;
  }

  return null;
}

export function buildManualApplyConfirmation(preview) {
  const totalHours = totalPreviewHours(preview);
  const entryCount = preview?.entries?.length || 0;
  return `Apply ${entryCount} logwork entries totaling ${formatHours(totalHours)}h?`;
}

export function buildManualUnbookedConfirmation(preview) {
  return `This preview contains ${manualUnbookedEntryCount(preview)} unbooked entries. Submit them anyway?`;
}

export function manualUnbookedEntryCount(preview) {
  return preview?.unbookedEntries?.length || 0;
}

export function buildManualDuplicateConfirmation(preview) {
  const duplicates = (preview?.entries || []).filter((entry) => entry.possibleDuplicate);
  const list = duplicates.map((entry) => {
    const duplicate = entry.possibleDuplicate;
    return duplicate.source === 'batch'
      ? `${entry.id} repeats ${duplicate.entryId}`
      : `${entry.id} matches RO logwork ${duplicate.logworkId ?? '(no id)'}`;
  }).join(', ');
  return `This preview contains ${duplicates.length} possible duplicate entries (${list}). Submit them anyway?`;
}

export function manualDuplicateEntryCount(preview) {
  return (preview?.entries || []).filter((entry) => entry.possibleDuplicate).length;
}

export function totalPreviewHours(preview) {
  return (preview?.entries || []).reduce((sum, entry) => sum + Number(entry.hours || 0), 0);
}
