export const RO_TARGET = 'ro';
export const JIRA_TARGET = 'jira';
export const BOTH_TARGET = 'both';

export const LOGWORK_TARGETS = Object.freeze([
  {
    key: RO_TARGET,
    label: 'Resource Optimiser',
    description: 'Log work to Resource Optimiser only.'
  },
  {
    key: JIRA_TARGET,
    label: 'Jira',
    description: 'Log Jira worklogs only.'
  },
  {
    key: BOTH_TARGET,
    label: 'Both',
    description: 'Preview and apply Resource Optimiser and Jira separately.'
  }
]);

export const AUTH_TARGETS = Object.freeze([
  {
    key: RO_TARGET,
    label: 'Resource Optimiser',
    description: 'Run Resource Optimiser API auth.'
  },
  {
    key: JIRA_TARGET,
    label: 'Jira',
    description: 'Show Jira PAT login command.'
  }
]);

export function parseTargetToken(value, {
  allowBoth = true
} = {}) {
  const normalized = normalizeTargetToken(value);
  if (!normalized) {
    return null;
  }

  if (['ro', 'resource', 'resource-optimiser', 'resource-optimizer', 'resource_optimiser', 'resource_optimizer'].includes(normalized)) {
    return RO_TARGET;
  }
  if (normalized === 'jira') {
    return JIRA_TARGET;
  }
  if (allowBoth && normalized === 'both') {
    return BOTH_TARGET;
  }
  return null;
}

export function targetLabel(target) {
  return LOGWORK_TARGETS.find((option) => option.key === target)?.label ||
    AUTH_TARGETS.find((option) => option.key === target)?.label ||
    String(target || 'unknown');
}

export function previewTargets(target) {
  if (target === BOTH_TARGET) {
    return [RO_TARGET, JIRA_TARGET];
  }
  return [target || RO_TARGET];
}

export function jiraLoginInstruction() {
  return 'Jira authentication required. Run `logwork-helper jira login` in a terminal, then retry this command.';
}

function normalizeTargetToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
}
