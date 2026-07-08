# PR-N QuickNote Release Readiness / PR 拆分收口

## Summary

PR-N 的目标不是继续扩展 QuickNote 功能，而是把当前 QuickNote 运行时闭环、编辑态保护、轻量同步状态、预览 smoke 和测试边界整理到可 review、可拆分、可合并的状态。

当前判断：QuickNote 主链路已经具备进入收口阶段的条件；合并前主要风险来自工作区混杂改动和大量未跟踪文件，而不是 QuickNote 核心行为本身。

## 当前可进入本轮 QuickNote PR 的范围

### QuickNote 产品与 UI

- `frontend/src/app/(app)/quick-notes/page.tsx`
- `frontend/src/app/(app)/layout.tsx` 中 QuickNote preview route guard bypass
- `frontend/src/components/quick-notes/`
- `frontend/src/app/globals.css` 中 `.quick-notes-surface` 相关 token
- `frontend/src/app/(app)/settings/page.tsx` 中主题切换和“小记页”入口
- `frontend/src/app/(app)/settings/page.test.tsx`
- `frontend/src/app/providers.tsx` 中扩展 `next-themes` theme list
- `frontend/src/stores/settings-store.ts` 中主题值支持

纳入理由：

- `/quick-notes` 已从占位页切为真实 `QuickNotesView`。
- preview 模式需要 layout guard 放行 `/quick-notes?quickNotePreview=1` 和 `/settings` 主题 smoke，否则本地验证会被 auth/space guard 截断。
- QuickNote 卡片、composer、timeline、trash panel、编辑器 hook、item actions 是本轮功能主体。
- 主题 token 与 settings smoke 入口直接服务 QuickNote 页面可见性和手动验证。

### QuickNote repository / store / trash

- `frontend/src/lib/quick-notes/`
- `frontend/src/stores/quick-note-store.ts`
- `frontend/src/stores/trash-store.ts`
- `frontend/src/stores/quick-note-store.test.ts`
- `frontend/src/stores/trash-store.test.ts`

纳入理由：

- QuickNote 的 Dexie repository、tag/selectors、preview bootstrap、sync 状态派生都集中在该目录。
- `quick-note-store` 已从 S0 no-op stub 变成真实 repository-backed Zustand store。
- `trash-store` 已补 QuickNote trash actions 的 loading/error/rethrow 行为，属于 QuickNote 回收站稳定性边界。

### Sync wiring 与 runtime refresh tests

- `frontend/src/lib/sync/index.ts`
- `frontend/src/lib/sync/index.test.ts`
- `frontend/src/components/quick-notes/quick-notes-view.runtime-sync.test.tsx`
- `frontend/src/lib/sync/quick-note-sync.integration.test.ts`
- `frontend/src/lib/sync/merge.test.ts`
- `frontend/src/lib/sync/push-batch.test.ts`

纳入理由：

- `wireSyncEngineToStore()` 已在 pull/push/sync complete 后触发 `refreshQuickNotesFromRepository()`。
- runtime-sync 测试使用真实 store + repository + fake-indexeddb，证明 refresh action 能穿透到 UI。
- merge/push-batch 补测覆盖 QuickNote tombstone / outbox 行为，是 PR-L/PR-M 的测试可信度基础。

### Space DB / preview support

- `frontend/src/services/space-db.ts`
- `frontend/src/services/space-db.test.ts`
- `frontend/src/lib/space-bootstrap.tsx`
- `frontend/scripts/dev-preview.ps1`
- `frontend/.env.local.example`
- `frontend/package.json`
- `frontend/README.md`

纳入理由：

- `spaceDBManager.switchTo(..., { dispatchEvent: false })` 支持测试和局部初始化避免不必要的 window event 干扰。
- QuickNote preview 需要绕开后端 auth bootstrap，便于本地 smoke。
- README 已记录 `npm run dev:preview`、固定入口、端口处理和 preview cleanup。
- `typecheck` 改为 `next typegen && tsc --noEmit` 是 Next typed routes 下的必要 gate 修复。

## 建议排除或单独归档的范围

