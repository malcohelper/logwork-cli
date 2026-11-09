import React, {
  useCallback,
  useMemo,
  useRef,
  useState
} from 'react';
import { Box, render, useApp } from 'ink';
import { isAuthRequiredError } from './auth-errors.mjs';
import { isDryRun } from './config.mjs';
import { isJiraAuthRequiredError } from './jira-auth.mjs';
import {
  getCommandSuggestions,
  TASK_COMMANDS
} from './manual-commands.mjs';
import { jiraLoginInstruction } from './manual-targets.mjs';
import {
  completeCommandValue,
  CurrentPanel,
  HeaderBar,
  LoadingLine,
  loadingMessageForCommand,
  panelTitleForCommand,
  StatusBar
} from './manual-ink-ui.mjs';
import { createInkCredentialProvider } from './manual-ink-auth.mjs';
import {
  activeSessionPreview,
  hasSessionPreview
} from './manual-ink-session.mjs';
import { useLogworkWizard } from './manual-ink-wizard.mjs';
import { useDraftActions } from './manual-ink-draft-actions.mjs';
import { useTaskEditorActions } from './manual-ink-task-editor.mjs';
import { renderManualInteraction } from './manual-ink-interaction.mjs';

export {
  CommandInput,
  ConfirmDialog,
  CurrentPanel,
  DatePicker,
  DraftPicker,
  HeaderBar,
  LoadingLine,
  McpClientPicker,
  OutputPanel,
  ProjectChart,
  ProjectPicker,
  SelectionList,
  SlashMenu,
  StatusBar,
  TargetPicker,
  TaskEditPicker,
  TaskRemovePicker,
  chartLineColor,
  commandItems,
  formatTaskHours,
  loadingMessageForCommand,
  panelColor,
  panelTitleForCommand,
  renderProjectChartText,
  sameProjectIdentity
} from './manual-ink-ui.mjs';
export {
  AuthCredentialsPrompt,
  AuthDevicePrompt,
  AuthOtpPrompt,
  AuthPrompt,
  createInkCredentialProvider
} from './manual-ink-auth.mjs';

const h = React.createElement;

export async function runManualInkApp({
  input,
  output,
  cwd = process.cwd(),
  workflows,
  controller,
  showIntro = true,
  updateNotice = ''
} = {}) {
  const app = render(h(ManualApp, {
    cwd,
    workflows,
    controller,
    showIntro,
    updateNotice
  }), {
    stdin: input,
    stdout: output,
    stderr: output
  });
  await app.waitUntilExit();
}

