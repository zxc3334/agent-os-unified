import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { handleSessionCommand } from '../../src/app/command-handler.js';
import { JsonCareerPreparation } from '../../src/core/career-preparation.js';
import { parseCommand } from '../../src/core/command-parser.js';

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
