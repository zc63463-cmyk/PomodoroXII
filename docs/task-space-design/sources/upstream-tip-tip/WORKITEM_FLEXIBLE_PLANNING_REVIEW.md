# WorkItem 类型与柔性排期规格

> 状态：已批准，作为工程实施计划的产品基线  
> 版本：v1.0  
> 依赖：[共享领域契约](./WORKITEM_SHARED_CONTRACT.md)

## 1. 问题与目标

传统任务工具常把“计划意向、有效投入、真实截止”压成一个精确日期，使用户在不确定环境中被迫伪精确，并在偏差后积累挫败与乱序。TipTip 要允许开发、学习、研究和个人场景用自己的类型语言，并用可校准的柔性承诺表达计划。

### 成功结果

1. 用户只填写标题即可创建有效 WorkItem。
2. 用户可表达“近一周、约 5h、低信心、周三复盘”，而不设置硬截止。
3. 柔性窗口结束后进入可行动的重排流程，不被标为失败。
4. Type、Label、计划和 Orbit 共享同一 WorkItem 事实。

## 2. 非目标

- 不做 Type 专属状态机或字段布局。
- 不做 AI 自动承诺时间。
- 不做公式数据库和跨 Workspace 类型继承。
- 不把重排次数直接当作失败或优先级。
- 不在本规格定义 Orbit 风险公式和权重。

## 3. 用户故事

- 作为学生，我希望使用“作业、复习、考试”等自建类型，以便产品语言符合学习场景。
- 作为开发者，我希望模板预设“功能、任务、缺陷、研究”，但可以修改，以便快速开始且不被锁死。
- 作为不擅长排期的用户，我希望选择“近一周”和“约 5h”，以便表达真实计划而非假装精确。
- 作为计划发生偏差的用户，我希望获得重排、拆分和补依赖建议，以便校准计划而非面对失败标签。

## 4. Type 与 Label

### 4.1 Type

- Workspace 维护稳定 ID 的 Type 库。
- 每个 WorkItem 必须且只能选择一个 Type。
- Project 选择包含哪些 Type，并设置默认 Type。
- Workspace 保留不可归档的通用兜底 Type；名称、图标、颜色可改。
- 名称不驱动业务逻辑；首版不支持 Project 级别名。
- 已被引用的 Type 只能归档，不能物理删除。
- 归档 Project 默认 Type 前必须选择替代；配置异常时回退兜底 Type。

### 4.2 Label

- Workspace 级自由创建。
- WorkItem 可多选。
- 只描述横向特征，不决定主语义、状态流和风险传播。

## 5. 计划字段

| 字段 | 类型 | 可空 | 默认 | 规则 |
|---|---|---:|---|---|
| `windowPreset` | enum | 是 | 空 | today/next3days/thisWeek/rolling7days/nextWeek/rolling14days/thisMonth/custom |
| `windowStart` | date | 是 | 空 | 选择预设时冻结 |
| `windowEnd` | date | 是 | 空 | 包含结束当天 |
| `windowTimezone` | IANA timezone | 是 | Workspace 时区 | 创建后不因跨时区改写 |
| `effortMinMinutes` | integer | 是 | 空 | >= 0 |
| `effortMaxMinutes` | integer | 是 | 空 | >= min |
| `effortInputMode` | enum | 是 | 空 | preset/approx_point/range/unknown/needs_split；`approx_point` 保留“约”语义 |
| `scheduleConfidence` | enum | 是 | 空 | high/medium/low；仅有窗口时可设置 |
| `reviewAt` | datetime | 是 | 自动生成 | 可手动修改或关闭 |
| `reviewMode` | enum | 否 | auto | auto/manual/disabled |
| `hardDeadlineAt` | datetime | 是 | 空 | 真实外部约束 |
| `planningRevisionCount` | integer | 否 | 0 | 由事件历史派生或投影 |
| `replanReviewAt` | datetime | 是 | 空 | 用户确认“保持当前计划”后的下次复查时间 |

## 6. 完成窗口规则

| 预设 | 日期范围 |
|---|---|
| 今天 | 选择当天 |
| 未来三天 | 当天起连续 3 个自然日 |
| 本周 | 当天至 Workspace 本周结束日 |
| 近一周 | 当天起连续 7 个自然日 |
| 下周 | 下一个完整日历周 |
| 未来两周 | 当天起连续 14 个自然日 |
| 本月 | 当天至当月最后一日 |
| 自定义 | 用户选择开始、结束日 |
| 暂不安排 | 不生成窗口 |

窗口首尾均包含。Workspace 时区进入 `windowEnd` 次日 00:00 后，活动且未完成/未取消的 WorkItem 才满足窗口结束。离线跨界后，下次启动或同步补算。

## 7. 预计投入

- 快捷档位：15–30m、30–60m、1–2h、2–4h、4–8h、1–2 工作日。
- 自由输入支持“约 5h”“3–6h”。
- 内部统一为最小/最大分钟数；工作日分钟数读取 Workspace 设置。
- 无法解析的文本不得进入容量计算。
- 投入是有效工作量，不是自然历时。

## 8. 信心与复盘

### 8.1 信心

