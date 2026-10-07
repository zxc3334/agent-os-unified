import { z } from 'zod';

/** Feedback distilled from the enabled career-interview workflow, never resume evidence. */
export const SaveCareerInterviewFeedbackSchema = z.object({
  summary: z.string().trim().min(1).max(2_000),
  weakPoint: z.string().trim().min(1).max(2_000),
  locator: z.string().trim().min(1).max(200).optional(),
}).strict();

export type SaveCareerInterviewFeedbackInput = z.infer<typeof SaveCareerInterviewFeedbackSchema>;

/** Deterministic owner-language opt-in gate; model-generated tool calls cannot grant consent. */
export function explicitlyRequestsCareerFeedbackSave(text: string): boolean {
  const normalized = text.normalize('NFKC').toLocaleLowerCase();
  if (/不要|别|不必|无需|不用|不需要|没必要|别给我|不要给我|do not|don't|dont|never/.test(normalized)) return false;
  const saveVerb = '(?:记录|保存|记下|加入|放进|沉淀|save|record|store|add)';
  const subject = '(?:反馈|薄弱点|不足|复习点|复习记录|面试反馈|mock interview feedback|interview feedback|weakness(?:es)?|review points)';
  return new RegExp(`${saveVerb}.{0,12}${subject}|${subject}.{0,12}${saveVerb}`, 'i').test(normalized);
}
