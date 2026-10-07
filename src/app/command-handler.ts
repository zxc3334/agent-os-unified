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
import type { JsonPersonalAffairStore } from "../core/affairs.js";
import { cleanSummary, MAX_AFFAIR_SUMMARY_CHARS } from "../core/affairs.js";
import type { MemoryExtractionWorker } from "../core/memory-worker.js";
import { PERSONAL_SKILLS, type JsonPersonalSkillRegistry } from "../core/personal-skills.js";
import type { JsonCareerPreparation } from "../core/career-preparation.js";
import type { CareerReviewSchedulerAdapter } from "../core/review-scheduler.js";
import type { JsonTextMaterialLibrary } from "../core/text-materials.js";
import type { BlogEntryService } from "./blog-entry-service.js";
import type { BlogWritingWorkflow } from "./blog-writing-workflow.js";
import type { JsonBlogAssociations } from "../core/blog-associations.js";
import type { JsonDailyRecordsReminders } from "../core/daily-records.js";
import { resolveRelativeDue } from "../core/daily-records.js";
import type { PersonalReminderScheduler } from "./personal-reminder-scheduler.js";

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
  memoryExtractionWorker?: MemoryExtractionWorker;
  personalSkills?: JsonPersonalSkillRegistry;
  careerPreparation?: JsonCareerPreparation;
  careerReviewScheduler?: CareerReviewSchedulerAdapter;
  textMaterials?: JsonTextMaterialLibrary;
  blogEntryService?: BlogEntryService;
  blogWorkflow?: BlogWritingWorkflow;
  blogAssociations?: JsonBlogAssociations;
  dailyRecords?: JsonDailyRecordsReminders;
  personalReminderScheduler?: PersonalReminderScheduler;
  personalAffairStore?: JsonPersonalAffairStore;
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
    memoryExtractionWorker,
    personalSkills,
    careerPreparation,
    careerReviewScheduler,
    textMaterials,
    blogEntryService,
    blogWorkflow,
    blogAssociations,
    dailyRecords,
    personalReminderScheduler,
    personalAffairStore,
  } = options;

  if (!isNew && cliRequest && cliRequest.cliId !== session.cliId) {
    await bot.reply(
      msg.messageId,
      `当前话题已经在使用 ${cliAdapter.displayName}。如需切换执行引擎，请新开一个话题。`,
      hasThread,
    );
    return "handled";
  }

  if (command?.name === "affair") {
    if (!trustedOwnerOpenId || msg.senderOpenId !== trustedOwnerOpenId || msg.chatType !== "p2p") {
      await bot.reply(msg.messageId, "个人事项切换仅限所有者在私聊中使用。", hasThread);
      return "handled";
    }
    if (!personalAffairStore) {
      await bot.reply(msg.messageId, "个人事项存储暂不可用。", hasThread);
      return "handled";
    }
    if (session.status === "active" || runtime.activeRuns.has(session.id)) {
      await bot.reply(msg.messageId, "当前事项仍在执行，不能切换或编辑事项。", hasThread);
      return "handled";
    }
    const affairId = session.affairId;
    if (!affairId) {
      await bot.reply(msg.messageId, "当前事项尚未建立，请先发送一条普通消息后再管理事项。", hasThread);
      return "handled";
    }
    try {
      if (command.action === "list") {
        const affairs = await personalAffairStore.listForSelection(trustedOwnerOpenId, msg.senderOpenId, msg.chatId, session.threadId, new Date(msg.receivedAt), 20);
        const lines = affairs.slice(0, 20).map((item) => `${item.id === affairId ? "▶ " : "• "}${item.id}${item.summary ? ` — ${item.summary}` : " — （暂无摘要）"}`);
        await bot.reply(msg.messageId, `${lines.length ? `本私聊中已使用的事项（最多 20 条）：\n${lines.join("\n")}` : "本私聊还没有其他事项。"}\n切换：/affair select <事项ID>；编辑摘要：/affair summary <简短摘要>`, hasThread);
      } else if (command.action === "summary") {
        const summary = cleanSummary(command.summary);
        const updated = await personalAffairStore.setSummary(affairId, trustedOwnerOpenId, msg.senderOpenId, msg.chatId, summary, msg.receivedAt);
        await bot.reply(msg.messageId, summary
          ? `当前事项摘要已保存（${Array.from(updated.summary).length}/${MAX_AFFAIR_SUMMARY_CHARS} 字）：${updated.summary}`
          : "当前事项摘要已清空。", hasThread);
      } else {
        const target = await personalAffairStore.getListedForSelection(command.affairId, trustedOwnerOpenId, msg.senderOpenId, msg.chatId, session.threadId, new Date(msg.receivedAt));
        if (!target) {
          await bot.reply(msg.messageId, "没有找到本所有者、本私聊中的该事项。", hasThread);
          return "handled";
        }
        const available = personalMemoryStore ? await personalMemoryStore.listSpaces() : undefined;
        const availableIds = available ? new Set(available.map((space) => space.id)) : undefined;
        const scope = target.memorySpaceIds.filter((id) => !availableIds || availableIds.has(id));
        const otherActiveSession = runtime.sessions.list().some((item) =>
          item.id !== session.id && item.affairId === target.id
          && (item.status === "active" || runtime.activeRuns.has(item.id)),
        );
        if (otherActiveSession) {
          await bot.reply(msg.messageId, "该事项正在另一个线程执行，暂不能切换接续。", hasThread);
          return "handled";
        }
        await runtime.sessions.selectAffair(session.id, target.id, scope);
        await bot.reply(msg.messageId, `已切换到事项 ${target.id}。只带入了该事项的摘要与 ${scope.length} 个仍有效的授权记忆空间；当前线程的原生 CLI 会话已隔离，不会复用其他线程的 session。${target.summary ? `\n事项摘要：${target.summary}` : "\n该事项尚无摘要。"}`, hasThread);
      }
    } catch {
      await bot.reply(msg.messageId, "个人事项操作失败；未能确认已完成切换或保存。", hasThread);
    }
    return "handled";
  }

  if (command?.name === "skills") {
    if (!trustedOwnerOpenId || msg.senderOpenId !== trustedOwnerOpenId) {
      await bot.reply(msg.messageId, "个人技能设置仅限配置的所有者使用。", hasThread);
      return "handled";
    }
    if (!personalSkills) {
      await bot.reply(msg.messageId, "个人技能设置暂不可用。", hasThread);
      return "handled";
    }
    try {
      if (command.action === "list") {
        const skills = await personalSkills.list();
        await bot.reply(msg.messageId, skills.map((skill) =>
          `${skill.enabled ? "✅ 已启用" : "○ 未启用"} ${skill.id} — ${skill.name}：${skill.description}`,
        ).join("\n") + "\n用法：/skills enable <id> 或 /skills disable <id>", hasThread);
      } else {
        const skill = PERSONAL_SKILLS.find((item) => item.id === command.skillId);
        if (!skill) {
          await bot.reply(msg.messageId, "没有这个内置技能。可先用 /skills 查看可用列表。", hasThread);
        } else {
          const updated = command.action === "enable"
            ? await personalSkills.enable(skill.id)
            : await personalSkills.disable(skill.id);
          await bot.reply(msg.messageId, updated
            ? `已${command.action === "enable" ? "启用" : "停用"}「${skill.name}」。`
            : "技能设置未能保存。", hasThread);
        }
      }
    } catch (error) {
      await bot.reply(msg.messageId, `技能设置失败：${(error as Error).message}`, hasThread);
    }
    return "handled";
  }

  if (command?.name === "daily" || command?.name === "reminder") {
    if (!trustedOwnerOpenId || msg.senderOpenId !== trustedOwnerOpenId || msg.chatType !== "p2p") {
      await bot.reply(msg.messageId, "个人日常记录和提醒仅限所有者在私聊中使用。", hasThread);
      return "handled";
    }
    if (!dailyRecords) {
      await bot.reply(msg.messageId, "日常记录暂不可用，请检查本地存储配置。", hasThread);
      return "handled";
    }
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const source = { sourceId: msg.messageId, actorId: trustedOwnerOpenId, receivedAt: msg.receivedAt, timezone };
    const safe = (value: string, max = 500) => Array.from(value.replace(/[\r\n\t\u0000-\u001f\u007f]/g, " ")).slice(0, max).join("");
    try {
      if (command.name === "daily") {
        if (command.action === "add") {
          const record = dailyRecords.createRecord({
            operationId: `message:${msg.messageId}`, kind: command.kind,
            date: localDateAt(msg.receivedAt, timezone), content: command.content,
            ...(command.authorView ? { authorView: command.authorView } : {}),
            ...(command.userView ? { userView: command.userView } : {}),
            source, scopeId: session.memorySpaceIds?.[0] ?? null,
          });
          await bot.reply(msg.messageId, `已保存${command.kind === "daily" ? "日常" : command.kind === "reading" ? "阅读" : "探索"}记录 [${record.id}]（${record.date}）。这只是带日期的记录，不会自动变成长久偏好或提醒。`, hasThread);
        } else if (command.action === "scope") {
          const previous = dailyRecords.getRecord(command.recordId);
          if (previous && previous.status !== "deleted" && previous.scopeId && previous.scopeId !== command.scopeId && blogAssociations) {
            // Invalidate first: if the record write later fails, stale citations still fail closed;
            // if invalidation itself fails, the old scope remains and this command can be retried.
            blogAssociations.invalidateSource(
              { kind: "daily-record", id: previous.id, spaceId: previous.scopeId }, "revoked", msg.receivedAt,
            );
          }
          const record = dailyRecords.setRecordScope(command.recordId, command.scopeId);
          await bot.reply(msg.messageId, record ? `记录 [${record.id}] 的归属已调整为「${record.scopeId ?? "未分类"}」${previous?.scopeId && previous.scopeId !== record.scopeId ? "，旧空间中的博客引用已失效" : ""}。` : "没有找到这条记录。", hasThread);
        } else if (command.action === "delete") {
          const previous = dailyRecords.getRecord(command.recordId);
          if (previous && previous.scopeId && blogAssociations) {
            // Repeating delete after a tombstone write failure retries invalidation before any further mutation.
            blogAssociations.invalidateSource(
              { kind: "daily-record", id: previous.id, spaceId: previous.scopeId }, "deleted", msg.receivedAt,
            );
          }
          const deleted = dailyRecords.deleteRecord(command.recordId);
          await bot.reply(msg.messageId, deleted
            ? `记录 [${deleted.id}] 的正文及观点内容已删除，关联博客引用已失效；独立提醒不会被取消。`
            : "没有找到这条日常记录。", hasThread);
        } else {
          const range = command.action === "recap"
            ? { from: command.from, through: command.through }
            : lastSevenDayRange(localDateAt(msg.receivedAt, timezone));
          const recap = dailyRecords.recap(range);
          const lines = recap.records.slice(-10).map((record) => `[${record.id}] ${record.date} ${record.kind}：${safe(record.content)}（来源 ${record.source.sourceId}；归属 ${record.scopeId ?? "未分类"}）`);
          await bot.reply(msg.messageId, `${recap.from} 至 ${recap.through}，共 ${recap.records.length} 条记录：\n${lines.join("\n") || "无记录"}${recap.records.length > 10 ? "\n（仅显示最近 10 条）" : ""}`, hasThread);
        }
      } else if (command.action === "add") {
        if (!personalReminderScheduler) throw new Error("提醒调度器尚未就绪");
        const reminder = dailyRecords.createReminder({
          operationId: `message:${msg.messageId}`, content: command.content, source,
          relativeDue: command.due,
          deliveryTarget: { botId: config.id, chatId: msg.chatId },
        });
        personalReminderScheduler.schedule(reminder);
        await bot.reply(msg.messageId, `已持久化提醒 [${reminder.id}]：${reminder.content}；计划时间 ${reminder.dueAt}。`, hasThread);
      } else if (command.action === "list") {
        const reminders = dailyRecords.listReminders().filter((item) => item.source.actorId === trustedOwnerOpenId);
        const lines = reminders.slice(-10).map((item) => `[${item.id}] ${item.status} ${item.dueAt}：${safe(item.content)}`);
        await bot.reply(msg.messageId, lines.join("\n") || "尚无提醒记录。", hasThread);
      } else if (command.action === "cancel") {
        const reminder = dailyRecords.cancelReminder(command.reminderId, msg.receivedAt);
        personalReminderScheduler?.cancel(command.reminderId);
        await bot.reply(msg.messageId, reminder ? `提醒已取消；原日期事实或日常记录不会删除。` : "没有找到这条提醒。", hasThread);
      } else if (command.action === "retry") {
        if (!personalReminderScheduler) throw new Error("提醒调度器尚未就绪");
        const reminder = dailyRecords.retryFailedReminder(command.reminderId, msg.receivedAt);
        if (!reminder) throw new Error("没有找到可重试的失败提醒");
        personalReminderScheduler.schedule(reminder);
        await bot.reply(msg.messageId, `已重新安排提醒 [${reminder.id}]，计划时间 ${reminder.dueAt}；最终送达状态会以实际发送回执为准。`, hasThread);
      } else if (command.action === "edit") {
        const current = dailyRecords.getReminder(command.reminderId!);
        if (!current) throw new Error("没有找到这条提醒");
        const dueAt = resolveRelativeDue(command.due, source);
        const updated = dailyRecords.editReminder(command.reminderId!, { dueAt, content: command.content, changedAt: msg.receivedAt });
        if (!updated) throw new Error("提醒更新失败");
        personalReminderScheduler?.schedule(updated);
        await bot.reply(msg.messageId, `提醒已更新，新的计划时间为 ${updated.dueAt}。`, hasThread);
      }
    } catch (error) {
      await bot.reply(msg.messageId, `日常记录/提醒操作失败，未确认成功：${safe((error as Error).message, 300)}`, hasThread);
    }
    return "handled";
  }

  if (command?.name === "task") {
    if (!trustedOwnerOpenId || msg.senderOpenId !== trustedOwnerOpenId || msg.chatType !== "p2p") {
      await bot.reply(msg.messageId, "个人事项轨迹仅限所有者在私聊中查看。", hasThread);
      return "handled";
    }
    const safe = (value: string, max = 300) => Array.from(value.replace(/[\r\n\t\u0000-\u001f\u007f]/g, " ")).slice(0, max).join("");
    try {
      if (command.action === "recent") {
        const tasks = (await runtime.unifiedTaskStore.list())
          .filter((item) => item.trusted.ownerId === trustedOwnerOpenId)
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
          .slice(0, 5);
        const lines = tasks.map((item) => `${item.id} · ${item.status} · ${item.trigger.source} · ${item.createdAt} · ${item.traceHistory.length} 个步骤`);
        await bot.reply(msg.messageId, lines.length
          ? `最近事项（最多 5 条）：\n${lines.join("\n")}\n查看轨迹：/task trace <事项ID>`
          : "尚无可查看的个人事项。", hasThread);
      } else {
        const task = await runtime.unifiedTaskStore.get(command.taskId);
        if (!task || task.trusted.ownerId !== trustedOwnerOpenId) {
          await bot.reply(msg.messageId, "没有找到属于你的事项。", hasThread);
          return "handled";
        }
        const lines = task.traceHistory.slice(-12).map((event) => {
          const detail = [event.sourceId ? `来源 ${event.sourceId}` : undefined, event.artifactIds.length ? `产物 ${event.artifactIds.join(", ")}` : undefined, event.failureCode ? `失败阶段 ${event.failureCode}` : undefined]
            .filter(Boolean).join("；");
          return `${event.timestamp} · ${event.stage}${detail ? ` · ${detail}` : ""}`;
        });
        await bot.reply(msg.messageId, `事项 ${task.id} · ${task.status}\n${lines.join("\n") || "还没有可查看的轨迹步骤。"}\n这里只展示步骤、来源/产物标识和失败阶段，不包含原始提示词或执行内容。`, hasThread);
      }
    } catch {
      await bot.reply(msg.messageId, "事项轨迹暂时不可用；未能读取本地任务记录。", hasThread);
    }
    return "handled";
  }

  if (command?.name === "blog") {
    if (!trustedOwnerOpenId || msg.senderOpenId !== trustedOwnerOpenId || msg.chatType !== "p2p") {
      await bot.reply(msg.messageId, "博客素材与关联仅限所有者在私聊中使用。", hasThread);
      return "handled";
    }
    try {
      const spaces = personalMemoryStore ? await personalMemoryStore.listSpaces() : [];
      const authorizedSpaceIds = session.memorySpaceIds === undefined
        ? spaces.map((space) => space.id)
        : spaces.map((space) => space.id).filter((id) => session.memorySpaceIds?.includes(id));
      const safe = (value: string, max = 500) => Array.from(value.replace(/[\r\n\t\u0000-\u001f\u007f]/g, " ")).slice(0, max).join("");
      if (command.action === "search") {
        if (!blogEntryService) {
          await bot.reply(msg.messageId, "博客来源检索暂不可用；没有执行检索。", hasThread);
          return "handled";
        }
        const result = await blogEntryService.search(command.query, authorizedSpaceIds);
        const lines = result.sources.slice(0, 6).map((source) => {
          const place = [source.provenance.date, source.provenance.location].filter(Boolean).join(" · ");
          return `${source.reference.kind} ${source.reference.id}（${source.reference.spaceId}${place ? `；${place}` : ""}）：${safe(source.excerpt)}`;
        });
        const unavailable = result.unavailableKinds.length ? `\n部分来源暂不可用：${result.unavailableKinds.join("、")}` : "";
        await bot.reply(msg.messageId, `${lines.length ? `授权范围内找到 ${lines.length} 条候选来源：\n${lines.join("\n")}` : "授权范围内没有找到相关来源。"}${unavailable}\n候选只供参考，不会自动拼成你的观点。`, hasThread);
      } else if (command.action === "propose" && "topic" in command) {
        if (!blogWorkflow) {
          await bot.reply(msg.messageId, "博客写作能力暂不可用：没有配置工作流适配器。", hasThread);
          return "handled";
        }
        const context = { actorId: trustedOwnerOpenId, trustedOwnerId: trustedOwnerOpenId, chatType: "p2p" as const, authorizedSpaceIds };
        const result = await blogWorkflow.propose({ context, topic: command.topic, operationId: `message:${msg.messageId}`, now: msg.receivedAt });
        if (result.status === "proposed") {
          const lines = result.proposals.map((item) => `关联建议 [${item.id}]：${item.reasoning}；用途：${item.intendedUse}；来源：${item.sources.map((source) => `${source.kind}/${source.spaceId}/${source.id}`).join("、")}。请用 /blog decide ${item.id} accept|reject|none 决定。`);
          await bot.reply(msg.messageId, lines.join("\n"), hasThread);
        } else {
          const unavailable = result.unavailableKinds.length ? `；不可用来源：${result.unavailableKinds.join("、")}` : "";
          await bot.reply(msg.messageId, result.status === "no-relevant-sources"
            ? `没有找到足够的相关资料，不会强行建立关联${unavailable}。`
            : `模型适配器暂不可用，未生成关联建议${unavailable}。`, hasThread);
        }
      } else if (command.action === "propose") {
        if (!blogEntryService || !personalMemoryStore) {
          await bot.reply(msg.messageId, "旧版指定用途关联暂不可用；可尝试 /blog propose <主题>。", hasThread);
          return "handled";
        }
        const result = await blogEntryService.propose({
          actorId: trustedOwnerOpenId, operationId: `blog:${msg.messageId}`, createdAt: msg.receivedAt,
          query: command.query, intendedUse: command.intendedUse, authorizedSpaceIds,
        });
        if (!result.proposalId) {
          const found = result.sources.map((item) => `${item.reference.kind} ${item.reference.id}（${item.reference.spaceId}）`).join("\n");
          await bot.reply(msg.messageId, `${result.sources.length ? `目前只找到 ${result.sources.length} 条来源，至少需要两条才能建立候选关联：\n${found}` : "目前没有找到足够的授权来源；没有建立关联。"}`, hasThread);
        } else {
          const refs = result.sources.map((item) => `${item.reference.kind} ${item.reference.id}（${item.reference.spaceId}）：${safe(item.excerpt, 240)}`).join("\n");
          await bot.reply(msg.messageId, `候选关联 [${result.proposalId}] 已保存，尚未接受为你的观点。\n${refs}\n请判断：/blog decide ${result.proposalId} accept|reject|none`, hasThread);
        }
      } else if (command.action === "decide") {
        const context = { actorId: trustedOwnerOpenId, trustedOwnerId: trustedOwnerOpenId, chatType: "p2p" as const, authorizedSpaceIds };
        const decided = blogWorkflow
          ? blogWorkflow.decide(context, command.proposalId, command.decision, msg.receivedAt)
          : blogEntryService?.decide(command.proposalId, trustedOwnerOpenId, command.decision, msg.receivedAt);
        await bot.reply(msg.messageId, decided ? `候选关联已记录为 ${command.decision}；原始记忆与资料未修改。` : "没有找到属于你的关联候选，或该候选已无法更新。", hasThread);
      } else if (command.action === "authorize") {
        if (!blogWorkflow) throw new Error("博客写作能力暂不可用");
        blogWorkflow.authorizePublicSource(
          { actorId: trustedOwnerOpenId, trustedOwnerId: trustedOwnerOpenId, chatType: "p2p", authorizedSpaceIds },
          command.proposalId, command.sourceId, command.authorization, msg.receivedAt,
        );
        await bot.reply(msg.messageId, `来源 ${command.sourceId} 的公开使用授权已更新。`, hasThread);
      } else {
        if (!blogWorkflow) throw new Error("博客写作能力暂不可用");
        const context = { actorId: trustedOwnerOpenId, trustedOwnerId: trustedOwnerOpenId, chatType: "p2p" as const, authorizedSpaceIds };
        const result = await blogWorkflow.draft({ context, topic: command.topic, operationId: `message:${msg.messageId}`, now: msg.receivedAt, proposalId: command.proposalId, audience: command.audience });
        if (result.status === "drafted") {
          const draft = result.draft;
          const lines = ["大纲：", ...(draft.outline ?? []).map((item) => `- ${item.text} [${item.sourceIds.join(", ")}]`), "草稿观点：", ...draft.userClaims.map((item) => `- 我的观点：${item.text}`), ...draft.authorViews.map((item) => `- 作者观点：${item.text}`), ...draft.assistantSuggestions.map((item) => `- 助理建议：${item.text}`), ...draft.hypotheses.map((item) => `- 假设：${item.text}`), "待解决问题：", ...(draft.unresolvedQuestions ?? []).map((item) => `- ${item}`)];
          await bot.reply(msg.messageId, lines.join("\n").slice(0, 3_500), hasThread);
        } else {
          await bot.reply(msg.messageId, result.status === "model-unavailable"
            ? "模型适配器暂不可用，未生成草稿。"
            : "提案来源当前无法读取，可能已撤权、删除或检索不可用；未生成草稿。", hasThread);
        }
      }
    } catch {
      await bot.reply(msg.messageId, "博客关联操作暂时失败；未能确认已保存任何结果。", hasThread);
    }
    return "handled";
  }

  if (command?.name === "career") {
    if (!trustedOwnerOpenId || msg.senderOpenId !== trustedOwnerOpenId || msg.chatType !== "p2p") {
      await bot.reply(msg.messageId, "求职资料仅限所有者在私聊中使用。", hasThread);
      return "handled";
    }
    if (!careerPreparation) {
      await bot.reply(msg.messageId, "求职资料暂不可用，请检查本地存储配置。", hasThread);
      return "handled";
    }
    const safe = (value: string, max = 600) => Array.from(value.replace(/[\r\n\t\u0000-\u001f\u007f]/g, " ")).slice(0, max).join("");
    try {
      if (command.action === "status") {
        const [roles, evidence, resumes, learning] = await Promise.all([
          careerPreparation.listRoleRequirements(), careerPreparation.listEvidence(),
          careerPreparation.getActiveResumeVersion(), careerPreparation.listLearningRecords(),
        ]);
        const lines = [
          `岗位：${roles.length ? roles.map((role) => `${safe(role.title)} [${role.id}]`).join("；") : "尚未记录"}`,
          `证据：${evidence.length ? evidence.map((item) => `${item.status === "confirmed" ? "✅" : "○"} ${safe(item.claim)} [${item.id}]`).join("；") : "尚未记录"}`,
          `当前简历版本：${resumes ? `${resumes.id}（岗位 ${resumes.roleId}，${resumes.claims.length} 条主张）` : "尚未批准"}`,
          `待复习反馈：${learning.filter((item) => item.reviewStatus === "needs-review").slice(0, 5).map((item) => `${safe(item.weakPoint)} [${item.id}]`).join("；") || "无"}`,
          "命令：/career role <岗位> | <要求1;要求2>；/career evidence confirmed|unconfirmed <内容>；/career resume <岗位ID> <证据ID,...>；/career approve <版本ID>；/career export <版本ID>；/career feedback <版本ID> <表现> | <薄弱点>；/career due 查看待复习项；/career review <反馈ID> <0-5>；/career material add <空间ID> <标题> :: <正文>；/career material search <查询>；/career material revoke <资料ID>",
        ];
        await bot.reply(msg.messageId, lines.join("\n"), hasThread);
      } else if (command.action === "material-add") {
        if (!textMaterials || !personalMemoryStore) throw new Error("资料库暂不可用");
        const spaces = await personalMemoryStore.listSpaces();
        if (!spaces.some((space) => space.id === command.spaceId)) throw new Error("没有这个个人记忆空间");
        if (session.memorySpaceIds !== undefined && !session.memorySpaceIds.includes(command.spaceId)) throw new Error("当前事项没有授权这个空间；请先用 /memory scope <空间ID> 修改范围");
        const material = await textMaterials.add({
          operationId: `message:${msg.messageId}`, spaceId: command.spaceId, title: command.title,
          content: command.content, receivedAt: msg.receivedAt,
        });
        await bot.reply(msg.messageId, `已保存参考资料「${safe(material.title)}」[${material.id}] 到空间 ${material.spaceId}；资料不等同于已确认的个人事实。`, hasThread);
      } else if (command.action === "material-search") {
        if (!textMaterials || !personalMemoryStore) throw new Error("资料库暂不可用");
        const spaces = await personalMemoryStore.listSpaces();
        const authorizedSpaceIds = session.memorySpaceIds === undefined
          ? spaces.map((space) => space.id)
          : spaces.map((space) => space.id).filter((id) => session.memorySpaceIds?.includes(id));
        const matches = textMaterials.search(command.query, authorizedSpaceIds, 5);
        await bot.reply(msg.messageId, matches.length
          ? matches.map((item) => `「${safe(item.title)}」[${item.materialId}] ${item.spaceId} L${item.startLine}：${safe(item.text, 900)}`).join("\n")
          : "授权范围内没有找到匹配的参考资料。", hasThread);
      } else if (command.action === "material-revoke") {
        if (!textMaterials || !personalMemoryStore) throw new Error("资料库暂不可用");
        const spaces = await personalMemoryStore.listSpaces();
        const authorizedSpaceIds = session.memorySpaceIds === undefined
          ? spaces.map((space) => space.id)
          : spaces.map((space) => space.id).filter((id) => session.memorySpaceIds?.includes(id));
        const reference = textMaterials.getReference(command.materialId);
        const revoked = await textMaterials.revoke(command.materialId, msg.receivedAt, authorizedSpaceIds);
        if (revoked && reference && blogAssociations) {
          blogAssociations.invalidateSource(
            { kind: "material", id: reference.id, spaceId: reference.spaceId }, "revoked", msg.receivedAt,
          );
        }
        await bot.reply(msg.messageId, revoked ? "参考资料已撤权，后续检索不再返回原文，已关联的博客引用也已失效。" : "没有找到授权范围内的有效参考资料。", hasThread);
      } else if (command.action === "due") {
        if (!careerReviewScheduler) throw new Error("复习调度暂不可用");
        const due = (await careerReviewScheduler.listDueReviews()).slice(0, 5);
        const lines = due.map((item) => `• ${safe(item.weakPoint)} [${item.id}]（到期 ${item.nextReviewAt}；${item.reviewRounds} 轮）`);
        await bot.reply(msg.messageId, lines.length
          ? `待复习（最多显示 5 条）：\n${lines.join("\n")}\n完成后用 /career review <ID> <0-5> 记录评分。`
          : "目前没有到期的求职复习项。", hasThread);
      } else if (command.action === "evidence") {
        const evidence = await careerPreparation.addEvidence({
          claim: command.claim, status: command.status,
          sources: [{ kind: command.status === "confirmed" ? "user-confirmation" : "other", id: msg.messageId }],
        });
        await bot.reply(msg.messageId, `已保存${command.status === "confirmed" ? "已确认" : "待核实"}求职事实 [${evidence.id}]。来源为本次私聊；未核实事实不会进入简历主张。`, hasThread);
      } else if (command.action === "role") {
        const role = await careerPreparation.saveRoleRequirements({
          title: command.title, requirements: command.requirements,
          source: { kind: "user-confirmation", id: msg.messageId },
        });
        await bot.reply(msg.messageId, `已保存岗位「${safe(role.title)}」[${role.id}]，记录要求 ${role.requirements.length} 项。`, hasThread);
      } else if (command.action === "resume") {
        const proposal = await careerPreparation.proposeResumeVersion({ roleId: command.roleId, evidenceIds: command.evidenceIds });
        await bot.reply(msg.messageId, `简历草案 [${proposal.id}] 已生成：纳入 ${proposal.claims.length} 条已确认事实，排除 ${proposal.excludedEvidenceIds.length} 条未确认事实。请先检查证据，再用 /career approve ${proposal.id} 明确批准；当前正式版本没有改变。`, hasThread);
      } else if (command.action === "approve") {
        const approved = await careerPreparation.approveResumeVersion(command.resumeId, { approvedBy: trustedOwnerOpenId, approvedAt: msg.receivedAt });
        await bot.reply(msg.messageId, `已明确批准简历版本 [${approved.id}]，它现在是当前正式版本。可用 /career export ${approved.id} 查看带来源的 Markdown。`, hasThread);
      } else if (command.action === "export") {
        const markdown = await careerPreparation.renderResumeMarkdown(command.resumeId);
        if (!markdown) throw new Error("没有找到这个简历版本");
        await bot.reply(msg.messageId, markdown.slice(0, 2_800), hasThread);
      } else if (command.action === "feedback") {
        const result = await careerPreparation.recordMockInterview({
          resumeVersionId: command.resumeId,
          feedback: [{ summary: command.summary, weakPoint: command.weakPoint, source: { kind: "mock-interview", id: msg.messageId } }],
          recordedAt: msg.receivedAt,
        });
        await bot.reply(msg.messageId, `模拟面试反馈已保存为待复习记录 [${result.learningRecords[0]?.id}]，它不是已确认的项目事实。`, hasThread);
      } else {
        const record = await careerPreparation.recordLearningReview(command.learningId, { score: command.score, reviewedAt: msg.receivedAt });
        await bot.reply(msg.messageId, `复习反馈已更新：${record.reviewRounds} 轮，最近评分 ${record.latestScore}。`, hasThread);
      }
    } catch (error) {
      await bot.reply(msg.messageId, `求职资料操作失败，未确认成功：${safe((error as Error).message, 300)}`, hasThread);
    }
    return "handled";
  }

  if (command?.name === "memory") {
    if (!trustedOwnerOpenId || msg.senderOpenId !== trustedOwnerOpenId || msg.chatType !== "p2p") {
      await bot.reply(msg.messageId, "个人记忆命令仅限所有者在私聊中使用。", hasThread);
      return "handled";
    }
    if (!personalMemoryStore) {
      await bot.reply(msg.messageId, "个人记忆暂不可用，请检查本地存储配置。", hasThread);
      return "handled";
    }
    const safe = (value: string, max = 700) => Array.from(value.replace(/[\r\n\t\u0000-\u001f\u007f]/g, " ")).slice(0, max).join("");
    if (command.action === "extract") {
      if (!memoryExtractionWorker) {
        await bot.reply(msg.messageId, "对话提取器暂不可用。", hasThread);
        return "handled";
      }
      const project = config.project || "default";
      await bot.reply(msg.messageId, `已开始为项目「${project}」提取待处理对话；完成或失败后会在此通知。`, hasThread);
      void memoryExtractionWorker.processProjectDialogueBatch(project).then(async (result) => {
        const text = result
          ? `对话记忆提取完成：处理 ${result.completedSources} 条来源，游标到 ${result.cursor}。`
          : `项目「${project}」没有待处理的对话记录。`;
        await bot.reply(msg.messageId, text, hasThread);
      }).catch(async (error) => {
        console.error("[记忆Worker] 显式提取失败:", (error as Error).message);
        await bot.reply(msg.messageId, `对话提取失败，记录未标记完成，可重试：${(error as Error).message}`, hasThread);
      });
      return "handled";
    }
    try {
      const spaces = await personalMemoryStore.listSpaces();
      const allSpaceIds = spaces.map((space) => space.id);
      const authorizedSpaceIds = allSpaceIds;
      const names = new Map(spaces.map((space) => [space.id, space.name]));
      if (command.action === "space-create") {
        const created = await personalMemoryStore.createSpace(command.nameText);
        await runtime.sessions.setMemorySpaceIds(session.id, [created.id]);
        if (session.affairId && personalAffairStore && trustedOwnerOpenId) await personalAffairStore.setMemorySpaceIds(session.affairId, trustedOwnerOpenId, msg.senderOpenId, msg.chatId, [created.id], msg.receivedAt);
        await bot.reply(msg.messageId, `已创建记忆空间「${safe(created.name, 100)}」[${created.id}]，并将本事项范围切换到该空间。`, hasThread);
        return "handled";
      }
      if (command.action === "space-rename") {
        if (!allSpaceIds.includes(command.spaceId)) {
          await bot.reply(msg.messageId, "没有找到这个个人记忆空间。", hasThread);
          return "handled";
        }
        const renamed = await personalMemoryStore.renameSpace(command.spaceId, command.nameText);
        await bot.reply(msg.messageId, `记忆空间已改名为「${safe(renamed.name, 100)}」；稳定 ID 保持为 ${renamed.id}，已有事项授权不变。`, hasThread);
        return "handled";
      }
      if (command.action === "spaces") {
        const activeIds = session.memorySpaceIds;
        const lines = spaces.map((space) => `${activeIds === undefined || activeIds.includes(space.id) ? "✅" : "○"} ${space.name} — ${space.id}`);
        await bot.reply(msg.messageId, `${lines.length ? lines.join("\n") : "尚无记忆空间。"}\n本事项当前：${activeIds === undefined ? "使用全部个人空间（仍只在相关时召回）" : activeIds.length ? "限定于已选空间" : "不读取个人记忆"}。\n设置：/memory scope <空间ID|all>；新增：/memory space create <名称>；改名：/memory space rename <空间ID> <新名称>`, hasThread);
        return "handled";
      }
      if (command.action === "scope") {
        if (command.spaceId !== "all" && !allSpaceIds.includes(command.spaceId)) {
          await bot.reply(msg.messageId, "没有找到这个个人记忆空间。可用 /memory spaces 查看 ID。", hasThread);
          return "handled";
        }
        const updated = command.spaceId === "all"
          ? await runtime.sessions.setMemorySpaceIds(session.id, undefined)
          : await runtime.sessions.setMemorySpaceIds(session.id, [command.spaceId]);
        if (session.affairId && personalAffairStore && trustedOwnerOpenId) await personalAffairStore.setMemorySpaceIds(session.affairId, trustedOwnerOpenId, msg.senderOpenId, msg.chatId, command.spaceId === "all" ? allSpaceIds : [command.spaceId], msg.receivedAt);
        const selected = command.spaceId === "all" ? "全部个人记忆空间" : names.get(command.spaceId) ?? command.spaceId;
        await bot.reply(msg.messageId, `本事项的个人记忆范围已设为「${selected}」。`, hasThread);
        return "handled";
      }
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
            receivedAt: msg.receivedAt,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
            excerpt: command.content,
          },
        });
        resultMessage = "记忆已更正。";
      } else if (command.action === "reject") {
        const rejected = await personalMemoryStore.reject(entry.id, entry.version);
        if ((rejected || entry.status === "rejected") && blogAssociations) {
          blogAssociations.invalidateSource(
            { kind: "memory", id: entry.id, spaceId: entry.spaceId }, "revoked", msg.receivedAt,
          );
        }
        resultMessage = rejected
          ? "已拒绝该候选；来源记录未删除，关联博客引用已失效。"
          : entry.status === "rejected" ? "该候选已拒绝，关联博客引用已确保失效。" : "该记忆已不再有效。";
      } else {
        const forgotten = await personalMemoryStore.forget(entry.id, entry.version);
        if ((forgotten || entry.status === "forgotten") && blogAssociations) {
          // Repeating /memory forget after a partial cross-store failure safely retries the tombstone.
          blogAssociations.invalidateSource(
            { kind: "memory", id: entry.id, spaceId: entry.spaceId }, "revoked", msg.receivedAt,
          );
        }
        resultMessage = forgotten
          ? "已忘记该记忆，内容已清除、抑制同一来源重新提取，关联博客引用已失效。"
          : entry.status === "forgotten" ? "该记忆已经忘记，关联博客引用已确保失效。" : "该记忆已经忘记。";
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
        "/task recent 查看最近个人事项；/task trace <事项ID> 查看无正文的执行步骤",
        "/affair list 查看本私聊事项；/affair select <事项ID> 切换；/affair summary <摘要> 编辑摘要",
        "/team 查看当前 Agent 团队",
        "/schedule <需求> 创建定时任务",
        "/schedules 查看定时任务",
        "/topics 扫描有哪些素材够写一篇博客了",
        "/blog search <关键词> 检索授权素材；/blog propose <关键词> :: <用途> 创建待确认关联；/blog decide <ID> accept|reject|none",
        "/memory [review|recent] [页码] 查看待确认或最近记忆（每页最多 5 条）",
        "/memory spaces 查看个人记忆空间；/memory scope <空间ID|all> 设置本事项的记忆范围",
        "/memory extract 从当前项目待处理对话中恢复并执行学习记忆提取",
        "/skills 查看个人能力包；/skills enable|disable <id> 管理能力包",
        "/career 查看求职准备；支持证据/简历/面试反馈、待复习项，以及 material add|search|revoke 参考资料管理",
        "/daily add daily|reading|exploration <内容> 记录生活；/daily list 回顾最近记录；/daily delete <ID> 删除记录正文；/daily recap <开始日期> <结束日期>",
        "/reminder add <今天/明天/后天 时间> :: <内容>；/reminder list；/reminder cancel|retry <ID>",
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


function localDateAt(instant: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(instant));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function lastSevenDayRange(today: string): { from: string; through: string } {
  const end = new Date(`${today}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() - 6);
  return { from: end.toISOString().slice(0, 10), through: today };
}