正式值由用户选择，可为空。只有窗口存在时可设置。修改窗口后提示重新确认，不静默清空。系统可给带理由建议，不自动覆盖。

### 8.2 自动复盘

窗口首尾计入天数：

```text
reviewDate = start + floor((days - 1) × ratio)
low = 0.3
medium/empty = 0.5
high = 0.7
```

- 今天：使用 Workspace 每日收尾时间做当日检查。
- 其他窗口：首版只生成一个复盘点。
- 默认时间使用 Workspace 每日复盘时间。
- 手动复盘点不被静默覆盖；修改窗口/信心时询问是否重算。
- 硬截止提醒独立，不复用柔性复盘。

## 9. 重排与 planning uncertainty

`needsReplan` 的真值见共享契约。处理动作包括：

- 保持当前计划；
- 移动窗口；
- 缩小范围；
- 拆分 WorkItem；
- 补充依赖；
- 转为暂停或暂不安排。

选择“保持当前计划”时，用户必须设置一个新的 `replanReviewAt`；在该时点前抑制 `needsReplan`，到时若窗口和状态仍未变化则重新派生。该确认记录为 `PlanningKept` 事件，不修改原始窗口，避免信号永久存在或被无期限忽略。

重排本身不增加失败风险。只有 30 天内重复移动窗口且范围、投入、依赖和执行进展均无实质变化时，后续 Orbit 可温和提高有上限、可衰减的 planning uncertainty。具体阈值不属于首版实现。

## 10. 事件

| 事件 | 关键载荷 |
|---|---|
| `WorkItemCreated` | title, typeId, statusId |
| `WorkItemTypeChanged` | fromTypeId, toTypeId |
| `WorkItemLabelsChanged` | addedIds, removedIds |
| `PlanningWindowSet` | preset, start, end, timezone |
| `PlanningWindowCleared` | reason |
| `EffortEstimateChanged` | min, max, mode |
| `ScheduleConfidenceChanged` | from, to |
| `ReviewScheduled` | reviewAt, mode |
| `ReviewDisabled` | reason? |
| `HardDeadlineChanged` | from, to |
| `PlanningRevised` | oldPlan, newPlan, reason, substantiveChanges |
| `PlanningKept` | originalWindow, replanReviewAt, note? |

派生标记变化不作为用户维护事件；可产生只读投影更新或遥测。

## 11. P0 / P1 / P2

### P0

- Type 库、Project 包含范围、默认与兜底。
- Label 创建与多选。
- 完成窗口及冻结日期。
- 档位和自由区间投入。
- 用户信心与一个复盘点。
- 独立硬截止。
- `needsReplan` 和重排历史。

### P1

- 模板预设类型库。
- 批量修改计划字段。
- planning uncertainty 洞察。
- 个人估算校准报告。

### P2

- Type 自定义字段和专属状态流。
- AI 排期建议。
- 跨项目容量自动优化。

## 12. 验收标准

1. **快速创建**  
   Given Project 有有效默认 Type/状态，When 用户输入非空标题并回车，Then WorkItem 创建成功，Type/状态自动填充，计划字段为空。
2. **Type 兜底**  
   Given Project 默认 Type 因异常不可用，When 创建 WorkItem，Then 使用 Workspace 通用 Type，且不产生空 `typeId`。
3. **本周与近一周**  
   Given 周五创建计划，When 选择“本周”，Then结束日为 Workspace 周结束日；When 选择“近一周”，Then范围为连续 7 个自然日。
4. **约 5h**  
   Given 输入“约 5h”，When 用户确认解析，Then保存 min=max=300 且界面保留“约”语义。
5. **复盘回退**  
   Given 有 7 天窗口且信心为空，When 自动生成复盘，Then按 ratio=0.5 计算。
6. **手动复盘保护**  
   Given reviewMode=manual，When用户修改窗口，Then系统询问是否重算且不静默覆盖。
7. **窗口结束**  
   Given活动 WorkItem 的窗口结束，When进入次日 00:00 并重新计算，Then `needsReplan=true`，状态不改变。
8. **取消/完成**  
   Given `needsReplan=true`，When WorkItem 完成或取消，Then标记消失、未来未完成任务提醒停止、历史计划保留。
9. **归档恢复**  
   Given过期活动项被归档，Then默认视图不展示信号；When恢复，Then按当前事实重新计算并可再次显示重排。
10. **解析失败**  
    Given自由投入文本无法解析，When保存，Then阻止该字段保存并保留原输入，不把其加入容量计算。

## 13. 指标与验证假设

当前没有真实用户基线，目标值是待验证假设，不作为“已证明”结果：

- 快速创建成功率 ≥ 98%。
- 创建时中位交互步骤 ≤ 2。
- 使用柔性窗口的计划中，硬截止占比不应被产品默认推高。
- 重排流程完成率、重排后 7 天再次调整率用于评估是否真正帮助校准。
- 用户研究重点：是否理解“窗口不是截止日”、是否降低延期挫败感。

## 14. 开放问题

无阻塞产品问题。硬截止“临近”提醒阈值、planning uncertainty 数学公式、跨项目容量属于后续独立规格。
