import { normalizeAppToolName } from '../cli/app-tool-names.js';
import type { CliRunResult } from '../cli/types.js';
import type { TaskMemoryOperation } from './unified-task-runtime.js';

const OPERATION_BY_TOOL: Readonly<Record<string, TaskMemoryOperation['operation']>> = {
  save_memory: 'write',
  save_personal_memory: 'write',
  search_personal_memory: 'read',
  capture_daily_record: 'write',
  search_daily_records: 'read',
  delete_daily_record: 'delete',
  save_career_interview_feedback: 'feedback',
};

/** Keep only recognized memory-related app-tool calls; never retain arguments or text. */
export function summarizeMemoryToolCalls(
  toolCalls: CliRunResult['toolCalls'],
): TaskMemoryOperation[] {
  if (!toolCalls?.length) return [];
  const seen = new Set<string>();
  return toolCalls.flatMap(({ toolName }) => {
    const tool = normalizeAppToolName(toolName);
    const operation = tool ? OPERATION_BY_TOOL[tool] : undefined;
    if (!tool || !operation || seen.has(tool)) return [];
    seen.add(tool);
    return [{ tool, operation, status: 'attempted' as const }];
  });
}
