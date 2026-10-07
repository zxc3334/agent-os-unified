import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Trigger kinds intentionally describe transport/workflow, not authority. */
/** Stable affair IDs deliberately exclude the executing bot/engine identity. */
export function conversationAffairId(chatId: string, threadId: string): string {
  if (!chatId.trim() || !threadId.trim()) throw new Error('chatId and threadId are required for a conversation affair');
  return `conversation:${encodeURIComponent(chatId)}:${encodeURIComponent(threadId)}`;
}

/** Workflow continuations use their trusted durable task ID as the matter identity. */
export function workflowAffairId(taskId: string): string {
  if (!taskId.trim()) throw new Error('taskId is required for a workflow affair');
  return `workflow:${encodeURIComponent(taskId)}`;
}

export type UnifiedTaskSource =
  | 'message'
  | 'schedule'
  | 'collaboration'
  | 'clarification'
  | 'approval'
  | 'comment'
  | (string & {});

export interface TrustedTaskIdentity {
  /** Identity authenticated by the caller; never populated from model output. */
  actorId: string;
  /** Personal-memory owner established by the trusted caller. */
  ownerId: string;
}

export interface UnifiedTaskTrigger {
  source: UnifiedTaskSource;
  sourceId?: string;
  /** Original event time, not the time this runtime happens to process it. */
  occurredAt: string;
}

export interface TaskArtifact {
  id: string;
  kind: string;
  label: string;
  /** Adapter-owned location/URI; the runtime does not interpret it. */
  location?: string;
}

export type UnifiedTaskStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'partially_succeeded'
  | 'failed'
  | 'cancelled';

/** Deliberately content-free milestones suitable for private-safe diagnostics. */
export type UnifiedTaskTraceStage =
  | 'queued'
  | 'context_prepared'
  | 'context_unavailable'
  | 'execution_progress'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * A trace contains opaque identifiers and lifecycle metadata only. In
 * particular it never contains task input, memory text, progress text, result,
 * artifact labels/locations, or exception messages.
 */
export interface UnifiedTaskTraceEvent {
  version: 1;
  taskId: string;
  source: 'message' | 'schedule' | 'collaboration' | 'clarification' | 'approval' | 'comment' | 'other';
  sourceId?: string;
  stage: UnifiedTaskTraceStage;
  timestamp: string;
  artifactIds: string[];
  failureCode?: 'memory_context_unavailable' | 'execution_failed';
}

export type UnifiedTaskTraceSink = (
  event: UnifiedTaskTraceEvent,
) => void | Promise<void>;

/** Durable, user-inspectable record for one execution attempt. */
export interface UnifiedTask {
  id: string;
  trusted: TrustedTaskIdentity;
  affairId: string;
  trigger: UnifiedTaskTrigger;
  authorizedMemorySpaceIds: string[];
  input: unknown;
  status: UnifiedTaskStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  progress?: string;
  result?: unknown;
  artifacts: TaskArtifact[];
  error?: string;
}

export interface UnifiedTaskStore {
  get(id: string): Promise<UnifiedTask | undefined>;
  list(affairId?: string): Promise<UnifiedTask[]>;
  save(task: UnifiedTask): Promise<void>;
}

export interface PrepareTaskMemoryContext {
  actorId: string;
  ownerId: string;
  affairId: string;
  trigger: UnifiedTaskTrigger;
  authorizedMemorySpaceIds: readonly string[];
  input: unknown;
  query?: string;
  signal: AbortSignal;
}

/** The provider must honor only the explicitly supplied authorized spaces. */
export interface TaskMemoryContextProvider<Context = unknown> {
  prepare(request: PrepareTaskMemoryContext): Promise<Context>;
}

export interface ExecuteUnifiedTask<Context = unknown> {
  task: Readonly<UnifiedTask>;
  memoryContext: Context;
  signal: AbortSignal;
  reportProgress(progress: string): Promise<void>;
}

export interface UnifiedTaskExecution {
  outcome: 'succeeded' | 'partial';
  result: unknown;
  artifacts: TaskArtifact[];
}

export interface UnifiedTaskExecutor<Context = unknown> {
  execute(request: ExecuteUnifiedTask<Context>): Promise<UnifiedTaskExecution>;
}

export interface RunUnifiedTaskInput {
  trusted: TrustedTaskIdentity;
  affairId: string;
  trigger: UnifiedTaskTrigger;
  /** Authorization is supplied by trusted application code, never by model output. */
  authorizedMemorySpaceIds: readonly string[];
  input: unknown;
  /** Ephemeral query used for scoped context preparation; never persisted in the task record. */
  memoryQuery?: string;
  signal: AbortSignal;
}

export interface UnifiedTaskRuntimeOptions<Context = unknown> {
  store: UnifiedTaskStore;
  memoryContext: TaskMemoryContextProvider<Context>;
  executor: UnifiedTaskExecutor<Context>;
  now?: () => string;
  id?: () => string;
  /** Best-effort diagnostic sink. Sink failures never change task outcomes. */
  trace?: UnifiedTaskTraceSink;
}

