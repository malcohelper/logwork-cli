import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// skills/logwork/SKILL.md is the single source for the agent procedure: it is
// shipped as an installable skill (`logwork skill install`) and served as the
// MCP prompt log_from_commits.
export const SKILL_NAME = 'logwork';
export const SKILL_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'skills', SKILL_NAME, 'SKILL.md');

export function readLogworkSkill({ withFrontmatter = false } = {}) {
  const text = readFileSync(SKILL_PATH, 'utf8');
  return withFrontmatter ? text : text.replace(/^---\n[\s\S]*?\n---\n+/, '').trim();
}
