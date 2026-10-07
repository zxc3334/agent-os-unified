import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

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
    return parsed.data;
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

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
