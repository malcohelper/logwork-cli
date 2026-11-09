import { join } from 'node:path';
import { mcpArgs, resolveLaunchCommand } from './launcher.mjs';
import { helperHome } from './paths.mjs';

export const MCP_CLIENTS = [
  {
    key: 'cursor',
    label: 'Cursor',
    aliases: ['cursor'],
    target: 'Cursor MCP settings',
    format: 'JSON'
  },
  {
    key: 'antigravity',
    label: 'Google Antigravity',
    aliases: ['antigravity', 'google-antigravity'],
    target: '~/.gemini/antigravity/mcp_config.json',
    format: 'JSON'
  },
  {
    key: 'copilot',
    label: 'GitHub Copilot / VS Code',
    aliases: ['copilot', 'github-copilot', 'vscode', 'vs-code'],
    target: 'workspace .vscode/mcp.json or VS Code user MCP config',
    format: 'JSON'
  },
  {
    key: 'claude-code',
    label: 'Claude Code',
    aliases: ['claude', 'claude-code'],
    target: 'claude mcp add or project .mcp.json',
    format: 'CLI or JSON'
  },
  {
    key: 'codex',
    label: 'Codex',
    aliases: ['codex'],
    target: '~/.codex/config.toml or project .codex/config.toml',
    format: 'TOML'
  }
];

// IDE configs run the launch command from lib/launcher.mjs: on macOS/Linux
// the generated <home>/bin/logwork-launch script (it finds a usable Node 22+
// at start time), on Windows a stable node.exe plus <home>\bin\logwork.mjs.
// Both are absolute because GUI IDEs (Cursor, VS Code started from the Dock or
// Finder) often start without the npm global bin directory or nvm's node on
// PATH, so neither `logwork` nor a bare `node` would be found.
export const MCP_SERVER_NAME = 'logwork';

// Only printed when the command is a raw Node path that an upgrade can remove.
export const MCP_NODE_PATH_NOTE = 'The config uses the absolute path of the Node that ran this command. If Node is upgraded or moved (nvm, Homebrew, a new installer), re-run `logwork setup` (it updates the config for you).';

export const MCP_LAUNCHER_NOTE = 'The command is the logwork launcher; it finds Node 22+ itself, so Node upgrades need no config change.';

const INSTALL_CLIENT_KEYS = {
  cursor: 'cursor',
  antigravity: 'antigravity',
  copilot: 'vscode',
  'claude-code': 'claude',
  codex: 'codex'
};

export function defaultMcpServerPath() {
  return join(helperHome(), 'bin', 'logwork.mjs');
}

// Accepts a launch command ({ command, argsPrefix }) or, for older callers, an
// entry path plus { nodePath }: a raw `<node> <entry>` command.
export function toLaunchCommand(launchOrServerPath, { nodePath } = {}) {
  if (launchOrServerPath && typeof launchOrServerPath === 'object') {
    return launchOrServerPath;
  }
  if (launchOrServerPath === undefined && nodePath === undefined) {
    return resolveLaunchCommand();
  }
  return {
    command: nodePath || process.execPath,
    argsPrefix: [launchOrServerPath || defaultMcpServerPath()],
    kind: 'node',
    stable: false
  };
}

export function resolveMcpClient(value) {
  const normalized = normalizeMcpClientValue(value);
  if (!normalized) {
    return null;
  }

  return MCP_CLIENTS.find((client) => (
    client.key === normalized ||
    client.aliases.includes(normalized)
  )) || null;
}

export function resolveMcpClientSelection(value) {
  const trimmed = String(value || '').trim();
  const numeric = Number(trimmed);
  if (/^\d+$/.test(trimmed) && Number.isInteger(numeric)) {
    return MCP_CLIENTS[numeric - 1] || null;
  }
  return resolveMcpClient(trimmed);
}

export function formatMcpClientOptions(clients = MCP_CLIENTS) {
  return [
    'Choose MCP client:',
    ...clients.map((client, index) => (
      `  ${index + 1}. ${client.label} - ${client.target}`
    )),
    '',
    'Type a number or name, for example: cursor, antigravity, copilot, claude-code, codex.'
  ].join('\n');
}

