import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PersonalMemoryToolBridge } from '../../src/app/personal-memory-bridge.js';
import { PersonalMemoryStore } from '../../src/core/personal-memory.js';
import { confidenceFromTrustedSource } from '../../src/core/personal-memory-tool.js';
import { JsonDailyRecordsReminders } from '../../src/core/daily-records.js';

async function withBridge(run: (options: {
  bridge: PersonalMemoryToolBridge;
  store: PersonalMemoryStore;
  daily: JsonDailyRecordsReminders;
  invalidated: string[];
  baseUrl: string;
}) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-os-memory-bridge-'));
  const store = new PersonalMemoryStore({ directory, ownerId: 'trusted-owner' });
  const daily = new JsonDailyRecordsReminders(join(directory, 'daily.json'));
  const invalidated: string[] = [];
  const bridge = new PersonalMemoryToolBridge(store, daily, undefined, (record) => invalidated.push(record.id));
  const port = await bridge.start();
  try {
    await run({ bridge, store, daily, invalidated, baseUrl: `http://127.0.0.1:${port}/api/personal-memory/remember` });
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


test('owner-only tools capture dated records, schedule reminders from trusted receipt time, and search authorized spaces', async () => {
  await withBridge(async ({ bridge, daily, baseUrl }) => {
    const spaceId = 'reading-space';
    const lease = bridge.issue({
      actorId: 'trusted-owner', ownerId: 'trusted-owner', sourceId: 'daily-message',
      receivedAt: '2026-10-07T12:00:00.000Z', timezone: 'Asia/Shanghai',
      sourceText: '作者认为注意力有限，我认为练习比专注更重要。明天上午九点提醒我复盘。',
      authorizedSpaceIds: [spaceId], allowUnclassifiedRecords: false, chatId: 'owner-dm', botId: 'assistant',
    });
    try {
      const capture = await fetch(baseUrl.replace('/api/personal-memory/remember', '/api/daily-records/capture'), {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-personal-memory-token': lease.token },
        body: JSON.stringify({
          kind: 'reading', content: '复盘阅读笔记', spaceId,
          authorView: '注意力有限', userView: '练习比专注更重要',
        }),
      });
      assert.equal(capture.status, 201);
      const captured = await capture.json() as { recordId: string; date: string };
      assert.equal(captured.date, '2026-10-07');
      assert.equal(daily.getRecord(captured.recordId)?.authorView, '注意力有限');

      const reminder = await fetch(baseUrl.replace('/api/personal-memory/remember', '/api/personal-reminders/create'), {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-personal-memory-token': lease.token },
        body: JSON.stringify({ content: '复盘', relativeDue: '明天上午9点', recordId: captured.recordId }),
      });
      assert.equal(reminder.status, 201);
      const reminderResult = await reminder.json() as { reminderId: string; dueAt: string };
      assert.equal(reminderResult.dueAt, '2026-10-08T01:00:00.000Z'); // Asia/Shanghai Oct 8 09:00
      assert.deepEqual(daily.getReminder(reminderResult.reminderId)?.deliveryTarget, { botId: 'assistant', chatId: 'owner-dm' });

      const recap = await fetch(baseUrl.replace('/api/personal-memory/remember', '/api/daily-records/search'), {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-personal-memory-token': lease.token },
        body: JSON.stringify({ from: '2026-10-07', through: '2026-10-07', spaceId }),
      });
      assert.equal(recap.status, 200);
      const recapResult = await recap.json() as { records: Array<{ authorView?: string; userView?: string }> };
      assert.equal(recapResult.records[0]?.authorView, '注意力有限');
      assert.equal(recapResult.records[0]?.userView, '练习比专注更重要');
      daily.createRecord({
        operationId: 'unclassified-record', kind: 'daily', date: '2026-10-07', content: '不应跨项目泄露',
        source: { sourceId: 'unclassified-source', actorId: 'trusted-owner', receivedAt: '2026-10-07T12:00:00.000Z', timezone: 'Asia/Shanghai' },
      });
      const scopedAgain = await fetch(baseUrl.replace('/api/personal-memory/remember', '/api/daily-records/search'), {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-personal-memory-token': lease.token },
        body: JSON.stringify({ from: '2026-10-07', through: '2026-10-07' }),
      });
      const scopedRows = await scopedAgain.json() as { records: Array<{ content: string }> };
      assert.deepEqual(scopedRows.records.map((record) => record.content), ['复盘阅读笔记']);

      const denied = await fetch(baseUrl.replace('/api/personal-memory/remember', '/api/daily-records/search'), {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-personal-memory-token': lease.token },
        body: JSON.stringify({ from: '2026-10-07', through: '2026-10-07', spaceId: 'unauthorized' }),
      });
      assert.equal(denied.status, 403);
    } finally { lease.release(); }
  });
});


test('natural-language record deletion requires explicit non-negated owner intent and authorized record scope', async () => {
  await withBridge(async ({ bridge, daily, invalidated, baseUrl }) => {
    const record = daily.createRecord({
      operationId: 'delete-target', kind: 'reading', date: '2026-10-07', content: 'Private reading note',
      userView: 'My private opinion', scopeId: 'reading-space',
      source: { sourceId: 'original', actorId: 'trusted-owner', receivedAt: '2026-10-07T12:00:00.000Z', timezone: 'Asia/Shanghai' },
    });
    const route = baseUrl.replace('/api/personal-memory/remember', '/api/daily-records/delete');
    const headers = { 'content-type': 'application/json', 'x-personal-memory-token': '' };
    const deniedLease = bridge.issue({
      actorId: 'trusted-owner', ownerId: 'trusted-owner', sourceId: 'delete-request-1',
      receivedAt: '2026-10-07T12:00:00.000Z', timezone: 'Asia/Shanghai',
      sourceText: '不要删除这条阅读记录', authorizedSpaceIds: ['reading-space'],
    });
    try {
      const denied = await fetch(route, {
        method: 'POST', headers: { ...headers, 'x-personal-memory-token': deniedLease.token },
        body: JSON.stringify({ recordId: record.id }),
      });
      assert.equal(denied.status, 403);
      assert.equal(daily.getRecord(record.id)?.content, 'Private reading note');
      assert.deepEqual(invalidated, []);
    } finally { deniedLease.release(); }

    const outOfScopeLease = bridge.issue({
      actorId: 'trusted-owner', ownerId: 'trusted-owner', sourceId: 'delete-request-2',
      receivedAt: '2026-10-07T12:00:00.000Z', timezone: 'Asia/Shanghai',
      sourceText: '请删除这条阅读记录', authorizedSpaceIds: ['career'],
    });
    try {
      const denied = await fetch(route, {
        method: 'POST', headers: { ...headers, 'x-personal-memory-token': outOfScopeLease.token },
        body: JSON.stringify({ recordId: record.id }),
      });
      assert.equal(denied.status, 404);
      assert.equal(daily.getRecord(record.id)?.content, 'Private reading note');
    } finally { outOfScopeLease.release(); }

    const lease = bridge.issue({
      actorId: 'trusted-owner', ownerId: 'trusted-owner', sourceId: 'delete-request-3',
      receivedAt: '2026-10-07T12:00:00.000Z', timezone: 'Asia/Shanghai',
      sourceText: '请删除这条阅读记录', authorizedSpaceIds: ['reading-space'],
    });
    try {
      const deleted = await fetch(route, {
        method: 'POST', headers: { ...headers, 'x-personal-memory-token': lease.token },
        body: JSON.stringify({ recordId: record.id }),
      });
      assert.equal(deleted.status, 200);
      assert.deepEqual(await deleted.json(), { recordId: record.id, status: 'deleted' });
      assert.equal(daily.getRecord(record.id)?.content, '');
      assert.equal(daily.getRecord(record.id)?.userView, undefined);
      assert.deepEqual(invalidated, [record.id]);
    } finally { lease.release(); }
  });
});
