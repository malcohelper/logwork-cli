import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  legacyUserConfigPath,
  projectConfigPath,
  userConfigPath
} from './paths.mjs';
import { atomicWriteFile } from './atomic-file.mjs';
import { withFileLock } from './file-lock.mjs';
import {
  normalizeProjectName,
  sameProjectIdentity
} from './project-identity.mjs';
import { safeJsonParse } from './util.mjs';

export async function loadLocalConfig(cwd = process.cwd()) {
  const legacyConfig = normalizeConfig(await readRawConfigPath(legacyUserConfigPath()));
  const userConfig = normalizeConfig(await readRawConfigPath(userConfigPath()));
  const projectPath = projectConfigPath(cwd);
  const projectConfig = projectPath === userConfigPath()
    ? normalizeConfig({})
    : normalizeConfig(await readRawConfigPath(projectPath));

  return mergeConfigs(legacyConfig, userConfig, projectConfig);
}

export async function upsertProjectMappingConfig({
  cwd = process.cwd(),
  scope = 'user',
  project,
  tickets = [],
  keywords = [],
  repos = [],
  lockOptions = {}
}) {
  const path = scope === 'project' ? projectConfigPath(cwd) : userConfigPath();
  return withFileLock(path, async () => {
    const config = scope === 'project'
      ? normalizeConfig(await readRawConfigPath(path))
      : mergeConfigs(
        normalizeConfig(await readRawConfigPath(legacyUserConfigPath())),
        normalizeConfig(await readRawConfigPath(path))
      );
    const mapping = withRepos({
      projectName: project.projectName,
      projectMemberId: project.projectMemberId,
      tickets: normalizeTickets(tickets),
      keywords: normalizeKeywords(keywords)
    }, normalizeRepos(repos));
    const existingIndex = config.projectMappings.findIndex((candidate) => (
      sameProjectIdentity(candidate, mapping)
    ));

    const projectMappings = [...config.projectMappings];
    if (existingIndex >= 0) {
      projectMappings[existingIndex] = mergeMapping(projectMappings[existingIndex], mapping);
    } else {
      projectMappings.push(mapping);
    }

    const nextConfig = { projectMappings };
    await atomicWriteFile(path, `${JSON.stringify(nextConfig, null, 2)}\n`);

    return {
      path,
      scope,
      config: normalizeConfig(nextConfig),
      mapping: normalizeConfig({ projectMappings: [existingIndex >= 0 ? projectMappings[existingIndex] : mapping] }).projectMappings[0],
      created: existingIndex < 0
    };
  }, lockOptions);
}

export function normalizeConfig(config) {
  const rawMappings = Array.isArray(config.projectMappings)
    ? config.projectMappings
    : Array.isArray(config.mappings)
      ? config.mappings
      : [];

  return {
    projectMappings: rawMappings
      .filter((mapping) => mapping && typeof mapping === 'object')
      .map(normalizeMapping)
      .filter((mapping) => mapping.projectMemberId !== undefined || mapping.projectName)
  };
}

export function configPath(cwd = process.cwd(), scope = 'user') {
  return scope === 'project' ? projectConfigPath(cwd) : userConfigPath();
}

async function readRawConfigPath(path) {
  try {
    const text = await fs.readFile(path, 'utf8');
    const data = safeJsonParse(text, null);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`${path} must contain a JSON object.`);
    }
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

function mergeConfigs(...configs) {
  const mappings = new Map();

  for (const config of configs) {
    for (const mapping of config.projectMappings) {
      const key = mappingKey(mapping);
      const existing = mappings.get(key);
      mappings.set(key, existing ? mergeMapping(existing, mapping) : mapping);
    }
  }

  return {
    projectMappings: [...mappings.values()]
  };
}

function mappingKey(mapping) {
  return mapping.projectMemberId !== undefined && mapping.projectMemberId !== null
    ? `member:${mapping.projectMemberId}`
    : `name:${normalizeProjectName(mapping.projectName)}`;
}

function normalizeMapping(mapping) {
  return withRepos({
    projectName: stringOrEmpty(mapping.projectName),
    projectMemberId: optionalId(mapping.projectMemberId),
    tickets: normalizeTickets(mapping.tickets),
    keywords: normalizeKeywords(mapping.keywords)
  }, normalizeRepos(mapping.repos));
}

function mergeMapping(existing, next) {
  return withRepos({
    projectName: next.projectName || existing.projectName,
    projectMemberId: next.projectMemberId ?? existing.projectMemberId,
    tickets: uniqueStrings([...existing.tickets, ...next.tickets], { uppercase: true }),
    keywords: uniqueStrings([...existing.keywords, ...next.keywords])
  }, normalizeRepos([...(existing.repos || []), ...(next.repos || [])]));
}

// repos is optional: a mapping without repos keeps its old shape on disk.
function withRepos(mapping, repos) {
  return repos.length ? { ...mapping, repos } : mapping;
}

// Git repo roots are stored resolved and without trailing separators. Windows
// paths compare case-insensitively (see repoPathKey).
export function normalizeRepoPath(value, platform = process.platform) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    return '';
  }
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const expanded = text === '~' || /^~[\\/]/.test(text) ? `${homedir()}${text.slice(1)}` : text;
  const resolved = pathApi.resolve(expanded);
  const root = pathApi.parse(resolved).root;
  let trimmed = resolved;
  while (trimmed.length > root.length && /[\\/]$/.test(trimmed)) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

export function repoPathKey(value, platform = process.platform) {
  const normalized = normalizeRepoPath(value, platform);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function normalizeRepos(value, platform = process.platform) {
  const seen = new Set();
  const results = [];
  for (const item of stringArray(value)) {
    const normalized = normalizeRepoPath(item, platform);
    const key = repoPathKey(normalized, platform);
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    results.push(normalized);
  }
  return results;
}

// The mapping whose repos list contains this git repo root, if any.
export function findRepoMapping(mappings, repoRoot, platform = process.platform) {
  const key = repoPathKey(repoRoot, platform);
  if (!key) {
    return null;
  }
  return (mappings || []).find((mapping) => (
    (mapping.repos || []).some((repo) => repoPathKey(repo, platform) === key)
  )) || null;
}

function stringOrEmpty(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalId(value) {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }

  const text = String(value).trim();
  return text ? text : undefined;
}

function stringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : [];
}

function normalizeTickets(value) {
  return uniqueStrings(stringArray(value), { uppercase: true });
}

function normalizeKeywords(value) {
  return uniqueStrings(stringArray(value));
}

function uniqueStrings(values, { uppercase = false } = {}) {
  const seen = new Set();
  const results = [];

  for (const value of values) {
    const normalized = uppercase ? value.toUpperCase() : value.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    results.push(normalized);
  }

  return results;
}
