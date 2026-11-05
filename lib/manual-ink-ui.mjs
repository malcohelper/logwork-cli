import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import chalk from 'chalk';
import {
  COMMAND_SUGGESTION_LIMIT,
  getCommandSuggestions,
  MANUAL_COMMANDS,
  TASK_COMMANDS
} from './manual-commands.mjs';
import { formatManualDraftLabel } from './manual-drafts.mjs';
import { MCP_CLIENTS } from './manual-mcp.mjs';
import {
  nextIndex,
  previousIndex
} from './list-navigation.mjs';
import {
  sameProjectIdentity
} from './project-identity.mjs';

const h = React.createElement;

export { sameProjectIdentity };

export function HeaderBar({ cwd }) {
  return h(Box, {
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor: 'cyan',
    paddingX: 1
  },
  h(Text, { bold: true }, 'Logwork Helper'),
  h(Text, { color: 'gray' }, `cwd: ${cwd}`));
}

export function StatusBar({ preview, dryRun, wizard, authPrompt }) {
  const previewText = preview
    ? `preview: ${preview.status} · ${preview.entries?.length || 0} entries`
    : 'preview: none';
  const targetText = wizard?.target ? ` · target: ${wizard.target}` : '';
  const mode = authPrompt ? `mode: auth-${authPrompt.step}` : wizard?.step ? `mode: ${wizard.step.replace('_', '-')}${targetText}` : 'mode: command';
  const dryRunText = dryRun ? ' · DRY RUN' : '';
  const hint = authPrompt ? 'Enter auth details here' : wizard?.step === 'edit_tasks' ? 'Type / for task commands' : 'Type / for commands';

  return h(Box, {
    borderStyle: 'single',
    borderColor: 'gray',
    paddingX: 1
  },
  h(Text, { color: authPrompt ? 'cyan' : wizard?.step ? 'yellow' : 'gray' }, `${mode} · ${previewText}${dryRunText} · ${hint}`));
}

export function TargetPicker({
  title = 'Pick target',
  targets = [],
  selectedIndex = 0,
  onChange,
  onSelect,
  onCancel
}) {
  useInput((input, key) => {
    if (key.upArrow) {
      onChange(previousIndex(selectedIndex, targets.length));
      return;
    }
    if (key.downArrow) {
      onChange(nextIndex(selectedIndex, targets.length));
      return;
    }
    if (key.return) {
      onSelect(targets[selectedIndex]);
      return;
    }
    if (key.escape && typeof onCancel === 'function') {
      onCancel();
    }
  });

  return h(SelectionList, {
    title,
    items: targets.map((target) => ({
      key: target.key,
      label: `${target.label} - ${target.description}`
    })),
    selectedIndex
  });
}

export function CurrentPanel({ panel = {} }) {
  return h(Box, {
    flexDirection: 'column',
    borderStyle: 'single',
    borderColor: panelColor(panel.kind),
    paddingX: 1,
    minHeight: 5
  },
  h(Text, {
    bold: true,
    color: panelColor(panel.kind)
  }, panel.title || 'Current'),
  h(Text, {
    color: panel.kind === 'error' ? 'red' : undefined
  }, panel.text || 'Type / for commands.'));
}

export function OutputPanel({ items = [] }) {
  const lastItem = items.at(-1);
  return h(CurrentPanel, {
    panel: lastItem
      ? {
        kind: lastItem.kind,
        title: 'Current',
        text: lastItem.text
      }
      : {
        kind: 'idle',
        title: 'Current',
        text: 'Type / for commands.'
      }
  });
}

