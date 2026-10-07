import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SaveCareerInterviewFeedbackSchema } from '../core/career-feedback-tool.js';
import type { JsonCareerPreparation } from '../core/career-preparation.js';

export interface TrustedCareerFeedbackInvocation {
  actorId: string;
  ownerId: string;
  sourceId: string;
  receivedAt: string;
  resumeVersionId: string;
}
interface Invocation extends TrustedCareerFeedbackInvocation { token: string; consumed: boolean }

/** Loopback-only, short-lived bridge for owner-authorized interview feedback persistence. */
export class CareerFeedbackToolBridge {
  private readonly invocations = new Map<string, Invocation>();
  private server?: ReturnType<typeof createServer>;
  private boundPort?: number;

  constructor(private readonly career: JsonCareerPreparation) {}

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

  issue(invocation: TrustedCareerFeedbackInvocation): { token: string; release: () => void } {
    if (!this.server) throw new Error('Career feedback tool bridge is not started');
    const token = randomUUID();
    this.invocations.set(token, { ...invocation, token, consumed: false });
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
    if (request.method !== 'POST' || request.url !== '/api/career/interview-feedback') return send(response, 404, { error: 'Not found' });
    const token = request.headers['x-career-feedback-token'];
    const invocation = typeof token === 'string' ? this.invocations.get(token) : undefined;
    if (!invocation) return send(response, 401, { error: 'No active trusted career-feedback invocation' });
    if (invocation.actorId !== invocation.ownerId) return send(response, 403, { error: 'Only the configured owner may save career interview feedback' });
    if (invocation.consumed) return send(response, 409, { error: 'This career feedback invocation was already used' });
    invocation.consumed = true;

    try {
      const input: unknown = await readJson(request);
      const parsed = SaveCareerInterviewFeedbackSchema.safeParse(input);
      if (!parsed.success) return send(response, 400, { error: 'Invalid career feedback', issues: parsed.error.issues });
      const result = await this.career.recordMockInterview({
        resumeVersionId: invocation.resumeVersionId,
        feedback: [{
          summary: parsed.data.summary,
          weakPoint: parsed.data.weakPoint,
          source: { kind: 'mock-interview', id: invocation.sourceId, ...(parsed.data.locator ? { locator: parsed.data.locator } : {}) },
        }],
        recordedAt: invocation.receivedAt,
      });
      const record = result.learningRecords[0]!;
      this.invocations.delete(invocation.token);
      return send(response, 201, {
        status: 'saved', interviewId: result.interview.id, learningRecordId: record.id,
        reviewStatus: record.reviewStatus, assessmentType: record.assessmentType,
      });
    } catch (error) {
      invocation.consumed = false;
      return send(response, 400, { error: `Career feedback was not saved: ${(error as Error).message}` });
    }
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 16_000) throw new Error('Request body exceeds limit');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}
function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}
