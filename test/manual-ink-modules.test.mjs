import test from 'node:test';
import assert from 'node:assert/strict';
import { RECONCILIATION_PERIODS } from '../lib/reconciliation-workflow.mjs';
import { AUTH_TARGETS, JIRA_TARGET, LOGWORK_TARGETS, RO_TARGET } from '../lib/manual-targets.mjs';
import {
  activeSessionPreview,
  clearSessionPreviews,
  hasSessionPreview,
  RECONCILIATION_PERIOD_OPTIONS,
  sessionPreview,
  setSessionPreview
} from '../lib/manual-ink-session.mjs';
import { renderManualInteraction } from '../lib/manual-ink-interaction.mjs';
import { AuthPrompt } from '../lib/manual-ink-auth.mjs';
import {
  CommandInput,
  ConfirmDialog,
  DatePicker,
  DraftPicker,
  McpClientPicker,
  ProjectPicker,
  SelectPrompt,
  TargetPicker,
  TaskEditPicker,
  TaskRemovePicker
} from '../lib/manual-ink-ui.mjs';

test('session preview helpers track one preview per target and the active one', () => {
  const session = {};
  assert.equal(hasSessionPreview(session), false);
  assert.equal(activeSessionPreview(session), null);

  const roPreview = { batchId: 'ro-1' };
  const jiraPreview = { batchId: 'jira-1' };
  setSessionPreview(session, RO_TARGET, roPreview);
  assert.equal(session.activeTarget, RO_TARGET);
  assert.equal(activeSessionPreview(session), roPreview);

  setSessionPreview(session, JIRA_TARGET, jiraPreview);
  assert.equal(session.activeTarget, JIRA_TARGET);
  assert.equal(sessionPreview(session, RO_TARGET), roPreview);
  assert.equal(activeSessionPreview(session), jiraPreview);
  assert.equal(hasSessionPreview(session), true);

  clearSessionPreviews(session);
  assert.deepEqual(session.previews, { [RO_TARGET]: null, [JIRA_TARGET]: null });
  assert.equal(hasSessionPreview(session), false);
  assert.equal(activeSessionPreview(session), null);
});

test('a Both session shows the RO preview unless Jira is active', () => {
  const session = { activeTarget: 'both', previews: { [RO_TARGET]: { id: 'ro' }, [JIRA_TARGET]: { id: 'jira' } } };
  assert.deepEqual(activeSessionPreview(session), { id: 'ro' });
});

test('reconciliation period options cover every reconciliation period', () => {
  assert.deepEqual(RECONCILIATION_PERIOD_OPTIONS.map((option) => option.key), RECONCILIATION_PERIODS);
  for (const option of RECONCILIATION_PERIOD_OPTIONS) {
    assert.ok(option.label && option.description, option.key);
  }
});

function interactionProps(overrides = {}) {
  const noop = () => {};
  const calls = [];
  const record = (name) => (...args) => calls.push([name, ...args]);
  return {
    calls,
    props: {
      authPrompt: null,
      authActive: false,
      pendingConfirm: null,
      pendingSelect: null,
      wizard: null,
      inputValue: '',
      selectedIndex: 0,
      setInputValue: record('setInputValue'),
      setSelectedIndex: record('setSelectedIndex'),
      setAuthPrompt: record('setAuthPrompt'),
      setWizard: record('setWizard'),
      setActivePanel: record('setActivePanel'),
      resolveAuthPrompt: noop,
      rejectAuthPrompt: noop,
      resolveConfirm: noop,
      changeSelect: record('changeSelect'),
      resolveSelect: record('resolveSelect'),
      exit: record('exit'),
      executeCommand: record('executeCommand'),
      submitInput: noop,
      startLogworkWizard: record('startLogworkWizard'),
      startNewLogworkWizard: record('startNewLogworkWizard'),
      selectWizardDate: record('selectWizardDate'),
      selectWizardProject: record('selectWizardProject'),
      cancelMcpClientPicker: record('cancelMcpClientPicker'),
      cancelCurrentLogwork: record('cancelCurrentLogwork'),
      restoreTaskEditorPanel: record('restoreTaskEditorPanel'),
      resumeManualDraft: record('resumeManualDraft'),
      deleteSavedDraft: record('deleteSavedDraft'),
      returnFromDraftPicker: record('returnFromDraftPicker'),
      confirmRemoveTasks: record('confirmRemoveTasks'),
      cancelRemoveTasks: record('cancelRemoveTasks'),
      selectTaskForEdit: record('selectTaskForEdit'),
      ...overrides
    }
  };
}

test('the interaction area puts auth first, then a pending confirm', () => {
  const credentials = renderManualInteraction(interactionProps({
    authPrompt: { step: 'credentials' },
    authActive: true,
    pendingConfirm: { message: 'Apply?' }
  }).props);
  assert.equal(credentials.type, AuthPrompt);
  assert.deepEqual(credentials.props.prompt, { step: 'credentials' });

  const working = renderManualInteraction(interactionProps({ authActive: true, pendingConfirm: { message: 'Apply?' } }).props);
  assert.equal(working.type, AuthPrompt);
  assert.deepEqual(working.props.prompt, { step: 'working' });

  const confirm = renderManualInteraction(interactionProps({
    pendingConfirm: { message: 'Apply?', initialValue: false },
    wizard: { step: 'select_date', dateOptions: [], dateIndex: 0 }
  }).props);
  assert.equal(confirm.type, ConfirmDialog);
  assert.equal(confirm.props.message, 'Apply?');
  assert.equal(confirm.props.initialValue, false);
});

