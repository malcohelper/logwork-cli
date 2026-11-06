import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { runRoEditCommand } from '../commands/edit.mjs';
import { parseRoEditArgs } from '../lib/ro-edit-args.mjs';

test('RO edit CLI parses hours and multi-word task name', () => {
  assert.deepEqual(parseRoEditArgs([
    '290364',
    '--hours', '0.5',
    '--task-name', 'Hide', 'View', 'history',
    '--yes'
  ]), {
    logworkId: '290364',
    hours: 0.5,
    taskName: 'Hide View history',
    description: undefined,
    typeOfWork: undefined,
    yes: true,
    json: false,
    help: false
  });
  assert.deepEqual(parseRoEditArgs(['290364', '--logtimes=1.25']), {
    logworkId: '290364',
    hours: 1.25,
    taskName: undefined,
    description: undefined,
    typeOfWork: undefined,
    yes: false,
    json: false,
    help: false
  });
  assert.deepEqual(parseRoEditArgs([
    '304032',
    '--task', '#74',
    '--description', 'Fix', 'date', 'picker', '(SAP-42)',
    '--type=correct'
  ]), {
    logworkId: '304032',
    hours: undefined,
    taskName: '#74',
    description: 'Fix date picker (SAP-42)',
    typeOfWork: 'correct',
    yes: false,
    json: false,
    help: false
  });
  assert.throws(() => parseRoEditArgs(['290364']), /requires at least one of --hours, --task, --desc, --type/);
  assert.throws(() => parseRoEditArgs(['290364', '--type', 'fix']), /must be one of/);
  assert.throws(() => parseRoEditArgs(['290364', '--hours', '0']), /positive number/);
});

test('RO edit CLI previews, confirms, and applies approved edit', async () => {
  const printed = [];
  let applied;
  const preview = createPreview();
  const result = await runRoEditCommand(['290364', '--hours', '0.5'], {
    preview: async (input) => {
      assert.deepEqual(input, {
        logworkId: '290364',
        hours: 0.5,
        taskName: undefined,
        description: undefined,
        typeOfWork: undefined
      });
      return preview;
    },
    apply: async (input) => {
      applied = input;
      return {
        status: 'updated',
        summary: 'Updated RO logwork 290364.'
      };
    },
    promptConfirm: async () => true,
    isTTY: true,
    print: (line) => printed.push(line)
  });

  assert.deepEqual(applied, {
    preview,
    confirm: true
  });
  assert.equal(result.status, 'updated');
  assert.deepEqual(printed, [preview.summary, 'Updated RO logwork 290364.']);
});

test('RO edit CLI requires explicit non-interactive approval and structured mode uses one JSON result', async () => {
  const preview = createPreview();
  await assert.rejects(() => runRoEditCommand(['290364', '--hours', '0.5'], {
    preview: async () => preview,
    isTTY: false,
    print: () => {}
  }), /Re-run with --yes/);

  const printed = [];
  await runRoEditCommand(['290364', '--hours', '0.5', '--yes', '--json'], {
    preview: async () => preview,
    apply: async () => ({ status: 'updated', summary: 'done' }),
    isTTY: false,
    print: (line) => printed.push(line)
  });
  assert.equal(printed.length, 1);
  assert.equal(JSON.parse(printed[0]).status, 'updated');
});

test('main CLI exposes Resource Optimiser edit help', () => {
  const result = spawnSync(process.execPath, ['bin/logwork.mjs', 'edit', '--help'], {
    cwd: process.cwd(),
    encoding: 'utf8'
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /logwork edit <id>/);
  assert.match(result.stdout, /Project and date are preserved/);
  assert.match(result.stdout, /--desc <text>/);
  assert.match(result.stdout, /replaces the entry/);
});

function createPreview() {
  return {
    previewId: 'ro_edit_safe',
    status: 'ready',
    logworkId: 290364,
    original: {
      id: 290364,
      projectMemberId: 5234,
      date: '2026-07-15',
      hours: 1,
      taskName: 'Original task'
    },
    updated: {
      id: 290364,
      projectMemberId: 5234,
      date: '2026-07-15',
      hours: 0.5,
      taskName: 'Original task'
    },
    changes: {
      hours: { from: 1, to: 0.5 },
      taskName: null
    },
    originalFingerprint: 'revision',
    summary: 'RO logwork edit is ready.'
  };
}
