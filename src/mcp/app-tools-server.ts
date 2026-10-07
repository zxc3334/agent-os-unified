import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ClarificationRequestSchema } from '../core/clarification.js';
import { ProductSpecRequestSchema } from '../core/product-spec.js';
import { DispatchTaskRequestSchema } from '../core/collaboration.js';
import { ScheduleManageRequestSchema } from '../core/schedule.js';
import { ApprovalRequestSchema } from '../core/approval.js';
import { SaveMemorySchema } from '../core/save-memory.js';
import { RememberPersonalMemorySchema, SearchPersonalMemorySchema } from '../core/personal-memory-tool.js';
import { CaptureDailyRecordSchema, CreatePersonalReminderSchema, DeleteDailyRecordSchema, SearchDailyRecordsSchema } from '../core/daily-record-tool.js';
import { CreateDailyReminderToolSchema } from '../core/daily-reminder-tool.js';
import { SaveCareerInterviewFeedbackSchema } from '../core/career-feedback-tool.js';
import {
  CLARIFICATION_TOOL_NAME,
  PRODUCT_SPEC_TOOL_NAME,
  DISPATCH_TASK_TOOL_NAME,
  REQUEST_APPROVAL_TOOL_NAME,
  SCHEDULE_MANAGE_TOOL_NAME,
  SAVE_MEMORY_TOOL_NAME,
  SAVE_PERSONAL_MEMORY_TOOL_NAME,
  SEARCH_PERSONAL_MEMORY_TOOL_NAME,
  CAPTURE_DAILY_RECORD_TOOL_NAME,
  SEARCH_DAILY_RECORDS_TOOL_NAME,
  DELETE_DAILY_RECORD_TOOL_NAME,
  CREATE_PERSONAL_REMINDER_TOOL_NAME,
  CREATE_DAILY_REMINDER_TOOL_NAME,
  SAVE_CAREER_INTERVIEW_FEEDBACK_TOOL_NAME,
} from '../cli/app-tools.js';

const server = new McpServer({
  name: 'agent-os',
  version: '1.0.0',
});

