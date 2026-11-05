export const MANUAL_COMMANDS = [
  {
    name: '/help',
    description: 'Show this help',
    usage: '/help',
    aliases: []
  },
  {
    name: '/auth',
    description: 'Authenticate Resource Optimiser or show Jira login command',
    usage: '/auth [ro|jira]',
    aliases: []
  },
  {
    name: '/status',
    description: 'Show Resource Optimiser and Jira auth status',
    usage: '/status [ro|jira]',
    aliases: []
  },
  {
    name: '/diagnostics',
    description: 'Write a sanitized support report',
    usage: '/diagnostics',
    aliases: []
  },
  {
    name: '/history',
    description: 'Show recent RO/Jira apply results',
    usage: '/history [ro|jira|both]',
    aliases: []
  },
  {
    name: '/query',
    description: 'Query logwork by preset period',
    usage: '/query today | yesterday | this-week | last-week | this-month | last-month',
    aliases: []
  },
  {
    name: '/reconcile',
    description: 'Compare Resource Optimiser and Jira worklogs',
    usage: '/reconcile [today|yesterday|this-week|last-week|this-month|last-month]',
    aliases: []
  },
  {
    name: '/logwork',
    description: 'Create Resource Optimiser, Jira, or combined logwork',
    usage: '/logwork [ro|jira|both]',
    aliases: []
  },
  {
    name: '/mcp',
    description: 'Show copy-ready MCP setup for an IDE',
    usage: '/mcp [cursor|antigravity|copilot|claude-code|codex]',
    aliases: []
  },
  {
    name: '/edit-logwork',
    description: 'Edit hours or task name on existing RO logwork',
    usage: '/edit-logwork <id> --hours <h> [--task-name <text>]',
    aliases: []
  },
  {
    name: '/apply',
    description: 'Apply the last preview after confirmation',
    usage: '/apply',
    aliases: [],
    hidden: true
  },
  {
    name: '/projects',
    description: 'List projects with weekly booked/logged chart',
    usage: '/projects [projectMemberId|projectId|name]',
    aliases: []
  },
  {
    name: '/map',
    description: 'Map ticket prefix to projectMemberId',
    usage: '/map SCB 5234',
    aliases: []
  }
];

export const TASK_COMMANDS = [
  {
    name: '/save',
    description: 'Save this draft locally',
    usage: '/save',
    aliases: []
  },
  {
    name: '/drafts',
    description: 'Resume or delete saved drafts',
    usage: '/drafts',
    aliases: []
  },
  {
    name: '/diagnostics',
    description: 'Write a sanitized support report',
    usage: '/diagnostics',
    aliases: []
  },
  {
    name: '/remove',
    description: 'Select tasks to delete',
    usage: '/remove',
    aliases: []
  },
  {
    name: '/edit',
    description: 'Select one task and replace it',
    usage: '/edit',
    aliases: []
  },
  {
    name: '/clear',
    description: 'Clear current task list',
    usage: '/clear',
    aliases: []
  },
  {
    name: '/back',
    description: 'Return to project picker',
    usage: '/back',
    aliases: []
  },
  {
    name: '/cancel',
    description: 'Discard this logwork session',
    usage: '/cancel',
    aliases: ['/discard']
  }
];

export const QUERY_PERIOD_COMMANDS = [
  {
    name: '/query today',
    description: 'Query today',
    aliases: []
  },
  {
    name: '/query yesterday',
    description: 'Query yesterday',
    aliases: []
  },
  {
    name: '/query this-week',
    description: 'Query this week',
    aliases: []
  },
  {
    name: '/query last-week',
    description: 'Query last week',
    aliases: []
  },
  {
    name: '/query this-month',
    description: 'Query this month',
    aliases: []
  },
  {
    name: '/query last-month',
    description: 'Query last month',
    aliases: []
  }
];

export const RECONCILE_PERIOD_COMMANDS = QUERY_PERIOD_COMMANDS.map((command) => ({
  ...command,
  name: command.name.replace('/query', '/reconcile'),
  description: command.description.replace('Query', 'Reconcile')
}));

export const LOGWORK_TARGET_COMMANDS = [
  {
    name: '/logwork ro',
    description: 'Create Resource Optimiser logwork',
    aliases: []
  },
  {
    name: '/logwork jira',
    description: 'Create Jira worklogs',
    aliases: []
  },
  {
    name: '/logwork both',
    description: 'Create RO and Jira previews',
    aliases: []
  }
];

export const COMMAND_SUGGESTION_LIMIT = 9;

export function formatManualHelp(commands = MANUAL_COMMANDS) {
  const visibleCommands = commands.filter((command) => command.hidden !== true);
  return [
    'Commands:',
    ...visibleCommands.map((command) => `  ${command.usage.padEnd(36)} ${command.description}`)
  ].join('\n');
}

export function findManualCommand(name, commands = MANUAL_COMMANDS) {
  const normalized = String(name || '').toLowerCase();
  return commands.find((command) => (
    command.name === normalized ||
    command.aliases.includes(normalized)
  ));
}

export function getCommandSuggestions(buffer, commands = MANUAL_COMMANDS) {
  const value = String(buffer || '');
  if (!value.startsWith('/')) {
    return [];
  }

  const queryPeriodSuggestions = getQueryPeriodSuggestions(value, commands);
  if (queryPeriodSuggestions.length) {
    return queryPeriodSuggestions;
  }

  const reconciliationPeriodSuggestions = getReconciliationPeriodSuggestions(value, commands);
  if (reconciliationPeriodSuggestions.length) {
    return reconciliationPeriodSuggestions;
  }

  const logworkTargetSuggestions = getLogworkTargetSuggestions(value, commands);
  if (logworkTargetSuggestions.length) {
    return logworkTargetSuggestions;
  }

  if (/^\S+\s/.test(value)) {
    return [];
  }

  const commandPart = value.split(/\s+/, 1)[0].toLowerCase();
  if (!commandPart) {
    return [];
  }

  return commands.filter((command) => command.hidden !== true && command.name.startsWith(commandPart));
}

function getQueryPeriodSuggestions(value, commands) {
  if (commands !== MANUAL_COMMANDS) {
    return [];
  }

  const normalized = value.toLowerCase();
  if (normalized !== '/query' && !normalized.startsWith('/query ')) {
    return [];
  }

  return QUERY_PERIOD_COMMANDS.filter((command) => command.name.startsWith(normalized));
}

function getReconciliationPeriodSuggestions(value, commands) {
  if (commands !== MANUAL_COMMANDS) {
    return [];
  }

  const normalized = value.toLowerCase();
  if (normalized !== '/reconcile' && !normalized.startsWith('/reconcile ')) {
    return [];
  }

  return RECONCILE_PERIOD_COMMANDS.filter((command) => command.name.startsWith(normalized));
}

function getLogworkTargetSuggestions(value, commands) {
  if (commands !== MANUAL_COMMANDS) {
    return [];
  }

  const normalized = value.toLowerCase();
  if (!normalized.startsWith('/logwork ')) {
    return [];
  }

  return LOGWORK_TARGET_COMMANDS.filter((command) => command.name.startsWith(normalized));
}

export function renderCommandSuggestions(buffer, selectedIndex = 0, commands = MANUAL_COMMANDS) {
  const suggestions = getCommandSuggestions(buffer, commands);
  if (!suggestions.length) {
    return '';
  }

  return suggestions
    .slice(0, COMMAND_SUGGESTION_LIMIT)
    .map((command, index) => {
      const marker = index === selectedIndex ? '›' : ' ';
      return `${marker} ${command.name.padEnd(12)} ${command.description}`;
    })
    .join('\n');
}
