# Project Activity 验收数据集 v1.1

> 日期：2026-07-11  
> 状态：P0 修复完成，待最终 P0 复审  
> 依赖：`ACTIVITY_RULE_TABLE_V10.md` v1.1  
> 目标：以规范事件信封验证 Activity 的确定性、revision 边界、幂等、重建和排除规则

## 1. 固定配置

```yaml
projectionVersion: activity-v1.1
spaceTimezone: Asia/Shanghai
storyGapSeconds: 14400
spaceId: space-daily
projectId: proj-tiptip-next
l2:
  id: l2-session-reconcile
  title: 完善离线 Session 对账
  moduleId: mod-infra
  moduleName: Session 基础设施
  effortCapSeconds: 18000
l3:
  unknown: { id: l3-unknown-status, title: 补充 unknown 状态提示 }
  retry: { id: l3-retry-timeout, title: 验证命令超时后的安全重试 }
  conflict: { id: l3-conflict-test, title: 补充冲突对账测试 }
```

## 2. 事件简写约定

以下数据使用完整 `DomainEvent` 必填字段。`payload` 中的标题和关系均是事件发生时快照。

```json
{
  "eventId": "evt-example",
  "eventType": "RegisteredEventType",
  "spaceId": "space-daily",
  "projectId": "proj-tiptip-next",
  "occurredAt": "2026-07-11T07:00:00+08:00",
  "recordedAt": "2026-07-11T07:00:01+08:00",
  "aggregateType": "focus_session",
  "aggregateId": "s-example",
  "aggregateRevision": 1,
  "correlationId": "s-example",
  "payload": {}
}
```

所有未单列的事件都必须补齐同一组 `spaceId/projectId/recordedAt`，不得在实现中猜测。

## 3. 核心数据集

### D01 普通无成果 Session

**输入：**

```json
[
  {
    "eventId":"evt-d01-focus-r1","eventType":"FocusSessionRevisionAppended",
    "spaceId":"space-daily","projectId":"proj-tiptip-next",
    "occurredAt":"2026-07-11T07:25:00+08:00","recordedAt":"2026-07-11T07:25:01+08:00",
    "aggregateType":"focus_session","aggregateId":"s-d01","aggregateRevision":1,"correlationId":"s-d01",
    "payload":{"effective":true,"validity":"valid","sessionStartedAt":"2026-07-11T07:00:00+08:00","sessionEndedAt":"2026-07-11T07:25:00+08:00","focusedSeconds":1500}
  },
  {
    "eventId":"evt-d01-attr-r1","eventType":"SessionAttributionRevisionAppended",
    "spaceId":"space-daily","projectId":"proj-tiptip-next",
    "occurredAt":"2026-07-11T07:25:00+08:00","recordedAt":"2026-07-11T07:25:02+08:00",
    "aggregateType":"session_attribution","aggregateId":"s-d01","aggregateRevision":1,"correlationId":"s-d01",
    "payload":{"effective":true,"level2WorkItemId":"l2-session-reconcile","level2TitleSnapshot":"完善离线 Session 对账"}
  }
]
```

**预期：** `visibleStories=[]`；EffortProjection 增加 1500 秒。

**门禁：** X06；不得生成纯投入 Story。

### D02 完成一个三级成果

**输入事实：** D01 同结构，Session `s-d02` 为 5220 秒；另含：

```json
{
  "eventId":"evt-d02-complete","eventType":"WorkItemStateCommandSucceeded",
  "spaceId":"space-daily","projectId":"proj-tiptip-next",
  "occurredAt":"2026-07-11T08:27:00+08:00","recordedAt":"2026-07-11T08:27:02+08:00",
  "aggregateType":"work_item_command","aggregateId":"cmd-d02","aggregateRevision":1,
  "correlationId":"s-d02",
  "payload":{"depth":3,"workItemId":"l3-unknown-status","workItemTitleSnapshot":"补充 unknown 状态提示","level2WorkItemIdSnapshot":"l2-session-reconcile","level2TitleSnapshot":"完善离线 Session 对账","sessionStartedAt":"2026-07-11T07:00:00+08:00","toState":"completed"}
}
```

**预期规范化 Story：**

```yaml
storyType: progress
headlineTemplateKey: outcome_completed
aggregationScope: l2:l2-session-reconcile
startedAt: 2026-07-11T07:00:00+08:00
endedAt: 2026-07-11T08:27:00+08:00
summaryFacts:
  effortSeconds: 5220
  completed: [l3-unknown-status]
sourceEventIds: [evt-d02-focus-r1, evt-d02-complete]
```

