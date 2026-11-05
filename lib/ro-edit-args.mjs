export function parseRoEditArgs(args = []) {
  const options = {
    logworkId: undefined,
    hours: undefined,
    taskName: undefined,
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
  if (options.hours === undefined && options.taskName === undefined) {
    throw new Error('RO edit requires --hours and/or --task-name.');
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
