export async function enrichEntriesWithLogworkF03(entries, { dates = [], fetchLogworkDay } = {}) {
  if (!fetchLogworkDay || !entries?.length || !dates?.length) {
    return { entries, f03ByDate: {} };
  }

  const f03ByDate = {};
  const statusById = new Map();

  for (const date of [...new Set(dates.filter(Boolean))]) {
    const day = await fetchLogworkDay(date);
    f03ByDate[date] = {
      isLocked: day.isLocked,
      entryCount: day.entries?.length || 0
    };
    for (const entry of day.entries || []) {
      if (entry.id !== undefined && entry.id !== null) {
        statusById.set(String(entry.id), entry);
      }
    }
  }

  const enriched = entries.map((entry) => {
    const f03 = entry.id !== undefined && entry.id !== null
      ? statusById.get(String(entry.id))
      : null;
    if (!f03) {
      return entry;
    }
    return {
      ...entry,
      status: f03.status || entry.status || '',
      typeOfWork: f03.typeOfWork || entry.typeOfWork || '',
      worklogTaskId: f03.worklogTaskId ?? entry.worklogTaskId ?? null,
      description: f03.description || entry.description || '',
      rejectionComment: f03.rejectionComment || entry.rejectionComment || '',
      noteToPm: f03.noteToPm || entry.noteToPm || ''
    };
  });

  return { entries: enriched, f03ByDate };
}
