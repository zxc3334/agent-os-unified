/** 对话落盘与可恢复的逐 source 记忆提取批次。 */
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { memoryRoot } from './memory.js';

export interface DialogueRecord {
  /** 飞书消息 id，用于追踪来源。 */
  messageId: string;
  /** 哪个 bot 参与的。 */
  botId: string;
  /** 归属项目。 */
  project: string;
  /** 话题 id。 */
  threadId: string;
  user: string;
  bot: string;
  /** ISO 时间戳（Feishu 原始事件时间，缺失时使用接收时间）。 */
  at: string;
  /** Authenticated user identity from the Feishu event envelope. */
  userActorId?: string;
}

export function dialogueFileForProject(project: string): string {
  const slug = project.trim().replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return join(memoryRoot(), 'dialogues', `${slug || 'default'}.jsonl`);
}

/** 追加失败不影响主对话链路。 */
export async function appendDialogue(record: DialogueRecord): Promise<void> {
  const file = dialogueFileForProject(record.project);
  try {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (error) {
    console.warn('[对话落盘] 写入失败（已忽略）:', (error as Error).message);
  }
}

export async function readDialogues(project: string): Promise<DialogueRecord[]> {
  let content: string;
  try {
    content = await readFile(dialogueFileForProject(project), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return content.split('\n').flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as DialogueRecord];
    } catch (error) {
      // Never drop a corrupt row: shifting later array indexes could permanently
      // skip that source when the contiguous cursor advances.
      throw new Error(`Invalid dialogue record at ${project}:${index + 1}`, { cause: error });
    }
  });
}

function cursorFile(): string {
  return join(memoryRoot(), 'dialogues', '.cursor.json');
}

function extractionStateFile(): string {
  return join(memoryRoot(), 'dialogues', '.extraction-state.json');
}

