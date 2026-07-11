# QN-S1.1 QuickNote Draft Session Reliability Design

## Status

- Date: 2026-07-11
- Scope: unsubmitted new QuickNote drafts only
- Baseline: QN-S1 commit `ee4dfd8` on top of `origin/main`
- Decision: deepen the new-draft lifecycle into a React-first `QuickNoteDraftSession` module

## Context

QN-S1 persists one unsubmitted QuickNote draft per Space in the local Dexie
`settings` table. It restores the draft on re-entry, clears it after successful
creation or discard, flushes before a Space switch, and keeps Space A and Space B
storage separate.

The baseline passes the current test suite, but three ordering and failure paths
remain outside the existing tests:

1. The before-switch listener copies `ActiveDraftContext.writeQueue`. Input that
   arrives while the copied flush is pending can use the original queue, allowing
   two writes for one Space to run concurrently. A slower old flush can overwrite
   a newer draft.
2. Loading damaged or unsupported JSON attempts to delete the bad row. If that
   delete fails, `load()` rejects from a fire-and-forget call and can produce an
   unhandled rejection.
3. After QuickNote creation succeeds, a failed draft clear is swallowed. The old
   persisted content can then appear again after reload even though the QuickNote
   was already created.

The current implementation distributes revision, debounce, queue, recovery,
discard, submit, Space lifecycle, and cleanup behavior across React refs and a
shallow `load/save/clear` repository interface. QN-S1.1 concentrates those rules
in one deep module.

## Goals

1. Guarantee one canonical write lane per Space draft session.
2. Never let an older operation overwrite a newer accepted input revision.
3. Prevent a successfully recorded draft from reappearing after reload by making
   entity creation, the production-default Outbox enqueue, and settings cleanup
   atomic.
4. Convert expected storage failures into observable state or tagged results;
   background work must not leak unhandled rejections.
5. Preserve input typed during record or discard operations.
6. Keep Space A module-owned failures, default Outbox writes, and hanging draft
   operations from blocking or contaminating Space B.
7. Reduce the new-draft interface used by `useQuickNoteEditor` to ordinary user
   intentions rather than storage and lifecycle mechanics.

## Non-goals

- Persisting or recovering edits to an existing QuickNote.
- Refactoring `QuickNoteReadArticle` or its inline editor.
- Changing QuickNote sync, Outbox semantics, backend routes, or backend schemas.
- Changing Session, Task, Timer, Schedule, or their relationships.
- Adding global quick capture, multiple drafts per Space, or cross-device drafts.
- Adding a manager-wide deadline to every `SpaceDBManager` listener.
- Refactoring the global QuickNote repository proxy in this change.
- Adding a Dexie schema version. Only the JSON value stored in `settings` changes.

## Design Alternatives

### A. Minimal patches inside `useQuickNoteEditor`

Keep the current refs and add guards for the three known paths.

This is the smallest diff, but it leaves queue ownership, storage recovery, and
Space transitions inside an already large hook. The next concurrency change would
again require tests past the intended interface. Rejected because it does not
improve locality and fails the deletion test.

### B. Generic command-driven actor

Expose `dispatch(command)`, `getSnapshot()`, and `subscribe()` with command,
receipt, token, and outcome unions.

This models ordering precisely and is extensible, but makes the common React
caller learn tokens and actor receipts. The type-level interface is small while
the behavioral interface remains broad. Rejected for QN-S1.1 because current
callers need only three user intentions.

### C. React-first deep module with an internal actor lane

Expose draft state plus `change`, `record`, and `discard`. Keep revision tokens,
Space epochs, queue drains, recovery, and atomic recording private.

This provides the best caller leverage while retaining the actor ordering model
inside the implementation. Selected.

## Module Shape

The external seam is a React hook because all current and planned near-term
callers are React capture surfaces.

