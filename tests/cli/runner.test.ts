import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCli } from '../../src/cli/runner.js';
import type { CliAdapter, CliEvent } from '../../src/cli/types.js';

function adapter(events: CliEvent[]): CliAdapter {
  const script = `for (const event of ${JSON.stringify(events)}) process.stdout.write(JSON.stringify(event) + '\\n')`;
  return {
    id: 'agy', command: process.execPath, displayName: 'test cli',
    buildArgs: () => ['-e', script],
    buildResumeArgs: () => ['-e', script],
    buildCompactPlan: () => { throw new Error('not used'); },
    parseEvents: (line) => [JSON.parse(line) as CliEvent],
  };
}

test('CLI result preserves a count of failed tool calls without leaking their details', { skip: process.platform === 'win32' }, async () => {
  const result = await runCli({
    adapter: adapter([
      { type: 'tool_call', toolUseId: 'tool-use-1', toolName: 'save_memory', input: { content: 'secret' } },
      { type: 'tool_end', toolUseId: 'tool-use-1', failed: true },
      { type: 'result', answer: 'Some work completed.' },
    ]),
    prompt: 'test', cwd: process.cwd(), signal: new AbortController().signal,
  });
  assert.equal(result.answer, 'Some work completed.');
  assert.equal(result.failedToolCalls, 1);
  assert.equal(result.toolCalls, undefined);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('CLI result omits the partial-failure marker when all tool calls succeed', { skip: process.platform === 'win32' }, async () => {
  const result = await runCli({
    adapter: adapter([
      { type: 'tool_call', toolUseId: 'tool-use-2', toolName: 'search', input: {} },
      { type: 'tool_end', toolUseId: 'tool-use-2', failed: false },
      { type: 'result', answer: 'Done.' },
    ]),
    prompt: 'test', cwd: process.cwd(), signal: new AbortController().signal,
  });
  assert.equal(result.answer, 'Done.');
  assert.equal(result.failedToolCalls, undefined);
});