export function formatMcpSetup({
  client,
  launch,
  serverPath,
  nodePath,
  platform = process.platform
} = {}) {
  const resolvedClient = typeof client === 'object' ? client : resolveMcpClient(client);
  if (!resolvedClient) {
    throw new Error('Unknown MCP client. Use: cursor, antigravity, copilot, claude-code, or codex.');
  }
  const command = launch || (serverPath === undefined && nodePath === undefined
    ? resolveLaunchCommand({ platform })
    : toLaunchCommand(serverPath, { nodePath }));

  const lines = [
    `MCP setup: ${resolvedClient.label}`,
    `Command: ${[command.command, ...mcpArgs(command)].join(' ')}`,
    ''
  ];

  if (resolvedClient.key === 'codex') {
    lines.push(
      `Copy this TOML into ${resolvedClient.target}:`,
      '',
      formatCodexToml(command)
    );
  } else if (resolvedClient.key === 'copilot') {
    lines.push(
      `Copy this JSON into ${resolvedClient.target}:`,
      '',
      JSON.stringify(vscodeMcpConfig(command), null, 2)
    );
  } else if (resolvedClient.key === 'claude-code') {
    lines.push(
      'Recommended command:',
      '',
      formatClaudeMcpAddCommand(command, { platform }),
      '',
      'Or copy this JSON into project .mcp.json:',
      '',
      JSON.stringify(stdioMcpServersConfig(command), null, 2)
    );
  } else {
    lines.push(
      `Copy this JSON into ${resolvedClient.target}:`,
      '',
      JSON.stringify(stdioMcpServersConfig(command), null, 2)
    );
  }

  const installKey = INSTALL_CLIENT_KEYS[resolvedClient.key];
  const note = command.stable ? (command.kind === 'launcher' ? MCP_LAUNCHER_NOTE : '') : MCP_NODE_PATH_NOTE;
  lines.push(
    '',
    ...(note ? [note] : []),
    ...(installKey ? [`To let logwork write it for you instead, run: logwork mcp install --client ${installKey}`] : []),
    'After saving, restart or reload the MCP client.',
    'Do not paste passwords, 2FA codes, Bearer tokens, cookies, or raw auth logs into AI chat.'
  );

  return lines.join('\n');
}

function normalizeMcpClientValue(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
}

export function stdioMcpServersConfig(launchOrServerPath, options = {}) {
  const launch = toLaunchCommand(launchOrServerPath, options);
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command: launch.command,
        args: mcpArgs(launch)
      }
    }
  };
}

export function vscodeMcpConfig(launchOrServerPath, options = {}) {
  const launch = toLaunchCommand(launchOrServerPath, options);
  return {
    servers: {
      [MCP_SERVER_NAME]: {
        type: 'stdio',
        command: launch.command,
        args: mcpArgs(launch)
      }
    }
  };
}

export function formatCodexToml(launchOrServerPath, options = {}) {
  const launch = toLaunchCommand(launchOrServerPath, options);
  return [
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    `command = "${escapeTomlString(launch.command)}"`,
    `args = [${mcpArgs(launch).map((arg) => `"${escapeTomlString(arg)}"`).join(', ')}]`,
    'startup_timeout_sec = 20',
    'tool_timeout_sec = 120'
  ].join('\n');
}

// User scope, so the server is available in every project.
export function formatClaudeMcpAddCommand(launchOrServerPath, { platform = process.platform, ...options } = {}) {
  const launch = toLaunchCommand(launchOrServerPath, options);
  return `claude mcp add --transport stdio --scope user ${MCP_SERVER_NAME} -- ${[launch.command, ...mcpArgs(launch)].map((arg) => (arg === 'mcp' ? arg : quoteShellArg(arg, { platform }))).join(' ')}`;
}

// TOML basic string: escape backslashes (Windows paths), quotes and control
// characters.
function escapeTomlString(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    // eslint-disable-next-line no-control-regex -- TOML needs control characters escaped.
    .replace(/[\u0000-\u001f\u007f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function quoteShellArg(value, { platform = process.platform } = {}) {
  if (platform === 'win32') {
    return `'${String(value).replaceAll("'", "''")}'`;
  }
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
