import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PersonalMemoryStore } from '../../src/core/personal-memory.js';

async function withStore(run: (store: PersonalMemoryStore, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-os-memory-'));
  try {
    await run(new PersonalMemoryStore({ directory: dir, ownerId: 'jackson' }), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const source = {
  sourceId: 'lark-message-1',
  actorId: 'owner',
  receivedAt: '2026-10-07T12:00:00+08:00',
  timezone: 'Asia/Shanghai',
  excerpt: '我不吃香菜',
};

test('a saved personal memory survives reopening the store and is filtered by authorized space', async () => {
  await withStore(async (store, dir) => {
    const food = await store.createSpace('日常生活');
    const project = await store.createSpace('Project Alpha');
    await store.add({
      spaceId: food.id,
      kind: 'preference',
      content: '我不吃香菜',
      confidence: 'user_stated',
      source,
    });

    const reopened = new PersonalMemoryStore({ directory: dir, ownerId: 'jackson' });
    const visible = await reopened.search('香菜', { authorizedSpaceIds: [food.id] });
    assert.equal(visible.length, 1);
    assert.equal(visible[0].content, '我不吃香菜');
    assert.equal((await reopened.search('香菜', { authorizedSpaceIds: [project.id] })).length, 0);
  });
});

test('a repeated source operation is idempotent, while forgetting suppresses re-extraction', async () => {
  await withStore(async (store) => {
    const space = await store.createSpace('个人');
    const input = {
      spaceId: space.id,
      kind: 'fact' as const,
      content: '后天给我女朋友发生日祝福',
      confidence: 'user_stated' as const,
      source: { ...source, sourceId: 'birthday-message' },
      operationId: 'birthday-operation',
    };
    const created = await store.add(input);
    const duplicate = await store.add(input);
    assert.equal(created.status, 'created');
    assert.equal(duplicate.status, 'already_applied');
    assert.equal(await store.forget(created.entry!.id), true);

    const retry = await store.add({ ...input, operationId: 'retry-with-new-operation' });
    assert.equal(retry.status, 'suppressed');
    assert.equal((await store.search('生日', { authorizedSpaceIds: [space.id] })).length, 0);
  });
});

test('correction uses optimistic versions and leaves the new value authoritative', async () => {
  await withStore(async (store) => {
    const space = await store.createSpace('个人');
    const { entry } = await store.add({
      spaceId: space.id,
      kind: 'preference',
      content: '我喜欢很长的回答',
      confidence: 'user_stated',
      source,
    });
    const corrected = await store.correct(entry.id, 1, {
      content: '我更喜欢简洁的回答',
      confidence: 'user_confirmed',
      source: { ...source, sourceId: 'correction-message', excerpt: '回答尽量简洁' },
    });
    assert.equal(corrected.version, 2);
    assert.equal((await store.search('简洁', { authorizedSpaceIds: [space.id] }))[0].content, '我更喜欢简洁的回答');
    await assert.rejects(
      () => store.correct(entry.id, 1, { content: 'stale overwrite' }),
      /version conflict/i,
    );
  });
});

test('unconfirmed memories are visible for review but do not enter automatic context', async () => {
  await withStore(async (store) => {
    const space = await store.createSpace('求职');
    await store.add({
      spaceId: space.id,
      kind: 'fact',
      content: '我可能独立负责了整个项目',
      confidence: 'inferred',
      source,
    });
    assert.equal((await store.listForReview({ authorizedSpaceIds: [space.id] })).length, 1);
    assert.equal((await store.search('负责项目', { authorizedSpaceIds: [space.id] })).length, 0);
    assert.equal((await store.search('负责项目', { authorizedSpaceIds: [space.id], includeInferred: true })).length, 1);
  });
});

test('parallel writes do not lose records', async () => {
  await withStore(async (store) => {
    const space = await store.createSpace('技术探索');
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.add({
      spaceId: space.id,
      kind: 'opinion',
      content: `我对方案${i}的看法`,
      confidence: 'user_stated',
      source: { ...source, sourceId: `source-${i}`, excerpt: `方案${i}` },
    })));
    assert.equal((await store.search('方案', { authorizedSpaceIds: [space.id], limit: 30 })).length, 20);
  });
});

test('formatted context obeys its character budget and does not expose other spaces', async () => {
  await withStore(async (store) => {
    const food = await store.createSpace('日常生活');
    const career = await store.createSpace('求职');
    await store.add({
      spaceId: food.id,
      kind: 'preference',
      content: '香菜要特别避开'.repeat(30),
      confidence: 'user_stated',
      source,
    });
    await store.add({
      spaceId: career.id,
      kind: 'fact',
      content: '简历项目不可公开',
      confidence: 'source_supported',
      source: { ...source, sourceId: 'career-source' },
    });

    const context = await store.formatContext('香菜', {
      authorizedSpaceIds: [food.id],
      maxCharacters: 180,
    });
    assert.ok(context.length <= 181);
    assert.match(context, /日常生活/);
    assert.doesNotMatch(context, /不可公开|求职/);
  });
});

test('operation idempotency and forgotten-source suppression are isolated by owner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-os-memory-owner-'));
  try {
    const ownerA = new PersonalMemoryStore({ directory: dir, ownerId: 'owner-a' });
    const ownerB = new PersonalMemoryStore({ directory: dir, ownerId: 'owner-b' });
    const spaceA = await ownerA.createSpace('个人');
    const spaceB = await ownerB.createSpace('个人');
    const input = {
      spaceId: spaceA.id,
      kind: 'fact' as const,
      content: '同一来源标识可以属于不同用户',
      confidence: 'user_stated' as const,
      source: { ...source, sourceId: 'shared-source' },
      operationId: 'shared-operation',
    };
    const a = await ownerA.add(input);
    assert.equal(a.status, 'created');
    await ownerA.forget(a.entry!.id);
    const b = await ownerB.add({ ...input, spaceId: spaceB.id });
    assert.equal(b.status, 'created');
    const retried = await ownerA.add({ ...input, content: 'different content' });
    assert.equal(retried.status, 'suppressed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a corrupt store is not overwritten by a mutation', async () => {
  await withStore(async (store, dir) => {
    const { writeFile, readFile } = await import('node:fs/promises');
    const path = join(dir, 'personal-memory.json');
    await writeFile(path, '{not-json');
    await assert.rejects(() => store.createSpace('个人'), /JSON|position|property/i);
    assert.equal(await readFile(path, 'utf8'), '{not-json');
  });
});

test('failed persistence rejects the save operation instead of implying success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-memory-failure-'));
  const blockedDirectory = join(root, 'not-a-directory');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(blockedDirectory, 'file');
  try {
    const store = new PersonalMemoryStore({ directory: blockedDirectory, ownerId: 'jackson' });
    await assert.rejects(() => store.createSpace('个人'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
