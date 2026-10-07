import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JsonCareerPreparation } from '../../src/core/career-preparation.js';
import { ReviewScheduler, CareerReviewSchedulerAdapter } from '../../src/core/review-scheduler.js';
import { saveMemoryCardEntry, type MemoryCardEntry } from '../../src/core/memory.js';
import type { Bot } from '../../src/im/lark.js';

const fixedNow = new Date('2026-10-10T12:00:00.000Z');

async function withTemp<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'career-review-scheduler-'));
  const previousRoot = process.env.AGENT_OS_DATA_ROOT;
  process.env.AGENT_OS_DATA_ROOT = directory;
  try {
    return await run(directory);
  } finally {
    if (previousRoot === undefined) delete process.env.AGENT_OS_DATA_ROOT;
    else process.env.AGENT_OS_DATA_ROOT = previousRoot;
    await rm(directory, { recursive: true, force: true });
  }
}

async function createDueCareerRecord(filePath: string): Promise<{ career: JsonCareerPreparation; id: string }> {
  const career = new JsonCareerPreparation(filePath, () => new Date('2026-10-01T00:00:00.000Z'));
  const role = await career.saveRoleRequirements({ title: 'Backend Intern', requirements: [] });
  const resume = await career.proposeResumeVersion({ roleId: role.id, evidenceIds: [] });
  const { learningRecords } = await career.recordMockInterview({
    resumeVersionId: resume.id,
    feedback: [{
      summary: 'Answer lacked a concrete example.',
      weakPoint: 'Explain how retry state survives a process restart.',
      source: { kind: 'mock-interview', id: 'interview-1', locator: 'q2' },
    }],
    recordedAt: '2026-10-01T00:00:00.000Z',
  });
  return { career, id: learningRecords[0]!.id };
}

test('career due items use persisted interval state and scheduler completion adapter', async () => {
  await withTemp(async (directory) => {
    const { career, id } = await createDueCareerRecord(join(directory, 'career.json'));
    const adapter = new CareerReviewSchedulerAdapter(career, () => fixedNow);
    const scheduler = new ReviewScheduler({
      cronExpression: 'disabled', timezone: 'UTC', workspaceDirs: [], getBot: () => undefined,
      getTargetChatId: () => undefined, now: () => fixedNow, careerReviewAdapter: adapter,
    });

    assert.deepEqual((await adapter.listDueReviews()).map((item) => item.id), [id]);
    const completed = await scheduler.completeCareerReview(id, 4);
    assert.equal(completed?.reviewRounds, 1);
    assert.equal(completed?.repetition, 1);
    assert.equal(completed?.intervalDays, 3);
    assert.equal(completed?.nextReviewAt, '2026-10-13T12:00:00.000Z');
    assert.deepEqual(await adapter.listDueReviews(), []);

    const reopened = new JsonCareerPreparation(join(directory, 'career.json'));
    assert.equal((await reopened.listLearningRecords())[0]?.nextReviewAt, '2026-10-13T12:00:00.000Z');
  });
});

test('group scheduler only pushes legacy memory cards, never due career learning records', async () => {
  await withTemp(async (directory) => {
    const { career, id: careerId } = await createDueCareerRecord(join(directory, 'career.json'));
    const adapter = new CareerReviewSchedulerAdapter(career, () => fixedNow);
    const memoryItem: MemoryCardEntry = {
      id: 'legacy-memory-card', project: 'demo', topic: 'Legacy topic', description: 'Legacy description',
      tags: [], createdAt: '2026-10-01T00:00:00.000Z', nextReviewAt: '2026-10-02T00:00:00.000Z',
      repetition: 0, intervalDays: 1, mastery: 1, status: 'active', weaknessAnalysis: '',
      corePrinciples: '', reviewQuestion: 'Legacy memory question?',
    };
    await saveMemoryCardEntry(memoryItem, 'demo');
    const sent: Array<Record<string, unknown>> = [];
    const bot = { sendCardToChat: async (_chatId: string, card: Record<string, unknown>) => { sent.push(card); return 'message-1'; } } as unknown as Bot;
    const scheduler = new ReviewScheduler({
      cronExpression: 'disabled', timezone: 'UTC', workspaceDirs: [], getBot: () => bot,
      getTargetChatId: () => 'group-chat', now: () => fixedNow, careerReviewAdapter: adapter,
    });

    const result = await scheduler.triggerProjectReview(undefined, { allowFallback: false });
    assert.equal(result.pushed, true);
    assert.equal(result.item?.id, memoryItem.id);
    assert.equal(sent.length, 1);
    const cardText = JSON.stringify(sent[0]);
    assert.match(cardText, /Legacy topic/);
    assert.doesNotMatch(cardText, new RegExp(careerId));
    assert.doesNotMatch(cardText, /retry state survives/);
  });
});
