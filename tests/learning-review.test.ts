import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateNextReview } from '../src/core/memory.js';
import { buildReviewCard } from '../src/im/card.js';

const fixedNow = new Date('2026-10-07T12:00:00.000Z');

function reviewCardText(card: ReturnType<typeof buildReviewCard>): string {
  const markdown = card.body.elements.find((element) => element.tag === 'markdown');
  assert.ok(markdown && 'content' in markdown);
  return markdown.content;
}

test('review card presents the project, topic, progress, question, and answer guidance', () => {
  const card = buildReviewCard({
    projectName: 'agent-os',
    itemId: 'memory-1',
    topic: '记忆检索',
    question: '为什么需要按事项召回？',
    repetition: 2,
    intervalDays: 7,
    mastery: 4,
    workspaceDir: '/workspace/agent-os',
  });

  assert.equal(card.schema, '2.0');
  assert.equal(card.config.summary.content, '🔔 艾宾浩斯复习：记忆检索');
  assert.equal(card.header.subtitle.content, 'agent-os');
  const text = reviewCardText(card);
  assert.match(text, /所属项目.*agent-os/);
  assert.match(text, /核心考点.*记忆检索/);
  assert.match(text, /第 3 次复习（历史掌握度：4\/5，间隔：7 天）/);
  assert.match(text, /为什么需要按事项召回？/);
  assert.match(text, /在当前话题直接回复/);
});

test('passing a review advances to the next interval from the supplied clock', () => {
  const result = calculateNextReview(
    { repetition: 0, mastery: 2, intervalDays: 1 },
    4,
    fixedNow,
  );

  assert.deepEqual(result, {
    repetition: 1,
    mastery: 4,
    intervalDays: 3,
    nextReviewAt: '2026-10-10T12:00:00.000Z',
    status: 'active',
  });
});

test('a failed review resets the interval to one day without marking the item mastered', () => {
  const result = calculateNextReview(
    { repetition: 3, mastery: 4, intervalDays: 15 },
    2,
    fixedNow,
  );

  assert.deepEqual(result, {
    repetition: 0,
    mastery: 2,
    intervalDays: 1,
    nextReviewAt: '2026-10-08T12:00:00.000Z',
    status: 'active',
  });
});

test('strong performance after three repetitions marks the item mastered', () => {
  const result = calculateNextReview(
    { repetition: 2, mastery: 4, intervalDays: 7 },
    5,
    fixedNow,
  );

  assert.deepEqual(result, {
    repetition: 3,
    mastery: 5,
    intervalDays: 30,
    nextReviewAt: '2026-11-06T12:00:00.000Z',
    status: 'mastered',
  });
});
