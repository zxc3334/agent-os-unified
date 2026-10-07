import { createHash } from 'node:crypto';
import { calculateNextReview, saveMemoryCardEntry } from './memory.js';
import { findSaveMemoryRequest } from './save-memory.js';
import type { CliRunResult } from '../cli/types.js';

/**
 * 把 bot 通过 save_memory 提交的记忆落盘。
 *
 * 为什么单独抽出来：普通消息路径（index.ts）和定时任务路径
 * （scheduled-task-runner.ts）都需要处理 toolCalls，两处各写一遍
 * 就会漏（已经漏过一次）。这里保证只有一份实现。
 *
 * 模型只负责提炼结构化信息，文件写入由代码执行 —— 沿用面试项目
 * SPEC-002 的原则：防止模型幻觉损坏 MEMORY.md 索引。
 */
export async function persistMemorySubmission(options: {
  toolCalls: CliRunResult['toolCalls'];
  fallbackProject: string;
}): Promise<{ saved: boolean; topic?: string; project?: string }> {
  const request = findSaveMemoryRequest(options.toolCalls);
  if (!request) return { saved: false };

  const project = request.project || options.fallbackProject;
  const id = request.action === 'update' && request.existingId
    ? request.existingId
    : `mem-${new Date().toISOString().slice(0, 10)}-${slugify(request.topic)}`;

  const sched = calculateNextReview(
    { repetition: 0, mastery: request.mastery, intervalDays: 1 },
    request.mastery,
  );

  await saveMemoryCardEntry({
    id,
    project,
    topic: request.topic,
    description: request.description,
    tags: request.tags,
    createdAt: new Date().toISOString(),
    nextReviewAt: sched.nextReviewAt,
    repetition: sched.repetition,
    intervalDays: sched.intervalDays,
    mastery: sched.mastery,
    status: sched.status,
    weaknessAnalysis: request.weaknessAnalysis,
    corePrinciples: request.corePrinciples,
    reviewQuestion: request.reviewQuestion,
  }, project);

  return { saved: true, topic: request.topic, project };
}

function slugify(topic: string): string {
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30);
  // 中文主题 slug 会是空串，全落成-tech-point- 会互相覆盖（文件名即 id）。
  // 用主题哈希做后缀保证唯一。
  const hash = createHash('sha1').update(topic).digest('hex').slice(0, 8);
  return slug ? `${slug}-${hash}` : `topic-${hash}`;
}
