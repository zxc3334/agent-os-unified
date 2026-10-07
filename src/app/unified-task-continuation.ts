import type { AppRuntime } from './runtime.js';
import { UnifiedTaskRuntime, type UnifiedTaskSource } from './unified-task-runtime.js';

interface RunContinuationTaskOptions<T> {
  runtime: AppRuntime;
  source: Extract<UnifiedTaskSource, 'approval' | 'clarification' | 'comment'>;
  sourceId: string;
  occurredAt: string;
  actorId: string;
  ownerId: string;
  affairId: string;
  /** Metadata only. Never include prompts, answers, or comment text here. */
  input: Record<string, string | number | boolean | null>;
  signal: AbortSignal;
  execute: (signal: AbortSignal) => Promise<T>;
}

/** Run an existing continuation through the shared lifecycle without changing its adapter semantics. */
export async function runContinuationThroughUnifiedTask<T>(
  options: RunContinuationTaskOptions<T>,
): Promise<T> {
  const task = await new UnifiedTaskRuntime<void>({
    store: options.runtime.unifiedTaskStore,
    memoryContext: { prepare: async () => undefined },
    executor: {
      execute: async ({ signal }) => ({
        outcome: 'succeeded',
        result: await options.execute(signal),
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
    authorizedMemorySpaceIds: [],
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