```ts
export type QuickNoteDraftSaveState =
  | 'idle'
  | 'dirty'
  | 'saving'
  | 'saved'
  | 'restored'
  | 'failed'

export type QuickNoteDraftRecordResult =
  | {
      kind: 'recorded'
      note: QuickNote
      visibility: 'refreshed' | 'pending'
    }
  | { kind: 'empty' }
  | { kind: 'busy'; operation: 'discard' }
  | { kind: 'failed'; issue: QuickNoteDraftIssue }

export type QuickNoteDraftDiscardResult =
  | { kind: 'discarded' }
  | { kind: 'superseded' }
  | { kind: 'busy'; operation: 'record' }
  | { kind: 'failed'; issue: QuickNoteDraftIssue }

export interface QuickNoteDraftIssue {
  code:
    | 'read-failed'
    | 'invalid-record-cleanup-failed'
    | 'migration-save-failed'
    | 'save-failed'
    | 'discard-failed'
    | 'record-failed'
    | 'projection-failed'
    | 'switch-flush-timeout'
  retryable: boolean
}

export interface QuickNoteDraftSession {
  readonly draft: string
  readonly saveState: QuickNoteDraftSaveState
  readonly issue: QuickNoteDraftIssue | null

  change(next: string): void
  record(): Promise<QuickNoteDraftRecordResult>
  discard(): Promise<QuickNoteDraftDiscardResult>
}

export function useQuickNoteDraftSession(input: {
  onRecorded: (note: QuickNote) => undefined
}): QuickNoteDraftSession
```

The interface intentionally does not expose `load`, `save`, `clear`, `flush`,
`activateSpace`, revision numbers, timers, queues, or lifecycle subscriptions.

`record()` owns the complete new-draft submission protocol. It does not call the
Store create action and leave database selection or cleanup ordering to its
caller. Raw adapter exceptions remain inside the implementation; the external
seam exposes stable issue codes.

`onRecorded` is a synchronous Store projection, not an asynchronous repository
refresh. The session calls it only after rechecking that the captured epoch is
still active. JavaScript run-to-completion then prevents a Space switch from
interleaving inside that projection. This keeps Store visibility behind the
module without allowing a delayed global-DB read to write Space A results into
Space B. Returning `undefined` rather than `void` prevents an async callback from
satisfying the TypeScript interface.

## Internal Modules

### `QuickNoteDraftSession`

Owns:

- current Space epoch and active draft generation;
- visible draft and save state;
- stable draft ID and input revision;
- debounce scheduling;
- one canonical write lane per Space epoch;
- restore guards and v1-to-v2 migration;
- atomic record, discard, and conditional discard cleanup;
- before-switch, pagehide, and unmount handling;
- normalization of expected storage failures.

### `DexieQuickNoteDraftAdapter`

An implementation-private adapter bound to a concrete `PomodoroXIDB` instance.
It does not use the global dynamic DB proxy.

Its internal interface supports these behaviors:

```ts
type QuickNoteDraftRowOwner =
  | { kind: 'v2'; draftId: string }
  | { kind: 'raw'; value: string }

type QuickNoteDraftLoadResult =
  | { kind: 'absent' }
  | {
      kind: 'valid'
      snapshot: QuickNoteNewDraftSnapshot | QuickNoteNewDraftSnapshotV2
      owner: QuickNoteDraftRowOwner
    }
  | { kind: 'invalid'; owner: QuickNoteDraftRowOwner }

interface QuickNoteDraftStorageAdapter {
  load(): Promise<QuickNoteDraftLoadResult>
  save(snapshot: QuickNoteNewDraftSnapshotV2): Promise<void>
  clearIfOwned(
    owners: readonly QuickNoteDraftRowOwner[],
  ): Promise<'cleared' | 'absent' | 'different-draft'>
  record(snapshot: QuickNoteNewDraftSnapshotV2): Promise<QuickNote>
}
```

