# WorkItem 父子与依赖关系规格

> 状态：已批准，作为工程实施计划的产品基线  
> 版本：v1.0  
> 依赖：[共享领域契约](./WORKITEM_SHARED_CONTRACT.md)

## 1. 问题与目标

父子关系表达整体与组成，依赖表达执行约束，相关关系表达信息联系。混用会造成错误进度、错误阻塞和双重风险。本规格建立稳定任务树和可解释有向依赖。

## 2. 非目标

- 不做任意深度知识图谱。
- 不自动从文本写入依赖。
- 不允许跨 Workspace 依赖或跨 Project 父子关系。
- 不做 lag、资源约束和正式 CPM。
- 不强制父项与子项状态同步。

## 3. 用户故事

- 作为用户，我希望将大任务拆成最多三层，以便在不迷失的情况下管理范围。
- 作为计划者，我希望依赖环被阻止并解释路径，以便避免执行死锁。
- 作为跨项目用户，我希望表达同 Workspace 的阻塞，但不让全局关系图爆炸。
- 作为 Orbit 用户，我希望只让真实依赖传播风险，以便理解风险来源。

## 4. 字段模型

### 4.1 父子关系

父子使用 `WorkItem.parentId`：

| 字段 | 类型 | 可空 | 规则 |
|---|---|---:|---|
| `parentId` | workItemId | 是 | 同 Project；非自身/后代；最大三层 |
| `childRank` | number | 否 | 同父项下稳定排序 |

每个 WorkItem 最多一个父项，可有多个子项。

### 4.2 Relation

| 字段 | 类型 | 可空 | 规则 |
|---|---|---:|---|
| `relationId` | ID | 否 | 全局唯一 |
| `workspaceId` | ID | 否 | 两端必须同 Workspace |
| `sourceWorkItemId` | ID | 否 | 稳定端点 |
| `targetWorkItemId` | ID | 否 | 稳定端点 |
| `kind` | enum | 否 | depends_on/relates_to/duplicates/evidence_for |
| `resolution` | enum | 是 | 仅依赖异常使用：confirmed_not_required；为空表示关系仍有效 |
| `resolvedAt` | datetime | 是 | 解决时间 |
| `createdAt` | datetime | 否 | 审计 |
| `createdBy` | ID | 否 | 审计 |

`blocks` 是 `depends_on` 的反向界面表达，不单独存为另一条边。若 A depends_on B，则 B blocks A。

## 5. 父子树不变量

1. 只允许同 Project。
2. 最多三层：父、子、孙。
3. 禁止自身为父和祖先环。
4. 移动 WorkItem 时验证整棵子树的最终深度。
5. 跨 Project 移动必须整体移动子树，或先解除/重组。
6. 多上下文归属使用 Module、Label、View 或 relates_to。

## 6. 父项完成

父项有活动子项时，完成前展示互斥状态明细和活动未完成合计。选项：

- 仅完成父项；
- 选择并完成具体直接子项；
- 返回处理。

等待和暂停项默认不勾选。不递归静默完成孙项；选择一个含活动孙项的子项时，再对该子项执行同样确认。取消父项或归档父项时也展示活动子项影响，但不自动改子项。

归档父项后，子项保持父子关系；默认列表在“显示归档父项的子项”设置关闭时，将子项以“父项已归档”上下文显示为可访问根项。恢复父项后恢复原树展示。

## 7. 递归进度

### 7.1 公式

```text
leafProgress = completed ? 1 : 0
branchProgress = average(valid direct child progress)
valid child = not cancelled
```

- 没有有效子项时为 N/A；若一个非叶子分支因全部直接子项 cancelled 而为 N/A，则该分支在其父项聚合中也从分母排除，并单独计为“范围已取消”。
- archived 不改变原状态的计算。
- 重开 completed 子项会立即降低进度。
- 取消子项从分母排除；重开后重新进入。
- 父项同时展示直接状态计数与递归百分比。
- 100% 只提示“子项工作已全部完成”，不自动完成父项。
- 首版只实现等权；投入加权属于 P1，不在 P0 保留可编辑权重字段。

## 8. 依赖写入与环检测

- 禁止自依赖、重复边和正反重复表达。
- 新增/修改依赖前，在 Workspace 有向图执行环检测。
- 若形成环，阻止保存并展示可理解路径。
- 提供改方向、删除冲突边、改 relates_to 建议，不自动改写。
- 检测失败/超时不得放行写入。

### 已有异常环

- 导入旧环标记 `dependencyAnomaly`。
- 异常 SCC 内仅允许删除边；任何维持、扩大、合并异常 SCC 的新增边都禁止。
- 删除后立即重算 SCC；脱离环即移除标记。
- Orbit 可有限展示，但必须标“依赖异常”，不视为正常关键链。

