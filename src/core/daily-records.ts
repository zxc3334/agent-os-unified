import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type DailyRecordKind = 'daily' | 'reading' | 'exploration';
export interface DailyRecordSource {
  sourceId: string;
  actorId: string;
  receivedAt: string;
  timezone: string;
}
export interface DailyRecord {
  id: string;
  operationId: string;
  kind: DailyRecordKind;
  date: string;
  content: string;
  scopeId: string | null;
  source: DailyRecordSource;
  createdAt: string;
  /** Reading source claims and the user's response remain separate. */
  authorView?: string;
  userView?: string;
  /** Exploration evidence, hypotheses, and questions are not conflated. */
  observation?: string;
  hypothesis?: string;
  question?: string;
}
export type ReminderStatus = 'scheduled' | 'delivered' | 'failed' | 'missed' | 'cancelled';
export type ReminderDeliveryOutcome = 'delivered' | 'failed' | 'unknown';
export interface ReminderDeliveryAttempt {
  outcome: ReminderDeliveryOutcome;
  attemptedAt: string;
  receiptId?: string;
}
export interface DailyReminder {
  id: string;
  operationId: string;
  content: string;
  dueAt: string;
  status: ReminderStatus;
  source: DailyRecordSource;
  recordId?: string;
  createdAt: string;
  updatedAt: string;
  deliveryAttempts: ReminderDeliveryAttempt[];
  lastDeliveryOutcome?: ReminderDeliveryOutcome;
  deliveryTarget?: { botId: string; chatId: string };
}
interface StoreState {
  schemaVersion: 1;
  records: DailyRecord[];
  reminders: DailyReminder[];
}
export interface CreateDailyRecordInput {
  operationId: string;
  kind: DailyRecordKind;
  date: string;
  content: string;
  source: DailyRecordSource;
  scopeId?: string | null;
  authorView?: string;
  userView?: string;
  observation?: string;
  hypothesis?: string;
  question?: string;
}
export interface CreateReminderInput {
  operationId: string;
  content: string;
  source: DailyRecordSource;
  dueAt?: string;
  relativeDue?: string;
  recordId?: string;
  deliveryTarget?: { botId: string; chatId: string };
}
export interface Recap {
  from: string;
  through: string;
  records: DailyRecord[];
  sourceIds: string[];
}

function nonEmpty(value: string, field: string, limit = 16_000): string {
  const result = value.trim();
  if (!result || result.length > limit) throw new Error(`${field} must contain 1-${limit} characters`);
  return result;
}
function validIso(value: string, field: string): string {
  const normalized = nonEmpty(value, field, 80);
  if (!Number.isFinite(Date.parse(normalized)) || !/^\d{4}-\d\d-\d\dT/.test(normalized)) {
    throw new Error(`${field} must be an ISO timestamp`);
  }
  return new Date(normalized).toISOString();
}
function validDate(value: string): string {
  if (!/^\d{4}-\d\d-\d\d$/.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error('date must be a valid YYYY-MM-DD calendar date');
  }
  return value;
}
function normalizeSource(source: DailyRecordSource): DailyRecordSource {
  const timezone = nonEmpty(source.timezone, 'timezone', 100);
  // Intl validates the IANA timezone and ensures parsing never falls back to host-local time.
  new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0);
  return {
    sourceId: nonEmpty(source.sourceId, 'sourceId', 300),
    actorId: nonEmpty(source.actorId, 'actorId', 300),
    receivedAt: validIso(source.receivedAt, 'receivedAt'),
    timezone,
  };
}

function localParts(instant: string, timezone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(instant));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: Number(value.year), month: Number(value.month), day: Number(value.day) };
}
function zonedLocalToIso(
  date: { year: number; month: number; day: number }, hour: number, minute: number, timezone: string,
): string {
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) throw new Error('invalid local reminder time');
  const wanted = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  let guess = wanted;
  // Resolve the supplied wall clock against the supplied timezone, including DST offset changes.
  for (let index = 0; index < 3; index += 1) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(guess));
    const local = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const represented = Date.UTC(Number(local.year), Number(local.month) - 1, Number(local.day), Number(local.hour), Number(local.minute));
    guess += wanted - represented;
  }
  return new Date(guess).toISOString();
}