export async function readCursor(): Promise<Record<string, number>> {
  let content: string;
  try {
    content = await readFile(cursorFile(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const parsed = JSON.parse(content) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid dialogue cursor: expected an object');
  }
  for (const [project, value] of Object.entries(parsed)) {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw new Error(`Invalid dialogue cursor for project ${project}`);
    }
  }
  return parsed as Record<string, number>;
}

async function persistCursor(cursors: Record<string, number>): Promise<void> {
  const file = cursorFile();
  await mkdir(dirname(file), { recursive: true });
  await atomicWrite(file, JSON.stringify(cursors, null, 2));
}

export async function pendingDialogues(project: string): Promise<{ records: DialogueRecord[]; startIndex: number }> {
  const all = await readDialogues(project);
  const cursors = await readCursor();
  const startIndex = cursors[project] ?? 0;
  return { records: all.slice(startIndex), startIndex };
}

export async function listDialogueProjects(): Promise<string[]> {
  try {
    const { readdir } = await import('node:fs/promises');
    return (await readdir(join(memoryRoot(), 'dialogues'), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => entry.name.replace(/\.jsonl$/, '')).sort();
  } catch {
    return [];
  }
}

export interface ExtractionSource {
  /** Stable source position in the append-only project log. */
  index: number;
  sourceId: string;
  record: DialogueRecord;
  /** Frozen output, written before side effects so retries do not re-extract differently. */
  candidates?: unknown[];
  committedCandidateIndexes: number[];
  completed: boolean;
}

export interface ExtractionBatch {
  id: string;
  project: string;
  startIndex: number;
  endIndex: number;
  sources: ExtractionSource[];
}

interface ExtractionState { batches: ExtractionBatch[] }

let stateQueue: Promise<void> = Promise.resolve();
function withStateLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = stateQueue.then(operation, operation);
  stateQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function readExtractionState(): Promise<ExtractionState> {
  try {
    const state = JSON.parse(await readFile(extractionStateFile(), 'utf8')) as ExtractionState;
    if (!state || !Array.isArray(state.batches)) throw new Error('Invalid extraction state: batches must be an array');
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { batches: [] };
    throw error;
  }
}

async function writeExtractionState(state: ExtractionState): Promise<void> {
  const file = extractionStateFile();
  await mkdir(dirname(file), { recursive: true });
  await atomicWrite(file, JSON.stringify(state, null, 2));
}

async function atomicWrite(file: string, content: string): Promise<void> {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, content, 'utf8');
    await rename(temp, file);
  } catch (error) {
    const { unlink } = await import('node:fs/promises');
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

function cloneBatch(batch: ExtractionBatch): ExtractionBatch {
  return structuredClone(batch);
}

/**
 * Freeze the current pending high-water mark. An unfinished batch is returned as-is
 * after restart; messages appended later are necessarily outside its endIndex.
 */
export async function beginExtractionBatch(project: string): Promise<ExtractionBatch | undefined> {
  await advanceCursors([project]);
  return withStateLock(async () => {
    const state = await readExtractionState();
    const unfinished = state.batches.find((batch) => batch.project === project && batch.sources.some((source) => !source.completed));
    if (unfinished) return cloneBatch(unfinished);

    const all = await readDialogues(project);
    const cursors = await readCursor();
    const startIndex = cursors[project] ?? 0;
    if (startIndex >= all.length) return undefined;
    const endIndex = all.length;
    const sources: ExtractionSource[] = all.slice(startIndex, endIndex).map((record, offset) => ({
      index: startIndex + offset,
      sourceId: record.messageId || `${project}:${startIndex + offset}`,
      record,
      committedCandidateIndexes: [],
      completed: false,
    }));
    const batch: ExtractionBatch = {
      id: `${encodeURIComponent(project)}:${startIndex}:${endIndex}`,
      project,
      startIndex,
      endIndex,
      sources,
    };
    state.batches.push(batch);
    await writeExtractionState(state);
    return cloneBatch(batch);
  });
}

export async function freezeSourceCandidates(
  batchId: string,
  sourceIndex: number,
  candidates: unknown[],
): Promise<unknown[]> {
  return withStateLock(async () => {
    const state = await readExtractionState();
    const source = findSource(state, batchId, sourceIndex);
    if (source.candidates === undefined) {
      source.candidates = structuredClone(candidates);
      if (source.candidates.length === 0) source.completed = true;
      await writeExtractionState(state);
    }
    return structuredClone(source.candidates);
  });
}

export async function markCandidateCommitted(batchId: string, sourceIndex: number, candidateIndex: number): Promise<void> {
  return withStateLock(async () => {
    const state = await readExtractionState();
    const source = findSource(state, batchId, sourceIndex);
    if (!source.candidates || candidateIndex < 0 || candidateIndex >= source.candidates.length) {
      throw new Error(`Unknown candidate ${candidateIndex} for source ${sourceIndex}`);
    }
    if (!source.committedCandidateIndexes.includes(candidateIndex)) {
      source.committedCandidateIndexes.push(candidateIndex);
      source.committedCandidateIndexes.sort((a, b) => a - b);
    }
    source.completed = source.committedCandidateIndexes.length === source.candidates.length;
    await writeExtractionState(state);
  });
}

function findSource(state: ExtractionState, batchId: string, sourceIndex: number): ExtractionSource {
  const batch = state.batches.find((item) => item.id === batchId);
  const source = batch?.sources.find((item) => item.index === sourceIndex);
  if (!source) throw new Error(`Unknown extraction source ${batchId}/${sourceIndex}`);
  return source;
}

/**
 * Advance only to the first gap in individually completed extraction sources.
 * The legacy scheduled-task call is harmless unless an extraction batch actually
 * completed those source positions; reminders and other plans cannot skip work.
 */
export async function advanceCursors(projects: string[]): Promise<Record<string, number>> {
  return withStateLock(async () => {
    const cursors = await readCursor();
    const state = await readExtractionState();
    let changed = false;
    for (const project of projects) {
      let cursor = cursors[project] ?? 0;
      const completed = new Set(state.batches
        .filter((batch) => batch.project === project)
        .flatMap((batch) => batch.sources.filter((source) => source.completed).map((source) => source.index)));
      while (completed.has(cursor)) cursor++;
      if (cursor !== (cursors[project] ?? 0)) {
        cursors[project] = cursor;
        changed = true;
      }
    }
    if (changed) await persistCursor(cursors);
    return cursors;
  });
}
