import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PersonalMemoryStore, PersonalMemorySource } from '../core/personal-memory.js';
import { confidenceFromTrustedSource, RememberPersonalMemorySchema, SearchPersonalMemorySchema } from '../core/personal-memory-tool.js';

export interface TrustedMemoryInvocation {
  actorId: string;
  ownerId: string;
  sourceId: string;
  receivedAt: string;
  timezone: string;
  sourceText: string;
  authorizedSpaceIds: string[];
}

interface Invocation extends TrustedMemoryInvocation { token: string }

/** Short-lived loopback bridge so a tool can report success only after durable save. */
export class PersonalMemoryToolBridge {
  private readonly invocations = new Map<string, Invocation>();
  private server?: ReturnType<typeof createServer>;
  private boundPort?: number;

  constructor(private readonly store: PersonalMemoryStore) {}

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
    if (request.method !== 'POST' || !['/api/personal-memory/remember', '/api/personal-memory/search'].includes(request.url ?? '')) {
      return send(response, 404, { error: 'Not found' });
    }
    const token = request.headers['x-personal-memory-token'];
    const invocation = typeof token === 'string' ? this.invocations.get(token) : undefined;
    if (!invocation) return send(response, 401, { error: 'No active trusted invocation' });

    try {
      const body = await readJson(request);
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
