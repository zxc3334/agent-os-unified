# 日常记录、阅读与提醒

- Status: blocked: 05-personal-entry-skills
- Blocked by: 05-personal-entry-skills
- Milestone: D
- Spec: [spec.md](../spec.md)

## What to build

支持阅读/探索/生活记录与按需日/周回顾。日期事实与提醒分开，按源接收时间解析相对日期；提醒具备幂等创建、取消/改期、送达未知/失败/错过恢复状态。

## Acceptance criteria

- 单次饮食/活动不自动变长期偏好；作者观点与本人意见区分；提醒重投不复活已取消任务；停机错过如实报告；回顾有时间范围和源记录且不写入永久画像。
- 为本票契约补单元/集成测试；通过公开行为验证，不以内部函数调用次数为验收。
- 完成后更新实现与验证说明；不触碰无关用户数据、生产配置或既有工作区。
