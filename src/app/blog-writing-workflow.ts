import type { AssociationProposal, BlogDraftStatement, BlogSourceReference, JsonBlogAssociations, StancePreservingBlogDraft } from '../core/blog-associations.js';
import { retrieveBlogSources, type BlogRetrievedSource, type BlogSourceRetrievalProviders } from '../core/blog-source-retriever.js';

export interface BlogActorContext {
  actorId: string;
  trustedOwnerId: string;
  chatType: 'p2p' | 'group';
  authorizedSpaceIds: readonly string[];
}
export interface BlogAssociationSuggestion {
  /** Composite opaque keys avoid collisions when providers reuse IDs across spaces/kinds. */
  sourceTokens?: string[];
  /** Legacy model response accepted only when every ID maps uniquely. */
  sourceIds?: string[];
  reasoning: string;
  intendedUse: string;
}
export interface BlogWritingResult {
  outline: BlogDraftStatement[];
  userClaims: BlogDraftStatement[];
  authorViews: BlogDraftStatement[];
  assistantSuggestions: BlogDraftStatement[];
  hypotheses: BlogDraftStatement[];
  unresolvedQuestions: string[];
}
/** Replaceable model seam. It receives only bounded excerpts from authorized, active sources. */
export type BlogModelSource = BlogRetrievedSource & { sourceToken: string };
export interface BlogWritingModel {
  suggestAssociations(input: { topic: string; sources: readonly BlogModelSource[] }): Promise<BlogAssociationSuggestion[]>;
  write(input: { topic: string; sources: readonly BlogModelSource[] }): Promise<BlogWritingResult>;
}
export interface BlogWorkflowInput { context: BlogActorContext; topic: string; operationId: string; now: string; }
export type BlogProposalResult =
  | { status: 'proposed'; proposals: AssociationProposal[]; unavailableKinds: string[] }
  | { status: 'no-relevant-sources'; unavailableKinds: string[] }
  | { status: 'model-unavailable'; unavailableKinds: string[] };
export type BlogDraftResult =
  | { status: 'drafted'; draft: StancePreservingBlogDraft; unavailableKinds: string[] }
  | { status: 'sources-unavailable'; unavailableKinds: string[] }
  | { status: 'model-unavailable'; unavailableKinds: string[] };

function assertOwnerPrivate(context: BlogActorContext): void {
  if (context.chatType !== 'p2p' || !context.trustedOwnerId || context.actorId !== context.trustedOwnerId) {
    throw new Error('blog workflow is available only to the trusted owner in private chat');
  }
}
function validateModelText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4_000) throw new Error(`model returned invalid ${field}`);
  return value.trim();
}
function validateStatements(statements: unknown, field: string, permitted: Set<string>, sources: readonly BlogRetrievedSource[]): BlogDraftStatement[] {
  if (!Array.isArray(statements)) throw new Error(`model returned invalid ${field}`);
  return statements.map((raw) => {
    const item = raw as BlogDraftStatement;
    const text = validateModelText(item?.text, `${field} statement`);
    if (!Array.isArray(item.sourceIds) || !item.sourceIds.length || item.sourceIds.some((id) => typeof id !== 'string' || !permitted.has(id))) {
      throw new Error(`model returned unsupported citations in ${field}`);
    }
    // Avoid copying private passages verbatim into generated prose. Users can explicitly
    // authorize publication separately through the store's per-source public-use gate.
    const normalized = text.normalize('NFKC').toLocaleLowerCase();
    if (item.sourceIds.some((id) => {
      const source = sources.find((candidate) => candidate.reference.id === id);
      const privateText = [source?.excerpt, source?.perspectives?.authorView, source?.perspectives?.userView];
      return privateText.some((value) => {
        const passage = value?.trim().normalize('NFKC').toLocaleLowerCase();
        // Short fragments are too collision-prone to match reliably; the surrounding
        // statement remains source-cited, while meaningful copied passages fail closed.
        return !!passage && passage.length >= 12 && normalized.includes(passage);
      });
    })) throw new Error(`model copied source text verbatim in ${field}`);
    return { text, sourceIds: [...new Set(item.sourceIds)] };
  });
}
function validateWriting(output: BlogWritingResult, sources: readonly BlogRetrievedSource[]): BlogWritingResult {
  const permitted = new Set(sources.map((source) => source.reference.id));
  if (!permitted.size) throw new Error('no active sources available for drafting');
  if (!output || typeof output !== 'object') throw new Error('model returned invalid writing result');
  if (!Array.isArray(output.unresolvedQuestions)) throw new Error('model returned invalid unresolved questions');
  const outline = validateStatements(output.outline, 'outline', permitted, sources);
  if (!outline.length) throw new Error('model returned an empty outline');
  return {
    outline,
    userClaims: validateStatements(output.userClaims, 'userClaims', permitted, sources),
    authorViews: validateStatements(output.authorViews, 'authorViews', permitted, sources),
    assistantSuggestions: validateStatements(output.assistantSuggestions, 'assistantSuggestions', permitted, sources),
    hypotheses: validateStatements(output.hypotheses, 'hypotheses', permitted, sources),
    unresolvedQuestions: output.unresolvedQuestions.map((item) => validateModelText(item, 'unresolved question')),
  };
}

/** Owner-triggered research-writing flow. It never writes source content to the association store. */
export class BlogWritingWorkflow {
  constructor(
    private readonly associations: JsonBlogAssociations,
    private readonly providers: BlogSourceRetrievalProviders,
    private readonly model?: BlogWritingModel,
  ) {}

