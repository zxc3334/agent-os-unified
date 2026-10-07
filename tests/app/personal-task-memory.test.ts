import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PersonalTaskMemoryProvider } from '../../src/app/personal-task-memory.js';
import { PersonalMemoryStore } from '../../src/core/personal-memory.js';

async function withStore(run: (store: PersonalMemoryStore, spaceId: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-os-task-memory-'));
  try {
    const store = new PersonalMemoryStore({ directory, ownerId: 'owner' });
    const space = await store.createSpace('求职');
    await store.add({
      spaceId: space.id,
      kind: 'fact',
      content: '我负责了项目中的任务调度模块',
      confidence: 'user_confirmed',
      source: { sourceId: 'msg-1', actorId: 'owner', receivedAt: '2026-10-07T09:00:00+08:00', occurredAt: '2026-10-07T09:00:00+08:00', timezone: 'Asia/Shanghai' },
    });
    await run(store, space.id);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('task memory provider recalls only explicitly authorized owner-DM context', async () => {
  await withStore(async (store, spaceId) => {
    const provider = new PersonalTaskMemoryProvider({ store, directMessage: true });
    const context = await provider.prepare({
      actorId: 'owner', ownerId: 'owner', affairId: 'career',
      trigger: { source: 'message', occurredAt: '2026-10-07T09:00:00+08:00' },
      authorizedMemorySpaceIds: [spaceId], input: { messageId: 'm1' },
      query: '任务调度模块', signal: new AbortController().signal,
    });
    assert.equal(context.status, 'ready');
    assert.match(context.text, /任务调度模块/);
    assert.deepEqual(context.sourceVersions, [{ id: (await store.search('任务调度模块', { authorizedSpaceIds: [spaceId] }))[0]!.id, version: 1 }]);
  });
});

test('task memory provider does not expose memory in group or unauthorized-space tasks', async () => {
  await withStore(async (store, spaceId) => {
    const groupProvider = new PersonalTaskMemoryProvider({ store, directMessage: false });
    const base = {
      actorId: 'owner', ownerId: 'owner', affairId: 'career',
      trigger: { source: 'message' as const, occurredAt: '2026-10-07T09:00:00+08:00' },
      authorizedMemorySpaceIds: [spaceId], input: {}, query: '任务调度模块',
      signal: new AbortController().signal,
    };
    assert.deepEqual(await groupProvider.prepare(base), { status: 'not_authorized', text: '' });
    const unauthorized = await new PersonalTaskMemoryProvider({ store, directMessage: true })
      .prepare({ ...base, authorizedMemorySpaceIds: [] });
    assert.equal(unauthorized.status, 'empty');
    assert.doesNotMatch(unauthorized.text, /任务调度模块/);
  });
});
