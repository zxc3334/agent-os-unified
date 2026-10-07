# Agent OS Unified — 面试/教学 + 博客流水线

把「面试拷打」的学习闭环和「博客发布」的产出链路统一到一个实例里，共享记忆库与发布通道。

## 与其它实例的关系

| 实例 | 用途 | 端口 |
|---|---|---|
| `agent-os-unified`（本目录） | 面试/教学 + 博客 | 3103 |
| `ao-30-approval-gate` | 博客 demo | 3102 |
| `paper_exam/agent-os` | 科研 | 3101 |
| `agent-os-interview/agent-os` | 面试/教学（**已被本实例接管**） | — |

⚠️ 本实例复用了面试项目的 3 个飞书 app（interviewer / tutor / general-tutor），
**两个实例不能同时启动**，否则 WS 长连接冲突。

## 启动

```bash
cd <本仓库目录>
no_proxy="localhost,127.0.0.1,172.25.128.1,.feishu.cn,.larksuite.com,.github.com" \
NO_PROXY="$no_proxy" \
pnpm start
```

`no_proxy` 必须带：本机 shell 有 `http(s)_proxy`，不走白名单飞书 SDK 会报
`ERR_INVALID_PROTOCOL` 并在启动时崩溃。`.env` 里也写了一份，但显式带上更稳。

## 团队（6 个 bot）

| bot | 引擎 | project | 职责 |
|---|---|---|---|
| `entry` Jackson替身 | agy | personal-blog | **编排器**：只在需要多成员接力时串联 |
| `thinking-partner` | agy | personal-blog | 深聊逼你想透 + 初稿保真复核 |
| `blog-writer` | pi | personal-blog | 成稿 + 定时记忆提取 |
| `interviewer` | pi | anker | 项目深挖面试 |
| `tutor` | pi | anker | 源码教学与复习 |
| `general-tutor` | pi | general | 通用计算机/大模型教学 |

### 为什么入口是"编排器"而不是"统一入口"

会话按 `botId:chatId:threadId` 隔离。如果所有消息都经 entry 转发，
被转发者和用户之间的**追问链会断**（成员看不到 entry 与你的对话历史）。

所以：

```
零散问答 / 多轮深聊  →  直接 @ 对应成员（上下文连续）
跨成员接力 / 发布     →  @Jackson替身 编排
```

## 数据流

```
你在飞书提问
   ↓
Agent OS 建会话 → 注入该项目 MEMORY.md → agy/pi 执行 → 更新卡片
   ↓
对话落盘 data/dialogues/<project>.jsonl
   ↓ 定时任务（blog-writer）
读游标之后的新增对话 → 调 save_memory 工具 → 代码写盘（防幻觉）
   ↓
data/memories/<project>/entries/*.md + MEMORY.md
   ↓ 每晚 20:00
复习调度推卡片 → 你答题 → 推进艾宾浩斯
```

## 目录约定

**数据在博客仓库内，但全部 gitignored：**

```
<数据根目录>/
├── data/                       ← 私有，绝不公开
│   ├── dialogues/              对话落盘 + .cursor.json 游标
│   ├── memories/<project>/     记忆库（各带自己的 MEMORY.md）
│   └── notes/<project>/        深聊素材
├── content/                    已发布文章（进 git）
└── content/drafts/             草稿
```

`data/` 含个人学习弱点与前雇主技术细节，**已在 `.gitignore` 中排除**。

## 记忆库

```
data/memories/
├── anker/       Anker GCS 中台（Java/微服务）
├── agent-os/    Agent OS 自身机制
└── general/     通用计算机与大模型
```

每条记忆 = 一个可复习考点，含 `mastery`(1-5)、`weaknessAnalysis`、
`corePrinciples`、`reviewQuestion`，按艾宾浩斯 1/3/7/15 天排期。

`project` 字段由 `bots.json` 显式声明，未配置时回退为 workspace 目录名。

## 引擎适配

- `src/cli/agy-adapter.ts` / `pi-adapter.ts`
- `src/cli/app-tool-names.ts` — 归一化各引擎不同的 MCP 工具命名
- `scripts/agent-os-mcp-shim.mjs` — **agy 只读一个全局 MCP 配置**，
  多实例共用时靠垫片按 `AGENT_OS_HOME` 转发

### pi 的已知限制

`pi-adapter.ts` 里 `if (!text) return []`：pi 若某轮只产出 `thinking`
没有 `text`，该轮不产生 result。实测未触发（正常轮次两者都有），
若出现「无响应」可先查 pi 会话 jsonl 的最后一条 content 块。

## 待办

- [x] 对话落盘
- [x] 记忆注入 prompt
- [x] `save_memory` 工具 + 代码落盘
- [ ] 定时提取任务接线（`review-scheduler` 尚未接入 `index.ts`）
- [ ] 复习卡片推送
- [ ] 发布链路端到端验证（push main → Actions → Pages）