test('each wizard step renders its picker', () => {
  const cases = [
    [{ step: 'select_logwork_target' }, TargetPicker],
    [{ step: 'select_auth_target' }, TargetPicker],
    [{ step: 'select_reconciliation_period', periodIndex: 2 }, TargetPicker],
    [{ step: 'select_draft', drafts: [] }, DraftPicker],
    [{ step: 'select_date', dateOptions: [], dateIndex: 0 }, DatePicker],
    [{ step: 'select_project', projectOptions: [], projectIndex: 0 }, ProjectPicker],
    [{ step: 'select_mcp_client' }, McpClientPicker],
    [{ step: 'remove_tasks', tasks: [] }, TaskRemovePicker],
    [{ step: 'edit_task_select', tasks: [] }, TaskEditPicker],
    [{ step: 'edit_tasks', tasks: [] }, CommandInput],
    [{ step: 'edit_task_replace', tasks: [] }, CommandInput],
    [null, CommandInput]
  ];
  for (const [wizard, component] of cases) {
    assert.equal(renderManualInteraction(interactionProps({ wizard }).props).type, component, wizard?.step || 'idle');
  }

  const targets = (wizard) => renderManualInteraction(interactionProps({ wizard }).props).props;
  assert.equal(targets({ step: 'select_logwork_target' }).targets, LOGWORK_TARGETS);
  assert.equal(targets({ step: 'select_auth_target' }).targets, AUTH_TARGETS);
  assert.equal(targets({ step: 'select_reconciliation_period', periodIndex: 2 }).targets, RECONCILIATION_PERIOD_OPTIONS);
  assert.equal(targets({ step: 'select_reconciliation_period', periodIndex: 2 }).selectedIndex, 2);
});

test('the command input mode follows the wizard step', () => {
  const mode = (wizard) => renderManualInteraction(interactionProps({ wizard }).props).props.mode;
  assert.equal(mode(null), 'command');
  assert.equal(mode({ step: 'edit_tasks', tasks: [] }), 'task');
  assert.equal(mode({ step: 'edit_task_replace', tasks: [] }), 'task-edit');
});

test('picker callbacks run the matching actions', () => {
  const auth = interactionProps({ wizard: { step: 'select_auth_target' } });
  renderManualInteraction(auth.props).props.onSelect({ key: 'jira' });
  assert.deepEqual(auth.calls, [['executeCommand', { type: 'auth', target: 'jira' }]]);

  const period = interactionProps({ wizard: { step: 'select_reconciliation_period' } });
  renderManualInteraction(period.props).props.onSelect({ key: 'last_week' });
  assert.deepEqual(period.calls, [['executeCommand', { type: 'reconcile', period: 'last_week' }]]);

  const target = interactionProps({ wizard: { step: 'select_logwork_target' } });
  const picker = renderManualInteraction(target.props).props;
  picker.onSelect({ key: 'both' });
  picker.onCancel();
  assert.deepEqual(target.calls[0], ['startLogworkWizard', 'both']);
  assert.deepEqual(target.calls.slice(1), [
    ['setWizard', null],
    ['setActivePanel', { kind: 'idle', title: 'Ready', text: 'Type / for commands.' }]
  ]);

  const drafts = interactionProps({ wizard: { step: 'select_draft', drafts: [{ id: 'd1' }], draftSource: 'start' } });
  const draftPicker = renderManualInteraction(drafts.props).props;
  assert.equal(draftPicker.includeStartNew, true);
  draftPicker.onResume({ id: 'd1' });
  draftPicker.onDelete({ id: 'd1' });
  draftPicker.onStartNew();
  draftPicker.onCancel();
  assert.deepEqual(drafts.calls, [
    ['resumeManualDraft', { id: 'd1' }],
    ['deleteSavedDraft', { id: 'd1' }],
    ['startNewLogworkWizard', RO_TARGET],
    ['returnFromDraftPicker']
  ]);
});

test('Escape in the command input exits, cancels the session or leaves task replace', () => {
  const idle = interactionProps();
  renderManualInteraction(idle.props).props.onEscape();
  assert.deepEqual(idle.calls, [['exit']]);

  const editing = interactionProps({ wizard: { step: 'edit_tasks', tasks: [] } });
  renderManualInteraction(editing.props).props.onEscape();
  assert.deepEqual(editing.calls, [['cancelCurrentLogwork']]);

  const replacing = interactionProps({ wizard: { step: 'edit_task_replace', tasks: [] } });
  renderManualInteraction(replacing.props).props.onEscape();
  assert.equal(replacing.calls[0][0], 'setWizard');
  assert.deepEqual(replacing.calls[0][1]({ step: 'edit_task_replace', editIndex: 1 }), { step: 'edit_tasks', editIndex: 1 });
  assert.deepEqual(replacing.calls[1], ['restoreTaskEditorPanel']);
});

test('a pending select renders the select prompt over the wizard', () => {
  const { props, calls } = interactionProps({
    pendingSelect: { message: 'Which RO project?', options: [{ value: 'p', label: 'FCS' }], selectedIndex: 0 },
    wizard: { step: 'select_date', dateOptions: [], dateIndex: 0 }
  });
  const element = renderManualInteraction(props);
  assert.equal(element.type, SelectPrompt);
  assert.equal(element.props.message, 'Which RO project?');
  element.props.onChange(1);
  element.props.onResolve('p');
  assert.deepEqual(calls, [['changeSelect', 1], ['resolveSelect', 'p']]);

  const confirmFirst = renderManualInteraction(interactionProps({
    pendingConfirm: { message: 'Apply?' },
    pendingSelect: { message: 'Which?', options: [] }
  }).props);
  assert.equal(confirmFirst.type, ConfirmDialog);
});
