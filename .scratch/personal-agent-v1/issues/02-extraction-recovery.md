# 可靠对话提取与游标恢复

- Status: in-progress
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
- The ordinary scheduled-task runner no longer advances dialogue extraction cursors; only `MemoryExtractionWorker.processDialogueBatch` advances after committed frozen sources. Generic cursor advancement remains defensive against incomplete batches.
- Verification: `pnpm test` (33 tests) and `pnpm build` pass.
- Remaining: connect the dedicated batch path to an explicit extraction schedule/trigger.
- Dialogue and task trigger timestamps now use the normalized Feishu `create_time` when available, with host receipt time as fallback; unit-tested.
