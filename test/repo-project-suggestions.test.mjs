import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bookedProjectsByDateFromQuery,
  formatSuggestionReason,
  historyFromQueryResult,
  MAX_REPO_SUGGESTIONS,
  meaningfulTokens,
  orderProjectsForPicker,
  projectNameKeys,
  rankRepoProjects,
  remoteRepoPath,
  suggestRepoProjects,
  tokenizeName
} from '../lib/repo-project-suggestions.mjs';

const FCS = { projectMemberId: 501, projectId: 51, projectName: 'GKE Fair Chem System (FCS)' };
const PORTAL = { projectMemberId: 502, projectId: 52, projectName: 'Customer Portal' };
const HOSTING = { projectMemberId: 503, projectId: 53, projectName: 'Managed Hosting' };
const CANDIDATES = [PORTAL, HOSTING, FCS];

test('names are tokenized on separators and camelCase, lowercase', () => {
  assert.deepEqual(tokenizeName('fcs-web_app.v2/FairChemAPI'), ['fcs', 'web', 'app', 'v2', 'fair', 'chem', 'api']);
  assert.deepEqual(tokenizeName('FCSWeb'), ['fcs', 'web']);
  assert.deepEqual(meaningfulTokens('the-fcs-frontend-app'), ['fcs']);
  assert.deepEqual(meaningfulTokens('2621A SIT HTML Builder PRJ'), ['2621a', 'html', 'builder']);
});

test('project name keys include the acronym in parentheses and word initials', () => {
  const keys = projectNameKeys('GKE Fair Chem System (FCS)');
  assert.deepEqual(keys.acronyms, ['fcs']);
  assert.deepEqual(keys.initials, ['gfcs']);
  assert.deepEqual(keys.tokens, ['gke', 'fair', 'chem', 'system', 'fcs']);
  // Initials without stop words too: "The Customer Portal App" -> tcpa and cp.
  assert.deepEqual(projectNameKeys('The Customer Portal App').initials, ['tcpa', 'cp']);
  assert.deepEqual(projectNameKeys('Hosting').initials, []);
});

test('remote URLs reduce to their repo path without host and .git', () => {
  assert.equal(remoteRepoPath('git@github.com:acme/fcs-web.git'), 'acme/fcs-web');
  assert.equal(remoteRepoPath('https://gitlab.example.com/group/sub/fcs-api.git'), 'group/sub/fcs-api');
  assert.equal(remoteRepoPath('ssh://git@host:2222/team/portal'), 'team/portal');
  assert.equal(remoteRepoPath('/srv/git/local-repo.git'), 'srv/git/local-repo');
  assert.equal(remoteRepoPath(''), '');
});

test('ticket history beats a name match', () => {
  const suggestions = suggestRepoProjects({
    repoPath: '/work/fcs-web',
    repoGroups: [{ tickets: ['CP-12'], date: '2026-11-05' }],
    candidates: CANDIDATES,
    history: [
      { date: '2026-11-02', ...PORTAL, text: 'Feature Development Checkout flow (CP-12)' },
      { date: '2026-11-03', ...PORTAL, text: 'Bug Fix login (CP-12)' },
      { date: '2026-11-03', ...HOSTING, text: 'Other Activities unrelated (OPS-1)' }
    ]
  });
  assert.deepEqual(suggestions.map((item) => item.projectName), ['Customer Portal', 'GKE Fair Chem System (FCS)']);
  assert.ok(suggestions[0].score > suggestions[1].score);
  assert.deepEqual(suggestions[0].reasons, ['ticket CP-12 was logged to this project on 2026-11-03']);
  assert.deepEqual(suggestions[1].reasons, ['repo name matches FCS']);
  assert.equal(suggestions[0].projectMemberId, 502);
  assert.equal(suggestions[0].projectId, 52);
});

test('more matching tickets raise the ticket score', () => {
  const ranked = rankRepoProjects({
    repoGroups: [{ tickets: ['CP-1', 'CP-2'] }, { tickets: ['MH-1'] }],
    candidates: CANDIDATES,
    history: [
      { date: '2026-11-01', ...PORTAL, text: 'x (CP-1)' },
      { date: '2026-11-02', ...PORTAL, text: 'y (CP-2)' },
      { date: '2026-11-02', ...HOSTING, text: 'z (MH-1)' }
    ]
  });
  assert.equal(ranked[0].projectName, 'Customer Portal');
  assert.ok(ranked[0].score > ranked[1].score);
  assert.equal(ranked[0].reasons.length, 2);
});

test('the acronym in parentheses matches the repo name or the git remote', () => {
  const byFolder = suggestRepoProjects({ repoPath: '/work/fcs-frontend', candidates: CANDIDATES });
  assert.equal(byFolder[0].projectName, FCS.projectName);
  assert.deepEqual(byFolder[0].reasons, ['repo name matches FCS']);

  const byRemote = suggestRepoProjects({
    repoPath: 'C:\\work\\client-app',
    remoteUrl: 'git@github.com:acme/FCSPlatform.git',
    candidates: CANDIDATES
  });
  assert.equal(byRemote[0].projectName, FCS.projectName);
  assert.deepEqual(byRemote[0].reasons, ['git remote matches FCS']);
});

