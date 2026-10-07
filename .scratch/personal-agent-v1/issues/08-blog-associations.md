# 授权跨空间关联与博客草稿

- Status: in-progress
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

- `src/core/blog-associations.ts` stores reference-only proposals, decisions, stance-separated draft statements, and fail-closed per-source public-use authorization. Original source content is not copied into the association store.
- `src/core/blog-source-retriever.ts` searches personal memories, daily/reading records and reference materials with a trusted space allowlist, bounded excerpts, provenance, lifecycle filtering, and provider-unavailable reporting. Material excerpts are rechecked at read time.
- `src/app/blog-entry-service.ts` and owner-only `/blog search`, `/blog propose`, `/blog decide` commands expose bounded candidates in private chat. Proposals require two distinct source IDs, remain unaccepted until explicit decision, and actor ownership is checked. Keyword candidates are not asserted to represent the user's viewpoint.
- Source lifecycle support now persists tombstones for exact `(kind, spaceId, id)` references with `revoked` or `deleted` reason. Legacy v1 store files remain readable. Tombstoned sources cannot be newly proposed, accepted, authorized for public use or drafted from; reusable-draft queries filter historical drafts that cite them, while audit history remains available.
- Tests cover authorization, source immutability, stance preservation, public-use gates, bounded retrieval, owner/group restrictions, decisions, revocation/deletion, and legacy-state migration.
- Verification: the source-lifecycle slice passed its focused core tests (77/77) in the implementation worktree; after integration, main-branch `pnpm test` passes 107/107 with `pnpm build` and `git diff --check`.
- Current boundary: owner-triggered memory rejection/forgetting, material revocation, and daily-record reclassification/deletion now write exact-source tombstones; tests cover the source lifecycle and retryable command path. Model-assisted association reasoning, outline and draft workflow remains, and the cross-store writes are sequential rather than a transactional outbox. Ticket remains in progress.


- Follow-up: owner-private `/memory reject|forget` and `/career material revoke` now tombstone the exact `(kind, spaceId, id)` reference in the blog-association store after the authoritative source mutation succeeds. Historical proposals/drafts remain auditable but are no longer reusable.
- Tests verify that rejected/forgotten memories and revoked materials make existing proposal sources inactive; unauthorized material revocation does not tombstone the source.
- Verification: `pnpm test` (115/115), `pnpm build`, `git diff --check`.
- Remaining: a durable cross-store outbox (the owner can retry a failed memory/material tombstone by repeating the forget/revoke command) and model-generated proposals/drafts remain. Ticket remains in progress.

- Follow-up: changing a daily record’s scope now invalidates its exact reference in the old space before the record mutation; references in the new space remain independently eligible. The original record is retained unchanged.
- Tests verify an existing proposal becomes inactive while the reclassified record and its content remain available in the new scope.

- Follow-up: owner-private `/daily delete <ID>` now invalidates a scoped reference with reason `deleted` before clearing the source record’s text and stance fields. Existing reminders are detached rather than cancelled; tests cover persisted deletion, privacy cleanup, blog-reference invalidation, and reminder preservation.

- Follow-up: added an owner-private `/blog propose <topic>` flow through the replaceable `BlogWritingModel` seam, plus `/blog draft`, per-source `/blog authorize`, and explicit `/blog decide` handling. The existing `/blog propose <query> :: <intended use>` command remains compatible. Draft generation enforces source activity, provenance/citation allowlists, stance separation, and explicit authorization for public use.
- The runtime wires retrieval providers into the workflow but intentionally does not configure a production model adapter. Until one is supplied, proposals/drafts report model unavailability rather than fabricating output. This is a remaining acceptance boundary, so the ticket stays in progress.
- Verification pending integration: blog workflow and private command-entry tests have been added; full suite/build will be recorded after merge resolution.
