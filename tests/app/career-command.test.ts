import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { handleSessionCommand } from '../../src/app/command-handler.js';
import { JsonCareerPreparation } from '../../src/core/career-preparation.js';
import { PersonalMemoryStore } from '../../src/core/personal-memory.js';
import { JsonTextMaterialLibrary } from '../../src/core/text-materials.js';
import { JsonBlogAssociations } from '../../src/core/blog-associations.js';
import { parseCommand } from '../../src/core/command-parser.js';
import { CareerReviewSchedulerAdapter } from '../../src/core/review-scheduler.js';

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-os-career-command-'));
  const careerPreparation = new JsonCareerPreparation(join(directory, 'career.json'), () => new Date('2026-10-07T12:00:00.000Z'));
  const replies: string[] = [];
  const bot = { reply: async (_id: string, text: string) => { replies.push(text); return undefined; } } as never;
  const options = {
    runtime: {}, scheduler: {}, config: {}, bot,
    msg: { senderOpenId: 'owner', chatType: 'p2p', messageId: 'message-1', receivedAt: '2026-10-07T12:00:00.000Z' },
    session: { id: 'session-1', status: 'idle' }, cliAdapter: {}, isNew: false, hasThread: false,
    trustedOwnerOpenId: 'owner', careerPreparation,
  } as never;
  return { directory, careerPreparation, replies, options };
}

test('career commands enforce explicit evidence and resume approval, and track mock-interview feedback', async () => {
  const ctx = await setup();
  try {
    assert.deepEqual(parseCommand('/career role Backend Intern | Python;Distributed systems'), { name: 'career', action: 'role', title: 'Backend Intern', requirements: ['Python', 'Distributed systems'] });
    assert.deepEqual(parseCommand('/career material search caching'), { name: 'career', action: 'material-search', query: 'caching' });
    assert.deepEqual(parseCommand('/career evidence confirmed Built a queue worker'), {
      name: 'career', action: 'evidence', status: 'confirmed', claim: 'Built a queue worker',
    });
    assert.deepEqual(parseCommand('/career evidence unconfirmed Reduced latency by 40%'), {
      name: 'career', action: 'evidence', status: 'unconfirmed', claim: 'Reduced latency by 40%',
    });
    assert.equal(parseCommand('/career resume role-1'), undefined);

    await handleSessionCommand({ ...ctx.options, command: parseCommand('/career role Backend Intern') });
    const role = (await ctx.careerPreparation.listRoleRequirements())[0]!;
    await handleSessionCommand({ ...ctx.options, command: parseCommand('/career evidence confirmed Implemented a durable queue') });
    await handleSessionCommand({ ...ctx.options, msg: { ...ctx.options.msg, messageId: 'message-2' }, command: parseCommand('/career evidence unconfirmed Improved throughput by 40%') });
    const [confirmed, unconfirmed] = await ctx.careerPreparation.listEvidence();

    await handleSessionCommand({ ...ctx.options, command: parseCommand(`/career resume ${role.id} ${confirmed!.id},${unconfirmed!.id}`) });
    const proposalId = ctx.replies.at(-1)!.match(/草案 \[([^\]]+)\]/)?.[1];
    assert.ok(proposalId);
    const proposal = await ctx.careerPreparation.getResumeVersion(proposalId!);
    assert.equal(proposal?.claims.length, 1);
    assert.deepEqual(proposal?.excludedEvidenceIds, [unconfirmed!.id]);
    assert.equal(await ctx.careerPreparation.getActiveResumeVersion(), undefined);

    await handleSessionCommand({ ...ctx.options, command: parseCommand(`/career approve ${proposalId}`) });
    assert.equal((await ctx.careerPreparation.getActiveResumeVersion())?.id, proposalId);
    await handleSessionCommand({ ...ctx.options, command: parseCommand(`/career export ${proposalId}`) });
    assert.match(ctx.replies.at(-1)!, /Implemented a durable queue/);
    assert.match(ctx.replies.at(-1)!, /Evidence: user-confirmation:message-1/);

    await handleSessionCommand({
      ...ctx.options,
      msg: { ...ctx.options.msg, messageId: 'interview-1' },
      command: parseCommand(`/career feedback ${proposalId} Explained the tradeoff | Need to review queue backpressure`),
    });
    const learning = (await ctx.careerPreparation.listLearningRecords())[0]!;
    assert.equal(learning.reviewStatus, 'needs-review');
    assert.equal(learning.source.id, 'interview-1');
    assert.equal(learning.assessmentType, 'practice-feedback');
    assert.equal((await ctx.careerPreparation.listEvidence()).length, 2);

    await handleSessionCommand({ ...ctx.options, command: parseCommand(`/career review ${learning.id} 4`) });
    assert.equal((await ctx.careerPreparation.listLearningRecords())[0]?.latestScore, 4);
    assert.equal((await ctx.careerPreparation.listLearningRecords())[0]?.reviewRounds, 1);
  } finally {
    await rm(ctx.directory, { recursive: true, force: true });
  }
});

test('career records are denied in group chats and for non-owner actors', async () => {
  const ctx = await setup();
  try {
    await handleSessionCommand({
      ...ctx.options,
      msg: { ...ctx.options.msg, chatType: 'group' },
      command: parseCommand('/career status'),
    });
    assert.match(ctx.replies.at(-1)!, /仅限所有者在私聊中使用/);
    assert.deepEqual(await ctx.careerPreparation.listEvidence(), []);
    await handleSessionCommand({
      ...ctx.options,
      msg: { ...ctx.options.msg, senderOpenId: 'other' },
      command: parseCommand('/career status'),
    });
    assert.match(ctx.replies.at(-1)!, /仅限所有者在私聊中使用/);
  } finally {
    await rm(ctx.directory, { recursive: true, force: true });
  }
});

