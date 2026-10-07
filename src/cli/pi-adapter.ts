import {
  normalizeAppToolName,
  unwrapPiProxyCall,
} from './app-tool-names.js';
import type { CliAdapter, CliCompactPlan, CliEvent, CliPromptInput, CliRunStats } from './types.js';

interface PiEvent {
  type?: unknown;
  id?: unknown;
  message?: unknown;
  assistantMessageEvent?: unknown;
  error?: unknown;
}

interface PiContentBlock {
  role?: unknown;
  type?: unknown;
  text?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  isError?: unknown;
  content?: unknown;
}

interface PiToolCall {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
}

const TOOL_LABELS: Record<string, string> = {
  bash: '运行命令',
  read: '读取文件',
  write: '写入文件',
  edit: '修改文件',
  glob: '查找文件',
  grep: '搜索代码',
  web_search: '搜索资料',
  web_fetch: '读取网页',
  task: '启动子任务',
  todo_write: '更新任务列表',
};

const APP_TOOL_LABELS: Record<string, string> = {
  request_approval: '请求审批',
  request_clarification: '请求澄清',
  dispatch_task: '派发团队任务',
  schedule_manage: '管理计划',
  request_spec_approval: '提交方案产物',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function shortText(value: unknown, maxLength = 72): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function toolDetail(name: string, args: unknown): string | undefined {
  if (!isRecord(args)) return undefined;
  if (name === 'bash') return shortText(args.command);
  if (name === 'read') return shortText(args.path);
  if (name === 'write') return shortText(args.path);
  if (name === 'edit') return shortText(args.path);
  if (name === 'glob') return shortText(args.pattern);
  if (name === 'grep') return shortText(args.pattern);
  if (name === 'web_search') return shortText(args.query);
  return undefined;
}

/** 从 assistant message content 中提取纯文本 */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(isRecord)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('');
}

/** 提取 token 用量 */
function usageTokens(message: unknown): number | undefined {
  if (!isRecord(message) || !isRecord(message.usage)) return undefined;
  const values = [
    asNumber(message.usage.input),
    asNumber(message.usage.output),
    asNumber(message.usage.cacheRead),
    asNumber(message.usage.cacheWrite),
  ].filter((value): value is number => value !== undefined);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : undefined;
}

function parseStats(message: unknown): CliRunStats | undefined {
  if (!isRecord(message) || !isRecord(message.usage)) return undefined;
  const usage = message.usage;
  const totalTokens = asNumber(usage.totalTokens) ?? usageTokens(message);
  const stats: CliRunStats = {
    totalTokens,
    inputTokens: asNumber(usage.input),
    outputTokens: asNumber(usage.output),
    cacheReadTokens: asNumber(usage.cacheRead),
    cacheCreationTokens: asNumber(usage.cacheWrite),
  };
  return Object.values(stats).some((value) => value !== undefined)
    ? stats
    : undefined;
}

export class PiAdapter implements CliAdapter {
  readonly id = 'pi' as const;
  readonly command = 'pi';
  readonly displayName = 'Pi';

  buildArgs(prompt: string, _promptInput?: CliPromptInput): string[] {
    return ['-p', '--mode', 'json', prompt];
  }

  buildResumeArgs(
    prompt: string,
    sessionId: string,
    _promptInput?: CliPromptInput,
  ): string[] {
    return ['-p', '--mode', 'json', '--session', sessionId, prompt];
  }

  buildCompactPlan(_sessionId: string, _instructions?: string): CliCompactPlan {
    // pi 没有原生 /compact 命令，用 claude-stream-json 协议占位。
    // /compact 对 pi 会走这里并自然失败，用户可用 /new 代替。
    return {
      protocol: 'claude-stream-json' as const,
      command: this.command,
      args: ['-p', '--mode', 'json', '/compact'],
      prompt: '/compact',
    };
  }

  parseEvents(line: string): CliEvent[] {
    let event: PiEvent;
    try {
      event = JSON.parse(line) as PiEvent;
    } catch {
      return [];
    }

    // 会话开始
    if (event.type === 'session' && typeof event.id === 'string') {
      return [{ type: 'session', sessionId: event.id }];
    }

    // 工具调用开始（toolcall_end 时才拿到完整 toolCall 对象）
    if (event.type === 'message_update' && isRecord(event.assistantMessageEvent)) {
      const e = event.assistantMessageEvent;
      if (e.type === 'toolcall_end' && isRecord(e.toolCall)) {
        const toolCall = e.toolCall as unknown as PiToolCall;
        if (typeof toolCall.id !== 'string' || typeof toolCall.name !== 'string') {
          return [];
        }
        const rawName = toolCall.name;
        const unwrapped = unwrapPiProxyCall(rawName, toolCall.arguments);
        const name = unwrapped.name;
        const args = unwrapped.args;
        const appTool = normalizeAppToolName(name);
        const detail = toolDetail(name, args);
        const events: CliEvent[] = [
          {
            type: 'tool_start',
            toolUseId: toolCall.id,
            toolName: name,
            label: TOOL_LABELS[name] ?? (appTool ? APP_TOOL_LABELS[appTool] : undefined) ?? `调用 ${name}`,
            ...(detail ? { detail } : {}),
          },
        ];
        // pi 无引擎级 MCP 参数，应用工具靠 .mcp.json / .pi/mcp.json 暴露，
        // 这里必须把命中的调用上报为 tool_call，否则审批/澄清/派发卡片不会触发。
        if (appTool) {
          events.push({
            type: 'tool_call',
            toolUseId: toolCall.id,
            toolName: appTool,
            input: args,
          });
        }
        return events;
      }
      return [];
    }

    // 消息结束事件
    if (event.type === 'message_end' && isRecord(event.message)) {
      const message = event.message as unknown as PiContentBlock;

      // 工具结果 → tool_end
      if (message.role === 'toolResult') {
        if (typeof message.toolCallId !== 'string') return [];
        return [
          {
            type: 'tool_end',
            toolUseId: message.toolCallId,
            failed: message.isError === true,
          },
        ];
      }

      // assistant 消息 → 提取文本作为 result
      if (message.role === 'assistant') {
        const text = extractText(message.content);
        const stats = parseStats(message);
        if (!text) return [];
        return [
          {
            type: 'result',
            answer: text,
            ...(stats ? { stats } : {}),
          },
        ];
      }

      return [];
    }

    // 错误事件
    if (event.type === 'error') {
      const errMsg = isRecord(event.error) && typeof event.error.message === 'string'
        ? event.error.message
        : 'Pi 执行失败';
      return [{ type: 'error', message: errMsg }];
    }

    return [];
  }
}
