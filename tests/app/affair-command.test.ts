import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { handleSessionCommand } from '../../src/app/command-handler.js';
import { JsonPersonalAffairStore } from '../../src/core/affairs.js';
import { JsonUnifiedTaskStore, UnifiedTaskRuntime } from '../../src/app/unified-task-runtime.js';
import { parseCommand } from '../../src/core/command-parser.js';
import { SessionManager } from '../../src/core/session-manager.js';
import { JsonSessionStore } from '../../src/core/session-store.js';

const at = '2026-10-07T12:00:00.000Z';

test('owner selects a same-chat affair in another thread with scope and summary only; native sessions stay isolated after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-os-affair-command-'));
  try {
    const affairsPath = join(directory, 'affairs.json');
    const affairs = new JsonPersonalAffairStore(affairsPath);
    await affairs.ensure({ id: 'matter-source', ownerId: 'owner', actorId: 'owner', chatId: 'chat-a', memorySpaceIds: ['job', 'project'], now: at });
    await affairs.setSummary('matter-source', 'owner', 'owner', 'chat-a', 'Resume deep dive', at);
    await affairs.ensure({ id: 'matter-target', ownerId: 'owner', actorId: 'owner', chatId: 'chat-a', memorySpaceIds: ['daily'], now: at });
    const sessionsPath = join(directory, 'sessions.json');
    const sessions = await SessionManager.open({ store: new JsonSessionStore(sessionsPath) });
    const source = await sessions.resolve({ messageId: 'm1', chatId: 'chat-a', threadId: 'thread-1', rootId: '' }, 'agy', 'assistant', '/workspace');
    await sessions.transition(source.session.id, 'idle');
    await sessions.selectAffair(source.session.id, 'matter-source', ['job', 'project']);
    await sessions.setCliSessionId(source.session.id, 'source-native-session');
    const target = await sessions.resolve({ messageId: 'm2', chatId: 'chat-a', threadId: 'thread-2', rootId: '' }, 'agy', 'assistant', '/workspace');
    await sessions.transition(target.session.id, 'idle');
    await sessions.setAffairId(target.session.id, 'matter-target');
    await sessions.setCliSessionId(target.session.id, 'target-native-session');

    const replies: string[] = [];
    const bot = { reply: async (_id: string, text: string) => { replies.push(text); } } as never;
    const options = {
      runtime: { sessions, activeRuns: new Map() }, scheduler: {}, config: {}, bot,
      msg: { senderOpenId: 'owner', chatType: 'p2p', chatId: 'chat-a', messageId: 'command', receivedAt: at },
      session: sessions.get(target.session.id), cliAdapter: {}, isNew: false, hasThread: true,
      trustedOwnerOpenId: 'owner', personalAffairStore: affairs,
    } as never;
    await handleSessionCommand({ ...options, command: parseCommand('/affair select matter-source') });
    assert.match(replies.at(-1)!, /没有找到本所有者、本私聊中的该事项/);
    await handleSessionCommand({ ...options, command: parseCommand('/affair list') });
    assert.match(replies.at(-1)!, /matter-source/);
    await handleSessionCommand({ ...options, command: parseCommand('/affair select matter-source') });
    const selected = sessions.get(target.session.id)!;
    assert.equal(selected.affairId, 'matter-source');
    assert.deepEqual(selected.memorySpaceIds, ['job', 'project']);
    assert.equal(selected.cliSessionId, undefined);
    assert.equal(sessions.get(source.session.id)?.cliSessionId, 'source-native-session');
    assert.match(replies.at(-1)!, /只带入了该事项的摘要与 2 个仍有效的授权记忆空间/);

    const reopenedSessions = await SessionManager.open({ store: new JsonSessionStore(sessionsPath) });
    const targetAfterRestart = await reopenedSessions.resolve({ messageId: 'm3', chatId: 'chat-a', threadId: 'thread-2', rootId: '' }, 'agy', 'assistant', '/workspace');
    assert.equal(targetAfterRestart.session.affairId, 'matter-source');
    assert.deepEqual(targetAfterRestart.session.memorySpaceIds, ['job', 'project']);
    assert.equal(targetAfterRestart.session.cliSessionId, undefined);
    const reopenedAffairs = new JsonPersonalAffairStore(affairsPath);
    assert.equal((await reopenedAffairs.get(targetAfterRestart.session.affairId!, 'owner', 'owner', 'chat-a'))?.summary, 'Resume deep dive');
    let preparedAffairId: string | undefined;
    let preparedSpaces: readonly string[] = [];
    const taskRuntime = new UnifiedTaskRuntime({
      store: new JsonUnifiedTaskStore(join(directory, 'tasks.json')),
      memoryContext: { async prepare(request) { preparedAffairId = request.affairId; preparedSpaces = request.authorizedMemorySpaceIds; return undefined; } },
      executor: { async execute() { return { outcome: 'succeeded' as const, result: 'ok', artifacts: [] }; } },
    });
    const task = await taskRuntime.run({
      trusted: { actorId: 'owner', ownerId: 'owner' }, affairId: targetAfterRestart.session.affairId!,
      trigger: { source: 'message', occurredAt: at }, authorizedMemorySpaceIds: targetAfterRestart.session.memorySpaceIds!,
      input: { messageId: 'after-restart' }, signal: new AbortController().signal,
    });
    assert.equal(task.affairId, 'matter-source');
    assert.equal(preparedAffairId, 'matter-source');
    assert.deepEqual(preparedSpaces, ['job', 'project']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('guessed cross-chat IDs, non-owner, group, and active-session affair operations are rejected', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-os-affair-gates-'));
  try {
    const affairs = new JsonPersonalAffairStore(join(directory, 'affairs.json'));
    await affairs.ensure({ id: 'private-matter', ownerId: 'owner', actorId: 'owner', chatId: 'chat-secret', memorySpaceIds: ['private-space'], now: at });
    const sessions = await SessionManager.open({ store: new JsonSessionStore(join(directory, 'sessions.json')) });
    const resolved = await sessions.resolve({ messageId: 'm', chatId: 'chat-other', threadId: 'thread', rootId: '' }, 'agy', 'assistant', '/workspace');
    await sessions.transition(resolved.session.id, 'idle');
    await sessions.setAffairId(resolved.session.id, 'current-matter');
    const replies: string[] = [];
    const bot = { reply: async (_id: string, text: string) => { replies.push(text); } } as never;
    const base = {
      runtime: { sessions, activeRuns: new Map() }, scheduler: {}, config: {}, bot,
      msg: { senderOpenId: 'owner', chatType: 'p2p', chatId: 'chat-other', messageId: 'command', receivedAt: at },
      session: sessions.get(resolved.session.id), cliAdapter: {}, isNew: false, hasThread: false,
      trustedOwnerOpenId: 'owner', personalAffairStore: affairs,
    } as never;
    await handleSessionCommand({ ...base, command: parseCommand('/affair select private-matter') });
    assert.match(replies.at(-1)!, /没有找到本所有者、本私聊中的该事项/);
    assert.deepEqual(await affairs.listForSelection('owner', 'owner', 'chat-other', 'thread', new Date(at)), []);

    await handleSessionCommand({ ...base, msg: { ...base.msg, senderOpenId: 'intruder' }, command: parseCommand('/affair list') });
    assert.match(replies.at(-1)!, /仅限所有者在私聊中使用/);
    await handleSessionCommand({ ...base, msg: { ...base.msg, chatType: 'group' }, command: parseCommand('/affair list') });
    assert.match(replies.at(-1)!, /仅限所有者在私聊中使用/);
    await sessions.transition(resolved.session.id, 'active');
    await handleSessionCommand({ ...base, session: sessions.get(resolved.session.id), command: parseCommand('/affair summary not allowed') });
    assert.match(replies.at(-1)!, /仍在执行/);
    assert.equal((await affairs.get('private-matter', 'owner', 'owner', 'chat-secret'))?.summary, '');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
