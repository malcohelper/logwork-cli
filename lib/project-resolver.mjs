import {
  projectIdentityKey,
  projectMatchesMapping
} from './project-identity.mjs';

const RESOLVE_THRESHOLD = 0.75;
const AMBIGUOUS_MARGIN = 0.1;
const CONFIG_TICKET_CONFIDENCE = 0.99;
const CONFIG_KEYWORD_CONFIDENCE = 0.98;
const PROJECT_NAME_CONFIDENCE = 0.95;
const PROJECT_NAME_TOKEN_CONFIDENCE = 0.65;
const SINGLE_BOOKED_CONFIDENCE = 0.95;

export function resolveEntryProject({
  entry,
  projects,
  membershipProjects = [],
  projectOverrides = {},
  config = {}
}) {
  const bookedProjects = Array.isArray(projects) ? projects : [];
  const memberships = Array.isArray(membershipProjects) ? membershipProjects : [];
  const override = projectOverrides?.[entry.id];

  if (override !== undefined && override !== null && String(override).trim() !== '') {
    const project = findProjectByMemberId(bookedProjects, override);

    if (project) {
      return resolved(project, 1, 'override', [], true);
    }

    const membership = findProjectByMemberId(memberships, override);
    if (membership) {
      return resolved(membership, 1, 'override_unbooked', [], false);
    }

    return unresolved('override_not_found', combineCandidates(bookedProjects, memberships));
  }

  const membershipCandidates = memberships.filter((membership) => (
    !bookedProjects.some((booked) => String(booked.projectMemberId) === String(membership.projectMemberId))
  ));

  if (bookedProjects.length === 1) {
    const bookedProject = bookedProjects[0];
    const bookedScore = scoreProject(entry, bookedProject, config);

    if (isConfigSource(bookedScore.source)) {
      return resolved(bookedProject, bookedScore.confidence, bookedScore.source, [bookedScore], true);
    }

    const conflicts = findConflictingMappingCandidates({
      entry,
      bookedProject,
      membershipCandidates,
      config
    });
    if (conflicts.length) {
      return unresolvedWithCandidates(
        'single_booked_project_conflicts_with_mapping',
        [
          ...conflicts,
          toCandidate({
            project: bookedProject,
            confidence: SINGLE_BOOKED_CONFIDENCE,
            source: 'single_booked_project'
          }, true)
        ],
        conflicts[0].confidence
      );
    }

    return resolved(bookedProject, SINGLE_BOOKED_CONFIDENCE, 'single_booked_project', [], true);
  }

  if (bookedProjects.length > 1) {
    const bookedResult = resolveScoredProjects(entry, bookedProjects, config, true);
    if (bookedResult.status === 'resolved') {
      return bookedResult;
    }
  }

  const unbookedResult = resolveScoredProjects(entry, membershipCandidates, config, false);
  if (unbookedResult.status === 'resolved_unbooked') {
    return unbookedResult;
  }

  if (bookedProjects.length === 0) {
    return unresolved('no_booked_projects', membershipCandidates);
  }

  const scored = bookedProjects
    .map((project) => scoreProject(entry, project, config))
    .sort((left, right) => right.confidence - left.confidence);
  const best = scored[0];

  return {
    status: 'unresolved',
    reason: best.confidence > 0 ? 'ambiguous_project_match' : 'no_project_match',
    confidence: best.confidence,
    candidates: scored.map((candidate) => toCandidate(candidate, true))
  };
}

function resolveScoredProjects(entry, projects, config, booked) {
  if (!projects.length) {
    return unresolved(booked ? 'no_booked_projects' : 'no_membership_project_match', []);
  }

  const scored = projects
    .map((project) => scoreProject(entry, project, config, { allowProjectTextMatch: booked }))
    .sort((left, right) => right.confidence - left.confidence);
  const best = scored[0];
  const second = scored[1];

  if (
    best.confidence >= RESOLVE_THRESHOLD &&
    isClearWinner(best, second)
  ) {
    return resolved(best.project, best.confidence, booked ? best.source : `${best.source}_unbooked`, scored, booked);
  }

  return {
    status: 'unresolved',
    reason: best.confidence > 0 ? 'ambiguous_project_match' : 'no_project_match',
    confidence: best.confidence,
    candidates: scored.map((candidate) => toCandidate(candidate, booked))
  };
}

function scoreProject(entry, project, config, { allowProjectTextMatch = true } = {}) {
  const taskText = normalize(entry.taskName);
  const projectName = normalize(project.projectName);
  let confidence = 0;
  let source = 'none';

  if (allowProjectTextMatch && projectName && taskText.includes(projectName)) {
    confidence = PROJECT_NAME_CONFIDENCE;
    source = 'project_name';
  }

  if (allowProjectTextMatch) {
    for (const word of projectName.split(/\s+/).filter((part) => part.length >= 4)) {
      if (taskText.includes(word) && confidence < PROJECT_NAME_TOKEN_CONFIDENCE) {
        confidence = PROJECT_NAME_TOKEN_CONFIDENCE;
        source = 'project_name_token';
      }
    }
  }

  for (const mapping of config.projectMappings || []) {
    if (!mappingMatchesProject(mapping, project)) {
      continue;
    }

    const mappingMatch = matchEntryMapping(entry, mapping);
    if (mappingMatch && confidence < mappingMatch.confidence) {
      confidence = mappingMatch.confidence;
      source = mappingMatch.source;
    }
  }

  return { project, confidence, source };
}

