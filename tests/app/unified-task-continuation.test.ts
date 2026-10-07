import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { JsonUnifiedTaskStore } from '../../src/app/unified-task-runtime.js';
import { runContinuationThroughUnifiedTask, withPersonalMemoryContext } from '../../src/app/unified-task-continuation.js';
import type { AppRuntime } from '../../src/app/runtime.js';
import { PersonalMemoryStore } from '../../src/core/personal-memory.js';

async function withStore(run: (store: JsonUnifiedTaskStore, path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-os-continuation-'));
  const path = join(directory, 'tasks.json');
  try {
    await run(new JsonUnifiedTaskStore(path), path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function runtime(store: JsonUnifiedTaskStore, personalMemoryStore?: PersonalMemoryStore): AppRuntime {
  return { unifiedTaskStore: store, personalMemoryStore } as AppRuntime;
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

test('continuation execution receives only bounded memory from its explicit session grant', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-os-continuation-memory-'));
  try {
    const memoryStore = new PersonalMemoryStore({ directory: join(directory, 'memory'), ownerId: 'trusted-owner' });
    const career = await memoryStore.createSpace('求职');
    const life = await memoryStore.createSpace('生活');
    await memoryStore.add({
      spaceId: career.id, kind: 'fact', content: '我负责过缓存一致性项目', confidence: 'user_confirmed',
      source: { sourceId: 'career-source', actorId: 'trusted-owner', receivedAt: '2026-10-07T10:00:00Z', timezone: 'UTC' },
    });
    await memoryStore.add({
      spaceId: life.id, kind: 'preference', content: '我不吃香菜', confidence: 'user_stated',
      source: { sourceId: 'life-source', actorId: 'trusted-owner', receivedAt: '2026-10-07T10:00:00Z', timezone: 'UTC' },
    });
    const taskStore = new JsonUnifiedTaskStore(join(directory, 'tasks.json'));
    let executedPrompt = '';
    await runContinuationThroughUnifiedTask({
      runtime: runtime(taskStore, memoryStore), source: 'clarification', sourceId: 'answer-1',
      occurredAt: '2026-10-07T11:00:00.000Z', actorId: 'trusted-owner', ownerId: 'trusted-owner',
      affairId: 'career:task-1', authorizedMemorySpaceIds: [career.id], memoryQuery: '缓存一致性项目',
      input: { taskId: 'task-1' }, signal: new AbortController().signal,
      execute: async (_signal, context) => {
        executedPrompt = withPersonalMemoryContext('继续准备项目面试', context);
        return 'continued';
      },
    });
    assert.match(executedPrompt, /缓存一致性项目/);
    assert.doesNotMatch(executedPrompt, /香菜/);
    const [task] = await taskStore.list('career:task-1');
    assert.deepEqual(task?.authorizedMemorySpaceIds, [career.id]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('continuation without a trusted matter grant receives no personal memory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-os-continuation-no-grant-'));
  try {
    const memoryStore = new PersonalMemoryStore({ directory: join(directory, 'memory'), ownerId: 'trusted-owner' });
    const space = await memoryStore.createSpace('求职');
    await memoryStore.add({
      spaceId: space.id, kind: 'fact', content: '缓存一致性项目', confidence: 'user_confirmed',
      source: { sourceId: 'career-source', actorId: 'trusted-owner', receivedAt: '2026-10-07T10:00:00Z', timezone: 'UTC' },
    });
    const taskStore = new JsonUnifiedTaskStore(join(directory, 'tasks.json'));
    let executedPrompt = '';
    await runContinuationThroughUnifiedTask({
      runtime: runtime(taskStore, memoryStore), source: 'approval', sourceId: 'approval-1',
      occurredAt: '2026-10-07T11:00:00.000Z', actorId: 'trusted-owner', ownerId: 'trusted-owner',
      affairId: 'workflow:task-2', memoryQuery: '缓存一致性', input: { taskId: 'task-2' },
      signal: new AbortController().signal,
      execute: async (_signal, context) => {
        executedPrompt = withPersonalMemoryContext('继续执行', context);
        return 'continued';
      },
    });
    assert.equal(executedPrompt, '继续执行');
    const [task] = await taskStore.list('workflow:task-2');
    assert.deepEqual(task?.authorizedMemorySpaceIds, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
