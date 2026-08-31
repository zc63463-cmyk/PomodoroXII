# TipTip Next WorkItem v1.0 工程实施计划

> 状态：待工程评审  
> 产品基线：WorkItem v1.0（2026-07-10 已批准）  
> 计划类型：全新构建，不在 Phase14C 上增量改造  
> 目标工程：`E:\Development\MyAwesomeApp\tip-tip-next-sandbox`

权威产品输入：

- [WorkItem v1.0 审查入口](../REVIEW_INDEX.md)
- [共享领域契约](../specs/WORKITEM_SHARED_CONTRACT.md)
- [Type 与柔性排期](../specs/WORKITEM_FLEXIBLE_PLANNING_REVIEW.md)
- [状态生命周期](../specs/WORKITEM_LIFECYCLE_REVIEW.md)
- [父子与依赖](../specs/WORKITEM_RELATIONS_REVIEW.md)
- [列表与详情工作面](../specs/WORKITEM_WORKBENCH_REVIEW.md)

目标沙箱中的早期 `docs/specs/WORKITEM_*.md` 是讨论草案，不作为实施输入；如有冲突，以上 v1.0 文件优先。

## 1. 计划目标

本计划把已批准的 WorkItem 产品基线转化为可执行工程路径，保证：

1. 先建立唯一、可持久化、可审计的 WorkItem 事实源；
2. 主窗口、未来 Orbit 桌宠和其他投影只能通过统一应用服务读写同一事实；
3. 柔性排期、状态、父子和依赖语义不被技术实现静默改变；
4. 每个阶段都形成可演示的用户闭环，而不是先完成所有后端层再一次性交付 UI；
5. Phase14C 仅迁移经过白名单审查的纯算法和回归夹具，不迁移旧事实模型与混合 UI；
6. WorkItem P0 通过验收后，才进入 Cycle、容量、Module 和 Orbit 数学权重。

## 2. 产品范围锁

### 2.1 P0 必须交付

- Workspace / Project 最小边界；
- Workspace Type、Label、StatusDefinition 库；
- Project 启用范围、默认 Type、默认未开始状态；
- WorkItem 快速创建、编辑、完成、取消、暂停、等待、重开、归档；
- 完成窗口、投入区间、信心、复盘点、硬截止；
- `needsReplan`、`reviewDue`、`blockedByDependency`、`dependencyNeedsResolution`、`recursiveProgress`；
- 最多三层的同 Project 单父任务树；
- 同 Workspace 项目内/跨 Project 依赖、环拒绝和异常修复；
- 默认七列列表、行内 Type/状态/计划/投入编辑、可选显示字段与当前 Project 会话查询状态；
- 桌面右侧详情抽屉、窄屏全页详情、关系详情与最小可用 L3 关系空间入口；
- 批量状态、Type、负责人、Label、归档/恢复以及部分失败结果；
- 乐观并发、崩溃恢复、迁移、可重建投影和可访问性核心流程；
- 本机多窗口共享事实所需的后台命令/查询/事件边界。

### 2.2 明确不进入 P0

- Cycle、容量超载与 planning uncertainty；
- Module；
- 完整 Saved View、看板、时间线；
- AI 自动排期；
- Type 专属状态机、自定义字段平台；
- Orbit 风险数学权重、L1/L2 和完整风险空间；P0 仍交付以当前 WorkItem 为中心的最小可用 L3 关系空间；
- 云同步、账号、企业权限；
- 跨 Workspace 依赖；
- CPM、lag、资源约束排程；
- 完整移动端应用。

说明：P0 的 L3 是最小可用关系空间，只展示当前 WorkItem、父子骨架、项目内依赖和跨项目边界端口，并支持返回详情；不包含风险权重、关键链视觉、L1/L2 或完整 WebGL 体验。

任何新增 P0 需求必须同时给出被移除项，或单独通过范围变更评审。

## 3. 总体技术策略

### 3.1 架构形态

采用**本地优先的模块化单体 + 桌面后台单写者 + 多窗口投影**：

