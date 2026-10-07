import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { Cron } from 'croner';
import {
  calculateNextReview,
  listMemoryCardEntries,
  listMemoryProjects,
  saveMemoryCardEntry,
  type MemoryCardEntry,
} from './memory.js';

/** 跨所有项目聚合记忆条目（复习调度需要看到全部项目）。 */
async function listAllProjectEntries(): Promise<MemoryCardEntry[]> {
  const projects = await listMemoryProjects();
  const all = await Promise.all(
    projects.map((p) => listMemoryCardEntries(p).catch(() => [])),
  );
  return all.flat();
}
import { buildReviewCard } from '../im/card.js';
import type { Bot } from '../im/lark.js';
import type { CareerLearningRecord } from './career-preparation.js';

export interface ReviewSchedulerOptions {
  cronExpression?: string;
  timezone?: string;
  workspaceDirs: string[];
  getBot: (botId?: string) => Bot | undefined;
  preferredBotId?: string;
  getTargetChatId: () => string | undefined;
  now?: () => Date;
  baseDir?: string;
  careerReviewAdapter?: CareerReviewSchedulerAdapter;
}

export interface ReviewTriggerResult {
  pushed: boolean;
  item?: MemoryCardEntry;
  chatId?: string;
  messageId?: string;
  reason?: string;
}

export interface CareerReviewStore {
  listLearningRecords(): Promise<CareerLearningRecord[]>;
  recordLearningReview(id: string, review: { score: number; reviewedAt?: string }): Promise<CareerLearningRecord>;
}

/**
 * Small bridge between persisted interview-learning feedback and the review lifecycle.
 * This adapter returns due records to an explicitly private caller; it is not consulted
 * by triggerDueReviews/triggerProjectReview, which remain memory-card-only group flows.
 */
export class CareerReviewSchedulerAdapter {
  constructor(
    private readonly career: CareerReviewStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async listDueReviews(): Promise<CareerLearningRecord[]> {
    const now = this.now().getTime();
    return (await this.career.listLearningRecords())
      .filter((record) => record.reviewState === 'active' && new Date(record.nextReviewAt).getTime() <= now)
      .sort((left, right) => left.nextReviewAt.localeCompare(right.nextReviewAt));
  }

  async completeReview(id: string, quality: number): Promise<CareerLearningRecord> {
    return this.career.recordLearningReview(id, { score: quality, reviewedAt: this.now().toISOString() });
  }
}

export class ReviewScheduler {
  private cronJob?: Cron;
  private running = false;
  private readonly cronExpression: string;
  private readonly timezone?: string;
  private readonly workspaceDirs: string[];
  private readonly getBot: (botId?: string) => Bot | undefined;
  private readonly preferredBotId: string;
  private readonly getTargetChatId: () => string | undefined;
  private readonly now: () => Date;
  private readonly baseDir?: string;
  private readonly careerReviewAdapter?: CareerReviewSchedulerAdapter;
  private lastDailyPushDate?: string;

  constructor(options: ReviewSchedulerOptions) {
    this.cronExpression = options.cronExpression || process.env.REVIEW_CRON || '0 20 * * *';
    this.timezone = options.timezone || process.env.TZ || 'Asia/Shanghai';
    this.workspaceDirs = [...new Set(options.workspaceDirs.filter(Boolean))];
    this.getBot = options.getBot;
    this.preferredBotId = options.preferredBotId || 'tutor';
    this.getTargetChatId = options.getTargetChatId;
    this.now = options.now || (() => new Date());
    this.baseDir = options.baseDir;
    this.careerReviewAdapter = options.careerReviewAdapter;
  }

  start(): void {
    if (this.running) return;
    if (
      this.cronExpression === 'none' ||
      this.cronExpression === 'disabled' ||
      process.env.REVIEW_ENABLED === 'false'
    ) {
      console.log('[复习调度] 艾宾浩斯复习调度器已被配置关闭');
      return;
    }
    this.running = true;

    try {
      this.cronJob = new Cron(
        this.cronExpression,
        { timezone: this.timezone },
        async () => {
          console.log(`[复习调度] 艾宾浩斯定时任务触发: ${this.cronExpression}`);
          try {
            await this.triggerDueReviews();
          } catch (error) {
            console.error('[复习调度] 执行复习巡检出错:', (error as Error).message);
          }
        },
      );
      console.log(
        `[复习调度] 艾宾浩斯复习调度器已启动: cron="${this.cronExpression}" tz="${this.timezone}"`,
      );
    } catch (error) {
      console.error('[复习调度] 初始化 Cron 失败:', (error as Error).message);
    }
  }

  stop(): void {
    this.running = false;
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = undefined;
    }
    console.log('[复习调度] 艾宾浩斯复习调度器已停止');
  }

