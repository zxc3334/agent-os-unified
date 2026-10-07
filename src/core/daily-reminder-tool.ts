import { z } from 'zod';
import { JsonDailyRecordsReminders, resolveRelativeDue, type DailyRecordSource } from './daily-records.js';

/** Intentionally accepts incomplete timing so the model can receive an actionable clarification result. */
export const CreateDailyReminderToolSchema = z.object({
  content: z.string().trim().min(1).max(16_000),
  dueAt: z.string().trim().min(1).max(80).optional(),
  relativeDue: z.string().trim().min(1).max(200).optional(),
}).strict();
export type CreateDailyReminderToolInput = z.infer<typeof CreateDailyReminderToolSchema>;

export type CreateDailyReminderToolResult =
  | { status: 'created'; reminderId: string; dueAt: string }
  | { status: 'needs_clarification'; code: 'missing_due_time' | 'ambiguous_due_time'; question: string }
  | { status: 'invalid'; code: 'invalid_due_time' | 'invalid_input'; message: string };

/** The tool boundary converts missing/uncertain timing into a non-error outcome and never persists it. */
export function createDailyReminderFromTool(
  store: JsonDailyRecordsReminders,
  input: unknown,
  context: { operationId: string; source: DailyRecordSource; deliveryTarget?: { botId: string; chatId: string } },
): CreateDailyReminderToolResult {
  const parsed = CreateDailyReminderToolSchema.safeParse(input);
  if (!parsed.success) return { status: 'invalid', code: 'invalid_input', message: '提醒内容不完整或参数格式不正确；请修正后重试。' };
  const { content, dueAt, relativeDue } = parsed.data;
  if (!dueAt && !relativeDue) {
    return { status: 'needs_clarification', code: 'missing_due_time', question: '提醒的具体日期和时间是什么？请提供明确时间，例如“明天下午 3 点”或“2026-10-08 15:00”。' };
  }
  if (Boolean(dueAt) === Boolean(relativeDue)) {
    return { status: 'invalid', code: 'invalid_due_time', message: '请只提供一种时间：明确的 ISO 时间 dueAt，或相对于原消息时间的 relativeDue。' };
  }
  try {
    // Resolve before calling createReminder so validation failures cannot have persistence side effects.
    if (dueAt && (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(dueAt) || !Number.isFinite(Date.parse(dueAt)))) {
      throw new Error('dueAt must include an explicit ISO date, clock time, and timezone');
    }
    const resolvedDueAt = dueAt ? new Date(dueAt).toISOString() : resolveRelativeDue(relativeDue!, context.source);
    const reminder = store.createReminder({ operationId: context.operationId, content, dueAt: resolvedDueAt, source: context.source, deliveryTarget: context.deliveryTarget });
    return { status: 'created', reminderId: reminder.id, dueAt: reminder.dueAt };
  } catch (error) {
    const message = (error as Error).message;
    if (message.includes('specify today, tomorrow, or the day after tomorrow')) {
      return { status: 'needs_clarification', code: 'missing_due_time', question: '具体是哪一天、几点？请给出明确日期和时间，例如“后天下午 3 点”或“2026-10-09 15:00”。' };
    }
    if (message.includes('specific time') || message.includes('include a reminder time')) {
      return { status: 'needs_clarification', code: 'missing_due_time', question: '你想在当天几点收到提醒？请给出具体小时和分钟（如“上午 9 点”）。' };
    }
    if (message.includes('ambiguous')) {
      return { status: 'needs_clarification', code: 'ambiguous_due_time', question: '这个时间可能对应多个时刻。请说明上午/下午或使用 24 小时制，例如“晚上 8 点”或“20:00”。' };
    }
    return { status: 'invalid', code: 'invalid_due_time', message: `无法验证提醒时间：${message}；请提供明确的日期和时间。` };
  }
}
