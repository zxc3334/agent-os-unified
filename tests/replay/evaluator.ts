import assert from 'node:assert/strict';
import {
  UnifiedTaskRuntime,
  type UnifiedTaskTraceEvent,
} from '../../src/app/unified-task-runtime.js';
import {
  PERSONAL_AGENT_REPLAY_FIXTURE_VERSION,
  PERSONAL_AGENT_REPLAY_FIXTURES,
  type PersonalAgentReplayFixture,
} from './fixtures.js';

export interface ReplayObservation {
  status: 'succeeded' | 'partially_succeeded' | 'failed' | 'cancelled';
  exposedMemorySpaceIds: string[];
  memoryAcknowledged: boolean;
  usageTokens: number | null;
  estimatedCostUsd: number | null;
  sideEffectApproved: boolean;
  sideEffectApplied: boolean;
  progressEvent: boolean;
  traceStages: string[];
}

export interface PersonalAgentReplayResult {
  fixtureVersion: number;
  rulesVersion: '1.0.0';
  caseId: string;
  passed: true;
  observed: ReplayObservation;
}

/**
 * Independent permission oracle: these are the scopes the replay caller is
 * allowed to pass to the runtime. They are deliberately not generated from
 * fixture.expected (which previously repeated the adapter's own assumptions).
 */
const AUTHORIZED_SCOPE_ORACLE: Readonly<Record<string, readonly string[]>> = {
  'R01-private-personal-read': ['personal'],
  'R02-private-project-read': ['project-alpha'],
  'R03-group-no-memory': [],
  'R04-group-forged-private-request': [],
  'R05-owner-only-selected-scope': ['project-alpha'],
  'R06-scheduled-authorized-scope': ['career'],
  'R07-explicit-save-persisted': ['personal'],
  'R08-implied-save-not-confirmed': ['personal'],
  'R09-explicit-save-write-failed': ['personal'],
  'R10-save-in-group-is-not-acknowledged': [],
  'R11-explicit-owned-correction': ['personal'],
  'R12-correction-of-other-owner-rejected': ['personal'],
  'R13-implicit-correction-rejected': ['personal'],
  'R14-context-unavailable': ['career'],
  'R15-executor-error': ['project-alpha'],
  'R16-cancel-before-run': [],
  'R17-progress-with-artifact-ids': ['career'],
  'R18-success-no-artifact': ['project-alpha'],
  'R19-partial-result': ['project-alpha'],
  'R20-known-usage-and-price': ['career'],
  'R21-unknown-usage': ['personal'],
  'R22-usage-known-price-unknown': ['personal'],
  'R23-automatic-publish-blocked': ['blog'],
  'R24-approved-email-adapter-output': ['personal'],
  'R25-non-owner-private-scope-denied': [],
};

/** Fixed outcome/trace contract for all cases, independent of fixture calculations. */
const OUTCOME_ORACLE: Readonly<Record<string, { status: ReplayObservation['status']; stages: string[] }>> = {
  'R01-private-personal-read': { status: 'succeeded', stages: ['queued', 'context_prepared', 'completed'] },
  'R02-private-project-read': { status: 'succeeded', stages: ['queued', 'context_prepared', 'completed'] },
  'R03-group-no-memory': { status: 'succeeded', stages: ['queued', 'context_prepared', 'completed'] },
  'R04-group-forged-private-request': { status: 'succeeded', stages: ['queued', 'context_prepared', 'completed'] },
  'R05-owner-only-selected-scope': { status: 'succeeded', stages: ['queued', 'context_prepared', 'completed'] },
  'R06-scheduled-authorized-scope': { status: 'succeeded', stages: ['queued', 'context_prepared', 'completed'] },
  'R07-explicit-save-persisted': { status: 'succeeded', stages: ['queued', 'context_prepared', 'completed'] },
  'R08-implied-save-not-confirmed': { status: 'succeeded', stages: ['queued', 'context_prepared', 'completed'] },
  'R09-explicit-save-write-failed': { status: 'succeeded', stages: ['queued', 'context_prepared', 'completed'] },
  'R10-save-in-group-is-not-acknowledged': { status: 'succeeded', stages: ['queued', 'context_prepared', 'completed'] },
  'R11-explicit-owned-correction': { status: 'succeeded', stages: ['queued', 'context_prepared', 'completed'] },
  'R12-correction-of-other-owner-rejected': { status: 'succeeded', stages: ['queued', 'context_prepared', 'completed'] },
  'R13-implicit-correction-rejected': { status: 'succeeded', stages: ['queued', 'context_prepared', 'completed'] },
  'R14-context-unavailable': { status: 'failed', stages: ['queued', 'context_unavailable', 'failed'] },
  'R15-executor-error': { status: 'failed', stages: ['queued', 'context_prepared', 'failed'] },
  'R16-cancel-before-run': { status: 'cancelled', stages: ['queued', 'cancelled'] },
  'R17-progress-with-artifact-ids': { status: 'succeeded', stages: ['queued', 'context_prepared', 'execution_progress', 'completed'] },
  'R18-success-no-artifact': { status: 'succeeded', stages: ['queued', 'context_prepared', 'completed'] },
  'R19-partial-result': { status: 'partially_succeeded', stages: ['queued', 'context_prepared', 'completed'] },
  'R20-known-usage-and-price': { status: 'succeeded', stages: ['queued', 'context_prepared', 'completed'] },
  'R21-unknown-usage': { status: 'succeeded', stages: ['queued', 'context_prepared', 'completed'] },
  'R22-usage-known-price-unknown': { status: 'succeeded', stages: ['queued', 'context_prepared', 'completed'] },
  'R23-automatic-publish-blocked': { status: 'succeeded', stages: ['queued', 'context_prepared', 'completed'] },
  'R24-approved-email-adapter-output': { status: 'succeeded', stages: ['queued', 'context_prepared', 'completed'] },
  'R25-non-owner-private-scope-denied': { status: 'succeeded', stages: ['queued', 'context_prepared', 'completed'] },
};

