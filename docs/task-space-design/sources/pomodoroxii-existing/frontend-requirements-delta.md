# 前端需求差分表（Vue → React）

> **S0 三大架构变更摘要：**
> 1. 单 Dexie → 多 Space per-space DB（`SpaceDBManager` 动态切换）
> 2. 单 token → 双 JWT（master token 认证 + space token 授权）
> 3. `/api` → `/api/v1` 前缀（`API_V1_PREFIX` 常量）

> 来源：`.trae/documents/f0-platform-shell-exploration.md` §10
> 版本：v0.2.2（2026-07-06）
> 用途：记录从 Vue 前端迁移到 React 前端的所有需求变更，供实施团队对照

## 差分规则表

| # | 能力 | Vue | React F0 | 变更类型 | 动契约? | Sprint |
|---|------|-----|---------|---------|--------|--------|
| 1 | API 前缀 | `/api` (`api.ts:10`) | `/api/v1` | 改 | 否 | S0 |
| 2 | Token 模式 | 单 token `pomodoroxi_token` (`api.ts:61`) | 双 JWT: master + space | 改 | 否 | S0 |
| 3 | Token 存储 | localStorage `pomodoroxi_token` (`api.ts:61`) | localStorage 3 keys (pxii_master_token, pxii_space_token, pxii_current_space_id) | 改 | 否 | S0 |
| 4 | 401 处理 | 清 token + 跳 login (`api.ts:77-84`) | master 401→login；space 401→re-issue（reissueMutex 单飞） | 改 | 否 | S0 |
| 5 | Dexie 库名 | 硬编码 `pomodoroxi` (`database.ts:102`) | `pomodoroxi_${spaceId}` | 改 | 否 | S0 |
| 6 | Dexie 实例 | 单例 `export const db = new PomodoroXIDB()` (`database.ts:177`) | `export const db = proxy`（SpaceDBManager 代理） | 改 | 否 | S0 |
| 7 | Outbox 函数 | 绑单例 db (`database.ts:233-298`) | ⛔ 不迁移，S1 重建（以 db 参数依赖注入） | 删 | 否 | S1 |
| 8 | `_etag` 字段 | Cached* 含 `_etag` | ⛔ 删除，用 `content_hash` | 改 | 否 | S0 |
| 9 | `deletion_state` | 不存在 | ✅ 新增（SyncFields） | 增 | 否 | S0 |
| 10 | 路由 `/memo` | 存在 (`router/index.ts:30`) | ⛔ 改为 `/quick-notes` | 改 | 否 | S0 |
| 11 | 路由 `/schedule` | 存在 (`router/index.ts:29`) | ⛔ 改为 `/schedules`（复数） | 改 | 否 | S0 |
| 12 | 路由 `/notes/trash` | 存在 (`router/index.ts:27`) | ⛔ 改为 `/trash`（独立路由） | 改 | 否 | S0 |
| 13 | 路由 `/notes/:id` | 存在 (`router/index.ts:28`) | F3b 实现 `/notes/[id]`（S0 不建占位） | 改 | 否 | F3b |
| 14 | 路由守卫 | `beforeEach` 检查单 token (`router/index.ts:57-67`) | layout client guard + (auth)/layout 三态守卫 | 改 | 否 | S0 |
| 15 | Store 数量 | 17 Pinia | 19 Zustand（17 新建 + 2 已有） | 改 | 否 | S0 |
| 16 | memo + quickNote | 两个独立 store (`memo.ts:75`, `quickNote.ts:31`) | 合并为 quick-note-store | 改 | 否 | S0 |
| 17 | countdown | 独立 store (`countdown.ts:30`) | 合并入 timer-store | 改 | 否 | S0 |
| 18 | tag + taskTag | 两个独立 store (`tag.ts:21`, `taskTag.ts:19`) | 合并入 task-store（内部子模块） | 改 | 否 | S0 |
| 19 | taskRelation | 独立 store (`taskRelation.ts:21`) | 合并入 task-store | 改 | 否 | S0 |
| 20 | memoComment | 独立 store (`memoComment.ts:23`) | 合并入 note-store | 改 | 否 | S0 |
| 21 | 全局搜索 | 组件内 (`AppLayout.vue:24`) | search-store（stub，Ctrl+K 占位） | 增 | 否 | S0 |
| 22 | 回收站 | `/notes/trash` 路由内 | 独立 trash-store + `/trash` 路由 | 增 | 否 | S0 |
| 23 | Sync 状态 | composable useSync | sync-store + use-sync hook | 改 | 否 | S0 |
| 24 | 主题 | CSS dark: 类 | next-themes | 改 | 否 | S0 |
| 25 | 快捷键 | useKeyboard composable (`AppLayout.vue:23-39`) | use-keyboard-shortcuts hook | 改 | 否 | S0 |
| 26 | Space 概念 | 不存在 | SpaceSwitcher + space-store + SpaceDBManager | 增 | 否 | S0 |
| 27 | Cloudflare 重试 | 有 (`api.ts:88-113`) | 迁移到双 Axios（metaApi + spaceApi 各自重试） | 改 | 否 | S0 |
| 28 | 侧栏 UI 状态 | app-store (`app.ts:15`) | ui-store（v0.2 C2 拆分，app-store 仅管 isOnline） | 改 | 否 | S0 |
| 29 | 多 Tab 空间同步 | 不存在 | BroadcastChannel + storage 事件（§3.7） | 增 | 否 | S0 |
| 30 | 空间密码 | 不存在 | §2.6 D8：has_password + S2P 状态机 + re-issue 弹窗 + 不缓存密码 | 增 | 否 | S0-D8 |
| 31 | useDexieDB() hook | 不存在 | §3.2.2：以 currentSpaceId 为 deps 获取真实 DB 引用（liveQuery fallback） | 增 | 否 | S0-2 |
| 32 | 每空间 UI 态 | app-store 持久 sidebar | ui-store 方案 A：切换时 reset sidebarCollapsed 等（R7-3） | 改 | 否 | S0 |
| 33 | settings 全局/空间分离 | 全在 settings 表 | theme/language 全局（不随空间 reset）；其余按空间从 Dexie 重载（R7-2） | 改 | 否 | S0 |
| 34 | Logout 全量 reset | 无 logout 流程 | destroy + 17 store reset + auth/space reset + clearAll（R5-1/R5-2） | 增 | 否 | S0 |

## 关键说明

- **变更类型**：增=Vue 无 React 新增；删=Vue 有 React 去除；改=两者都有但行为不同
- **动契约?**：全部为否，不涉及后端 REST/Sync 契约变更（D8 空间密码需 B-D8 后端扩展，但属新增端点参数，不推翻已有契约）
- **Sprint**：S0=平台壳阶段完成；S1=Sync Client；F2=业务页；F3b=笔记详情页；S0-D8=空间密码 UI（B-D8 后端扩展后）