```text
Main Workbench Window ─┐
                       ├─ Versioned Command / Query Contract
Future Orbit Window ───┘
                                ↓
Desktop Host / Background Runtime
├─ Application Services        唯一写入口
├─ Domain Modules              业务不变量
├─ Repository Ports            持久化抽象
├─ Transaction + Audit Events  事实与事件同事务
├─ Projection Scheduler        派生信号与读模型
└─ Local Event Fan-out         多窗口失效/增量通知
                                ↓
Embedded Database + Backup
```

### 3.2 强制依赖方向

```text
UI → IPC/API Contract → Application → Domain
                                  ↑
                    Infrastructure implements ports

Projection → reads facts/events → produces disposable read models
Orbit      → reads projections   → never owns or rewrites facts
```

禁止：

- UI 直接访问数据库；
- UI Store 成为 WorkItem 事实源；
- Repository 承担业务规则；
- 投影或风险引擎回写 WorkItem 事实；
- Domain 依赖 React、桌面壳、SQLite 驱动或系统时钟实现；
- 新工程直接 import Phase14C 包。

### 3.3 事实与事件策略

P0 不采用全量 Event Sourcing。权威数据为：

> **规范化当前事实表 + 同事务追加审计事件/Outbox**

事件用于活动历史、诊断、多窗口通知和未来同步出口；不能假定现有事件足以重建全部事实。P0 保证：

- 当前事实可从数据库恢复；
- 派生缓存/投影可从事实与关系重建；
- 每个成功命令产生审计事件；
- 事实更新与事件追加处于同一事务；
- 投影失败不回滚已成功的用户事实。

## 4. Gate 0：桌面壳与技术栈能力验证

Gate 0 是**并行、限时且非阻塞的风险 Spike**：它必须在正式桌面打包和多窗口阶段前完成，但不能阻塞纯领域契约、数据库原型和测试夹具的推进。不要用“熟悉度”直接代替验证，也不要在 Spike 中实现正式 WorkItem 业务。

### 4.1 必测能力

1. 后台运行时独立于主窗口生命周期；
2. 主窗口关闭后后台继续运行；
3. 可创建透明、置顶、可拖动的第二窗口；
4. 两个窗口通过版本化命令/查询接口读取同一事实；
5. 渲染进程没有直接数据库权限；
6. 本地事件可以向多个窗口广播并触发投影刷新；
7. 单实例、崩溃恢复、自动启动和明确退出语义可实现；
8. Windows 首轮打包、安装、升级路径可以自动化；签名所需机制和外部凭据已识别；
9. 在同一基准机、同一构建模式下记录冷启动、主窗口唤起、双窗口空闲内存与 CPU；Gate 0 只做相对选型，不冒充正式性能 SLA；
10. 能运行无障碍与浏览器/桌面 E2E 测试。

### 4.2 候选与决策规则

候选至少比较：

- Tauri v2 + Web UI；
- Electron + Web UI。

不要在 Spike 前锁死 React/Vue、Rust/Node 领域实现。选型必须记录 ADR，并以以下权重判断：

| 维度 | 权重 |
|---|---:|
| 多窗口与后台生命周期可靠性 | 25% |
| 单写者与本地数据库隔离 | 20% |
| 透明桌宠窗口能力 | 15% |
| 崩溃诊断、测试与可维护性 | 15% |
| 安装升级与跨平台路径 | 10% |
| 性能与资源占用 | 10% |
| 团队开发效率 | 5% |

### 4.3 Gate 0 退出标准

- 两个候选均有可运行 Spike 或明确不可行证据；
- 形成 ADR-001；
- 确认后台进程、渲染窗口、数据库和事件分发边界；
- 未实现正式 WorkItem 业务代码；
- 选型不改变产品基线。

## 5. 建议模块边界

