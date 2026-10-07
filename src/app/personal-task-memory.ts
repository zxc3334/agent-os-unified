import type { TaskMemoryContextProvider, PrepareTaskMemoryContext } from './unified-task-runtime.js';
import type { PersonalMemoryStore } from '../core/personal-memory.js';
import { preparePersonalMemoryContext } from '../core/personal-memory-context.js';

export type TaskPersonalMemoryContext =
  | { status: 'ready'; text: string }
  | { status: 'empty' | 'not_authorized'; text: '' }
  | { status: 'unavailable'; text: string };

/** Build private-memory context inside the unified task preparation seam. */
export class PersonalTaskMemoryProvider implements TaskMemoryContextProvider<TaskPersonalMemoryContext> {
  constructor(private readonly options: {
    store?: PersonalMemoryStore;
    directMessage: boolean;
  }) {}

  async prepare(request: PrepareTaskMemoryContext): Promise<TaskPersonalMemoryContext> {
    if (!this.options.store) return { status: 'empty', text: '' };
    // A missing query is not permission to inject a broad/recency-based dump.
    // Likewise an empty allowlist means this caller has no trusted grant.
    if (!request.query?.trim() || request.authorizedMemorySpaceIds.length === 0) {
      return { status: 'empty', text: '' };
    }
    try {
      return await preparePersonalMemoryContext(this.options.store, {
        actorId: request.actorId,
        trustedOwnerId: request.ownerId,
        directMessage: this.options.directMessage,
        query: request.query ?? "",
        authorizedSpaceIds: request.authorizedMemorySpaceIds,
        maxEntries: 5,
        maxCharacters: 3_000,
      });
    } catch (error) {
      console.warn('[个人记忆] 任务上下文读取失败:', (error as Error).message);
      return {
        status: 'unavailable',
        text: '个人记忆查询不可用。凡是依赖个人记录的内容都应明确说明无法核验，不要猜测或补造。',
      };
    }
  }
}
