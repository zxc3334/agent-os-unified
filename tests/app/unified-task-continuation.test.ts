import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { JsonUnifiedTaskStore } from '../../src/app/unified-task-runtime.js';
import { runContinuationThroughUnifiedTask } from '../../src/app/unified-task-continuation.js';
import type { AppRuntime } from '../../src/app/runtime.js';

async function withStore(run: (store: JsonUnifiedTaskStore, path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-os-continuation-'));
  const path = join(directory, 'tasks.json');
  try {
    await run(new JsonUnifiedTaskStore(path), path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function runtime(store: JsonUnifiedTaskStore): AppRuntime {
  return { unifiedTaskStore: store } as AppRuntime;
}

for (const source of ['approval', 'clarification', 'comment'] as const) {
  test(`${source} continuation persists through the unified task seam without prompt or memory scope`, async () => {
    await withStore(async (store, path) => {
      const result = await runContinuationThroughUnifiedTask({
        runtime: runtime(store),
        source,
        sourceId: `${source}-source-1`,
        occurredAt: '2026-10-08T01:02:03.000Z',
        actorId: 'trusted-actor',
        ownerId: 'trusted-owner',
        affairId: 'bot:task-7',
        input: { botId: 'bot', sessionId: 'session-2', taskId: 'task-7' },
        signal: new AbortController().signal,
        execute: async () => ({ answer: 'completed', prompt: 'ephemeral prompt must not persist' }),
      });
      assert.deepEqual(result, { answer: 'completed', prompt: 'ephemeral prompt must not persist' });
      const persisted = JSON.parse(await readFile(path, 'utf8'));
      const [task] = persisted;
      assert.equal(task.trigger.source, source);
      assert.equal(task.trusted.actorId, 'trusted-actor');
      assert.equal(task.trusted.ownerId, 'trusted-owner');
      assert.deepEqual(task.authorizedMemorySpaceIds, []);
      assert.deepEqual(task.input, { botId: 'bot', sessionId: 'session-2', taskId: 'task-7' });
      assert.equal(JSON.stringify(task.input).includes('ephemeral prompt'), false);
      assert.equal(task.status, 'succeeded');
    });
  });
}

test('continuation failure is durably observable and remains a failure to its adapter', async () => {
  await withStore(async (store) => {
    await assert.rejects(runContinuationThroughUnifiedTask({
      runtime: runtime(store),
      source: 'comment',
      sourceId: 'comment-event',
      occurredAt: '2026-10-08T01:02:03.000Z',
      actorId: 'comment-author',
      ownerId: 'flow-owner',
      affairId: 'bot:task-9',
      input: { taskId: 'task-9' },
      signal: new AbortController().signal,
      execute: async () => { throw new Error('document write failed'); },
    }), /document write failed/);
    const [task] = await store.list('bot:task-9');
    assert.equal(task?.status, 'failed');
    assert.equal(task?.error, 'document write failed');
  });
});

test('continuation cancellation is persisted and surfaced as cancellation', async () => {
  await withStore(async (store) => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(runContinuationThroughUnifiedTask({
      runtime: runtime(store),
      source: 'approval',
      sourceId: 'approval-event',
      occurredAt: '2026-10-08T01:02:03.000Z',
      actorId: 'approver',
      ownerId: 'owner',
      affairId: 'bot:task-10',
      input: { taskId: 'task-10' },
      signal: controller.signal,
      execute: async () => 'should not run',
    }), (error: unknown) => error instanceof Error && error.name === 'AbortError');
    const [task] = await store.list('bot:task-10');
    assert.equal(task?.status, 'cancelled');
  });
});
