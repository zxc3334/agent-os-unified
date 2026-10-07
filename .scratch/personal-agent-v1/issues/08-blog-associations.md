# 授权跨空间关联与博客草稿

- Status: in-progress (domain core; user-facing integration depends on 06 and 07)
- Blocked by: 06-career-loop, 07-daily-records-reminders
- Milestone: E
- Spec: [spec.md](../spec.md)

## What to build

用已有能力做授权资料/记忆查询，提出可拒绝且有来源/理由的关联；生成带证据清单、个人立场、未解决问题的大纲/草稿并进行轻量来源与隐私自查。

## Acceptance criteria

- 没有关联时不硬凑；接受/拒绝不改原记忆；未确认观点不冒充本人结论；私密材料未经具体授权不进入公开草稿；无资料/联网能力时诚实说明。
- 为本票契约补单元/集成测试；通过公开行为验证，不以内部函数调用次数为验收。
- 完成后更新实现与验证说明；不触碰无关用户数据、生产配置或既有工作区。


## Implementation status

- Added `src/core/blog-associations.ts`: durable reference-only association proposals with explicit user-trigger marker, authorized-space validation, source IDs and reasoning, final accept/reject/no-connection decisions, and stance-separated draft statements. Source originals are not copied into this store.
- Public draft creation fails closed until every cited proposal source has an explicit per-source public-use authorization. Drafts cannot cite sources outside an accepted proposal.
- Tests use temporary real storage and cover unauthorized spaces, idempotent references, source immutability, no-connection, stance preservation and denied/authorized public-use paths.
- Verification after integration: `pnpm test` (73/73), `pnpm build`, `git diff --check`.
- This is only the domain core. There is no Feishu/ordinary-task command integration, no live search over the authoritative personal/daily stores, no model-driven association generation, and no material-revocation invalidation. The caller must still establish trusted actor/authorized spaces. Ticket remains in progress.
