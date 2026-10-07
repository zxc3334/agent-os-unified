import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PersonalMemoryToolBridge } from '../../src/app/personal-memory-bridge.js';
import { PersonalMemoryStore } from '../../src/core/personal-memory.js';
import { confidenceFromTrustedSource } from '../../src/core/personal-memory-tool.js';

async function withBridge(run: (options: {
  bridge: PersonalMemoryToolBridge;
  store: PersonalMemoryStore;
  baseUrl: string;
}) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-os-memory-bridge-'));
  const store = new PersonalMemoryStore({ directory, ownerId: 'trusted-owner' });
  const bridge = new PersonalMemoryToolBridge(store);
  const port = await bridge.start();
  try {
    await run({ bridge, store, baseUrl: `http://127.0.0.1:${port}/api/personal-memory/remember` });
  } finally {
    await bridge.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('personal-memory tool reports success only after durable persistence', async () => {
  await withBridge(async ({ bridge, store, baseUrl }) => {
    const lease = bridge.issue({
      actorId: 'trusted-owner', ownerId: 'trusted-owner', sourceId: 'message-1',
      receivedAt: '2026-10-07T12:00:00.000Z', timezone: 'Asia/Shanghai',
      sourceText: '记住我女朋友的生日是 10 月 9 日', authorizedSpaceIds: [],
    });
    try {
      const response = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-personal-memory-token': lease.token },
        body: JSON.stringify({
          spaceName: '个人生活', kind: 'fact', content: '女朋友生日是 10 月 9 日', tags: ['生日'],
        }),
      });
      assert.equal(response.status, 201);
      const result = await response.json() as { entryId: string; confidence: string; space: string };
      assert.equal(result.confidence, 'user_stated');
      assert.equal(result.space, '个人生活');
      const spaces = await store.listSpaces();
      const entry = await store.get(result.entryId, { authorizedSpaceIds: spaces.map((space) => space.id) });
      assert.equal(entry?.content, '女朋友生日是 10 月 9 日');
      assert.equal(entry?.sources[0]?.sourceId, 'message-1');
      assert.equal(entry?.sources[0]?.excerpt, '记住我女朋友的生日是 10 月 9 日');

      const replay = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-personal-memory-token': lease.token },
        body: JSON.stringify({ spaceName: '个人生活', kind: 'fact', content: '女朋友生日是 10 月 9 日' }),
      });
      assert.equal(replay.status, 200);
      assert.equal((await replay.json() as { status: string }).status, 'already_applied');
    } finally {
      lease.release();
    }
  });
});

test('tool invocation token is temporary and model input cannot supply trusted ownership or source', async () => {
  await withBridge(async ({ bridge, baseUrl }) => {
    const noToken = await fetch(baseUrl, { method: 'POST', body: '{}' });
    assert.equal(noToken.status, 401);
    const lease = bridge.issue({
      actorId: 'not-owner', ownerId: 'trusted-owner', sourceId: 'trusted-source',
      receivedAt: '2026-10-07T12:00:00.000Z', timezone: 'UTC', sourceText: '我不吃香菜',
    });
    try {
      const denied = await fetch(baseUrl, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-personal-memory-token': lease.token },
        body: JSON.stringify({
          spaceName: '我的空间', kind: 'preference', content: '我不吃香菜',
          ownerId: 'attacker', sourceId: 'attacker-source', confidence: 'user_confirmed',
        }),
      });
      assert.equal(denied.status, 403);
    } finally {
      lease.release();
    }
    const expired = await fetch(baseUrl, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-personal-memory-token': lease.token },
      body: JSON.stringify({ spaceName: '个人', kind: 'fact', content: '未授权' }),
    });
    assert.equal(expired.status, 401);
  });
});

test('rejected memory suppresses only the rejected claim, not unrelated claims from the same source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-os-memory-reject-'));
  try {
    const store = new PersonalMemoryStore({ directory, ownerId: 'owner' });
    const space = await store.createSpace('求职');
    const source = { sourceId: 'same-message', actorId: 'owner', receivedAt: '2026-10-07T12:00:00Z', timezone: 'UTC' };
    const rejected = await store.add({
      spaceId: space.id, kind: 'fact', content: '模型误提取的错误陈述', confidence: 'inferred', source,
    });
    await store.reject(rejected.entry!.id, 1);
    assert.equal((await store.add({
      spaceId: space.id, kind: 'fact', content: '模型误提取的错误陈述', confidence: 'inferred', source,
    })).status, 'suppressed');
    assert.equal((await store.add({
      spaceId: space.id, kind: 'fact', content: '另一个正确的候选', confidence: 'inferred', source,
    })).status, 'created');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('on-demand search is limited to trusted authorized spaces', async () => {
  await withBridge(async ({ bridge, store, baseUrl }) => {
    const privateSpace = await store.createSpace('日常生活');
    const projectSpace = await store.createSpace('项目 Alpha');
    const source = { sourceId: 'source', actorId: 'trusted-owner', receivedAt: '2026-10-07T12:00:00Z', timezone: 'Asia/Shanghai' };
    await store.add({ spaceId: privateSpace.id, kind: 'preference', content: '我不吃香菜', confidence: 'user_stated', source });
    await store.add({ spaceId: projectSpace.id, kind: 'fact', content: '项目 Alpha 使用 TypeScript', confidence: 'user_confirmed', source: { ...source, sourceId: 'source-2' } });
    const lease = bridge.issue({
      actorId: 'trusted-owner', ownerId: 'trusted-owner', sourceId: 'query-message',
      receivedAt: '2026-10-07T13:00:00Z', timezone: 'Asia/Shanghai', sourceText: '项目 Alpha 的技术栈是什么？',
      authorizedSpaceIds: [projectSpace.id],
    });
    try {
      const response = await fetch(baseUrl.replace('/remember', '/search'), {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-personal-memory-token': lease.token },
        body: JSON.stringify({ query: '项目 Alpha 技术栈', limit: 5 }),
      });
      assert.equal(response.status, 200);
      const result = await response.json() as { entries: Array<{ content: string; space: string }> };
      assert.deepEqual(result.entries.map((entry) => entry.content), ['项目 Alpha 使用 TypeScript']);
      assert.equal(result.entries[0]?.space, '项目 Alpha');
    } finally {
      lease.release();
    }
  });
});

test('confidence is derived from trusted source wording, never tool arguments', () => {
  assert.equal(confidenceFromTrustedSource('preference', '我不吃香菜'), 'user_stated');
  assert.equal(confidenceFromTrustedSource('event', '今天午饭吃了拉面'), 'user_stated');
  assert.equal(confidenceFromTrustedSource('fact', '用户主导了整个系统重构'), 'inferred');
});
