export type CliId = 'agy' | 'pi' | 'claude' | 'codex';

export type CliPromptInput = 'argument' | 'stdin';

/** Windows 上 prompt 必须走 stdin（避免 cmd 对命令行参数转义/乱码），其他平台直接走参数。 */
export function promptInputForPlatform(platform: NodeJS.Platform): CliPromptInput {
  return platform === 'win32' ? 'stdin' : 'argument';
}

export type CliCompactPlan =
  | {
      protocol: 'claude-stream-json';
      command: string;
      args: string[];
      prompt: string;
    }
  | {
      protocol: 'codex-app-server';
      command: string;
      args: string[];
      sessionId: string;
    };

export interface CliRunStats {
  durationMs?: number;
  turns?: number;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  contextUsedTokens?: number;
  contextWindowTokens?: number;
}

export interface CliSessionSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export type CliEvent =
  | { type: 'session'; sessionId: string }
  | {
      type: 'tool_start';
      toolUseId: string;
      toolName: string;
      label: string;
      detail?: string;
    }
  | { type: 'tool_end'; toolUseId: string; failed: boolean }
  | { type: 'context'; usedTokens: number }
  | {
      type: 'tool_call';
      toolUseId: string;
      toolName: string;
      input: unknown;
    }
  | { type: 'result'; answer: string; sessionId?: string; stats?: CliRunStats }
  | { type: 'error'; message: string; sessionId?: string };

export interface CliAdapter {
  readonly id: CliId;
  readonly command: string;
  readonly displayName: string;
  /** workspace 只对 agy 有意义（它默认在自家 scratch 目录跑，需要 --add-dir 才能访问工作区）。 */
  buildArgs(prompt: string, promptInput: CliPromptInput, workspace?: string): string[];
  buildResumeArgs(
    prompt: string,
    sessionId: string,
    promptInput: CliPromptInput,
    workspace?: string,
  ): string[];
  buildCompactPlan(sessionId: string, instructions?: string): CliCompactPlan;
  parseEvents(line: string): CliEvent[];
}

export interface CliRunResult {
  answer: string;
  sessionId?: string;
  stats?: CliRunStats;
  toolCalls?: Array<{
    toolUseId: string;
    toolName: string;
    input: unknown;
  }>;
  /** Tool names and execution status only; never includes tool arguments or output. */
  toolOutcomes?: Array<{ toolName: string; status: 'succeeded' | 'failed' | 'unknown' }>;
  /** Number of tool executions reported failed by the adapter; contents are intentionally omitted. */
  failedToolCalls?: number;
}
