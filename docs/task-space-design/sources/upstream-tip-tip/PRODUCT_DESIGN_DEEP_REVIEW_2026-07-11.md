# TipTip 产品设计深度审查报告

> 日期：2026-07-11  
> 审查范围：Project 主工作台、Module、Saved View、Project Activity、Activity 规则表与验收数据集  
> 初次审查结论：有条件否决  
> 2026-07-11 修复复审：**8 项 P0 全部关闭；Activity 规则与验收基线通过 P0 门禁**

## 1. 总体结论

当前设计的**领域方向是合理的**：

- 二级 WorkItem 承接投入、Cycle 和 Session 归属；
- 三级 WorkItem 是成果，不承接分钟；
- Module 是轻量长期领域，不成为子项目；
- Saved View 只保存查询规则；
- Activity 是 Project 级自动、只读、可重建的叙事投影。

但当前仍有两类阻塞问题：

1. **Activity 投影规则尚未达到确定性规格要求**，相同输入可能产生不同 Story，验收数据与规则存在冲突；
2. **Project 主工作台的信息架构需要重新设计**，Module、Saved View、Activity 长期挤在同一首屏会相互争夺注意力，且部分 Plane 借鉴已经越过 Module 无进度边界。

因此建议：保留领域契约，撤回当前主工作台布局冻结，先关闭下列 P0，再重新设计导航与页面层级。

---

## 1.1 修复复审结论

本轮已完成 8 项 P0 的深度修复，并通过独立最终门禁复核：

| P0 | 修复结果 |
|---|---|
| Story 时间窗口不可确定 | 已定义 `(effectiveAt,eventId)` 稳定排序、gap-based 4 小时算法、等于 4 小时拆分、跨日及同 Session 例外 |
| Story 身份与 supersede 冲突 | 已采用内容寻址 Story ID，并支持一对一、一拆多、多合一及无替代终止血缘 |
| projectionVersion 误作数据修订号 | 已拆分 `projectionVersion`、`projectionRevision` 与 `rebuiltAt` |
| Session revision 事实链混用 | 已分离 FocusSession、Attribution、Outcome 和 WorkItem 正式状态四条事实链 |
| 投入上限验收算术错误 | 已修正为 `12780 + 5220 = 18000` 秒，并修复原型对预计区间上界的解析判断 |
| Attribution 更正生成纯投入 Story | 已明确普通无成果 Session 在新旧归属侧均不生成 Activity Story |
| 事件信封与幂等引用缺失 | 已统一 DomainEvent 信封，使用不可变 `eventId`/History ID 追溯和去重 |
| Module 完成计数违反无进度门禁 | 已移除已完成/总数及完成色，仅保留中性 WorkItem 总数 |

**当前批准范围：** Activity 规则表 v1.1、验收数据集 v1.1 和上述 P0 语义边界通过门禁。

**仍未冻结：** Project 主工作台永久三栏信息架构。`Work / Modules / Views / Activity` 独立目的地重设计仍是下一阶段 P1，不因本轮 P0 关闭而自动批准当前三栏方案。

## 2. P0：初次审查问题与修复依据

### P0-1：Story 时间窗口算法不可确定

当前只定义“4 小时窗口”和“连续相关事件”，但没有定义：

- 固定时间桶、首事件锚定窗口，还是相邻事件滑动窗口；
- 使用 `occurredAt`、Session `startedAt` 还是 `endedAt`；
- 恰好 4 小时是否合并；
- 事件同时间时如何排序；
- 0h、3h、6h 的链式事件是一个 Story 还是两个 Story；
- 迟到事件插入后如何重新分桶。

**风险：** 同一组事件因遍历顺序不同产生不同 Story。

**必须修复：**

```text
1. 所有事件按 (effectiveAt, eventId) 稳定排序
2. 采用明确的 gap-based sessionization 或固定时间桶
3. 定义 4h 边界：< 4h、= 4h、> 4h
4. 定义 Space 时区和跨日规则
5. 同一 Session 强制合并优先于跨日规则
```

### P0-2：Story 身份与 supersede 语义冲突

规则表规定 Session revision 后“旧 Story 被 supersede”，验收数据集 6 却要求“同 Story 原位更新，`supersededByStoryId = null`”。

同时尚未定义：

- `storyId` 的生成公式；
- 聚合成员变化后 Story ID 是否变化；
- 一个旧 Story 拆成两个新 Story 如何引用；
- 两个旧 Story 合成一个新 Story 如何引用。

**必须修复：** 推荐采用内容寻址模型：

```text
storyId = hash(
  projectionVersion,
  spaceId,
  projectId,
  aggregationScope,
  orderedSourceEventIds
)
```

任何成员事件、作用域或 projectionVersion 变化均生成新 Story；旧 Story 使用 `supersedesStoryIds[]` / `supersededByStoryIds[]` 记录拆分与合并。纯缓存刷新才允许原位覆盖。

### P0-3：projectionVersion 被错误用作数据修订号

契约中 `projectionVersion` 表示规则和模板版本，但迟到同步规则要求它递增，验收数据集又使用 `ProjectionVersionUpgraded` 伪领域事件触发升级。

