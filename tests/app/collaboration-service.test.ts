import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CollaborationService } from '../../src/app/collaboration-service.js';
import { CollaborationInbox } from '../../src/core/collaboration.js';
import type { AppRuntime } from '../../src/app/runtime.js';

function setup() {
  const inbox = new CollaborationInbox();
  const sentMentions: Array<{ chatId: string; text: string; target: string }> = [];
  const runtime = {
    collaborationInbox: inbox,
    botRuntimes: new Map([
      ['lead', { config: { id: 'lead' }, identity: { openId: 'lead-open', name: 'Lead' }, bot: {} }],
      ['worker', { config: { id: 'worker' }, identity: { openId: 'worker-open', name: 'Worker' }, bot: {} }],
    ]),
  } as unknown as AppRuntime;
  const senderBot = {
    sendMentionToChat: async (chatId: string, target: { openId: string }, text: string) => {
      sentMentions.push({ chatId, text, target: target.openId });
      return 'mention-message';
    },
  };
  return { inbox, sentMentions, runtime, senderBot };
}

test('collaboration dispatch registers trusted workflow metadata before notifying target bot', async () => {
  const ctx = setup();
  try {
    await new CollaborationService(ctx.runtime).dispatch({
      senderConfig: { id: 'lead' } as never,
      senderBot: ctx.senderBot as never,
      chatId: 'owner-chat', skipCard: true,
      targetBotId: 'worker', taskId: 'workflow-123', ownerOpenId: 'owner', ownerUnionId: 'union-owner',
      reportToBotId: 'lead', objective: 'Review project', instruction: 'Inspect the evidence',
      expectedOutput: 'List risks', round: 1, maxRounds: 3, workspaceDir: '/private/project',
    });
    assert.equal(ctx.sentMentions.length, 1);
    assert.equal(ctx.sentMentions[0]?.chatId, 'owner-chat');
    assert.equal(ctx.sentMentions[0]?.target, 'worker-open');
    const dispatchId = ctx.sentMentions[0]?.text.match(/任务编号：([a-f0-9]{12})/)?.[1];
    assert.ok(dispatchId);
    const delivered = ctx.inbox.consume(dispatchId!, 'worker');
    assert.equal(delivered?.taskId, 'workflow-123');
    assert.equal(delivered?.ownerOpenId, 'owner');
    assert.equal(delivered?.ownerUnionId, 'union-owner');
    assert.equal(delivered?.fromBotId, 'lead');
    assert.equal(delivered?.toBotId, 'worker');
    assert.equal(delivered?.workspaceDir, '/private/project');
    assert.equal(ctx.inbox.consume(dispatchId!, 'worker'), undefined);
  } finally { /* no filesystem or live transport used */ }
});

test('failed collaboration notification removes pending inbox authorization', async () => {
  const ctx = setup();
  let failedDispatchId: string | undefined;
  const failedSender = { sendMentionToChat: async (_chatId: string, _target: { openId: string }, text: string) => {
    failedDispatchId = text.match(/任务编号：([a-f0-9]{12})/)?.[1];
    return undefined;
  } };
  await assert.rejects(new CollaborationService(ctx.runtime).dispatch({
    senderConfig: { id: 'lead' } as never,
    senderBot: failedSender as never,
    chatId: 'owner-chat', skipCard: true,
    targetBotId: 'worker', taskId: 'workflow-456', ownerOpenId: 'owner',
    reportToBotId: 'lead', objective: 'Review project', instruction: 'Inspect the evidence',
    round: 1, maxRounds: 3, workspaceDir: '/private/project',
  }), /没有返回协作通知 message_id/);
  assert.ok(failedDispatchId);
  assert.equal(ctx.inbox.consume(failedDispatchId!, 'worker'), undefined);
});
