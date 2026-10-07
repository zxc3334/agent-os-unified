import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { handleSessionCommand } from '../../src/app/command-handler.js';
import { JsonDailyRecordsReminders } from '../../src/core/daily-records.js';
import { parseCommand } from '../../src/core/command-parser.js';
import { JsonBlogAssociations } from '../../src/core/blog-associations.js';

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-os-daily-command-'));
  const dailyRecords = new JsonDailyRecordsReminders(join(directory, 'daily.json'));
  const replies: string[] = [];
  const scheduled: string[] = [];
  const cancelled: string[] = [];
  const bot = { reply: async (_id: string, text: string) => { replies.push(text); return undefined; } } as never;
  const options = {
    runtime: {}, scheduler: {}, config: { id: 'assistant' }, bot,
    msg: { senderOpenId: 'owner', chatType: 'p2p', chatId: 'owner-dm', messageId: 'message-1', receivedAt: '2026-10-07T10:00:00.000Z' },
    session: { id: 'session-1', status: 'idle', memorySpaceIds: ['reading'] }, cliAdapter: {}, isNew: false, hasThread: false,
    trustedOwnerOpenId: 'owner', dailyRecords,
    personalReminderScheduler: { schedule: (reminder: { id: string }) => scheduled.push(reminder.id), cancel: (id: string) => cancelled.push(id) },
  } as never;
  return { directory, dailyRecords, replies, scheduled, cancelled, options };
}

test('daily and reminder command parsing is bounded and rejects malformed commands', () => {
  assert.deepEqual(parseCommand('/daily add reading Read one chapter'), { name: 'daily', action: 'add', kind: 'reading', content: 'Read one chapter' });
  assert.deepEqual(parseCommand('/daily add reading Author argues attention is limited :: I think deliberate practice matters more'), { name: 'daily', action: 'add', kind: 'reading', content: '用户观点：I think deliberate practice matters more', authorView: 'Author argues attention is limited', userView: 'I think deliberate practice matters more' });
  assert.deepEqual(parseCommand('/daily scope record-1 reading'), { name: 'daily', action: 'scope', recordId: 'record-1', scopeId: 'reading' });
  assert.deepEqual(parseCommand('/daily delete record-1'), { name: 'daily', action: 'delete', recordId: 'record-1' });
  assert.deepEqual(parseCommand('/reminder add 后天上午9点 :: Call mom'), { name: 'reminder', action: 'add', due: '后天上午9点', content: 'Call mom' });
  assert.deepEqual(parseCommand('/reminder edit reminder-1 明天 10:30 :: Call mom'), { name: 'reminder', action: 'edit', reminderId: 'reminder-1', due: '明天 10:30', content: 'Call mom' });
  assert.deepEqual(parseCommand('/reminder retry reminder-1'), { name: 'reminder', action: 'retry', reminderId: 'reminder-1' });
  assert.equal(parseCommand('/reminder add tomorrow'), undefined);
});

test('private daily records and reminders persist with trusted source dates and explicit delivery lifecycle', async () => {
  const ctx = await setup();
  try {
    await handleSessionCommand({ ...ctx.options, command: parseCommand('/daily add reading Read a chapter about attention') });
    const record = ctx.dailyRecords.listRecords()[0]!;
    assert.equal(record.date, '2026-10-07'); // converted from trusted receipt time in the local Asia/Shanghai timezone
    assert.equal(record.scopeId, 'reading');
    await handleSessionCommand({ ...ctx.options, msg: { ...ctx.options.msg, messageId: 'message-2' }, command: parseCommand('/daily add reading Author argues attention is limited :: I disagree with the conclusion') });
    const reading = ctx.dailyRecords.listRecords().find((item) => item.source.sourceId === 'message-2')!;
    assert.equal(reading.authorView, 'Author argues attention is limited');
    assert.equal(reading.userView, 'I disagree with the conclusion');
    assert.equal(ctx.dailyRecords.listReminders().length, 0);
    assert.match(ctx.replies.at(-1)!, /不会自动变成长久偏好或提醒/);

    await handleSessionCommand({ ...ctx.options, command: parseCommand('/reminder add 明天上午9点 :: Call mom') });
    assert.ok(ctx.dailyRecords.listReminders()[0], ctx.replies.at(-1));
    const reminder = ctx.dailyRecords.listReminders()[0]!;
    assert.equal(reminder.status, 'scheduled');
    assert.deepEqual(reminder.deliveryTarget, { botId: 'assistant', chatId: 'owner-dm' });
    assert.deepEqual(ctx.scheduled, [reminder.id]);
    await handleSessionCommand({ ...ctx.options, command: parseCommand(`/reminder cancel ${reminder.id}`) });
    assert.equal(ctx.dailyRecords.getReminder(reminder.id)?.status, 'cancelled');
    assert.deepEqual(ctx.cancelled, [reminder.id]);

    const failed = ctx.dailyRecords.createReminder({
      operationId: 'failed-reminder', content: 'Try again', dueAt: '2026-10-07T12:30:00.000Z',
      source: { sourceId: 'failure-source', actorId: 'owner', receivedAt: ctx.options.msg.receivedAt, timezone: 'Asia/Shanghai' },
      deliveryTarget: { botId: 'assistant', chatId: 'owner-dm' },
    });
    ctx.dailyRecords.recordDeliveryOutcome(failed.id, { outcome: 'failed', attemptedAt: ctx.options.msg.receivedAt });
    await handleSessionCommand({ ...ctx.options, msg: { ...ctx.options.msg, messageId: 'retry-msg' }, command: parseCommand(`/reminder retry ${failed.id}`) });
    assert.equal(ctx.dailyRecords.getReminder(failed.id)?.status, 'scheduled');
    assert.ok(ctx.scheduled.includes(failed.id));
    assert.match(ctx.replies.at(-1)!, /实际发送回执/);
    assert.equal(ctx.dailyRecords.getRecord(record.id)?.content, 'Read a chapter about attention');
  } finally { await rm(ctx.directory, { recursive: true, force: true }); }
});

