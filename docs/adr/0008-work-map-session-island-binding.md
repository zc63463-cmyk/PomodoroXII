# ADR-0008：工作导图与会话岛绑定（任务空间 × MindCanvas）

| 项 | 值 |
|---|---|
| 日期 | 2026-09-30 |
| 状态 | **已接受**（S1 三项裁决 D1–D3 完成，D8–D10 已经用户确认；2026-09-30：**D5 已复核（D12）、S3 最小集已 spike 定盘（D13）、思考类型键名与写入形状已裁决（D14）**；D6–D7 为暂定） |
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

### D5 · 导图端口与沉浸三态（**已复核，见 D12**；下述"暂定方案"已被 D12 取代）

番茄钟页面（937 行、无 slot/portal 结构）新增导图分区：

| 会话状态 | 端口内容 | 位置 |
|---|---|---|
| 准备态 | 目标 L3 的主图（帮助选计划项） | `SessionLauncher` 相邻分区 |
| 运行态 | **当前会话岛** | 运行态 `.timer-immersive-region` 网格内新增一格 |
| 结束态 | 本会话岛 + 该工作项已有岛的全览（本次落在全局中的位置） | 复盘区下方 |

**沉浸模式冲突（必须裁决的语义问题）**：现有沉浸模式把 `.timer-immersive-region` 内元素渐隐至 `opacity 0.2`（`globals.css:968-978`），这与"沉浸时仍能记录思路"冲突。暂定方案：新增**极简岛**态（只保留岛轮廓与当前会话节点高亮，隐藏文字标注），环与退出按钮照常常驻。**S3 实施前须复核此决策**。

### D12 · D5 复核结论（2026-09-30，S3 实施前复核完成）

**复核对象**：D5 暂定方案（极简岛）与沉浸渐隐的实现假设。

**发现 1（技术事实，必须改机制）**：沉浸渐隐现实现为
`[data-immersive='true'] .timer-immersive-region { opacity: .2; pointer-events: none }`
（`globals.css:971-978`；作用域容器由 `TimerFrame` 提供，`timer-frame.tsx:100-124`）。
**父级 opacity 是子树合成效果，子元素无法"逆渐隐"** —— 只要导图端口仍位于
`.timer-immersive-region` 子树内，"导图不随沉浸渐隐"在 CSS 层面不可实现；
且现规则连 `pointer-events` 一并关闭，"沉浸时仍能记录思路"更无从谈起。

**裁决 1（结构性方案）**：渐隐作用域从"整个右栏"下沉为**显式标记的伴奏卡**——
新增 `.timer-immersive-fade`，只打在 Workspace / Note / TodaySummary 等卡上；
导图端口卡**不加**该标记，天然常驻且可交互。`data-testid="immersive-region"`
与根 `data-immersive` 保持不动（既有断言的稳定面不变）；`TimerFrame` 头注
"被渐隐的是右栏"相应改为"被渐隐的是标记为 `.timer-immersive-fade` 的伴奏卡"。
视觉代价：沉浸下右栏呈"渐隐卡 + 常驻卡"混排——这是"沉浸中仍可记录"的必然代价。

**裁决 2（极简岛呈态，与 `CONTEXT.md` 定义对齐）**：
- **保留**：岛轮廓、当前会话节点高亮、节点形状/颜色点阵（类型双编码）、
  以及**「快速记录」类型按钮行**——它是动作入口，按钮文字属动作标签而非"文字标注"
  （若不保留，D5 冲突里"沉浸时仍能记录思路"无解法）
- **隐藏**：节点文字标注、非本次会话的历史岛（运行态本就只渲染当前岛）
- **切换方式**：纯 CSS 派生（同一 DOM、同一容器尺寸）→ 零布局抖动；
  极简态下快速记录直接落节点，输入控件为浮层，不撑开容器

**裁决 3（端口位置，对齐演示稿决策节点）**：准备态 = 启动器相邻分区（目标 L3 主图）；
运行态 = 右栏伴奏列新增一格（演示稿节点原文"端口位置：运行态网格"）；
结束态 = 复盘区下方。

