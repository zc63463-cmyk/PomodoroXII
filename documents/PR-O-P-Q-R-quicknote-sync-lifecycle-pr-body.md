# feat(frontend): harden QuickNote sync lifecycle and trash flows

## Summary

This PR closes the next QuickNote release-hardening slice across four bounded areas: outbox event-level failure attribution, unified trash productization, editor conflict handling, and real QuickNote to Note conversion.

## PR-O: outbox event-level failure

- Adds per-event failure metadata to outbox rows: `lastError`, `lastErrorCode`, `failedAt`, `attemptCount`.
- Marks failed push events in place instead of deriving all QuickNote failures from global sync status.
- Derives QuickNote card `failed` only from matching unsynced QuickNote outbox event failure metadata.
- Clears stale failure metadata when local mutations replace or merge existing outbox events.

## PR-P: productized `/trash`

- Replaces the placeholder trash route with `TrashView`.
- Expands `trash-store` to Notes, Folders, and QuickNotes.
- Supports unified empty state, error banner, refresh, restore, purge, and empty-trash flows.
- Adds view/store coverage for all three entity buckets.

## PR-Q: QuickNote conflict panel

- Preserves local dirty drafts when remote active updates arrive during editing.
- Shows a conflict panel with local draft and remote version.
- Supports keep local, use remote, and merge remote into draft.
- Keeps tombstone/converted remote changes as exit-edit flows with user-facing toast.

## PR-R: QuickNote to Note conversion

- Replaces the `migrateToNote()` placeholder with real repository-backed conversion.
- Creates the target Note, marks the source QuickNote converted, and enqueues note/create plus quickNote/update in one Dexie transaction.
- Rolls back conversion if the sync outbox hook fails.
- Adds card action UI, pending state, success/error toast, lifecycle refresh, and repository/store/view tests.

## Verification

- `npm run test -- src/lib/quick-notes/quick-note-repository.test.ts src/stores/quick-note-store.test.ts src/components/quick-notes/quick-notes-view.test.tsx src/components/quick-notes/quick-notes-view.runtime-sync.test.tsx`
  Result: 4 files / 71 tests passed.
- `npm run test -- src/lib/sync/outbox.test.ts src/lib/sync/push-batch.test.ts src/lib/sync/index.test.ts src/components/trash/trash-view.test.tsx src/stores/trash-store.test.ts src/stores/business-stores.test.ts`
  Result: 6 files / 87 tests passed.
- `npm run typecheck` passed.
- `npm run lint` passed.
- `npm run test` passed: 39 files / 333 tests.
- `npm run build` passed: 19 routes generated.
- `git diff --check` passed.

## Staging Notes

Include only QuickNote/Trash/Sync source and tests for the functional commit:

- `frontend/src/app/(app)/trash/page.tsx`
- `frontend/src/components/quick-notes/`
- `frontend/src/components/trash/`
- `frontend/src/lib/quick-notes/`
- `frontend/src/lib/sync/`
- `frontend/src/stores/`
- `frontend/src/types/index.ts`

Exclude local or generated artifacts:

- `--title`
- `.codebase-memory/`
- `.trae/documents/`
- `frontend/.codebase-memory/`
- `output/`
- `quick-notes-token-demo/`
- old `pr-body.md`
- old `quicknote-pr-body.md`
- generated HTML reports
