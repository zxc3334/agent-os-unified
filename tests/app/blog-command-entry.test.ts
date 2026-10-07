import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { handleSessionCommand } from '../../src/app/command-handler.js';
import { BlogWritingWorkflow, type BlogWritingModel } from '../../src/app/blog-writing-workflow.js';
import { JsonBlogAssociations } from '../../src/core/blog-associations.js';
import { parseCommand } from '../../src/core/command-parser.js';
import type { BlogSourceRetrievalProviders, BlogSourceSearchProvider } from '../../src/core/blog-source-retriever.js';

const now = '2026-10-08T02:00:00.000Z';
test('owner private /blog entry can propose, decide and generate persisted outline/draft via replaceable model', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-os-blog-command-entry-'));
  try {
    const associations = new JsonBlogAssociations(join(directory, 'blog.json'));
    const provider: BlogSourceSearchProvider = { async search() { return [
      { id: 'note-1', spaceId: 'reading', status: 'active', text: 'Reading notes about reliable evidence.' },
      { id: 'note-2', spaceId: 'exploration', status: 'active', text: 'Exploration notes about reproducible tests.' },
    ]; } };
    const none: BlogSourceSearchProvider = { async search() { return []; } };
    const providers: BlogSourceRetrievalProviders = { memories: none, dailyRecords: provider, materials: none };
    const model: BlogWritingModel = {
      async suggestAssociations({ sources }) { return [{ sourceIds: sources.map((item) => item.reference.id), reasoning: 'Both cover traceable evidence.', intendedUse: 'Connect reading and experiments.' }]; },
      async write({ sources }) { return {
        outline: [{ text: '证据与实验', sourceIds: sources.map((item) => item.reference.id) }],
        userClaims: [], authorViews: [], assistantSuggestions: [{ text: '补充一个可复现案例。', sourceIds: ['note-2'] }], hypotheses: [], unresolvedQuestions: ['还需验证案例来源'],
      }; },
    };
    const workflow = new BlogWritingWorkflow(associations, providers, model);
    const replies: string[] = [];
    const options = {
      runtime: {}, scheduler: {}, config: {}, bot: { reply: async (_id: string, text: string) => { replies.push(text); } },
      msg: { senderOpenId: 'owner', chatType: 'p2p', messageId: 'blog-msg-1', receivedAt: now },
      session: { id: 'session', status: 'idle', memorySpaceIds: ['reading', 'exploration'] }, cliAdapter: {}, isNew: false, hasThread: false,
      trustedOwnerOpenId: 'owner', blogWorkflow: workflow, personalMemoryStore: { listSpaces: async () => [{ id: 'reading' }, { id: 'exploration' }] },
    } as never;
    assert.deepEqual(parseCommand('/blog propose evidence'), { name: 'blog', action: 'propose', topic: 'evidence' });
    await handleSessionCommand({ ...options, command: parseCommand('/blog propose evidence') });
    assert.match(replies.at(-1)!, /关联建议/);
    const id = replies.at(-1)!.match(/关联建议 \[([^\]]+)\]/)?.[1];
    assert.ok(id);
    await handleSessionCommand({ ...options, msg: { ...options.msg, messageId: 'blog-decide' }, command: parseCommand(`/blog decide ${id} accept`) });
    await handleSessionCommand({ ...options, msg: { ...options.msg, messageId: 'blog-draft' }, command: parseCommand(`/blog draft ${id} private :: evidence`) });
    assert.match(replies.at(-1)!, /大纲：[\s\S]*证据与实验/);
    assert.match(replies.at(-1)!, /待解决问题：[\s\S]*还需验证案例来源/);
    assert.equal(associations.listDrafts(id).length, 1);
    assert.deepEqual(parseCommand(`/blog authorize ${id} note-1 allow`), { name: 'blog', action: 'authorize', proposalId: id, sourceId: 'note-1', authorization: 'authorized' });
    await handleSessionCommand({ ...options, msg: { ...options.msg, messageId: 'grant-1' }, command: parseCommand(`/blog authorize ${id} note-1 allow`) });
    await handleSessionCommand({ ...options, msg: { ...options.msg, messageId: 'grant-2' }, command: parseCommand(`/blog authorize ${id} note-2 allow`) });
    await handleSessionCommand({ ...options, msg: { ...options.msg, messageId: 'blog-public-draft' }, command: parseCommand(`/blog draft ${id} public :: evidence`) });
    assert.equal(associations.listDrafts(id).filter((draft) => draft.audience === 'public').length, 1);

    const before = replies.length;
    await handleSessionCommand({ ...options, msg: { ...options.msg, chatType: 'group', messageId: 'blog-group' }, command: parseCommand('/blog propose evidence') });
    assert.equal(replies.length, before + 1);
    assert.match(replies.at(-1)!, /仅限所有者在私聊/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
