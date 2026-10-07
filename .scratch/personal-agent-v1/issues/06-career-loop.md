# 求职、简历与模拟面试闭环

- Status: in-progress (user-facing integration blocked by 05)
- Blocked by: 05-personal-entry-skills
- Milestone: C
- Spec: [spec.md](../spec.md)

## What to build

支持岗位需求、简历版本、项目事实与已读文本材料引用；建立项目深挖/面试技能，问题围绕实际简历主张，反馈成为学习记忆并接上现有复习状态。

## Acceptance criteria

- 未确认贡献/数字不得进入确定简历表述；引用项目来源；面试薄弱点可追踪到学习记录；复习分数/轮次在重启后保留；用户确认后才改正式简历。
- 为本票契约补单元/集成测试；通过公开行为验证，不以内部函数调用次数为验收。
- 完成后更新实现与验证说明；不触碰无关用户数据、生产配置或既有工作区。


## Implementation status

- Added `src/core/career-preparation.ts`, a local durable domain module for role requirements, source-linked career evidence, resume proposals, explicit approval of active resume versions, mock-interview records, and reviewable learning feedback.
- Unconfirmed evidence is excluded from resume claims. Interview weakness is stored as `practice-feedback`, not confirmed project fact; review score/round history survives reopening.
- Tests use a real temporary directory and cover confirmed/unconfirmed evidence, explicit approval, feedback provenance, persisted review progress, and invalid-input recovery.
- Verification: `pnpm test` (53/53), `pnpm build`, `git diff --check`.
- Remaining: connect this module to owner-authorized entry commands/skills, project and material evidence lookup, interview execution, existing learning/review scheduler, and confirmed Markdown resume output. This ticket is not complete.