test('word initials of the project name match the repo name', () => {
  const suggestions = suggestRepoProjects({ repoPath: '/work/cp-mobile', candidates: CANDIDATES });
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].projectName, 'Customer Portal');
  assert.deepEqual(suggestions[0].reasons, ['repo name matches the initials CP of the project name']);
});

test('shared name tokens count; stop words never do', () => {
  const shared = suggestRepoProjects({ repoPath: '/work/hosting-scripts', candidates: CANDIDATES });
  assert.equal(shared[0].projectName, 'Managed Hosting');
  assert.deepEqual(shared[0].reasons, ['repo name shares "hosting" with the project name']);

  // Every token of these names is a stop word.
  const stopWords = [
    { projectMemberId: 1, projectName: 'Web App Project (API)' },
    { projectMemberId: 2, projectName: 'Mobile Backend Service UAT' }
  ];
  assert.deepEqual(suggestRepoProjects({ repoPath: '/work/the-web-app-api-fe-be', remoteUrl: 'https://github.com/org/mobile-backend-service.git', candidates: stopWords }), []);
});

test('a single booked project on the repo commit days is evidence', () => {
  const suggestions = suggestRepoProjects({
    repoPath: '/work/misc',
    repoGroups: [{ date: '2026-11-05' }, { date: '2026-11-06' }],
    candidates: CANDIDATES,
    bookedProjectsByDate: {
      '2026-11-05': [{ ...HOSTING, bookedHours: 8 }],
      '2026-11-06': [{ ...HOSTING, bookedHours: 4 }]
    }
  });
  assert.deepEqual(suggestions.map((item) => item.projectName), ['Managed Hosting']);
  assert.deepEqual(suggestions[0].reasons, ["the only project booked on this repo's commit days (2026-11-05, 2026-11-06)"]);

  // Two booked projects across the days: no evidence.
  assert.deepEqual(suggestRepoProjects({
    repoPath: '/work/misc',
    repoGroups: [{ date: '2026-11-05' }, { date: '2026-11-06' }],
    candidates: CANDIDATES,
    bookedProjectsByDate: { '2026-11-05': [HOSTING], '2026-11-06': [PORTAL] }
  }), []);
});

test('without evidence every candidate stays, unranked, and nothing is suggested', () => {
  const ranked = rankRepoProjects({ repoPath: '/work/zzz', candidates: CANDIDATES });
  assert.deepEqual(ranked.map((item) => item.projectName), CANDIDATES.map((item) => item.projectName));
  assert.ok(ranked.every((item) => item.score === 0 && item.reasons.length === 0));
  assert.deepEqual(suggestRepoProjects({ repoPath: '/work/zzz', candidates: CANDIDATES }), []);

  const picker = orderProjectsForPicker(CANDIDATES, []);
  assert.deepEqual(picker.map((item) => item.project.projectName), CANDIDATES.map((item) => item.projectName));
});

test('suggestions are capped and the picker lists suggestions first, then the rest', () => {
  const many = Array.from({ length: 8 }, (_, index) => ({ projectMemberId: index + 1, projectName: `Shop ${index + 1}` }));
  const suggestions = suggestRepoProjects({ repoPath: '/work/shop', candidates: many });
  assert.equal(suggestions.length, MAX_REPO_SUGGESTIONS);

  const top = suggestRepoProjects({ repoPath: '/work/fcs', candidates: CANDIDATES });
  const picker = orderProjectsForPicker([...CANDIDATES, { ...PORTAL }], top);
  assert.deepEqual(picker.map((item) => item.project.projectName), [FCS.projectName, PORTAL.projectName, HOSTING.projectName]);
  assert.equal(picker[0].suggestion, top[0]);
  assert.equal(picker[1].suggestion, null);
  assert.equal(formatSuggestionReason(top[0]), 'repo name matches FCS');
});

test('history and bookings are read from a queryLogwork result', () => {
  const query = {
    entries: [
      { date: '2026-11-03', ...FCS, taskName: 'Bug Fix', description: 'fix (FCS-12)' },
      { date: '2026-11-03', taskName: 'Nameless', description: 'no project' },
      { date: '2026-11-04', ...PORTAL, taskName: '', description: '' }
    ],
    days: [{ date: '2026-11-03', projects: [{ ...FCS, bookedHours: 8 }, { ...PORTAL, bookedHours: 0 }] }]
  };
  assert.deepEqual(historyFromQueryResult(query), [
    { date: '2026-11-03', projectName: FCS.projectName, projectMemberId: 501, projectId: 51, text: 'Bug Fix fix (FCS-12)' }
  ]);
  assert.deepEqual(historyFromQueryResult(null), []);
  assert.deepEqual(bookedProjectsByDateFromQuery(query), { '2026-11-03': [{ ...FCS, bookedHours: 8 }] });
});
