import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSkillArgs, run } from '../commands/skill.mjs';
import { SKILL_PATH, readLogworkSkill } from '../lib/agent-skill.mjs';

test('the agent skill has frontmatter and walks through the commit-based flow', () => {
  const raw = readLogworkSkill({ withFrontmatter: true });
  assert.match(raw, /^---\nname: logwork\ndescription: .+\n---\n/);
  const body = readLogworkSkill();
  assert.doesNotMatch(body, /^---/);
  for (const tool of ['get_logwork', 'draft_from_commits', 'list_tasks', 'log_work', 'map_project', 'edit_entry', 'login']) {
    assert.match(body, new RegExp(tool), tool);
  }
  assert.match(body, /Never invent work/);
  assert.match(body, /\+<hours> <worklog task> \| <description>/);
});

test('logwork skill install writes SKILL.md for each target', async () => {
  const written = [];
  const printed = [];
  await run(['install'], {
    home: '/home/me',
    print: (line) => printed.push(line),
    mkdirFn: async () => {},
    writeFileFn: async (path, content) => written.push([path, content])
  });
  assert.deepEqual(written.map(([path]) => path), [
    join('/home/me', '.claude', 'skills', 'logwork', 'SKILL.md'),
    join('/home/me', '.codex', 'skills', 'logwork', 'SKILL.md')
  ]);
  assert.match(written[0][1], /^---\nname: logwork/);
  assert.match(printed.join('\n'), /log_from_commits/);

  assert.deepEqual(parseSkillArgs(['install', '--target', 'claude']).targets, ['claude']);
  assert.throws(() => parseSkillArgs(['install', '--target', 'cursor']), /Unknown skill target/);
  assert.throws(() => parseSkillArgs(['remove']), /Usage: logwork skill/);
});

test('readLogworkSkill strips frontmatter even when the file has CRLF line endings', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = join(mkdtempSync(join(tmpdir(), 'logwork-skill-crlf-')), 'SKILL.md');
  writeFileSync(path, readFileSync(SKILL_PATH, 'utf8').replace(/\r?\n/g, '\r\n'));

  const body = readLogworkSkill({ path });
  assert.match(body, /^# Logwork from commits\n/);
  assert.doesNotMatch(body, /\r|^---|name: logwork/);
  assert.match(readLogworkSkill({ path, withFrontmatter: true }), /^---\nname: logwork\n/);
});