```text
packages/
├─ contracts/              命令、查询、错误和事件 schema
├─ domain-catalog/         Workspace/Project/Type/Label/StatusDefinition
├─ domain-workitem/        WorkItem、生命周期、计划值对象
├─ domain-relations/       父子、依赖、不变量与图算法
├─ application/            命令编排、事务、版本检查
├─ projections/            列表、详情、信号、活动读模型
├─ persistence/            Repository、迁移、备份、恢复
├─ desktop-host/           单实例、窗口、IPC、事件广播
├─ workbench-ui/           主工作台
└─ test-support/           FakeClock、fixtures、property generators
```

实际目录可以随桌面壳调整，但依赖方向不可改变。

### 5.1 Catalog 模块

负责：Type、Label、StatusDefinition、Project 启用范围和默认值。

不负责：WorkItem 生命周期、任务树、依赖和 UI 过滤状态。

### 5.2 WorkItem 模块

负责：稳定身份、标题、描述、负责人、优先级、状态、归档和柔性计划事实。

关键值对象：

- `WorkItemId`、`DisplayKey`；
- `StatusCategory`；
- `TargetWindow`；
- `EffortRange`；
- `PlanningConfidence`；
- `ReviewSchedule`；
- `HardDeadline`；
- `Version`。

### 5.3 Relations 模块

负责：

- 单父项、三层限制和祖先环；
- `depends_on` 规范方向；
- 同 Workspace 跨 Project 校验；
- 重复语义边、自环和有向环拒绝；
- 依赖结果与异常修复；
- 递归进度。

### 5.4 Projection 模块

负责可删除、可重建的：

- WorkItem 列表行；
- WorkItem 详情；
- 活动时间线；
- 派生信号；
- 父子展开摘要；
- 信号优先级与去重。

不负责保存用户事实。

## 6. 持久化与恢复计划

### 6.1 首选基线

首版优先验证 SQLite，原因是单机桌面、单主写者、跨表不变量、关系查询、事务迁移和在线备份需求高度匹配。最终仍需通过 Gate 0 与 ADR-004 确认具体驱动和进程位置。

建议启用：

- foreign keys；
- WAL；
- `synchronous=FULL`；
- busy timeout；
- schema version；
- 启动 quick check；
- 迁移前备份。

### 6.2 核心事实表

建议最少包括：

```text
workspaces
projects
project_counters
work_item_types
labels
status_definitions
project_enabled_types
project_enabled_statuses
work_items
work_item_labels
work_item_relations
domain_events
schema_migrations
projection_state / attention_cache（可删除）
```

计划字段在 P0 可与 `work_items` 同表存储，避免过早拆表；只有出现独立生命周期或高频历史需求时再拆分。

### 6.3 命令事务模板

```text
BEGIN IMMEDIATE
→ 读取事实与配置
→ 校验 expectedVersion / commandId
→ 执行领域不变量
→ 更新事实，version + 1
→ 追加 domain_event / outbox
→ COMMIT
→ 发布本地失效事件
→ 异步刷新投影
```

### 6.4 幂等与编号

- 所有命令含 `commandId`，数据库唯一约束保证崩溃重试幂等；
- 内部 ID 使用可排序全局 ID（最终格式由 ADR 决定）；
- `displayKey` 由 Project 计数器在同事务分配；
- 允许号段空洞，禁止复用；
- `displayKey` 只是可见别名，不是关系外键；
- 未来同步若需重编号，必须保留旧 Key alias；P0 不实现重编号。

### 6.5 时间与时区

现在必须固定：

- 日期事实使用 ISO 本地日期；
- 瞬时值使用 UTC；
- 完成窗口保留创建时 IANA 时区；
- Workspace 改时区不改写历史窗口；
- `needsReplan` 在窗口结束日次日 00:00 后产生；
- FakeClock 与 FakeTimezone 是所有日期测试的强制依赖；
- 不允许 Domain 直接调用系统 `now()`。

### 6.6 恢复与迁移

