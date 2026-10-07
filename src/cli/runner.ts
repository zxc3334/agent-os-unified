import { killCli, spawnCli } from './spawn-cli.js';
import { promptInputForPlatform } from './types.js';
import { createInterface } from 'node:readline';
import type { CliAdapter, CliEvent, CliRunResult } from './types.js';

const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000;

function envTimeoutMs(adapter: CliAdapter): number | undefined {
  const raw = process.env[`${adapter.id.toUpperCase()}_TIMEOUT_MS`]
    ?? process.env.CLI_TIMEOUT_MS;
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export interface RunCliOptions {
  adapter: CliAdapter;
  prompt: string;
  cwd: string;
  sessionId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  stopToolNames?: string[];
  env?: Record<string, string>;
  onEvent?: (event: CliEvent) => void;
}

export function runCli(options: RunCliOptions): Promise<CliRunResult> {
  const {
    adapter,
    prompt,
    cwd,
    sessionId,
    signal,
    timeoutMs = envTimeoutMs(adapter) ?? DEFAULT_TIMEOUT_MS,
    stopToolNames = [],
    env,
    onEvent,
  } = options;
  // Windows 下 prompt 走 stdin（规避 cmd 转义/乱码），其他平台直接作为命令行参数。
  const promptInput = promptInputForPlatform(process.platform);
  const useStdin = promptInput === 'stdin';
  const args = sessionId
    ? adapter.buildResumeArgs(prompt, sessionId, promptInput, cwd)
    : adapter.buildArgs(prompt, promptInput, cwd);

  return new Promise((resolve, reject) => {
    // 固定用 `['pipe','pipe','pipe']`，让 stdin 始终可写（spawnCli 返回类型按字面量收窄）。
    const child = spawnCli(adapter.command, args, {
      cwd,
      signal,
      env: env ? { ...process.env, ...env } : undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // stdin 模式下把 prompt 写入子进程；否则 prompt 已在命令行参数里，stdin 直接收口。
    if (child.stdin) {
      if (useStdin) child.stdin.end(prompt, 'utf8');
      else child.stdin.end();
    }
    // spawn 的 signal 选项只杀直接子进程（cmd 外壳），Windows 下 claude.exe/codex.exe 会变孤儿；
    // 额外监听 abort 用 killCli 连进程树一起清。
    signal?.addEventListener('abort', () => killCli(child), { once: true });
    const lines = createInterface({ input: child.stdout });
    let observedSessionId = sessionId;
    let observedAnswer: string | undefined;
    let observedStats: CliRunResult['stats'];
    const observedToolCalls = new Map<
      string,
      NonNullable<CliRunResult['toolCalls']>[number]
    >();
    const failedToolUseIds = new Set<string>();
    const toolOutcomes = new Map<string, { toolName: string; status: 'succeeded' | 'failed' | 'unknown' }>();
    let finalResult: CliRunResult | undefined;
    let stoppedByToolCall:
      | NonNullable<CliRunResult['toolCalls']>[number]
      | undefined;
    let resultError: Error | undefined;
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killCli(child);
    }, timeoutMs);

    const finish = () => clearTimeout(timer);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      finish();
      reject(error);
    };

    lines.on('line', (line) => {
      for (const event of adapter.parseEvents(line)) {
        onEvent?.(event);
        if ('sessionId' in event && event.sessionId) {
          observedSessionId = event.sessionId;
        }
        if (event.type === 'error') {
          resultError = new Error(event.message);
          continue;
        }
        if (event.type === 'tool_call') {
          observedToolCalls.set(event.toolUseId, event);
          toolOutcomes.set(event.toolUseId, { toolName: event.toolName, status: 'unknown' });
          if (
            !stoppedByToolCall
            && stopToolNames.includes(event.toolName)
          ) {
            stoppedByToolCall = {
              toolUseId: event.toolUseId,
              toolName: event.toolName,
              input: event.input,
            };
            killCli(child);
          }
          continue;
        }
        if (event.type === 'tool_end') {
          const observed = toolOutcomes.get(event.toolUseId);
          if (observed) toolOutcomes.set(event.toolUseId, { ...observed, status: event.failed ? 'failed' : 'succeeded' });
          if (event.failed) {
            failedToolUseIds.add(event.toolUseId);
            observedToolCalls.delete(event.toolUseId);
          }
          continue;
        }
        if (event.type === 'result') {
          // agy 在部分轮次会返回空 response；空串也是有效结论，不能当「没返回结果」。
          if (event.answer !== undefined) observedAnswer = event.answer;
          if (event.stats) observedStats = event.stats;
          finalResult = {
            answer: observedAnswer || '任务已执行完成。',
            sessionId: event.sessionId ?? observedSessionId,
            ...(observedStats ? { stats: observedStats } : {}),
          };
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => {
      if (timedOut) {
        fail(new Error(`${adapter.displayName} 执行超时`));
        return;
      }
      if (signal?.aborted) {
        fail(new Error(`${adapter.displayName} 执行已取消`));
        return;
      }
      fail(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      if (stoppedByToolCall) {
        settled = true;
        finish();
        resolve({
          answer: observedAnswer ?? '',
          sessionId: observedSessionId,
          toolCalls: [stoppedByToolCall],
          toolOutcomes: [...toolOutcomes.values()],
          ...(failedToolUseIds.size ? { failedToolCalls: failedToolUseIds.size } : {}),
        });
        return;
      }
      if (timedOut) {
        return fail(new Error(`${adapter.displayName} 执行超时`));
      }
      if (signal?.aborted) {
        return fail(new Error(`${adapter.displayName} 执行已取消`));
      }
      if (resultError) return fail(resultError);
      if (code !== 0) {
        return fail(new Error(
          stderr.trim() || `${adapter.displayName} 退出，状态码 ${code}`,
        ));
      }
      if (!finalResult) {
        // agy 的最终回答可能为空串，此时用兜底文案收束，而不是判定执行失败。
        if (observedAnswer !== undefined) {
          finalResult = {
            answer: observedAnswer || '任务已执行完成。',
            sessionId: observedSessionId,
            ...(observedStats ? { stats: observedStats } : {}),
          };
        } else {
          return fail(new Error(`${adapter.displayName} 没有返回最终结果`));
        }
      }
      if (observedToolCalls.size > 0) {
        finalResult.toolCalls = [...observedToolCalls.values()].map((call) => ({
          toolUseId: call.toolUseId,
          toolName: call.toolName,
          input: call.input,
        }));
      }
      if (toolOutcomes.size > 0) finalResult.toolOutcomes = [...toolOutcomes.values()];
      if (failedToolUseIds.size > 0) finalResult.failedToolCalls = failedToolUseIds.size;
      settled = true;
      finish();
      resolve(finalResult);
    });
  });
}