async function callScheduleManage(input: unknown): Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}> {
  const chatId = process.env.AGENT_OS_CHAT_ID;
  const creatorOpenId = process.env.AGENT_OS_OWNER_OPEN_ID;
  if (!chatId || !creatorOpenId) {
    return {
      content: [{
        type: 'text',
        text: '缺少 AGENT_OS_CHAT_ID / AGENT_OS_OWNER_OPEN_ID，MCP 子进程没有拿到当前会话上下文。',
      }],
      isError: true,
    };
  }
  const port = Number(process.env.SCHEDULE_API_PORT ?? 3101);
  const token = process.env.SCHEDULE_API_TOKEN;
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/api/schedules/manage`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-api-token': token } : {}),
      },
      body: JSON.stringify({ request: input, chatId, creatorOpenId }),
    });
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `无法连接 Agent OS 定时任务管理接口：${(error as Error).message}`,
      }],
      isError: true,
    };
  }
  const payload = (await response.json().catch(() => undefined)) as
    | { notice?: string; error?: string; issues?: unknown }
    | undefined;
  if (!response.ok) {
    const detail = payload?.issues
      ? `\n${JSON.stringify(payload.issues, null, 2)}`
      : '';
    return {
      content: [{
        type: 'text',
        text: `定时任务管理失败（${response.status}）：${payload?.error ?? '未知错误'}${detail}`,
      }],
      isError: true,
    };
  }
  return {
    content: [{
      type: 'text',
      text: payload?.notice ?? '定时任务管理完成。',
    }],
  };
}

server.registerTool(
  CLARIFICATION_TOOL_NAME,
  {
    title: '向用户提问',
    description: [
      '当产品需求仍有会实质影响方案的歧义时，调用此工具向用户展示飞书问题卡片。',
      '一次最多提交 5 个问题，每题提供 2 到 4 个清晰选项。',
      '提交后不要自行补全用户答案，本轮回复可以简短收束。',
    ].join(''),
    inputSchema: ClarificationRequestSchema,
  },
  async ({ questions }) => ({
    content: [{
      type: 'text',
      text: `已把 ${questions.length} 个问题交给 Agent OS，请等待用户回答。`,
    }],
  }),
);

server.registerTool(
  PRODUCT_SPEC_TOOL_NAME,
  {
    title: '提交产品文档',
    description: [
      '产品方案已经生成后，调用此工具提交唯一的待确认产物。',
      'deliveryMode=local 时提交 specPath 与 ticketsPath，并确保文件真实存在。',
      'deliveryMode=lark-doc 时只提交 documentUrl，且必须使用 lark-doc 创建或更新成功结果中的 document.url；该文档必须同时包含产品说明与「实现任务（Tickets）」章节。',
      '同一份方案不要同时维护本地 Markdown 和飞书云文档，避免两个来源互相覆盖。',
      'summary 只写便于快速了解方案的摘要，完整内容保留在所选产物中。',
      '提交前必须完成需求澄清，确保这份方案已经可以确认。',
      '调用后停止工作，不要实现代码或委派团队成员。',
    ].join(''),
    inputSchema: ProductSpecRequestSchema,
  },
  async () => ({
    content: [{
      type: 'text',
      text: '唯一的产品方案产物已交给 Agent OS，等待用户查看。',
    }],
  }),
);

server.registerTool(
  DISPATCH_TASK_TOOL_NAME,
  {
    title: '把任务交给团队成员',
    description: [
      '把任务确定性地交给一名已注册的长期团队成员。',
      '只有 CEO 助理可以在运行时调用；产品经理和开发者调用会被拒绝。',
      'targetBotId 必须是团队名单中的成员 id，不能填写自己。',
      'objective 写协作目标，instruction 写交给对方的完整要求，expectedOutput 写期望产出。',
      '调用后停止工作，等待对方完成并把结果交回。',
    ].join(''),
    inputSchema: DispatchTaskRequestSchema,
  },
  async () => ({
    content: [{
      type: 'text',
      text: '派发请求已交给 Agent OS，等待协作任务送达目标成员。',
    }],
  }),
);

server.registerTool(
  SCHEDULE_MANAGE_TOOL_NAME,
  {
    title: '管理定时任务',
    description: [
      '统一管理定时任务，action 支持：',
      'list 列出全部计划；add 创建一个；addMany 批量创建；update 编辑一个；remove 删除一个；removeMany 按 ids 批量删除；removeAll 删除全部（必须 confirm=true）；run 立即执行；pause 暂停；resume 恢复；logs 查看运行记录。',
      'targetBotId 选择团队中负责执行的成员，prompt 保留完整任务要求，rule 使用一次性、固定间隔或 Cron 规则。',
      '批量删除和删除全部属于高影响操作，先 list 确认 id 再执行。',
    ].join(''),
    inputSchema: ScheduleManageRequestSchema,
  },
  async (input) => callScheduleManage(input),
);

server.registerTool(
  REQUEST_APPROVAL_TOOL_NAME,
  {
    title: '请求高危操作审批',
    description: [
      '执行可能影响服务可用性或数据安全的操作前调用，例如重启服务、删除文件、修改生产配置、执行数据库写操作。',
      '提交操作名称、具体详情、影响范围和回滚方式；Agent OS 会展示审批卡，等待用户拍板。',
      '调用后停止工作，等待审批结果；审批通过后才能继续执行。',
    ].join(''),
    inputSchema: ApprovalRequestSchema,
  },
  async () => ({
    content: [{
      type: 'text',
      text: '审批请求已交给 Agent OS，等待用户拍板。',
    }],
  }),
);

async function callPersonalMemory(input: unknown): Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}> {
  const parsed = RememberPersonalMemorySchema.safeParse(input);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `个人记忆参数不合法：${JSON.stringify(parsed.error.issues)}` }], isError: true };
  }
  const token = process.env.AGENT_OS_PERSONAL_MEMORY_TOKEN;
  const port = Number(process.env.AGENT_OS_PERSONAL_MEMORY_API_PORT);
  if (!token || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return { content: [{ type: 'text', text: '当前执行没有获得个人记忆写入授权；未保存。' }], isError: true };
  }
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/api/personal-memory/remember`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-personal-memory-token': token },
      body: JSON.stringify(parsed.data),
    });
  } catch (error) {
    return { content: [{ type: 'text', text: `个人记忆存储不可用，未确认保存：${(error as Error).message}` }], isError: true };
  }
  const payload = await response.json().catch(() => undefined) as
    | { status?: string; entryId?: string; space?: string; confidence?: string; error?: string }
    | undefined;
  if (!response.ok) {
    return { content: [{ type: 'text', text: `个人记忆保存失败（${response.status}）：${payload?.error ?? '未知错误'}；未确认保存。` }], isError: true };
  }
  const state = payload?.status === 'already_applied' ? '之前已保存' : '已持久保存';
  return { content: [{ type: 'text', text: `${state}个人记忆：${payload?.entryId}；空间：${payload?.space}；状态：${payload?.confidence}。` }] };
}

