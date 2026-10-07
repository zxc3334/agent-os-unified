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

export interface PersonalAgentReplayResult {
  fixtureVersion: number;
  rulesVersion: '1.0.0';
  caseId: string;
  passed: true;
  observed: PersonalAgentReplayFixture['expected'];
}

/** Runs synthetic adapters through the public unified-task runtime seam. */
export async function runPersonalAgentReplaySuite(): Promise<PersonalAgentReplayResult[]> {
  const results: PersonalAgentReplayResult[] = [];
  for (const fixture of PERSONAL_AGENT_REPLAY_FIXTURES) {
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
    const observed: PersonalAgentReplayFixture['expected'] = {
      status: task.status as PersonalAgentReplayFixture['expected']['status'],
      exposedMemorySpaceIds: preparedSpaces,
      memoryAcknowledged: result?.memoryAcknowledged ?? false,
      usageTokens: result?.usageTokens ?? null,
      estimatedCostUsd: result?.estimatedCostUsd ?? null,
      sideEffectApproved: result?.sideEffectApproved ?? false,
      sideEffectApplied: result?.sideEffectApplied ?? false,
      progressEvent: trace.some((event) => event.stage === 'execution_progress'),
      traceStages: trace.map((event) => event.stage),
    };

    assert.deepEqual(observed, fixture.expected, `replay case ${fixture.id}`);
    const traceJson = JSON.stringify(trace);
    assert.equal(traceJson.includes(fixture.privateInputMarker), false, `trace leaked input in ${fixture.id}`);
    assert.equal(traceJson.includes('synthetic executor error'), false, `trace leaked error in ${fixture.id}`);
    assert.equal(traceJson.includes('synthetic artifact'), false, `trace leaked artifact label in ${fixture.id}`);
    assert.ok(trace.every((event) => event.version === 1), `trace schema version missing in ${fixture.id}`);
    assert.ok(trace.every((event) => event.sourceId === `source-${fixture.id}`), `source id missing in ${fixture.id}`);
    assert.deepEqual(trace.at(-1)?.artifactIds, task.artifacts.map(({ id }) => id));
    if (fixture.actor === 'group') {
      assert.deepEqual(preparedSpaces, [], `group memory isolation failed in ${fixture.id}`);
    }
    if (fixture.actor === 'other-dm') {
      assert.deepEqual(preparedSpaces, [], `non-owner memory isolation failed in ${fixture.id}`);
    }
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
