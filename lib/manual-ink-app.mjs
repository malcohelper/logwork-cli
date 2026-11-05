import React, {
  useCallback,
  useMemo,
  useRef,
  useState
} from 'react';
import { Box, render, useApp } from 'ink';
import { isAuthRequiredError } from './auth-errors.mjs';
import { isJiraAuthRequiredError } from './jira-auth.mjs';
import {
  buildLogworkText,
  buildCurrentWeekDateOptions,
  buildProjectOverrides,
  buildProjectOptions,
  buildWeekDateOptions,
  canApplyPreview,
  formatDraftPreview,
  parseTaskLine,
  removeDraftTasks,
  replaceDraftTask,
  toggleTaskSelection
} from './manual-logwork-wizard.mjs';
import {
  getCommandSuggestions,
  TASK_COMMANDS
} from './manual-commands.mjs';
import {
  AUTH_TARGETS,
  BOTH_TARGET,
  jiraLoginInstruction,
  JIRA_TARGET,
  LOGWORK_TARGETS,
  previewTargets,
  RO_TARGET,
  targetLabel
} from './manual-targets.mjs';
import {
  deleteManualDraft,
  formatManualDraftLabel,
  loadManualDrafts,
  saveManualDraft
} from './manual-drafts.mjs';
import { enrichRoPreviewWithJiraProjects } from './project-mapping-workflow.mjs';
import {
  CommandInput,
  ConfirmDialog,
  completeCommandValue,
  CurrentPanel,
  DatePicker,
  DraftPicker,
  formatTaskHours,
  HeaderBar,
  LoadingLine,
  loadingMessageForCommand,
  McpClientPicker,
  panelTitleForCommand,
  ProjectPicker,
  sameProjectIdentity,
  StatusBar,
  TargetPicker,
  TaskEditPicker,
  TaskRemovePicker
} from './manual-ink-ui.mjs';
import {
  AuthPrompt,
  createInkCredentialProvider
} from './manual-ink-auth.mjs';

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
const RECONCILIATION_PERIOD_OPTIONS = [
  { key: 'today', label: 'Today', description: 'Compare today' },
  { key: 'yesterday', label: 'Yesterday', description: 'Compare yesterday' },
  { key: 'this_week', label: 'This week', description: 'Compare Monday through Sunday' },
  { key: 'last_week', label: 'Last week', description: 'Compare the previous week' },
  { key: 'this_month', label: 'This month', description: 'Compare the current month' },
  { key: 'last_month', label: 'Last month', description: 'Compare the previous month' }
];

function setSessionPreview(session, target, preview) {
  session.activeTarget = target;
  session.previews = {
    ...(session.previews || {}),
    [target]: preview
  };
}

function clearSessionPreview(session, target) {
  if (session.previews) {
    session.previews[target] = null;
  }
}

function clearSessionPreviews(session) {
  session.previews = {
    [RO_TARGET]: null,
    [JIRA_TARGET]: null
  };
}

function sessionPreview(session, target) {
  return session.previews?.[target] || null;
}

function hasSessionPreview(session) {
  return Boolean(session.previews?.[RO_TARGET] || session.previews?.[JIRA_TARGET]);
}

