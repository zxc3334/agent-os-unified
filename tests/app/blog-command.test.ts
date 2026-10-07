import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BlogEntryService } from '../../src/app/blog-entry-service.js';
import { handleSessionCommand } from '../../src/app/command-handler.js';
import { JsonBlogAssociations } from '../../src/core/blog-associations.js';
import { PersonalMemoryStore } from '../../src/core/personal-memory.js';
import { parseCommand } from '../../src/core/command-parser.js';
import type { BlogSourceSearchProvider } from '../../src/core/blog-source-retriever.js';

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-os-blog-command-'));
  const memory = new PersonalMemoryStore({ directory: join(directory, 'memory'), ownerId: 'owner' });
  const allowed = await memory.createSpace('博客');
  const privateSpace = await memory.createSpace('私密');
  const replies: string[] = [];
  const bot = { reply: async (_id: string, text: string) => { replies.push(text); return undefined; } } as never;
  const candidate = (id: string, spaceId = allowed.id, status: 'active' | 'forgotten' = 'active') => ({
    id, spaceId, status, text: `Source text ${id}`,
  });
  let memoryResults = [candidate('memory-1'), candidate('memory-private', privateSpace.id)];
  let dailyResults = [candidate('daily-1')];
  const provider = (get: () => typeof memoryResults): BlogSourceSearchProvider => ({
    search: async ({ authorizedSpaceIds }) => get().filter((item) => authorizedSpaceIds.includes(item.spaceId)),
  });
  const associations = new JsonBlogAssociations(join(directory, 'associations.json'));
  const service = new BlogEntryService(associations, {
    memories: provider(() => memoryResults), dailyRecords: provider(() => dailyResults),
    materials: { search: async () => [] },
  });
  const options = {
    runtime: {}, scheduler: {}, config: { id: 'assistant' }, bot,
    msg: { senderOpenId: 'owner', chatType: 'p2p', chatId: 'owner-dm', messageId: 'message-1', receivedAt: '2026-10-07T10:00:00.000Z' },
    session: { id: 'session-1', status: 'idle', memorySpaceIds: [allowed.id] }, cliAdapter: {}, isNew: false, hasThread: false,
    trustedOwnerOpenId: 'owner', personalMemoryStore: memory, blogEntryService: service,
  } as never;
  return { directory, allowed, privateSpace, replies, associations, service, options, setMemory: (v: typeof memoryResults) => { memoryResults = v; }, setDaily: (v: typeof dailyResults) => { dailyResults = v; } };
}

test('blog command parser accepts only bounded search, propose and decision forms', () => {
  assert.deepEqual(parseCommand('/blog search attention'), { name: 'blog', action: 'search', query: 'attention' });
  assert.deepEqual(parseCommand('/blog propose attention :: connect reading to my project'), {
    name: 'blog', action: 'propose', query: 'attention', intendedUse: 'connect reading to my project',
  });
  assert.deepEqual(parseCommand('/blog decide proposal_1 none'), {
    name: 'blog', action: 'decide', proposalId: 'proposal_1', decision: 'no-connection',
  });
  assert.deepEqual(parseCommand('/blog propose only-query'), { name: 'blog', action: 'propose', topic: 'only-query' });
  assert.equal(parseCommand('/blog decide id maybe'), undefined);
});

