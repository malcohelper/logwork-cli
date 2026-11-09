import { formatNodePathIssue, inspectNodePath } from './node-runtime.mjs';
import {
  loadReminderConfig,
  normalizeReminderConfig,
  normalizeReminderRepos,
  saveReminderConfig
} from './reminder-config.mjs';
import {
  getReminderSchedulerStatus,
  installReminderScheduler,
  removeReminderScheduler
} from './reminder-scheduler.mjs';
import { loadReminderState } from './reminder-state.mjs';
import { sendTestReminderNotification } from './reminder-workflow.mjs';

// repos: undefined keeps the configured commit repos; an array (even empty)
// replaces them.
export async function enableLogworkReminder({
  time,
  target,
  repos,
  confirm,
  loadConfig = loadReminderConfig,
  saveConfig = saveReminderConfig,
  installScheduler = installReminderScheduler,
  removeScheduler = removeReminderScheduler
} = {}) {
  requireConfirmation(confirm, 'enable');
  const current = await loadConfig();
  const config = normalizeReminderConfig({
    ...current,
    enabled: true,
    ...(time ? { time } : {}),
    ...(target ? { target } : {}),
    ...(repos !== undefined ? { repos: normalizeReminderRepos(repos) } : {})
  });

  const scheduler = await installScheduler(config);
  try {
    await saveConfig(config);
  } catch (error) {
    await removeScheduler().catch(() => {});
    throw error;
  }

  return {
    status: 'enabled',
    config,
    scheduler,
    summary: [
      `Enabled ${config.target} logwork reminder at ${config.time}, Monday-Friday, using ${scheduler.scheduler}.`,
      config.repos.length
        ? `Commit summary repos: ${config.repos.join(', ')}.`
        : 'No reminder repos set; add --repo <path> to include today\'s commits (repos on project mappings are also used).'
    ].join('\n')
  };
}

export async function disableLogworkReminder({
  confirm,
  loadConfig = loadReminderConfig,
  saveConfig = saveReminderConfig,
  removeScheduler = removeReminderScheduler
} = {}) {
  requireConfirmation(confirm, 'disable');
  const current = await loadConfig();
  const scheduler = await removeScheduler();
  const config = await saveConfig({
    ...current,
    enabled: false
  });
  return {
    status: 'disabled',
    config,
    scheduler,
    summary: 'Disabled the logwork reminder and removed its OS schedule.'
  };
}

export async function getLogworkReminderStatus({
  loadConfig = loadReminderConfig,
  loadState = loadReminderState,
  schedulerStatus = getReminderSchedulerStatus,
  inspectNode = inspectNodePath
} = {}) {
  const [config, state, scheduler] = await Promise.all([
    loadConfig(),
    loadState(),
    schedulerStatus()
  ]);
  const consistent = config.enabled === scheduler.installed;
  const lines = [
    `Logwork reminder: ${config.enabled ? 'enabled' : 'disabled'}.`,
    `Schedule: Monday-Friday at ${config.time}; target ${config.target}.`,
    `OS scheduler: ${scheduler.scheduler} ${scheduler.installed ? 'installed' : 'not installed'}.`
  ];
  if (config.repos?.length) {
    lines.push(`Commit summary repos: ${config.repos.join(', ')}.`);
  }
  if (!consistent) {
    lines.push('Warning: reminder config and OS scheduler are out of sync; run reminder enable or disable again.');
  }
  // The schedule stores an absolute node path; nvm or Homebrew can remove it
  // while the schedule still looks installed.
  const nodeCheck = scheduler.nodePath
    ? await inspectNode(scheduler.nodePath).catch(() => ({ status: 'unknown', recordedPath: scheduler.nodePath }))
    : null;
  const nodeIssue = nodeCheck ? formatNodePathIssue('reminder', nodeCheck) : '';
  if (nodeIssue) {
    lines.push(`Warning: ${nodeIssue}`);
  }
  if (state?.lastRunAt) {
    lines.push(`Last run: ${state.lastRunAt}, status ${state.lastStatus || 'unknown'}.`);
  }
  return {
    status: 'ok',
    config,
    scheduler,
    state,
    consistent,
    ...(nodeCheck ? { nodeCheck } : {}),
    summary: lines.join('\n')
  };
}

export async function testLogworkReminder({
  target,
  confirm,
  loadConfig = loadReminderConfig,
  sendTest = sendTestReminderNotification
} = {}) {
  requireConfirmation(confirm, 'test');
  const config = await loadConfig();
  return sendTest({
    target: target || config.target
  });
}

function requireConfirmation(confirm, action) {
  if (confirm !== true) {
    throw new Error(`Reminder ${action} requires confirm: true.`);
  }
}
