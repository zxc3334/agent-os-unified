import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { calculateNextReview } from './memory.js';

export interface CareerSourceRef {
  kind: 'project-record' | 'material' | 'resume' | 'mock-interview' | 'user-confirmation' | 'other';
  id: string;
  version?: string;
  locator?: string;
}

export interface CareerEvidence {
  id: string;
  claim: string;
  status: 'confirmed' | 'unconfirmed';
  sources: CareerSourceRef[];
  createdAt: string;
}

export interface RoleRequirements {
  id: string;
  title: string;
  organization?: string;
  requirements: string[];
  source?: CareerSourceRef;
  createdAt: string;
}

export interface ResumeClaim {
  text: string;
  evidenceId: string;
  sources: CareerSourceRef[];
}

export interface ResumeVersion {
  id: string;
  roleId: string;
  claims: ResumeClaim[];
  excludedEvidenceIds: string[];
  status: 'proposed' | 'active' | 'superseded';
  createdAt: string;
  approval?: { approvedBy: string; approvedAt: string };
}

export interface LearningReview {
  score: number;
  reviewedAt: string;
}

export interface CareerLearningRecord {
  id: string;
  assessmentType: 'practice-feedback';
  reviewStatus: 'needs-review' | 'reviewed';
  summary: string;
  weakPoint: string;
  source: CareerSourceRef;
  resumeVersionId: string;
  createdAt: string;
  latestScore?: number;
  reviewRounds: number;
  reviewHistory: LearningReview[];
  /** Scheduler state; optional only in persisted legacy JSON and normalized on read. */
  nextReviewAt: string;
  repetition: number;
  intervalDays: number;
  mastery: number;
  reviewState: 'active' | 'mastered';
}

export interface MockInterviewRecord {
  id: string;
  resumeVersionId: string;
  roleId?: string;
  recordedAt: string;
  learningRecordIds: string[];
}

export interface MockInterviewFeedbackInput {
  summary: string;
  weakPoint: string;
  source: CareerSourceRef;
}

interface CareerState {
  evidence: CareerEvidence[];
  roles: RoleRequirements[];
  resumes: ResumeVersion[];
  activeResumeVersionId?: string;
  interviews: MockInterviewRecord[];
  learningRecords: CareerLearningRecord[];
}

const SourceSchema = z.object({
  kind: z.enum(['project-record', 'material', 'resume', 'mock-interview', 'user-confirmation', 'other']),
  id: z.string().min(1),
  version: z.string().optional(),
  locator: z.string().optional(),
}).strict();
const StateSchema = z.object({
  evidence: z.array(z.object({
    id: z.string().min(1), claim: z.string().min(1), status: z.enum(['confirmed', 'unconfirmed']),
    sources: z.array(SourceSchema).min(1), createdAt: z.string().min(1),
  }).strict()),
  roles: z.array(z.object({
    id: z.string().min(1), title: z.string().min(1), organization: z.string().optional(),
    requirements: z.array(z.string()), source: SourceSchema.optional(), createdAt: z.string().min(1),
  }).strict()),
  resumes: z.array(z.object({
    id: z.string().min(1), roleId: z.string().min(1),
    claims: z.array(z.object({ text: z.string().min(1), evidenceId: z.string().min(1), sources: z.array(SourceSchema).min(1) }).strict()),
    excludedEvidenceIds: z.array(z.string()), status: z.enum(['proposed', 'active', 'superseded']), createdAt: z.string().min(1),
    approval: z.object({ approvedBy: z.string().min(1), approvedAt: z.string().min(1) }).strict().optional(),
  }).strict()),
  activeResumeVersionId: z.string().optional(),
  interviews: z.array(z.object({ id: z.string().min(1), resumeVersionId: z.string().min(1), roleId: z.string().optional(), recordedAt: z.string().min(1), learningRecordIds: z.array(z.string()) }).strict()),
  learningRecords: z.array(z.object({
    id: z.string().min(1), assessmentType: z.literal('practice-feedback'), reviewStatus: z.enum(['needs-review', 'reviewed']),
    summary: z.string().min(1), weakPoint: z.string().min(1), source: SourceSchema,
    resumeVersionId: z.string().min(1), createdAt: z.string().min(1), latestScore: z.number().int().min(0).max(5).optional(),
    reviewRounds: z.number().int().nonnegative(), reviewHistory: z.array(z.object({ score: z.number().int().min(0).max(5), reviewedAt: z.string().min(1) }).strict()),
    nextReviewAt: z.string().min(1).optional(), repetition: z.number().int().nonnegative().optional(),
    intervalDays: z.number().int().nonnegative().optional(), mastery: z.number().int().min(0).max(5).optional(),
    reviewState: z.enum(['active', 'mastered']).optional(),
  }).strict()),
}).strict();

