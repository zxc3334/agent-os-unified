import type { DailyRecord } from './daily-records.js';
import type { PersonalMemoryEntry } from './personal-memory.js';
import type { BlogSourceKind, BlogSourceReference } from './blog-associations.js';
import type { JsonTextMaterialLibrary } from './text-materials.js';

export type BlogRetrievalSourceStatus = 'active' | 'forgotten' | 'deleted' | 'unavailable';

/** Small adapter contract; source stores remain authoritative and are never mutated here. */
export interface BlogSourceCandidate {
  id: string;
  spaceId: string;
  status: BlogRetrievalSourceStatus;
  text: string;
  date?: string;
  version?: number | string;
  location?: string;
  /** Kept separate so reading claims are not confused with the user's response. */
  authorView?: string;
  userView?: string;
}

export interface BlogSourceSearchRequest {
  query: string;
  /** Explicit allow-list supplied by trusted host authorization. */
  authorizedSpaceIds: readonly string[];
  limit: number;
}
export interface BlogSourceSearchProvider {
  search(request: BlogSourceSearchRequest): Promise<readonly BlogSourceCandidate[]>;
}
export interface BlogSourceRetrievalProviders {
  memories: BlogSourceSearchProvider;
  dailyRecords: BlogSourceSearchProvider;
  materials: BlogSourceSearchProvider;
}
export interface BlogRetrievedSource {
  reference: BlogSourceReference;
  excerpt: string;
  provenance: {
    spaceId: string;
    sourceKind: BlogSourceKind;
    sourceId: string;
    date?: string;
    version?: number | string;
    location?: string;
  };
  perspectives?: { authorView?: string; userView?: string };
}
export interface BlogSourceRetrievalResult {
  sources: BlogRetrievedSource[];
  unavailableKinds: BlogSourceKind[];
}
export interface RetrieveBlogSourcesInput {
  query: string;
  authorizedSpaceIds: readonly string[];
  limit?: number;
  maxExcerptCharacters?: number;
}