- 数据库迁移只向前、事务化、记录版本；
- 新版本打开数据库前自动备份；
- 定期轮换快照，并实际做恢复测试；
- WAL 崩溃恢复后重建可删除投影；
- 新版数据库禁止旧版应用静默打开；
- 投影算法保存 `algorithmVersion`，不匹配时全量重建；
- P0 没有正式云端产品，但必须实现可测试的离线重放闭环：命令在传输不可用时进入本地 durable intent queue；恢复连接后按 `commandId`、`originDeviceId`、`expectedVersion` 顺序提交到可替换的 SyncTarget 端口；冲突产生待用户处理结果，不静默覆盖；
- P0 使用本地模拟/回环 SyncTarget 完成断网→重连→重放验收，不实现真实账号、云服务、CRDT 或跨设备 UI；未来云端只替换 SyncTarget 实现；
- 旧 Phase14C 用户数据迁移另设 Gate M：盘点 localStorage、IndexedDB、JSON 导出和旧事件数据；若项目从未面向真实用户发布，必须以书面证据关闭 Gate M，而不是默认忽略。

## 7. 纵向实施阶段

实施按用户闭环切片，不按“先写完数据库，再写完服务，最后写 UI”的水平方式切割。

### Phase 0：工程骨架与契约门

**目标**：建立新工程与不可绕过的架构约束。

**交付**：

- 选型 ADR；
- Workspace/Project/WorkItem/Type/Status/Relation ID 与 schema；
- Clock、Timezone、ID、Transaction、Repository 端口；
- IPC/API 契约版本机制；
- 数据库迁移、测试数据库和 FakeClock；
- 架构依赖检查；
- 一条不含 UI 的 create → persist → read contract test。

**退出标准**：

- UI 无数据库依赖；
- Domain 无框架依赖；
- 事实与事件同事务测试通过；
- expectedVersion 冲突不覆盖；
- 强杀后事实仍可恢复；
- Phase14C 代码没有成为新工程依赖。

### Phase 1A：最小 Catalog 与捕捉契约

**用户闭环**：新 Workspace/Project 获得可解释的默认 Type 与状态语言，为创建真实 WorkItem 做准备。

**交付**：

- Workspace 通用 Type；
- 唯一系统 `not_started` 兜底状态；
- 初始化一个可归档但 Project 必须保留的默认 `completed` 状态定义（不是系统 fallback）；
- Project 包含范围、默认 Type 和默认未开始状态；
- Catalog 管理命令、迁移规则和契约测试。

**退出标准**：

- Project 始终至少启用一个 `not_started` 和一个 `completed` 定义；
- 默认状态必须映射 `not_started`；
- 配置异常不会产生无 Type/Status WorkItem；
- 已被引用的底层类别不能原地修改。

### Phase 1B：捕捉与找回

**用户闭环**：输入标题，立即在列表看到并可打开详情。

**交付**：

- WorkItem 创建、查询、列表、详情；
- Project 计数器与 displayKey；
- 快速创建只要求标题；
- 创建失败保留输入；
- 本地事件驱动列表刷新。

**退出标准**：

- 重复 commandId 不重复创建；
- 创建成功不等待派生计算；
- 快速创建键盘流程和恢复通过 E2E。

### Phase 2：自己的工作语言与生命周期

**用户闭环**：用户扩展 Type/状态语言，并推进、暂停、等待、完成、取消、重开、归档任务。

**交付**：

- Type、Label、StatusDefinition 完整管理 UI；
- Project 包含范围和默认值编辑；
- 六类状态映射；
- 状态变更事件；
- 归档/恢复；
- 完成、取消、重开副作用；
- 右侧详情抽屉基础编辑。

**退出标准**：

- 状态映射被引用后不可原地改底层类别；
- Project 始终有未开始与完成状态；
- 完成/取消停止未来提醒，但保留历史；
- 取消不自动归档；
- 重开不自动安排时间。

### Phase 3：柔性计划与重排闭环

**用户闭环**：用窗口、投入、信心和复盘表达计划；窗口结束后获得重排帮助而非失败提示。

**交付**：

- 自然语言窗口冻结；
- 投入档位与自由区间解析；
- 用户正式信心；
- 动态复盘点；
- 独立硬截止；
- `reviewDue`、`needsReplan`、`lowConfidenceAttention`；
- 保持计划、移动窗口、暂不安排、拆分、暂停等处理动作；
- 计划列与信号列。

