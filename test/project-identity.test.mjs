import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nextIndex,
  previousIndex,
  moveIndex
} from '../lib/list-navigation.mjs';
import {
  normalizeProjectName,
  projectIdentityKey,
  projectMatchesFilter,
  projectMatchesMapping,
  sameProjectIdentity
} from '../lib/project-identity.mjs';

test('project identity helpers compare ids before normalized names', () => {
  assert.equal(sameProjectIdentity({ projectMemberId: 5234 }, { projectMemberId: '5234' }), true);
  assert.equal(sameProjectIdentity({ projectId: 643 }, { projectId: '643' }), true);
  assert.equal(sameProjectIdentity({ projectName: ' Course   Builder ' }, { projectName: 'course builder' }), true);
  assert.equal(sameProjectIdentity({ projectMemberId: 5234 }, { projectMemberId: 7777, projectName: 'Course Builder' }), false);
  assert.equal(projectIdentityKey({ projectMemberId: 5234, projectName: 'Course Builder' }), '5234');
  assert.equal(projectIdentityKey({ projectName: ' Course   Builder ' }), 'course builder');
});

test('project identity helpers support filter and mapping matches', () => {
  const project = {
    projectMemberId: 5234,
    projectId: 643,
    projectName: '2621A-SIT-HTML Builder-PRJ'
  };

  assert.equal(normalizeProjectName('  HTML   Builder  '), 'html builder');
  assert.equal(projectMatchesFilter(project, '5234'), true);
  assert.equal(projectMatchesFilter(project, 'html builder'), true);
  assert.equal(projectMatchesMapping(project, { projectMemberId: '5234' }), true);
  assert.equal(projectMatchesMapping(project, { projectName: 'HTML Builder' }), true);
  assert.equal(projectMatchesMapping(project, { projectName: 'HTML Builder' }, { allowNameContains: false }), false);
  assert.equal(projectMatchesMapping(project, { projectMemberId: '7777', projectName: 'HTML Builder' }), false);
  assert.equal(projectMatchesMapping(project, { projectMemberId: '7777', projectName: 'HTML Builder' }, { fallbackToName: true }), true);
});

test('list navigation helpers wrap and handle empty lists', () => {
  assert.equal(previousIndex(0, 3), 2);
  assert.equal(nextIndex(2, 3), 0);
  assert.equal(moveIndex(0, 3, -2), 1);
  assert.equal(moveIndex(10, 3, 1), 2);
  assert.equal(nextIndex(0, 0), 0);
});