test('owner blog search and proposal stay within the matter allowlist and preserve source records', async () => {
  const ctx = await setup();
  try {
    await handleSessionCommand({ ...ctx.options, command: parseCommand('/blog search source') });
    assert.match(ctx.replies.at(-1)!, /memory-1/);
    assert.doesNotMatch(ctx.replies.at(-1)!, /memory-private/);
    assert.match(ctx.replies.at(-1)!, /不会自动拼成你的观点/);

    await handleSessionCommand({ ...ctx.options, msg: { ...ctx.options.msg, messageId: 'proposal-message' }, command: parseCommand('/blog propose source :: relate these notes') });
    const proposalId = ctx.replies.at(-1)!.match(/候选关联 \[([^\]]+)\]/)?.[1];
    assert.ok(proposalId);
    assert.equal(ctx.associations.getProposal(proposalId!)?.sources.length, 2);
    assert.deepEqual(ctx.associations.getProposal(proposalId!)?.sources.map((s) => s.id), ['memory-1', 'daily-1']);
    ctx.setDaily([{ id: 'memory-1', spaceId: ctx.allowed.id, status: 'active', text: 'duplicate source' }]);
    assert.deepEqual((await ctx.service.search('source', [ctx.allowed.id])).sources.map((s) => s.reference.id), ['memory-1']);
    ctx.setDaily([{ id: 'daily-1', spaceId: ctx.allowed.id, status: 'active', text: 'Source text daily-1' }]);
    await handleSessionCommand({ ...ctx.options, msg: { ...ctx.options.msg, messageId: 'decision-message' }, command: parseCommand(`/blog decide ${proposalId} reject`) });
    assert.equal(ctx.associations.getProposal(proposalId!)?.decision, 'rejected');
    assert.equal(ctx.associations.listDrafts().length, 0);
    assert.deepEqual((await ctx.service.search('source', [ctx.allowed.id])).sources.map((s) => s.reference.id), ['memory-1', 'daily-1']);
  } finally { await rm(ctx.directory, { recursive: true, force: true }); }
});

test('blog commands reject non-owner and group access and refuse proposals with fewer than two unique sources', async () => {
  const ctx = await setup();
  try {
    await handleSessionCommand({ ...ctx.options, msg: { ...ctx.options.msg, chatType: 'group' }, command: parseCommand('/blog search source') });
    assert.match(ctx.replies.at(-1)!, /仅限所有者在私聊中使用/);
    await handleSessionCommand({ ...ctx.options, msg: { ...ctx.options.msg, senderOpenId: 'other' }, command: parseCommand('/blog search source') });
    assert.match(ctx.replies.at(-1)!, /仅限所有者在私聊中使用/);

    ctx.setDaily([]);
    await handleSessionCommand({ ...ctx.options, msg: { ...ctx.options.msg, messageId: 'one-source' }, command: parseCommand('/blog propose source :: connect them') });
    assert.match(ctx.replies.at(-1)!, /只找到 1 条来源/);
    assert.equal(ctx.associations.listProposals().length, 0);

    // A broken provider is reported as unavailable without exposing its error text.
    const broken = new BlogEntryService(ctx.associations, {
      memories: { search: async () => { throw new Error('sensitive backend error'); } },
      dailyRecords: { search: async () => [] }, materials: { search: async () => [] },
    });
    const result = await broken.search('source', [ctx.allowed.id]);
    assert.deepEqual(result.unavailableKinds, ['memory']);
    assert.deepEqual(result.sources, []);
  } finally { await rm(ctx.directory, { recursive: true, force: true }); }
});

test('blog decisions are actor-bound and cannot alter original sources', async () => {
  const ctx = await setup();
  try {
    const proposal = ctx.associations.proposeAssociation({
      initiatedBy: 'user', operationId: 'other-proposal', actorId: 'different-owner', createdAt: '2026-10-07T10:00:00.000Z',
      authorizedSpaceIds: [ctx.allowed.id], sources: [
        { id: 'memory-1', spaceId: ctx.allowed.id, kind: 'memory' },
        { id: 'daily-1', spaceId: ctx.allowed.id, kind: 'daily-record' },
      ], reasoning: 'candidate', intendedUse: 'blog',
    });
    await handleSessionCommand({ ...ctx.options, command: parseCommand(`/blog decide ${proposal.id} accept`) });
    assert.match(ctx.replies.at(-1)!, /没有找到属于你的/);
    assert.equal(ctx.associations.getProposal(proposal.id)?.decision, undefined);
    assert.equal(ctx.associations.listDrafts().length, 0);
  } finally { await rm(ctx.directory, { recursive: true, force: true }); }
});
