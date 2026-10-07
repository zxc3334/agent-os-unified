import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureProductSpecSubmission } from '../../src/app/product-spec-submission.js';
import { JsonUnifiedTaskStore, UnifiedTaskRuntime } from '../../src/app/unified-task-runtime.js';
import type { CliRunResult } from '../../src/cli/types.js';

async function withStore(run: (store: JsonUnifiedTaskStore, filePath: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'product-spec-task-'));
  try {
    const filePath = join(directory, 'tasks.json');
    await run(new JsonUnifiedTaskStore(filePath), filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const request = {
  trusted: { actorId: 'owner', ownerId: 'owner' },
  affairId: 'spec-matter',
  trigger: { source: 'message' as const, sourceId: 'message-1', occurredAt: '2026-10-07T12:00:00.000Z' },
  authorizedMemorySpaceIds: [],
  input: { messageId: 'message-1' },
  signal: new AbortController().signal,
};
const submission = {
  title: 'Personal agent', summary: 'Implementation plan', deliveryMode: 'local' as const,
  specPath: 'spec.md', ticketsPath: 'tickets',
};

function runtimeWithExecutor(
  store: JsonUnifiedTaskStore,
  execute: () => Promise<CliRunResult>,
) {
  return new UnifiedTaskRuntime({
    store,
    id: () => 'spec-task-1',
    now: () => '2026-10-07T12:00:00.000Z',
    memoryContext: { async prepare() { return undefined; } },
    executor: {
      async execute() {
        const initial = await execute();
        const final = await ensureProductSpecSubmission({
          result: initial,
          defaultDeliveryMode: 'local',
          retry: async () => ({
            answer: 'submitted', sessionId: 'native-session-2',
            toolCalls: [{ toolUseId: 'submit-call', toolName: 'request_spec_approval', input: submission }],
          }),
        });
        return { outcome: 'succeeded' as const, result: final.result, artifacts: [] };
      },
    },
  });
}

test('product-spec retry result and native session are persisted as the unified task outcome', async () => {
  await withStore(async (store, filePath) => {
    const runtime = runtimeWithExecutor(store, async () => ({ answer: 'draft complete', sessionId: 'native-session-1' }));
    const task = await runtime.run(request);
    assert.equal(task.status, 'succeeded');
    assert.deepEqual(task.result, {
      answer: 'submitted', sessionId: 'native-session-2',
      toolCalls: [{ toolUseId: 'submit-call', toolName: 'request_spec_approval', input: submission }],
    });
    assert.deepEqual(await new JsonUnifiedTaskStore(filePath).get(task.id), task);
  });
});

test('failed product-spec retry is persisted as a failed unified task instead of leaving a false success', async () => {
  await withStore(async (store, filePath) => {
    const runtime = new UnifiedTaskRuntime({
      store,
      id: () => 'spec-task-1',
      now: () => '2026-10-07T12:00:00.000Z',
      memoryContext: { async prepare() { return undefined; } },
      executor: {
        async execute() {
          return ensureProductSpecSubmission({
            result: { answer: 'draft complete', sessionId: 'native-session-1' },
            defaultDeliveryMode: 'local',
            retry: async () => ({ answer: 'still no structured submission', sessionId: 'native-session-2' }),
          }).then((final) => ({ outcome: 'succeeded' as const, result: final.result, artifacts: [] }));
        },
      },
    });
    const task = await runtime.run(request);
    assert.equal(task.status, 'failed');
    assert.match(task.error ?? '', /request_spec_approval/);
    assert.equal((await store.get(task.id))?.status, 'failed');
  });
});
