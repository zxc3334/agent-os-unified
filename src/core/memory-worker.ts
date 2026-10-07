import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import {
  advanceCursors,
  beginExtractionBatch,
  freezeSourceCandidates,
  markCandidateCommitted,
  type DialogueRecord,
} from './dialogue-store.js';
import {
  bootstrapMemoryIndexIfEmpty,
  calculateNextReview,
  dropMemoryCardEntry,
  listMemoryCardEntries,
  markEntryPass,
  saveMemoryCardEntry,
  type MemoryCardEntry,
} from './memory.js';

export {
  bootstrapMemoryIndexIfEmpty,
  type MemoryCardEntry,
} from './memory.js';

export interface ExtractedMemoryPayload {
  should_record: boolean;
  action?: 'create' | 'update' | 'skip';
  existing_id?: string | null;
  slug?: string;
  topic: string;
  description: string;
  tags?: string[];
  mastery?: number;
  weakness_analysis?: string;
  core_principles?: string;
  review_question?: string;
}

export interface DialogueTurn {
  user: string;
  bot: string;
  timestamp?: string;
}

export class DialogueBuffer {
  private readonly buffers = new Map<string, DialogueTurn[]>();
  private readonly maxTurns: number;

  constructor(maxTurns = 8) {
    this.maxTurns = maxTurns;
  }

  append(key: string, turn: DialogueTurn): void {
    const list = this.buffers.get(key) || [];
    list.push(turn);
    if (list.length > this.maxTurns) {
      list.splice(0, list.length - this.maxTurns);
    }
    this.buffers.set(key, list);
  }

  get(key: string): DialogueTurn[] {
    return [...(this.buffers.get(key) || [])];
  }

  format(key: string): string {
    const list = this.buffers.get(key) || [];
    if (list.length === 0) return '';
    return list
      .map(
        (t, idx) =>
          `[第 ${idx + 1} 轮探讨]\n学员: ${t.user}\n导师/面试官: ${t.bot}`,
      )
      .join('\n\n');
  }

  clear(key: string): void {
    this.buffers.delete(key);
  }
}

export type LLMExtractFunction = (context: {
  userPrompt: string;
  botAnswer: string;
  projectName: string;
  existingSummary: string;
  historyText?: string;
  historyTurnsCount?: number;
}) => Promise<ExtractedMemoryPayload | undefined>;

export interface MemoryWorkerOptions {
  baseDir?: string;
  llmExtractor?: LLMExtractFunction;
}

export interface ExtractTaskContext {
  userPrompt: string;
  botAnswer: string;
  role: string;
  workspaceDir: string;
  /** 归属项目标识，决定记忆写入 data/memories/<project>/ */
  project?: string;
  sessionKey?: string;
  historyText?: string;
  historyTurnsCount?: number;
  cardMessageId?: string;
  bot?: {
    updateCard?: (messageId: string, card: Record<string, unknown>) => Promise<void>;
  };
}

/**
 * 启发式触发门禁：
 * 1. 拦截纯闲聊
 * 2. 识别收敛信号（评定打分标签、总结关键词）
 * 3. 识别多轮累积信号（连续深入交互 3 轮及以上）
 * 4. 兼容单轮自包含长篇解答
 */
export function supportsMemoryExtraction(role: string): boolean {
  const normalized = role.toLocaleLowerCase();
  return ['interviewer', 'tutor', 'general-tutor'].includes(normalized)
    || normalized.includes('tutor')
    || normalized.includes('interviewer');
}

export function shouldExtractMemory(context: {
  userPrompt: string;
  botAnswer: string;
  role: string;
  historyText?: string;
  historyTurnsCount?: number;
}): boolean {
  const { botAnswer, role, historyTurnsCount } = context;
  if (!botAnswer || !supportsMemoryExtraction(role)) return false;

  // 1. 强收敛信号：导师输出自然语言打分评定（例如 [复习评定: 5/5] 或 [评定: 4]）
  if (parseReviewAssessmentFromAnswer(botAnswer) !== undefined) {
    return true;
  }

  // 2. 强收敛信号：包含阶段性总结标志词
  const isSummary = /(?:总结一下|核心结论|归纳一下|总分[:：]|薄弱点[:：]|评定[:：]|结论如下)/i.test(
    botAnswer,
  );
  if (isSummary && botAnswer.length >= 60) {
    return true;
  }

  // 3. 多轮累积收敛信号：当前技术点连续深入交互达到 3 轮及以上
  if (historyTurnsCount && historyTurnsCount >= 3) {
    return true;
  }

  // 4. 单轮自包含长篇解答（字数 >= 80，且非首轮单纯抛出的极简引导题）
  if (botAnswer.length >= 80) {
    const isJustAskingQuestion =
      /[？?]\s*$/.test(botAnswer.trim()) &&
      botAnswer.length < 150 &&
      (!historyTurnsCount || historyTurnsCount <= 1);
    if (!isJustAskingQuestion) {
      return true;
    }
  }

  return false;
}

