import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BlogWritingWorkflow, type BlogWritingModel } from '../../src/app/blog-writing-workflow.js';
import { JsonBlogAssociations, type BlogSourceReference } from '../../src/core/blog-associations.js';
import type { BlogSourceCandidate, BlogSourceRetrievalProviders, BlogSourceSearchProvider } from '../../src/core/blog-source-retriever.js';

const now = '2026-10-08T02:00:00.000Z';
const context = { actorId: 'owner', trustedOwnerId: 'owner', chatType: 'p2p' as const, authorizedSpaceIds: ['reading', 'exploration'] };
const candidates: BlogSourceCandidate[] = [
  { id: 'reading-1', spaceId: 'reading', status: 'active', text: 'Private source passage one, never copy it verbatim into public prose.', userView: '我的明确观点是证据应保留不确定性，失败实验同样必须被完整记录。' },
  { id: 'exploration-1', spaceId: 'exploration', status: 'active', text: 'Private source passage two, another distinct research note.', userView: '实验需要记录失败结果' },
];
const provider = (items: BlogSourceCandidate[]): BlogSourceSearchProvider => ({ async search() { return items; } });
const providers: BlogSourceRetrievalProviders = { memories: provider([]), dailyRecords: provider(candidates), materials: provider([]) };
const model: BlogWritingModel = {
  async suggestAssociations({ sources }) {
    return [{ sourceIds: sources.map((item) => item.reference.id), reasoning: 'Both notes emphasize honest evidence.', intendedUse: 'Connect evidence and reproducibility.' }];
  },
  async write({ sources }) {
    const ids = sources.map((item) => item.reference.id);
    return {
      outline: [{ text: '从证据边界谈到实验复现', sourceIds: ids }],
      userClaims: [{ text: '用户观点：应保留证据中的不确定性。', sourceIds: ['reading-1'] }],
      authorViews: [], assistantSuggestions: [{ text: '可以补充失败实验如何记录。', sourceIds: ['exploration-1'] }],
      hypotheses: [{ text: '这可能提升读者对结论的信任。', sourceIds: ids }],
      unresolvedQuestions: ['尚需补充一个具体失败案例'],
    };
  },
};
const sourceRefs: BlogSourceReference[] = candidates.map((candidate) => ({ id: candidate.id, spaceId: candidate.spaceId, kind: 'daily-record' }));

 test('owner can propose explainable connections and build a stance-separated outline/draft in real storage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-os-blog-workflow-'));
  const file = join(directory, 'blog.json');
  try {
    const store = new JsonBlogAssociations(file);
    const workflow = new BlogWritingWorkflow(store, providers, model);
    const result = await workflow.propose({ context, topic: 'evidence', operationId: 'blog-op', now });
    assert.equal(result.status, 'proposed');
    if (result.status !== 'proposed') return;
    const proposal = result.proposals[0]!;
    assert.equal(proposal.decision, undefined);
    assert.match(proposal.reasoning, /evidence/);
    assert.deepEqual(proposal.sources, sourceRefs);
    assert.equal(await readFile(file, 'utf8').then((text) => text.includes(candidates[0]!.text)), false);

    store.decide(proposal.id, 'accepted', now);
    const draftResult = await workflow.draft({ context, topic: 'evidence', operationId: 'draft-op', now, proposalId: proposal.id, audience: 'private' });
    assert.equal(draftResult.status, 'drafted');
    if (draftResult.status !== 'drafted') return;
    assert.equal(draftResult.draft.outline?.[0]?.text, '从证据边界谈到实验复现');
    assert.equal(draftResult.draft.userClaims[0]?.text.startsWith('用户观点'), true);
    assert.equal(draftResult.draft.hypotheses[0]?.text.startsWith('这可能'), true);
    assert.deepEqual(draftResult.draft.unresolvedQuestions, ['尚需补充一个具体失败案例']);
    const reopened = new JsonBlogAssociations(file);
    assert.equal(reopened.listReusableDrafts(proposal.id).length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('workflow refuses non-owner and group access and does not invent associations when model finds none', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-os-blog-no-match-'));
  try {
    const store = new JsonBlogAssociations(join(directory, 'blog.json'));
    const blocked = new BlogWritingWorkflow(store, providers, model);
    await assert.rejects(() => blocked.propose({ context: { ...context, chatType: 'group' }, topic: 'evidence', operationId: 'x', now }), /trusted owner/);
    await assert.rejects(() => blocked.propose({ context: { ...context, actorId: 'other' }, topic: 'evidence', operationId: 'x', now }), /trusted owner/);
    const noMatchModel: BlogWritingModel = { ...model, async suggestAssociations() { return []; } };
    const result = await new BlogWritingWorkflow(store, providers, noMatchModel).propose({ context, topic: 'evidence', operationId: 'none', now });
    assert.deepEqual(result, { status: 'no-relevant-sources', unavailableKinds: [] });
    assert.deepEqual(store.listProposals(), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('public drafting fails closed per cited source and source tombstones block drafting after acceptance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-os-blog-public-workflow-'));
  try {
    const store = new JsonBlogAssociations(join(directory, 'blog.json'));
    const workflow = new BlogWritingWorkflow(store, providers, model);
    const suggested = await workflow.propose({ context, topic: 'evidence', operationId: 'public-op', now });
    assert.equal(suggested.status, 'proposed');
    if (suggested.status !== 'proposed') return;
    const proposal = suggested.proposals[0]!;
    store.decide(proposal.id, 'accepted', now);
    await assert.rejects(() => workflow.draft({ context, topic: 'evidence', operationId: 'public-draft', now, proposalId: proposal.id, audience: 'public' }), /not explicitly authorized/);
    assert.equal(store.listDrafts(proposal.id).length, 0);
    // Even an uncited unresolved-question field cannot bypass authorization of a source.
    store.setPublicUseAuthorization(proposal.id, proposal.sources[0]!.id, 'authorized', now);
    assert.throws(() => store.createDraft({ proposalId: proposal.id, createdAt: now, audience: 'public', unresolvedQuestions: ['private-derived detail'] }), /not explicitly authorized/);

    for (const reference of proposal.sources) store.setPublicUseAuthorization(proposal.id, reference.id, 'authorized', now);
    store.invalidateSource(proposal.sources[0]!, 'revoked', now);
    await assert.rejects(() => workflow.draft({ context, topic: 'evidence', operationId: 'after-revoke', now, proposalId: proposal.id, audience: 'public' }), /revoked or deleted/);
    assert.equal(store.listDrafts(proposal.id).length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('workflow reports retrieval/model limitations and rejects model output that copies private source text', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-os-blog-limitations-'));
  try {
    const store = new JsonBlogAssociations(join(directory, 'blog.json'));
    const noModel = await new BlogWritingWorkflow(store, providers).propose({ context, topic: 'evidence', operationId: 'no-model', now });
    assert.deepEqual(noModel, { status: 'model-unavailable', unavailableKinds: [] });
    const failingProviders = { ...providers, materials: { async search() { throw new Error('secret'); } } };
    const limited = await new BlogWritingWorkflow(store, failingProviders).propose({ context, topic: 'evidence', operationId: 'limited', now });
    assert.equal(limited.status, 'model-unavailable');
    assert.deepEqual(limited.unavailableKinds, ['material']);

    const copyModel: BlogWritingModel = { ...model, async write({ sources }) { return {
      outline: [{ text: candidates[0]!.userView!, sourceIds: [sources[0]!.reference.id] }], userClaims: [], authorViews: [],
      assistantSuggestions: [], hypotheses: [], unresolvedQuestions: [],
    }; } };
    const proposed = await new BlogWritingWorkflow(store, providers, model).propose({ context, topic: 'evidence', operationId: 'copy', now });
    if (proposed.status !== 'proposed') throw new Error('expected proposal');
    store.decide(proposed.proposals[0]!.id, 'accepted', now);
    await assert.rejects(() => new BlogWritingWorkflow(store, providers, copyModel).draft({ context, topic: 'evidence', operationId: 'copy-draft', now, proposalId: proposed.proposals[0]!.id, audience: 'private' }), /copied source text verbatim/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('proposal model sees only allowlisted candidates and composite tokens disambiguate same ID across kind and scope', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-os-blog-source-tokens-'));
  try {
    const store = new JsonBlogAssociations(join(directory, 'blog.json'));
    const memory: BlogSourceSearchProvider = provider([
      { id: 'shared-id', spaceId: 'reading', status: 'active', text: 'Authorized memory note with sufficient detail.' },
      { id: 'cross-scope', spaceId: 'outside', status: 'active', text: 'Provider must not expose this.' },
    ]);
    const daily: BlogSourceSearchProvider = provider([
      { id: 'shared-id', spaceId: 'reading', status: 'active', text: 'Authorized daily note, same ID but different kind.' },
      { id: 'unique-id', spaceId: 'exploration', status: 'active', text: 'Authorized exploration note with enough detail.' },
    ]);
    const scopedProviders: BlogSourceRetrievalProviders = { memories: memory, dailyRecords: daily, materials: provider([]) };
    let seen: Array<{ sourceToken: string; id: string; spaceId: string; kind: string }> = [];
    const tokenModel: BlogWritingModel = {
      async suggestAssociations({ sources }) {
        seen = sources.map((source) => ({ sourceToken: source.sourceToken, id: source.reference.id, spaceId: source.reference.spaceId, kind: source.reference.kind }));
        assert.equal(sources.some((source) => source.reference.id === 'cross-scope'), false);
        const selected = sources.filter((source) => source.reference.kind === 'memory' || source.reference.id === 'unique-id');
        return [{ sourceTokens: selected.map((source) => source.sourceToken), reasoning: 'Authorized, distinct records.', intendedUse: 'Blog connection.' }];
      },
      async write() { throw new Error('not used'); },
    };
    const result = await new BlogWritingWorkflow(store, scopedProviders, tokenModel).propose({ context, topic: 'notes', operationId: 'tokens', now });
    assert.equal(result.status, 'proposed');
    assert.equal(seen.length, 3);
    assert.notEqual(seen[0]!.sourceToken, seen[1]!.sourceToken);
    if (result.status !== 'proposed') return;
    assert.deepEqual(result.proposals[0]!.sources, [
      { id: 'shared-id', spaceId: 'reading', kind: 'memory' },
      { id: 'unique-id', spaceId: 'exploration', kind: 'daily-record' },
    ]);

    const ambiguousModel: BlogWritingModel = { ...tokenModel, async suggestAssociations({ sources }) {
      // Legacy scalar IDs are rejected when they match more than one authorized source.
      return [{ sourceIds: ['shared-id', 'unique-id'], reasoning: 'Ambiguous legacy response.', intendedUse: 'Should not persist.' }];
    } };
    const ambiguousStore = new JsonBlogAssociations(join(directory, 'ambiguous.json'));
    const ambiguous = await new BlogWritingWorkflow(ambiguousStore, scopedProviders, ambiguousModel).propose({ context, topic: 'notes', operationId: 'ambiguous', now });
    assert.deepEqual(ambiguous, { status: 'no-relevant-sources', unavailableKinds: [] });
    assert.deepEqual(ambiguousStore.listProposals(), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
