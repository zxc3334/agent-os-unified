# 日常记录、阅读与提醒

- Status: in-progress (safe reminder clarification added; broader entry integration blocked by 05)
- Blocked by: 05-personal-entry-skills
- Milestone: D
- Spec: [spec.md](../spec.md)

## What to build

支持阅读/探索/生活记录与按需日/周回顾。日期事实与提醒分开，按源接收时间解析相对日期；提醒具备幂等创建、取消/改期、送达未知/失败/错过恢复状态。

## Implementation progress

- Implemented an owner-private MCP reminder tool with trusted message receipt time/timezone and durable persistence. Missing date/time and ambiguous clock input return explicit `needs_clarification` outcomes; invalid or date-only timestamps return validation outcomes without creating a reminder. Relative-time parsing rejects unqualified 12-hour clocks and common conflicting alternatives.
- Behavioral coverage verifies no reminder is written for missing, ambiguous, unsupported-date, or invalid timestamp input; a clear relative time is stored using the trusted source context.
- Remaining: broader reminder lifecycle delivery/recovery wiring and record capture/review flows are not part of this slice.

## Acceptance criteria

- 单次饮食/活动不自动变长期偏好；作者观点与本人意见区分；提醒重投不复活已取消任务；停机错过如实报告；回顾有时间范围和源记录且不写入永久画像。
- 为本票契约补单元/集成测试；通过公开行为验证，不以内部函数调用次数为验收。
- 完成后更新实现与验证说明；不触碰无关用户数据、生产配置或既有工作区。


## Implementation status

- Added the durable `JsonDailyRecordsReminders` core for dated daily, reading, and exploration records; source/receipt timestamps and timezones; scope changes; bounded recaps; and a separate reminder lifecycle with idempotency, edits, cancellation, delivery receipts, failure, missed recovery, and trusted-time relative date resolution.
- Owner-only `/daily` and `/reminder` commands now save/review/re-scope records, create/edit/list/cancel reminders, and use the trusted message receipt time and local timezone. Reading capture also accepts `/daily add reading <作者观点> :: <我的观点>` and persists the two positions separately. A date record never implicitly creates a reminder.
- `PersonalReminderScheduler` restores future reminders, delivers to the originating private chat with an idempotency key, reports delivered only after a transport message ID is returned, persists failures, and marks overdue reminders missed after restart with an honest recovery notice.
- Tests cover persistence, parser boundaries, private-chat authorization, timezones, explicit delivery receipts, missed recovery, and separation of records from reminders.
- Verification: `pnpm test` (65/65), `pnpm build`, `git diff --check`. A scheduler test uses a due time safely beyond startup to avoid classifying a test-runner scheduling delay as a missed reminder.
- Remaining: fuller natural-language capture/clarification, reading author-view vs user-view input controls, retry/edit UX for failed reminders, and review/summary integrations. Ticket remains in progress.


### Conversational tool integration update

- Added owner-DM-only MCP tools `capture_daily_record`, `search_daily_records`, and `create_personal_reminder`, backed by the same durable daily/reminder store and short-lived trusted invocation token. Relative dates use the message receipt timestamp/timezone; reminder delivery destination comes only from the trusted Feishu invocation.
- Requested space IDs are checked against the invocation allowlist. Recap filters by authorized spaces; unclassified records are visible only when the matter uses the default all-spaces policy, not when explicitly scoped.
- Reminder creation is immediately registered with the receipt-aware scheduler. Duplicate tool calls for the same source/action are idempotent.
- MCP tool names are normalized through CLI adapters. Tests exercise durable capture, author/user stance separation, timezone conversion, private delivery target, scope denial/isolation, and CLI alias mapping.
- Verification: `pnpm test` (67/67), `pnpm build`, `git diff --check`.
- Remaining: natural-language clarification when key date/time details are missing, user-facing retry of failed delivery, richer author/user feedback, and summary/review integration. Ticket remains in progress.

- Follow-up: failed reminders can now be retried by the owner in private chat with `/reminder retry <ID>`. Only `failed` reminders are eligible; retry preserves the previous attempt history and returns to `scheduled`, while successful delivery remains contingent on a transport receipt. Tests cover retry eligibility, persistence behavior, scheduling callback, and honest response wording.
- Verification after this change: `pnpm test` (86/86), `pnpm build`, `git diff --check`.


- Follow-up: added an owner-private conversational reminder tool that returns `needs_clarification` for missing or ambiguous dates/times instead of guessing or persisting. Successful reminders use the existing authoritative daily-record/reminder store, trusted private delivery target, and receipt-aware scheduler (no parallel reminder database).
- Tests cover missing/ambiguous timing without writes, trusted actor/token checks, scheduling after durable creation, delivery-target binding, and CLI tool-name normalization.
- Verification: `pnpm test` (114/114), `pnpm build`, `git diff --check`.
- Remaining: richer feedback and summary/review integration; ticket remains in progress.