/**
 * 轻量判重相似度辅助（供本地无 LLM 时的兜底比对）
 */
export function calculateTopicSimilarity(
  existing: { topic: string; description: string; tags: string[] },
  incoming: { topic: string; description: string; tags: string[] },
): number {
  if (!existing || !incoming) return 0;
  if (existing.topic === incoming.topic) return 1.0;
  if (
    existing.topic.includes(incoming.topic) ||
    incoming.topic.includes(existing.topic)
  ) {
    return 0.7;
  }
  const tagsA = new Set(existing.tags.map((t) => t.toLowerCase()));
  const tagsB = new Set((incoming.tags || []).map((t) => t.toLowerCase()));
  const intersection = [...tagsA].filter((x) => tagsB.has(x)).length;
  const union = new Set([...tagsA, ...tagsB]).size;
  return union > 0 ? Number((intersection / union).toFixed(2)) : 0;
}

/**
 * 从导师回复中提取自然语言打分，实现艾宾浩斯复习全自动闭环
 * 匹配示例: [复习评定: 5/5 | 熟练掌握] 或 [复习评定: 4/5]
 */
export function parseReviewAssessmentFromAnswer(botAnswer: string): number | undefined {
  const match = botAnswer.match(/\[(?:复习评定|评定|得分|复习打分)[:：]\s*([0-5])(?:\s*\/\s*5)?/i);
  if (!match || !match[1]) return undefined;
  return Number.parseInt(match[1], 10);
}

/**
 * 默认使用 DeepSeek API 极速抽取结构化记忆
 */
export async function defaultDeepSeekExtractor(context: {
  userPrompt: string;
  botAnswer: string;
  projectName: string;
  existingSummary: string;
  historyText?: string;
  historyTurnsCount?: number;
}): Promise<ExtractedMemoryPayload | undefined> {
  const anthropicBaseUrl =
    process.env.ANTHROPIC_BASE_URL || 'https://api.deepseek.com/anthropic';
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.log('[记忆Worker] 未配置 ANTHROPIC_API_KEY / DEEPSEEK_API_KEY，跳过大模型提取');
    return undefined;
  }

  const model =
    process.env.CLAUDE_MODEL ||
    process.env.ANTHROPIC_MODEL ||
    process.env.DEEPSEEK_MODEL ||
    'deepseek-v4-flash';

  const dialogueContent = context.historyText
    ? context.historyText.slice(0, 6000)
    : `[用户提问/回答]:\n${context.userPrompt.slice(0, 1500)}\n\n[AI 面试官/导师回复]:\n${context.botAnswer.slice(0, 4000)}`;

  const prompt = `你是一位专业的技术学习与架构考核档案分析师。
你的唯一任务是：纵观以下【用户与 AI 面试官/导师的多轮对话推演全记录】，提炼出学员在后台档案中需要维护的【核心技术考点、盲区剖析、核心原理、掌握度打分(1-5)以及艾宾浩斯复习思考题】。

【输入信息】：
- 项目背景：${context.projectName}
- 已有索引目录：
${context.existingSummary || '（暂无）'}
- 对话推演全记录：
---
${dialogueContent}
---

【分析与提取规则】：
1. 纵观全局推演：从学员最初的提问/解答，到导师的逐步引导与追问，再到最终得出的推导结论，提炼出讨论的核心工程技术概念（如：大模型在线推理显存分布与KV Cache、微服务BFF异步聚合与线程池隔离等）。若整段推演无实质硬核技术探讨，输出 "should_record": false。
2. 比对【已有索引目录】：如果该考点已在目录中记录过，action 设为 "update"，existing_id 填写对应 ID；如果是全新技术点，action 设为 "create"。
3. 精准定位技术盲区（weakness_analysis）：分析学员在多轮互动中暴露的初始误区、概念混淆或算错卡壳的地方（若学员表现极其优秀且无盲区，写明已深入掌握该原理）。
4. 提炼核心原理（core_principles）：提炼推导出的标准核心机理与架构依据（包含公式、数据流转或源码设计）。
5. 掌握度打分（1-5）：综合学员在多轮推演中的表现评定。若多次答错或严重混淆评 1 或 2；需导师引导才答出评 3；能主动深入并解释底层原理评 4 或 5。（若导师给出了 [复习评定: X/5]，优先采纳导师的评分）。
6. 考点粒度（中粒度）：必须以【具体工程机制/核心概念/底层原理】为单位，禁止过于宽泛或过于琐碎。
7. 生成一道高度贴合当前技术点且针对学员薄弱处的【艾宾浩斯复习思考题】。
8. 必须严格输出 JSON，不得包含任何 Markdown 格式外壳或解释性文字。

【输出 JSON 格式】：
{
  "should_record": true,
  "action": "create",
  "existing_id": null,
  "slug": "english-slug-keyword",
  "topic": "核心考点分类",
  "description": "一句话考点概要",
  "tags": ["标签1", "标签2"],
  "mastery": 2,
  "weakness_analysis": "学员的技术盲区与混淆点剖析",
  "core_principles": "核心原理解析与标准解答",
  "review_question": "艾宾浩斯复习思考题"
}`;

  try {
    const url = anthropicBaseUrl.endsWith('/v1/messages')
      ? anthropicBaseUrl
      : `${anthropicBaseUrl.replace(/\/$/, '')}/v1/messages`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        system:
          'You are a professional technical evaluation archive analyzer. Output valid JSON only without markdown formatting.',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 4000,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(35000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(`[记忆Worker] 调用模型 API 失败 HTTP ${res.status}:`, errText);
      return undefined;
    }

    const data = (await res.json()) as any;
    const textBlock = data?.content?.find((c: any) => c.type === 'text');
    const thinkingBlock = data?.content?.find((c: any) => c.type === 'thinking');
    const rawText = textBlock?.text || thinkingBlock?.thinking || '';
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error(
        `[记忆Worker] 未能匹配到有效 JSON 内容 (stop_reason: ${data?.stop_reason}):`,
        JSON.stringify(data?.content)?.slice(0, 300),
      );
      return undefined;
    }

    return JSON.parse(jsonMatch[0]) as ExtractedMemoryPayload;
  } catch (error) {
    console.error('[记忆Worker] 提取模型调用异常 (已安全降级):', (error as Error).message);
    return undefined;
  }
}

