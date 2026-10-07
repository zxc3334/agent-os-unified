# 可信记忆与来源存储

- Status: complete
- Blocked by: None
- Milestone: A
- Spec: [spec.md](../spec.md)

## What to build

实现通用个人记忆的本地权威存储、稳定身份与来源/版本、空间与确认状态、最近/待确认查询、纠正/忘记及并发安全写入。学习复习卡保持兼容，不能要求通用记忆填学习字段。

## Acceptance criteria

- 采用真实临时目录的公开 Interface 测试：新建/读取/修订/忘记、重启读取、同一记忆跨空间过滤、同名空间不碰撞、冲突/陈旧版本不覆盖。显式记住仅在持久保存成功后确认。
- 为本票契约补单元/集成测试；通过公开行为验证，不以内部函数调用次数为验收。
- 完成后更新实现与验证说明；不触碰无关用户数据、生产配置或既有工作区。

## Implementation status

- Implemented in `src/core/personal-memory.ts` with atomic local JSON persistence, process-safe write locking, owner-scoped operations/source suppression, version-checked correction, authorized reads, review/recent lists, and forget/reject handling.
- Verified with temporary-directory tests for restart, space isolation, idempotency, correction conflicts, inferred-review gating, concurrent writes, context budget, owner isolation, corrupt files, and failed persistence.
- `pnpm test` includes both root and nested core tests; `pnpm build` passes.
