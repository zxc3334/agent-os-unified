import { runCli } from '../cli/runner.js';
import { getCliAdapter } from '../cli/registry.js';
import { buildBotPrompt } from '../core/bot-registry.js';
import { persistMemorySubmission } from '../core/persist-memory.js';
import { advanceCursors, listDialogueProjects, pendingDialogues } from '../core/dialogue-store.js';
import { resolve } from 'node:path';
import type { AppRuntime } from './runtime.js';
import type { ScheduledTask } from '../core/schedule.js';
import { markSessionIdle } from './session-view.js';
import { UnifiedTaskRuntime } from './unified-task-runtime.js';
import type { CliRunResult } from '../cli/types.js';

export async function runScheduledTaskDirectly(options: {
  runtime: AppRuntime;
  task: ScheduledTask;
  scheduledFor: string;
  defaultProductDeliveryMode: 'local' | 'lark-doc';
}): Promise<{ sessionId?: string }> {
  const { runtime, task, scheduledFor } = options;
  const target = runtime.teamRegistry.get(task.targetBotId);
  if (!target) {
    throw new Error(`定时任务目标成员未注册或未启用: ${task.targetBotId}`);
  }

  const messageAddress = {
    messageId: `scheduled-${task.id}`,
    chatId: task.chatId,
    threadId: `scheduled-${task.id}`,
    rootId: '',
  };
  const resolved = await runtime.sessions.resolve(
    messageAddress,
    target.defaultCliId,
    target.id,
    target.workspaceDir,
  );
  let { session } = resolved;
  if (resolved.isNew && session.status === 'creating') {
    session = await runtime.sessions.transition(session.id, 'idle');
  }
  if (session.status === 'active') {
    throw new Error('目标 bot 当前会话仍在执行');
  }
  await runtime.sessions.transition(session.id, 'active');

  const prompt = buildBotPrompt(
    target,
    [
      `这是一条由 Agent OS 发起的定时任务，计划触发时间：${scheduledFor}。`,
      task.prompt,
      '直接执行任务要求；如果任务要求把结果推送给你或其他用户，请自行完成推送。',
    ].join('\n\n'),
    runtime.teamRegistry.contextFor(target.id),
    options.defaultProductDeliveryMode,
  );
  const adapter = getCliAdapter(session.cliId);
  const run = new AbortController();
  try {
    const taskExecution = await new UnifiedTaskRuntime<void>({
      store: runtime.unifiedTaskStore,
      memoryContext: { prepare: async () => undefined },
      executor: {
        execute: async ({ signal }) => ({
          outcome: 'succeeded',
          result: await runCli({
            adapter,
            prompt,
            cwd: session.workspaceDir,
            // 定时任务不续跑 CLI 历史会话，避免旧任务上下文污染新一轮。
            sessionId: undefined,
            signal,
            env: {
              AGENT_OS_CHAT_ID: task.chatId,
              AGENT_OS_OWNER_OPEN_ID: task.creatorOpenId,
              AGENT_OS_HOME: resolve(import.meta.dirname, '..', '..'),
            },
            onEvent: (event) => {
              if (event.type === 'tool_start') {
                console.log(`[定时] ${task.id} 开始 ${event.label}${'detail' in event && event.detail ? ` ${event.detail}` : ''}`);
              }
            },
          }),
          artifacts: [],
        }),
      },
    }).run({
      trusted: { actorId: task.creatorOpenId, ownerId: task.creatorOpenId },
      affairId: `schedule:${task.id}`,
      trigger: { source: 'schedule', sourceId: `${task.id}:${scheduledFor}`, occurredAt: scheduledFor },
      authorizedMemorySpaceIds: [],
      input: { scheduleId: task.id, targetBotId: target.id },
      signal: run.signal,
    });
    if (taskExecution.status === 'failed') throw new Error(taskExecution.error ?? 'Scheduled task failed');
    if (taskExecution.status === 'cancelled') throw new Error('Scheduled task cancelled');
    const result = taskExecution.result as CliRunResult;
    // 不把 CLI 会话 id 存回会话记录：定时任务每次都是全新会话，
    // 存回去只会让下一轮又续跑上一个（第一次已踩坑）。
    if (result.stats?.contextWindowTokens) {
      runtime.contextWindows.set(session.id, result.stats.contextWindowTokens);
    }
    // 定时路径也要处理 save_memory 的落盘。
    // 之前只接了普通消息路径，导致定时提取「工具受理了但没人写文件」。
    try {
      const outcome = await persistMemorySubmission({
        toolCalls: result.toolCalls,
        fallbackProject: target.project,
      });
      if (outcome.saved) {
        console.log(`[定时] ${task.id} 已沉淀记忆 project=${outcome.project} topic=${outcome.topic}`);
      }
    } catch (error) {
      console.error(`[定时] ${task.id} 记忆落盘失败:`, (error as Error).message);
    }
    // 推进游标：任务成功后，把「有新增对话」的项目的游标推到当前条数。
    // 必须成功后才推进 —— 失败时推进会永久跳过未处理的对话。
    // 「读了但没有值得记的」也算处理完，否则下次会重复读同一批。
    try {
      const projects = await listDialogueProjects();
      const withPending: string[] = [];
      for (const project of projects) {
        const { records } = await pendingDialogues(project);
        if (records.length > 0) withPending.push(project);
      }
      if (withPending.length > 0) {
        const cursors = await advanceCursors(withPending);
        console.log(`[定时] ${task.id} 游标已推进: ${withPending.map((p) => `${p}=${cursors[p]}`).join(' ')}`);
      }
    } catch (error) {
      console.error(`[定时] ${task.id} 游标推进失败:`, (error as Error).message);
    }
    console.log(`[定时] ${task.id} 直接执行完成`);
    return { sessionId: result.sessionId };
  } finally {
    await markSessionIdle(runtime.sessions, session.id);
  }
}
