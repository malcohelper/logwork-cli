import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { renderToString } from 'ink';
import {
  addDraftTask,
  createManualSession,
  executeManualCommand,
  formatProjectChart,
  formatProjects,
  previewManualLogworkDraft,
  parseManualCommand
} from '../lib/manual-repl.mjs';
import {
  buildLogworkText,
  buildProjectOptions,
  buildProjectOverrides,
  buildWeekDateOptions,
  canApplyPreview,
  formatDraftPreview,
  parseTaskLine,
  removeDraftTasks,
  replaceDraftTask,
  toggleTaskSelection
} from '../lib/manual-logwork-wizard.mjs';
import { createAuthRequiredError } from '../lib/auth-errors.mjs';
import { createJiraAuthRequiredError } from '../lib/jira-auth.mjs';
import {
  formatManualHelp,
  getCommandSuggestions,
  renderCommandSuggestions,
  TASK_COMMANDS
} from '../lib/manual-commands.mjs';
import {
  deleteManualDraft,
  formatManualDraftLabel,
  loadManualDrafts,
  saveManualDraft
} from '../lib/manual-drafts.mjs';
import {
  AuthPrompt,
  CurrentPanel,
  createInkCredentialProvider,
  DatePicker,
  DraftPicker,
  HeaderBar,
  McpClientPicker,
  OutputPanel,
  ProjectPicker,
  ProjectChart,
  SlashMenu,
  StatusBar,
  TargetPicker,
  TaskEditPicker,
  TaskRemovePicker
} from '../lib/manual-ink-app.mjs';
import {
  StatusBar as DirectStatusBar,
  commandInputKey,
  commandItems,
  completeCommandValue,
  loadingMessageForCommand,
  sameProjectIdentity
} from '../lib/manual-ink-ui.mjs';
import {
  AuthPrompt as DirectAuthPrompt
} from '../lib/manual-ink-auth.mjs';
import {
  formatMcpSetup,
  resolveMcpClientSelection
} from '../lib/manual-mcp.mjs';

const h = React.createElement;