  /**
   * 定时触发到期的复习题目（每晚定时任务全局只推送 1 道到期考点，绝不向同一群聊重复推送）
   */
  async triggerDueReviews(): Promise<ReviewTriggerResult[]> {
    const today = this.now().toISOString().slice(0, 10);
    if (this.lastDailyPushDate === today) {
      console.log(`[复习调度] 今日 (${today}) 定时复习已推送过，避免重复推送`);
      return [];
    }

    const res = await this.triggerProjectReview(undefined, {
      allowFallback: false,
      isDailyScheduled: true,
    });
    if (!res.pushed) {
      console.log(`[复习调度] 定时巡检完成: ${res.reason || '今日暂无到期复习题目'}`);
      return [];
    }
    this.lastDailyPushDate = today;
    return [res];
  }

  /**
   * 触发单个工作区/全局的复习题目（供手动 /review 命令或定时任务调用）
   */
  async triggerProjectReview(
    workspaceDir?: string,
    options: { allowFallback?: boolean; isDailyScheduled?: boolean } = { allowFallback: true },
  ): Promise<ReviewTriggerResult> {
    const chatId = this.getTargetChatId();
    if (!chatId) {
      return {
        pushed: false,
        reason: '找不到可推送的飞书群聊 (chatId 为空)',
      };
    }

    const bot = this.getBot(this.preferredBotId) || this.getBot();
    if (!bot) {
      return {
        pushed: false,
        reason: '找不到可用的飞书机器人实例',
      };
    }

    const entries = await listAllProjectEntries();
    const activeEntries = entries.filter((e) => e.status === 'active');
    const nowTime = this.now().getTime();

    // 如果指定了工作区，且存在与该工作区匹配的项目卡片，优先在该项目范围内挑选
    let scopedEntries = activeEntries;
    if (workspaceDir) {
      const projectSlug = basename(workspaceDir).toLowerCase();
      const matched = activeEntries.filter(
        (e) =>
          e.project?.toLowerCase() === projectSlug ||
          e.project?.toLowerCase() === workspaceDir.toLowerCase(),
      );
      if (matched.length > 0) {
        scopedEntries = matched;
      }
    }

    // 优先挑选已到期的考点；若允许回退（如用户手动触发 /review），则挑选最近待复习考点
    const targetItem =
      scopedEntries.find((e) => new Date(e.nextReviewAt).getTime() <= nowTime) ||
      (options.allowFallback ? scopedEntries[0] : undefined);

    if (!targetItem) {
      return {
        pushed: false,
        reason: '当前暂无需要复习的薄弱点或题目',
      };
    }

    const card = buildReviewCard({
      projectName: targetItem.project,
      itemId: targetItem.id,
      topic: targetItem.topic,
      question: targetItem.reviewQuestion || `${targetItem.description} 的核心考点与原理？`,
      repetition: targetItem.repetition,
      intervalDays: targetItem.intervalDays,
      mastery: targetItem.mastery,
      workspaceDir: workspaceDir || this.workspaceDirs[0] || process.cwd(),
    });

    const todayDate = this.now().toISOString().slice(0, 10);
    // 生成确定性的飞书服务端幂等 uuid（不超过 50 字符，格式标准，飞书云端 1 小时内物理去重）
    const idempotentKey = `rev-${createHash('md5').update(`${targetItem.id}:${todayDate}`).digest('hex')}`;

    try {
      const messageId = await bot.sendCardToChat(chatId, card, idempotentKey);
      console.log(
        `[复习调度] 已向群 ${chatId} 推送复习卡片: [${targetItem.topic}] messageId=${messageId ?? '(空)'} uuid=${idempotentKey}`,
      );
      if (options.isDailyScheduled) {
        this.lastDailyPushDate = todayDate;
      }
      return {
        pushed: true,
        item: targetItem,
        chatId,
        messageId,
      };
    } catch (error) {
      const msg = (error as Error).message;
      console.error(`[复习调度] 推送复习卡片失败: ${msg}`);
      return {
        pushed: false,
        item: targetItem,
        chatId,
        reason: msg,
      };
    }
  }

  /**
   * Career feedback uses the same review completion entry point/algorithm, but is
   * deliberately never included in group-chat selection or scheduled group pushes.
   * The owner-only caller may retrieve due records from the adapter and present them
   * in a private conversation before invoking this method.
   */
  async completeCareerReview(id: string, quality: number): Promise<CareerLearningRecord | undefined> {
    return this.careerReviewAdapter?.completeReview(id, quality);
  }

  /**
   * 记录复习完成，推进艾宾浩斯复习周期
   */
  async completeReview(
    _workspaceDir: string,
    itemId: string,
    quality: number, // 0 - 5
  ): Promise<MemoryCardEntry | undefined> {
    const currentItem = (await listAllProjectEntries()).find((e) => e.id === itemId);
    if (!currentItem) return undefined;

    const next = calculateNextReview(currentItem, quality, this.now());
    currentItem.mastery = next.mastery;
    currentItem.repetition = next.repetition;
    currentItem.intervalDays = next.intervalDays;
    currentItem.nextReviewAt = next.nextReviewAt;
    currentItem.status = next.status;

    await saveMemoryCardEntry(currentItem, currentItem.project || 'default');
    return currentItem;
  }
}