function normalizeCandidates(
  candidates: ExtractedMemoryPayload | ExtractedMemoryPayload[] | undefined,
): ExtractedMemoryPayload[] {
  if (!candidates) return [];
  return (Array.isArray(candidates) ? candidates : [candidates])
    .filter((candidate) => candidate && candidate.should_record && candidate.action !== 'skip');
}

/**
 * 专职后台记忆提取 Worker
 */
export class MemoryExtractionWorker {
  private readonly baseDir?: string;
  /** 当前任务的项目标识（处理每个任务前设置） */
  private currentProject = 'default';
  private readonly llmExtractor: LLMExtractFunction;
  private readonly queue: ExtractTaskContext[] = [];
  private readonly projectBatchRuns = new Map<string, { promise: Promise<{ batchId: string; completedSources: number; cursor: number } | undefined>; requestedAgain: boolean }>();
  public readonly dialogueBuffer = new DialogueBuffer(8);
  private isProcessing = false;

  constructor(options: MemoryWorkerOptions = {}) {
    this.baseDir = options.baseDir;
    this.llmExtractor = options.llmExtractor || defaultDeepSeekExtractor;
  }

  /**
   * Process the next frozen dialogue batch. Candidate persistence receives a stable
   * operation id and must be idempotent, including the crash window between the
   * side effect and recording its completion marker.
   */
  async processDialogueBatch(
    project: string,
    extract: (record: DialogueRecord) => Promise<ExtractedMemoryPayload | ExtractedMemoryPayload[] | undefined>,
    persist: (candidate: ExtractedMemoryPayload, operationId: string, record: DialogueRecord) => Promise<void>,
  ): Promise<{ batchId: string; completedSources: number; cursor: number } | undefined> {
    const batch = await beginExtractionBatch(project);
    if (!batch) return undefined;

    for (const source of batch.sources) {
      if (source.completed) continue;
      const extraction = source.candidates === undefined
        ? normalizeCandidates(await extract(source.record))
        : source.candidates as ExtractedMemoryPayload[];
      const candidates = await freezeSourceCandidates(batch.id, source.index, extraction);
      const latestBatch = await beginExtractionBatch(project);
      const committedIndexes = new Set(
        latestBatch?.sources.find((item) => item.index === source.index)?.committedCandidateIndexes ?? [],
      );

      for (let index = 0; index < candidates.length; index++) {
        if (committedIndexes.has(index)) continue;
        await persist(candidates[index] as ExtractedMemoryPayload, `${batch.id}:${source.index}:${index}`, source.record);
        await markCandidateCommitted(batch.id, source.index, index);
      }
    }

    const cursors = await advanceCursors([project]);
    return {
      batchId: batch.id,
      completedSources: batch.sources.length,
      cursor: cursors[project] ?? batch.startIndex,
    };
  }

