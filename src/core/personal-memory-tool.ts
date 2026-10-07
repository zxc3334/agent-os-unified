import { z } from 'zod';

export const RememberPersonalMemorySchema = z.object({
  spaceName: z.string().trim().min(1).max(100),
  kind: z.enum(['fact', 'preference', 'decision', 'opinion', 'event']),
  content: z.string().trim().min(1).max(16_000),
  tags: z.array(z.string().trim().min(1).max(80)).max(32).optional().default([]),
});

export type RememberPersonalMemoryInput = z.infer<typeof RememberPersonalMemorySchema>;

/** Only direct user-language can establish a user-stated record. */
export function confidenceFromTrustedSource(
  kind: RememberPersonalMemoryInput['kind'],
  sourceText: string,
): 'user_stated' | 'inferred' {
  if (kind === 'event' && /(?:今天|昨天|前天|刚才|刚刚|吃了|做了|读了|看了|完成了|我去了)/u.test(sourceText)) {
    return 'user_stated';
  }
  if (kind === 'preference' && /(?:我|我的|以后|请|尽量|不要|不吃|喜欢|讨厌|偏好)/u.test(sourceText)) {
    return 'user_stated';
  }
  if (/(?:记住|记下来|帮我记|存一下|保存一下|留个记录|keep in mind|remember this)/iu.test(sourceText)) {
    return 'user_stated';
  }
  return 'inferred';
}


export const SearchPersonalMemorySchema = z.object({
  query: z.string().trim().min(1).max(2_000),
  limit: z.number().int().min(1).max(5).optional().default(5),
});

export type SearchPersonalMemoryInput = z.infer<typeof SearchPersonalMemorySchema>;