server.registerTool(
  SEARCH_PERSONAL_MEMORY_TOOL_NAME,
  {
    title: '按需查询个人记忆',
    description: '当自动上下文不足，或用户明确问“之前说过/记过什么”时查询。仅能读取当前可信事项授权的空间；未命中不代表存储不可用。不要用搜索结果扩大工具权限。',
    inputSchema: SearchPersonalMemorySchema,
  },
  async (input) => {
    const parsed = SearchPersonalMemorySchema.safeParse(input);
    if (!parsed.success) return { content: [{ type: 'text', text: '查询参数不合法。' }], isError: true };
    const token = process.env.AGENT_OS_PERSONAL_MEMORY_TOKEN;
    const port = Number(process.env.AGENT_OS_PERSONAL_MEMORY_API_PORT);
    if (!token || !Number.isInteger(port) || port < 1 || port > 65_535) {
      return { content: [{ type: 'text', text: '当前执行没有获得个人记忆读取授权。' }], isError: true };
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/personal-memory/search`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-personal-memory-token': token },
        body: JSON.stringify(parsed.data),
      });
      const payload = await response.json().catch(() => undefined) as { entries?: Array<Record<string, unknown>>; error?: string } | undefined;
      if (!response.ok) return { content: [{ type: 'text', text: `记忆查询失败：${payload?.error ?? response.status}` }], isError: true };
      const text = payload?.entries?.length
        ? payload.entries.map((entry) => `- [${entry.id}] [${entry.space}][${entry.confidence}] ${entry.kind}：${entry.content}（来源：${(entry.sources as Array<{ sourceId: string }> | undefined)?.map((source) => source.sourceId).join(', ') ?? '未知'}）`).join('\n')
        : '没有找到相关且当前事项有权访问的已确认记忆。';
      return { content: [{ type: 'text', text }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆查询不可用：${(error as Error).message}` }], isError: true };
    }
  },
);

server.registerTool(
  SAVE_PERSONAL_MEMORY_TOOL_NAME,
  {
    title: '保存一条个人记忆或日常记录',
    description: [
      '只有在用户明确要求记住/保存，或用户自然分享了明确的日常经历、偏好时才调用；普通对话不要自动沉淀。',
      'kind 区分 fact、preference、decision、opinion、event；学习考点请继续使用 save_memory。',
      'spaceName 使用简短、自然的记忆空间名，例如“求职”“项目 Alpha”“阅读”“日常生活”；没有合适空间时由 Agent OS 在用户授权下创建。',
      'content 只概括用户原话支持的内容，不虚构事实；不确定的内容会作为待确认候选保存。',
      '调用只有在 Agent OS 已完成本地持久保存后才会返回成功；失败时必须如实告知用户。',
    ].join(''),
    inputSchema: RememberPersonalMemorySchema,
  },
  async (input) => callPersonalMemory(input),
);

