import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDailyReminderFromTool, CreateDailyReminderToolSchema } from '../../src/core/daily-reminder-tool.js';
import { JsonDailyRecordsReminders } from '../../src/core/daily-records.js';

const context = {
  operationId: 'reminder-tool:test',
  source: { sourceId: 'message-test', actorId: 'owner', receivedAt: '2026-10-07T02:00:00.000Z', timezone: 'Asia/Shanghai' },
};

test('MCP reminder schema allows omitted time through to an explicit clarification outcome without persistence', () => {
  const store = new JsonDailyRecordsReminders();
  const input = CreateDailyReminderToolSchema.parse({ content: '提醒我给女朋友过生日' });
  const result = createDailyReminderFromTool(store, input, context);
  assert.deepEqual(result, {
    status: 'needs_clarification', code: 'missing_due_time',
    question: '提醒的具体日期和时间是什么？请提供明确时间，例如“明天下午 3 点”或“2026-10-08 15:00”。',
  });
  assert.deepEqual(store.listReminders(), []);
});

test('relative reminders with absent or ambiguous clock time never create a reminder', () => {
  const store = new JsonDailyRecordsReminders();
  const absent = createDailyReminderFromTool(store, { content: '提醒我复习', relativeDue: '明天' }, context);
  assert.equal(absent.status, 'needs_clarification');
  if (absent.status === 'needs_clarification') assert.equal(absent.code, 'missing_due_time');

  const ambiguous = createDailyReminderFromTool(store, { content: '提醒我复习', relativeDue: '明天 8 点' }, context);
  assert.equal(ambiguous.status, 'needs_clarification');
  if (ambiguous.status === 'needs_clarification') {
    assert.equal(ambiguous.code, 'ambiguous_due_time');
    assert.match(ambiguous.question, /上午\/下午|24 小时制/);
  }
  const minuteAmbiguous = createDailyReminderFromTool(store, { content: '提醒我复习', relativeDue: '明天 8:30' }, { ...context, operationId: 'minute-ambiguous' });
  assert.equal(minuteAmbiguous.status, 'needs_clarification');
  assert.deepEqual(store.listReminders(), []);
});

test('invalid date-only timestamp is rejected instead of becoming midnight; clear relative time is stored', () => {
  const store = new JsonDailyRecordsReminders();
  const dateOnly = createDailyReminderFromTool(store, { content: '复习', dueAt: '2026-10-08' }, context);
  assert.equal(dateOnly.status, 'invalid');
  assert.deepEqual(store.listReminders(), []);

  const result = createDailyReminderFromTool(store, { content: '复习', relativeDue: '明天下午 3 点' }, context);
  assert.equal(result.status, 'created');
  if (result.status === 'created') assert.equal(result.dueAt, '2026-10-08T07:00:00.000Z');
  assert.equal(store.listReminders().length, 1);
});

test('explicit timezone timestamp is accepted; ambiguous English clock returns a user-actionable result', () => {
  const store = new JsonDailyRecordsReminders();
  const explicit = createDailyReminderFromTool(store, { content: 'appointment', dueAt: '2026-10-08T15:00:00+08:00' }, context);
  assert.equal(explicit.status, 'created');
  if (explicit.status === 'created') assert.equal(explicit.dueAt, '2026-10-08T07:00:00.000Z');

  const ambiguous = createDailyReminderFromTool(store, { content: 'call', relativeDue: 'tomorrow at 8' }, { ...context, operationId: 'other' });
  assert.equal(ambiguous.status, 'needs_clarification');
  if (ambiguous.status === 'needs_clarification') assert.equal(ambiguous.code, 'ambiguous_due_time');
  assert.equal(store.listReminders().length, 1);
});

test('unclear date and conflicting alternatives ask the user instead of creating a guessed reminder', () => {
  const store = new JsonDailyRecordsReminders();
  const missingDate = createDailyReminderFromTool(store, { content: '提交材料', relativeDue: '某天上午 9 点' }, context);
  assert.equal(missingDate.status, 'needs_clarification');
  if (missingDate.status === 'needs_clarification') assert.match(missingDate.question, /具体是哪一天/);

  const conflicting = createDailyReminderFromTool(store, { content: '提交材料', relativeDue: '明天上午 9 点还是下午 3 点' }, context);
  assert.equal(conflicting.status, 'needs_clarification');
  if (conflicting.status === 'needs_clarification') assert.equal(conflicting.code, 'ambiguous_due_time');
  assert.deepEqual(store.listReminders(), []);
});
