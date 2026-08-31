# Saved View 查询 AST 规格 v1.0

> 日期：2026-07-11  
> 状态：设计已批准，P1 修复完成，待规格审查  
> 依赖：`SAVED_VIEW_V10.md`、`WORKITEM_SINGLE_USER_V11.md`（v1.2 含 §5.1 Priority 枚举和 §5.2 ScheduleFields）、`../../tiptip-next-cycle-review/CYCLE_CAPACITY_SINGLE_USER_V10.md`  
> 目标：让 Project/Space Saved View 在 Dexie、SQLite 和服务端获得一致、可解释、可迁移的动态查询语义

## 1. 定位

查询 AST 只表达 Saved View 的用户查询规则，不保存结果 WorkItem ID，不拥有 WorkItem 状态，也不包含不可编辑的 Project/Space 作用域。

执行查询由两部分组成：

```text
EffectiveQuery = SystemScopeConstraint AND UserQueryAst
```

同一输入事实、Space 时区、字段注册版本和执行器版本必须产生相同的规范化 AST、执行指纹、匹配结果和 UNKNOWN 诊断。

## 2. Non-goals

首版不做：

- 任意深度布尔表达式；
- 组级 NOT；
- SQL、正则表达式或用户脚本；
- 对未注册数据库字段的即席查询；
- 全文检索表达式；
- 查询结果快照；
- Saved View 自动通知或自动执行动作；
- 跨 Space 查询；
- 在不兼容版本上猜测降级执行。

## 3. AST 结构

### 3.1 QueryAst

```text
QueryAst
- astVersion: "1.0"
- root: GroupNode
- displayOrder: string[]
```

根节点必须是 `GroupNode`。

### 3.2 GroupNode

```text
GroupNode
- nodeId: string
- type: "group"
- operator: "AND" | "OR"
- children: QueryNode[]
```

约束：

- 根组深度为 0；只允许再包含一层子组，最大组深度为 1；
- 子组不能继续包含 GroupNode；
- 每组保存时至少包含一个子节点；
- 不支持组级 NOT；
- 单节点组在规范化阶段折叠，但根组始终保留。

### 3.3 ConditionNode

```text
ConditionNode
- nodeId: string
- type: "condition"
- field: FieldKey
- operator: OperatorKey
- value?: TypedValue
- negated: boolean
- referenceSnapshot?: {
    id: string
    name: string
    kind: ReferenceKind
  }
```

`negated` 只作用于叶子条件的最终三值结果。

## 4. 字段注册表

查询只允许使用当前 `fieldRegistryVersion` 注册的字段。数据库新增列不会自动开放。

```text
FieldDefinition
- fieldKey
- valueType
- allowedOperators[]
- allowedScopes: project[] | space[]
- allowedDepths: 1[] | 2[] | 3[]
- nullable: boolean
- referenceKind?
- relativeTimeSupported: boolean
- evaluatorVersion
```

### 4.1 首版字段

| 字段 | 类型 | Project View | Space View | 深度 |
|---|---|---:|---:|---|
| `depth` | enum | 是 | 是 | 1/2/3；枚举：1 / 2 / 3 |
| `projectId` | reference | 否：由 scope 注入 | 是 | 1/2/3 |
| `moduleId` | reference | 是 | 是，但值必须属于 scope 内 Project | 1/2/3 |
| `typeId` | reference | 是 | 是 | 1/2/3 |
| `status` | enum | 是 | 是 | 1/2/3；枚举：not_started / in_progress / paused / waiting / completed / cancelled |
| `labelIds` | multi_reference | 是 | 是 | 1/2/3 |
| `cycleId` | reference | 是 | 是 | 仅 2 |
| `cycleRole` | enum | 是 | 是 | 仅 2；枚举：committed / planned / stretch |
| `parentLevel1Id` | reference | 是 | 是 | 仅 2/3 |
| `completionWindowStart` | datetime | 是 | 是 | 仅 2 |
| `completionWindowEnd` | datetime | 是 | 是 | 仅 2 |
| `reviewPoint` | datetime | 是 | 是 | 仅 2 |
| `hardDeadline` | datetime | 是 | 是 | 1/2/3 |
| `isBlocked` | boolean | 是 | 是 | 仅 2 |
| `hasProgressAnomaly` | boolean | 是 | 是 | 仅 2 |
| `hasIncompleteLevel3` | boolean | 是 | 是 | 仅 2 |
| `isArchived` | boolean | 是 | 是 | 1/2/3 |
| `isCompleted` | boolean | 是 | 是 | 1/2/3 |
| `isCancelled` | boolean | 是 | 是 | 1/2/3 |
| `priority` | enum | 是 | 是 | 1/2/3；枚举：low / medium / high / urgent |
| `confidence` | enum | 是 | 是 | 仅 2；枚举：low / medium / high |
| `createdAt` | datetime | 是 | 是 | 1/2/3 |
| `updatedAt` | datetime | 是 | 是 | 1/2/3 |
| `effortActualSeconds` | number | 是 | 是 | 仅 2；不可空，默认 0 |
| `effortUpperBoundUsageRatio` | number | 是 | 是 | 仅 2；上限为空时值为 null；计算口径：`effortActualSeconds / effortEstimateUpperSeconds`，与 WorkItem v1.2 §5.2 一致 |

