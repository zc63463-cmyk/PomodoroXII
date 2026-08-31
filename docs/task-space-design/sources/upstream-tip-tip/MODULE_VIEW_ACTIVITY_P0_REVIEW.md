# Module / Saved View / Project Activity 跨契约 P0 审查

> 日期：2026-07-11  
> 结论：**批准**  
> 审查范围：WorkItem v1.2、Saved View v1.0、Project Activity v1.0、Cycle v1.0、Session 集成 v1.0

## 1. 审查目标

重点验证：

1. Activity 不成为第二事实源；
2. Saved View 不复制 WorkItem；
3. Module 不进入容量、进度、Cycle 或 Session；
4. Space / Project 作用域一致；
5. Session revision、归属更正和跨域命令部分成功能被 Activity 正确投影。

## 2. P0 结论

### 2.1 Activity 事实源边界：通过

- Activity 完全自动、只读、可重建；
- ActivityStory 只保存/缓存派生摘要和源引用；
- 用户不能创建、编辑、删除或批注 Activity；
- 用户说明回到 WorkItemNote、Session 总结、Cycle 复盘或正式变更原因；
- failed / unknown / conflict 命令不能叙述为正式成果完成；
- 缓存删除后可以按源事实和投影版本重建。

### 2.2 Saved View 任务复制边界：通过

- Saved View 只保存 filters、sortRules、groupBy、visibleFields 等规则；
- 数据模型明确禁止保存结果 `workItemIds`；
- 查询结果动态重算，不形成任务快照；
- 从待处理区保存只复制可表达条件，不继承异常提醒、处置动作、复盘时限或同步状态；
- 删除 View 不影响 WorkItem、Cycle、Module 或 Activity。

### 2.3 Module 容量与进度边界：通过

- Module 是 Project 内轻量长期领域分类，不形成第四层任务树；
- WorkItem 最多属于一个 Module，也可无 Module；
- Module 不拥有状态、预计投入、Session、Cycle Membership、容量、权限或进度百分比；
- Module 创建、归档、删除或 WorkItem 换 Module 不改变 Cycle 预计/实际投入；
- 删除 Module 只允许清空或迁移归属，不删除 WorkItem。

### 2.4 Space / Project 作用域：通过

- Module 固定属于同 Space、同 Project；
- Project Saved View 固定单 Project；Space Saved View 固定当前 Space；
- ActivityStory 固定单 Project；
- 三者均禁止跨 Space 查询、归属和聚合。

### 2.5 Session revision 与 Activity 重建：通过

- `SessionTaskContext` 永久保存启动快照；
- `SessionAttributionRevision` 追加式保存当前时间归属；
- EffortProjection、Cycle 报表和 Activity 时间摘要读取最新有效 Attribution revision；
- Outcome 更正追加 revision，Activity 读取最新有效结果；
- 旧 Outcome 中未收敛命令仍独立保留并持续对账；
- 已成功命令不因 Session/Outcome revision 自动回滚。

## 3. 审查中关闭的 P0

1. **Session Outcome 缺少版本字段**  
   已增加 `outcomeRevisionId`、`sessionRevision`、`revision`、`correctedFromRevision`、`effective`。

2. **二级归属更正覆盖启动上下文**  
   已新增 `SessionAttributionRevision`，明确启动 Context 不变，当前投入投影按最新有效归属重算。

3. **pending / unknown 状态解释不完整**  
   已明确 pending 为尚无终态回执，unknown 为服务端结果不可知；两者进入对账但重试规则不同。

4. **Outcome revision 可能隐藏旧待对账命令**  
   已明确命令生命周期独立于最新 Outcome，旧命令不得隐藏、删除或改写。

5. **Cycle 使用未定义 unknown / needs_split 状态**  
   已改为 `estimate_missing` 与 `needs_split` 派生分类，明确不是 WorkItem 生命周期状态。

## 4. P1 建议（不阻塞批准）

- 工程规格中进一步区分：
  - `pending / unknown`：自动查询与安全对账队列；
  - `failed`：明确失败展示与用户修正队列；
  - `conflict`：必须用户决策并生成新 commandId。
- 为 Activity 准备固定事件输入/Story 输出的 golden dataset；
- 为 Saved View 复杂布尔条件定义标准 AST 和解释文案；
- 为 Module 归档与删除制作批量迁移交互。

## 5. 批准门禁

本轮 P0 已全部关闭，三项契约可以进入 Project 主工作台专题原型与工程设计阶段。任何后续新增能力不得破坏：

- Activity 只读投影；
- Saved View 只保存查询规则；
- Module 不参与容量和进度。
