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

/** Keep only recognized memory-related tool names and terminal status; discard inputs and outputs. */
export function summarizeMemoryToolCalls(
  outcomes: CliRunResult['toolOutcomes'],
): TaskMemoryOperation[] {
  if (!outcomes?.length) return [];
  const seen = new Set<string>();
  return outcomes.flatMap(({ toolName, status }) => {
    const tool = normalizeAppToolName(toolName);
    const operation = tool ? OPERATION_BY_TOOL[tool] : undefined;
    const key = `${tool}:${status}`;
    if (!tool || !operation || seen.has(key)) return [];
    seen.add(key);
    return [{ tool, operation, status }];
  });
}
