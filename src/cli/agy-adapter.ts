import {
  normalizeAppToolName,
} from './app-tool-names.js';
import {
  DISPATCH_TASK_TOOL_NAME,
  PRODUCT_SPEC_TOOL_NAME,
  REQUEST_APPROVAL_TOOL_NAME,
  SCHEDULE_MANAGE_TOOL_NAME,
  CLARIFICATION_TOOL_NAME,
} from './app-tools.js';
import type {
  CliAdapter,
  CliCompactPlan,
  CliEvent,
  CliPromptInput,
  CliRunStats,
} from './types.js';

const TOOL_LABELS: Record<string, string> = {
  run_command: '运行命令',
  view_file: '查看文件',
  write_to_file: '写入文件',
  replace_file_content: '修改文件',
  multi_replace_file_content: '批量修改文件',
  find_by_name: '查找文件',
  list_dir: '查看目录',
  grep_search: '搜索代码',
  search_web: '搜索资料',
  read_url_content: '读取网页',
  invoke_subagent: '调度子代理',
  manage_subagents: '管理子代理',
  send_message: '发送消息',
  schedule: '定时任务',
  manage_task: '管理后台任务',
  ask_question: '提问用户',
  call_mcp_tool: '调用工具',
  [REQUEST_APPROVAL_TOOL_NAME]: '请求审批',
  [CLARIFICATION_TOOL_NAME]: '请求澄清',
  [DISPATCH_TASK_TOOL_NAME]: '派发团队任务',
  [SCHEDULE_MANAGE_TOOL_NAME]: '管理计划',
  [PRODUCT_SPEC_TOOL_NAME]: '提交方案产物',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function shortPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const normalized = value.replaceAll('\\', '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts.slice(normalized.startsWith('/') ? -2 : -3).join('/');
}

function shortText(value: unknown, maxLength = 72): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function toolDetail(name: string, input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  if (name === 'run_command') return shortText(input.CommandLine);
  if (['view_file', 'read_file'].includes(name)) return shortPath(input.AbsolutePath ?? input.path);
  if (['write_to_file', 'replace_file_content', 'multi_replace_file_content'].includes(name)) {
    return shortPath(input.TargetFile ?? input.path);
  }
  if (name === 'find_by_name') return shortText(input.Pattern);
  if (name === 'list_dir') return shortPath(input.DirectoryPath);
  if (name === 'grep_search') return shortText(input.Query);
  if (name === 'search_web') return shortText(input.query);
  if (name === 'read_url_content') return shortText(input.Url);
  if (name === REQUEST_APPROVAL_TOOL_NAME) return shortText(input.operation);
  if (name === DISPATCH_TASK_TOOL_NAME) {
    const target = typeof input.targetBotId === 'string' ? input.targetBotId : '';
    const obj = shortText(input.objective);
    return target && obj ? `${target}: ${obj}` : (target || obj);
  }
  if (name === SCHEDULE_MANAGE_TOOL_NAME) return shortText(input.action);
  return undefined;
}

function parseStats(usageRaw: unknown, durationSeconds?: unknown): CliRunStats | undefined {
  if (!isRecord(usageRaw)) return undefined;
  const stats: CliRunStats = {
    durationMs: typeof durationSeconds === 'number' ? Math.round(durationSeconds * 1000) : undefined,
    totalTokens: asNumber(usageRaw.total_tokens),
    inputTokens: asNumber(usageRaw.input_tokens),
    outputTokens: asNumber(usageRaw.output_tokens),
    cacheReadTokens: asNumber(usageRaw.cache_read_tokens),
    contextUsedTokens: asNumber(usageRaw.total_tokens),
  };
  return Object.values(stats).some((value) => value !== undefined) ? stats : undefined;
}

function cleanToolName(val: unknown): string {
  if (typeof val !== 'string') return '';
  let str = val.trim();
  if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
    str = str.slice(1, -1).trim();
  }
  return str;
}

