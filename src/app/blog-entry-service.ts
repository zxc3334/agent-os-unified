import type { AssociationDecision, JsonBlogAssociations } from '../core/blog-associations.js';
import {
  retrieveBlogSources,
  type BlogSourceRetrievalProviders,
  type BlogSourceRetrievalResult,
} from '../core/blog-source-retriever.js';

export interface ProposeBlogAssociationInput {
  actorId: string;
  operationId: string;
  createdAt: string;
  query: string;
  intendedUse: string;
  authorizedSpaceIds: readonly string[];
}

/** Trusted host wrapper for owner-triggered, reference-only blog association flows. */
export class BlogEntryService {
  constructor(
    private readonly associations: JsonBlogAssociations,
    private readonly providers: BlogSourceRetrievalProviders,
  ) {}

  async search(query: string, authorizedSpaceIds: readonly string[]): Promise<BlogSourceRetrievalResult> {
    const result = await retrieveBlogSources(this.providers, { query, authorizedSpaceIds, limit: 6, maxExcerptCharacters: 500 });
    // Association storage requires globally unique source IDs; keep the first provider result.
    const seen = new Set<string>();
    return {
      ...result,
      sources: result.sources.filter(({ reference }) => {
        if (seen.has(reference.id)) return false;
        seen.add(reference.id);
        return true;
      }),
    };
  }

  async propose(input: ProposeBlogAssociationInput): Promise<{
    proposalId?: string;
    sources: BlogSourceRetrievalResult['sources'];
    unavailableKinds: BlogSourceRetrievalResult['unavailableKinds'];
  }> {
    const retrieval = await this.search(input.query, input.authorizedSpaceIds);
    const sources = retrieval.sources.slice(0, 6);
    if (sources.length < 2) return { sources, unavailableKinds: retrieval.unavailableKinds };
    const proposal = this.associations.proposeAssociation({
      initiatedBy: 'user', operationId: input.operationId, actorId: input.actorId,
      createdAt: input.createdAt, authorizedSpaceIds: input.authorizedSpaceIds,
      sources: sources.map(({ reference }) => reference),
      reasoning: `关键词检索候选（${input.query.trim().slice(0, 300)}）；这是待用户判断的关联，不代表系统已确认观点。`,
      intendedUse: input.intendedUse,
    });
    return { proposalId: proposal.id, sources, unavailableKinds: retrieval.unavailableKinds };
  }

  decide(proposalId: string, actorId: string, decision: AssociationDecision, decidedAt: string): boolean {
    const proposal = this.associations.getProposal(proposalId);
    if (!proposal || proposal.actorId !== actorId) return false;
    return Boolean(this.associations.decide(proposalId, decision, decidedAt));
  }
}

export type { AssociationDecision };
