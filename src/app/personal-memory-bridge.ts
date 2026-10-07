import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PersonalMemoryStore, PersonalMemorySource } from '../core/personal-memory.js';
import type { DailyRecord, DailyReminder, JsonDailyRecordsReminders } from '../core/daily-records.js';
import { CaptureDailyRecordSchema, CreatePersonalReminderSchema, DeleteDailyRecordSchema, SearchDailyRecordsSchema } from '../core/daily-record-tool.js';
import { confidenceFromTrustedSource, RememberPersonalMemorySchema, SearchPersonalMemorySchema } from '../core/personal-memory-tool.js';

export interface TrustedMemoryInvocation {
  actorId: string;
  ownerId: string;
  sourceId: string;
  receivedAt: string;
  timezone: string;
  sourceText: string;
  authorizedSpaceIds: string[];
  allowUnclassifiedRecords?: boolean;
  chatId?: string;
  botId?: string;
}

interface Invocation extends TrustedMemoryInvocation { token: string }

/** Short-lived loopback bridge so a tool can report success only after durable save. */
export class PersonalMemoryToolBridge {
  private readonly invocations = new Map<string, Invocation>();
  private server?: ReturnType<typeof createServer>;
  private boundPort?: number;

  constructor(
    private readonly store: PersonalMemoryStore,
    private readonly dailyRecords?: JsonDailyRecordsReminders,
    private readonly onReminderCreated?: (reminder: DailyReminder) => void,
    private readonly invalidateDailySource?: (record: DailyRecord) => void,
  ) {}

  async start(port = 0): Promise<number> {
    if (this.server) return this.boundPort!;
    const server = createServer((request, response) => { void this.handle(request, response); });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    this.server = server;
    this.boundPort = (server.address() as AddressInfo).port;
    return this.boundPort;
  }

  issue(invocation: TrustedMemoryInvocation): { token: string; release: () => void } {
    if (!this.server) throw new Error('Personal memory tool bridge is not started');
    const token = randomUUID();
    this.invocations.set(token, { ...invocation, token });
    return { token, release: () => { this.invocations.delete(token); } };
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.boundPort = undefined;
    this.invocations.clear();
    if (!server) return;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST' || !['/api/personal-memory/remember', '/api/personal-memory/search', '/api/daily-records/capture', '/api/daily-records/search', '/api/daily-records/delete', '/api/personal-reminders/create'].includes(request.url ?? '')) {
      return send(response, 404, { error: 'Not found' });
    }
    const token = request.headers['x-personal-memory-token'];
    const invocation = typeof token === 'string' ? this.invocations.get(token) : undefined;
    if (!invocation) return send(response, 401, { error: 'No active trusted invocation' });