test('manual command registry renders help and slash suggestions', () => {
  assert.match(formatManualHelp(), /\/query today/);
  assert.match(formatManualHelp(), /yesterday/);
  assert.match(formatManualHelp(), /last-week/);
  assert.match(formatManualHelp(), /this-month/);
  assert.match(formatManualHelp(), /last-month/);
  assert.match(formatManualHelp(), /\/reconcile \[today\|yesterday\|this-week/);
  assert.match(formatManualHelp(), /\/logwork/);
  assert.match(formatManualHelp(), /\/edit-logwork <id> --hours/);
  assert.match(formatManualHelp(), /\/mcp \[cursor\|antigravity\|copilot\|claude-code\|codex\]/);
  assert.match(formatManualHelp(), /\/diagnostics/);
  assert.match(formatManualHelp(), /\/history \[ro\|jira\|both\]/);
  assert.doesNotMatch(formatManualHelp(), /\/apply/);
  assert.doesNotMatch(formatManualHelp(), /\/exit|\/quit/);
  assert.doesNotMatch(formatManualHelp(), /\/preview/);
  assert.match(formatManualHelp(), /\/projects \[projectMemberId\|projectId\|name\]/);
  assert.deepEqual(getCommandSuggestions('/q').map((command) => command.name), ['/query']);
  assert.deepEqual(getCommandSuggestions('/query').map((command) => command.name), [
    '/query today',
    '/query yesterday',
    '/query this-week',
    '/query last-week',
    '/query this-month',
    '/query last-month'
  ]);
  assert.deepEqual(getCommandSuggestions('/query l').map((command) => command.name), [
    '/query last-week',
    '/query last-month'
  ]);
  assert.deepEqual(getCommandSuggestions('/reconcile l').map((command) => command.name), [
    '/reconcile last-week',
    '/reconcile last-month'
  ]);
  assert.deepEqual(getCommandSuggestions('/lo').map((command) => command.name), ['/logwork']);
  assert.deepEqual(getCommandSuggestions('/logwork ').map((command) => command.name), [
    '/logwork ro',
    '/logwork jira',
    '/logwork both'
  ]);
  assert.deepEqual(getCommandSuggestions('/mc').map((command) => command.name), ['/mcp']);
  assert.deepEqual(getCommandSuggestions('/ap').map((command) => command.name), []);
  assert.deepEqual(getCommandSuggestions('/e').map((command) => command.name), ['/edit-logwork']);
  assert.deepEqual(getCommandSuggestions('/pre').map((command) => command.name), []);
  assert.deepEqual(getCommandSuggestions('/pro').map((command) => command.name), ['/projects']);
  assert.deepEqual(getCommandSuggestions('/di').map((command) => command.name), ['/diagnostics']);
  assert.deepEqual(getCommandSuggestions('/hi').map((command) => command.name), ['/history']);
  assert.match(renderCommandSuggestions('/pro'), /\/projects\s+List projects with weekly booked\/logged chart/);
  assert.match(renderCommandSuggestions('/mc'), /\/mcp\s+Show copy-ready MCP setup for an IDE/);
  assert.match(renderCommandSuggestions('/'), /\/mcp\s+Show copy-ready MCP setup for an IDE/);
  assert.deepEqual(getCommandSuggestions('/a', TASK_COMMANDS).map((command) => command.name), []);
  assert.deepEqual(getCommandSuggestions('/s', TASK_COMMANDS).map((command) => command.name), ['/save']);
  assert.deepEqual(getCommandSuggestions('/d', TASK_COMMANDS).map((command) => command.name), ['/drafts', '/diagnostics']);
  assert.deepEqual(getCommandSuggestions('/e', TASK_COMMANDS).map((command) => command.name), ['/edit']);
  assert.match(renderCommandSuggestions('/re', 0, TASK_COMMANDS), /\/remove\s+Select tasks to delete/);
});

test('Ink manual components render shell, current panel, pickers, menu, status, and chart text', () => {
  assert.match(renderToString(h(HeaderBar, { cwd: '/tmp/repo' })), /Logwork Helper/);
  assert.match(renderToString(h(HeaderBar, { cwd: '/tmp/repo' })), /cwd: \/tmp\/repo/);
  assert.match(renderToString(h(SlashMenu, {
    suggestions: getCommandSuggestions('/pro'),
    selectedIndex: 0
  })), /\/projects/);
  assert.match(renderToString(h(SlashMenu, {
    suggestions: getCommandSuggestions('/'),
    selectedIndex: 0
  })), /\/mcp/);
  assert.match(renderToString(h(CurrentPanel, {
    panel: { kind: 'error', title: 'Current', text: 'Something failed' }
  })), /Something failed/);
  assert.match(renderToString(h(OutputPanel, {
    items: [{ kind: 'error', text: 'Something failed' }]
  })), /Something failed/);
  assert.match(renderToString(h(StatusBar, {
    preview: readyPreview(),
    dryRun: true,
    wizard: { step: 'edit_tasks' }
  })), /mode: edit-tasks · preview: ready · 1 entries · DRY RUN/);
  assert.match(renderToString(h(StatusBar, {
    preview: null,
    dryRun: false,
    wizard: null,
    authPrompt: { step: 'credentials' }
  })), /mode: auth-credentials/);
  const authPasswordOutput = renderToString(h(AuthPrompt, {
    prompt: { step: 'credentials', field: 'password', email: 'malco' },
    inputValue: 'secret-password',
    onInputChange() {},
    onPromptChange() {},
    onResolve() {},
    onReject() {}
  }));
  assert.match(authPasswordOutput, /password/);
  assert.doesNotMatch(authPasswordOutput, /secret-password/);
  const authOtpOutput = renderToString(h(AuthPrompt, {
    prompt: { step: 'otp' },
    inputValue: '123456',
    onInputChange() {},
    onPromptChange() {},
    onResolve() {},
    onReject() {}
  }));
  assert.match(authOtpOutput, /2FA/);
  assert.doesNotMatch(authOtpOutput, /123456/);
  const authPasswordUpdateOutput = renderToString(h(AuthPrompt, {
    prompt: { step: 'password-update', field: 'newPassword' },
    inputValue: 'new-secret-password',
    onInputChange() {},
    onPromptChange() {},
    onResolve() {},
    onReject() {}
  }));
  assert.match(authPasswordUpdateOutput, /Update Resource Optimiser password/);
  assert.doesNotMatch(authPasswordUpdateOutput, /new-secret-password/);
  assert.match(renderToString(h(AuthPrompt, {
    prompt: {
      step: 'device',
      selectedIndex: 0,
      devices: [{ label: 'iPhone' }, { label: '14 PRM' }]
    },
    onPromptChange() {},
    onResolve() {},
    onReject() {}
  })), /Choose 2FA device/);
  assert.match(renderToString(h(DatePicker, {
    options: buildWeekDateOptions(weeklyLogwork()),
    selectedIndex: 0,
    onChange() {},
    onSelect() {}
  })), /Pick date/);
  assert.match(renderToString(h(ProjectPicker, {
    options: buildProjectOptions({
      projectsResult: projectList(),
      weekly: weeklyLogwork(),
      date: '2026-06-01'
    }),
    selectedIndex: 0,
    onChange() {},
    onSelect() {}
  })), /Pick project/);
  const projectOptions = buildProjectOptions({
    projectsResult: projectList(),
    weekly: weeklyLogwork(),
    date: '2026-06-01'
  });
  assert.equal(projectOptions[0].booked, true);
  assert.equal(projectOptions[1].booked, false);
  assert.match(projectOptions[1].label, /UNBOOKED/);
  assert.match(renderToString(h(ProjectChart, {
    lines: [
      'Course Builder',
      '[████████████████████] 100%'
    ]
  })), /Course Builder/);
  assert.match(renderToString(h(TaskRemovePicker, {
    tasks: [
      { hours: 2, taskName: 'check ui/ux' },
      { hours: 1, taskName: 'fix copy' }
    ],
    selectedIndex: 0,
    selectedIndexes: [1],
    onChange() {},
    onToggle() {},
    onSubmit() {},
    onCancel() {}
  })), /Remove tasks/);
  assert.match(renderToString(h(TaskEditPicker, {
    tasks: [
      { hours: 2, taskName: 'check ui/ux' }
    ],
    selectedIndex: 0,
    onChange() {},
    onSelect() {},
    onCancel() {}
  })), /Edit task/);
  assert.match(renderToString(h(DraftPicker, {
    drafts: [
      savedDraftFixture()
    ],
    selectedIndex: 0,
    includeStartNew: true,
    onChange() {},
    onResume() {},
    onDelete() {},
    onStartNew() {},
    onCancel() {}
  })), /Start new logwork session/);
  assert.match(renderToString(h(McpClientPicker, {
    selectedIndex: 0,
    onChange() {},
    onSelect() {},
    onCancel() {}
  })), /Pick MCP client/);
  assert.match(renderToString(h(McpClientPicker, {
    selectedIndex: 0,
    onChange() {},
    onSelect() {},
    onCancel() {}
  })), /Cursor/);
  assert.match(renderToString(h(TargetPicker, {
    title: 'Pick logwork target',
    targets: [
      { key: 'ro', label: 'Resource Optimiser', description: 'RO only' },
      { key: 'jira', label: 'Jira', description: 'Jira only' }
    ],
    selectedIndex: 1,
    onChange() {},
    onSelect() {},
    onCancel() {}
  })), /Jira - Jira only/);
});

test('Ink manual app re-exports maintain UI and auth module compatibility', () => {
  assert.equal(StatusBar, DirectStatusBar);
  assert.equal(AuthPrompt, DirectAuthPrompt);
  assert.equal(loadingMessageForCommand({ type: 'query' }), 'Fetching Resource Optimiser timesheet...');
  assert.equal(sameProjectIdentity({ projectMemberId: 5234 }, { projectMemberId: '5234' }), true);
  assert.equal(commandInputKey('command', 2), 'command:2');
  assert.equal(completeCommandValue('/lo', [{ name: '/logwork' }], 0), '/logwork');
  assert.equal(completeCommandValue('/query l', getCommandSuggestions('/query l'), 1), '/query last-month');
  assert.equal(completeCommandValue('/logwork', [{ name: '/logwork' }], 0), null);
  assert.equal(completeCommandValue('/query today', [{ name: '/query' }], 0), null);
  assert.ok(commandItems().some((item) => item.value === '/query'));
  assert.match(renderToString(h(DirectStatusBar, {
    preview: null,
    dryRun: false,
    wizard: null
  })), /mode: command · preview: none/);
});

test('Ink credential provider resolves auth steps without clack prompts', async () => {
  const prompts = [];
  const panels = [];
  const inputValues = [];
  const selectedIndexes = [];
  const resolverRef = { current: null };
  const rejecterRef = { current: null };
  const provider = createInkCredentialProvider({
    resolverRef,
    rejecterRef,
    setAuthPrompt(prompt) {
      prompts.push(prompt);
    },
    setActivePanel(panel) {
      panels.push(panel);
    },
    setInputValue(value) {
      inputValues.push(value);
    },
    setSelectedIndex(value) {
      selectedIndexes.push(value);
    }
  });

  const credentialsPromise = provider.requestCredentials();
  assert.equal(prompts.at(-1).step, 'credentials');
  assert.equal(prompts.at(-1).field, 'email');
  assert.match(panels.at(-1).text, /email and password/);
  resolverRef.current({
    email: 'malco',
    password: 'not-printed'
  });
  assert.deepEqual(await credentialsPromise, {
    email: 'malco',
    password: 'not-printed'
  });

  const singleDevice = { label: 'Only phone', credentialId: 'one' };
  assert.equal(await provider.requestDeviceSelection([singleDevice]), singleDevice);

  const devices = [
    { label: 'iPhone', credentialId: 'a' },
    { label: '14 PRM', credentialId: 'b' }
  ];
  const devicePromise = provider.requestDeviceSelection(devices);
  assert.equal(prompts.at(-1).step, 'device');
  assert.equal(prompts.at(-1).devices, devices);
  resolverRef.current(devices[1]);
  assert.equal(await devicePromise, devices[1]);

  const otpPromise = provider.requestOtp();
  assert.equal(prompts.at(-1).step, 'otp');
  resolverRef.current('123456');
  assert.equal(await otpPromise, '123456');

  const passwordUpdatePromise = provider.requestPasswordUpdate();
  assert.equal(prompts.at(-1).step, 'password-update');
  assert.equal(prompts.at(-1).field, 'newPassword');
  assert.match(panels.at(-1).text, /requires a new Resource Optimiser password/);
  resolverRef.current({
    newPassword: 'new-secret-password',
    confirmPassword: 'new-secret-password'
  });
  assert.deepEqual(await passwordUpdatePromise, {
    newPassword: 'new-secret-password',
    confirmPassword: 'new-secret-password'
  });

  assert.ok(inputValues.every((value) => value === ''));
  assert.ok(selectedIndexes.every((value) => value === 0));
  assert.doesNotMatch(JSON.stringify(panels), /not-printed|123456|new-secret-password/);
});

test('parseManualCommand supports visible commands and rejects exit aliases', () => {
  assert.deepEqual(parseManualCommand('/query today'), {
    type: 'query',
    args: { period: 'today' }
  });
  assert.deepEqual(parseManualCommand('/query yesterday'), {
    type: 'query',
    args: { period: 'yesterday' }
  });
  assert.deepEqual(parseManualCommand('/query this-week'), {
    type: 'query',
    args: { period: 'this_week' }
  });
  assert.deepEqual(parseManualCommand('/query last-week'), {
    type: 'query',
    args: { period: 'last_week' }
  });
  assert.deepEqual(parseManualCommand('/query this-month'), {
    type: 'query',
    args: { period: 'this_month' }
  });
  assert.deepEqual(parseManualCommand('/query last-month'), {
    type: 'query',
    args: { period: 'last_month' }
  });
  assert.deepEqual(parseManualCommand('/reconcile'), {
    type: 'reconcile',
    period: undefined
  });
  assert.deepEqual(parseManualCommand('/reconcile last-week'), {
    type: 'reconcile',
    period: 'last_week'
  });
  assert.deepEqual(parseManualCommand('/logwork'), {
    type: 'logwork',
    text: undefined
  });
  assert.deepEqual(parseManualCommand('/logwork ro'), {
    type: 'logwork',
    target: 'ro',
    text: undefined
  });
  assert.deepEqual(parseManualCommand('/logwork jira'), {
    type: 'logwork',
    target: 'jira',
    text: undefined
  });
  assert.deepEqual(parseManualCommand('/logwork both'), {
    type: 'logwork',
    target: 'both',
    text: undefined
  });
  assert.deepEqual(parseManualCommand('/logwork Monday, 01 Jun 2026'), {
    type: 'logwork',
    text: 'Monday, 01 Jun 2026'
  });
  assert.deepEqual(parseManualCommand('/edit-logwork 290364 --hours 0.5 --task-name Updated task'), {
    type: 'edit_ro_logwork',
    logworkId: '290364',
    hours: 0.5,
    taskName: 'Updated task'
  });
  assert.deepEqual(parseManualCommand('/auth ro'), {
    type: 'auth',
    target: 'ro'
  });
  assert.deepEqual(parseManualCommand('/auth jira'), {
    type: 'auth',
    target: 'jira'
  });
  assert.deepEqual(parseManualCommand('/status ro'), {
    type: 'status',
    target: 'ro'
  });
  assert.deepEqual(parseManualCommand('/status jira'), {
    type: 'status',
    target: 'jira'
  });
  assert.deepEqual(parseManualCommand('/mcp'), {
    type: 'mcp',
    client: undefined
  });
  assert.deepEqual(parseManualCommand('/mcp cursor'), {
    type: 'mcp',
    client: 'cursor'
  });
  assert.deepEqual(parseManualCommand('/mcp claude code'), {
    type: 'mcp',
    client: 'claude-code'
  });
  assert.deepEqual(parseManualCommand('/diagnostics'), { type: 'diagnostics' });
  assert.deepEqual(parseManualCommand('/history'), { type: 'history' });
  assert.deepEqual(parseManualCommand('/history jira'), { type: 'history', target: 'jira' });
  assert.deepEqual(parseManualCommand('/history both'), { type: 'history', target: 'both' });
  assert.deepEqual(parseManualCommand('/apply'), { type: 'apply' });
  assert.deepEqual(parseManualCommand('/apply jira'), { type: 'apply', target: 'jira' });
  assert.deepEqual(parseManualCommand('/apply both'), { type: 'apply', target: 'both' });
  assert.deepEqual(parseManualCommand('/projects'), {
    type: 'projects',
    project: undefined
  });
  assert.deepEqual(parseManualCommand('/projects 5234'), {
    type: 'projects',
    project: '5234'
  });
  assert.deepEqual(parseManualCommand('/map SCB,OPS 5234'), {
    type: 'map',
    tickets: ['SCB', 'OPS'],
    projectMemberId: '5234'
  });
  assert.throws(() => parseManualCommand('/exit'), /Unknown command/);
  assert.throws(() => parseManualCommand('/quit'), /Unknown command/);
  assert.throws(() => parseManualCommand('/query sometime'), /Usage: \/query/);
  assert.throws(() => parseManualCommand('/query 2026-06-05'), /Usage: \/query/);
  assert.throws(() => parseManualCommand('/query 2026-06-01..2026-06-08'), /Usage: \/query/);
  assert.throws(() => parseManualCommand('/auth both'), /Usage: \/auth/);
  assert.throws(() => parseManualCommand('/status both'), /Usage: \/status/);
  assert.throws(() => parseManualCommand('/preview'), /Unknown command/);
  assert.throws(() => parseManualCommand('/edit-logwork 290364'), /requires --hours/);
  assert.throws(() => parseManualCommand('/edit-logwork 290364 --hours 1 --yes'), /always previews and confirms/);
  assert.throws(() => parseManualCommand('/mcp unknown'), /Unknown MCP client/);
  assert.throws(() => parseManualCommand('/unknown'), /Unknown command/);
});

test('manual MCP setup formats copy-ready client configs', async () => {
  const serverPath = '/tmp/logwork-helper/mcp-server.mjs';
  const cursor = formatMcpSetup({
    client: 'cursor',
    serverPath
  });
  assert.match(cursor, /MCP setup: Cursor/);
  assert.match(cursor, /"mcpServers"/);
  assert.match(cursor, /"args": \[\s+"\/tmp\/logwork-helper\/mcp-server\.mjs"/);

  const copilot = formatMcpSetup({
    client: 'copilot',
    serverPath
  });
  assert.match(copilot, /GitHub Copilot \/ VS Code/);
  assert.match(copilot, /"servers"/);
  assert.match(copilot, /"type": "stdio"/);

  const claude = formatMcpSetup({
    client: 'claude-code',
    serverPath
  });
  assert.match(claude, /claude mcp add --transport stdio logwork-helper -- node/);
  assert.match(claude, /project \.mcp\.json/);

  const windowsClaude = formatMcpSetup({
    client: 'claude-code',
    serverPath: 'C:\\Users\\example\\.logwork-helper\\mcp-server.mjs',
    platform: 'win32'
  });
  assert.match(windowsClaude, /node 'C:\\Users\\example\\.logwork-helper\\mcp-server\.mjs'/);

  const codex = formatMcpSetup({
    client: 'codex',
    serverPath
  });
  assert.match(codex, /\[mcp_servers\.logwork-helper\]/);
  assert.match(codex, /tool_timeout_sec = 120/);

  assert.equal(resolveMcpClientSelection('2')?.key, 'antigravity');
  assert.equal(resolveMcpClientSelection('github copilot')?.key, 'copilot');
});

test('manual MCP command prompts for client and prints setup', async () => {
  const printed = [];
  await executeManualCommand(parseManualCommand('/mcp'), createManualSession(), context({
    printed,
    lines: ['2']
  }));

  assert.match(printed.join('\n'), /Choose MCP client/);
  assert.match(printed.join('\n'), /MCP setup: Google Antigravity/);
  assert.match(printed.join('\n'), /"mcpServers"/);
});

test('manual RO edit previews and confirms before applying', async () => {
  const printed = [];
  let applied;
  const editPreview = {
    previewId: 'ro_edit_safe',
    status: 'ready',
    summary: 'RO edit preview: hours 1 -> 0.5.'
  };
  await executeManualCommand(
    parseManualCommand('/edit-logwork 290364 --hours 0.5'),
    createManualSession(),
    context({
      printed,
      prompts: confirmations([true]),
      workflows: {
        previewRoLogworkEdit: async (args) => {
          assert.deepEqual(args, {
            logworkId: '290364',
            hours: 0.5,
            taskName: undefined
          });
          return editPreview;
        },
        applyRoLogworkEdit: async (args) => {
          applied = args;
          return { summary: 'Updated RO logwork 290364.' };
        }
      }
    })
  );

  assert.equal(applied.preview, editPreview);
  assert.equal(applied.confirm, true);
  assert.deepEqual(printed, [
    editPreview.summary,
    'Updated RO logwork 290364.'
  ]);
});

test('manual query prints grouped logwork summary', async () => {
  const printed = [];
  const session = createManualSession();
  const command = parseManualCommand('/query this-week');
  const workflows = {
    queryLogwork: async (args) => {
      assert.equal(args.period, 'this_week');
      assert.equal(args.includeEntries, true);
      return {
        summary: 'Logwork from 2026-06-01 to 2026-06-08: 8h logged / 8h booked.'
      };
    }
  };

  await executeManualCommand(command, session, context({ workflows, printed }));

  assert.deepEqual(printed, ['Logwork from 2026-06-01 to 2026-06-08: 8h logged / 8h booked.']);
});

test('manual reconcile runs the shared read-only workflow', async () => {
  const printed = [];
  const session = createManualSession();
  await executeManualCommand(parseManualCommand('/reconcile this-week'), session, context({
    cwd: '/workspace/project',
    printed,
    workflows: {
      reconcileLogwork: async (args) => {
        assert.deepEqual(args, {
          period: 'this_week',
          cwd: '/workspace/project'
        });
        return { summary: 'RO / Jira reconciliation: matched.' };
      }
    }
  }));

  assert.deepEqual(printed, ['RO / Jira reconciliation: matched.']);
});

test('manual diagnostics writes support report summary', async () => {
  const printed = [];
  await executeManualCommand(parseManualCommand('/diagnostics'), createManualSession(), context({
    printed,
    workflows: {
      generateDiagnosticsReport: async () => ({
        summary: 'Diagnostics report written to /tmp/logwork-diagnostics.txt'
      })
    }
  }));

  assert.match(printed.join('\n'), /Diagnostics report written to \/tmp\/logwork-diagnostics\.txt/);
  assert.match(printed.join('\n'), /Send this sanitized file/);
});

test('manual history filters the local ledger by target and workspace', async () => {
  const printed = [];
  await executeManualCommand(parseManualCommand('/history both'), createManualSession(), context({
    cwd: '/workspace/project',
    printed,
    workflows: {
      queryApplyLedger: async (args) => {
        assert.deepEqual(args, {
          target: 'both',
          cwd: '/workspace/project',
          limit: 20
        });
        return { summary: 'Apply history: 2 records.' };
      }
    }
  }));

  assert.deepEqual(printed, ['Apply history: 2 records.']);
});

test('manual auth and status route Resource Optimiser and Jira targets', async () => {
  const printed = [];
  const session = createManualSession();
  const workflows = {
    loginResourceOptimiser: async () => ({ summary: 'RO auth complete.' }),
    getStoredAuthStatus: async () => ({ summary: 'RO authenticated.' }),
    getStoredJiraStatus: async () => ({ summary: 'Jira authenticated.' })
  };

  await executeManualCommand(parseManualCommand('/auth ro'), session, context({
    workflows,
    printed
  }));
  await executeManualCommand(parseManualCommand('/auth jira'), session, context({
    workflows,
    printed
  }));
  await executeManualCommand(parseManualCommand('/status'), session, context({
    workflows,
    printed
  }));
  await executeManualCommand(parseManualCommand('/status jira'), session, context({
    workflows,
    printed
  }));

  assert.match(printed.join('\n'), /RO auth complete/);
  assert.match(printed.join('\n'), /logwork-helper jira login/);
  assert.match(printed.join('\n'), /Resource Optimiser: RO authenticated/);
  assert.match(printed.join('\n'), /Jira: Jira authenticated/);
});

test('manual logwork fallback stores last preview from pasted text', async () => {
  const printed = [];
  const session = createManualSession();
  const workflows = {
    previewLogworkBatch: async ({ text }) => {
      assert.match(text, /Maintenance mode/);
      return readyPreview({
        summary: 'Logwork preview:\nReady to apply.'
      });
    }
  };

  await executeManualCommand(parseManualCommand('/logwork'), session, context({
    workflows,
    printed,
    lines: [
      'ro',
      'Monday, 01 Jun 2026',
      '+2 Maintenance mode (SCB-213)',
      '/end'
    ]
  }));

  assert.equal(session.previews.ro.status, 'ready');
  assert.equal(session.activeTarget, 'ro');
  assert.match(printed.join('\n'), /Paste Resource Optimiser weekly logwork text/);
  assert.match(printed.join('\n'), /Ready to apply/);
});

test('manual Jira logwork previews and applies independently', async () => {
  const printed = [];
  const session = createManualSession();
  const workflows = {
    previewJiraWorklogBatch: async ({ text }) => {
      assert.match(text, /Maintenance mode/);
      return readyJiraPreview({
        summary: 'Jira preview:\nReady to apply.'
      });
    },
    applyJiraWorklogBatch: async ({ batch, confirm }) => {
      assert.equal(batch, session.previews.jira);
      assert.equal(confirm, true);
      return {
        summary: 'Jira worklog submitted.'
      };
    }
  };

  await executeManualCommand(parseManualCommand('/logwork jira'), session, context({
    workflows,
    printed,
    lines: [
      'Monday, 01 Jun 2026',
      '+2 Maintenance mode (SCB-213)',
      '/end'
    ]
  }));

  assert.equal(session.activeTarget, 'jira');
  assert.equal(session.previews.jira.status, 'ready');
  assert.match(printed.join('\n'), /Jira preview/);

  await executeManualCommand(parseManualCommand('/apply jira'), session, context({
    workflows,
    prompts: confirmations([true]),
    printed
  }));

  assert.equal(session.previews.jira, null);
  assert.match(printed.join('\n'), /Jira worklog submitted/);
});

test('manual Jira logwork reports login command when auth is missing', async () => {
  const session = createManualSession();
  await assert.rejects(() => executeManualCommand(parseManualCommand('/logwork jira'), session, context({
    workflows: {
      previewJiraWorklogBatch: async () => {
        throw createJiraAuthRequiredError();
      }
    },
    lines: [
      'Monday, 01 Jun 2026',
      '+2 Maintenance mode (SCB-213)',
      '/end'
    ]
  })), /logwork-helper jira login/);
});

test('manual both logwork previews and applies RO then Jira with separate confirmations', async () => {
  const printed = [];
  const session = createManualSession();
  const calls = [];
  const workflows = {
    previewLogworkBatch: async () => readyPreview({ summary: 'RO preview ready.' }),
    previewJiraWorklogBatch: async () => readyJiraPreview({ summary: 'Jira preview ready.' }),
    applyLogworkBatch: async ({ confirm, ledgerContext }) => {
      calls.push('ro');
      assert.equal(confirm, true);
      assert.deepEqual(ledgerContext, { flowTarget: 'both' });
      return { summary: 'RO submitted.' };
    },
    applyJiraWorklogBatch: async ({ confirm, ledgerContext }) => {
      calls.push('jira');
      assert.equal(confirm, true);
      assert.deepEqual(ledgerContext, { flowTarget: 'both' });
      return { summary: 'Jira submitted.' };
    }
  };

  await executeManualCommand(parseManualCommand('/logwork both'), session, context({
    workflows,
    printed,
    lines: [
      'Monday, 01 Jun 2026',
      '+2 Maintenance mode (SCB-213)',
      '/end'
    ]
  }));

  assert.equal(session.activeTarget, 'both');
  assert.equal(session.previews.ro.status, 'ready');
  assert.equal(session.previews.jira.status, 'ready');
  assert.match(printed.join('\n'), /Resource Optimiser preview/);
  assert.match(printed.join('\n'), /Jira preview/);

  await executeManualCommand(parseManualCommand('/apply both'), session, context({
    workflows,
    prompts: confirmations([true, true]),
    printed
  }));

  assert.deepEqual(calls, ['ro', 'jira']);
  assert.equal(session.previews.ro, null);
  assert.equal(session.previews.jira, null);
});

test('manual logwork draft helpers build text, overrides, and live preview', async () => {
  const task = parseTaskLine('+2 check ui/ux');
  assert.deepEqual(task, {
    hours: 2,
    taskName: 'check ui/ux',
    line: '+2 check ui/ux'
  });

  const draft = addDraftTask({
    draft: {
      date: '2026-06-01',
      project: {
        projectMemberId: 5234,
        projectName: '2621A-SIT-HTML BUILDER-PRJ'
      },
      tasks: []
    },
    line: '+1.5 polish flow'
  });
  assert.equal(draft.tasks[0].hours, 1.5);
  assert.equal(buildLogworkText({
    date: '2026-06-01',
    tasks: [task]
  }), 'Monday, 01 Jun 2026\n+2 check ui/ux');
  assert.deepEqual(buildProjectOverrides({
    date: '2026-06-01',
    tasks: [task],
    projectMemberId: 5234
  }), {
    '2026-06-01-01': 5234
  });
  assert.deepEqual(toggleTaskSelection([], 1), [1]);
  assert.deepEqual(toggleTaskSelection([0, 1], 1), [0]);
  assert.deepEqual(removeDraftTasks([
    { taskName: 'one' },
    { taskName: 'two' },
    { taskName: 'three' }
  ], [0, 2]), [{ taskName: 'two' }]);
  assert.deepEqual(replaceDraftTask([
    { taskName: 'one' },
    { taskName: 'two' }
  ], 1, { taskName: 'replacement' }), [
    { taskName: 'one' },
    { taskName: 'replacement' }
  ]);
  assert.equal(canApplyPreview(readyPreview()).ok, true);
  assert.equal(canApplyPreview({
    errors: [],
    unresolvedEntries: [{ id: 'entry_1' }]
  }).ok, false);
  assert.match(formatDraftPreview({
    date: '2026-06-01',
    project: {
      projectName: '2621A-SIT-HTML BUILDER-PRJ',
      booked: true
    },
    tasks: [task],
    preview: readyPreview()
  }), /Tasks: 1 · Total: 2h/);
  const bothPreviewText = formatDraftPreview({
    target: 'both',
    date: '2026-06-01',
    project: { projectName: 'Course Builder', booked: true },
    tasks: [task],
    preview: readyPreview(),
    previews: {
      ro: readyPreview(),
      jira: {
        status: 'blocked',
        totals: {
          readyCount: 0,
          duplicateCount: 0,
          missingIssueCount: 1,
          multipleIssueCount: 0,
          lookupFailedCount: 0
        },
        entries: [
          {
            reason: 'missing_issue_key',
            worklog: { comment: 'check ui/ux\n\n#lh:12345678' }
          }
        ]
      }
    }
  });
  assert.match(bothPreviewText, /missing ticket 1/);
  assert.match(bothPreviewText, /Both apply is blocked/);
  assert.match(bothPreviewText, /Comment: check ui\/ux \| #lh:12345678/);

  let previewArgs;
  const preview = await previewManualLogworkDraft({
    date: '2026-06-01',
    project: {
      projectMemberId: 5234,
      projectName: '2621A-SIT-HTML BUILDER-PRJ'
    },
    tasks: [task],
    workflows: {
      previewLogworkBatch: async (args) => {
        previewArgs = args;
        return readyPreview();
      }
    },
    print() {}
  });
  assert.equal(preview.status, 'ready');
  assert.match(previewArgs.text, /Monday, 01 Jun 2026/);
  assert.deepEqual(previewArgs.projectOverrides, {
    '2026-06-01-01': 5234
  });
});

test('manual draft persistence saves, updates, lists newest first, deletes, and sanitizes secrets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'logwork-helper-drafts-'));
  const path = join(dir, 'manual-drafts.json');
  const first = await saveManualDraft({
    cwd: '/tmp/repo',
    date: '2026-06-01',
    project: {
      projectMemberId: 5234,
      projectId: 643,
      projectName: '2621A-SIT-HTML BUILDER-PRJ',
      secretToken: 'should-not-save'
    },
    tasks: [
      {
        hours: 2,
        taskName: 'check ui/ux',
        password: 'should-not-save'
      }
    ],
    accessToken: 'should-not-save',
    latestPreviewStatus: 'ready'
  }, { path, cwd: '/tmp/repo' });
  assert.match(first.id, /^draft_/);
  assert.match(formatManualDraftLabel(first), /2026-06-01 · 2621A-SIT-HTML BUILDER-PRJ · 1 task/);

  const second = await saveManualDraft({
    cwd: '/tmp/repo',
    date: '2026-06-02',
    project: {
      projectMemberId: 7777,
      projectName: '2513A-JURONG-VAL-PRJ'
    },
    tasks: [
      {
        hours: 1,
        taskName: 'support'
      }
    ]
  }, { path, cwd: '/tmp/repo' });
  let drafts = await loadManualDrafts({ path });
  assert.deepEqual(drafts.map((draft) => draft.id), [second.id, first.id]);

  const updated = await saveManualDraft({
    id: first.id,
    cwd: '/tmp/repo',
    date: '2026-06-01',
    project: first.project,
    tasks: [
      {
        hours: 3,
        taskName: 'updated task'
      }
    ]
  }, { path, cwd: '/tmp/repo' });
  drafts = await loadManualDrafts({ path });
  assert.equal(drafts[0].id, updated.id);
  assert.equal(drafts[0].tasks[0].taskName, 'updated task');

  const raw = await readFile(path, 'utf8');
  assert.doesNotMatch(raw, /should-not-save|accessToken|password|secretToken/i);

  assert.equal(await deleteManualDraft(second.id, { path }), true);
  drafts = await loadManualDrafts({ path });
  assert.deepEqual(drafts.map((draft) => draft.id), [first.id]);
});

test('manual draft loading can be scoped to the current workspace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'logwork-helper-drafts-'));
  const path = join(dir, 'manual-drafts.json');
  const current = await saveManualDraft({
    cwd: '/tmp/current-repo',
    date: '2026-06-01',
    project: {
      projectMemberId: 5234,
      projectName: '2621A-SIT-HTML BUILDER-PRJ'
    },
    tasks: [
      {
        hours: 2,
        taskName: 'current repo task'
      }
    ]
  }, { path, cwd: '/tmp/current-repo' });
  const other = await saveManualDraft({
    cwd: '/tmp/other-repo',
    date: '2026-06-02',
    project: {
      projectMemberId: 7777,
      projectName: '2513A-JURONG-VAL-PRJ'
    },
    tasks: [
      {
        hours: 1,
        taskName: 'other repo task'
      }
    ]
  }, { path, cwd: '/tmp/other-repo' });

  assert.deepEqual((await loadManualDrafts({ path, cwd: '/tmp/current-repo' })).map((draft) => draft.id), [current.id]);
  assert.deepEqual((await loadManualDrafts({ path, cwd: '/tmp/other-repo' })).map((draft) => draft.id), [other.id]);
  assert.deepEqual(new Set((await loadManualDrafts({ path })).map((draft) => draft.id)), new Set([current.id, other.id]));
});

test('manual projects prints weekly chart and calls project query', async () => {
  const printed = [];
  const session = createManualSession();
  let listCalls = 0;
  let queryArgs;
  const workflows = {
    listLogworkProjects: async () => {
      listCalls += 1;
      return projectList();
    },
    queryLogwork: async (args) => {
      queryArgs = args;
      return weeklyLogwork();
    }
  };

  await executeManualCommand(parseManualCommand('/projects'), session, context({
    workflows,
    printed
  }));

  assert.equal(listCalls, 1);
  assert.equal(queryArgs.period, 'this_week');
  assert.equal(queryArgs.includeEntries, false);
  assert.match(printed.join('\n'), /This week:/);
  assert.match(printed.join('\n'), /2621A-SIT-HTML BUILDER-PRJ/);
  assert.match(printed.join('\n'), /\[████████████████████\] 100%/);
  assert.match(printed.join('\n'), /Mon 8\/8/);
  assert.match(printed.join('\n'), /Other memberships:/);
});

test('manual projects supports filter and overbooked chart', async () => {
  const printed = [];
  const session = createManualSession();
  let queryArgs;
  const workflows = {
    listLogworkProjects: async () => projectList(),
    queryLogwork: async (args) => {
      queryArgs = args;
      return weeklyLogwork({
        projects: [
          {
            projectMemberId: 5234,
            projectId: 643,
            projectName: '2621A-SIT-HTML BUILDER-PRJ',
            bookedHours: 40,
            loggedHours: 43,
            dates: ['2026-06-01']
          }
        ],
        days: [
          {
            date: '2026-06-01',
            projects: [
              {
                projectMemberId: 5234,
                projectId: 643,
                projectName: '2621A-SIT-HTML BUILDER-PRJ',
                bookedHours: 8,
                loggedHours: 9
              }
            ]
          }
        ]
      });
    }
  };

  await executeManualCommand(parseManualCommand('/projects 5234'), session, context({
    workflows,
    printed
  }));

  assert.equal(queryArgs.project, '5234');
  assert.match(printed.join('\n'), /43h logged \/ 40h booked \(\+3h over\)/);
  assert.doesNotMatch(printed.join('\n'), /2513A-JURONG-VAL-PRJ/);
});

test('manual apply blocks when no preview or unresolved entries exist', async () => {
  const printed = [];
  const session = createManualSession();

  await executeManualCommand(parseManualCommand('/apply'), session, context({ printed }));
  assert.match(printed.at(-1), /No preview available/);

  session.previews.ro = {
    entries: [],
    errors: [],
    unresolvedEntries: [{ id: 'entry_1' }],
    unbookedEntries: []
  };
  await executeManualCommand(parseManualCommand('/apply'), session, context({ printed }));
  assert.match(printed.at(-1), /Cannot apply preview with 1 unresolved entries/);
});

test('formatProjects handles no weekly chart for focused project', () => {
  const output = formatProjects(projectList(), {
    projects: [],
    days: []
  }, '2513');

  assert.match(output, /No weekly booking\/logwork chart found for "2513"/);
  assert.match(output, /2513A-JURONG-VAL-PRJ/);
});

test('formatProjectChart handles unbooked logged work', () => {
  const output = formatProjectChart({
    project: {
      projectMemberId: 123,
      projectId: 456,
      projectName: 'Support Project',
      bookedHours: 0,
      loggedHours: 2
    },
    days: [
      {
        date: '2026-06-06',
        bookedHours: 0,
        loggedHours: 2
      }
    ]
  }).join('\n');

  assert.match(output, /2h logged \/ 0h booked/);
  assert.match(output, /\[████████████████████\] unbooked/);
  assert.match(output, /Sat 2\/0/);
});

test('manual apply requires extra confirmation for unbooked entries', async () => {
  const printed = [];
  const session = createManualSession();
  session.previews.ro = readyPreview({
    status: 'ready_with_unbooked',
    unbookedEntries: [{ id: 'entry_1' }]
  });
  let applyCalled = false;
  const prompts = confirmations([true, false]);
  const workflows = {
    applyLogworkBatch: async () => {
      applyCalled = true;
    }
  };

  await executeManualCommand(parseManualCommand('/apply'), session, context({
    workflows,
    prompts,
    printed
  }));

  assert.equal(applyCalled, false);
  assert.match(printed.at(-1), /unbooked entries were not approved/);
});

test('manual apply submits approved preview and clears last preview', async () => {
  const printed = [];
  const session = createManualSession();
  session.previews.ro = readyPreview({
    status: 'ready_with_unbooked',
    unbookedEntries: [{ id: 'entry_1' }]
  });
  const prompts = confirmations([true, true]);
  const workflows = {
    applyLogworkBatch: async ({ batch, confirm, allowUnbooked }) => {
      assert.equal(batch, session.previews.ro);
      assert.equal(confirm, true);
      assert.equal(allowUnbooked, true);
      return {
        summary: 'Logwork submitted.',
        verification: {
          summary: 'Verified totals.'
        }
      };
    }
  };

  await executeManualCommand(parseManualCommand('/apply'), session, context({
    workflows,
    prompts,
    printed
  }));

  assert.equal(session.previews.ro, null);
  assert.match(printed.join('\n'), /Logwork submitted/);
  assert.match(printed.join('\n'), /Verified totals/);
});

test('manual commands run API auth inline when workflow reports auth required', async () => {
  const printed = [];
  const session = createManualSession();
  let queryCalls = 0;
  let loginCalls = 0;
  const workflows = {
    queryLogwork: async () => {
      queryCalls += 1;
      if (queryCalls === 1) {
        throw createAuthRequiredError();
      }
      return {
        summary: 'Authenticated query result.'
      };
    },
    loginResourceOptimiser: async () => {
      loginCalls += 1;
      return {
        summary: 'Authenticated as user 115.'
      };
    }
  };

  await executeManualCommand(parseManualCommand('/query today'), session, context({
    workflows,
    printed
  }));

  assert.equal(queryCalls, 2);
  assert.equal(loginCalls, 1);
  assert.match(printed.join('\n'), /Resource Optimiser authentication required/);
  assert.match(printed.join('\n'), /Authenticated query result/);
  assert.doesNotMatch(printed.join('\n'), /password|otp/i);
});

test('manual map confirms and upserts project mapping', async () => {
  const printed = [];
  const session = createManualSession();
  const prompts = confirmations([true]);
  const workflows = {
    upsertProjectMapping: async (args) => {
      assert.deepEqual(args.tickets, ['SCB']);
      assert.equal(args.projectMemberId, '5234');
      assert.equal(args.confirm, true);
      return {
        summary: 'Created project mapping for 2621A-SIT-HTML BUILDER-PRJ.'
      };
    }
  };

  await executeManualCommand(parseManualCommand('/map SCB 5234'), session, context({
    workflows,
    prompts,
    printed
  }));

  assert.match(printed.at(-1), /Created project mapping/);
});

function context({
  cwd = '/tmp/repo',
  workflows = {},
  prompts = confirmations([]),
  printed = [],
  lines = []
} = {}) {
  const queue = [...lines];
  return {
    cwd,
    workflows: {
      queryLogwork: async () => ({ summary: 'query' }),
      previewLogworkBatch: async () => readyPreview(),
      applyLogworkBatch: async () => ({ summary: 'applied' }),
      previewJiraWorklogBatch: async () => readyJiraPreview(),
      applyJiraWorklogBatch: async () => ({ summary: 'jira applied' }),
      listLogworkProjects: async () => ({ summary: 'projects', projects: [], mappings: [] }),
      upsertProjectMapping: async () => ({ summary: 'mapped' }),
      loginResourceOptimiser: async () => ({ summary: 'auth' }),
      getStoredAuthStatus: async () => ({ summary: 'status' }),
      getStoredJiraStatus: async () => ({ summary: 'jira status' }),
      ...workflows
    },
    prompts,
    print(message = '') {
      printed.push(message);
    },
    async readLine() {
      if (!queue.length) {
        throw new Error('No test input line available.');
      }
      return queue.shift();
    }
  };
}

function confirmations(values) {
  const queue = [...values];
  return {
    async confirm() {
      return queue.length ? queue.shift() : true;
    }
  };
}

function readyPreview(overrides = {}) {
  return {
    batchId: 'batch_1',
    status: 'ready',
    errors: [],
    entries: [
      {
        id: 'entry_1',
        date: '2026-06-01',
        hours: 2,
        taskName: 'Maintenance mode',
        matchedProject: {
          projectMemberId: 5234,
          projectName: '2621A-SIT-HTML BUILDER-PRJ'
        }
      }
    ],
    unresolvedEntries: [],
    unbookedEntries: [],
    summary: 'Logwork preview:\nReady to apply.',
    ...overrides
  };
}

function readyJiraPreview(overrides = {}) {
  return {
    batchId: 'jira_batch_1',
    status: 'ready',
    errors: [],
    entries: [
      {
        id: 'entry_1',
        batchId: 'jira_batch_1',
        date: '2026-06-01',
        hours: 2,
        taskName: 'Maintenance mode (SCB-213)',
        tickets: ['SCB-213'],
        issueKey: 'SCB-213',
        status: 'ready',
        reason: 'single_issue_key'
      }
    ],
    summary: 'Jira worklog preview:\nReady to apply.',
    ...overrides
  };
}

function projectList() {
  return {
    summary: 'Found 2 Resource Optimiser project memberships.',
    projects: [
      {
        projectMemberId: 5234,
        projectId: 643,
        projectName: '2621A-SIT-HTML BUILDER-PRJ'
      },
      {
        projectMemberId: 7777,
        projectId: 2513,
        projectName: '2513A-JURONG-VAL-PRJ'
      }
    ],
    mappings: [
      {
        projectMemberId: 5234,
        projectName: '2621A-SIT-HTML BUILDER-PRJ',
        tickets: ['SCB'],
        keywords: []
      }
    ]
  };
}

function savedDraftFixture() {
  return {
    id: 'draft_1',
    createdAt: '2026-06-08T00:00:00.000Z',
    updatedAt: '2026-06-08T01:00:00.000Z',
    cwd: '/tmp/repo',
    date: '2026-06-08',
    project: {
      projectMemberId: 5234,
      projectId: 643,
      projectName: '2621A-SIT-HTML BUILDER-PRJ'
    },
    tasks: [
      {
        hours: 2,
        taskName: 'check ui/ux'
      }
    ],
    latestPreviewStatus: 'ready'
  };
}

function weeklyLogwork(overrides = {}) {
  return {
    projects: [
      {
        projectMemberId: 5234,
        projectId: 643,
        projectName: '2621A-SIT-HTML BUILDER-PRJ',
        bookedHours: 40,
        loggedHours: 40,
        dates: ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05']
      }
    ],
    days: [
      {
        date: '2026-06-01',
        projects: [
          {
            projectMemberId: 5234,
            projectId: 643,
            projectName: '2621A-SIT-HTML BUILDER-PRJ',
            bookedHours: 8,
            loggedHours: 8
          }
        ]
      }
    ],
    ...overrides
  };
}
