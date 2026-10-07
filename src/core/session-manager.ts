import { randomUUID } from 'node:crypto';
import type { CliId } from '../cli/types.js';
import type { SessionStore } from './session-store.js';

export type SessionStatus = 'creating' | 'active' | 'idle' | 'closed';

export interface Session {
  id: string;
  botId: string;
  threadId: string;
  chatId: string;
  cliId: CliId;
  cliSessionId?: string;
  /** Matter-scoped personal-memory allowlist; undefined means owner-authorized defaults. */
  memorySpaceIds?: string[];
  /** Stable personal affair identity; does not contain an engine-native session ID. */
  affairId?: string;
  workspaceDir: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface MessageAddress {
  messageId: string;
  chatId: string;
  threadId: string;
  rootId: string;
}

export interface ResolvedSession {
  session: Session;
  isNew: boolean;
}

export interface SessionManagerOptions {
  now?: () => Date;
  createId?: () => string;
  store?: SessionStore;
}

const ALLOWED_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  creating: ['active', 'idle', 'closed'],
  active: ['idle', 'closed'],
  idle: ['active', 'closed'],
  closed: [],
};

function topicIdOf(message: MessageAddress): string {
  return message.threadId || message.rootId || message.messageId;
}

function sessionKey(botId: string, chatId: string, threadId: string): string {
  return `${botId}:${chatId}:${threadId}`;
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly store?: SessionStore;

  constructor(options: SessionManagerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.store = options.store;
  }

  static async open(
    options: SessionManagerOptions = {},
  ): Promise<SessionManager> {
    const manager = new SessionManager(options);
    const restored = (await options.store?.load()) ?? [];
    for (const session of restored) {
      manager.sessions.set(
        sessionKey(session.botId, session.chatId, session.threadId),
        session,
      );
    }
    return manager;
  }

  get size(): number {
    return this.sessions.size;
  }

  list(): Session[] {
    return [...this.sessions.values()].map((session) => ({ ...session, memorySpaceIds: session.memorySpaceIds ? [...session.memorySpaceIds] : undefined }));
  }

  get(sessionId: string): Session | undefined {
    return [...this.sessions.values()].find(
      (session) => session.id === sessionId,
    );
  }

  async resolve(
    message: MessageAddress,
    cliId: CliId = 'agy',
    botId = 'default',
    workspaceDir = process.cwd(),
  ): Promise<ResolvedSession> {
    const threadId = topicIdOf(message);
    const key = sessionKey(botId, message.chatId, threadId);
    const existing = this.sessions.get(key);
    if (existing) {
      if (existing.cliId === cliId) return { session: existing, isNew: false };
      if (existing.status === 'active') {
        throw new Error('当前事项仍在执行，不能切换执行引擎');
      }
      const switched = await this.switchCliAdapter(existing, cliId, workspaceDir);
      return { session: switched, isNew: false };
    }

    const now = this.now().toISOString();
    const session: Session = {
      id: this.createId(),
      botId,
      threadId,
      chatId: message.chatId,
      cliId,
      workspaceDir,
      status: 'creating',
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(key, session);
    try {
      await this.persist();
    } catch (error) {
      if (this.sessions.get(key) === session) this.sessions.delete(key);
      throw error;
    }
    return { session, isNew: true };
  }

  async transition(
    sessionId: string,
    nextStatus: SessionStatus,
  ): Promise<Session> {
    const current = this.get(sessionId);
    if (!current) throw new Error(`会话不存在: ${sessionId}`);
    if (!ALLOWED_TRANSITIONS[current.status].includes(nextStatus)) {
      throw new Error(`会话 ${current.status} 不能切换到 ${nextStatus}`);
    }

    const updated: Session = {
      ...current,
      status: nextStatus,
      updatedAt: this.now().toISOString(),
    };
    const key = sessionKey(updated.botId, updated.chatId, updated.threadId);
    this.sessions.set(key, updated);
    try {
      await this.persist();
    } catch (error) {
      if (this.sessions.get(key) === updated) this.sessions.set(key, current);
      throw error;
    }
    return updated;
  }

  async setCliSessionId(
    sessionId: string,
    cliSessionId: string,
  ): Promise<Session> {
    if (!cliSessionId) throw new Error('CLI 会话 ID 不能为空');
    return this.updateCliSelection(sessionId, cliSessionId);
  }

  async clearCliSessionId(sessionId: string): Promise<Session> {
    return this.updateCliSelection(sessionId, undefined);
  }

  private async updateCliSelection(
    sessionId: string,
    cliSessionId: string | undefined,
  ): Promise<Session> {
    const current = this.get(sessionId);
    if (!current) throw new Error(`会话不存在: ${sessionId}`);
    const updated: Session = {
      ...current,
      cliSessionId,
      updatedAt: this.now().toISOString(),
    };
    const key = sessionKey(updated.botId, updated.chatId, updated.threadId);
    this.sessions.set(key, updated);
    try {
      await this.persist();
    } catch (error) {
      if (this.sessions.get(key) === updated) this.sessions.set(key, current);
      throw error;
    }
    return updated;
  }

  async selectAffair(
    sessionId: string,
    affairId: string,
    memorySpaceIds: readonly string[],
  ): Promise<Session> {
    if (!affairId.trim()) throw new Error('事项 ID 不能为空');
    const current = this.get(sessionId);
    if (!current) throw new Error(`会话不存在: ${sessionId}`);
    if (current.status === 'active') throw new Error('当前事项仍在执行，不能切换事项');
    const updated: Session = {
      ...current,
      affairId,
      memorySpaceIds: [...new Set(memorySpaceIds)],
      // Native CLI history belongs to this thread + engine, never to the selected affair.
      cliSessionId: !current.affairId || current.affairId === affairId ? current.cliSessionId : undefined,
      updatedAt: this.now().toISOString(),
    };
    const key = sessionKey(updated.botId, updated.chatId, updated.threadId);
    this.sessions.set(key, updated);
    try { await this.persist(); }
    catch (error) {
      if (this.sessions.get(key) === updated) this.sessions.set(key, current);
      throw error;
    }
    return updated;
  }

  async setAffairId(sessionId: string, affairId: string): Promise<Session> {
    const current = this.get(sessionId);
    if (!current) throw new Error(`会话不存在: ${sessionId}`);
    if (current.affairId === affairId) return current;
    return this.selectAffair(sessionId, affairId, current.memorySpaceIds ?? []);
  }

  async setMemorySpaceIds(
    sessionId: string,
    memorySpaceIds: readonly string[] | undefined,
  ): Promise<Session> {
    const current = this.get(sessionId);
    if (!current) throw new Error(`会话不存在: ${sessionId}`);
    const updated: Session = {
      ...current,
      ...(memorySpaceIds === undefined
        ? { memorySpaceIds: undefined }
        : { memorySpaceIds: [...new Set(memorySpaceIds)] }),
      updatedAt: this.now().toISOString(),
    };
    const key = sessionKey(updated.botId, updated.chatId, updated.threadId);
    this.sessions.set(key, updated);
    try {
      await this.persist();
    } catch (error) {
      if (this.sessions.get(key) === updated) this.sessions.set(key, current);
      throw error;
    }
    return updated;
  }

  async setWorkspaceDir(
    sessionId: string,
    workspaceDir: string,
  ): Promise<Session> {
    const current = this.get(sessionId);
    if (!current) throw new Error(`会话不存在: ${sessionId}`);
    if (!workspaceDir) throw new Error('工作目录不能为空');
    if (current.workspaceDir === workspaceDir) return current;

    const { cliSessionId: _previousCliSessionId, ...rest } = current;
    const updated: Session = {
      ...rest,
      workspaceDir,
      updatedAt: this.now().toISOString(),
    };
    const key = sessionKey(updated.botId, updated.chatId, updated.threadId);
    this.sessions.set(key, updated);
    try {
      await this.persist();
    } catch (error) {
      if (this.sessions.get(key) === updated) this.sessions.set(key, current);
      throw error;
    }
    return updated;
  }


  private async switchCliAdapter(
    current: Session,
    cliId: CliId,
    workspaceDir: string,
  ): Promise<Session> {
    const updated: Session = {
      ...current,
      cliId,
      workspaceDir,
      // Native histories are engine-specific. Keep the Agent OS session/affair,
      // but never pass an old engine's opaque session identifier to another CLI.
      cliSessionId: undefined,
      updatedAt: this.now().toISOString(),
    };
    const key = sessionKey(updated.botId, updated.chatId, updated.threadId);
    this.sessions.set(key, updated);
    try {
      await this.persist();
    } catch (error) {
      if (this.sessions.get(key) === updated) this.sessions.set(key, current);
      throw error;
    }
    return updated;
  }

  private async persist(): Promise<void> {
    await this.store?.save([...this.sessions.values()]);
  }
}
