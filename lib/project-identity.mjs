export function normalizeProjectName(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function projectIdentityKey(project = {}) {
  return String(
    firstPresent(project.projectMemberId, project.projectId) ??
      normalizeProjectName(project.projectName)
  );
}

export function sameProjectIdentity(left = {}, right = {}) {
  if (hasValue(left.projectMemberId) && hasValue(right.projectMemberId)) {
    return String(left.projectMemberId) === String(right.projectMemberId);
  }
  if (hasValue(left.projectId) && hasValue(right.projectId)) {
    return String(left.projectId) === String(right.projectId);
  }

  const leftName = normalizeProjectName(left.projectName);
  const rightName = normalizeProjectName(right.projectName);
  return Boolean(leftName && rightName && leftName === rightName);
}

export function projectMatchesFilter(project = {}, filterValue) {
  const filter = String(filterValue || '').trim();
  if (!filter) {
    return false;
  }

  const normalizedFilter = normalizeProjectName(filter);
  return (hasValue(project.projectMemberId) && String(project.projectMemberId) === filter) ||
    (hasValue(project.projectId) && String(project.projectId) === filter) ||
    normalizeProjectName(project.projectName).includes(normalizedFilter);
}

export function projectMatchesMapping(project = {}, mapping = {}, {
  allowNameContains = true,
  fallbackToName = false
} = {}) {
  if (hasValue(mapping.projectMemberId)) {
    const memberMatches = hasValue(project.projectMemberId) &&
      String(mapping.projectMemberId) === String(project.projectMemberId);
    if (memberMatches || !fallbackToName) {
      return memberMatches;
    }
  }

  const projectName = normalizeProjectName(project.projectName);
  const mappingName = normalizeProjectName(mapping.projectName);
  if (!projectName || !mappingName) {
    return false;
  }

  return allowNameContains
    ? projectName.includes(mappingName)
    : projectName === mappingName;
}

function firstPresent(...values) {
  return values.find(hasValue);
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}