const SOURCES: ReadonlyArray<{ kind: BlogSourceKind; provider: keyof BlogSourceRetrievalProviders }> = [
  { kind: 'memory', provider: 'memories' },
  { kind: 'daily-record', provider: 'dailyRecords' },
  { kind: 'material', provider: 'materials' },
];
function bounded(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}
function short(text: string | undefined, max: number): string | undefined {
  if (typeof text !== 'string' || !text.trim()) return undefined;
  const normalized = text.trim();
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

/** Search explicit authorized sources; this does not create memories, associations, or drafts. */
export async function retrieveBlogSources(
  providers: BlogSourceRetrievalProviders,
  input: RetrieveBlogSourcesInput,
): Promise<BlogSourceRetrievalResult> {
  if (typeof input.query !== 'string' || !input.query.trim()) throw new Error('query must not be empty');
  const authorizedSpaceIds = [...new Set(input.authorizedSpaceIds.filter(
    (id): id is string => typeof id === 'string' && !!id.trim(),
  ))];
  if (!authorizedSpaceIds.length) return { sources: [], unavailableKinds: [] };
  const query = input.query.trim().slice(0, 2_000);
  const limit = bounded(input.limit, 8, 30);
  const excerptLimit = bounded(input.maxExcerptCharacters, 360, 1_200);
  const authorized = new Set(authorizedSpaceIds);
  const results = await Promise.all(SOURCES.map(async ({ kind, provider }) => {
    try {
      return { kind, candidates: await providers[provider].search({ query, authorizedSpaceIds, limit }) } as const;
    } catch {
      return { kind, candidates: undefined } as const;
    }
  }));
  const sources: BlogRetrievedSource[] = [];
  const unavailableKinds: BlogSourceKind[] = [];
  for (const { kind, candidates } of results) {
    if (!candidates) { unavailableKinds.push(kind); continue; }
    for (const candidate of candidates) {
      // Enforce the allow-list and lifecycle again at this boundary, regardless of adapter behavior.
      if (candidate.status !== 'active' || !authorized.has(candidate.spaceId)
        || !candidate.id.trim() || !candidate.text.trim()) continue;
      const recordExcerpt = short(candidate.text, excerptLimit);
      if (!recordExcerpt) continue;
      const authorView = kind === 'daily-record' ? short(candidate.authorView, excerptLimit) : undefined;
      const userView = kind === 'daily-record' ? short(candidate.userView, excerptLimit) : undefined;
      sources.push({
        reference: { id: candidate.id, spaceId: candidate.spaceId, kind },
        excerpt: recordExcerpt,
        provenance: {
          spaceId: candidate.spaceId, sourceKind: kind, sourceId: candidate.id,
          ...(candidate.date ? { date: candidate.date } : {}),
          ...(candidate.version !== undefined ? { version: candidate.version } : {}),
          ...(candidate.location ? { location: candidate.location } : {}),
        },
        ...(authorView || userView ? { perspectives: {
          ...(authorView ? { authorView } : {}), ...(userView ? { userView } : {}),
        } } : {}),
      });
    }
  }
  return { sources: sources.slice(0, limit), unavailableKinds };
}

/** Adapter to the existing memory authority; only active, authorized search results are exposed. */
export function personalMemorySearchProvider(store: {
  search(query: string, options: { authorizedSpaceIds: string[]; limit: number }): Promise<PersonalMemoryEntry[]>;
}): BlogSourceSearchProvider {
  return {
    async search({ query, authorizedSpaceIds, limit }) {
      return (await store.search(query, { authorizedSpaceIds: [...authorizedSpaceIds], limit })).map((entry) => ({
        id: entry.id, spaceId: entry.spaceId, status: entry.status === 'active' ? 'active' : 'forgotten',
        text: entry.content, date: entry.updatedAt, version: entry.version, location: `memory:${entry.kind}`,
      }));
    },
  };
}

/** Unscoped daily records are intentionally excluded: null scope is not authorization. */
export function dailyRecordSearchProvider(store: {
  listRecords(options?: { scopeId?: string | null }): DailyRecord[];
}): BlogSourceSearchProvider {
  return {
    async search({ query, authorizedSpaceIds, limit }) {
      const needle = query.normalize('NFKC').toLocaleLowerCase();
      const allowed = new Set(authorizedSpaceIds);
      return store.listRecords().filter((record) => record.scopeId !== null && allowed.has(record.scopeId))
        .filter((record) => [record.content, record.authorView, record.userView]
          .some((text) => text?.normalize('NFKC').toLocaleLowerCase().includes(needle)))
        .slice(0, limit)
        .map((record) => ({
          id: record.id, spaceId: record.scopeId!, status: 'active', text: record.content,
          date: record.date, location: `daily-record:${record.kind}`,
          ...(record.authorView ? { authorView: record.authorView } : {}),
          ...(record.userView ? { userView: record.userView } : {}),
        }));
    },
  };
}

/** Adapter for owner-owned reference materials; it always rechecks scope on excerpt reads. */
export function textMaterialSearchProvider(library: Pick<JsonTextMaterialLibrary, 'search' | 'readExcerpt'>): BlogSourceSearchProvider {
  return {
    async search({ query, authorizedSpaceIds, limit }) {
      return library.search(query, authorizedSpaceIds, limit).flatMap((hit) => {
        const excerpt = library.readExcerpt(hit.materialId, { start: hit.startLine, end: hit.endLine }, authorizedSpaceIds);
        return excerpt ? [{
          id: excerpt.materialId, spaceId: excerpt.spaceId, status: 'active' as const, text: excerpt.text,
          version: excerpt.version, location: `lines ${excerpt.startLine}-${excerpt.endLine}`,
        }] : [];
      });
    },
  };
}
