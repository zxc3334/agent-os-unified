import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { SessionManager } from '../../src/core/session-manager.js';
import { TeamRegistry } from '../../src/core/team-registry.js';
import { PersonalMemoryStore } from '../../src/core/personal-memory.js';
import { JsonUnifiedTaskStore } from '../../src/app/unified-task-runtime.js';
import { runScheduledTaskDirectly } from '../../src/app/scheduled-task-runner.js';
import type { AppRuntime } from '../../src/app/runtime.js';
import type { ScheduledTask } from '../../src/core/schedule.js';

const scheduledFor = '2026-10-08T09:30:00.000Z';

async function withFixture(run: (root: string, runtime: AppRuntime, captured: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'scheduled-task-runtime-'));
  const bin = join(root, 'bin');
  await mkdir(bin, { recursive: true });
  const captured = join(root, 'fake-cli.json');
  const fixture = join(bin, 'codex');
  await writeFile(fixture, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.FAKE_CLI_CAPTURE, JSON.stringify({ args: process.argv.slice(2), prompt: process.argv.slice(2).at(-1), chatId: process.env.AGENT_OS_CHAT_ID, ownerId: process.env.AGENT_OS_OWNER_OPEN_ID }));
const partial = process.env.FAKE_CLI_PARTIAL === '1';
if (process.env.FAKE_CLI_FAIL === '1') { console.log(JSON.stringify({ type: 'turn.failed', message: 'fixture failure' })); process.exit(0); }
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fake-native-session' }));
if (process.env.FAKE_CLI_MEMORY_TOOL === '1') {
  console.log(JSON.stringify({ type: 'item.started', item: { id: 'memory-tool', type: 'mcp_tool_call', server: 'agent_os', tool: 'save_personal_memory', arguments: { content: 'secret personal note' } } }));
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'memory-tool', type: 'mcp_tool_call', status: 'completed' } }));
}
if (partial) {
  console.log(JSON.stringify({ type: 'item.started', item: { id: 'failed-tool', type: 'command_execution', command: 'fixture task' } }));
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'failed-tool', type: 'command_execution', status: 'failed', exit_code: 1 } }));
}
console.log(JSON.stringify({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'fixture answer' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 4, output_tokens: 3 } }));
`);
  await chmod(fixture, 0o755);
  const sessions = new SessionManager();
  const bot = {
    id: 'assistant', appId: '', appSecret: '', defaultCliId: 'codex' as const,
    role: '个人助理', skills: [], systemPrompt: '', workspaceDir: root,
    collaborationMaxRounds: 4, project: 'test-project',
  };
  const teamRegistry = new TeamRegistry(bot.id, [bot]);
  const personalMemoryStore = new PersonalMemoryStore({ directory: join(root, 'memory'), ownerId: 'trusted-owner' });
  const runtime: AppRuntime = {
    sessions,
    teamRegistry,
    activeRuns: new Map(),
    contextWindows: new Map(),
    botRuntimes: new Map(),
    processedCollaborationTurns: new Set(),
    collaborationInbox: {} as AppRuntime['collaborationInbox'],
    clarificationFlows: {} as AppRuntime['clarificationFlows'],
    productSpecFlows: {} as AppRuntime['productSpecFlows'],
    approvalFlows: {} as AppRuntime['approvalFlows'],
    unifiedTaskStore: new JsonUnifiedTaskStore(join(root, 'unified-tasks.json')),
    personalMemoryStore,
  };
  const oldPath = process.env.PATH;
  const oldCapture = process.env.FAKE_CLI_CAPTURE;
  const oldPartial = process.env.FAKE_CLI_PARTIAL;
  const oldFail = process.env.FAKE_CLI_FAIL;
  const oldMemoryTool = process.env.FAKE_CLI_MEMORY_TOOL;
  process.env.PATH = `${bin}${delimiter}${oldPath ?? ''}`;
  process.env.FAKE_CLI_CAPTURE = captured;
  try {
    await run(root, runtime, captured);
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldCapture === undefined) delete process.env.FAKE_CLI_CAPTURE; else process.env.FAKE_CLI_CAPTURE = oldCapture;
    if (oldPartial === undefined) delete process.env.FAKE_CLI_PARTIAL; else process.env.FAKE_CLI_PARTIAL = oldPartial;
    if (oldFail === undefined) delete process.env.FAKE_CLI_FAIL; else process.env.FAKE_CLI_FAIL = oldFail;
    if (oldMemoryTool === undefined) delete process.env.FAKE_CLI_MEMORY_TOOL; else process.env.FAKE_CLI_MEMORY_TOOL = oldMemoryTool;
    await rm(root, { recursive: true, force: true });
  }
}

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'sched-42', creatorOpenId: 'trusted-owner', chatId: 'private-chat',
    targetBotId: 'assistant', prompt: 'Career notes for interview review: explain the cache invalidation project with measurable impact.',
    rule: { kind: 'once', runAt: scheduledFor }, status: 'active',
    createdAt: scheduledFor, updatedAt: scheduledFor,
    authorizedMemorySpaceIds: [], ...overrides,
  };
}

test('public scheduled runner persists trusted schedule trigger and explicitly granted memory with successful result', { concurrency: false }, async () => {
  await withFixture(async (root, runtime, capturedPath) => {
    process.env.FAKE_CLI_MEMORY_TOOL = '1';
    const memory = runtime.personalMemoryStore!;
    const space = await memory.createSpace('career');
    const savedNote = await memory.add({
      spaceId: space.id, kind: 'learning', content: 'Career notes for interview review: explain the cache invalidation project with measurable impact.',
      confidence: 'user_stated', source: { sourceId: 'note-1', actorId: 'trusted-owner', receivedAt: scheduledFor, timezone: 'UTC' },
    });
    await runScheduledTaskDirectly({ runtime, task: task({ authorizedMemorySpaceIds: [space.id] }), scheduledFor, defaultProductDeliveryMode: 'local' });

    const [stored] = await new JsonUnifiedTaskStore(join(root, 'unified-tasks.json')).list();
    assert.ok(stored);
    assert.equal(stored.trigger.source, 'schedule');
    assert.equal(stored.trigger.sourceId, `sched-42:${scheduledFor}`);
    assert.equal(stored.trigger.occurredAt, scheduledFor);
    assert.deepEqual(stored.trusted, { actorId: 'trusted-owner', ownerId: 'trusted-owner' });
    assert.deepEqual(stored.authorizedMemorySpaceIds, [space.id]);
    assert.equal(stored.status, 'succeeded');
    const contextTrace = stored.traceHistory.find((event) => event.stage === 'context_prepared');
    assert.deepEqual(contextTrace?.memorySources, [{ id: savedNote.entry.id, version: savedNote.entry.version }]);
    assert.deepEqual(stored.traceHistory.at(-1)?.memoryOperations, [
      { tool: 'save_personal_memory', operation: 'write', status: 'succeeded' },
    ]);
    assert.deepEqual(stored.traceHistory.at(-1)?.usage, { totalTokens: 7, inputTokens: 4, outputTokens: 3, cost: 'unknown' });
    assert.doesNotMatch(JSON.stringify(stored.traceHistory), /secret personal note/);
    assert.deepEqual({
      answer: (stored.result as { answer: string }).answer,
      sessionId: (stored.result as { sessionId: string }).sessionId,
      stats: (stored.result as { stats: unknown }).stats,
    }, { answer: '任务已执行完成。', sessionId: 'fake-native-session', stats: { totalTokens: 7, inputTokens: 4, outputTokens: 3 } });

    const invocation = JSON.parse(await readFile(capturedPath, 'utf8')) as { prompt: string; chatId: string; ownerId: string };
    assert.equal(invocation.chatId, 'private-chat');
    assert.equal(invocation.ownerId, 'trusted-owner');
    assert.match(invocation.prompt, /Career notes for interview review: explain the cache invalidation project with measurable impact\./);
    assert.equal(runtime.sessions.list()[0]?.status, 'idle');
  });
});

test('public scheduled runner persists partially_succeeded when the fake CLI reports a failed tool', { concurrency: false }, async () => {
  await withFixture(async (root, runtime) => {
    process.env.FAKE_CLI_PARTIAL = '1';
    await runScheduledTaskDirectly({ runtime, task: task(), scheduledFor, defaultProductDeliveryMode: 'local' });
    const [stored] = await new JsonUnifiedTaskStore(join(root, 'unified-tasks.json')).list();
    assert.ok(stored);
    assert.equal(stored.status, 'partially_succeeded');
    assert.deepEqual(stored.result, {
      answer: '任务已执行完成。', sessionId: 'fake-native-session',
      stats: { totalTokens: 7, inputTokens: 4, outputTokens: 3 },
      failedToolCalls: 1,
    });
  });
});


test('public scheduled runner persists failed execution before surfacing its error', { concurrency: false }, async () => {
  await withFixture(async (root, runtime) => {
    process.env.FAKE_CLI_FAIL = '1';
    await assert.rejects(
      runScheduledTaskDirectly({ runtime, task: task(), scheduledFor, defaultProductDeliveryMode: 'local' }),
      /fixture failure/,
    );
    const [stored] = await new JsonUnifiedTaskStore(join(root, 'unified-tasks.json')).list();
    assert.ok(stored);
    assert.equal(stored.status, 'failed');
    assert.match(stored.error ?? '', /fixture failure/);
    assert.ok(stored.completedAt);
  });
});
