import type { Bot, IncomingMessage } from "../im/lark.js";
import {
  buildResumeCard,
  buildSessionNoticeCard,
  buildScheduleListCard,
  buildTeamCard,
} from "../im/card.js";
import type { CliAdapter } from "../cli/types.js";
import { getCliAdapter } from "../cli/registry.js";
import { listNativeCliSessions } from "../cli/native-sessions.js";
import type { CliRequest, SlashCommand } from "../core/command-parser.js";
import type { Session } from "../core/session-manager.js";
import type { BotConfig } from "../core/bot-registry.js";
import {
  ensureWorkspaceDirectory,
  resolveWorkspacePath,
} from "../core/workspace.js";
import { formatSessionStatus } from "./session-view.js";
import type { AppRuntime } from "./runtime.js";
import type { Scheduler } from "./scheduler.js";
import type { PersonalMemoryStore } from "../core/personal-memory.js";

export type CommandOutcome = "handled" | "continue";

export async function handleSessionCommand(options: {
  runtime: AppRuntime;
  scheduler: Scheduler;
  config: BotConfig;
  msg: IncomingMessage;
  bot: Bot;
  session: Session;
  cliAdapter: CliAdapter;
  command?: SlashCommand;
  cliRequest?: CliRequest;
  isNew: boolean;
  hasThread: boolean;
  personalMemoryStore?: PersonalMemoryStore;
  trustedOwnerOpenId?: string;
}): Promise<CommandOutcome> {
  const {
    runtime,
    scheduler,
    config,
    msg,
    bot,
    session,
    cliAdapter,
    command,
    cliRequest,
    isNew,
    hasThread,
    personalMemoryStore,
    trustedOwnerOpenId,
  } = options;

  if (!isNew && cliRequest && cliRequest.cliId !== session.cliId) {
    await bot.reply(
      msg.messageId,
      `当前话题已经在使用 ${cliAdapter.displayName}。如需切换执行引擎，请新开一个话题。`,
      hasThread,
    );
    return "handled";
  }

  if (command?.name === "memory") {
    if (!trustedOwnerOpenId || msg.senderOpenId !== trustedOwnerOpenId) {
      await bot.reply(msg.messageId, "个人记忆命令仅限配置的所有者使用。", hasThread);
      return "handled";
    }
    if (!personalMemoryStore) {
      await bot.reply(msg.messageId, "个人记忆暂不可用，请检查本地存储配置。", hasThread);
      return "handled";
    }
    const safe = (value: string, max = 700) => Array.from(value.replace(/[\r\n\t\u0000-\u001f\u007f]/g, " ")).slice(0, max).join("");
    try {
      const spaces = await personalMemoryStore.listSpaces();
      const authorizedSpaceIds = spaces.map((space) => space.id);
      const names = new Map(spaces.map((space) => [space.id, space.name]));
      if (command.action === "review" || command.action === "recent") {
        const pageSize = 5;
        const fetchLimit = command.page * pageSize;
        const all = command.action === "review"
          ? await personalMemoryStore.listForReview({ authorizedSpaceIds, limit: fetchLimit })
          : await personalMemoryStore.listRecent({ authorizedSpaceIds, limit: fetchLimit });
        const entries = all.slice((command.page - 1) * pageSize, command.page * pageSize);
        const title = command.action === "review" ? "待确认记忆" : "最近记忆";
        const lines = entries.map((entry, index) => {
          const source = entry.sources.map((item) => item.sourceId).join(", ") || "无来源";
          return `${(command.page - 1) * pageSize + index + 1}. [${entry.id}] 来源：${safe(source, 180)}；空间：${safe(names.get(entry.spaceId) ?? "未知空间", 100)}；置信：${entry.confidence}；状态：${entry.status}；内容：${safe(entry.content)}`;
        });
        const next = command.page < 10 && all.length === fetchLimit ? `\n下一页：/memory ${command.action} ${command.page + 1}` : "";
        await bot.reply(msg.messageId, lines.length ? `${title}（第 ${command.page} 页，每页最多 5 条）\n${lines.join("\n")}${next}` : `${title}：没有更多记录。`, hasThread);
        return "handled";
      }
      if (!("entryId" in command)) return "handled";
      const entry = await personalMemoryStore.get(command.entryId, { authorizedSpaceIds });
      if (!entry) {
        await bot.reply(msg.messageId, "没有找到可操作的有效记忆。", hasThread);
        return "handled";
      }
      let resultMessage: string;
      if (command.action === "confirm") {
        await personalMemoryStore.confirm(entry.id, entry.version);
        resultMessage = "记忆已确认。";
      } else if (command.action === "correct") {
        await personalMemoryStore.correct(entry.id, entry.version, {
          content: command.content,
          source: {
            sourceId: msg.messageId,
            actorId: trustedOwnerOpenId,
            receivedAt: new Date().toISOString(),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
            excerpt: command.content,
          },
        });
        resultMessage = "记忆已更正。";
      } else if (command.action === "reject") {
        const rejected = await personalMemoryStore.reject(entry.id, entry.version);
        resultMessage = rejected ? "已拒绝该候选；来源记录未删除。" : "该记忆已不再有效。";
      } else {
        const forgotten = await personalMemoryStore.forget(entry.id, entry.version);
        resultMessage = forgotten ? "已忘记该记忆，内容已清除并抑制同一来源重新提取。" : "该记忆已经忘记。";
      }
      const updated = await personalMemoryStore.get(entry.id, { authorizedSpaceIds });
      if (updated) {
        const source = updated.sources.map((item) => item.sourceId).join(", ") || "无来源";
        resultMessage += `\n来源：${safe(source, 180)}；空间：${safe(names.get(updated.spaceId) ?? "未知空间", 100)}；置信：${updated.confidence}；状态：${updated.status}；内容：${safe(updated.content)}`;
      }
      await bot.reply(msg.messageId, resultMessage, hasThread);
    } catch (error) {
      await bot.reply(msg.messageId, `记忆操作失败，未确认成功：${safe((error as Error).message, 300)}`, hasThread);
    }
    return "handled";
  }

  if (command?.name === "help") {
    await bot.reply(
      msg.messageId,
      [
        "/status 查看当前会话",
        "/team 查看当前 Agent 团队",
        "/schedule <需求> 创建定时任务",
        "/schedules 查看定时任务",
        "/topics 扫描有哪些素材够写一篇博客了",
        "/memory [review|recent] [页码] 查看待确认或最近记忆（每页最多 5 条）",
        "/memory confirm <id>、/memory correct <id> <内容>、/memory reject <id>、/memory forget <id>",
        "/schedule pause <id> 暂停定时任务",
        "/schedule resume <id> 恢复定时任务",
        "/schedule delete <id> 删除定时任务",
        "/schedule run <id> 立即执行定时任务",
        "/new 开启一个全新的 CLI 会话",
        "/resume 选择当前工作目录中的 CLI 会话",
        "/compact [要求] 使用当前引擎原生整理上下文",
        "/cd 查看当前工作目录",
        "/cd <目录> 切换当前话题的工作目录",
        "/close 关闭当前会话",
        "/help 查看命令",
        "/agy <任务> 新话题使用 Antigravity (agy)",
        "/pi <任务> 新话题使用 Pi",
        "/claude <任务> 新话题使用 Claude Code",
        "/codex <任务> 新话题使用 Codex",
      ].join("\n"),
      hasThread,
    );
    return "handled";
  }

  if (command?.name === "team") {
    await bot.replyCard(
      msg.messageId,
      buildTeamCard({
        members: runtime.teamRegistry.members.map((member) => {
          const memberRuntime = runtime.botRuntimes.get(member.id);
          return {
            id: member.id,
            displayName: memberRuntime?.identity.name ?? member.id,
            role: member.role,
            cliName: getCliAdapter(member.defaultCliId).displayName,
            skills: member.skills,
            isLeader: member.id === runtime.teamRegistry.leaderBotId,
            ready: !!memberRuntime,
          };
        }),
      }),
      hasThread,
    );
    return "handled";
  }

  if (command?.name === "schedules") {
    await bot.replyCard(
      msg.messageId,
      buildScheduleListCard(scheduler.list()),
      hasThread,
    );
    return "handled";
  }

  if (command?.name === "schedule" && !command.request) {
    await bot.reply(
      msg.messageId,
      [
        "用法：/schedule <需求>",
        "例如：/schedule 每小时检查一次服务日志",
        "管理：/schedules、/schedule pause <id>、/schedule resume <id>、/schedule delete <id>、/schedule run <id>",
      ].join("\n"),
      hasThread,
    );
    return "handled";
  }

  if (command?.name === "schedule" && command.request) {
    const request = command.request;
    const pause = /^pause\s+([a-z0-9_-]+)$/i.exec(request);
    const resume = /^resume\s+([a-z0-9_-]+)$/i.exec(request);
    const remove = /^delete\s+([a-z0-9_-]+)$/i.exec(request);
    const run = /^run\s+([a-z0-9_-]+)$/i.exec(request);
    if (pause) {
      const task = scheduler.pause(pause[1]);
      await bot.reply(
        msg.messageId,
        task ? `定时任务 ${task.id} 已暂停。` : "没有找到这个定时任务。",
        hasThread,
      );
      return "handled";
    }
    if (resume) {
      const task = scheduler.resume(resume[1]);
      await bot.reply(
        msg.messageId,
        task ? `定时任务 ${task.id} 已恢复。` : "没有找到这个定时任务。",
        hasThread,
      );
      return "handled";
    }
    if (remove) {
      const deleted = scheduler.delete(remove[1]);
      await bot.reply(
        msg.messageId,
        deleted ? `定时任务 ${remove[1]} 已删除。` : "没有找到这个定时任务。",
        hasThread,
      );
      return "handled";
    }
    if (run) {
      const task = await scheduler.runNow(run[1]);
      await bot.reply(
        msg.messageId,
        task ? `定时任务 ${task.id} 已触发执行。` : "没有找到这个定时任务。",
        hasThread,
      );
      return "handled";
    }
    return "continue";
  }

  if (command?.name === "new") {
    if (session.status === "active") {
      await bot.reply(msg.messageId, "当前任务结束后才能新建会话。", hasThread);
      return "handled";
    }
    if (session.status === "closed") {
      await bot.reply(msg.messageId, "当前话题的会话已经关闭。", hasThread);
      return "handled";
    }
    await runtime.sessions.clearCliSessionId(session.id);
    await bot.replyCard(
      msg.messageId,
      buildSessionNoticeCard({
        title: "新会话已就绪",
        template: "green",
        detail: `下一条任务会由 ${cliAdapter.displayName} 开启全新的 CLI 会话。\n\n旧会话仍然保留，可以随时用 \`/resume\` 找回来。`,
      }),
      hasThread,
    );
    return "handled";
  }

  if (command?.name === "resume") {
    if (session.status === "active") {
      await bot.reply(msg.messageId, "当前任务结束后才能切换会话。", hasThread);
      return "handled";
    }
    if (session.status === "closed") {
      await bot.reply(msg.messageId, "当前话题的会话已经关闭。", hasThread);
      return "handled";
    }
    try {
      const nativeSessions = await listNativeCliSessions({
        adapter: cliAdapter,
        cwd: session.workspaceDir,
      });
      await bot.replyCard(
        msg.messageId,
        buildResumeCard({
          agentSessionId: session.id,
          cliName: cliAdapter.displayName,
          currentCliSessionId: session.cliSessionId,
          sessions: nativeSessions,
        }),
        hasThread,
      );
    } catch (error) {
      await bot.reply(
        msg.messageId,
        `无法读取 ${cliAdapter.displayName} 会话：${(error as Error).message}`,
        hasThread,
      );
    }
    return "handled";
  }

  if (command?.name === "compact") {
    if (session.status === "active") {
      await bot.reply(
        msg.messageId,
        "当前任务结束后才能整理上下文。",
        hasThread,
      );
      return "handled";
    }
    if (session.status === "closed") {
      await bot.reply(msg.messageId, "当前话题的会话已经关闭。", hasThread);
      return "handled";
    }
    if (!session.cliSessionId) {
      await bot.reply(
        msg.messageId,
        "当前还没有可整理的 CLI 会话。先完成一次任务，再使用 /compact。",
        hasThread,
      );
      return "handled";
    }
    return "continue";
  }

  if (command?.name === "status") {
    await bot.reply(
      msg.messageId,
      formatSessionStatus(session, config.id),
      hasThread,
    );
    return "handled";
  }

  if (command?.name === "cd") {
    if (!command.path) {
      await bot.reply(
        msg.messageId,
        `当前工作目录：${session.workspaceDir}`,
        hasThread,
      );
      return "handled";
    }
    if (session.status === "active") {
      await bot.reply(
        msg.messageId,
        "当前任务仍在执行，结束后再切换工作目录。",
        hasThread,
      );
      return "handled";
    }
    try {
      const workspaceDir = resolveWorkspacePath(
        command.path,
        session.workspaceDir,
      );
      await ensureWorkspaceDirectory(workspaceDir);
      const changed = workspaceDir !== session.workspaceDir;
      await runtime.sessions.setWorkspaceDir(session.id, workspaceDir);
      await bot.reply(
        msg.messageId,
        changed
          ? `工作目录已切换到：${workspaceDir}\n下一条任务会在这里建立新的 CLI 会话。`
          : `当前工作目录已经是：${workspaceDir}`,
        hasThread,
      );
    } catch (error) {
      await bot.reply(
        msg.messageId,
        `无法切换工作目录：${(error as Error).message}`,
        hasThread,
      );
    }
    return "handled";
  }

  if (command?.name === "close") {
    const active = runtime.activeRuns.get(session.id);
    if (active) {
      active.cancelMode = "close";
      active.controller.abort();
    }
    if (session.status !== "closed") {
      await runtime.sessions.transition(session.id, "closed");
    }
    await bot.reply(
      msg.messageId,
      "当前会话已关闭。需要继续时，请新开一个话题。",
      hasThread,
    );
    return "handled";
  }

  return "continue";
}
