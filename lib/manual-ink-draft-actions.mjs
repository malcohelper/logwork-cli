// Saved-draft actions for the Ink logwork wizard: save, list, resume, delete.
import { useCallback } from 'react';
import {
  buildProjectOptions,
  buildWeekDateOptions,
  formatDraftPreview
} from './manual-logwork-wizard.mjs';
import { JIRA_TARGET, RO_TARGET } from './manual-targets.mjs';
import {
  deleteManualDraft,
  formatManualDraftLabel,
  loadManualDrafts,
  saveManualDraft
} from './manual-drafts.mjs';
import { sameProjectIdentity } from './manual-ink-ui.mjs';
import { clearSessionPreviews } from './manual-ink-session.mjs';

export function useDraftActions(ctx) {
  const {
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
  } = ctx;

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

  return {
    saveCurrentDraft,
    openDraftPicker,
    resumeManualDraft,
    deleteSavedDraft,
    returnFromDraftPicker
  };
}