test('owner can list a bounded set of due career reviews in private chat', async () => {
  const ctx = await setup();
  try {
    const role = await ctx.careerPreparation.saveRoleRequirements({
      title: 'Backend Intern', requirements: [], source: { kind: 'user-confirmation', id: 'role-source' },
    });
    const evidence = await ctx.careerPreparation.addEvidence({
      claim: 'Built a durable queue', status: 'confirmed', sources: [{ kind: 'user-confirmation', id: 'evidence-source' }],
    });
    const resume = await ctx.careerPreparation.proposeResumeVersion({ roleId: role.id, evidenceIds: [evidence.id] });
    for (let index = 0; index < 7; index += 1) {
      await ctx.careerPreparation.recordMockInterview({
        resumeVersionId: resume.id, recordedAt: '2026-10-06T10:00:00.000Z',
        feedback: [{ summary: `Feedback ${index}`, weakPoint: `Weak point ${index}`, source: { kind: 'mock-interview', id: `interview-${index}` } }],
      });
    }
    const careerReviewScheduler = new CareerReviewSchedulerAdapter(ctx.careerPreparation, () => new Date('2026-10-07T12:00:00.000Z'));
    assert.deepEqual(parseCommand('/career due'), { name: 'career', action: 'due' });
    await handleSessionCommand({ ...ctx.options, careerReviewScheduler, command: parseCommand('/career due') });
    const reply = ctx.replies.at(-1)!;
    assert.match(reply, /最多显示 5 条/);
    assert.match(reply, /Weak point 0/);
    assert.match(reply, /Weak point 4/);
    assert.doesNotMatch(reply, /Weak point 5/);
  } finally {
    await rm(ctx.directory, { recursive: true, force: true });
  }
});

test('career material commands enforce matter scope and preserve line citations until revocation', async () => {
  const ctx = await setup();
  try {
    const personalMemoryStore = new PersonalMemoryStore({ directory: join(ctx.directory, 'memory'), ownerId: 'owner' });
    const careerSpace = await personalMemoryStore.createSpace('求职');
    const otherSpace = await personalMemoryStore.createSpace('阅读');
    const textMaterials = new JsonTextMaterialLibrary(join(ctx.directory, 'materials.json'), 'owner');
    const add = parseCommand(`/career material add ${careerSpace.id} Project Alpha :: Cache invalidation reduced stale reads.`);
    assert.deepEqual(add, { name: 'career', action: 'material-add', spaceId: careerSpace.id, title: 'Project Alpha', content: 'Cache invalidation reduced stale reads.' });
    await handleSessionCommand({ ...ctx.options, personalMemoryStore, textMaterials, command: add });
    const materialId = ctx.replies.at(-1)!.match(/\[([a-f0-9-]+)\]/)?.[1];
    assert.ok(materialId);
    await handleSessionCommand({ ...ctx.options, personalMemoryStore, textMaterials, command: parseCommand('/career material search stale reads') });
    assert.match(ctx.replies.at(-1)!, new RegExp(`${careerSpace.id} L1`));
    assert.match(ctx.replies.at(-1)!, /Cache invalidation reduced stale reads/);

    await handleSessionCommand({
      ...ctx.options, personalMemoryStore, textMaterials,
      session: { ...ctx.options.session, memorySpaceIds: [otherSpace.id] },
      command: parseCommand('/career material search stale reads'),
    });
    assert.equal(ctx.replies.at(-1), '授权范围内没有找到匹配的参考资料。');
    await handleSessionCommand({
      ...ctx.options, personalMemoryStore, textMaterials,
      session: { ...ctx.options.session, memorySpaceIds: [otherSpace.id] },
      command: parseCommand(`/career material revoke ${materialId}`),
    });
    assert.ok(await textMaterials.readExcerpt(materialId!, { start: 1, end: 1 }, [careerSpace.id]));
    assert.match(ctx.replies.at(-1)!, /没有找到授权范围/);
    const blogAssociations = new JsonBlogAssociations(join(ctx.directory, 'blog.json'));
    const proposal = blogAssociations.proposeAssociation({
      initiatedBy: 'user', operationId: 'material-source-proposal', actorId: 'owner',
      createdAt: '2026-10-07T12:00:00.000Z', authorizedSpaceIds: [careerSpace.id, otherSpace.id],
      sources: [
        { kind: 'material', id: materialId!, spaceId: careerSpace.id },
        { kind: 'daily-record', id: 'another-source', spaceId: otherSpace.id },
      ], reasoning: 'Potential relation.', intendedUse: 'Private blog draft.',
    });
    await handleSessionCommand({ ...ctx.options, personalMemoryStore, textMaterials, blogAssociations, command: parseCommand(`/career material revoke ${materialId}`) });
    assert.match(ctx.replies.at(-1)!, /博客引用也已失效/);
    assert.equal(blogAssociations.areProposalSourcesActive(proposal.id), false);
    assert.equal(await textMaterials.readExcerpt(materialId!, { start: 1, end: 1 }, [careerSpace.id]), undefined);
    assert.deepEqual(textMaterials.search('stale reads', [careerSpace.id]), []);
  } finally {
    await rm(ctx.directory, { recursive: true, force: true });
  }
});
