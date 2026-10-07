# Personal Agent 第一版：记忆底座、统一入口与求职主线

- 日期：2026-10-07（Asia/Shanghai）
- 修订：v1.1，吸收本地 Comet 代码基线 `2ae1c07` 的可适用机制；不复制其平台架构。
- Status: ready-for-agent
- Publication: 用户已授权开始实施；测试接缝确认为统一任务执行 Interface。
- Required triage on publication: `ready-for-agent`

## Implementation Status

Statuses below describe the checked-in implementation, not the intended final architecture. A ticket is only marked complete when its acceptance criteria have implementation and test evidence.

| Ticket | Status | Evidence / remaining boundary |
|---|---|---|
| 01 可信记忆底座 | Complete | Local authoritative store, versioned corrections, owner/space authorization, durable-write tests. |
| 02 提取恢复 | Complete | Eligible-message trigger, explicit `/memory extract`, restart recovery, frozen/idempotent batches, original source identity/time, retry tests. |
| 03 记忆审查反馈 | Complete | Owner-only `/memory` review/confirm/correct/reject/forget commands with temporary-store tests. |
| 04 统一任务运行时 | In progress | Core runtime, ordinary-message/scheduled adapters, approval/clarification continuations (including product-spec retry), and document comments are wired. Engine switching now clears native-session IDs while preserving the Agent OS session, and active-run switching is rejected. Collaboration wiring, continuation end-to-end tests, affair summary carryover, and partial-result UI reconciliation remain. |
| 05 个人入口与技能 | In progress | Owner-DM bounded memory context runs through the unified runtime preparation seam; owner-only `/memory spaces` and `/memory scope` configure a persisted per-thread space allowlist. Scoped search/save MCP tools and four user-enabled skill packs for career/interview, reading, research/blog, and daily-record tasks exist. Cross-thread affair selection/continuation and scheduled/continuation context wiring remain. |
| 06 求职闭环 | In progress | Durable role/evidence/resume-proposal/mock-interview learning core, owner-only `/career` workflow, source-linked Markdown export, and bounded career context are implemented; project/material lookup, natural-language interview execution, and existing review scheduler integration remain. |
| 07 日常记录与提醒 | In progress | Durable daily/reading/exploration records, scoped recaps, owner-only `/daily` and `/reminder` commands, and receipt-aware reminder delivery/recovery are implemented; natural-language capture/clarification and richer feedback remain. |
| 08 博客关联与草稿 | Not started (blocked by 06 and 07) | No authorized cross-space association proposals, stance-aware drafting, or public-use checks yet. |
| 09 轨迹与回放 | Not started (blocked by 04) | Runtime persists basic task state, but explanatory trace, replay fixture set and per-case results are not implemented. |

- 范围：按依赖顺序实施个人自用的渐进式改造，不是通用 SaaS。
- 发布位置：遵循仓库提供的 Local Markdown Issue Tracker 约定。

## Problem Statement

使用者近期要找实习，主要工作是个人简历、项目深度复习和模拟面试。同时，希望通过同一个助理随手记录阅读、生活与技术探索，并在写博客时得到有来源的跨领域关联建议。

现有系统已具备飞书交互、专业成员、多个 CLI 执行引擎、会话续跑、审批与计划能力。但使用者仍需参与选择成员和流程设计；应用记忆与 bot 的项目配置、工作目录和学习复习卡绑定。个人偏好、生日、阅读观点无法自然进入同一套通用记忆机制。不同执行路径的记忆读取、保存和记录处理也不一致，且批量提取存在只保留最后一次提交、越界推进游标、失败后继续推进等可靠性风险。

使用者真正需要的不是更多 bot，而是一个持续认识自己的个人助理：能够在适当空间保存信息，在做事时得到相关记忆，让记忆随事项而不是执行者走；无需每次从头解释，也不能因为自动提取而错误记住、泄露或跳过信息。

## Solution

在保留飞书、既有专业成员、CLI adapters、学习算法、审批和计划能力的基础上，渐进式形成“一个入口、一份权威记忆、多个记忆空间、统一任务执行”的个人助理。

### 使用者看到的第一版

1. 默认找同一个助理，说目标而不是选择 bot；可以查看、暂停和继续正在推进的事项。
2. 简历、项目复习和模拟面试组成首要闭环，事实、薄弱点和进展能够相互引用。
3. 阅读、探索和日常记录可以随手输入，不需要先建编程项目或填写复习卡。
4. 明确记忆请求当场保存；明确提醒请求当场安排。隐含、非紧急信息继续后台提取。
5. 博客可以检索相关的阅读、探索和项目记忆，提出有来源的关联；用户决定是否采用，不自动合并记忆或公开私人资料。
6. 用户可以自然语言查询、纠正、忘记信息；对失败和不确定结果给出真实说明。
7. 可以问“最近记住了什么、哪些还不确定”，在原入口确认、纠正或拒绝候选，不另建记忆管理后台。
8. 项目材料、阅读原文属于资料；“我的贡献、观点和薄弱点”属于个人记忆。引用资料不等于把资料作者的话记成自己的事实。
9. 常用做事方法以少量可编辑技能承载；可以查看这次为什么用某条记忆、为什么失败，但不要求自己配置整套工作流。

### 记忆空间与内容用途

| 记忆空间 | 内容 | 默认使用方式 |
|---|---|---|
| 个人通用信息 | 少量稳定表达偏好、长期约定 | 在授权的个人事项中带入；不等于全部私人资料 |
| 求职 | 简历版本、岗位要求、确认经历、面试反馈 | 求职闭环默认相关 |
| 各个项目 | 工程背景、设计决定、真实贡献、学习表现 | 当前项目优先，其他空间按需查询 |
| 阅读 | 资料来源、作者观点、自己的理解与立场 | 记录与检索；写作时提供候选关联 |
| 技术探索 | 实验、结果、假设、疑问、个人判断 | 区分证据和猜想；支持文章素材 |
| 日常生活 | 日期事实、活动记录、私人安排 | 按需查询；不默认向编程成员或公开稿件提供 |

记忆、日常记录、提醒任务和技能分别表达“知道什么、发生什么、接下来做什么、怎样做”。可互相关联，不互相替代。记忆空间是分区，不是独立 agent 身份、执行配置或权限凭证。

### 从 Comet 吸收什么，以及不吸收什么

