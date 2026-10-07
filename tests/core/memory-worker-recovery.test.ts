import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  advanceCursors,
  appendDialogue,
  beginExtractionBatch,
  pendingDialogues,
  readCursor,
  type DialogueRecord,
} from '../../src/core/dialogue-store.js';
import { MemoryExtractionWorker, type ExtractedMemoryPayload } from '../../src/core/memory-worker.js';

const originalRoot = process.env.AGENT_OS_DATA_ROOT;

async function withDataRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-extraction-'));
  process.env.AGENT_OS_DATA_ROOT = root;
  try {
    await run(root);
  } finally {
    if (originalRoot === undefined) delete process.env.AGENT_OS_DATA_ROOT;
    else process.env.AGENT_OS_DATA_ROOT = originalRoot;
    await rm(root, { recursive: true, force: true });
  }
}

function record(project: string, messageId: string, user = `question ${messageId}`): DialogueRecord {
  return {
    messageId,
    botId: 'assistant',
    project,
    threadId: `thread-${messageId}`,
    user,
    bot: `answer ${messageId}`,
    at: '2026-10-07T12:00:00.000Z',
  };
}

function candidate(topic: string): ExtractedMemoryPayload {
  return {
    should_record: true,
    action: 'create',
    topic,
    description: `${topic} description`,
  };
}

test('all candidates extracted from a source are persisted', async () => {
  await withDataRoot(async () => {
    await appendDialogue(record('project-a', 'message-1'));
    const saved: string[] = [];
    const worker = new MemoryExtractionWorker();
    const result = await worker.processDialogueBatch(
      'project-a',
      async () => [candidate('topic-one'), candidate('topic-two'), candidate('topic-three')],
      async (item) => { saved.push(item.topic); },
    );

    assert.deepEqual(saved, ['topic-one', 'topic-two', 'topic-three']);
    assert.equal(result?.cursor, 1);
    assert.deepEqual(await pendingDialogues('project-a'), { records: [], startIndex: 1 });
  });
});

test('retry resumes a partial source without repeating committed candidates or skipping remaining ones', async () => {
  await withDataRoot(async () => {
    await appendDialogue(record('project-a', 'message-1'));
    await appendDialogue(record('project-a', 'message-2'));
    const savedOperations: string[] = [];
    const worker = new MemoryExtractionWorker();
    let failed = false;
    const extract = async (source: DialogueRecord) => source.messageId === 'message-1'
      ? [candidate('one'), candidate('two')]
      : [candidate('three')];
    await assert.rejects(() => worker.processDialogueBatch('project-a', extract, async (item, operationId) => {
      if (item.topic === 'three' && !failed) {
        failed = true;
        throw new Error('temporary persistence failure');
      }
      savedOperations.push(`${operationId}:${item.topic}`);
    }), /temporary persistence failure/);
    assert.equal((await readCursor())['project-a'] ?? 0, 1);
    assert.equal((await pendingDialogues('project-a')).records[0]?.messageId, 'message-2');

    const result = await new MemoryExtractionWorker().processDialogueBatch('project-a', extract, async (item, operationId) => {
      savedOperations.push(`${operationId}:${item.topic}`);
    });
    assert.equal(savedOperations.length, 3);
    assert.deepEqual(savedOperations.map((entry) => entry.split(':').at(-1)), ['one', 'two', 'three']);
    assert.equal(new Set(savedOperations.map((entry) => entry.split(':').slice(0, -1).join(':'))).size, 3);
    assert.equal(result?.cursor, 2);
  });
});

test('messages arriving while a frozen batch is processed are deferred to the next batch', async () => {
  await withDataRoot(async () => {
    await appendDialogue(record('project-a', 'message-1'));
    const extracted: string[] = [];
    const worker = new MemoryExtractionWorker();
    await worker.processDialogueBatch('project-a', async (source) => {
      extracted.push(source.messageId);
      await appendDialogue(record('project-a', 'message-2'));
      return [];
    }, async () => assert.fail('empty extraction should not persist candidates'));

    assert.deepEqual(extracted, ['message-1']);
    const nextBatch = await beginExtractionBatch('project-a');
    assert.equal(nextBatch?.startIndex, 1);
    assert.equal(nextBatch?.endIndex, 2);
    assert.equal(nextBatch?.sources[0]?.record.messageId, 'message-2');
  });
});

test('unfinished frozen batch and candidate completion survive worker restart', async () => {
  await withDataRoot(async (root) => {
    await appendDialogue(record('project-a', 'message-1'));
    const firstBatch = await beginExtractionBatch('project-a');
    assert.ok(firstBatch);
    const saved: string[] = [];
    await assert.rejects(() => new MemoryExtractionWorker().processDialogueBatch(
      'project-a',
      async () => [candidate('persisted-one'), candidate('persisted-two')],
      async (item) => {
        if (item.topic === 'persisted-two') throw new Error('stop for restart');
        saved.push(item.topic);
      },
    ), /stop for restart/);
    const stateBeforeRestart = await readFile(join(root, 'dialogues', '.extraction-state.json'), 'utf8');

    const restarted = new MemoryExtractionWorker();
    await restarted.processDialogueBatch('project-a', async () => {
      assert.fail('frozen candidates should be reused after restart');
    }, async (item) => { saved.push(item.topic); });

    assert.equal(JSON.parse(stateBeforeRestart).batches[0].endIndex, 1);
    assert.deepEqual(saved, ['persisted-one', 'persisted-two']);
    assert.equal((await readCursor())['project-a'], 1);
  });
});

test('unrelated schedule completion cannot advance an extraction cursor', async () => {
  await withDataRoot(async () => {
    await appendDialogue(record('project-a', 'message-1'));
    // This is the legacy task-runner completion hook: without an explicitly
    // completed extraction source it must be a no-op, even when called repeatedly.
    await advanceCursors(['project-a']);
    await advanceCursors(['project-a']);
    assert.equal((await readCursor())['project-a'] ?? 0, 0);
    assert.equal((await pendingDialogues('project-a')).records[0]?.messageId, 'message-1');
  });
});