function mappingMatchesProject(mapping, project) {
  return projectMatchesMapping(project, mapping);
}

function findConflictingMappingCandidates({
  entry,
  bookedProject,
  membershipCandidates,
  config
}) {
  const candidates = new Map();

  for (const mapping of config.projectMappings || []) {
    const mappingMatch = matchEntryMapping(entry, mapping);
    if (!mappingMatch || mappingMatchesProject(mapping, bookedProject)) {
      continue;
    }

    const matchedMemberships = membershipCandidates.filter((membership) => mappingMatchesProject(mapping, membership));
    if (matchedMemberships.length) {
      for (const membership of matchedMemberships) {
        addCandidate(candidates, {
          project: membership,
          booked: false,
          confidence: mappingMatch.confidence,
          source: mappingMatch.source
        });
      }
      continue;
    }

    const mappedProject = projectFromMapping(mapping);
    if (mappedProject) {
      addCandidate(candidates, {
        project: mappedProject,
        booked: false,
        confidence: mappingMatch.confidence,
        source: mappingMatch.source
      });
    }
  }

  return [...candidates.values()]
    .map((candidate) => toCandidate(candidate, candidate.booked))
    .sort(compareCandidates);
}

function matchEntryMapping(entry, mapping) {
  const ticketMatch = (entry.tickets || []).some((ticket) => (
    (mapping.tickets || []).some((prefix) => {
      const normalizedPrefix = String(prefix || '').trim().toUpperCase();
      return normalizedPrefix && ticket.startsWith(normalizedPrefix);
    })
  ));
  if (ticketMatch) {
    return {
      confidence: CONFIG_TICKET_CONFIDENCE,
      source: 'config_ticket'
    };
  }

  const taskText = normalize(entry.taskName);
  const keywordMatch = (mapping.keywords || []).some((keyword) => {
    const normalizedKeyword = normalize(keyword);
    return normalizedKeyword && taskText.includes(normalizedKeyword);
  });
  if (keywordMatch) {
    return {
      confidence: CONFIG_KEYWORD_CONFIDENCE,
      source: 'config_keyword'
    };
  }

  return null;
}

function projectFromMapping(mapping) {
  const project = {
    projectMemberId: mapping.projectMemberId,
    projectId: mapping.projectId,
    projectName: mapping.projectName
  };

  const hasProjectData = project.projectMemberId !== undefined ||
    project.projectId !== undefined ||
    Boolean(normalize(project.projectName));

  return hasProjectData
    ? project
    : null;
}

function addCandidate(candidates, candidate) {
  const key = candidateKey(candidate.project);
  const existing = candidates.get(key);
  if (!existing || candidate.confidence > existing.confidence) {
    candidates.set(key, candidate);
  }
}

function unresolvedWithCandidates(reason, candidates, confidence = 0) {
  return {
    status: 'unresolved',
    reason,
    confidence,
    candidates
  };
}

function isClearWinner(best, second) {
  if (!second) {
    return true;
  }

  if (isConfigSource(best.source) && !isConfigSource(second.source)) {
    return true;
  }

  return best.confidence - second.confidence >= AMBIGUOUS_MARGIN;
}

function isConfigSource(source) {
  return source === 'config_ticket' || source === 'config_keyword';
}

function resolved(project, confidence, source, candidates, booked) {
  return {
    status: booked ? 'resolved' : 'resolved_unbooked',
    reason: source,
    confidence,
    booked,
    requiresAllowUnbooked: !booked,
    project,
    candidates: candidates.map((candidate) => toCandidate(candidate, booked))
  };
}

function unresolved(reason, projects) {
  return {
    status: 'unresolved',
    reason,
    confidence: 0,
    candidates: projects.map((project) => ({
      projectMemberId: project.projectMemberId,
      projectId: project.projectId,
      projectName: project.projectName,
      booked: Boolean(project.booked),
      confidence: 0,
      source: 'none'
    }))
  };
}

function combineCandidates(bookedProjects, membershipProjects) {
  const candidates = new Map();

  for (const project of bookedProjects) {
    candidates.set(candidateKey(project), {
      ...project,
      booked: true
    });
  }

  for (const project of membershipProjects) {
    const key = candidateKey(project);
    if (candidates.has(key)) {
      continue;
    }

    candidates.set(key, {
      ...project,
      booked: false
    });
  }

  return [...candidates.values()];
}

function toCandidate(item, booked = item.booked) {
  const project = item.project || item;
  return {
    projectMemberId: project.projectMemberId,
    projectId: project.projectId,
    projectName: project.projectName,
    booked: Boolean(booked),
    confidence: item.confidence ?? 0,
    source: item.source || 'none'
  };
}

function compareCandidates(left, right) {
  return right.confidence - left.confidence ||
    String(left.projectName || '').localeCompare(String(right.projectName || ''));
}

function findProjectByMemberId(projects, projectMemberId) {
  return projects.find((candidate) => (
    String(candidate.projectMemberId) === String(projectMemberId)
  ));
}

function candidateKey(project) {
  return projectIdentityKey(project);
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}