    try {
      const body = await readJson(request);
      if (request.url?.startsWith('/api/daily-records/') || request.url === '/api/personal-reminders/create') {
        return await this.handleDailyTool(request.url, body, invocation, response);
      }
      if (request.url === '/api/personal-memory/search') {
        const parsedSearch = SearchPersonalMemorySchema.safeParse(body);
        if (!parsedSearch.success) return send(response, 400, { error: 'Invalid memory query', issues: parsedSearch.error.issues });
        if (invocation.actorId !== invocation.ownerId) return send(response, 403, { error: 'Only the configured owner may search personal memories' });
        const entries = await this.store.search(parsedSearch.data.query, {
          authorizedSpaceIds: invocation.authorizedSpaceIds,
          limit: parsedSearch.data.limit,
        });
        const spaces = new Map((await this.store.listSpaces()).map((space) => [space.id, space.name]));
        return send(response, 200, { entries: entries.map((entry) => ({
          id: entry.id, space: spaces.get(entry.spaceId) ?? '记忆空间', kind: entry.kind,
          confidence: entry.confidence, content: entry.content, sources: entry.sources.map(({ sourceId, receivedAt }) => ({ sourceId, receivedAt })),
        })) });
      }
      const parsed = RememberPersonalMemorySchema.safeParse(body);
      if (!parsed.success) return send(response, 400, { error: 'Invalid memory input', issues: parsed.error.issues });
      if (invocation.actorId !== invocation.ownerId) return send(response, 403, { error: 'Only the configured owner may save personal memories' });

      const space = await this.store.createSpace(parsed.data.spaceName);
      const source: PersonalMemorySource = {
        sourceId: invocation.sourceId,
        actorId: invocation.actorId,
        receivedAt: invocation.receivedAt,
        timezone: invocation.timezone,
        excerpt: invocation.sourceText,
      };
      const confidence = confidenceFromTrustedSource(parsed.data.kind, invocation.sourceText);
      const digest = createHash('sha256')
        .update(JSON.stringify([invocation.sourceId, space.id, parsed.data.kind, parsed.data.content]))
        .digest('hex');
      const result = await this.store.add({
        spaceId: space.id,
        kind: parsed.data.kind,
        content: parsed.data.content,
        confidence,
        source,
        tags: parsed.data.tags,
        operationId: `memory-tool:${digest}`,
      });
      if (result.status === 'suppressed') return send(response, 409, { error: 'This source was previously forgotten or rejected' });
      return send(response, result.status === 'created' ? 201 : 200, {
        status: result.status,
        entryId: result.entry.id,
        space: space.name,
        confidence: result.entry.confidence,
      });
    } catch (error) {
      return send(response, 500, { error: (error as Error).message || 'Personal memory save failed' });
    }
  }

  private async handleDailyTool(
    route: string | undefined,
    body: unknown,
    invocation: Invocation,
    response: ServerResponse,
  ): Promise<void> {
    if (invocation.actorId !== invocation.ownerId) return send(response, 403, { error: 'Only the configured owner may use personal daily records and reminders' });
    if (!this.dailyRecords) return send(response, 503, { error: 'Personal daily records are unavailable' });
    const source = {
      sourceId: invocation.sourceId,
      actorId: invocation.actorId,
      receivedAt: invocation.receivedAt,
      timezone: invocation.timezone,
    };
    if (route === '/api/daily-records/capture') {
      const parsed = CaptureDailyRecordSchema.safeParse(body);
      if (!parsed.success) return send(response, 400, { error: 'Invalid daily record', issues: parsed.error.issues });
      const { spaceId, ...fields } = parsed.data;
      if (spaceId && !invocation.authorizedSpaceIds.includes(spaceId)) return send(response, 403, { error: 'Requested memory space is not authorized for this matter' });
      const localDate = new Intl.DateTimeFormat('en-CA', {
        timeZone: invocation.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(new Date(invocation.receivedAt));
      const dateParts = Object.fromEntries(localDate.map((part) => [part.type, part.value]));
      const date = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
      const operationHash = createHash('sha256').update(JSON.stringify([
        invocation.sourceId, fields.kind, fields.content, spaceId ?? null,
        fields.authorView ?? null, fields.userView ?? null,
        fields.observation ?? null, fields.hypothesis ?? null, fields.question ?? null,
      ])).digest('hex');
      const record = this.dailyRecords.createRecord({
        operationId: `daily-tool:${operationHash}`,
        kind: fields.kind, date, content: fields.content, source,
        scopeId: spaceId ?? null,
        ...(fields.authorView ? { authorView: fields.authorView } : {}),
        ...(fields.userView ? { userView: fields.userView } : {}),
        ...(fields.observation ? { observation: fields.observation } : {}),
        ...(fields.hypothesis ? { hypothesis: fields.hypothesis } : {}),
        ...(fields.question ? { question: fields.question } : {}),
      });
      return send(response, 201, { recordId: record.id, kind: record.kind, date: record.date, scopeId: record.scopeId });
    }
    if (route === '/api/daily-records/delete') {
      if (!hasExplicitDailyDeleteIntent(invocation.sourceText)) {
        return send(response, 403, { error: 'The original owner message does not explicitly request deleting a daily record' });
      }
      const parsed = DeleteDailyRecordSchema.safeParse(body);
      if (!parsed.success) return send(response, 400, { error: 'Invalid daily record ID', issues: parsed.error.issues });
      const record = this.dailyRecords.getRecord(parsed.data.recordId);
      if (!record) return send(response, 404, { error: 'Daily record not found in the current authorized scope' });
      if (record.scopeId === null
        ? invocation.allowUnclassifiedRecords !== true
        : !invocation.authorizedSpaceIds.includes(record.scopeId)) {
        return send(response, 404, { error: 'Daily record not found in the current authorized scope' });
      }
      if (record.status === 'deleted') return send(response, 200, { recordId: record.id, status: 'already_deleted' });
      if (record.scopeId !== null) this.invalidateDailySource?.(record);
      const deleted = this.dailyRecords.deleteRecord(record.id);
      if (!deleted) return send(response, 404, { error: 'Daily record not found' });
      return send(response, 200, { recordId: deleted.id, status: 'deleted' });
    }
    if (route === '/api/personal-reminders/create') {
      const parsed = CreatePersonalReminderSchema.safeParse(body);
      if (!parsed.success) return send(response, 400, { error: 'Invalid personal reminder', issues: parsed.error.issues });
      if (!invocation.chatId || !invocation.botId) return send(response, 403, { error: 'This invocation has no trusted private delivery target' });
      const operationHash = createHash('sha256').update(JSON.stringify([
        invocation.sourceId, parsed.data.relativeDue, parsed.data.content, parsed.data.recordId ?? null,
      ])).digest('hex');
      const reminder = this.dailyRecords.createReminder({
        operationId: `reminder-tool:${operationHash}`,
        content: parsed.data.content,
        relativeDue: parsed.data.relativeDue,
        source,
        ...(parsed.data.recordId ? { recordId: parsed.data.recordId } : {}),
        deliveryTarget: { botId: invocation.botId, chatId: invocation.chatId },
      });
      this.onReminderCreated?.(reminder);
      return send(response, 201, { reminderId: reminder.id, status: reminder.status, dueAt: reminder.dueAt });
    }
    const parsed = SearchDailyRecordsSchema.safeParse(body);
    if (!parsed.success) return send(response, 400, { error: 'Invalid recap range', issues: parsed.error.issues });
    if (parsed.data.spaceId && !invocation.authorizedSpaceIds.includes(parsed.data.spaceId)) return send(response, 403, { error: 'Requested memory space is not authorized for this matter' });
    try {
      const recap = this.dailyRecords.recap({
        from: parsed.data.from,
        through: parsed.data.through,
        ...(parsed.data.spaceId ? { scopeId: parsed.data.spaceId } : {}),
      });
      const authorized = recap.records.filter((record) => record.scopeId === null
        ? invocation.allowUnclassifiedRecords === true
        : invocation.authorizedSpaceIds.includes(record.scopeId));
      return send(response, 200, {
        from: recap.from, through: recap.through,
        records: authorized.slice(-parsed.data.limit).map((record) => ({
          id: record.id, date: record.date, kind: record.kind, content: record.content,
          ...(record.authorView ? { authorView: record.authorView } : {}),
          ...(record.userView ? { userView: record.userView } : {}),
          ...(record.observation ? { observation: record.observation } : {}),
          ...(record.hypothesis ? { hypothesis: record.hypothesis } : {}),
          ...(record.question ? { question: record.question } : {}),
          sourceId: record.source.sourceId, scopeId: record.scopeId,
        })),
      });
    } catch (error) {
      return send(response, 400, { error: (error as Error).message });
    }
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 64_000) throw new Error('Request body exceeds limit');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function hasExplicitDailyDeleteIntent(sourceText: string): boolean {
  const request = /(?:删除|删掉|删去|移除|清除|忘掉|忘记).{0,24}(?:记录|日常|阅读|探索)|(?:记录|日常|阅读|探索).{0,24}(?:删除|删掉|删去|移除|清除|忘掉|忘记)/i;
  const negated = /(?:不要|别|不|无需|不用|勿).{0,6}(?:删除|删掉|删去|移除|清除|忘掉|忘记)/i;
  return request.test(sourceText) && !negated.test(sourceText);
}