### 明确不应混入 QuickNote PR 的本地/生成产物

- `--title`
- `.codebase-memory/`
- `frontend/.codebase-memory/`
- `quick-notes-token-demo/`
- `深度架构分析.html`
- 根目录各类历史审查 HTML / report 临时产物

处理建议：

- 不在本轮 QuickNote PR 中 stage。
- 如需保留，单独归档到文档 PR 或本地资料目录；如需删除，应由专门 cleanup PR 处理，避免和功能 review 混在一起。

### `.trae/documents/` 大量历史计划文档

处理建议：

- 不随 QuickNote 功能 PR 合入。
- 若需要沉淀历史过程，单开 docs/history PR；否则保持未跟踪，不纳入 release readiness diff。

### 旧 `pr-body.md`

处理建议：

- 当前内容仍是 S1 Sync Foundation 的 PR body，不适合作为 QuickNote PR 正文直接复用。
- QuickNote PR body 应从本文件的“建议 PR body”段落重新生成。

## 建议 PR 拆分

### PR-N1: QuickNote MVP + Theme Preview

包含：

- `/quick-notes` 页面切换到 `QuickNotesView`
- `frontend/src/components/quick-notes/`
- `frontend/src/lib/quick-notes/`
- `quick-note-store`
- settings theme UI、global QuickNote tokens、preview README/script

目标：

- 让 reviewer 能完整验证 QuickNote 本地 CRUD、搜索、tag、回收站、主题 smoke。

### PR-N2: QuickNote Sync Runtime Refresh

包含：

- `frontend/src/lib/sync/index.ts`
- `quick-notes-view.runtime-sync.test.tsx`
- `quick-note-sync.integration.test.ts`
- QuickNote 相关 sync/merge/push-batch 补测

目标：

- 单独证明 pull/push/sync complete 后真实 refresh action 能穿透 UI，避免和 UI 视觉 diff 混在一起。

### PR-N3: Trash Store Hardening

包含：

- `frontend/src/stores/trash-store.ts`
- `frontend/src/stores/trash-store.test.ts`

目标：

- 把全局 trash-store 的 QuickNote action 收口为稳定、可复用的错误处理和 loading 行为。
- 后续真正产品化 `/trash` 页面时，可基于该 store 做页面级审查。

如果希望减少 PR 数量，可以把 PR-N2 合并进 PR-N1，但不建议把本地生成文档和历史计划文件混入。

## Manual Smoke Checklist

### QuickNote preview

1. `cd frontend`
2. `npm run dev:preview`
3. 打开 `http://127.0.0.1:3005/quick-notes?quickNotePreview=1`
4. 新建一条包含 `#tag` 的小记，确认卡片出现、tag 可点击搜索。
5. 编辑小记，确认本地 draft 可保存，保存状态文案正常。
6. 移到回收站，确认 active timeline 清空或减少，回收站计数增加。
7. 打开回收站，确认恢复和彻删按钮可见且可用。
8. 在浏览器控制台执行 `localStorage.removeItem('pxii_quick_notes_preview')` 清理 preview 标记。

### Theme smoke

1. 打开 `/settings`。
2. 切换 `Light / Dark / Midnight / Nord / Daylight`。
3. 返回 `/quick-notes?quickNotePreview=1`。
4. 检查标题、composer、搜索框、卡片正文、tag、回收站按钮没有白字或低对比。
5. 确认设置页“查看小记页”入口指向 `/quick-notes`，不会自动写入 preview 标记。

### Sync runtime confidence

1. 运行 runtime sync test，确认 active card 来自真实 repository + store。
2. 确认 pull tombstone 后页面从卡片刷新为空态。
3. 确认 soft delete 后 active timeline 为空、回收站计数变为 1。
4. 确认 push clean 后 `待同步` 状态消失。
5. 确认 sync error + pending outbox 时显示 `同步失败，可稍后重试`。

## Automated Gate Checklist

合并前建议在 `frontend/` 下运行：

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

QuickNote focused gate：