**必须修复：**

- `projectionVersion`：只随代码中的规则/模板版本升级；
- `projectionRevision` 或 `buildSequence`：随迟到事件、revision、更正和重建增加；
- 版本升级由部署配置触发，不属于 WorkItem/Session/Cycle 领域事件。

### P0-4：Session revision 三条事实链被混用

当前规则用 `SessionAttributionRevision` 触发时长更正，但该对象只负责二级投入归属。需要严格区分：

| 修订链 | 负责内容 | Activity 行为 |
|---|---|---|
| FocusSession revision | 时长、有效性、暂停等 | 重算投入摘要 |
| SessionAttributionRevision | 二级/Project 时间归属 | 移动投入贡献 |
| SessionWorkItemOutcome revision | 三级当时结果 | 读取最新有效结果 |
| WorkItem 正式状态事件 | 成功完成/取消等 | 永久独立事实，不随 Session revision 回滚 |

**必须修复：** 规则表和验收输入使用真实对象和 revision 语义，不用混合的 `SessionRevisionCorrected` 代替。

### P0-5：验收数据集 5 无法触发投入上限

当前数据为：

```text
前置投入 2h50m + 本次 87m = 4h17m
```

不是文档中的 4h20m，也没有达到 5h 上限。同时 `newEstimateRange: 2–4h` 没有输入事件来源，属于投影创造事实。

**必须修复：**

- 将前置投入改为 3h33m，使累计恰好达到 5h；或调整上限；
- 如果期望显示新估算，必须追加正式 `EffortEstimateChanged` 事件；否则删除 `newEstimateRange`。

### P0-6：归属更正验收违反普通 Session 排除规则

X08 规定普通无成果 Session 不生成 Story，但数据集 14 却要求一个无成果 Session 在归属更正后生成纯投入 Story。

**必须修复：** 二选一：

1. 保持 X08：归属更正只移动 EffortProjection，两侧均不生成 Activity Story；
2. 若要验证 Story 迁移，输入必须包含 progressed/completed/stuck 等叙事事件。

推荐选择 1，避免 Activity 退化为计时流水。

### P0-7：事件信封与幂等键不完整

规则要求按 `eventId` 去重，但：

- `sourceRefs` 结构没有 `eventId`；
- 大部分验收输入没有 `eventId`；
- 部分输入缺少 `spaceId` 和 `projectId`；
- `workitem_history.refId` 使用 WorkItem ID，而非不可变 History/Event ID；
- 事件名与契约不一致，例如 `L3Created`、`ModuleChanged`。

**必须修复：** 所有输入采用统一事件信封：

```text
DomainEvent
- eventId
- eventType
- spaceId
- projectId
- occurredAt
- recordedAt
- aggregateType
- aggregateId
- aggregateRevision
- payload
```

`sourceRefs` 必须引用不可变 `eventId` 或 History ID，不得只引用 WorkItem ID。

### P0-8：Module 完成计数违反“无进度”门禁

主工作台原型新增了 `已完成/总数`（如 3/8）。即使没有百分比和进度条，这仍然向用户表达 Module 的完成进度，与以下冻结规则冲突：

- Module 不拥有进度；
- Module 不显示由 WorkItem 状态派生的完成百分比；
- 所有 WorkItem 完成不改变 Module 生命周期。

**必须修复：**

- Module 可以显示 `WorkItem 总数`、`当前 Cycle 二级数量`、`未归档数量`；
- 不显示“已完成/总数”、百分比、进度条或完成色；
- 如果保留完成计数，必须先修改 Module 产品契约，不能仅作为 UI 微调偷偷引入。

---

## 3. P1：应在工程规划前修复

### P1-1：命令失败状态被写入 Activity summaryFacts

数据集 11 将 failed/pending 写入 `pendingSync`，但 Activity 契约明确：待同步、失败、冲突属于待处理区，不是 Activity 故事事实。

**建议：** 从 Activity `summaryFacts` 删除 `pendingSync`。Activity 只显示 succeeded 的正式事实；failed/pending/conflict 单独验证 AttentionProjection。

### P1-2：规则判定仍存在自然语言条件

以下词语无法直接转为确定性代码：

- “重要 WorkItem 创建”；
- “因果关系明确”；
- “有解释价值”；
- “容量状态跨越阈值”；
- “角色重要变化”。

**建议：** 每条事件定义机器可判定 Predicate，禁止实现者自由解释。

### P1-3：分钟格式和排序规则未定义

需要明确：

- 先求和整数秒，再统一格式化；
- 30 秒是 0 分钟、1 分钟还是 `<1 分钟`；
- `summaryFacts` 中数组的稳定排序；
- `sourceRefs` 去重和排序；
- 多个 headline 候选时主标题选择规则。

### P1-4：验收数据不够严格

“投影引擎可以包含更多字段”会削弱 golden dataset。额外字段可能包含错误事实却仍被判定通过。

**建议：** 对规范化 Story 做严格深相等，仅排除明确列出的非确定性元数据（例如 `rebuiltAt`）。

