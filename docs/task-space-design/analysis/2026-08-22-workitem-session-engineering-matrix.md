# WorkItem / FocusSession 工程事实源矩阵

## 基线

- 主线提交：`69c397021db46c0cacd8df7ea0626a1db9811206`
- Space Alembic head：`space_011_sync_clients_streaming`
- Meta Alembic head：`meta_002_active_session_locator`
- 计划校验：`VERIFY_TS_OK plans=5 tasks=44 steps=291 cross_wave=pass`
- 适用范围：Windows 单用户、单 Pomodoro Space；不包含多人协作、Linux、Docker 或生产部署认证。

## 事实源矩阵

| 事实 | 唯一写入边界 | 持久化位置 | 对外适配 | 当前证据 |
|---|---|---|---|---|
| Project、WorkItem 树、正式状态 | Task Space command module | Space DB `projects` / `work_items` / definition tables | `/api/v1/projects`、`/api/v1/work-items`、Task Space repository | `backend/app/task_space/`、`backend/app/routes/v1/projects.py`、`backend/app/routes/v1/work_items.py` |
| WorkItemNote 文档与 checklist | WorkItemNote CAS repository | Space DB `work_item_notes`；前端 v18 Note cache/outbox | `/api/v1/work-item-notes`、`WorkItemNoteRepository` | `backend/app/task_space/document.py`、`backend/app/routes/v1/work_item_notes.py`、`frontend/src/lib/task-space/work-item-note-repository.ts` |
| FocusSession 时间与生命周期 | FocusSession module / ActiveSessionCoordinator | Space DB FocusSession tables；Meta active locator | `/api/v1/active-session` 与历史/复核路由 | `backend/app/focus_session/`、`backend/app/active_session/`、`backend/alembic_space/versions/010_task_space_focus_session.py` |
| Session attribution revisions | FocusSession revision command | Space DB `session_attribution_revisions` | FocusSession history/review adapters | `backend/app/models/session_revision.py`、`backend/app/focus_session/recovery_authority.py` |
| Session plan/outcome | FocusSession command and review | Space DB plan/outcome tables | FocusSession review API、前端 review repository | `backend/app/focus_session/`、`frontend/src/lib/focus-session/` |
| WorkItem 完成/取消 | Task Space transition command | WorkItem status/version columns | WorkItem transition API；Session 只能提交命令意图 | `backend/app/task_space/module.py`、`backend/app/focus_session/commands.py` |
| Active Session routing/lease | ActiveSessionCoordinator | Meta `active_session_locator` / operation journal | Master-scoped active-session API | `backend/alembic_meta/versions/002_active_session_locator.py`、`backend/app/active_session/` |
| Direct command identity | Shared mutation identity owner | Space/Meta intent and receipt records；Dexie v18 intents | REST command retries and frontend repositories | `backend/app/mutation/types.py`、`frontend/src/lib/direct-command-intents.ts` |

## 已冻结的不变量

1. WorkItem 深度由 `parentId` 派生，最多三层；跨 Project、环和第四层移动必须拒绝。
2. WorkItemNote v1 仅允许 paragraph/checklist 结构化 Block；整文档 CAS 冲突保留本地与远端版本。
3. FocusSession 不直接写 WorkItem 状态或 WorkItemNote；跨域操作必须经过命令 envelope/receipt。
4. ActiveSession 的运行中写入必须经过 Coordinator 的 owner/epoch fencing。
5. Space 行不重复 `space_id`；Space 身份由授权 scope、路由和命令 envelope 携带并校验。
6. 直接 Project/WorkItem/review 命令在传输前固定 operation ID、完整请求 JSON 和 payload hash。

## 迁移与兼容边界

- 当前设计采用破坏式切换，不保留旧 Task/Session 的双读、双写或兼容影子。
- 旧数据迁移不是当前 Windows 单用户发布门禁；若未来引入真实数据，必须单独批准回填、回滚和 fleet preflight 设计。
- 任一后续 schema/API 改动必须同时更新：Alembic、Registry、OpenAPI、前端生成类型、Dexie schema 和对应证据测试。

## 当前验证与未认证项

已验证：Task Space Workbench、FocusSession 核心回归、VFS、前端测试/typecheck/lint/build，以及上述迁移头。

未认证：Linux/Docker、多人协作、旧数据迁移、生产部署、签名与供应链发布。它们不能由本矩阵或绿色 CI 推断为完成。
