const DAY_HEADING_RE = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+(\d{2})\s+([A-Za-z]{3})\s+(\d{4})$/;
const ENTRY_RE = /^\+(\d+(?:\.\d+)?)\s+(.+)$/;
const TICKET_RE = /\b[A-Z][A-Z0-9]+-\d+\b/g;
const MAX_DAY_HOURS = 24;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const MONTHS = new Map([
  ['jan', 1],
  ['feb', 2],
  ['mar', 3],
  ['apr', 4],
  ['may', 5],
  ['jun', 6],
  ['jul', 7],
  ['aug', 8],
  ['sep', 9],
  ['oct', 10],
  ['nov', 11],
  ['dec', 12]
]);

export function parseWeeklyLogText(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('text must be a non-empty weekly log block.');
  }

  const entries = [];
  const errors = [];
  let currentDate = null;
  let entryIndex = 0;
  const lines = text.split(/\r?\n/);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const lineNumber = lineIndex + 1;
    const line = lines[lineIndex].trim();

    if (!line) {
      continue;
    }

    const heading = DAY_HEADING_RE.exec(line);
    if (heading) {
      currentDate = parseHeadingDate(heading, lineNumber, errors);
      continue;
    }

    const entry = ENTRY_RE.exec(line);
    if (!entry) {
      errors.push({
        line: lineNumber,
        message: `Invalid line format: ${line}`
      });
      continue;
    }

    if (!currentDate) {
      errors.push({
        line: lineNumber,
        message: 'Log entry appears before a valid date heading.'
      });
      continue;
    }

    const hours = Number(entry[1]);
    if (!Number.isFinite(hours) || hours <= 0) {
      errors.push({
        line: lineNumber,
        message: `Invalid hours value: ${entry[1]}`
      });
      continue;
    }
    // RO rejects more than 24h; catching it here keeps a batch from failing
    // halfway after earlier entries were written.
    const dayTotal = entries.filter((item) => item.date === currentDate).reduce((sum, item) => sum + item.hours, 0) + hours;
    if (hours > MAX_DAY_HOURS || dayTotal > MAX_DAY_HOURS) {
      errors.push({
        line: lineNumber,
        message: hours > MAX_DAY_HOURS
          ? `Hours ${entry[1]} exceed ${MAX_DAY_HOURS}h for one entry.`
          : `Entries for ${currentDate} add up to ${dayTotal}h, more than ${MAX_DAY_HOURS}h in one day.`
      });
      continue;
    }

    const text = entry[2].trim();
    const { taskName, description, taskExplicit } = splitTaskAndDescription(text);
    if (!taskName) {
      errors.push({
        line: lineNumber,
        message: `Worklog task name is empty before "|": ${line}`
      });
      continue;
    }
    entryIndex += 1;
    entries.push({
      id: `${currentDate}-${String(entryIndex).padStart(2, '0')}`,
      date: currentDate,
      hours,
      taskName,
      description,
      taskExplicit,
      text,
      tickets: [...new Set(text.match(TICKET_RE) || [])],
      line: lineNumber
    });
  }

  return { entries, errors };
}

// Entry text format: "<worklog task> | <description>".
// Without "|", the whole text is kept as taskName and description stays empty;
// batch-workflow later decides whether that text is a catalog task name or a
// description that needs a default worklog task.
export function splitTaskAndDescription(text) {
  const value = String(text || '').trim();
  const separatorIndex = value.indexOf('|');
  if (separatorIndex === -1) {
    return { taskName: value, description: '', taskExplicit: false };
  }
  return {
    taskName: value.slice(0, separatorIndex).trim(),
    description: value.slice(separatorIndex + 1).trim(),
    taskExplicit: true
  };
}

function parseHeadingDate(match, lineNumber, errors) {
  const day = Number(match[2]);
  const month = MONTHS.get(match[3].toLowerCase());
  const year = Number(match[4]);

  if (!month) {
    errors.push({
      line: lineNumber,
      message: `Unsupported month: ${match[3]}`
    });
    return null;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    errors.push({
      line: lineNumber,
      message: `Invalid date heading: ${match[0]}`
    });
    return null;
  }

  const weekday = WEEKDAYS[date.getUTCDay()];
  if (weekday !== match[1]) {
    errors.push({
      line: lineNumber,
      message: `Date heading says ${match[1]} but ${match[2]} ${match[3]} ${match[4]} is a ${weekday}: ${match[0]}`
    });
    return null;
  }

  return [
    String(year).padStart(4, '0'),
    String(month).padStart(2, '0'),
    String(day).padStart(2, '0')
  ].join('-');
}
