import type { AppRuntime } from './runtime.js';
import { UnifiedTaskRuntime, type UnifiedTaskSource } from './unified-task-runtime.js';
import { PersonalTaskMemoryProvider, type TaskPersonalMemoryContext } from './personal-task-memory.js';

interface RunContinuationTaskOptions<T> {
  runtime: AppRuntime;
  source: Extract<UnifiedTaskSource, 'approval' | 'clarification' | 'comment'>;
  sourceId: string;
  occurredAt: string;
  actorId: string;
  ownerId: string;
  affairId: string;
  /** Explicit grant from the durable session/matter; absent means no memory access. */
  authorizedMemorySpaceIds?: readonly string[];
  /** Ephemeral text used only to rank within the explicit grant. */
  memoryQuery?: string;
  /** Metadata only. Never include prompts, answers, or comment text here. */
  input: Record<string, string | number | boolean | null>;
  signal: AbortSignal;
  execute: (signal: AbortSignal, memoryContext: TaskPersonalMemoryContext) => Promise<T>;
}

/** Add retrieved memory as bounded background context without changing authority. */
export function withPersonalMemoryContext(prompt: string, context: TaskPersonalMemoryContext): string {
  return context.text ? `${prompt}\n\n${context.text}` : prompt;
}

/** Run an existing continuation through the shared lifecycle without changing its adapter semantics. */
export async function runContinuationThroughUnifiedTask<T>(
  options: RunContinuationTaskOptions<T>,
): Promise<T> {
  const authorizedMemorySpaceIds = [...new Set(options.authorizedMemorySpaceIds ?? [])];
  const task = await new UnifiedTaskRuntime<TaskPersonalMemoryContext>({
    store: options.runtime.unifiedTaskStore,
    memoryContext: new PersonalTaskMemoryProvider({
      store: options.runtime.personalMemoryStore,
      // A non-empty persisted session allowlist is the trusted proof of a
      // matter grant. No allowlist (including legacy sessions) stays empty.
      directMessage: authorizedMemorySpaceIds.length > 0,
    }),
    executor: {
      execute: async ({ signal, memoryContext }) => ({
        outcome: 'succeeded',
        result: await options.execute(signal, memoryContext),
        artifacts: [],
      }),
    },
  }).run({
    trusted: { actorId: options.actorId, ownerId: options.ownerId },
    affairId: options.affairId,
    trigger: {
      source: options.source,
      sourceId: options.sourceId,
      occurredAt: options.occurredAt,
    },
    // Continuations do not gain memory access merely because they resume a flow.
    authorizedMemorySpaceIds,
    ...(options.memoryQuery?.trim() ? { memoryQuery: options.memoryQuery } : {}),
    input: options.input,
    signal: options.signal,
  });

  if (task.status === 'failed') {
    throw new Error(task.error ?? 'Continuation task failed');
  }
  if (task.status === 'cancelled') {
    const error = new Error('Continuation task cancelled');
    error.name = 'AbortError';
    throw error;
  }
  if (task.status === 'partially_succeeded') {
    throw new Error('Continuation task partially succeeded');
  }
  return task.result as T;
}
