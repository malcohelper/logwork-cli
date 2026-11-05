import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyLogworkBatch,
  attachWorklogTaskTargets,
  buildLogworkBatchPreview,
  previewLogworkBatch
} from '../lib/batch-workflow.mjs';
import { parseWeeklyLogText } from '../lib/batch-parser.mjs';

const weeklyText = `Monday, 01 Jun 2026
+2 Maintenance mode management and status UI (SCB-213)
+1 System page updates`;

const parsed = parseWeeklyLogText(weeklyText);
const projectsByDate = new Map([
  ['2026-06-01', [{ projectMemberId: 5352, projectId: 1, projectName: 'Course Builder' }]]
]);

test('buildLogworkBatchPreview returns ready batch with totals', () => {
  const preview = buildLogworkBatchPreview({ parsed, projectsByDate });

  assert.equal(preview.status, 'ready');
  assert.equal(preview.entries.length, 2);
  assert.deepEqual(preview.entries[0].resolution, {
    status: 'resolved',
    reason: 'single_booked_project',
    confidence: 0.95,
    booked: true,
    autoResolved: true,
    requiresUserChoice: false,
    requiresAllowUnbooked: false,
    candidates: []
  });
  assert.deepEqual(preview.totalsByDate, { '2026-06-01': 3 });
  assert.deepEqual(preview.totalsByProject, { 'Course Builder': 3 });
  assert.deepEqual(preview.approvalSummary, {
    entryCount: 2,
    totalHours: 3,
    dateRange: { from: '2026-06-01', to: '2026-06-01' },
    projectCount: 1,
    projects: [
      {
        projectMemberId: 5352,
        projectId: 1,
        projectName: 'Course Builder',
        hours: 3,
        entries: 2,
        unbookedEntries: 0,
        unresolvedEntries: 0
      }
    ],
    unresolvedEntries: 0,
    unbookedEntries: 0,
    requiresUserChoice: false,
    requiresAllowUnbooked: false,
    confirmRequired: true,
    canApply: true
  });
  assert.match(preview.summary, /via single_booked_project, confidence 0.95/);
  assert.match(preview.summary, /Approval checklist: 2 entries, 3h total, 2026-06-01/);
  assert.match(preview.summary, /Projects: Course Builder: 3h/);
});

test('buildLogworkBatchPreview marks mapped membership without booking as ready_with_unbooked', () => {
  const unbookedParsed = parseWeeklyLogText(`Monday, 01 Jun 2026
+2 Maintenance mode management and status UI (SCB-213)`.replace('++', '+'));
  const preview = buildLogworkBatchPreview({
    parsed: unbookedParsed,
    projectsByDate: new Map([['2026-06-01', []]]),
    membershipProjects: [
      { projectMemberId: 5234, projectId: 643, projectName: '2621A-SIT-HTML BUILDER-PRJ' }
    ],
    config: {
      projectMappings: [
        { projectName: '2621A-SIT-HTML BUILDER-PRJ', tickets: ['SCB'] }
      ]
    }
  });

  assert.equal(preview.status, 'ready_with_unbooked');
  assert.equal(preview.entries[0].status, 'resolved_unbooked');
  assert.equal(preview.entries[0].booked, false);
  assert.equal(preview.entries[0].requiresAllowUnbooked, true);
  assert.equal(preview.entries[0].resolution.requiresAllowUnbooked, true);
  assert.equal(preview.entries[0].resolution.autoResolved, true);
  assert.equal(preview.entries[0].matchedProject.projectMemberId, 5234);
  assert.equal(preview.approvalSummary.requiresAllowUnbooked, true);
  assert.equal(preview.approvalSummary.canApply, true);
  assert.equal(preview.approvalSummary.projects[0].unbookedEntries, 1);
  assert.match(preview.summary, /UNBOOKED: \+2h/);
});

