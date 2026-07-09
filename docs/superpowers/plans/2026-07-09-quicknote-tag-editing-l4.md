# Quick Note Tag Editing L4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add lightweight Quick Notes tag maintenance: rename tags, clean dirty tags, and insert popular tags into the composer draft.

**Architecture:** Keep tags as derived `QuickNote.tags` arrays plus inline `#tag` text. Put deterministic tag transforms in `frontend/src/lib/quick-notes/quick-note-tags.ts`, batch active-note mutations in `frontend/src/stores/quick-note-store.ts`, and expose controls through the existing Quick Notes explorer/composer props. Repository writes continue through `updateQuickNote` so the outbox/sync boundary stays centralized.

**Tech Stack:** React 19, Zustand, Dexie repository, Vitest + Testing Library, existing Tailwind utility style map.

## Global Constraints

- Do not touch session, timer, system session entity, sync protocol, or quick note schema/data model.
- Do not introduce a tag entity, tag table, or relationship model.
- Tags remain derived from `QuickNote.tags` and simple inline hashtags in content.
- Rename and cleanup operate on active quick notes only.
- Slash tags such as `work/frontend` update only the `tags` array; content is not rewritten for slash tags.
- Quick Preview, Detail Read, and Markdown rendering semantics remain unchanged.

---

### Task 1: Tag Transform Helpers

**Files:**
- Modify: `frontend/src/lib/quick-notes/quick-note-tags.ts`
- Test: `frontend/src/lib/quick-notes/quick-note-tags.test.ts`

**Interfaces:**
- Produces: `cleanupQuickNoteTags(tags: string[]): string[]`
- Produces: `renameQuickNoteTagInList(tags: string[], from: string, to: string): string[]`
- Produces: `replaceInlineQuickNoteHashtag(content: string, from: string, to: string): string`

- [ ] **Step 1: Write failing tests**

Add tests for:

```ts
expect(cleanupQuickNoteTags(['', '#', ' Work ', '#work', 'life'])).toEqual(['work', 'life'])
expect(renameQuickNoteTagInList(['work', 'life'], 'work', 'project')).toEqual(['project', 'life'])
expect(renameQuickNoteTagInList(['work', 'project'], 'work', 'project')).toEqual(['project'])
expect(replaceInlineQuickNoteHashtag('ship #work and #work-now', 'work', 'project')).toBe('ship #project and #work-now')
expect(replaceInlineQuickNoteHashtag('ship #work/frontend', 'work/frontend', 'project')).toBe('ship #work/frontend')
```

- [ ] **Step 2: Run helper tests and confirm RED**

Run:

```powershell
cd frontend
npm run test -- src/lib/quick-notes/quick-note-tags.test.ts
```

Expected: missing exported functions.

- [ ] **Step 3: Implement helpers**

Add pure helpers using `normalizeQuickNoteTags`, exact normalized tag matching, and Unicode-safe simple hashtag replacement for tags without `/`.

- [ ] **Step 4: Run helper tests and confirm GREEN**

Run the same focused test command. Expected: all quick-note-tags tests pass.

### Task 2: Store Batch Actions

**Files:**
- Modify: `frontend/src/stores/quick-note-store.ts`
- Test: `frontend/src/stores/quick-note-store.test.ts`

**Interfaces:**
- Produces: `renameQuickNoteTag(from: string, to: string): Promise<void>`
- Produces: `cleanupQuickNoteTags(): Promise<number>`

- [ ] **Step 1: Write failing store tests**

Cover:

```ts
await useQuickNoteStore.getState().renameQuickNoteTag('work', 'project')
expect(useQuickNoteStore.getState().selectedTagFilters).toEqual(['project'])
```

Also assert active notes update content and tags, rename merges existing tags without duplicates, cleanup returns changed note count, cleanup does not change content, and trashed/converted notes remain unchanged.

- [ ] **Step 2: Run store tests and confirm RED**

Run:

```powershell
cd frontend
npm run test -- src/stores/quick-note-store.test.ts
```

Expected: store actions are missing.

- [ ] **Step 3: Implement actions**

Use current `allQuickNotes`, filter to active notes, compute patches with helper functions, call repository `updateQuickNote(id, patch)` only when tags/content change, then refresh lists with updated selected filters. On rename, replace selected `from` filters with `to`; on cleanup, remove selected filters that no longer exist.