export function CommandInput({
  value,
  onChange,
  onSubmit,
  selectedIndex,
  setSelectedIndex,
  mode = 'command',
  onEscape
}) {
  const [autocompleteVersion, setAutocompleteVersion] = useState(0);
  const [completedCommandValue, setCompletedCommandValue] = useState('');
  const suggestions = mode === 'task' ? getCommandSuggestions(value, TASK_COMMANDS) : mode === 'command' ? getCommandSuggestions(value) : [];
  const showSuggestions = suggestions.length > 0 && value !== completedCommandValue;

  function completeSelectedCommand() {
    const completed = completeCommandValue(value, suggestions, selectedIndex);
    if (!completed) {
      return false;
    }

    onChange(completed);
    setCompletedCommandValue(completed);
    setAutocompleteVersion((current) => current + 1);
    return true;
  }

  function handleInputChange(nextValue) {
    setCompletedCommandValue('');
    onChange(nextValue);
  }

  function handleSubmit(submittedValue) {
    if (completeSelectedCommand()) {
      return;
    }
    onSubmit(submittedValue);
  }

  useInput((input, key) => {
    if (key.escape && typeof onEscape === 'function') {
      onEscape();
      return;
    }

    if (!showSuggestions) {
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((current) => previousIndex(current, suggestions.length));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((current) => nextIndex(current, suggestions.length));
      return;
    }

    if (key.tab) {
      completeSelectedCommand();
    }
  });

  const isTaskMode = mode === 'task' || mode === 'task-edit';
  return h(Box, {
    flexDirection: 'column'
  },
  h(Box, null,
    h(Text, { color: isTaskMode ? 'yellow' : 'green' }, isTaskMode ? 'task › ' : 'logwork › '),
    h(TextInput, {
      key: commandInputKey(mode, autocompleteVersion),
      value,
      onChange: handleInputChange,
      onSubmit: handleSubmit,
      placeholder: mode === 'task'
        ? '+2 check ui/ux  ·  / for task commands  ·  empty Enter applies'
        : mode === 'task-edit'
          ? '+2 replacement task'
          : 'Type / for commands'
    })),
  showSuggestions ? h(SlashMenu, {
    suggestions,
    selectedIndex
  }) : null);
}

export function commandInputKey(mode, autocompleteVersion = 0) {
  return `${mode}:${autocompleteVersion}`;
}

export function completeCommandValue(value, suggestions = [], selectedIndex = 0) {
  const selected = suggestions[selectedIndex] || suggestions[0];
  const trimmed = String(value || '').trim();
  if (!selected || !trimmed || trimmed === selected.name || !selected.name.startsWith(trimmed)) {
    return null;
  }

  return selected.name;
}

export function DatePicker({
  options = [],
  selectedIndex = 0,
  onChange,
  onSelect
}) {
  useInput((input, key) => {
    if (key.upArrow) {
      onChange(previousIndex(selectedIndex, options.length));
      return;
    }
    if (key.downArrow) {
      onChange(nextIndex(selectedIndex, options.length));
      return;
    }
    if (key.return) {
      onSelect(options[selectedIndex]);
    }
  });

  return h(SelectionList, {
    title: 'Pick date',
    items: options.map((option) => ({
      key: option.date,
      label: `${option.label}${option.isToday ? ' · today' : ''}`
    })),
    selectedIndex
  });
}

export function ProjectPicker({
  options = [],
  selectedIndex = 0,
  onChange,
  onSelect
}) {
  useInput((input, key) => {
    if (key.upArrow) {
      onChange(previousIndex(selectedIndex, options.length));
      return;
    }
    if (key.downArrow) {
      onChange(nextIndex(selectedIndex, options.length));
      return;
    }
    if (key.return) {
      onSelect(options[selectedIndex]);
    }
  });

  return h(SelectionList, {
    title: 'Pick project',
    items: options.map((option) => ({
      key: String(option.projectMemberId ?? option.projectId ?? option.projectName),
      label: option.label
    })),
    selectedIndex
  });
}

export function DraftPicker({
  drafts = [],
  selectedIndex = 0,
  includeStartNew = false,
  onChange,
  onResume,
  onDelete,
  onStartNew,
  onCancel
}) {
  const items = includeStartNew
    ? [{ type: 'new', key: '__new__', label: 'Start new logwork session' }, ...drafts.map((draft) => ({
      type: 'draft',
      key: draft.id,
      draft,
      label: formatManualDraftLabel(draft)
    }))]
    : drafts.map((draft) => ({
      type: 'draft',
      key: draft.id,
      draft,
      label: formatManualDraftLabel(draft)
    }));

  useInput((input, key) => {
    if (!items.length) {
      if (key.escape) {
        onCancel();
      }
      return;
    }
    if (key.upArrow) {
      onChange(previousIndex(selectedIndex, items.length));
      return;
    }
    if (key.downArrow) {
      onChange(nextIndex(selectedIndex, items.length));
      return;
    }
    if (key.escape) {
      onCancel();
      return;
    }
    const selected = items[selectedIndex];
    if (key.return) {
      if (selected?.type === 'new') {
        onStartNew();
      } else if (selected?.draft) {
        onResume(selected.draft);
      }
      return;
    }
    if (String(input || '').toLowerCase() === 'd' && selected?.draft) {
      onDelete(selected.draft);
    }
  });

  if (!items.length) {
    return h(Box, {
      borderStyle: 'single',
      borderColor: 'yellow',
      paddingX: 1
    }, h(Text, { color: 'yellow' }, 'No saved drafts. Esc returns.'));
  }

  return h(SelectionList, {
    title: 'Saved drafts · Enter resume/start · d delete · Esc back',
    items,
    selectedIndex
  });
}