This is an internal seam with two justified adapters. Production uses
`DexieQuickNoteDraftAdapter`. Session ordering tests use a deterministic
`ControlledQuickNoteDraftAdapter` that can delay, reject, or hang individual
operations. Real transaction, codec, and migration integration tests still run
the Dexie adapter against fake-indexeddb. No public storage port is added.
The package-private controller factory accepts a
`QuickNoteDraftStorageAdapter`. The production hook creates a Dexie adapter for
each Space epoch; controller tests inject a test-file
`ControlledQuickNoteDraftAdapter`. Both exercise the same `change`, `record`,
`discard`, and state interface, and the storage port is not re-exported as an
application dependency. The controlled adapter proves lane ordering,
single-flight behavior, and timeout isolation. Dexie plus fake-indexeddb proves
codec, migration, transaction rollback, and table-operation failures.

The adapter never deletes during `load()`. A v2 row is owned by its `draftId`; a
v1, blank, damaged, or unsupported row receives an implementation-private raw
value token. `clearIfOwned` re-reads the settings row and deletes only when its v2
ID or exact raw value matches a captured owner. Raw owner values never cross the
external session interface or enter logs.

`record()` is bound to the epoch's concrete database. Under the production
default Outbox configuration, its implementation runs one Dexie transaction over
`quickNotes`, `outbox`, and `settings`: validate that the stored `draftId` still
matches, create the QuickNote, enqueue its Outbox event, and delete the draft row.
Any failure aborts all three writes. Shared QuickNote construction and
normalization logic is reused from the repository so this path does not create a
second domain contract.

The repository extracts one concrete-DB-aware configured Outbox helper. Its
configuration semantics stay compatible with the current hook:

- default/reset calls `enqueueOutbox(database, ...)` with the transaction's
  concrete database;
- configured `null` disables enqueue as it does today;
- a configured custom hook still receives the same mutation context and is
  awaited inside the transaction.

Internally, configuration is represented as a discriminated
`default | disabled | custom` state instead of relying on function identity.
`configureQuickNoteOutboxHook()` and `resetQuickNoteOutboxHook()` keep their
existing external behavior, while the default branch can reliably select the
captured concrete database.

With `null`, the transaction intentionally contains only entity creation and
draft deletion. With a custom hook, a thrown or rejected hook aborts those local
writes; QN-S1.1 does not claim rollback for side effects that custom code performs
outside the captured Dexie transaction. These are compatibility modes. The
three-write atomicity guarantee applies to the production default, while all
modes keep QuickNote creation and draft deletion atomic with each other.

The custom hook's existing context does not provide a concrete database. A custom
hook that closes over the dynamic proxy or performs external side effects is
therefore outside QN-S1.1's late-Space isolation guarantee. The module still
guarantees its own concrete adapter writes, default Outbox writer, and public
state cannot cross into the new epoch.

The default implementation no longer closes over the dynamic global DB proxy.
Repository tests must prove default, null, custom, and throwing-hook behavior for
both ordinary create and draft-record local transaction paths.

### `useQuickNoteEditor`

Remains the assembly module for two distinct workflows:

- new capture delegates to `QuickNoteDraftSession`;
- existing QuickNote editing keeps the current autosave/conflict implementation.

It selects which draft is visible and maps tagged record/discard results to toast
messages. It no longer owns new-draft persistence refs, queues, timers,
new-draft Space listeners, or cleanup ordering.

It does retain one narrowly scoped synchronous `onSwitch` invalidation path for
the existing-QuickNote editor. After a target Space opens successfully and before
the event loop can run queued edit work, that path cancels existing-edit timers,
increments the existing save sequence, clears the editing ID,
snapshots/conflicts, and ensures queued work checks the invalidated sequence
before calling the dynamic repository. It neither flushes nor persists the
new-draft session. This preserves cross-Space safety without pulling existing-note
persistence into QN-S1.1 or discarding an edit when target-Space open fails.