Story ID 必须按 v1.1 内容寻址公式计算；History sourceRef 使用 `evt-d02-complete`，不是 `l3-unknown-status`。

### D03 同一 Session 发现并完成

**输入：** `WorkItemCreated(depth=3, originSessionId=s-d03)`、FocusSession revision、Attribution revision、另一个三级的 `WorkItemStateCommandSucceeded`，四个事件均使用 `correlationId=s-d03`。

**预期：** 只生成 1 个 Story；包含 `completed=[unknown]`、`discovered=[retry]`；标题优先选择 `outcome_completed`；sourceEventIds 稳定排序。

### D04 多 Session 同窗口聚合

**输入：**

- `s-d04a`：07:00 开始，30 分钟，完成 unknown；
- `s-d04b`：08:00 开始，45 分钟，progressed retry；
- 两组均有独立 eventId、FocusSession/Attribution/成果事件。

**预期：** 1 个 Story，`effortSeconds=4500`；completed 与 progressed 各一项。交换输入数组顺序后，Story ID、summaryFacts、sourceRefs 顺序完全相同。

### D05 投入恰好达到上限

**前置事实：** 该二级在本 Session 前已有 `12780` 秒（3h33m）有效投入。

**输入：** `s-d05` 增加 `5220` 秒（87m），累计从 `12780` 到 `18000` 秒；同 Session 完成 unknown；追加正式跨越事件：

```json
{
  "eventId":"evt-d05-cap","eventType":"EffortCapCrossed",
  "spaceId":"space-daily","projectId":"proj-tiptip-next",
  "occurredAt":"2026-07-11T08:27:00+08:00","recordedAt":"2026-07-11T08:27:03+08:00",
  "aggregateType":"effort_projection","aggregateId":"l2-session-reconcile","aggregateRevision":1,"correlationId":"s-d05",
  "payload":{"level2WorkItemIdSnapshot":"l2-session-reconcile","level2TitleSnapshot":"完善离线 Session 对账","sessionStartedAt":"2026-07-11T07:00:00+08:00","beforeSeconds":12780,"afterSeconds":18000,"capSeconds":18000}
}
```

**预期：** E13+E15 同一 Story；`effortCapReached=true`；不存在 `newEstimateRange`。只有另有 `EffortEstimateChanged` 时才显示新估算。

### D06 FocusSession 时长 revision

**输入：** 初始 FocusSession r1 `focusedSeconds=5220`，完成 unknown；随后追加：

```json
{
  "eventId":"evt-d06-focus-r2","eventType":"FocusSessionRevisionAppended",
  "spaceId":"space-daily","projectId":"proj-tiptip-next",
  "occurredAt":"2026-07-11T09:00:00+08:00","recordedAt":"2026-07-11T09:00:01+08:00",
  "aggregateType":"focus_session","aggregateId":"s-d06","aggregateRevision":2,"correlationId":"s-d06",
  "payload":{"effective":true,"supersedesRevision":1,"validity":"valid","sessionStartedAt":"2026-07-11T07:00:00+08:00","sessionEndedAt":"2026-07-11T08:00:00+08:00","focusedSeconds":3600}
}
```

**预期：** 新 Story `effortSeconds=3600`，completed 保留；新 Story ID 不同；新 Story `supersedesStoryIds=[oldStoryId]`，旧 Story `supersededByStoryIds=[newStoryId]`；不生成“更正”Story。

### D07 WorkItem 后续改名

**输入：** 先产生 D02 Story；后续 `WorkItemTitleChanged` 事件不在白名单。

**预期：** Story 标题快照仍为“完善离线 Session 对账”；当前跳转对象可显示新标题；改名不生成 Story，旧 Story ID 不变。

### D08 离线迟到同步

**输入：** Session 实际发生于 7月10日 22:00–22:45，`recordedAt=2026-07-11T08:00:00+08:00`。

**预期：** `startedAt=2026-07-10T22:00:00+08:00`；`projectionRevision` 增加；`projectionVersion=activity-v1.1` 不变。若迟到事件改变 cluster 成员，则按 Story 血缘产生新 ID。

### D09 Saved View 创建

**输入：** 完整信封的 `SavedViewCreated`。

**预期：** 无 Story；Saved View 正常创建；不继承待处理处置语义。

### D10 Module 归属变化

**输入：** `WorkItemModuleChanged`，二级从 `mod-infra` 变为 `mod-sync`。

**预期：** structure Story，模板 `module_changed`。ID 相同仅名称改动时不进入 Activity。

### D11 命令部分成功