  /**
   * Explicit, retryable project-learning extraction entry point. A missing model
   * result is a failure (not an empty extraction), so it cannot advance the cursor.
   */
  async processProjectDialogueBatch(
    project: string,
  ): Promise<{ batchId: string; completedSources: number; cursor: number } | undefined> {
    const active = this.projectBatchRuns.get(project);
    if (active) {
      active.requestedAgain = true;
      return active.promise;
    }
    const run = { requestedAgain: false } as { promise: Promise<{ batchId: string; completedSources: number; cursor: number } | undefined>; requestedAgain: boolean };
    run.promise = (async () => {
      let result: { batchId: string; completedSources: number; cursor: number } | undefined;
      for (let pass = 0; pass < 2; pass += 1) {
        run.requestedAgain = false;
        result = await this.processProjectDialogueBatchOnce(project);
        if (!run.requestedAgain) break;
      }
      return result;
    })().finally(() => {
      this.projectBatchRuns.delete(project);
    });
    this.projectBatchRuns.set(project, run);
    return run.promise;
  }

  private async processProjectDialogueBatchOnce(
    project: string,
  ): Promise<{ batchId: string; completedSources: number; cursor: number } | undefined> {
    return this.processDialogueBatch(
      project,
      async (record) => {
        const existingEntries = await listMemoryCardEntries(project);
        const existingSummary = existingEntries
          .filter((entry) => entry.status === 'active')
          .slice(0, 40)
          .map((entry) => `- ID: ${entry.id} | 主题: ${entry.topic} | 描述: ${entry.description}`)
          .join('\n');
        const extracted = await this.llmExtractor({
          userPrompt: record.user,
          botAnswer: record.bot,
          projectName: project,
          existingSummary,
        });
        if (!extracted) throw new Error('记忆提取器未能返回结果，批次保留以便重试');
        return extracted;
      },
      async (candidate, operationId, record) => {
        const entries = await listMemoryCardEntries(project);
        const target = candidate.action === 'update' && candidate.existing_id
          ? entries.find((entry) => entry.id === candidate.existing_id)
          : undefined;
        if (candidate.action === 'update' && candidate.existing_id && !target) {
          throw new Error(`待更新的学习记忆不存在：${candidate.existing_id}`);
        }
        const content = {
          topic: candidate.topic || '核心考点',
          description: candidate.description || '',
          tags: Array.isArray(candidate.tags) ? candidate.tags : [],
          weaknessAnalysis: candidate.weakness_analysis || '',
          corePrinciples: candidate.core_principles || '',
          reviewQuestion: candidate.review_question || '',
        };
        if (target) {
          await this.saveEntryAndIndex({
            ...target,
            ...content,
            tags: [...new Set([...target.tags, ...content.tags])],
            mastery: Number.isInteger(candidate.mastery) && Number(candidate.mastery) >= 1 && Number(candidate.mastery) <= 5
              ? Number(candidate.mastery)
              : target.mastery,
            sourceMessageId: record.messageId,
            ...(record.userActorId ? { sourceActorId: record.userActorId } : {}),
            sourceAt: record.at,
          });
          return;
        }
        const operationHash = createHash('sha256').update(operationId).digest('hex').slice(0, 24);
        const occurredAt = new Date(record.at);
        const createdAt = Number.isFinite(occurredAt.getTime()) ? occurredAt.toISOString() : new Date().toISOString();
        const nextReview = calculateNextReview(
          { repetition: 0, mastery: Number(candidate.mastery) || 2, intervalDays: 1 },
          Number(candidate.mastery) || 2,
          new Date(createdAt),
        );
        await this.saveEntryAndIndex({
          id: `mem-extract-${operationHash}`,
          project,
          ...content,
          createdAt,
          nextReviewAt: nextReview.nextReviewAt,
          repetition: 0,
          intervalDays: nextReview.intervalDays,
          mastery: nextReview.mastery,
          status: nextReview.status,
          sourceMessageId: record.messageId,
          ...(record.userActorId ? { sourceActorId: record.userActorId } : {}),
          sourceAt: record.at,
        });
      },
    );
  }

