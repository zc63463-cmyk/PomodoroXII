# Saved View 查询 AST 验收矩阵 v1.0

> 日期：2026-07-11  
> 依赖：`SAVED_VIEW_QUERY_AST_V10.md`  
> 目标：固定规范化、作用域、三值逻辑、相对时间、引用生命周期与版本迁移的跨端验收向量

## 1. 固定上下文

```yaml
space:
  id: space-a
  timezone: Asia/Shanghai
projectA: proj-a
projectB: proj-b
otherSpaceProject: proj-x
now: 2026-07-11T11:00:00+08:00
fieldRegistryVersion: fields-1.0
evaluatorVersion: evaluator-1.0
timezoneDatabaseVersion: tzdb-2026a
```

固定 WorkItem：

| ID | Space | Project | Depth | Status | Module | Labels | Blocked | ReviewPoint | Archived | Effort ratio |
|---|---|---|---:|---|---|---|---:|---|---:|---:|
| w1 | space-a | proj-a | 2 | active | m-infra | [urgent, offline] | true | 2026-07-11 09:00 | false | 1.00 |
| w2 | space-a | proj-a | 2 | active | m-ux | [ux] | false | 2026-07-13 09:00 | false | 0.40 |
| w3 | space-a | proj-b | 2 | active | m-sync | [offline] | false | null | false | null |
| w4 | space-a | proj-a | 3 | completed | m-infra | [] | false | null | false | null |
| w5 | space-a | proj-a | 2 | active | null | [] | UNKNOWN | 2026-07-11 18:00 | false | 0.80 |
| wx | space-x | proj-x | 2 | active | m-x | [urgent] | true | 2026-07-10 09:00 | false | 1.20 |

## 2. 结构与规范化

| # | 场景 | 预期 |
|---|---|---|
| N01 | AND 条件 A/B 与 B/A | normalized AST 和 queryFingerprint 相同 |
| N02 | OR 条件包含两个完全相同叶子 | 去重为一个叶子；非根单节点组折叠 |
| N03 | 根组只有一个叶子 | 根组保留 |
| N04 | 子组继续包含 GroupNode | schema validation 失败：`max_group_depth_exceeded` |
| N05 | 空组 | 保存失败：`empty_group` |
| N06 | 组级 NOT | schema validation 失败：`group_not_unsupported` |
| N07 | displayOrder 改变 | queryFingerprint 不变；解释顺序改变 |
| N08 | displayOrder 缺节点 | 自动修复显示顺序并产生 `display_order_repaired`；语义不变 |

## 3. 操作符

| # | 条件 | 预期匹配 |
|---|---|---|
| O01 | labelIds CONTAINS_ANY [urgent, ux] | w1, w2 |
| O02 | labelIds CONTAINS_ALL [urgent, offline] | w1 |
| O03 | labelIds CONTAINS_NONE [urgent] | w2, w3, w4, w5（应用 scope 后再裁剪） |
| O04 | labelIds IS_EMPTY | w4, w5 |
| O05 | moduleId IS_NULL | w5 |
| O06 | reviewPoint IS_NULL | w3, w4 |
| O07 | effortUpperBoundUsageRatio GTE 1.0 | w1；wx 只能在其自身 Space scope 内出现 |
| O08 | BETWEEN start > end | 保存失败：`invalid_range` |
| O09 | IN [] 或 CONTAINS_ANY [] | 保存失败：`empty_operand_set` |
| O10 | boolean IS_TRUE 携带 value | 保存失败：`unexpected_value` |

## 4. 作用域

| # | View | 用户 AST | 预期 |
|---|---|---|---|
| S01 | Project View proj-a | isBlocked IS_TRUE | 只返回 w1，不返回 wx |
| S02 | Project View proj-a | OR(projectId=proj-b, isBlocked=true) | projectId 字段不允许，保存失败 |
| S03 | Space View space-a | projectId EQ proj-b | 只返回 w3 |
| S04 | Space View space-a | projectId EQ proj-x | 保存失败：`reference_outside_space` |
| S05 | Project View 复制为 Space View | 原地修改 scope | 禁止；必须创建新 savedViewId |
| S06 | 客户端先查全局再过滤 | 安全测试失败；scope 必须由数据访问层前置执行 |
| S07 | 相同 AST 分别用于 proj-a/proj-b | queryFingerprint 相同，executionFingerprint 不同 |

## 5. 三值逻辑

以 w5 的 `isBlocked=UNKNOWN` 为基础：

| # | 表达式 | w5 结果 |
|---|---|---|
| T01 | isBlocked IS_TRUE | UNKNOWN |
| T02 | isBlocked IS_TRUE AND moduleId IS_NULL | UNKNOWN |
| T03 | isBlocked IS_TRUE AND moduleId EQ m-infra | FALSE |
| T04 | isBlocked IS_TRUE OR moduleId IS_NULL | TRUE |
| T05 | isBlocked IS_TRUE OR moduleId EQ m-infra | UNKNOWN |
| T06 | NOT(isBlocked IS_TRUE) | UNKNOWN |
| T07 | 最终 UNKNOWN | 不进入 matched；进入 unknownItems 并含条件 ID |
| T08 | 使用旧缓存补入 UNKNOWN | 禁止 |