const emptyState = (): CareerState => ({ evidence: [], roles: [], resumes: [], interviews: [], learningRecords: [] });

/**
 * Self-contained career-domain core. It stores career preparation state locally;
 * callers decide which evidence is genuinely confirmed and who is authorized to approve.
 */
export class JsonCareerPreparation {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string, private readonly now: () => Date = () => new Date()) {}

  async addEvidence(input: Omit<CareerEvidence, 'id' | 'createdAt'> & { id?: string; createdAt?: string }): Promise<CareerEvidence> {
    requireText(input.claim, 'claim', 2_000);
    if (input.sources.length < 1 || input.sources.length > 20) throw new Error('Evidence must have 1-20 source references');
    return this.mutate((state) => {
      const record: CareerEvidence = {
        ...copy(input), id: input.id ?? randomUUID(), createdAt: input.createdAt ?? this.now().toISOString(),
      };
      state.evidence.push(record);
      return record;
    });
  }

  async listEvidence(): Promise<CareerEvidence[]> {
    return (await this.read()).evidence;
  }

  async saveRoleRequirements(input: Omit<RoleRequirements, 'id' | 'createdAt'> & { id?: string; createdAt?: string }): Promise<RoleRequirements> {
    requireText(input.title, 'role title', 200);
    if (input.requirements.length > 40) throw new Error('A role can have at most 40 requirements');
    input.requirements.forEach((requirement) => requireText(requirement, 'requirement', 500));
    return this.mutate((state) => {
      const role: RoleRequirements = {
        ...copy(input), id: input.id ?? randomUUID(), createdAt: input.createdAt ?? this.now().toISOString(),
      };
      state.roles.push(role);
      return role;
    });
  }

  async listRoleRequirements(): Promise<RoleRequirements[]> {
    return (await this.read()).roles;
  }

  async proposeResumeVersion(input: { roleId: string; evidenceIds: string[] }): Promise<ResumeVersion> {
    return this.mutate((state) => {
      const role = state.roles.find((item) => item.id === input.roleId);
      if (!role) throw new Error(`Unknown role requirements: ${input.roleId}`);
      const requestedIds = [...new Set(input.evidenceIds)];
      const byId = new Map(state.evidence.map((item) => [item.id, item]));
      const unknown = requestedIds.filter((id) => !byId.has(id));
      if (unknown.length) throw new Error(`Unknown career evidence: ${unknown.join(', ')}`);
      const eligible = requestedIds.map((id) => byId.get(id)!).filter((item) => item.status === 'confirmed');
      const excludedEvidenceIds = requestedIds.filter((id) => byId.get(id)?.status !== 'confirmed');
      const version: ResumeVersion = {
        id: randomUUID(), roleId: role.id,
        claims: eligible.map((item) => ({ text: item.claim, evidenceId: item.id, sources: copy(item.sources) })),
        excludedEvidenceIds, status: 'proposed', createdAt: this.now().toISOString(),
      };
      state.resumes.push(version);
      return version;
    });
  }

  async getResumeVersion(id: string): Promise<ResumeVersion | undefined> {
    return (await this.read()).resumes.find((version) => version.id === id);
  }

  async renderResumeMarkdown(id: string): Promise<string | undefined> {
    const state = await this.read();
    const version = state.resumes.find((item) => item.id === id);
    if (!version) return undefined;
    const role = state.roles.find((item) => item.id === version.roleId);
    const lines = [
      `# Resume${role ? ` — ${role.title}` : ''}`,
      '',
      `Version: ${version.id} | Status: ${version.status}`,
      '',
      '## Experience and Projects',
      ...(version.claims.length ? version.claims.map((claim) => `- ${claim.text}\n  - Evidence: ${claim.sources.map((source) => `${source.kind}:${source.id}${source.version ? `@${source.version}` : ''}${source.locator ? `#${source.locator}` : ''}`).join(', ')}`) : ['- No confirmed evidence included.']),
    ];
    return `${lines.join('\n')}\n`;
  }

  async getActiveResumeVersion(): Promise<ResumeVersion | undefined> {
    const state = await this.read();
    return state.resumes.find((version) => version.id === state.activeResumeVersionId);
  }

  async approveResumeVersion(id: string, approval: { approvedBy: string; approvedAt?: string }): Promise<ResumeVersion> {
    if (!approval.approvedBy.trim()) throw new Error('An explicit approver is required');
    return this.mutate((state) => {
      const version = state.resumes.find((item) => item.id === id);
      if (!version) throw new Error(`Unknown resume version: ${id}`);
      if (version.status !== 'proposed') throw new Error(`Resume version is not awaiting approval: ${id}`);
      for (const previous of state.resumes) {
        if (previous.id === state.activeResumeVersionId) previous.status = 'superseded';
      }
      version.status = 'active';
      version.approval = { approvedBy: approval.approvedBy, approvedAt: approval.approvedAt ?? this.now().toISOString() };
      state.activeResumeVersionId = version.id;
      return version;
    });
  }

  async recordMockInterview(input: {
    resumeVersionId: string;
    roleId?: string;
    feedback: MockInterviewFeedbackInput[];
    recordedAt?: string;
  }): Promise<{ interview: MockInterviewRecord; learningRecords: CareerLearningRecord[] }> {
    if (input.feedback.length > 20) throw new Error('An interview can have at most 20 feedback items');
    input.feedback.forEach((item) => { requireText(item.summary, 'feedback summary', 2_000); requireText(item.weakPoint, 'weak point', 2_000); });
    return this.mutate((state) => {
      const resume = state.resumes.find((item) => item.id === input.resumeVersionId);
      if (!resume) throw new Error(`Unknown resume version: ${input.resumeVersionId}`);
      const roleId = input.roleId ?? resume.roleId;
      if (roleId && !state.roles.some((item) => item.id === roleId)) throw new Error(`Unknown role requirements: ${roleId}`);
      const interviewId = randomUUID();
      const recordedAt = input.recordedAt ?? this.now().toISOString();
      const learningRecords = input.feedback.map((feedback): CareerLearningRecord => ({
        id: randomUUID(), assessmentType: 'practice-feedback', reviewStatus: 'needs-review',
        summary: feedback.summary, weakPoint: feedback.weakPoint, source: copy(feedback.source),
        resumeVersionId: resume.id, createdAt: recordedAt, reviewRounds: 0, reviewHistory: [],
        nextReviewAt: addDays(recordedAt, 1), repetition: 0, intervalDays: 1, mastery: 1, reviewState: 'active',
      }));
      const interview: MockInterviewRecord = {
        id: interviewId, resumeVersionId: resume.id, roleId, recordedAt,
        learningRecordIds: learningRecords.map((record) => record.id),
      };
      state.interviews.push(interview);
      state.learningRecords.push(...learningRecords);
      return { interview, learningRecords };
    });
  }

  async listMockInterviews(): Promise<MockInterviewRecord[]> {
    return (await this.read()).interviews;
  }

  async listLearningRecords(): Promise<CareerLearningRecord[]> {
    return (await this.read()).learningRecords;
  }

  async recordLearningReview(id: string, review: { score: number; reviewedAt?: string }): Promise<CareerLearningRecord> {
    if (!Number.isInteger(review.score) || review.score < 0 || review.score > 5) {
      throw new Error('Learning review score must be an integer from 0 to 5');
    }
    return this.mutate((state) => {
      const record = state.learningRecords.find((item) => item.id === id);
      if (!record) throw new Error(`Unknown learning record: ${id}`);
      const entry = { score: review.score, reviewedAt: review.reviewedAt ?? this.now().toISOString() };
      record.latestScore = entry.score;
      record.reviewRounds += 1;
      record.reviewStatus = 'reviewed';
      record.reviewHistory.push(entry);
      const next = calculateNextReview(record, entry.score, new Date(entry.reviewedAt));
      record.repetition = next.repetition;
      record.mastery = next.mastery;
      record.intervalDays = next.intervalDays;
      record.nextReviewAt = next.nextReviewAt;
      record.reviewState = next.status;
      return record;
    });
  }

  private async read(): Promise<CareerState> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
      throw error;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`Career preparation store is invalid; refusing to overwrite: ${this.filePath}`);
    }
    const parsed = StateSchema.safeParse(json);
    if (!parsed.success) throw new Error(`Career preparation store is invalid; refusing to overwrite: ${this.filePath}: ${parsed.error.message}`);
    return {
      ...parsed.data,
      learningRecords: parsed.data.learningRecords.map(normalizeLearningRecord),
    };
  }

  private mutate<T>(operation: (state: CareerState) => T): Promise<T> {
    const pending = this.queue.then(async () => {
      const state = await this.read();
      const result = operation(state);
      const validatedState = StateSchema.parse(state);
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${randomUUID()}.tmp`;
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(validatedState, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(temporary, this.filePath);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
      return copy(result);
    });
    this.queue = pending.catch(() => undefined);
    return pending;
  }
}

function addDays(timestamp: string, days: number): string {
  return new Date(new Date(timestamp).getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Backfill scheduler state for records written before career reviews used the shared
 * repetition algorithm. Existing score/history progress is replayed rather than reset.
 */
function normalizeLearningRecord(record: z.infer<typeof StateSchema>['learningRecords'][number]): CareerLearningRecord {
  const history = [...record.reviewHistory];
  const roundsToRestore = Math.max(record.reviewRounds, history.length);
  const fallbackScore = record.latestScore ?? history.at(-1)?.score;
  const roundsWithoutScoreHistory = history.length === 0 && record.reviewRounds > 0 && fallbackScore === undefined;
  const fallbackTime = history.at(-1)?.reviewedAt ?? record.createdAt;
  while (history.length < roundsToRestore && fallbackScore !== undefined) {
    history.push({ score: fallbackScore, reviewedAt: fallbackTime });
  }

  let schedule: ReturnType<typeof calculateNextReview> = {
    repetition: 0,
    mastery: 1,
    intervalDays: 1,
    nextReviewAt: addDays(record.createdAt, 1),
    status: 'active',
  };
  for (const review of history) {
    schedule = calculateNextReview(schedule, review.score, new Date(review.reviewedAt));
  }

  return {
    ...record,
    reviewHistory: record.reviewHistory,
    repetition: record.repetition ?? (roundsWithoutScoreHistory ? record.reviewRounds : schedule.repetition),
    mastery: record.mastery ?? schedule.mastery,
    intervalDays: record.intervalDays ?? schedule.intervalDays,
    nextReviewAt: record.nextReviewAt ?? schedule.nextReviewAt,
    reviewState: record.reviewState ?? schedule.status,
  };
}

function requireText(value: string, field: string, maxLength: number): void {
  if (typeof value !== 'string' || !value.trim() || Array.from(value).length > maxLength) {
    throw new Error(`${field} must contain 1-${maxLength} characters`);
  }
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
