import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildCareerContext } from '../../src/core/career-context.js';
import { JsonCareerPreparation } from '../../src/core/career-preparation.js';
import { PersonalMemoryStore } from '../../src/core/personal-memory.js';
import { JsonTextMaterialLibrary } from '../../src/core/text-materials.js';

async function withStores(run: (stores: {
  career: JsonCareerPreparation;
  memories: PersonalMemoryStore;
  materials: JsonTextMaterialLibrary;
}) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'career-context-'));
  try {
    await run({
      career: new JsonCareerPreparation(join(directory, 'career.json')),
      memories: new PersonalMemoryStore({ directory: join(directory, 'memory'), ownerId: 'owner' }),
      materials: new JsonTextMaterialLibrary(join(directory, 'materials.json'), 'owner'),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('career context retrieves source-linked project memories only from explicitly authorized spaces', async () => {
  await withStores(async ({ career, memories, materials }) => {
    const project = await memories.createSpace('Project Alpha');
    const privateLife = await memories.createSpace('Private Life');
    const source = { sourceId: 'msg-1', actorId: 'owner', receivedAt: '2026-10-07T12:00:00.000Z', timezone: 'Asia/Shanghai' };
    const authorized = await memories.add({
      spaceId: project.id, kind: 'learning', confidence: 'user_confirmed',
      content: 'Queue retry workflow preserves pending jobs after restart.', source,
    });
    await memories.add({
      spaceId: privateLife.id, kind: 'fact', confidence: 'user_confirmed',
      content: 'Private retry medicine schedule.', source: { ...source, sourceId: 'msg-2' },
    });
    const material = await materials.add({
      operationId: 'alpha-notes', spaceId: project.id, title: 'Project Alpha notes', content: 'Retry workflow uses an idempotent job key.',
      receivedAt: '2026-10-07T12:00:00.000Z',
    });

    const context = await buildCareerContext({
      query: 'retry workflow', authorizedSpaceIds: [project.id], career, memories, materials,
    });
    assert.match(context, new RegExp(`记忆 \\[${authorized.entry.id}\\]`));
    assert.match(context, new RegExp(`资料 \\[${material.id}\\]`));
    assert.match(context, /不能直接成为简历事实/);
    assert.doesNotMatch(context, /Private retry medicine schedule/);
  });
});

test('career context does not trust a retrieval adapter that returns out-of-scope records', async () => {
  await withStores(async ({ career }) => {
    const context = await buildCareerContext({
      query: 'queue', authorizedSpaceIds: ['career'], career,
      memories: {
        search: async () => [{
          id: 'outside-memory', ownerId: 'owner', spaceId: 'life', kind: 'fact', content: 'Private out of scope',
          tags: [], confidence: 'user_confirmed', status: 'active', version: 1, sources: [],
          createdAt: '', updatedAt: '', history: [],
        }],
      } as never,
      materials: {
        search: () => [{ materialId: 'outside-material', title: 'Out of scope', spaceId: 'life', version: 'v1', startLine: 1, endLine: 1, text: 'Private out of scope' }],
        readExcerpt: () => ({ materialId: 'outside-material', title: 'Out of scope', spaceId: 'life', version: 'v1', startLine: 1, endLine: 1, text: 'Private out of scope' }),
      } as never,
    });
    assert.doesNotMatch(context, /Private out of scope/);
  });
});
