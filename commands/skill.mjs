import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { SKILL_NAME, readLogworkSkill } from '../lib/agent-skill.mjs';

// `logwork skill`            print the agent skill (SKILL.md)
// `logwork skill install`    copy it to ~/.claude/skills and ~/.codex/skills
export const SKILL_TARGETS = Object.freeze({
  claude: (home) => join(home, '.claude', 'skills', SKILL_NAME, 'SKILL.md'),
  codex: (home) => join(home, '.codex', 'skills', SKILL_NAME, 'SKILL.md')
});

export function parseSkillArgs(args = []) {
  const options = { action: 'print', targets: [], dir: undefined, help: false };
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--target' || arg === '--dir') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${arg} requires a value.`);
      }
      if (arg === '--dir') {
        options.dir = value;
      } else {
        options.targets.push(...value.split(','));
      }
      index += 1;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown skill option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1 || (positional[0] && !['print', 'install'].includes(positional[0]))) {
    throw new Error('Usage: logwork skill [print|install] [--target claude|codex|all] [--dir <path>]');
  }
  options.action = positional[0] || 'print';
  const targets = options.targets.length ? options.targets : ['all'];
  options.targets = targets.includes('all') ? Object.keys(SKILL_TARGETS) : targets;
  for (const target of options.targets) {
    if (!SKILL_TARGETS[target]) {
      throw new Error(`Unknown skill target: ${target}. Use claude, codex or all.`);
    }
  }
  return options;
}

export async function run(args = [], {
  home = homedir(),
  print = console.log,
  mkdirFn = mkdir,
  writeFileFn = writeFile
} = {}) {
  const options = parseSkillArgs(args);
  if (options.help) {
    print(formatSkillHelp());
    return 0;
  }
  const content = `${readLogworkSkill({ withFrontmatter: true }).trim()}\n`;
  if (options.action === 'print') {
    print(content);
    return 0;
  }
  const paths = options.dir
    ? [join(resolve(options.dir), SKILL_NAME, 'SKILL.md')]
    : options.targets.map((target) => SKILL_TARGETS[target](home));
  for (const path of paths) {
    await mkdirFn(join(path, '..'), { recursive: true });
    await writeFileFn(path, content, 'utf8');
    print(`Installed the logwork skill: ${path}`);
  }
  print('Restart the agent so it picks up the skill. The same procedure is served as the MCP prompt "log_from_commits".');
  return 0;
}

export function formatSkillHelp() {
  return `Usage:
  logwork skill                        Print the agent skill (SKILL.md)
  logwork skill install                Install it for Claude Code and Codex
  logwork skill install --target claude|codex|all
  logwork skill install --dir <path>   Install under <path>/logwork/SKILL.md
                                       (for example a repo's .claude/skills)

The skill tells an AI agent how to log accurate work from your git commits:
get_logwork -> draft_from_commits -> list_tasks -> review with you -> log_work.
Other agents (Cursor, Copilot) can use the MCP prompt "log_from_commits", or
paste \`logwork skill\` output into their rules.`;
}
