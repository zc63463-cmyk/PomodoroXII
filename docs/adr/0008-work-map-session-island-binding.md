# ADR-0008：工作导图与会话岛绑定（任务空间 × MindCanvas）

| 项 | 值 |
|---|---|
| 日期 | 2026-09-30 |
| 状态 | **已接受**（S1 三项裁决 D1–D3 完成，D8–D10 已经用户确认；D5–D7 为暂定，S3 前复核） |
| 关联 | ADR-0007（会话类型双轨）、`CONTEXT.md`、MindCanvas v1.12.0、entity-ref 协议 v1.3.1 |
| 前置 | S0 接缝校验通过（解析/岛投影/布局/浏览器渲染全部验证，`S0-接缝校验报告-2026-09-29.md`） |
| 依赖 | React 已升至 19.3.0（`e62b265`），解除 `@mindcanvas/react` 的 React 版本冲突 |

---

## 1. 背景

用户在任务空间的工作项上开专注会话时，需要一处**当场记录与梳理思路**的载体，并希望回到任务时能看到"这个任务下历次会话都干了什么"的宏观全貌。

本项目已实现的会话模型对此有硬约束：会话**只归因到一个二级工作项**（恰一条 effective，`session_revision.py:23-28` + `effort_projection.py:176-209` + 写侧 `policy.py:3033-3036` 三重保护），三级工作项只出现在 `session_work_item_plans`（会话的计划项）。

同时经 S0 实测确认：MindCanvas 已有成熟的**岛**（协议 §6.3 `centers` 中心升格 + `projectIslands` 投影）与**岛总览**（`k<0.35` 语义缩放，IO-1/IO-2/IO-UX 已验收）机制，**无需发明任何新机制**。

因此本 ADR 只做三件事：**定绑定层级、定事实源、定岛的比例语义**。

---

## 2. 决策

### D1 · 绑定层级：**L3（一个三级工作项 = 一份工作导图）**

一个三级工作项对应一份 `.mm.md`。文件名 `<workItemId>.mm.md`，路径：

```
<space 数据目录>/maps/<workItemId>.mm.md
```

`maps/` 与既有 `notes/`、`assets/` 同级（实测结构：`data/spaces/<spaceId>/{assets,index.db,notes,space.db}`）。

**理由**：与用户心智一致（前端启动器选 depth3 时归因到父 L2，用户感知上就是"这个三级任务的会话"）；导图绑定是**独立于会话归因的一条新关系**，不受归因不变量约束——归因仍只挂 L2，导图挂在 L3，两者互不干扰。

**后果**：一个 L2 下有多个 L3 时会有多张图；任务空间视图需要"L3 详情内进入导图"的入口，而不是"L2 汇总图"。若后续需要 L2 汇总，另立 ADR（可考虑用岛总览的嵌套迷你卡形态，而非新建图）。

### D2 · 事实源：**space 文件系统 `maps/`**，接受不进同步账本

`.mm.md` 是纯文本事实源（人可读、可 diff、可任意编辑器修改），落盘在 space 数据目录。

**理由**：与既有 `notes/` 文件系统分域一致（`notes/` 存 Markdown 笔记、`maps/` 存导图）；保持 MindCanvas 的核心设计立场——**事实源在纯文本文件，不在 IndexedDB**。

**明确接受的代价**：`.mm.md` **不进 sync v2 同步账本**，因此**跨设备不同步**。这是有意识的取舍，不是遗漏。

**所有者与写路径**：**前端持有 kernel**（TypeScript），负责解析、建岛、布局、序列化；**后端（Python）只做文件字节的存取与路径管理**，不理解导图语义。（硬约束：kernel 是 TS 包，Python 后端无法运行它。）

### D3 · 岛与会话：**严格 1:1**

一次会话 → 图上一个岛。岛内承载该会话期间的思路记录与梳理。

**理由**：直接对应"每个会话占用一个岛"的需求；会话本身已是稳定实体（`focus_sessions.id`），岛身份可与之对齐，无需另建映射。

**后果与义务**：岛数量 = 该工作项的会话次数，随时间线性增长。**必须在 S4 交付归档/折叠策略**（默认只展开近 N 个岛），并用 MindCanvas 既有的岛性能基准（`bench-islands-matrix.mjs` / `bench-islands-a6.mjs`）给出可读性上限的实测依据。不做归档就放任增长，视为缺陷。