  async propose(input: BlogWorkflowInput): Promise<BlogProposalResult> {
    assertOwnerPrivate(input.context);
    const topic = validateModelText(input.topic, 'topic');
    const retrieved = await retrieveBlogSources(this.providers, { query: topic, authorizedSpaceIds: input.context.authorizedSpaceIds });
    if (retrieved.sources.length < 2) return { status: 'no-relevant-sources', unavailableKinds: retrieved.unavailableKinds };
    if (!this.model) return { status: 'model-unavailable', unavailableKinds: retrieved.unavailableKinds };
    const modelSources = retrieved.sources.map((source) => ({ ...source, sourceToken: sourceToken(source.reference) }));
    const suggestions = await this.model.suggestAssociations({ topic, sources: modelSources });
    const proposals: AssociationProposal[] = [];
    for (const [index, suggestion] of suggestions.slice(0, 3).entries()) {
      if (!suggestion) continue;
      let refs: BlogSourceReference[];
      if (Array.isArray(suggestion.sourceTokens)) {
        const tokenMap = new Map(retrieved.sources.map((source) => [sourceToken(source.reference), source.reference]));
        refs = [...new Set(suggestion.sourceTokens)].flatMap((token) => tokenMap.has(token) ? [tokenMap.get(token)!] : []);
      } else if (Array.isArray(suggestion.sourceIds)) {
        refs = [...new Set(suggestion.sourceIds)].flatMap((id) => {
          const matches = retrieved.sources.filter((source) => source.reference.id === id);
          return matches.length === 1 ? [matches[0]!.reference] : [];
        });
      } else continue;
      // Current storage and draft citation IDs are scalar. Refuse an ambiguous collision rather
      // than collapsing same-ID sources from distinct kinds/spaces into the wrong reference.
      if (new Set(refs.map((ref) => ref.id)).size !== refs.length) continue;
      if (refs.length < 2) continue; // no forced association
      proposals.push(this.associations.proposeAssociation({
        initiatedBy: 'user', operationId: `${input.operationId}:${index}`, actorId: input.context.actorId,
        createdAt: input.now, authorizedSpaceIds: input.context.authorizedSpaceIds, sources: refs,
        reasoning: validateModelText(suggestion.reasoning, 'association reasoning'),
        intendedUse: validateModelText(suggestion.intendedUse, 'intended use'),
      }));
    }
    return proposals.length
      ? { status: 'proposed', proposals, unavailableKinds: retrieved.unavailableKinds }
      : { status: 'no-relevant-sources', unavailableKinds: retrieved.unavailableKinds };
  }

  decide(context: BlogActorContext, proposalId: string, decision: 'accepted' | 'rejected' | 'no-connection', now: string): AssociationProposal | undefined {
    assertOwnerPrivate(context);
    const proposal = this.associations.getProposal(proposalId);
    if (!proposal || proposal.actorId !== context.actorId) return undefined;
    return this.associations.decide(proposalId, decision, now);
  }

  authorizePublicSource(context: BlogActorContext, proposalId: string, sourceId: string, authorization: 'authorized' | 'denied', now: string): void {
    assertOwnerPrivate(context);
    const proposal = this.associations.getProposal(proposalId);
    if (!proposal || proposal.actorId !== context.actorId || proposal.decision !== 'accepted') throw new Error('accepted owner proposal not found');
    this.associations.setPublicUseAuthorization(proposalId, sourceId, authorization, now);
  }

  async draft(input: BlogWorkflowInput & { proposalId: string; audience: 'private' | 'public' }): Promise<BlogDraftResult> {
    assertOwnerPrivate(input.context);
    const proposal = this.associations.getProposal(input.proposalId);
    if (!proposal || proposal.actorId !== input.context.actorId || proposal.decision !== 'accepted') throw new Error('accepted owner proposal not found');
    if (!this.associations.areProposalSourcesActive(proposal.id)) throw new Error('proposal contains revoked or deleted sources');
    // Generated metadata (notably unresolved questions) is not necessarily source-cited, so
    // public generation requires grants for every retrieved source, not only cited statements.
    if (input.audience === 'public' && !this.associations.areProposalSourcesPubliclyAuthorized(proposal.id)) {
      throw new Error('public use not explicitly authorized for every proposal source');
    }
    const topic = validateModelText(input.topic, 'topic');
    const retrieved = await retrieveBlogSources(this.providers, { query: topic, authorizedSpaceIds: input.context.authorizedSpaceIds });
    const allowed = new Set(input.context.authorizedSpaceIds);
    const selected = retrieved.sources.filter((source) => allowed.has(source.reference.spaceId)
      && proposal.sources.some((ref) => sameSource(ref, source.reference)));
    const modelSources = selected.map((source) => ({ ...source, sourceToken: sourceToken(source.reference) }));
    if (selected.length !== proposal.sources.length) return { status: 'sources-unavailable', unavailableKinds: retrieved.unavailableKinds };
    // Recheck after retrieval to close the common revoke-between-search-and-use window.
    if (!this.associations.areProposalSourcesActive(proposal.id)) throw new Error('proposal contains revoked or deleted sources');
    if (!this.model) return { status: 'model-unavailable', unavailableKinds: retrieved.unavailableKinds };
    const generated = validateWriting(await this.model.write({ topic, sources: modelSources }), modelSources);
    const draft = this.associations.createDraft({ proposalId: proposal.id, createdAt: input.now, audience: input.audience, ...generated });
    return { status: 'drafted', draft, unavailableKinds: retrieved.unavailableKinds };
  }
}
export function sourceToken(source: BlogSourceReference): string {
  return Buffer.from(JSON.stringify([source.kind, source.spaceId, source.id])).toString('base64url');
}
function sameSource(a: BlogSourceReference, b: BlogSourceReference): boolean {
  return a.id === b.id && a.spaceId === b.spaceId && a.kind === b.kind;
}
