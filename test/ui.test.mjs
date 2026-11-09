import test from 'node:test';
import assert from 'node:assert/strict';
import {
  askHours,
  chooseMessageSource,
  chooseProject,
  chooseTask,
  confirmSubmit,
  formatSubmitConfirmation,
  handleCancel,
  projectSelectOptions,
  showError,
  showSuccess,
  taskSelectOptions,
  validateHours,
  validateTaskMessage
} from '../lib/ui.mjs';

const CANCEL = Symbol('cancel');

// Answers each prompt from a queue and records what was asked.
function fakePrompts(answers = []) {
  const queue = [...answers];
  const calls = [];
  const answer = (kind) => async (options) => {
    calls.push({ kind, options });
    return queue.shift();
  };
  return {
    calls,
    select: answer('select'),
    text: answer('text'),
    confirm: answer('confirm'),
    outro(message) {
      calls.push({ kind: 'outro', message });
    },
    cancel(message) {
      calls.push({ kind: 'cancel', message });
    },
    isCancel: (value) => value === CANCEL
  };
}

const projects = [
  { projectMemberId: 11, projectName: 'Course Builder', assignedHours: 4, workloadPercent: 50, loggedHours: 1.5 },
  { projectMemberId: 12, projectName: 'Maintenance', assignedHours: 2.25, workloadPercent: 28, loggedHours: 0 }
];

test('projectSelectOptions shows booked hours, workload and logged hours', () => {
  assert.deepEqual(projectSelectOptions(projects, [{ ok: true, totalHours: 3 }, { ok: false, totalHours: 9 }]), [
    { value: 11, label: 'Course Builder - 4h/day (50% assigned) · 3h logged today' },
    { value: 12, label: 'Maintenance - 2.3h/day (28% assigned) · 0h logged today' }
  ]);
  // Without a usable day summary, the project's own logged hours are shown.
  assert.match(projectSelectOptions(projects, [])[0].label, /1\.5h logged today/);
});

test('taskSelectOptions labels each task with its type of work', () => {
  assert.deepEqual(taskSelectOptions([{ taskId: 9, name: 'Feature Development', typeOfWork: 'create', description: 'New work' }]), [
    { value: 9, label: 'Feature Development (create)', hint: 'New work' }
  ]);
});

test('validateTaskMessage requires non-blank text', () => {
  assert.equal(validateTaskMessage(''), 'Vui lòng nhập nội dung công việc.');
  assert.equal(validateTaskMessage('   '), 'Vui lòng nhập nội dung công việc.');
  assert.equal(validateTaskMessage(undefined), 'Vui lòng nhập nội dung công việc.');
  assert.equal(validateTaskMessage('Fix login'), undefined);
});

test('validateHours requires a positive multiple of the hour step', () => {
  assert.equal(validateHours('abc'), 'Số giờ phải là số.');
  assert.equal(validateHours('0'), 'Số giờ phải lớn hơn 0.');
  assert.equal(validateHours('-1'), 'Số giờ phải lớn hơn 0.');
  assert.equal(validateHours('0.3'), 'Số giờ phải chia hết cho 0.5.');
  assert.equal(validateHours('1.5'), undefined);
  assert.equal(validateHours('0.75', 0.25), undefined);
  assert.equal(validateHours('0.5', 1), 'Số giờ phải chia hết cho 1.');
});

test('formatSubmitConfirmation truncates long task names and descriptions', () => {
  assert.equal(
    formatSubmitConfirmation({ hours: 2, projectName: 'Course Builder', taskName: 'Feature Development' }),
    'Log 2h to Course Builder with task "Feature Development"?'
  );
  const message = formatSubmitConfirmation({
    hours: 1,
    projectName: 'P',
    taskName: 'T'.repeat(100),
    description: 'D'.repeat(200)
  });
  assert.match(message, new RegExp(`task "${'T'.repeat(79)}…" \\| "${'D'.repeat(119)}…"\\?$`));
});

test('chooseProject and chooseTask return the picked records', async () => {
  const prompts = fakePrompts([12, 9]);

  assert.equal(await chooseProject(projects, [], { prompts }), projects[1]);
  const task = { taskId: 9, name: 'Feature Development', typeOfWork: 'create' };
  assert.equal(await chooseTask([task], { prompts }), task);
  assert.deepEqual(prompts.calls.map((call) => call.options.message), ['Chọn project cần log work:', 'Chọn loại công việc:']);
  assert.equal(prompts.calls[0].options.options.length, 2);
});

test('chooseMessageSource prefills the git message only when chosen', async () => {
  const gitPrompts = fakePrompts(['git', '  Fix login flow  ']);
  assert.equal(await chooseMessageSource('commit subject', { prompts: gitPrompts }), 'Fix login flow');
  assert.equal(gitPrompts.calls[1].options.initialValue, 'commit subject');
  assert.equal(gitPrompts.calls[1].options.validate(''), 'Vui lòng nhập nội dung công việc.');

  const customPrompts = fakePrompts(['custom', 'Custom text']);
  assert.equal(await chooseMessageSource('commit subject', { prompts: customPrompts }), 'Custom text');
  assert.equal(customPrompts.calls[1].options.initialValue, '');
});

test('askHours returns a number and validates with the hour step', async () => {
  const prompts = fakePrompts(['2.5']);
  assert.equal(await askHours(3, { prompts }), 2.5);
  assert.equal(prompts.calls[0].options.initialValue, '3');
  assert.equal(prompts.calls[0].options.validate('0.2'), 'Số giờ phải chia hết cho 0.5.');
  assert.equal(prompts.calls[0].options.validate('1'), undefined);
});

test('confirmSubmit resolves on yes and throws on no', async () => {
  const preview = { hours: 1, projectName: 'P', taskName: 'T' };
  assert.equal(await confirmSubmit(preview, { prompts: fakePrompts([true]) }), true);
  await assert.rejects(confirmSubmit(preview, { prompts: fakePrompts([false]) }), /User declined final submit\./);
});

test('a cancelled prompt throws Cancelled', async () => {
  await assert.rejects(chooseProject(projects, [], { prompts: fakePrompts([CANCEL]) }), /^Error: Cancelled\.$/);
  await assert.rejects(askHours(1, { prompts: fakePrompts([CANCEL]) }), /Cancelled/);
  assert.throws(() => handleCancel(CANCEL, fakePrompts()), /Cancelled/);
  assert.equal(handleCancel('value', fakePrompts()), 'value');
});

test('showSuccess and showError print through the prompts outro and cancel', () => {
  const prompts = fakePrompts();
  showSuccess('Logwork submitted.', { prompts });
  showError(new Error('boom'), { prompts });
  showError('plain', { prompts });
  assert.deepEqual(prompts.calls, [
    { kind: 'outro', message: 'Logwork submitted.' },
    { kind: 'cancel', message: 'boom' },
    { kind: 'cancel', message: 'plain' }
  ]);
});
