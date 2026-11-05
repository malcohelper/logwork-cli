import { ApiError, getProjects } from './api.mjs';
import {
  configPath,
  loadLocalConfig,
  upsertProjectMappingConfig
} from './logwork-config.mjs';
import { createResourceOptimiserSession } from './query-workflow.mjs';

export async function listLogworkProjects({
  cwd = process.cwd(),
  fetchProjects
} = {}) {
  const projects = sanitizeProjects(await (fetchProjects || createMembershipProjectsFetcher())());
  const config = await loadLocalConfig(cwd);

  return {
    projects,
    mappings: config.projectMappings,
    configSources: {
      user: configPath(cwd, 'user'),
      project: configPath(cwd, 'project')
    },
    summary: [
      `Found ${projects.length} Resource Optimiser project memberships.`,
      config.projectMappings.length
        ? `Current mappings: ${config.projectMappings.length}.`
        : 'No project mappings configured yet.'
    ].join('\n')
  };
}

export async function upsertProjectMapping({
  projectMemberId,
  projectName,
  tickets = [],
  keywords = [],
  scope = 'user',
  confirm,
  cwd = process.cwd(),
  fetchProjects
} = {}) {
  if (confirm !== true) {
    throw new Error('upsert_project_mapping requires confirm: true.');
  }

  if (!Array.isArray(tickets) || !tickets.length) {
    throw new Error('upsert_project_mapping requires at least one ticket prefix.');
  }

  const projects = sanitizeProjects(await (fetchProjects || createMembershipProjectsFetcher())());
  const resolution = resolveProjectSelection(projects, { projectMemberId, projectName });
  if (!resolution.project) {
    const suffix = resolution.candidates?.length
      ? ` Candidates: ${resolution.candidates.map((project) => `${project.projectMemberId}:${project.projectName}`).join(', ')}`
      : '';
    throw new Error(`${resolution.reason}.${suffix}`);
  }

  const result = await upsertProjectMappingConfig({
    cwd,
    scope,
    project: resolution.project,
    tickets,
    keywords
  });

  return {
    status: result.created ? 'created' : 'updated',
    scope: result.scope,
    configPath: result.path,
    mapping: result.mapping,
    projects,
    summary: [
      `${result.created ? 'Created' : 'Updated'} project mapping for ${result.mapping.projectName}.`,
      `Tickets: ${result.mapping.tickets.join(', ')}.`,
      result.mapping.keywords.length ? `Keywords: ${result.mapping.keywords.join(', ')}.` : 'Keywords: none.'
    ].join('\n')
  };
}

export function buildSetupSuggestions(entries, membershipProjects = []) {
  const candidates = sanitizeProjects(membershipProjects);

  return entries
    .filter((entry) => entry.status === 'unresolved')
    .map((entry) => {
      const ticketPrefixes = ticketPrefixesFromEntry(entry);
      if (!ticketPrefixes.length) {
        return null;
      }

      const candidateProjects = rankCandidatesByTicketPrefix(
        sanitizeProjects(entry.candidates?.length ? entry.candidates : candidates),
        ticketPrefixes
      );
      if (!candidateProjects.length) {
        return null;
      }

      return {
        entryId: entry.id,
        date: entry.date,
        hours: entry.hours,
        taskName: entry.taskName,
        tickets: entry.tickets || [],
        ticketPrefixes,
        candidateProjects: candidateProjects.map((project) => ({
          ...project,
          toolArguments: {
            projectMemberId: project.projectMemberId,
            tickets: ticketPrefixes,
            keywords: [],
            confirm: true
          }
        }))
      };
    })
    .filter(Boolean);
}

export function enrichRoPreviewWithJiraProjects(roPreview, jiraPreview) {
  if (!roPreview || !jiraPreview) {
    return roPreview;
  }

  const setupByEntry = new Map((roPreview.setupSuggestions || []).map((suggestion) => [suggestion.entryId, suggestion]));
  const suggestions = (jiraPreview.entries || [])
    .map((jiraEntry) => buildJiraMappingSuggestion(jiraEntry, setupByEntry.get(jiraEntry.id)))
    .filter(Boolean);

  if (!suggestions.length) {
    return roPreview;
  }

  return {
    ...roPreview,
    jiraMappingSuggestions: suggestions,
    summary: [
      roPreview.summary,
      '',
      'Jira-assisted RO mapping suggestions:',
      ...suggestions.map(formatJiraMappingSuggestion)
    ].join('\n')
  };
}

function createMembershipProjectsFetcher() {
  const session = createResourceOptimiserSession();
  return async () => {
    const { token, userId } = await session.get();
    try {
      return await getProjects(token, userId);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) {
        throw error;
      }

      const refreshed = await session.get({ forceLogin: true });
      return getProjects(refreshed.token, refreshed.userId);
    }
  };
}

