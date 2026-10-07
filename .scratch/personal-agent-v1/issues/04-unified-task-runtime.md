# 统一任务执行与事项上下文

- Status: blocked: 01-memory-substrate, 02-extraction-recovery
- Blocked by: 01-memory-substrate, 02-extraction-recovery
- Milestone: B
- Spec: [spec.md](../spec.md)

## What to build

演进高层任务执行 Interface，统一普通消息、定时、协作、审批/澄清续跑和评论的可信身份、事项、授权空间、来源时间、取消、执行状态、产物与交付；按事项隔离原生 session 与记忆上下文。

## Acceptance criteria

- 通过同一任务测试入口覆盖各触发源；bot/引擎切换保留事项摘要和授权记忆；取消/失败/部分成功状态可观察；事项切换不串 native session。
- 为本票契约补单元/集成测试；通过公开行为验证，不以内部函数调用次数为验收。
- 完成后更新实现与验证说明；不触碰无关用户数据、生产配置或既有工作区。
