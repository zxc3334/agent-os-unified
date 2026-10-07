import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PersonalReminderScheduler } from '../../src/app/personal-reminder-scheduler.js';
import { JsonDailyRecordsReminders } from '../../src/core/daily-records.js';

const source = (receivedAt: string) => ({ sourceId: 'message-1', actorId: 'owner', receivedAt, timezone: 'Asia/Shanghai' });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withStore(run: (store: JsonDailyRecordsReminders) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-os-reminder-scheduler-'));
  try { await run(new JsonDailyRecordsReminders(join(directory, 'records.json'))); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('scheduled reminder becomes delivered only after a transport receipt', async () => {
  await withStore(async (store) => {
    const receivedAt = new Date().toISOString();
    const reminder = store.createReminder({
      operationId: 'reminder-1', content: 'Call the dentist', source: source(receivedAt),
      dueAt: new Date(Date.now() + 1_500).toISOString(), deliveryTarget: { botId: 'assistant', chatId: 'owner-dm' },
    });
    const sent: string[] = [];
    const scheduler = new PersonalReminderScheduler({
      store, senderFor: () => ({ async sendTextToChat(chatId, text, uuid) { sent.push(`${chatId}:${text}:${uuid}`); return 'receipt-1'; } }),
    });
    scheduler.start();
    try {
      await wait(1_600);
      const delivered = store.getReminder(reminder.id)!;
      assert.equal(delivered.status, 'delivered');
      assert.equal(delivered.deliveryAttempts[0]?.receiptId, 'receipt-1');
      assert.match(sent[0]!, /owner-dm:⏰ 提醒：Call the dentist:personal-reminder-/);
    } finally { scheduler.stop(); }
  });
});

test('restart marks overdue reminders missed and sends an honest recovery notice', async () => {
  await withStore(async (store) => {
    const now = new Date('2026-10-07T12:00:00.000Z');
    const reminder = store.createReminder({
      operationId: 'reminder-overdue', content: 'Attend appointment', source: source('2026-10-07T10:00:00.000Z'),
      dueAt: '2026-10-07T11:00:00.000Z', deliveryTarget: { botId: 'assistant', chatId: 'owner-dm' },
    });
    const messages: string[] = [];
    const scheduler = new PersonalReminderScheduler({
      store, now: () => now,
      senderFor: () => ({ async sendTextToChat(_chatId, text) { messages.push(text); return 'recovery-receipt'; } }),
    });
    scheduler.start();
    await wait(0);
    scheduler.stop();
    assert.equal(store.getReminder(reminder.id)?.status, 'missed');
    assert.match(messages[0]!, /没有按时送达/);
    assert.match(messages[0]!, /已标记为错过/);
  });
});