```bash
npm run test -- src/stores/quick-note-store.test.ts src/stores/trash-store.test.ts src/components/quick-notes/quick-notes-view.runtime-sync.test.tsx src/components/quick-notes/quick-notes-view.test.tsx src/components/quick-notes/quick-note-theme-smoke.test.ts src/lib/sync/index.test.ts src/lib/sync/quick-note-sync.integration.test.ts
```

已知上一轮全量 gate 结果：

- `npm run lint` passed
- `npm run typecheck` passed with `next typegen && tsc --noEmit`
- `npm run test` passed: 38 files / 315 tests
- `npm run build` passed

如果本文件之后没有业务代码变更，可只跑 focused test 或文档 review；如果 stage 范围改变，应复跑全量 gate。

## Remaining Risks

- `failed` 仍由全局 sync error + pending outbox 派生，不能精确定位单条 outbox event 错误；后续需要 outbox event 级 error 状态才能做更细 UI。
- `trash-store` 的 QuickNote action 已稳定，但全局 `/trash` 页面仍未产品化；接 UI 时需要页面级审查。
- 工作区存在大量历史未跟踪文件和大范围改动；合并前必须按 PR bucket 手动 stage，避免把本地资料、生成文件、历史计划文档混入。
- `migrateToNote()` 当前显式抛出 local MVP 未实现错误；这比空实现安全，但产品上仍属于后续 conversion PR。

## Suggested QuickNote PR Body

```markdown
# feat(frontend): QuickNote MVP runtime refresh and release readiness

## Summary

- Build the local QuickNote MVP page with real Dexie repository-backed Zustand store.
- Wire sync completion callbacks to refresh QuickNote state from repository and prove the refresh reaches UI with fake-indexeddb runtime tests.
- Add editing protections for remote tombstone/update/conversion cases without introducing conflict UI.
- Surface lightweight per-card sync states for pending and failed local changes.
- Add QuickNote preview smoke path and theme coverage for release readiness.

## Test Plan

- npm run lint
- npm run typecheck
- npm run test
- npm run build
- npm run test -- src/stores/quick-note-store.test.ts src/stores/trash-store.test.ts src/components/quick-notes/quick-notes-view.runtime-sync.test.tsx src/components/quick-notes/quick-notes-view.test.tsx src/components/quick-notes/quick-note-theme-smoke.test.ts src/lib/sync/index.test.ts src/lib/sync/quick-note-sync.integration.test.ts

## Out of Scope

- Event-level outbox error attribution.
- Full `/trash` product page.
- QuickNote conflict resolution panel.
- QuickNote to Note conversion implementation.
- Historical planning docs and local generated artifacts.
```

## Stage Checklist

建议先只 stage 以下 bucket：

```text
frontend/.env.local.example
frontend/README.md
frontend/package.json
frontend/scripts/dev-preview.ps1
frontend/src/app/(app)/layout.tsx
frontend/src/app/(app)/quick-notes/page.tsx
frontend/src/app/(app)/settings/page.tsx
frontend/src/app/(app)/settings/page.test.tsx
frontend/src/app/globals.css
frontend/src/app/providers.tsx
frontend/src/lib/space-bootstrap.tsx
frontend/src/lib/quick-notes/
frontend/src/components/quick-notes/
frontend/src/lib/sync/index.ts
frontend/src/lib/sync/index.test.ts
frontend/src/lib/sync/quick-note-sync.integration.test.ts
frontend/src/lib/sync/merge.test.ts
frontend/src/lib/sync/push-batch.test.ts
frontend/src/services/space-db.ts
frontend/src/services/space-db.test.ts
frontend/src/stores/quick-note-store.ts
frontend/src/stores/quick-note-store.test.ts
frontend/src/stores/trash-store.ts
frontend/src/stores/trash-store.test.ts
frontend/src/stores/settings-store.ts
frontend/src/stores/business-stores.test.ts
documents/PR-N-quicknote-release-readiness.md
```

明确不要 stage：

```text
--title
.codebase-memory/
frontend/.codebase-memory/
.trae/documents/
quick-notes-token-demo/
pr-body.md
*.html generated/review artifacts
```
