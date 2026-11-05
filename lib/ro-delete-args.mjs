export function parseRoDeleteArgs(args = []) {
  const options = {
    logworkId: undefined,
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
    if (String(arg).startsWith('-')) {
      throw new Error(`Unknown delete option: ${arg}`);
    }
    positional.push(arg);
  }

  if (options.help) {
    return options;
  }
  if (positional.length !== 1) {
    throw new Error('RO delete requires exactly one logwork id.');
  }
  options.logworkId = positional[0];
  return options;
}
