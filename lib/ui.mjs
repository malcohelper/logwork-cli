import * as clackPrompts from '@clack/prompts';
import { CONFIG } from './config.mjs';

// Every prompt function takes an optional `{ prompts }` (default: @clack/prompts)
// so tests can answer prompts without a terminal.

export async function chooseProject(projects, daySummaries, { prompts = clackPrompts } = {}) {
  const options = projectSelectOptions(projects, daySummaries);

  const projectMemberId = handleCancel(await prompts.select({
    message: 'Chọn project cần log work:',
    options
  }), prompts);

  return projects.find((project) => project.projectMemberId === projectMemberId);
}

export function projectSelectOptions(projects, daySummaries) {
  return projects.map((project, index) => {
    const summary = daySummaries[index];
    const logged = summary?.ok ? `${formatHours(summary.totalHours)}h` : `${formatHours(project.loggedHours)}h`;
    const booked = `${formatHours(project.assignedHours)}h`;

    return {
      value: project.projectMemberId,
      label: `${project.projectName} - ${booked}/day (${project.workloadPercent}% assigned) · ${logged} logged today`
    };
  });
}

export async function chooseTask(tasks, { prompts = clackPrompts } = {}) {
  const taskId = handleCancel(await prompts.select({
    message: 'Chọn loại công việc:',
    options: taskSelectOptions(tasks)
  }), prompts);

  return tasks.find((task) => task.taskId === taskId);
}

export function taskSelectOptions(tasks) {
  return tasks.map((task) => ({
    value: task.taskId,
    label: `${task.name} (${task.typeOfWork})`,
    hint: task.description
  }));
}

export async function chooseMessageSource(defaultMessage, { prompts = clackPrompts } = {}) {
  const source = handleCancel(await prompts.select({
    message: 'Task message:',
    options: [
      { value: 'git', label: 'Use git commit message' },
      { value: 'custom', label: 'Custom' }
    ],
    initialValue: 'git'
  }), prompts);

  const initialValue = source === 'git' ? defaultMessage : '';
  const value = handleCancel(await prompts.text({
    message: 'Nội dung công việc:',
    placeholder: 'Fix login flow',
    initialValue,
    validate: validateTaskMessage
  }), prompts);

  return value.trim();
}

export function validateTaskMessage(input) {
  if (!input || input.trim() === '') {
    return 'Vui lòng nhập nội dung công việc.';
  }
  return undefined;
}

export async function askHours(defaultHours = CONFIG.defaultHours, { prompts = clackPrompts } = {}) {
  const value = handleCancel(await prompts.text({
    message: 'Số giờ log:',
    placeholder: String(defaultHours),
    initialValue: String(defaultHours),
    validate(input) {
      return validateHours(input);
    }
  }), prompts);

  return Number(value);
}

export function validateHours(input, hourStep = CONFIG.hourStep) {
  const numeric = Number(input);

  if (!Number.isFinite(numeric)) {
    return 'Số giờ phải là số.';
  }
  if (numeric <= 0) {
    return 'Số giờ phải lớn hơn 0.';
  }
  if (!Number.isInteger(numeric / hourStep)) {
    return `Số giờ phải chia hết cho ${hourStep}.`;
  }

  return undefined;
}

export async function confirmSubmit(payloadPreview, { prompts = clackPrompts } = {}) {
  const ok = handleCancel(await prompts.confirm({
    message: formatSubmitConfirmation(payloadPreview),
    initialValue: true
  }), prompts);

  if (!ok) {
    throw new Error('User declined final submit.');
  }

  return true;
}

export function formatSubmitConfirmation(payloadPreview) {
  const task = truncate(payloadPreview.taskName, 80);
  const description = payloadPreview.description
    ? ` | "${truncate(payloadPreview.description, 120)}"`
    : '';
  return `Log ${payloadPreview.hours}h to ${payloadPreview.projectName} with task "${task}"${description}?`;
}

export function showSuccess(message, { prompts = clackPrompts } = {}) {
  prompts.outro(message);
}

export function showError(error, { prompts = clackPrompts } = {}) {
  prompts.cancel(error?.message || String(error));
}

export function handleCancel(value, prompts = clackPrompts) {
  if (prompts.isCancel(value)) {
    throw new Error('Cancelled.');
  }

  return value;
}

function formatHours(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) ? String(number) : String(number.toFixed(1)).replace(/\.0$/, '');
}

function truncate(value, maxLength) {
  const textValue = String(value);
  if (textValue.length <= maxLength) {
    return textValue;
  }

  return `${textValue.slice(0, maxLength - 1)}…`;
}
