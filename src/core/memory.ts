import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * 记忆库根目录。默认取环境变量 AGENT_OS_DATA_ROOT；未设置时回退到 cwd/data。
 * 多个 Agent OS 实例共享同一个记忆库时，用它把路径固定住。
 */
export function memoryRoot(): string {
  const envRoot = process.env.AGENT_OS_DATA_ROOT?.trim();
  return envRoot ? resolve(envRoot) : resolve(process.cwd(), 'data');
}

/**
 * 某个项目的记忆目录：<dataRoot>/memories/<project>/
 * 每个项目一个独立库，各带自己的 MEMORY.md 与 entries/。
 */
export function memoryDirForProject(project: string): string {
  const slug = project.trim().replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return join(memoryRoot(), 'memories', slug || 'default');
}

export interface MemoryCardEntry {
  id: string;
  project: string;
  topic: string;
  description: string;
  tags: string[];
  createdAt: string;
  nextReviewAt: string;
  repetition: number;
  intervalDays: number;
  mastery: number; // 1 - 5
  status: 'active' | 'mastered' | 'archived';
  weaknessAnalysis: string;
  corePrinciples: string;
  reviewQuestion: string;
  /** Source event used for an extracted card; absent on legacy/imported cards. */
  sourceMessageId?: string;
  sourceActorId?: string;
  sourceAt?: string;
}

export const REVIEW_INTERVALS = [1, 3, 7, 15] as const;

/**
 * 艾宾浩斯复习算法（经典固定阶梯: 1天 -> 3天 -> 7天 -> 15天 -> 掌握归档）
 * 告别复杂的浮点衰减因子，贴合技术面试冲刺周期
 */
export function calculateNextReview(
  item: { repetition: number; mastery: number; intervalDays: number },
  quality: number,
  now: Date = new Date(),
): {
  repetition: number;
  mastery: number;
  intervalDays: number;
  nextReviewAt: string;
  status: 'active' | 'mastered';
} {
  const q = Math.max(0, Math.min(5, Math.round(quality)));

  if (q < 3) {
    // 考核未通过，轮次归零，次日再复习
    return {
      repetition: 0,
      mastery: q,
      intervalDays: 1,
      nextReviewAt: new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000).toISOString(),
      status: 'active',
    };
  }

  const nextRep = item.repetition + 1;
  const isMastered = nextRep >= REVIEW_INTERVALS.length || (q === 5 && nextRep >= 3);
  const intervalDays = isMastered ? 30 : REVIEW_INTERVALS[nextRep] ?? 15;
  const nextReviewAt = new Date(
    now.getTime() + intervalDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  return {
    repetition: nextRep,
    mastery: q,
    intervalDays,
    nextReviewAt,
    status: isMastered ? 'mastered' : 'active',
  };
}

export function serializeMemoryCard(entry: MemoryCardEntry): string {
  return [
    '---',
    `id: ${entry.id}`,
    `project: ${entry.project}`,
    `topic: ${entry.topic}`,
    `description: ${entry.description}`,
    `tags: [${entry.tags.join(', ')}]`,
    `created_at: ${entry.createdAt}`,
    ...(entry.sourceMessageId ? [`source_message_id: ${JSON.stringify(entry.sourceMessageId)}`] : []),
    ...(entry.sourceActorId ? [`source_actor_id: ${JSON.stringify(entry.sourceActorId)}`] : []),
    ...(entry.sourceAt ? [`source_at: ${entry.sourceAt}`] : []),
    `next_review_at: ${entry.nextReviewAt}`,
    `repetition: ${entry.repetition}`,
    `interval_days: ${entry.intervalDays}`,
    `mastery: ${entry.mastery}`,
    `status: ${entry.status}`,
    '---',
    '',
    `# ${entry.topic}：${entry.description}`,
    '',
    '## 1. 考点与薄弱点剖析',
    entry.weaknessAnalysis,
    '',
    '## 2. 核心原理与标准解答',
    entry.corePrinciples,
    '',
    '## 3. 艾宾浩斯复习思考题',
    `- **复习题目**：${entry.reviewQuestion}`,
    '',
  ].join('\n');
}


function parseYamlJsonString(value: string): string {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'string' ? parsed : value;
  } catch {
    return value;
  }
}

