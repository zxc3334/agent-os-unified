import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { memoryRoot, memoryDirForProject } from './memory.js';
/**
 * 选题粗筛（阶段①）：用确定性规则挑出「够格的记忆点」。
 *
 * 只做 A+B+D 的机械判定，不做聚类 —— 聚类需要读懂内容，
 * 交给 bot（阶段②）。这样代码负责不遗漏，bot 负责判断质量。
 */
export interface CandidateMemory {
  id: string;
  project: string;
  topic: string;
  description: string;
  tags: string[];
  mastery: number;
  createdAt: string;
  /** 已发布为哪篇文章（有值则不再提议） */
  publishedAs?: string;
}

export interface TopicCandidate {
  project: string;
  memories: CandidateMemory[];
}

/** A: 掌握度门槛 */
export const MIN_MASTERY = 4;

function frontmatter(content: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([a-zA-Z_]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

function parseTags(raw: string | undefined): string[] {
  if (!raw) return [];
  const m = /^\[(.*)\]$/.exec(raw.trim());
  if (!m) return [];
  return m[1].split(',').map((t) => t.trim()).filter(Boolean);
}

/** B: 有实质的薄弱点记录（不能是占位符或空） */
function hasWeaknessRecord(body: string): boolean {
  const m = /##\s*1[.、]?\s*考点与薄弱点剖析\s*\n+([\s\S]*?)(?=\n##|\s*$)/.exec(body);
  if (!m) return false;
  const text = m[1].trim();
  // 过滤占位符与过短内容
  if (text.length < 40) return false;
  if (/^(x|w|待补充|暂无|无|N\/A)$/i.test(text)) return false;
  return true;
}

/**
 * D: 有用户的真实表达。
 * 记忆是由对话提炼的，正文通常以「学员……」记录实际表现；
 * 这里只做廉价的存在性检查，是否真的可引用交给 bot 判断。
 */
function hasUserVoice(body: string): boolean {
  return /学员|你(?:当时|说|认为|把|误解)|原话/.test(body);
}

/** 扫描所有项目，返回通过 A+B+D 的记忆点，按项目分组。 */
export async function scanCandidates(): Promise<TopicCandidate[]> {
  let projects: string[] = [];
  try {
    const entries = await readdir(join(memoryRoot(), 'memories'), { withFileTypes: true });
    projects = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }

  const result: TopicCandidate[] = [];
  for (const project of projects) {
    const dir = join(memoryDirForProject(project), 'entries');
    let files: string[] = [];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }

    const qualified: CandidateMemory[] = [];
    for (const file of files) {
      const content = await readFile(join(dir, file), 'utf8');
      const fm = frontmatter(content);
      const mastery = Number(fm.mastery ?? 0);
      const body = content.split(/^---$/m).slice(2).join('---');

      if (mastery < MIN_MASTERY) continue;            // A
      if (!hasWeaknessRecord(body)) continue;          // B
      if (!hasUserVoice(body)) continue;               // D
      if (fm.published_as) continue;                   // 已发布过，不再提议

      qualified.push({
        id: fm.id ?? file.replace(/\.md$/, ''),
        project,
        topic: fm.topic ?? file,
        description: fm.description ?? '',
        tags: parseTags(fm.tags),
        mastery,
        createdAt: fm.created_at ?? '',
        publishedAs: fm.published_as,
      });
    }
    if (qualified.length > 0) result.push({ project, memories: qualified });
  }
  return result;
}

/** 给 bot 的提示词：让它对粗筛结果做聚类与可写性判断。 */
export function buildTopicPrompt(candidates: TopicCandidate[]): string {
  const lines = candidates.map((c) => {
    const items = c.memories
      .map((m) => [
        `  - ${m.topic}`,
        `    文件：${join(memoryDirForProject(c.project), 'entries', `${m.id}.md`)}`,
        `    描述：${m.description}`,
        `    标签：${m.tags.join('、')}`,
      ].join('\n'))
      .join('\n');
    return `[项目 ${c.project}] ${c.memories.length} 条\n${items}`;
  }).join('\n\n');

  const detailFile = join(memoryRoot(), 'topics', `${new Date().toISOString().slice(0, 10)}.md`);

  return [
    '以下是按规则粗筛出的「掌握度 >= 4 且踩过坑且有你原话」的记忆点：',
    '',
    lines,
    '',
    '请你阅读这些记忆点的实际内容（**用上面给出的完整绝对路径直接 read**，不要自己去搜索目录），然后判断：',
    '',
    '1. **哪些能聚合成一篇文章**。一篇博客通常需要同一主线下的 2~5 条记忆，',
    '   而不是一条一篇。判断依据是它们能否串成「从问题到结论」的连贯论证，',
    '   而不是仅仅标签重叠。',
    '2. 对每个可写主题，给出**建议主线** —— 一条可论证的路径，',
    '   作为后续和用户深聊的起点。',
    '3. 素材不足的（只有 1 条、或彼此不成主线）明确标注「继续积累」，不要硬凑。',
    '',
    '## 输出方式（重要，分两处写）',
    '',
    `**① 详细分析写入文件**：${detailFile}`,
    '   用 write_to_file 工具写入，内容包含：',
    '   - 每个可写主题的完整判断依据（为什么这几条能串成一篇文章）',
    '   - 每条记忆的关键论点摘要（供后续深聊取用）',
    '   - 不建议成篇的条目的原因',
    '   这份文件是给用户后续深聊时参考的，要写全。',
    '',
    '**② 聊天回复只给摘要，控制在 1500 个汉字以内**：',
    '',
    '  可写主题（按素材充足度排序）',
    '',
    '  1. <主题名>（N 条）',
    '     建议主线：<一句话说明这篇文章要论证什么>',
    '',
    '  2. ...',
    '',
    '  继续积累：<只列条目名，每行一条，不解释>',
    '',
    `  详细分析见 \`data/topics/${new Date().toISOString().slice(0, 10)}.md\``,
    '',
    '**严禁**在聊天回复里复述记忆条目的完整正文，也严禁逐条罗列原始素材 —— ',
    '那些内容属于文件。聊天里只回答「有哪些可写的、该论证什么」。',
  ].join('\n');
}