function parseMcpArguments(raw: unknown): unknown {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

export class AgyAdapter implements CliAdapter {
  readonly id = 'agy' as const;
  readonly command = 'agy';
  readonly displayName = 'Antigravity (agy)';

  buildArgs(prompt: string, _promptInput: CliPromptInput, workspace?: string): string[] {
    return [
      ...(workspace ? ['--add-dir', workspace] : []),
      '-p', prompt,
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
    ];
  }

  buildResumeArgs(
    prompt: string,
    sessionId: string,
    _promptInput: CliPromptInput,
    workspace?: string,
  ): string[] {
    return [
      ...(workspace ? ['--add-dir', workspace] : []),
      '--conversation',
      sessionId,
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--dangerously-skip-permissions',
    ];
  }

  buildCompactPlan(sessionId: string, _instructions?: string): CliCompactPlan {
    return {
      protocol: 'claude-stream-json',
      command: this.command,
      args: ['--conversation', sessionId, '-p', '/compact', '--output-format', 'stream-json'],
      prompt: '/compact',
    };
  }

  parseEvents(line: string): CliEvent[] {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      return [];
    }

    if (event.event === 'init') {
      const sessionId = typeof event.conversation_id === 'string' ? event.conversation_id : undefined;
      return sessionId ? [{ type: 'session', sessionId }] : [];
    }

    if (event.event === 'step_update') {
      const step = isRecord(event.step_update) ? event.step_update : {};
      const stepType = step.step_type;
      const conversationId = typeof step.conversation_id === 'string' ? step.conversation_id : 'tool';
      const stepIndex = step.step_index !== undefined ? String(step.step_index) : '0';
      const toolUseId = `${conversationId}:${stepIndex}`;

      if (stepType === 'agent_response') {
        const usage = isRecord(step.usage) ? step.usage : undefined;
        const totalTokens = asNumber(usage?.total_tokens);
        return totalTokens !== undefined ? [{ type: 'context', usedTokens: totalTokens }] : [];
      }

      if (stepType === 'tool') {
        const state = step.state;
        const toolInfo = isRecord(step.tool_info) ? step.tool_info : {};
        const rawToolName = typeof step.tool_name === 'string'
          ? step.tool_name
          : typeof toolInfo.name === 'string'
          ? toolInfo.name
          : 'unknown';
        const normalizedToolName = cleanToolName(rawToolName);

        if (state === 'ACTIVE') {
          // agy 把 MCP 调用包成 call_mcp_tool，真实工具名与参数在 parameters 里。
          if (normalizedToolName === 'call_mcp_tool' && isRecord(toolInfo.parameters)) {
            const params = toolInfo.parameters;
            const mcpToolName = cleanToolName(params.ToolName);
            const mcpArgs = parseMcpArguments(params.Arguments);
            const appTool = normalizeAppToolName(mcpToolName);
            const label = TOOL_LABELS[mcpToolName] ?? `调用 ${mcpToolName}`;
            const detail = toolDetail(mcpToolName, mcpArgs);

            const events: CliEvent[] = [
              {
                type: 'tool_start',
                toolUseId,
                toolName: mcpToolName,
                label,
                ...(detail ? { detail } : {}),
              },
            ];

            // 只上报 Agent OS 自己的应用工具；第三方 MCP server（如博客工具）
            // 不应触发审批/澄清等卡片流程。
            if (appTool) {
              events.push({
                type: 'tool_call',
                toolUseId,
                toolName: appTool,
                input: mcpArgs,
              });
            }
            return events;
          }

          // 处理原生工具调用
          const appTool = normalizeAppToolName(normalizedToolName);
          const label = TOOL_LABELS[normalizedToolName] ?? `调用 ${normalizedToolName}`;
          const detail = toolDetail(normalizedToolName, toolInfo.parameters);
          const events: CliEvent[] = [
            {
              type: 'tool_start',
              toolUseId,
              toolName: normalizedToolName,
              label,
              ...(detail ? { detail } : {}),
            },
          ];

          if (appTool) {
            events.push({
              type: 'tool_call',
              toolUseId,
              toolName: appTool,
              input: toolInfo.parameters,
            });
          }
          return events;
        }

        if (state === 'DONE' || state === 'ERROR') {
          const failed = state === 'ERROR' || Boolean(toolInfo.error);
          return [{ type: 'tool_end', toolUseId, failed }];
        }
      }

      return [];
    }

    if (event.event === 'result') {
      const result = isRecord(event.result) ? event.result : {};
      const sessionId = typeof result.conversation_id === 'string' ? result.conversation_id : undefined;
      const status = result.status;
      const responseText = typeof result.response === 'string' ? result.response : '';

      if (status === 'ERROR') {
        return [
          {
            type: 'error',
            message: responseText || 'Antigravity CLI 执行失败',
            ...(sessionId ? { sessionId } : {}),
          },
        ];
      }

      const stats = parseStats(result.usage, result.duration_seconds);
      return [
        {
          type: 'result',
          answer: responseText || '任务已执行完成。',
          ...(sessionId ? { sessionId } : {}),
          ...(stats ? { stats } : {}),
        },
      ];
    }

    return [];
  }
}
