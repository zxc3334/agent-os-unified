import type { PersonalMemoryStore } from './personal-memory.js';

export interface PersonalMemoryContextRequest {
  /** Authenticated actor from the host message envelope. */
  actorId: string;
  /** Configured owner identity; never model supplied. */
  trustedOwnerId: string;
  /** Keep private personal memory out of group and bot-to-bot traffic. */
  directMessage: boolean;
  query: string;
  /** Authorized by the trusted caller, not inferred from relevance. */
  authorizedSpaceIds: readonly string[];
  maxEntries?: number;
  maxCharacters?: number;
}

export type PersonalMemoryContextResult =
  | { status: 'not_authorized' | 'empty'; text: '' }
  | { status: 'ready'; text: string; sourceVersions: Array<{ id: string; version: number }> };

/**
 * Produce a small, read-only background snapshot for one task. Authorization is
 * checked before retrieval; relevance only ranks records inside that scope.
 */
export async function preparePersonalMemoryContext(
  store: PersonalMemoryStore,
  request: PersonalMemoryContextRequest,
): Promise<PersonalMemoryContextResult> {
  if (!request.directMessage || request.actorId !== request.trustedOwnerId) {
    return { status: 'not_authorized', text: '' };
  }
  const context = await store.formatContextWithSources(request.query, {
    authorizedSpaceIds: [...new Set(request.authorizedSpaceIds)],
    maxEntries: request.maxEntries ?? 5,
    maxCharacters: request.maxCharacters ?? 3_000,
  });
  return context.text ? { status: 'ready', ...context } : { status: 'empty', text: '' };
}