export function ManualApp({
  cwd = process.cwd(),
  workflows,
  controller,
  showIntro = true,
  updateNotice = ''
}) {
  const { exit } = useApp();
  const sessionRef = useRef(controller.createManualSession());
  const confirmResolverRef = useRef(null);
  const authResolverRef = useRef(null);
  const authRejecterRef = useRef(null);
  const [inputValue, setInputValue] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [activePanel, setActivePanel] = useState(() => ({
    kind: 'idle',
    title: 'Ready',
    text: showIntro
      ? ['Type / for commands.', updateNotice].filter(Boolean).join('\n')
      : 'Ready.'
  }));
  const [loading, setLoading] = useState('');
  const [pendingConfirm, setPendingConfirm] = useState(null);
  const [authPrompt, setAuthPrompt] = useState(null);
  const [authActive, setAuthActive] = useState(false);
  const [wizard, setWizard] = useState(null);

  const prompts = useMemo(() => ({
    confirm(message, initialValue = true) {
      return new Promise((resolveValue) => {
        confirmResolverRef.current = resolveValue;
        setPendingConfirm({
          message,
          initialValue
        });
      });
    }
  }), []);

  const resolveConfirm = useCallback((value) => {
    const resolver = confirmResolverRef.current;
    confirmResolverRef.current = null;
    setPendingConfirm(null);
    if (resolver) {
      resolver(Boolean(value));
    }
  }, []);

  const credentialProvider = useMemo(() => createInkCredentialProvider({
    resolverRef: authResolverRef,
    rejecterRef: authRejecterRef,
    setAuthPrompt,
    setActivePanel,
    setInputValue,
    setSelectedIndex
  }), []);

  const inkWorkflows = useMemo(() => ({
    ...workflows,
    async loginResourceOptimiser(options = {}) {
      setAuthActive(true);
      try {
        return await workflows.loginResourceOptimiser({
          ...options,
          credentialProvider: options.credentialProvider || credentialProvider
        });
      } finally {
        setAuthActive(false);
        setAuthPrompt(null);
        setInputValue('');
        setSelectedIndex(0);
      }
    }
  }), [credentialProvider, workflows]);

  const resolveAuthPrompt = useCallback((value) => {
    const resolver = authResolverRef.current;
    authResolverRef.current = null;
    authRejecterRef.current = null;
    setAuthPrompt(null);
    setInputValue('');
    setSelectedIndex(0);
    if (resolver) {
      resolver(value);
    }
  }, []);

  const rejectAuthPrompt = useCallback((error = new Error('Resource Optimiser authentication cancelled.')) => {
    const rejecter = authRejecterRef.current;
    authResolverRef.current = null;
    authRejecterRef.current = null;
    setAuthPrompt(null);
    setInputValue('');
    setSelectedIndex(0);
    if (rejecter) {
      rejecter(error);
    }
  }, []);

  const runWithInlineAuth = useCallback(async (action) => {
    try {
      return await action();
    } catch (error) {
      if (!isAuthRequiredError(error)) {
        throw error;
      }
      setActivePanel({
        kind: 'auth',
        title: 'Authentication',
        text: 'Resource Optimiser authentication required. Enter credentials in this CLI panel.'
      });
      setLoading('Authenticating Resource Optimiser...');
      await inkWorkflows.loginResourceOptimiser();
      return action();
    }
  }, [inkWorkflows]);

  const runWithJiraAuthInstruction = useCallback(async (action) => {
    try {
      return await action();
    } catch (error) {
      if (!isJiraAuthRequiredError(error)) {
        throw error;
      }
      throw new Error(jiraLoginInstruction());
    }
  }, []);

  const setCommandPanel = useCallback((title, kind = 'output') => {
    const lines = [];
    setActivePanel({
      kind,
      title,
      text: ''
    });
    return (message = '') => {
      lines.push(String(message ?? ''));
      setActivePanel({
        kind,
        title,
        text: lines.join('\n')
      });
    };
  }, []);

  const executeCommand = useCallback(async (command) => {
    if (command.type !== 'apply' && command.type !== 'diagnostics') {
      setWizard(null);
    }
    setLoading(loadingMessageForCommand(command));
    const print = setCommandPanel(panelTitleForCommand(command), command.type === 'apply' ? 'success' : 'output');
    try {
      const result = await controller.executeManualCommand(command, sessionRef.current, {
        cwd,
        workflows: inkWorkflows,
        prompts,
        print,
        readLine: null
      });
      if (result.exit) {
        exit();
      }
    } catch (error) {
      setActivePanel({
        kind: 'error',
        title: 'Error',
        text: error.message
      });
    } finally {
      if (command.type === 'apply' && !hasSessionPreview(sessionRef.current)) {
        sessionRef.current.logworkDraft = null;
      }
      setLoading('');
    }
  }, [controller, cwd, exit, inkWorkflows, prompts, setCommandPanel]);

  const {
    startNewLogworkWizard,
    startAuthTargetPicker,
    startReconciliationPeriodPicker,
    startLogworkWizard,
    startMcpClientPicker,
    cancelMcpClientPicker,
    selectWizardDate,
    selectWizardProject,
    previewDraft,
    cancelCurrentLogwork,
    applyWizardPreview,
    restoreTaskEditorPanel
  } = useLogworkWizard({
    cwd,
    sessionRef,
    wizard,
    setWizard,
    setActivePanel,
    setLoading,
    setInputValue,
    setSelectedIndex,
    inkWorkflows,
    prompts,
    runWithInlineAuth,
    runWithJiraAuthInstruction,
    executeCommand
  });

  const {
    saveCurrentDraft,
    openDraftPicker,
    resumeManualDraft,
    deleteSavedDraft,
    returnFromDraftPicker
  } = useDraftActions({
    cwd,
    sessionRef,
    wizard,
    setWizard,
    setActivePanel,
    setLoading,
    inkWorkflows,
    prompts,
    runWithInlineAuth,
    previewDraft,
    startNewLogworkWizard
  });

  const {
    cancelRemoveTasks,
    confirmRemoveTasks,
    submitWizardTaskInput,
    selectTaskForEdit,
    submitTaskReplacement
  } = useTaskEditorActions({
    sessionRef,
    wizard,
    setWizard,
    setActivePanel,
    setInputValue,
    prompts,
    executeCommand,
    previewDraft,
    applyWizardPreview,
    cancelCurrentLogwork,
    restoreTaskEditorPanel,
    saveCurrentDraft,
    openDraftPicker
  });

  const submitInput = useCallback((value) => {
    const text = String(value || '');
    const trimmed = text.trim();

    if (pendingConfirm) {
      return;
    }

    if (authActive || authPrompt) {
      return;
    }

    if (wizard?.step === 'edit_tasks') {
      const taskSuggestions = getCommandSuggestions(inputValue, TASK_COMMANDS);
      const selected = taskSuggestions[selectedIndex];
      if (selected && !inputValue.includes(' ') && trimmed !== selected.name && trimmed !== '') {
        setInputValue(selected.name);
        setSelectedIndex(0);
        return;
      }
      submitWizardTaskInput(text);
      return;
    }

    if (wizard?.step === 'edit_task_replace') {
      submitTaskReplacement(text);
      return;
    }

    const suggestions = getCommandSuggestions(inputValue);
    const completed = completeCommandValue(inputValue, suggestions, selectedIndex);
    if (completed) {
      setInputValue(completed);
      setSelectedIndex(0);
      return;
    }

    setInputValue('');
    setSelectedIndex(0);

    if (!trimmed) {
      return;
    }

    let command;
    try {
      command = controller.parseManualCommand(trimmed);
    } catch (error) {
      setActivePanel({
        kind: 'error',
        title: 'Command Error',
        text: error.message
      });
      return;
    }

    if (command.type === 'logwork' && !command.text) {
      startLogworkWizard(command.target);
      return;
    }

    if (command.type === 'auth' && !command.target) {
      startAuthTargetPicker();
      return;
    }

    if (command.type === 'mcp' && !command.client) {
      startMcpClientPicker();
      return;
    }

    if (command.type === 'reconcile' && !command.period) {
      startReconciliationPeriodPicker();
      return;
    }

    executeCommand(command);
  }, [
    controller,
    executeCommand,
    inputValue,
    pendingConfirm,
    authActive,
    authPrompt,
    selectedIndex,
    startMcpClientPicker,
    startLogworkWizard,
    startAuthTargetPicker,
    startReconciliationPeriodPicker,
    submitTaskReplacement,
    submitWizardTaskInput,
    wizard
  ]);

  return h(Box, {
    flexDirection: 'column',
    gap: 1
  },
  h(HeaderBar, { cwd }),
  h(CurrentPanel, { panel: activePanel }),
  loading ? h(LoadingLine, { message: loading }) : null,
  h(StatusBar, {
    preview: activeSessionPreview(sessionRef.current),
    dryRun: isDryRun(),
    wizard,
    authPrompt: authPrompt || (authActive ? { step: 'working' } : null)
  }),
  renderManualInteraction({
    authPrompt,
    authActive,
    pendingConfirm,
    wizard,
    inputValue,
    selectedIndex,
    setInputValue,
    setSelectedIndex,
    setAuthPrompt,
    setWizard,
    setActivePanel,
    resolveAuthPrompt,
    rejectAuthPrompt,
    resolveConfirm,
    exit,
    executeCommand,
    submitInput,
    startLogworkWizard,
    startNewLogworkWizard,
    selectWizardDate,
    selectWizardProject,
    cancelMcpClientPicker,
    cancelCurrentLogwork,
    restoreTaskEditorPanel,
    resumeManualDraft,
    deleteSavedDraft,
    returnFromDraftPicker,
    confirmRemoveTasks,
    cancelRemoveTasks,
    selectTaskForEdit
  }));
}