**输入：** 同一 Session 三个 WorkItem 命令结果：unknown 成功，conflict failed，retry pending。只有成功命令写入 `WorkItemStateCommandSucceeded`；failed/pending 仅存在命令状态事实，不在 Activity 白名单。

**预期：** Activity 的 completed 只含 unknown；`summaryFacts` 不得出现 `pendingSync`、failed 或 conflict。待处理投影单独验证其余两项。

### D12 Cycle 关闭

**输入：** 完整信封 `CycleClosed`，`cycleNameSnapshot="Cycle 24"`。

**预期：** 模板渲染为 `Cycle 24 关闭`，不得出现 `Cycle Cycle 24 关闭`；不与同时间 l2 Story 合并。

### D13 Session 撤销

**输入：** Session 60 分钟并产生独立的三级完成命令成功；随后 FocusSession r2 变为 `validity=invalid, focusedSeconds=0`。

**预期：** 新 Story 不显示 effort 字段，completed 保留；新旧 Story 建立 supersede 血缘；不生成撤销 Story。

### D14 Attribution 更正的普通无成果 Session

**输入：** 普通无成果 Session `s-d14` 60 分钟；Attribution r1 指向 `l2-session-reconcile`，r2 指向 `l2-sync-refactor`。

**预期：** EffortProjection 从旧二级移动到新二级；新旧二级都没有 Activity Story；不生成“更正”Story。这是 X06 与 revision 边界的强制门禁。

### D15 重复投递

**输入：** 完整 D02 事件集合重复两遍，eventId 完全相同。

**预期：** 先去重再投影；Story 数量、投入、completed、sourceRefs 均不翻倍；不产生 supersede。

### D16 projectionVersion 升级

**输入：** 与 D02 相同的领域事件集合。分别用配置 `activity-v1.1` 与 `activity-v1.2` 重建；输入中不存在版本升级领域事件。

**预期：** 两版 Story summaryFacts 可相同但 storyId 必须不同；v1.2 Story supersedes v1.1 Story；领域事件数量不变；`projectionRevision` 分别从各版本构建状态维护。

## 4. 确定性边界数据集

### B01 小于 4 小时

同 scope 事件发生于 07:00 与 10:59:59，预期合并。

### B02 恰好 4 小时

同 scope 事件发生于 07:00 与 11:00，预期拆为 2 个 Story。

### B03 大于 4 小时

同 scope 事件发生于 07:00 与 11:00:01，预期拆为 2 个 Story。

### B04 链式窗口

同 scope 事件发生于 00:00、03:00、06:00，预期 1 个 Story；算法比较相邻事件，不比较首尾总跨度。

### B05 同时间稳定排序

三个事件 effectiveAt 相同，eventId 分别为 `evt-c`、`evt-a`、`evt-b`，预期 sourceEventIds 顺序为 a、b、c；输入排列不影响结果。

### B06 跨自然日

同 scope 事件 23:30 与次日 00:30，不同 Session，预期拆分。

### B07 同 Session 跨自然日

同一 correlationId 的 Session 从 23:30 到次日 00:30，E02/E13/E15 预期强制合并并归入开始日。

### B08 迟到事件导致多旧合一

初始构建有 07:00 与 13:00 两个 Story（间隔 6h）。迟到事件 effectiveAt=10:00，形成 07:00→10:00=3h、10:00→13:00=3h，完整重算后合并为一个 Story。新 Story 的 `supersedesStoryIds` 必须同时包含两个旧 Story ID；两个旧 Story 的 `supersededByStoryIds` 都只包含该新 Story ID。对照组：迟到事件为 11:30 时，07:00→11:30=4.5h，不得把两个旧 Story 合一。

### B09 一旧拆多

FocusSession revision 或归属修订移除 cluster 中的桥接事实，导致原一个 Story 拆成两个；旧 Story 的 `supersededByStoryIds` 必须含两个新 ID。

## 5. 验收执行规则

1. 每组数据独立执行，明确列出的前置 EffortProjection 除外。
2. 先校验事件信封，再按 eventId 去重，再选择最新有效 revision，再投影。
3. 同一数据集至少执行三种输入排列：原顺序、逆序、固定随机顺序；结果必须相同。
4. 对规范化 Story 做严格深相等，只排除 `rebuiltAt` 和数据库物理 ID。
5. Story ID 使用实际 SHA-256 实现验证，不接受手填示例 ID。
6. `projectionVersion` 只由测试配置提供；迟到、更正、撤销只增加 `projectionRevision`。
7. D01–D16 与 B01–B09 全部通过，才允许关闭 Activity 投影 P0。
