import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { JsonDailyRecordsReminders } from '../../src/core/daily-records.js';
import {
  dailyRecordSearchProvider,
  personalMemorySearchProvider,
  retrieveBlogSources,
  type BlogSourceCandidate,
  type BlogSourceSearchProvider,
} from '../../src/core/blog-source-retriever.js';
import { PersonalMemoryStore } from '../../src/core/personal-memory.js';

const message = {
  sourceId: 'message-1', actorId: 'owner', receivedAt: '2026-10-07T02:00:00.000Z', timezone: 'Asia/Shanghai',
};

function provider(candidates: BlogSourceCandidate[]): BlogSourceSearchProvider {
  return { async search() { return candidates; } };
}

const emptyProvider: BlogSourceSearchProvider = { async search() { return []; } };

test('retrieves memory, dated records, and distinct reference material only from authorized spaces', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-os-blog-retrieval-'));
  try {
    const memories = new PersonalMemoryStore({ directory: join(directory, 'memory'), ownerId: 'owner' });
    const career = await memories.createSpace('求职');
    const life = await memories.createSpace('生活');
    const memory = await memories.add({
      spaceId: career.id, kind: 'fact', content: '我做过分布式缓存项目', confidence: 'user_confirmed',
      source: message,
    });
    assert.equal(memory.status, 'created');

    const records = new JsonDailyRecordsReminders(join(directory, 'daily.json'));
    const reading = records.createRecord({
      operationId: 'reading-1', kind: 'reading', date: '2026-10-06', scopeId: career.id,
      content: '读了缓存一致性的文章', authorView: '作者认为缓存一致性很难',
      userView: '我认为边界条件比算法更重要', source: message,
    });
    records.createRecord({
      operationId: 'private-life', kind: 'daily', date: '2026-10-07', scopeId: life.id,
      content: '生活中的缓存讨论', source: message,
    });
    const materials = provider([{
      id: 'paper-1', spaceId: career.id, status: 'active', text: '论文引用：缓存失效策略比较'.repeat(20),
      date: '2026-10-01', version: 3, location: 'page 4, paragraph 2',
    }]);

    const result = await retrieveBlogSources({
      memories: personalMemorySearchProvider(memories),
      dailyRecords: dailyRecordSearchProvider(records),
      materials,
    }, {
      query: '缓存', authorizedSpaceIds: [career.id], maxExcerptCharacters: 40,
    });

    assert.deepEqual(result.unavailableKinds, []);
    assert.deepEqual(result.sources.map((source) => source.reference.kind), ['memory', 'daily-record', 'material']);
    assert.ok(result.sources.every((source) => source.reference.spaceId === career.id));
    assert.ok(result.sources.every((source) => source.excerpt.length <= 41));
    const daily = result.sources.find((source) => source.reference.id === reading.id)!;
    assert.equal(daily.provenance.date, '2026-10-06');
    assert.equal(daily.provenance.location, 'daily-record:reading');
    assert.deepEqual(daily.perspectives, {
      authorView: '作者认为缓存一致性很难', userView: '我认为边界条件比算法更重要',
    });
    assert.equal(result.sources[2]?.provenance.version, 3);
    assert.equal(result.sources[2]?.provenance.location, 'page 4, paragraph 2');
    assert.equal(result.sources[2]?.reference.kind, 'material');
    assert.doesNotMatch(JSON.stringify(result.sources[2]), /我认为|作者认为/);

    const noScope = await retrieveBlogSources({
      memories: personalMemorySearchProvider(memories), dailyRecords: dailyRecordSearchProvider(records), materials,
    }, { query: '缓存', authorizedSpaceIds: [] });
    assert.deepEqual(noScope, { sources: [], unavailableKinds: [] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rechecks provider scope and excludes forgotten/deleted/unavailable candidates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-os-blog-revoked-'));
  try {
    const memories = new PersonalMemoryStore({ directory, ownerId: 'owner' });
    const space = await memories.createSpace('求职');
    const added = await memories.add({
      spaceId: space.id, kind: 'fact', content: '缓存项目的旧结论', confidence: 'user_stated', source: message,
    });
    assert.equal(added.status, 'created');
    if (added.status !== 'created') throw new Error('expected memory creation');
    await memories.forget(added.entry.id);

    const result = await retrieveBlogSources({
      memories: personalMemorySearchProvider(memories),
      dailyRecords: provider([
        { id: 'deleted-daily', spaceId: space.id, status: 'deleted', text: '缓存的删除记录' },
        { id: 'cross-space', spaceId: 'not-authorized', status: 'active', text: '缓存的越权记录' },
      ]),
      materials: provider([
        { id: 'forgotten-material', spaceId: space.id, status: 'forgotten', text: '缓存的撤权资料' },
        { id: 'unavailable-material', spaceId: space.id, status: 'unavailable', text: '缓存的不可用资料' },
      ]),
    }, { query: '缓存', authorizedSpaceIds: [space.id] });
    assert.deepEqual(result.sources, []);

    const unavailable = await retrieveBlogSources({
      memories: emptyProvider,
      dailyRecords: { async search() { throw new Error('private backend details'); } },
      materials: emptyProvider,
    }, { query: '缓存', authorizedSpaceIds: [space.id] });
    assert.deepEqual(unavailable, { sources: [], unavailableKinds: ['daily-record'] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('bounds result count and excerpts, omits unscoped daily records, and rejects empty queries', async () => {
  const records = new JsonDailyRecordsReminders();
  records.createRecord({ operationId: 'unscoped', kind: 'daily', date: '2026-10-07', content: '缓存记录', source: message });
  const candidateList = Array.from({ length: 6 }, (_, index) => ({
    id: `material-${index}`, spaceId: 'space-a', status: 'active' as const, text: '缓存'.repeat(100),
  }));
  const result = await retrieveBlogSources({
    memories: emptyProvider, dailyRecords: dailyRecordSearchProvider(records), materials: provider(candidateList),
  }, { query: '缓存', authorizedSpaceIds: ['space-a'], limit: 2, maxExcerptCharacters: 8 });
  assert.equal(result.sources.length, 2);
  assert.ok(result.sources.every((source) => source.excerpt.length === 9));
  await assert.rejects(() => retrieveBlogSources({
    memories: emptyProvider, dailyRecords: emptyProvider, materials: emptyProvider,
  }, { query: '  ', authorizedSpaceIds: ['space-a'] }), /query must not be empty/);
});
