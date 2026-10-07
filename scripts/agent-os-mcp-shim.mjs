#!/usr/bin/env node
/**
 * Agent OS 的 MCP 分发垫片（agy 专用）。
 *
 * 为什么需要它：agy 只读取一个全局 MCP 配置 ~/.gemini/config/mcp_config.json，
 * 没有项目级配置（已实测：工作目录下的 .gemini/config、.mcp.json 均被忽略）。
 * 同一台机器上跑多个 Agent OS 时，它们都需要各自的 app-tools-server，
 * 却只能共享同一个全局条目。
 *
 * 解法：全局条目只注册这一个垫片；垫片按 Agent OS 调用 CLI 时注入的
 * AGENT_OS_HOME，把 stdio 转交给对应安装目录的 app-tools-server。
 *
 * 未注入 AGENT_OS_HOME 的安装（改造前的老系统）落到 FALLBACK_HOME，
 * 因此升级本文件不会改变它们的行为。
 *
 * 本文件只做进程转发，不实现任何 MCP 协议逻辑。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 自定位：席片位于 <home>/scripts/ 下，所以它自己就知道 home 是谁。
 * 这比硬编码任何 fallback 都可靠：各实例的席片各自路由到自己。
 */
const FALLBACK_HOME = join(dirname(fileURLToPath(import.meta.url)), '..');

const home = process.env.AGENT_OS_HOME?.trim() || FALLBACK_HOME;
const server = join(home, 'src', 'mcp', 'app-tools-server.ts');
const tsx = join(home, 'node_modules', 'tsx', 'dist', 'cli.mjs');

for (const [label, path] of [['app-tools-server', server], ['tsx', tsx]]) {
  if (existsSync(path)) continue;
  process.stderr.write(`[agent-os-shim] 找不到 ${label}: ${path}\n`);
  process.exit(1);
}

const child = spawn(process.execPath, [tsx, server], {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
