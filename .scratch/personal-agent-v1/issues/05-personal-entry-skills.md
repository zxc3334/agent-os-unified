# 统一个人入口、技能和上下文召回

- Status: in-progress
- Blocked by: 04-unified-task-runtime
- Milestone: B
- Spec: [spec.md](../spec.md)

## What to build

在飞书增加默认个人入口，能按目标选少量用户确认启用的能力包；技能版本、适用条件、所需来源/记忆空间、工具需求和输出约定进入任务上下文；启动时有界召回，支持按需查记忆。

## Acceptance criteria

- 单入口可开始/继续事项；相关记忆自动可用且权限先过滤；缓存按事项/权限/版本区分或禁用；技能不能扩大权限或虚构未提供工具；普通查询召回超时可恢复，关键核验不补造。
- 为本票契约补单元/集成测试；通过公开行为验证，不以内部函数调用次数为验收。
- 完成后更新实现与验证说明；不触碰无关用户数据、生产配置或既有工作区。

## Implementation status

- The primary existing Feishu message path now appends a bounded personal-memory snapshot for direct messages from the configured owner only. Query scope is passed as trusted authorized space IDs, and relevance filtering occurs inside that scope; group messages and non-owner actors receive no private personal-memory snapshot.
- Added temporary-storage tests for owner/DM gating and space filtering.
- Verification: `pnpm test` (27/27) and `pnpm build` pass.
- Added an authorized on-demand `search_personal_memory` MCP tool. It uses the invocation token and host-supplied authorized space IDs; model arguments cannot choose owner, source, or access scope. Search results include space, confidence, and source IDs; no-hit is distinct from bridge failure.
- Verification: `pnpm test` (37 tests) and `pnpm build` pass.
- Remaining: add explicit affair/space selection and enabled skill packs, and share memory-context preparation with scheduled/continuation adapters. The current automatic snapshot and on-demand search are wired only for the owner’s direct Feishu message path.
