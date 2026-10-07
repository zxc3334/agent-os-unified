import { createHash } from 'node:crypto';
import type { CareerLearningRecord, JsonCareerPreparation } from '../core/career-preparation.js';
import { JsonCareerReviewNotificationStore } from '../core/career-review-notifications.js';
import type { Bot } from '../im/lark.js';

export interface CareerReviewBotTarget { botId: string; bot: Pick<Bot, 'sendTextToChat'> }
export interface CareerReviewNotificationOptions {
  career: Pick<JsonCareerPreparation, 'listLearningRecords'>;
  store: JsonCareerReviewNotificationStore;
  ownerId?: string;
  getBot: (botId: string) => CareerReviewBotTarget | undefined;
  now?: () => Date;
  batchSize?: number;
  intervalMs?: number;
  onError?: (message: string) => void;
}

/** Scheduler and crash-recovery pump for a persisted, owner-DM-only outbox. */
export class CareerReviewNotificationScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  constructor(private readonly options: CareerReviewNotificationOptions) {}
  async rememberOwnerConversation(input: { ownerId: string; botId: string; chatId: string; chatType: string }): Promise<boolean> {
    if (!this.options.ownerId || input.ownerId !== this.options.ownerId || input.chatType !== 'p2p' || !input.chatId.trim()) return false;
    await this.options.store.rememberOwnerDm(input); return true;
  }
  async runOnce(): Promise<{ delivered: string[]; failed: string[]; skipped?: string }> {
    if (!this.options.ownerId) return { delivered: [], failed: [], skipped: 'owner-not-configured' };
    const target = await this.options.store.getOwnerDm(this.options.ownerId);
    if (!target) return { delivered: [], failed: [], skipped: 'owner-private-chat-not-known' };
    const bot = this.options.getBot(target.botId);
    if (!bot) return { delivered: [], failed: [], skipped: 'delivery-bot-unavailable' };
    const due = await this.options.store.due(await this.options.career.listLearningRecords(), this.options.batchSize ?? 5);
    const delivered: string[] = []; const failed: string[] = [];
    for (const { record, key } of due) {
      try {
        await this.options.store.markAttempt(key, record);
        const receipt = await bot.bot.sendTextToChat(target.chatId, formatReview(record), larkUuid(key));
        if (!receipt?.trim()) throw new Error('Feishu returned no message receipt');
        await this.options.store.markDelivered(key, receipt);
        delivered.push(record.id);
      } catch (error) { failed.push(record.id); this.options.onError?.(`career review ${record.id}: ${(error as Error).message}`); }
    }
    return { delivered, failed };
  }
  start(): void {
    if (this.timer) return;
    void this.runGuarded(); // startup recovery: pending/due items are revisited immediately
    this.timer = setInterval(() => void this.runGuarded(), this.options.intervalMs ?? 5 * 60_000);
    this.timer.unref?.();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  private runGuarded(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.runOnce().then(() => undefined).catch((error) => this.options.onError?.(`career review scheduler: ${(error as Error).message}`)).finally(() => { this.running = undefined; });
    return this.running;
  }
}

function formatReview(record: CareerLearningRecord): string {
  return `面试复习提醒\n${record.weakPoint}\n\n回想一下：${record.summary}\n复习记录：/career review ${record.id} <0-5分>`;
}
function larkUuid(key: string): string { return createHash('sha256').update(key).digest('hex').slice(0, 32); }
