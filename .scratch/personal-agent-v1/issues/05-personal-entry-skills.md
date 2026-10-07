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
- Added owner-only `/skills` commands and four small built-in packs (career/interview, reading, research/blog, daily records); activation is persisted and requires explicit enablement. Selection is keyword-based and adds process guidance only, never tools or permissions.
- Added an authorized on-demand `search_personal_memory` MCP tool. It uses the invocation token and host-supplied authorized space IDs; model arguments cannot choose owner, source, or access scope. Search results include space, confidence, and source IDs; no-hit is distinct from bridge failure.
- Verification: `pnpm test` (38 tests) and `pnpm build` pass.
- The ordinary-message adapter now obtains its bounded memory snapshot through `UnifiedTaskRuntime`'s memory-context preparation seam. The actual query is ephemeral runtime input and is not persisted in the task trace; memory content is assembled into the CLI prompt only inside execution.
- Added owner-only `/memory spaces` and `/memory scope <space-id|all>` controls. The selected allowlist is persisted with the Feishu thread/session, validated against current spaces, and applies only to that matter; memory commands are restricted to the owner’s direct messages.
- Verification: `pnpm test` (48/48), `pnpm build`, and `git diff --check` pass.
- Remaining: affair continuation/selection beyond current-thread scoping, and context preparation for scheduled/continuation adapters. The current automatic snapshot and on-demand search remain restricted to the configured owner’s direct Feishu message path.


### Space management update

- Added owner-only `/memory space create <name>` and `/memory space rename <id> <name>`. Creation uses the store's stable normalized ID and immediately limits the current matter to the new space; rename preserves IDs and existing matter grants.
- Tests cover parser behavior, durable create/rename and owner-DM gate via temporary storage.
- Verification: `pnpm test` (65/65), `pnpm build`, `git diff --check`.
- Remaining: cross-thread affair selection/continuation and memory-context preparation for scheduled and continuation runs. Ticket remains in progress.

### Scheduled and continuation task memory context

- Approval, clarification (including product-spec retry), and document-comment continuations now use the shared bounded personal-memory provider and append retrieved text only as background context. The runtime receives only explicit `session.memorySpaceIds`; absent/legacy grants stay empty. Provider retrieval requires a non-empty query, checks actor against the trusted owner, filters within the authorized spaces, and keeps the existing 5-entry / 3,000-character bound. Prompts, answers, and retrieved memory remain ephemeral and are not written to task input/trace.
- Scheduled runs now use the same context-preparation seam, but deliberately receive an empty authorized-space list. Existing scheduled-task records store creator and chat identity, not the originating matter's memory-space grant; identity alone is not permission. Do not infer a grant from chat ID, target bot, workspace, or schedule ownership. Extend only after a trusted matter-level grant is durably represented and safely propagated.
- Document-comment events carry no comment body, so they do not perform broad/empty-query recall; they remain empty unless a meaningful trusted query becomes available.
- Public behavior tests exercise a continuation prompt receiving only memory in its explicit session grant, excluding other spaces, and a continuation with no grant receiving no memory. Existing provider tests cover non-owner/group denial and empty grants.
- Verification: focused continuation and memory-context tests pass; `pnpm build` and `git diff --check` pass. Ticket 05 remains in progress: cross-thread affair selection/continuation and broader end-to-end Feishu flow validation remain open. (Scheduled-task grant persistence was subsequently implemented and is recorded below.)


### Durable scheduled-task memory grant

- New schedules created from an owner’s direct message now persist a copy of that matter’s already-filtered authorized memory-space allowlist. The allowlist comes from host execution context, not model-supplied `schedule_manage` arguments; it is deduplicated and carried to scheduled execution through the unified runtime preparation seam. Legacy schedules without a grant remain empty, and group/non-owner creation receives no personal-space grant.
- Tests verify tool arguments cannot inject a grant, trusted matter scope is persisted and survives store reopen, and legacy records remain ungranted.
- Verification: `pnpm test` (133/133), `pnpm build`, `git diff --check`.
- Remaining: cross-thread affair selection/continuation and broader end-to-end Feishu validation. Ticket remains in progress.


### Cross-thread matter continuation update

- The owner can list/select an existing matter from another thread in the same private chat. The runtime injects only the sanitized matter summary and its still-valid explicit memory-space grants; selection clears native CLI history to prevent cross-matter leakage.
- Regression tests cover list-receipt binding, same-chat/owner restrictions, persistence, grant carryover and native-session isolation.
- Remaining: broader live Feishu end-to-end validation. Ticket remains in progress.
