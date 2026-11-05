import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withFileLock } from '../lib/file-lock.mjs';
import { configPath, upsertProjectMappingConfig } from '../lib/logwork-config.mjs';
import {
  loadManualDrafts,
  saveManualDraft
} from '../lib/manual-drafts.mjs';

test('saveManualDraft waits for the draft file lock before writing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'logwork-draft-lock-'));
  const path = join(dir, 'manual-drafts.json');
  let saveSettled = false;
  let pendingSave;

  await withFileLock(path, async () => {
    pendingSave = saveManualDraft({
      cwd: '/tmp/repo',
      date: '2026-06-01',
      project: {
        projectMemberId: 5234,
        projectName: 'Course Builder'
      },
      tasks: [
        {
          hours: 2,
          taskName: 'check lock behavior'
        }
      ]
    }, {
      path,
      cwd: '/tmp/repo',
      lockOptions: {
        retryDelayMs: 1,
        timeoutMs: 1_000
      }
    });
    pendingSave.then(() => {
      saveSettled = true;
    }, () => {
      saveSettled = true;
    });

    await delay(30);
    assert.equal(saveSettled, false);
  });

  const saved = await pendingSave;
  const drafts = await loadManualDrafts({ path });
  assert.equal(saveSettled, true);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].id, saved.id);
});

test('upsertProjectMappingConfig waits for the config file lock before writing', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logwork-config-lock-'));
  const path = configPath(cwd, 'project');
  let upsertSettled = false;
  let pendingUpsert;

  await withFileLock(path, async () => {
    pendingUpsert = upsertProjectMappingConfig({
      cwd,
      scope: 'project',
      project: {
        projectMemberId: 5234,
        projectName: 'Course Builder'
      },
      tickets: ['SCB'],
      keywords: ['support'],
      lockOptions: {
        retryDelayMs: 1,
        timeoutMs: 1_000
      }
    });
    pendingUpsert.then(() => {
      upsertSettled = true;
    }, () => {
      upsertSettled = true;
    });

    await delay(30);
    assert.equal(upsertSettled, false);
  });

  const result = await pendingUpsert;
  const file = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(upsertSettled, true);
  assert.equal(result.created, true);
  assert.deepEqual(file.projectMappings, [
    {
      projectName: 'Course Builder',
      projectMemberId: 5234,
      tickets: ['SCB'],
      keywords: ['support']
    }
  ]);
});