**发现 2（渲染接入通道未验证 —— S3 工作包 0 必须先定）**：D10 的"接 react
渲染器"在工程上尚无接入通道 —— 实测 `frontend/package.json` 无 `@mindcanvas/*`
依赖、前端无 vendor 目录；且 `@mindcanvas/react` 带 `workspace:*` 依赖，
不能 `file:` 安装（D11 已因同一原因自持 centers 精简实现）。候选通道：
① MindCanvas 侧产出可安装 tarball；② vendor 整包；③ 端口按演示稿形态先自持
DOM/SVG 行式渲染，kernel 渲染器推迟到主图布局成为真实瓶颈时。
**该选型留给 S3 计划评审**，①/② 任一入选须先做最小 spike 取证。

**S3 验收（承接《规划 v2修正》S3 行，强化为可测断言）**：
1. 沉浸下岛可辨识（极简态渲染，且可完成一次快速记录）
2. **无布局抖动**：沉浸切换前后端口容器尺寸不变（测试钉住）
3. timer 页测试更新：渐隐作用域断言（哪些卡被标记）+ 极简态快速记录可用

---

### D13 · S3 接入最小集与递增路径（2026-09-30 spike 实测）

**背景**：D12 发现 2 曾把"渲染接入通道选型"列为 S3 工作包 0 决策门。复核修正：
D10 的集成特化是**按功能模块接入**——运输量随模块走；S3 端口所需的最小集
**不含 react 渲染器**，故该决策门在 S3 不成立。

**spike 实测（2026-09-30，全绿）**：
- 出包：MindCanvas 侧 `pnpm -F @mindcanvas/kernel build && pnpm pack`
  → `frontend/vendor/mindcanvas-kernel-1.12.0.tgz`（238 KB，`files:["dist"]`）
- 安装：`npm i ./vendor/…tgz` → lockfile 记 `file:` + integrity；kernel **零传递依赖**，
  无 `workspace:*` 问题（D11 曾因同类问题自持 centers 精简实现）
- 跑通：对本项目**真实产出的岛文件**（`maps/ca5a2d6c….mm.md`）与 S0 手写样本：
  `parseMm`（0 诊断）→ `astToEditable` → **自持 centers 读数** → `projectIslands`
  正确切出**根岛 + 会话岛**（含边界边与 `ownerByNodeId`），会话岛 `session_id` 完整保留
- 产物：`frontend/src/lib/work-map/island-view.ts`（最小数据层）+ 11 例协议行为断言

**最小集（S3 步 1–3）**：kernel 的 `protocol/parser` + `tree/treeOps`（`astToEditable`）
+ `layout/islands`（`projectIslands`，内部拉入 `layout/forest`）——单包、零运行时依赖；
centers 读数（cid 优先 / 路径锚三态 / 坐标成对强转）由本项目**自持**（D11 纪律延续，
不引入 react 包的 `collectCenters`）。**react 渲染器不在 S3 关键路径。**

**递增路径（每步可验收）**：

| 步 | 内容 | 依赖 |
|---|---|---|
| 1 | 运行态当前岛（岛轮廓 + 节点行 + 类型标记 + D12 极简岛） | 最小集（已就位） |
| 2 | 快速记录（写侧 `mm-note.ts` 已有；读侧回读验证） | 步 1 |
| 3 | 准备态主图 / 结束态全览（多岛排布；行式不够时再引 kernel `layout`） | 步 1 |
| 4 | 可交互导图（拖拽/缩放/富文本编辑）→ **此时才评估 react 渲染器**（tarball/bundle 通道，届时 spike） | 真实需求触发 |

**spike 发现的三处互操作边界（已钉在 `island-view.test.ts`）**：
1. **坐标是字符串**：kernel 的 note 解析保留标量原样（`x: 900` → `"900"`）→
   读数必须数值强转，否则坐标静默丢失
2. **单键条目不兼容**：只有单个 `k: v` 行的 centers 条目被解析成**标量字符串**
   而非记录（本项目写出侧恒多键故不受影响；兼容外部文档前需与 MindCanvas 侧对齐口径）
3. **`next_cid` 两种约定并存**：S0 样本写 `c2`（带前缀），本项目写出侧写 `2`——
   cid 分配算法在步 3（多岛写回）前必须对齐，否则可能重复分配

