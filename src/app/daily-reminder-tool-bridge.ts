import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDailyReminderFromTool, type CreateDailyReminderToolInput } from '../core/daily-reminder-tool.js';
import type { DailyRecordSource, JsonDailyRecordsReminders } from '../core/daily-records.js';

export interface TrustedReminderInvocation {
  actorId: string;
  ownerId: string;
  source: DailyRecordSource;
  deliveryTarget: { botId: string; chatId: string };
}
interface Invocation extends TrustedReminderInvocation { token: string }

/** Short-lived trusted-context bridge for creating personal reminders from the MCP process. */
export class DailyReminderToolBridge {
  private readonly invocations = new Map<string, Invocation>();
  private server?: ReturnType<typeof createServer>;
  private boundPort?: number;

  constructor(
    private readonly store: JsonDailyRecordsReminders,
    private readonly schedule: (reminder: NonNullable<ReturnType<JsonDailyRecordsReminders['getReminder']>>) => void = () => undefined,
  ) {}

  async start(port = 0): Promise<number> {
    if (this.server) return this.boundPort!;
    const server = createServer((request, response) => { void this.handle(request, response); });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    this.server = server;
    this.boundPort = (server.address() as AddressInfo).port;
    return this.boundPort;
  }

  issue(invocation: TrustedReminderInvocation): { token: string; release: () => void } {
    if (!this.server) throw new Error('Daily reminder tool bridge is not started');
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
    if (request.method !== 'POST' || request.url !== '/api/daily-reminders/create') return send(response, 404, { error: 'Not found' });
    const token = request.headers['x-daily-reminder-token'];
    const invocation = typeof token === 'string' ? this.invocations.get(token) : undefined;
    if (!invocation) return send(response, 401, { error: 'No active trusted reminder invocation' });
    if (invocation.actorId !== invocation.ownerId) return send(response, 403, { error: 'Only the configured owner may create personal reminders' });

    try {
      const input: unknown = await readJson(request);
      const operationId = `reminder-tool:${createHash('sha256').update(JSON.stringify([invocation.source.sourceId, input])).digest('hex')}`;
      const result = createDailyReminderFromTool(this.store, input, {
        operationId, source: invocation.source, deliveryTarget: invocation.deliveryTarget,
      });
      if (result.status === 'created') {
        const reminder = this.store.getReminder(result.reminderId);
        if (reminder) this.schedule(reminder);
      }
      return send(response, result.status === 'created' ? 201 : 200, result);
    } catch (error) {
      return send(response, 500, { status: 'invalid', code: 'invalid_input', message: `提醒未创建：${(error as Error).message}` });
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
