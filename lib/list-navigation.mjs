export function previousIndex(selectedIndex, itemCount) {
  return moveIndex(selectedIndex, itemCount, -1);
}

export function nextIndex(selectedIndex, itemCount) {
  return moveIndex(selectedIndex, itemCount, 1);
}

export function moveIndex(selectedIndex, itemCount, delta) {
  if (!Number.isFinite(itemCount) || itemCount <= 0) {
    return 0;
  }

  const count = Math.trunc(itemCount);
  const current = Number.isFinite(Number(selectedIndex))
    ? Math.trunc(Number(selectedIndex))
    : 0;
  return ((current + delta) % count + count) % count;
}
