import { join } from 'node:path';
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

// IDE configs run `<absolute node> <runtime>/bin/logwork.mjs mcp`. Both paths
// are absolute because GUI IDEs (Cursor, VS Code started from the Dock or
// Finder) often start without the npm global bin directory or nvm's node on
// PATH, so neither `logwork` nor a bare `node` would be found.
export const MCP_SERVER_NAME = 'logwork';

export const MCP_NODE_PATH_NOTE = 'The config uses the absolute path of the Node that ran this command. If Node is upgraded or moved (nvm, Homebrew, a new installer), re-run `logwork setup` and paste the new config.';

export function defaultMcpServerPath() {
  return join(helperHome(), 'bin', 'logwork.mjs');
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
  serverPath = defaultMcpServerPath(),
  nodePath = process.execPath,
  platform = process.platform
} = {}) {
  const resolvedClient = typeof client === 'object' ? client : resolveMcpClient(client);
  if (!resolvedClient) {
    throw new Error('Unknown MCP client. Use: cursor, antigravity, copilot, claude-code, or codex.');
  }

  const lines = [
    `MCP setup: ${resolvedClient.label}`,
    `Node: ${nodePath}`,
    `Entry path: ${serverPath} (run with the "mcp" argument)`,
    ''
  ];

  if (resolvedClient.key === 'codex') {
    lines.push(
      `Copy this TOML into ${resolvedClient.target}:`,
      '',
      formatCodexToml(serverPath, { nodePath })
    );
  } else if (resolvedClient.key === 'copilot') {
    lines.push(
      `Copy this JSON into ${resolvedClient.target}:`,
      '',
      JSON.stringify(vscodeMcpConfig(serverPath, { nodePath }), null, 2)
    );
  } else if (resolvedClient.key === 'claude-code') {
    lines.push(
      'Recommended command:',
      '',
      `claude mcp add --transport stdio ${MCP_SERVER_NAME} -- ${quoteShellArg(nodePath, { platform })} ${quoteShellArg(serverPath, { platform })} mcp`,
      '',
      'Or copy this JSON into project .mcp.json:',
      '',
      JSON.stringify(stdioMcpServersConfig(serverPath, { nodePath }), null, 2)
    );
  } else {
    lines.push(
      `Copy this JSON into ${resolvedClient.target}:`,
      '',
      JSON.stringify(stdioMcpServersConfig(serverPath, { nodePath }), null, 2)
    );
  }

  lines.push(
    '',
    MCP_NODE_PATH_NOTE,
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

export function stdioMcpServersConfig(serverPath, { nodePath = process.execPath } = {}) {
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command: nodePath,
        args: [serverPath, 'mcp']
      }
    }
  };
}

export function vscodeMcpConfig(serverPath, { nodePath = process.execPath } = {}) {
  return {
    servers: {
      [MCP_SERVER_NAME]: {
        type: 'stdio',
        command: nodePath,
        args: [serverPath, 'mcp']
      }
    }
  };
}

export function formatCodexToml(serverPath, { nodePath = process.execPath } = {}) {
  return [
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    `command = "${escapeTomlString(nodePath)}"`,
    `args = ["${escapeTomlString(serverPath)}", "mcp"]`,
    'startup_timeout_sec = 20',
    'tool_timeout_sec = 120'
  ].join('\n');
}

// TOML basic string: escape backslashes (Windows paths), quotes and control
// characters.
function escapeTomlString(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\u0000-\u001f\u007f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function quoteShellArg(value, { platform = process.platform } = {}) {
  if (platform === 'win32') {
    return `'${String(value).replaceAll("'", "''")}'`;
  }
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
