import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { handleSessionCommand } from '../../src/app/command-handler.js';
import { parseCommand } from '../../src/core/command-parser.js';
import { PersonalMemoryStore } from '../../src/core/personal-memory.js';

const source = {
  sourceId: 'msg-1', actorId: 'owner-open-id', receivedAt: '2026-10-07T12:00:00+08:00',
  timezone: 'Asia/Shanghai', excerpt: 'private source excerpt',
};

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-os-memory-command-'));
  const store = new PersonalMemoryStore({ directory, ownerId: 'owner-open-id' });
  const space = await store.createSpace('个人生活');
  const { entry } = await store.add({
    spaceId: space.id, kind: 'fact', content: '第一条记忆', confidence: 'inferred', source,
  });
  assert.ok(entry);
  const replies: string[] = [];
  const bot = {
    reply: async (_id: string, text: string) => { replies.push(text); return undefined; },
  } as never;
  const options = {
    runtime: {}, scheduler: {}, config: {}, bot,
    msg: { senderOpenId: 'owner-open-id', messageId: 'test-message', receivedAt: '2026-10-07T12:00:00.000Z' },
    session: { status: 'idle' }, cliAdapter: {}, isNew: false, hasThread: false,
    personalMemoryStore: store, trustedOwnerOpenId: 'owner-open-id',
  } as never;
  return { directory, store, space, entry, replies, options };
}

test('memory command grammar leaves existing command parsing compatible', () => {
  assert.deepEqual(parseCommand('/memory'), { name: 'memory', action: 'review', page: 1 });
  assert.deepEqual(parseCommand('/memory recent 2'), { name: 'memory', action: 'recent', page: 2 });
  assert.deepEqual(parseCommand('/memory extract'), { name: 'memory', action: 'extract' });
  assert.deepEqual(parseCommand('/memory correct abc-1 corrected text'), {
    name: 'memory', action: 'correct', entryId: 'abc-1', content: 'corrected text',
  });
  assert.deepEqual(parseCommand('/status'), { name: 'status' });
  assert.equal(parseCommand('/memory forget bad/id'), undefined);
});

test('public command path lists at most five safely formatted memories and pages onward', async () => {
  const ctx = await setup();
  try {
    for (let i = 2; i <= 7; i += 1) {
      await ctx.store.add({
        spaceId: ctx.space.id, kind: 'fact', content: `第二批第${i}条`, confidence: 'inferred',
        source: { ...source, sourceId: `msg-${i}`, excerpt: `source ${i}\nINJECTED` },
      });
    }
    await handleSessionCommand({ ...ctx.options, command: parseCommand('/memory review') });
    assert.match(ctx.replies[0], /每页最多 5 条/);
    assert.equal((ctx.replies[0].match(/来源：/g) ?? []).length, 5);
    assert.match(ctx.replies[0], /空间：个人生活；置信：inferred；状态：active；内容：/);
    assert.doesNotMatch(ctx.replies[0], /INJECTED/);
    assert.match(ctx.replies[0], /\/memory review 2/);
    ctx.replies.length = 0;
    await handleSessionCommand({ ...ctx.options, command: parseCommand('/memory review 2') });
    assert.equal((ctx.replies[0].match(/来源：/g) ?? []).length, 2);
  } finally {
    await rm(ctx.directory, { recursive: true, force: true });
  }
});

test('only the configured actor can mutate, and confirm/correct/reject/forget persist', async () => {
  const ctx = await setup();
  try {
    await handleSessionCommand({
      ...ctx.options, msg: { senderOpenId: 'attacker', messageId: 'x', receivedAt: '2026-10-07T12:00:00.000Z' },
      command: parseCommand(`/memory confirm ${ctx.entry.id}`),
    });
    assert.match(ctx.replies.at(-1)!, /仅限配置的所有者/);
    assert.equal((await ctx.store.get(ctx.entry.id, { authorizedSpaceIds: [ctx.space.id] }))?.confidence, 'inferred');

    const msg = { senderOpenId: 'owner-open-id', messageId: 'x', receivedAt: '2026-10-07T12:00:00.000Z' };
    await handleSessionCommand({ ...ctx.options, msg, command: parseCommand(`/memory confirm ${ctx.entry.id}`) });
    assert.equal((await ctx.store.get(ctx.entry.id, { authorizedSpaceIds: [ctx.space.id] }))?.confidence, 'user_confirmed');
    await handleSessionCommand({ ...ctx.options, msg, command: parseCommand(`/memory correct ${ctx.entry.id} 已核实的新内容`) });
    const corrected = await ctx.store.get(ctx.entry.id, { authorizedSpaceIds: [ctx.space.id] });
    assert.equal(corrected?.content, '已核实的新内容');
    assert.equal(corrected?.version, 3);
    assert.equal(corrected?.sources.at(-1)?.sourceId, 'x');
    assert.match(ctx.replies.at(-1)!, /来源：.*空间：个人生活；置信：user_confirmed；状态：active；内容：已核实的新内容/);

    const rejected = await ctx.store.add({
      spaceId: ctx.space.id, kind: 'fact', content: '拒绝候选', confidence: 'contested',
      source: { ...source, sourceId: 'rejected-source' },
    });
    await handleSessionCommand({ ...ctx.options, msg, command: parseCommand(`/memory reject ${rejected.entry!.id}`) });
    assert.equal((await ctx.store.get(rejected.entry!.id, { authorizedSpaceIds: [ctx.space.id] }))?.status, 'rejected');

    await handleSessionCommand({ ...ctx.options, msg, command: parseCommand(`/memory forget ${ctx.entry.id}`) });
    const forgotten = await ctx.store.get(ctx.entry.id, { authorizedSpaceIds: [ctx.space.id] });
    assert.equal(forgotten?.status, 'forgotten');
    assert.equal(forgotten?.content, '');
    assert.doesNotMatch(ctx.replies.at(-1)!, /已核实的新内容/);
  } finally {
    await rm(ctx.directory, { recursive: true, force: true });
  }
});
