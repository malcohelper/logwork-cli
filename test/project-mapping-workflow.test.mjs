import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadLocalConfig,
  configPath,
  normalizeConfig
} from '../lib/logwork-config.mjs';
import {
  helperHome,
  legacyUserConfigPath,
  userConfigPath
} from '../lib/paths.mjs';
import {
  enrichRoPreviewWithJiraProjects,
  listLogworkProjects,
  upsertProjectMapping
} from '../lib/project-mapping-workflow.mjs';
import { previewLogworkBatch } from '../lib/batch-workflow.mjs';
import { restoreEnv, snapshotEnv } from './helpers/env.mjs';

const projects = [
  {
    projectMemberId: 5234,
    projectId: 643,
    projectName: '2621A-SIT-HTML BUILDER-PRJ'
  }
];
const envSnapshot = snapshotEnv(['HOME', 'LOGWORK_HELPER_HOME']);

test.afterEach(() => {
  restoreEnv(envSnapshot);
});

test('upsertProjectMapping creates .logwork-helper.json and preview can use it', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logwork-helper-test-'));
  const home = await useTempHelperHome();

  const result = await upsertProjectMapping({
    cwd,
    projectMemberId: 5234,
    tickets: ['scb'],
    keywords: ['question bank'],
    confirm: true,
    fetchProjects: async () => projects
  });

  assert.equal(result.status, 'created');
  assert.equal(result.scope, 'user');
  assert.deepEqual(result.mapping, {
    projectName: '2621A-SIT-HTML BUILDER-PRJ',
    projectMemberId: 5234,
    tickets: ['SCB'],
    keywords: ['question bank']
  });

  const file = JSON.parse(await fs.readFile(join(home, '.logwork-helper.json'), 'utf8'));
  assert.equal(file.projectMappings[0].projectName, '2621A-SIT-HTML BUILDER-PRJ');
  await assert.rejects(
    () => fs.readFile(join(cwd, '.logwork-helper.json'), 'utf8'),
    /ENOENT/
  );

  const preview = await previewLogworkBatch({
    cwd,
    text: `Monday, 01 Jun 2026
+2 Maintenance mode management (SCB-213)`.replace('++', '+'),
    fetchProjects: async () => [],
    fetchMembershipProjects: async () => projects,
    fetchWorklogTasks: async () => [
      { id: 42, name: 'Maintenance mode management (SCB-213)', project_id: 643 }
    ]
  });

  assert.equal(preview.status, 'ready_with_unbooked');
  assert.equal(preview.entries[0].status, 'resolved_unbooked');
  assert.equal(preview.entries[0].matchedProject.projectMemberId, 5234);
});

test('upsertProjectMapping merges existing mapping and dedupes tickets and keywords', async () => {
  await useTempHelperHome();
  await fs.mkdir(helperHome(), { recursive: true });
  await fs.writeFile(userConfigPath(), JSON.stringify({
    projectMappings: [
      {
        projectName: '2621A-SIT-HTML BUILDER-PRJ',
        projectMemberId: 5234,
        tickets: ['SCB'],
        keywords: ['question bank']
      }
    ]
  }), 'utf8');

  const result = await upsertProjectMapping({
    projectName: 'HTML BUILDER',
    tickets: ['SCB', 'scb', 'NEW'],
    keywords: ['programme', 'question bank'],
    confirm: true,
    fetchProjects: async () => projects
  });

  assert.equal(result.status, 'updated');
  assert.deepEqual(result.mapping.tickets, ['SCB', 'NEW']);
  assert.deepEqual(result.mapping.keywords, ['question bank', 'programme']);
});

test('upsertProjectMapping rejects invalid project without writing config', async () => {
  const home = await useTempHelperHome();

  await assert.rejects(
    () => upsertProjectMapping({
      projectMemberId: 9999,
      tickets: ['SCB'],
      confirm: true,
      fetchProjects: async () => projects
    }),
    /was not found/
  );

  await assert.rejects(
    () => fs.readFile(join(home, '.logwork-helper.json'), 'utf8'),
    /ENOENT/
  );
});

test('upsertProjectMapping requires explicit confirm true', async () => {
  await assert.rejects(
    () => upsertProjectMapping({
      projectMemberId: 5234,
      tickets: ['SCB'],
      confirm: false,
      fetchProjects: async () => projects
    }),
    /confirm: true/
  );
});

test('listLogworkProjects returns memberships and current mappings', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logwork-helper-project-'));
  const home = await useTempHelperHome();
  await upsertProjectMapping({
    cwd,
    projectMemberId: 5234,
    tickets: ['SCB'],
    confirm: true,
    fetchProjects: async () => projects
  });

  const result = await listLogworkProjects({
    cwd,
    fetchProjects: async () => projects
  });

  assert.deepEqual(result.projects, projects);
  assert.equal(result.mappings.length, 1);
  assert.equal(result.configSources.user, join(home, '.logwork-helper.json'));
  assert.equal(result.configSources.project, join(cwd, '.logwork-helper.json'));
  assert.match(result.summary, /Found 1 Resource Optimiser project memberships/);
});

