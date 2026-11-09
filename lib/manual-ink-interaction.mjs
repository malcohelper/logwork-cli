// The bottom interaction area of the Ink app: the auth prompt, a confirm dialog,
// the active wizard picker, or the command input. A plain render function (not a
// component) so the element tree matches the single-component layout.
import React from 'react';
import { toggleTaskSelection } from './manual-logwork-wizard.mjs';
import { AUTH_TARGETS, LOGWORK_TARGETS, RO_TARGET } from './manual-targets.mjs';
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
} from './manual-ink-ui.mjs';
import { AuthPrompt } from './manual-ink-auth.mjs';
import { RECONCILIATION_PERIOD_OPTIONS } from './manual-ink-session.mjs';

const h = React.createElement;

export function renderManualInteraction({
  authPrompt,
  authActive,
  pendingConfirm,
  pendingSelect,
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
  changeSelect,
  resolveSelect,
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
}) {
  return authPrompt
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
    : pendingSelect
    ? h(SelectPrompt, {
      message: pendingSelect.message,
      options: pendingSelect.options,
      selectedIndex: pendingSelect.selectedIndex || 0,
      onChange: changeSelect,
      onResolve: resolveSelect
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
        });
}