The session invokes synchronous `onRecorded(note)` only while its epoch is still
active. The production callback projects the created note into the current
QuickNote Store using its existing selectors; it performs no database read. A
callback throw returns `visibility: 'pending'` and sets the session's issue to
`projection-failed`, but does not turn the already committed record into a creation
failure. Runtime sync or a later repository refresh may repair visibility; the
record operation is not repeated. If the epoch is already inactive, the callback
is skipped and visibility is `pending` without mutating the new Space Store.

The Store adds one synchronous `projectRecordedQuickNote(note): undefined`
action. It
inserts or replaces the note in `allQuickNotes`, re-derives the visible list from
the current query, tag, and date filters, and updates the note's active lifecycle
and pending sync projection in one synchronous state update. It does not call the
repository or dynamic DB proxy.

## Persisted Format

QN-S1.1 stores a stable QuickNote ID with the draft:

```ts
interface QuickNoteNewDraftSnapshotV2 {
  version: 2
  draftId: string
  content: string
  updatedAt: string
}
```

`draftId` is the ID used by the concrete-DB record transaction. It provides stable
transaction identity and a conditional-clear key without changing the QuickNote
schema or sync protocol.

### V1 migration

When a valid version 1 snapshot is loaded:

1. add its raw row owner to the active epoch's owned-row frontier;
2. if the normal load guards allow restoration, restore its content, assign a new
   `draftId`, and enqueue a version 2 save on the canonical lane;
3. expose `restored` immediately when restoration applies;
4. expose `failed` if the migration save fails, while retaining the restored text;
5. if a newer input revision blocks restoration, reconcile that current revision
   instead of migrating or displaying the stale v1 content.

Damaged, blank, or unsupported values are never restored. Their raw owner is
conditionally cleared on the canonical lane; cleanup failure becomes
`saveState: 'failed'` and is fully caught. A concurrent newer save cannot be
deleted because its owner token no longer matches.

## State and Ordering Rules

### Space epochs

Each activated Space creates a new epoch containing:

- the Space ID;
- a concrete database reference;
- one mutable write-lane tail;
- the current draft generation;
- an owned-row frontier for loaded, current, or queued generations that could
  still occupy the settings row;
- an epoch identifier used by late-completion guards.

The owned-row frontier contains v2 ID tokens plus temporary raw tokens for loaded
v1 or invalid rows. It is pruned after successful save, record, or clear outcomes
make older owners unable to reappear. It does not retain every ID or raw value
ever observed in the epoch.

The lane object is never copied. Every save, clear, discard, and record task for
that epoch is appended to that same lane. Space switching drains the lane from
outside it.

When a switch completes, the new Space gets a new independent epoch. Late work
from the old epoch may finish against its captured database but cannot update the
new epoch's public state.

### Input

`change(next)` synchronously updates visible content and increments the input
revision.

`next` is always the complete controlled-textarea value, never a character delta.
It is the authoritative content of the active generation, or of the successor
generation when a terminal intent is already pending. The session does not
optimistically clear the textarea when `record()` starts.

- The first nonblank input after an empty or consumed generation allocates a new
  `draftId` with `crypto.randomUUID()`.
- Nonblank content becomes `dirty` and schedules one 500 ms debounced save.
- Blank content schedules a conditional clear on the same lane.
- During a record or discard operation, the first new input starts a successor
  generation. Its first nonblank value allocates a new `draftId`.
- Generation identity is independent from `draftId`. A blank successor has a new
  generation identity but no new `draftId`; its clear task captures the set of
  predecessor owners in the frontier that could have been persisted or queued
  before that revision.
- A completion may update public state only when its epoch, generation, revision,
  and expected content are still current.

