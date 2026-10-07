import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonCareerPreparation } from '../../src/core/career-preparation.js';
import { JsonCareerReviewNotificationStore } from '../../src/core/career-review-notifications.js';
import { CareerReviewNotificationScheduler } from '../../src/app/career-review-notification.js';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'career-review-notify-'));
  let current = new Date('2026-10-08T12:00:00.000Z');
  const now = () => new Date(current);
  const career = new JsonCareerPreparation(join(directory, 'career.json'), now);
  const store = new JsonCareerReviewNotificationStore(join(directory, 'delivery.json'), now);
  const evidence = await career.addEvidence({ claim: 'Built a queue', status: 'confirmed', sources: [{ kind: 'other', id: 'source' }] });
  const role = await career.saveRoleRequirements({ title: 'Intern', requirements: [] });
  const resume = await career.proposeResumeVersion({ roleId: role.id, evidenceIds: [evidence.id] });
  const record = (await career.recordMockInterview({
    resumeVersionId: resume.id,
    feedback: [{ summary: 'Explain queue design', weakPoint: 'Tradeoffs unclear', source: { kind: 'mock-interview', id: 'interview' } }],
    recordedAt: '2026-10-06T12:00:00.000Z',
  })).learningRecords[0]!;
  const sent: Array<{ chatId: string; text: string; uuid?: string }> = [];
  let shouldFail = false;
  let noReceipt = false;
  const scheduler = new CareerReviewNotificationScheduler({
    career, store, ownerId: 'owner-1', batchSize: 1, now,
    getBot: (botId) => botId === 'bot-1' ? { botId, bot: { async sendTextToChat(chatId, text, uuid) {
      sent.push({ chatId, text, uuid });
      if (shouldFail) { shouldFail = false; throw new Error('temporary failure'); }
      if (noReceipt) { noReceipt = false; return undefined; }
      return `feishu-message-${sent.length}`;
    } } } : undefined,
  });
  return { directory, now, career, store, record, sent, scheduler, setTime(value: string) { current = new Date(value); }, failNext() { shouldFail = true; }, omitNextReceipt() { noReceipt = true; } };
}