function resolveProjectSelection(projects, { projectMemberId, projectName }) {
  if (projectMemberId !== undefined && projectMemberId !== null && String(projectMemberId).trim() !== '') {
    const project = projects.find((candidate) => String(candidate.projectMemberId) === String(projectMemberId));
    return project
      ? { project }
      : { project: null, reason: `Project member ${projectMemberId} was not found in your memberships`, candidates: projects };
  }

  if (!projectName || !String(projectName).trim()) {
    return {
      project: null,
      reason: 'Pass projectMemberId or projectName to choose a mapping project',
      candidates: projects
    };
  }

  const normalizedName = normalize(projectName);
  const exactMatches = projects.filter((project) => normalize(project.projectName) === normalizedName);
  if (exactMatches.length === 1) {
    return { project: exactMatches[0] };
  }

  const fuzzyMatches = projects.filter((project) => normalize(project.projectName).includes(normalizedName));
  if (fuzzyMatches.length === 1) {
    return { project: fuzzyMatches[0] };
  }

  if (exactMatches.length > 1 || fuzzyMatches.length > 1) {
    return {
      project: null,
      reason: `Project name "${projectName}" is ambiguous`,
      candidates: exactMatches.length > 1 ? exactMatches : fuzzyMatches
    };
  }

  return {
    project: null,
    reason: `Project name "${projectName}" was not found in your memberships`,
    candidates: projects
  };
}

function ticketPrefixesFromEntry(entry) {
  return [...new Set((entry.tickets || [])
    .map((ticket) => String(ticket).toUpperCase().match(/^([A-Z][A-Z0-9]+)-\d+/)?.[1])
    .filter(Boolean))];
}

function buildJiraMappingSuggestion(jiraEntry, setupSuggestion) {
  if (!setupSuggestion || !jiraEntry?.issue?.project) {
    return null;
  }

  const jiraProject = {
    key: String(jiraEntry.issue.project.key || '').trim(),
    name: String(jiraEntry.issue.project.name || '').trim()
  };
  const ranked = (setupSuggestion.candidateProjects || [])
    .map((project) => ({
      ...project,
      ...scoreJiraProjectCandidate(project, jiraProject)
    }))
    .sort((left, right) => right.confidence - left.confidence || String(left.projectName).localeCompare(String(right.projectName)));
  const recommendation = ranked[0]?.confidence > 0 ? ranked[0] : null;

  return {
    entryId: jiraEntry.id,
    issueKey: jiraEntry.issueKey,
    jiraProject,
    ticketPrefixes: setupSuggestion.ticketPrefixes,
    recommendation,
    candidates: ranked
  };
}

function scoreJiraProjectCandidate(project, jiraProject) {
  const projectName = normalize(project.projectName);
  const jiraName = normalize(jiraProject.name);
  const jiraKey = normalize(jiraProject.key);

  if (jiraName && projectName === jiraName) {
    return { confidence: 0.99, reason: 'jira_project_name_exact' };
  }
  if (jiraName && (projectName.includes(jiraName) || jiraName.includes(projectName))) {
    return { confidence: 0.94, reason: 'jira_project_name_contains' };
  }
  if (jiraKey && projectName.split(/[^a-z0-9]+/).includes(jiraKey)) {
    return { confidence: 0.9, reason: 'jira_project_key_match' };
  }

  const jiraTokens = meaningfulTokens(jiraName);
  const projectTokens = new Set(meaningfulTokens(projectName));
  const overlap = jiraTokens.filter((token) => projectTokens.has(token));
  if (overlap.length) {
    return {
      confidence: Number(Math.min(0.85, 0.6 + (overlap.length / Math.max(jiraTokens.length, 1)) * 0.25).toFixed(2)),
      reason: 'jira_project_name_token_match'
    };
  }

  return { confidence: 0, reason: 'jira_project_no_match' };
}

function rankCandidatesByTicketPrefix(projects, ticketPrefixes) {
  const prefixes = ticketPrefixes.map(normalize);
  return projects
    .map((project) => {
      const tokens = normalize(project.projectName).split(/[^a-z0-9]+/);
      const prefixMatch = prefixes.some((prefix) => tokens.includes(prefix));
      return {
        ...project,
        suggestedByTicket: prefixMatch
      };
    })
    .sort((left, right) => Number(right.suggestedByTicket) - Number(left.suggestedByTicket));
}

function meaningfulTokens(value) {
  return normalize(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !['project', 'team', 'the', 'and'].includes(token));
}

function formatJiraMappingSuggestion(suggestion) {
  const jiraProject = [suggestion.jiraProject.key, suggestion.jiraProject.name].filter(Boolean).join(' / ') || 'unknown Jira project';
  if (!suggestion.recommendation) {
    return `- ${suggestion.issueKey}: ${jiraProject} has no confident RO project match. Choose a candidate manually.`;
  }

  const recommendation = suggestion.recommendation;
  return `- ${suggestion.issueKey}: ${jiraProject} -> ${recommendation.projectName} (${recommendation.projectMemberId}), ${recommendation.reason}, confidence ${recommendation.confidence}. Confirm with /map ${suggestion.ticketPrefixes.join(',')} ${recommendation.projectMemberId}.`;
}

function sanitizeProjects(projects) {
  return (Array.isArray(projects) ? projects : [])
    .filter((project) => project && project.projectMemberId !== undefined && project.projectMemberId !== null)
    .map((project) => ({
      projectMemberId: project.projectMemberId,
      projectId: project.projectId,
      projectName: project.projectName
    }));
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}