### D4 · 建岛：会话 start 成功后写入，且**三处必须同写**

会话启动成功（拿到真实 session）之后建岛，**不在用户点击时预建**——避免建了岛却没有真实会话。

建岛需要在 `.mm.md` 中**同时写三处**（S0 已实测：缺任一处即 `dangling`）：

```markdown
<!--                              ① 文档根笔记块：岛清单 -->
next_cid: c2                        计数器，单调递增、永不复用
centers:
  - at: "node:实现依赖域阻塞计算/2026-09-29 会话 A"
    cid: c1                          稳定身份，优先于 at（改名/移动不失效）
    dir: right                       生长方向
    x: 900                           世界坐标，必须成对
    y: 0
-->
# 实现依赖域阻塞计算

<!--
cid: c1                           ② 目标节点自己的 note.cid（一对一关联）
note:                             ③ 该节点的思路记录
  - 会上确认到的一条结论
-->
## 2026-09-29 会话 A
```

**协议陷阱（实测踩过）**：笔记块**归属其后的节点**。`cid` 块必须写在会话节点标题**之前**，否则它挂到下一个节点上，导致 `cidIndexSize=0` + `dangling:cid-not-found`。

**不自己实现写入逻辑**（**注：此条经 D11 修订**）：使用 `@mindcanvas/react` 现成 API —— `ensureNodeCid` / `upsertCenter` / `removeCenter` / `collectCenters`（`render/centers.ts`）。

### D11 · 建岛实现：自持「移植精简版」（**修订 D4**）

**变更原因**（实施 S2 时发现）：
- `centers.ts` 位于 **react 包**（不在 kernel），且依赖同包 `freeEdges.js` 的三个函数
  （`anchorOfNode` / `collectEntityOccurrences` / `splitEntityAnchor`）
- react 包带 `workspace:*` 依赖，不能直接 `file:` 安装；引入需 vendor 整包
- 而 S2 只需「建岛」一处能力，引入整包的成本收益比不佳

**决策**：在 `frontend/src/lib/work-map/` 自持**文本级最小实现**：

| 模块 | 职责 |
|---|---|
| `mm-note.ts` | `.mm.md` 文档级根块（`next_cid` / `centers`）的**有界解析**与**规范生成** |
| `session-island.ts` | 会话 → 岛：两处同写、`session_id` 幂等、fail-soft |

**为什么文本级可行**：完整 `.mm.md` 解析器要处理标题栈 / 列表栈 / 笔记块归属（~400 行），
而建岛只用到**文档级根块**这一处；本实现只解析根块，**其余正文原样保留** → 天然保真，
不会因重写而丢用户排版。遵循协议「宽松读入、规范写出」。

**代价与硬约束**（必须守住）：
1. 本项目与 MindCanvas 存在**两处实现**，都以协议 v1.3.1 为准；**协议变更时本项目须同步**
2. 因此本模块测试锚在**协议可观察行为**上（生成物能被自己的解析器读回、条目形状、`cid` 单调、
   未知键不丢、fail-soft），而**不是**内部实现细节
3. S3 引入 kernel/react 后若两者的 centers 行为出现分叉，**以协议为准并补对照测试**

**保留 D4 的其余纪律**：不自研另一套岛语义（岛仍是协议 `centers` 的升格机制）；
两处同写与 `cid` 永不复用的规则不变。

### D5 · 导图端口与沉浸三态（**暂定**，S3 前复核）

番茄钟页面（937 行、无 slot/portal 结构）新增导图分区：

| 会话状态 | 端口内容 | 位置 |
|---|---|---|
| 准备态 | 目标 L3 的主图（帮助选计划项） | `SessionLauncher` 相邻分区 |
| 运行态 | **当前会话岛** | 运行态 `.timer-immersive-region` 网格内新增一格 |
| 结束态 | 本会话岛 + 该工作项已有岛的全览（本次落在全局中的位置） | 复盘区下方 |

**沉浸模式冲突（必须裁决的语义问题）**：现有沉浸模式把 `.timer-immersive-region` 内元素渐隐至 `opacity 0.2`（`globals.css:968-978`），这与"沉浸时仍能记录思路"冲突。暂定方案：新增**极简岛**态（只保留岛轮廓与当前会话节点高亮，隐藏文字标注），环与退出按钮照常常驻。**S3 实施前须复核此决策**。

