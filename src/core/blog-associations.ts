import { randomUUID } from 'node:crypto';
import {
  closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export type AssociationDecision = 'accepted' | 'rejected' | 'no-connection';
export type BlogSourceKind = 'memory' | 'material' | 'daily-record';
export type PublicUseAuthorization = 'authorized' | 'denied';
export type BlogDraftStance = 'user-claim' | 'author-view' | 'assistant-suggestion' | 'hypothesis';

/** A reference only. Source content is intentionally never copied into this domain store. */
export interface BlogSourceReference {
  id: string;
  spaceId: string;
  kind: BlogSourceKind;
}
export interface AssociationProposal {
  id: string;
  operationId: string;
  actorId: string;
  createdAt: string;
  sources: BlogSourceReference[];
  reasoning: string;
  intendedUse: string;
  decision?: AssociationDecision;
  decidedAt?: string;
}
export interface BlogDraftStatement {
  text: string;
  sourceIds: string[];
}
export interface StancePreservingBlogDraft {
  id: string;
  proposalId: string;
  createdAt: string;
  audience: 'private' | 'public';
  /** These categories remain separate; no cross-category synthesis occurs in this core. */
  userClaims: BlogDraftStatement[];
  authorViews: BlogDraftStatement[];
  assistantSuggestions: BlogDraftStatement[];
  hypotheses: BlogDraftStatement[];
}
interface StoreState {
  schemaVersion: 1;
  proposals: AssociationProposal[];
  publicUseAuthorizations: Array<{ proposalId: string; sourceId: string; authorization: PublicUseAuthorization; updatedAt: string }>;
  drafts: StancePreservingBlogDraft[];
}
export interface ProposeAssociationInput {
  /** The host must call this only for an explicit user-triggered association request. */
  initiatedBy: 'user';
  operationId: string;
  actorId: string;
  createdAt: string;
  authorizedSpaceIds: readonly string[];
  sources: readonly BlogSourceReference[];
  reasoning: string;
  intendedUse: string;
}
export interface CreateBlogDraftInput {
  proposalId: string;
  createdAt: string;
  audience: 'private' | 'public';
  userClaims?: readonly BlogDraftStatement[];
  authorViews?: readonly BlogDraftStatement[];
  assistantSuggestions?: readonly BlogDraftStatement[];
  hypotheses?: readonly BlogDraftStatement[];
}

const MAX_TEXT = 4_000;
const nonEmpty = (value: string, field: string, limit = MAX_TEXT): string => {
  if (typeof value !== 'string') throw new Error(`${field} must be text`);
  const normalized = value.trim();
  if (!normalized || normalized.length > limit) throw new Error(`${field} must contain 1-${limit} characters`);
  return normalized;
};
function iso(value: string, field: string): string {
  const normalized = nonEmpty(value, field, 80);
  if (!/^\d{4}-\d\d-\d\dT/.test(normalized) || !Number.isFinite(Date.parse(normalized))) {
    throw new Error(`${field} must be an ISO timestamp`);
  }
  return new Date(normalized).toISOString();
}
function emptyState(): StoreState {
  return { schemaVersion: 1, proposals: [], publicUseAuthorizations: [], drafts: [] };
}
function readState(path: string): StoreState {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as StoreState;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.proposals)
      || !Array.isArray(parsed.publicUseAuthorizations) || !Array.isArray(parsed.drafts)) {
      throw new Error('unsupported blog association store schema');
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
    throw error;
  }
}
function writeState(path: string, state: StoreState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    const directoryFd = openSync(dirname(path), 'r');
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch { /* Best effort cleanup. */ }
    throw error;
  }
}
function normalizeSource(source: BlogSourceReference): BlogSourceReference {
  const kind = source.kind;
  if (!['memory', 'material', 'daily-record'].includes(kind)) throw new Error('unsupported blog source kind');
  return {
    id: nonEmpty(source.id, 'source.id', 300),
    spaceId: nonEmpty(source.spaceId, 'source.spaceId', 300),
    kind,
  };
}
function normalizeStatements(statements: readonly BlogDraftStatement[] | undefined, field: string): BlogDraftStatement[] {
  if (!statements) return [];
  return statements.map((statement) => {
    if (!Array.isArray(statement.sourceIds) || statement.sourceIds.length === 0) {
      throw new Error(`${field} statements must cite at least one source`);
    }
    return {
      text: nonEmpty(statement.text, `${field}.text`),
      sourceIds: [...new Set(statement.sourceIds.map((id) => nonEmpty(id, `${field}.sourceId`, 300)))],
    };
  });
}

/** Durable, deterministic domain slice. It does not search, infer associations, or call a model. */
export class JsonBlogAssociations {
  private state: StoreState;
  constructor(private readonly filePath?: string) {
    this.state = filePath ? readState(filePath) : emptyState();
  }