export function McpClientPicker({
  clients = MCP_CLIENTS,
  selectedIndex = 0,
  onChange,
  onSelect,
  onCancel
}) {
  useInput((input, key) => {
    if (key.upArrow) {
      onChange(previousIndex(selectedIndex, clients.length));
      return;
    }
    if (key.downArrow) {
      onChange(nextIndex(selectedIndex, clients.length));
      return;
    }
    if (key.return) {
      onSelect(clients[selectedIndex]);
      return;
    }
    if (key.escape) {
      onCancel();
    }
  });

  return h(SelectionList, {
    title: 'Pick MCP client',
    items: clients.map((client) => ({
      key: client.key,
      label: `${client.label} - ${client.format}`
    })),
    selectedIndex
  });
}

export function TaskEditPicker({
  tasks = [],
  selectedIndex = 0,
  onChange,
  onSelect,
  onCancel
}) {
  useInput((input, key) => {
    if (key.upArrow) {
      onChange(previousIndex(selectedIndex, tasks.length));
      return;
    }
    if (key.downArrow) {
      onChange(nextIndex(selectedIndex, tasks.length));
      return;
    }
    if (key.return) {
      onSelect(selectedIndex);
      return;
    }
    if (key.escape) {
      onCancel();
    }
  });

  return h(Box, {
    flexDirection: 'column',
    borderStyle: 'single',
    borderColor: 'yellow',
    paddingX: 1
  },
  h(Text, { color: 'yellow' }, 'Edit task · ↑/↓ select · Enter replace · Esc cancel'),
  tasks.map((task, index) => h(Text, {
    key: `${index}-${task.taskName}`,
    color: index === selectedIndex ? 'yellow' : 'gray'
  }, `${index === selectedIndex ? '›' : ' '} ${index + 1}. +${formatTaskHours(task.hours)} ${task.taskName}`)));
}

export function TaskRemovePicker({
  tasks = [],
  selectedIndex = 0,
  selectedIndexes = [],
  onChange,
  onToggle,
  onSubmit,
  onCancel
}) {
  const [commandBuffer, setCommandBuffer] = useState('');

  useInput((input, key) => {
    if (key.upArrow) {
      onChange(previousIndex(selectedIndex, tasks.length));
      return;
    }
    if (key.downArrow) {
      onChange(nextIndex(selectedIndex, tasks.length));
      return;
    }
    if (input === ' ' || key.space) {
      onToggle(selectedIndex);
      return;
    }
    if (key.return) {
      onSubmit(selectedIndexes);
      return;
    }
    if (key.escape) {
      onCancel();
      return;
    }

    const nextBuffer = `${commandBuffer}${input || ''}`;
    if ('/cancel'.startsWith(nextBuffer)) {
      setCommandBuffer(nextBuffer);
      if (nextBuffer === '/cancel') {
        onCancel();
      }
    } else {
      setCommandBuffer(input === '/' ? '/' : '');
    }
  });

  return h(Box, {
    flexDirection: 'column',
    borderStyle: 'single',
    borderColor: 'yellow',
    paddingX: 1
  },
  h(Text, { color: 'yellow' }, 'Remove tasks · Space select · Enter confirm · Esc cancel'),
  tasks.map((task, index) => {
    const selected = selectedIndexes.includes(index);
    return h(Text, {
      key: `${index}-${task.taskName}`,
      color: index === selectedIndex ? 'yellow' : selected ? 'cyan' : 'gray'
    }, `${index === selectedIndex ? '›' : ' '} ${selected ? '[x]' : '[ ]'} ${index + 1}. +${formatTaskHours(task.hours)} ${task.taskName}`);
  }));
}

export function SelectionList({ title, items = [], selectedIndex = 0 }) {
  return h(Box, {
    flexDirection: 'column',
    borderStyle: 'single',
    borderColor: 'cyan',
    paddingX: 1
  },
  h(Text, { color: 'cyan' }, `${title} · ↑/↓ then Enter`),
  items.map((item, index) => h(Text, {
    key: item.key,
    color: index === selectedIndex ? 'cyan' : 'gray'
  }, `${index === selectedIndex ? '›' : ' '} ${item.label}`)));
}