**退出标准**：

- 本周、近一周、下周、跨年、DST 测试通过；
- 窗口结束不改变工作状态；
- 柔性窗口不使用失败/强红色语义；
- 手动复盘不被自动规则静默覆盖；
- 投入解析失败不污染容量数据；
- 派生缓存删除后重建结果一致。

### Phase 4：三层任务树与递归进度

**用户闭环**：拆分范围、移动子树、查看进度，并处理父项完成例外。

**交付**：

- 同 Project 单父项；
- 最多三层；
- childRank；
- 子树移动；
- 祖先环检查；
- 递归进度与 N/A；
- 父项完成确认；
- 列表折叠与摘要。

**退出标准**：

- 第四层、跨 Project 父子和祖先环写入成功率为 0；
- 已取消子项排除分母并单独展示；
- 全部子项取消时为 N/A；
- 100% 不自动完成父项；
- 并发移动不会生成双父或断树。

### Phase 5：可解释依赖与修复

**用户闭环**：创建执行依赖、看到被谁阻塞、拒绝死循环，并修复取消/不可访问的前置项。

**交付**：

- 项目内与 Workspace 内跨 Project `depends_on`；
- 自环、重复语义边和有向环拒绝；
- `blocks` 反向显示；
- `blockedByDependency`；
- `dependencyNeedsResolution`；
- 取消、归档、缺失、不可访问前置项真值；
- 旧异常环修复视图基础能力；
- Waiting 建议但不自动改状态；
- 详情关系区和版本化 L3 路由契约；
- 最小可用 L3 关系空间：以当前 WorkItem 为中心，展示三层父子骨架、直接/可见依赖、跨 Project 边界端口、关系类型与异常说明；不计算 Orbit 风险权重。

**退出标准**：

- 新环写入成功率为 0；
- 错误返回环路径和可行动建议；
- 依赖解除只建议恢复，不自动跳状态；
- 跨项目读取不泄露无权访问内容；
- relates_to/duplicates/evidence_for 不传播阻塞风险；
- 从详情进入 L3 后可辨认父子与依赖、跨项目端口，返回时恢复原详情上下文；
- 在基准规模 10,000 WorkItems / 30,000 依赖边的合成 Workspace 上，单次新增依赖环检测 P95 ≤ 100ms（基准机与构建模式必须记录）；若不达标，禁止用降低正确性换性能，进入索引/算法优化。

### Phase 6：日常工作台与桌面运行加固

**用户闭环**：在稳定、可恢复、键盘可用的工作台完成日常管理。

**交付**：

- 默认七列列表与 Type/状态/计划/投入行内编辑；
- Display fields 及当前 Project 会话级显示列、Filter、Group、Sort；
- 信号优先级与折叠；
- 桌面右侧抽屉、全页路由与窄屏自动全页；
- 返回恢复滚动、折叠、筛选、分组、显示列和选中；
- 批量状态、Type、负责人、Label、归档/恢复；独立项默认部分成功并返回成功/失败清单；
- 父项批量完成时汇总活动子项异常并要求统一或逐项决策；
- 冲突处理与重新应用；
- 投影失败时“洞察更新中”；
- 后台运行、多窗口事件广播和明确退出；
- WCAG 2.1 AA 核心流程；
- 备份、恢复、升级和安装包验收。

**退出标准**：

- 核心 Given/When/Then 全部自动化；
- 事实编辑不因风险计算失败而阻塞；
- 版本冲突不覆盖后台已提交的较新事实；
- 主窗口重开后恢复事实和可重建投影；
- 桌面/窄屏详情模式、行内编辑和批量部分失败通过产品验收；
- 详情返回上下文恢复率 100%；
- 键盘、屏幕阅读器、200% 文本与 44px 触控目标验收通过；
- WorkItem P0 产品验收通过。

## 8. 可独立抓取的工程工作包