There is still exactly one draft slot per Space. If a submitted generation later
fails to record after newer input has started a successor generation, the
successor remains visible. Its lane task retires any captured predecessor owner and,
when nonblank, saves the successor snapshot. Once that persistence succeeds, the
successor replaces the predecessor snapshot. The failed `record()` result still
reports the predecessor failure, but the module does not retain a hidden second
draft or deliberately revive older content over newer accepted input. If the
successor persistence fails, state becomes `failed` and the module makes no false
durability claim. If no successor exists, the failed submitted draft remains
visible and persisted.

### Terminal intent ownership

Each draft generation has at most one terminal intent in flight.

- Repeated `record()` calls for the same generation return the same single-flight
  Promise. Exactly one transaction and one `onRecorded` callback may run.
- Repeated `discard()` calls for the same generation return the same single-flight
  Promise. Exactly one conditional clear may run.
- If discard owns the generation, `record()` returns
  `{ kind: 'busy', operation: 'discard' }` without creating anything.
- If record owns the generation, `discard()` returns
  `{ kind: 'busy', operation: 'record' }` without clearing anything.
- New input during either operation starts a new generation, so terminal ownership
  of the old generation cannot block record or discard on the new draft.
- A failed terminal result releases ownership. Retrying the unchanged generation
  starts one new single-flight operation with the same stable `draftId`. A
  successful record or discard consumes that generation instead.

### Restore

Restore captures the epoch, generation, and input revision before reading.
When the read completes for an active epoch, its v2 ID or raw row owner is added
to the owned-row frontier before any display guard is evaluated. Loaded text is
applied only when:

- the same epoch is still active;
- the input revision is unchanged;
- the visible new-draft state is still blank.

If a valid row fails those guards because a newer revision exists, the session
appends reconciliation for the current revision: save its exact nonblank v2
snapshot, or conditionally clear the owned-row frontier when current content is
blank. This ensures a delayed load cannot leave an undisplayed predecessor to
restore later. Read results for an inactive epoch are observed but do not mutate
state or schedule new work.

Existing-QuickNote editing is separate state and is not an input to this module.
A restore may complete while an existing QuickNote is being edited; it remains in
the independent new-draft session and becomes visible only when that edit exits.

A version 2 row can only represent an active unsubmitted draft. Successful record
deletes the row in the same Dexie transaction that creates the QuickNote and,
under the default configuration, its Outbox event, so there is no post-create
residue to reconcile on load.

### Record

`record()` follows this protocol:

1. Reject blank content with `{ kind: 'empty' }`.
2. Capture epoch, generation, revision, content, and stable `draftId`.
3. Cancel the debounce and append one composite record task to the canonical lane.
4. That task first persists the exact captured snapshot. If this save fails, return
   `failed` and do not start entity creation.
5. Without releasing its place in the lane, the task runs the adapter's
   concrete-DB `record(snapshot)` transaction. Under the default Outbox
   configuration, the transaction creates the QuickNote, enqueues Outbox, and
   deletes the matching settings row atomically. Compatibility modes follow the
   policy described above.
6. If the transaction aborts, return `failed`; its local writes are absent and the
   persisted submitted draft remains until successor reconciliation saves a
   replacement or conditionally clears the single draft slot.
7. If the transaction commits, return the created QuickNote and clear visible
   content only when the captured generation is still current.
8. Release the storage lane after the local transaction settles. Then recheck the
   epoch and synchronously call `onRecorded(note)` to project Store state. A
   callback throw or an already inactive epoch produces `visibility: 'pending'`,
   not a second create.

A projection throw sets public `issue: projection-failed` only if no newer
generation or revision has replaced the recorded operation. The recorded
operation's Promise still returns `visibility: 'pending'` when that guard fails,
but it cannot overwrite a successor generation's issue or save state.

If no newer input arrived, a recorded result clears visible content. If newer
input arrived, its complete controlled value remains visible under its new
generation and is saved after the composite record task on the same lane. The
composite task prevents a new generation save from interleaving between the
submitted snapshot save and its record transaction.