export function SlashMenu({ suggestions = [], selectedIndex = 0 }) {
  return h(Box, {
    flexDirection: 'column',
    borderStyle: 'single',
    borderColor: 'cyan',
    paddingX: 1
  },
  suggestions.slice(0, COMMAND_SUGGESTION_LIMIT).map((command, index) => h(Text, {
    key: command.name,
    color: index === selectedIndex ? 'cyan' : 'gray'
  }, `${index === selectedIndex ? '›' : ' '} ${command.name.padEnd(12)} ${command.description}`)));
}

export function ConfirmDialog({
  message,
  initialValue = true,
  onResolve
}) {
  useInput((input, key) => {
    if (key.return) {
      onResolve(initialValue);
      return;
    }

    const normalized = String(input || '').toLowerCase();
    if (normalized === 'y') {
      onResolve(true);
      return;
    }
    if (normalized === 'n' || key.escape) {
      onResolve(false);
    }
  });

  return h(Box, {
    borderStyle: 'round',
    borderColor: 'yellow',
    paddingX: 1
  },
  h(Text, { color: 'yellow' }, `${message} ${initialValue ? '[Y/n]' : '[y/N]'}`));
}

export function LoadingLine({ message }) {
  return h(Text, { color: 'yellow' }, `⏳ ${message}`);
}

export function ProjectChart({ lines = [] }) {
  return h(Box, {
    flexDirection: 'column'
  }, lines.map((line, index) => h(Text, {
    key: index,
    color: chartLineColor(line)
  }, line)));
}

export function loadingMessageForCommand(command) {
  if (command.type === 'query') {
    return 'Fetching Resource Optimiser timesheet...';
  }
  if (command.type === 'projects') {
    return 'Fetching Resource Optimiser projects and weekly timesheet...';
  }
  if (command.type === 'reconcile') {
    return 'Comparing Resource Optimiser and Jira worklogs...';
  }
  if (command.type === 'logwork') {
    return 'Building logwork preview...';
  }
  if (command.type === 'apply') {
    return 'Submitting logwork...';
  }
  if (command.type === 'edit_ro_logwork') {
    return 'Checking and updating Resource Optimiser logwork...';
  }
  if (command.type === 'map') {
    return 'Updating project mapping...';
  }
  if (command.type === 'auth') {
    return 'Authenticating Resource Optimiser...';
  }
  if (command.type === 'diagnostics') {
    return 'Writing diagnostics report...';
  }
  if (command.type === 'mcp') {
    return '';
  }
  return '';
}

export function panelTitleForCommand(command) {
  if (command.type === 'query') {
    return 'Query Logwork';
  }
  if (command.type === 'projects') {
    return 'Projects';
  }
  if (command.type === 'reconcile') {
    return 'RO / Jira Reconciliation';
  }
  if (command.type === 'logwork') {
    return 'Logwork Preview';
  }
  if (command.type === 'apply') {
    return 'Apply Logwork';
  }
  if (command.type === 'edit_ro_logwork') {
    return 'Edit RO Logwork';
  }
  if (command.type === 'map') {
    return 'Project Mapping';
  }
  if (command.type === 'auth') {
    return 'Authentication';
  }
  if (command.type === 'status') {
    return 'Auth Status';
  }
  if (command.type === 'diagnostics') {
    return 'Diagnostics';
  }
  if (command.type === 'mcp') {
    return 'MCP Setup';
  }
  return 'Command';
}

export function panelColor(kind) {
  if (kind === 'error') {
    return 'red';
  }
  if (kind === 'success') {
    return 'green';
  }
  if (kind === 'logwork' || kind === 'auth') {
    return 'cyan';
  }
  return 'gray';
}

export function formatTaskHours(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(2))).replace(/\.0$/, '');
}

export function chartLineColor(line) {
  if (/over|unbooked/i.test(line)) {
    return 'yellow';
  }
  if (line.includes('█')) {
    return 'green';
  }
  return undefined;
}

export function renderProjectChartText(lines = []) {
  return lines.map((line) => {
    if (/over|unbooked/i.test(line)) {
      return chalk.yellow(line);
    }
    if (line.includes('█')) {
      return chalk.green(line);
    }
    return line;
  }).join('\n');
}

export function commandItems() {
  return MANUAL_COMMANDS
    .filter((command) => command.hidden !== true)
    .map((command) => ({
      label: `${command.name} ${command.description}`,
      value: command.name
    }));
}
