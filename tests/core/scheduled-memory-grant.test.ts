import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { executeScheduleManageRequest } from '../../src/app/schedule-manage-service.js';
import { ScheduleManageRequestSchema } from '../../src/core/schedule.js';
import { JsonScheduleStore } from '../../src/core/schedule-store.js';

const addRequest = {
  action: 'add' as const,
  targetBotId: 'assistant',
  prompt: 'Summarize my interview practice notes',
  rule: { kind: 'interval' as const, everyMs: 60_000 },
};

test('scheduled-task memory grants come from trusted matter context and survive store reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'schedule-memory-grant-'));
  const filePath = join(directory, 'schedules.json');
  try {
    const store = new JsonScheduleStore(filePath);
    const created: Array<{ authorizedMemorySpaceIds?: string[] }> = [];
    const scheduler = {
      create(input: Parameters<JsonScheduleStore['create']>[0]) {
        const task = store.create(input);
        created.push(task);
        return task;
      },
      list: () => store.list(),
    };
    const request = ScheduleManageRequestSchema.parse({
      ...addRequest,
      authorizedMemorySpaceIds: ['forged-by-tool'],
    });
    assert.equal('authorizedMemorySpaceIds' in request, false);

    await executeScheduleManageRequest(request, {
      scheduler: scheduler as never,
      runStore: {} as never,
      chatId: 'private-chat',
      creatorOpenId: 'owner',
      authorizedMemorySpaceIds: ['career', 'project-alpha', 'career'],
    });
    assert.deepEqual(created[0]?.authorizedMemorySpaceIds, ['career', 'project-alpha']);

    const reopened = new JsonScheduleStore(filePath);
    assert.deepEqual(reopened.list()[0]?.authorizedMemorySpaceIds, ['career', 'project-alpha']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('legacy schedules without a stored matter grant remain ungranted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'legacy-schedule-memory-'));
  const filePath = join(directory, 'schedules.json');
  try {
    const store = new JsonScheduleStore(filePath);
    const task = store.create({
      creatorOpenId: 'owner', chatId: 'private-chat', targetBotId: 'assistant',
      prompt: 'Do a task', rule: { kind: 'interval', everyMs: 60_000 },
    });
    assert.equal(task.authorizedMemorySpaceIds, undefined);
    assert.equal(new JsonScheduleStore(filePath).get(task.id)?.authorizedMemorySpaceIds, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
