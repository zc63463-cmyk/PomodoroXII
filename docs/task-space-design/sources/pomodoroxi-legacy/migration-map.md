# PomodoroX → PomodoroXI 迁移映射

> 版本: 1.0 | 日期: 2026-06-06

## 业务逻辑迁移对照表

### Composables (前端核心逻辑)

| # | PomodoroX 源文件 | PomodoroXI 目标文件 | 迁移方式 | 改动要点 |
|---|-----------------|-------------------|---------|---------|
| 1 | `src/composables/useTimer.ts` | `src/composables/useTimer.ts` | 适配迁移 | 去掉 Tauri 通知，改用 Web Notification API |
| 2 | `src/composables/useTask.ts` | `src/composables/useTasks.ts` | 重写 | 数据源从本地 DB 改为 API + IndexedDB 缓存 |
| 3 | `src/composables/useNotification.ts` | `src/composables/useNotification.ts` | 适配迁移 | 去掉 Tauri plugin，改用 Web API |
| 4 | `src/composables/useWebDavSync.ts` | `src/composables/useSync.ts` + `src/services/sync-engine.ts` | 重写 | WebDAV 双阶段 → REST API 增量同步 |
| 5 | — (无) | `src/composables/useSessions.ts` | 新增 | 从 PomodoroX `stores/session.ts` 拆出，加分页 |
| 6 | — (无) | `src/composables/useReflections.ts` | 新增 | 从 PomodoroX `stores/reflection.ts` 拆出 |
| 7 | — (无) | `src/composables/useStats.ts` | 新增 | 统计计算从 API 聚合 |

### Stores (Pinia)

| # | PomodoroX 源文件 | PomodoroXI 目标文件 | 迁移方式 | 改动要点 |
|---|-----------------|-------------------|---------|---------|
| 1 | `src/stores/task.ts` | `src/stores/task.ts` | 适配迁移 | `getAllTasks()` → API 分页 + IndexedDB 缓存 |
| 2 | `src/stores/session.ts` | `src/stores/session.ts` | 适配迁移 | 加分页参数，归档加载 |
| 3 | `src/stores/reflection.ts` | `src/stores/reflection.ts` | 适配迁移 | 改用 API |
| 4 | `src/stores/sync.ts` | `src/stores/sync.ts` | 重写 | WebDAV 状态 → API 同步状态 |
| 5 | — (无) | `src/stores/timer.ts` | 新增 | 从 PomodoroX useTimer 中拆出状态 |
| 6 | — (无) | `src/stores/settings.ts` | 新增 | 统一设置管理 |

### Services (数据服务层)

| # | PomodoroX 源文件 | PomodoroXI 目标文件 | 迁移方式 | 改动要点 |
|---|-----------------|-------------------|---------|---------|
| 1 | `src/services/database.ts` (双引擎) | `src/services/database.ts` (Dexie.js) | 重写 | 去掉 Tauri SQLite + MemoryStore，统一 Dexie |
| 2 | `src/services/outbox.ts` | `src/services/database.ts` (outbox table) | 简化 | 内置到 Dexie schema |
| 3 | — (无) | `src/services/api.ts` | 新增 | axios HTTP 客户端 + JWT 拦截器 |
| 4 | — (无) | `src/services/sync-engine.ts` | 新增 | 增量同步引擎核心逻辑 |
| 5 | — (无) | `src/utils/storage.ts` | 新增 | 安全存储 (Web Crypto API 加密) |

### Components (UI 组件)

| # | PomodoroX 源文件 | PomodoroXI 目标文件 | 迁移方式 | 改动要点 |
|---|-----------------|-------------------|---------|---------|
| 1 | `src/components/timer/*` | `src/components/timer/*` | 适配迁移 | UI 保持，数据源改用 store |
| 2 | `src/components/task/TaskListPanel.vue` | `src/components/task/TaskListPanel.vue` | 重写 | v-for → @tanstack/vue-virtual 虚拟滚动 |
| 3 | `src/components/task/TaskCard.vue` | `src/components/task/TaskCard.vue` | 适配迁移 | props 类型调整 |
| 4 | `src/components/task/TaskForm.vue` | `src/components/task/TaskForm.vue` | 适配迁移 | 改用 API 提交 |
| 5 | `src/components/stats/*` | `src/components/stats/*` | 适配迁移 | 数据源改用 API |
| 6 | `src/components/reflection/*` | `src/components/reflection/*` | 适配迁移 | 改用 API |
| 7 | `src/components/layout/*` | `src/components/layout/*` | 适配迁移 | 简化，去掉 Tauri 特有逻辑 |
| 8 | — (无) | `src/components/common/*` | 新增 | 通用组件库 |
| 9 | — (无) | `src/components/session/SessionArchive.vue` | 新增 | 归档查看 |