function activeSessionPreview(session) {
  if (session.activeTarget === JIRA_TARGET) {
    return sessionPreview(session, JIRA_TARGET);
  }
  return sessionPreview(session, RO_TARGET);
}

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

  const startNewLogworkWizard = useCallback(async (target = RO_TARGET) => {
    setInputValue('');
    setSelectedIndex(0);
    setLoading(target === JIRA_TARGET ? 'Building current week...' : 'Fetching current week...');
    setActivePanel({
      kind: 'logwork',
      title: 'Logwork',
      text: target === JIRA_TARGET
        ? 'Preparing Jira worklog dates...'
        : 'Loading this week booking/logwork data...'
    });
    try {
      const weekly = target === JIRA_TARGET
        ? null
        : await runWithInlineAuth(() => inkWorkflows.queryLogwork({
          period: 'this_week',
          cwd,
          includeEntries: false
        }));
      const dateOptions = weekly ? buildWeekDateOptions(weekly) : buildCurrentWeekDateOptions();
      if (!dateOptions.length) {
        throw new Error('Unable to build week date options.');
      }
      const todayIndex = dateOptions.findIndex((option) => option.isToday);
      setWizard({
        step: 'select_date',
        target,
        weekly,
        dateOptions,
        dateIndex: todayIndex >= 0 ? todayIndex : 0,
        projectsResult: null,
        projectOptions: [],
        projectIndex: 0,
        selectedDate: null,
        selectedProject: null,
        tasks: [],
        preview: null,
        activeDraftId: null
      });
      setActivePanel({
        kind: 'logwork',
        title: 'Select Date',
        text: `Choose a day for this ${targetLabel(target)} logwork session.`
      });
    } catch (error) {
      setActivePanel({
        kind: 'error',
        title: 'Logwork Error',
        text: error.message
      });
    } finally {
      setLoading('');
    }
  }, [cwd, inkWorkflows, runWithInlineAuth, runWithJiraAuthInstruction]);

  const startLogworkTargetPicker = useCallback(() => {
    setInputValue('');
    setSelectedIndex(0);
    setWizard({
      step: 'select_logwork_target',
      targetIndex: 0
    });
    setActivePanel({
      kind: 'logwork',
      title: 'Select Logwork Target',
      text: 'Choose where this logwork session should write.'
    });
  }, []);

  const startAuthTargetPicker = useCallback(() => {
    setInputValue('');
    setSelectedIndex(0);
    setWizard({
      step: 'select_auth_target',
      targetIndex: 0
    });
    setActivePanel({
      kind: 'auth',
      title: 'Select Auth Target',
      text: 'Choose which service to authenticate.'
    });
  }, []);

  const startReconciliationPeriodPicker = useCallback(() => {
    setInputValue('');
    setSelectedIndex(0);
    setWizard({
      step: 'select_reconciliation_period',
      periodIndex: 2
    });
    setActivePanel({
      kind: 'output',
      title: 'RO / Jira Reconciliation',
      text: 'Choose a preset period to compare.'
    });
  }, []);

  const startLogworkWizard = useCallback(async (target) => {
    if (!target) {
      startLogworkTargetPicker();
      return;
    }

    if (target !== RO_TARGET) {
      await startNewLogworkWizard(target);
      return;
    }

    setInputValue('');
    setSelectedIndex(0);
    setLoading('Loading saved drafts...');
    try {
      const drafts = await loadManualDrafts({ cwd });
      if (drafts.length) {
        setWizard({
          step: 'select_draft',
          target: RO_TARGET,
          drafts,
          draftIndex: 0,
          draftSource: 'start',
          weekly: null,
          dateOptions: [],
          dateIndex: 0,
          projectsResult: null,
          projectOptions: [],
          projectIndex: 0,
          selectedDate: null,
          selectedProject: null,
          tasks: [],
          preview: null,
          activeDraftId: null
        });
        setActivePanel({
          kind: 'logwork',
          title: 'Saved Drafts',
          text: 'Resume a saved draft, delete one, or start a new logwork session.'
        });
        return;
      }
      await startNewLogworkWizard(RO_TARGET);
    } catch (error) {
      setActivePanel({
        kind: 'error',
        title: 'Draft Error',
        text: error.message
      });
    } finally {
      setLoading('');
    }
  }, [cwd, startLogworkTargetPicker, startNewLogworkWizard]);

  const startMcpClientPicker = useCallback(() => {
    setInputValue('');
    setSelectedIndex(0);
    setWizard({
      step: 'select_mcp_client',
      mcpClientIndex: 0
    });
    setActivePanel({
      kind: 'output',
      title: 'MCP Setup',
      text: 'Choose an MCP client to print copy-ready setup.'
    });
  }, []);

  const cancelMcpClientPicker = useCallback(() => {
    setWizard(null);
    setActivePanel({
      kind: 'idle',
      title: 'Ready',
      text: 'Type / for commands.'
    });
  }, []);

  const selectWizardDate = useCallback(async (dateOption) => {
    const target = wizard?.target || RO_TARGET;
    if (target === JIRA_TARGET) {
      const draft = {
        target,
        date: dateOption.date,
        project: null,
        tasks: [],
        preview: null
      };
      sessionRef.current.logworkDraft = draft;
      clearSessionPreviews(sessionRef.current);
      sessionRef.current.activeTarget = target;
      setWizard((current) => ({
        ...current,
        step: 'edit_tasks',
        selectedDate: dateOption.date,
        selectedProject: null,
        tasks: [],
        preview: null,
        previews: {}
      }));
      setActivePanel({
        kind: 'logwork',
        title: 'Jira Worklog Draft',
        text: [
          formatDraftPreview(draft),
          '',
          'Enter tasks one per line: +2 check ui/ux (SCB-213)',
          'Empty Enter applies after preview is ready.',
          'Type / for task commands. Esc cancels.'
        ].join('\n')
      });
      return;
    }

    setLoading('Fetching project memberships...');
    setActivePanel({
      kind: 'logwork',
      title: 'Select Project',
      text: `Loading projects for ${dateOption.date}...`
    });
    try {
      const projectsResult = await runWithInlineAuth(() => inkWorkflows.listLogworkProjects({ cwd }));
      const projectOptions = buildProjectOptions({
        projectsResult,
        weekly: wizard.weekly,
        date: dateOption.date
      });
      if (!projectOptions.length) {
        throw new Error('No Resource Optimiser project memberships found.');
      }
      setWizard((current) => ({
        ...current,
        step: 'select_project',
        target,
        selectedDate: dateOption.date,
        projectsResult,
        projectOptions,
        projectIndex: 0,
        selectedProject: null,
        tasks: [],
        preview: null
      }));
      setActivePanel({
        kind: 'logwork',
        title: 'Select Project',
        text: `Choose a project for ${dateOption.date}.`
      });
    } catch (error) {
      setActivePanel({
        kind: 'error',
        title: 'Project Error',
        text: error.message
      });
    } finally {
      setLoading('');
    }
  }, [cwd, inkWorkflows, runWithInlineAuth, wizard]);

  const selectWizardProject = useCallback((project) => {
    const target = wizard?.target || RO_TARGET;
    const draft = {
      target,
      date: wizard.selectedDate,
      project,
      tasks: [],
      preview: null
    };
    sessionRef.current.logworkDraft = draft;
    clearSessionPreviews(sessionRef.current);
    sessionRef.current.activeTarget = target;
    setWizard((current) => ({
      ...current,
      step: 'edit_tasks',
      target,
      selectedProject: project,
      tasks: [],
      preview: null,
      previews: {}
    }));
    setActivePanel({
      kind: 'logwork',
      title: target === BOTH_TARGET ? 'RO + Jira Draft' : 'Logwork Draft',
      text: [
        formatDraftPreview(draft),
        '',
        target === BOTH_TARGET ? 'Enter tasks one per line: +2 check ui/ux (SCB-213)' : 'Enter tasks one per line: +2 check ui/ux',
        'Empty Enter applies after preview is ready.',
        'Type / for task commands. Esc cancels.'
      ].join('\n')
    });
  }, [wizard]);

  const previewDraft = useCallback(async (nextWizard) => {
    const target = nextWizard.target || RO_TARGET;
    const draft = {
      target,
      date: nextWizard.selectedDate,
      project: nextWizard.selectedProject,
      tasks: nextWizard.tasks
    };

    if (!draft.tasks.length) {
      sessionRef.current.logworkDraft = draft;
      clearSessionPreviews(sessionRef.current);
      sessionRef.current.activeTarget = target;
      setWizard(nextWizard);
      setActivePanel({
        kind: 'logwork',
        title: target === JIRA_TARGET ? 'Jira Worklog Draft' : target === BOTH_TARGET ? 'RO + Jira Draft' : 'Logwork Draft',
        text: [
          formatDraftPreview(draft),
          '',
          target === RO_TARGET ? 'Enter tasks one per line: +2 check ui/ux' : 'Enter tasks one per line: +2 check ui/ux (SCB-213)',
          'Empty Enter applies after preview is ready.'
        ].join('\n')
      });
      return;
    }

    setLoading('Building live preview...');
    try {
      const text = buildLogworkText({
        date: draft.date,
        tasks: draft.tasks
      });
      const previews = {};
      if (previewTargets(target).includes(RO_TARGET)) {
        const projectOverrides = buildProjectOverrides({
          date: draft.date,
          tasks: draft.tasks,
          projectMemberId: draft.project.projectMemberId
        });
        previews[RO_TARGET] = await runWithInlineAuth(() => inkWorkflows.previewLogworkBatch({
          text,
          projectOverrides,
          cwd
        }));
      }
      if (previewTargets(target).includes(JIRA_TARGET)) {
        previews[JIRA_TARGET] = await runWithJiraAuthInstruction(() => inkWorkflows.previewJiraWorklogBatch({
          text
        }));
      }
      if (target === BOTH_TARGET && previews[RO_TARGET] && previews[JIRA_TARGET]) {
        previews[RO_TARGET] = enrichRoPreviewWithJiraProjects(previews[RO_TARGET], previews[JIRA_TARGET]);
      }
      const preview = target === JIRA_TARGET ? previews[JIRA_TARGET] : previews[RO_TARGET];
      const withPreview = {
        ...draft,
        preview,
        previews
      };
      sessionRef.current.logworkDraft = withPreview;
      sessionRef.current.activeTarget = target;
      for (const previewTarget of previewTargets(target)) {
        setSessionPreview(sessionRef.current, previewTarget, previews[previewTarget] || null);
      }
      setWizard({
        ...nextWizard,
        target,
        preview,
        previews
      });
      const hasBlockedJira = previews[JIRA_TARGET]?.entries?.some((entry) => entry.status !== 'ready');
      setActivePanel({
        kind: preview?.unresolvedEntries?.length || preview?.errors?.length || hasBlockedJira ? 'error' : 'logwork',
        title: target === JIRA_TARGET ? 'Jira Worklog Preview' : target === BOTH_TARGET ? 'RO + Jira Preview' : 'Logwork Preview',
        text: [
          formatDraftPreview(withPreview),
          '',
          'Empty Enter applies this preview.',
          'Type another +hours task to add more.',
          '/remove selects tasks to delete.'
        ].join('\n')
      });
      return preview;
    } catch (error) {
      setActivePanel({
        kind: 'error',
        title: 'Preview Error',
        text: error.message
      });
    } finally {
      setLoading('');
    }
  }, [cwd, inkWorkflows, runWithInlineAuth, runWithJiraAuthInstruction]);

  const saveCurrentDraft = useCallback(async () => {
    if (wizard?.target === JIRA_TARGET) {
      setActivePanel({
        kind: 'logwork',
        title: 'Save Draft',
        text: 'Saved drafts are only supported for Resource Optimiser logwork in this version.'
      });
      return null;
    }

    if (!wizard?.selectedDate || !wizard?.selectedProject || !wizard?.tasks?.length) {
      setActivePanel({
        kind: 'logwork',
        title: 'Save Draft',
        text: 'Add at least one task before saving a draft.'
      });
      return null;
    }

    try {
      const saved = await saveManualDraft({
        id: wizard.activeDraftId,
        cwd,
        date: wizard.selectedDate,
        project: wizard.selectedProject,
        tasks: wizard.tasks,
        latestPreviewStatus: wizard.preview?.status
      }, { cwd });
      setWizard((current) => ({
        ...current,
        activeDraftId: saved.id
      }));
      setActivePanel({
        kind: 'success',
        title: 'Draft Saved',
        text: [
          `Saved ${saved.tasks.length} task${saved.tasks.length === 1 ? '' : 's'} locally.`,
          formatManualDraftLabel(saved),
          '',
          'Continue editing, press empty Enter to apply, or type /drafts.'
        ].join('\n')
      });
      return saved;
    } catch (error) {
      setActivePanel({
        kind: 'error',
        title: 'Save Draft Error',
        text: error.message
      });
      return null;
    }
  }, [cwd, wizard]);

  const openDraftPicker = useCallback(async (source = 'editor') => {
    setLoading('Loading saved drafts...');
    try {
      const drafts = await loadManualDrafts({ cwd });
      if (!drafts.length) {
        setActivePanel({
          kind: 'logwork',
          title: 'Saved Drafts',
          text: 'No saved drafts found.'
        });
        return;
      }
      setWizard((current) => ({
        ...current,
        step: 'select_draft',
        drafts,
        draftIndex: 0,
        draftSource: source
      }));
      setActivePanel({
        kind: 'logwork',
        title: 'Saved Drafts',
        text: 'Enter resumes · d deletes · Esc returns.'
      });
    } catch (error) {
      setActivePanel({
        kind: 'error',
        title: 'Draft Error',
        text: error.message
      });
    } finally {
      setLoading('');
    }
  }, [cwd]);

  const resumeManualDraft = useCallback(async (draft) => {
    setLoading('Resuming saved draft...');
    try {
      const weekly = await runWithInlineAuth(() => inkWorkflows.queryLogwork({
        period: 'this_week',
        cwd,
        includeEntries: false
      }));
      const dateOptions = buildWeekDateOptions(weekly);
      const projectsResult = await runWithInlineAuth(() => inkWorkflows.listLogworkProjects({ cwd }));
      const projectOptions = buildProjectOptions({
        projectsResult,
        weekly,
        date: draft.date
      });
      const selectedProject = projectOptions.find((project) => sameProjectIdentity(project, draft.project)) || draft.project;
      const nextWizard = {
        step: 'edit_tasks',
        target: RO_TARGET,
        weekly,
        dateOptions,
        dateIndex: Math.max(0, dateOptions.findIndex((option) => option.date === draft.date)),
        projectsResult,
        projectOptions,
        projectIndex: Math.max(0, projectOptions.findIndex((project) => sameProjectIdentity(project, selectedProject))),
        selectedDate: draft.date,
        selectedProject,
        tasks: draft.tasks,
        preview: null,
        activeDraftId: draft.id
      };
      sessionRef.current.logworkDraft = {
        target: RO_TARGET,
        date: draft.date,
        project: selectedProject,
        tasks: draft.tasks,
        preview: null
      };
      clearSessionPreviews(sessionRef.current);
      sessionRef.current.activeTarget = RO_TARGET;
      await previewDraft(nextWizard);
    } catch (error) {
      setActivePanel({
        kind: 'error',
        title: 'Resume Draft Error',
        text: error.message
      });
    } finally {
      setLoading('');
    }
  }, [cwd, inkWorkflows, previewDraft, runWithInlineAuth]);

  const deleteSavedDraft = useCallback(async (draft) => {
    const ok = await prompts.confirm(`Delete saved draft "${formatManualDraftLabel(draft)}"?`, false);
    if (!ok) {
      return;
    }
    await deleteManualDraft(draft.id);
    const drafts = await loadManualDrafts({ cwd });
    setWizard((current) => ({
      ...current,
      drafts,
      draftIndex: 0
    }));
    setActivePanel({
      kind: 'success',
      title: 'Draft Deleted',
      text: drafts.length ? 'Draft deleted. Choose another saved draft or start new.' : 'Draft deleted. No saved drafts remain.'
    });
  }, [cwd, prompts]);

  const returnFromDraftPicker = useCallback(() => {
    if (wizard?.draftSource === 'start') {
      startNewLogworkWizard(RO_TARGET);
      return;
    }
    setWizard((current) => ({
      ...current,
      step: 'edit_tasks',
      draftSource: undefined
    }));
    const draft = {
      target: wizard?.target || RO_TARGET,
      date: wizard?.selectedDate,
      project: wizard?.selectedProject,
      tasks: wizard?.tasks || [],
      preview: wizard?.preview
    };
    setActivePanel({
      kind: 'logwork',
      title: wizard?.preview ? 'Logwork Preview' : 'Logwork Draft',
      text: [
        formatDraftPreview(draft),
        '',
        'Type / for task commands. Empty Enter applies when ready.'
      ].join('\n')
    });
  }, [startNewLogworkWizard, wizard]);

  const cancelCurrentLogwork = useCallback(async () => {
    if (wizard?.tasks?.length) {
      const ok = await prompts.confirm('Discard this unsaved logwork session?', false);
      if (!ok) {
        return;
      }
    }
    sessionRef.current.logworkDraft = null;
    clearSessionPreviews(sessionRef.current);
    setWizard(null);
    setActivePanel({
      kind: 'idle',
      title: 'Ready',
      text: 'Logwork session discarded. Type / for commands.'
    });
  }, [prompts, wizard]);

  const applyWizardPreview = useCallback(async () => {
    const target = wizard.target || RO_TARGET;
    if (!wizard.tasks.length) {
      setActivePanel({
        kind: 'logwork',
        title: 'Logwork Draft',
        text: target === RO_TARGET ? 'Enter a task like +2 check ui/ux.' : 'Enter a task like +2 check ui/ux (SCB-213).'
      });
      return;
    }

    const targets = previewTargets(target);
    const missingPreview = targets.some((previewTarget) => !sessionPreview(sessionRef.current, previewTarget));
    if (missingPreview) {
      await previewDraft(wizard);
      return;
    }

    for (const previewTarget of targets) {
      const applyState = canApplyPreview(sessionPreview(sessionRef.current, previewTarget), { target: previewTarget });
      if (!applyState.ok) {
        setActivePanel({
          kind: 'error',
          title: 'Apply Blocked',
          text: `${targetLabel(previewTarget)}: ${applyState.reason}`
        });
        return;
      }
    }

    await executeCommand({ type: 'apply', target });
    if (!hasSessionPreview(sessionRef.current)) {
      setWizard(null);
    }
  }, [executeCommand, previewDraft, wizard]);

  const restoreTaskEditorPanel = useCallback((nextWizard = wizard) => {
    const target = nextWizard.target || RO_TARGET;
    const draft = {
      target,
      date: nextWizard.selectedDate,
      project: nextWizard.selectedProject,
      tasks: nextWizard.tasks,
      preview: nextWizard.preview,
      previews: nextWizard.previews
    };
    setActivePanel({
      kind: 'logwork',
      title: nextWizard.preview ? `${targetLabel(target)} Preview` : `${targetLabel(target)} Draft`,
      text: [
        formatDraftPreview(draft),
        '',
        nextWizard.preview ? 'Empty Enter applies this preview.' : target === RO_TARGET ? 'Enter tasks one per line: +2 check ui/ux' : 'Enter tasks one per line: +2 check ui/ux (SCB-213)',
        nextWizard.preview ? 'Type another +hours task to add more.' : 'Empty Enter applies after preview is ready.',
        'Type / for task commands. Esc cancels.'
      ].join('\n')
    });
  }, [wizard]);

  const cancelRemoveTasks = useCallback(() => {
    setWizard((current) => ({
      ...current,
      step: 'edit_tasks',
      removeIndex: 0,
      removeSelectedIndexes: []
    }));
    restoreTaskEditorPanel();
  }, [restoreTaskEditorPanel]);

  const confirmRemoveTasks = useCallback(async (selectedIndexes) => {
    if (!selectedIndexes.length) {
      setActivePanel({
        kind: 'logwork',
        title: 'Remove Tasks',
        text: 'No tasks selected. Use Space to select tasks, Enter to remove, Esc to cancel.'
      });
      return;
    }

    const ok = await prompts.confirm(`Remove ${selectedIndexes.length} selected task${selectedIndexes.length === 1 ? '' : 's'}?`);
    if (!ok) {
      cancelRemoveTasks();
      return;
    }

    await previewDraft({
      ...wizard,
      step: 'edit_tasks',
      tasks: removeDraftTasks(wizard.tasks, selectedIndexes),
      preview: null,
      removeIndex: 0,
      removeSelectedIndexes: []
    });
  }, [cancelRemoveTasks, previewDraft, prompts, wizard]);

  const submitWizardTaskInput = useCallback(async (value) => {
    const text = String(value || '').trim();
    setInputValue('');

    if (!text) {
      await applyWizardPreview();
      return;
    }

    if (text === '/diagnostics') {
      await executeCommand({ type: 'diagnostics' });
      return;
    }

    if (text === '/cancel' || text === '/discard') {
      await cancelCurrentLogwork();
      return;
    }

    if (text === '/back') {
      sessionRef.current.logworkDraft = null;
      clearSessionPreviews(sessionRef.current);
      if (wizard.target === JIRA_TARGET) {
        setWizard((current) => ({
          ...current,
          step: 'select_date',
          selectedDate: null,
          tasks: [],
          preview: null,
          previews: {}
        }));
        setActivePanel({
          kind: 'logwork',
          title: 'Select Date',
          text: 'Choose a day for this Jira worklog session.'
        });
      } else {
        setWizard((current) => ({
          ...current,
          step: 'select_project',
          selectedProject: null,
          tasks: [],
          preview: null,
          previews: {}
        }));
        setActivePanel({
          kind: 'logwork',
          title: 'Select Project',
          text: `Choose a project for ${wizard.selectedDate}.`
        });
      }
      return;
    }

    if (text === '/clear') {
      const ok = !wizard.tasks.length || await prompts.confirm('Clear all current tasks?', false);
      if (!ok) {
        restoreTaskEditorPanel();
        return;
      }
      await previewDraft({
        ...wizard,
        tasks: [],
        preview: null
      });
      return;
    }

    if (text === '/save') {
      await saveCurrentDraft();
      return;
    }

    if (text === '/drafts') {
      await openDraftPicker('editor');
      return;
    }

    if (text === '/edit') {
      if (!wizard.tasks.length) {
        setActivePanel({
          kind: 'error',
          title: 'Edit Task',
          text: 'No tasks to edit.'
        });
        return;
      }
      setWizard((current) => ({
        ...current,
        step: 'edit_task_select',
        editIndex: 0,
        replacementError: ''
      }));
      setActivePanel({
        kind: 'logwork',
        title: 'Edit Task',
        text: 'Select a task to replace. Esc returns to the editor.'
      });
      return;
    }

    if (text === '/remove') {
      if (!wizard.tasks.length) {
        setActivePanel({
          kind: 'error',
          title: 'Remove Task',
          text: 'No tasks to remove.'
        });
        return;
      }
      setWizard((current) => ({
        ...current,
        step: 'remove_tasks',
        removeIndex: 0,
        removeSelectedIndexes: []
      }));
      setActivePanel({
        kind: 'logwork',
        title: 'Remove Tasks',
        text: 'Select tasks to remove. Space toggles, Enter confirms, Esc cancels.'
      });
      return;
    }

    if (text.startsWith('/remove ')) {
      const index = Number(text.slice('/remove '.length).trim());
      if (!Number.isInteger(index)) {
        setActivePanel({
          kind: 'error',
          title: 'Remove Task',
          text: 'Usage: /remove <task number>'
        });
        return;
      }
      if (index < 1 || index > wizard.tasks.length) {
        setActivePanel({
          kind: 'error',
          title: 'Remove Task',
          text: `No task found at index ${index}.`
        });
        return;
      }
      await previewDraft({
        ...wizard,
        tasks: wizard.tasks.filter((_, currentIndex) => currentIndex !== index - 1),
        preview: null
      });
      return;
    }

    if (text === '/done') {
      if (!wizard.tasks.length) {
        setActivePanel({
          kind: 'error',
          title: 'Logwork Draft',
          text: 'Add at least one task before /done.'
        });
        return;
      }
      await previewDraft(wizard);
      return;
    }

    if (text === '/apply') {
      await applyWizardPreview();
      return;
    }

    if (text.startsWith('/')) {
      setActivePanel({
        kind: 'error',
        title: 'Logwork Draft',
        text: `Unknown logwork command: ${text}`
      });
      return;
    }

    try {
      const task = parseTaskLine(text);
      await previewDraft({
        ...wizard,
        tasks: [...wizard.tasks, task],
        preview: null
      });
    } catch (error) {
      setActivePanel({
        kind: 'error',
        title: 'Task Error',
        text: error.message
      });
    }
  }, [
    applyWizardPreview,
    cancelCurrentLogwork,
    executeCommand,
    openDraftPicker,
    previewDraft,
    prompts,
    restoreTaskEditorPanel,
    saveCurrentDraft,
    wizard
  ]);

  const selectTaskForEdit = useCallback((index) => {
    const task = wizard.tasks[index];
    setInputValue('');
    setWizard((current) => ({
      ...current,
      step: 'edit_task_replace',
      editIndex: index,
      replacementError: ''
    }));
    setActivePanel({
      kind: 'logwork',
      title: 'Replace Task',
      text: [
        `Replacing ${index + 1}. +${formatTaskHours(task.hours)} ${task.taskName}`,
        'Enter replacement line using format: +2 check ui/ux',
        'Esc returns without changing the task.'
      ].join('\n')
    });
  }, [wizard]);

  const submitTaskReplacement = useCallback(async (value) => {
    const text = String(value || '').trim();
    setInputValue('');
    if (!text) {
      setActivePanel({
        kind: 'error',
        title: 'Replace Task',
        text: 'Replacement task is empty. Use format: +2 check ui/ux'
      });
      return;
    }
    if (text === '/cancel') {
      setWizard((current) => ({
        ...current,
        step: 'edit_tasks',
        replacementError: ''
      }));
      restoreTaskEditorPanel();
      return;
    }
    try {
      const task = parseTaskLine(text);
      await previewDraft({
        ...wizard,
        step: 'edit_tasks',
        tasks: replaceDraftTask(wizard.tasks, wizard.editIndex, task),
        preview: null,
        replacementError: ''
      });
    } catch (error) {
      setWizard((current) => ({
        ...current,
        replacementError: error.message
      }));
      setActivePanel({
        kind: 'error',
        title: 'Replace Task',
        text: error.message
      });
    }
  }, [previewDraft, restoreTaskEditorPanel, wizard]);

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
    dryRun: process.env.LOGWORK_DRY_RUN === '1',
    wizard,
    authPrompt: authPrompt || (authActive ? { step: 'working' } : null)
  }),
  authPrompt
    ? h(AuthPrompt, {
      prompt: authPrompt,
      inputValue,
      onInputChange(value) {
        setInputValue(value);
      },
      onPromptChange(nextPrompt) {
        setAuthPrompt(nextPrompt);
      },
      onResolve: resolveAuthPrompt,
      onReject: rejectAuthPrompt
    })
    : authActive
      ? h(AuthPrompt, {
        prompt: { step: 'working' },
        inputValue,
        onInputChange(value) {
          setInputValue(value);
        },
        onPromptChange(nextPrompt) {
          setAuthPrompt(nextPrompt);
        },
        onResolve: resolveAuthPrompt,
        onReject: rejectAuthPrompt
      })
    : pendingConfirm
    ? h(ConfirmDialog, {
      message: pendingConfirm.message,
      initialValue: pendingConfirm.initialValue,
      onResolve: resolveConfirm
    })
    : wizard?.step === 'select_logwork_target'
      ? h(TargetPicker, {
        title: 'Pick logwork target',
        targets: LOGWORK_TARGETS,
        selectedIndex: wizard.targetIndex || 0,
        onChange(index) {
          setWizard((current) => ({
            ...current,
            targetIndex: index
          }));
        },
        onSelect(target) {
          startLogworkWizard(target.key);
        },
        onCancel() {
          setWizard(null);
          setActivePanel({
            kind: 'idle',
            title: 'Ready',
            text: 'Type / for commands.'
          });
        }
      })
    : wizard?.step === 'select_auth_target'
      ? h(TargetPicker, {
        title: 'Pick auth target',
        targets: AUTH_TARGETS,
        selectedIndex: wizard.targetIndex || 0,
        onChange(index) {
          setWizard((current) => ({
            ...current,
            targetIndex: index
          }));
        },
        onSelect(target) {
          executeCommand({
            type: 'auth',
            target: target.key
          });
        },
        onCancel() {
          setWizard(null);
          setActivePanel({
            kind: 'idle',
            title: 'Ready',
            text: 'Type / for commands.'
          });
        }
      })
    : wizard?.step === 'select_reconciliation_period'
      ? h(TargetPicker, {
        title: 'Pick reconciliation period',
        targets: RECONCILIATION_PERIOD_OPTIONS,
        selectedIndex: wizard.periodIndex || 0,
        onChange(index) {
          setWizard((current) => ({
            ...current,
            periodIndex: index
          }));
        },
        onSelect(period) {
          executeCommand({
            type: 'reconcile',
            period: period.key
          });
        },
        onCancel() {
          setWizard(null);
          setActivePanel({
            kind: 'idle',
            title: 'Ready',
            text: 'Type / for commands.'
          });
        }
      })
    : wizard?.step === 'select_draft'
      ? h(DraftPicker, {
        drafts: wizard.drafts || [],
        selectedIndex: wizard.draftIndex || 0,
        includeStartNew: wizard.draftSource === 'start',
        onChange(index) {
          setWizard((current) => ({
            ...current,
            draftIndex: index
          }));
        },
        onResume(draft) {
          resumeManualDraft(draft);
        },
        onDelete(draft) {
          deleteSavedDraft(draft);
        },
        onStartNew() {
          startNewLogworkWizard(RO_TARGET);
        },
        onCancel() {
          returnFromDraftPicker();
        }
      })
      : wizard?.step === 'select_date'
      ? h(DatePicker, {
        options: wizard.dateOptions,
        selectedIndex: wizard.dateIndex,
        onChange(index) {
          setWizard((current) => ({
            ...current,
            dateIndex: index
          }));
        },
        onSelect(option) {
          selectWizardDate(option);
        }
      })
      : wizard?.step === 'select_project'
        ? h(ProjectPicker, {
          options: wizard.projectOptions,
          selectedIndex: wizard.projectIndex,
          onChange(index) {
            setWizard((current) => ({
              ...current,
              projectIndex: index
            }));
          },
          onSelect(project) {
            selectWizardProject(project);
          }
        })
        : wizard?.step === 'select_mcp_client'
          ? h(McpClientPicker, {
            selectedIndex: wizard.mcpClientIndex || 0,
            onChange(index) {
              setWizard((current) => ({
                ...current,
                mcpClientIndex: index
              }));
            },
            onSelect(client) {
              executeCommand({
                type: 'mcp',
                client: client.key
              });
            },
            onCancel() {
              cancelMcpClientPicker();
            }
          })
        : wizard?.step === 'remove_tasks'
          ? h(TaskRemovePicker, {
            tasks: wizard.tasks,
            selectedIndex: wizard.removeIndex || 0,
            selectedIndexes: wizard.removeSelectedIndexes || [],
            onChange(index) {
              setWizard((current) => ({
                ...current,
                removeIndex: index
              }));
            },
            onToggle(index) {
              setWizard((current) => ({
                ...current,
                removeSelectedIndexes: toggleTaskSelection(current.removeSelectedIndexes || [], index)
              }));
            },
            onSubmit(indexes) {
              confirmRemoveTasks(indexes);
            },
            onCancel() {
              cancelRemoveTasks();
            }
          })
        : wizard?.step === 'edit_task_select'
          ? h(TaskEditPicker, {
            tasks: wizard.tasks,
            selectedIndex: wizard.editIndex || 0,
            onChange(index) {
              setWizard((current) => ({
                ...current,
                editIndex: index
              }));
            },
            onSelect(index) {
              selectTaskForEdit(index);
            },
            onCancel() {
              setWizard((current) => ({
                ...current,
                step: 'edit_tasks'
              }));
              restoreTaskEditorPanel();
            }
          })
        : h(CommandInput, {
          value: inputValue,
          onChange(value) {
            setInputValue(value);
            setSelectedIndex(0);
          },
          onSubmit: submitInput,
          selectedIndex,
          setSelectedIndex,
          mode: wizard?.step === 'edit_tasks' ? 'task' : wizard?.step === 'edit_task_replace' ? 'task-edit' : 'command',
          onEscape() {
            if (!wizard) {
              exit();
              return;
            }
            if (wizard?.step === 'edit_tasks') {
              cancelCurrentLogwork();
              return;
            }
            if (wizard?.step === 'edit_task_replace') {
              setWizard((current) => ({
                ...current,
                step: 'edit_tasks'
              }));
              restoreTaskEditorPanel();
            }
          }
        }));
}