test('Both preview ranks Jira project matches as explicit RO mapping suggestions', () => {
  const roPreview = {
    summary: 'RO preview unresolved.',
    setupSuggestions: [
      {
        entryId: '2026-06-01-01',
        ticketPrefixes: ['SCB'],
        candidateProjects: [
          {
            projectMemberId: 5234,
            projectId: 643,
            projectName: '2621A-SIT-HTML BUILDER-PRJ',
            toolArguments: {
              projectMemberId: 5234,
              tickets: ['SCB'],
              keywords: [],
              confirm: true
            }
          },
          {
            projectMemberId: 9000,
            projectId: 900,
            projectName: 'Internal Operations',
            toolArguments: {
              projectMemberId: 9000,
              tickets: ['SCB'],
              keywords: [],
              confirm: true
            }
          }
        ]
      }
    ]
  };
  const jiraPreview = {
    entries: [
      {
        id: '2026-06-01-01',
        issueKey: 'SCB-213',
        issue: {
          project: {
            key: 'SCB',
            name: 'HTML Builder'
          }
        }
      }
    ]
  };

  const enriched = enrichRoPreviewWithJiraProjects(roPreview, jiraPreview);

  assert.equal(enriched.jiraMappingSuggestions.length, 1);
  assert.equal(enriched.jiraMappingSuggestions[0].recommendation.projectMemberId, 5234);
  assert.equal(enriched.jiraMappingSuggestions[0].recommendation.reason, 'jira_project_name_contains');
  assert.match(enriched.summary, /Jira-assisted RO mapping suggestions/);
  assert.match(enriched.summary, /Confirm with \/map SCB 5234/);
});

test('upsertProjectMapping can write project scoped mapping explicitly', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logwork-helper-project-'));
  await useTempHelperHome();

  const result = await upsertProjectMapping({
    cwd,
    scope: 'project',
    projectMemberId: 5234,
    tickets: ['SCB'],
    confirm: true,
    fetchProjects: async () => projects
  });

  assert.equal(result.scope, 'project');
  assert.equal(result.configPath, join(cwd, '.logwork-helper.json'));
  assert.equal(JSON.parse(await fs.readFile(join(cwd, '.logwork-helper.json'), 'utf8')).projectMappings.length, 1);
});

test('config paths default to helper home and support project scope', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logwork-helper-project-'));
  const home = await useTempHelperHome();

  assert.equal(helperHome(), home);
  assert.equal(userConfigPath(), join(home, '.logwork-helper.json'));
  assert.equal(configPath(cwd), join(home, '.logwork-helper.json'));
  assert.equal(configPath(cwd, 'project'), join(cwd, '.logwork-helper.json'));
});

test('normalizeConfig cleans mapping arrays and drops mappings without project identity', () => {
  assert.deepEqual(normalizeConfig({
    projectMappings: [
      {
        projectName: '  Course Builder  ',
        projectMemberId: ' 5234 ',
        tickets: [' scb ', 'SCB', '', 123, 'ops'],
        keywords: [' question bank ', 'Question Bank', '', null, 'support']
      },
      {
        tickets: ['DROP']
      }
    ]
  }), {
    projectMappings: [
      {
        projectName: 'Course Builder',
        projectMemberId: '5234',
        tickets: ['SCB', 'OPS'],
        keywords: ['question bank', 'support']
      }
    ]
  });
});

test('loadLocalConfig reads legacy home mapping and upsert migrates it into helper home', async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), 'logwork-helper-legacy-home-'));
  process.env.HOME = fakeHome;
  const helperHomePath = await useTempHelperHome({ preserveHome: true });
  await fs.writeFile(legacyUserConfigPath(), JSON.stringify({
    projectMappings: [
      {
        projectName: '2621A-SIT-HTML BUILDER-PRJ',
        projectMemberId: 5234,
        tickets: ['SCB'],
        keywords: ['legacy']
      }
    ]
  }), 'utf8');

  assert.equal((await loadLocalConfig()).projectMappings[0].keywords[0], 'legacy');

  const result = await upsertProjectMapping({
    projectMemberId: 5234,
    tickets: ['NEW'],
    keywords: ['current'],
    confirm: true,
    fetchProjects: async () => projects
  });

  assert.equal(result.configPath, join(helperHomePath, '.logwork-helper.json'));
  assert.deepEqual(result.mapping.tickets, ['SCB', 'NEW']);
  assert.deepEqual(result.mapping.keywords, ['legacy', 'current']);
});

test('loadLocalConfig merges duplicate mappings across legacy, user, and project sources', async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), 'logwork-helper-legacy-home-'));
  process.env.HOME = fakeHome;
  await useTempHelperHome({ preserveHome: true });
  const cwd = await mkdtemp(join(tmpdir(), 'logwork-helper-project-'));
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(legacyUserConfigPath(), JSON.stringify({
    projectMappings: [
      {
        projectName: 'Legacy Course Builder',
        projectMemberId: 5234,
        tickets: ['scb'],
        keywords: ['legacy']
      }
    ]
  }), 'utf8');
  await fs.writeFile(userConfigPath(), JSON.stringify({
    projectMappings: [
      {
        projectName: 'User Course Builder',
        projectMemberId: 5234,
        tickets: ['NEW', 'scb'],
        keywords: ['legacy', 'user']
      }
    ]
  }), 'utf8');
  await fs.writeFile(join(cwd, '.logwork-helper.json'), JSON.stringify({
    projectMappings: [
      {
        projectName: 'Project Course Builder',
        projectMemberId: 5234,
        tickets: ['PRJ'],
        keywords: ['project']
      }
    ]
  }), 'utf8');

  const config = await loadLocalConfig(cwd);

  assert.deepEqual(config.projectMappings, [
    {
      projectName: 'Project Course Builder',
      projectMemberId: 5234,
      tickets: ['SCB', 'NEW', 'PRJ'],
      keywords: ['legacy', 'user', 'project']
    }
  ]);
});

async function useTempHelperHome({ preserveHome = false } = {}) {
  if (!preserveHome) {
    process.env.HOME = await mkdtemp(join(tmpdir(), 'logwork-helper-test-home-'));
  }
  const home = await mkdtemp(join(tmpdir(), 'logwork-helper-home-'));
  process.env.LOGWORK_HELPER_HOME = home;
  return home;
}