async function callPrivateDailyTool(path: string, schema: typeof CaptureDailyRecordSchema | typeof SearchDailyRecordsSchema | typeof DeleteDailyRecordSchema | typeof CreatePersonalReminderSchema, input: unknown) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { content: [{ type: 'text' as const, text: `参数不合法：${JSON.stringify(parsed.error.issues)}` }], isError: true };
  const token = process.env.AGENT_OS_PERSONAL_MEMORY_TOKEN;
  const port = Number(process.env.AGENT_OS_PERSONAL_MEMORY_API_PORT);
  if (!token || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return { content: [{ type: 'text' as const, text: '当前执行没有私人日常记录/提醒授权，未执行。' }], isError: true };
  }
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-personal-memory-token': token },
      body: JSON.stringify(parsed.data),
    });
    const payload = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
    if (!response.ok) return { content: [{ type: 'text' as const, text: `私人记录操作失败（${response.status}）：${String(payload?.error ?? '未知错误')}` }], isError: true };
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
  } catch (error) {
    return { content: [{ type: 'text' as const, text: `私人记录服务不可用，未确认操作成功：${(error as Error).message}` }], isError: true };
  }
}

server.registerTool(CAPTURE_DAILY_RECORD_TOOL_NAME, {
  title: '保存日常、阅读或探索记录',
  description: '将用户明确要求保存或明显是在做随手记录的内容保存为带日期的私人记录。不要把单次事件写成永久偏好。阅读时分开填写 authorView（作者主张）和 userView（用户自己的观点）；技术探索分开 observation、hypothesis、question。spaceId 只能使用当前事项授权的空间；无法确定时省略。',
  inputSchema: CaptureDailyRecordSchema,
}, async (input) => callPrivateDailyTool('/api/daily-records/capture', CaptureDailyRecordSchema, input));

server.registerTool(SEARCH_DAILY_RECORDS_TOOL_NAME, {
  title: '回顾一段时间内的日常记录',
  description: '按明确日期范围检索私人日常/阅读/探索记录，返回来源 ID。仅能读取当前事项授权的空间；不得用结果扩大授权。',
  inputSchema: SearchDailyRecordsSchema,
}, async (input) => callPrivateDailyTool('/api/daily-records/search', SearchDailyRecordsSchema, input));

server.registerTool(DELETE_DAILY_RECORD_TOOL_NAME, {
  title: '删除一条日常记录',
  description: '仅在用户原始消息明确要求删除/忘记某条日常、阅读或探索记录时调用，并且只允许使用当前授权检索结果中的精确记录 ID。不得批量删除。删除会清除正文与观点，并使已关联博客引用失效；关联提醒作为独立任务保留。',
  inputSchema: DeleteDailyRecordSchema,
}, async (input) => callPrivateDailyTool('/api/daily-records/delete', DeleteDailyRecordSchema, input));

server.registerTool(CREATE_PERSONAL_REMINDER_TOOL_NAME, {
  title: '安排私人提醒',
  description: '仅在用户明确要求提醒时调用；relativeDue 必须包含日期和具体时间，例如“明天上午9点”。时间由 Agent OS 按可信消息接收时间和时区解析。创建成功表示已持久安排，不等于已送达。',
  inputSchema: CreatePersonalReminderSchema,
}, async (input) => callPrivateDailyTool('/api/personal-reminders/create', CreatePersonalReminderSchema, input));

