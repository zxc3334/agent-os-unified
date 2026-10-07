import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  JsonUnifiedTaskStore,
  UnifiedTaskRuntime,
  conversationAffairId,
  workflowAffairId,
  type UnifiedTask,
} from '../../src/app/unified-task-runtime.js';
import { runPersonalAgentReplaySuite } from '../replay/evaluator.js';
import {
  PERSONAL_AGENT_REPLAY_FIXTURE_VERSION,
  PERSONAL_AGENT_REPLAY_FIXTURES,
} from '../replay/fixtures.js';

const fixedTime = '2026-10-07T12:00:00.000Z';

async function withStore(run: (filePath: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-os-task-runtime-'));
  try {
    await run(join(dir, 'tasks.json'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function request(signal = new AbortController().signal) {
  return {
    trusted: { actorId: 'owner-open-id', ownerId: 'jackson' },
    affairId: 'career-search',
    trigger: { source: 'message' as const, sourceId: 'message-42', occurredAt: fixedTime },
    authorizedMemorySpaceIds: ['job-search', 'project-alpha'],
    input: { text: 'Prepare project interview notes' },
    signal,
  };
}

test('one task run passes trusted scope to memory and executor and persists observable result and artifacts', async () => {
  await withStore(async (filePath) => {
    const store = new JsonUnifiedTaskStore(filePath);
    let receivedContext: unknown;
    let memoryQuery: string | undefined;
    const runtime = new UnifiedTaskRuntime({
      store,
      now: () => fixedTime,
      id: () => 'run-1',
      memoryContext: {
        async prepare(input) {
          memoryQuery = input.query;
          assert.deepEqual(input.authorizedMemorySpaceIds, ['job-search', 'project-alpha']);
          assert.equal(input.ownerId, 'jackson');
          return { snippets: ['authorized project summary'] };
        },
      },
      executor: {
        async execute(input) {
          receivedContext = input.memoryContext;
          await input.reportProgress('Preparing interview notes');
          return {
            outcome: 'succeeded',
            result: { summary: 'Notes are ready' },
            artifacts: [{ id: 'artifact-1', kind: 'markdown', label: 'Interview notes', location: 'artifacts/notes.md' }],
          };
        },
      },
    });

    const transitions: string[] = [];
    const result = await runtime.run({ ...request(), memoryQuery: 'find my project contributions' }, (task) => transitions.push(task.status));
    assert.equal(result.id, 'run-1');
    assert.equal(result.status, 'succeeded');
    assert.equal(result.affairId, 'career-search');
    assert.equal(result.trigger.occurredAt, fixedTime);
    assert.deepEqual(result.result, { summary: 'Notes are ready' });
    assert.equal(result.artifacts[0]?.id, 'artifact-1');
    assert.deepEqual(receivedContext, { snippets: ['authorized project summary'] });
    assert.equal(memoryQuery, 'find my project contributions');
    assert.equal(JSON.stringify(result).includes('find my project contributions'), false);
    assert.deepEqual(transitions, ['queued', 'running', 'running', 'succeeded']);
    assert.equal((await runtime.get('run-1'))?.progress, 'Preparing interview notes');

    const reopened = new JsonUnifiedTaskStore(filePath);
    assert.deepEqual(await reopened.get('run-1'), result);
  });
});

test('executor output cannot replace trusted identity or expand authorized memory spaces', async () => {
  await withStore(async (filePath) => {
    const runtime = new UnifiedTaskRuntime({
      store: new JsonUnifiedTaskStore(filePath),
      id: () => 'run-2',
      memoryContext: { async prepare() { return {}; } },
      executor: {
        async execute() {
          return {
            outcome: 'succeeded',
            result: { ownerId: 'attacker', authorizedMemorySpaceIds: ['private'] },
            artifacts: [],
          };
        },
      },
    });
    const task = await runtime.run(request());
    assert.equal(task.trusted.ownerId, 'jackson');
    assert.deepEqual(task.authorizedMemorySpaceIds, ['job-search', 'project-alpha']);
    assert.deepEqual(task.result, { ownerId: 'attacker', authorizedMemorySpaceIds: ['private'] });
  });
});

test('cancellation before execution is persisted and the executor is not called', async () => {
  await withStore(async (filePath) => {
    const controller = new AbortController();
    controller.abort();
    let executed = false;
    const runtime = new UnifiedTaskRuntime({
      store: new JsonUnifiedTaskStore(filePath),
      id: () => 'run-cancelled',
      memoryContext: { async prepare() { throw new Error('must not prepare context'); } },
      executor: { async execute() { executed = true; return { outcome: 'succeeded', result: null, artifacts: [] }; } },
    });
    const task = await runtime.run(request(controller.signal));
    assert.equal(task.status, 'cancelled');
    assert.equal(executed, false);
    assert.equal((await new JsonUnifiedTaskStore(filePath).get('run-cancelled'))?.status, 'cancelled');
  });
});

test('partial completion, failure and cancellation during execution remain distinguishable', async () => {
  await withStore(async (filePath) => {
    let id = 0;
    const store = new JsonUnifiedTaskStore(filePath);
    const runtime = new UnifiedTaskRuntime({
      store,
      id: () => `run-${++id}`,
      memoryContext: { async prepare() { return null; } },
      executor: {
        async execute({ signal }) {
          if (id === 1) return { outcome: 'partial', result: 'one step failed', artifacts: [] };
          if (id === 2) throw new Error('executor unavailable');
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
          signal.throwIfAborted();
          return { outcome: 'succeeded', result: null, artifacts: [] };
        },
      },
    });
    const partial = await runtime.run(request());
    const failed = await runtime.run(request());
    const controller = new AbortController();
    const running = runtime.run(request(controller.signal));
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    const cancelled = await running;
    assert.equal(partial.status, 'partially_succeeded');
    assert.equal(failed.status, 'failed');
    assert.match(failed.error ?? '', /executor unavailable/);
    assert.equal(cancelled.status, 'cancelled');
  });
});

test('task records are defensively copied at the store seam', async () => {
  await withStore(async (filePath) => {
    const runtime = new UnifiedTaskRuntime({
      store: new JsonUnifiedTaskStore(filePath),
      id: () => 'run-copy',
      memoryContext: { async prepare() { return {}; } },
      executor: { async execute() { return { outcome: 'succeeded', result: { nested: ['safe'] }, artifacts: [] }; } },
    });
    const result = await runtime.run(request());
    (result.result as { nested: string[] }).nested.push('mutated');
    const saved = await new JsonUnifiedTaskStore(filePath).get('run-copy') as UnifiedTask | undefined;
    assert.deepEqual(saved?.result, { nested: ['safe'] });
  });
});



test('affair identities remain stable across bot and engine changes', () => {
  assert.equal(conversationAffairId('chat-1', 'thread-2'), conversationAffairId('chat-1', 'thread-2'));
  assert.equal(conversationAffairId('chat:1', 'thread:2'), 'conversation:chat%3A1:thread%3A2');
  assert.notEqual(conversationAffairId('chat-1', 'thread-2'), conversationAffairId('chat-1', 'thread-3'));
  assert.equal(workflowAffairId('flow-1'), workflowAffairId('flow-1'));
  assert.throws(() => conversationAffairId('', 'thread'), /required/);
});

test('private-safe trace exposes lifecycle and opaque source/artifact identifiers only', async () => {
  await withStore(async (filePath) => {
    const trace: unknown[] = [];
    const runtime = new UnifiedTaskRuntime({
      store: new JsonUnifiedTaskStore(filePath),
      id: () => 'trace-run-1',
      now: () => fixedTime,
      trace: (event) => { trace.push(event); },
      memoryContext: { async prepare() { return { privateMemoryText: 'PRIVATE-MEMORY-MARKER' }; } },
      executor: {
        async execute({ reportProgress }) {
          await reportProgress('PRIVATE-PROGRESS-MARKER');
          return {
            outcome: 'succeeded',
            result: { privateResult: 'PRIVATE-RESULT-MARKER' },
            artifacts: [{ id: 'artifact-resume-v2', kind: 'markdown', label: 'PRIVATE-ARTIFACT-LABEL', location: '/private/PRIVATE-ARTIFACT-PATH' }],
          };
        },
      },
    });
    const task = await runtime.run({
      ...request(), input: { text: 'PRIVATE-INPUT-MARKER' },
      trigger: { source: 'message', sourceId: 'message-opaque-42', occurredAt: fixedTime },
    });
    assert.equal(task.status, 'succeeded');
    assert.deepEqual((trace as Array<{ stage: string }>).map(({ stage }) => stage), ['queued', 'context_prepared', 'execution_progress', 'completed']);
    const traceJson = JSON.stringify(trace);
    for (const secret of ['PRIVATE-INPUT-MARKER', 'PRIVATE-MEMORY-MARKER', 'PRIVATE-PROGRESS-MARKER', 'PRIVATE-RESULT-MARKER', 'PRIVATE-ARTIFACT-LABEL', 'PRIVATE-ARTIFACT-PATH']) {
      assert.equal(traceJson.includes(secret), false);
    }
    assert.equal(traceJson.includes('message-opaque-42'), true);
    assert.equal(traceJson.includes('artifact-resume-v2'), true);
  });
});

test('trace sink failure is best effort and context failure is described without its message', async () => {
  await withStore(async (filePath) => {
    const trace: Array<{ stage: string; failureCode?: string }> = [];
    const runtime = new UnifiedTaskRuntime({
      store: new JsonUnifiedTaskStore(filePath), id: () => 'trace-context-failed',
      trace(event) { trace.push(event); if (event.stage === 'queued') throw new Error('trace sink unavailable'); },
      memoryContext: { async prepare() { throw new Error('PRIVATE-CONTEXT-ERROR-MARKER'); } },
      executor: { async execute() { throw new Error('executor must not run'); } },
    });
    const task = await runtime.run(request());
    assert.equal(task.status, 'failed');
    assert.deepEqual(trace.map(({ stage }) => stage), ['queued', 'context_unavailable', 'failed']);
    assert.equal(trace[2]?.failureCode, 'memory_context_unavailable');
    assert.equal(JSON.stringify(trace).includes('PRIVATE-CONTEXT-ERROR-MARKER'), false);

    const successful = new UnifiedTaskRuntime({
      store: new JsonUnifiedTaskStore(filePath), id: () => 'trace-failed-but-task-succeeded',
      trace() { throw new Error('diagnostics must not fail a task'); },
      memoryContext: { async prepare() { return null; } },
      executor: { async execute() { return { outcome: 'succeeded', result: 'saved result', artifacts: [] }; } },
    });
    assert.equal((await successful.run(request())).status, 'succeeded');
  });
});

test('versioned synthetic replay cases assert deterministic adapter and permission behavior', async () => {
  assert.equal(PERSONAL_AGENT_REPLAY_FIXTURE_VERSION, 1);
  assert.equal(PERSONAL_AGENT_REPLAY_FIXTURES.length, 25);
  const results = await runPersonalAgentReplaySuite();
  assert.equal(results.length, PERSONAL_AGENT_REPLAY_FIXTURES.length);
  assert.ok(results.every((result) => result.passed && result.fixtureVersion === 1));
});
});