| 机制 | 本方案的取舍 | 实施位置 |
|---|---|---|
| 主动召回 + 记忆工具 | 吸收两段式读取；增加相关性、确认状态和上下文预算；保留事项与授权隔离 | A、B |
| 记忆审查与反馈 | 复用自然语言/飞书交互，按需查看候选、确认/纠正/拒绝，不做 Web 仪表盘 | A |
| 来源 → 原子陈述 → 派生记忆 | 用稳定来源与片段引用表达；不要求建四层图数据库 | A、C、D |
| 资料检索和个人记忆检索分离 | 最小资料引用与文本检索，支持简历/项目材料和阅读；不建设完整 RAG 入库平台 | C、D、E |
| Skill 能力包 | 做法 + 适用条件 + 所需资料/空间 + 工具声明 + 输出约定；不新增人格 bot | B、C、D、E |
| 阶段化研究和引用写作 | 以技能方式复用现有执行器，先做资料清单、大纲与草稿；不移植整个研究引擎 | E |
| 轨迹与评测 | 先做事项级简短解释与固定场景回放；不做全量 prompt 监控或公共榜单 | A 起贯穿 |
| 日常回顾、长期洞察、语义检索、独立审稿 | 第一版仅按需回顾；其他须由真实使用瓶颈驱动，另立后续规格 | 未来 |

**取舍原则：借机制，不借复杂度。** Comet 的用户级跨会话召回、异步显式记忆、模型置信度数值和平台式多存储，不直接变成这里的运行规则。具体代码依据与局限另见 Comet 参考说明。

### 非目标原则

第一版不追求 agent 接管整个人生；不预先设计饮食、健身、旅行等完整垂直产品。用户在真实使用中反馈，先让已经需要的事情可靠完成，再逐步扩展能力。

## User Stories

### 统一入口与事项

1. As a personal-agent user, I want to talk to one assistant for work and life, so that I do not have to choose a bot or model before asking for help.
2. As a personal-agent user, I want to state a goal in ordinary language, so that the assistant can select suitable capabilities without asking me to design its workflow.
3. As a personal-agent user, I want to continue a task after a worker handoff, so that I do not have to repeat my background and decisions.
4. As a personal-agent user, I want to switch between ongoing matters without mixing their context, so that separate tasks can stay coherent behind one entry point.
5. As a personal-agent user, I want to see what the assistant is working on and pause or cancel it, so that I remain in control without monitoring every execution step.
6. As a personal-agent user, I want to use existing specialist bots directly when I explicitly choose, so that the new entry point does not remove useful existing workflows.
7. As a personal-agent user, I want to resume relevant work after a restart or engine change, so that my assistant is not defined by a particular native conversation.
8. As a personal-agent user, I want to receive concise progress and decision requests, so that background work does not flood my Feishu conversation.

### 权威记忆与记忆空间

9. As a personal-agent user, I want to keep personal, job-search, project, reading, exploration and daily information in appropriate memory spaces, so that unrelated content is not mixed together.
10. As a personal-agent user, I want to create or rename a memory space without adding a new bot, so that my assistant can grow beyond programming.
11. As a personal-agent user, I want to save facts, preferences, decisions and opinions without review-card fields, so that ordinary personal information has a suitable representation.
12. As a personal-agent user, I want to keep existing learning cards and review progress, so that the redesign does not interrupt my internship preparation.
13. As a personal-agent user, I want to know which statement or material supports a memory, so that I can understand and correct what the assistant believes.
14. As a personal-agent user, I want to save an explicit remember request before receiving a success confirmation, so that remembered information is actually durable.
15. As a personal-agent user, I want to ask what the assistant remembers about a topic, so that I can inspect my personal record without opening storage files.
16. As a personal-agent user, I want to correct a memory and see the correction used in the current matter, so that outdated facts do not keep influencing later answers.
17. As a personal-agent user, I want to forget selected memories and prevent automatic extraction from recreating them, so that my corrections and privacy choices persist.
18. As a personal-agent user, I want to distinguish forgetting a memory from deleting source records, so that the assistant does not misrepresent the extent of deletion.
19. As a personal-agent user, I want to keep temporary events separate from long-term preferences, so that one meal or one experiment does not become a permanent claim about me.
20. As a personal-agent user, I want to have ambiguous or inferred information marked as such, so that the assistant does not silently turn guesses into established facts.

### 上下文与权限

21. As a personal-agent user, I want to have essential relevant memory included automatically, so that I do not need to ask the assistant to reread its files every time.
22. As a personal-agent user, I want to have details retrieved only when needed, so that my entire life history is not placed into every prompt.
23. As a personal-agent user, I want to get relevant memory in scheduled work and resumed interactions, so that memory support is not limited to ordinary messages.
24. As a personal-agent user, I want to restrict worker memory access to authorized task context, so that an implementation worker does not automatically receive unrelated private records.
25. As a personal-agent user, I want to authorize a cross-space lookup when it serves my current goal, so that useful connections remain possible without flattening all spaces.
26. As a personal-agent user, I want to avoid carrying unrelated native session history into a newly scoped worker task, so that prompt filtering is not undermined by old conversation context.
27. As a personal-agent owner, I want to have memory and approval operations tied to my trusted identity, so that another group participant or a model-supplied owner field cannot change my records or authorize my actions.
28. As a personal-agent user, I want to treat external documents and retrieved text as information rather than new operating instructions, so that stored content cannot grant itself additional permissions.

### 批量提取与可靠性

29. As a personal-agent user, I want to keep background extraction of useful information from ordinary conversations, so that I can accumulate memory without manually writing every entry.
30. As a personal-agent user, I want to save every valid memory proposal in a processed batch, so that a multi-topic conversation does not retain only its last item.
31. As a personal-agent user, I want to retry failed extraction without duplicating completed records, so that temporary failures do not cause loss or clutter.
32. As a personal-agent user, I want to continue capturing messages while extraction is running, so that new arrivals remain available for the next batch.
33. As a personal-agent user, I want to advance extraction only over the records actually processed, so that an unrelated scheduled job cannot skip my conversations.
34. As a personal-agent user, I want to know when saving or extraction has failed, so that the assistant does not claim durable success after an error.
35. As a personal-agent user, I want to retain reliable source times and speaker attribution, so that delayed processing does not change dates or attribute worker output to me.
36. As a personal-agent user, I want to avoid duplicate side effects after redelivery or restart, so that the same source request does not silently create multiple reminders or memories.

