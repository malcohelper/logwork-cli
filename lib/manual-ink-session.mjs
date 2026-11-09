// Manual session preview bookkeeping shared by the Ink app and its action hooks.
import { JIRA_TARGET, RO_TARGET } from './manual-targets.mjs';

export const RECONCILIATION_PERIOD_OPTIONS = [
  { key: 'today', label: 'Today', description: 'Compare today' },
  { key: 'yesterday', label: 'Yesterday', description: 'Compare yesterday' },
  { key: 'this_week', label: 'This week', description: 'Compare Monday through Sunday' },
  { key: 'last_week', label: 'Last week', description: 'Compare the previous week' },
  { key: 'this_month', label: 'This month', description: 'Compare the current month' },
  { key: 'last_month', label: 'Last month', description: 'Compare the previous month' }
];

export function setSessionPreview(session, target, preview) {
  session.activeTarget = target;
  session.previews = {
    ...(session.previews || {}),
    [target]: preview
  };
}

export function clearSessionPreviews(session) {
  session.previews = {
    [RO_TARGET]: null,
    [JIRA_TARGET]: null
  };
}

export function sessionPreview(session, target) {
  return session.previews?.[target] || null;
}

export function hasSessionPreview(session) {
  return Boolean(session.previews?.[RO_TARGET] || session.previews?.[JIRA_TARGET]);
}

export function activeSessionPreview(session) {
  if (session.activeTarget === JIRA_TARGET) {
    return sessionPreview(session, JIRA_TARGET);
  }
  return sessionPreview(session, RO_TARGET);
}
