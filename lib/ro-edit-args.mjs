export function parseRoEditArgs(args = []) {
  const options = {
    logworkId: undefined,
    hours: undefined,
    taskName: undefined,
    description: undefined,
    typeOfWork: undefined,
    yes: false,
    json: false,
    help: false
  };
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--yes' || arg === '-y') {
      options.yes = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--hours' || arg === '--logtimes') {
      const value = args[index + 1];
      if (value === undefined) {
        throw new Error(`${arg} requires a positive number.`);
      }
      options.hours = normalizeHours(value);
      index += 1;
      continue;
    }
    if (arg.startsWith('--hours=') || arg.startsWith('--logtimes=')) {
      options.hours = normalizeHours(arg.slice(arg.indexOf('=') + 1));
      continue;
    }
    if (arg === '--task-name' || arg === '--task') {
      const values = [];
      while (args[index + 1] !== undefined && !String(args[index + 1]).startsWith('-')) {
        values.push(args[index + 1]);
        index += 1;
      }
      options.taskName = normalizeTaskName(values.join(' '), arg);
      continue;
    }
    if (arg.startsWith('--task-name=') || arg.startsWith('--task=')) {
      options.taskName = normalizeTaskName(arg.slice(arg.indexOf('=') + 1), arg.split('=')[0]);
      continue;
    }
    if (arg === '--description' || arg === '--desc') {
      const values = [];
      while (args[index + 1] !== undefined && !String(args[index + 1]).startsWith('--')) {
        values.push(args[index + 1]);
        index += 1;
      }
      options.description = normalizeDescription(values.join(' '), arg);
      continue;
    }
    if (arg.startsWith('--description=') || arg.startsWith('--desc=')) {
      options.description = normalizeDescription(arg.slice(arg.indexOf('=') + 1), arg.split('=')[0]);
      continue;
    }
    if (arg === '--type' || arg === '--type-of-work') {
      options.typeOfWork = normalizeTypeOfWork(args[index + 1], arg);
      index += 1;
      continue;
    }
    if (arg.startsWith('--type=') || arg.startsWith('--type-of-work=')) {
      options.typeOfWork = normalizeTypeOfWork(arg.slice(arg.indexOf('=') + 1), arg.split('=')[0]);
      continue;
    }
    if (String(arg).startsWith('-')) {
      throw new Error(`Unknown edit option: ${arg}`);
    }
    positional.push(arg);
  }

  if (options.help) {
    return options;
  }
  if (positional.length !== 1) {
    throw new Error('RO edit requires exactly one logwork id.');
  }
  if (
    options.hours === undefined &&
    options.taskName === undefined &&
    options.description === undefined &&
    options.typeOfWork === undefined
  ) {
    throw new Error('RO edit requires at least one of --hours, --task, --desc, --type.');
  }
  options.logworkId = positional[0];
  return options;
}

function normalizeHours(value) {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error('--hours must be a positive number.');
  }
  const rounded = Number(hours.toFixed(2));
  if (rounded <= 0) {
    throw new Error('--hours must be at least 0.01 after rounding.');
  }
  return rounded;
}

function normalizeTaskName(value, option) {
  const taskName = String(value || '').trim();
  if (!taskName) {
    throw new Error(`${option} requires a non-empty value.`);
  }
  if (taskName.length > 1_000) {
    throw new Error('--task-name must not exceed 1000 characters.');
  }
  return taskName;
}

function normalizeDescription(value, option) {
  const description = String(value || '').trim();
  if (!description) {
    throw new Error(`${option} requires a non-empty value.`);
  }
  if (description.length > 1_000) {
    throw new Error('--description must not exceed 1000 characters.');
  }
  return description;
}

const TYPE_OF_WORK = ['create', 'correct', 'improve', 'other'];

function normalizeTypeOfWork(value, option) {
  const typeOfWork = String(value ?? '').trim();
  if (!TYPE_OF_WORK.includes(typeOfWork)) {
    throw new Error(`${option} must be one of: ${TYPE_OF_WORK.join(', ')}.`);
  }
  return typeOfWork;
}