### Views (页面视图)

| # | PomodoroX 源文件 | PomodoroXI 目标文件 | 迁移方式 |
|---|-----------------|-------------------|---------|
| 1 | `src/views/TimerView.vue` | `src/views/TimerView.vue` | 适配迁移 |
| 2 | `src/views/TaskView.vue` | `src/views/TaskView.vue` | 适配迁移 |
| 3 | `src/views/StatsView.vue` | `src/views/StatsView.vue` | 适配迁移 |
| 4 | `src/views/ReflectionView.vue` | `src/views/ReflectionView.vue` | 适配迁移 |
| 5 | `src/views/SettingsView.vue` | `src/views/SettingsView.vue` | 重写（无 WebDAV 配置，加同步设置） |
| 6 | — (无) | `src/views/LoginView.vue` | 新增 |

### 不再迁移的文件

| PomodoroX 文件 | 原因 |
|---------------|------|
| `src/services/database.ts` MemoryStore 部分 | 统一用 Dexie.js |
| `src/composables/useWebDavSync.ts` | 完全重写为 API 同步 |
| `src/services/outbox.ts` | 内置到 Dexie |
| `cloudflare-worker/` | 自托管不需要 CORS 代理 |
| `api/webdav-proxy.js` | 同上 |
| `src-tauri/` | 去掉桌面端 |
| `netlify.toml` / `vercel.json` | 自托管 Docker |
| `start-with-qr.cjs` | 局域网通过 Tunnel 域名访问 |

## 数据模型映射

### Task

| PomodoroX MemoryStore 字段 | PomodoroXI 服务端字段 | 变化 |
|---------------------------|---------------------|------|
| id | id | 不变 |
| title | title | 不变 |
| description | description | 不变 |
| status | status | 不变 (pending/in_progress/completed/archived) |
| priority | priority | 不变 |
| tags | tags | 不变 (JSON array) |
| plan | plan | 不变 |
| completion | completion | 不变 |
| dueDate | due_date | camelCase → snake_case |
| estimatedPomodoros | estimated_pomodoros | 同上 |
| completedPomodoros | completed_pomodoros | 同上 |
| createdAt | created_at | 同上 |
| updatedAt | updated_at | 同上 |
| — | _etag / _dirty | 新增 (前端 IndexedDB 缓存字段) |

### Session

| PomodoroX 字段 | PomodoroXI 字段 | 变化 |
|---------------|----------------|------|
| id | id | 不变 |
| taskId | task_id | camelCase → snake_case |
| type | type | 不变 |
| duration | duration | 不变 |
| plan | plan | 不变 |
| completion | completion | 不变 |
| startedAt | started_at | camelCase → snake_case |
| endedAt | ended_at | camelCase → snake_case |
| — | _etag / _dirty | 新增 |

### Reflection

| PomodoroX 字段 | PomodoroXI 字段 | 变化 |
|---------------|----------------|------|
| id | id | 不变 |
| date | date | 不变 (UNIQUE) |
| content | content | 不变 |
| mood | mood | 不变 |
| tags | tags | 不变 |
| createdAt | created_at | camelCase → snake_case |
| updatedAt | updated_at | camelCase → snake_case |

## 同步机制迁移对照

| 维度 | PomodoroX (WebDAV) | PomodoroXI (REST API) |
|------|-------------------|----------------------|
| 主存储 | 坚果云 WebDAV 文件 | 服务器 SQLite 数据库 |
| 本地存储 | SQLite (Tauri) / IndexedDB (Web) | Dexie.js IndexedDB |
| 同步方向 | 双向文件同步 (快照 + 事件流) | Client push → Server pull |
| 冲突解决 | 快照 LWW + 事件版本保护 | 服务器权威 + LWW (updated_at) |
| 首次同步 | 下载全量快照 | `/api/sync/full` 全量拉取 |
| 增量同步 | PROPFIND + 批量 GET 事件 | `GET /api/sync/pull?since=` |
| 推送变更 | PUT/MKCOL 事件文件 | `POST /api/sync/push` |
| 离线队列 | outbox_events 表 | Dexie outbox 表 |
| GC | 远程事件 30 天清理 | 服务器 session 归档 |