export function parseMemoryCard(content: string): MemoryCardEntry | undefined {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return undefined;
  const yamlBlock = match[1];
  const body = match[2];

  const getField = (key: string): string => {
    const m = yamlBlock.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
    return m ? m[1].trim() : '';
  };

  const id = getField('id');
  if (!id) return undefined;

  const tagsRaw = getField('tags');
  const tags = tagsRaw
    ? tagsRaw
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    : [];

  const weaknessMatch = body.match(/## 1\. 考点与薄弱点剖析\r?\n([\s\S]*?)(?=\r?\n## 2\.|$)/);
  const principlesMatch = body.match(/## 2\. 核心原理与标准解答\r?\n([\s\S]*?)(?=\r?\n## 3\.|$)/);
  const questionMatch = body.match(/-\s+\*\*复习题目\*\*[:：]\s*([\s\S]*?)(?=\r?\n##|$)/);

  return {
    id,
    project: getField('project') || 'default',
    topic: getField('topic') || '未命名考点',
    description: getField('description') || '',
    tags,
    createdAt: getField('created_at') || new Date().toISOString(),
    nextReviewAt: getField('next_review_at') || new Date().toISOString(),
    repetition: Number.parseInt(getField('repetition'), 10) || 0,
    intervalDays: Number.parseInt(getField('interval_days'), 10) || 1,
    mastery: Number.parseInt(getField('mastery'), 10) || 1,
    status: (getField('status') as MemoryCardEntry['status']) || 'active',
    weaknessAnalysis: weaknessMatch ? weaknessMatch[1].trim() : '',
    corePrinciples: principlesMatch ? principlesMatch[1].trim() : '',
    reviewQuestion: questionMatch ? questionMatch[1].trim() : '',
    ...(getField('source_message_id') ? { sourceMessageId: parseYamlJsonString(getField('source_message_id')) } : {}),
    ...(getField('source_actor_id') ? { sourceActorId: parseYamlJsonString(getField('source_actor_id')) } : {}),
    ...(getField('source_at') ? { sourceAt: getField('source_at') } : {}),
  };
}

/**
 * 记忆库冷启动：若 MEMORY.md 不存在，初始化标准双层索引骨架
 */
export async function bootstrapMemoryIndexIfEmpty(
  project = 'default',
  projectName = 'Global Project',
): Promise<string> {
  const indexFilePath = join(memoryDirForProject(project), 'MEMORY.md');
  try {
    await readFile(indexFilePath, 'utf8');
    return indexFilePath;
  } catch {
    const memoryDir = join(indexFilePath, '..');
    const entriesDir = join(memoryDir, 'entries');
    await mkdir(entriesDir, { recursive: true });

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const skeleton = [
      `# 全局学习与复习记忆索引 (Global Memory Index)`,
      `> 关联项目: \`${projectName}\``,
      `> 初始化时间: ${now}`,
      '',
      `## 待复习队列 (Review Queue)`,
      `<!-- 格式: - [YYYY-MM-DD][分类] [标题](./entries/文件名.md) | 掌握度:X/5 | 轮次:R | 下次复习:YYYY-MM-DD -->`,
      '',
      `## 已掌握/归档 (Archived)`,
      '',
    ].join('\n');

    await writeFile(indexFilePath, skeleton, 'utf8');
    return indexFilePath;
  }
}

/**
 * 将一条记忆卡片保存至 entries/ 并更新 MEMORY.md 索引指针 (保证不超过 200 行)
 */
export async function saveMemoryCardEntry(
  entry: MemoryCardEntry,
  project = entry.project || 'default',
): Promise<void> {
  const memoryDir = memoryDirForProject(project);
  const entriesDir = join(memoryDir, 'entries');
  await mkdir(entriesDir, { recursive: true });

  // 1. 写入独立的 Markdown 卡片
  const entryPath = join(entriesDir, `${entry.id}.md`);
  await writeFile(entryPath, serializeMemoryCard(entry), 'utf8');

  // 2. 更新 MEMORY.md 索引指针
  await bootstrapMemoryIndexIfEmpty(project, entry.project);
  const indexFilePath = join(memoryDir, 'MEMORY.md');
  const content = await readFile(indexFilePath, 'utf8').catch(() => '');
  const lines = content.split('\n');

  const dateStr = entry.createdAt.slice(0, 10);
  const nextDateStr = entry.nextReviewAt.slice(0, 10);
  const isMastered = entry.status === 'mastered';
  const statusStr = isMastered ? '已彻底掌握并归档' : `下次复习: ${nextDateStr}`;
  const pointerLine = `- [${dateStr}][${entry.topic}] [${entry.description}](./entries/${entry.id}.md) | 掌握度: ${entry.mastery}/5 | 轮次: ${entry.repetition} | ${statusStr}`;

  // 先剔除已有同一 ID 行
  const filtered = lines.filter((l) => !l.includes(entry.id));

  // 根据状态插入对应区块
  const targetHeader = isMastered ? '## 已掌握/归档 (Archived)' : '## 待复习队列 (Review Queue)';
  const headerIndex = filtered.findIndex((l) => l.includes(targetHeader));
  if (headerIndex !== -1) {
    filtered.splice(headerIndex + 2, 0, pointerLine);
  } else {
    filtered.push(pointerLine);
  }

  // 滚动淘汰控制在 200 行内
  if (filtered.length > 200) {
    const archiveHeader = filtered.findIndex((l) => l.includes('## 已掌握/归档'));
    if (archiveHeader !== -1 && filtered.length > archiveHeader + 5) {
      filtered.splice(archiveHeader + 5, filtered.length - 200);
    }
  }

  await writeFile(indexFilePath, filtered.join('\n'), 'utf8');
}

/**
 * 加载单张记忆卡片
 */
export async function loadMemoryCardEntry(
  id: string,
  project = 'default',
): Promise<MemoryCardEntry | undefined> {
  const entryPath = join(memoryDirForProject(project), 'entries', `${id}.md`);
  try {
    const content = await readFile(entryPath, 'utf8');
    return parseMemoryCard(content);
  } catch {
    return undefined;
  }
}

/**
 * 列出记忆库下已有的所有项目标识（即 memories/ 下的子目录名）。
 */
export async function listMemoryProjects(): Promise<string[]> {
  const dir = join(memoryRoot(), 'memories');
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * 遍历所有记忆卡片
 */
export async function listMemoryCardEntries(
  project = 'default',
): Promise<MemoryCardEntry[]> {
  const entriesDir = join(memoryDirForProject(project), 'entries');
  try {
    const files = await readdir(entriesDir);
    const entries: MemoryCardEntry[] = [];
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const content = await readFile(join(entriesDir, file), 'utf8');
      const entry = parseMemoryCard(content);
      if (entry) entries.push(entry);
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * 标记记忆卡片为彻底掌握并移入归档区
 */
export async function markEntryPass(
  id: string,
  project = 'default',
): Promise<boolean> {
  const entry = await loadMemoryCardEntry(id, project);
  if (!entry) return false;
  entry.mastery = 5;
  entry.status = 'mastered';
  await saveMemoryCardEntry(entry, project);
  return true;
}

/**
 * 删除某条记忆卡片及索引
 */
export async function dropMemoryCardEntry(
  id: string,
  project = 'default',
): Promise<boolean> {
  const dir = memoryDirForProject(project);
  const entryPath = join(dir, 'entries', `${id}.md`);
  const indexPath = join(dir, 'MEMORY.md');
  await unlink(entryPath).catch(() => undefined);
  try {
    const content = await readFile(indexPath, 'utf8');
    const filtered = content.split('\n').filter((l) => !l.includes(id));
    await writeFile(indexPath, filtered.join('\n'), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 直接将 MEMORY.md（<= 200行）注入 Prompt 上下文
 */
export async function formatMemoryPromptContext(
  project = 'default',
): Promise<string | undefined> {
  const indexPath = join(memoryDirForProject(project), 'MEMORY.md');
  try {
    const content = await readFile(indexPath, 'utf8');
    const trimmed = content.trim();
    if (!trimmed) return undefined;
    return `【学员技术记忆与薄弱点索引 (MEMORY.md)】\n${trimmed}\n（注：请结合上述薄弱点与复习轮次，在提问或解答时有针对性地强化对应考点）`;
  } catch {
    return undefined;
  }
}
