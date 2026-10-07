# 事项轨迹与个人回放评测

- Status: in-progress (user-facing persistence blocked by 04-unified-task-runtime)
- Blocked by: 04-unified-task-runtime
- Milestone: B-E
- Spec: [spec.md](../spec.md)

## What to build

增加最小事项级操作轨迹与约 20–30 条合成/脱敏固定回放案例，记录任务/技能版本、来源 ID、可观察阶段、记忆操作与失败；不存完整提示词。

## Acceptance criteria

- 能解释引用与失败；执行器无 usage 时成本显示未知；轨迹写入失败不改变已完成的记忆结果；私密原文遵循忘记清理；回放逐条保存可比较结果且不外发。
- 为本票契约补单元/集成测试；通过公开行为验证，不以内部函数调用次数为验收。
- 完成后更新实现与验证说明；不触碰无关用户数据、生产配置或既有工作区。


## Implementation status

- Added content-free lifecycle trace events with opaque task/source/artifact IDs and failure codes; diagnostic sink failures are best-effort and never change task outcomes.
- Added 25 versioned synthetic replay cases and basic version/result contract tests.
- Remaining: trace persistence and safe matter-level inspection, stronger independent assertions for replay behavior (avoid fixtures that manufacture expected outputs), and privacy/revocation lifecycle integration. This ticket is not complete.
