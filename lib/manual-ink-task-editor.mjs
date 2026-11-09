// Task editor actions for the Ink logwork wizard: task lines, slash commands,
// edit/replace and multi-select remove.
import { useCallback } from 'react';
import {
  parseTaskLine,
  removeDraftTasks,
  replaceDraftTask
} from './manual-logwork-wizard.mjs';
import { JIRA_TARGET } from './manual-targets.mjs';
import { formatTaskHours } from './manual-ink-ui.mjs';
import { clearSessionPreviews } from './manual-ink-session.mjs';

export function useTaskEditorActions(ctx) {
  const {
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
  } = ctx;

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
        'Enter replacement line using format: +2 Feature Development | check ui/ux',
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
        text: 'Replacement task is empty. Use format: +2 Feature Development | check ui/ux'
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

  return {
    cancelRemoveTasks,
    confirmRemoveTasks,
    submitWizardTaskInput,
    selectTaskForEdit,
    submitTaskReplacement
  };
}