test('buildLogworkBatchPreview keeps ticket mapping conflicts unresolved', async () => {
  const conflictParsed = parseWeeklyLogText(`Monday, 01 Jun 2026
+2 Maintenance mode management and status UI (SCB-213)`);
  const preview = buildLogworkBatchPreview({
    parsed: conflictParsed,
    projectsByDate: new Map([[
      '2026-06-01',
      [{ projectMemberId: 1, projectId: 10, projectName: 'Internal' }]
    ]]),
    membershipProjects: [
      { projectMemberId: 5234, projectId: 643, projectName: '2621A-SIT-HTML BUILDER-PRJ' }
    ],
    config: {
      projectMappings: [
        { projectMemberId: 5234, projectName: '2621A-SIT-HTML BUILDER-PRJ', tickets: ['SCB'] }
      ]
    }
  });

  assert.equal(preview.status, 'unresolved');
  assert.equal(preview.entries[0].matchedProject, null);
  assert.equal(preview.entries[0].reason, 'single_booked_project_conflicts_with_mapping');
  assert.equal(preview.entries[0].resolution.requiresUserChoice, true);
  assert.equal(preview.entries[0].resolution.autoResolved, false);
  assert.equal(preview.approvalSummary.requiresUserChoice, true);
  assert.equal(preview.approvalSummary.canApply, false);
  assert.equal(preview.approvalSummary.projects[0].projectName, 'UNRESOLVED');
  assert.deepEqual(preview.entries[0].candidates.map((candidate) => candidate.source), [
    'config_ticket',
    'single_booked_project'
  ]);
  assert.match(preview.summary, /needs user choice single_booked_project_conflicts_with_mapping, confidence 0.99/);

  await assert.rejects(
    () => applyLogworkBatch({
      batch: preview,
      confirm: true,
      submitEntry: async () => ({ dryRun: true })
    }),
    /unresolved/
  );
});

test('buildLogworkBatchPreview suggests mapping setup for unresolved ticket entries', () => {
  const unbookedParsed = parseWeeklyLogText(`Monday, 01 Jun 2026
+2 Maintenance mode management and status UI (SCB-213)`.replace('++', '+'));
  const preview = buildLogworkBatchPreview({
    parsed: unbookedParsed,
    projectsByDate: new Map([['2026-06-01', []]]),
    membershipProjects: [
      { projectMemberId: 5234, projectId: 643, projectName: '2621A-SIT-HTML BUILDER-PRJ' }
    ]
  });

  assert.equal(preview.status, 'unresolved');
  assert.equal(preview.setupSuggestions.length, 1);
  assert.equal(preview.setupSuggestions[0].ticketPrefixes[0], 'SCB');
  assert.deepEqual(preview.setupSuggestions[0].candidateProjects[0].toolArguments, {
    projectMemberId: 5234,
    tickets: ['SCB'],
    keywords: [],
    confirm: true
  });
  assert.match(preview.summary, /upsert_project_mapping/);
});

test('applyLogworkBatch requires confirm true', async () => {
  const preview = buildLogworkBatchPreview({ parsed, projectsByDate });

  await assert.rejects(
    () => applyLogworkBatch({
      batch: preview,
      confirm: false,
      submitEntry: async () => ({ dryRun: true })
    }),
    /confirm: true/
  );
});

test('applyLogworkBatch blocks unresolved entries', async () => {
  const preview = buildLogworkBatchPreview({
    parsed,
    projectsByDate: new Map([['2026-06-01', []]])
  });

  await assert.rejects(
    () => applyLogworkBatch({
      batch: preview,
      confirm: true,
      submitEntry: async () => ({ dryRun: true })
    }),
    /unresolved/
  );
});