**运输与维护**：tgz 入库（`frontend/vendor/`）以保 `npm ci` 可复现；kernel 升级 =
重新 pack + `npm i`（版本号与文件名同步）。若日后嫌二进制入库，可换私有 registry
或 repack 脚本，均不改本决策的模块边界。

---

### D14 · 思考类型的落盘键名与写入形状（2026-09-30，D13 步 2 前置裁决）

**裁决**：思考类型落盘为**未知笔记键** `thought_type`，值域 = D9 五类 ASCII id
（`insight` / `problem` / `decision` / `review` / `todo`）；写入形状 = 会话节点子标题
+ 其**前导**笔记块。

**依据（改动前先读）**：
- `.mm.md` 协议 §5.2：「**未知字段一律透传**（`Note` 有 `[key: string]: unknown`）」
  —— 零协议改动、旧客户端忽略即降级
- 同款先例：`note.ai_role`（MindCanvas `2026-08-27-mindmap-forgejo-sync-design.md:267`
  「AI 建议（未采纳）→ `note` 未知键 …… 协议规定未知 note 键透传不报错」）
- 反向先例（**不采用**）：新增 `EditableNode.type` 会撞上"未知 type 降级纪律未定义"
  （`2026-09-14-node-card-flip-markdown-design.md:62` 的判据）—— 属协议面改动，须先立 ADR

**键名取舍**：不用 `thought`（易被读成"思考正文"而歧义）、不用 `type`（与节点三分结构
`type: text|image|entity` 撞名）；`thought_type` 对齐既有未知键命名风格（`<域>_<角色>`）。

**写入形状（协议可观察行为，测试钉住）**：
```markdown
<!--
thought_type: "problem"
-->
### token 对照：灰阶 vs 玻璃主题
```
- 笔记块**归属其后的节点**（协议：空行插在块之前，插在之后会拆开两者）
- 层级 = 会话节点层级 + 1；插入点 = **会话子树末尾**（保持会话内时序，追加语义）
- 其余正文**逐字节保留**（只做一处字符串拼接）
- fail-closed：类型非法 / 空标题 / 缺 sessionId → 拒绝；fail-soft：找不到会话节点 → 原样返回

**读侧**：`island-view` 把类型带出为 `WorkMapNode.thoughtType`（非法值 → `null`）；
**形状与颜色映射只在渲染层**（不落盘）→ 改形状不需要动任何文件。

**渲染（D9 双编码强制）**：洞察=实心圆/青 · 问题=三角/珊瑚 · 决策=菱形/紫 ·
复盘=空心圆/绿 · 待办=空心方/琥珀；节点行 = 形状 + 中文尾标。
节点类型**图例**与**跨岛按类型筛选**留 D13 步 3。

**已知边界**：读-改-写不做并发合并（D6 单机前提；跨设备议题另立）；若该键未来升级为
协议登记字段，按 D11 纪律「以协议为准 + 补对照测试」。

---

### D15 · 导图界面分工与树形渲染（2026-10-01，用户视觉评审后修订 D12 裁决 2/3 的适用面）

**背景**：D12 把运行态导图放在右栏（304px 列）并以"行式"呈现；D13 把树形排到步 3。
用户视觉评审（2026-10-01）指出：焦点区环下方是一大块空白，而 304px 塞不下可读的树。

**裁决（用户明确确认三项）**：
1. **职责拆分**：中央焦点区（环下大块）= **导图编辑区**（看全 + 记录）；右栏 = **小视图**
   （缩略 + 定位）。两者渲染**同一份几何**（`WorkMapTree` 单一渲染器 + 自适应 `viewBox`，
   "小视图 vs 大编辑区"只是容器宽度，没有第二套代码）。
2. **极简岛重定位**：原"右栏端口在沉浸下的呈现态" → 现在 = **小视图在沉浸时的呈现**
   （保留轮廓/点阵/当前高亮、隐文字）；"记录入口"职责移交中央编辑区。
3. **沉浸语义**：沉浸只渐隐右栏伴奏，**中央编辑区保留**（记录面常驻）。
   D12 裁决 1（渐隐作用域下沉到卡）保持不变并继续生效。