## 9. 跨 Project 依赖

- 允许同 Workspace 跨 Project depends_on。
- 创建时明确目标 Project 并二次确认。
- 列表显示摘要；详情可跳转。
- L3 使用边界端口；L2 压缩为弱应力，不展开全局边网。
- 跨 Project 边参与 Workspace 环检测。
- 目标 Project 归档/不可访问时关系保留并进入 resolution。

## 10. 依赖结果真值表

| 前置 WorkItem | 结果 | 下游信号 |
|---|---|---|
| not_started/in_progress/paused/waiting | blocking | `blockedByDependency=true` |
| completed | satisfied | 不阻塞 |
| cancelled | broken_requires_resolution | 需移除、替换或确认不再需要；确认后保留审计边但 `resolution=confirmed_not_required`，计算视为 satisfied |
| archived | 按原状态 + archived 提示 | 可能阻塞/满足 |
| Project archived / 不可访问 / 缺失 | unknown_requires_resolution | 必须修复，不静默解除 |

系统建议 blocked 的活动项切换 Waiting，但不自动修改；所有阻塞解除后建议恢复进入 Waiting 前的状态。

## 11. Orbit 边界

- depends_on 进入 blocked risk、关键链、异常检测和跨 Project 弱应力。
- 父子只用于 L3 骨架、进度和一次父级聚合，不作为第二依赖路径。
- relates_to、duplicates、evidence_for 只展示。
- Type、Label、Module、Cycle 不推断依赖。
- 同一对 WorkItem 同时父子+依赖时，风险适配器必须避免双重放大；公式进入独立风险规格。

## 12. 事件

| 事件 | 关键载荷 |
|---|---|
| `WorkItemParentChanged` | fromParentId, toParentId, subtreeDepth |
| `WorkItemChildRankChanged` | parentId, oldRank, newRank |
| `RelationCreated` | relationId, source, target, kind |
| `RelationRemoved` | relationId, reason? |
| `DependencyRejected` | attemptedEdge, cyclePath/errorCode |
| `DependencyAnomalyDetected` | sccWorkItemIds, edgeIds |
| `DependencyResolutionConfirmed` | relationId, resolution |
| `ParentCompletionDecisionRecorded` | parentId, choice, selectedChildIds |

## 13. P0 / P1 / P2

### P0

- 三层单父树、移动验证和祖先环检测。
- 父项完成确认。
- 等权递归进度。
- Project 内/跨 Project 依赖。
- Workspace 环检测和异常修复。
- Waiting 建议和依赖真值表。
- 关系详情与 L3 入口。

### P1

- 按预计投入加权进度。
- 批量关系编辑。
- 更丰富异常修复向导。

### P2

- 跨 Workspace 关系。
- lag、资源约束和自动依赖推断。

## 14. 验收标准

1. **三层限制**  
   Given目标父项会让子树出现第 4 层，When移动，Then阻止并解释最大层级。
2. **祖先环**  
   Given A 是 B 的祖先，When将 A 移到 B 下，Then阻止且树不变化。
3. **跨 Project 父子**  
   When尝试把另一 Project WorkItem 设为父项，Then阻止并建议 relates_to/依赖。
4. **父项完成**  
   Given父项有活动子项，When完成父项，Then显示互斥明细和三个选择，不自动改子项。
5. **递归进度**  
   Given一个直接子项进度 100%、另一个叶子未完成，When计算父项，Then综合进度 50%，直接完成计数按直接状态单独显示。
6. **全取消分母**  
   Given所有直接子项 cancelled，Then进度为 N/A，不显示 100%。
7. **依赖环**  
   Given A→B→C，When创建 C→A，Then拒绝并显示路径。
8. **取消前置项**  
   Given A depends_on B 且 B cancelled，Then结果为 broken_requires_resolution，不视为满足。
9. **依赖解除建议**  
   Given用户因依赖进入 Waiting，When所有依赖 satisfied，Then提示恢复但不自动切状态。
10. **跨项目摘要**  
    Given同 Workspace 跨 Project 依赖，Then列表显示外部依赖摘要，L3 显示边界端口，不展开目标全图。
11. **异常 SCC 修复**  
    Given导入环，When删除足以破环的边，Then重算并清除脱离节点异常标记。
12. **风险边界**  
    Given relates_to 关系，Then不产生 blocked risk 或关键链边。

## 15. 指标与验证假设

- 无意依赖环写入成功率必须为 0。
- 关系创建失败均提供可行动原因。
- 用户研究验证父子与依赖是否能被正确区分。
- 监测 Waiting 建议接受率，仅评估可理解性，不作为用户绩效。

## 16. 开放问题

无阻塞产品问题。风险权重、跨项目衰减和去重公式进入 Orbit 风险适配规格。
