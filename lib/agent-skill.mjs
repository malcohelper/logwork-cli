import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// skills/logwork/SKILL.md is the single source for the agent procedure: it is
// shipped as an installable skill (`logwork skill install`) and served as the
// MCP prompt log_from_commits.
export const SKILL_NAME = 'logwork';
export const SKILL_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'skills', SKILL_NAME, 'SKILL.md');

export function readLogworkSkill({ withFrontmatter = false, path = SKILL_PATH } = {}) {
  // Normalise CRLF (Windows git checkouts) so the frontmatter strip and the
  // installed copies are identical on every platform.
  const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  return withFrontmatter ? text : text.replace(/^---\n[\s\S]*?\n---\n+/, '').trim();
}