字段不适用于某个 WorkItem 深度时，叶子求值为 `FALSE`，不是 UNKNOWN。

## 5. 操作符矩阵

### 5.1 enum

```text
EQ / IN / NOT_IN
```

- `IN`：字段值属于给定非空集合；
- `NOT_IN`：字段非 null 且不属于集合；null 不自动满足 NOT_IN；空值必须显式使用空值操作符，但 enum 字段若声明不可空则不开放空值操作符。

### 5.2 reference

```text
EQ / IN / IS_NULL / IS_NOT_NULL
```

值使用稳定对象 ID；名称只用于快照解释。

### 5.3 multi_reference

```text
CONTAINS_ANY / CONTAINS_ALL / CONTAINS_NONE
IS_EMPTY / IS_NOT_EMPTY
```

- ANY：交集非空；
- ALL：查询集合是字段集合的子集；
- NONE：交集为空；
- 空查询集合不允许保存；
- WorkItem 无 Label 时字段集合为空，满足 NONE 与 IS_EMPTY，不满足 ANY/ALL（ALL 空集合因禁止保存不产生真空真）。

### 5.4 boolean

```text
IS_TRUE / IS_FALSE
```

不携带 value。

### 5.5 datetime

```text
BEFORE / ON_OR_BEFORE / AFTER / ON_OR_AFTER / BETWEEN
IS_NULL / IS_NOT_NULL
```

`BETWEEN` 为闭区间 `[start,end]`，要求 start <= end。

### 5.6 number

```text
LT / LTE / EQ / GTE / GT / BETWEEN
IS_NULL / IS_NOT_NULL
```

- 数值使用十进制规范字符串进入 AST，执行器解析为同一精度模型；
- `BETWEEN` 为闭区间；
- `effortUpperBoundUsageRatio = effortActualSeconds / effortEstimateUpperSeconds`；上限为空或小于等于 0 时字段为 null。

### 5.7 空值

空值只通过：

```text
IS_NULL / IS_NOT_NULL / IS_EMPTY / IS_NOT_EMPTY
```

禁止 `EQ null`、`NE null` 和字符串 `"none"`。

## 6. TypedValue

```text
TypedValue =
  EnumValue
  | ReferenceValue
  | ReferenceSetValue
  | AbsoluteDateTimeValue
  | RelativeDateValue
  | NumberValue
  | RangeValue
```

### 6.1 相对日期

```text
RelativeDateValue
- kind: "relative_date"
- anchor: "TODAY"
- offset: integer
- unit: "DAY" | "WEEK" | "MONTH"
- boundary: "START" | "END"
- timezoneSource: "SPACE"
```

- 使用 Saved View 固定绑定 Space 的 IANA 时区；
- AST 保存相对表达，不保存展开后的绝对日期；
- 每次打开、相关数据变化和 Space 跨自然日时重新求值；
- 月偏移采用目标月份最后有效日截断规则；
- DST 重叠/缺失时间按 IANA 时区库的该版本规则展开，并由 evaluatorVersion 锁定。

## 7. 系统作用域

### 7.1 Project View

执行器不可变注入：

```text
spaceId = savedView.spaceId
AND projectId = savedView.projectId
```

用户 AST 不开放 `projectId` 字段。

### 7.2 Space View

执行器不可变注入：

```text
spaceId = savedView.spaceId
```

用户可使用已注册的 `projectId` 条件，但值必须属于该 Space。

### 7.3 不变量