  /** Creates a proposal only from caller-supplied source references after space authorization checks. */
  proposeAssociation(input: ProposeAssociationInput): AssociationProposal {
    if (input.initiatedBy !== 'user') throw new Error('association proposals must be explicitly user-triggered');
    const operationId = nonEmpty(input.operationId, 'operationId', 300);
    const actorId = nonEmpty(input.actorId, 'actorId', 300);
    const createdAt = iso(input.createdAt, 'createdAt');
    const authorized = new Set(input.authorizedSpaceIds.map((id) => nonEmpty(id, 'authorizedSpaceId', 300)));
    const sources = input.sources.map(normalizeSource);
    if (sources.length < 2) throw new Error('an association proposal requires at least two sources');
    if (new Set(sources.map((source) => source.id)).size !== sources.length) throw new Error('source ids must be unique');
    const unauthorized = sources.filter((source) => !authorized.has(source.spaceId));
    if (unauthorized.length) throw new Error(`unauthorized source space: ${unauthorized.map((source) => source.spaceId).join(', ')}`);
    const reasoning = nonEmpty(input.reasoning, 'reasoning');
    const intendedUse = nonEmpty(input.intendedUse, 'intendedUse');
    const existing = this.state.proposals.find((proposal) => proposal.operationId === operationId);
    if (existing) {
      const { id: _id, ...prior } = existing;
      const candidate = { operationId, actorId, createdAt, sources, reasoning, intendedUse };
      if (JSON.stringify(prior) !== JSON.stringify(candidate)) throw new Error('operationId already used for a different proposal');
      return structuredClone(existing);
    }
    const proposal: AssociationProposal = {
      id: randomUUID(), operationId, actorId, createdAt, sources, reasoning, intendedUse,
    };
    this.mutate(() => { this.state.proposals.push(proposal); });
    return structuredClone(proposal);
  }

  getProposal(id: string): AssociationProposal | undefined {
    const proposal = this.state.proposals.find((item) => item.id === id);
    return proposal && structuredClone(proposal);
  }
  listProposals(): AssociationProposal[] { return structuredClone(this.state.proposals); }

  decide(proposalId: string, decision: AssociationDecision, decidedAt: string): AssociationProposal | undefined {
    if (!['accepted', 'rejected', 'no-connection'].includes(decision)) throw new Error('unsupported association decision');
    const current = this.state.proposals.find((item) => item.id === proposalId);
    if (!current) return undefined;
    if (current.decision && current.decision !== decision) throw new Error('association decision is final');
    const updated = { ...current, decision, decidedAt: iso(decidedAt, 'decidedAt') };
    this.mutate(() => { this.state.proposals = this.state.proposals.map((item) => item.id === proposalId ? updated : item); });
    return structuredClone(updated);
  }

  /** Permission is recorded for exactly one source in exactly one proposal; there is no space-wide grant. */
  setPublicUseAuthorization(
    proposalId: string, sourceId: string, authorization: PublicUseAuthorization, updatedAt: string,
  ): void {
    if (!['authorized', 'denied'].includes(authorization)) throw new Error('unsupported public-use authorization');
    const proposal = this.state.proposals.find((item) => item.id === proposalId);
    if (!proposal || !proposal.sources.some((source) => source.id === sourceId)) throw new Error('source is not part of this proposal');
    const normalizedAt = iso(updatedAt, 'updatedAt');
    const record = { proposalId, sourceId, authorization, updatedAt: normalizedAt };
    this.mutate(() => {
      const index = this.state.publicUseAuthorizations.findIndex((item) => item.proposalId === proposalId && item.sourceId === sourceId);
      if (index < 0) this.state.publicUseAuthorizations.push(record);
      else this.state.publicUseAuthorizations[index] = record;
    });
  }

  /** Creates structured, stance-separated draft content. Public drafts fail closed per cited source. */
  createDraft(input: CreateBlogDraftInput): StancePreservingBlogDraft {
    if (!['private', 'public'].includes(input.audience)) throw new Error('unsupported draft audience');
    const proposal = this.state.proposals.find((item) => item.id === input.proposalId);
    if (!proposal) throw new Error('association proposal does not exist');
    if (proposal.decision !== 'accepted') throw new Error('association must be accepted before drafting');
    const draft: StancePreservingBlogDraft = {
      id: randomUUID(), proposalId: proposal.id, createdAt: iso(input.createdAt, 'createdAt'), audience: input.audience,
      userClaims: normalizeStatements(input.userClaims, 'userClaims'),
      authorViews: normalizeStatements(input.authorViews, 'authorViews'),
      assistantSuggestions: normalizeStatements(input.assistantSuggestions, 'assistantSuggestions'),
      hypotheses: normalizeStatements(input.hypotheses, 'hypotheses'),
    };
    const proposalSourceIds = new Set(proposal.sources.map((source) => source.id));
    const citedIds = [...new Set([
      ...draft.userClaims, ...draft.authorViews, ...draft.assistantSuggestions, ...draft.hypotheses,
    ].flatMap((statement) => statement.sourceIds))];
    if (citedIds.some((id) => !proposalSourceIds.has(id))) throw new Error('draft cites a source outside the accepted proposal');
    if (draft.audience === 'public') {
      const unauthorized = citedIds.filter((sourceId) => !this.state.publicUseAuthorizations.some(
        (item) => item.proposalId === proposal.id && item.sourceId === sourceId && item.authorization === 'authorized',
      ));
      if (unauthorized.length) throw new Error(`public use not explicitly authorized for source(s): ${unauthorized.join(', ')}`);
    }
    this.mutate(() => { this.state.drafts.push(draft); });
    return structuredClone(draft);
  }

  listDrafts(proposalId?: string): StancePreservingBlogDraft[] {
    return structuredClone(this.state.drafts.filter((draft) => proposalId === undefined || draft.proposalId === proposalId));
  }

  private mutate(change: () => void): void {
    const previous = structuredClone(this.state);
    change();
    try {
      if (this.filePath) writeState(this.filePath, this.state);
    } catch (error) {
      this.state = previous;
      throw error;
    }
  }
}