test('remembers only configured owner direct conversations and sends bounded due reviews only there', async () => {
  const f = await fixture();
  try {
    assert.equal(await f.scheduler.rememberOwnerConversation({ ownerId: 'other', botId: 'bot-1', chatId: 'group-x', chatType: 'p2p' }), false);
    assert.equal(await f.scheduler.rememberOwnerConversation({ ownerId: 'owner-1', botId: 'bot-1', chatId: 'group-x', chatType: 'group' }), false);
    assert.equal(await f.scheduler.runOnce().then((result) => result.skipped), 'owner-private-chat-not-known');
    assert.equal(await f.scheduler.rememberOwnerConversation({ ownerId: 'owner-1', botId: 'bot-1', chatId: 'private-x', chatType: 'p2p' }), true);
    const first = await f.scheduler.runOnce();
    assert.deepEqual(first.delivered, [f.record.id]);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0]!.chatId, 'private-x');
    assert.match(f.sent[0]!.text, /Tradeoffs unclear/);
    assert.equal(f.sent[0]!.uuid?.length, 32);
    const persisted = JSON.parse(await readFile(join(f.directory, 'delivery.json'), 'utf8')) as { deliveries: Array<{ status: string; receiptId?: string }> };
    assert.equal(persisted.deliveries[0]!.status, 'delivered');
    assert.equal(persisted.deliveries[0]!.receiptId, 'feishu-message-1');
    assert.deepEqual((await f.scheduler.runOnce()).delivered, []);
    assert.equal(f.sent.length, 1);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('failed send or missing Feishu receipt stays retryable and does not claim delivery', async () => {
  const f = await fixture();
  try {
    await f.scheduler.rememberOwnerConversation({ ownerId: 'owner-1', botId: 'bot-1', chatId: 'private-x', chatType: 'p2p' });
    f.failNext();
    assert.deepEqual((await f.scheduler.runOnce()).failed, [f.record.id]);
    let deliveries = await f.store.listDeliveries();
    assert.equal(deliveries[0]!.status, 'pending');
    assert.equal(deliveries[0]!.receiptId, undefined);
    f.omitNextReceipt();
    assert.deepEqual((await f.scheduler.runOnce()).failed, [f.record.id]);
    deliveries = await f.store.listDeliveries();
    assert.equal(deliveries[0]!.status, 'pending');
    assert.equal(deliveries[0]!.receiptId, undefined);
    assert.deepEqual((await f.scheduler.runOnce()).delivered, [f.record.id]);
    deliveries = await f.store.listDeliveries();
    assert.equal(deliveries[0]!.attempts, 3);
    assert.equal(deliveries[0]!.status, 'delivered');
    assert.equal(f.sent[0]!.uuid, f.sent[1]!.uuid);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('next review round and nextReviewAt form a fresh persisted delivery identity', async () => {
  const f = await fixture();
  try {
    await f.scheduler.rememberOwnerConversation({ ownerId: 'owner-1', botId: 'bot-1', chatId: 'private-x', chatType: 'p2p' });
    await f.scheduler.runOnce();
    await f.career.recordLearningReview(f.record.id, { score: 2, reviewedAt: '2026-10-08T12:00:00.000Z' });
    f.setTime('2026-10-09T12:00:00.000Z');
    const secondRound = await f.scheduler.runOnce();
    assert.deepEqual(secondRound.delivered, [f.record.id]);
    const deliveries = await f.store.listDeliveries();
    assert.equal(deliveries.length, 2);
    assert.notEqual(deliveries[0]!.key, deliveries[1]!.key);
    assert.equal(deliveries[1]!.reviewRound, 1);
    assert.notEqual(f.sent[0]!.uuid, f.sent[1]!.uuid);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('caps each poll to configured batch size and recovers pending items after restart', async () => {
  const f = await fixture();
  try {
    const second = await f.career.recordMockInterview({
      resumeVersionId: f.record.resumeVersionId,
      feedback: Array.from({ length: 3 }, (_, i) => ({ summary: `summary ${i}`, weakPoint: `weakness ${i}`, source: { kind: 'mock-interview' as const, id: `i${i}` } })),
      recordedAt: '2026-10-06T12:00:00.000Z',
    });
    assert.equal(second.learningRecords.length, 3);
    await f.scheduler.rememberOwnerConversation({ ownerId: 'owner-1', botId: 'bot-1', chatId: 'private-x', chatType: 'p2p' });
    assert.equal((await f.scheduler.runOnce()).delivered.length, 1);
    const restarted = new CareerReviewNotificationScheduler({
      career: f.career, store: new JsonCareerReviewNotificationStore(join(f.directory, 'delivery.json'), f.now),
      ownerId: 'owner-1', batchSize: 2, now: f.now,
      getBot: (botId) => botId === 'bot-1' ? { botId, bot: { async sendTextToChat(chatId, _text, _uuid) { return `receipt-${chatId}-${Math.random()}`; } } } : undefined,
    });
    assert.equal((await restarted.runOnce()).delivered.length, 2);
    assert.equal((await restarted.runOnce()).delivered.length, 1);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});


test('start immediately recovers due outbox items after restart', async () => {
  const f = await fixture();
  try {
    await f.scheduler.rememberOwnerConversation({ ownerId: 'owner-1', botId: 'bot-1', chatId: 'private-x', chatType: 'p2p' });
    // The fixture transport completes synchronously; observing the persisted receipt is
    // the public behavior proving startup's immediate recovery pump ran.
    const original = await f.scheduler.runOnce();
    assert.deepEqual(original.delivered, [f.record.id]);
    // A fresh due record represents work that became due while the app was stopped.
    await f.career.recordLearningReview(f.record.id, { score: 1, reviewedAt: '2026-10-08T12:00:00.000Z' });
    f.setTime('2026-10-09T12:00:00.000Z');
    f.scheduler.start();
    for (let i = 0; i < 40; i += 1) {
      const snapshot = await f.store.listDeliveries();
      if (snapshot.length === 2 && snapshot[1]!.status === 'delivered') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    f.scheduler.stop();
    const deliveries = await f.store.listDeliveries();
    assert.equal(deliveries.length, 2);
    assert.equal(deliveries[1]!.status, 'delivered');
  } finally { f.scheduler.stop(); await rm(f.directory, { recursive: true, force: true }); }
});