| 编号 | 工作包 | 主要依赖 | 用户可见价值 |
|---|---|---|---|
| E-01 | 桌面壳与后台生命周期 Spike | 无（与 E-02 并行） | 为主窗口与桌宠共存消除技术不确定性 |
| E-02 | 契约、ID、Clock 与架构门禁 | 无 | 防止后续实现破坏产品语义 |
| E-03 | 本地数据库、事务事件、离线重放、迁移与恢复 | E-02；桌面 Host 接线前需 E-01 | 任务可真实保存、离线重放并从崩溃恢复 |
| E-04 | 最小 Catalog、兜底与 Project 默认配置 | E-02, E-03 | 新项目始终拥有可用工作语言 |
| E-05 | 首个 WorkItem：快速创建与默认列表 | E-04 | 用户能记录并找回工作 |
| E-06 | Type/Status/Label 管理、生命周期、归档与详情编辑 | E-05 | 开发、学习、个人能使用自己的语言并推进工作 |
| E-07 | 柔性计划与计划列 | E-06 | 不用伪精确日期也能安排工作 |
| E-08 | 复盘与重排闭环 | E-07 | 偏差转化为行动，不制造失败感 |
| E-09 | 三层任务树与父项进度 | E-06 | 用户能拆分复杂工作并理解范围 |
| E-10 | 依赖、环检测与阻塞信号 | E-06, E-09 | 用户看见执行约束并避免死锁 |
| E-11 | 跨项目依赖、异常修复与最小 L3 | E-10 | 共享组件/课程前置关系可表达并可空间查看 |
| E-12 | 可恢复工作台、行内/批量操作与桌面质量门禁 | E-07, E-08, E-09, E-10, E-11 | 日常使用稳定、可访问、可恢复 |
| E-13 | Phase14C 用户数据迁移或无迁移证据关闭 | E-03, ADR-010 | 升级不静默丢失旧任务事实 |

每个工作包都必须包含：领域测试、Repository/事务集成测试、契约测试、必要 E2E、文档/ADR 更新和明确退出标准。

## 9. TDD 与测试策略

### 9.1 测试金字塔

1. **领域单元与属性测试**：状态真值、窗口边界、树深、祖先环、依赖环、递归进度；
2. **应用服务测试**：命令、expectedVersion、幂等、事件、durable intent 重放、冲突和批量部分成功；
3. **Repository 集成测试**：事务、外键、并发、迁移、崩溃恢复；
4. **投影一致性测试**：删除缓存后重建与增量结果相同；
5. **IPC/API 契约测试**：schema 兼容、错误码、权限与序列化；
6. **桌面 E2E**：快速创建、状态、计划、树、依赖、冲突、重启恢复、键盘与多窗口同步。

### 9.2 每个功能的红绿重构模板

```text
1. 从产品 Given/When/Then 写失败验收测试
2. 补领域级最小失败测试
3. 实现最小领域规则
4. 补应用服务与事务测试
5. 实现持久化/命令处理
6. 补 UI 契约/E2E
7. 实现最小用户闭环
8. 重构并运行全量门禁
9. 更新 ADR/契约/迁移说明
```

### 9.3 必做故障注入

- 事务各步骤中断；
- 两连接同时更新同一版本；
- 两次相同 commandId；
- Project 编号竞争；
- 进程强杀与 WAL 恢复；
- 投影刷新失败；
- 迁移中断；
- 数据库 quick check 失败；
- DST、跨午夜、跨年；
- 依赖图随机生成与环性质测试。

## 10. 自动化质量门禁

任何 Phase 不得在以下门禁失败时标记完成：

- format / lint / typecheck；
- domain unit tests；
- property tests；
- persistence and migration tests；
- IPC/API schema compatibility；
- projection rebuild equivalence；
- browser/desktop E2E；
- accessibility smoke；
- architecture dependency check；
- bundle/installer smoke；
- 数据备份恢复演练。

建议建立静态架构规则：

- `domain-*` 不能依赖 UI、desktop-host、persistence；
- `workbench-ui` 不能依赖数据库驱动；
- `projections` 不能调用写 Repository；
- `desktop-host` 不包含 WorkItem 业务规则；
- 禁止从新工程导入 Phase14C 源码路径。

