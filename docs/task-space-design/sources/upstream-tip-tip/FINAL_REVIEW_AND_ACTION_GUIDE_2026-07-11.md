# TipTip 产品规格最终审查与后续行动指导

> 日期：2026-07-11  
> 审查范围：WorkItem v1.2、Cycle v1.0、Session v1.0、Saved View v1.0、Saved View AST v1.0、Project Activity v1.0、Activity 规则表 v1.1、Activity 验收数据集 v1.1、主工作台规格、四目的地原型  
> 结论：**产品领域基线可进入工程规划；以下 P1 需在工程实施前补齐**

---

## 1. 当前产品基线总览

### 已冻结

| 模块 | 版本 | 状态 |
|---|---|---|
| WorkItem 单人领域 | v1.2 | 已批准 |
| Cycle 容量 | v1.0 | 已批准 |
| Session 集成 | v1.0 | 已批准 |
| Saved View 契约 | v1.0 | 已批准 |
| Saved View 查询 AST | v1.0 | 自审通过，待用户审查 |
| Project Activity 契约 | v1.0 | 已批准 |
| Activity 规则表 | v1.1 | P0 全部关闭 |
| Activity 验收数据集 | v1.1 | P0 全部关闭 |
| 主工作台四目的地架构 | 方向冻结 | UI/UX 细节延期 |

### 已解决的关键风险

- Activity 投影确定性：统一事件信封、稳定排序、gap-based 4h 聚合、内容寻址 Story ID
- Session revision 事实链：FocusSession / Attribution / Outcome / WorkItem 状态四链独立
- Module 无进度边界：原型已移除完成计数和完成色
- Saved View 查询安全：scope 不可变注入、三值逻辑、失效引用恒 FALSE

---

## 2. 跨文件一致性审查

### P0：无

所有已冻结模块之间未发现 P0 级冲突。

### P1：工程前应修复

#### P1-1：AST 字段与 WorkItem 契约存在 3 处对齐缺口

**AST 开放但 WorkItem 契约未明确定义的字段：**

| AST 字段 | WorkItem 契约状态 | 问题 |
|---|---|---|
| `effortUpperBoundUsageRatio` | 契约第 10.2 节提到"预计上限"但未给出字段名和计算公式 | AST 定义 `actualEffortSeconds / effortUpperBoundSeconds`，但契约未定义 `effortUpperBoundSeconds` |
| `completionWindowStart` / `completionWindowEnd` | 契约第 10.1 节提到"完成窗口"但未定义字段 | AST 直接使用，但契约缺正式字段定义 |
| `reviewPoint` | 契约第 10.1 节提到"复盘点"但未定义字段 | 同上 |

**修复建议：** 在 WorkItem v1.2 第 10 节补充二级排期字段正式定义：

```text
ScheduleFields (仅二级)
- completionWindowStart?: datetime
- completionWindowEnd?: datetime
- reviewPoint?: datetime
- hardDeadline?: datetime (1/2/3)
- effortEstimateLowerSeconds?: integer
- effortEstimateUpperSeconds?: integer
- effortActualSeconds: integer (派生，来自有效 Session)
- confidence?: enum
```

#### P1-2：AST 缺少 `priority` 字段

WorkItem 契约第 5 节定义了 `priority: enum?`，Saved View 契约第 6 节排序也列出了"优先级"，但 AST 字段注册表遗漏了 `priority`。

**修复建议：** 在 AST 字段注册表补充：

```text
| priority | enum | 是 | 是 | 1/2/3 |
```

#### P1-3：AST 缺少 `confidence` 字段

WorkItem 契约第 10.1 节提到"信心"，柔性排期中是重要判断维度，但 AST 未注册。

**修复建议：** 补充或明确声明首版不开放 confidence 筛选。

#### P1-4：Activity 事件名与 WorkItem 契约事件名存在差异

| Activity 规则表 | WorkItem 契约 | 差异 |
|---|---|---|
| `WorkItemStateCommandSucceeded` | `WorkItemCompleted` / `WorkItemCancelled` / `WorkItemReopened` / `WorkItemStatusChanged` | Activity 使用命令成功事件；WorkItem 契约使用状态变更事件 |
| `NoteItemPromoted` | `NoteItemPromotedToWorkItem` | 名称缩短 |
| `BlockerStarted` / `BlockerResolved` | 未在 WorkItem 事件列表中 | WorkItem 契约未定义阻塞事件 |
| `ScopeExpansionMarked` | 未在 WorkItem 事件列表中 | WorkItem 契约未定义范围扩大事件 |
| `EffortCapCrossed` | 未在 WorkItem 事件列表中 | WorkItem 契约未定义投入上限跨越事件 |
| `SessionNoteDistilled` | 未在 WorkItem 事件列表中 | 源自 Session 但 Session 契约未定义 |

