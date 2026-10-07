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
- Added owner-only `/career` commands for facts, roles/requirements, evidence-backed resume proposals, explicit approval, source-linked Markdown export, mock-interview feedback, and review score capture. Career tasks from the owner’s direct chat also receive a bounded snapshot of the active resume, source-linked evidence, and roles; private career context is kept out of group/non-owner flows. End-to-end command tests verify confirmation boundaries and exclusion of unconfirmed evidence.
- Verification after command integration: `pnpm test` (65/65), `pnpm build`, `git diff --check`.
- Remaining: natural-language/tool workflow instead of primarily slash commands, project/material evidence retrieval, interview execution integration, and connection of these learning records to the existing review scheduler. This ticket is not complete.
- Follow-up: learning records now persist review schedule state and are exposed through `CareerReviewSchedulerAdapter`. Owner-only `/career due` lists at most five due records in private chat; `/career review <ID> <0-5>` records the review. The group scheduler remains memory-card-only, so career feedback is not sent to a group.
- Verification after scheduler and command integration: `pnpm test` (84/84), `pnpm build`, `git diff --check`.
- Remaining: natural-language/tool workflow, career-context material retrieval, natural-language mock interview execution, and automatic private delivery for due review items. This ticket is not complete.

- Follow-up: added owner-DM-only `/career material add <space> <title> :: <text>`, `material search <query>`, and `material revoke <id>`. Storage remains separate from personal claims, retrieval requires current matter space authorization and returns line/version citations, and revoked content is removed from future search/read paths. Career-related prompts receive at most three matching authorized excerpts, explicitly marked as reference data rather than confirmed experience.
- Verification after material integration: `pnpm test` (90/90), `pnpm build`, `git diff --check`.
- Remaining: natural-language mock interview execution, project-record lookup beyond explicitly added text materials, automatic private review delivery, and conversational workflow replacing slash-command setup.
