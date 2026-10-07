import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JsonCareerPreparation } from '../../src/core/career-preparation.js';

async function withStore<T>(run: (filePath: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'career-preparation-'));
  try {
    return await run(join(directory, 'career.json'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const confirmedSource = { kind: 'project-record' as const, id: 'project-alpha', version: 'v3', locator: 'README.md#contribution' };
const unconfirmedSource = { kind: 'mock-interview' as const, id: 'practice-1', locator: 'turn-4' };

test('resume proposals include confirmed claims with source refs and omit unconfirmed evidence', async () => {
  await withStore(async (filePath) => {
    const career = new JsonCareerPreparation(filePath);
    const confirmed = await career.addEvidence({
      claim: 'Designed the retry policy for the ingestion worker.',
      status: 'confirmed',
      sources: [confirmedSource],
    });
    const unconfirmed = await career.addEvidence({
      claim: 'Led the entire platform migration and reduced costs by 40%.',
      status: 'unconfirmed',
      sources: [unconfirmedSource],
    });
    const role = await career.saveRoleRequirements({ title: 'Backend Intern', requirements: ['Distributed systems'] });

    const proposal = await career.proposeResumeVersion({ roleId: role.id, evidenceIds: [confirmed.id, unconfirmed.id] });

    assert.deepEqual(proposal.claims.map((item) => item.text), ['Designed the retry policy for the ingestion worker.']);
    assert.deepEqual(proposal.claims[0]?.sources, [confirmedSource]);
    assert.deepEqual(proposal.excludedEvidenceIds, [unconfirmed.id]);
    assert.equal((await career.getActiveResumeVersion()), undefined);
  });
});

test('only explicit approval activates a proposed resume version', async () => {
  await withStore(async (filePath) => {
    const career = new JsonCareerPreparation(filePath);
    const evidence = await career.addEvidence({ claim: 'Implemented a bounded retry queue.', status: 'confirmed', sources: [confirmedSource] });
    const role = await career.saveRoleRequirements({ title: 'Backend Intern', requirements: ['Reliability'] });
    const proposal = await career.proposeResumeVersion({ roleId: role.id, evidenceIds: [evidence.id] });

    assert.equal(await career.getActiveResumeVersion(), undefined);
    await career.approveResumeVersion(proposal.id, { approvedBy: 'user', approvedAt: '2026-10-08T08:00:00.000Z' });
    assert.equal((await career.getActiveResumeVersion())?.id, proposal.id);
    assert.equal((await career.getResumeVersion(proposal.id))?.status, 'active');
  });
});

test('mock-interview weaknesses remain reviewable learning records, not confirmed evidence, and review progress survives reopen', async () => {
  await withStore(async (filePath) => {
    let career = new JsonCareerPreparation(filePath);
    const evidence = await career.addEvidence({ claim: 'Added idempotency keys to retry processing.', status: 'confirmed', sources: [confirmedSource] });
    const role = await career.saveRoleRequirements({ title: 'Backend Intern', requirements: ['Reliability'] });
    const resume = await career.proposeResumeVersion({ roleId: role.id, evidenceIds: [evidence.id] });
    const interview = await career.recordMockInterview({
      resumeVersionId: resume.id,
      feedback: [{
        summary: 'The explanation moved too quickly through failure recovery.',
        weakPoint: 'Explain how duplicate deliveries are detected.',
        source: { kind: 'mock-interview', id: 'session-1', locator: 'question-2' },
      }],
      recordedAt: '2026-10-08T09:00:00.000Z',
    });
    const learning = interview.learningRecords[0]!;
    assert.equal(learning.reviewStatus, 'needs-review');
    assert.equal(learning.assessmentType, 'practice-feedback');
    assert.equal((await career.listEvidence()).length, 1);

    await career.recordLearningReview(learning.id, { score: 2, reviewedAt: '2026-10-08T10:00:00.000Z' });
    career = new JsonCareerPreparation(filePath);
    const reopened = (await career.listLearningRecords())[0]!;
    assert.equal(reopened.latestScore, 2);
    assert.equal(reopened.reviewRounds, 1);
    assert.equal(reopened.reviewStatus, 'reviewed');
    assert.equal(reopened.source.id, 'session-1');
    assert.equal((await career.listEvidence()).length, 1);
  });
});

test('practice feedback can be retained without binding it to an approved resume', async () => {
  await withStore(async (filePath) => {
    const career = new JsonCareerPreparation(filePath, () => new Date('2026-10-07T12:00:00.000Z'));
    const result = await career.recordMockInterview({
      feedback: [{ summary: 'Good structure.', weakPoint: 'Explain the tradeoff.', source: { kind: 'mock-interview', id: 'unbound-session' } }],
    });
    assert.equal(result.interview.resumeVersionId, undefined);
    assert.equal(result.learningRecords[0]?.resumeVersionId, undefined);
    assert.equal(result.learningRecords[0]?.assessmentType, 'practice-feedback');
    assert.equal((await career.listEvidence()).length, 0);
    const reopened = new JsonCareerPreparation(filePath);
    assert.equal((await reopened.listLearningRecords())[0]?.source.id, 'unbound-session');
  });
});

test('learning review rejects scores outside the five-point scale without changing progress', async () => {
  await withStore(async (filePath) => {
    const career = new JsonCareerPreparation(filePath);
    const role = await career.saveRoleRequirements({ title: 'Backend Intern', requirements: [] });
    const resume = await career.proposeResumeVersion({ roleId: role.id, evidenceIds: [] });
    const interview = await career.recordMockInterview({
      resumeVersionId: resume.id,
      roleId: role.id,
      feedback: [{
        summary: 'Needs more precision.',
        weakPoint: 'State the trade-off explicitly.',
        source: { kind: 'mock-interview', id: 'session-2' },
      }],
    });
    const learning = interview.learningRecords[0]!;
    await assert.rejects(career.recordLearningReview(learning.id, { score: 6 }), /0.*5/);
    assert.equal((await career.listLearningRecords())[0]?.reviewRounds, 0);
  });
});


test('invalid domain input is rejected before persistence and does not poison later reads', async () => {
  await withStore(async (filePath) => {
    const career = new JsonCareerPreparation(filePath);
    await assert.rejects(career.addEvidence({ claim: '', status: 'confirmed', sources: [confirmedSource] }));
    const valid = await career.addEvidence({ claim: 'Confirmed contribution.', status: 'confirmed', sources: [confirmedSource] });
    assert.equal((await career.listEvidence())[0]?.id, valid.id);
  });
});


test('legacy learning records backfill schedule state without dropping prior review progress', async () => {
  await withStore(async (filePath) => {
    const career = new JsonCareerPreparation(filePath);
    const role = await career.saveRoleRequirements({ title: 'Backend Intern', requirements: [] });
    const resume = await career.proposeResumeVersion({ roleId: role.id, evidenceIds: [] });
    const { learningRecords } = await career.recordMockInterview({
      resumeVersionId: resume.id,
      feedback: [{ summary: 'Needs detail.', weakPoint: 'Explain retries.', source: unconfirmedSource }],
      recordedAt: '2026-10-01T00:00:00.000Z',
    });
    const learning = learningRecords[0]!;
    await career.recordLearningReview(learning.id, { score: 3, reviewedAt: '2026-10-02T00:00:00.000Z' });
    await career.recordLearningReview(learning.id, { score: 4, reviewedAt: '2026-10-05T00:00:00.000Z' });

    const legacy = JSON.parse(await readFile(filePath, 'utf8')) as { learningRecords: Array<Record<string, unknown>> };
    const persisted = legacy.learningRecords[0]!;
    delete persisted.nextReviewAt;
    delete persisted.repetition;
    delete persisted.intervalDays;
    delete persisted.mastery;
    delete persisted.reviewState;
    await writeFile(filePath, `${JSON.stringify(legacy)}\n`, 'utf8');

    const reopened = new JsonCareerPreparation(filePath);
    const restored = (await reopened.listLearningRecords())[0]!;
    assert.equal(restored.reviewRounds, 2);
    assert.deepEqual(restored.reviewHistory, [
      { score: 3, reviewedAt: '2026-10-02T00:00:00.000Z' },
      { score: 4, reviewedAt: '2026-10-05T00:00:00.000Z' },
    ]);
    assert.equal(restored.latestScore, 4);
    assert.equal(restored.repetition, 2);
    assert.equal(restored.intervalDays, 7);
    assert.equal(restored.nextReviewAt, '2026-10-12T00:00:00.000Z');
  });
});
