import { z } from 'zod';

const id = z.string().trim().min(1).max(300);
const content = z.string().trim().min(1).max(16_000);

export const CaptureDailyRecordSchema = z.object({
  kind: z.enum(['daily', 'reading', 'exploration']),
  content,
  spaceId: id.optional(),
  authorView: content.optional(),
  userView: content.optional(),
  observation: content.optional(),
  hypothesis: content.optional(),
  question: content.optional(),
}).strict();

export const CreatePersonalReminderSchema = z.object({
  content,
  relativeDue: z.string().trim().min(1).max(200),
  recordId: id.optional(),
}).strict();

export const SearchDailyRecordsSchema = z.object({
  from: z.string().regex(/^\d{4}-\d\d-\d\d$/),
  through: z.string().regex(/^\d{4}-\d\d-\d\d$/),
  spaceId: id.optional(),
  limit: z.number().int().min(1).max(30).optional().default(10),
}).strict();

export const DeleteDailyRecordSchema = z.object({ recordId: id }).strict();
