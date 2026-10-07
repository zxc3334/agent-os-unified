import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { JsonDailyRecordsReminders } from '../../src/core/daily-records.js';

const source = {
  sourceId: 'message-1',
  actorId: 'owner',
  receivedAt: '2026-10-07T02:00:00.000Z',
  timezone: 'Asia/Shanghai',
};

test('dated records persist with source and adjustable scope; a date fact alone creates no reminder', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-os-daily-'));
  const file = join(directory, 'records.json');
  try {
    const store = new JsonDailyRecordsReminders(file);
    const record = store.createRecord({
      operationId: 'record-op-1',
      kind: 'daily',
      date: '2026-10-07',
      content: 'Ate noodles once',
      source,
      scopeId: null,
    });
    assert.equal(record.createdAt, source.receivedAt);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(record.scopeId, null);
    assert.deepEqual(store.listReminders(), []);

    const reopened = new JsonDailyRecordsReminders(file);
    assert.equal(reopened.createRecord({
      operationId: 'record-op-1', kind: 'daily', date: '2026-10-07',
      content: 'Ate noodles once', source, scopeId: null,
    }).id, record.id);
    assert.equal(reopened.setRecordScope(record.id, 'daily-life')?.scopeId, 'daily-life');
    assert.equal(new JsonDailyRecordsReminders(file).getRecord(record.id)?.scopeId, 'daily-life');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('relative due dates use trusted receipt time and timezone, and reminder creation is idempotent', async () => {
  const store = new JsonDailyRecordsReminders();
  const input = {
    operationId: 'reminder-op-1',
    content: 'Review the notes',
    relativeDue: '后天上午九点',
    source,
  };
  const first = store.createReminder(input);
  assert.equal(first.dueAt, '2026-10-09T01:00:00.000Z');
  assert.equal(store.createReminder(input).id, first.id);
  assert.equal(first.status, 'scheduled');
  assert.equal(store.createReminder({ operationId: 'reminder-op-cn', content: 'Call home', relativeDue: '明天上午9点', source }).dueAt, '2026-10-08T01:00:00.000Z');
});

test('cancel and edit affect reminder status without deleting its linked record; cancellation is terminal on redelivery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-os-reminders-'));
  const file = join(directory, 'records.json');
  try {
  const store = new JsonDailyRecordsReminders(file);
  const record = store.createRecord({
    operationId: 'record-op', kind: 'daily', date: '2026-10-07', content: 'Dentist appointment', source,
  });
  const reminder = store.createReminder({
    operationId: 'reminder-op', content: 'Dentist appointment', dueAt: '2026-10-08T01:00:00.000Z', source, recordId: record.id,
  });
  assert.equal(store.editReminder(reminder.id, { dueAt: '2026-10-08T02:00:00.000Z', changedAt: '2026-10-07T02:30:00.000Z' })?.dueAt, '2026-10-08T02:00:00.000Z');
  assert.equal(store.cancelReminder(reminder.id, '2026-10-07T02:31:00.000Z')?.status, 'cancelled');
  assert.equal(store.createReminder({
    operationId: 'reminder-op', content: 'Dentist appointment', dueAt: '2026-10-09T01:00:00.000Z', source, recordId: record.id,
  }).status, 'cancelled');
  assert.ok(store.getRecord(record.id));
  assert.equal(store.recordDeliveryOutcome(reminder.id, { outcome: 'failed', attemptedAt: '2026-10-07T02:32:00.000Z' })?.status, 'cancelled');
  const reopened = new JsonDailyRecordsReminders(file);
  assert.equal(reopened.getReminder(reminder.id)?.status, 'cancelled');
  assert.equal(reopened.getRecord(record.id)?.content, 'Dentist appointment');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('delivery outcomes remain explicit and recovery marks overdue scheduled reminders missed', () => {
  const store = new JsonDailyRecordsReminders();
  const failed = store.createReminder({
    operationId: 'failed', content: 'Retry me', dueAt: '2026-10-07T03:00:00.000Z', source,
  });
  assert.equal(store.recordDeliveryOutcome(failed.id, { outcome: 'failed', attemptedAt: '2026-10-07T03:01:00.000Z' })?.status, 'failed');
  assert.equal(store.editReminder(failed.id, { dueAt: '2026-10-07T04:00:00.000Z', changedAt: '2026-10-07T03:01:30.000Z' })?.status, 'scheduled');
  assert.equal(store.recordDeliveryOutcome(failed.id, { outcome: 'delivered', attemptedAt: '2026-10-07T03:02:00.000Z', receiptId: 'receipt-1' })?.status, 'delivered');
  assert.equal(store.getReminder(failed.id)?.deliveryAttempts.length, 2);
  assert.equal(store.getReminder(failed.id)?.updatedAt, '2026-10-07T03:02:00.000Z');

  const unknown = store.createReminder({
    operationId: 'unknown', content: 'Receipt unavailable', dueAt: '2026-10-07T03:00:00.000Z', source,
  });
  assert.equal(store.recordDeliveryOutcome(unknown.id, { outcome: 'unknown', attemptedAt: '2026-10-07T03:01:00.000Z' })?.status, 'scheduled');
  assert.equal(store.getReminder(unknown.id)?.lastDeliveryOutcome, 'unknown');

  const overdue = store.createReminder({
    operationId: 'overdue', content: 'Was offline', dueAt: '2026-10-07T03:00:00.000Z', source,
  });
  const missed = store.markMissedThrough('2026-10-07T04:00:00.000Z');
  assert.deepEqual(missed.map((item) => item.id), [unknown.id, overdue.id]);
  assert.equal(store.getReminder(overdue.id)?.status, 'missed');
  assert.equal(store.getReminder(unknown.id)?.status, 'missed');
});

test('recap is a date-bounded view with source ids and does not create lasting memory', () => {
  const store = new JsonDailyRecordsReminders();
  store.createRecord({ operationId: 'one', kind: 'reading', date: '2026-10-07', content: 'Read a chapter', source });
  store.createRecord({ operationId: 'two', kind: 'daily', date: '2026-10-08', content: 'Went for a walk', source });
  const recap = store.recap({ from: '2026-10-07', through: '2026-10-07' });
  assert.equal(recap.records.length, 1);
  assert.deepEqual(recap.sourceIds, ['message-1']);
  assert.deepEqual(store.listRecords().map((item) => item.date), ['2026-10-07', '2026-10-08']);
});