### D6 · 同步：**先单机，跨设备延后**（**暂定**）

`.mm.md` 不进 sync v2 账本（D2 的直接后果）。若跨设备成为真实需求，另立 ADR 设计导图同步——**不在本轮实现**。

### D7 · 形态：**只用思维导图，不引入自由画布**（**暂定**）

`.mc.canvas.json`（自由画布）与本需求无关，不引入。

### D8 · 图内节点：导图自有节点，不占工作项层级

**背景事实**：任务空间工作项**最深 3 层**。`task_space/compiler.py:443-450` 硬拒绝：

```python
if parent_depth >= 3:
    raise MutationRuleViolation("invalid_work_item_tree", {"reason": "depth_exceeds_three"}, retryable=False)
```

因此"L3 下再开一级工作项"这条路被既有不变量关闭（真实数据里的 depth=3 项属 2026-09-11 校验加入前的历史遗留）。

**决策**：在导图里引入**图内节点**——不投影自工作项的节点，承载"还没成为正式任务的子任务/想法"。

- 视觉：**虚线边框 + 极浅底 + 灰字**，与工作项投影节点（实线）区分
- 可「**提升为工作项**」：届时才调任务空间 API 在合法层级创建，节点转为实线投影节点
- **不触碰层级不变量**：图内节点只存在于 `.mm.md`，不写入 `work_items`

这样"任务下面还能再开一级"的需求由图内节点满足，而任务空间保持三层。

### D9 · 节点类型：思考类型作为节点属性

节点可携带思考类型，取值（首版）：

| 类型 | 形状 | 颜色 | 含义 |
|---|---|---|---|
| `insight` 洞察 | 实心圆 | 青 `#0c8599` | 想通了什么 |
| `problem` 问题 | 三角 | 珊瑚 `#d85a30` | 卡住 / 风险 |
| `decision` 决策 | 菱形 | 紫 `#534ab7` | 定了什么 |
| `review` 复盘 | 空心圆 | 绿 `#2f9e44` | 回顾旧结论 |
| `todo` 待办 | 方框 | 琥珀 `#d97706` | 下一步动作 |

**可行性依据**：协议明确「未知字段一律保留，绝不丢弃」（`.mm.md` v1.3.1 前向兼容原则），故该属性可安全写入 `.mm.md`；MindCanvas 保留但**不渲染**它——**视觉呈现由 PomodoroXII 侧实现**，这正是集成特化的空间。

**强制要求**：形状 + 颜色**双重区分**（不只靠颜色），保证色盲可辨。

**由此长出的能力**：按类型跨岛筛选——只看「问题」得到全部历史卡点，只看「待办」得到跨会话行动清单。

### D10 · 接入策略：模块化按需接入（不整包照搬）

**可行，且有明确的官方依据**：kernel 的架构即「入口即组合点」，原话为「空注册表时内核照常工作（渐进增强架构『纯文本版』= `kernel + []` 组合）」「**app = kernel + [plugins]**」。

三层控制手段（按粒度递增）：

| 层 | 手段 | 本项目用法 |
|---|---|---|
| **包级** | `@mindcanvas/kernel`（零依赖 headless）· `@mindcanvas/react`（渲染器）· `@mindcanvas/free-canvas`（自由画布） | 接 kernel；接 react（取其渲染器，非整壳 App）；**不接 free-canvas** |
| **数据级**（最强） | 解析 `.mm.md` 后**剥掉不需要的语义面**再交给 MapView | 首版**剥掉 `edges`（自由边）与 `relations`**；Section / 子树框按需 |
| **props 级** | MapView 的 `boundaryLinks` / `islandMembers` / `centerIds` / `onRemoveSection` / `onEdgeClick` 等**全部可选** | 不传 `boundaryLinks` → **无岛间连线**；不传 `onEdgeClick` → 无自由边交互 |

**关于"关系线"的逐项结论**：

| 线 | 归属 | 能否不接 |
|---|---|---|
| 树连线（父子） | 思维导图本体（`layout.links`） | **必须留**（去掉就不是导图了） |
| 跨岛边界边 | MapView `boundaryLinks` prop | ✅ **不传即关闭** |
| 自由边 / 关系 | 由 `documentRoot` 经 `collectFreeEdges` **内部派生**（`MapView.tsx:762`） | ✅ **剥掉 `edges` 即得空数组** |
| rel 关系几何 | `buildRelGeometries`（kernel 内，**react 包无引用**） | ✅ **天然不接**（不在渲染链路里） |