  /**
   * 异步派发记忆提取任务（主会话非阻塞）
   */
  dispatch(task: ExtractTaskContext): void {
    if (task.sessionKey) {
      this.dialogueBuffer.append(task.sessionKey, {
        user: task.userPrompt,
        bot: task.botAnswer,
      });
      if (!task.historyText) {
        task.historyText = this.dialogueBuffer.format(task.sessionKey);
      }
      if (!task.historyTurnsCount) {
        task.historyTurnsCount = this.dialogueBuffer.get(task.sessionKey).length;
      }
    }

    if (!shouldExtractMemory(task)) {
      return;
    }
    this.queue.push(task);
    void this.processNext();
  }

  private async processNext(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;
    const task = this.queue.shift();
    if (!task) {
      this.isProcessing = false;
      return;
    }

    try {
      await this.handleTask(task);
    } catch (error) {
      console.error('[记忆Worker] 提取异常（已安全吸收）:', (error as Error).message);
    } finally {
      this.isProcessing = false;
      if (this.queue.length > 0) {
        void this.processNext();
      }
    }
  }

  private async handleTask(task: ExtractTaskContext): Promise<void> {
    const project = task.project || 'default';
    this.currentProject = project;
    await bootstrapMemoryIndexIfEmpty(project, project);

    // 1. 检查是否是自然语言复习打分闭环
    const reviewScore = parseReviewAssessmentFromAnswer(task.botAnswer);
    if (reviewScore !== undefined) {
      console.log(`[记忆Worker] 捕获到评定打分: ${reviewScore}/5`);
      const progressed = await this.autoProgressLatestReview(reviewScore);
      if (progressed) {
        console.log(`[记忆Worker] 已成功推进已有复习周期`);
        return;
      }
      console.log(`[记忆Worker] 暂无进行中的复习条目，继续作为新知识点沉淀后台记忆`);
    }

    // 2. 知识点沉淀任务（纯后台静默记录，不给前端/飞书推卡片）
    try {
      const existingEntries = await listMemoryCardEntries(project);
      const existingSummary = existingEntries
        .filter((e) => e.status === 'active')
        .slice(0, 20)
        .map((e) => `- ID: ${e.id} | 主题: ${e.topic} | 描述: ${e.description}`)
        .join('\n');

      const projectName = task.project || (task.workspaceDir ? basename(task.workspaceDir) : 'General');
      const extracted = await this.llmExtractor({
        userPrompt: task.userPrompt,
        botAnswer: task.botAnswer,
        projectName,
        existingSummary,
        historyText: task.historyText,
        historyTurnsCount: task.historyTurnsCount,
      });

      if (!extracted || !extracted.should_record || extracted.action === 'skip') {
        console.log('[记忆Worker] 本轮问答无需沉淀记忆，已跳过');
        return;
      }

      if (reviewScore !== undefined) {
        extracted.mastery = reviewScore;
      }

      // 重复性校验与合并：检查是否已有相同考点
      let targetEntry =
        extracted.action === 'update' && extracted.existing_id
          ? existingEntries.find((e) => e.id === extracted.existing_id)
          : undefined;

      if (!targetEntry) {
        targetEntry = existingEntries.find((e) => {
          if (e.status !== 'active') return false;
          return (
            calculateTopicSimilarity(e, {
              topic: extracted.topic,
              description: extracted.description,
              tags: extracted.tags || [],
            }) >= 0.65
          );
        });
      }

      if (targetEntry) {
        // 更新已有考点
        if (
          extracted.mastery !== undefined &&
          extracted.mastery >= 1 &&
          extracted.mastery <= 5
        ) {
          targetEntry.mastery = extracted.mastery;
        }
        if (extracted.weakness_analysis) {
          targetEntry.weaknessAnalysis = extracted.weakness_analysis;
        }
        if (extracted.core_principles) {
          targetEntry.corePrinciples = extracted.core_principles;
        }
        if (extracted.review_question) {
          targetEntry.reviewQuestion = extracted.review_question;
        }
        if (Array.isArray(extracted.tags) && extracted.tags.length > 0) {
          targetEntry.tags = [...new Set([...targetEntry.tags, ...extracted.tags])];
        }
        await this.saveEntryAndIndex(targetEntry);
        console.log(
          `[记忆Worker] 后台已更新已有技术记忆: [${targetEntry.topic}] (${targetEntry.id})`,
        );
        if (task.sessionKey) {
          this.dialogueBuffer.clear(task.sessionKey);
        }
      } else {
        // 创建全新考点
        const dateStr = new Date().toISOString().slice(0, 10);
        const cleanSlug =
          (extracted.slug || 'tech-point')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 30) || 'tech-point';
        const id = `mem-${dateStr}-${cleanSlug}`;

        const newEntry: MemoryCardEntry = {
          id,
          project: projectName,
          topic: extracted.topic || '核心考点',
          description: extracted.description || '',
          tags: Array.isArray(extracted.tags) ? extracted.tags : [],
          createdAt: new Date().toISOString(),
          nextReviewAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          repetition: 0,
          intervalDays: 1,
          mastery: Number(extracted.mastery) || 2,
          status: 'active',
          weaknessAnalysis: extracted.weakness_analysis || '',
          corePrinciples: extracted.core_principles || '',
          reviewQuestion: extracted.review_question || '',
        };

        await this.saveEntryAndIndex(newEntry);
        console.log(
          `[记忆Worker] 后台已录入新技术记忆: [${newEntry.topic}] -> entries/${newEntry.id}.md`,
        );
        if (task.sessionKey) {
          this.dialogueBuffer.clear(task.sessionKey);
        }
      }
    } catch (e) {
      console.error('[记忆Worker] 后台记忆提取失败 (已静默吸收):', (e as Error).message);
    }
  }

  /**
   * 将记忆条目写入 entries/ 并原子更新 MEMORY.md 索引指针
   */
  async saveEntryAndIndex(entry: MemoryCardEntry): Promise<void> {
    await saveMemoryCardEntry(entry, entry.project || 'default');
  }

  /**
   * 标记已掌握并归档
   */
  async markPass(id: string, project = 'default'): Promise<boolean> {
    return markEntryPass(id, project);
  }

  /**
   * 删除某条记忆
   */
  async dropEntry(id: string, project = 'default'): Promise<boolean> {
    return dropMemoryCardEntry(id, project);
  }

  /**
   * 自动推进最近一条复习题目
   */
  private async autoProgressLatestReview(score: number): Promise<boolean> {
    try {
      const entries = await listMemoryCardEntries(this.currentProject);
      const activeEntries = entries.filter((e) => e.status === 'active');
      if (activeEntries.length === 0) return false;

      // 取最近一条待复习条目
      const latest = activeEntries[0];
      const next = calculateNextReview(latest, score, new Date());
      latest.mastery = next.mastery;
      latest.repetition = next.repetition;
      latest.intervalDays = next.intervalDays;
      latest.nextReviewAt = next.nextReviewAt;
      latest.status = next.status;

      await saveMemoryCardEntry(latest, latest.project || this.currentProject);
      return true;
    } catch (e) {
      console.error('[记忆Worker] 推进复习失败:', (e as Error).message);
      return false;
    }
  }
}
