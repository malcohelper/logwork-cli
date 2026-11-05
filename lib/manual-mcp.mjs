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

export function defaultMcpServerPath() {
  return join(helperHome(), 'mcp-server.mjs');
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
  platform = process.platform
} = {}) {
  const resolvedClient = typeof client === 'object' ? client : resolveMcpClient(client);
  if (!resolvedClient) {
    throw new Error('Unknown MCP client. Use: cursor, antigravity, copilot, claude-code, or codex.');
  }

  const lines = [
    `MCP setup: ${resolvedClient.label}`,
    `Server path: ${serverPath}`,
    ''
  ];

  if (resolvedClient.key === 'codex') {
    lines.push(
      `Copy this TOML into ${resolvedClient.target}:`,
      '',
      formatCodexToml(serverPath)
    );
  } else if (resolvedClient.key === 'copilot') {
    lines.push(
      `Copy this JSON into ${resolvedClient.target}:`,
      '',
      JSON.stringify(vscodeMcpConfig(serverPath), null, 2)
    );
  } else if (resolvedClient.key === 'claude-code') {
    lines.push(
      'Recommended command:',
      '',
      `claude mcp add --transport stdio logwork-helper -- node ${quoteShellArg(serverPath, { platform })}`,
      '',
      'Or copy this JSON into project .mcp.json:',
      '',
      JSON.stringify(stdioMcpServersConfig(serverPath), null, 2)
    );
  } else {
    lines.push(
      `Copy this JSON into ${resolvedClient.target}:`,
      '',
      JSON.stringify(stdioMcpServersConfig(serverPath), null, 2)
    );
  }

  lines.push(
    '',
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

function stdioMcpServersConfig(serverPath) {
  return {
    mcpServers: {
      'logwork-helper': {
        command: 'node',
        args: [serverPath]
      }
    }
  };
}

function vscodeMcpConfig(serverPath) {
  return {
    servers: {
      logworkHelper: {
        type: 'stdio',
        command: 'node',
        args: [serverPath]
      }
    }
  };
}

function formatCodexToml(serverPath) {
  return [
    '[mcp_servers.logwork-helper]',
    'command = "node"',
    `args = ["${escapeTomlString(serverPath)}"]`,
    'startup_timeout_sec = 20',
    'tool_timeout_sec = 120'
  ].join('\n');
}

function escapeTomlString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function quoteShellArg(value, { platform = process.platform } = {}) {
  if (platform === 'win32') {
    return `'${String(value).replaceAll("'", "''")}'`;
  }
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