- scope 不写入用户 AST；
- scope 不可编辑、删除、取反或放入 OR；
- 引用值保存前校验归属 Space；
- Project/Space View 转换必须复制并创建新 ID；
- 执行端必须先应用 scope，再执行用户 AST；禁止先查全局再在客户端过滤。

## 8. 引用生命周期

| 状态 | 保存形式 | 求值 | 展示 |
|---|---|---|---|
| active | ID + snapshot | 按 ID | 正常 |
| archived | ID + snapshot | 按 ID | 标记已归档 |
| invalid_reference | 原 ID + snapshot | 恒 FALSE | 标记引用已失效 |

- 不按名称寻找替代对象；
- 不自动删除失效条件；
- 条件级 NOT 作用于失效引用时：先得到 FALSE，再取反为 TRUE。为避免失效引用经 NOT 扩大结果，保存或迁移时禁止 `negated=true` 的引用条件进入 invalid_reference；一旦活动引用在运行期失效，整个 View 标记 `needs_repair` 并停止执行，而不是将 FALSE 取反。未取反的失效引用仍按 FALSE 安全求值。

## 9. 三值求值

```text
EvaluationResult = TRUE | FALSE | UNKNOWN
```

### 9.1 UNKNOWN 来源

- 字段暂未加载；
- 派生信号计算失败；
- 本地数据版本不支持当前字段；
- evaluatorVersion 不支持该字段的当前算法。

不适用深度与未取反的永久失效引用是确定 FALSE，不是 UNKNOWN。

### 9.2 Kleene 强三值逻辑

AND：

| A | B | Result |
|---|---|---|
| FALSE | 任意 | FALSE |
| TRUE | TRUE | TRUE |
| TRUE | UNKNOWN | UNKNOWN |
| UNKNOWN | UNKNOWN | UNKNOWN |

OR：

| A | B | Result |
|---|---|---|
| TRUE | 任意 | TRUE |
| FALSE | FALSE | FALSE |
| FALSE | UNKNOWN | UNKNOWN |
| UNKNOWN | UNKNOWN | UNKNOWN |

NOT：

```text
NOT TRUE = FALSE
NOT FALSE = TRUE
NOT UNKNOWN = UNKNOWN
```

### 9.3 结果结构

```text
QueryResult
- matchedWorkItemIds[]
- unknownItems[] {
    workItemId
    reasonCode
    affectedConditionIds[]
  }
- evaluatedAt
- executionFingerprint
- sourceDataVersion
```

只有最终 TRUE 进入正式结果。UNKNOWN 不进入正式结果，也不使用旧结果补位。

## 10. 规范化与指纹

### 10.1 规范化流程

1. 校验 AST 版本和结构深度；
2. 校验字段、操作符、值类型和作用域；
3. 解析引用状态；
4. 递归规范化子节点；
5. 按稳定语义键排序 AND/OR 子节点；
6. 删除完全重复的子节点；
7. 折叠非根单节点组；
8. 拒绝空组；
9. 输出规范 JSON；
10. 生成指纹。

稳定语义键由节点类型、字段、操作符、规范值、negated 和子节点规范哈希组成，不使用 nodeId 或 displayOrder。

### 10.2 Canonical JSON

所有指纹基于同一 canonical JSON 序列化规则：

1. 对象键按 UTF-8 字典序排列；
2. 无多余空白；
3. 字符串值使用 UTF-8，禁止 Unicode 替代对；
4. 数值使用十进制规范字符串，禁止科学计数法、前导零和尾随零；整数无小数点，非整数保留最小有效小数位；
5. 数组保持规范化后的顺序，不使用原始输入顺序；
6. null 显式序列化为 `null`，不省略键；
7. 布尔值为 `true` 或 `false`；
8. 枚举按注册代码比较，不使用显示名称。

三端必须共享同一 canonical JSON 实现的测试向量。

### 10.3 结果排序

`matchedWorkItemIds` 不按数据库返回顺序排列，而按统一结果排序规则：

1. 用户 `sortRules` 中每个排序键；
2. 无显式排序时按 `(depth ASC, parentId ASC, manualOrder ASC, workItemId ASC)`；
3. 排序键值相同时按 `workItemId` 稳定兜底；
4. `unknownItems` 按 `(workItemId ASC, affectedConditionIds sorted)`。

排序规则不改变 `evaluationContextFingerprint`，但属于跨端一致性测试向量的一部分。