**渲染层顺序**（`MapView.tsx:1946` 注释）为 `sections → tree-links → free-edges → nodes → edge-labels → ghosts → drag`，各层独立，可分别裁剪。

**同时可注册自有能力**：kernel 的 `Plugin` 基类经 `registerInto` 支持六注册表（kinds / noteKeys / renderers / layouts / semantics / channels），PomodoroXII 可注册自己的 kind（如工作项引用、思考类型）而不改 MindCanvas 源码。

---

## 3. 术语（建议并入 `CONTEXT.md`）

| 术语 | 定义 | 避免 |
|---|---|---|
| **工作导图（Work Map）** | 某个**三级工作项**的全部会话事实的派生视图：会话岛 + 其思路记录 | 思维导图、脑图、画布（歧义） |
| **会话岛（Session Island）** | 一次会话在图上的实体：一个升格中心 + 其思路记录子树；边界由会话身份决定 | 分组、便签、cluster |
| **建岛** | 把会话节点写入 `centers` 使其成为独立岛的动作 | 升格（协议用语，指向同一动作） |
| **导图端口（Map Port）** | 番茄钟页面中承载导图渲染的布局分区 | 插件位、插槽、iframe |
| **极简岛** | 沉浸模式下的第三态：只显示岛轮廓与当前节点 | 隐藏、折叠 |

---

## 4. 不变量与禁止项

1. **导图是只读投影，不是事实源**——除了用户的思路记录本身（图上内容），布局与视图态不入事实源。
2. **布局与视图态（位置、折叠、缩放）不入同步**，只存浏览器本地，与依赖域画布同款纪律。
3. **不引入 iframe / webview 渲染导图**：后端响应统一带 `X-Frame-Options: DENY`，且与现有安全姿态一致。
4. **建岛失败不得阻断会话**：导图是辅助能力，会话闭环优先。会话 start 成功后建岛失败只记录，不回滚会话。
5. **派生不入库**：图上的"某 L3 有哪些会话"是派生读，不新增数据库列。
6. **不新增第二份 React**：`@mindcanvas/react` 的 React 版本必须与本项目对齐（当前 19.3.0），并保持 dedupe 单一实例。
7. **不改会话归因层级**：导图绑定 L3 与会话归因 L2 是两条独立关系，不得借此改动 ADR-0007 的归因不变量。

---

## 5. 被否选项

| 选项 | 结论 | 理由 |
|---|---|---|
| 在 PomodoroXII 内自建画布（复用 `@xyflow/react`） | 否 | MindCanvas 已有成熟的岛/岛总览/富文本渲染；自建等于重造 |
| 绑定 L2 | 否 | 与"三级任务一个主文件"的心智不符；且 L2 下多 L3 时图粒度过粗 |
| `.mm.md` 入 SQLite | 否 | 违反 MindCanvas"纯文本事实源、不在 IndexedDB"的设计立场，且要重做序列化 |
| 独立 Git 仓库承载导图 | 否 | 引入第二套版本/认证体系，与 space 隔离模型不吻合；日后再议 |
| 岛 = L3（会话为岛内节点） | 否 | 与"会话占用一个岛"不符，且一个节点只能有一个 `cid`，多次会话会冲突 |
| 预建岛（点击启动即建） | 否 | 会产生"有岛无会话"的空壳事实 |

---

## 6. 未决与复核点

| # | 事项 | 复核时机 |
|---|---|---|
| 1 | 极简岛的视觉与交互细节（D5） | S3 实施前 |
| 2 | 导图同步方案（D6） | 跨设备成为真实需求时 |
| 3 | 岛归档/折叠阈值（D3） | S4，必须用 MindCanvas 基准脚本给实测依据 |
| 4 | 协议共享方：entity-ref 共享方名单当前不含 PomodoroXII | S1 内与 MindCanvas 侧对齐；未对齐前只作独立消费者，不承诺兼容 |
| 5 | **导入子树 / 导入岛 + 复制操作**（用户规划中的后续能力）：把某工作项子树投影进当前图、把另一张图的会话岛搬运过来，并配套复制 | 独立立项。技术基础已具备：kernel 导出 `duplicateNode`（`tree/`），岛搬运可基于序列化 + `centers` 重分配 `cid` |
| 6 | 图内节点「提升为工作项」的交互与冲突处理（D8） | S2/S3 |
| 7 | 节点类型的**可扩展性**：首版五个类型是否够用、能否由用户自定义（D9） | 首版落地后按真实使用调整 |
| 8 | L2–L3 联动的其余形态（如 L2 汇总视图 vs L3 各自成图） | 按真实使用痛点决定，不预先实现 |

