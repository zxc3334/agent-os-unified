import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { JsonTextMaterialLibrary } from '../../src/core/text-materials.js';

async function withLibrary(run: (library: JsonTextMaterialLibrary, file: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-os-text-materials-'));
  const file = join(dir, 'materials.json');
  try { await run(new JsonTextMaterialLibrary(file, 'owner'), file); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test('text materials return line citations only from authorized, active spaces and survive reopen', async () => {
  await withLibrary(async (library, file) => {
    const material = await library.add({
      operationId: 'resume-source-1', spaceId: 'career', title: 'Project Alpha design notes',
      content: 'Overview\nWe reduced API latency through cache invalidation changes.\nThe measured result is not yet confirmed.',
      sourceUri: 'user-provided:project-alpha.md', receivedAt: '2026-10-07T12:00:00Z',
    });
    assert.equal(material.version.length, 64);
    assert.deepEqual(library.search('latency cache', ['other']), []);
    assert.equal(library.search('latency cache', ['career'])[0]?.startLine, 2);
    assert.equal(library.readExcerpt(material.id, { start: 2, end: 3 }, ['career'])?.text,
      'We reduced API latency through cache invalidation changes.\nThe measured result is not yet confirmed.');
    assert.equal(library.readExcerpt(material.id, { start: 1, end: 1 }, ['other']), undefined);
    const reopened = new JsonTextMaterialLibrary(file, 'owner');
    assert.equal(reopened.search('latency', ['career'])[0]?.materialId, material.id);
  });
});

test('material revocation removes the source text from future reads and blocks re-add through the same operation', async () => {
  await withLibrary(async (library) => {
    const material = await library.add({
      operationId: 'book-1', spaceId: 'reading', title: 'Book excerpt', content: 'Private passage about attention.',
      receivedAt: '2026-10-07T12:00:00Z',
    });
    assert.equal(await library.revoke(material.id, '2026-10-07T13:00:00Z', ['reading']), true);
    assert.deepEqual(library.search('attention', ['reading']), []);
    assert.equal(library.readExcerpt(material.id, { start: 1, end: 1 }, ['reading']), undefined);
    await assert.rejects(() => library.add({
      operationId: 'book-1', spaceId: 'reading', title: 'Book excerpt', content: 'Private passage about attention.',
      receivedAt: '2026-10-07T12:00:00Z',
    }), /revoked material/);
    assert.equal(await library.revoke(material.id, '2026-10-07T14:00:00Z', ['unauthorized']), false);
  });
});

test('materials cannot be read without an explicit space allowlist or beyond the citation excerpt bound', async () => {
  await withLibrary(async (library) => {
    const material = await library.add({
      operationId: 'bounded', spaceId: 'project', title: 'Large notes', content: Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n'),
      receivedAt: '2026-10-07T12:00:00Z',
    });
    assert.deepEqual(library.search('line', []), []);
    assert.throws(() => library.readExcerpt(material.id, { start: 1, end: 41 }, ['project']), /1-40 lines/);
  });
});
