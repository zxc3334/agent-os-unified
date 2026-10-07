import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PersonalMemoryStore } from '../../src/core/personal-memory.js';
import { preparePersonalMemoryContext } from '../../src/core/personal-memory-context.js';

test('personal context is limited to an authorized owner DM and relevant spaces', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-os-context-'));
  try {
    const store = new PersonalMemoryStore({ directory, ownerId: 'owner' });
    const food = await store.createSpace('生活');
    const career = await store.createSpace('求职');
    await store.add({
      spaceId: food.id, kind: 'preference', content: '我不吃香菜', confidence: 'user_stated',
      source: { sourceId: 'food-msg', actorId: 'owner', receivedAt: '2026-10-07T10:00:00Z', timezone: 'UTC' },
    });
    await store.add({
      spaceId: career.id, kind: 'fact', content: '我做过分布式缓存项目', confidence: 'user_confirmed',
      source: { sourceId: 'career-msg', actorId: 'owner', receivedAt: '2026-10-07T10:00:00Z', timezone: 'UTC' },
    });

    const denied = await preparePersonalMemoryContext(store, {
      actorId: 'owner', trustedOwnerId: 'owner', directMessage: false,
      query: '项目经历', authorizedSpaceIds: [food.id, career.id],
    });
    assert.deepEqual(denied, { status: 'not_authorized', text: '' });

    const context = await preparePersonalMemoryContext(store, {
      actorId: 'owner', trustedOwnerId: 'owner', directMessage: true,
      query: '项目经历 缓存', authorizedSpaceIds: [career.id],
    });
    assert.equal(context.status, 'ready');
    assert.match(context.text, /分布式缓存项目/);
    assert.doesNotMatch(context.text, /香菜|生活/);

    const wrongActor = await preparePersonalMemoryContext(store, {
      actorId: 'other', trustedOwnerId: 'owner', directMessage: true,
      query: '项目经历', authorizedSpaceIds: [career.id],
    });
    assert.deepEqual(wrongActor, { status: 'not_authorized', text: '' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('context does not fill its budget with weakly matching unrelated memories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-os-context-relevance-'));
  try {
    const store = new PersonalMemoryStore({ directory, ownerId: 'owner' });
    const space = await store.createSpace('个人');
    await store.add({
      spaceId: space.id, kind: 'fact', content: '项目组织方式的随手想法', confidence: 'user_stated',
      source: { sourceId: 'unrelated', actorId: 'owner', receivedAt: '2026-10-07T10:00:00Z', timezone: 'UTC' },
    });
    const result = await preparePersonalMemoryContext(store, {
      actorId: 'owner', trustedOwnerId: 'owner', directMessage: true,
      query: '项目缓存命中率如何统计', authorizedSpaceIds: [space.id],
    });
    assert.deepEqual(result, { status: 'empty', text: '' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
