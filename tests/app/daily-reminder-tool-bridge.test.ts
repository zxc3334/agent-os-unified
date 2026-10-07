import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JsonDailyRecordsReminders } from '../../src/core/daily-records.js';
import { DailyReminderToolBridge } from '../../src/app/daily-reminder-tool-bridge.js';

test('reminder bridge binds source time and timezone to trusted invocation and returns clarification without saving', async () => {
  const store = new JsonDailyRecordsReminders();
  const scheduled: string[] = [];
  const bridge = new DailyReminderToolBridge(store, (reminder) => scheduled.push(reminder.id));
  const port = await bridge.start();
  const invocation = bridge.issue({
    actorId: 'owner', ownerId: 'owner',
    source: { sourceId: 'trusted-message', actorId: 'owner', receivedAt: '2026-10-07T02:00:00.000Z', timezone: 'Asia/Shanghai' },
    deliveryTarget: { botId: 'assistant', chatId: 'owner-dm' },
  });
  try {
    const missing = await fetch(`http://127.0.0.1:${port}/api/daily-reminders/create`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-daily-reminder-token': invocation.token },
      body: JSON.stringify({ content: '生日提醒' }),
    });
    assert.equal(missing.status, 200);
    assert.deepEqual(await missing.json(), {
      status: 'needs_clarification', code: 'missing_due_time',
      question: '提醒的具体日期和时间是什么？请提供明确时间，例如“明天下午 3 点”或“2026-10-08 15:00”。',
    });
    assert.deepEqual(store.listReminders(), []);

    const created = await fetch(`http://127.0.0.1:${port}/api/daily-reminders/create`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-daily-reminder-token': invocation.token },
      body: JSON.stringify({ content: '生日提醒', relativeDue: '后天上午九点' }),
    });
    assert.equal(created.status, 201);
    const result = await created.json() as { status: string; dueAt: string };
    assert.equal(result.status, 'created');
    assert.equal(result.dueAt, '2026-10-09T01:00:00.000Z');
    assert.deepEqual(scheduled, [store.listReminders()[0]?.id]);
    assert.deepEqual(store.listReminders()[0]?.deliveryTarget, { botId: 'assistant', chatId: 'owner-dm' });
    assert.deepEqual(store.listReminders()[0]?.source, {
      sourceId: 'trusted-message', actorId: 'owner', receivedAt: '2026-10-07T02:00:00.000Z', timezone: 'Asia/Shanghai',
    });
  } finally {
    invocation.release();
    await bridge.close();
  }
});

test('reminder bridge rejects an untrusted actor and released tokens without writing', async () => {
  const store = new JsonDailyRecordsReminders();
  const bridge = new DailyReminderToolBridge(store);
  const port = await bridge.start();
  const notOwner = bridge.issue({
    actorId: 'group-member', ownerId: 'owner',
    source: { sourceId: 'group-message', actorId: 'group-member', receivedAt: '2026-10-07T02:00:00.000Z', timezone: 'UTC' },
    deliveryTarget: { botId: 'assistant', chatId: 'group-chat' },
  });
  try {
    const forbidden = await fetch(`http://127.0.0.1:${port}/api/daily-reminders/create`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-daily-reminder-token': notOwner.token },
      body: JSON.stringify({ content: 'task', dueAt: '2026-10-08T10:00:00Z' }),
    });
    assert.equal(forbidden.status, 403);
    notOwner.release();
    const released = await fetch(`http://127.0.0.1:${port}/api/daily-reminders/create`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-daily-reminder-token': notOwner.token },
      body: JSON.stringify({ content: 'task', dueAt: '2026-10-08T10:00:00Z' }),
    });
    assert.equal(released.status, 401);
    assert.deepEqual(store.listReminders(), []);
  } finally {
    await bridge.close();
  }
});
