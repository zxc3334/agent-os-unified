import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { CareerLearningRecord } from './career-preparation.js';

const DeliverySchema = z.object({
  key: z.string().min(1), learningRecordId: z.string().min(1), reviewRound: z.number().int().nonnegative(),
  nextReviewAt: z.string().min(1), status: z.enum(['pending', 'delivered']), attempts: z.number().int().nonnegative(),
  attemptedAt: z.string().min(1), receiptId: z.string().optional(), deliveredAt: z.string().optional(),
}).strict();
const TargetSchema = z.object({ ownerId: z.string().min(1), botId: z.string().min(1), chatId: z.string().min(1), savedAt: z.string().min(1) }).strict();
const StateSchema = z.object({ deliveries: z.array(DeliverySchema), target: TargetSchema.optional() }).strict();
export type CareerReviewDelivery = z.infer<typeof DeliverySchema>;
export type CareerReviewTarget = z.infer<typeof TargetSchema>;

/** Durable outbox for review-round delivery. A new nextReviewAt creates a new delivery identity. */
export class JsonCareerReviewNotificationStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string, private readonly now: () => Date = () => new Date()) {}

  async rememberOwnerDm(input: { ownerId: string; botId: string; chatId: string }): Promise<void> {
    const target = TargetSchema.parse({ ownerId: input.ownerId, botId: input.botId, chatId: input.chatId, savedAt: this.now().toISOString() });
    await this.mutate((state) => { state.target = target; });
  }
  async getOwnerDm(ownerId: string): Promise<CareerReviewTarget | undefined> {
    const state = await this.read();
    return state.target?.ownerId === ownerId ? state.target : undefined;
  }
  async due(records: CareerLearningRecord[], limit: number): Promise<Array<{ record: CareerLearningRecord; key: string }>> {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
    const now = this.now().getTime();
    const state = await this.read();
    return records.filter((r) => r.reviewState === 'active' && Number.isFinite(Date.parse(r.nextReviewAt)) && Date.parse(r.nextReviewAt) <= now)
      .sort((a, b) => a.nextReviewAt.localeCompare(b.nextReviewAt))
      .map((record) => ({ record, key: deliveryKey(record) }))
      .filter(({ key }) => !state.deliveries.some((delivery) => delivery.key === key && delivery.status === 'delivered'))
      .slice(0, limit);
  }
  async markAttempt(key: string, record: CareerLearningRecord): Promise<CareerReviewDelivery> {
    return this.mutate((state) => {
      const existing = state.deliveries.find((delivery) => delivery.key === key);
      if (existing?.status === 'delivered') return existing;
      const value: CareerReviewDelivery = {
        key, learningRecordId: record.id, reviewRound: record.reviewRounds, nextReviewAt: record.nextReviewAt,
        status: 'pending', attempts: (existing?.attempts ?? 0) + 1, attemptedAt: this.now().toISOString(),
      };
      if (existing) Object.assign(existing, value); else state.deliveries.push(value);
      return value;
    });
  }
  async markDelivered(key: string, receiptId: string): Promise<void> {
    if (!receiptId.trim()) throw new Error('A real transport receipt is required');
    await this.mutate((state) => {
      const delivery = state.deliveries.find((item) => item.key === key);
      if (!delivery) throw new Error('Delivery attempt must be persisted before receipt');
      delivery.status = 'delivered'; delivery.receiptId = receiptId; delivery.deliveredAt = this.now().toISOString();
    });
  }
  async listDeliveries(): Promise<CareerReviewDelivery[]> { return (await this.read()).deliveries; }

  private async read(): Promise<z.infer<typeof StateSchema>> {
    try {
      const data: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      return StateSchema.parse(data);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { deliveries: [] };
      throw new Error(`Career review notification store is invalid or unreadable: ${this.path}: ${(error as Error).message}`);
    }
  }
  private mutate<T>(operation: (state: z.infer<typeof StateSchema>) => T): Promise<T> {
    const pending = this.queue.then(async () => {
      const state = await this.read(); const result = operation(state); StateSchema.parse(state);
      await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${randomUUID()}.tmp`; const handle = await open(temp, 'wx', 0o600);
      try { await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
      try { await rename(temp, this.path); } catch (error) { await unlink(temp).catch(() => undefined); throw error; }
      return result === undefined ? result : JSON.parse(JSON.stringify(result)) as T;
    });
    this.queue = pending.catch(() => undefined); return pending;
  }
}

export function careerReviewDeliveryKey(record: CareerLearningRecord): string { return deliveryKey(record); }
function deliveryKey(record: CareerLearningRecord): string { return `career-review:${encodeURIComponent(record.id)}:${record.reviewRounds}:${encodeURIComponent(record.nextReviewAt)}`; }
