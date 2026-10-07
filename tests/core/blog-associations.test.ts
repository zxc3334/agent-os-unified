import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { JsonBlogAssociations, type BlogSourceReference } from '../../src/core/blog-associations.js';

const sources: BlogSourceReference[] = [
  { id: 'reading-1', spaceId: 'reading', kind: 'daily-record' },
  { id: 'exploration-1', spaceId: 'exploration', kind: 'daily-record' },
];
const timestamp = '2026-10-08T02:00:00.000Z';

function propose(store: JsonBlogAssociations, operationId = 'association-op') {
  return store.proposeAssociation({
    initiatedBy: 'user', operationId, actorId: 'owner', createdAt: timestamp,
    authorizedSpaceIds: ['reading', 'exploration'], sources,
    reasoning: 'Both notes discuss how evidence should shape an explanation.',
    intendedUse: 'Consider a connection in a personal blog draft.',
  });
}

test('association proposals persist only references and reasoning; unauthorized spaces are rejected before creation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-os-blog-associations-'));
  const file = join(directory, 'blog.json');
  try {
    const store = new JsonBlogAssociations(file);
    assert.throws(() => store.proposeAssociation({
      initiatedBy: 'user', operationId: 'unauthorized', actorId: 'owner', createdAt: timestamp,
      authorizedSpaceIds: ['reading'], sources,
      reasoning: 'Potential connection.', intendedUse: 'Blog draft.',
    }), /unauthorized source space/);
    assert.deepEqual(store.listProposals(), []);

    const original = Object.freeze({ ...sources[0], privateOriginal: 'FULL PRIVATE SOURCE TEXT — never persist' });
    const proposal = store.proposeAssociation({
      initiatedBy: 'user', operationId: 'authorized', actorId: 'owner', createdAt: timestamp,
      authorizedSpaceIds: ['reading', 'exploration'],
      sources: [original, sources[1]], reasoning: 'Shared theme.', intendedUse: 'Blog draft.',
    });
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const serialized = await readFile(file, 'utf8');
    assert.equal(serialized.includes('FULL PRIVATE SOURCE TEXT'), false);
    assert.equal(serialized.includes('privateOriginal'), false);
    const reopened = new JsonBlogAssociations(file);
    assert.deepEqual(reopened.getProposal(proposal.id), proposal);
    assert.deepEqual(original, { ...sources[0], privateOriginal: 'FULL PRIVATE SOURCE TEXT — never persist' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('accepting or rejecting a proposal never mutates its source records', () => {
  const sourceRecord = Object.freeze({ id: 'reading-1', content: 'Original note content', spaceId: 'reading' });
  const before = structuredClone(sourceRecord);
  const store = new JsonBlogAssociations();
  const accepted = propose(store, 'accept-op');
  const rejected = propose(store, 'reject-op');

  assert.equal(store.decide(accepted.id, 'accepted', timestamp)?.decision, 'accepted');
  assert.equal(store.decide(rejected.id, 'rejected', timestamp)?.decision, 'rejected');
  assert.deepEqual(sourceRecord, before);
  assert.deepEqual(store.getProposal(accepted.id)?.sources, sources);
  assert.deepEqual(store.getProposal(rejected.id)?.sources, sources);
  assert.equal(store.listDrafts().length, 0);
  assert.throws(() => store.decide(rejected.id, 'accepted', timestamp), /decision is final/);
});

test('no-connection is a valid user decision and does not force a blog association or draft', () => {
  const store = new JsonBlogAssociations();
  const proposal = propose(store);
  const result = store.decide(proposal.id, 'no-connection', timestamp);
  assert.equal(result?.decision, 'no-connection');
  assert.equal(store.listDrafts(proposal.id).length, 0);
  assert.throws(() => store.createDraft({ proposalId: proposal.id, createdAt: timestamp, audience: 'private' }), /must be accepted/);
});

test('draft content preserves user claims, author views, assistant suggestions and hypotheses separately', () => {
  const store = new JsonBlogAssociations();
  const proposal = propose(store);
  store.decide(proposal.id, 'accepted', timestamp);
  const draft = store.createDraft({
    proposalId: proposal.id, createdAt: timestamp, audience: 'private',
    userClaims: [{ text: 'I believe explanations should show their evidence.', sourceIds: ['reading-1'] }],
    authorViews: [{ text: 'The author argues that evidence improves trust.', sourceIds: ['reading-1'] }],
    assistantSuggestions: [{ text: 'You could connect this to reproducible experiments.', sourceIds: ['exploration-1'] }],
    hypotheses: [{ text: 'Perhaps reproducibility makes disagreement more productive.', sourceIds: ['exploration-1'] }],
  });
  assert.equal(draft.userClaims[0]?.text.startsWith('I believe'), true);
  assert.equal(draft.authorViews[0]?.text.startsWith('The author argues'), true);
  assert.equal(draft.assistantSuggestions[0]?.text.startsWith('You could'), true);
  assert.equal(draft.hypotheses[0]?.text.startsWith('Perhaps'), true);
  assert.deepEqual(store.listDrafts(proposal.id), [draft]);
});

test('public drafts fail closed until every cited source has explicit per-source authorization', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-os-blog-public-'));
  const file = join(directory, 'blog.json');
  try {
    const store = new JsonBlogAssociations(file);
    const proposal = propose(store);
    store.decide(proposal.id, 'accepted', timestamp);
    const input = {
      proposalId: proposal.id, createdAt: timestamp, audience: 'public' as const,
      userClaims: [{ text: 'A public-facing claim.', sourceIds: ['reading-1', 'exploration-1'] }],
    };
    store.setPublicUseAuthorization(proposal.id, 'reading-1', 'authorized', timestamp);
    store.setPublicUseAuthorization(proposal.id, 'exploration-1', 'denied', timestamp);
    assert.throws(() => store.createDraft(input), /not explicitly authorized/);
    assert.equal(store.listDrafts(proposal.id).length, 0);

    const reopened = new JsonBlogAssociations(file);
    assert.throws(() => reopened.createDraft(input), /not explicitly authorized/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('explicit grants are source-specific and persist with a public draft', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-os-blog-authorized-'));
  const file = join(directory, 'blog.json');
  try {
    const store = new JsonBlogAssociations(file);
    const proposal = propose(store);
    store.decide(proposal.id, 'accepted', timestamp);
    store.setPublicUseAuthorization(proposal.id, 'reading-1', 'authorized', timestamp);
    store.setPublicUseAuthorization(proposal.id, 'exploration-1', 'authorized', timestamp);
    const draft = store.createDraft({
      proposalId: proposal.id, createdAt: timestamp, audience: 'public',
      userClaims: [{ text: 'A reviewed public claim.', sourceIds: ['reading-1'] }],
      hypotheses: [{ text: 'A clearly labeled hypothesis.', sourceIds: ['exploration-1'] }],
    });
    const reopened = new JsonBlogAssociations(file);
    assert.deepEqual(reopened.getProposal(proposal.id)?.decision, 'accepted');
    assert.deepEqual(reopened.listDrafts(proposal.id), [draft]);
    assert.throws(() => reopened.setPublicUseAuthorization(proposal.id, 'unrelated-source', 'authorized', timestamp), /not part/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('revoked or deleted references cannot be proposed, accepted, authorized, or used for new drafts', () => {
  for (const reason of ['revoked', 'deleted'] as const) {
    const store = new JsonBlogAssociations();
    const proposal = propose(store, `before-${reason}`);
    store.invalidateSource(sources[0]!, reason, timestamp);
    store.invalidateSource(sources[0]!, reason, timestamp); // idempotent

    assert.equal(store.areProposalSourcesActive(proposal.id), false);
    assert.throws(() => store.proposeAssociation({
      initiatedBy: 'user', operationId: `after-${reason}`, actorId: 'owner', createdAt: timestamp,
      authorizedSpaceIds: ['reading', 'exploration'], sources,
      reasoning: 'Potential connection.', intendedUse: 'Blog draft.',
    }), /revoked or deleted source/);
    assert.throws(() => store.decide(proposal.id, 'accepted', timestamp), /cannot accept/);
    assert.throws(() => store.setPublicUseAuthorization(proposal.id, 'reading-1', 'authorized', timestamp), /cannot authorize/);
    assert.equal(store.listProposals().length, 1);
  }
});

test('source invalidation prevents already accepted proposals from creating or reusing drafts', () => {
  const store = new JsonBlogAssociations();
  const proposal = propose(store);
  store.decide(proposal.id, 'accepted', timestamp);
  store.setPublicUseAuthorization(proposal.id, 'reading-1', 'authorized', timestamp);
  store.setPublicUseAuthorization(proposal.id, 'exploration-1', 'authorized', timestamp);
  const draft = store.createDraft({
    proposalId: proposal.id, createdAt: timestamp, audience: 'public',
    userClaims: [{ text: 'An approved public claim.', sourceIds: ['reading-1'] }],
  });
  assert.deepEqual(store.listReusableDrafts(proposal.id), [draft]);

  store.invalidateSource(sources[0]!, 'revoked', timestamp);
  assert.throws(() => store.createDraft({
    proposalId: proposal.id, createdAt: timestamp, audience: 'private',
    userClaims: [{ text: 'A new claim.', sourceIds: ['reading-1'] }],
  }), /contains revoked or deleted sources/);
  assert.deepEqual(store.listReusableDrafts(proposal.id), []);
  // Historical records remain auditable, but are no longer advertised as reusable.
  assert.deepEqual(store.listDrafts(proposal.id), [draft]);
});

test('legacy v1 state without invalidation metadata remains readable and upgrades on next write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-os-blog-legacy-'));
  const file = join(directory, 'blog.json');
  try {
    const legacy = {
      schemaVersion: 1,
      proposals: [],
      publicUseAuthorizations: [],
      drafts: [],
    };
    await import('node:fs/promises').then(({ writeFile }) => writeFile(file, JSON.stringify(legacy), 'utf8'));
    const store = new JsonBlogAssociations(file);
    assert.deepEqual(store.listProposals(), []);
    store.invalidateSource(sources[0]!, 'deleted', timestamp);
    const persisted = JSON.parse(await readFile(file, 'utf8')) as { invalidatedSources?: unknown[] };
    assert.equal(persisted.invalidatedSources?.length, 1);
    const reopened = new JsonBlogAssociations(file);
    assert.equal(reopened.areProposalSourcesActive('missing'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
