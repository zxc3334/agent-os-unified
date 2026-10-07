# 记忆审查反馈与清理语义

- Status: complete
- Blocked by: None
- Milestone: A
- Spec: [spec.md](../spec.md)

## What to build

通过同一飞书/命令入口提供分页待确认/最近记忆，显示来源、空间、状态并支持确认、纠正、拒绝；落实忘记抑制和派生来源失效。操作身份取可信 actor。

## Acceptance criteria

- 默认最多 5 条，可继续分页；确认/纠正对新读取立即生效；拒绝候选不删来源；忘记后重提取旧输入不复活；持久化失败不返回成功。
- 为本票契约补单元/集成测试；通过公开行为验证，不以内部函数调用次数为验收。
- 完成后更新实现与验证说明；不触碰无关用户数据、生产配置或既有工作区。

## Implementation status

- Implemented `/memory [review|recent] [page]`, `/memory confirm <id>`, `/memory correct <id> <content>`, `/memory reject <id>`, and `/memory forget <id>` in the existing Feishu command path. Listing is paginated at five entries per page (up to the store’s 50-entry list bound); review/recent output includes source IDs, space, confidence, status, and safely bounded content.
- Memory commands require an exact sender match with configured `OWNER_OPEN_ID`; store owner and authorized spaces come from trusted configuration/store state, never command/model text. The store is rooted at `AGENT_OS_DATA_ROOT/personal-memory` (default `data/personal-memory`).
- Mutations use current persisted versions. Corrections record a trusted message source. Forget replies only from the redacted persisted record; failures report no success. Rejection changes the candidate status without deleting its source.
- Added public command-path tests backed by temporary storage for paging, safe formatting, owner denial, and confirm/correct/reject/forget persistence, plus parser compatibility coverage.
- Verification: focused command-path tests pass (3/3) and `pnpm build` passes. Full `pnpm test` passes (37/37) and `pnpm build` passes.