/** Fixed assertions for sensitive memory acknowledgements; not fixture-derived. */
const MEMORY_ACK_ORACLE: Readonly<Record<string, boolean>> = {
  'R07-explicit-save-persisted': true,
  'R08-implied-save-not-confirmed': false,
  'R09-explicit-save-write-failed': false,
  'R10-save-in-group-is-not-acknowledged': false,
  'R11-explicit-owned-correction': true,
  'R12-correction-of-other-owner-rejected': false,
  'R13-implicit-correction-rejected': false,
};

/** Runs synthetic adapters through the public unified-task runtime seam. */
export async function runPersonalAgentReplaySuite(): Promise<PersonalAgentReplayResult[]> {
  const results: PersonalAgentReplayResult[] = [];
  assert.equal(PERSONAL_AGENT_REPLAY_FIXTURES.length, Object.keys(OUTCOME_ORACLE).length,
    'every replay fixture must have an independent outcome expectation');
  assert.equal(PERSONAL_AGENT_REPLAY_FIXTURES.length, Object.keys(AUTHORIZED_SCOPE_ORACLE).length,
    'every replay fixture must have an independent scope expectation');
  assert.deepEqual(
    PERSONAL_AGENT_REPLAY_FIXTURES.filter(({ memoryAction }) => memoryAction).map(({ id }) => id).sort(),
    Object.keys(MEMORY_ACK_ORACLE).sort(),
    'every memory-action fixture must have an independent acknowledgement expectation',
  );

  for (const fixture of PERSONAL_AGENT_REPLAY_FIXTURES) {
    const expectedScopes = AUTHORIZED_SCOPE_ORACLE[fixture.id];
    assert.ok(expectedScopes, `missing independent scope expectation for ${fixture.id}`);
    const expectedOutcome = OUTCOME_ORACLE[fixture.id];
    assert.ok(expectedOutcome, `missing independent outcome expectation for ${fixture.id}`);

    const trace: UnifiedTaskTraceEvent[] = [];
    let preparedSpaces: string[] = [];
    const controller = new AbortController();
    if (fixture.cancelBeforeRun) controller.abort();
    const runtime = new UnifiedTaskRuntime({
      id: () => `replay-${fixture.id}`,
      now: () => '2026-10-07T12:00:00.000Z',
      trace: (event) => { trace.push(event); },
      store: {
        async get() { return undefined; },
        async list() { return []; },
        async save() {},
      },
      memoryContext: {
        async prepare(request) {
          preparedSpaces = [...request.authorizedMemorySpaceIds];
          if (fixture.contextUnavailable) throw new Error('synthetic context adapter error');
          return { sourceIds: preparedSpaces.map((space) => `source-${space}`) };
        },
      },
      executor: {
        async execute({ reportProgress }) {
          if (fixture.reportProgress) await reportProgress(fixture.privateInputMarker);
          if (fixture.executionError) throw new Error('synthetic executor error');
          const action = fixture.memoryAction;
          const memoryAcknowledged = Boolean(
            fixture.actor === 'owner-dm' &&
            action?.explicitlyRequested && action.persisted &&
            (action.kind === 'save' || action.targetOwned === true),
          );
          const usageTokens = fixture.usageTokens ?? null;
          const estimatedCostUsd = usageTokens !== null && fixture.pricePerMillionUsd !== undefined
            ? usageTokens * fixture.pricePerMillionUsd / 1_000_000
            : null;
          return {
            outcome: fixture.outcome ?? 'succeeded',
            result: {
              memoryAcknowledged,
              usageTokens,
              estimatedCostUsd,
              sideEffectApproved: fixture.requestedSideEffect !== undefined &&
                fixture.explicitlyApprovedSideEffect === true,
              sideEffectApplied: false,
            },
            artifacts: (fixture.artifactIds ?? []).map((id) => ({
              id,
              kind: 'synthetic',
              label: 'synthetic artifact',
            })),
          };
        },
      },
    });

    const task = await runtime.run({
      trusted: { actorId: fixture.actor === 'other-dm' ? 'synthetic-other' : 'synthetic-owner', ownerId: 'synthetic-owner' },
      affairId: 'synthetic-affair',
      trigger: {
        source: fixture.actor === 'scheduler' ? 'schedule' : 'message',
        sourceId: `source-${fixture.id}`,
        occurredAt: '2026-10-07T12:00:00.000Z',
      },
      // This is the adapter's authorization decision, not the requested scope
      // carried in untrusted input. Fixed oracle checks it below.
      authorizedMemorySpaceIds: fixture.actor !== 'owner-dm' && fixture.actor !== 'scheduler'
        ? []
        : fixture.authorizedMemorySpaceIds,
      input: {
        syntheticText: fixture.privateInputMarker,
        requestedMemorySpaceIds: fixture.requestedMemorySpaceIds ?? [],
      },
      signal: controller.signal,
    });
    const result = task.result as {
      memoryAcknowledged?: boolean;
      usageTokens?: number | null;
      estimatedCostUsd?: number | null;
      sideEffectApproved?: boolean;
      sideEffectApplied?: false;
    } | undefined;
    const observed: ReplayObservation = {
      status: task.status as ReplayObservation['status'],
      exposedMemorySpaceIds: preparedSpaces,
      memoryAcknowledged: result?.memoryAcknowledged ?? false,
      usageTokens: result?.usageTokens ?? null,
      estimatedCostUsd: result?.estimatedCostUsd ?? null,
      sideEffectApproved: result?.sideEffectApproved ?? false,
      sideEffectApplied: result?.sideEffectApplied ?? false,
      progressEvent: trace.some((event) => event.stage === 'execution_progress'),
      traceStages: trace.map((event) => event.stage),
    };

    // Permission expectations are independent of the fixture and the adapter's
    // computed expected values. In particular, requested scope cannot elevate
    // a group/non-owner, and an owner's broader request cannot expand its grant.
    assert.deepEqual(preparedSpaces, expectedScopes, `authorized scope mismatch in ${fixture.id}`);
    assert.equal(observed.status, expectedOutcome.status, `task status mismatch in ${fixture.id}`);
    assert.deepEqual(observed.traceStages, expectedOutcome.stages, `trace stages mismatch in ${fixture.id}`);
    assert.equal(observed.progressEvent, expectedOutcome.stages.includes('execution_progress'),
      `progress event mismatch in ${fixture.id}`);
    assert.equal(observed.sideEffectApplied, false, `synthetic replay must never apply side effects in ${fixture.id}`);
    assert.equal(observed.usageTokens, fixture.id === 'R20-known-usage-and-price' ? 1200 :
      fixture.id === 'R22-usage-known-price-unknown' ? 900 : null, `usage mismatch in ${fixture.id}`);
    assert.equal(observed.estimatedCostUsd, fixture.id === 'R20-known-usage-and-price' ? 0.0024 : null,
      `cost must be known only with usage and price in ${fixture.id}`);
    assert.equal(observed.sideEffectApproved, fixture.id === 'R24-approved-email-adapter-output',
      `approval output mismatch in ${fixture.id}`);
    if (fixture.requestedMemorySpaceIds?.length) {
      for (const requested of fixture.requestedMemorySpaceIds) {
        if (!expectedScopes.includes(requested)) {
          assert.equal(preparedSpaces.includes(requested), false, `ungranted requested scope leaked in ${fixture.id}`);
        }
      }
    }
    if (Object.hasOwn(MEMORY_ACK_ORACLE, fixture.id)) {
      assert.equal(observed.memoryAcknowledged, MEMORY_ACK_ORACLE[fixture.id],
        `memory acknowledgement mismatch in ${fixture.id}`);
    }

    const traceJson = JSON.stringify(trace);
    assert.equal(traceJson.includes(fixture.privateInputMarker), false, `trace leaked input in ${fixture.id}`);
    assert.equal(traceJson.includes('synthetic executor error'), false, `trace leaked error in ${fixture.id}`);
    assert.equal(traceJson.includes('synthetic artifact'), false, `trace leaked artifact label in ${fixture.id}`);
    assert.ok(trace.every((event) => event.version === 1), `trace schema version missing in ${fixture.id}`);
    assert.ok(trace.every((event) => event.sourceId === `source-${fixture.id}`), `source id missing in ${fixture.id}`);
    assert.deepEqual(trace.at(-1)?.artifactIds, task.artifacts.map(({ id }) => id));

    results.push({
      fixtureVersion: PERSONAL_AGENT_REPLAY_FIXTURE_VERSION,
      rulesVersion: '1.0.0',
      caseId: fixture.id,
      passed: true,
      observed,
    });
  }
  return results;
}
