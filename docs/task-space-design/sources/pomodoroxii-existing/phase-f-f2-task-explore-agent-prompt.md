# PomodoroXII · F2 任务页深度探索 · Agent Prompt

> **用法**：从 `---BEGIN F2-TASK-EXPLORE---` 到 `---END F2-TASK-EXPLORE---` 整段复制给 Codex / GPT。  
> **双仓库上下文**：必须同时可读 **PomodoroXII（目标）** + **Pomodoroxi Vue（参照）**。  
> **性质**：只探索、只写计划文档；不写代码、不改测试、不 commit、不开 PR。

---

---BEGIN F2-TASK-EXPLORE---

# PomodoroXII F2：任务页 / 任务空间深度探索

## 0. 双项目概况（探索 Agent 必须先建立的心智模型）

### 0.1 两个仓库的关系

```text
Pomodoroxi (Vue)          →  行为/交互/能力参照（「原来有什么」）
PomodoroXII (React)       →  架构权威 + 实施目标（「现在要怎么做」）
```

| 项 | PomodoroXII（新） | Pomodoroxi（原 Vue） |
|----|-------------------|----------------------|
| **GitHub** | https://github.com/zc63463-cmyk/PomodoroXII | （本地参照，无强制 remote） |
| **本地路径** | `E:\Development\MyAwesomeApp\PomodoroXII` | `E:\Development\MyAwesomeApp\pomodoroxi\frontend\` |
| **前端栈** | Next.js 15 + React 19 + Zustand + Dexie v16 | Vue 3 + Pinia + Dexie 单例 |
| **认证** | 双 JWT（master + space） | 单 token |
| **Dexie** | per-space `pomodoroxi_${spaceId}` + Proxy | 单库 `pomodoroxi` |
| **Sync** | S1 已完成 RealSyncEngine + outbox | Vue composable `useSync` + 旧 outbox |
| **任务页** | `/tasks` = Placeholder | `TaskView.vue` 三视图完整实现 |

### 0.2 PomodoroXII 当前阶段（不要重复做）

| 阶段 | 状态 | 证据 |
|------|------|------|
| S0 平台壳 | ✅ | 路由、Space 切换、17 store 骨架 |
| S1 Sync Client | ✅ | `lib/sync/*`，225 tests，已 merge `main` PR #22 |
| tag `s1-sync-foundation` | ✅ | 里程碑已打 |
| **F2 任务页** | ⏳ | `tasks/page.tsx` → `PlaceholderPage` |
| F3 笔记详情 | 未开始 | `/notes/[id]` 未建 |

### 0.3 Pomodoroxi 任务域资产清单（探索必须盘点）

Vue 任务页已知结构（`TaskView.vue` 头部注释）：

```text
TaskView.vue                    # 三视图容器：List / Kanban / Calendar
├── TaskListPanel.vue
├── TaskKanbanPanel.vue
├── TaskCalendarPanel.vue
├── TaskDetailModal.vue         # plan / completion / sessions 三 tab
├── TaskFormModal.vue
├── TaskExportModal.vue
├── TaskDeleteConfirm.vue
stores/task.ts                  # CRUD + filter/sort/stats + sync recordChange
stores/taskTag.ts               # → React 已合并入 task-store（F0 裁定）
stores/taskRelation.ts          # → React 已合并入 task-store（F0 裁定）
components/task/__tests__/      # tags、relations、dedup 等行为测试
stores/__tests__/task-*.spec.ts
```

**探索必须输出**：Vue 能力 → React「保留 / 延后 / 不迁移 / 重构」矩阵。

### 0.4 纸面设计库（可选）

`E:\Development\MyAwesomeApp\交互审计库-dev\PomodoroXII\前端纸上设计开发\`

---

## 1. 任务性质（硬边界）

你是 PomodoroXII **F2 任务页深度探索 Agent**。

| 允许 | 禁止 |
|------|------|
| 阅读双仓库源码 + F0/F1 + `frontend-requirements-delta.md` | 修改任一仓库源码 |
| 运行只读命令（grep、读 test 输出、读 openapi） | 实现 UI / store / 测试 |
| 对照 Vue spec 提炼「必须保留的行为」 | git commit、开 PR |
| 提出任务空间新设计方案（纸面） | 推翻 F0/F1 锁定契约 |
| 产出实施计划供下一 Agent 派发 | 把 tag/taskTag/taskRelation 做成独立 sync 实体 |

**主交付物**（必须）：

```text
PomodoroXII/.trae/documents/f2-task-space-exploration-plan.md
```

**可选交付物**：

```text
交互审计库-dev/PomodoroXII/前端纸上设计开发/F2-任务页-探索.md
```

---

## 2. 必读清单（按顺序 Read）

### 2.1 PomodoroXII — 架构权威（P0）

| 文件 | 章节/用途 |
|------|-----------|
| `README.md` | 项目总览 |
| `frontend/README.md` | S0/S1 进度、Sync 架构、技术债 |
| `.trae/documents/f0-platform-shell-exploration.md` | §4 `/tasks` 路由、§7.3.6 task-store、§3.2 Dexie、§10 Vue 差分 |
| `.trae/documents/f1-sync-client-exploration.md` | §3.3 `task` sync 映射、§8 F2 接线、§3.3b tag 非 sync |
| `docs/frontend-requirements-delta.md` | Vue→React 全表差分 |

### 2.2 PomodoroXII — 任务域现状（P0）

| 文件 | 用途 |
|------|------|
| `frontend/src/app/(app)/tasks/page.tsx` | Placeholder 起点 |
| `frontend/src/stores/task-store.ts` | stub API 面（将实现目标） |
| `frontend/src/types/index.ts` | `Task` / `TaskFilter` / `TaskStats` / `TaskStatus` |
| `frontend/src/services/database.ts` | `tasks` 表 schema、`CachedTask` |
| `frontend/src/lib/sync/outbox.ts` | `enqueueOutbox` |
| `frontend/src/lib/sync/index.ts` | `syncEngine.markDirty` |
| `backend/app/schemas/task.py` | 后端字段权威 |
| `backend/app/routes/v1/tasks.py` | REST 端点 |

### 2.3 Pomodoroxi Vue — 行为参照（P0，必须读）

| 文件 | 用途 |
|------|------|
| `pomodoroxi/frontend/src/views/TaskView.vue` | 三视图 + 筛选/排序/快捷键/弹窗编排 |
| `pomodoroxi/frontend/src/stores/task.ts` | Vue CRUD、filter、stats、sync 集成方式 |
| `pomodoroxi/frontend/src/components/task/TaskListPanel.vue` | 列表交互 |
| `pomodoroxi/frontend/src/components/task/TaskKanbanPanel.vue` | 看板拖拽（若有） |
| `pomodoroxi/frontend/src/components/task/TaskCalendarPanel.vue` | 日历视图 |
| `pomodoroxi/frontend/src/components/task/TaskDetailModal.vue` | 详情三 tab |
| `pomodoroxi/frontend/src/components/task/TaskFormModal.vue` | 创建/编辑表单 |
| `pomodoroxi/frontend/src/stores/taskTag.ts` | tag 模型（对照 F0 合并决策） |
| `pomodoroxi/frontend/src/stores/taskRelation.ts` | 关系模型 |
| `pomodoroxi/frontend/src/components/task/__tests__/` | 行为契约证据 |
| `pomodoroxi/frontend/src/stores/__tests__/task-*.spec.ts` | store 行为契约 |

### 2.4 关联域（P1）

| 文件 | 用途 |
|------|------|
| `PomodoroXII/frontend/src/stores/timer-store.ts` | 番茄钟选任务联动 |
| `PomodoroXII/frontend/src/components/layout/nav-config.ts` | 导航入口 |
| `PomodoroXII/frontend/src/stores/trash-store.ts` | 删除/恢复策略 |
| `pomodoroxi/frontend/src/components/timer/TaskSelector.vue` | Vue 计时器选任务 |

---

## 3. 探索前已知基线（勿假设已实现）

### 3.1 PomodoroXII React 现状

```text
/tasks/page.tsx     → PlaceholderPage("任务", sprint="F2")
task-store.ts       → 全部 actions 为 S0 stub（no-op）
Dexie tasks 表      → v16 schema 已有（_dirty, content_hash, deletion_state）
Sync                → task ∈ 14 sync-enabled 实体
tag 系              → 合并入 task-store；F1：不参与 push/pull
```

### 3.2 F1-D12 接线模式（探索方案必须对齐，实现时硬约束）

```typescript
// 事务内：实体 + outbox
await db.transaction('rw', db.tasks, db.outbox, async () => {
  await db.tasks.put(task)
  await enqueueOutbox(db, 'task', task.id, op, task)
})
// 事务外：触发 debounce sync
syncEngine.markDirty('task', task.id, op)
```

### 3.3 Vue sync 集成方式（对照用，不可照搬）

Vue `task.ts` 使用 `useSync().recordChange` + 旧单例 `db` outbox。  
React 必须改为 **per-space db + enqueueOutbox + markDirty**（F1 §8）。

---

## 4. 探索核心问题（§0 Executive Summary 必须回答）

1. **任务空间定位**：在「任务空间新设计」背景下，首版是复刻 Vue 三视图，还是先做列表 MVP？
2. **Vue→React 能力矩阵**：哪些必须保留、哪些延后、哪些因架构变化不迁移？
3. **F2-Task-1 MVP**：≤2 周可交付的最小切片（文件级、测试级）？
4. **数据模型**：`Task` 字段首版子集？`tags` vs `tag_refs`？删除走 `deletion_state` 还是 trash-store？
5. **Store 架构**：Zustand 存什么 vs Dexie 读什么？是否 `useLiveQuery`？
6. **Sync 时机**：MVP 是否首版即接 outbox+sync，还是先本地闭环？
7. **与 timer/dashboard 边界**：首版要不要联动选任务开番茄？

---

## 5. 探索维度（必须全覆盖）

### 5.1 Vue 能力盘点表（必须产出）

对 Vue 任务域每项能力填表：

| 能力 | Vue 证据（file:line 或组件名） | React 建议 | 理由 | 阶段 |
|------|-------------------------------|------------|------|------|
| 三视图切换 | TaskView viewMode | 保留/延后/砍 | … | F2-1 / F2-2 |
| 搜索筛选排序 | TaskView watch → setFilter | … | … | … |
| 看板拖拽 | TaskKanbanPanel | … | … | … |
| 日历视图 | TaskCalendarPanel | … | … | … |
| 详情三 tab | TaskDetailModal | … | … | … |
| 导出 | TaskExportModal | … | … | … |
| Tags | taskTag store + specs | … | … | … |
| Relations | taskRelation + specs | … | … | … |
| … | … | … | … | … |

### 5.2 UI 架构方案对比（至少 3 种）

| 方案 | 描述 | 对齐 Vue | 实现成本 | 适合「新任务空间」迭代 |
|------|------|--------|----------|------------------------|
| A | 列表 + 侧栏/抽屉编辑 | 部分 | 低 | 高 |
| B | 复刻三视图 Tab（list/kanban/calendar） | 高 | 高 | 中 |
| C | 列表 MVP + 后续独立「任务空间」壳 | 低 | 最低 | 最高 |

**输出**：推荐方案 + 分阶段路线图（F2-1 / F2-2 / F2-3）。

### 5.3 信息架构与路由

- `/tasks` 单页 vs `/tasks/[id]`
- 移动端底栏已有 tasks（F0）— 响应式约束
- 与 `/timer`、`/dashboard` 跳转关系

### 5.4 Store + Dexie + Sync 设计

- `loadTasks` / `createTask` / `updateTask` / `deleteTask` 伪代码（对齐 F1-D12）
- `CachedTask` 与 `Task` 转换（strip SyncFields）
- 删除：tombstone vs trash-store（对照 Vue `TaskDeleteConfirm`）
- 空间切换后：STORE_RESET + 从 Dexie 重载（不走 REST hydrate？）

### 5.5 字段对齐表（必须）

| 字段 | frontend Task | CachedTask | backend TaskResponse | Vue task.ts | MVP 需要 |
|------|---------------|------------|----------------------|-------------|----------|

### 5.6 测试与 Smoke（纸面）

- store 单测 ≥6（CRUD + outbox + filter）
- 组件测 ≥3（空态、创建、列表渲染）
- Smoke ≥4（含 sync 一条）

---

## 6. 种子问题清单（TSK-1～TSK-15，逐条验证）

对每条给出：**证实 / 驳回 / 降级** + `path:line` + 建议 + 归属阶段。

| ID | 严重度 | 假设/问题 |
|----|--------|-----------|
| TSK-1 | P0 | `CachedTask` 是否含完整 `SyncFields`？ |
| TSK-2 | P0 | React `task-store` stub API 是否覆盖 Vue `task.ts` 核心方法？差分？ |
| TSK-3 | P0 | 后端 `TaskResponse` 与前端 `Task` 字段差分？ |
| TSK-4 | P1 | F2-1 是否应「本地闭环优先」再接 sync？ |
| TSK-5 | P1 | tag 首版是否仅本地（符合 F1 §3.3b 非 sync）？ |
| TSK-6 | P1 | Vue 看板是否依赖 drag-drop 库？React 复刻成本？ |
| TSK-7 | P1 | Vue `detailTab: plan/completion/sessions` 首版是否保留？ |
| TSK-8 | P1 | timer `TaskSelector` 是否阻塞 task-store 先实现 loadTasks？ |
| TSK-9 | P2 | trash-store 与 task `deletion_state` 如何分工？ |
| TSK-10 | P2 | 是否需要 `GET /api/v1/tasks` 作 space 切换后 hydrate？ |
| TSK-11 | P2 | Vue export 功能是否延后到 F2-3？ |
| TSK-12 | P2 | `useLiveQuery` vs store 手动 load — T29 已 PASS，推荐哪条？ |
| TSK-13 | P2 | 任务空间「新设计」是否需要项目/分组实体 — 首版是否只留扩展点？ |
| TSK-14 | P3 | Vue 键盘快捷键是否迁移到 `use-keyboard-shortcuts`？ |
| TSK-15 | P3 | Vue 165 spec 中 task 相关有多少？迁移优先级？ |

---

## 7. 交付文档结构（f2-task-space-exploration-plan.md）

```markdown
# F2 任务页 / 任务空间深度探索计划

## §0 Executive Summary
- Verdict：可启动 F2-Task-1？（是 / 条件通过 / 否）
- 推荐路线：A/B/C + 分阶段 F2-1/2/3
- Vue→React 能力矩阵摘要（保留 N / 延后 M / 不迁移 K）
- F2-Task-1 MVP（≤10 bullets）
- 估算：文件数、测试数、是否挡 sync

## §1 双项目现状审计（证据表）
## §2 种子问题验证（TSK-1～TSK-15）
## §3 Vue 能力盘点与迁移矩阵
## §4 信息架构与路由方案
## §5 Store + Dexie + Sync 接线设计（含伪代码）
## §6 字段对齐表（Task / CachedTask / Backend / Vue）
## §7 UI 方案对比与推荐
## §8 F2-Task-1 实施切片（PR 顺序 + 文件级）
## §9 测试矩阵（≥8）+ Smoke（≥4）
## §10 风险与开放问题（需产品决策 ≤5）
## §11 后继派发建议（F2-Task-1 Agent Prompt 要点）
```

---

## 8. 硬约束（探索结论不得违反）

- F0 §6.3 空间切换硬顺序；F1-D15 bootstrap 时机
- F1-D12：`enqueueOutbox` 事务内、`markDirty` 事务外
- `tag` / `taskTag` / `taskRelation` **不是** sync 实体（F1 §3.3b）
- API 前缀 `/api/v1`（非 Vue `/api`）
- per-space Dexie（非 Vue 单例）
- 不修改 backend 契约（除非 §10 明确「需后端 PR」）
- D8 空间密码 UI 不在范围

---

## 9. 工作流程（Agent 必须遵守）

```text
Step 1  读 PomodoroXII P0 文档 + 任务域代码（建立权威约束）
Step 2  读 Pomodoroxi Vue 任务域（建立能力清单）
Step 3  填 TSK-1～TSK-15 验证表
Step 4  产出 Vue→React 迁移矩阵
Step 5  对比 UI 方案 A/B/C，给出分阶段推荐
Step 6  写 F2-Task-1 实施切片（文件级，可直接派发）
Step 7  写 f2-task-space-exploration-plan.md
Step 8  回复 §9 完成格式
```

**禁止**未读 Vue `TaskView.vue` + `task.ts` 就给出 UI 方案。

---

## 10. 完成后回复格式

1. 交付文档路径  
2. Executive Summary（8～10 句）  
3. Vue→React 迁移矩阵摘要（保留/延后/不迁移 各几条）  
4. 推荐 F2-Task-1 MVP 文件清单（≤20 文件）  
5. 开放问题（需你决策 ≤5 条）  
6. **明确建议**：先列表 MVP 还是复刻三视图 — 以及为何适合「任务空间新设计」后续迭代

---END F2-TASK-EXPLORE---
