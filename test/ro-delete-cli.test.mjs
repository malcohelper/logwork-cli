import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { runRoDeleteCommand } from '../delete-logwork-cli.mjs';
import { parseRoDeleteArgs } from '../lib/ro-delete-args.mjs';

test('RO delete CLI parses logwork id and flags', () => {
  assert.deepEqual(parseRoDeleteArgs(['290364', '--yes', '--json']), {
    logworkId: '290364',
    yes: true,
    json: true,
    help: false
  });
  assert.throws(() => parseRoDeleteArgs([]), /exactly one logwork id/);
});

test('RO delete CLI previews, confirms, and applies', async () => {
  const printed = [];
  let applied;
  const preview = createPreview();
  const result = await runRoDeleteCommand(['290364'], {
    preview: async (input) => {
      assert.deepEqual(input, { logworkId: '290364' });
      return preview;
    },
    apply: async (input) => {
      applied = input;
      return { status: 'deleted', summary: 'Deleted RO logwork entry 290364.' };
    },
    promptConfirm: async () => true,
    isTTY: true,
    print: (line) => printed.push(line)
  });

  assert.deepEqual(applied, { preview, confirm: true });
  assert.equal(result.status, 'deleted');
  assert.deepEqual(printed, [preview.summary, 'Deleted RO logwork entry 290364.']);
});

test('RO delete CLI requires --yes in non-interactive mode', async () => {
  const preview = createPreview();
  await assert.rejects(() => runRoDeleteCommand(['290364'], {
    preview: async () => preview,
    isTTY: false,
    print: () => {}
  }), /Re-run with --yes/);
});

test('main CLI exposes Resource Optimiser delete help', () => {
  const result = spawnSync(process.execPath, ['cli.mjs', 'delete', '--help'], {
    cwd: process.cwd(),
    encoding: 'utf8'
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /logwork-helper delete <logwork-id>/);
  assert.match(result.stdout, /submitted or approved/);
});

function createPreview() {
  return {
    previewId: 'delete_290364',
    status: 'ready',
    logworkId: 290364,
    original: { id: 290364, status: 'approved', hours: 2, taskName: 'Task' },
    originalFingerprint: '{"id":290364,"hours":2,"status":"approved","taskName":"Task"}',
    summary: 'RO logwork delete preview:\n- Entry: 290364'
  };
}