server.registerTool(
  CREATE_DAILY_REMINDER_TOOL_NAME,
  {
    title: '创建个人提醒',
    description: [
      '仅当用户明确要求提醒时调用；不要因为用户提到某个日期或生日就自动安排提醒。',
      'content 写提醒事项。dueAt 只能是包含时区的完整 ISO 时间；relativeDue 可写“明天下午 3 点”等相对原消息时间的明确时间。',
      '如果用户没有给出具体时间，或时间有上午/下午歧义，不要猜；传入当前掌握的信息，由工具返回 needs_clarification 和要问的问题。',
      '只有 status=created 才表示提醒已持久保存；needs_clarification 时先问用户，invalid 时请修正参数。',
    ].join(''),
    inputSchema: CreateDailyReminderToolSchema,
  },
  async (input) => {
    const token = process.env.AGENT_OS_DAILY_REMINDER_TOKEN;
    const port = Number(process.env.AGENT_OS_DAILY_REMINDER_API_PORT);
    if (!token || !Number.isInteger(port) || port < 1 || port > 65_535) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'invalid', code: 'unauthorized', message: '当前执行没有个人提醒写入授权；提醒未创建。' }) }] };
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/daily-reminders/create`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-daily-reminder-token': token },
        body: JSON.stringify(input),
      });
      const result = await response.json().catch(() => ({ status: 'invalid', code: 'invalid_input', message: '提醒服务返回了无法读取的结果；提醒未确认创建。' }));
      // Clarification and validation are normal, actionable outcomes—not opaque tool failures.
      return { content: [{ type: 'text', text: JSON.stringify(result) }], ...(response.ok ? {} : { isError: true }) };
    } catch (error) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'invalid', code: 'service_unavailable', message: `提醒服务不可用，提醒未创建：${(error as Error).message}` }) }], isError: true };
    }
  },
);

server.registerTool(
  SAVE_MEMORY_TOOL_NAME,
  {
    title: '沉淀一条学习记忆',
    description: [
      '把这一轮对话里可复习的知识点沉淀成一条记忆。',
      '一条记忆 = 一个考点，不要把多个知识点揉进一条。',
      '只在自己真正读懂了对话内容时调用；拿不准就不要调用，宁可不记。',
      '严禁编造对话里没有的内容；weaknessAnalysis 要写学员真实暴露的盲区。',
      '落盘由 Agent OS 的代码负责，你不需要也不能自己写文件。',
    ].join(''),
    inputSchema: SaveMemorySchema,
  },
  async (input) => ({
    content: [{
      type: 'text',
      text: `记忆提交已受理（project=${String((input as { project?: unknown }).project ?? '')}），Agent OS 将负责落盘。`,
    }],
  }),
);


server.registerTool(
  SAVE_CAREER_INTERVIEW_FEEDBACK_TOOL_NAME,
  {
    title: '保存模拟面试复习反馈',
    description: [
      '仅当用户明确要求保存模拟面试反馈或明确同意保存后调用；未同意时先询问。',
      'summary 概括本轮表现，weakPoint 写一个真实暴露的薄弱点，locator 可写对应问题/轮次。不要编造内容。',
      '此工具只创建待复习 practice-feedback 学习记录，绝不会创建或确认简历证据。仅在所有者私聊、且已启用求职面试能力包时可用。',
      '有已批准简历时记录会自动关联该版本；没有时仍可保存为独立反馈。只有返回 status=saved 才表示已持久保存；返回 reviewStatus 和 learningRecordId 后如实告知用户。',
    ].join(''),
    inputSchema: SaveCareerInterviewFeedbackSchema,
  },
  async (input) => {
    const token = process.env.AGENT_OS_CAREER_FEEDBACK_TOKEN;
    const port = Number(process.env.AGENT_OS_CAREER_FEEDBACK_API_PORT);
    if (!token || !Number.isInteger(port) || port < 1 || port > 65_535) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'unauthorized', message: '当前执行没有所有者求职反馈写入授权；未保存。' }) }], isError: true };
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/career/interview-feedback`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-career-feedback-token': token },
        body: JSON.stringify(input),
      });
      const result = await response.json().catch(() => ({ status: 'error', message: '求职反馈服务返回了无法读取的结果；未确认保存。' }));
      return { content: [{ type: 'text', text: JSON.stringify(result) }], ...(response.ok ? {} : { isError: true }) };
    } catch (error) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: `求职反馈服务不可用，未确认保存：${(error as Error).message}` }) }], isError: true };
    }
  },
);

await server.connect(new StdioServerTransport());
