import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWeeklyLogText } from '../lib/batch-parser.mjs';

test('parseWeeklyLogText parses multiple days and tickets', () => {
  const parsed = parseWeeklyLogText(`Monday, 01 Jun 2026
+2 Maintenance mode management and status UI (SCB-213, SCB-227)
+1 System page updates
Tuesday, 02 Jun 2026
+2.5 Password reset validation (SCB-228)`);

  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.entries.length, 3);
  assert.deepEqual(parsed.entries.map((entry) => entry.date), [
    '2026-06-01',
    '2026-06-01',
    '2026-06-02'
  ]);
  assert.equal(parsed.entries[0].hours, 2);
  assert.deepEqual(parsed.entries[0].tickets, ['SCB-213', 'SCB-227']);
  assert.equal(parsed.entries[2].hours, 2.5);
});

test('parseWeeklyLogText reports entries before headings and invalid lines', () => {
  const parsed = parseWeeklyLogText(`+1 Missing heading
Monday, 01 Jun 2026
not a valid entry`);

  assert.equal(parsed.entries.length, 0);
  assert.equal(parsed.errors.length, 2);
  assert.match(parsed.errors[0].message, /before a valid date heading/);
  assert.match(parsed.errors[1].message, /Invalid line format/);
});

test('parseWeeklyLogText splits worklog task and description on the first pipe', () => {
  const result = parseWeeklyLogText(`Monday, 01 Jun 2026
+2 Code Review | Review PR | follow-up (SCB-213)
+1 Development
+1 | missing task`);

  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].taskName, 'Code Review');
  assert.equal(result.entries[0].description, 'Review PR | follow-up (SCB-213)');
  assert.equal(result.entries[0].taskExplicit, true);
  assert.deepEqual(result.entries[0].tickets, ['SCB-213']);
  assert.equal(result.entries[1].taskName, 'Development');
  assert.equal(result.entries[1].description, '');
  assert.equal(result.entries[1].taskExplicit, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /Worklog task name is empty/);
});
