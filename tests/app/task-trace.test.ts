import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeMemoryToolCalls } from '../../src/app/task-trace.js';

test('memory tool trace keeps an allowlisted operation summary without inputs or duplicate calls', () => {
  const summary = summarizeMemoryToolCalls([
    { toolUseId: '1', toolName: 'mcp__agent_os__save_personal_memory', input: { content: 'private diary text' } },
    { toolUseId: '2', toolName: 'save_personal_memory', input: { content: 'duplicate private text' } },
    { toolUseId: '3', toolName: 'search_daily_records', input: { query: 'private search terms' } },
    { toolUseId: '4', toolName: 'dispatch_task', input: { prompt: 'sensitive task' } },
    { toolUseId: '5', toolName: 'unknown_private_tool', input: { secret: 'do not record' } },
  ]);
  assert.deepEqual(summary, [
    { tool: 'save_personal_memory', operation: 'write', status: 'attempted' },
    { tool: 'search_daily_records', operation: 'read', status: 'attempted' },
  ]);
  assert.doesNotMatch(JSON.stringify(summary), /private diary|search terms|sensitive task|do not record/);
});