test('reclassifying a daily record invalidates old-space blog references but leaves the record intact', async () => {
  const ctx = await setup();
  try {
    await handleSessionCommand({ ...ctx.options, command: parseCommand('/daily add reading Read about memory systems') });
    const record = ctx.dailyRecords.listRecords()[0]!;
    const blogAssociations = new JsonBlogAssociations(join(ctx.directory, 'blog.json'));
    const proposal = blogAssociations.proposeAssociation({
      initiatedBy: 'user', operationId: 'daily-source-proposal', actorId: 'owner',
      createdAt: '2026-10-07T10:00:00.000Z', authorizedSpaceIds: ['reading', 'career'],
      sources: [
        { kind: 'daily-record', id: record.id, spaceId: 'reading' },
        { kind: 'memory', id: 'career-memory', spaceId: 'career' },
      ], reasoning: 'Potential relation.', intendedUse: 'Private blog draft.',
    });
    await handleSessionCommand({
      ...ctx.options, blogAssociations,
      command: parseCommand(`/daily scope ${record.id} career`),
    });
    assert.equal(blogAssociations.areProposalSourcesActive(proposal.id), false);
    assert.equal(ctx.dailyRecords.getRecord(record.id)?.scopeId, 'career');
    assert.equal(ctx.dailyRecords.getRecord(record.id)?.content, 'Read about memory systems');
    assert.match(ctx.replies.at(-1)!, /旧空间中的博客引用已失效/);
  } finally { await rm(ctx.directory, { recursive: true, force: true }); }
});

test('deleting a daily record clears content, invalidates blog references, and preserves independent reminders', async () => {
  const ctx = await setup();
  try {
    await handleSessionCommand({ ...ctx.options, command: parseCommand('/daily add reading Author idea :: My response') });
    const record = ctx.dailyRecords.listRecords()[0]!;
    const reminder = ctx.dailyRecords.createReminder({
      operationId: 'linked-reminder', content: 'Review this note', dueAt: '2026-10-08T10:00:00.000Z',
      source: { sourceId: 'reminder-source', actorId: 'owner', receivedAt: '2026-10-07T10:00:00.000Z', timezone: 'UTC' },
      recordId: record.id,
    });
    const blogAssociations = new JsonBlogAssociations(join(ctx.directory, 'blog.json'));
    const proposal = blogAssociations.proposeAssociation({
      initiatedBy: 'user', operationId: 'deleted-daily-source', actorId: 'owner',
      createdAt: '2026-10-07T10:00:00.000Z', authorizedSpaceIds: ['reading', 'career'],
      sources: [
        { kind: 'daily-record', id: record.id, spaceId: 'reading' },
        { kind: 'memory', id: 'career-memory', spaceId: 'career' },
      ], reasoning: 'Potential relation.', intendedUse: 'Private blog draft.',
    });
    await handleSessionCommand({ ...ctx.options, blogAssociations, command: parseCommand(`/daily delete ${record.id}`) });
    assert.equal(blogAssociations.areProposalSourcesActive(proposal.id), false);
    assert.equal(ctx.dailyRecords.getRecord(record.id)?.status, 'deleted');
    assert.equal(ctx.dailyRecords.getRecord(record.id)?.content, '');
    assert.equal(ctx.dailyRecords.getRecord(record.id)?.authorView, undefined);
    assert.deepEqual(ctx.dailyRecords.listRecords(), []);
    assert.equal(ctx.dailyRecords.getReminder(reminder.id)?.status, 'scheduled');
    assert.equal(ctx.dailyRecords.getReminder(reminder.id)?.recordId, undefined);
    assert.match(ctx.replies.at(-1)!, /独立提醒不会被取消/);
  } finally { await rm(ctx.directory, { recursive: true, force: true }); }
});

test('group messages cannot create personal daily records or reminders', async () => {
  const ctx = await setup();
  try {
    await handleSessionCommand({
      ...ctx.options,
      msg: { ...ctx.options.msg, chatType: 'group' },
      command: parseCommand('/daily add daily I went to the gym'),
    });
    assert.equal(ctx.dailyRecords.listRecords().length, 0);
    assert.match(ctx.replies.at(-1)!, /仅限所有者在私聊中使用/);
  } finally { await rm(ctx.directory, { recursive: true, force: true }); }
});