---

## 7. 证据索引

| 事实 | 证据 |
|---|---|
| 会话只归因 L2（恰一条 effective） | `backend/app/models/session_revision.py:23-28`；`focus_session/effort_projection.py:176-209`；`focus_session/policy.py:3033-3036` |
| 三级只在会话计划中 | `backend/app/models/session_revision.py:42-68`；`policy.py:559-565` |
| 后端为 Python、无法运行 TS kernel | `backend/app/services/`（无 JS 运行时）；kernel 为 `@mindcanvas/kernel` v1.12.0 |
| space 目录结构（maps 的同级位置） | 实测 `data/spaces/<id>/{assets,index.db,notes,space.db}` |
| 岛 = 协议 §6.3 `centers` 升格 | MindCanvas `docs/specs/2026-09-02-mm-md-protocol.md` §6.3 |
| 建岛三处同写、笔记块归属其后节点 | S0 实测：`s0-kernel-probe.mjs` 对自造样本的两次迭代输出 |
| 岛总览语义缩放已验收 | `docs/specs/2026-09-17-island-overview-design.md` §3 D1–D11、§5、§9 |
| 建岛写入 API 现成 | `@mindcanvas/react` `render/centers.ts`：`ensureNodeCid`/`upsertCenter`/`removeCenter`/`collectCenters` |
| 沉浸模式渐隐实现 | `frontend/src/app/(app)/timer/page.tsx:198-205,811,823-842`；`globals.css:968-978` |
| 后端响应带 X-Frame-Options: DENY | `backend/app/middleware.py:96-108` |
| React 版本已对齐并 dedupe | 提交 `e62b265`；`npm ls react` 全树 `19.3.0 deduped` |
| **任务空间最深 3 层（D8 依据）** | `backend/app/task_space/compiler.py:443-450`（`depth_exceeds_three` 硬拒绝）；`_parent_depth` `:358-381`；`_work_item_depth` `focus_session/policy.py:2881` |
| 层级标注实测（L1/L2 真实 depth） | 实测 space.db：`思维导图的悬浮窗视图`=depth 1、`探索小窗实现方式`=depth 2、`体验：卡点分析记录`=depth 2 |
| **协议容忍未知字段（D9 依据）** | MindCanvas `docs/specs/2026-09-02-mm-md-protocol.md` §一「前向兼容：未知 kind、未知字段一律保留，绝不丢弃」 |
| type_definitions 具备 icon/color/rank | 实测 `space.db`：`type_definitions(id, created_at, updated_at, version, name, icon, color, rank, system, archived_at)`，当前仅 `sys-type-work-item` |
| **模块化接入依据（D10）** | `packages/kernel/src/plugin/plugin.ts`（Plugin 基类 + registerInto 自注销）；`packages/kernel/src/registry/index.ts`（六注册表；「空注册表时内核照常工作 = kernel + []」「app = kernel + [plugins]」） |
| MapView 能力全部可选 | `packages/react/src/render/MapView.tsx:139-300`（`boundaryLinks?` / `islandMembers?` / `centerIds?` / `onRemoveSection?` / `onEdgeClick?` …） |
| 自由边由 documentRoot 内部派生 | `packages/react/src/render/MapView.tsx:762`（`collectFreeEdges(rootNode)`）→ 剥掉 `edges` 即空 |
| 渲染层顺序独立可裁剪 | `packages/react/src/render/MapView.tsx:1946`（`sections → tree-links → free-edges → nodes → edge-labels → ghosts → drag`） |
| rel 关系不在 react 渲染链路 | `buildRelGeometries` 在 `packages/react` 内零引用 |
| 复制能力基础（§6-5） | kernel 导出 `duplicateNode`（`tree/treeOps.ts`） |