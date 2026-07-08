# ADR-2026-07-08 QuickNote Sync Lifecycle

## Status

Accepted.

## Context

QuickNote 已从本地 MVP 进入 release hardening 阶段。当前风险集中在四条生命周期边界：卡片级同步失败提示、同步完成后的真实 UI 刷新、编辑中遇到远端变更、以及 QuickNote 转 Note 的事务一致性。

过去的 `failed = global sync error + pending` 派生方式只能说明“同步整体失败”，不能准确定位到单条 QuickNote。编辑器也需要在远端更新、删除、迁移到来时保护本地草稿。`/trash` 页面则需要从占位状态升级为 Notes/Folders/QuickNotes 的统一产品面。

## Decision

1. **Outbox event-level failure**
   - `OutboxEvent` 增加 `lastError`、`lastErrorCode`、`failedAt`、`attemptCount` 失败元数据。
   - push 错误保留 outbox 行，并把失败写到匹配的 outbox event。
   - QuickNote 卡片的 `failed` 只由同实体未同步 outbox event 的失败元数据派生，不再由全局 sync error 批量染色。

2. **QuickNote runtime refresh**
   - sync `onPullComplete` / `onPushComplete` / `onSyncComplete` 保持触发 `refreshQuickNotesFromRepository()`。
   - runtime 测试使用真实 Zustand store、真实 repository、`spaceDBManager.switchTo()` 和 fake-indexeddb，证明 repository 刷新能穿透到 `QuickNotesView` UI。

3. **Editing remote-change behavior**
   - 编辑开始时保存原始 snapshot，并用 draft dirty 判断保护本地草稿。
   - dirty draft 遇到远端 active 更新时，不自动覆盖 textarea，展示冲突面板。
   - 冲突面板支持保留本地草稿、采用远端版本、或把远端版本合并到当前草稿。
   - 被 sync tombstone 移除或 converted 时退出编辑态并提示用户。

4. **QuickNote to Note conversion**
   - `convertQuickNoteToNote()` 在 Dexie transaction 中完成 Note 创建、QuickNote archived/converted 标记、outbox 入队。
   - note:create 与 quickNote:update 必须同事务成功；outbox hook 失败时回滚 Note 创建和 QuickNote lifecycle 更新。
   - converted QuickNote 不再进入 active list，并通过 lifecycle state 暴露给 store/UI。

5. **Unified trash lifecycle**
   - `/trash` 使用统一 `TrashView`，展示 Notes、Folders、QuickNotes 的空态、错误态、恢复、彻删和清空流程。
   - `trash-store` 直接从 Dexie 读取三类 trashed entities，并集中处理 loading/error/rethrow。

## Consequences

- 卡片级失败提示更准确，为后续单条 retry 按钮留下稳定边界。
- QuickNote 编辑冲突先保护用户草稿，不在本轮实现复杂 diff/merge panel。
- conversion 以本地事务一致性为准，后续可在成功 toast 中接入 Note 跳转。
- `/trash` 成为跨实体共享产品面，后续需要可访问性、批量操作和真实后端同步 smoke。

## Verification Baseline

- `npm run test -- src/lib/quick-notes/quick-note-repository.test.ts src/stores/quick-note-store.test.ts src/components/quick-notes/quick-notes-view.test.tsx src/components/quick-notes/quick-notes-view.runtime-sync.test.tsx`
- `npm run test -- src/lib/sync/outbox.test.ts src/lib/sync/push-batch.test.ts src/lib/sync/index.test.ts src/components/trash/trash-view.test.tsx src/stores/trash-store.test.ts src/stores/business-stores.test.ts`
- `npm run typecheck`
- `npm run lint`
- `npm run test`
- `npm run build`
