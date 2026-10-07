# 统一任务执行与事项上下文

- Status: in-progress
- Blocked by: None
- Milestone: B
- Spec: [spec.md](../spec.md)

## What to build

演进高层任务执行 Interface，统一普通消息、定时、协作、审批/澄清续跑和评论的可信身份、事项、授权空间、来源时间、取消、执行状态、产物与交付；按事项隔离原生 session 与记忆上下文。

## Acceptance criteria

- 通过同一任务测试入口覆盖各触发源；bot/引擎切换保留事项摘要和授权记忆；取消/失败/部分成功状态可观察；事项切换不串 native session。
- 为本票契约补单元/集成测试；通过公开行为验证，不以内部函数调用次数为验收。
- 完成后更新实现与验证说明；不触碰无关用户数据、生产配置或既有工作区。

## Implementation status

- Added `src/app/unified-task-runtime.ts`: replaceable memory-context and execution adapters, trusted identity/authorized-space propagation, affair and source-time context, persisted lifecycle/progress/result/artifacts, cancellation, partial success, and failure states. JSON storage is atomic and inspectable.
- Tests use a real temporary directory and verify persistence after reopening, trusted-scope handling, progress/artifacts, defensive copies, and distinguishable cancellation/failure/partial outcomes.
- Verification: `pnpm test` (26/26), `pnpm build`, and `git diff --check` pass.
- Remaining: wire the runtime through existing message, schedule, collaboration, approval/clarification, card-action, and document-comment entry points; preserve per-affair native sessions and summaries. These production adapters are not yet implemented, so this ticket remains in progress.

### Adapter wiring update

- The ordinary Feishu message execution path and scheduled CLI execution now both enter `UnifiedTaskRuntime` with trusted actor/owner, source type/time, affair/session identity, a minimal stored input reference, cancellation signal, and persisted result. Full message text remains out of the task trace.
- The shared runtime store is attached to `AppRuntime`; state files are written with private file permissions and fsync/atomic rename.
- Approval and clarification card continuations now enter the runtime; product-spec submission retry is also tracked as its own continuation attempt. Document-comment execution enters the runtime while retaining its existing session and reply behavior. These tasks carry metadata-only durable inputs, flow/host-derived identity, no authorized memory spaces, and persist cancellation/failure outcomes.
- Targeted temporary-store tests cover approval/clarification/comment source mapping, prompt exclusion from durable inputs, empty memory scope, cancellation, and failure. Validation: `pnpm test` (45/45), `pnpm build`, `git diff --check`.
- Engine changes within an existing Agent OS session now preserve the matter identifier while clearing engine-native session IDs; switching during an active run is rejected. Regression tests verify persistence and the no-cross-engine-history boundary.
- Verification after this change: `pnpm test` (48/48), `pnpm build`, `git diff --check`.
- Remaining exactly: collaboration task dispatch/worker execution and end-to-end route tests for continuation handlers (including UI/card and product-spec retry behavior); affair summary carryover across engine/member changes; reconciliation of persisted partial CLI outcomes with existing task UI. Ticket remains in progress.


### Stable affair identity update

- Added `conversationAffairId(chatId, threadId)` and `workflowAffairId(taskId)`. Conversation task records now group across bot/engine changes without sharing their native CLI session; approval, clarification, comments, collaboration and scheduled runs use stable workflow/task IDs.
- Regression test verifies deterministic identity independent of worker identity and rejects empty identifiers.
- Verification: `pnpm test` (74/74), `pnpm build`, `git diff --check`.
- Remaining: user-facing cross-thread matter selection/continuation, carryover of a concise authorized affair summary, collaboration lifecycle end-to-end test/dispatch reconciliation, and partial-result UI reconciliation. Ticket remains in progress.


### Collaboration contract coverage

- Added a collaboration runtime test that verifies stable workflow identity, trusted actor/owner propagation, and an empty personal-memory grant. Added service-level tests for dispatch registration, destination identity, workflow metadata handoff, single-use inbox consumption, and removal of pending authorization when Feishu notification fails. These tests exercise the runtime and dispatch service boundaries, but do not replace a live Feishu end-to-end dispatch/worker test.
- Verification after the tests: `pnpm test` (101/101), `pnpm build`, `git diff --check`.