## 11. Phase14C 迁移策略

### 11.1 可迁移白名单

仅允许在新工程内重新落位并重新测试以下精确资产：

- `src/domain/math.ts`：`clamp`、`normalizeSoft`、`safeDiv`、`lerp`、`hashToRange`、`smoothstep`；回归依据 `tests/domain/math.test.ts`；
- `src/domain/taskGraph.ts`：算法思路与函数体 `buildGraph`、`stronglyConnectedComponents`、`canReach`、`wouldCreateCycle`、`largestScc`；必须替换旧 `SimTask` / `DependencyEdge` 为 Next `WorkItemId` / `Relation`，并明确只对 `depends_on` 图做环检测；回归依据 `tests/domain/taskGraph.test.ts`；
- `src/fixtures/scenarioFixtures.ts` 与 `tests/domain/simulationRegression.test.ts` 只能挑选不依赖旧 UI 的输入/期望值，复制为新工程独立 golden data，并在文件头记录来源；禁止直接 import；
- `src/domain/l3RiskModel.ts`、`src/domain/orbitDebtModel.ts` 仅进入未来独立 Orbit 候选库，必须经过 `WorkItemRiskInput` 防腐适配器，P0 不接入正式风险权重。

### 11.2 必须重写黑名单

以下是代表性禁止复制列表；凡依赖旧 `ProjectSpace`、`Track/Lane`、`SimTask/TaskState`、旧浏览器持久化协议或混合 UI Store 的模块，默认都不在白名单：

- `src/domain/projectWorkspace.ts`；
- `src/domain/projectWorkspaceRepository.ts`；
- `src/domain/projectWorkspaceApplicationService.ts`；
- `src/domain/projectWorkspaceServices.ts`；
- `src/domain/projectWorkspaceAttention.ts`；
- `src/app/projectWorkspaceRuntime.ts`；
- `src/fixtures/projectWorkspaceFixtures.ts`；
- `src/state/taskStore.ts`；
- `src/state/taskActions.ts`；
- `src/state/memoryTaskRepository.ts`；
- `src/state/persistence.ts`；
- `src/state/taskRepository.ts`；
- `src/state/browserTaskRepository.ts`；
- `src/state/indexedDbTaskRepository.ts`；
- `src/state/localStorageTaskRepository.ts`；
- `src/state/taskSelectors.ts`；
- `src/app/App.tsx`；
- `src/app/ProjectWorkspaceWorkbench.tsx`。

原因：上述模块混合旧 ProjectSpace/Track/Lane/SimTask 事实、内存仓储、选择态、风险态和 UI 写入，不满足 v1.0 稳定身份、状态、计划、版本与跨 Project 依赖契约。

### 11.3 仅作行为参考

- 旧 Relation 语义归一；
- 旧风险传播、关键链和积分倒计时的测试场景；
- 旧 WebGL 视觉与交互探索；
- 旧工作台信息密度和键盘交互经验。

参考不等于复制。所有迁移必须经过：

```text
旧算法 → 纯函数提取 → Next 类型适配 → golden 对照 → 新性质测试 → 才能合入
```

## 12. ADR 清单

ADR 必须在其阻塞的工作包开始前冻结，不要求十份文档在所有工程活动前一次性写完：

| ADR | 主题 | 最晚冻结点 |
|---|---|---|
| ADR-001 | 桌面壳能力门槛与最终选型 | E-01 结束、桌面 Host 实施前 |
| ADR-002 | 后台单写者、多窗口与退出语义 | E-03 持久化接线前 |
| ADR-003 | 模块化单体及依赖规则 | E-02 前 |
| ADR-004 | SQLite/替代存储、事实表 + 事务事件 | E-03 前 |
| ADR-005 | 命令幂等、expectedVersion 与批量语义 | E-03 前 |
| ADR-006 | 全局 ID、displayKey 和未来重编号策略 | E-03 前 |
| ADR-007 | 日期、UTC、IANA 时区与 DST | E-07 前 |
| ADR-008 | 派生投影一致性、失效与重建 | E-07 前 |
| ADR-009 | 备份、迁移、旧版阻断和恢复 | E-03 前 |
| ADR-010 | Phase14C 代码/用户数据迁移与防腐层 | 任一旧资产进入新工程前 |