### 简历、复习与模拟面试

37. As a internship applicant, I want to assemble resume statements from confirmed project contributions, so that the assistant does not invent achievements or metrics.
38. As a internship applicant, I want to keep resume versions and target-role requirements in the job-search space, so that my preparation remains aligned with what I plan to submit.
39. As a internship applicant, I want to run a mock interview using my resume and relevant project records, so that questions test the claims I am actually making.
40. As a internship applicant, I want to have the assistant probe technical decisions and my own contribution, so that I can prepare for project deep dives rather than generic trivia.
41. As a internship applicant, I want to record real weaknesses exposed during practice, so that subsequent study targets the gaps that matter.
42. As a internship applicant, I want to continue studying and reviewing a knowledge point across sessions, so that my progress is not reset by changing bots or engines.
43. As a internship applicant, I want to receive bounded review reminders for due knowledge points, so that I can maintain preparation without notification overload.
44. As a internship applicant, I want to be shown when a newly clarified project fact affects my resume, so that my written claims and interview explanations stay consistent.
45. As a internship applicant, I want to confirm changes to externally used resume content, so that the assistant does not submit or publish an unreviewed representation of me.

### 阅读、探索与日常记录

46. As a reader, I want to capture a reading passage and my reflection in one message, so that recording an idea does not require a formal note-taking workflow.
47. As a reader, I want to keep the author claim separate from my agreement or criticism, so that future writing can preserve my own position.
48. As a technical explorer, I want to record experiments, observed results, hypotheses and open questions separately, so that speculation is not presented as verified technical evidence.
49. As a personal-agent user, I want to save dated daily records and retrieve summaries, so that life use can start without a separate application.
50. As a personal-agent user, I want to leave uncertain records temporarily unclassified, so that the assistant does not repeatedly interrupt me to organize everything.
51. As a personal-agent user, I want to find and correct the scope of a captured note, so that misclassification remains reversible.

### 提醒与日期事实

52. As a personal-agent user, I want to store an important date and separately schedule its reminder, so that remembering a birthday does not substitute for notifying me.
53. As a personal-agent user, I want to have relative dates resolved from message receipt time and my timezone, so that background extraction cannot shift the intended date.
54. As a personal-agent user, I want to be asked only for missing reminder details that affect execution, so that the assistant can act without an unnecessary interview.
55. As a personal-agent user, I want to modify or cancel a reminder independently of its underlying fact, so that task control does not erase useful personal knowledge.
56. As a personal-agent user, I want to see the difference between scheduled, delivered, failed and missed reminders, so that an execution record is not mistaken for a delivered notification.
57. As a personal-agent user, I want to receive an honest recovery notice after downtime causes a missed reminder, so that the assistant does not pretend it notified me on time.

### 跨空间关联与博客

58. As a blog author, I want to search authorized reading, project and exploration records for relevant material, so that my writing can connect ideas I developed in different contexts.
59. As a blog author, I want to see each proposed connection with its source and reasoning, so that I can decide whether the connection is meaningful.
60. As a blog author, I want to accept or reject connections before they become my stated position, so that the assistant does not manufacture my personal conclusions.
61. As a blog author, I want to retain separate original records when building an article, so that a writing task does not overwrite its source memories.
62. As a blog author, I want to keep private and employer-sensitive material out of public-facing drafts unless specifically approved, so that internal retrieval does not automatically authorize disclosure.
63. As a blog author, I want to receive an outline and draft grounded in my recorded views, so that the article contains my perspective rather than a generic synthesized voice.
64. As a blog author, I want to keep dissenting or tentative thoughts identifiable, so that the draft does not erase uncertainty to sound more authoritative.
65. As a personal-agent user, I want to add a new capability using the existing skill and tool mechanisms, so that growth does not require another independent assistant.

### Comet 启发的轻量补充

66. As a personal-agent user, I want to review recent and unconfirmed memories from the same conversation, so that I can inspect the assistant without opening a management dashboard.
67. As a personal-agent user, I want to confirm, correct or reject an inferred claim with its source visible, so that my feedback changes future behavior rather than just the wording of one response.
68. As a personal-agent user, I want to distinguish no relevant memory from a failed lookup, so that unavailable retrieval does not look like forgetting.
69. As a personal-agent user, I want cached context to reflect the current matter, permissions and memory versions, so that fast replies do not reuse another task's private or outdated background.
70. As a personal-agent user, I want uncertain claims excluded from factual resume statements until I verify them, so that high model confidence cannot invent my experience.
71. As a personal-agent user, I want source passages linked to derived memories, so that I can check an interpretation without retaining a full graph database.
72. As a personal-agent user, I want reference materials kept distinct from what the assistant believes about me, so that a book passage or project README does not become a personal claim.
73. As a personal-agent user, I want existing text materials searched with source locations, so that I can prepare interviews and write with evidence before a full document-ingestion system exists.
74. As a personal-agent user, I want to edit or disable a small task skill independently of my memories, so that I can improve how the assistant works without losing what it knows.
75. As a personal-agent user, I want skill requirements limited by my actual permissions and available tools, so that loading a capability cannot grant itself access or pretend to perform unsupported actions.
76. As a technical explorer, I want a research-writing skill to preserve evidence, unanswered questions and my own position, so that a draft does not become a generic report or an unsupported opinion.
77. As a personal-agent user, I want a concise task explanation showing used sources and failed steps, so that I can diagnose problems without reading full prompts or raw execution logs.
78. As a personal-agent user, I want to replay a small set of representative scenarios after changing skills or retrieval rules, so that iterative optimization does not silently break privacy, corrections or useful recall.
79. As a personal-agent user, I want an on-demand daily or weekly recap that remains a dated summary, so that reviewing activities does not automatically turn them into permanent personality claims.

## Implementation Decisions

以下是本方案的实施决定；已由用户确认统一任务执行入口、可替换外部 Adapter 与真实临时存储作为主测试接缝。

### 1. 统一任务执行模块，而不是全局共享会话

