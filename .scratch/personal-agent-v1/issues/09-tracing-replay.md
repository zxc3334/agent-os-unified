# 事项轨迹与个人回放评测

- Status: in-progress
- Blocked by: 04-unified-task-runtime (collaboration/continuation end-to-end coverage remains)
- Milestone: B-E
- Spec: [spec.md](../spec.md)

## What to build

增加最小事项级操作轨迹与约 20–30 条合成/脱敏固定回放案例，记录任务/技能版本、来源 ID、可观察阶段、记忆操作与失败；不存完整提示词。

## Acceptance criteria

- 能解释引用与失败；执行器无 usage 时成本显示未知；轨迹写入失败不改变已完成的记忆结果；私密原文遵循忘记清理；回放逐条保存可比较结果且不外发。
- 为本票契约补单元/集成测试；通过公开行为验证，不以内部函数调用次数为验收。
- 完成后更新实现与验证说明；不触碰无关用户数据、生产配置或既有工作区。

## Implementation status

- Added content-free lifecycle trace events with opaque task/source/artifact IDs and failure codes. Trace history is persisted in the task record and survives restart via existing `get` / `list`; best-effort trace writes never change task outcomes, and legacy records load with empty history.
- Added 25 versioned synthetic replay cases and owner-DM-only `/task recent` and `/task trace <id>` commands. These expose task state, content-free trace stages and opaque source/artifact identifiers, not prompts, results, or progress text.
- Replay tests now use independent fixed authorization-space and memory-confirmation oracles rather than deriving expected results from fixture fields. They cover group/non-owner denial, no permission expansion from user requests, rejection/forget/failure/implicit-request boundaries, and owner/scheduler scope filtering.
- Still incomplete: the trace schema does not yet record skill versions, memory operations, elapsed time, or explicit unknown cost when usage is unavailable. Memory forgetting/material revocation need end-to-end trace/derived-reference cleanup tests; live collaboration/continuation coverage remains in ticket 04. Ticket remains in progress.
- Verification: focused replay tests (10/10) in the implementation worktree; after integrating with the owner blog commands and collaboration tests, the main branch passes `pnpm test` (101/101), `pnpm build`, and `git diff --check`.
