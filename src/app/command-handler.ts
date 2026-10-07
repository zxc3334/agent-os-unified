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
import type { MemoryExtractionWorker } from "../core/memory-worker.js";
import { PERSONAL_SKILLS, type JsonPersonalSkillRegistry } from "../core/personal-skills.js";
import type { JsonCareerPreparation } from "../core/career-preparation.js";
import type { CareerReviewSchedulerAdapter } from "../core/review-scheduler.js";
import type { JsonTextMaterialLibrary } from "../core/text-materials.js";
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
  dailyRecords?: JsonDailyRecordsReminders;
  personalReminderScheduler?: PersonalReminderScheduler;
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
    dailyRecords,
    personalReminderScheduler,
  } = options;

  if (!isNew && cliRequest && cliRequest.cliId !== session.cliId) {
    await bot.reply(
      msg.messageId,
      `当前话题已经在使用 ${cliAdapter.displayName}。如需切换执行引擎，请新开一个话题。`,
      hasThread,
    );
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
          const record = dailyRecords.setRecordScope(command.recordId, command.scopeId);
          await bot.reply(msg.messageId, record ? `记录 [${record.id}] 的归属已调整为「${record.scopeId ?? "未分类"}」。` : "没有找到这条记录。", hasThread);
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
        const revoked = await textMaterials.revoke(command.materialId, msg.receivedAt, authorizedSpaceIds);
        await bot.reply(msg.messageId, revoked ? "参考资料已撤权，后续检索不再返回原文。" : "没有找到授权范围内的有效参考资料。", hasThread);
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
        "/task recent 查看最近个人事项；/task trace <事项ID> 查看无正文的执行步骤",
        "/team 查看当前 Agent 团队",
        "/schedule <需求> 创建定时任务",
        "/schedules 查看定时任务",
        "/topics 扫描有哪些素材够写一篇博客了",
        "/memory [review|recent] [页码] 查看待确认或最近记忆（每页最多 5 条）",
        "/memory spaces 查看个人记忆空间；/memory scope <空间ID|all> 设置本事项的记忆范围",
        "/memory extract 从当前项目待处理对话中恢复并执行学习记忆提取",
        "/skills 查看个人能力包；/skills enable|disable <id> 管理能力包",
        "/career 查看求职准备；支持证据/简历/面试反馈、待复习项，以及 material add|search|revoke 参考资料管理",
        "/daily add daily|reading|exploration <内容> 记录生活；/daily list 回顾最近记录；/daily recap <开始日期> <结束日期>",
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