- [ ] **Step 4: Run store tests and confirm GREEN**

Run the same focused store test command. Expected: all store tests pass.

### Task 3: Explorer Rename And Cleanup UI

**Files:**
- Modify: `frontend/src/components/quick-notes/quick-note-explorer.tsx`
- Modify: `frontend/src/components/quick-notes/quick-notes-workspace.tsx`
- Modify: `frontend/src/components/quick-notes/quick-notes-view.tsx`
- Modify: `frontend/src/components/quick-notes/quick-note-styles.ts`
- Test: `frontend/src/components/quick-notes/quick-notes-view.test.tsx`

**Interfaces:**
- Consumes: `renameQuickNoteTag(from, to)` from store
- Consumes: `cleanupQuickNoteTags()` from store

- [ ] **Step 1: Write failing UI tests**

Cover explorer rename entry, inline input save via Enter or button, Escape cancel, cleanup button dispatch, success toast, and failure toast.

- [ ] **Step 2: Run Quick Notes view tests and confirm RED**

Run:

```powershell
cd frontend
npm run test -- src/components/quick-notes/quick-notes-view.test.tsx
```

Expected: missing controls/store mocks.

- [ ] **Step 3: Implement explorer UI**

Add an inline rename state per tag. Keep filter chip as the primary button and add small text controls for `重命名`, `保存`, `取消`. Add a header action for `清理标签`. Workspace/View wrap store actions with toast messages:

```ts
toast(`已将 #${from} 重命名为 #${to}`)
toast(`已清理 ${count} 条小记的标签`)
toast('标签已是干净状态')
toast.error('标签重命名失败')
```

- [ ] **Step 4: Run Quick Notes view tests and confirm GREEN**

Run the same focused UI test command. Expected: view tests pass.

### Task 4: Composer Popular Tags

**Files:**
- Modify: `frontend/src/components/quick-notes/quick-note-composer.tsx`
- Modify: `frontend/src/components/quick-notes/quick-notes-workspace.tsx`
- Modify: `frontend/src/components/quick-notes/quick-note-styles.ts`
- Test: `frontend/src/components/quick-notes/quick-notes-view.test.tsx`

**Interfaces:**
- Produces composer props: `popularTags?: string[]`, `onInsertTag?: (tag: string) => void`

- [ ] **Step 1: Write failing UI tests**

Cover top 8 active tag chips, clicking a chip appends ` #tag` to a non-empty draft, empty draft becomes `#tag `, and an already-present tag is not duplicated.

- [ ] **Step 2: Run Quick Notes view tests and confirm RED**

Run:

```powershell
cd frontend
npm run test -- src/components/quick-notes/quick-notes-view.test.tsx
```

- [ ] **Step 3: Implement popular tag insertion**

Compute `getQuickNoteTagStats(allQuickNotes).slice(0, 8).map((stat) => stat.tag)` in workspace and pass into composer. Composer renders chips below status/preview tags; clicking calls `onInsertTag` only when the draft does not already include the normalized tag.

- [ ] **Step 4: Run Quick Notes view tests and confirm GREEN**

Run the same focused UI test command.

### Task 5: Verification, Smoke, Review, PR

**Files:**
- No new production scope unless tests reveal a direct PR-L4 issue.

- [ ] **Step 1: Run targeted tests**

```powershell
cd frontend
npm run test -- src/lib/quick-notes/quick-note-tags.test.ts src/stores/quick-note-store.test.ts src/components/quick-notes/quick-notes-view.test.tsx
```

- [ ] **Step 2: Run gates**

```powershell
npm run lint
npm run typecheck
npm run test
npm run build
```

- [ ] **Step 3: Restart fresh preview after build and smoke**

```powershell
npm run dev:preview -- -Port 3013
```

Open `http://127.0.0.1:3013/quick-notes?quickNotePreview=1` and verify tag rename, cleanup, popular tag insertion, and no Quick Preview/Detail Read/Markdown regressions.

- [ ] **Step 4: Review diff against this plan**

Check no session/timer/system session/sync/schema files changed. Confirm no tag table/entity exists.

- [ ] **Step 5: Commit and push**

Stage only PR-L4 files and commit:

```powershell
git commit -m "feat: enhance quick note tag editing"
git push -u origin codex/quicknote-tag-editing-l4
```
