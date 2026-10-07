import {
  CLARIFICATION_TOOL_NAME,
  DISPATCH_TASK_TOOL_NAME,
  PRODUCT_SPEC_TOOL_NAME,
  REQUEST_APPROVAL_TOOL_NAME,
  SCHEDULE_MANAGE_TOOL_NAME,
  SAVE_MEMORY_TOOL_NAME,
  SAVE_PERSONAL_MEMORY_TOOL_NAME,
  SEARCH_PERSONAL_MEMORY_TOOL_NAME,
  CAPTURE_DAILY_RECORD_TOOL_NAME,
  SEARCH_DAILY_RECORDS_TOOL_NAME,
  CREATE_PERSONAL_REMINDER_TOOL_NAME,
  CREATE_DAILY_REMINDER_TOOL_NAME,
  SAVE_CAREER_INTERVIEW_FEEDBACK_TOOL_NAME,
} from './app-tools.js';

export const APP_TOOL_NAMES = [
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
  CREATE_PERSONAL_REMINDER_TOOL_NAME,
  CREATE_DAILY_REMINDER_TOOL_NAME,
  SAVE_CAREER_INTERVIEW_FEEDBACK_TOOL_NAME,
] as const;

// 各引擎对同一个 MCP 工具的命名不同：
//   claude → mcp__agent_os__request_approval
//   agy    → call_mcp_tool { ToolName: "request_approval" }
//   pi     → request_approval（directTools）或 agent_os_request_approval（服务名前缀）
// 这里统一归一到 Agent OS 的规范工具名。
const MATCHERS = APP_TOOL_NAMES.map((name) => ({
  name,
  pattern: new RegExp(`^(?:mcp__)?(?:agent_os__?)?${name}$`),
}));

function clean(value: string): string {
  return value.trim().replace(/^["']|["']$/g, '');
}

/**
 * 把引擎暴露的工具名归一为 Agent OS 规范工具名。
 * 不是应用工具时返回 undefined。
 */
export function normalizeAppToolName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = clean(raw);
  return MATCHERS.find((matcher) => matcher.pattern.test(value))?.name;
}

/** pi 的 mcp 代理模式：工具名是 "mcp"，真实工具名藏在参数里。 */
export function unwrapPiProxyCall(
  name: string,
  args: unknown,
): { name: string; args: unknown } {
  if (clean(name) !== 'mcp' || typeof args !== 'object' || args === null) {
    return { name, args };
  }
  const record = args as Record<string, unknown>;
  if (typeof record.tool !== 'string') return { name, args };
  return { name: record.tool, args: record.args ?? {} };
}
