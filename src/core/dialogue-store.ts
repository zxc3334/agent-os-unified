/**
 * 对话落盘：每轮对话追加写入 data/dialogues/<project>.jsonl
 *
 * 为什么需要它：记忆提取是定时批处理，它要读的原料必须落盘。
 * 内存里的 DialogueBuffer 只留最近 8 轮、进程重启即丢，不能作为提取依据。
 *
 * 设计要点：
 * - 按 project 分文件（与 data/memories/<project>/ 对齐）
 * - 只追加，不重写 → 崩溃安全
 * - 每条带 messageId 与时间戳 → 提取时可做去重与游标
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { memoryRoot } from './memory.js';

export interface DialogueRecord {
  /** 该轮对话在飞书里的消息 id，用于去重 */
  messageId: string;
  /** 哪个 bot 参与的 */
  botId: string;
  /** 归属项目，决定写入哪个文件 */
  project: string;
  /** 话题 id，用于把同一段讨论串起来 */
  threadId: string;
  /** 用户说了什么 */
  user: string;
  /** bot 回答了什么 */
  bot: string;
  /** ISO 时间戳 */
  at: string;
}

export function dialogueFileForProject(project: string): string {
  const slug = project.trim().replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return join(memoryRoot(), 'dialogues', `${slug || 'default'}.jsonl`);
}

/** 追加一条对话记录。失败不抛错，避免影响主链路。 */
export async function appendDialogue(record: DialogueRecord): Promise<void> {
  const file = dialogueFileForProject(record.project);
  try {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (error) {
    console.warn('[对话落盘] 写入失败（已忽略）:', (error as Error).message);
  }
}

/** 读取某个项目的全部对话记录。 */
export async function readDialogues(project: string): Promise<DialogueRecord[]> {
  const file = dialogueFileForProject(project);
  try {
    const content = await readFile(file, 'utf8');
    return content
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line) as DialogueRecord;
        } catch {
          return undefined;
        }
      })
      .filter((r): r is DialogueRecord => r !== undefined);
  } catch {
    return [];
  }
}

/**
 * 提取游标：记录每个项目已处理到第几条。
 * 提取任务读「游标之后」的新增记录，避免重复提取。
 */
function cursorFile(): string {
  return join(memoryRoot(), 'dialogues', '.cursor.json');
}

export async function readCursor(): Promise<Record<string, number>> {
  try {
    return JSON.parse(await readFile(cursorFile(), 'utf8')) as Record<string, number>;
  } catch {
    return {};
  }
}

export async function writeCursor(cursors: Record<string, number>): Promise<void> {
  const file = cursorFile();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(cursors, null, 2), 'utf8');
}

/** 取出某个项目「游标之后」的新增对话。 */
export async function pendingDialogues(
  project: string,
): Promise<{ records: DialogueRecord[]; startIndex: number }> {
  const all = await readDialogues(project);
  const cursors = await readCursor();
  const start = cursors[project] ?? 0;
  return { records: all.slice(start), startIndex: start };
}

/** 列出所有已有对话文件的项目。 */
export async function listDialogueProjects(): Promise<string[]> {
  const dir = join(memoryRoot(), 'dialogues');
  try {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
      .map((e) => e.name.replace(/\.jsonl$/, ''))
      .sort();
  } catch {
    return [];
  }
}

/**
 * 把指定项目的游标推进到「当前全部条数」。
 *
 * 只在定时提取任务**成功后**调用：
 * - 失败时推进会跳过未处理的对话
 * - 「读了但没值得记的」属于正常完成，也要推进，否则会无限重复读同一批
 */
export async function advanceCursors(projects: string[]): Promise<Record<string, number>> {
  const cursors = await readCursor();
  for (const project of projects) {
    const all = await readDialogues(project);
    cursors[project] = all.length;
  }
  await writeCursor(cursors);
  return cursors;
}