/**
 * Deep execution seam shared by message, schedule, collaboration and continuation
 * callers. It owns task lifecycle, authorization propagation, cancellation and
 * durable outcome reporting; transport and model/CLI details stay in adapters.
 *
 * Ordinary messages, scheduled runs, and approval/clarification/comment
 * continuations adapt existing execution paths through this seam. Collaboration
 * and affair-native-session isolation remain separate integration work. Adapters
 * preserve their existing delivery and native-session behavior; callers derive
 * authority before entering this module, and executor/model output is only stored
 * as result data, never re-read as identity or permission.
 *
 * A run resolves with its final record, including failed/cancelled outcomes.
 * Storage and adapter setup failures are not disguised as task outcomes.
 */
export class UnifiedTaskRuntime<Context = unknown> {
  private readonly now: () => string;
  private readonly id: () => string;

  constructor(private readonly options: UnifiedTaskRuntimeOptions<Context>) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.id = options.id ?? randomUUID;
  }

  async run(
    request: RunUnifiedTaskInput,
    observe?: (task: UnifiedTask) => void,
  ): Promise<UnifiedTask> {
    validateRequest(request);
    const timestamp = this.now();
    let task: UnifiedTask = {
      id: this.id(),
      trusted: { ...request.trusted },
      affairId: request.affairId,
      trigger: { ...request.trigger },
      authorizedMemorySpaceIds: [...new Set(request.authorizedMemorySpaceIds)],
      input: clone(request.input),
      status: 'queued',
      createdAt: timestamp,
      updatedAt: timestamp,
      artifacts: [],
    };

    await this.persist(task, observe);
    await this.trace(task, 'queued');
    if (request.signal.aborted) {
      task = await this.finish(task, 'cancelled', observe);
      await this.trace(task, 'cancelled');
      return clone(task);
    }

    task = { ...task, status: 'running', startedAt: this.now() };
    await this.persist(task, observe);

    let phase: 'context' | 'execution' = 'context';
    try {
      const memoryContext = await this.options.memoryContext.prepare({
        actorId: task.trusted.actorId,
        ownerId: task.trusted.ownerId,
        affairId: task.affairId,
        trigger: clone(task.trigger),
        authorizedMemorySpaceIds: [...task.authorizedMemorySpaceIds],
        input: clone(task.input),
        ...(request.memoryQuery === undefined ? {} : { query: request.memoryQuery }),
        signal: request.signal,
      });
      await this.trace(task, 'context_prepared');
      phase = 'execution';
      if (request.signal.aborted) {
        task = await this.finish(task, 'cancelled', observe);
        await this.trace(task, 'cancelled');
        return clone(task);
      }

      const execution = await this.options.executor.execute({
        task: clone(task),
        memoryContext,
        signal: request.signal,
        reportProgress: async (progress) => {
          if (task.status !== 'running' || request.signal.aborted) return;
          task = { ...task, progress, updatedAt: this.now() };
          await this.persist(task, observe);
          await this.trace(task, 'execution_progress');
        },
      });
      assertExecution(execution);
      task = {
        ...task,
        result: clone(execution.result),
        artifacts: clone(execution.artifacts),
      };
      const status: UnifiedTaskStatus = request.signal.aborted
        ? 'cancelled'
        : execution.outcome === 'partial'
          ? 'partially_succeeded'
          : 'succeeded';
      task = await this.finish(task, status, observe);
      await this.trace(task, status === 'cancelled' ? 'cancelled' : 'completed');
      return clone(task);
    } catch (error) {
      const cancelled = request.signal.aborted || isAbortError(error);
      task = {
        ...task,
        ...(cancelled ? {} : { error: errorMessage(error) }),
      };
      if (!cancelled && phase === 'context') await this.trace(task, 'context_unavailable');
      task = await this.finish(task, cancelled ? 'cancelled' : 'failed', observe);
      if (cancelled) await this.trace(task, 'cancelled');
      else {
        await this.trace(task, 'failed', [], phase === 'context'
          ? 'memory_context_unavailable'
          : 'execution_failed');
      }
      return clone(task);
    }
  }

  get(id: string): Promise<UnifiedTask | undefined> {
    return this.options.store.get(id);
  }

  list(affairId?: string): Promise<UnifiedTask[]> {
    return this.options.store.list(affairId);
  }

  private async finish(
    task: UnifiedTask,
    status: Extract<UnifiedTaskStatus, 'succeeded' | 'partially_succeeded' | 'failed' | 'cancelled'>,
    observe?: (task: UnifiedTask) => void,
  ): Promise<UnifiedTask> {
    const completed = {
      ...task,
      status,
      completedAt: this.now(),
    } satisfies UnifiedTask;
    await this.persist(completed, observe);
    return completed;
  }

  private async persist(
    task: UnifiedTask,
    observe?: (task: UnifiedTask) => void,
  ): Promise<void> {
    const snapshot = clone(task);
    await this.options.store.save(snapshot);
    try {
      observe?.(clone(snapshot));
    } catch {
      // Observers are reporting hooks; they cannot alter task execution truth.
    }
  }

  private async trace(
    task: UnifiedTask,
    stage: UnifiedTaskTraceStage,
    artifactIds: readonly string[] = task.artifacts.map(({ id }) => id),
    failureCode?: UnifiedTaskTraceEvent['failureCode'],
  ): Promise<void> {
    if (!this.options.trace) return;
    const taskId = safeIdentifier(task.id);
    const sourceId = task.trigger.sourceId === undefined
      ? undefined
      : safeIdentifier(task.trigger.sourceId);
    const event: UnifiedTaskTraceEvent = {
      version: 1,
      taskId: taskId ?? 'unavailable',
      source: safeSource(task.trigger.source),
      ...(sourceId === undefined ? {} : { sourceId }),
      stage,
      timestamp: this.now(),
      artifactIds: artifactIds.flatMap((id) => {
        const safe = safeIdentifier(id);
        return safe === undefined ? [] : [safe];
      }),
      ...(failureCode === undefined ? {} : { failureCode }),
    };
    try {
      await this.options.trace(clone(event));
    } catch {
      // Diagnostics are best effort; task state remains authoritative.
    }
  }
}