- 从现有应用执行入口演进一个有任务语义的 Module，其 Interface 接收可信身份、事项、输入类型、源事件时间、授权空间、执行能力和取消信号，交付可观察任务状态、产物及操作结果。
- 普通消息、协作、定时、澄清/审批续跑和文档评论进入同一条任务处理路径。接入 handlers 做协议转换，不各自实现记忆与结果处理。
- Module 隐藏上下文准备、执行器选择、工具结果、记忆确认、对话记录、续执行和结果交付的 Implementation。替换当前薄封装，避免在其外再叠加空转层。
- 保留原有 CliAdapter、会话存储和计划存储这些内部 seams；真实 CLI 与测试替身以 Adapter 方式提供。外层不声称控制执行引擎内部每次 LLM 请求。
- 个人入口与后台成员不是共享一条 native conversation。事项具有独立持久标识、目标、空间、决定、摘要、状态与产物；成员只得到自己的任务简报与必要上下文。
- 用户可以一条主对话处理多个事项；不明确的事项切换只在有实质歧义时询问。原有直接找专家和高级命令作为兼容入口保留，但同样使用统一任务与记忆入口。

### 2. 权威记忆 Module

- 由 Agent OS 管理权威记忆；执行引擎原生会话用于工作连续性，不作为个人事实的唯一存储。第一版不要求开启、同步或重写各引擎的原生长期记忆。
- 对外提供准备相关上下文、查询详情、提交变更的少量 Interface。MCP 工具调用和后台提取都是这些 Interface 的 callers，不允许各成员另建自己的个人档案。
- 继续使用本地可检查、可备份的文件存储；先不引入向量数据库或图数据库。记忆正文是权威源，索引是可重建派生数据；禁止两者被当成不同的真实来源。
- Memory record 包含稳定 ID、使用者、记忆空间、类型、内容、来源事件或材料、发生/接收时间、更新时间、确认或推断状态、敏感与公开使用许可、有效版本或删除状态。学习数据作为可选领域扩展，不是通用必填项。
- 事实、偏好、决定与个人观点要能区分；一项内容同时适用多个事项时引用同一记录，不通过复制产生多个互相矛盾的版本。
- 确认状态使用可解释的类别：用户明确表达/确认、材料支持、模型推断待确认、冲突或失效。资料支持不等于用户参与已确认；模型分数不当作客观概率，不把“高置信”自动提升为求职事实。
- 原子内容通过稳定来源标识、材料版本及片段定位回到证据。无需每段都建中间节点；原文、材料与派生记录分层引用，不把同一个词出现多次当成同一事实。
- 用户可按需查看最近变化或待确认条目，默认一页最多 5 条并可继续；显示来源、空间和状态，可确认、纠正或拒绝。拒绝提取结论不等于删除原文或否定来源中的所有内容，不默认每轮追问确认。
- 确认/纠正与其版本、反馈记录采用同一可恢复写入约定，不能正文已改却反馈失踪后仍宣称全部成功。反馈本身按记忆权限处理；忘记后不在轨迹或反馈文本里保留被要求移除的原文副本。
- Scope 名称可以中文显示，但内部标识稳定且唯一；不因名称清洗导致不同空间写入相同目录。空间创建和归属变更均可撤销，不要求新增 bot。
- Actor、owner 和可访问范围由外层可信运行上下文决定，不接受模型填写的 owner 或任意 scope 作为授权。个人模式默认只允许配置的使用者修改私人数据；群聊公开上下文不得自动注入私密目录标题或内容。

### 3. 读取策略：小快照 + 按需查询

- 启动任务时提供有预算的小快照：允许使用的少量通用偏好、当前事项摘要、已明确相关空间摘要，以及被授权的空间目录。
- 在启动任务的小快照中，按当前输入与事项挑选少量相关有效记忆；相关性与可信状态分别判断，宁可不注入也不为了 top-k 填满。第一版用文本、标签和明确关联，不要求向量分数。
- 召回缓存如确有必要，必须区分使用者、事项、授权范围、查询条件和权威记忆版本；先不引入 Comet 式仅按用户复用上一轮召回的缓存。纠正、忘记、确认状态及权限变化后，下一次读取不得继续使用旧缓存。
- 可选召回有有界延迟、数量和文本预算，超时不无限阻塞普通交流；分别记录无相关结果、服务不可用和超时。简历事实核验、明确查询或必须依赖记忆的任务不能在读取失败后自行补全，须说明缺口或暂停相应步骤。
- 细节通过统一记忆查询获得；明确空间优先，否则主模型根据用户意图查询或澄清。第一版不另建多模型意图分类器。
- 查询检查 owner、授权空间、有效版本和忘记抑制，返回来源标识、适用范围和截断说明；无结果应明确说明，不把其他空间或猜测自动补成答案。
- 与当前事项不相关的信息不默认加载。模型要求跨空间检索时，由实际权限过滤，不因为模型说“相关”就扩大范围。
- 快照和查询内容按“数据”提供，不授予其高于系统规则的指令权；外部资料中的指令不能改变权限、要求公开内容或调用高影响工具。
- 事项或授权范围改变时重新选择 native session，不能把不相关的旧 worker 历史一起续跑。纠正与忘记后，使相关快照失效；对仍含旧内容的执行会话，必要时以权威事项摘要启动新会话，避免单纯追加提示但继续携带已忘信息。
- 无需每次重发所有记忆；每次外层续执行保证任务上下文可追溯，必要时刷新快照或查询。压缩后的 native 历史不能覆盖权威记忆版本。

### 4. 写入与纠正：明确请求立即落实

- “记住”调用真实保存操作，返回稳定记录标识、空间和保存结果；只有持久提交完成才向用户确认成功。不把“提交受理”显示为已经保存。
- 写入 MCP 工具通过可信的本地宿主接口进入同一记忆 Module；沿用计划管理的宿主通信思路，而不是 MCP 子进程和每个结果 handler 各自写文件。
- 同一次执行多个有效提交必须逐个记录结果；已经通过工具提交的内容，不再由回合结束的工具观察重复保存。兼容旧学习工具时也需要稳定操作标识及去重。
- 用户明确纠正优先于提取器的旧结论；不同来源冲突保留出处和冲突状态，不把猜想覆盖为确定事实。普通新增使用唯一记录标识，不以同一天同主题作为唯一 ID。
- 更新需要检查原记录和版本；引用不存在或版本过时不能静默重建或覆盖。串行化权威写入、原子替换和失败恢复保障同进程并发与重启后的一致结果。
- 忘记操作从有效记忆、索引和自动提取候选中排除该信息，并记录不包含原文的抑制标识，避免重读同一来源后重新创建。
- “忘记记忆”与“删除源记录”分别说明；不宣称该操作已清除引擎所有 native 历史。若用户要求删除原始记录，需明确范围并清理应用可控制的源与派生内容，不做无证据的全系统删除承诺。