## 6. 引用生命周期

| # | 条件 | 引用状态 | 预期 |
|---|---|---|---|
| R01 | moduleId EQ m-infra | active | 正常按 ID 匹配 |
| R02 | moduleId EQ m-infra | archived | 继续匹配，解释标记已归档 |
| R03 | moduleId EQ m-deleted | invalid | 条件恒 FALSE，不扩大结果 |
| R04 | NOT(moduleId EQ m-deleted) | active 时保存、运行期失效 | View 变为 needs_repair，停止执行 |
| R05 | invalid 引用按名称匹配新对象 | 禁止 |
| R06 | 自动删除失效条件 | 禁止 |
| R07 | OR(isBlocked IS_TRUE, moduleId EQ m-deleted) | m-deleted 恒 FALSE，其他有效分支仍正常求值；不因失效引用阻塞整组 |
| R08 | AND(isBlocked IS_TRUE, moduleId EQ m-deleted) | m-deleted 恒 FALSE，整组恒 FALSE；不扩大结果 |

## 7. 相对时间

| # | 条件 | 预期 |
|---|---|---|
| D01 | reviewPoint ON_OR_BEFORE TODAY END | 在 Asia/Shanghai 下匹配 w1、w5 |
| D02 | 同一 AST 设备切到 UTC | 结果不变，仍使用 Space 时区 |
| D03 | Space 跨到 7月12日 | 动态重算；AST/queryFingerprint 不变，execution fingerprint 不因当前时间改变，但缓存键必须包含 evaluationDay |
| D04 | TODAY + 1 MONTH，锚点 1月31日 | 截断到 2月最后有效日 |
| D05 | BETWEEN 使用相对 start/end | 两端均展开后执行闭区间 |
| D06 | DST 缺失/重叠时间 | 按指定 tzdb 与 evaluatorVersion 固定测试向量 |

## 8. 解释

| # | 输入 | 预期解释 |
|---|---|---|
| E01 | active AND (blocked OR review<=today) | 显示括号和“并且/或者” |
| E02 | negated archived=true | 显示“不包含已归档工作” |
| E03 | archived reference | 显示对象名称和“已归档” |
| E04 | invalid reference | 显示原快照名称和“引用已失效” |
| E05 | 规范化排序不同于 displayOrder | 默认按 displayOrder；诊断视图展示规范顺序 |

## 9. 版本与迁移

| # | 迁移 | 预期 |
|---|---|---|
| M01 | 字段仅改展示名称 | 自动迁移；queryFingerprint 不变 |
| M02 | 操作符等价重命名 | 自动等价重写；记录 migrationId，重算指纹 |
| M03 | 字段被拆成两个且无法证明等价 | needs_repair，停止执行 |
| M04 | 不支持 evaluatorVersion | `unsupported_query_version` |
| M05 | needs_repair 时展示旧结果 | 禁止冒充当前事实 |
| M06 | 用户修复完成 | 新 View version；旧版本只读保留 |

## 10. 跨端一致性

对 N01–M06 的规范 JSON 向量：

1. Dexie、SQLite、服务端 normalized AST 严格深相等；
2. queryFingerprint 和 executionFingerprint 完全相同；
3. matchedWorkItemIds 顺序按统一结果排序规则，而非数据库返回顺序；
4. unknownItems 的 reasonCode 与 affectedConditionIds 稳定排序；
5. 相对时间展开值一致；
6. 任一端不支持版本时不执行。

### Canonical JSON 向量

| # | 输入 | 预期 |
|---|---|---|
| C01 | 数值 1.0 和 1 | canonical 字符串均为 `"1"` |
| C02 | 数值 0.10 | canonical 为 `"0.1"` |
| C03 | 字符串含 Unicode 替代对 | 序列化失败 |
| C04 | 对象键顺序不同 | canonical JSON 相同 |
| C05 | 枚举显示名称 vs 注册代码 | 按代码比较；显示名称不参与指纹 |

### 缓存键向量

| # | 场景 | 预期 |
|---|---|---|
| K01 | AST 含相对日期，同一天内多次打开 | executionFingerprint 不变；evaluationContextFingerprint 不变 |
| K02 | AST 含相对日期，跨自然日 | executionFingerprint 不变；evaluationContextFingerprint 改变 |
| K03 | AST 不含相对日期 | relativeTimeAnchorDate 省略 |
| K04 | sourceDataVersion 变化 | evaluationContextFingerprint 改变 |
| K05 | 用户编辑条件但语义不变 | queryFingerprint 不变；evaluationContextFingerprint 不变 |

## 11. 批准门禁

- N01–N08 全部通过；
- O01–O10 全部通过；
- S01–S07 全部通过；
- T01–T08 全部通过；
- R01–R08 全部通过；
- D01–D06 全部通过；
- E01–E05 全部通过；
- M01–M06 全部通过；
- C01–C05 全部通过；
- K01–K05 全部通过；
- 三端固定向量严格一致；
- 不出现跨 Space 泄漏、静默扩大结果或旧结果冒充当前事实。