Because entity creation and draft deletion always share one local transaction,
QN-S1.1 has no "created but cleanup pending" data state. The production default
also includes Outbox enqueue in that transaction. A later QuickNote purge cannot
revive the consumed draft because no draft row remains.

### Discard

Discard captures the current generation and the epoch-owned row tokens that could
occupy the settings row at that revision, then performs `clearIfOwned(...)` on
the canonical lane.

- Clear success with no newer generation clears visible content.
- New input during clear returns `superseded`, preserves the new generation, and
  schedules its save.
- Clear failure returns `failed`, preserves visible input, and exposes failed state.

For the internal adapter result, `cleared` and `absent` satisfy cleanup. The
adapter deletes only when the stored v2 ID or exact legacy raw value belongs to
the captured owner set. `different-draft` means an uncaptured newer generation
owns the row and therefore produces `superseded` rather than deleting it. Because
blank and discard tasks are appended immediately, any later nonblank successor
save remains ordered after the clear.

For restore, migration, and invalid-row reconciliation, `different-draft` means a
newer row already won. The stale loaded owner is pruned without reporting a
cleanup failure; the current generation's own durability state remains the source
of truth.

### Space switch

The before-switch listener cancels the debounce and drains from outside the write
lane. It never appends a barrier that waits for work queued behind itself.

The drain algorithm is:

1. capture the active epoch, generation, revision, content, and current lane tail;
2. await that captured tail;
3. if that state is not durably reconciled, append its exact persistence task to
   the lane: save a nonblank snapshot or conditionally clear the captured owned
   row owners for blank content;
4. capture and await the new tail;
5. repeat until generation, revision, content, and the durability marker are
   stable, or until the shared three-second deadline expires.

Input accepted while a captured tail is pending increments revision. The next
outer loop iteration observes it and orders its save or clear after the prior tail
without forming a Promise dependency cycle.

The single lane removes concurrent old/new writes, but `SpaceDBManager` has no
two-phase "sealed then switched" callback. Input arriving after the barrier's
final stable observation and before `onSwitch` is therefore best-effort against
the old concrete database. Closing that narrow acceptance window requires a
manager lifecycle change and is outside QN-S1.1; the module still guarantees its
concrete adapter, default Outbox writer, and public state cannot write through or
update the new Space epoch.

On timeout, Space switching proceeds for availability. The old lane remains bound
to the old concrete database and absorbs all eventual rejections. A permanently
hung IndexedDB operation cannot be cancelled, so the design guarantees isolation
for module-owned/default writes and non-blocking Space B behavior, not guaranteed
persistence of an operation that never settles or isolation of side effects
inside an arbitrary custom hook.

### Pagehide and unmount

These paths request a best-effort flush from the active epoch. The module observes
and catches every resulting promise internally, including promises that remain
pending because IndexedDB never settles. They never update an inactive epoch or
produce unhandled rejections.

## Performance and Resource Bounds

- `change(next)` performs one synchronous state update and timer replacement; it
  does not append one storage task per keystroke.
- Debouncing retains only the latest unsaved revision. Serialization and Dexie
  work are linear in the current draft length.
- Each Space epoch runs at most one storage effect at a time. A timed-out old
  epoch may retain an unresolved promise, but it cannot occupy the new epoch's
  lane or block its input and persistence.
- `record()` adds one exact snapshot save and one local transaction. Store
  projection is synchronous and performs no additional database round trip.

## Error Semantics

Expected failures are represented as save state or tagged method results:

| Failure | Observable result |
| --- | --- |
| Initial read fails | `saveState: 'failed'`; no draft is restored |
| Invalid-row cleanup fails | `saveState: 'failed'`; no rejection escapes |
| Debounced save fails | `saveState: 'failed'`; content remains visible |
| Discard clear fails | `discard(): failed`; content remains visible |
| Pre-record snapshot save fails | `record(): failed`; transaction is not started |
| Record transaction fails | `record(): failed`; default local writes abort; the single-slot successor policy applies |
| Projection throws or epoch is stale | `recorded, visibility: pending`; no duplicate or cross-Space write |
| Switch flush times out | switch proceeds; module-owned/default work cannot affect new state |

