# 记忆审查反馈与清理语义

- Status: blocked: 01-memory-substrate
- Blocked by: 01-memory-substrate
- Milestone: A
- Spec: [spec.md](../spec.md)

## What to build

通过同一飞书/命令入口提供分页待确认/最近记忆，显示来源、空间、状态并支持确认、纠正、拒绝；落实忘记抑制和派生来源失效。操作身份取可信 actor。

## Acceptance criteria

- 默认最多 5 条，可继续分页；确认/纠正对新读取立即生效；拒绝候选不删来源；忘记后重提取旧输入不复活；持久化失败不返回成功。
- 为本票契约补单元/集成测试；通过公开行为验证，不以内部函数调用次数为验收。
- 完成后更新实现与验证说明；不触碰无关用户数据、生产配置或既有工作区。
