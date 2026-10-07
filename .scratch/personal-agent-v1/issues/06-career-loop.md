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


### Natural-language interview entry

- The owner’s ordinary message path selects the explicitly enabled `career-interview` skill from natural-language triggers and appends the current approved resume, confirmed/unconfirmed evidence, target roles, and bounded authorized material excerpts for relevant interview requests. The skill directs a one-question-at-a-time interview, distinguishes evidence from inference, and concludes with strengths and review questions. The natural-language skill now distinguishes ordinary study knowledge (`save_memory`) from interview-performance feedback and requires explicit owner request/consent before feedback persistence. A deterministic positive-intent and negation gate checks the owner’s original message before issuing the feedback capability token, so a model-generated tool call cannot manufacture consent. The owner-only feedback tool is made available only in an owner DM when the skill is enabled, its natural-language trigger and explicit save request match the current message, and an active approved resume exists. Its trusted bridge binds the message provenance and active resume; persistence creates reviewable `practice-feedback` records only, never confirmed evidence.
- Verification before the persistence path: `pnpm test` (101/101), `pnpm build`, `git diff --check`.
- Verification after the persistence path: focused career/skill/tool tests (11/11; `pnpm test` also passed the full suite at 118/118), `pnpm build`, `git diff --check`.
- Remaining: project-record lookup beyond manually added text materials; automatic private delivery of due review items; feedback saving is unavailable if no active approved resume exists; and no live Feishu end-to-end execution has been performed. Ticket remains in progress.


### Owner-authorized natural-language feedback persistence

- Added `save_career_interview_feedback` to the MCP application tools. It is gated by a short-lived loopback token issued only for the configured owner in a direct chat when the enabled `career-interview` skill matches the current natural-language message, the owner explicitly requested saving in that source message, and an active approved resume is present. The tool instructions require explicit owner request/consent; its invocation is single-use to avoid duplicate learning records from tool retries. It records the model’s summary and weak point against the trusted active resume and originating message as a `practice-feedback` learning record. It does not write career evidence. Non-owner, released-token, invalid-input, and resume-evidence-separation behavior is covered through the public bridge/domain surfaces.
- Validation: focused career/skill/tool tests (11/11) and full `pnpm test` (123/123), `pnpm build`, `git diff --check`.
- This is a bounded slice, not Ticket 06 completion; the remaining gaps above stay open.

- Follow-up: career task preparation now retrieves up to three matching active project/personal memories from the current matter's explicit space allow-list, alongside up to three authorized line-cited materials. Memory IDs, versions, source message IDs, and space are included; retrieved references are explicitly not confirmed resume evidence. A test also injects out-of-scope search adapters and verifies the career context still excludes their results.
- Verification after authorized project-memory context integration: `pnpm test` (125/125), `pnpm build`, `git diff --check`.
- Remaining: automatic private review delivery; broader natural-language evidence capture and direct project-record lookup beyond matching memories/materials; feedback persistence when no approved resume exists or user consents later; and live Feishu end-to-end validation. Ticket remains in progress.


- Follow-up: explicit owner-authorized mock-interview feedback can now be persisted even when there is no approved resume. Such feedback remains a reviewable `practice-feedback` learning record and is not attached to a fabricated resume version or converted into evidence. When an approved resume exists, the trusted bridge still binds the feedback to that version. Tests cover persistence/reopen without a resume, optional interview linkage, owner authorization, and separation from evidence.
- Verification: `pnpm test` (131/131), `pnpm build`, `git diff --check`.
- Remaining: automatic private delivery of due review items, broader direct project-record/evidence retrieval beyond current authorized memories/materials, follow-up consent workflow, and live Feishu end-to-end validation. Ticket remains in progress.