**树形渲染（D13 步 3-1，本次交付）**：横向树（数据语义 `dir: right` 落到几何）。
- 几何：kernel `layoutIslands(projection, measure, ∅)` → `nodes[]`（盒）+ `links[]`（**SVG
  path 字符串**，可直接画）——度量**自持**（全角/半角估算 + 夹紧 [76,240]；不引 react 的
  canvas 精确度量，理由同 D13 最小集）
- 渲染：`WorkMapTree`（SVG：盒 + `<path>` + 类型形状/颜色 D9）+ `fitTextToBox`（与度量
  同一把尺子截断，SVG 无 ellipsis）

**实现落点**：`island-layout.ts`（几何层）· `work-map-tree.tsx`（共用渲染器）·
`timer-map-editor.tsx`（中央编辑区，快速记录自端口迁移至此）· `timer-map-port.tsx`
（小视图）· `globals.css`（`.wm-*`；旧行式样式 `.ios-map-island/row/node-text/tail` 删除）。

**顺带修复（跨日实测发现）**：`TimerSideToday.formatRecentTime` 原先自取 `new Date()`，
"今日/日期"分支绕过组件注入的 `now` → 注入语义不完整、单测跨日必红；改为由调用方传入
同一把 `todayKey`（生产调用方恒传真实 now，行为不变）。

**验证**：真机截图 `s3-tree-center.png`（中央树 + 右栏小视图）/ `s3-tree-minimal.png`
（沉浸：中央保留 + 右栏极简）；断言见 `island-layout.test.ts` / `timer-map-editor.test.tsx` /
`timer-map-port.test.tsx` / `page.test.tsx`。

---

### D16 · 节点身份与编辑写入纪律（2026-10-01，D13 步 3-2 前置裁决）

**背景**：中央编辑区要对**当前会话岛**的节点做五个最小编辑（改名 / 加子 / 删除 / 类型切换 /
注释）。前置问题是「怎样**稳定指认**一个节点」——写回后文本变化会重建整棵树。

**D16-a · 节点身份与定位**
- kernel 的 `EditableNode.id` 是**运行时标识**：`astToEditable` 每次解析 `newId()` 重新分配，
  `editableToAst` 剥离（`packages/kernel/src/tree/treeOps.ts` 头注原文「id 不进入序列化」）。
  页面每次写回后 `mapText` 变化 → 重新 parse → **所有节点 id 全变**。故它只能作 React 复用键，
  **绝不能**当跨渲染的持久编辑键。
- **稳定编辑键 = 节点笔记块里的 `cid`**（协议 §6.3 既有机制，与根块 `next_cid` 联动）。
  定位通式：找到含 `cid: "<目标>"` 的笔记块 → 其标题 = 块后**第一个 heading 行**
  （协议：笔记块**归属其后的节点**）。
- **新节点一律带 cid**：`appendThoughtNode`（快速记录）与加子都从根块 `next_cid` 分配并写回；
  与建岛**共用同一计数器**（否则下一次建岛会与已分配 cid 撞车）。
- **只读边界**：存量无 cid 节点（D14 期 thought 节点、建岛写的 L3 标题行）、会话节点（岛根）、
  根岛、其它会话岛 → **一律只读**（渐进增强；防跨会话编辑冲突）。centers 条目的 cid 属岛根，
  删普通节点不碰它。

**D16-b · 写入纪律（延续 D11/D14）**
- 全部操作为**文本级字符串变换**：除目标节点的块/标题行（加子另含根块 `next_cid` 那一行）外，
  其余正文**逐字节保留**。
- **禁止** `parse → treeOps 编辑 → serializeMm 整文写回`（D11 已否：会把用户手写排版规范化成
  全量 diff）。kernel `treeOps`（`updateNode/removeNode/addChild`）只作**行为参照**，不进编辑路径。
- 返回形状沿用 `{ text, changed, reason? }`；fail-closed（非法输入拒绝）与 fail-soft
  （结构找不到原样返回）分工同 `thought-nodes.ts` 头注。
- **子树边界必须包含边界节点的笔记块**：块的物理位置落在**前一个节点**的行范围内
  （`…### 前\n\n<!--块-->\n### 后`）。若边界按 heading 行算，会连后一节点的块一起删/覆盖 →
  静默丢 cid（`node-edits.ts` 的 `unitStart` 即为此）。

