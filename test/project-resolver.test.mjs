import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEntryProject } from '../lib/project-resolver.mjs';

const entry = {
  id: '2026-06-01-01',
  taskName: 'Create question set UI/API integration (SCB-231)',
  tickets: ['SCB-231']
};

test('resolveEntryProject resolves a single booked project', () => {
  const result = resolveEntryProject({
    entry,
    projects: [{ projectMemberId: 1, projectId: 10, projectName: 'SCB' }]
  });

  assert.equal(result.status, 'resolved');
  assert.equal(result.project.projectMemberId, 1);
  assert.equal(result.reason, 'single_booked_project');
  assert.equal(result.booked, true);
  assert.equal(result.requiresAllowUnbooked, false);
});

test('resolveEntryProject prefers config mapping over single booked fallback', () => {
  const result = resolveEntryProject({
    entry,
    projects: [{ projectMemberId: 2, projectId: 20, projectName: 'Course Builder' }],
    config: {
      projectMappings: [
        { projectMemberId: 2, projectName: 'Course Builder', tickets: ['SCB'] }
      ]
    }
  });

  assert.equal(result.status, 'resolved');
  assert.equal(result.project.projectMemberId, 2);
  assert.equal(result.reason, 'config_ticket');
  assert.equal(result.booked, true);
});

test('resolveEntryProject blocks single booked fallback when ticket maps elsewhere', () => {
  const result = resolveEntryProject({
    entry,
    projects: [
      { projectMemberId: 1, projectId: 10, projectName: 'Internal' }
    ],
    membershipProjects: [
      { projectMemberId: 2, projectId: 20, projectName: 'Course Builder' }
    ],
    config: {
      projectMappings: [
        { projectMemberId: 2, projectName: 'Course Builder', tickets: ['SCB'] }
      ]
    }
  });

  assert.equal(result.status, 'unresolved');
  assert.equal(result.reason, 'single_booked_project_conflicts_with_mapping');
  assert.equal(result.confidence, 0.99);
  assert.deepEqual(result.candidates, [
    {
      projectMemberId: 2,
      projectId: 20,
      projectName: 'Course Builder',
      booked: false,
      confidence: 0.99,
      source: 'config_ticket'
    },
    {
      projectMemberId: 1,
      projectId: 10,
      projectName: 'Internal',
      booked: true,
      confidence: 0.95,
      source: 'single_booked_project'
    }
  ]);
});

test('resolveEntryProject resolves via config ticket prefix', () => {
  const result = resolveEntryProject({
    entry,
    projects: [
      { projectMemberId: 1, projectId: 10, projectName: 'Internal' },
      { projectMemberId: 2, projectId: 20, projectName: 'Course Builder' }
    ],
    config: {
      projectMappings: [
        { projectName: 'Course Builder', tickets: ['SCB'] }
      ]
    }
  });

  assert.equal(result.status, 'resolved');
  assert.equal(result.project.projectMemberId, 2);
  assert.equal(result.reason, 'config_ticket');
});

test('resolveEntryProject marks ambiguous matches unresolved', () => {
  const result = resolveEntryProject({
    entry: {
      ...entry,
      taskName: 'Question filter cleanup',
      tickets: []
    },
    projects: [
      { projectMemberId: 1, projectId: 10, projectName: 'Question Bank' },
      { projectMemberId: 2, projectId: 20, projectName: 'Question Set' }
    ]
  });

  assert.equal(result.status, 'unresolved');
  assert.equal(result.reason, 'ambiguous_project_match');
});

test('resolveEntryProject keeps ambiguous keyword matches unresolved', () => {
  const result = resolveEntryProject({
    entry: {
      ...entry,
      taskName: 'Question filter cleanup',
      tickets: []
    },
    projects: [
      { projectMemberId: 1, projectId: 10, projectName: 'Question Bank' },
      { projectMemberId: 2, projectId: 20, projectName: 'Question Set' }
    ],
    config: {
      projectMappings: [
        { projectMemberId: 1, projectName: 'Question Bank', keywords: ['question'] },
        { projectMemberId: 2, projectName: 'Question Set', keywords: ['question'] }
      ]
    }
  });

  assert.equal(result.status, 'unresolved');
  assert.equal(result.reason, 'ambiguous_project_match');
  assert.equal(result.confidence, 0.98);
});

test('resolveEntryProject resolves unbooked project from ticket mapping and membership', () => {
  const result = resolveEntryProject({
    entry,
    projects: [],
    membershipProjects: [
      { projectMemberId: 5234, projectId: 643, projectName: '2621A-SIT-HTML BUILDER-PRJ' }
    ],
    config: {
      projectMappings: [
        { projectName: '2621A-SIT-HTML BUILDER-PRJ', tickets: ['SCB'] }
      ]
    }
  });

  assert.equal(result.status, 'resolved_unbooked');
  assert.equal(result.project.projectMemberId, 5234);
  assert.equal(result.project.projectId, 643);
  assert.equal(result.booked, false);
  assert.equal(result.requiresAllowUnbooked, true);
  assert.equal(result.reason, 'config_ticket_unbooked');
});

test('resolveEntryProject treats valid unbooked override as resolved_unbooked', () => {
  const result = resolveEntryProject({
    entry,
    projects: [],
    membershipProjects: [
      { projectMemberId: 5234, projectId: 643, projectName: '2621A-SIT-HTML BUILDER-PRJ' }
    ],
    projectOverrides: {
      [entry.id]: 5234
    }
  });

  assert.equal(result.status, 'resolved_unbooked');
  assert.equal(result.reason, 'override_unbooked');
  assert.equal(result.project.projectMemberId, 5234);
});

test('resolveEntryProject rejects override missing from bookings and memberships', () => {
  const result = resolveEntryProject({
    entry,
    projects: [],
    membershipProjects: [
      { projectMemberId: 5234, projectId: 643, projectName: '2621A-SIT-HTML BUILDER-PRJ' }
    ],
    projectOverrides: {
      [entry.id]: 9999
    }
  });

  assert.equal(result.status, 'unresolved');
  assert.equal(result.reason, 'override_not_found');
});

test('resolveEntryProject keeps booked flags and deduplicates invalid override candidates', () => {
  const result = resolveEntryProject({
    entry,
    projects: [
      { projectMemberId: 1, projectId: 10, projectName: 'Booked Project' }
    ],
    membershipProjects: [
      { projectMemberId: 1, projectId: 10, projectName: 'Booked Project' },
      { projectMemberId: 2, projectId: 20, projectName: 'Membership Project' }
    ],
    projectOverrides: {
      [entry.id]: 9999
    }
  });

  assert.equal(result.status, 'unresolved');
  assert.deepEqual(result.candidates, [
    {
      projectMemberId: 1,
      projectId: 10,
      projectName: 'Booked Project',
      booked: true,
      confidence: 0,
      source: 'none'
    },
    {
      projectMemberId: 2,
      projectId: 20,
      projectName: 'Membership Project',
      booked: false,
      confidence: 0,
      source: 'none'
    }
  ]);
});
