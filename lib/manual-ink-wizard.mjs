// Logwork wizard flow for the Ink app: target, date and project pickers, live
// preview, apply and cancel. Called from ManualApp with its state and setters.
import { useCallback } from 'react';
import {
  buildCurrentWeekDateOptions,
  buildLogworkText,
  buildProjectOptions,
  buildProjectOverrides,
  buildWeekDateOptions,
  canApplyPreview,
  formatDraftPreview
} from './manual-logwork-wizard.mjs';
import {
  BOTH_TARGET,
  JIRA_TARGET,
  previewTargets,
  RO_TARGET,
  targetLabel
} from './manual-targets.mjs';
import { loadManualDrafts } from './manual-drafts.mjs';
import { enrichRoPreviewWithJiraProjects } from './project-mapping-workflow.mjs';
import {
  clearSessionPreviews,
  hasSessionPreview,
  sessionPreview,
  setSessionPreview
} from './manual-ink-session.mjs';

export function useLogworkWizard(ctx) {
  const {
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
  } = ctx;

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
          'Enter tasks one per line: +2 Feature Development | check ui/ux (SCB-213)',
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
        target === BOTH_TARGET ? 'Enter tasks one per line: +2 Feature Development | check ui/ux (SCB-213)' : 'Enter tasks one per line: +2 Feature Development | check ui/ux',
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
          target === RO_TARGET ? 'Enter tasks one per line: +2 Feature Development | check ui/ux' : 'Enter tasks one per line: +2 Feature Development | check ui/ux (SCB-213)',
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
        text: target === RO_TARGET ? 'Enter a task like +2 Feature Development | check ui/ux.' : 'Enter a task like +2 Feature Development | check ui/ux (SCB-213).'
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
        nextWizard.preview ? 'Empty Enter applies this preview.' : target === RO_TARGET ? 'Enter tasks one per line: +2 Feature Development | check ui/ux' : 'Enter tasks one per line: +2 Feature Development | check ui/ux (SCB-213)',
        nextWizard.preview ? 'Type another +hours task to add more.' : 'Empty Enter applies after preview is ready.',
        'Type / for task commands. Esc cancels.'
      ].join('\n')
    });
  }, [wizard]);

  return {
    startNewLogworkWizard,
    startLogworkTargetPicker,
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
  };
}