/** JSON-backed local adapter. Writes are atomic and serialized per instance. */
export class JsonUnifiedTaskStore implements UnifiedTaskStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async get(id: string): Promise<UnifiedTask | undefined> {
    const tasks = await this.load();
    const found = tasks.find((task) => task.id === id);
    return found ? clone(found) : undefined;
  }

  async list(affairId?: string): Promise<UnifiedTask[]> {
    const tasks = await this.load();
    return tasks
      .filter((task) => affairId === undefined || task.affairId === affairId)
      .map(clone);
  }

  save(task: UnifiedTask): Promise<void> {
    const snapshot = clone(task);
    const write = async () => {
      const tasks = await this.load();
      const index = tasks.findIndex((current) => current.id === snapshot.id);
      if (index === -1) tasks.push(snapshot);
      else tasks[index] = snapshot;
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
      const handle = await open(temporaryPath, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(tasks, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(temporaryPath, this.filePath);
        const directoryHandle = await open(dirname(this.filePath), 'r');
        try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
    };
    this.writeQueue = this.writeQueue.then(write, write);
    return this.writeQueue;
  }

  private async load(): Promise<UnifiedTask[]> {
    let content: string;
    try {
      content = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const parsed: unknown = JSON.parse(content);
    if (!Array.isArray(parsed)) throw new Error(`任务文件格式错误: ${this.filePath}`);
    return parsed.map(parseTask);
  }
}

function validateRequest(request: RunUnifiedTaskInput): void {
  if (!request.trusted.actorId.trim() || !request.trusted.ownerId.trim()) {
    throw new Error('trusted actorId and ownerId are required');
  }
  if (!request.affairId.trim()) throw new Error('affairId is required');
  if (!request.trigger.source.trim() || !request.trigger.occurredAt.trim()) {
    throw new Error('trigger source and occurredAt are required');
  }
  if (request.authorizedMemorySpaceIds.some((id) => !id.trim())) {
    throw new Error('authorized memory space IDs must be non-empty');
  }
}

function assertExecution(value: UnifiedTaskExecution): void {
  if (!value || !['succeeded', 'partial'].includes(value.outcome) || !Array.isArray(value.artifacts)) {
    throw new Error('executor returned an invalid task outcome');
  }
  for (const artifact of value.artifacts) {
    if (!artifact || !artifact.id || !artifact.kind || !artifact.label) {
      throw new Error('executor returned an invalid artifact');
    }
  }
}

function parseTask(value: unknown): UnifiedTask {
  if (!value || typeof value !== 'object') throw new Error('任务文件包含无效记录');
  const task = value as UnifiedTask;
  const statuses: UnifiedTaskStatus[] = [
    'queued', 'running', 'succeeded', 'partially_succeeded', 'failed', 'cancelled',
  ];
  if (
    typeof task.id !== 'string' ||
    typeof task.affairId !== 'string' ||
    !statuses.includes(task.status) ||
    !Array.isArray(task.authorizedMemorySpaceIds) ||
    !Array.isArray(task.artifacts)
  ) {
    throw new Error('任务文件包含无效记录');
  }
  return clone(task);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeIdentifier(value: string): string | undefined {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : undefined;
}

function safeSource(value: UnifiedTaskSource): UnifiedTaskTraceEvent['source'] {
  return ['message', 'schedule', 'collaboration', 'clarification', 'approval', 'comment'].includes(value)
    ? value as UnifiedTaskTraceEvent['source']
    : 'other';
}