Raw error objects and draft contents are not exposed or logged. The implementation
maps expected failures to `QuickNoteDraftIssue` codes; user-facing descriptions
remain the responsibility of the React assembly module.

## Testing Strategy

The `QuickNoteDraftSession` interface is the primary test surface. Existing tests
that assert its behavior through `useQuickNoteEditor` move to the new module where
appropriate; a smaller number of view tests remain to prove wiring and copy.

### Required red-green tests

1. A before-switch flush starts and newer input arrives. A
   `ControlledQuickNoteDraftAdapter` proves the newer write cannot start before
   the older write settles, and the final stored draft is the newer input.
2. Damaged JSON is loaded and its cleanup rejects; no unhandled rejection occurs,
   no bad content is restored, and state becomes failed.
3. Under the default configuration, draft deletion or Outbox enqueue fails inside
   the record transaction; the QuickNote and Outbox are absent and the draft
   remains restorable.
4. The record transaction commits and Store projection throws; record reports
   visibility pending, remount does not restore the draft, and retry cannot create
   a duplicate entity.
5. Input typed while record is pending remains as a new draft generation.
6. Input typed while discard is pending remains and is persisted.
7. A version 1 snapshot restores and is migrated to version 2 with a stable ID.
8. A delayed restore never overwrites input typed after load began.
9. A hung Space A lane times out without blocking Space B save and restore.
10. Late Space A module-owned/default completions never change Space B state.
11. `spaceDBManager.flushBeforeClose()` with a real mounted draft session waits for
    the canonical lane and persists the current revision before database close.
12. Under the default configuration, two `record()` calls for one generation
    share one Promise, one transaction, one Outbox event, and one `onRecorded`
    callback.
13. Conflicting record/discard calls return the documented busy result; the first
    terminal intent wins and the losing intent performs no storage mutation.
14. Default, null, custom, and throwing Outbox hook configurations retain their
    current behavior on the concrete-DB local transaction path.
15. A record fails after newer input starts a successor generation; after its
    reconciliation succeeds, the successor remains visible and persisted, and
    the predecessor is not revived over it.
16. A Space A record commits after its epoch becomes inactive; the synchronous
    Store projection is skipped and Space B Store state is unchanged.
17. `record(A)` is pending, `change('')` creates a blank successor, and A fails;
    after the successor clear succeeds, remount does not restore A.
18. A failed record releases terminal ownership; one explicit retry reuses the
    stable ID and produces one QuickNote and, under the default configuration, one
    Outbox event.
19. A restored v2 draft joins the owned-row frontier and discard removes it.
20. A delayed v2 load returns A after the user has created and then blanked a
    newer revision; reconciliation clears A and remount restores nothing.
21. Delayed invalid-row cleanup runs after a newer valid snapshot is saved; the
    raw owner mismatch preserves the newer snapshot.
22. Space switch invalidates an existing-note edit before repository invocation;
    releasing a queued save afterward cannot write the old edit into Space B.
23. `projectRecordedQuickNote` inserts and same-ID replaces, re-derives current
    query/tag/date visibility, marks lifecycle active and sync pending, and makes
    no repository or database read.
24. One successful active-epoch record invokes the synchronous Store projection
    exactly once and returns `visibility: 'refreshed'`.

### Retained integration coverage

- Under the default configuration, QuickNote create still writes the entity and
  Outbox event.
- QuickNote creation and settings-row deletion commit or abort together.
- Successful record clears the visible draft and does not restore after remount.
- Create failure retains the visible and persisted draft.
- Successful record projects the created note without a repository refresh.
- Logout flush occurs before stores and database are closed.
- Composer status copy reflects restored, dirty, saving, saved, and failed states.