**实现落点**：`node-edits.ts`（五原语）· `thought-nodes.ts`（薄委托，语义不变）·
`island-layout.ts`（`MapTreeNode` + `cid`/`comment`）· `timer-map-editor.tsx` / `work-map-tree.tsx`
（选中 + 操作行 + 浮层 + 删除二次确认）· `page.tsx`（`editMap` 接线）· `globals.css`（`.wm-*`）。

**验证**：断言锚在写入形状 / 字节保真 / cid 分配 / fail 语义（`node-edits.test.ts`）与
交互闭环（`timer-map-editor.test.tsx` / `page.test.tsx`）；真机五操作演练见交付报告。

---

### D17 · 结束态岛总览与跨岛筛选的交互裁决（2026-10-01，D13 步 3-4b）

- **落点**：结束态焦点区 `SessionReview` **下方**（D12 裁决 3 原文"结束态 = 复盘区下方"）；
  **只读**（复盘不改图）—— 不传 `onEdit`/`onQuickRecord`（D16 编辑入口仅运行态有）。
- **筛选交互**：**单选**（一类或"全部"）。**dim 不 hide** —— 隐藏节点会拆断树结构，
  违反"导图是树"的身份；dim 只调视觉权重、保留结构。连线随两端：**两端都 dim 才 dim**，
  一端亮则线亮，树不被打散。
- **全览渲染全部 `islands`（不滤当前会话）**：与运行态编辑区/小视图"只渲染当前会话岛"
  不同 —— 结束态要回答"这次会话在图里的位置"；当前会话岛用"本次"高亮（复用 `wm-box--session`）。
- **类型图例（`work-map-legend`）可复用**：形状几何复用 `work-map-tree` 导出的 `TypeShape`、
  配色复用同一批 `.wm-shape--*`（D9 双编码"形状同源"，不另抄一份）；后续**准备态主图**共用。

**实现落点**：`timer-map-overview.tsx`（全览 + 筛选状态）· `work-map-legend.tsx`（图例，可复用）·
`work-map-tree.tsx`（`highlightType` prop）· `page.tsx`（`endedMapText` + 结束态接线）· `globals.css`。

---

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
| 1 | ~~极简岛的视觉与交互细节（D5）~~ → **已复核（D12）**；~~渲染接入通道选型~~ → **S3 最小集已 spike 定盘（D13）：kernel 单包 + 特化渲染；react 渲染器推迟到步 4** | ✅ 2026-09-30 关闭（步 4 触发时重开评估） |
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
| 沉浸模式渐隐实现（2026-09-30 复核更新） | 作用域容器：`frontend/src/components/timer/timer-frame.tsx:100-124`（`data-immersive` 在根、`.timer-immersive-region` 在右栏）；渐隐规则：`globals.css:971-978`（子树级 `opacity .2` + `pointer-events: none`）→ D12 据此改机制 |
| ~~渲染接入通道未验证（D12 发现 2）~~ → 已 spike 定盘（D13） | 实测 2026-09-30：`pnpm pack` kernel → `frontend/vendor/mindcanvas-kernel-1.12.0.tgz`（238 KB）→ `npm i` 成功；`parseMm`/`astToEditable`/`projectIslands` 对真实岛文件与 S0 样本 0 诊断、2 岛切分正确；断言见 `frontend/src/lib/work-map/island-view.test.ts`（11 例） |
| 三处互操作边界（D13 发现，已钉测试） | `island-view.test.ts`：「坐标字符串强转」「单键条目标量化」「`next_cid` 两种约定并存」（S0 `c2` vs 本项目 `2`） |
| 未知笔记键透传（D14 依据） | 协议 §5.2（`Note` 有 `[key: string]: unknown`，"未知字段一律透传"）；先例 `note.ai_role`（MindCanvas forgejo-sync 设计 §5.3）；反向判据「不新增 node type」：node-card-flip 设计 §3 D1 |
| 快速记录写入形状（D14，已钉测试） | `frontend/src/lib/work-map/thought-nodes.test.ts`（写作形状 / 时序 / fail 语义 / 写读闭环）；真机验收：`s3-quick-record-demo.mjs` + 截图 `s3-quick-normal.png` + `s3-quick-minimal.png` |
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