**修复建议：** 不要求完全统一事件名，但需在 WorkItem v1.2 和 Session v1.0 中补充 `BlockerStarted`、`BlockerResolved`、`ScopeExpansionMarked` 和 `EffortCapCrossed` 的正式事件定义，或在 Activity 规则表中标注这些是投影层派生事件而非直接领域事件。

#### P1-5：AST `hasProgressAnomaly` 与 WorkItem 契约 `progressAnomaly` 信号口径未对齐

WorkItem 契约第 13 节定义 `progressAnomaly` 为复合派生信号（多轮未完成、过复盘点、反复卡住/哈吉米或主动关注），但没有给出机器可判定的精确条件。AST 使用 `hasProgressAnomaly` 作为 boolean 字段，但 evaluatorVersion 无法确定其计算规则。

**修复建议：** 在 WorkItem v1.2 或单独的派生信号规格中定义 `progressAnomaly` 的精确判定条件，或在 AST 中标注此字段为 `evaluatorVersion` 锁定的派生计算，首版条件固定。

#### P1-6：Saved View 契约排序维度含"优先级"，但未定义优先级枚举

WorkItem 契约定义 `priority: enum?` 但未给出枚举值。Saved View 契约第 6 节排序列出"优先级"，AST 排序规则也需要引用。

**修复建议：** 在 WorkItem v1.2 中定义优先级枚举（如 `low / medium / high / urgent`）或明确声明首版不使用优先级排序。

---

## 3. 建议修复顺序

```text
1. WorkItem v1.2 补充排期字段正式定义（P1-1）
2. WorkItem v1.2 补充 priority 枚举（P1-6）
3. WorkItem v1.2 补充阻塞、范围扩大和投入跨越事件（P1-4）
4. WorkItem v1.2 或派生信号规格定义 progressAnomaly 精确条件（P1-5）
5. AST 补充 priority 字段（P1-2）
6. AST 决定是否开放 confidence（P1-3）
7. 统一 Activity 规则表与 WorkItem 事件名引用（P1-4）
8. 再做一次跨契约 P1 审查
9. 全部 P1 关闭后进入工程实施计划
```

---

## 4. 工程实施前检查清单

进入工程前必须确认：

- [ ] WorkItem v1.2 排期字段有正式名称和类型
- [ ] priority 枚举已定义或已声明首版不使用
- [ ] Activity 规则表引用的事件在源契约中均可找到或标注为投影层派生
- [ ] progressAnomaly 有机器可判定条件或标注为首版固定算法
- [ ] AST 字段注册表与 WorkItem 契约字段完全对齐
- [ ] AST 验收矩阵无与契约冲突的场景
- [ ] 三端（Dexie/SQLite/服务端）共享的 canonical JSON 测试向量已准备
- [ ] Activity 验收数据集的三种输入排列测试向量已准备
- [ ] 主工作台四目的地架构方向冻结（已满足）

---

## 5. 后续行动路线

### Now：工程前补齐

1. 修订 WorkItem v1.2，补排期字段、priority、阻塞事件和 progressAnomaly 精确条件
2. 同步修订 AST 字段注册表
3. 统一 Activity 规则表事件引用
4. 跨契约 P1 审查

### Next：工程规划

1. 编写 WorkItem + Session + Cycle 工程实施计划
2. 编写 Activity 投影引擎工程实施计划
3. 编写 Saved View 查询引擎工程实施计划
4. 编写主工作台前端工程实施计划（含四目的地导航）
5. 准备三端共享测试向量

### Later：验证后再决定

1. 主工作台 UI/UX 深度设计
2. Module 展示微调（借鉴 Plane 卡片风格但不越界）
3. Saved View 查询编辑器 UI
4. Activity 页面完整筛选与展开
5. Orbit L1/L2/L3 与主工作台联动
6. 看板/日历/时间线等展示器
7. Space 级 Activity
8. AI 辅助叙事或周报

---

## 6. 批准结论

**产品领域基线：可进入工程规划。**

当前不存在 P0 阻塞。6 项 P1 均属于"契约字段定义补齐"而非"产品方向错误"，修复路径明确且工作量可控。建议按第 3 节顺序逐项关闭后，再做一次跨契约 P1 审查，然后正式进入工程实施计划。