test('applyLogworkBatch submits one payload per line', async () => {
  const preview = buildLogworkBatchPreview({ parsed, projectsByDate });
  const payloads = [];

  const result = await applyLogworkBatch({
    batch: preview,
    confirm: true,
    submitEntry: async (payload) => {
      payloads.push(payload);
      return { dryRun: true, body: payload };
    },
    verifyLogwork: async () => {
      throw new Error('dry run should not verify');
    }
  });

  assert.equal(result.status, 'submitted');
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.submissionSummary, {
    entryCount: 2,
    totalHours: 3,
    dryRun: true,
    dates: ['2026-06-01'],
    projects: [
      { projectName: 'Course Builder', hours: 3 }
    ]
  });
  assert.match(result.summary, /Submitted 2 entries, 3h total/);
  assert.equal(payloads.length, 2);
  assert.deepEqual(payloads[0], {
    projectMemberId: 5352,
    projectId: 1,
    logtimes: 2,
    taskName: 'Maintenance mode management and status UI (SCB-213)',
    localDateISO: '2026-06-01',
    worklogTaskId: undefined,
    worklogNeedsProjectId: undefined,
    taskCache: payloads[0].taskCache
  });
  assert.ok(payloads[0].taskCache instanceof Map);
  assert.equal(result.verification, null);
});

test('applyLogworkBatch records a sanitized ledger outcome when a writer is provided', async () => {
  const preview = buildLogworkBatchPreview({ parsed, projectsByDate });
  const ledgerCalls = [];
  const result = await applyLogworkBatch({
    batch: preview,
    confirm: true,
    ledgerContext: { flowTarget: 'both' },
    submitEntry: async () => ({ dryRun: true }),
    recordLedger: async (record) => {
      ledgerCalls.push(record);
      return { id: 'ledger-ro' };
    }
  });

  assert.deepEqual(result.ledger, {
    status: 'recorded',
    recorded: true,
    recordId: 'ledger-ro'
  });
  assert.equal(ledgerCalls[0].target, 'ro');
  assert.equal(ledgerCalls[0].flowTarget, 'both');
  assert.equal(ledgerCalls[0].entries.length, 2);
});

test('applyLogworkBatch blocks unbooked entries without allowUnbooked true', async () => {
  const unbookedParsed = parseWeeklyLogText(`Monday, 01 Jun 2026
+2 Maintenance mode management and status UI (SCB-213)`.replace('++', '+'));
  const preview = buildLogworkBatchPreview({
    parsed: unbookedParsed,
    projectsByDate: new Map([['2026-06-01', []]]),
    membershipProjects: [
      { projectMemberId: 5234, projectId: 643, projectName: '2621A-SIT-HTML BUILDER-PRJ' }
    ],
    config: {
      projectMappings: [
        { projectName: '2621A-SIT-HTML BUILDER-PRJ', tickets: ['SCB'] }
      ]
    }
  });
  const payloads = [];

  await assert.rejects(
    () => applyLogworkBatch({
      batch: preview,
      confirm: true,
      submitEntry: async (payload) => {
        payloads.push(payload);
        return { dryRun: true };
      }
    }),
    /allowUnbooked: true/
  );
  assert.equal(payloads.length, 0);
});

test('applyLogworkBatch submits unbooked entries with allowUnbooked true', async () => {
  const unbookedParsed = parseWeeklyLogText(`Monday, 01 Jun 2026
+2 Maintenance mode management and status UI (SCB-213)`.replace('++', '+'));
  const preview = buildLogworkBatchPreview({
    parsed: unbookedParsed,
    projectsByDate: new Map([['2026-06-01', []]]),
    membershipProjects: [
      { projectMemberId: 5234, projectId: 643, projectName: '2621A-SIT-HTML BUILDER-PRJ' }
    ],
    config: {
      projectMappings: [
        { projectName: '2621A-SIT-HTML BUILDER-PRJ', tickets: ['SCB'] }
      ]
    }
  });
  const payloads = [];

  const result = await applyLogworkBatch({
    batch: preview,
    confirm: true,
    allowUnbooked: true,
    submitEntry: async (payload) => {
      payloads.push(payload);
      return { dryRun: true, body: payload };
    }
  });

  assert.equal(result.status, 'submitted');
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].projectMemberId, 5234);
  assert.equal(payloads[0].projectId, 643);
  assert.equal(payloads[0].taskName, 'Maintenance mode management and status UI (SCB-213)');
});

test('attachWorklogTaskTargets marks missing RO tasks as unresolved', async () => {
  const preview = buildLogworkBatchPreview({ parsed, projectsByDate });
  const enriched = await attachWorklogTaskTargets(preview, {
    fetchWorklogTasks: async () => []
  });

  assert.equal(enriched.status, 'unresolved');
  assert.equal(enriched.entries[0].reason, 'task_not_found');
  assert.equal(enriched.approvalSummary.canApply, false);
});