### Release gates

Run from `frontend/`:

```powershell
npm run test -- src/components/quick-notes/use-quick-note-draft-session.test.tsx `
  src/lib/quick-notes/quick-note-draft-repository.test.ts `
  src/lib/quick-notes/quick-note-repository.test.ts `
  src/stores/quick-note-store.test.ts `
  src/components/quick-notes/use-quick-note-editor.test.tsx `
  src/components/quick-notes/quick-notes-view.test.tsx `
  src/services/space-db.test.ts `
  src/lib/logout.test.ts
npm run typecheck
npm run lint
npm test
npm run build
```

Manual smoke must cover:

- type, wait for local save, reload, and restore;
- record, reload, and confirm no old draft returns;
- discard with two-step confirmation and confirm no restore;
- begin existing-note edit and cancel back to the untouched new draft.

Space A/B switching remains a mandatory fake-indexeddb integration scenario. It
is also a manual smoke requirement only when the selected runtime exposes a real
authenticated Space switcher; the single-Space preview fixture is not treated as
evidence for multi-Space behavior.

## Expected File Scope

Expected additions:

- `frontend/src/components/quick-notes/use-quick-note-draft-session.ts`
- `frontend/src/components/quick-notes/use-quick-note-draft-session.test.tsx`

Expected modifications:

- `frontend/src/lib/quick-notes/quick-note-draft-repository.ts`
- `frontend/src/lib/quick-notes/quick-note-draft-repository.test.ts`
- `frontend/src/lib/quick-notes/quick-note-repository.ts`
- `frontend/src/lib/quick-notes/quick-note-repository.test.ts`
- `frontend/src/lib/quick-notes/quick-note-editor-status.ts`
- `frontend/src/stores/quick-note-store.ts`
- `frontend/src/stores/quick-note-store.test.ts`
- `frontend/src/components/quick-notes/quick-note-composer.tsx`
- `frontend/src/components/quick-notes/use-quick-note-editor.ts`
- `frontend/src/components/quick-notes/use-quick-note-editor.test.tsx`
- `frontend/src/components/quick-notes/quick-notes-view.tsx`
- focused view tests only where wiring changes

`QuickNoteDraftSaveState` moves from `quick-note-composer.tsx` to
`quick-note-editor-status.ts` so the session and the composer share a neutral
status type without creating a dependency from the session back into UI rendering.

No backend, sync protocol, Session, Task, Timer, or Schedule files are in scope.

## Acceptance Criteria

QN-S1.1 is complete only when:

1. the external new-draft interface is limited to state plus `change`, `record`,
   and `discard`;
2. there is exactly one canonical write lane per Space epoch and no queue copy;
3. every accepted input is ordered after earlier operations for the same epoch;
4. a successfully recorded draft cannot restore later, even if that QuickNote is
   subsequently purged;
5. Under the production-default hook, QuickNote creation, Outbox enqueue, and
   draft consumption are one concrete-DB transaction with all-or-nothing
   behavior;
6. null and custom Outbox hook compatibility modes retain their documented
   behavior; QuickNote creation and draft consumption remain atomic, and a
   throwing custom hook aborts both local writes;
7. terminal intents are single-flight per generation and conflicting intents have
   deterministic busy outcomes;
8. expected storage failures expose typed issue codes and do not produce unhandled
   rejections;
9. record and discard preserve the complete latest controlled input; after its
   persistence succeeds, no earlier epoch-owned row is restored over it, and
   persistence failure is observable rather than hidden;
10. late old-Space module-owned adapter work, default Outbox writes, and public
    completions cannot update or write through the new Space epoch or project old
    data into the new Space Store; arbitrary custom-hook external effects are
    explicitly outside this guarantee;
11. all required tests, typecheck, lint, full tests, build, and manual smoke pass;
12. the final diff remains inside the declared QuickNote/frontend scope.
