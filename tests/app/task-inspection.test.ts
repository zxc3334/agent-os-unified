import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleSessionCommand } from '../../src/app/command-handler.js';
import { parseCommand } from '../../src/core/command-parser.js';
import type { UnifiedTask } from '../../src/app/unified-task-runtime.js';

const timestamp = '2026-10-07T10:00:00.000Z';
function task(id: string, ownerId: string, trace = false): UnifiedTask {
  return {
    id, trusted: { actorId: ownerId, ownerId }, affairId: `affair-${id}`,
    trigger: { source: 'message', sourceId: `source-${id}`, occurredAt: timestamp },
    authorizedMemorySpaceIds: [], input: 'PRIVATE-INPUT-MARKER', status: 'succeeded',
    createdAt: timestamp, updatedAt: timestamp, completedAt: timestamp, artifacts: [],
    result: 'PRIVATE-RESULT-MARKER',
    traceHistory: trace ? [{
      version: 1, taskId: id, source: 'message', sourceId: `source-${id}`, stage: 'failed',
      timestamp, artifactIds: ['artifact-1'], failureCode: 'execution_failed',
      skillVersions: [{ id: 'career-interview', version: 1 }],
      memoryOperations: [{ tool: 'save_personal_memory', operation: 'write', status: 'attempted' }],
      memorySources: [{ id: 'mem-1', version: 2 }],
      durationMs: 1200, usage: { totalTokens: 100, cost: 'unknown' },
    }] : [],
  };
}
function makeOptions(tasks: UnifiedTask[], senderOpenId = 'owner', chatType = 'p2p') {
  const replies: string[] = [];
  const bot = { reply: async (_id: string, text: string) => { replies.push(text); return undefined; } } as never;
  const store = {
    get: async (id: string) => tasks.find((item) => item.id === id),
    list: async () => tasks,
    save: async () => undefined,
  };
  const options = {
    runtime: { unifiedTaskStore: store }, scheduler: {}, config: {}, bot,
    msg: { senderOpenId, chatType, messageId: 'command-1', receivedAt: timestamp },
    session: { id: 'session-1', status: 'idle' }, cliAdapter: {}, isNew: false, hasThread: false,
    trustedOwnerOpenId: 'owner',
  } as never;
  return { options, replies };
}

test('owner can list recent personal tasks and inspect content-free trace steps', async () => {
  const ctx = makeOptions([task('task-private', 'owner', true), task('task-other', 'someone-else')]);
  await handleSessionCommand({ ...ctx.options, command: parseCommand('/task recent') });
  assert.match(ctx.replies.at(-1)!, /task-private/);
  assert.doesNotMatch(ctx.replies.at(-1)!, /task-other/);
  await handleSessionCommand({ ...ctx.options, command: parseCommand('/task trace task-private') });
  const trace = ctx.replies.at(-1)!;
  assert.match(trace, /execution_failed/);
  assert.match(trace, /source-task-private/);
  assert.match(trace, /artifact-1/);
  assert.match(trace, /career-interview@1/);
  assert.match(trace, /记忆操作 write:save_personal_memory/);
  assert.match(trace, /使用记忆 mem-1@v2/);
  assert.match(trace, /耗时 1200ms/);
  assert.match(trace, /费用未知/);
  assert.doesNotMatch(trace, /PRIVATE-INPUT-MARKER|PRIVATE-RESULT-MARKER/);
});

test('task inspection rejects group chats, non-owners, and tasks owned by another person', async () => {
  const group = makeOptions([task('task-private', 'owner', true)], 'owner', 'group');
  await handleSessionCommand({ ...group.options, command: parseCommand('/task recent') });
  assert.match(group.replies.at(-1)!, /仅限所有者在私聊中查看/);

  const nonOwner = makeOptions([task('task-private', 'owner', true)], 'other');
  await handleSessionCommand({ ...nonOwner.options, command: parseCommand('/task recent') });
  assert.match(nonOwner.replies.at(-1)!, /仅限所有者在私聊中查看/);

  const hidden = makeOptions([task('task-other', 'someone-else', true)]);
  await handleSessionCommand({ ...hidden.options, command: parseCommand('/task trace task-other') });
  assert.match(hidden.replies.at(-1)!, /没有找到属于你的事项/);
});

test('task inspection command accepts only bounded, safe task identifiers', () => {
  assert.deepEqual(parseCommand('/task recent'), { name: 'task', action: 'recent' });
  assert.deepEqual(parseCommand('/task trace task-1'), { name: 'task', action: 'trace', taskId: 'task-1' });
  assert.equal(parseCommand('/task trace ../../private'), undefined);
});