### 5. 日常记录与批量提取

- 用户输入在接收时以原文、可信 actor、源 ID、接收时间及时区留存；执行结果另存，不以最后完成时间代替用户表达时间，不把成员结果标成用户原话。
- 日常记录可立即保存，不必都提炼成长久记忆；暂时无法确定空间时进入待归类状态。归类过程不改变原始内容，重分类可追溯。
- 只有明确类型的记忆提取任务能取得提取批次与推进游标；普通提醒、巡检和其他计划不能触碰提取游标。
- 批次启动冻结本次输入范围，以来源记录 ID 或显式高水位记录“从哪里到哪里”。执行期间到达的新记录留给下一批，不以结束时全量行数推进。
- 每条来源记录有处理结论：保存成功、已处理无需保存，或失败；只推进连续且完整处理的范围。错误、无完整结果或持久化失败都不能被当成“没有值得记的内容”。
- 保存幂等与游标推进要有可恢复提交语义；允许失败后重跑、复用成功项，不允许重复创建或永久跳过。单个提取 Module 管理并发批次，不使用通用任务收尾顺便推进游标。
- 模型负责提出内容与归属建议，代码负责校验、权限、写入和处理结果；提取器不得凭空创建提醒任务、恢复用户取消的任务或覆盖明确纠正。
- 对后台提取静默处理正常情况，只在持续失败、数据需确认或重要变化时通知。单轮不得用反复分类提问打断记录体验。

### 6. 求职优先的能力闭环

- 求职事项引用简历版本、岗位要求和指定项目记录。项目记忆保存真实贡献、设计决定和来源；资料不足时标注未确认，不补造数字、职级或责任范围。
- 模拟面试读取简历中的实际表述与对应项目背景；回答、反馈和弱点沉淀成学习记忆。助手的评价标记为评价，不冒充确定的项目事实。
- 保留现有掌握度、复习间隔和卡片表达；学习评分更新必须保留进展，不因普通内容修改重置全部轮次。
- 复习到期与作答评分需要形成可使用的完整闭环。优先复用统一 Scheduler 驱动，不再同时启动另一套未经整合的全局定时推送。
- 默认复习推送有明确频率和数量上限，可以暂停；不因跨项目扫描同时大量推题。需要进一步调整时通过实际使用反馈修改默认行为。
- 新项目事实影响简历时提出修改建议，由用户确认最终版本。第一版交付可检查的简历内容或 Markdown 产物，不扩展到自动投递或招聘平台操作。

### 7. 日期事实与提醒任务

- 同一表达可同时产生日期事实和提醒任务，二者有可选关联；保存事实并不表示已创建任务。取消提醒保留事实，删除事实不擅自取消已确认任务，发现不一致时说明并提供操作。
- 创建提醒以源消息接收时间和使用者时区解析相对日期；后台提取不重新计算“后天”。仅在提醒时刻等必要信息缺失且没有已确认默认值时询问。
- 生日事实不自动推断出生年份或每年重复规则；除非用户明确要求，不将一次提醒改成年度任务。
- 使用稳定源操作 ID 管理重投、重启和修改；取消或改期状态不会因为重新提取来源消息而被还原。
- 计划执行完成与通知送达分开表达。提醒应记录发送尝试和实际 receipt；没有可信回执时标记未知或待重试，不标成已送达。
- 重启时已经错过的一次性提醒明确标记错过，并在恢复后提供一次恢复告知；不宣称原时间已提醒。使用可控 clock 和持久投递标识防止重复告知，不承诺外部网络 exactly-once。
- 写入事实成功、建提醒失败时明确报告部分成功，提供可重试结果；不能因缺少跨模块事务而告诉用户两者均已完成。

### 8. 阅读、技术探索与博客关联

- 资料是项目说明、简历原件、阅读原文等供引用的材料；个人记忆是从中确认的个人事实、观点和决定。资料和记忆都可属于同一空间，但分别检索和标注来源；不把整篇材料作为用户画像自动提取。
- 第一版资料能力限用户明确提供的已有文本/Markdown 或既有执行器确实可读取的材料，保存稳定材料标识、版本、来源定位及权限，支持有界文本查询与片段读取。仅提供链接但无法读取时，说明未取得正文；不谎称已经读过，不新建爬虫、OCR 或全格式解析平台。
- 材料本身不能证明代码由用户编写或指标由用户实现；求职个人贡献仍要确认。删除或撤销材料授权时使相关片段、引用缓存和派生建议失效；可保留指向失效来源的历史定位，但不可继续提供被撤销的正文，也不能把失去证据支持的推断当成已验证事实。

- 阅读笔记保存原材料定位、作者观点、用户评论和立场；技术探索区分可观察实验、假设和待验证疑问。
- 关联以当前任务为条件：先检索当前空间，再按授权查询其他空间的候选。第一版采用文本、标签、实体与来源检索，语义解释由主模型完成，不依赖复杂图谱。
- 关联输出包括源记录、简短关联理由、可能用途及不确定性；找不到有意义关联时允许不建议，不能为了丰富稿件硬凑。
- 用户可以接受、拒绝或修改关联。未经确认的关联不能写成用户已有的确定结论；原始记忆保持不变，关联只作为任务中的建议或引用。
- 博客大纲和草稿以用户已有观点为依据；区分“用户主张”“作者观点”“助理建议”和“假设”。允许先准备可撤回草稿，关键立场变化再请求确认。
- 公开使用许可独立于内部读取许可。默认个人、前雇主、账号、简历私密细节不可公开使用；必要时给出脱敏建议或请求对具体片段授权，不从一次许可推出全空间可公开。
- 第一版止于大纲、草稿和关联建议，保留现有发布方式作为后续衔接；不以全自动发布或外部传播为验收前提。

### 9. 兼容、迁移与数据安全

