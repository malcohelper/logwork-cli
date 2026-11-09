// Normalization diagnostics attached (non-enumerable) to normalized RO record lists.

const NORMALIZATION_DIAGNOSTICS_KEY = 'normalization';

const MAX_DIAGNOSTIC_ITEMS = 25;

export function getNormalizationDiagnostics(value) {
  return value?.[NORMALIZATION_DIAGNOSTICS_KEY] || emptyNormalizationDiagnostics();
}

export function createNormalizationDiagnostics(sourceShape = 'unknown') {
  return {
    status: 'ok',
    sourceShape,
    rowsRead: 0,
    rowsAccepted: 0,
    droppedRowCount: 0,
    warningCount: 0,
    warnings: [],
    droppedRows: []
  };
}

function emptyNormalizationDiagnostics() {
  return createNormalizationDiagnostics('unknown');
}

export function attachNormalizationDiagnostics(value, diagnostics) {
  Object.defineProperty(value, NORMALIZATION_DIAGNOSTICS_KEY, {
    value: finalizeNormalizationDiagnostics(diagnostics),
    enumerable: false,
    configurable: true
  });
  return value;
}

function finalizeNormalizationDiagnostics(diagnostics) {
  const warningCount = diagnostics.warnings.length;
  const droppedRowCount = diagnostics.droppedRows.length;
  return {
    ...diagnostics,
    status: warningCount || droppedRowCount ? 'warning' : 'ok',
    warningCount,
    droppedRowCount
  };
}

export function combineNormalizationDiagnostics(...items) {
  const diagnostics = createNormalizationDiagnostics('combined');
  for (const item of items) {
    const current = item?.warnings || item?.droppedRows
      ? item
      : getNormalizationDiagnostics(item);
    if (!current) {
      continue;
    }
    diagnostics.rowsRead += Number(current.rowsRead || 0);
    diagnostics.rowsAccepted += Number(current.rowsAccepted || 0);
    for (const warning of current.warnings || []) {
      pushDiagnostic(diagnostics.warnings, warning);
    }
    for (const dropped of current.droppedRows || []) {
      pushDiagnostic(diagnostics.droppedRows, dropped);
    }
  }
  return finalizeNormalizationDiagnostics(diagnostics);
}

export function addWarning(diagnostics, reason, details = {}) {
  if (!diagnostics) {
    return;
  }
  pushDiagnostic(diagnostics.warnings, compactDiagnostic({
    reason,
    ...details
  }));
}

export function addDroppedRow(diagnostics, reason, details = {}) {
  if (!diagnostics) {
    return;
  }
  pushDiagnostic(diagnostics.droppedRows, compactDiagnostic({
    reason,
    ...details
  }));
}

function pushDiagnostic(items, item) {
  if (items.length < MAX_DIAGNOSTIC_ITEMS) {
    items.push(item);
  }
}

function compactDiagnostic(details) {
  return Object.fromEntries(Object.entries(details).filter(([, value]) => (
    value !== undefined &&
    value !== null &&
    value !== ''
  )));
}

export function diagnosticProjectFields({ projectMemberId, projectId, projectName } = {}) {
  return compactDiagnostic({
    projectMemberId,
    projectId,
    projectName
  });
}