可延后：

- 云同步协议与 CRDT；
- Orbit 风险算法版本；
- Cycle/容量数据模型；
- Module；
- 完整 Saved View；
- 多人权限。

## 13. 风险登记

| 风险 | 可能后果 | 缓解措施 |
|---|---|---|
| 过早锁死桌面壳 | 后台/透明窗口能力返工 | Gate 0 双候选 Spike |
| 事实与事件双写不一致 | 活动、同步与恢复不可信 | 同事务事件 + 故障注入 |
| UI 直连数据库 | 多窗口产生不同业务规则 | 单写者 + 架构静态门禁 |
| 时区与日期边界错误 | 重排/复盘错误触发 | Clock/Timezone 端口 + 边界性质测试 |
| 父子与依赖重复传播 | 风险被双重放大 | 父子只聚合，依赖才传播 |
| 跨项目环检测退化 | 保存变慢或漏环 | 图索引、性能预算、随机图测试 |
| 派生计算被当作事实 | 缓存损坏导致状态漂移 | 可删除重建 + algorithmVersion |
| 旧代码污染新模型 | 两套事实再次并存 | import 禁令 + 白名单 clean-room 迁移 |
| 范围顺手扩张 | WorkItem P0 无法收口 | 非目标锁 + 变更换范围规则 |
| 备份从未验证恢复 | 真故障时备份不可用 | SQLite 一致快照、校验、隔离损坏库与自动化恢复演练 |
| 遗漏旧用户数据迁移 | 切换新产品时历史任务丢失 | Gate M 数据源盘点、字段映射、不可映射报告、幂等导入和回滚 |

## 14. WorkItem P0 发布准入

只有同时满足以下条件，才能宣布 WorkItem P0 完成并进入 Cycle 规划：

1. v1.0 产品验收场景全部通过；
2. 所有核心不变量有自动化测试；
3. 数据库从空库及所有公开发布过的 schema 逐级迁移；若尚无公开 schema，至少验证空库→当前和当前前一开发 schema→当前；
4. 使用数据库一致快照机制生成的备份通过校验并可真实恢复，恢复后重新验证核心不变量；
5. 投影可删除并重建为相同结果；
6. 版本冲突、重复命令和崩溃不会静默丢数据；
7. 新依赖环写入成功率为 0；
8. 主窗口关闭/重开不影响后台事实；
9. 核心流程满足 WCAG 2.1 AA；
10. 新工程不依赖 Phase14C 事实模型或 UI；
11. 离线 durable intent 在本地模拟 SyncTarget 上完成断网、重连、顺序重放、幂等与冲突验收；
12. Gate M 完成 Phase14C localStorage、IndexedDB、JSON 和旧事件盘点；若存在真实用户数据，E-13 迁移、不可映射报告、幂等重跑与回滚测试通过；若不存在，以可审计证据关闭；
13. 最小 L3 可从详情进入、展示父子/依赖/跨项目边界并恢复返回上下文；
14. Cycle、Module、Saved View、Orbit 权重没有被偷偷纳入 P0；
15. 产品负责人完成最终演示验收。

## 15. 下一步确认点

本计划通过工程评审后：

1. 并行执行 Gate 0 技术 Spike 与 E-02 契约/领域骨架；
2. 在 E-02 前冻结 ADR-003；E-01 结束后冻结 ADR-001/002；在 E-03 前冻结 ADR-004、ADR-005、ADR-006、ADR-009；
3. 完成旧用户数据 Gate M 盘点，并冻结 ADR-010；
4. 在 `tip-tip-next-sandbox` 初始化正式工程；
5. 按 E-02 → E-03 → E-04 → E-05 的依赖顺序开始 TDD 实施，不并行抢占未解锁工作包；
6. 每完成一个纵向 Phase 进行产品演示与退出评审。