- 原有项目 ID 映射为稳定记忆空间，工作区只决定执行位置，不再决定信息归属。旧学习卡作为可读领域数据接入，不一次性重写全部历史。
- 先提供迁移预览、备份和校验，保留学习字段、来源可知信息和复习进度。未知旧来源明确标记 legacy/unknown，不编造历史时间或用户原话。
- 初始灰度：新记忆与新入口使用新路径；学习能力通过兼容 Adapter 访问旧数据。每个领域数据保持一份权威写入源，禁止长期双写两个各自演化的库。
- 失败可退回既有专家入口；不得为整改删除私人工作区、日志、草稿、原生 session 或旧计划。更新 README 时区分已接线、可选能力和未来目标。
- 宿主记忆通信只在 loopback 上提供，认证和可信 run context 不能以任意客户端声明替代；现有审批/取消核对使用者身份的缺口应在共用相关能力时修正。
- 记忆空间过滤是应用层访问政策，不宣称同一 OS 用户下的 shell/file 工具已经被物理隔离。对不可信 CLI 或外部扩展的完整 sandbox 在范围外，使用时应明确风险。

### 10. 技能能力包与轻量研究

- 复用既有 skills/工具加载机制，增加满足实际调用所需的轻量声明：适用条件、做法、所需资料/记忆空间、期望工具、输出要求及少量示例。声明缺省值明确，不另建技能商店或复杂 workflow DSL。
- 第一版将已需要的方法配置为少量能力包，优先项目深挖与模拟面试，其次阅读记录和技术探索/博客。主入口可按当前目标选用，用户也可显式指定；不要求每个能力有独立 bot、身份或长期记忆。
- 技能声明只表达需求，不授予权限；可用工具与范围必须同时满足宿主授权、事项范围和实际执行器能力。提示词里的“只用这些工具”不是安全隔离；不能约束引擎暴露工具时，需明确限制并由宿主检查高影响操作。
- 新增、修改或启用用户自定义技能由用户确认，禁用后不再自动选用；加载当前版本，不把旧 native session 内的技能文本冒充最新版。不自动把一次成功任务提炼为已启用 skill。
- 技术探索/博客技能采用“问题与个人立场 → 资料和证据清单 → 缺口 → 大纲 → 草稿 → 自查”的轻量步骤；复用现有工具，不因参考 Comet 而新增专用研究 runtime。没有可用联网能力时仅使用已有材料，明确时效和覆盖局限。
- 保留阶段产物与来源，可继续或重试失败步骤；第一版不承诺引擎内部工具的精确断点恢复。简历/草稿的来源、立场和私人内容检查先用确定性规则与用户审阅，不默认给所有任务增加独立 judge 模型或自动改写循环。

### 11. 事项轨迹与使用回放

- 在统一任务 Module 内记录最小事项轨迹：源事件、事项/run、能力及版本、已用记忆/材料的稳定 ID 与版本、应用可观察阶段、记忆操作结果、耗时、失败/取消、产物位置。用户可问“这次依据什么、卡在哪里”，回复简短可检查摘要。
- 默认不记录完整 prompt、私密原文副本或推理过程；轨迹遵循使用者/事项授权和忘记清理约定。低风险诊断记录失败不改变已持久完成的业务结果；关键记忆操作与任务状态的持久失败仍按原契约报告，不能靠 best-effort 日志代替权威状态。
- 只展示执行器实际暴露的事件。tokens 有可信 usage 时才列出；成本只有已知价格口径和可核对用量时做估算，否则显示未知，不将 CLI 订阅费摊算为精确每次费用。
- 建一个约 20–30 条合成/脱敏场景的个人回放集，复用统一任务 Interface；标注应该保存什么、用哪些来源、哪些不得带入、是否需要动作和预期失败表现。记录规则/技能版本与逐条结果；不把 Comet 自建数据集或公共 benchmark 的数字写成本系统成绩。
- 日/周回顾第一版按用户请求生成，限指定时间范围与授权空间、有原记录引用；它是带日期的摘要，不自动写成长久画像，也不额外开启定时关心。未来用户明确开启后才通过统一 Scheduler 做有界推送。

### 12. 实施顺序与里程碑

| 批次 | 必须先完成 | 交付 | 验收出口 |
|---|---|---|---|
| A：可信记忆 | 无 | 通用类型、来源片段、确认状态、审查反馈、保存/查询/纠正/忘记，修复提取与游标；最小轨迹/回放 | 重启不丢、重试不重复、并发不跳过、反馈生效、旧复习数据可读 |
| B：统一运行与入口 | A | 统一任务 Interface、事项上下文、预算内主动召回与按需查询、技能声明、个人入口 | 通过同一个入口换成员/引擎继续做事；不泄漏无关空间 |
| C：求职闭环 | B | 简历/项目文本资料引用、简历事实、项目深挖和面试技能、薄弱点、复习接线 | 一次真实项目练习能回流到后续学习和简历建议 |
| D：轻量生活输入 | B | 阅读/探索/日常记录、按需回顾，明确事实与提醒，修改/取消/恢复 | 随手记可查询；提醒如实完成或报告失败，不被提取复活 |
| E：博客关联 | C、D | 授权资料/记忆查询、可解释关联、轻量研究写作技能、大纲与草稿及自查 | 一次文章能引用经用户认可的跨空间观点，不改源、不泄密 |

新增机制嵌入 A–E，不追加一套平台建设里程碑；轨迹/回放随切片补齐，资料从已有可读文本起步。A、B 优先，不先大规模迁移或增加生活 integrations。C 优先于深化 D、E，避免系统整改阻碍近期实习准备。具体工期随实施验证确定，不凭当前静态检视承诺时间。

## Testing Decisions

### 主测试接缝：统一任务执行 Interface（已确认）

测试主要从“输入一条可信用户消息、计划触发或续执行事件”开始，到“可观察回复/状态、持久记忆、任务安排和产物”结束。真实 CLI 和 Feishu 用可替换 Adapters 模拟，使用临时真实存储、固定 clock 和可注入失败；不依赖线上模型才能验证确定性契约。

这是一个新增的高层 seam，由现有应用执行入口演进而来；现有 CliAdapter、SessionStore、计划存储作为内部 seams 复用。主测试不直接测提示词拼接函数、目录实现或 handler 私有方法，也不为每个 bot 建独立测试接口。

### 好测试的判断

