import { cancel, confirm, isCancel, outro, select, text } from '@clack/prompts';
import { CONFIG } from './config.mjs';

export async function chooseProject(projects, daySummaries) {
  const options = projects.map((project, index) => {
    const summary = daySummaries[index];
    const logged = summary?.ok ? `${formatHours(summary.totalHours)}h` : `${formatHours(project.loggedHours)}h`;
    const booked = `${formatHours(project.assignedHours)}h`;

    return {
      value: project.projectMemberId,
      label: `${project.projectName} - ${booked}/day (${project.workloadPercent}% assigned) · ${logged} logged today`
    };
  });

  const projectMemberId = handleCancel(await select({
    message: 'Chọn project cần log work:',
    options
  }));

  return projects.find((project) => project.projectMemberId === projectMemberId);
}

export async function chooseTask(tasks) {
  const taskId = handleCancel(await select({
    message: 'Chọn loại công việc:',
    options: tasks.map((task) => ({
      value: task.taskId,
      label: `${task.name} (${task.typeOfWork})`,
      hint: task.description
    }))
  }));

  return tasks.find((task) => task.taskId === taskId);
}

export async function chooseMessageSource(defaultMessage) {
  const source = handleCancel(await select({
    message: 'Task message:',
    options: [
      { value: 'git', label: 'Use git commit message' },
      { value: 'custom', label: 'Custom' }
    ],
    initialValue: 'git'
  }));

  const initialValue = source === 'git' ? defaultMessage : '';
  const value = handleCancel(await text({
    message: 'Nội dung công việc:',
    placeholder: 'Fix login flow',
    initialValue,
    validate(input) {
      if (!input || input.trim() === '') {
        return 'Vui lòng nhập nội dung công việc.';
      }
      return undefined;
    }
  }));

  return value.trim();
}

export async function askHours(defaultHours = CONFIG.defaultHours) {
  const value = handleCancel(await text({
    message: 'Số giờ log:',
    placeholder: String(defaultHours),
    initialValue: String(defaultHours),
    validate(input) {
      const numeric = Number(input);

      if (!Number.isFinite(numeric)) {
        return 'Số giờ phải là số.';
      }
      if (numeric <= 0) {
        return 'Số giờ phải lớn hơn 0.';
      }
      if (!Number.isInteger(numeric / CONFIG.hourStep)) {
        return `Số giờ phải chia hết cho ${CONFIG.hourStep}.`;
      }

      return undefined;
    }
  }));

  return Number(value);
}

export async function confirmSubmit(payloadPreview) {
  const task = truncate(payloadPreview.taskName, 80);
  const description = payloadPreview.description
    ? ` | "${truncate(payloadPreview.description, 120)}"`
    : '';
  const ok = handleCancel(await confirm({
    message: `Log ${payloadPreview.hours}h to ${payloadPreview.projectName} with task "${task}"${description}?`,
    initialValue: true
  }));

  if (!ok) {
    throw new Error('User declined final submit.');
  }

  return true;
}

export function showSuccess(message) {
  outro(message);
}

export function showError(error) {
  cancel(error?.message || String(error));
}

export function handleCancel(value) {
  if (isCancel(value)) {
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
