import { z } from 'zod';

/**
 * 记忆提取的提交结构。
 *
 * 设计原则（沿用面试项目的 SPEC-002）：模型只负责提炼结构化信息，
 * 文件落盘、frontmatter 拼接、MEMORY.md 索引维护全部由 TypeScript 代码执行，
 * 避免模型幻觉损坏索引文件。
 */
export const SaveMemorySchema = z.object({
  /** 归属项目，决定写入 data/memories/<project>/ */
  project: z.string().trim().min(1).max(64),
  /** 考点主题，一条记忆一个主题 */
  topic: z.string().trim().min(1).max(200),
  /** 一句话描述 */
  description: z.string().trim().min(1).max(600),
  /** 标签 */
  tags: z.array(z.string().trim().min(1).max(64)).max(30).optional().default([]),
  /** 掌握度 1-5：1 完全不懂 2 有盲区 3 基本掌握 4 熟练 5 透彻 */
  mastery: z.number().int().min(1).max(5),
  /** 学员哪里没搞懂 */
  weaknessAnalysis: z.string().trim().min(1).max(4000),
  /** 正确原理与标准解答 */
  corePrinciples: z.string().trim().min(1).max(8000),
  /** 艾宾浩斯复习思考题 */
  reviewQuestion: z.string().trim().min(1).max(2000),
  /**
   * create 新建；update 更新已有（需同时给 existingId）。
   * 判断不确定时用 create。
   */
  action: z.enum(['create', 'update']).optional().default('create'),
  /** action=update 时必填 */
  existingId: z.string().trim().min(1).max(120).optional(),
});

export type SaveMemoryRequest = z.infer<typeof SaveMemorySchema>;

/**
 * 从工具调用里找出 save_memory 请求。
 * 与 findApprovalRequest 等同构：取最后一次成功解析的调用。
 */
export function findSaveMemoryRequest(
  toolCalls: Array<{ toolName: string; input: unknown }> | undefined,
): SaveMemoryRequest | undefined {
  for (let index = (toolCalls?.length ?? 0) - 1; index >= 0; index -= 1) {
    const call = toolCalls?.[index];
    if (call?.toolName !== 'save_memory') continue;
    const parsed = SaveMemorySchema.safeParse(call.input);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}