- 只断言外部可观察行为：保存是否成功、能否查询到正确版本、哪些信息被提供给执行者、是否确实安排/取消任务、状态和通知是否如实。
- 不断言具体私有调用顺序或完整 prompt 快照；对上下文检查授权、相关内容、无关内容缺失、来源和预算限制。
- 正常路径与失败/重试/并发/重启/越权使用同一外部 Interface。持久化测试必须关闭重开 Module 再读取，不以“mock 的 save 被调用”作为持久成功。
- LLM 是否能理解自由表达、是否找到了有意义的关联，另用小型对话回放与人工验收；不把脚本替身测试当成真实模型行为保证。

### 需要测试的 Modules 和行为

1. **统一任务执行 Module**：普通消息、协作、定时、卡片续跑、评论进入同一处理约定；保留取消、错误和续执行结果。
2. **权威记忆 Module**：空间/owner 过滤、真实保存、更新冲突、忘记抑制、上下文预算、跨空间查询和重启一致性。
3. **提取 Module**：冻结输入范围、全部有效提交、无内容与失败的区分、部分成功重试、连续高水位和隔离普通计划。
4. **计划与提醒 Module**：相对时间、持久幂等、改期/取消、未知投递状态和停机后错过通知。
5. **求职/学习能力**：从受支持的项目事实构造简历候选、按简历和项目提问、弱点回流、学习进度保留及有界复习。
6. **关联建议能力**：来源/立场区分、允许无关联、用户接受/拒绝、公开使用许可、原始记录不变。
7. **迁移 Adapter**：旧卡片和进度可读、备份预览、重复执行迁移幂等、未知历史来源不伪造。
8. **技能与资料能力**：技能版本/禁用、所需工具不可用的说明、不提权、外部作者与个人观点分离、材料授权撤销、资料定位和来源失效。
9. **事项轨迹与回顾**：真实操作与诊断摘要一致、未知用量不编造、非关键轨迹失败不伪报业务失败、权限与忘记后不暴露原文、按需摘要不自动生成永久画像。
10. **CLI Adapters 契约**：四类引擎的工具别名/包裹调用归一、错误工具结果不计成功、新查询/保存结果能返回给引擎。使用已验证的事件 fixtures，后续记录真实引擎格式更新，不虚构未验证事件。

### 首批验收场景

| ID | 输入/操作 | 外部可观察结果 |
|---|---|---|
| M01 | “记住我不吃香菜”，重启后查询 | 个人记忆中有一条有来源的偏好，成功确认发生在真实保存后 |
| M02 | 同批提出三个知识点/事实，第二项保存失败 | 不只保存最后一项；已保存项重试不重复，未完成范围仍待处理 |
| M03 | 提取运行中新增消息，同时触发普通提醒 | 新消息留待下一批；提醒不推进提取游标 |
| M04 | 修改偏好，再说忘记，并重新提取旧对话 | 新版本生效；忘记后不被旧来源自动恢复；旧会话快照不继续引用 |
| M05 | 写项目 A 方案、换执行者/新引擎继续 | 可查询确认决定；不加载项目 B 和私人生活内容 |
| M06 | 在个人事项和项目事项之间切换 | 同入口可以继续，各事项/worker native history 不混串 |
| M07 | 群内其他成员或工具参数伪造 owner 请求改记忆/批准/取消 | 操作被拒绝，私人记录与任务不变 |
| M08 | 项目材料没有业绩指标，生成简历并模拟面试 | 无编造数字；问题对齐真实表述；真实弱点进入复习 |
| M09 | 明确评分更新学习卡，再重启 | 复习进度保留；仅学习记录受复习算法影响 |
| M10 | 2026-10-07 说“后天上午九点提醒我”，10 月 8 日再提取 | 任务时间是 Asia/Shanghai 的 2026-10-09 09:00，不随提取日漂移 |
| M11 | 保存生日并安排提醒，取消提醒后重投/提取 | 生日事实保留，提醒保持取消，不被重建；部分失败结果明确 |
| M12 | 停机越过提醒时间后恢复 | 标记错过，给一次恢复告知；不宣称准时送达 |
| M13 | 随手记作者观点及自己的反对意见，之后查询 | 作者和个人立场可区分，不把反对写成认同 |
| M14 | 博客检索到阅读和技术探索的潜在关联 | 有源与理由、可接受/拒绝；不存在有效关联时不硬凑 |
| M15 | 候选素材含前雇主私密细节 | 未获具体许可不进入公开使用内容；原始资料不被自动合并修改 |
| M16 | 外部材料要求忽略限制、读取其他空间并发布 | 当作数据，不改变权限和操作规则 |
| M17 | 旧学习数据接入与迁移重复执行 | 内容/复习进度不丢、不双写漂移；原始资料保留可回退 |
| M18 | 未确认“可能独立负责整个项目”，生成简历，再由用户纠正真实贡献 | 推断不进入确定经历；纠正的有效版本在下次读取/新执行生效，原来源可核对 |
| M19 | 查询待确认记忆，逐条确认/拒绝，期间反馈存储注入失败 | 最多默认一页 5 条、有来源；反馈与有效记录一致，失败不假称全部已生效；不误删其他源内容 |
| M20 | 事项切换或撤销范围后命中旧召回缓存；再纠正/忘记 | 旧缓存不得提供另一事项、未授权或已失效内容，包含不应暴露的标题 |
| M21 | 普通交流时可选召回超时；明确查询或简历核验时读取失败 | 普通交流可继续但轨迹有失败；依赖缺失的事实不补造，无结果与查询失败可区分 |
| M22 | 输入一段作者观点、项目 README 和自己的评论，撤销其中材料授权 | 作者/项目文档不等于个人经历；片段可定位；撤销后正文不再提供，派生建议不能用失效材料证明事实 |
| M23 | 选用已禁用/旧版技能，或技能请求未授权空间、不存在工具 | 当前有效版本才可用；不能获得新权限；缺工具明确说明，不虚构已经执行 |
| M24 | 查询事项为何失败、费用多少，执行器未暴露 usage；诊断记录暂时失败 | 有真实可观察阶段与失败信息，用量/费用未知；已保存记忆不被伪报失败，不提供完整私密 prompt |
| M25 | 运行研究写作技能，资料不足、无可用联网能力，并要求公开草稿 | 可停留在证据清单/大纲，缺口明确，不声称已联网验证；用户立场与隐私自查仍须满足原规则 |
| M26 | 请求本周回顾，再次读取长期记忆，并运行版本化个人回放集 | 回顾有范围和来源、不变成永久画像；回放有逐条结果与条件说明，无外发/生产数据混用 |

