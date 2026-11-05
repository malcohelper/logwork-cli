import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  mergeWorklogTaskLists,
  resolveWorklogTask
} from '../lib/worklog-task-resolver.mjs';

describe('resolveWorklogTask', () => {
  const tasks = [
    { id: 1, name: 'Testing Activities', project_id: 643 },
    { id: 2, name: 'Code Review', project_id: null }
  ];
  const ambiguousTasks = [
    ...tasks,
    { id: 3, name: 'Testing Activities', project_id: 644 }
  ];

  test('matches task name case-insensitively', () => {
    const result = resolveWorklogTask({
      taskName: 'testing activities',
      projectId: 643,
      tasks
    });
    assert.equal(result.worklogTaskId, 1);
    assert.equal(result.needsProjectId, false);
  });

  test('marks default tasks as needing project_id on create', () => {
    const result = resolveWorklogTask({
      taskName: 'Code Review',
      projectId: 643,
      tasks
    });
    assert.equal(result.worklogTaskId, 2);
    assert.equal(result.needsProjectId, true);
  });

  test('returns catalog type_of_work when the matched task defines it', () => {
    const result = resolveWorklogTask({
      taskName: 'Testing Activities',
      projectId: 643,
      tasks: [
        { id: 1, name: 'Testing Activities', project_id: 643, type_of_work: 'create' }
      ]
    });
    assert.equal(result.typeOfWork, 'create');
  });

  test('omits typeOfWork when catalog field is missing or invalid', () => {
    const result = resolveWorklogTask({
      taskName: 'Testing Activities',
      projectId: 643,
      tasks: [{ id: 1, name: 'Testing Activities', project_id: 643 }]
    });
    assert.equal(result.typeOfWork, undefined);
  });

  test('throws when no task matches and includes suggestions', () => {
    assert.throws(
      () => resolveWorklogTask({
        taskName: 'Testing',
        projectId: 643,
        tasks
      }),
      /No worklog task named "Testing"/
    );
    assert.throws(
      () => resolveWorklogTask({
        taskName: 'Testing',
        projectId: 643,
        tasks
      }),
      /Similar tasks: "Testing Activities"/
    );
  });

  test('throws on ambiguous duplicate names', () => {
    assert.throws(
      () => resolveWorklogTask({
        taskName: 'Testing Activities',
        projectId: 643,
        tasks: ambiguousTasks
      }),
      /Ambiguous worklog task name/
    );
  });
});

test('mergeWorklogTaskLists deduplicates by id', () => {
  const merged = mergeWorklogTaskLists(
    [{ id: 1, name: 'A' }],
    [{ id: 1, name: 'A duplicate' }, { id: 2, name: 'B' }]
  );
  assert.deepEqual(merged.map((task) => task.id), [1, 2]);
  assert.equal(merged[0].name, 'A');
});
