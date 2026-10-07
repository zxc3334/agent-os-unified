import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeMemoryToolCalls } from '../../src/app/task-trace.js';

test('memory tool trace keeps an allowlisted operation summary without inputs or duplicate calls', () => {
  const summary = summarizeMemoryToolCalls([
    { toolName: 'mcp__agent_os__save_personal_memory', status: 'succeeded' },
    { toolName: 'save_personal_memory', status: 'failed' },
    { toolName: 'search_daily_records', status: 'unknown' },
    { toolName: 'dispatch_task', status: 'succeeded' },
    { toolName: 'unknown_private_tool', status: 'failed' },
  ]);
  assert.deepEqual(summary, [
    { tool: 'save_personal_memory', operation: 'write', status: 'succeeded' },
    { tool: 'save_personal_memory', operation: 'write', status: 'failed' },
    { tool: 'search_daily_records', operation: 'read', status: 'unknown' },
  ]);
  assert.doesNotMatch(JSON.stringify(summary), /private diary|search terms|sensitive task|do not record/);
});