test('previewLogworkBatch resolves worklog tasks when names match', async () => {
  const preview = await previewLogworkBatch({
    text: weeklyText,
    fetchProjects: async () => projectsByDate.get('2026-06-01'),
    fetchWorklogTasks: async () => [
      {
        id: 88,
        name: 'Maintenance mode management and status UI (SCB-213)',
        project_id: 1
      },
      {
        id: 89,
        name: 'System page updates',
        project_id: 1
      }
    ]
  });

  assert.equal(preview.status, 'ready');
  assert.equal(preview.entries[0].worklogTaskId, 88);
  assert.equal(preview.entries[1].worklogTaskId, 89);
});

test('previewLogworkBatch inherits typeOfWork from matched catalog task', async () => {
  const preview = await previewLogworkBatch({
    text: weeklyText,
    fetchProjects: async () => projectsByDate.get('2026-06-01'),
    fetchWorklogTasks: async () => [
      {
        id: 88,
        name: 'Maintenance mode management and status UI (SCB-213)',
        project_id: 1,
        type_of_work: 'correct'
      },
      {
        id: 89,
        name: 'System page updates',
        project_id: 1
      }
    ]
  });

  assert.equal(preview.entries[0].typeOfWork, 'correct');
  assert.equal(preview.entries[1].typeOfWork, undefined);
});

test('previewLogworkBatch batch typeOfWork overrides catalog defaults', async () => {
  const preview = await previewLogworkBatch({
    text: weeklyText,
    typeOfWork: 'improve',
    fetchProjects: async () => projectsByDate.get('2026-06-01'),
    fetchWorklogTasks: async () => [
      {
        id: 88,
        name: 'Maintenance mode management and status UI (SCB-213)',
        project_id: 1,
        type_of_work: 'correct'
      },
      {
        id: 89,
        name: 'System page updates',
        project_id: 1,
        type_of_work: 'create'
      }
    ]
  });

  assert.equal(preview.typeOfWork, 'improve');
  assert.equal(preview.entries[0].typeOfWork, 'correct');
});

test('applyLogworkBatch prefers batch typeOfWork over entry catalog type', async () => {
  const preview = buildLogworkBatchPreview({ parsed, projectsByDate });
  preview.entries[0].worklogTaskId = 88;
  preview.entries[0].typeOfWork = 'correct';
  preview.typeOfWork = 'other';
  const payloads = [];
  await applyLogworkBatch({
    batch: preview,
    confirm: true,
    submitEntry: async (payload) => {
      payloads.push(payload);
      return { dryRun: true };
    }
  });
  assert.equal(payloads[0].typeOfWork, 'other');
});

test('applyLogworkBatch blocks preview with task_not_found entries', async () => {
  const preview = buildLogworkBatchPreview({ parsed, projectsByDate });
  const unresolvedPreview = await attachWorklogTaskTargets(preview, {
    fetchWorklogTasks: async () => []
  });

  await assert.rejects(
    () => applyLogworkBatch({
      batch: unresolvedPreview,
      confirm: true,
      submitEntry: async () => ({ dryRun: true })
    }),
    /unresolved entries/
  );
});

test('applyLogworkBatch verifies submitted date range after real submit', async () => {
  const preview = buildLogworkBatchPreview({ parsed, projectsByDate });
  const verificationCalls = [];

  const result = await applyLogworkBatch({
    batch: preview,
    confirm: true,
    submitEntry: async () => ({ ok: true }),
    verifyLogwork: async (args) => {
      verificationCalls.push(args);
      return {
        range: { from: args.from, to: args.to },
        totals: { loggedHours: 3, bookedHours: 8 }
      };
    }
  });

  assert.equal(result.verification.totals.loggedHours, 3);
  assert.deepEqual(verificationCalls, [
    { from: '2026-06-01', to: '2026-06-02', includeEntries: false }
  ]);
});