### 10.4 指纹

```text
queryFingerprint = hash(canonicalJson(normalizedUserAst))

executionFingerprint = hash(canonicalJson({
  scopeType,
  spaceId,
  projectId?,
  queryFingerprint,
  fieldRegistryVersion,
  evaluatorVersion,
  timezoneDatabaseVersion
}))

evaluationContextFingerprint = hash(canonicalJson({
  executionFingerprint,
  relativeTimeAnchorDate?,
  sourceDataVersion
}))
```

- `queryFingerprint` 用于用户规则语义等价判断；
- `executionFingerprint` 用于确认查询执行语义、作用域与引擎版本是否一致；当前时间和数据版本不参与；
- `evaluationContextFingerprint` 是结果缓存键。AST 含相对日期时，`relativeTimeAnchorDate` 使用 Space 时区的 `YYYY-MM-DD`；无相对日期时省略；
- `sourceDataVersion` 必须能代表当前 scope 内查询相关事实版本，事实变化后缓存键改变；
- hash 算法首版固定为 SHA-256，小写十六进制。

## 11. 人类可读解释

`displayOrder` 单独保存，不参与语义和指纹。

解释器必须：

- 按 UI 顺序展示；
- 显式显示括号、AND、OR 和条件级 NOT；
- 使用字段和引用快照名称；
- 归档引用标记“已归档”；
- 失效引用标记“引用已失效”；
- 不自动改写或弱化逻辑关系；
- 可提供规范化查询诊断视图，但不作为默认文案。

如果 displayOrder 缺少节点或含不存在节点，解释器先按有效节点恢复顺序，再将未列节点按规范语义键追加；同时记录 `display_order_repaired`，不改变 queryFingerprint。

## 12. AST 与执行版本迁移

Saved View 保存：

```text
- astVersion
- fieldRegistryVersion
- evaluatorVersion
- queryFingerprint
- version
- migrationHistory[]
- status: active | needs_repair
```

迁移分三类：

1. **无语义变化**：自动迁移，queryFingerprint 不变；
2. **可证明等价重写**：自动迁移，记录 migrationId 并重新计算指纹；
3. **无法证明等价**：原 AST、引用快照与旧解释只读保留，标记 `needs_repair`，停止执行。

修复完成后创建新的 Saved View version；旧版本进入配置版本历史。不得删除不支持条件、猜测字段替代或使用旧结果冒充当前事实。

## 13. 跨端一致性

Dexie、SQLite 和服务端共享：

- FieldDefinition 注册表；
- AST JSON Schema；
- canonical JSON 规则；
- 三值逻辑真值表；
- 相对时间展开向量；
- 字符串、枚举、引用、数值比较规则；
- 指纹测试向量；
- 固定验收数据集。

字符串只用于已注册的名称快照展示，不参与 ID 引用匹配。枚举按规范代码比较。数值禁止使用运行时二进制浮点直接参与指纹序列化。

执行端不支持当前 astVersion、fieldRegistryVersion 或 evaluatorVersion 时，必须返回 `unsupported_query_version`，不得降级猜测执行。

## 14. 安全与隐私

- Space scope 在数据访问层强制执行，不只依赖 UI；
- 查询错误不得返回其他 Space 的候选数量或字段；
- UNKNOWN 诊断只返回当前 scope 内 WorkItem；
- 日志记录条件 ID 和错误码，不记录 Note 正文等非查询字段；
- Saved View 删除只删除查询配置，不影响 WorkItem。

## 15. 验收门禁

1. 条件顺序变化不改变 queryFingerprint。
2. 不同 Project 的同一用户 AST 可有相同 queryFingerprint，但 executionFingerprint 必须不同。
3. Project View 永远不能返回其他 Project WorkItem。
4. Space View 永远不能读取其他 Space 数据。
5. 永久删除的未取反引用不会扩大结果。
6. 被取反的引用失效后 View 必须 needs_repair，不能执行。
7. UNKNOWN 与 FALSE 在结果和诊断中可区分。
8. Dexie、SQLite、服务端对固定向量输出一致。
9. 相对时间跨日后动态重算，AST 本身不改变。
10. 旧 AST 无法无损迁移时不自动删条件。
11. 规范化、解释顺序和 UI 显示顺序互不污染。
12. 查询结果只包含当前事实，不保存 WorkItem ID 快照。
