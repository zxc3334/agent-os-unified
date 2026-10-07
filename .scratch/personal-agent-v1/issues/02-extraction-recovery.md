# 可靠对话提取与游标恢复

- Status: complete
- Blocked by: 01-memory-substrate
- Milestone: A
- Spec: [spec.md](../spec.md)

## What to build

修复定时记忆提取：固定批次高水位、每条 source 独立幂等结果、多个候选全部落地、失败可重试、只推进连续已完成范围。普通计划不得动提取游标；使用消息接收时间和可信 speaker。

## Acceptance criteria

- 两个及以上候选都可查询；中途失败后成功项不重复且未完成项不跳过；执行期间新到消息归下批；进程重启后状态一致；提醒/其他计划不修改游标。
- 为本票契约补单元/集成测试；通过公开行为验证，不以内部函数调用次数为验收。
- 完成后更新实现与验证说明；不触碰无关用户数据、生产配置或既有工作区。

## Implementation status

- Added persistent frozen-batch primitives and a restart-safe `MemoryExtractionWorker.processDialogueBatch` path with stable per-candidate operation IDs.
- Unit tests cover multiple candidates, partial failure/retry, high-water freezing, restart recovery, and the legacy unrelated-plan cursor hook.
- Added automatic extraction after eligible tutoring/interview messages, bounded per-project batch coalescing, and startup recovery for unfinished eligible project batches. `/memory extract` is an owner-only manual trigger. Generic reminders and scheduled tasks do not advance extraction cursors.
- Failed or unavailable model extraction now throws and leaves the frozen batch/cursor retryable; an explicit `should_record: false` result is the only no-op completion.
- Extracted learning cards retain the trusted source message ID, actor ID, and original event time. New card IDs are stable per committed candidate, so retrying a persisted candidate is idempotent.
- Verified freezing/high-water, multi-candidate writes, partial retry, restart recovery, concurrent arrivals, unavailable extractor, source attribution, and cursor isolation in temporary-storage tests. Full suite: `pnpm test` (37 tests); `pnpm build` passes.
- Dialogue and task trigger timestamps now use the normalized Feishu `create_time` when available, with host receipt time as fallback; unit-tested.
