import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CareerFeedbackToolBridge } from '../../src/app/career-feedback-tool-bridge.js';
import { JsonCareerPreparation } from '../../src/core/career-preparation.js';

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'career-feedback-bridge-'));
  const career = new JsonCareerPreparation(join(directory, 'career.json'), () => new Date('2026-10-07T12:00:00.000Z'));
  const role = await career.saveRoleRequirements({ title: 'Backend Intern', requirements: [] });
  const evidence = await career.addEvidence({
    claim: 'Built an idempotent processing worker.', status: 'confirmed',
    sources: [{ kind: 'project-record', id: 'project-1' }],
  });
  const resume = await career.proposeResumeVersion({ roleId: role.id, evidenceIds: [evidence.id] });
  const bridge = new CareerFeedbackToolBridge(career);
  const port = await bridge.start();
  return { directory, career, bridge, port, resume };
}

test('owner-authorized NL interview feedback becomes reviewable learning, never resume evidence', async () => {
  const ctx = await setup();
  const invocation = ctx.bridge.issue({
    actorId: 'owner', ownerId: 'owner', sourceId: 'message-42',
    receivedAt: '2026-10-07T12:00:00.000Z', resumeVersionId: ctx.resume.id,
  });
  try {
    const response = await fetch(`http://127.0.0.1:${ctx.port}/api/career/interview-feedback`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-career-feedback-token': invocation.token },
      body: JSON.stringify({ summary: 'Answered the design tradeoff clearly.', weakPoint: 'Explain retry exhaustion behavior.', locator: 'question-3' }),
    });
    assert.equal(response.status, 201);
    const result = await response.json() as { status: string; learningRecordId: string; reviewStatus: string; assessmentType: string };
    assert.equal(result.status, 'saved');
    assert.equal(result.reviewStatus, 'needs-review');
    assert.equal(result.assessmentType, 'practice-feedback');
    const learning = (await ctx.career.listLearningRecords())[0]!;
    assert.equal(learning.id, result.learningRecordId);
    assert.equal(learning.source.id, 'message-42');
    assert.equal(learning.source.locator, 'question-3');
    assert.equal(learning.weakPoint, 'Explain retry exhaustion behavior.');
    const duplicate = await fetch(`http://127.0.0.1:${ctx.port}/api/career/interview-feedback`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-career-feedback-token': invocation.token },
      body: JSON.stringify({ summary: 'duplicate', weakPoint: 'duplicate' }),
    });
    assert.equal(duplicate.status, 401);
    assert.deepEqual((await ctx.career.listEvidence()).map((item) => item.claim), ['Built an idempotent processing worker.']);
    const next = await ctx.career.proposeResumeVersion({ roleId: ctx.resume.roleId, evidenceIds: [learning.id] }).catch((error: Error) => error);
    assert.match((next as Error).message, /Unknown career evidence/);
    assert.equal((await ctx.career.listEvidence()).length, 1);
  } finally {
    invocation.release();
    await ctx.bridge.close();
    await rm(ctx.directory, { recursive: true, force: true });
  }
});

test('career feedback bridge rejects non-owner, released or invalid requests without persistence', async () => {
  const ctx = await setup();
  const nonOwner = ctx.bridge.issue({ actorId: 'guest', ownerId: 'owner', sourceId: 'group-msg', receivedAt: '2026-10-07T12:00:00.000Z', resumeVersionId: ctx.resume.id });
  const owner = ctx.bridge.issue({ actorId: 'owner', ownerId: 'owner', sourceId: 'owner-msg', receivedAt: '2026-10-07T12:00:00.000Z', resumeVersionId: ctx.resume.id });
  try {
    const forbidden = await fetch(`http://127.0.0.1:${ctx.port}/api/career/interview-feedback`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-career-feedback-token': nonOwner.token },
      body: JSON.stringify({ summary: 'x', weakPoint: 'y' }),
    });
    assert.equal(forbidden.status, 403);
    const invalid = await fetch(`http://127.0.0.1:${ctx.port}/api/career/interview-feedback`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-career-feedback-token': owner.token },
      body: JSON.stringify({ summary: 'x', weakPoint: '' }),
    });
    assert.equal(invalid.status, 400);
    owner.release();
    const released = await fetch(`http://127.0.0.1:${ctx.port}/api/career/interview-feedback`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-career-feedback-token': owner.token },
      body: JSON.stringify({ summary: 'x', weakPoint: 'y' }),
    });
    assert.equal(released.status, 401);
    assert.deepEqual(await ctx.career.listLearningRecords(), []);
  } finally {
    nonOwner.release();
    owner.release();
    await ctx.bridge.close();
    await rm(ctx.directory, { recursive: true, force: true });
  }
});
