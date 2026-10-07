import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface TextMaterial {
  id: string;
  ownerId: string;
  spaceId: string;
  title: string;
  sourceUri?: string;
  version: string;
  status: 'active' | 'revoked';
  content: string;
  createdAt: string;
  updatedAt: string;
  operationId: string;
}
export interface MaterialExcerpt {
  materialId: string;
  title: string;
  spaceId: string;
  version: string;
  startLine: number;
  endLine: number;
  text: string;
}
interface LibraryState { schemaVersion: 1; materials: TextMaterial[] }
export interface AddTextMaterialInput {
  operationId: string;
  spaceId: string;
  title: string;
  content: string;
  sourceUri?: string;
  receivedAt: string;
}

const MAX_CONTENT = 200_000;
const MAX_EXCERPT_LINES = 40;
const clean = (value: string, name: string, max = 500): string => {
  const result = value.trim();
  if (!result || result.length > max) throw new Error(`${name} must contain 1-${max} characters`);
  return result;
};
const validIso = (value: string, name: string) => {
  const text = clean(value, name, 80);
  if (!/^\d{4}-\d\d-\d\dT/.test(text) || !Number.isFinite(Date.parse(text))) throw new Error(`${name} must be an ISO timestamp`);
  return new Date(text).toISOString();
};
const textHash = (value: string) => createHash('sha256').update(value).digest('hex');
const empty = (): LibraryState => ({ schemaVersion: 1, materials: [] });
function readStore(path: string): LibraryState {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as LibraryState;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.materials)) throw new Error('Unsupported or corrupt material library; refusing to overwrite');
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty();
    throw error;
  }
}
function writeStore(path: string, state: LibraryState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    const dir = openSync(dirname(path), 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch { /* best effort */ }
    throw error;
  }
}

/** Local text/Markdown materials with citation locations and fail-closed scope checks. */
export class JsonTextMaterialLibrary {
  private state: LibraryState;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly filePath: string, private readonly ownerId: string) {
    this.ownerId = clean(ownerId, 'ownerId', 200);
    this.state = readStore(filePath);
    if (this.state.materials.some((item) => item.ownerId !== this.ownerId)) throw new Error('Material owner mismatch; refusing to expose or overwrite the library');
  }

  add(input: AddTextMaterialInput): Promise<TextMaterial> {
    const operationId = clean(input.operationId, 'operationId', 300);
    const spaceId = clean(input.spaceId, 'spaceId', 300);
    const title = clean(input.title, 'title', 300);
    const content = input.content.trim();
    if (!content || content.length > MAX_CONTENT) throw new Error(`content must contain 1-${MAX_CONTENT} characters`);
    const createdAt = validIso(input.receivedAt, 'receivedAt');
    const sourceUri = input.sourceUri === undefined ? undefined : clean(input.sourceUri, 'sourceUri', 2_000);
    const version = textHash(content);
    return this.mutate((state) => {
      const existing = state.materials.find((item) => item.operationId === operationId);
      if (existing) {
        if (existing.status !== 'active' || existing.version !== version || existing.spaceId !== spaceId || existing.title !== title) {
          throw new Error('operationId already used for different or revoked material');
        }
        return existing;
      }
      const material: TextMaterial = {
        id: randomUUID(), ownerId: this.ownerId, spaceId, title,
        ...(sourceUri ? { sourceUri } : {}), version, status: 'active', content,
        createdAt, updatedAt: createdAt, operationId,
      };
      state.materials.push(material);
      return material;
    });
  }

  search(query: string, authorizedSpaceIds: readonly string[], limit = 5): MaterialExcerpt[] {
    const phrase = clean(query, 'query', 1_000).normalize('NFKC').toLocaleLowerCase();
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('limit must be 1-20');
    const authorized = new Set(authorizedSpaceIds);
    if (authorized.size === 0) return [];
    const terms = [...new Set(phrase.split(/[\s,，。.!?！？;；:：/\\]+/).filter((item) => item.length > 1))];
    const matches: Array<{ score: number; excerpt: MaterialExcerpt }> = [];
    for (const material of this.state.materials) {
      if (material.ownerId !== this.ownerId || material.status !== 'active' || !authorized.has(material.spaceId)) continue;
      const lines = material.content.split(/\r?\n/);
      lines.forEach((line, index) => {
        const haystack = `${material.title}\n${line}`.normalize('NFKC').toLocaleLowerCase();
        const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
        if (!score) return;
        matches.push({ score, excerpt: {
          materialId: material.id, title: material.title, spaceId: material.spaceId,
          version: material.version, startLine: index + 1, endLine: index + 1,
          text: line.slice(0, 1_200),
        } });
      });
    }
    return matches.sort((a, b) => b.score - a.score || a.excerpt.title.localeCompare(b.excerpt.title) || a.excerpt.startLine - b.excerpt.startLine)
      .slice(0, limit).map(({ excerpt }) => structuredClone(excerpt));
  }

  readExcerpt(materialId: string, lines: { start: number; end: number }, authorizedSpaceIds: readonly string[]): MaterialExcerpt | undefined {
    const material = this.state.materials.find((item) => item.id === materialId && item.ownerId === this.ownerId && item.status === 'active');
    if (!material || !authorizedSpaceIds.includes(material.spaceId)) return undefined;
    if (!Number.isInteger(lines.start) || !Number.isInteger(lines.end) || lines.start < 1 || lines.end < lines.start || lines.end - lines.start + 1 > MAX_EXCERPT_LINES) {
      throw new Error(`excerpt range must contain 1-${MAX_EXCERPT_LINES} lines`);
    }
    const all = material.content.split(/\r?\n/);
    if (lines.start > all.length) return undefined;
    const end = Math.min(lines.end, all.length);
    return {
      materialId, title: material.title, spaceId: material.spaceId, version: material.version,
      startLine: lines.start, endLine: end, text: all.slice(lines.start - 1, end).join('\n'),
    };
  }

  getReference(materialId: string): { id: string; spaceId: string; status: TextMaterial['status'] } | undefined {
    const material = this.state.materials.find((item) => item.id === materialId && item.ownerId === this.ownerId);
    return material ? { id: material.id, spaceId: material.spaceId, status: material.status } : undefined;
  }

  revoke(materialId: string, changedAt: string, authorizedSpaceIds: readonly string[]): Promise<boolean> {
    const updatedAt = validIso(changedAt, 'changedAt');
    return this.mutate((state) => {
      const item = state.materials.find((material) => material.id === materialId && material.ownerId === this.ownerId);
      if (!item || !authorizedSpaceIds.includes(item.spaceId)) return false;
      item.status = 'revoked';
      item.content = '';
      item.version = textHash('');
      item.updatedAt = updatedAt;
      return true;
    });
  }

  private mutate<T>(change: (state: LibraryState) => T): Promise<T> {
    const run = async () => {
      const previous = structuredClone(this.state);
      const result = change(this.state);
      try { writeStore(this.filePath, this.state); }
      catch (error) { this.state = previous; throw error; }
      return structuredClone(result);
    };
    const current = this.queue.then(run, run);
    this.queue = current.catch(() => undefined);
    return current;
  }
}
