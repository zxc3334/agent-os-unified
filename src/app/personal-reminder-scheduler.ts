import type { JsonDailyRecordsReminders, DailyReminder } from '../core/daily-records.js';

export interface ReminderTextSender {
  sendTextToChat(chatId: string, text: string, uuid?: string): Promise<string | undefined>;
}

/** Delivers private one-shot reminders and records only confirmed delivery receipts. */
export class PersonalReminderScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = false;

  constructor(private readonly options: {
    store: JsonDailyRecordsReminders;
    senderFor: (botId: string) => ReminderTextSender | undefined;
    now?: () => Date;
    onError?: (message: string) => void;
  }) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    const now = (this.options.now ?? (() => new Date()))().toISOString();
    const missed = this.options.store.markMissedThrough(now);
    for (const reminder of missed) void this.notifyMissed(reminder);
    for (const reminder of this.options.store.listReminders()) {
      if (reminder.status === 'scheduled') this.schedule(reminder);
    }
  }

  stop(): void {
    this.running = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  schedule(reminder: DailyReminder): void {
    this.clear(reminder.id);
    if (!this.running || reminder.status !== 'scheduled' || !reminder.deliveryTarget) return;
    const now = (this.options.now ?? (() => new Date()))().getTime();
    const due = Date.parse(reminder.dueAt);
    if (!Number.isFinite(due)) return;
    const delay = Math.max(0, Math.min(due - now, 2_147_000_000));
    const timer = setTimeout(() => {
      this.timers.delete(reminder.id);
      void this.deliver(reminder.id);
    }, delay);
    timer.unref?.();
    this.timers.set(reminder.id, timer);
  }

  cancel(id: string): void {
    this.clear(id);
  }

  private async deliver(id: string): Promise<void> {
    const reminder = this.options.store.getReminder(id);
    if (!this.running || !reminder || reminder.status !== 'scheduled' || !reminder.deliveryTarget) return;
    const now = (this.options.now ?? (() => new Date()))();
    if (Date.parse(reminder.dueAt) > now.getTime()) {
      this.schedule(reminder);
      return;
    }
    const sender = this.options.senderFor(reminder.deliveryTarget.botId);
    if (!sender) {
      this.options.store.recordDeliveryOutcome(id, { outcome: 'failed', attemptedAt: now.toISOString() });
      this.options.onError?.(`提醒 ${id} 未送达：发送成员不可用`);
      return;
    }
    try {
      const receiptId = await sender.sendTextToChat(
        reminder.deliveryTarget.chatId,
        `⏰ 提醒：${reminder.content}`,
        `personal-reminder-${id}`,
      );
      if (!receiptId) throw new Error('发送接口未返回消息回执');
      this.options.store.recordDeliveryOutcome(id, { outcome: 'delivered', attemptedAt: now.toISOString(), receiptId });
    } catch (error) {
      this.options.store.recordDeliveryOutcome(id, { outcome: 'failed', attemptedAt: now.toISOString() });
      this.options.onError?.(`提醒 ${id} 发送失败：${(error as Error).message}`);
    }
  }

  private async notifyMissed(reminder: DailyReminder): Promise<void> {
    if (!reminder.deliveryTarget) return;
    const sender = this.options.senderFor(reminder.deliveryTarget.botId);
    if (!sender) return;
    try {
      await sender.sendTextToChat(
        reminder.deliveryTarget.chatId,
        `你设置的提醒「${reminder.content}」原定于 ${reminder.dueAt} 发送，但 Agent OS 当时不可用，因此没有按时送达。该提醒已标记为错过。`,
        `personal-reminder-missed-${reminder.id}`,
      );
    } catch (error) {
      this.options.onError?.(`错过提醒恢复通知失败 ${reminder.id}：${(error as Error).message}`);
    }
  }

  private clear(id: string): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
  }
}