/** Resolve supported relative phrases only from trusted source receipt time and timezone. */
export function resolveRelativeDue(relativeDue: string, sourceInput: DailyRecordSource): string {
  const source = normalizeSource(sourceInput);
  const phrase = nonEmpty(relativeDue, 'relativeDue', 200).toLocaleLowerCase();
  if (/\bor\b|还是|或者/.test(phrase)) throw new Error('ambiguous clock time; the phrase contains alternatives');
  let dayOffset: number;
  if (/\bday after tomorrow\b|\bin two days\b|后天/.test(phrase)) dayOffset = 2;
  else if (/\btomorrow\b|明天/.test(phrase)) dayOffset = 1;
  else if (/\btoday\b|今天/.test(phrase)) dayOffset = 0;
  else throw new Error('relativeDue must specify today, tomorrow, or the day after tomorrow');

  const english = phrase.match(/(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  const chinese = phrase.match(/(?:上午|早上|中午|下午|晚上)?\s*(\d{1,2}|十二|十一|十|九|八|七|六|五|四|三|二|两|一|〇|零)(?::(\d{2}))?\s*(?:点|时)(?:(\d{1,2}|十二|十一|十|九|八|七|六|五|四|三|二|两|一|〇|零)分?)?/);
  let hour: number;
  let minute: number;
  if (chinese) {
    const chineseNumber = (value: string | undefined): number => {
      if (!value) return 0;
      const digits: Record<string, number> = { '〇': 0, '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10, '十一': 11, '十二': 12 };
      return digits[value] ?? Number(value);
    };
    hour = chineseNumber(chinese[1]);
    minute = chinese[2] ? Number(chinese[2]) : chineseNumber(chinese[3]);
    const period = phrase.match(/上午|早上|中午|下午|晚上/)?.[0];
    if (!period && hour >= 1 && hour <= 12) throw new Error('ambiguous clock time; specify morning/evening or 24-hour time');
    if (period === '下午' || period === '晚上') hour = hour === 12 ? hour : hour + 12;
    else if (period === '中午' && hour < 11) hour += 12;
    else if ((period === '上午' || period === '早上') && hour === 12) hour = 0;
  } else if (english) {
    hour = Number(english[1]);
    minute = Number(english[2] ?? 0);
    if (!english[3] && hour >= 1 && hour <= 12) throw new Error('ambiguous clock time; specify am/pm or 24-hour time');
    if (english[3]?.toLowerCase() === 'pm' && hour < 12) hour += 12;
    if (english[3]?.toLowerCase() === 'am' && hour === 12) hour = 0;
  } else {
    throw new Error('relativeDue must include a reminder time');
  }
  const today = localParts(source.receivedAt, source.timezone);
  const day = new Date(Date.UTC(today.year, today.month - 1, today.day + dayOffset));
  return zonedLocalToIso({ year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate() }, hour, minute, source.timezone);
}

function emptyState(): StoreState { return { schemaVersion: 1, records: [], reminders: [] }; }
function readState(filePath: string): StoreState {
  try {
    const value: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!value || typeof value !== 'object') throw new Error('invalid daily records store');
    const candidate = value as Partial<StoreState>;
    if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.records) || !Array.isArray(candidate.reminders)) {
      throw new Error('unsupported or corrupt daily records store; refusing to overwrite it');
    }
    return candidate as StoreState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
    throw error;
  }
}