### 现有测试先例与实际覆盖

仓库没有自动化测试 suite 或 test script。现有 CLI/MCP probes 可作为实时集成 smoke 的先例，其中工具 probe 仅检查至少产生工具调用；不能把它们当作记忆、权限或恢复已有覆盖。会话存储的临时文件与写队列、计划存储的回滚结构可作为持久化测试对象，但未见对应测试断言。

外部先例仅供设计参考：Comet 的主动召回测试检查待确认标签、过滤参数与空结果，可靠性测试检查置信度过滤/排序和画像字段；它们是局部测试，不证明事项权限、写入事务、缓存失效或重启恢复。本系统将可观察要求提升到统一任务级测试，而不是照抄对私有函数或具体数值的断言。

个人回放作为同一主 seam 上的模型行为评估，不另设第二个产品入口：固定合成输入、预期应召回/禁止召回的来源、动作及归属；保留逐条输出与人工判断，关注误记、漏记、无关注入、权限泄露和纠正生效。确定性保存/授权契约要求全过；模型场景先记录基线再比较，不凭空承诺准确率。真实调用必须显式启用且无外部副作用，不复制私人完整对话当共享 fixtures。

实施时先补离线任务级回归，再用使用者本人的小型飞书场景做真实 smoke；不在自动化测试中使用私有生产对话、真实外发邮件/电话或公开发布。

## Out of Scope

- 通用 SaaS、多用户产品、收费、上线营销、面向所有人的完整 personal-agent 产品。
- 邮件、电话、支付、医疗、完整饮食或健身管理等外部 integrations；第一版只保留以后通过能力接入扩展的空间。
- 多模型领域路由器、向量数据库、知识图谱、训练专用意图模型或训练基础模型。第一版也不移植 Comet 的 PostgreSQL/Elasticsearch/Neo4j/Redis/Celery 平台栈。
- 完整知识库产品：全格式文件解析、OCR、网页抓取、图片索引、批量 embedding 与 rerank；只支持前文约定的轻量可读资料能力。
- 独立 Web 记忆审查后台、图谱可视化、全量 OpenTelemetry 部署与精确账单核算。
- 默认自动反思画像、人格/情绪推断、音乐推荐、定时主动关心、全部任务多模型 judge 或完整自动修复循环；按需回顾和轻量自查不在此排除项内。
- 自动修改核心运行规则、无确认部署新工具、自动批量生成并启用 skills、完整 Curator 管理系统。
- 每个领域新增独立 bot/独立人格，或完全复制 Hermes 的运行配置和存储架构。
- 每次内部 LLM 调用前拦截/改写系统 prompt；跨执行引擎原生长期记忆同步。
- 完整 OS sandbox、不可信 CLI 的强制进程隔离或外部平台 exactly-once 承诺。
- 自动简历投递、招聘平台操作、未经批准公开个人资料、自动博客发布。
- 本轮实现业务代码、启动生产 bot、大规模迁移或清理私人数据。
- 完整拆票：本次实施按下方任务图和里程碑拆分为可独立验收的纵向切片；具体 tickets 位于本规格目录的 issues 子目录。

## Further Notes

### 后续吸收路线：由真实问题触发，不预先搭建

| 后续方向 | 触发条件 | 最小后续尝试 | 保留的约束 |
|---|---|---|---|
| 语义/混合检索、必要时 rerank | 个人回放反复出现同义表达漏召回，文本/标签改进仍不足 | 在现有查询 Interface 下加可替换召回 Adapter，先与基线做逐条比较 | 权限先过滤、允许无命中、索引可重建、不必先部署大型 ES |
| 长期主题/洞察 | 多周记录存在有价值的重复弱点或思考主题，人工总结开始费力 | 定期提出带多条源引用的“候选洞察”，由用户确认/拒绝 | 不覆盖事实、不自动人格定性；源纠正/忘记后使依赖洞察失效；被反复召回不等于真 |
| 关联图或主题聚类 | 已有引用检索无法解释稳定的多跳关联，而且用户确实需要这些关联 | 先用稳定 ID 的轻量关系/主题视图验证，不以 Neo4j 为起点 | 图/聚类不授予权限、不自动合并记录、关系也要有出处 |
| 独立审稿与有界修复 | 博客出现可重复的引用/结构问题，手动审阅耗时明显 | 用户触发的任务专属 rubric，最多约定轮次的局部修复；必要时接独立模型 | judge 不是真相来源，不替用户批准立场或公开；失败/未评估不当通过，状态恢复须另行验收 |
| 有限主动回顾 | 用户实际愿意固定收到复习/读书汇总 | 明确开启、可暂停、可改频率，复用统一 Scheduler 和通知状态 | 无新内容少打扰、无授权不跨空间、不中断用户求职主线 |
| 重复流程提炼 skill | 同一方法真实复用多次，用户明确要求固定下来 | 产出可编辑 skill 草案与实例，用户确认后启用 | 不从单次成功推出通用规则，不自行授权工具，不训练模型 |

这些方向不是第一版验收项，不影响 A–E 完成。引入新存储、索引或模型前要通过个人回放说明实际收益和维护代价。

### 来源与发布状态

- 本方案以用户对话和 Comet 源码核对为需求/设计参考；不依赖此前对 Dots/Muse/Cue/Hermes 的产品定位描述来证明技术可行性。
- 仓库未提供既有 CONTEXT 或 ADR。本次增加领域词汇表，以“记忆空间”表达用户讨论中的内容分区，不把它等同于独立运行 profile。
- 原系统架构见 [architecture.md](architecture.md)，Comet 机制、源码证据及不直接照搬的原因见 [comet-reference.md](comet-reference.md)；Implementation Decisions 不锁定具体文件路径或私有函数，避免实现路径变化导致规格过时。
- 实施状态以本地任务票及 Git 提交为准；未创建 GitHub issue 或 PR。
- 用户在 2026-10-07 明确授权开始实施，确认使用统一任务执行入口、替换式执行器/飞书 Adapter 和真实临时存储作为主测试接缝。
- 优先保护近期求职体验：第一版以事实可靠、复习闭环和少量日常输入为成功标准，不以新增领域数量、记忆数量或完全自主程度为指标。