### P1-5：Cycle 标题模板重复

`Cycle {cycleName} 关闭` 在 `cycleName = Cycle 24` 时生成“Cycle Cycle 24 关闭”。

**建议：** 改为 `{cycleName} 关闭`。

### P1-6：Module 与 Saved View 的交互混淆

当前选择 Module 后，Saved View 被标记“已修改”。这会把“导航上下文”误当成“修改查询配置”。

**建议：**

- 选择 Module 默认只是临时作用域，不让 Saved View 变脏；
- 只有用户点击“将当前 Module 条件保存到 View”时才标记 View 已修改；
- UI 分别显示 `当前 Module` 与 `View 条件`。

### P1-7：三栏永久并置的信息架构过重

Module、Saved View、Activity 同时常驻，右栏 Activity 又展示投入、成果、Cycle 和来源，与中栏任务详情有较高重复。

**建议：** 借鉴 Plane 的“独立目的地”，但不复制其领域语义：

```text
Project 主导航
├── Work（默认，当前工作）
├── Modules（长期领域浏览）
├── Views（保存的观察方案）
└── Activity（只读推进故事）
```

Work 页面可以保留：

- 左侧紧凑 Module / View 快捷切换；
- 中间当前工作；
- 右侧只显示 2–3 条近期故事摘要或按需抽屉。

完整 Module、Views、Activity 进入独立页面。这样既保留 Plane 的清晰层级，又不引入 Plane 的团队、子项目和审计语义。

### P1-8：Saved View 缺标准查询 AST

契约列出了过滤维度，但没有定义 AND/OR/NOT、嵌套、空值、失效引用的标准表达。

**建议：** 工程前补充标准 AST 和人类可读解释规则，否则 View 保存/复制/失效处理会产生多种实现。

---

## 4. 可保留的设计

以下设计合理，建议继续保留：

1. **单用户 Space 隔离**：不引入成员、负责人和权限；
2. **二级是执行和投入单位**：Session、估算、Cycle 均在二级收口；
3. **三级是成果**：不承接独立分钟和 Cycle Membership；
4. **Saved View 只保存规则**：不保存任务副本；
5. **Activity 只读、自动、Project 级**：不变成社交动态或处置工作台；
6. **Activity 使用快照并可追溯源事实**；
7. **普通无成果 Session 不进入 Activity**；
8. **失败/冲突不冒充正式完成**；
9. **局部异常降级**：某一区域失败不锁死整页；
10. **Plane 只作为交互和信息密度参考**，不直接复制团队协作模型。

---

## 5. Plane 借鉴结论

### 值得借鉴

- Modules / Views / Activity 作为独立清晰入口；
- 页面标题、状态摘要、列表密度和筛选工具的层级；
- Module 卡片比单纯左栏文字列表更容易建立领域全貌；
- View 卡片展示查询目的、条件摘要和结果数量；
- Activity 独立页面更适合完整回顾。

### 不应借鉴

- Module 进度百分比、燃尽图、日期范围、Lead/Members；
- WorkItem 同时属于多个 Module；
- View 承载看板/甘特/日历等首版多展示器；
- Activity 变成“谁改了什么”的多人操作审计流；
- Workspace 级跨项目 Activity；
- 负责人、成员、协作权限和团队 Cycle。

### 推荐中间方案

Module 卡片允许展示：

- 名称和颜色；
- 简短说明；
- WorkItem 总数；
- 二级 WorkItem 数；
- 当前 Cycle 中的二级数量；
- 最近有叙事价值的推进时间；
- 打开 Module 的入口。

禁止展示：完成比例、完成色、进度条、状态、日期范围、成员、燃尽图。

---

## 6. 修订顺序与批准门禁

```text
1. 定义统一 DomainEvent 信封
2. 冻结 storyWindow 的确定性算法
3. 定义 storyId / supersede / split / merge 规则
4. 拆分 projectionVersion 与 projectionRevision
5. 修正三条 Session revision 事实链
6. 修正验收数据集 5、6、11、14、16
7. 补充 4h 边界、跨日、链式窗口、同时间排序测试
8. 移除 Module 已完成/总数展示
9. 重构主工作台为 Work + Modules + Views + Activity 独立目的地
10. 补 Saved View 查询 AST
11. 再做一次 P0 审查
12. P0 关闭后进入工程实施计划
```

### 批准条件

只有同时满足以下条件，才能批准进入工程：

- 同一组事件无论输入顺序如何，规范化后 Story 输出一致；
- Story 身份和 supersede 关系唯一；
- revision、迟到同步和版本升级不会混用版本字段；
- 验收数据的输入能够真实触发期望输出；
- Activity 不承载待同步或冲突处置；
- Module 不出现任何完成进度表达；
- 主工作台重新验证导航层级和首屏注意力。

## 7. 最终判断

**产品领域模型：可保留。**  
**Activity 规则与验收数据：暂不可批准。**  
**Project 主工作台三栏布局：建议撤回冻结并重新设计。**  
**Plane 借鉴方向：应该吸收页面层级和信息密度，不应吸收团队子项目语义。**