/** Durable core lifecycle. Reminder scheduling is explicit; creating a date record has no reminder side effect. */
export class JsonDailyRecordsReminders {
  private state: StoreState;
  constructor(private readonly filePath?: string) {
    this.state = filePath ? readState(filePath) : emptyState();
  }
  createRecord(input: CreateDailyRecordInput): DailyRecord {
    const source = normalizeSource(input.source);
    const normalized = {
      operationId: nonEmpty(input.operationId, 'operationId', 300), kind: input.kind,
      date: validDate(input.date), content: nonEmpty(input.content, 'content'), scopeId: input.scopeId == null ? null : nonEmpty(input.scopeId, 'scopeId', 300), source,
      ...(input.authorView?.trim() ? { authorView: nonEmpty(input.authorView, 'authorView') } : {}),
      ...(input.userView?.trim() ? { userView: nonEmpty(input.userView, 'userView') } : {}),
      ...(input.observation?.trim() ? { observation: nonEmpty(input.observation, 'observation') } : {}),
      ...(input.hypothesis?.trim() ? { hypothesis: nonEmpty(input.hypothesis, 'hypothesis') } : {}),
      ...(input.question?.trim() ? { question: nonEmpty(input.question, 'question') } : {}),
    };
    if (!['daily', 'reading', 'exploration'].includes(normalized.kind)) throw new Error('unsupported daily record kind');
    const existing = this.state.records.find((record) => record.operationId === normalized.operationId);
    if (existing) {
      const { id: _id, createdAt: _createdAt, ...existingInput } = existing;
      if (JSON.stringify(existingInput) !== JSON.stringify(normalized)) throw new Error('operationId already used for different record content');
      return structuredClone(existing);
    }
    const record: DailyRecord = { id: randomUUID(), ...normalized, createdAt: source.receivedAt };
    this.mutate(() => { this.state.records.push(record); });
    return structuredClone(record);
  }
  getRecord(id: string): DailyRecord | undefined {
    const record = this.state.records.find((item) => item.id === id);
    return record && structuredClone(record);
  }
  listRecords(options: { from?: string; through?: string; scopeId?: string | null } = {}): DailyRecord[] {
    const from = options.from === undefined ? undefined : validDate(options.from);
    const through = options.through === undefined ? undefined : validDate(options.through);
    return structuredClone(this.state.records.filter((record) =>
      (!from || record.date >= from) && (!through || record.date <= through)
      && (options.scopeId === undefined || record.scopeId === options.scopeId),
    ).sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt)));
  }
  setRecordScope(id: string, scopeId: string | null): DailyRecord | undefined {
    const record = this.state.records.find((item) => item.id === id);
    if (!record) return undefined;
    const next = { ...record, scopeId: scopeId === null ? null : nonEmpty(scopeId, 'scopeId', 300) };
    this.mutate(() => { this.state.records = this.state.records.map((item) => item.id === id ? next : item); });
    return structuredClone(next);
  }
  createReminder(input: CreateReminderInput): DailyReminder {
    if ((input.dueAt === undefined) === (input.relativeDue === undefined)) throw new Error('provide exactly one of dueAt or relativeDue');
    const operationId = nonEmpty(input.operationId, 'operationId', 300);
    const content = nonEmpty(input.content, 'content');
    const source = normalizeSource(input.source);
    const dueAt = input.dueAt === undefined ? resolveRelativeDue(input.relativeDue!, source) : validIso(input.dueAt, 'dueAt');
    if (Date.parse(dueAt) <= Date.parse(source.receivedAt)) throw new Error('reminder time must be after the source message was received');
    if (input.recordId && !this.state.records.some((record) => record.id === input.recordId)) throw new Error('linked record does not exist');
    const existing = this.state.reminders.find((item) => item.operationId === operationId);
    if (existing) return structuredClone(existing);
    const reminder: DailyReminder = {
      id: randomUUID(), operationId, content, dueAt, status: 'scheduled', source,
      ...(input.recordId ? { recordId: input.recordId } : {}),
      ...(input.deliveryTarget ? { deliveryTarget: { botId: nonEmpty(input.deliveryTarget.botId, 'botId', 100), chatId: nonEmpty(input.deliveryTarget.chatId, 'chatId', 300) } } : {}),
      createdAt: source.receivedAt,
      updatedAt: source.receivedAt, deliveryAttempts: [],
    };
    this.mutate(() => { this.state.reminders.push(reminder); });
    return structuredClone(reminder);
  }
  getReminder(id: string): DailyReminder | undefined {
    const reminder = this.state.reminders.find((item) => item.id === id);
    return reminder && structuredClone(reminder);
  }
  listReminders(): DailyReminder[] { return structuredClone(this.state.reminders); }
  editReminder(id: string, patch: { dueAt?: string; content?: string; changedAt: string }): DailyReminder | undefined {
    const current = this.state.reminders.find((item) => item.id === id);
    if (!current) return undefined;
    if (current.status === 'cancelled' || current.status === 'delivered' || current.status === 'missed') throw new Error(`cannot edit ${current.status} reminder`);
    if (patch.dueAt === undefined && patch.content === undefined) return structuredClone(current);
    const updated = { ...current, ...(patch.dueAt ? { dueAt: validIso(patch.dueAt, 'dueAt') } : {}), ...(patch.content ? { content: nonEmpty(patch.content, 'content') } : {}), ...(current.status === 'failed' ? { status: 'scheduled' as const } : {}), updatedAt: validIso(patch.changedAt, 'changedAt') };
    this.mutate(() => { this.replaceReminder(updated); });
    return structuredClone(updated);
  }
  retryFailedReminder(id: string, retriedAt: string): DailyReminder | undefined {
    const current = this.state.reminders.find((item) => item.id === id);
    if (!current || current.status !== 'failed') return undefined;
    const updated: DailyReminder = { ...current, status: 'scheduled', updatedAt: validIso(retriedAt, 'retriedAt') };
    this.mutate(() => { this.replaceReminder(updated); });
    return structuredClone(updated);
  }
  cancelReminder(id: string, cancelledAt: string): DailyReminder | undefined {
    const current = this.state.reminders.find((item) => item.id === id);
    if (!current) return undefined;
    if (current.status === 'cancelled') return structuredClone(current);
    if (current.status === 'delivered' || current.status === 'missed') throw new Error(`cannot cancel ${current.status} reminder`);
    const updated = { ...current, status: 'cancelled' as const, updatedAt: validIso(cancelledAt, 'cancelledAt') };
    this.mutate(() => { this.replaceReminder(updated); });
    return structuredClone(updated);
  }
  recordDeliveryOutcome(id: string, input: ReminderDeliveryAttempt): DailyReminder | undefined {
    const current = this.state.reminders.find((item) => item.id === id);
    if (!current) return undefined;
    if (current.status === 'cancelled' || current.status === 'delivered' || current.status === 'missed') return structuredClone(current);
    if (!['delivered', 'failed', 'unknown'].includes(input.outcome)) throw new Error('unsupported delivery outcome');
    const attempt: ReminderDeliveryAttempt = {
      outcome: input.outcome, attemptedAt: validIso(input.attemptedAt, 'attemptedAt'),
      ...(input.receiptId ? { receiptId: nonEmpty(input.receiptId, 'receiptId', 300) } : {}),
    };
    if (attempt.outcome === 'delivered' && !attempt.receiptId) throw new Error('delivered outcome requires a trusted receiptId');
    const updated: DailyReminder = {
      ...current,
      status: attempt.outcome === 'delivered' ? 'delivered' : attempt.outcome === 'failed' ? 'failed' : 'scheduled',
      lastDeliveryOutcome: attempt.outcome, updatedAt: attempt.attemptedAt,
      deliveryAttempts: [...current.deliveryAttempts, attempt],
    };
    this.mutate(() => { this.replaceReminder(updated); });
    return structuredClone(updated);
  }
  /** Called at recovery with an explicit trusted clock; never reads system-now. */
  markMissedThrough(trustedNow: string): DailyReminder[] {
    const cutoff = validIso(trustedNow, 'trustedNow');
    const missed = this.state.reminders.filter((item) => item.status === 'scheduled' && item.dueAt <= cutoff)
      .map((item) => ({ ...item, status: 'missed' as const, updatedAt: cutoff }));
    if (missed.length) this.mutate(() => { for (const item of missed) this.replaceReminder(item); });
    return structuredClone(missed);
  }
  recap(range: { from: string; through: string; scopeId?: string | null }): Recap {
    const from = validDate(range.from);
    const through = validDate(range.through);
    if (from > through) throw new Error('recap from must be on or before through');
    const records = this.listRecords({ from, through, ...(range.scopeId === undefined ? {} : { scopeId: range.scopeId }) });
    return { from, through, records, sourceIds: [...new Set(records.map((item) => item.source.sourceId))] };
  }
  private replaceReminder(updated: DailyReminder): void {
    this.state.reminders = this.state.reminders.map((item) => item.id === updated.id ? updated : item);
  }
  private mutate(change: () => void): void {
    const previous = structuredClone(this.state);
    try {
      change();
      this.persist();
    } catch (error) {
      this.state = previous;
      throw error;
    }
  }
  private persist(): void {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    const descriptor = openSync(temporaryPath, 'wx', 0o600);
    try {
      writeFileSync(descriptor, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      renameSync(temporaryPath, this.filePath);
    } catch (error) {
      try { unlinkSync(temporaryPath); } catch { /* preserve the original rename failure */ }
      throw error;
    }
  }
}
