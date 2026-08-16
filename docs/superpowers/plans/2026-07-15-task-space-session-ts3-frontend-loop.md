# Task Space + FocusSession TS3 Frontend Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the local-first PomodoroXII frontend loop for Project and three-level WorkItem planning, paragraph/checklist WorkItemNote v1 editing with dual-version conflict review, durable FocusSession timing and review, application-wide ownership, Space switching, and explicit offline/conflict recovery.

**Architecture:** TS3 consumes the final TS0 generated contracts plus the TS1 Task Space and TS2 FocusSession/ActiveSession REST Adapters. Per-Space Dexie v18 is the local business authority and atomically records local mutations with the S3 outbox identity fields; Meta Dexie mirrors only global locator/device/tab/provisional-operation coordination. Zustand stores remain disposable projections, while repositories, timestamp reconstruction, whole-document CAS, ownership epochs, and forced flushes preserve durable behavior across refresh, Tab, and Space boundaries.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript 5, Dexie 4, Zustand 5, Zod 4, Axios, React Testing Library, Vitest 4, fake-indexeddb, Playwright Chromium, Axe accessibility checks, Tailwind CSS 4, shadcn/base-ui, Lucide icons.

## Global Constraints

- Execute TS3 only after S3, TS0, TS1, and TS2 are merged and their exit gates are green. TS3 consumes their generated OpenAPI and does not recreate backend domain rules.
- S3 owns per-Space Dexie v17 idempotency fields. TS3 owns exactly Dexie v18. Do not declare, reference, test, or implement any later frontend Dexie revision in TS3; expanded S4 owns all post-TS3 transport convergence.
- There is no real legacy Task/Session client data to migrate. Dexie v18 is a breaking cutover performed by one native, exclusive IndexedDB versionchange transaction. After all v17 connections receive `versionchange` and close, the transaction first performs a read-only scan and fails closed if any of `tasks`, `sessions`, `sessionEvents`, `sessionContexts`, `cognitiveMarks`, `taskTags`, `taskRelations`, `focusPatterns`, `taskQuickNotes`, or `sessionQuickNotes` contains a row; if a surviving row/config still owns any removed Task/Session reference (`quickNotes.session_id`, `timeBlocks.task_id`, Reflection task/session link arrays, or report Task/Session filters); or if the old outbox is nonempty. On rejection it aborts before any DDL and leaves the database at v17 with an identical logical inventory. Only a clean scan may apply v18 DDL later in that same exclusive transaction; a separate probe/open sequence is forbidden because it permits a v17-writer TOCTOU race.
- Delete `frontend/src/stores/task-store.ts` and `frontend/src/stores/session-store.ts`. Create `task-space-store.ts` and `focus-session-store.ts`; rewrite `timer-store.ts` as a timestamp-derived global Session projection.
- Do not retain legacy Task/Session table aliases, store exports, route calls, Sync keys, dual reads, dual writes, or conversion code.
- Per-Space Dexie business rows do not repeat `spaceId`. Repository ingress verifies the API `spaceId` against the opened database and strips it before storage. Outbox, conflict, operation, and Meta coordination rows carry `spaceId` explicitly. Every v18 `OutboxEvent` stores its nonoptional owning `spaceId` at creation; S4 may validate that authority but must never infer or backfill it from payload, UI state, or a later database open.
- Runtime Zod schemas validate every Task Space, WorkItemNote, FocusSession, locator, conflict, and receipt response before it enters Dexie or Zustand. Generated `frontend/src/types/api-generated.ts` remains generated-only.
- API/cache views, Outbox command post-images, and authoritative recovery wire snapshots are three independent strict shapes. A FocusSession cache may carry derived `clockState` and local `sessionId`; its command post-image maps `sessionId -> id`, includes `overallProgress`/`mood`, and rejects `clockState`; recovery carries complete `id/spaceId/createdAt/updatedAt/version`, verifies top-level entity identity, then maps `id -> sessionId` and derives `clockState` from timestamps. The four Session child entities retain their real wire `id` even when Dexie uses a different local key.
- Every Task Space and Session write body is camelCase and carries camelCase `payloadHash`, but the hash input is the TS1/TS2 canonical internal command shape with explicit snake_case keys. Each command owns an exhaustive builder; no generic recursive case converter is allowed. Root identity, ownership epoch, and operation-specific CAS fields are excluded. Provisional activation excludes only `cachedOwnershipEpoch` and `expectedWorkItemVersions`; its recursively mapped snapshot, including every nested version fact, remains hashed. Nested review/activation DTOs use explicit schema-specific mappers, while WorkItemNote v1 document values remain camelCase aliases. The digest is SHA-256 over RFC 8785 canonical UTF-8 bytes.
- Frontend RFC 8785 uses exact runtime dependency `json-canonicalize@2.0.0`. S3 owns backend `rfc8785==0.1.4` and the tracked cross-language vectors; S4 consumes and re-verifies this hash contract instead of introducing it.
- Every derived operation ID uses S3 `child-v1`: exact printable-ASCII parent validation, an ASCII allowlisted suffix of 1-512 bytes, injective `childp:<parent-byte-length>:<parent>:<suffix>` while the result is at most 128 bytes, otherwise `childh:<sha256(b"child-v1\0" + uint16be(parent-byte-length) + parent-bytes + suffix-bytes)>`. TS3 copies S3's tracked vector fixture byte-for-byte and never maintains a second hardcoded hash oracle.
- Project create trims and uppercases `key` once before constructing both the camelCase wire object and canonical internal hash payload; mixed-case or surrounding whitespace can never produce different wire/hash values.
- Project-scoped WorkItem reads use the TS0 collection contract `GET /api/v1/work-items?projectId={projectId}`. Do not introduce a `/tree` route; the frontend derives the visible three-level projection from returned `parentId` values.
- WorkItemNote is one aggregate JSON document with `contentVersion: 1`, stable Block/Checklist-item IDs, array ordering, whole-document CAS, exactly `paragraph` and `checklist` Blocks, canonical UTF-8 size at most `128 * 1024` bytes, at most `256` Blocks, and at most `2048` recursively counted Checklist items.
- WorkItemNote Adapters use only TS0's locked paths: replace via `PUT /api/v1/work-items/{id}/note`, append via `POST .../note/append-blocks`, and toggle via `POST .../note/toggle-checklist-item`. Do not add a generic aggregate Note or promotion command route.
- Checklist uses nested `children[]` and supports at most two levels; `parentItemId` is forbidden. Array order is the only order authority. Each Checklist item owns only `itemId`, plain `text`, Boolean `checked`, and `children`. Checklist changes never mutate WorkItem status, FocusSession outcome, validity, effort, or review state.
- Task detail provides complete paragraph/checklist structural editing. Timer renders existing content read-only and may only append a new paragraph or Checklist Block through `appendBlocks`; it cannot replace text, toggle existing items, reorder, indent, or promote. Neither surface persists a pure-text shadow.
- WorkItemNote autosave waits 800 ms after inactivity and performs a local durability flush before blur, current-item change, Session end, Space switch, and logout. A newer edit sequence may never be overwritten by an older response.
- WorkItemNote CAS conflict pauses automatic network dispatch for that WorkItem, persists local and remote documents plus both versions, and offers only reload-remote or reviewed-local overwrite with a new command ID. No automatic Block merge or CRDT is introduced.
- Every WorkItemNote writer serializes the same complete next cached row into exactly `noteId/workItemId/document/version/createdAt/updatedAt`; local conflict metadata never enters the post-image, and overwrite cannot enqueue a three-field partial payload. Its command hash remains exactly `{document}`.
- Timer remaining time is reconstructed from persisted UTC timestamps, pause facts, and planned duration. Do not persist a tick counter or decrement `remaining` as business state.
- `clockState`, `timerCompletion`, `validity`, `reviewState`, and `ownershipState` stay independent. No frontend `status` field may collapse them.
- `/api/v1/active-session` uses `metaApi` and the Master Token. Start, provisional activation, pause, resume, end, heartbeat, takeover, Session-note update, all four running-plan writes, and activation-conflict resolution for an old Space go through that global Adapter; never temporarily replace the current Space token.
- Global start and provisional activation require an explicit user-selected `spaceId` because a Master Token has no current-Space authority. Every locator-bound mutation derives the owning `spaceId`, `sessionId`, strictly positive `ownershipEpoch`, and current owner device/Tab proof from the installed locator. The frontend does not call public Space-scoped running-lifecycle or running-content endpoints. `focusSessionApi` exposes only `get`, `submitReview`, and `reconcileCommands`; reconciliation has exactly `{ commandIds, replaySafe, abandonCommandIds, decisionAt }` as payload and no Session CAS.
- One Tab owns writes. Other Tabs are read-only until explicit takeover increments `ownershipEpoch`; any `stale_session_owner` response immediately fences the stale Tab and refreshes the global locator.
- Space switch is allowed during an active Session. Old-Space Note and Session drafts must flush before the old database closes. Any critical flush rejection aborts the switch and preserves the old Space/token/database.
- Offline formal Project/WorkItem creation remains forbidden. Offline start from cached level-2/level-3 WorkItems creates `local_provisional` with `validity: pending` and a durable Meta operation.
- An unresolved `activation_conflict` preserves both `(spaceId, sessionId)` Sessions, contributes no effort, dispatches no WorkItem command, and requires explicit `active | candidate` role selection. It is locally content-read-only: every Session-note, plan, completion-draft, add/remove-plan, pause/resume/end, and review attempt returns `blocked_conflict` before any business-row or outbox effect. Bare Session ID is never a conflict-selection key because both Spaces may legitimately use the same ID. No record is silently deleted, merged, or selected.
- A successful REST provisional activation consumes only the exact Session/context/initial effective attribution/plan `awaiting_s4` rows absorbed by that activation snapshot, and caches the authoritative aggregate in the same Space Dexie transaction. Any absorbed row that was attempted, has an unknown result, is already synced, or has an unexpected action/state fails closed without deleting the row or partially caching the authoritative aggregate; the conflict branch changes only those pre-conflict rows to `blocked_conflict`. Conflict-time UI actions cannot create or mutate held rows. After resolution, a candidate winner consumes only the receipt-bound pristine blocked snapshot while an active winner preserves the candidate snapshot; no generic conflict-resolution step releases blocked outbox.
- The Space-side activation application and its immutable `SessionActivationApplicationReceiptRow` commit together before the separate Meta operation transition. Restart recovery verifies the receipt's canonical result hash, composite identity, cached version, and absorbed outbox IDs, then idempotently completes Meta/store installation without reconstructing or resending a lost provisional snapshot.
- Session clock terminal facts persist before review and before WorkItem command reconciliation. Note failure, Note conflict, or one failed WorkItem command never rolls back Session time or successful sibling receipts.
- Unknown command results invoke the original-command query/reconciliation endpoint before any replay or abandonment. Replay of the same immutable envelope requires both explicit caller permission and its server-authored `replaySafe=true`; explicit abandonment retains the envelope and appends `abandoned` only when the server finds no existing terminal receipt, while a real terminal result always wins. A user-approved corrected Outcome receives a new command ID. Immutable envelopes are never edited.
- Every reconciliation request persists its root operation ID plus exact ordered query/replay/abandon intent before transport. A timeout/restart reuses that root until its HTTP operation is terminal; the Adapter never invents a random default, and one persisted root can never bind a changed payload.
- Every direct online `createProject`, `createWorkItem`, `moveWorkItem`, `transitionWorkItem`, and `submitReview` command first persists one Space-scoped `DirectCommandIntentRow` with a fixed operation ID, canonical complete request JSON, and request hash. A server commit followed by response loss or restart resends the exact same TS1/TS2/S3 idempotent POST; the returned business cache and terminal intent commit atomically. WorkItemNote continues to use its outbox, ActiveSession continues to recover through its locator/Meta journal, and TS3 does not call or emulate S4 operation-query.
- A Timer append composer persists only a structured `contentVersion: 1` paragraph/checklist draft, never a plain-text Note shadow. Its identity is the explicit `(spaceId, workItemId)` pair. Blur, unmount, current-item change, Space switch, logout, and reopen flush or hydrate that exact key; a successful explicit append clears it and a failed append retains it. A draft from WorkItem A can never append to WorkItem B.
- TS3 may produce final-model outbox events, but it does not claim remote Sync/MCP convergence. Every new row stores one strict canonical UTC RFC3339 `createdAt` string as immutable caller-intent time; no number/`Date` conversion is permitted. New final entity events remain visibly marked `awaiting_s4` until expanded S4 validates and consumes that state into its transport protocol.
- Preserve unrelated dirty and untracked files. Every Task stages only its listed paths.

---

## File Responsibility Map

### Runtime contracts and transport Adapters

- `frontend/src/lib/contracts/task-space.ts`: strict Zod schemas, WorkItemNote v1 invariants, inferred public types, and API-to-Dexie Space assertion.
- `frontend/src/lib/contracts/focus-session.ts`: orthogonal Session axes, immutable envelope/receipt schemas, locator and activation-conflict schemas.
- `frontend/src/services/task-space-api.ts`: Space-scoped TS1 Project/WorkItem/WorkItemNote requests with stable operation IDs.
- `frontend/src/services/focus-session-api.ts`: Space-scoped TS2 read, review, and command-reconciliation requests.
- `frontend/src/services/active-session-api.ts`: Master-scoped TS2 global locator/start/clock/takeover/running-content/provisional-resolution requests.

### Per-Space and Meta persistence

- `frontend/src/services/dexie-v18-schema.ts`: single structured v18 store/key/index definition plus Dexie-string and native-DDL projections.
- `frontend/src/services/dexie-v18-cutover.ts`: native atomic v17-to-v18 scan-before-DDL transaction, stable abort errors, and `openPomodoroXIDB` factory; it consumes the schema module and imports the database class only in this direction.
- `frontend/src/services/database.ts`: Dexie v18 breaking schema, final business tables, Note conflict table, command queue, durable reconciliation attempts, direct-command intents, structured Timer composer drafts, Session review drafts, activation-conflict cache, and activation-application receipts; it does not override Dexie's `open()`.
- `frontend/src/services/meta-database.ts`: Meta Dexie v2 locator/device/tab/provisional-operation mirrors; every provisional root binds its canonical complete start intent/hash and stores no Session business content.
- `frontend/src/lib/sync/types.ts`: final local entity-to-table map and explicit TS3 transport hold set.
- `frontend/src/lib/sync/outbox.ts`: atomic final-entity outbox enqueue that preserves explicit Space plus S3 operation/base-version identity.

### Local-first repositories

- `frontend/src/lib/task-space/task-space-repository.ts`: Project/definition/tree caching and online formal commands.
- `frontend/src/lib/task-space/work-item-note-repository.ts`: local Note CAS, atomic outbox, server dispatch, conflict preservation, and explicit resolution.
- `frontend/src/lib/task-space/note-autosave-controller.ts`: 800 ms sequencing, cancellation, forced local flush, and stale-response suppression.
- `frontend/src/lib/direct-command-intents.ts`: fixed-ID canonical direct-command intent preparation, exact retry, and atomic cache/terminal completion without S4 operation-query.
- `frontend/src/lib/task-space/timer-note-composer-draft-registry.ts`: structured `(spaceId, workItemId)` Timer composer durability and critical flush registration.
- `frontend/src/lib/focus-session/focus-session-repository.ts`: Space aggregate persistence, plans, Session note, review/envelope/receipt cache, and durable command queue.
- `frontend/src/lib/focus-session/session-review-draft-registry.ts`: durable review form plus fixed submit operation identity before direct review transport.
- `frontend/src/lib/focus-session/clock.ts`: pure timestamp reconstruction with no persisted ticks.
- `frontend/src/lib/focus-session/active-session-coordinator.ts`: global locator mirror, owner heartbeat/takeover/fencing, and reconnect activation.
- `frontend/src/lib/focus-session/tab-identity.ts`: stable device ID, session-scoped Tab ID, and Meta tab mirror.

### Zustand projections and lifecycle

- `frontend/src/stores/task-space-store.ts`: selected Project/tree/WorkItem/Note projection over Task Space repositories.
- `frontend/src/stores/focus-session-store.ts`: current-Space Session history/review projection.
- `frontend/src/stores/timer-store.ts`: global active locator, derived clock, ownership mode, and owning-Space identity.
- `frontend/src/stores/index.ts`: separate Space-scoped reset and logout-global reset registries.
- `frontend/src/services/space-db.ts`: fail-fast critical before-switch flush barrier.
- `frontend/src/stores/space-store.ts`: commits target token/Space only after the old-Space flush and database transition succeed.
- `frontend/src/lib/on-space-switch.tsx`: resets only Space-scoped projections and rehydrates the global active locator.
- `frontend/src/lib/logout.ts`: critical flush, global reset, Meta coordination cleanup, and token cleanup ordering.

### Product UI

- `frontend/src/app/(app)/tasks/page.tsx`: real Task Space workbench.
- `frontend/src/app/(app)/timer/page.tsx`: real Session launcher/running/review surface.
- `frontend/src/components/task-space/project-rail.tsx`: Project selection and online creation.
- `frontend/src/components/task-space/work-item-tree.tsx`: accessible three-level tree and level-aware creation.
- `frontend/src/components/task-space/work-item-detail.tsx`: status/read model and complete Note editor host.
- `frontend/src/components/task-space/work-item-note-editor.tsx`: paragraph/checklist structural editor.
- `frontend/src/components/task-space/note-block-editor.tsx`: paragraph fields and two-level Checklist items.
- `frontend/src/components/task-space/note-conflict-panel.tsx`: side-by-side preserved versions and explicit resolution.
- `frontend/src/components/timer/session-launcher.tsx`: level-2 attribution and same-parent level-3 planning.
- `frontend/src/components/timer/session-clock.tsx`: timestamp-derived clock and owner-aware controls.
- `frontend/src/components/timer/session-workspace.tsx`: current level-3 item, completion drafts, compact WorkItemNote, and Session note.
- `frontend/src/components/timer/session-review.tsx`: Outcome review and immutable command receipt status.
- `frontend/src/components/timer/global-active-session-bar.tsx`: old-Space locator, return action, read-only/takeover state.
- `frontend/src/components/timer/activation-conflict-dialog.tsx`: explicit winner selection preserving both records.

### Verification

- `frontend/playwright.config.ts`: isolated Chromium desktop/mobile projects.
- `frontend/e2e/support/mock-task-space-backend.ts`: stateful generated-contract HTTP fixture.
- `frontend/e2e/task-space-session.spec.ts`: complete P0 product flow, refresh, Tab, Space, offline, conflict, and partial-receipt checks.
- `frontend/scripts/verify-ts3-boundaries.mjs`: old-surface absence, Dexie numbering, token-switch ban, and S4 boundary checks.
- `docs/task-space-design/analysis/ts3-exit-report.md`: generated gate evidence that explicitly remains pending S4 parity.

---

### Task 1: Lock Runtime Contracts And Scope-Correct Transport Adapters

**Files:**
- Create: `frontend/src/lib/contracts/task-space.ts`
- Create: `frontend/src/lib/contracts/task-space.test.ts`
- Create: `frontend/src/lib/contracts/focus-session.ts`
- Create: `frontend/src/lib/contracts/focus-session.test.ts`
- Create: `frontend/src/lib/contracts/payload-hash.ts`
- Create: `frontend/src/lib/contracts/payload-hash.test.ts`
- Create: `frontend/src/lib/contracts/fixtures/task-space-session-payload-hash-vectors.json`
- Modify: `frontend/package.json`
- Modify: `frontend/package-lock.json`
- Create: `frontend/src/services/task-space-api.ts`
- Create: `frontend/src/services/task-space-api.test.ts`
- Create: `frontend/src/services/focus-session-api.ts`
- Create: `frontend/src/services/focus-session-api.test.ts`
- Create: `frontend/src/services/active-session-api.ts`
- Create: `frontend/src/services/active-session-api.test.ts`
- Consume unchanged: `frontend/openapi.json`
- Consume unchanged: `frontend/src/types/api-generated.ts`
- Consume unchanged: `frontend/src/services/api.ts`
- Consume unchanged: `backend/tests/fixtures/task_space_session_payload_hash_vectors.json`

**Interfaces:**
- Consumes: generated `ProjectResponse`, `TaskDefinitionSetResponse`, `WorkItemResponse`, `WorkItemNoteResponse`, `FocusSessionAggregateResponse`, `SessionReviewResponse`, `SessionCommandReceiptResponse`, `ActiveSessionResponse`, and TS1/TS2 request schemas; `spaceApi`; `metaApi`; S3 `Idempotency-Key`; tracked cross-language payload-hash vectors.
- Produces: `hashCommandPayload`, `buildCommandFields`, byte-identical frontend vector copy, `parseProject`, `parseDefinitions`, `parseWorkItem`, `parseWorkItemNote`, `parseFocusSession`, `parseActiveSession`, `assertResponseSpace`; `taskSpaceApi`, `focusSessionApi`, and `activeSessionApi` with camelCase `payloadHash`, parsed return values, and no token mutation.

- [ ] **Step 1: Pin RFC 8785 and copy the tracked TS0 vectors byte-for-byte**

Run from `frontend/`:

```powershell
npm install --save-exact json-canonicalize@2.0.0
Copy-Item -LiteralPath '..\backend\tests\fixtures\task_space_session_payload_hash_vectors.json' -Destination 'src\lib\contracts\fixtures\task-space-session-payload-hash-vectors.json'
$backendHash = (Get-FileHash -Algorithm SHA256 '..\backend\tests\fixtures\task_space_session_payload_hash_vectors.json').Hash
$frontendHash = (Get-FileHash -Algorithm SHA256 'src\lib\contracts\fixtures\task-space-session-payload-hash-vectors.json').Hash
if ($backendHash -ne $frontendHash) { throw 'payload hash vector copy differs' }
```

Expected: `package.json` contains exactly `"json-canonicalize": "2.0.0"`; the lock resolves `2.0.0`; backend and frontend fixture SHA-256 values are identical.

- [ ] **Step 2: Write failing RFC 8785 vector and identity-exclusion tests**

```typescript
// frontend/src/lib/contracts/payload-hash.test.ts
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import vectors from './fixtures/task-space-session-payload-hash-vectors.json'
import { buildCommandFields, hashCommandPayload } from './payload-hash'

it.each(vectors.cases)('matches cross-language RFC 8785 vector $name', async (vector) => {
  expect(await hashCommandPayload(vector.payload)).toBe(vector.sha256)
})

it('keeps the tracked frontend copy byte-identical to the backend authority', () => {
  const backend = readFileSync('../backend/tests/fixtures/task_space_session_payload_hash_vectors.json')
  const frontend = readFileSync('src/lib/contracts/fixtures/task-space-session-payload-hash-vectors.json')
  expect(createHash('sha256').update(frontend).digest('hex'))
    .toBe(createHash('sha256').update(backend).digest('hex'))
})

it('hashes only command-specific business payload', async () => {
  const business = { document: { contentVersion: 1, blocks: [] } }
  const first = await buildCommandFields({
    commandId: 'cmd-a', spaceId: 'space-a', targetId: 'wi-a',
    expectedVersion: 2, ownershipEpoch: 4, payload: business,
  })
  const second = await buildCommandFields({
    commandId: 'cmd-b', spaceId: 'space-b', targetId: 'wi-b',
    expectedVersion: 9, ownershipEpoch: 8, payload: business,
  })
  expect(first.payloadHash).toBe(second.payloadHash)
  expect(first.payloadHash).toMatch(/^[0-9a-f]{64}$/)
})
```

Expected at this point: FAIL because `payload-hash.ts` does not exist.

- [ ] **Step 3: Write failing WorkItemNote runtime-contract tests**

```typescript
// frontend/src/lib/contracts/task-space.test.ts
import { describe, expect, it } from 'vitest'
import { canonicalize } from 'json-canonicalize'
import {
  MAX_NOTE_BLOCKS, MAX_NOTE_DOCUMENT_BYTES, MAX_NOTE_ITEMS,
  workItemNoteDocumentSchema,
} from './task-space'

const valid = {
  contentVersion: 1,
  blocks: [
    { type: 'paragraph', blockId: 'p-1', text: 'Context' },
    {
      type: 'checklist', blockId: 'cl-1', items: [
        { itemId: 'i-1', text: 'Ship', checked: false, children: [
          { itemId: 'i-2', text: 'Verify', checked: false, children: [] },
        ] },
      ],
    },
  ],
}

const canonicalBytes = (value: unknown) =>
  new TextEncoder().encode(canonicalize(value)!).byteLength

function documentAtCanonicalByteLimit() {
  const blocks = Array.from({ length: 14 }, (_, index) => ({
    type: 'paragraph' as const,
    blockId: `size-${index}`,
    text: index < 13 ? 'x'.repeat(9_500) : '',
  }))
  const document = { contentVersion: 1 as const, blocks }
  const remaining = MAX_NOTE_DOCUMENT_BYTES - canonicalBytes(document)
  if (remaining < 0 || remaining > 10_000) throw new Error('invalid byte fixture')
  blocks.at(-1)!.text = 'x'.repeat(remaining)
  return document
}

describe('WorkItemNote document v1', () => {
  it('accepts exactly paragraph and checklist Blocks', () => {
    expect(workItemNoteDocumentSchema.parse(valid)).toEqual(valid)
  })

  it('rejects duplicate IDs and a third Checklist level', () => {
    const duplicate = structuredClone(valid)
    duplicate.blocks[1]!.blockId = 'p-1'
    expect(() => workItemNoteDocumentSchema.parse(duplicate)).toThrow(/unique/i)

    const deep = structuredClone(valid)
    const checklist = deep.blocks[1] as {
      items: Array<{ children: Array<{ children: unknown[] }> }>
    }
    checklist.items[0]!.children[0]!.children.push({
      itemId: 'i-3', text: 'Too deep', checked: false, children: [],
    })
    expect(() => workItemNoteDocumentSchema.parse(deep)).toThrow(/two levels/i)
  })

  it('rejects richer Blocks and WorkItem-reference Checklist items', () => {
    for (const block of [
      { type: 'heading', blockId: 'h-1', level: 2, text: 'No' },
      { type: 'ordered_list', blockId: 'o-1', items: [] },
      { type: 'unordered_list', blockId: 'u-1', items: [] },
    ]) {
      expect(() => workItemNoteDocumentSchema.parse({
        contentVersion: 1, blocks: [block],
      })).toThrow()
    }
    const referenced = structuredClone(valid)
    const checklist = referenced.blocks[1] as { items: Array<Record<string, unknown>> }
    checklist.items[0] = {
      kind: 'work_item_ref', itemId: 'i-1', workItemId: 'wi-1',
      titleSnapshot: 'Created', checked: false, children: [],
    }
    expect(() => workItemNoteDocumentSchema.parse(referenced)).toThrow()
  })

  it('locks the 256-Block and recursively counted 2048-Checklist-item boundaries', () => {
    const blocksAtLimit = {
      contentVersion: 1 as const,
      blocks: Array.from({ length: MAX_NOTE_BLOCKS }, (_, index) => ({
        type: 'paragraph' as const, blockId: `p-${index}`, text: '',
      })),
    }
    expect(workItemNoteDocumentSchema.parse(blocksAtLimit)).toEqual(blocksAtLimit)
    expect(() => workItemNoteDocumentSchema.parse({
      ...blocksAtLimit,
      blocks: [...blocksAtLimit.blocks, { type: 'paragraph', blockId: 'overflow', text: '' }],
    })).toThrow(/256|block/i)

    const items = Array.from({ length: MAX_NOTE_ITEMS - 1 }, (_, index) => ({
      itemId: `i${index.toString(36)}`, text: 'x', checked: false, children: [],
    }))
    items[0]!.children.push({
      itemId: 'nested-limit', text: 'x', checked: false, children: [],
    } as never)
    const itemsAtLimit = {
      contentVersion: 1 as const,
      blocks: [{ type: 'checklist' as const, blockId: 'wide', items }],
    }
    expect(workItemNoteDocumentSchema.parse(itemsAtLimit)).toEqual(itemsAtLimit)
    const tooManyItems = structuredClone(itemsAtLimit)
    tooManyItems.blocks[0]!.items[1]!.children.push({
      itemId: 'nested-overflow', text: 'x', checked: false, children: [],
    } as never)
    expect(() => workItemNoteDocumentSchema.parse(tooManyItems)).toThrow(/item count/i)
  })

  it('accepts exactly 128 KiB of canonical UTF-8 and rejects the next byte', () => {
    const atLimit = documentAtCanonicalByteLimit()
    expect(canonicalBytes(atLimit)).toBe(MAX_NOTE_DOCUMENT_BYTES)
    expect(workItemNoteDocumentSchema.parse(atLimit)).toEqual(atLimit)
    const tooLarge = structuredClone(atLimit)
    tooLarge.blocks.at(-1)!.text += 'x'
    expect(() => workItemNoteDocumentSchema.parse(tooLarge)).toThrow(/byte limit/i)
  })

  it('rejects persisted Checklist items whose trimmed text is empty', () => {
    const blank = structuredClone(valid)
    const checklist = blank.blocks[1] as { items: Array<{ text: string }> }
    checklist.items[0]!.text = ' \t '
    expect(() => workItemNoteDocumentSchema.parse(blank)).toThrow(/nonblank/i)
  })
})
```

- [ ] **Step 4: Write failing FocusSession, locator, and API-scope tests**

```typescript
// frontend/src/lib/contracts/focus-session.test.ts
import { describe, expect, it } from 'vitest'
import {
  activateProvisionalPayloadSchema, activeSessionLocatorSchema, addPlanItemRequestSchema,
  endActiveSessionRequestSchema, heartbeatRequestSchema, pauseActiveSessionRequestSchema,
  reconcileFocusSessionCommandsPayloadSchema,
  removePlanItemRequestSchema, resolveActivationConflictRequestSchema,
  resumeActiveSessionRequestSchema, setCompletionDraftRequestSchema,
  setCurrentPlanItemRequestSchema, takeoverRequestSchema,
  updateActiveSessionNoteRequestSchema, focusSessionAggregateSchema,
  focusSessionCommandPostImageSchema, focusSessionRecoveryWireSchema,
  projectFocusSessionRecoveryWireToCache,
} from './focus-session'

const aggregateFor = (spaceId: string, sessionId: string) => ({
  session: {
    id: sessionId, spaceId, sessionRevision: 3,
    startedAt: '2026-07-15T08:00:00Z', endedAt: null, pauseStartedAt: null,
    plannedSeconds: 1500, grossSeconds: 600, pausedSeconds: 0,
    breakSeconds: 0, focusedSeconds: 600, clockState: 'running',
    timerCompletion: null, validity: 'pending', validityReason: null,
    overallProgress: null, mood: null,
    reviewState: 'not_required', ownershipState: 'local_provisional',
    sessionNote: '', version: 2, createdAt: '2026-07-15T08:00:00Z',
    updatedAt: '2026-07-15T08:10:00Z',
  },
  context: null,
  attribution: {
    id: 'attr-1', spaceId, sessionId, revision: 1, projectId: 'project-1',
    level2WorkItemId: 'l2', reason: null, correctedFromRevision: null,
    effective: true, createdAt: '2026-07-15T08:00:00Z',
    updatedAt: '2026-07-15T08:00:00Z', version: 1,
  },
  plan: [], outcomes: [], commandEnvelopes: [], commandReceipts: [],
})

const validProvisionalPayload = () => ({
  cachedAt: '2026-07-15T08:05:00Z', cachedOwnershipEpoch: null,
  ownerDeviceId: 'device-a', ownerTabId: 'tab-a',
  snapshot: {
    session: {
      sessionRevision: 0, startedAt: '2026-07-15T08:00:00Z', pauseStartedAt: null,
      plannedSeconds: 1500, grossSeconds: 300, pausedSeconds: 0,
      breakSeconds: 0, focusedSeconds: 300, validity: 'pending', validityReason: null,
      reviewState: 'not_required', ownershipState: 'local_provisional', sessionNote: '',
    },
    context: {
      projectId: 'project-a', projectTitleSnapshot: 'Project A', level2WorkItemId: 'l2-a',
      level2TitleSnapshot: 'Deliver A', level2ParentIdSnapshot: 'l1-a',
      level2StatusDefinitionIdSnapshot: 'status-progress', level2VersionSnapshot: 4,
      level2EffortLowerSecondsSnapshot: 1200, level2EffortUpperSecondsSnapshot: 2400,
      linkedAt: '2026-07-15T08:00:00Z', linkMethod: 'explicit',
    },
    plan: [],
  },
  expectedWorkItemVersions: { 'l2-a': 4 },
})

const owner = { ownerDeviceId: 'device-a', ownerTabId: 'tab-a' }
const root = {
  commandId: 'cmd-a', sessionId: 'fs-a', ownershipEpoch: 1,
  payloadHash: 'a'.repeat(64),
}
const locatorRequests = [
  { schema: activeSessionLocatorSchema, body: {
    spaceId: 'space-a', sessionId: 'fs-a', operationId: 'op-a', state: 'active',
    ownerDeviceId: 'device-a', ownerTabId: 'tab-a', ownershipEpoch: 1,
    leaseExpiresAt: '2026-07-15T08:02:00Z', updatedAt: '2026-07-15T08:01:00Z',
  } },
  { schema: heartbeatRequestSchema, body: { ...root, payload: {
    ...owner, heartbeatAt: '2026-07-15T08:01:00Z',
  } } },
  { schema: pauseActiveSessionRequestSchema, body: { ...root, payload: {
    expectedVersion: 1, occurredAt: '2026-07-15T08:01:00Z', ...owner,
  } } },
  { schema: resumeActiveSessionRequestSchema, body: { ...root, payload: {
    expectedVersion: 1, occurredAt: '2026-07-15T08:01:00Z', ...owner,
  } } },
  { schema: endActiveSessionRequestSchema, body: { ...root, payload: {
    expectedVersion: 1, occurredAt: '2026-07-15T08:01:00Z', ...owner,
    timerCompletion: 'ended_early', validity: 'pending', validityReason: null,
  } } },
  { schema: takeoverRequestSchema, body: { ...root, payload: {
    newOwnerDeviceId: 'device-b', newOwnerTabId: 'tab-b',
  } } },
  { schema: updateActiveSessionNoteRequestSchema, body: { ...root, payload: {
    expectedVersion: 1, sessionNote: 'Note', ...owner,
  } } },
  { schema: setCurrentPlanItemRequestSchema, body: { ...root, payload: {
    workItemId: null, expectedPlanVersions: { 'plan-a': 1 }, ...owner,
  } } },
  { schema: setCompletionDraftRequestSchema, body: { ...root, payload: {
    planItemId: 'plan-a', expectedPlanVersion: 1, completionDraft: true, ...owner,
  } } },
  { schema: addPlanItemRequestSchema, body: { ...root, payload: {
    workItemId: 'l3-a', expectedWorkItemVersion: 1, planRank: 1,
    addedAt: '2026-07-15T08:01:00Z', ...owner,
  } } },
  { schema: removePlanItemRequestSchema, body: { ...root, payload: {
    planItemId: 'plan-a', expectedPlanVersion: 1,
    removedAt: '2026-07-15T08:01:00Z', removalReason: 'Replanned', ...owner,
  } } },
  { schema: resolveActivationConflictRequestSchema, body: { ...root, payload: {
    winnerRole: 'candidate',
    decisionAt: '2026-07-15T08:01:00Z', validityCorrection: {
      loserValidity: 'invalid', loserValidityReason: 'activation_conflict_loser',
    },
  } } },
] as const

describe('FocusSession axes', () => {
  it('keeps clock, completion, validity, review, and ownership independent', () => {
    const aggregate = focusSessionAggregateSchema.parse(aggregateFor('space-a', 'fs-1'))
    expect(aggregate.session.clockState).toBe('running')
    expect(aggregate.session.ownershipState).toBe('local_provisional')
    expect(aggregate.session.validity).toBe('pending')
  })

  it('separates cache view, command post-image, and authoritative recovery wire', () => {
    const view = focusSessionAggregateSchema.parse(
      aggregateFor('space-a', 'fs-1'),
    ).session
    const { spaceId: _space, clockState: _clock, ...postImage } = view
    expect(focusSessionCommandPostImageSchema.parse(postImage)).toMatchObject({
      id: 'fs-1', overallProgress: null, mood: null,
    })
    expect(focusSessionCommandPostImageSchema.safeParse({
      ...postImage, clockState: 'running',
    }).success).toBe(false)
    const { clockState: _derived, ...recoveryWire } = view
    expect(focusSessionRecoveryWireSchema.parse(recoveryWire).id).toBe('fs-1')
    expect(projectFocusSessionRecoveryWireToCache(recoveryWire)).toMatchObject({
      sessionId: 'fs-1', clockState: 'running',
    })
  })

  it.each([0, true, 1.5])('rejects locator epoch %p for every owned action', (epoch) => {
    for (const { schema, body } of locatorRequests) {
      expect(schema.safeParse({ ...body, ownershipEpoch: epoch }).success).toBe(false)
    }
  })

  it.each([0, true, 1.5])('rejects cached provisional epoch %p', (epoch) => {
    expect(activateProvisionalPayloadSchema.safeParse({
      ...validProvisionalPayload(), cachedOwnershipEpoch: epoch,
    }).success).toBe(false)
  })

  it('rejects review-materialized plan rows from a provisional activation snapshot', () => {
    const payload = validProvisionalPayload()
    payload.snapshot.plan[0]!.source = 'review_materialized' as never
    expect(activateProvisionalPayloadSchema.safeParse(payload).success).toBe(false)
  })

  it.each([
    { commandIds: ['cmd-a'], replaySafe: false,
      abandonCommandIds: ['cmd-b'], decisionAt: '2026-07-15T08:00:00Z' },
    { commandIds: ['cmd-a'], replaySafe: false,
      abandonCommandIds: ['cmd-a', 'cmd-a'], decisionAt: '2026-07-15T08:00:00Z' },
    { commandIds: ['cmd-a'], replaySafe: false,
      abandonCommandIds: ['cmd-a'], decisionAt: null },
    { commandIds: ['cmd-a'], replaySafe: false,
      abandonCommandIds: [], decisionAt: '2026-07-15T08:00:00Z' },
  ])('rejects malformed command abandonment %#', (payload) => {
    expect(reconcileFocusSessionCommandsPayloadSchema.safeParse(payload).success).toBe(false)
  })
})
```

```typescript
// frontend/src/services/active-session-api.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { metaApi, spaceApi } from './api'
import { activeSessionApi, activateProvisionalHashPayload } from './active-session-api'
import { hashCommandPayload } from '@/lib/contracts/payload-hash'

vi.mock('./api', () => ({
  metaApi: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
  spaceApi: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
}))

const aggregateFor = (spaceId: string, sessionId: string) => ({
  session: {
    id: sessionId, spaceId, sessionRevision: 1,
    startedAt: '2026-07-15T08:00:00Z', endedAt: null, pauseStartedAt: null,
    plannedSeconds: 1500, grossSeconds: 0, pausedSeconds: 0,
    breakSeconds: 0, focusedSeconds: 0, clockState: 'running',
    timerCompletion: null, validity: 'pending', validityReason: null,
    reviewState: 'not_required', ownershipState: 'authoritative',
    sessionNote: '', version: 1,
  },
  context: null,
  attribution: {
    id: 'attr-1', sessionId, revision: 1, projectId: 'project-1',
    level2WorkItemId: 'l2', reason: null, correctedFromRevision: null,
    effective: true, createdAt: '2026-07-15T08:00:00Z',
  },
  plan: [], outcomes: [], commandEnvelopes: [], commandReceipts: [],
})

const activeSessionResponse = () => ({
  spaceId: 'space-old', sessionId: 'fs-1', operationId: 'content-op',
  state: 'active', ownerDeviceId: 'device-1', ownerTabId: 'tab-1',
  ownershipEpoch: 4, leaseExpiresAt: '2026-07-15T08:01:00Z',
  updatedAt: '2026-07-15T08:00:00Z', session: aggregateFor('space-old', 'fs-1'),
})

const terminalAggregateFor = (spaceId: string, sessionId: string) => {
  const aggregate = aggregateFor(spaceId, sessionId)
  return { ...aggregate, session: {
    ...aggregate.session, endedAt: '2026-07-15T08:10:00Z', clockState: 'ended' as const,
    timerCompletion: 'ended_early' as const, grossSeconds: 600, focusedSeconds: 600,
  } }
}

const provisionalActivationPayload = () => ({
  cachedAt: '2026-07-15T08:05:00Z', cachedOwnershipEpoch: null,
  ownerDeviceId: 'device-1', ownerTabId: 'tab-1',
  snapshot: {
    session: {
      sessionRevision: 0, startedAt: '2026-07-15T08:00:00Z', pauseStartedAt: null,
      plannedSeconds: 1500, grossSeconds: 300, pausedSeconds: 0,
      breakSeconds: 0, focusedSeconds: 300, validity: 'pending' as const,
      validityReason: null, reviewState: 'not_required' as const,
      ownershipState: 'local_provisional' as const, sessionNote: '',
    },
    context: {
      projectId: 'project-1', projectTitleSnapshot: 'Project', level2WorkItemId: 'l2',
      level2TitleSnapshot: 'Deliver', level2ParentIdSnapshot: 'l1',
      level2StatusDefinitionIdSnapshot: 'status-progress', level2VersionSnapshot: 4,
      level2EffortLowerSecondsSnapshot: 1200, level2EffortUpperSecondsSnapshot: 2400,
      linkedAt: '2026-07-15T08:00:00Z', linkMethod: 'explicit' as const,
    },
    plan: [{
      id: 'plan-1', workItemId: 'l3', titleSnapshot: 'Verify',
      level2WorkItemIdSnapshot: 'l2', workItemVersionSnapshot: 2, planRank: 0,
      source: 'before_start' as const, addedAt: '2026-07-15T08:00:00Z',
      removedAt: null, removalReason: null, currentDuringSession: true,
      completionDraft: false,
    }],
  },
  expectedWorkItemVersions: { l2: 4, l3: 2 },
})

async function invokeRunningContent(api: typeof activeSessionApi, method: string) {
  const owner = {
    sessionId: 'fs-1', operationId: `${method}-1`, ownershipEpoch: 4,
    ownerDeviceId: 'device-1', ownerTabId: 'tab-1',
  }
  if (method === 'updateNote') {
    return api.updateNote({ ...owner, expectedVersion: 1, sessionNote: 'Observed' })
  }
  if (method === 'setCurrentPlanItem') {
    return api.setCurrentPlanItem({
      ...owner, workItemId: 'l3', expectedPlanVersions: { 'plan-1': 1 },
    })
  }
  if (method === 'setCompletionDraft') {
    return api.setCompletionDraft({
      ...owner, planItemId: 'plan-1', expectedPlanVersion: 1, completionDraft: true,
    })
  }
  if (method === 'addPlanItem') {
    return api.addPlanItem({
      ...owner, workItemId: 'l3', expectedWorkItemVersion: 2,
      planRank: 1, addedAt: '2026-07-15T08:05:00Z',
    })
  }
  return api.removePlanItem({
    ...owner, planItemId: 'plan-1', expectedPlanVersion: 1,
    removedAt: '2026-07-15T08:05:00Z', removalReason: 'Replanned',
  })
}

describe('activeSessionApi', () => {
  beforeEach(() => vi.clearAllMocks())

  it('parses unresolved conflict from locate without dropping the candidate', async () => {
    const conflict = {
      kind: 'activation_conflict',
      active: activeSessionResponse(),
      candidate: {
        spaceId: 'space-offline', sessionId: 'offline-1',
        session: aggregateFor('space-offline', 'offline-1'),
      },
    }
    vi.mocked(metaApi.get).mockResolvedValue({ data: conflict })
    await expect(activeSessionApi.locate()).resolves.toEqual(conflict)
  })

  it('requires explicit target spaceId on master-scoped start', async () => {
    vi.mocked(metaApi.post).mockResolvedValue({ data: {
      spaceId: 'space-target', sessionId: 'fs-start', operationId: 'start-1',
      state: 'active', ownerDeviceId: 'device-1', ownerTabId: 'tab-1',
      ownershipEpoch: 1, leaseExpiresAt: '2026-07-15T08:01:00Z',
      updatedAt: '2026-07-15T08:00:00Z', session: aggregateFor('space-target', 'fs-start'),
    } })
    await activeSessionApi.start({
      spaceId: 'space-target', sessionId: 'fs-start', operationId: 'start-1',
      level2WorkItemId: 'l2', level3WorkItemIds: [], plannedSeconds: 1500,
      startedAt: '2026-07-15T08:00:00Z', ownerDeviceId: 'device-1',
      ownerTabId: 'tab-1', expectedWorkItemVersions: { l2: 4 },
    })
    const expectedHash = await hashCommandPayload({
      level2_work_item_id: 'l2', level3_work_item_ids: [], planned_seconds: 1500,
      started_at: '2026-07-15T08:00:00Z', owner_device_id: 'device-1',
      owner_tab_id: 'tab-1',
    })
    expect(metaApi.post).toHaveBeenCalledWith(
      '/active-session/start', expect.objectContaining({
        commandId: 'start-1', spaceId: 'space-target',
        ownershipEpoch: null, payloadHash: expectedHash,
        payload: expect.objectContaining({
          level2WorkItemId: 'l2', expectedWorkItemVersions: { l2: 4 },
        }),
      }),
      { headers: { 'Idempotency-Key': 'start-1' } },
    )
  })

  it('uses only the master-scoped client for an old-Space pause', async () => {
    vi.mocked(metaApi.post).mockResolvedValue({ data: {
      spaceId: 'space-old', sessionId: 'fs-1', operationId: 'start-1',
      state: 'active', ownerDeviceId: 'device-1', ownerTabId: 'tab-1',
      ownershipEpoch: 4, leaseExpiresAt: '2026-07-15T08:01:00Z',
      updatedAt: '2026-07-15T08:00:00Z', session: aggregateFor('space-old', 'fs-1'),
    } })
    await activeSessionApi.pause({
      sessionId: 'fs-1', operationId: 'pause-1',
      ownershipEpoch: 4, expectedVersion: 2, occurredAt: '2026-07-15T08:00:30Z',
      ownerDeviceId: 'device-1', ownerTabId: 'tab-1',
    })
    expect(metaApi.post).toHaveBeenCalledWith(
      '/active-session/pause', expect.objectContaining({
        commandId: 'pause-1', sessionId: 'fs-1', ownershipEpoch: 4,
        payload: expect.objectContaining({
          expectedVersion: 2, occurredAt: '2026-07-15T08:00:30Z',
          ownerDeviceId: 'device-1', ownerTabId: 'tab-1',
        }),
      }),
      { headers: { 'Idempotency-Key': 'pause-1' } },
    )
    const pauseBody = vi.mocked(metaApi.post).mock.calls[0]![1] as Record<string, unknown>
    expect(pauseBody.payloadHash).toBe(await hashCommandPayload({
      occurred_at: '2026-07-15T08:00:30Z',
      owner_device_id: 'device-1', owner_tab_id: 'tab-1',
    }))
    expect(vi.mocked(metaApi.post).mock.calls[0]![1]).not.toHaveProperty('spaceId')
    expect(spaceApi.post).not.toHaveBeenCalled()
  })

  it('accepts only the locator-only heartbeat response', async () => {
    const locatorOnly = {
      spaceId: 'space-old', sessionId: 'fs-1', operationId: 'heartbeat-1',
      state: 'active', ownerDeviceId: 'device-1', ownerTabId: 'tab-1',
      ownershipEpoch: 4, leaseExpiresAt: '2026-07-15T08:02:00Z',
      updatedAt: '2026-07-15T08:01:00Z',
    }
    vi.mocked(metaApi.post).mockResolvedValueOnce({ data: {
      ...locatorOnly, session: aggregateFor('space-old', 'fs-1'),
    } })
    const input = {
      sessionId: 'fs-1', operationId: 'heartbeat-1', ownershipEpoch: 4,
      ownerDeviceId: 'device-1', ownerTabId: 'tab-1', heartbeatAt: '2026-07-15T08:01:00Z',
    }
    await expect(activeSessionApi.heartbeat(input)).rejects.toThrow()
    vi.mocked(metaApi.post).mockResolvedValueOnce({ data: locatorOnly })
    await expect(activeSessionApi.heartbeat(input)).resolves.toEqual(locatorOnly)
  })

  it('hashes resume and end with current owner proof while excluding Session CAS', async () => {
    vi.mocked(metaApi.post)
      .mockResolvedValueOnce({ data: activeSessionResponse() })
      .mockResolvedValueOnce({ data: {
        session: terminalAggregateFor('space-old', 'fs-1'), locator: null,
      } })
    const owner = {
      sessionId: 'fs-1', ownershipEpoch: 4,
      ownerDeviceId: 'device-1', ownerTabId: 'tab-1',
    }
    await activeSessionApi.resume({
      ...owner, operationId: 'resume-1', expectedVersion: 2,
      occurredAt: '2026-07-15T08:09:00Z',
    })
    await activeSessionApi.end({
      ...owner, operationId: 'end-1', expectedVersion: 3,
      occurredAt: '2026-07-15T08:10:00Z', timerCompletion: 'ended_early',
      validity: 'pending', validityReason: null,
    })
    const resumeBody = vi.mocked(metaApi.post).mock.calls
      .find(([path]) => path === '/active-session/resume')![1] as Record<string, unknown>
    expect(resumeBody.payloadHash).toBe(await hashCommandPayload({
      occurred_at: '2026-07-15T08:09:00Z',
      owner_device_id: 'device-1', owner_tab_id: 'tab-1',
    }))
    const endBody = vi.mocked(metaApi.post).mock.calls
      .find(([path]) => path === '/active-session/end')![1] as Record<string, unknown>
    expect(endBody.payloadHash).toBe(await hashCommandPayload({
      occurred_at: '2026-07-15T08:10:00Z', timer_completion: 'ended_early',
      validity: 'pending', validity_reason: null,
      owner_device_id: 'device-1', owner_tab_id: 'tab-1',
    }))
  })

  it('hashes the persisted conflict winner role with an internal snake_case key', async () => {
    vi.mocked(metaApi.post).mockResolvedValue({ data: {
      kind: 'authoritative', spaceId: 'space-offline', sessionId: 'offline-1',
      operationId: 'resolve-1', state: 'active', ownerDeviceId: 'device-1',
      ownerTabId: 'tab-1', ownershipEpoch: 5,
      leaseExpiresAt: '2026-07-15T08:01:00Z', updatedAt: '2026-07-15T08:00:00Z',
      session: aggregateFor('space-offline', 'offline-1'),
    } })
    await activeSessionApi.resolveActivationConflict({
      sessionId: 'online-1', operationId: 'resolve-1', ownershipEpoch: 4,
      winnerRole: 'candidate',
      decisionAt: '2026-07-15T08:00:45Z', validityCorrection: {
        loserValidity: 'invalid', loserValidityReason: 'activation_conflict_loser',
      },
    })
    const body = vi.mocked(metaApi.post).mock.calls[0]![1] as Record<string, unknown>
    expect(body).not.toHaveProperty('spaceId')
    expect(body).not.toHaveProperty('ownerDeviceId')
    expect(body).not.toHaveProperty('ownerTabId')
    expect(body).toMatchObject({
      sessionId: 'online-1', ownershipEpoch: 4,
      payload: { winnerRole: 'candidate',
        decisionAt: '2026-07-15T08:00:45Z', validityCorrection: {
          loserValidity: 'invalid', loserValidityReason: 'activation_conflict_loser',
        } },
    })
    expect(body.payloadHash).toBe(await hashCommandPayload({
      winner_role: 'candidate',
      decision_at: '2026-07-15T08:00:45Z', validity_correction: {
        loser_validity: 'invalid', loser_validity_reason: 'activation_conflict_loser',
      },
    }))
  })

  it('requires explicit spaceId for the complete provisional activation DTO', async () => {
    await expect(activeSessionApi.activateProvisional({
      spaceId: '', sessionId: 'offline-1', operationId: 'activate-1',
      payload: provisionalActivationPayload(),
    })).rejects.toThrow('spaceId is required for provisional activation')
  })

  it('excludes only provisional cached epoch/version guards from the recursive hash', async () => {
    const base = provisionalActivationPayload()
    const guardsChanged = structuredClone(base)
    guardsChanged.cachedOwnershipEpoch = 9
    guardsChanged.expectedWorkItemVersions = { l2: 99, l3: 98 }
    expect(await hashCommandPayload(activateProvisionalHashPayload(guardsChanged)))
      .toBe(await hashCommandPayload(activateProvisionalHashPayload(base)))

    const frozenFactChanged = structuredClone(base)
    frozenFactChanged.snapshot.context.level2VersionSnapshot = 5
    frozenFactChanged.expectedWorkItemVersions.l2 = 5
    expect(await hashCommandPayload(activateProvisionalHashPayload(frozenFactChanged)))
      .not.toBe(await hashCommandPayload(activateProvisionalHashPayload(base)))
  })

  it.each([
    ['updateNote', '/active-session/note', {
      session_note: 'Observed', owner_device_id: 'device-1', owner_tab_id: 'tab-1',
    }],
    ['setCurrentPlanItem', '/active-session/plan/current', {
      work_item_id: 'l3', owner_device_id: 'device-1', owner_tab_id: 'tab-1',
    }],
    ['setCompletionDraft', '/active-session/plan/completion-draft', {
      plan_item_id: 'plan-1', completion_draft: true,
      owner_device_id: 'device-1', owner_tab_id: 'tab-1',
    }],
    ['addPlanItem', '/active-session/plan/add', {
      work_item_id: 'l3', plan_rank: 1, added_at: '2026-07-15T08:05:00Z',
      owner_device_id: 'device-1', owner_tab_id: 'tab-1',
    }],
    ['removePlanItem', '/active-session/plan/remove', {
      plan_item_id: 'plan-1', removed_at: '2026-07-15T08:05:00Z',
      removal_reason: 'Replanned', owner_device_id: 'device-1', owner_tab_id: 'tab-1',
    }],
  ] as const)('routes %s only through the master client', async (method, path, hashPayload) => {
    vi.mocked(metaApi.put).mockResolvedValue({ data: activeSessionResponse() })
    vi.mocked(metaApi.post).mockResolvedValue({ data: activeSessionResponse() })
    await invokeRunningContent(activeSessionApi, method)
    const calls = method === 'updateNote'
      ? vi.mocked(metaApi.put).mock.calls : vi.mocked(metaApi.post).mock.calls
    expect(calls.at(-1)?.[0]).toBe(path)
    expect((calls.at(-1)?.[1] as { payloadHash: string }).payloadHash)
      .toBe(await hashCommandPayload(hashPayload))
    expect(spaceApi.put).not.toHaveBeenCalled()
    expect(spaceApi.post).not.toHaveBeenCalled()
  })
})
```

```typescript
// frontend/src/services/task-space-api.test.ts
import { hashCommandPayload } from '@/lib/contracts/payload-hash'

it('uses only the three TS0-locked WorkItemNote write paths', async () => {
  mockNoteResponses(spaceApi)
  await taskSpaceApi.replaceNote(noteCommandInput())
  await taskSpaceApi.appendBlocks(appendCommandInput())
  await taskSpaceApi.toggleChecklistItem(toggleCommandInput())

  expect(spaceApi.put).toHaveBeenCalledWith(
    '/work-items/wi-1/note', expect.any(Object), expect.any(Object),
  )
  expect(spaceApi.post).toHaveBeenCalledWith(
    '/work-items/wi-1/note/append-blocks', expect.any(Object), expect.any(Object),
  )
  expect(spaceApi.post).toHaveBeenCalledWith(
    '/work-items/wi-1/note/toggle-checklist-item', expect.any(Object), expect.any(Object),
  )
  expect(spaceApi.post).not.toHaveBeenCalledWith(
    expect.stringContaining('promote'), expect.anything(), expect.anything(),
  )
  expect(spaceApi.post).not.toHaveBeenCalledWith(
    expect.stringContaining(['/note', 'commands'].join('/')), expect.anything(), expect.anything(),
  )
  const bodies = [
    vi.mocked(spaceApi.put).mock.calls[0]![1],
    ...vi.mocked(spaceApi.post).mock.calls.map((call) => call[1]),
  ] as Array<Record<string, unknown>>
  for (const body of bodies) {
    expect(body.payloadHash).toMatch(/^[0-9a-f]{64}$/)
    expect(body).toHaveProperty('commandId')
  }
})

it('hashes camelCase wire commands as explicit canonical internal payloads', async () => {
  mockTaskSpaceResponses(spaceApi)
  await taskSpaceApi.createProject({
    spaceId: 'space-1', operationId: 'project-op', name: 'Roadmap',
    key: ' rm ', description: null,
  })
  await taskSpaceApi.createWorkItem(workItemCommandInput({
    projectId: 'project-1', title: 'Draft', description: null, parentId: null,
    typeDefinitionId: null, statusDefinitionId: null, priority: null,
  }))
  await taskSpaceApi.toggleChecklistItem(toggleCommandInput({
    blockId: 'check-1', itemId: 'item-1', checked: true,
  }))

  const projectBody = vi.mocked(spaceApi.post).mock.calls
    .find(([path]) => path === '/projects')![1] as Record<string, unknown>
  expect(projectBody).toMatchObject({ key: 'RM' })
  expect(projectBody.payloadHash).toBe(await hashCommandPayload({
    name: 'Roadmap', key: 'RM', description: null,
  }))

  const createBody = vi.mocked(spaceApi.post).mock.calls
    .find(([path]) => path === '/work-items')![1] as Record<string, unknown>
  expect(createBody).toMatchObject({ projectId: 'project-1', parentId: null })
  expect(createBody.payloadHash).toBe(await hashCommandPayload({
    title: 'Draft', description: null, parent_id: null,
    type_definition_id: null, status_definition_id: null, priority: null,
  }))

  const toggleBody = vi.mocked(spaceApi.post).mock.calls
    .find(([path]) => String(path).endsWith('/note/toggle-checklist-item'))![1] as Record<string, unknown>
  expect(toggleBody).toMatchObject({ blockId: 'check-1', itemId: 'item-1', checked: true })
  expect(toggleBody.payloadHash).toBe(await hashCommandPayload({
    block_id: 'check-1', item_id: 'item-1', checked: true,
  }))
})

it('keeps Move projectId on the wire but outside the business hash', async () => {
  mockTaskSpaceResponses(spaceApi)
  await taskSpaceApi.moveWorkItem({
    spaceId: 'space-1', projectId: 'project-a', workItemId: 'wi-a',
    operationId: 'move-a', expectedVersion: 4, newParentId: 'l2', childRank: 7,
  })
  await taskSpaceApi.moveWorkItem({
    spaceId: 'space-1', projectId: 'project-b', workItemId: 'wi-b',
    operationId: 'move-b', expectedVersion: 9, newParentId: 'l2', childRank: 7,
  })
  const [first, second] = vi.mocked(spaceApi.post).mock.calls
    .filter(([path]) => String(path).endsWith('/move'))
    .map(([, body]) => body as Record<string, unknown>)
  expect(first).toMatchObject({ projectId: 'project-a', commandId: 'move-a' })
  expect(second).toMatchObject({ projectId: 'project-b', commandId: 'move-b' })
  expect(first!.payloadHash).toBe(second!.payloadHash)
  expect(first!.payloadHash).toBe(await hashCommandPayload({
    new_parent_id: 'l2', child_rank: 7,
  }))
})
```

```typescript
// frontend/src/services/focus-session-api.test.ts
import { hashCommandPayload } from '@/lib/contracts/payload-hash'

it('nests review wire fields and hashes normalized outcomes without version guards', async () => {
  vi.mocked(spaceApi.post).mockResolvedValue({ data: focusSessionAggregate('space-a', 'fs-1') })
  await focusSessionApi.submitReview({
    operationId: 'review-1', spaceId: 'space-a', sessionId: 'fs-1', expectedVersion: 3,
    validity: 'valid', reviewState: 'completed', reviewedAt: '2026-07-15T09:00:00Z',
    outcomes: [{
      workItemId: 'l3-1', touched: true, result: 'completed', stateCommand: 'complete',
      expectedWorkItemVersion: 7,
    }],
  })
  const body = vi.mocked(spaceApi.post).mock.calls[0]![1] as Record<string, unknown>
  expect(body).toMatchObject({
    commandId: 'review-1', spaceId: 'space-a', sessionId: 'fs-1', ownershipEpoch: null,
    payload: {
      expectedVersion: 3, validity: 'valid', reviewState: 'completed',
      reviewedAt: '2026-07-15T09:00:00Z',
      outcomes: [{
        workItemId: 'l3-1', touched: true, result: 'completed',
        stateCommand: 'complete', expectedWorkItemVersion: 7,
      }],
    },
  })
  expect(body.payloadHash).toBe(await hashCommandPayload({
    validity: 'valid', review_state: 'completed', reviewed_at: '2026-07-15T09:00:00Z',
    outcomes: [{
      work_item_id: 'l3-1', touched: true, result: 'completed', state_command: 'complete',
    }],
  }))
})

it('rejects reconciliation expectedVersion as an unknown input field', async () => {
  await expect(focusSessionApi.reconcileCommands({
    operationId: 'reconcile-1', spaceId: 'space-a', sessionId: 'fs-1', commandIds: ['cmd-a'],
    replaySafe: false, abandonCommandIds: [], decisionAt: null, expectedVersion: 3,
  } as never)).rejects.toThrow()
  expect(spaceApi.post).not.toHaveBeenCalled()
})

it('hashes an explicit abandon decision and sends no Session CAS', async () => {
  vi.mocked(spaceApi.post).mockResolvedValue({
    data: focusSessionAggregate('space-a', 'fs-1', { receiptState: 'abandoned' }),
  })
  await focusSessionApi.reconcileCommands({
    operationId: 'reconcile-1', spaceId: 'space-a', sessionId: 'fs-1',
    commandIds: ['cmd-a'], replaySafe: false,
    abandonCommandIds: ['cmd-a'], decisionAt: '2026-07-15T09:00:00Z',
  })
  const body = vi.mocked(spaceApi.post).mock.calls[0]![1] as Record<string, unknown>
  expect(body).not.toHaveProperty('expectedVersion')
  expect(body.payloadHash).toBe(await hashCommandPayload({
    command_ids: ['cmd-a'], replay_safe: false,
    abandon_command_ids: ['cmd-a'], decision_at: '2026-07-15T09:00:00Z',
  }))
})

it('requires a caller-persisted reconciliation root operation ID', async () => {
  await expect(focusSessionApi.reconcileCommands({
    spaceId: 'space-a', sessionId: 'fs-1', commandIds: ['cmd-a'],
    replaySafe: false, abandonCommandIds: [], decisionAt: null,
  } as never)).rejects.toThrow()
  expect(spaceApi.post).not.toHaveBeenCalled()
})
```

- [ ] **Step 5: Run the contract tests and verify the red state**

Run from `frontend/`:

```powershell
npm run test -- --run src/lib/contracts/payload-hash.test.ts src/lib/contracts/task-space.test.ts src/lib/contracts/focus-session.test.ts src/services/task-space-api.test.ts src/services/focus-session-api.test.ts src/services/active-session-api.test.ts
```

Expected: FAIL because the runtime schemas and three Adapter modules do not exist.

- [ ] **Step 6: Implement RFC 8785 SHA-256 and the complete WorkItemNote schema**

```typescript
// frontend/src/lib/contracts/payload-hash.ts
import { canonicalize } from 'json-canonicalize'

export type JsonValue = null | boolean | number | string | JsonValue[] | {
  [key: string]: JsonValue
}

export async function hashCommandPayload(payload: JsonValue): Promise<string> {
  const canonical = canonicalize(payload)
  if (canonical === undefined) throw new Error('command payload is not canonical JSON')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function buildCommandFields<T extends JsonValue>(input: {
  commandId: string
  spaceId?: string
  targetId?: string
  expectedVersion?: number | null
  ownershipEpoch?: number | null
  payload: T
}): Promise<{ commandId: string; payloadHash: string }> {
  return {
    commandId: input.commandId,
    payloadHash: await hashCommandPayload(input.payload),
  }
}
```

Callers never pass the full wire body to `hashCommandPayload`. Each Adapter uses an explicit command-level builder for the canonical internal business payload expected by TS1/TS2: top-level transport keys such as `blockId`, `level2WorkItemId`, and `reviewState` remain camelCase on the wire but become `block_id`, `level2_work_item_id`, and `review_state` in the hash input. This is not a recursive case converter: nested WorkItemNote v1 `document`/`blocks` values retain their locked camelCase alias shape. `json-canonicalize` rejects unsupported values, while Zod request schemas reject `undefined`, non-finite numbers, BigInt, dates, functions, and non-JSON prototypes before hashing.

```typescript
// frontend/src/lib/contracts/task-space.ts
import { z } from 'zod'
import { canonicalize } from 'json-canonicalize'

const id = z.string().min(1).max(64)
const entityId = z.string().min(1).max(36)
const utc = z.string().datetime({ offset: true })
export const MAX_NOTE_DOCUMENT_BYTES = 128 * 1024
export const MAX_NOTE_BLOCKS = 256
export const MAX_NOTE_ITEMS = 2048

const noChildren = z.array(z.never()).max(0, 'Checklist supports at most two levels')
const checklistText = z.string().max(10_000).refine(
  (value) => value.trim().length > 0,
  { message: 'checklist item requires nonblank text' },
)
const checklistLeaf = z.object({
  itemId: id, text: checklistText, checked: z.boolean(), children: noChildren,
}).strict()
const checklistItem = z.object({
  itemId: id, text: checklistText, checked: z.boolean(),
  children: z.array(checklistLeaf).max(MAX_NOTE_ITEMS),
}).strict()

const paragraph = z.object({
  type: z.literal('paragraph'), blockId: id, text: z.string().max(10_000),
}).strict()
const checklist = z.object({
  type: z.literal('checklist'), blockId: id, items: z.array(checklistItem).max(MAX_NOTE_ITEMS),
}).strict()

export const noteBlockSchema = z.discriminatedUnion('type', [
  paragraph, checklist,
])

export const workItemNoteDocumentSchema = z.object({
  contentVersion: z.literal(1), blocks: z.array(noteBlockSchema).max(MAX_NOTE_BLOCKS),
}).strict().superRefine((document, context) => {
  type NestedChecklistItem = { itemId: string; children: NestedChecklistItem[] }
  const seen = new Set<string>()
  let itemCount = 0
  const visitItem = (item: NestedChecklistItem) => {
    itemCount += 1
    if (seen.has(item.itemId)) {
      context.addIssue({ code: 'custom', message: 'Block and item IDs must be unique' })
    }
    seen.add(item.itemId)
    for (const child of item.children) visitItem(child)
  }
  for (const block of document.blocks) {
    if (seen.has(block.blockId)) {
      context.addIssue({ code: 'custom', message: 'Block and item IDs must be unique' })
    }
    seen.add(block.blockId)
    if (!('items' in block)) continue
    for (const item of block.items) visitItem(item)
  }
  if (itemCount > MAX_NOTE_ITEMS) {
    context.addIssue({ code: 'custom', message: 'Note item count exceeds limit' })
  }
  const canonical = canonicalize(document)
  if (canonical === undefined) {
    context.addIssue({ code: 'custom', message: 'Note document is not canonical JSON' })
  } else if (new TextEncoder().encode(canonical).byteLength > MAX_NOTE_DOCUMENT_BYTES) {
    context.addIssue({ code: 'custom', message: 'Note document exceeds byte limit' })
  }
})

export const projectSchema = z.object({
  id: entityId, spaceId: entityId, name: z.string().min(1).max(200),
  key: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/), description: z.string().nullable(),
  nextWorkItemNumber: z.number().int().positive(), rank: z.number().int().nonnegative(),
  archivedAt: utc.nullable(), version: z.number().int().positive(),
  createdAt: utc, updatedAt: utc,
}).strict()

export const workItemSchema = z.object({
  id: entityId, spaceId: entityId, projectId: entityId, displayKey: z.string().min(1),
  title: z.string().min(1).max(500), description: z.string().nullable(),
  typeDefinitionId: entityId, statusDefinitionId: entityId,
  priority: z.number().int().nullable(), parentId: entityId.nullable(),
  childRank: z.number().int().nonnegative(), depth: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  completionWindowStart: utc.nullable(), completionWindowEnd: utc.nullable(),
  reviewPoint: utc.nullable(), hardDeadline: utc.nullable(),
  effortEstimateLowerSeconds: z.number().int().nonnegative().nullable(),
  effortEstimateUpperSeconds: z.number().int().nonnegative().nullable(),
  effortActualSeconds: z.number().int().nonnegative(), confidence: z.number().nullable(),
  completedAt: utc.nullable(), cancelledAt: utc.nullable(), archivedAt: utc.nullable(),
  markedAsAttention: z.boolean(),
  version: z.number().int().positive(), createdAt: utc, updatedAt: utc,
}).strict()

export const workItemNoteSchema = z.object({
  spaceId: entityId, noteId: entityId, workItemId: entityId,
  document: workItemNoteDocumentSchema, version: z.number().int().positive(),
  createdAt: utc, updatedAt: utc,
}).strict()
export const workItemNoteCommandPostImageSchema = workItemNoteSchema.omit({
  spaceId: true,
})

export const projectPageSchema = z.object({
  items: z.array(projectSchema), nextCursor: z.string().nullable(),
}).strict()
export const workItemPageSchema = z.object({
  items: z.array(workItemSchema), nextCursor: z.string().nullable(),
}).strict()
export type WorkItemNoteDocument = z.infer<typeof workItemNoteDocumentSchema>
export type NoteBlock = z.infer<typeof noteBlockSchema>
export type ProjectView = z.infer<typeof projectSchema>
export type WorkItemView = z.infer<typeof workItemSchema>
export type WorkItemNoteView = z.infer<typeof workItemNoteSchema>

export function assertResponseSpace<T extends { spaceId: string }>(
  value: T, expectedSpaceId: string,
): T {
  if (value.spaceId !== expectedSpaceId) {
    throw new Error(`space_scope_mismatch:${value.spaceId}:${expectedSpaceId}`)
  }
  return value
}
```

The same file exports strict `statusDefinitionSchema`, `typeDefinitionSchema`, `labelSchema`, and `workItemLabelSchema` values from `frontend/openapi.json`, plus the command-response schemas. `workItemLabelSchema` retains the backend Sync `id`, verifies `spaceId`, and carries `workItemId`, `labelId`, `version`, `createdAt`, and `updatedAt`; the per-Space Dexie projector strips only `spaceId` and still uses `[workItemId,labelId]` as the local key. A generated-type contract test assigns every inferred response to its corresponding `components['schemas'][...]` type in both directions so a regeneration drift fails `tsc`.

- [ ] **Step 7: Implement orthogonal Session, immutable command, locator, and conflict schemas**

```typescript
// frontend/src/lib/contracts/focus-session.ts
import { z } from 'zod'

const id = z.string().min(1).max(64)
const utc = z.string().datetime({ offset: true })
const syncWireSystem = {
  id,
  spaceId: id,
  createdAt: utc,
  updatedAt: utc,
  version: z.number().int().nonnegative(),
} as const
const syncCommandSystem = {
  id,
  createdAt: utc,
  updatedAt: utc,
  version: z.number().int().nonnegative(),
} as const
export const clockStateSchema = z.enum(['running', 'paused', 'ended'])
export const timerCompletionSchema = z.enum(['completed', 'ended_early', 'interrupted'])
export const validitySchema = z.enum(['pending', 'valid', 'invalid'])
export const reviewStateSchema = z.enum(['not_required', 'pending', 'completed', 'skipped'])
export const ownershipStateSchema = z.enum([
  'authoritative', 'local_provisional', 'activation_conflict',
])
export const receiptStateSchema = z.enum([
  'not_needed', 'pending', 'succeeded', 'failed', 'conflict', 'unknown', 'abandoned',
])
export const executionPersonaSchema = z.enum(['ox', 'pig', 'hajimi', 'wukong'])
export const overallProgressSchema = z.enum(['smooth', 'progressed', 'stuck', 'interrupted'])
export const sessionMoodSchema = z.enum(['great', 'good', 'normal', 'bad'])

export const sessionCommandEnvelopeSchema = z.object({
  commandId: z.string().min(1).max(128), spaceId: id, sessionId: id,
  sessionRevision: z.number().int().nonnegative(),
  workItemId: id, expectedVersion: z.number().int().nonnegative(),
  targetTransition: z.string().min(1), replaySafe: z.boolean(),
  payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: utc,
}).strict()

export const sessionCommandReceiptSchema = z.object({
  commandId: z.string().min(1).max(128),
  attempt: z.number().int().nonnegative(), state: receiptStateSchema,
  errorCode: z.string().nullable(), detail: z.record(z.string(), z.unknown()).nullable(),
  recordedAt: utc,
}).strict()

const sessionTaskContextBusiness = {
  sessionId: id, projectId: id, level2WorkItemId: id,
  projectTitleSnapshot: z.string().min(1), level2TitleSnapshot: z.string().min(1),
  level2ParentIdSnapshot: id.nullable(), level2StatusDefinitionIdSnapshot: id,
  level2VersionSnapshot: z.number().int().nonnegative(),
  level2EffortLowerSecondsSnapshot: z.number().int().nonnegative().nullable(),
  level2EffortUpperSecondsSnapshot: z.number().int().nonnegative().nullable(),
  linkedAt: utc, linkMethod: z.enum(['explicit', 'contextual_confirmed']),
} as const
export const sessionTaskContextRecoveryWireSchema = z.object({
  ...syncWireSystem, ...sessionTaskContextBusiness,
}).strict()
export const sessionTaskContextCommandPostImageSchema = z.object({
  ...syncCommandSystem, ...sessionTaskContextBusiness,
}).strict()
export const sessionTaskContextSchema = sessionTaskContextRecoveryWireSchema

const sessionAttributionBusiness = {
  sessionId: id, revision: z.number().int().positive(), projectId: id,
  level2WorkItemId: id, reason: z.string().nullable(),
  correctedFromRevision: z.number().int().positive().nullable(),
  effective: z.boolean(),
} as const
export const sessionAttributionRevisionRecoveryWireSchema = z.object({
  ...syncWireSystem, ...sessionAttributionBusiness,
}).strict()
export const sessionAttributionRevisionCommandPostImageSchema = z.object({
  ...syncCommandSystem, ...sessionAttributionBusiness,
}).strict()
export const sessionAttributionRevisionSchema =
  sessionAttributionRevisionRecoveryWireSchema

const sessionWorkItemPlanBusiness = {
  sessionId: id, workItemId: id, titleSnapshot: z.string().min(1),
  level2WorkItemIdSnapshot: id, workItemVersionSnapshot: z.number().int().nonnegative(),
  planRank: z.number().int().nonnegative(),
  source: z.enum(['before_start', 'during_session', 'review_materialized']),
  addedAt: utc, removedAt: utc.nullable(), removalReason: z.string().nullable(),
  currentDuringSession: z.boolean(), completionDraft: z.boolean(),
} as const
export const sessionWorkItemPlanRecoveryWireSchema = z.object({
  ...syncWireSystem, ...sessionWorkItemPlanBusiness,
}).strict()
export const sessionWorkItemPlanCommandPostImageSchema = z.object({
  ...syncCommandSystem, ...sessionWorkItemPlanBusiness,
}).strict()
export const sessionWorkItemPlanSchema = sessionWorkItemPlanRecoveryWireSchema

const sessionWorkItemOutcomeBusiness = {
  sessionId: id, sessionRevision: z.number().int().nonnegative(),
  revision: z.number().int().positive(), correctedFromRevision: z.number().int().positive().nullable(),
  effective: z.boolean(), workItemId: id, touched: z.boolean(),
  result: z.enum(['completed', 'progressed', 'stuck', 'untouched', 'cancelled']),
  executionPersona: executionPersonaSchema.nullable(),
  personaSwitched: z.boolean().nullable(),
  personaNote: z.string().max(2_000).nullable(),
  stateCommand: z.enum(['complete', 'cancel', 'none']),
  commandId: id.nullable(), reviewedAt: utc.nullable(),
} as const
export const sessionWorkItemOutcomeRecoveryWireSchema = z.object({
  ...syncWireSystem, ...sessionWorkItemOutcomeBusiness,
}).strict()
export const sessionWorkItemOutcomeCommandPostImageSchema = z.object({
  ...syncCommandSystem, ...sessionWorkItemOutcomeBusiness,
}).strict()
export const sessionWorkItemOutcomeSchema = sessionWorkItemOutcomeRecoveryWireSchema

export const sessionReviewDraftSchema = z.object({
  operationId: id,
  spaceId: id,
  sessionId: id,
  expectedVersion: z.number().int().nonnegative(),
  validity: validitySchema,
  reviewState: reviewStateSchema,
  reviewedAt: utc,
  outcomes: z.array(z.object({
    workItemId: id,
    touched: z.boolean(),
    result: z.enum(['completed', 'progressed', 'stuck', 'untouched', 'cancelled']),
    stateCommand: z.enum(['complete', 'cancel', 'none']),
    expectedWorkItemVersion: z.number().int().nonnegative(),
    executionPersona: executionPersonaSchema.nullable().optional(),
    personaSwitched: z.boolean().nullable().optional(),
    personaNote: z.string().max(2_000).nullable().optional(),
  }).strict()),
}).strict()

export type SessionReviewDraft = z.infer<typeof sessionReviewDraftSchema>

const focusSessionBusiness = {
  sessionRevision: z.number().int().nonnegative(),
  startedAt: utc, endedAt: utc.nullable(), pauseStartedAt: utc.nullable(),
  plannedSeconds: z.number().int().positive(), grossSeconds: z.number().int().nonnegative(),
  pausedSeconds: z.number().int().nonnegative(), breakSeconds: z.number().int().nonnegative(),
  focusedSeconds: z.number().int().nonnegative(),
  timerCompletion: timerCompletionSchema.nullable(), validity: validitySchema,
  validityReason: z.string().nullable(), overallProgress: overallProgressSchema.nullable(),
  mood: sessionMoodSchema.nullable(), reviewState: reviewStateSchema,
  ownershipState: ownershipStateSchema, sessionNote: z.string().max(20_000),
} as const
export const focusSessionRecoveryWireSchema = z.object({
  ...syncWireSystem, ...focusSessionBusiness,
}).strict()
export const focusSessionCommandPostImageSchema = z.object({
  ...syncCommandSystem, ...focusSessionBusiness,
}).strict()
export const focusSessionSchema = z.object({
  ...syncWireSystem, ...focusSessionBusiness, clockState: clockStateSchema,
}).strict()

export const focusSessionAggregateSchema = z.object({
  session: focusSessionSchema,
  context: sessionTaskContextSchema.nullable(),
  attribution: sessionAttributionRevisionSchema,
  plan: z.array(sessionWorkItemPlanSchema),
  outcomes: z.array(sessionWorkItemOutcomeSchema),
  commandEnvelopes: z.array(sessionCommandEnvelopeSchema),
  commandReceipts: z.array(sessionCommandReceiptSchema),
}).strict()

export type FocusSessionView = z.infer<typeof focusSessionSchema>
export type SessionTaskContextView = z.infer<typeof sessionTaskContextSchema>
export type SessionAttributionRevisionView =
  z.infer<typeof sessionAttributionRevisionSchema>
export type SessionWorkItemPlanView = z.infer<typeof sessionWorkItemPlanSchema>
export type SessionWorkItemOutcomeView = z.infer<typeof sessionWorkItemOutcomeSchema>

export function deriveClockStateFromPersistedFacts(
  row: Pick<z.infer<typeof focusSessionRecoveryWireSchema>,
    'endedAt' | 'pauseStartedAt'>,
): z.infer<typeof clockStateSchema> {
  if (row.endedAt !== null) return 'ended'
  return row.pauseStartedAt !== null ? 'paused' : 'running'
}

export function projectFocusSessionViewToCache(raw: unknown) {
  const view = focusSessionSchema.parse(raw)
  const derived = deriveClockStateFromPersistedFacts(view)
  if (view.clockState !== derived) throw new Error('focus_session_clock_state_mismatch')
  const { id: sessionId, spaceId: _verifiedSpace, ...row } = view
  return { sessionId, ...row }
}

export function projectFocusSessionRecoveryWireToCache(raw: unknown) {
  const wire = focusSessionRecoveryWireSchema.parse(raw)
  const { id: sessionId, spaceId: _verifiedSpace, ...facts } = wire
  return {
    sessionId,
    ...facts,
    clockState: deriveClockStateFromPersistedFacts(wire),
  }
}

// API/cache views, Outbox command post-images, and authoritative recovery wire
// snapshots intentionally have separate schemas. In particular, no command
// post-image parser can admit the derived clockState field.

const canonicalUtc = utc.refine((value) => value.endsWith('Z'), {
  message: 'timestamp must be canonical UTC with Z suffix',
})

export const provisionalSessionSnapshotSchema = z.object({
  sessionRevision: z.number().int().nonnegative(),
  startedAt: canonicalUtc,
  pauseStartedAt: canonicalUtc.nullable(),
  plannedSeconds: z.number().int().positive(),
  grossSeconds: z.number().int().nonnegative(),
  pausedSeconds: z.number().int().nonnegative(),
  breakSeconds: z.number().int().nonnegative(),
  focusedSeconds: z.number().int().nonnegative(),
  validity: z.literal('pending'),
  validityReason: z.string().max(500).nullable(),
  reviewState: z.literal('not_required'),
  ownershipState: z.literal('local_provisional'),
  sessionNote: z.string().max(20_000),
}).strict()

export const provisionalTaskContextSnapshotSchema = z.object({
  projectId: id,
  projectTitleSnapshot: z.string().min(1).max(500),
  level2WorkItemId: id,
  level2TitleSnapshot: z.string().min(1).max(500),
  level2ParentIdSnapshot: id.nullable(),
  level2StatusDefinitionIdSnapshot: id,
  level2VersionSnapshot: z.number().int().nonnegative(),
  level2EffortLowerSecondsSnapshot: z.number().int().nonnegative().nullable(),
  level2EffortUpperSecondsSnapshot: z.number().int().nonnegative().nullable(),
  linkedAt: canonicalUtc,
  linkMethod: z.enum(['explicit', 'contextual_confirmed']),
}).strict()

export const provisionalPlanItemSnapshotSchema = z.object({
  id,
  workItemId: id,
  titleSnapshot: z.string().min(1).max(500),
  level2WorkItemIdSnapshot: id,
  workItemVersionSnapshot: z.number().int().nonnegative(),
  planRank: z.number().int().nonnegative(),
  source: z.enum(['before_start', 'during_session']),
  addedAt: canonicalUtc,
  removedAt: canonicalUtc.nullable(),
  removalReason: z.string().max(500).nullable(),
  currentDuringSession: z.boolean(),
  completionDraft: z.boolean(),
}).strict()

export const provisionalFocusSessionSnapshotSchema = z.object({
  session: provisionalSessionSnapshotSchema,
  context: provisionalTaskContextSnapshotSchema,
  plan: z.array(provisionalPlanItemSnapshotSchema),
}).strict()

export const activateProvisionalPayloadSchema = z.object({
  cachedAt: canonicalUtc,
  cachedOwnershipEpoch: z.number().int().positive().nullable(),
  ownerDeviceId: id,
  ownerTabId: id,
  snapshot: provisionalFocusSessionSnapshotSchema,
  expectedWorkItemVersions: z.record(id, z.number().int().nonnegative()),
}).strict().superRefine((payload, context) => {
  const issue = (message: string) => context.addIssue({ code: 'custom', message })
  const { session, context: taskContext, plan } = payload.snapshot
  const startedAt = Date.parse(session.startedAt)
  const cachedAt = Date.parse(payload.cachedAt)
  if (startedAt > cachedAt) issue('startedAt must not exceed cachedAt')
  if (session.pauseStartedAt) {
    const pausedAt = Date.parse(session.pauseStartedAt)
    if (pausedAt < startedAt || pausedAt > cachedAt) {
      issue('pauseStartedAt must be between startedAt and cachedAt')
    }
  }
  const lower = taskContext.level2EffortLowerSecondsSnapshot
  const upper = taskContext.level2EffortUpperSecondsSnapshot
  if (lower !== null && upper !== null && lower > upper) {
    issue('effort lower snapshot must not exceed upper snapshot')
  }

  const planIds = new Set<string>()
  const workItemIds = new Set<string>()
  const ranks = new Set<number>()
  let currentCount = 0
  const expected = new Map<string, number>([[
    taskContext.level2WorkItemId, taskContext.level2VersionSnapshot,
  ]])
  for (const item of plan) {
    if (planIds.has(item.id)) issue('provisional plan IDs must be unique')
    if (workItemIds.has(item.workItemId)) issue('provisional WorkItem IDs must be unique')
    if (ranks.has(item.planRank)) issue('provisional plan ranks must be unique')
    planIds.add(item.id); workItemIds.add(item.workItemId); ranks.add(item.planRank)
    if (item.level2WorkItemIdSnapshot !== taskContext.level2WorkItemId) {
      issue('plan level2 snapshot must match Context')
    }
    const removed = item.removedAt !== null
    const hasReason = item.removalReason !== null && item.removalReason.trim().length > 0
    if (removed !== hasReason) issue('removed plan item requires removedAt and nonblank reason')
    if (!removed && item.currentDuringSession) currentCount += 1
    expected.set(item.workItemId, item.workItemVersionSnapshot)
  }
  if (currentCount > 1) issue('at most one active plan item may be current')
  const actualKeys = Object.keys(payload.expectedWorkItemVersions).sort()
  const expectedKeys = [...expected.keys()].sort()
  if (actualKeys.join('\0') !== expectedKeys.join('\0')) {
    issue('expectedWorkItemVersions must exactly cover Context and Plan')
  }
  for (const [workItemId, version] of expected) {
    if (payload.expectedWorkItemVersions[workItemId] !== version) {
      issue('expectedWorkItemVersions must equal frozen snapshot versions')
    }
  }
})

export const activationConflictValidityCorrectionSchema = z.object({
  loserValidity: z.literal('invalid'),
  loserValidityReason: z.literal('activation_conflict_loser'),
}).strict()

export const activationConflictRoleSchema = z.enum(['active', 'candidate'])

export const resolveActivationConflictPayloadSchema = z.object({
  winnerRole: activationConflictRoleSchema,
  decisionAt: canonicalUtc,
  validityCorrection: activationConflictValidityCorrectionSchema,
}).strict()

const OPERATION_ID_ASCII = /^[A-Za-z0-9._:-]+$/
export const operationIdSchema = z.string().superRefine((value, context) => {
  const bytes = new TextEncoder().encode(value)
  if (!OPERATION_ID_ASCII.test(value) || bytes.byteLength < 1 || bytes.byteLength > 128) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'operation ID must be 1..128 allowlisted ASCII bytes',
    })
  }
})
const commandId = operationIdSchema
const payloadHash = z.string().regex(/^[0-9a-f]{64}$/)
const positiveOwnershipEpoch = z.number().int().positive()
const nonnegativeVersion = z.number().int().nonnegative()
const ownerProofPayloadSchema = z.object({
  ownerDeviceId: id,
  ownerTabId: id,
}).strict()

const targetRequestSchema = <Payload extends z.ZodType>(payload: Payload) => z.object({
  commandId, spaceId: id, sessionId: id, ownershipEpoch: z.null(), payloadHash, payload,
}).strict()

const locatorRequestSchema = <Payload extends z.ZodType>(payload: Payload) => z.object({
  commandId, sessionId: id, ownershipEpoch: positiveOwnershipEpoch, payloadHash, payload,
}).strict()

export const startActiveSessionPayloadSchema = z.object({
  level2WorkItemId: id,
  level3WorkItemIds: z.array(id),
  plannedSeconds: z.number().int().positive(),
  startedAt: canonicalUtc,
  ownerDeviceId: id,
  ownerTabId: id,
  expectedWorkItemVersions: z.record(id, nonnegativeVersion),
}).strict()
export const startActiveSessionRequestSchema = targetRequestSchema(startActiveSessionPayloadSchema)

export const heartbeatPayloadSchema = z.object({
  ownerDeviceId: id, ownerTabId: id, heartbeatAt: canonicalUtc,
}).strict()
export const heartbeatRequestSchema = locatorRequestSchema(heartbeatPayloadSchema)

export const ownedClockPayloadSchema = ownerProofPayloadSchema.extend({
  expectedVersion: nonnegativeVersion,
  occurredAt: canonicalUtc,
}).strict()
export const pauseActiveSessionRequestSchema = locatorRequestSchema(ownedClockPayloadSchema)
export const resumeActiveSessionRequestSchema = locatorRequestSchema(ownedClockPayloadSchema)

export const endActiveSessionPayloadSchema = ownedClockPayloadSchema.extend({
  timerCompletion: timerCompletionSchema,
  validity: validitySchema,
  validityReason: z.string().max(500).nullable(),
}).strict()
export const endActiveSessionRequestSchema = locatorRequestSchema(endActiveSessionPayloadSchema)

export const takeoverPayloadSchema = z.object({
  newOwnerDeviceId: id, newOwnerTabId: id,
}).strict()
export const takeoverRequestSchema = locatorRequestSchema(takeoverPayloadSchema)

export const updateActiveSessionNotePayloadSchema = ownerProofPayloadSchema.extend({
  expectedVersion: nonnegativeVersion,
  sessionNote: z.string().max(20_000),
}).strict()
export const updateActiveSessionNoteRequestSchema = locatorRequestSchema(
  updateActiveSessionNotePayloadSchema,
)

export const setCurrentPlanItemPayloadSchema = ownerProofPayloadSchema.extend({
  workItemId: id.nullable(),
  expectedPlanVersions: z.record(id, nonnegativeVersion),
}).strict()
export const setCurrentPlanItemRequestSchema = locatorRequestSchema(setCurrentPlanItemPayloadSchema)

export const setCompletionDraftPayloadSchema = ownerProofPayloadSchema.extend({
  planItemId: id,
  expectedPlanVersion: nonnegativeVersion,
  completionDraft: z.boolean(),
}).strict()
export const setCompletionDraftRequestSchema = locatorRequestSchema(setCompletionDraftPayloadSchema)

export const addPlanItemPayloadSchema = ownerProofPayloadSchema.extend({
  workItemId: id,
  expectedWorkItemVersion: nonnegativeVersion,
  planRank: z.number().int().nonnegative(),
  addedAt: canonicalUtc,
}).strict()
export const addPlanItemRequestSchema = locatorRequestSchema(addPlanItemPayloadSchema)

export const removePlanItemPayloadSchema = ownerProofPayloadSchema.extend({
  planItemId: id,
  expectedPlanVersion: nonnegativeVersion,
  removedAt: canonicalUtc,
  removalReason: z.string().min(1).max(500).refine((value) => value.trim().length > 0),
}).strict()
export const removePlanItemRequestSchema = locatorRequestSchema(removePlanItemPayloadSchema)

export const activateProvisionalRequestSchema = z.object({
  commandId,
  spaceId: id,
  sessionId: id,
  ownershipEpoch: z.null(),
  payloadHash,
  payload: activateProvisionalPayloadSchema,
}).strict()

export const resolveActivationConflictRequestSchema = locatorRequestSchema(
  resolveActivationConflictPayloadSchema,
)

export type ProvisionalActivationPayload = z.infer<typeof activateProvisionalPayloadSchema>
export type ActivationConflictValidityCorrection = z.infer<
  typeof activationConflictValidityCorrectionSchema
>
export type ResolveActivationConflictPayload = z.infer<
  typeof resolveActivationConflictPayloadSchema
>
export type StartActiveSessionPayload = z.infer<typeof startActiveSessionPayloadSchema>
export type OwnedClockPayload = z.infer<typeof ownedClockPayloadSchema>
export type EndActiveSessionPayload = z.infer<typeof endActiveSessionPayloadSchema>
export type UpdateActiveSessionNotePayload = z.infer<typeof updateActiveSessionNotePayloadSchema>
export type SetCurrentPlanItemPayload = z.infer<typeof setCurrentPlanItemPayloadSchema>
export type SetCompletionDraftPayload = z.infer<typeof setCompletionDraftPayloadSchema>
export type AddPlanItemPayload = z.infer<typeof addPlanItemPayloadSchema>
export type RemovePlanItemPayload = z.infer<typeof removePlanItemPayloadSchema>

export const reconcileFocusSessionCommandsPayloadSchema = z.object({
  commandIds: z.array(z.string().min(1).max(128)).min(1).superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', message: 'commandIds must be unique' })
    }
  }),
  replaySafe: z.boolean(),
  abandonCommandIds: z.array(z.string().min(1).max(128)),
  decisionAt: canonicalUtc.nullable(),
}).strict().superRefine((payload, context) => {
  if (new Set(payload.abandonCommandIds).size !== payload.abandonCommandIds.length) {
    context.addIssue({ code: 'custom', path: ['abandonCommandIds'],
      message: 'abandonCommandIds must be unique' })
  }
  const commandIds = new Set(payload.commandIds)
  if (payload.abandonCommandIds.some((commandId) => !commandIds.has(commandId))) {
    context.addIssue({ code: 'custom', path: ['abandonCommandIds'],
      message: 'abandonCommandIds must be a subset of commandIds' })
  }
  if ((payload.abandonCommandIds.length === 0) !== (payload.decisionAt === null)) {
    context.addIssue({ code: 'custom', path: ['decisionAt'],
      message: 'decisionAt is required exactly when commands are abandoned' })
  }
})
export const reconcileFocusSessionCommandsRequestSchema = z.object({
  commandId, spaceId: id, sessionId: id, ownershipEpoch: z.null(), payloadHash,
  payload: reconcileFocusSessionCommandsPayloadSchema,
}).strict()
export const reconcileFocusSessionCommandsInputSchema = z.object({
  operationId: commandId, spaceId: id, sessionId: id,
  commandIds: z.array(z.string().min(1).max(128)).min(1).superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', message: 'commandIds must be unique' })
    }
  }),
  replaySafe: z.boolean(),
  abandonCommandIds: z.array(z.string().min(1).max(128)),
  decisionAt: canonicalUtc.nullable(),
}).strict().superRefine((input, context) => {
  const parsed = reconcileFocusSessionCommandsPayloadSchema.safeParse({
    commandIds: input.commandIds, replaySafe: input.replaySafe,
    abandonCommandIds: input.abandonCommandIds, decisionAt: input.decisionAt,
  })
  for (const issue of parsed.success ? [] : parsed.error.issues) context.addIssue(issue)
})
export type ReconcileFocusSessionCommandsInput = z.infer<
  typeof reconcileFocusSessionCommandsInputSchema
>

export const activeSessionLocatorSchema = z.object({
  spaceId: id, sessionId: id, operationId: commandId,
  state: z.enum(['claiming', 'active', 'releasing']),
  ownerDeviceId: id, ownerTabId: id, ownershipEpoch: positiveOwnershipEpoch,
  leaseExpiresAt: utc, updatedAt: utc,
}).strict()
export const heartbeatResponseSchema = activeSessionLocatorSchema.extend({
  state: z.literal('active'),
}).strict()

export const activeSessionSchema = activeSessionLocatorSchema.extend({
  kind: z.enum(['authoritative', 'resumed']).optional(),
  session: focusSessionAggregateSchema,
}).strict()

export const activationConflictSchema = z.object({
  kind: z.literal('activation_conflict'),
  active: activeSessionSchema,
  candidate: z.object({
    spaceId: id, sessionId: id, session: focusSessionAggregateSchema,
  }).strict(),
}).strict()
export const locatedActiveSessionSchema = activeSessionSchema.or(activationConflictSchema)

export const terminalActiveSessionResponseSchema = z.object({
  session: focusSessionAggregateSchema.extend({
    session: focusSessionSchema.extend({ clockState: z.literal('ended') }),
  }),
  locator: z.null(),
}).strict()

export type FocusSessionView = z.infer<typeof focusSessionSchema>
export type FocusSessionAggregateView = z.infer<typeof focusSessionAggregateSchema>
export type ActiveSessionLocatorView = z.infer<typeof activeSessionLocatorSchema>
export type ActiveSessionView = z.infer<typeof activeSessionSchema>
export type TerminalActiveSessionResponse = z.infer<
  typeof terminalActiveSessionResponseSchema
>
export type SessionCommandEnvelopeView = z.infer<typeof sessionCommandEnvelopeSchema>
export type SessionCommandReceiptView = z.infer<typeof sessionCommandReceiptSchema>
export type ActivationConflictRole = z.infer<typeof activationConflictRoleSchema>
export type ActivationConflictResponse = z.infer<typeof activationConflictSchema>
export type LocatedActiveSessionResponse = z.infer<typeof locatedActiveSessionSchema>
```

- [ ] **Step 8: Implement the three parsed transport Adapters with payloadHash**

```typescript
// frontend/src/services/task-space-api.ts
import { spaceApi } from './api'
import type { components } from '@/types/api-generated'
import { buildCommandFields, type JsonValue } from '@/lib/contracts/payload-hash'
import {
  assertResponseSpace, projectPageSchema, projectSchema, workItemNoteSchema,
  workItemPageSchema, workItemSchema,
  type NoteBlock, type WorkItemNoteDocument,
} from '@/lib/contracts/task-space'

type CommandIdentityKey = 'commandId' | 'payloadHash' | 'spaceId' | 'workItemId' | 'expectedVersion'
type CreateWorkItemRequest = Omit<components['schemas']['WorkItemCreate'], CommandIdentityKey>
type MoveWorkItemRequest = Omit<components['schemas']['WorkItemMove'], CommandIdentityKey>
type TransitionWorkItemRequest = Omit<components['schemas']['WorkItemTransition'], CommandIdentityKey>

const operation = (operationId: string) => ({
  headers: { 'Idempotency-Key': operationId },
})

export const normalizeProjectKey = (key: string) => key.trim().toUpperCase()

async function commandWire<TWire extends Record<string, unknown>>(input: {
  commandId: string; spaceId: string; targetId?: string;
  expectedVersion?: number | null; wirePayload: TWire; hashPayload: JsonValue;
}) {
  return {
    commandId: input.commandId,
    spaceId: input.spaceId,
    ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
    ...await buildCommandFields({ ...input, payload: input.hashPayload }),
    ...input.wirePayload,
  }
}

const createWorkItemHashPayload = (input: CreateWorkItemRequest): JsonValue => ({
  title: input.title,
  description: input.description ?? null,
  parent_id: input.parentId ?? null,
  type_definition_id: input.typeDefinitionId ?? null,
  status_definition_id: input.statusDefinitionId ?? null,
  priority: input.priority ?? null,
})

const moveWorkItemHashPayload = (input: MoveWorkItemRequest): JsonValue => ({
  new_parent_id: input.newParentId ?? null,
  child_rank: input.childRank,
})

const transitionWorkItemHashPayload = (input: TransitionWorkItemRequest): JsonValue => ({
  status_definition_id: input.statusDefinitionId,
})

export const taskSpaceApi = {
  async listProjects(spaceId: string) {
    const { data } = await spaceApi.get('/projects')
    const page = projectPageSchema.parse(data)
    return page.items.map((row) => assertResponseSpace(row, spaceId))
  },
  async readTree(spaceId: string, projectId: string) {
    const { data } = await spaceApi.get('/work-items', { params: { projectId } })
    const page = workItemPageSchema.parse(data)
    return page.items.map((row) => assertResponseSpace(row, spaceId))
  },
  async readNote(spaceId: string, workItemId: string) {
    const { data } = await spaceApi.get(`/work-items/${workItemId}/note`)
    return data === null ? null : assertResponseSpace(workItemNoteSchema.parse(data), spaceId)
  },
  async createProject(input: {
    spaceId: string; name: string; key: string; description: string | null; operationId: string;
  }) {
    const wirePayload = {
      name: input.name,
      key: normalizeProjectKey(input.key),
      description: input.description,
    }
    const { data } = await spaceApi.post('/projects', await commandWire({
      commandId: input.operationId, spaceId: input.spaceId,
      wirePayload, hashPayload: wirePayload,
    }), operation(input.operationId))
    return assertResponseSpace(projectSchema.parse(data), input.spaceId)
  },
  async createWorkItem(input: CreateWorkItemRequest & { spaceId: string; operationId: string }) {
    const { operationId, spaceId, ...wirePayload } = input
    const body = await commandWire({
      commandId: operationId, spaceId, wirePayload,
      hashPayload: createWorkItemHashPayload(input),
    })
    const { data } = await spaceApi.post('/work-items', body, operation(operationId))
    return assertResponseSpace(workItemSchema.parse(data), input.spaceId)
  },
  async moveWorkItem(input: MoveWorkItemRequest & {
    spaceId: string; workItemId: string; operationId: string; expectedVersion: number;
  }) {
    const { workItemId, operationId, spaceId, expectedVersion, ...wirePayload } = input
    const body = await commandWire({
      commandId: operationId, spaceId, targetId: workItemId, expectedVersion, wirePayload,
      hashPayload: moveWorkItemHashPayload(input),
    })
    const { data } = await spaceApi.post(
      `/work-items/${workItemId}/move`, body, operation(operationId),
    )
    return assertResponseSpace(workItemSchema.parse(data), input.spaceId)
  },
  async transitionWorkItem(input: TransitionWorkItemRequest & {
    spaceId: string; workItemId: string; operationId: string; expectedVersion: number;
  }) {
    const { workItemId, operationId, spaceId, expectedVersion, ...wirePayload } = input
    const body = await commandWire({
      commandId: operationId, spaceId, targetId: workItemId, expectedVersion, wirePayload,
      hashPayload: transitionWorkItemHashPayload(input),
    })
    const { data } = await spaceApi.post(
      `/work-items/${workItemId}/transition`, body, operation(operationId),
    )
    return assertResponseSpace(workItemSchema.parse(data), input.spaceId)
  },
  async replaceNote(input: {
    spaceId: string; workItemId: string; expectedVersion: number;
    document: WorkItemNoteDocument; operationId: string;
  }) {
    const wirePayload = { document: input.document }
    const { data } = await spaceApi.put(
      `/work-items/${input.workItemId}/note`,
      await commandWire({
        commandId: input.operationId, spaceId: input.spaceId,
        targetId: input.workItemId, expectedVersion: input.expectedVersion,
        wirePayload, hashPayload: { document: input.document },
      }),
      operation(input.operationId),
    )
    return assertResponseSpace(workItemNoteSchema.parse(data), input.spaceId)
  },
  async appendBlocks(input: {
    spaceId: string; workItemId: string; expectedVersion: number;
    blocks: NoteBlock[]; operationId: string;
  }) {
    const wirePayload = { blocks: input.blocks }
    const { data } = await spaceApi.post(
      `/work-items/${input.workItemId}/note/append-blocks`,
      await commandWire({
        commandId: input.operationId, spaceId: input.spaceId,
        targetId: input.workItemId, expectedVersion: input.expectedVersion,
        wirePayload, hashPayload: { blocks: input.blocks },
      }),
      operation(input.operationId),
    )
    return assertResponseSpace(workItemNoteSchema.parse(data), input.spaceId)
  },
  async toggleChecklistItem(input: {
    spaceId: string; workItemId: string; expectedVersion: number;
    blockId: string; itemId: string; checked: boolean; operationId: string;
  }) {
    const wirePayload = { blockId: input.blockId, itemId: input.itemId, checked: input.checked }
    const { data } = await spaceApi.post(
      `/work-items/${input.workItemId}/note/toggle-checklist-item`,
      await commandWire({
        commandId: input.operationId, spaceId: input.spaceId,
        targetId: input.workItemId, expectedVersion: input.expectedVersion, wirePayload,
        hashPayload: { block_id: input.blockId, item_id: input.itemId, checked: input.checked },
      }),
      operation(input.operationId),
    )
    return assertResponseSpace(workItemNoteSchema.parse(data), input.spaceId)
  },
}
```

```typescript
// frontend/src/services/active-session-api.ts
import { metaApi } from './api'
import { hashCommandPayload, type JsonValue } from '@/lib/contracts/payload-hash'
import {
  activeSessionSchema, activationConflictSchema, activateProvisionalPayloadSchema,
  activateProvisionalRequestSchema, addPlanItemPayloadSchema, addPlanItemRequestSchema,
  endActiveSessionPayloadSchema, endActiveSessionRequestSchema, heartbeatPayloadSchema,
  heartbeatRequestSchema, heartbeatResponseSchema, pauseActiveSessionRequestSchema,
  locatedActiveSessionSchema, removePlanItemPayloadSchema,
  removePlanItemRequestSchema, resolveActivationConflictPayloadSchema,
  resolveActivationConflictRequestSchema, resumeActiveSessionRequestSchema,
  setCompletionDraftPayloadSchema, setCompletionDraftRequestSchema,
  setCurrentPlanItemPayloadSchema, setCurrentPlanItemRequestSchema,
  startActiveSessionPayloadSchema, startActiveSessionRequestSchema,
  takeoverPayloadSchema, takeoverRequestSchema, terminalActiveSessionResponseSchema,
  updateActiveSessionNotePayloadSchema, updateActiveSessionNoteRequestSchema,
  type ActivationConflictRole, type ActivationConflictValidityCorrection,
  type AddPlanItemPayload,
  type EndActiveSessionPayload, type ProvisionalActivationPayload,
  type RemovePlanItemPayload, type SetCompletionDraftPayload,
  type SetCurrentPlanItemPayload, type StartActiveSessionPayload,
  type UpdateActiveSessionNotePayload,
} from '@/lib/contracts/focus-session'

const keyed = (operationId: string) => ({ headers: { 'Idempotency-Key': operationId } })
type JsonObject = { [key: string]: JsonValue }

export interface GlobalTargetCommandRequest {
  spaceId: string
  sessionId: string
  operationId: string
}

export interface GlobalStartActiveSessionRequest extends GlobalTargetCommandRequest {
  level2WorkItemId: StartActiveSessionPayload['level2WorkItemId']
  level3WorkItemIds: StartActiveSessionPayload['level3WorkItemIds']
  plannedSeconds: StartActiveSessionPayload['plannedSeconds']
  startedAt: StartActiveSessionPayload['startedAt']
  ownerDeviceId: StartActiveSessionPayload['ownerDeviceId']
  ownerTabId: StartActiveSessionPayload['ownerTabId']
  expectedWorkItemVersions: StartActiveSessionPayload['expectedWorkItemVersions']
}

export interface LocatorDerivedMutationRequest {
  sessionId: string
  operationId: string
  ownershipEpoch: number
}

export interface HeartbeatRequest extends LocatorDerivedMutationRequest {
  ownerDeviceId: string
  ownerTabId: string
  heartbeatAt: string
}

export interface OwnedLocatorMutationRequest extends LocatorDerivedMutationRequest {
  ownerDeviceId: string
  ownerTabId: string
}

export interface OwnedClockRequest extends OwnedLocatorMutationRequest {
  expectedVersion: number
  occurredAt: string
}

export interface EndActiveSessionRequest extends OwnedLocatorMutationRequest,
  EndActiveSessionPayload {}

export interface ActivateProvisionalInput extends GlobalTargetCommandRequest {
  payload: ProvisionalActivationPayload
}

export interface ResolveActivationConflictRequest extends LocatorDerivedMutationRequest {
  winnerRole: ActivationConflictRole
  decisionAt: string
  validityCorrection: ActivationConflictValidityCorrection
}

export type UpdateActiveSessionNoteRequest = OwnedLocatorMutationRequest &
  UpdateActiveSessionNotePayload
export type SetCurrentPlanItemRequest = OwnedLocatorMutationRequest &
  SetCurrentPlanItemPayload
export type SetCompletionDraftRequest = OwnedLocatorMutationRequest &
  SetCompletionDraftPayload
export type AddPlanItemRequest = OwnedLocatorMutationRequest & AddPlanItemPayload
export type RemovePlanItemRequest = OwnedLocatorMutationRequest & RemovePlanItemPayload

async function activeCommandWire(input: {
  operationId: string
  spaceId?: string
  sessionId: string
  ownershipEpoch: number | null
  wirePayload: JsonObject
  hashPayload: JsonValue
}) {
  return {
    commandId: input.operationId,
    ...(input.spaceId === undefined ? {} : { spaceId: input.spaceId }),
    sessionId: input.sessionId,
    ownershipEpoch: input.ownershipEpoch,
    payloadHash: await hashCommandPayload(input.hashPayload),
    payload: input.wirePayload,
  }
}

const startHashPayload = (body: GlobalStartActiveSessionRequest): JsonValue => ({
  level2_work_item_id: body.level2WorkItemId,
  level3_work_item_ids: body.level3WorkItemIds,
  planned_seconds: body.plannedSeconds,
  started_at: body.startedAt,
  owner_device_id: body.ownerDeviceId,
  owner_tab_id: body.ownerTabId,
})

const heartbeatHashPayload = (body: HeartbeatRequest): JsonValue => ({
  owner_device_id: body.ownerDeviceId,
  owner_tab_id: body.ownerTabId,
  heartbeat_at: body.heartbeatAt,
})

const clockHashPayload = (body: OwnedClockRequest): JsonValue => ({
  occurred_at: body.occurredAt,
  owner_device_id: body.ownerDeviceId,
  owner_tab_id: body.ownerTabId,
})

const endHashPayload = (body: EndActiveSessionRequest): JsonValue => ({
  occurred_at: body.occurredAt,
  timer_completion: body.timerCompletion,
  validity: body.validity,
  validity_reason: body.validityReason,
  owner_device_id: body.ownerDeviceId,
  owner_tab_id: body.ownerTabId,
})

const noteHashPayload = (body: UpdateActiveSessionNoteRequest): JsonValue => ({
  session_note: body.sessionNote,
  owner_device_id: body.ownerDeviceId,
  owner_tab_id: body.ownerTabId,
})

const currentPlanHashPayload = (body: SetCurrentPlanItemRequest): JsonValue => ({
  work_item_id: body.workItemId,
  owner_device_id: body.ownerDeviceId,
  owner_tab_id: body.ownerTabId,
})

const completionDraftHashPayload = (body: SetCompletionDraftRequest): JsonValue => ({
  plan_item_id: body.planItemId,
  completion_draft: body.completionDraft,
  owner_device_id: body.ownerDeviceId,
  owner_tab_id: body.ownerTabId,
})

const addPlanHashPayload = (body: AddPlanItemRequest): JsonValue => ({
  work_item_id: body.workItemId,
  plan_rank: body.planRank,
  added_at: body.addedAt,
  owner_device_id: body.ownerDeviceId,
  owner_tab_id: body.ownerTabId,
})

const removePlanHashPayload = (body: RemovePlanItemRequest): JsonValue => ({
  plan_item_id: body.planItemId,
  removed_at: body.removedAt,
  removal_reason: body.removalReason,
  owner_device_id: body.ownerDeviceId,
  owner_tab_id: body.ownerTabId,
})

const provisionalSessionHashPayload = (
  row: ProvisionalActivationPayload['snapshot']['session'],
): JsonValue => ({
  session_revision: row.sessionRevision,
  started_at: row.startedAt,
  pause_started_at: row.pauseStartedAt,
  planned_seconds: row.plannedSeconds,
  gross_seconds: row.grossSeconds,
  paused_seconds: row.pausedSeconds,
  break_seconds: row.breakSeconds,
  focused_seconds: row.focusedSeconds,
  validity: row.validity,
  validity_reason: row.validityReason,
  review_state: row.reviewState,
  ownership_state: row.ownershipState,
  session_note: row.sessionNote,
})

const provisionalContextHashPayload = (
  row: ProvisionalActivationPayload['snapshot']['context'],
): JsonValue => ({
  project_id: row.projectId,
  project_title_snapshot: row.projectTitleSnapshot,
  level2_work_item_id: row.level2WorkItemId,
  level2_title_snapshot: row.level2TitleSnapshot,
  level2_parent_id_snapshot: row.level2ParentIdSnapshot,
  level2_status_definition_id_snapshot: row.level2StatusDefinitionIdSnapshot,
  level2_version_snapshot: row.level2VersionSnapshot,
  level2_effort_lower_seconds_snapshot: row.level2EffortLowerSecondsSnapshot,
  level2_effort_upper_seconds_snapshot: row.level2EffortUpperSecondsSnapshot,
  linked_at: row.linkedAt,
  link_method: row.linkMethod,
})

const provisionalPlanHashPayload = (
  row: ProvisionalActivationPayload['snapshot']['plan'][number],
): JsonValue => ({
  id: row.id,
  work_item_id: row.workItemId,
  title_snapshot: row.titleSnapshot,
  level2_work_item_id_snapshot: row.level2WorkItemIdSnapshot,
  work_item_version_snapshot: row.workItemVersionSnapshot,
  plan_rank: row.planRank,
  source: row.source,
  added_at: row.addedAt,
  removed_at: row.removedAt,
  removal_reason: row.removalReason,
  current_during_session: row.currentDuringSession,
  completion_draft: row.completionDraft,
})

export const activateProvisionalHashPayload = (
  payload: ProvisionalActivationPayload,
): JsonValue => ({
  cached_at: payload.cachedAt,
  owner_device_id: payload.ownerDeviceId,
  owner_tab_id: payload.ownerTabId,
  snapshot: {
    session: provisionalSessionHashPayload(payload.snapshot.session),
    context: provisionalContextHashPayload(payload.snapshot.context),
    plan: payload.snapshot.plan.map(provisionalPlanHashPayload),
  },
})

const resolveHashPayload = (body: ResolveActivationConflictRequest): JsonValue => ({
  winner_role: body.winnerRole,
  decision_at: body.decisionAt,
  validity_correction: {
    loser_validity: body.validityCorrection.loserValidity,
    loser_validity_reason: body.validityCorrection.loserValidityReason,
  },
})

export const activeSessionApi = {
  async locate() {
    const { data } = await metaApi.get('/active-session')
    return data === null ? null : locatedActiveSessionSchema.parse(data)
  },
  async start(body: GlobalStartActiveSessionRequest) {
    if (!body.spaceId) throw new Error('spaceId is required for global start')
    const wirePayload = startActiveSessionPayloadSchema.parse({
      level2WorkItemId: body.level2WorkItemId,
      level3WorkItemIds: body.level3WorkItemIds,
      plannedSeconds: body.plannedSeconds,
      startedAt: body.startedAt,
      ownerDeviceId: body.ownerDeviceId,
      ownerTabId: body.ownerTabId,
      expectedWorkItemVersions: body.expectedWorkItemVersions,
    })
    const wire = startActiveSessionRequestSchema.parse(await activeCommandWire({
      operationId: body.operationId, spaceId: body.spaceId, sessionId: body.sessionId,
      ownershipEpoch: null, wirePayload, hashPayload: startHashPayload(body),
    }))
    const { data } = await metaApi.post('/active-session/start', wire, keyed(body.operationId))
    return activeSessionSchema.parse(data)
  },
  async heartbeat(body: HeartbeatRequest) {
    const wirePayload = heartbeatPayloadSchema.parse({
      ownerDeviceId: body.ownerDeviceId, ownerTabId: body.ownerTabId,
      heartbeatAt: body.heartbeatAt,
    })
    const { data } = await metaApi.post(
      '/active-session/heartbeat', heartbeatRequestSchema.parse(await activeCommandWire({
        ...body, wirePayload,
        hashPayload: heartbeatHashPayload(body),
      })), keyed(body.operationId),
    )
    return heartbeatResponseSchema.parse(data)
  },
  async pause(body: OwnedClockRequest) {
    const wirePayload = {
      expectedVersion: body.expectedVersion, occurredAt: body.occurredAt,
      ownerDeviceId: body.ownerDeviceId, ownerTabId: body.ownerTabId,
    }
    const { data } = await metaApi.post(
      '/active-session/pause', pauseActiveSessionRequestSchema.parse(await activeCommandWire({
        ...body, wirePayload, hashPayload: clockHashPayload(body),
      })), keyed(body.operationId),
    )
    return activeSessionSchema.parse(data)
  },
  async resume(body: OwnedClockRequest) {
    const wirePayload = {
      expectedVersion: body.expectedVersion, occurredAt: body.occurredAt,
      ownerDeviceId: body.ownerDeviceId, ownerTabId: body.ownerTabId,
    }
    const { data } = await metaApi.post(
      '/active-session/resume', resumeActiveSessionRequestSchema.parse(await activeCommandWire({
        ...body, wirePayload, hashPayload: clockHashPayload(body),
      })), keyed(body.operationId),
    )
    return activeSessionSchema.parse(data)
  },
  async end(body: EndActiveSessionRequest) {
    const wirePayload = endActiveSessionPayloadSchema.parse({
      expectedVersion: body.expectedVersion, occurredAt: body.occurredAt,
      timerCompletion: body.timerCompletion, validity: body.validity,
      validityReason: body.validityReason,
      ownerDeviceId: body.ownerDeviceId, ownerTabId: body.ownerTabId,
    })
    const { data } = await metaApi.post(
      '/active-session/end', endActiveSessionRequestSchema.parse(await activeCommandWire({
        ...body, wirePayload,
        hashPayload: endHashPayload(body),
      })), keyed(body.operationId),
    )
    return terminalActiveSessionResponseSchema.parse(data)
  },
  async takeover(body: LocatorDerivedMutationRequest & {
    newOwnerDeviceId: string; newOwnerTabId: string;
  }) {
    const wirePayload = takeoverPayloadSchema.parse({
      newOwnerDeviceId: body.newOwnerDeviceId, newOwnerTabId: body.newOwnerTabId,
    })
    const { data } = await metaApi.post(
      '/active-session/takeover', takeoverRequestSchema.parse(await activeCommandWire({
        ...body, wirePayload,
        hashPayload: {
          new_owner_device_id: body.newOwnerDeviceId, new_owner_tab_id: body.newOwnerTabId,
        },
      })), keyed(body.operationId),
    )
    return activeSessionSchema.parse(data)
  },
  async updateNote(body: UpdateActiveSessionNoteRequest) {
    const wirePayload = updateActiveSessionNotePayloadSchema.parse({
      expectedVersion: body.expectedVersion, sessionNote: body.sessionNote,
      ownerDeviceId: body.ownerDeviceId, ownerTabId: body.ownerTabId,
    })
    const wire = updateActiveSessionNoteRequestSchema.parse(await activeCommandWire({
      ...body, wirePayload, hashPayload: noteHashPayload(body),
    }))
    const { data } = await metaApi.put('/active-session/note', wire, keyed(body.operationId))
    return activeSessionSchema.parse(data)
  },
  async setCurrentPlanItem(body: SetCurrentPlanItemRequest) {
    const wirePayload = setCurrentPlanItemPayloadSchema.parse({
      workItemId: body.workItemId, expectedPlanVersions: body.expectedPlanVersions,
      ownerDeviceId: body.ownerDeviceId, ownerTabId: body.ownerTabId,
    })
    const wire = setCurrentPlanItemRequestSchema.parse(await activeCommandWire({
      ...body, wirePayload, hashPayload: currentPlanHashPayload(body),
    }))
    const { data } = await metaApi.post(
      '/active-session/plan/current', wire, keyed(body.operationId),
    )
    return activeSessionSchema.parse(data)
  },
  async setCompletionDraft(body: SetCompletionDraftRequest) {
    const wirePayload = setCompletionDraftPayloadSchema.parse({
      planItemId: body.planItemId, expectedPlanVersion: body.expectedPlanVersion,
      completionDraft: body.completionDraft,
      ownerDeviceId: body.ownerDeviceId, ownerTabId: body.ownerTabId,
    })
    const wire = setCompletionDraftRequestSchema.parse(await activeCommandWire({
      ...body, wirePayload, hashPayload: completionDraftHashPayload(body),
    }))
    const { data } = await metaApi.post(
      '/active-session/plan/completion-draft', wire, keyed(body.operationId),
    )
    return activeSessionSchema.parse(data)
  },
  async addPlanItem(body: AddPlanItemRequest) {
    const wirePayload = addPlanItemPayloadSchema.parse({
      workItemId: body.workItemId, expectedWorkItemVersion: body.expectedWorkItemVersion,
      planRank: body.planRank, addedAt: body.addedAt,
      ownerDeviceId: body.ownerDeviceId, ownerTabId: body.ownerTabId,
    })
    const wire = addPlanItemRequestSchema.parse(await activeCommandWire({
      ...body, wirePayload, hashPayload: addPlanHashPayload(body),
    }))
    const { data } = await metaApi.post('/active-session/plan/add', wire, keyed(body.operationId))
    return activeSessionSchema.parse(data)
  },
  async removePlanItem(body: RemovePlanItemRequest) {
    const wirePayload = removePlanItemPayloadSchema.parse({
      planItemId: body.planItemId, expectedPlanVersion: body.expectedPlanVersion,
      removedAt: body.removedAt, removalReason: body.removalReason,
      ownerDeviceId: body.ownerDeviceId, ownerTabId: body.ownerTabId,
    })
    const wire = removePlanItemRequestSchema.parse(await activeCommandWire({
      ...body, wirePayload, hashPayload: removePlanHashPayload(body),
    }))
    const { data } = await metaApi.post(
      '/active-session/plan/remove', wire, keyed(body.operationId),
    )
    return activeSessionSchema.parse(data)
  },
  async activateProvisional(body: ActivateProvisionalInput) {
    if (!body.spaceId) throw new Error('spaceId is required for provisional activation')
    const wirePayload = activateProvisionalPayloadSchema.parse(body.payload)
    const wire = activateProvisionalRequestSchema.parse(await activeCommandWire({
      operationId: body.operationId, spaceId: body.spaceId, sessionId: body.sessionId,
      ownershipEpoch: null, wirePayload,
      hashPayload: activateProvisionalHashPayload(wirePayload),
    }))
    const { data } = await metaApi.post(
      '/active-session/activate-provisional', wire, keyed(body.operationId),
    )
    return activeSessionSchema.or(activationConflictSchema).parse(data)
  },
  async resolveActivationConflict(body: ResolveActivationConflictRequest) {
    const wirePayload = resolveActivationConflictPayloadSchema.parse({
      winnerRole: body.winnerRole,
      decisionAt: body.decisionAt, validityCorrection: body.validityCorrection,
    })
    const wire = resolveActivationConflictRequestSchema.parse(await activeCommandWire({
      operationId: body.operationId, sessionId: body.sessionId,
      ownershipEpoch: body.ownershipEpoch,
      wirePayload,
      hashPayload: resolveHashPayload(body),
    }))
    const { data } = await metaApi.post(
      '/active-session/resolve-activation-conflict', wire, keyed(body.operationId),
    )
    return activeSessionSchema.parse(data)
  },
}
```

```typescript
// frontend/src/services/focus-session-api.ts
import { spaceApi } from './api'
import type { components } from '@/types/api-generated'
import { assertResponseSpace } from '@/lib/contracts/task-space'
import { hashCommandPayload, type JsonValue } from '@/lib/contracts/payload-hash'
import {
  focusSessionAggregateSchema, reconcileFocusSessionCommandsInputSchema,
  reconcileFocusSessionCommandsRequestSchema,
  type FocusSessionAggregateView, type ReconcileFocusSessionCommandsInput,
} from '@/lib/contracts/focus-session'

type SessionReviewWire = components['schemas']['SubmitFocusSessionReviewRequest']
type SessionReviewWirePayload = NonNullable<SessionReviewWire['payload']>
type SessionReviewRequest = Omit<SessionReviewWire,
  'commandId' | 'payloadHash' | 'ownershipEpoch' | 'payload'> &
  SessionReviewWirePayload & { operationId: string }

function reviewOutcomeHashPayload(
  outcome: SessionReviewWirePayload['outcomes'][number],
): JsonValue {
  const payload: { [key: string]: JsonValue } = {
    work_item_id: outcome.workItemId,
    touched: outcome.touched,
    result: outcome.result,
    state_command: outcome.stateCommand,
  }
  const persona = outcome as typeof outcome & {
    executionPersona?: JsonValue; personaSwitched?: JsonValue; personaNote?: JsonValue;
  }
  if (persona.executionPersona !== undefined) {
    payload.execution_persona = persona.executionPersona
  }
  if (persona.personaSwitched !== undefined) {
    payload.persona_switched = persona.personaSwitched
  }
  if (persona.personaNote !== undefined) payload.persona_note = persona.personaNote
  return payload
}

const reviewHashPayload = (payload: SessionReviewWirePayload): JsonValue => ({
  validity: payload.validity,
  review_state: payload.reviewState,
  reviewed_at: payload.reviewedAt,
  outcomes: payload.outcomes.map(reviewOutcomeHashPayload),
})

function parseAggregate(
  raw: unknown, spaceId: string, sessionId: string,
): FocusSessionAggregateView {
  const aggregate = focusSessionAggregateSchema.parse(raw)
  assertResponseSpace(aggregate.session, spaceId)
  if (aggregate.session.id !== sessionId) throw new Error('focus_session_identity_mismatch')
  return aggregate
}

export const focusSessionApi = {
  async get(spaceId: string, sessionId: string) {
    const { data } = await spaceApi.get(`/focus-sessions/${sessionId}`)
    return parseAggregate(data, spaceId, sessionId)
  },
  async submitReview(input: SessionReviewRequest) {
    const wirePayload: SessionReviewWirePayload = {
      expectedVersion: input.expectedVersion,
      validity: input.validity,
      reviewState: input.reviewState,
      reviewedAt: input.reviewedAt,
      outcomes: input.outcomes,
    }
    const body = {
      commandId: input.operationId,
      spaceId: input.spaceId,
      sessionId: input.sessionId,
      ownershipEpoch: null,
      payloadHash: await hashCommandPayload(reviewHashPayload(wirePayload)),
      payload: wirePayload,
    }
    const { data } = await spaceApi.post(
      `/focus-sessions/${input.sessionId}/review`, body,
      { headers: { 'Idempotency-Key': input.operationId } },
    )
    return parseAggregate(data, input.spaceId, input.sessionId)
  },
  async reconcileCommands(rawInput: ReconcileFocusSessionCommandsInput) {
    const input = reconcileFocusSessionCommandsInputSchema.parse(rawInput)
    const operationId = input.operationId
    const wirePayload = {
      commandIds: input.commandIds,
      replaySafe: input.replaySafe,
      abandonCommandIds: input.abandonCommandIds,
      decisionAt: input.decisionAt,
    }
    const body = reconcileFocusSessionCommandsRequestSchema.parse({
      commandId: operationId, spaceId: input.spaceId, sessionId: input.sessionId,
      ownershipEpoch: null,
      payloadHash: await hashCommandPayload({
        command_ids: input.commandIds, replay_safe: input.replaySafe,
        abandon_command_ids: input.abandonCommandIds, decision_at: input.decisionAt,
      }),
      payload: wirePayload,
    })
    const { data } = await spaceApi.post(
      `/focus-sessions/${input.sessionId}/commands/reconcile`, body,
      { headers: { 'Idempotency-Key': operationId } },
    )
    return parseAggregate(data, input.spaceId, input.sessionId)
  },
}
```

Adapter tests assert that no function reads or writes `tokenStorage` and that `spaceId` mismatch rejects before repository persistence.
They also assert `Object.keys(focusSessionApi).sort()` is exactly
`['get', 'reconcileCommands', 'submitReview']`, so the frontend cannot call the
public Space-scoped lifecycle methods even if a backend Protocol still exposes
internal guarded methods.

- [ ] **Step 9: Run payload-vector, runtime, Adapter, generated-contract, and type gates**

Run from `frontend/`:

```powershell
npm run test -- --run src/lib/contracts/payload-hash.test.ts src/lib/contracts/task-space.test.ts src/lib/contracts/focus-session.test.ts src/services/task-space-api.test.ts src/services/focus-session-api.test.ts src/services/active-session-api.test.ts src/types/api-generated.contract.test.ts
npm run typecheck
```

Expected: PASS; all malformed discriminators/axes fail before persistence, all active-Session actions use `metaApi`, and inferred schemas remain assignable to the generated TS0-TS2 types.

- [ ] **Step 10: Commit payload hashing, runtime contracts, and Adapters**

```powershell
git add -- frontend/package.json frontend/package-lock.json frontend/src/lib/contracts/payload-hash.ts frontend/src/lib/contracts/payload-hash.test.ts frontend/src/lib/contracts/fixtures/task-space-session-payload-hash-vectors.json frontend/src/lib/contracts/task-space.ts frontend/src/lib/contracts/task-space.test.ts frontend/src/lib/contracts/focus-session.ts frontend/src/lib/contracts/focus-session.test.ts frontend/src/services/task-space-api.ts frontend/src/services/task-space-api.test.ts frontend/src/services/focus-session-api.ts frontend/src/services/focus-session-api.test.ts frontend/src/services/active-session-api.ts frontend/src/services/active-session-api.test.ts
git commit -m "feat(frontend): add task space session contracts"
```

---

### Task 2: Perform The Dexie v18 Breaking Cutover And Meta v2 Coordination Upgrade

**Files:**
- Create: `frontend/src/services/dexie-v18-schema.ts`
- Create: `frontend/src/services/dexie-v18-cutover.ts`
- Modify: `frontend/src/services/database.ts`
- Modify: `frontend/src/services/database.test.ts`
- Modify: `frontend/src/services/space-db.ts`
- Modify: `frontend/src/services/meta-database.ts`
- Create: `frontend/src/services/meta-database.test.ts`
- Modify: `frontend/src/types/index.ts`
- Modify: `frontend/src/types/sync.ts`
- Delete: `frontend/src/types/phase1.ts`
- Delete: `frontend/src/types/phase2.ts`
- Delete: `frontend/src/stores/task-store.ts`
- Delete: `frontend/src/stores/session-store.ts`
- Modify: `frontend/src/stores/index.ts`
- Modify: `frontend/src/stores/business-stores.test.ts`
- Modify: `frontend/src/utils/constants.ts`
- Modify: `frontend/src/lib/sync/types.ts`
- Modify: `frontend/src/lib/sync/types.test.ts`
- Modify: `frontend/src/lib/sync/outbox.ts`
- Modify: `frontend/src/lib/sync/outbox.test.ts`
- Modify: `frontend/src/lib/quick-notes/quick-note-repository.ts`
- Modify: `frontend/src/lib/quick-notes/quick-note-repository.test.ts`
- Modify: `frontend/src/stores/trash-store.ts`
- Modify: `frontend/src/stores/trash-store.test.ts`
- Modify: `frontend/src/stores/quick-note-store.test.ts`
- Modify: `frontend/src/components/trash/trash-view.test.tsx`
- Modify: `frontend/src/components/quick-notes/quick-notes-view.test.tsx`
- Modify: `frontend/src/components/quick-notes/use-quick-note-draft-session.test.tsx`
- Modify: `frontend/src/components/quick-notes/use-quick-note-editor.test.tsx`
- Modify: `frontend/src/lib/quick-notes/quick-note-focus.test.ts`
- Modify: `frontend/src/lib/quick-notes/quick-note-draft-repository.test.ts`
- Modify: `frontend/src/lib/quick-notes/quick-note-selectors.test.ts`
- Modify: `frontend/src/lib/sync/quick-note-sync.integration.test.ts`
- Modify: `frontend/src/lib/sync/engine.test.ts`
- Modify: `frontend/src/lib/sync/merge.test.ts`
- Modify: `frontend/src/lib/sync/pull-loop.test.ts`
- Modify: `frontend/src/lib/sync/push-batch.test.ts`
- Modify: `frontend/src/lib/sync/sync-meta.test.ts`
- Modify: `frontend/src/hooks/use-sync.test.ts`
- Modify: `frontend/src/components/sync/conflict-panel.test.tsx`
- Modify: `frontend/src/services/space-db.test.ts`
- Consume unchanged: `backend/tests/fixtures/task_space_session_child_operation_id_vectors.json`
- Create deterministic copy: `frontend/src/lib/contracts/fixtures/task-space-session-child-operation-id-vectors.json`

**Interfaces:**
- Consumes: S3 Dexie v17 `OutboxEvent.operationId`, `expectedVersion`, and `requiresVersionRebase`; S3's authoritative `child-v1` vector bytes and injective `childp:`/`childh:` algorithm; Task 1 inferred document/Session types; TS0 final 31-entry catalog and removed legacy keys.
- Produces: native `atomicDexieV18Cutover(dbName)` whose exclusive versionchange transaction scans before DDL and aborts without changing v17; an `openPomodoroXIDB(spaceId)` factory and `PomodoroXIDB.spaceId` identity that require the exact `dexieDbNameForSpace(spaceId)` name while preserving Dexie's declared `open()` type; per-Space Dexie v18 final tables with all ten removed stores absent and no `session_id`/`task_id` on surviving QuickNote/TimeBlock rows; nonoptional same-Space `OutboxEvent.spaceId`; strict canonical RFC3339 string outbox intent timestamps; immutable `CachedSessionCommandEnvelope.replaySafe`; `WorkItemNoteConflictRow`, `SessionCommandQueueRow`, `CommandReconciliationAttemptRow`, `SessionActivationConflictRow`, `SessionActivationApplicationReceiptRow`, `DirectCommandIntentRow`, `SessionReviewDraftRow`, and `TimerNoteComposerDraftRow`; Meta Dexie v2 `ActiveSessionLocatorMirror`, `DeviceIdentityRow`, `SessionTabRow`, and full-intent-bound `ProvisionalOperationRow`; `TS3_LOCAL_ENTITY_TO_TABLE`; final-entity outbox rows held as `awaiting_s4` or `blocked_conflict`.

- [ ] **Step 1: Copy S3 child-ID vectors byte-for-byte and write failing cutover/schema tests**

Run from `frontend/` before writing the tests. The backend fixture is the authority; do not reserialize it:

```powershell
$source = '..\backend\tests\fixtures\task_space_session_child_operation_id_vectors.json'
$target = 'src\lib\contracts\fixtures\task-space-session-child-operation-id-vectors.json'
if (-not (Test-Path -LiteralPath $source)) { throw "missing S3 child operation ID vectors" }
Copy-Item -LiteralPath $source -Destination $target -Force
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash -ne
    (Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash) {
  throw "child operation ID vector copy drift"
}
```

```typescript
// Merge this import into frontend/src/services/database.test.ts's existing import
// section, then append the helpers/tests below its current suites.
import { dexieDbNameForSpace } from '@/lib/platform'
import { openPomodoroXIDB } from './dexie-v18-cutover'
import {
  DEXIE_V18_NATIVE_VERSION, expectedV18SchemaInventory,
} from './dexie-v18-schema'

interface LogicalStoreInventory {
  name: string
  keyPath: string | string[] | null
  autoIncrement: boolean
  indexes: Array<{
    name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean
  }>
  keys: IDBValidKey[]
  rows: unknown[]
}

interface LogicalIndexedDbInventory {
  version: number
  stores: LogicalStoreInventory[]
}

// Test-only oracle. It is deliberately independent from V18_STORE_DEFINITIONS
// and must never drive either the native or Dexie schema projection.
const REQUIRED_V18_ACTIVE_STORE_NAMES = Object.freeze([
  'directCommandIntents', 'folders', 'focusSessions', 'habitCheckIns', 'habits',
  'labels', 'memoComments', 'notes', 'outbox', 'projects', 'quickNotes',
  'reflectionTemplates', 'reflections', 'reportTemplates', 'reports',
  'scheduleQuickNotes', 'schedules', 'sessionActivationApplications',
  'sessionActivationConflicts', 'sessionAttributionRevisions',
  'sessionCommandEnvelopes', 'sessionCommandQueue',
  'sessionCommandReceipts', 'sessionCommandReconciliationAttempts',
  'sessionReviewDrafts', 'sessionTaskContexts', 'sessionWorkItemOutcomes',
  'sessionWorkItemPlans', 'settings', 'statusDefinitions', 'syncMeta', 'tags',
  'timeBlocks', 'timerNoteComposerDrafts', 'typeDefinitions', 'workItemLabels',
  'workItemNoteConflicts', 'workItemNotes', 'workItems',
].sort())

const requestResult = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})

const transactionDone = (transaction: IDBTransaction) => new Promise<void>((resolve, reject) => {
  transaction.oncomplete = () => resolve()
  transaction.onabort = () => reject(transaction.error)
  transaction.onerror = () => reject(transaction.error)
})

async function openExistingRaw(name: string): Promise<IDBDatabase> {
  return await new Promise((resolve, reject) => {
    const request = indexedDB.open(name)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    request.onupgradeneeded = () => {
      request.transaction!.abort()
      reject(new Error(`test database does not exist: ${name}`))
    }
  })
}

async function readNativeIndexedDbVersion(name: string): Promise<number> {
  const database = await openExistingRaw(name)
  try { return database.version } finally { database.close() }
}

async function logicalIndexedDbInventory(name: string): Promise<LogicalIndexedDbInventory> {
  const database = await openExistingRaw(name)
  const names = Array.from(database.objectStoreNames).sort()
  const transaction = database.transaction(names, 'readonly')
  const done = transactionDone(transaction)
  try {
    const stores = await Promise.all(names.map(async (name) => {
      const store = transaction.objectStore(name)
      const indexes = Array.from(store.indexNames).sort().map((indexName) => {
        const index = store.index(indexName)
        return { name: index.name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry }
      })
      const keysRequest = store.getAllKeys()
      const rowsRequest = store.getAll()
      const [keys, rows] = await Promise.all([
        requestResult(keysRequest), requestResult(rowsRequest),
      ])
      return {
        name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes,
        keys, rows,
      }
    }))
    await done
    return { version: database.version, stores }
  } finally {
    database.close()
  }
}

describe('Dexie v18 Task Space cutover', () => {
  const removedStores = [
    'tasks', 'sessions', 'sessionEvents', 'sessionContexts', 'cognitiveMarks',
    'taskTags', 'taskRelations', 'focusPatterns', 'taskQuickNotes', 'sessionQuickNotes',
  ] as const
  const v17Stores = {
    tasks: 'id', sessions: 'id', sessionEvents: 'id', sessionContexts: 'id',
    cognitiveMarks: 'id', taskTags: 'id', taskRelations: 'id', focusPatterns: 'id',
    taskQuickNotes: 'id', sessionQuickNotes: 'id',
    quickNotes: 'id, session_id', timeBlocks: 'id, task_id',
    reflections: 'id', reports: 'id', reportTemplates: 'id',
    outbox: '++id, entityType, entityId, synced, createdAt',
  }

  it('opens an empty v17 database at v18 with only final tables', async () => {
    const spaceId = `space-v18-empty-${crypto.randomUUID()}`
    const name = dexieDbNameForSpace(spaceId)
    const old = new Dexie(name)
    old.version(17).stores(v17Stores)
    await old.open()
    old.close()

    const db = await openPomodoroXIDB(spaceId)
    expect(db.verno).toBe(18)
    expect(db.tables.map((table) => table.name).sort())
      .toEqual(REQUIRED_V18_ACTIVE_STORE_NAMES)
    expect(db.quickNotes.schema.indexes.map((index) => index.name)).not.toContain('session_id')
    expect(db.timeBlocks.schema.indexes.map((index) => index.name)).not.toContain('task_id')
    await db.delete()
  })

  it('keeps clean-install, empty-v17, native, Dexie, and schema-authority inventories equal', async () => {
    const cleanSpaceId = `space-v18-clean-${crypto.randomUUID()}`
    const upgradedSpaceId = `space-v18-upgraded-${crypto.randomUUID()}`
    const cleanName = dexieDbNameForSpace(cleanSpaceId)
    const upgradedName = dexieDbNameForSpace(upgradedSpaceId)
    const clean = await openPomodoroXIDB(cleanSpaceId)
    const old = new Dexie(upgradedName)
    old.version(17).stores(v17Stores)
    await old.open()
    old.close()
    const upgraded = await openPomodoroXIDB(upgradedSpaceId)

    const withoutRows = (inventory: LogicalIndexedDbInventory) =>
      inventory.stores.map(({ keys: _keys, rows: _rows, ...schema }) => schema)
    const fromDexie = (database: PomodoroXIDB) => [...database.tables]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((table) => ({
        name: table.name,
        keyPath: table.schema.primKey.keyPath ?? null,
        autoIncrement: Boolean(table.schema.primKey.auto),
        indexes: table.schema.indexes.map((index) => ({
          name: index.name, keyPath: index.keyPath!,
          unique: Boolean(index.unique), multiEntry: Boolean(index.multi),
        })).sort((left, right) => left.name.localeCompare(right.name)),
      }))
    const expected = expectedV18SchemaInventory()
    const cleanRaw = await logicalIndexedDbInventory(cleanName)
    const upgradedRaw = await logicalIndexedDbInventory(upgradedName)
    expect(expected.map((store) => store.name)).toEqual(REQUIRED_V18_ACTIVE_STORE_NAMES)
    expect(cleanRaw.version).toBe(DEXIE_V18_NATIVE_VERSION)
    expect(upgradedRaw.version).toBe(DEXIE_V18_NATIVE_VERSION)
    expect(withoutRows(cleanRaw)).toEqual(expected)
    expect(withoutRows(upgradedRaw)).toEqual(expected)
    expect(fromDexie(clean)).toEqual(expected)
    expect(fromDexie(upgraded)).toEqual(expected)
    await clean.delete()
    await upgraded.delete()
  })

  it('preserves surviving rows that contain no legacy Task/Session reference', async () => {
    const spaceId = `space-v18-surviving-${crypto.randomUUID()}`
    const name = dexieDbNameForSpace(spaceId)
    const survivingRows = Object.freeze([
      ['quickNotes', Object.freeze({ id: 'quick-clean', content: 'Keep', tags: ['focus'] })],
      ['timeBlocks', Object.freeze({ id: 'block-clean', date: '2026-07-16', title: 'Keep' })],
      ['reflections', Object.freeze({
        id: 'reflection-clean', content: 'Keep', mood: 'calm', tags: ['focus'],
      })],
      ['reports', Object.freeze({
        id: 'report-clean', config: { dimensions: ['tags'], tags: ['focus'] },
      })],
      ['reportTemplates', Object.freeze({
        id: 'template-clean', config: { dimensions: ['mood'], moods: ['calm'] },
      })],
    ] as const)
    const old = new Dexie(name)
    old.version(17).stores(v17Stores)
    await old.open()
    for (const [table, row] of survivingRows) await old.table(table).put(row)
    old.close()

    const upgraded = await openPomodoroXIDB(spaceId)
    for (const [table, expectedRow] of survivingRows) {
      expect(await upgraded.table(table).get(expectedRow.id)).toEqual(expectedRow)
    }
    await upgraded.delete()
  })

  it.each(removedStores)('rejects populated %s before any v18 DDL', async (store) => {
    const spaceId = `space-v18-${store}-${crypto.randomUUID()}`
    const name = dexieDbNameForSpace(spaceId)
    const old = new Dexie(name)
    old.version(17).stores(v17Stores)
    await old.open()
    await old.table(store).put({ id: 'legacy-row' })
    old.close()

    const before = await logicalIndexedDbInventory(name)
    await expect(openPomodoroXIDB(spaceId))
      .rejects.toThrow(`legacy_client_data_present:${store}`)
    expect(await logicalIndexedDbInventory(name)).toEqual(before)
    expect(await readNativeIndexedDbVersion(name)).toBe(170)
    await Dexie.delete(name)
  })

  it('observes a v17 write committed while an old Tab handles versionchange', async () => {
    const spaceId = `space-v18-versionchange-race-${crypto.randomUUID()}`
    const name = dexieDbNameForSpace(spaceId)
    const seed = new Dexie(name)
    seed.version(17).stores(v17Stores)
    await seed.open()
    seed.close()

    const oldTab = await openExistingRaw(name)
    const writeCommitted = new Promise<void>((resolve, reject) => {
      oldTab.onversionchange = () => {
        const transaction = oldTab.transaction('tasks', 'readwrite')
        transaction.objectStore('tasks').put({ id: 'last-v17-write' })
        transaction.oncomplete = () => { oldTab.close(); resolve() }
        transaction.onabort = () => reject(transaction.error)
        transaction.onerror = () => reject(transaction.error)
      }
    })

    const opening = openPomodoroXIDB(spaceId)
    await writeCommitted
    await expect(opening).rejects.toThrow('legacy_client_data_present:tasks')
    expect(await readNativeIndexedDbVersion(name)).toBe(170)
    const preserved = await openExistingRaw(name)
    expect(await requestResult(
      preserved.transaction('tasks', 'readonly').objectStore('tasks').get('last-v17-write'),
    )).toEqual({ id: 'last-v17-write' })
    preserved.close()
    await Dexie.delete(name)
  })

  it.each([
    ['quickNotes', { id: 'quick-1', session_id: null }],
    ['timeBlocks', { id: 'block-1', task_id: null }],
    ['reflections', { id: 'reflection-1', related_task_ids: [] }],
    ['reports', { id: 'report-1', config: { task_ids: [] } }],
    ['reports', { id: 'report-2', config: { dimensions: ['task_type'] } }],
    ['reportTemplates', { id: 'template-1', config: { session_types: [] } }],
    ['reportTemplates', { id: 'template-2', config: { dimensions: ['session_type'] } }],
    ['outbox', { entityType: 'quickNote', entityId: 'quick-1', createdAt: 1 }],
  ] as const)('rejects any legacy reference or old outbox row in %s', async (store, row) => {
    const spaceId = `space-v18-reference-${crypto.randomUUID()}`
    const name = dexieDbNameForSpace(spaceId)
    const old = new Dexie(name)
    old.version(17).stores(v17Stores)
    await old.open()
    await old.table(store).add(row)
    old.close()
    const before = await logicalIndexedDbInventory(name)
    await expect(openPomodoroXIDB(spaceId)).rejects.toThrow('legacy_client_data_present')
    expect(await logicalIndexedDbInventory(name)).toEqual(before)
    expect(await readNativeIndexedDbVersion(name)).toBe(170)
    await Dexie.delete(name)
  })

  it('persists the server replay declaration in the envelope and queue rows', async () => {
    const db = await openPomodoroXIDB(`pxii-v18-replay-${crypto.randomUUID()}`)
    const envelope = {
      commandId: 'cmd-a', spaceId: 'space-a', sessionId: 'fs-a', sessionRevision: 1,
      workItemId: 'l3-a', expectedVersion: 4, targetTransition: 'complete',
      replaySafe: true, payloadHash: 'a'.repeat(64), createdAt: '2026-07-15T08:00:00Z',
    }
    await db.sessionCommandEnvelopes.put(envelope)
    await db.sessionCommandQueue.put({
      commandId: 'cmd-a', spaceId: 'space-a', sessionId: 'fs-a',
      payloadHash: envelope.payloadHash, replaySafe: envelope.replaySafe,
      envelopeJson: JSON.stringify(envelope), state: 'held', lastReceiptState: 'unknown',
      createdAt: envelope.createdAt, updatedAt: envelope.createdAt,
    })
    expect(await db.sessionCommandEnvelopes.get('cmd-a')).toMatchObject({ replaySafe: true })
    expect(await db.sessionCommandQueue.get('cmd-a')).toMatchObject({ replaySafe: true })
    await db.delete()
  })
})
```

```typescript
// In frontend/src/lib/sync/outbox.test.ts, add `vi` to the existing Vitest
// import and `boundedChildOperationId` to the existing `./outbox` import. Add
// these Node imports at the top, then append the helper/tests below the imports.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

async function importFreshOutboxModule() {
  vi.resetModules()
  return await import('./outbox')
}

interface ChildOperationIdVectorFile {
  algorithm: 'child-v1'
  valid: Array<{
    name: string; parent_id: string; suffix: string; expected: string
  }>
  invalid: Array<{
    name: string; parent_id: string; suffix: string; error: string
  }>
}

const backendChildVectorPath = resolve(
  process.cwd(), '../backend/tests/fixtures/task_space_session_child_operation_id_vectors.json',
)
const frontendChildVectorPath = resolve(
  process.cwd(), 'src/lib/contracts/fixtures/task-space-session-child-operation-id-vectors.json',
)
const backendChildVectorBytes = readFileSync(backendChildVectorPath)
const frontendChildVectorBytes = readFileSync(frontendChildVectorPath)
const childVectors = JSON.parse(
  frontendChildVectorBytes.toString('utf8'),
) as ChildOperationIdVectorFile

it('uses the byte-identical authoritative S3 child operation ID vectors', async () => {
  expect(createHash('sha256').update(frontendChildVectorBytes).digest('hex')).toBe(
    createHash('sha256').update(backendChildVectorBytes).digest('hex'),
  )
  expect(frontendChildVectorBytes.equals(backendChildVectorBytes)).toBe(true)
  expect(childVectors.algorithm).toBe('child-v1')
  expect(childVectors.valid.map((vector) => vector.name)).toEqual(expect.arrayContaining([
    'colon_parent', 'colon_suffix', 'plain_result_127', 'plain_result_128',
    'first_overflow_129', 'parent_127', 'parent_128', 'suffix_512',
  ]))
  expect(childVectors.invalid.map((vector) => vector.name)).toEqual(expect.arrayContaining([
    'suffix_513', 'suffix_non_ascii',
  ]))
  for (const vector of childVectors.valid) {
    expect(await boundedChildOperationId(vector.parent_id, vector.suffix), vector.name)
      .toBe(vector.expected)
  }
  for (const vector of childVectors.invalid) {
    await expect(boundedChildOperationId(vector.parent_id, vector.suffix), vector.name)
      .rejects.toThrow(vector.error)
  }
})

it('matches the S3 bounded child ID vector and is stable across a fresh instance', async () => {
  const vector = childVectors.valid.find((item) => item.name === 'parent_128')!
  expect(await boundedChildOperationId(vector.parent_id, vector.suffix)).toBe(vector.expected)
  expect(await importFreshOutboxModule().then((module) =>
    module.boundedChildOperationId(vector.parent_id, vector.suffix))).toBe(vector.expected)
})

it('keeps colon-bearing parent/suffix pairs injective in the readable namespace', async () => {
  const left = await boundedChildOperationId('a:receipt', 'pending')
  const right = await boundedChildOperationId('a', 'receipt:pending')
  expect(left).toBe('childp:9:a:receipt:pending')
  expect(right).toBe('childp:1:a:receipt:pending')
  expect(left).not.toBe(right)
})

it.each([
  [116, 127, 'childp:'],
  [117, 128, 'childp:'],
  [118, 71, 'childh:'],
] as const)(
  'uses disjoint plain/hash namespaces at the %i-byte suffix boundary',
  async (suffixLength, expectedLength, expected) => {
    const child = await boundedChildOperationId('p', 's'.repeat(suffixLength))
    expect(new TextEncoder().encode(child)).toHaveLength(expectedLength)
    expect(child.startsWith(expected)).toBe(true)
  },
)

it('accepts a 512-byte ASCII suffix and rejects 513 bytes or non-ASCII', async () => {
  const maxSuffix = await boundedChildOperationId('p', 's'.repeat(512))
  expect(maxSuffix.startsWith('childh:')).toBe(true)
  expect(new TextEncoder().encode(maxSuffix)).toHaveLength(71)
  await expect(boundedChildOperationId('p', 's'.repeat(513)))
    .rejects.toThrow('invalid child operation suffix')
  await expect(boundedChildOperationId('p', '计划'))
    .rejects.toThrow('invalid child operation suffix')
  await expect(boundedChildOperationId('p', 'pending\n'))
    .rejects.toThrow('invalid child operation suffix')
})

it('derives unique stable child IDs for every compound provisional entity', async () => {
  const root = 'offline-root'
  const suffixes = [
    'focus_session', 'session_task_context', 'attribution:0001',
    'plan:plan-a', 'plan:plan-b',
  ]
  const first = await Promise.all(suffixes.map((suffix) =>
    boundedChildOperationId(root, suffix)))
  const second = await Promise.all(suffixes.map((suffix) =>
    boundedChildOperationId(root, suffix)))
  expect(second).toEqual(first)
  expect(new Set(first).size).toBe(first.length)
  expect(first.every((id) => /^[\x21-\x7e]{1,128}$/.test(id))).toBe(true)
})
```

- [ ] **Step 2: Write failing Meta locator/device/tab/provisional mirror tests**

```typescript
// frontend/src/services/meta-database.test.ts
import { describe, expect, it } from 'vitest'
import { MetaDB, type ProvisionalOperationRow } from './meta-database'

const provisionalOperationFixture = (
  overrides: Partial<ProvisionalOperationRow> = {},
): ProvisionalOperationRow => ({
  operationId: 'offline-a', deviceId: 'device-a', tabId: 'tab-a',
  spaceId: 'space-a', sessionId: 'fs-a', cachedOwnershipEpoch: null,
  intentJson: '{"spaceId":"space-a","sessionId":"fs-a"}',
  payloadHash: 'a'.repeat(64), state: 'pending',
  createdAt: '2026-07-15T08:00:00Z', updatedAt: '2026-07-15T08:00:00Z',
  ...overrides,
})

describe('MetaDB v2 coordination mirrors', () => {
  it('stores locator identity without Session business content', async () => {
    const db = new MetaDB(`pxii-meta-${crypto.randomUUID()}`)
    await db.open()
    await db.activeSessionLocator.put({
      key: 'active', spaceId: 'space-a', sessionId: 'fs-1', operationId: 'start-1',
      state: 'active', ownerDeviceId: 'device-a', ownerTabId: 'tab-a',
      ownershipEpoch: 3, leaseExpiresAt: '2026-07-15T08:01:00Z',
      updatedAt: '2026-07-15T08:00:00Z',
    })
    const row = await db.activeSessionLocator.get('active')
    expect(Object.keys(row!).sort()).toEqual([
      'key', 'leaseExpiresAt', 'operationId', 'ownerDeviceId', 'ownerTabId',
      'ownershipEpoch', 'sessionId', 'spaceId', 'state', 'updatedAt',
    ])
    await db.delete()
  })

  it('prevents two unresolved same-device provisional starts', async () => {
    const db = new MetaDB(`pxii-meta-provisional-${crypto.randomUUID()}`)
    await db.open()
    await db.provisionalOperations.add(provisionalOperationFixture({
      operationId: 'offline-a', deviceId: 'device-a', tabId: 'tab-a',
      spaceId: 'space-a', sessionId: 'fs-a', state: 'pending',
      createdAt: '2026-07-15T08:00:00Z', updatedAt: '2026-07-15T08:00:00Z',
    }))
    await expect(db.claimProvisional(provisionalOperationFixture({
      operationId: 'offline-b', deviceId: 'device-a', tabId: 'tab-b',
      spaceId: 'space-b', sessionId: 'fs-b', state: 'pending',
      createdAt: '2026-07-15T08:01:00Z', updatedAt: '2026-07-15T08:01:00Z',
    }))).rejects.toThrow('active_session_exists')
    await db.delete()
  })

  it('does not treat the same Session ID in another Space as the same claim', async () => {
    const db = new MetaDB(`pxii-meta-composite-${crypto.randomUUID()}`)
    await db.open()
    await db.claimProvisional(provisionalOperationFixture({
      operationId: 'offline-a', deviceId: 'device-a', tabId: 'tab-a',
      spaceId: 'space-a', sessionId: 'shared-1', state: 'pending',
    }))
    await expect(db.claimProvisional(provisionalOperationFixture({
      operationId: 'offline-b', deviceId: 'device-a', tabId: 'tab-b',
      spaceId: 'space-b', sessionId: 'shared-1', state: 'pending',
    }))).rejects.toThrow('active_session_exists')
    await db.delete()
  })

  it('accepts only an identical operation intent as an idempotent claim', async () => {
    const db = new MetaDB(`pxii-meta-idempotent-${crypto.randomUUID()}`)
    await db.open()
    const intent = provisionalOperationFixture({
      operationId: 'offline-a', deviceId: 'device-a', tabId: 'tab-a',
      spaceId: 'space-a', sessionId: 'fs-a', state: 'pending',
    })
    await db.claimProvisional(intent)
    await db.claimProvisional({ ...intent })
    expect(await db.provisionalOperations.count()).toBe(1)
    await expect(db.claimProvisional({
      ...intent, operationId: 'offline-b',
    })).rejects.toThrow('active_session_exists')
    await db.delete()
  })

  it('retains an awaiting_s4 terminal operation without letting it occupy the active slot', async () => {
    const db = new MetaDB(`pxii-meta-terminal-${crypto.randomUUID()}`)
    await db.open()
    await db.provisionalOperations.add(provisionalOperationFixture({
      operationId: 'closed-op', spaceId: 'space-a', sessionId: 'closed-1',
      state: 'awaiting_s4',
    }))
    await db.claimProvisional(provisionalOperationFixture({
      operationId: 'next-op', spaceId: 'space-b', sessionId: 'next-1', state: 'pending',
    }))
    expect(await db.provisionalOperations.get('closed-op'))
      .toMatchObject({ state: 'awaiting_s4' })
    expect(await db.provisionalOperations.get('next-op')).toMatchObject({ state: 'pending' })
    await db.delete()
  })

  it('never rebinds an operation ID or downgrades terminal evidence', async () => {
    const db = new MetaDB(`pxii-meta-operation-binding-${crypto.randomUUID()}`)
    await db.open()
    const terminal = provisionalOperationFixture({ state: 'awaiting_s4' })
    await db.provisionalOperations.add(terminal)
    await db.claimProvisional(provisionalOperationFixture())
    expect(await db.provisionalOperations.get(terminal.operationId)).toEqual(terminal)
    await expect(db.claimProvisional(provisionalOperationFixture({
      intentJson: '{"spaceId":"space-b","sessionId":"fs-a"}',
      payloadHash: 'b'.repeat(64),
    }))).rejects.toThrow('idempotency_conflict')
    expect(await db.provisionalOperations.get(terminal.operationId)).toEqual(terminal)
    await db.delete()
  })
})
```

- [ ] **Step 3: Run database tests and verify the red state**

Run from `frontend/`:

```powershell
npm run test -- --run src/services/database.test.ts src/services/meta-database.test.ts src/lib/sync/types.test.ts src/lib/sync/outbox.test.ts
```

Expected: FAIL because v18, Meta v2, final tables, coordination rows, and final local entity mappings do not exist.

- [ ] **Step 4: Remove legacy compile surfaces and define final persisted row types**

```typescript
// append final-model declarations to frontend/src/types/index.ts
import type { WorkItemNoteDocument } from '@/lib/contracts/task-space'
import type {
  FocusSessionView, SessionAttributionRevisionView, SessionCommandEnvelopeView,
  SessionTaskContextView, SessionWorkItemOutcomeView, SessionWorkItemPlanView,
} from '@/lib/contracts/focus-session'

export interface CachedWorkItemNote {
  noteId: string
  workItemId: string
  document: WorkItemNoteDocument
  version: number
  localRevision: number
  syncState: 'clean' | 'dirty' | 'conflict'
  createdAt: string
  updatedAt: string
}

// API/cache rows are not Sync command post-images. Only the FocusSession cache
// carries derived clockState and renames the wire id to its Dexie key sessionId.
export type CachedFocusSession = Omit<FocusSessionView, 'id' | 'spaceId'> & {
  sessionId: string
}
export type CachedSessionTaskContext = Omit<SessionTaskContextView, 'spaceId'>
export type CachedSessionAttributionRevision =
  Omit<SessionAttributionRevisionView, 'spaceId'>
export type CachedSessionWorkItemPlan = Omit<SessionWorkItemPlanView, 'spaceId'>
export type CachedSessionWorkItemOutcome = Omit<SessionWorkItemOutcomeView, 'spaceId'>

export interface WorkItemNoteConflictRow {
  spaceId: string
  workItemId: string
  noteId: string
  localDocument: WorkItemNoteDocument
  localRevision: number
  baseVersion: number
  remoteDocument: WorkItemNoteDocument
  remoteVersion: number
  detectedAt: string
}

export type CachedSessionCommandEnvelope = SessionCommandEnvelopeView & {
  replaySafe: boolean
}

export interface SessionCommandQueueRow {
  commandId: string
  spaceId: string
  sessionId: string
  payloadHash: string
  replaySafe: boolean
  envelopeJson: string
  state: 'held' | 'querying' | 'dispatchable' | 'terminal'
  lastReceiptState: 'not_needed' | 'pending' | 'succeeded' | 'failed' |
    'conflict' | 'unknown' | 'abandoned'
  createdAt: string
  updatedAt: string
}

export interface CommandReconciliationAttemptRow {
  operationId: string
  spaceId: string
  sessionId: string
  requestJson: string
  requestHash: string
  state: 'prepared' | 'in_flight' | 'terminal'
  createdAt: string
  updatedAt: string
}

export interface SessionActivationConflictRow {
  conflictId: string
  provisionalOperationId: string
  authoritativeSpaceId: string
  authoritativeSessionId: string
  provisionalSpaceId: string
  provisionalSessionId: string
  detectedAt: string
  resolutionOperationId: string | null
  resolvedAt: string | null
  selectedRole: 'active' | 'candidate' | null
}

export interface SessionActivationApplicationReceiptRow {
  operationId: string
  provisionalSpaceId: string
  provisionalSessionId: string
  resultKind: 'authoritative' | 'resumed' | 'activation_conflict'
  resultHash: string
  resultJson: string
  activeSpaceId: string
  activeSessionId: string
  activeSessionVersion: number
  ownershipEpoch: number
  absorbedOutboxIds: number[]
  appliedAt: string
}

export interface DirectCommandIntentRow {
  operationId: string
  kind: 'create_project' | 'create_work_item' | 'move_work_item' |
    'transition_work_item' | 'submit_review'
  spaceId: string
  targetId: string | null
  requestJson: string
  requestHash: string
  state: 'prepared' | 'in_flight' | 'terminal'
  resultJson: string | null
  resultHash: string | null
  createdAt: string
  updatedAt: string
}

export interface SessionReviewDraftRow {
  spaceId: string
  sessionId: string
  draftJson: string
  operationId: string
  updatedAt: string
}

export interface TimerNoteComposerDraftRow {
  spaceId: string
  workItemId: string
  contentVersion: 1
  draftJson: string
  appendState: 'draft' | 'submitting' | 'committed'
  appendOperationId: string | null
  submittedBlockJson: string | null
  updatedAt: string
}
```

Before declaring v18, delete `task-store.ts`, `session-store.ts`, `types/phase1.ts`, and `types/phase2.ts`; remove their imports/reset registrations/tests and the legacy Task/Session export/constants surface. `QuickNote` and `TimeBlock` row types lose `session_id` and `task_id` rather than marking them optional. Reflection/report row and filter types lose their Task/Session arrays. Migrate every QuickNote component/store/repository fixture and every Sync engine/merge/pull/push/hook/conflict/Space-DB fixture listed by this Task; do not preserve old entity keys as test conveniences.

Freeze the post-migration inventory before the first v18 typecheck. `rg -l` over `frontend/src` for `session_id|task_id|taskQuickNotes|sessionQuickNotes|sessionEvents|sessionContexts|cognitiveMarks|taskTags|taskRelations|focusPatterns` may return only `services/database.ts`, `services/database.test.ts`, and `services/dexie-v18-cutover.ts`, where the strings are historical schema or fail-closed evidence. A second scan for imports of `task-store|session-store|types/phase1|types/phase2` must return no active source/test file. AST checks over `SyncEntityType`, `ENTITY_TYPE_TO_TABLE`, `PULL_KEY_TO_TABLE`, and `SYNC_PULL_KEYS` reject all four singular legacy keys `task|session|taskQuickNote|sessionQuickNote` and all four plural pull/table keys `tasks|sessions|taskQuickNotes|sessionQuickNotes`; checking only object literals shaped as `entityType: ...` is insufficient. Any unexpected path expands this Task's explicit file list and is migrated before proceeding; it is not allowlisted by a comment. Run `npm run typecheck` at this point and do not declare v18 while a legacy type/store/reference still compiles.

`database.ts` then declares typed tables for all 14 TS0 Space entities and the surviving non-Task/Session product tables. Command envelopes and receipts are local read caches, not ordinary Sync entities; Note conflicts, command queue, and activation conflicts are local plumbing.

```typescript
projects!: Table<CachedProject, string>
statusDefinitions!: Table<CachedStatusDefinition, string>
typeDefinitions!: Table<CachedTypeDefinition, string>
labels!: Table<CachedLabel, string>
workItemLabels!: Table<CachedWorkItemLabel, [string, string]>
workItems!: Table<CachedWorkItem, string>
workItemNotes!: Table<CachedWorkItemNote, string>
focusSessions!: Table<CachedFocusSession, string>
sessionTaskContexts!: Table<CachedSessionTaskContext, string>
sessionAttributionRevisions!: Table<CachedSessionAttributionRevision, string>
sessionWorkItemPlans!: Table<CachedSessionWorkItemPlan, string>
sessionWorkItemOutcomes!: Table<CachedSessionWorkItemOutcome, string>
sessionCommandEnvelopes!: Table<CachedSessionCommandEnvelope, string>
sessionCommandReceipts!: Table<CachedSessionCommandReceipt, [string, number]>
workItemNoteConflicts!: Table<WorkItemNoteConflictRow, string>
sessionCommandQueue!: Table<SessionCommandQueueRow, string>
sessionCommandReconciliationAttempts!: Table<CommandReconciliationAttemptRow, string>
sessionActivationConflicts!: Table<SessionActivationConflictRow, string>
sessionActivationApplications!: Table<SessionActivationApplicationReceiptRow, string>
directCommandIntents!: Table<DirectCommandIntentRow, string>
sessionReviewDrafts!: Table<SessionReviewDraftRow, [string, string]>
timerNoteComposerDrafts!: Table<TimerNoteComposerDraftRow, [string, string]>
```

- [ ] **Step 5: Add one exclusive scan-before-DDL v18 cutover and a typed open factory**

```typescript
// frontend/src/services/dexie-v18-schema.ts
export const DEXIE_V17_NATIVE_VERSION = 170 as const
export const DEXIE_V18_NATIVE_VERSION = 180 as const

export interface V18SchemaInventory {
  name: string
  keyPath: string | string[] | null
  autoIncrement: boolean
  indexes: Array<{
    name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean
  }>
}

// The same structured entries drive applyNativeV18Schema and Dexie's stores().
export const V18_STORE_DEFINITIONS = defineV18Stores({
  // Full final store/key/index definitions plus ten explicit removed tombstones.
  directCommandIntents: store('operationId', [
    index('[spaceId+kind+state]'), index('state'), index('createdAt'),
  ]),
  sessionReviewDrafts: store(['spaceId', 'sessionId'], [index('updatedAt')]),
  timerNoteComposerDrafts: store(['spaceId', 'workItemId'], [index('updatedAt')]),
})

export function expectedV18SchemaInventory(): V18SchemaInventory[] {
  return Object.entries(V18_STORE_DEFINITIONS)
    .filter(([, definition]) => !definition.removed)
    .map(([name, definition]) => ({
      name,
      keyPath: definition.keyPath,
      autoIncrement: definition.autoIncrement,
      indexes: definition.indexes.map((index) => ({ ...index }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
}
```

```typescript
// frontend/src/services/dexie-v18-cutover.ts
import { dexieDbNameForSpace } from '@/lib/platform'
import { PomodoroXIDB } from './database'
import {
  DEXIE_V17_NATIVE_VERSION, DEXIE_V18_NATIVE_VERSION,
  V18_STORE_DEFINITIONS, applyNativeV18Schema,
} from './dexie-v18-schema'
export const REMOVED_V18_TABLES = [
  'tasks', 'sessions', 'sessionEvents', 'sessionContexts', 'cognitiveMarks',
  'taskTags', 'taskRelations', 'focusPatterns', 'taskQuickNotes', 'sessionQuickNotes',
] as const

const LEGACY_REFERENCE_PATHS = new Map<string, readonly string[]>([
  ['quickNotes', ['session_id']],
  ['timeBlocks', ['task_id']],
  ['reflections', ['related_task_ids', 'auto_linked_session_ids']],
  ['reports', ['config.task_ids', 'config.session_type', 'config.session_types']],
  ['reportTemplates', ['config.task_ids', 'config.session_type', 'config.session_types']],
])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function hasOwnPath(row: Record<string, unknown>, path: string): boolean {
  const segments = path.split('.')
  let current: Record<string, unknown> = row
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!
    if (!Object.hasOwn(current, segment)) return false
    if (index === segments.length - 1) return true
    const next = current[segment]
    if (!isRecord(next)) return false
    current = next
  }
  return false
}

function findLegacyReference(tableName: string, value: unknown): string | null {
  if (!isRecord(value)) return 'non_object_row'
  for (const path of LEGACY_REFERENCE_PATHS.get(tableName) ?? []) {
    if (hasOwnPath(value, path)) return path
  }
  if (tableName === 'reports' || tableName === 'reportTemplates') {
    const config = value.config
    if (isRecord(config) && Array.isArray(config.dimensions) &&
        config.dimensions.some((dimension) =>
          dimension === 'task_type' || dimension === 'session_type')) {
      return 'config.dimensions'
    }
  }
  return null
}

interface CutoverScanCallbacks {
  onRejected(error: Error): void
  onClean(): void
}

function scanLegacyV17InsideUpgrade(
  transaction: IDBTransaction,
  callbacks: CutoverScanCallbacks,
): void {
  const requiredStores = new Set([
    ...REMOVED_V18_TABLES, ...LEGACY_REFERENCE_PATHS.keys(), 'outbox',
  ])
  const availableStores = new Set(Array.from(transaction.objectStoreNames))
  const missing = [...requiredStores].filter((name) => !availableStores.has(name))
  if (missing.length !== 0) {
    callbacks.onRejected(new Error(`unsupported_client_schema:missing:${missing.sort().join(',')}`))
    return
  }

  let pending = 0
  let settled = false
  const reject = (error: Error) => {
    if (settled) return
    settled = true
    callbacks.onRejected(error)
  }
  const completeOne = () => {
    if (settled) return
    pending -= 1
    if (pending === 0) {
      settled = true
      callbacks.onClean()
    }
  }
  const scheduleCount = (tableName: string) => {
    pending += 1
    const request = transaction.objectStore(tableName).count()
    request.onerror = () => reject(new Error(`legacy_client_scan_failed:${tableName}`))
    request.onsuccess = () => request.result === 0
      ? completeOne()
      : reject(new Error(`legacy_client_data_present:${tableName}`))
  }
  const scheduleReferenceCursor = (tableName: string) => {
    pending += 1
    const request = transaction.objectStore(tableName).openCursor()
    request.onerror = () => reject(new Error(`legacy_client_scan_failed:${tableName}`))
    request.onsuccess = () => {
      if (settled) return
      const cursor = request.result
      if (!cursor) { completeOne(); return }
      const reference = findLegacyReference(tableName, cursor.value)
      if (reference) {
        reject(new Error(`legacy_client_data_present:${tableName}.${reference}`))
        return
      }
      cursor.continue()
    }
  }

  for (const tableName of REMOVED_V18_TABLES) scheduleCount(tableName)
  scheduleCount('outbox')
  for (const tableName of LEGACY_REFERENCE_PATHS.keys()) {
    scheduleReferenceCursor(tableName)
  }
}

export async function atomicDexieV18Cutover(dbName: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(dbName, DEXIE_V18_NATIVE_VERSION)
    let rejection: Error | null = null

    request.onupgradeneeded = (event) => {
      const database = request.result
      const transaction = request.transaction!
      const oldVersion = event.oldVersion
      const applySchema = () => {
        try {
          applyNativeV18Schema(database, transaction, V18_STORE_DEFINITIONS)
        } catch (error) {
          rejection = error instanceof Error ? error : new Error('dexie_v18_schema_apply_failed')
          transaction.abort()
        }
      }
      if (oldVersion === 0) {
        applySchema()
        return
      }
      if (oldVersion !== DEXIE_V17_NATIVE_VERSION) {
        rejection = new Error(`unsupported_client_schema:${oldVersion}`)
        transaction.abort()
        return
      }

      scanLegacyV17InsideUpgrade(transaction, {
        onRejected(error) {
          rejection = error
          transaction.abort()
        },
        onClean() {
          // This callback runs from the final successful IDBRequest handler while
          // the same exclusive versionchange transaction is still active.
          applySchema()
        },
      })
    }
    request.onerror = () => reject(rejection ?? request.error ?? new Error('dexie_v18_cutover_failed'))
    request.onsuccess = () => { request.result.close(); resolve() }
  })
}

export async function openPomodoroXIDB(spaceId: string): Promise<PomodoroXIDB> {
  const dbName = dexieDbNameForSpace(spaceId)
  await atomicDexieV18Cutover(dbName)
  const database = new PomodoroXIDB(spaceId, dbName)
  await database.open()
  if (database.verno !== 18 || database.spaceId !== spaceId ||
      database.name !== dbName) {
    database.close()
    throw new Error('space_database_open_identity_mismatch')
  }
  return database
}
```

Dexie 4 maps each logical version to the native IndexedDB integer by multiplying
by ten. `dexie-v18-schema.ts` therefore locks
`DEXIE_V17_NATIVE_VERSION = 170` and `DEXIE_V18_NATIVE_VERSION = 180`; raw tests
assert those exact values. Passing logical 17/18 directly to `indexedDB.open` is
forbidden because it creates a second native upgrade when Dexie opens.

`scanLegacyV17InsideUpgrade` schedules all ten store counts, the old outbox count,
and read-only cursors over every surviving reference-bearing store synchronously
inside `onupgradeneeded`. A callback barrier calls `onClean` only after every
request succeeds and every row has been inspected. It rejects on a missing
expected v17 store, any row in a removed store/outbox, any own-path or forbidden
dimension match in `LEGACY_REFERENCE_PATHS`, or any request error. It does not use `async` gaps that
can let the upgrade transaction become inactive. `transaction.abort()` is the
only rejection path, so IndexedDB retains version 17 and rolls back any schema
work. Old v17 connections receive `versionchange` before `onupgradeneeded`; a
last write committed while such a connection is closing is therefore visible to
the scan. There is no close-and-reopen authorization window.

`dexie-v18-schema.ts` owns `V18_STORE_DEFINITIONS` as one structured schema
definition consumed by both `applyNativeV18Schema(...)` and
`toDexieStoreStrings(...)`. It represents each of the ten removals as an explicit
`removed: true` tombstone: the native projection calls `deleteObjectStore`, while
the Dexie projection emits the required `storeName: null` revision entry so its
cumulative v1-v18 expected schema does not inherit the v17 store. The native function
deletes exactly the ten removed stores, preserves surviving rows, removes the
`quickNotes.session_id` and `timeBlocks.task_id` indexes, reconciles every other
index, and creates the final Task Space/local-recovery stores only after the
barrier. The Dexie constructor contains only:

The independent test-only `REQUIRED_V18_ACTIVE_STORE_NAMES` exact oracle lists
every surviving product table, all 14 TS0 Space tables, and every TS3-local table,
including `directCommandIntents`, `sessionReviewDrafts`, and
`timerNoteComposerDrafts`. It is not generated from `V18_STORE_DEFINITIONS`.
Expanded S4 starts its v19 definitions by spreading the complete v18 structured
definitions unchanged and then adds only v19 protocol state; it cannot silently
drop one of these TS3-local recovery stores.

```typescript
// Replace frontend/src/services/database.ts's constructor while retaining all
// existing table declarations and versions 1 through 17.
constructor(
  readonly spaceId: string,
  dbName = dexieDbNameForSpace(spaceId),
) {
  super(dbName)
  if (!spaceId || dbName !== dexieDbNameForSpace(spaceId)) {
    throw new Error('space_database_identity_mismatch')
  }
  // Keep existing versions 1 through 17 unchanged above this declaration.
  this.version(18).stores(toDexieStoreStrings(V18_STORE_DEFINITIONS))
}
```

It has no `.upgrade()` callback and does not override `Dexie.open()`. A schema
parity test compares clean-install native v18, empty-v17 native upgrade, the
structured definition, and Dexie's observed complete store/keyPath/index
inventory. Any duplicate schema declaration or mismatch fails the Task. Every
application/test call site opens through `openPomodoroXIDB(spaceId)`; direct
`new PomodoroXIDB(...).open()` is statically forbidden outside the factory.
`database.ts` imports only `dexie-v18-schema.ts`; `dexie-v18-schema.ts` imports
neither database nor cutover; `dexie-v18-cutover.ts` may import both. An import
graph test rejects any database-to-cutover or schema-to-database/cutover edge.

- [ ] **Step 6: Add Meta v2 locator, device, Tab, and provisional-operation mirrors**

```typescript
// frontend/src/services/meta-database.ts
import { canonicalize } from 'json-canonicalize'
import { hashCommandPayload, type JsonValue } from '@/lib/contracts/payload-hash'

export interface ActiveSessionLocatorMirror {
  key: 'active'
  spaceId: string
  sessionId: string
  operationId: string
  state: 'claiming' | 'active' | 'releasing'
  ownerDeviceId: string
  ownerTabId: string
  ownershipEpoch: number
  leaseExpiresAt: string
  updatedAt: string
}

export interface DeviceIdentityRow { key: 'device'; deviceId: string; createdAt: string }
export interface SessionTabRow {
  tabId: string; deviceId: string; openedAt: string; lastSeenAt: string; closedAt: string | null
}
export interface ProvisionalOperationRow {
  operationId: string; deviceId: string; tabId: string; spaceId: string; sessionId: string
  cachedOwnershipEpoch: number | null
  intentJson: string
  payloadHash: string
  state: 'pending' | 'activating' | 'conflict' | 'awaiting_s4' | 'resolved'
  resolutionOperationId?: string | null
  resolutionConflictIdentityJson?: string | null
  resolutionSelectedRole?: 'active' | 'candidate' | null
  resolutionResolvedAt?: string | null
  resolutionRequestHash?: string | null
  createdAt: string; updatedAt: string
}

export interface CanonicalProvisionalStartIntent {
  operationId: string
  spaceId: string
  sessionId: string
  deviceId: string
  tabId: string
  level2WorkItemId: string
  level3WorkItemIds: string[]
  plannedSeconds: number
  startedAt: string
  expectedWorkItemVersions: Record<string, number>
}

export async function buildProvisionalOperationRow(
  input: CanonicalProvisionalStartIntent,
  cachedOwnershipEpoch: number | null,
): Promise<ProvisionalOperationRow> {
  const intent = {
    spaceId: input.spaceId, sessionId: input.sessionId,
    deviceId: input.deviceId, tabId: input.tabId,
    level2WorkItemId: input.level2WorkItemId,
    level3WorkItemIds: input.level3WorkItemIds,
    plannedSeconds: input.plannedSeconds, startedAt: input.startedAt,
    expectedWorkItemVersions: input.expectedWorkItemVersions,
  }
  const intentJson = canonicalize(intent)!
  return {
    operationId: input.operationId,
    spaceId: input.spaceId, sessionId: input.sessionId,
    deviceId: input.deviceId, tabId: input.tabId, cachedOwnershipEpoch,
    intentJson, payloadHash: await hashCommandPayload(intent as JsonValue), state: 'pending',
    createdAt: input.startedAt, updatedAt: input.startedAt,
  }
}

export type ProvisionalClaimResult =
  | { disposition: 'created'; row: ProvisionalOperationRow }
  | { disposition: 'existing'; row: ProvisionalOperationRow }

export class MetaDB extends Dexie {
  spaces!: Table<SpaceMeta, string>
  activeSessionLocator!: Table<ActiveSessionLocatorMirror, 'active'>
  deviceIdentity!: Table<DeviceIdentityRow, 'device'>
  sessionTabs!: Table<SessionTabRow, string>
  provisionalOperations!: Table<ProvisionalOperationRow, string>

  constructor(name = META_DB_NAME) {
    super(name)
    this.version(1).stores({ spaces: 'id, name, is_default' })
    this.version(2).stores({
      activeSessionLocator: 'key, spaceId, sessionId, state, ownershipEpoch',
      deviceIdentity: 'key, deviceId',
      sessionTabs: 'tabId, deviceId, lastSeenAt, closedAt',
      provisionalOperations: 'operationId, deviceId, spaceId, sessionId, state, createdAt',
    })
  }

  async claimProvisional(row: ProvisionalOperationRow): Promise<ProvisionalClaimResult> {
    if (row.cachedOwnershipEpoch !== null &&
        (!Number.isInteger(row.cachedOwnershipEpoch) || row.cachedOwnershipEpoch <= 0)) {
      throw new Error('cachedOwnershipEpoch must be null or a positive integer')
    }
    return this.transaction('rw', this.provisionalOperations, async () => {
      const existing = await this.provisionalOperations.get(row.operationId)
      if (existing) {
        const sameIntent = existing.intentJson === row.intentJson &&
          existing.payloadHash === row.payloadHash && existing.spaceId === row.spaceId &&
          existing.sessionId === row.sessionId && existing.deviceId === row.deviceId &&
          existing.tabId === row.tabId &&
          existing.cachedOwnershipEpoch === row.cachedOwnershipEpoch &&
          existing.createdAt === row.createdAt
        if (!sameIntent) throw new Error('idempotency_conflict')
        // Return the durable row. The caller must not replay a Space write merely
        // because the same root was claimed before.
        return { disposition: 'existing', row: existing } as const
      }
      const blockingStates = new Set<ProvisionalOperationRow['state']>([
        'pending', 'activating', 'conflict',
      ])
      const active = await this.provisionalOperations
        .where('deviceId').equals(row.deviceId)
        .and((item) => blockingStates.has(item.state))
        .first()
      if (active) {
        throw new Error('active_session_exists')
      }
      await this.provisionalOperations.add(row)
      return { disposition: 'created', row } as const
    })
  }
}
```

- [ ] **Step 7: Extend local outbox typing without claiming S4 transport parity**

```typescript
// frontend/src/lib/sync/types.ts
export const TS3_LOCAL_ENTITY_TO_TABLE = {
  project: 'projects', statusDefinition: 'statusDefinitions',
  typeDefinition: 'typeDefinitions', label: 'labels', workItemLabel: 'workItemLabels',
  workItem: 'workItems', workItemNote: 'workItemNotes', focusSession: 'focusSessions',
  sessionTaskContext: 'sessionTaskContexts',
  sessionAttributionRevision: 'sessionAttributionRevisions',
  sessionWorkItemPlan: 'sessionWorkItemPlans',
  sessionWorkItemOutcome: 'sessionWorkItemOutcomes',
} as const

export type TS3LocalEntityType = keyof typeof TS3_LOCAL_ENTITY_TO_TABLE
export const TS3_AWAITING_S4_ENTITY_TYPES = new Set<TS3LocalEntityType>(
  Object.keys(TS3_LOCAL_ENTITY_TO_TABLE) as TS3LocalEntityType[],
)
```

Extend S3's persisted `OutboxEvent` without making transport readiness optional:

```typescript
export interface OutboxEvent {
  id?: number
  spaceId: string
  entityType: SyncEntityType | TS3LocalEntityType
  entityId: string
  action: 'create' | 'update' | 'delete'
  payload: string
  payloadHash: string
  operationId: string
  compoundOperationId: string | null
  compoundOrder: number | null
  expectedVersion: number | null
  requiresVersionRebase: boolean
  transportState: 'ready' | 'awaiting_s4' | 'blocked_conflict'
  createdAt: string
  synced: boolean
  lastError: string | null
  lastErrorCode: string | null
  failedAt: string | null
  attemptCount: number
}
```

`enqueueOutbox` accepts `SyncEntityType | TS3LocalEntityType` and an exact identity object:

```typescript
// Add this getter to frontend/src/services/space-db.ts's SpaceDBManager.
// The class shell only supplies syntactic context; merge the getter into the
// existing class rather than creating a second SpaceDBManager.
export class SpaceDBManager {
get currentBinding(): Readonly<{ database: PomodoroXIDB; spaceId: string }> {
  const database = this.currentDB
  const spaceId = this._currentSpaceId
  if (!database || !spaceId) {
    throw new Error('SpaceDBManager: No space selected. Call switchTo(spaceId) first.')
  }
  if (database.spaceId !== spaceId) {
    throw new Error('SpaceDBManager: current database/Space binding mismatch')
  }
  return { database, spaceId }
}
}

// frontend/src/lib/sync/outbox.ts
export interface OutboxIdentity {
  operationId: string
  payloadHash: string
  expectedVersion: number | null
  transportState: 'ready' | 'awaiting_s4' | 'blocked_conflict'
  createdAt: string
  compoundOperationId?: string | null
  compoundOrder?: number | null
}

export interface PreparedEntityCommand {
  requestIndex: number
  operationId: string
  entityType: SyncEntityType | TS3LocalEntityType
  entityId: string
  action: OutboxAction
  expectedVersion: number | null
  payload: unknown
  payloadHash: string
}

export interface PreparedEntityBatch {
  batchId: string
  items: PreparedEntityCommand[]
}

const PRINTABLE_ASCII_CHARACTER = /^[\x21-\x7e]$/
const CHILD_SUFFIX_CHARACTER = /^[A-Za-z0-9._:-]$/
const ASCII = new TextEncoder()
const CHILD_HASH_DOMAIN = ASCII.encode('child-v1\0')

const isExactAscii = (value: string, maximum: number, character: RegExp): boolean =>
  value.length > 0 && value.length <= maximum && [...value].every((item) => character.test(item))

export async function boundedChildOperationId(
  parentId: string,
  suffix: string,
): Promise<string> {
  if (!isExactAscii(parentId, 128, PRINTABLE_ASCII_CHARACTER)) {
    throw new Error('invalid parent operation ID')
  }
  if (!isExactAscii(suffix, 512, CHILD_SUFFIX_CHARACTER)) {
    throw new Error('invalid child operation suffix')
  }
  const parentBytes = ASCII.encode(parentId)
  const suffixBytes = ASCII.encode(suffix)
  const candidate = `childp:${parentBytes.byteLength}:${parentId}:${suffix}`
  if (ASCII.encode(candidate).byteLength <= 128) {
    if (!isExactAscii(candidate, 128, PRINTABLE_ASCII_CHARACTER)) {
      throw new Error('invalid bounded child operation ID')
    }
    return candidate
  }
  const preimage = new Uint8Array(
    CHILD_HASH_DOMAIN.byteLength + 2 + parentBytes.byteLength + suffixBytes.byteLength,
  )
  preimage.set(CHILD_HASH_DOMAIN, 0)
  preimage[CHILD_HASH_DOMAIN.byteLength] = parentBytes.byteLength >>> 8
  preimage[CHILD_HASH_DOMAIN.byteLength + 1] = parentBytes.byteLength & 0xff
  preimage.set(parentBytes, CHILD_HASH_DOMAIN.byteLength + 2)
  preimage.set(suffixBytes, CHILD_HASH_DOMAIN.byteLength + 2 + parentBytes.byteLength)
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', preimage))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('')
  const bounded = `childh:${digest}`
  if (!isExactAscii(bounded, 128, PRINTABLE_ASCII_CHARACTER)) {
    throw new Error('invalid bounded child operation ID')
  }
  return bounded
}

export async function enqueueOutbox(
  db: PomodoroXIDB,
  spaceId: string,
  entityType: SyncEntityType | TS3LocalEntityType,
  entityId: string,
  action: OutboxAction,
  payload: unknown,
  identity: OutboxIdentity,
): Promise<void> {
  if (!spaceId) throw new Error('spaceId is required')
  if (db.spaceId !== spaceId) throw new Error('outbox_space_database_mismatch')
  if (!identity.operationId) throw new Error('operationId is required')
  if (!/^[0-9a-f]{64}$/.test(identity.payloadHash)) {
    throw new Error('payloadHash must be lowercase SHA-256')
  }
  if (action === 'create' && identity.expectedVersion !== null) {
    throw new Error('create expectedVersion must be null')
  }
  if (action !== 'create' && identity.expectedVersion === null) {
    throw new Error('update/delete expectedVersion is required')
  }
  requireCanonicalUtcRfc3339(identity.createdAt)
  const compoundOperationId = identity.compoundOperationId ?? null
  const compoundOrder = identity.compoundOrder ?? null
  if ((compoundOperationId === null) !== (compoundOrder === null) ||
      (compoundOrder !== null && (!Number.isInteger(compoundOrder) || compoundOrder < 0))) {
    throw new Error('compound identity must be null or a nonnegative ordered pair')
  }
  await mergeOrInsertOutbox(db, spaceId, entityType, entityId, action, payload, {
    ...identity, spaceId, compoundOperationId, compoundOrder,
  })
}

export function prepareHeldProvisionalBatch(rows: OutboxEvent[]): PreparedEntityBatch {
  if (rows.length < 3) throw new Error('provisional_compound_batch_incomplete')
  const spaceId = rows[0]!.spaceId
  const compoundOperationId = rows[0]!.compoundOperationId
  if (!compoundOperationId || rows.some((row) =>
    row.spaceId !== spaceId || row.compoundOperationId !== compoundOperationId ||
    row.compoundOrder === null ||
    row.action !== 'create' || row.expectedVersion !== null)) {
    throw new Error('provisional_compound_identity_mismatch')
  }
  const ordered = [...rows].sort((left, right) =>
    left.compoundOrder! - right.compoundOrder!)
  if (ordered.some((row, index) => row.compoundOrder !== index) ||
      new Set(ordered.map((row) => row.operationId)).size !== ordered.length) {
    throw new Error('provisional_compound_order_or_operation_id_invalid')
  }
  const expectedPrefix = [
    'focusSession', 'sessionTaskContext', 'sessionAttributionRevision',
  ]
  if (expectedPrefix.some((entityType, index) => ordered[index]?.entityType !== entityType) ||
      ordered.slice(3).some((row) => row.entityType !== 'sessionWorkItemPlan')) {
    throw new Error('provisional_compound_parent_before_child_order_invalid')
  }
  const planRanks = ordered.slice(3).map((row) =>
    (JSON.parse(row.payload) as CachedSessionWorkItemPlan).planRank)
  if (planRanks.some((rank, index) => index > 0 && rank < planRanks[index - 1]!)) {
    throw new Error('provisional_plan_rank_order_invalid')
  }
  return {
    batchId: compoundOperationId,
    items: ordered.map((row, requestIndex) => ({
      requestIndex, operationId: row.operationId, entityType: row.entityType,
      entityId: row.entityId, action: row.action, expectedVersion: null,
      payload: JSON.parse(row.payload), payloadHash: row.payloadHash,
    })),
  }
}
```

`requireCanonicalUtcRfc3339` is the same strict lexical/calendar predicate consumed by S4 vectors. `mergeOrInsertOutbox` persists the supplied `spaceId` and omitted compound fields as `null`; it scopes every merge candidate to that exact Space and rejects cross-Space rows. It may replace `payload + payloadHash + createdAt` under the earliest `operationId` only while `attemptCount === 0`; the replacement timestamp is the new caller intent and has never crossed a wire boundary. A merge into a provisional create preserves its original `spaceId`, `operationId`, `compoundOperationId`, and `compoundOrder`; its root intent timestamp remains immutable. Once an attempt begins, `spaceId + operationId + payloadHash + expectedVersion + createdAt + compound identity` are immutable, and a newer local post-image creates a new outbox row with a new operation ID instead of mutating the attempted command. `prepareHeldProvisionalBatch` requires one exact Space and returns the persisted `compoundOperationId` as `batchId`; no later layer may rehash its children into a different batch identity. Merge keeps the strictest transport state in `blocked_conflict > awaiting_s4 > ready` order. Current push selection excludes `awaiting_s4` and `blocked_conflict`. Conflict resolution never generically clears that state: only the authoritative candidate-winner application may consume the exact receipt-bound pristine activation snapshot; an active-winner result preserves the losing candidate rows for later authorized convergence.

All fifteen production calls use `enqueueOutbox(database, spaceId, ...)`: the nine TS3 WorkItemNote/FocusSession calls plus the retained two calls in `quick-note-repository.ts` and four calls in `trash-store.ts`. `SpaceDBManager.currentBinding` returns one synchronously captured `{ database, spaceId }` pair or throws before a transaction; the retained QuickNote and trash writers use that pair throughout their entity/outbox transaction and never read `currentSpaceId` after an `await`. Tests assert all fifteen calls pass an explicit Space, every inserted row carries that Space, and a mismatched/cross-Space merge fails before changing either entity or outbox state.

- [ ] **Step 8: Run Dexie, Meta, outbox, and existing repository regressions**

Run from `frontend/`:

```powershell
npm run test -- --run src/services/database.test.ts src/services/meta-database.test.ts src/lib/sync/types.test.ts src/lib/sync/outbox.test.ts src/lib/quick-notes/quick-note-repository.test.ts src/stores/trash-store.test.ts src/lib/sync/quick-note-sync.integration.test.ts src/lib/sync/engine.test.ts src/lib/sync/merge.test.ts src/lib/sync/pull-loop.test.ts src/lib/sync/push-batch.test.ts src/lib/sync/sync-meta.test.ts
npm run test -- --run src/stores/business-stores.test.ts src/stores/quick-note-store.test.ts src/hooks/use-sync.test.ts src/components/sync/conflict-panel.test.tsx src/services/space-db.test.ts src/components/trash/trash-view.test.tsx src/components/quick-notes/quick-notes-view.test.tsx src/components/quick-notes/use-quick-note-draft-session.test.tsx src/components/quick-notes/use-quick-note-editor.test.tsx src/lib/quick-notes/quick-note-focus.test.ts src/lib/quick-notes/quick-note-draft-repository.test.ts src/lib/quick-notes/quick-note-selectors.test.ts
npm run typecheck
```

Expected: PASS; the exclusive v18 transaction scans before DDL and refuses every populated removed store, any legacy QuickNote/TimeBlock/Reflection/report reference, and any old outbox row while leaving v17 inventory/version unchanged. The closing-v17-Tab race test proves its last committed row is observed and causes abort. Clean install and empty-v17 upgrade expose the same complete schema inventory. The ten stores and all old Task/Session type/store/import/test surfaces are absent before typecheck; Meta rows contain no Session content; the frontend child-ID fixture is byte-identical to S3 and every `childp:`/`childh:` boundary vector passes; all fifteen production enqueue calls persist one explicit matching `spaceId`; final rows preserve S3 operation/base-version identity and canonical RFC3339 intent time; final entity events are retained but not transmitted before S4.

- [ ] **Step 9: Commit the v18 and Meta v2 cutover**

```powershell
git add -- frontend/src/services/dexie-v18-schema.ts frontend/src/services/dexie-v18-cutover.ts frontend/src/services/database.ts frontend/src/services/database.test.ts frontend/src/services/meta-database.ts frontend/src/services/meta-database.test.ts frontend/src/services/space-db.ts frontend/src/types/index.ts frontend/src/types/sync.ts frontend/src/stores/index.ts frontend/src/stores/business-stores.test.ts frontend/src/stores/quick-note-store.test.ts frontend/src/stores/trash-store.ts frontend/src/stores/trash-store.test.ts frontend/src/utils/constants.ts frontend/src/lib/sync/types.ts frontend/src/lib/sync/types.test.ts frontend/src/lib/sync/outbox.ts frontend/src/lib/sync/outbox.test.ts frontend/src/lib/sync/sync-meta.test.ts frontend/src/lib/contracts/fixtures/task-space-session-child-operation-id-vectors.json frontend/src/lib/quick-notes/quick-note-repository.ts frontend/src/lib/quick-notes/quick-note-repository.test.ts frontend/src/lib/quick-notes/quick-note-focus.test.ts frontend/src/lib/quick-notes/quick-note-draft-repository.test.ts frontend/src/lib/quick-notes/quick-note-selectors.test.ts frontend/src/lib/sync/quick-note-sync.integration.test.ts frontend/src/lib/sync/engine.test.ts frontend/src/lib/sync/merge.test.ts frontend/src/lib/sync/pull-loop.test.ts frontend/src/lib/sync/push-batch.test.ts frontend/src/hooks/use-sync.test.ts frontend/src/components/sync/conflict-panel.test.tsx frontend/src/services/space-db.test.ts frontend/src/components/trash/trash-view.test.tsx frontend/src/components/quick-notes/quick-notes-view.test.tsx frontend/src/components/quick-notes/use-quick-note-draft-session.test.tsx frontend/src/components/quick-notes/use-quick-note-editor.test.tsx
git rm -- frontend/src/types/phase1.ts frontend/src/types/phase2.ts frontend/src/stores/task-store.ts frontend/src/stores/session-store.ts
git commit -m "feat(frontend): cut over to task space dexie v18"
```

---

### Task 3: Build The Task Space And WorkItemNote Local-First Repositories

**Files:**
- Create: `frontend/src/lib/task-space/task-space-repository.ts`
- Create: `frontend/src/lib/task-space/task-space-repository.test.ts`
- Create: `frontend/src/lib/task-space/work-item-note-repository.ts`
- Create: `frontend/src/lib/task-space/work-item-note-repository.test.ts`
- Create: `frontend/src/lib/task-space/note-autosave-controller.ts`
- Create: `frontend/src/lib/task-space/note-autosave-controller.test.ts`
- Create: `frontend/src/lib/direct-command-intents.ts`
- Create: `frontend/src/lib/direct-command-intents.test.ts`
- Modify: `frontend/src/lib/sync/outbox.ts`
- Modify: `frontend/src/lib/sync/outbox.test.ts`

**Interfaces:**
- Consumes: Task 1 parsed `taskSpaceApi`; Task 2 `workItemNotes`, `workItemNoteConflicts`, `directCommandIntents`, final business tables, S3-identity outbox, and `TS3_AWAITING_S4_ENTITY_TYPES`.
- Produces: `prepareDirectCommandIntent/executeDurableDirectCommand/resumePendingDirectCommandIntents`; `TaskSpaceRepository.hydrate/createProject/createWorkItem/moveWorkItem/transitionWorkItem`; `WorkItemNoteRepository.read/saveLocal/dispatchReplace/appendBlocks/toggleChecklistItem/resolveReloadRemote/resolveOverwriteLocal`; `NoteAutosaveController.schedule/flush/cancel/isDirty`; atomic direct-command cache/terminal commits, atomic local Note/outbox writes, and preserved two-version conflict records, with no Note Item promotion surface.

- [ ] **Step 1: Write failing atomic local-CAS and outbox tests**

```typescript
// frontend/src/lib/task-space/work-item-note-repository.test.ts
import { beforeEach, describe, expect, it } from 'vitest'
import type { PomodoroXIDB } from '@/services/database'
import { openPomodoroXIDB } from '@/services/dexie-v18-cutover'
import { WorkItemNoteRepository } from './work-item-note-repository'

describe('WorkItemNoteRepository local durability', () => {
  let db: PomodoroXIDB
  let spaceId: string
  beforeEach(async () => {
    spaceId = `space-note-repository-${crypto.randomUUID()}`
    db = await openPomodoroXIDB(spaceId)
    await db.workItemNotes.put({
      noteId: 'note-1', workItemId: 'wi-1',
      document: { contentVersion: 1, blocks: [] }, version: 4,
      localRevision: 7, syncState: 'clean',
      createdAt: '2026-07-15T08:00:00Z', updatedAt: '2026-07-15T08:00:00Z',
    })
  })

  it('writes document and one outbox post-image atomically', async () => {
    const repository = new WorkItemNoteRepository(db, spaceId)
    const saved = await repository.saveLocal({
      workItemId: 'wi-1', expectedLocalRevision: 7,
      document: { contentVersion: 1, blocks: [
        { type: 'paragraph', blockId: 'p-1', text: 'Durable' },
      ] }, operationId: 'note-op-1', now: '2026-07-15T08:01:00Z',
    })
    expect(saved.localRevision).toBe(8)
    expect((await db.workItemNotes.get('note-1'))!.document.blocks).toHaveLength(1)
    const rows = await db.outbox.where('entityId').equals('note-1').toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      spaceId, entityType: 'workItemNote', operationId: 'note-op-1',
      expectedVersion: 4, transportState: 'awaiting_s4',
      createdAt: '2026-07-15T08:01:00Z',
    })
    expect(JSON.parse(rows[0]!.payload)).toEqual({
      noteId: 'note-1', workItemId: 'wi-1',
      document: saved.document, version: 4,
      createdAt: '2026-07-15T08:00:00Z',
      updatedAt: '2026-07-15T08:01:00Z',
    })
  })

  it('rejects a stale local revision without changing Note or outbox', async () => {
    const repository = new WorkItemNoteRepository(db, spaceId)
    await expect(repository.saveLocal({
      workItemId: 'wi-1', expectedLocalRevision: 6,
      document: { contentVersion: 1, blocks: [] }, operationId: 'stale',
      now: '2026-07-15T08:01:00Z',
    })).rejects.toThrow('local_version_conflict')
    expect((await db.workItemNotes.get('note-1'))!.localRevision).toBe(7)
    expect(await db.outbox.count()).toBe(0)
  })
})
```

- [ ] **Step 2: Write failing server-CAS conflict and stale-response tests**

```typescript
// append to frontend/src/lib/task-space/work-item-note-repository.test.ts
it('preserves local and remote documents and blocks dispatch on 409', async () => {
  const api = noteApiThatConflicts({
    spaceId, noteId: 'note-1', workItemId: 'wi-1', version: 5,
    document: { contentVersion: 1, blocks: [
      { type: 'paragraph', blockId: 'p-remote', text: 'Remote' },
    ] }, createdAt: '2026-07-15T08:00:00Z', updatedAt: '2026-07-15T08:02:00Z',
  })
  const repository = new WorkItemNoteRepository(db, spaceId, api)
  await repository.saveLocal(localParagraph('Local', 7, 'note-conflict'))

  await expect(repository.dispatchReplace('wi-1')).rejects.toThrow('version_conflict')
  const conflict = await db.workItemNoteConflicts.get('wi-1')
  expect(conflict?.localDocument.blocks[0]).toMatchObject({ text: 'Local' })
  expect(conflict?.remoteDocument.blocks[0]).toMatchObject({ text: 'Remote' })
  expect(conflict).toMatchObject({ baseVersion: 4, remoteVersion: 5 })
  expect((await db.workItemNotes.get('note-1'))!.syncState).toBe('conflict')
  expect((await db.outbox.where('entityId').equals('note-1').first())!.transportState)
    .toBe('blocked_conflict')
})

it('keeps a newer local edit when an older server response arrives', async () => {
  const deferred = deferredNoteResponse()
  const repository = new WorkItemNoteRepository(db, spaceId, deferred.api)
  await repository.saveLocal(localParagraph('First', 7, 'op-first'))
  const dispatch = repository.dispatchReplace('wi-1')
  await repository.saveLocal(localParagraph('Second', 8, 'op-second'))
  deferred.resolve(serverNote('First', 5))
  await dispatch

  const note = await db.workItemNotes.get('note-1')
  expect(note?.document.blocks[0]).toMatchObject({ text: 'Second' })
  expect(note).toMatchObject({ version: 5, localRevision: 9, syncState: 'dirty' })
  const row = await db.outbox.where('entityId').equals('note-1').first()
  expect(row).toMatchObject({ expectedVersion: 5 })
  expect(row!.operationId).not.toBe('op-first')
})
```

```typescript
// frontend/src/lib/direct-command-intents.test.ts
import { describe, expect, it } from 'vitest'

it.each([
  'create_project', 'create_work_item', 'move_work_item',
  'transition_work_item', 'submit_review',
] as const)('reuses one durable %s intent after server commit and response loss', async (kind) => {
  const fixture = await directCommandIntentFixture(kind, { commitThenLoseResponse: true })
  await expect(fixture.execute()).rejects.toThrow('transport_response_lost')
  const held = await fixture.db.directCommandIntents.toArray()
  expect(held).toHaveLength(1)
  expect(held[0]).toMatchObject({ kind, state: 'in_flight' })

  const restarted = await fixture.reopen({ returnStoredIdempotentResult: true })
  await restarted.resumePendingDirectCommandIntents()
  expect(restarted.api.calls).toHaveLength(2)
  expect(restarted.api.calls[1]).toEqual(restarted.api.calls[0])
  expect(restarted.api.calls[1].operationId).toBe(held[0]!.operationId)
  expect(await restarted.db.directCommandIntents.get(held[0]!.operationId))
    .toMatchObject({ state: 'terminal', resultJson: expect.any(String) })
  expect(await restarted.readExpectedBusinessCache()).toEqual(restarted.serverResult)
  expect(restarted.api.queryOperations).toBeUndefined()
})

it('commits the parsed business cache and terminal direct intent atomically', async () => {
  const fixture = await directCommandIntentFixture('create_work_item', {
    failAtomicCompletion: true,
  })
  await expect(fixture.execute()).rejects.toThrow('injected_completion_failure')
  expect(await fixture.readExpectedBusinessCache()).toBeNull()
  expect((await fixture.db.directCommandIntents.toArray())[0]).toMatchObject({
    state: 'in_flight', resultJson: null,
  })
})
```

- [ ] **Step 3: Write failing 800 ms and forced-flush sequencing tests**

```typescript
// frontend/src/lib/task-space/note-autosave-controller.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NoteAutosaveController } from './note-autosave-controller'

describe('NoteAutosaveController', () => {
  afterEach(() => vi.useRealTimers())

  it('coalesces edits for 800 ms and flushes the newest document once', async () => {
    vi.useFakeTimers()
    const write = vi.fn().mockResolvedValue(undefined)
    const autosave = new NoteAutosaveController(write, 800)
    autosave.schedule({ revision: 1, document: documentWithText('old') })
    autosave.schedule({ revision: 2, document: documentWithText('new') })
    await vi.advanceTimersByTimeAsync(799)
    expect(write).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(write).toHaveBeenCalledOnce()
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ revision: 2 }))
  })

  it('awaits a forced local flush and propagates storage failure', async () => {
    const write = vi.fn().mockRejectedValue(new Error('quota'))
    const autosave = new NoteAutosaveController(write, 800)
    autosave.schedule({ revision: 3, document: documentWithText('critical') })
    await expect(autosave.flush('space-switch')).rejects.toThrow('quota')
    expect(autosave.isDirty()).toBe(true)
  })
})
```

- [ ] **Step 4: Run repository tests and verify missing modules**

Run from `frontend/`:

```powershell
 npm run test -- --run src/lib/direct-command-intents.test.ts src/lib/task-space/task-space-repository.test.ts src/lib/task-space/work-item-note-repository.test.ts src/lib/task-space/note-autosave-controller.test.ts src/lib/sync/outbox.test.ts
```

Expected: FAIL because the direct-intent helper, Task Space repositories, and autosave controller do not exist.

- [ ] **Step 5: Implement Task Space cache ingress and online-only formal mutations**

```typescript
// frontend/src/lib/direct-command-intents.ts
import { canonicalize } from 'json-canonicalize'
import type { Table } from 'dexie'
import { hashCommandPayload, type JsonValue } from '@/lib/contracts/payload-hash'
import type { PomodoroXIDB } from '@/services/database'
import type { DirectCommandIntentRow } from '@/types'

export const canonicalNow = (): string => new Date().toISOString()
export type DirectCommandKind = DirectCommandIntentRow['kind']
export type DirectCommandHandlerMap = Record<DirectCommandKind, {
  executeExact(intent: DirectCommandIntentRow): Promise<void>
}>

export async function prepareDirectCommandIntent(
  db: PomodoroXIDB,
  input: Omit<DirectCommandIntentRow,
    'operationId' | 'requestJson' | 'requestHash' | 'state' | 'resultJson' |
    'resultHash' | 'createdAt' | 'updatedAt'> & {
      request: Record<string, JsonValue>; now: string;
    },
  requestedOperationId = crypto.randomUUID(),
): Promise<DirectCommandIntentRow> {
  const exactRequest = { ...input.request, operationId: requestedOperationId }
  const requestJson = canonicalize(exactRequest)
  if (requestJson === undefined) throw new Error('direct_command_request_not_canonical')
  const requestHash = await hashCommandPayload(exactRequest)
  const row: DirectCommandIntentRow = {
    operationId: requestedOperationId, kind: input.kind, spaceId: input.spaceId,
    targetId: input.targetId, requestJson, requestHash, state: 'prepared',
    resultJson: null, resultHash: null, createdAt: input.now, updatedAt: input.now,
  }
  return db.transaction('rw', db.directCommandIntents, async () => {
    const existing = await db.directCommandIntents.get(row.operationId)
    if (existing) {
      if (existing.requestJson !== row.requestJson || existing.requestHash !== row.requestHash ||
          existing.kind !== row.kind || existing.spaceId !== row.spaceId ||
          existing.targetId !== row.targetId) {
        throw new Error('direct_command_operation_payload_mismatch')
      }
      return existing
    }
    await db.directCommandIntents.add(row)
    return row
  })
}

export async function executeDurableDirectCommand<TResult extends JsonValue>(input: {
  db: PomodoroXIDB
  intent: DirectCommandIntentRow
  businessTables: Table[]
  parseResult(value: unknown): TResult
  sendExactRequest(value: Record<string, JsonValue>): Promise<unknown>
  applyResult(result: TResult): Promise<void>
  now(): string
}): Promise<TResult> {
  const exactRequest = JSON.parse(input.intent.requestJson) as Record<string, JsonValue>
  const terminal = await input.db.transaction('rw', input.db.directCommandIntents, async () => {
    const current = await input.db.directCommandIntents.get(input.intent.operationId)
    if (!current || current.requestJson !== input.intent.requestJson ||
        current.requestHash !== input.intent.requestHash || current.kind !== input.intent.kind) {
      throw new Error('direct_command_intent_lost')
    }
    if (current.state === 'terminal') {
      if (!current.resultJson || !current.resultHash) {
        throw new Error('direct_command_terminal_result_missing')
      }
      return input.parseResult(JSON.parse(current.resultJson))
    }
    await input.db.directCommandIntents.update(input.intent.operationId, {
      state: 'in_flight', updatedAt: input.now(),
    })
    return null
  })
  if (terminal !== null) return terminal
  const result = input.parseResult(await input.sendExactRequest(exactRequest))
  const resultJson = canonicalize(result as JsonValue)
  if (resultJson === undefined) throw new Error('direct_command_result_not_canonical')
  const resultHash = await hashCommandPayload(result as JsonValue)
  await input.db.transaction(
    'rw', input.db.directCommandIntents, ...input.businessTables,
    async () => {
      const current = await input.db.directCommandIntents.get(input.intent.operationId)
      if (!current || current.requestJson !== input.intent.requestJson ||
          current.requestHash !== input.intent.requestHash || current.state === 'terminal') {
        throw new Error('direct_command_intent_lost')
      }
      await input.applyResult(result)
      await input.db.directCommandIntents.update(input.intent.operationId, {
        state: 'terminal', resultJson, resultHash, updatedAt: input.now(),
      })
    },
  )
  return result
}

export async function resumePendingDirectCommandIntents(
  db: PomodoroXIDB,
  handlers: DirectCommandHandlerMap,
): Promise<void> {
  const pending = await db.directCommandIntents
    .where('state').anyOf('prepared', 'in_flight').sortBy('createdAt')
  for (const intent of pending) await handlers[intent.kind].executeExact(intent)
}
```

```typescript
// frontend/src/lib/task-space/task-space-repository.ts
import type { PomodoroXIDB } from '@/services/database'
import { normalizeProjectKey, taskSpaceApi } from '@/services/task-space-api'
import { assertResponseSpace, projectSchema, workItemSchema } from '@/lib/contracts/task-space'
import type { JsonValue } from '@/lib/contracts/payload-hash'
import {
  canonicalNow, executeDurableDirectCommand, prepareDirectCommandIntent,
} from '@/lib/direct-command-intents'
import type { DirectCommandIntentRow } from '@/types'

interface CreateWorkItemInput {
  projectId: string; title: string; description: string | null; parentId: string | null
  typeDefinitionId: string | null; statusDefinitionId: string | null; priority: number | null
}
interface MoveWorkItemInput {
  projectId: string; workItemId: string; newParentId: string | null; childRank: number
}
interface TransitionWorkItemInput { workItemId: string; statusDefinitionId: string }

const withoutSpace = <T extends { spaceId: string }>(row: T): Omit<T, 'spaceId'> => {
  const { spaceId: _verified, ...persisted } = row
  return persisted
}

export class TaskSpaceRepository {
  constructor(
    private readonly db: PomodoroXIDB,
    private readonly spaceId: string,
    private readonly api = taskSpaceApi,
  ) {}

  async hydrateProjectTree(projectId: string) {
    const cached = await this.db.workItems.where('projectId').equals(projectId).toArray()
    const remote = await this.api.readTree(this.spaceId, projectId)
    await this.db.workItems.bulkPut(remote.map((row) => withoutSpace(assertResponseSpace(row, this.spaceId))))
    return { cached, remote: await this.db.workItems.where('projectId').equals(projectId).toArray() }
  }

  async createProject(input: { name: string; key: string; description: string | null }) {
    if (!navigator.onLine) throw new Error('offline_formal_creation_forbidden')
    const normalized = { ...input, key: normalizeProjectKey(input.key) }
    const intent = await prepareDirectCommandIntent(this.db, {
      kind: 'create_project', spaceId: this.spaceId, targetId: normalized.key,
      request: { ...normalized, spaceId: this.spaceId }, now: canonicalNow(),
    })
    return executeDurableDirectCommand({
      db: this.db, intent, businessTables: [this.db.projects],
      sendExactRequest: (request) => this.api.createProject(request),
      parseResult: (value) => assertResponseSpace(projectSchema.parse(value), this.spaceId),
      applyResult: async (response) => { await this.db.projects.put(withoutSpace(response)) },
      now: canonicalNow,
    })
  }

  async createWorkItem(input: CreateWorkItemInput) {
    if (!navigator.onLine) throw new Error('offline_formal_creation_forbidden')
    const intent = await prepareDirectCommandIntent(this.db, {
      kind: 'create_work_item', spaceId: this.spaceId, targetId: null,
      request: { ...input, spaceId: this.spaceId }, now: canonicalNow(),
    })
    return this.executeWorkItemIntent(intent, this.api.createWorkItem)
  }

  async moveWorkItem(input: MoveWorkItemInput) {
    if (!navigator.onLine) throw new Error('offline_formal_mutation_forbidden')
    const cached = await this.db.workItems.get(input.workItemId)
    if (!cached) throw new Error('work_item_not_loaded')
    const intent = await prepareDirectCommandIntent(this.db, {
      kind: 'move_work_item', spaceId: this.spaceId, targetId: input.workItemId,
      request: { ...input, spaceId: this.spaceId, expectedVersion: cached.version },
      now: canonicalNow(),
    })
    return this.executeWorkItemIntent(intent, this.api.moveWorkItem)
  }

  async transitionWorkItem(input: TransitionWorkItemInput) {
    if (!navigator.onLine) throw new Error('offline_formal_mutation_forbidden')
    const cached = await this.db.workItems.get(input.workItemId)
    if (!cached) throw new Error('work_item_not_loaded')
    const intent = await prepareDirectCommandIntent(this.db, {
      kind: 'transition_work_item', spaceId: this.spaceId, targetId: input.workItemId,
      request: { ...input, spaceId: this.spaceId, expectedVersion: cached.version },
      now: canonicalNow(),
    })
    return this.executeWorkItemIntent(intent, this.api.transitionWorkItem)
  }

  private executeWorkItemIntent<TRequest extends Record<string, JsonValue>>(
    intent: DirectCommandIntentRow,
    send: (request: TRequest) => Promise<unknown>,
  ) {
    return executeDurableDirectCommand({
      db: this.db, intent, businessTables: [this.db.workItems],
      // The intent was created from this method's TRequest. The Adapter still
      // applies its operation-specific runtime request schema before transport.
      sendExactRequest: (request) => send(request as TRequest),
      parseResult: (value) => assertResponseSpace(workItemSchema.parse(value), this.spaceId),
      applyResult: async (response) => { await this.db.workItems.put(withoutSpace(response)) },
      now: canonicalNow,
    })
  }
}
```

`moveWorkItem` and `transitionWorkItem` capture the cached `version`, include it in the exact persisted request, and use the same `prepareDirectCommandIntent -> executeDurableDirectCommand` path. Repository bootstrap calls `resumePendingDirectCommandIntents` before accepting another formal command. TS1/S3 receives the byte-identical operation ID/body again after response loss; TS3 never calls S4 operation-query. The parsed WorkItem cache update and terminal intent transition share one Dexie transaction. No method computes tree depth, display key, or status transition legality locally as authority. The repository exposes no Note Item promotion method.

- [ ] **Step 6: Implement local Note CAS, response sequencing, and two explicit conflict resolutions**

```typescript
// frontend/src/lib/task-space/work-item-note-repository.ts
import { z } from 'zod'
import { workItemNoteCommandPostImageSchema } from '@/lib/contracts/task-space'

export function serializeWorkItemNoteCommandPostImage(
  row: CachedWorkItemNote,
): z.infer<typeof workItemNoteCommandPostImageSchema> {
  return workItemNoteCommandPostImageSchema.parse({
    noteId: row.noteId,
    workItemId: row.workItemId,
    document: row.document,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  })
}

export class WorkItemNoteRepository {
  constructor(
    private readonly db: PomodoroXIDB,
    private readonly spaceId: string,
    private readonly api = taskSpaceApi,
  ) {}

  async saveLocal(input: SaveLocalNoteInput): Promise<CachedWorkItemNote> {
    const payloadHash = await hashCommandPayload({ document: input.document })
    return this.db.transaction('rw', this.db.workItemNotes, this.db.outbox, async () => {
      const current = await this.db.workItemNotes.where('workItemId').equals(input.workItemId).first()
      if (!current) throw new Error('work_item_note_not_loaded')
      if (current.syncState === 'conflict') throw new Error('version_conflict')
      if (current.localRevision !== input.expectedLocalRevision) {
        throw new Error('local_version_conflict')
      }
      const next = {
        ...current, document: input.document, localRevision: current.localRevision + 1,
        syncState: 'dirty' as const, updatedAt: input.now,
      }
      await this.db.workItemNotes.put(next)
      await enqueueOutbox(
        this.db, this.spaceId, 'workItemNote', current.noteId, 'update',
        serializeWorkItemNoteCommandPostImage(next),
        { operationId: input.operationId, payloadHash, expectedVersion: current.version,
          transportState: 'awaiting_s4', createdAt: input.now },
      )
      return next
    })
  }

  async dispatchReplace(workItemId: string): Promise<void> {
    const sent = await this.db.workItemNotes.where('workItemId').equals(workItemId).first()
    if (!sent || sent.syncState !== 'dirty') return
    const row = await this.db.outbox.where('entityId').equals(sent.noteId).first()
    if (!row || row.transportState === 'blocked_conflict') return
    await this.db.outbox.update(row.id!, { attemptCount: row.attemptCount + 1 })
    try {
      const remote = await this.api.replaceNote({
        spaceId: this.spaceId, workItemId, expectedVersion: sent.version,
        document: sent.document, operationId: row.operationId,
      })
      await this.acknowledge(sent, remote)
    } catch (error) {
      if (!isVersionConflict(error)) throw error
      const remote = await this.api.readNote(this.spaceId, workItemId)
      if (!remote) throw new Error('version_conflict_without_remote')
      await this.preserveConflict(sent, remote)
      throw new Error('version_conflict')
    }
  }

  async appendBlocks(input: AppendBlocksInput): Promise<void> {
    const sent = await this.applyLocalAppend(input)
    await this.dispatchCommand(sent, (row) => this.api.appendBlocks({
      spaceId: this.spaceId, workItemId: input.workItemId,
      expectedVersion: row.version, blocks: input.blocks,
      operationId: input.operationId,
    }))
  }

  async toggleChecklistItem(input: ToggleChecklistItemInput): Promise<void> {
    const sent = await this.applyLocalChecklistToggle(input)
    await this.dispatchCommand(sent, (row) => this.api.toggleChecklistItem({
      spaceId: this.spaceId, workItemId: input.workItemId,
      expectedVersion: row.version, blockId: input.blockId, itemId: input.itemId,
      checked: input.checked, operationId: input.operationId,
    }))
  }

  async resolveReloadRemote(workItemId: string): Promise<void> {
    await this.db.transaction(
      'rw', this.db.workItemNotes, this.db.workItemNoteConflicts, this.db.outbox,
      async () => {
        const conflict = await this.db.workItemNoteConflicts.get(workItemId)
        if (!conflict) throw new Error('conflict_not_found')
        await this.db.workItemNotes.update(conflict.noteId, {
          document: conflict.remoteDocument, version: conflict.remoteVersion,
          localRevision: conflict.localRevision + 1, syncState: 'clean',
        })
        const ids = await this.db.outbox.where('entityId').equals(conflict.noteId).primaryKeys()
        await this.db.outbox.bulkDelete(ids as number[])
        await this.db.workItemNoteConflicts.delete(workItemId)
      },
    )
  }

  async resolveOverwriteLocal(workItemId: string): Promise<void> {
    const conflict = await this.db.workItemNoteConflicts.get(workItemId)
    if (!conflict) throw new Error('conflict_not_found')
    const operationId = crypto.randomUUID()
    const createdAt = new Date().toISOString()
    const payloadHash = await hashCommandPayload({ document: conflict.localDocument })
    await this.db.transaction(
      'rw', this.db.workItemNotes, this.db.workItemNoteConflicts, this.db.outbox,
      async () => {
        const current = await this.db.workItemNotes.get(conflict.noteId)
        if (!current || current.workItemId !== workItemId) {
          throw new Error('work_item_note_not_loaded')
        }
        const next: CachedWorkItemNote = {
          ...current,
          document: conflict.localDocument,
          version: conflict.remoteVersion,
          localRevision: conflict.localRevision + 1,
          syncState: 'dirty',
          updatedAt: createdAt,
        }
        await this.db.outbox.where('entityId').equals(conflict.noteId).delete()
        await this.db.workItemNotes.put(next)
        await enqueueOutbox(
          this.db, this.spaceId, 'workItemNote', conflict.noteId, 'update',
          serializeWorkItemNoteCommandPostImage(next),
          { operationId, payloadHash, expectedVersion: conflict.remoteVersion,
            transportState: 'awaiting_s4', createdAt },
        )
        await this.db.workItemNoteConflicts.delete(workItemId)
      },
    )
    await this.dispatchReplace(workItemId)
  }
}
```

`dispatch` is named `dispatchReplace` in the final file. `appendBlocks` and `toggleChecklistItem` apply the exact local document operation plus canonical post-image outbox in one transaction, then call their TS0-locked focused endpoints. `saveLocal`, focused commands, stale-response requeue, and reviewed-local overwrite all call `serializeWorkItemNoteCommandPostImage`; no second partial payload builder exists. Overwrite first writes the complete next cached row, then serializes that same row inside the transaction. Tests exact-compare all six post-image keys (`noteId`, `workItemId`, `document`, `version`, `createdAt`, `updatedAt`) for both normal save and overwrite and re-hash only `{document}`. All three paths share `dispatchCommand`, `acknowledge`, stale-response sequencing, and `preserveConflict`. `acknowledge` compares the current `localRevision` with the dispatched revision. An equal revision installs the server document/version and clears the outbox. A newer local revision keeps its document, installs only the new server base version, deletes the acknowledged outbox row, and enqueues the newer post-image with a fresh operation ID and `expectedVersion=remote.version`. `preserveConflict` writes `spaceId`, both documents, Note `syncState`, and outbox `blocked_conflict` in one transaction.

- [ ] **Step 7: Implement the exact 800 ms autosave state machine**

```typescript
// frontend/src/lib/task-space/note-autosave-controller.ts
export type FlushReason = 'idle' | 'blur' | 'current-item-change' | 'session-end' | 'space-switch' | 'logout'

export class NoteAutosaveController<T extends { revision: number }> {
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending: T | null = null
  private inFlight: Promise<void> = Promise.resolve()

  constructor(
    private readonly write: (value: T, reason: FlushReason) => Promise<void>,
    private readonly delayMs = 800,
    private readonly onBackgroundError: (error: unknown) => void = () => undefined,
  ) {}

  schedule(value: T): void {
    this.pending = value
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      void this.flush('idle').catch(this.onBackgroundError)
    }, this.delayMs)
  }

  async flush(reason: FlushReason): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const next = this.pending
    if (!next) return this.inFlight
    this.pending = null
    const write = this.inFlight.catch(() => undefined).then(() => this.write(next, reason))
    this.inFlight = write
    try {
      await write
    } catch (error) {
      if (!this.pending || this.pending.revision < next.revision) this.pending = next
      throw error
    }
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending = null
  }

  isDirty(): boolean { return this.pending !== null }
}
```

- [ ] **Step 8: Run repository, fault, and type gates**

Run from `frontend/`:

```powershell
npm run test -- --run src/lib/direct-command-intents.test.ts src/lib/task-space/task-space-repository.test.ts src/lib/task-space/work-item-note-repository.test.ts src/lib/task-space/note-autosave-controller.test.ts src/lib/sync/outbox.test.ts
npm run typecheck
```

Expected: PASS; direct formal commands survive server-commit/response-loss/restart with one fixed request and atomically cache/terminate, injected transaction failure leaves neither Note nor outbox change, a conflict preserves both documents, forced flush propagates failure, and old responses never overwrite newer input.

- [ ] **Step 9: Commit Task Space repositories**

```powershell
git add -- frontend/src/lib/direct-command-intents.ts frontend/src/lib/direct-command-intents.test.ts frontend/src/lib/task-space/task-space-repository.ts frontend/src/lib/task-space/task-space-repository.test.ts frontend/src/lib/task-space/work-item-note-repository.ts frontend/src/lib/task-space/work-item-note-repository.test.ts frontend/src/lib/task-space/note-autosave-controller.ts frontend/src/lib/task-space/note-autosave-controller.test.ts frontend/src/lib/sync/outbox.ts frontend/src/lib/sync/outbox.test.ts
git commit -m "feat(frontend): persist task space note drafts"
```

---

### Task 4: Build The Project And Three-Level WorkItem UI

**Files:**
- Create: `frontend/src/stores/task-space-store.ts`
- Create: `frontend/src/stores/task-space-store.test.ts`
- Modify: `frontend/src/stores/business-stores.test.ts`
- Create: `frontend/src/components/task-space/project-rail.tsx`
- Create: `frontend/src/components/task-space/project-rail.test.tsx`
- Create: `frontend/src/components/task-space/work-item-tree.tsx`
- Create: `frontend/src/components/task-space/work-item-tree.test.tsx`
- Create: `frontend/src/components/task-space/work-item-detail.tsx`
- Modify: `frontend/src/app/(app)/tasks/page.tsx`

**Interfaces:**
- Consumes: Task 3 `TaskSpaceRepository`; final seeded status/type definitions; online-only formal creation rule.
- Produces: `useTaskSpaceStore`; `selectProjectTree`; selected Project/WorkItem projection; accessible `ProjectRail`, `WorkItemTree`, and `WorkItemDetail`; real `/tasks` route with level-aware creation.

- [ ] **Step 1: Write failing store hydration, reset, and level-selection tests**

```typescript
// frontend/src/stores/task-space-store.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTaskSpaceStore } from './task-space-store'

describe('task-space-store projection', () => {
  beforeEach(() => useTaskSpaceStore.getState().reset())

  it('shows cached rows first and replaces them with parsed remote rows', async () => {
    const repository = repositoryFixture({
      cached: [workItem('l1', null, 1)],
      remote: [workItem('l1', null, 1), workItem('l2', 'l1', 2)],
    })
    const promise = useTaskSpaceStore.getState().hydrate('space-a', repository)
    expect(useTaskSpaceStore.getState().workItems.map((item) => item.id)).toEqual(['l1'])
    await promise
    expect(useTaskSpaceStore.getState().workItems.map((item) => item.id)).toEqual(['l1', 'l2'])
  })

  it('selecting a level-3 item preserves its level-2 parent for Session launch', () => {
    useTaskSpaceStore.setState({ workItems: [
      workItem('l1', null, 1), workItem('l2', 'l1', 2), workItem('l3', 'l2', 3),
    ] })
    useTaskSpaceStore.getState().selectWorkItem('l3')
    expect(useTaskSpaceStore.getState()).toMatchObject({
      selectedWorkItemId: 'l3', selectedLevel2WorkItemId: 'l2',
    })
  })
})
```

- [ ] **Step 2: Write failing accessible tree and online-action tests**

```typescript
// frontend/src/components/task-space/work-item-tree.test.tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { WorkItemTree } from './work-item-tree'

it('renders semantic levels and exposes only a valid next-level create action', () => {
  const createChild = vi.fn()
  render(<WorkItemTree items={threeLevelFixture()} selectedId="l2" onSelect={vi.fn()} onCreateChild={createChild} />)
  expect(screen.getByRole('treeitem', { name: /L1 Alpha/ })).toHaveAttribute('aria-level', '1')
  expect(screen.getByRole('treeitem', { name: /L2 Build/ })).toHaveAttribute('aria-level', '2')
  expect(screen.getByRole('treeitem', { name: /L3 Verify/ })).toHaveAttribute('aria-level', '3')
  fireEvent.click(screen.getByRole('button', { name: 'Create child under L2 Build' }))
  expect(createChild).toHaveBeenCalledWith('l2')
  expect(screen.queryByRole('button', { name: 'Create child under L3 Verify' })).toBeNull()
})
```

- [ ] **Step 3: Run store and component tests and verify legacy projection remains**

Run from `frontend/`:

```powershell
npm run test -- --run src/stores/task-space-store.test.ts src/components/task-space/project-rail.test.tsx src/components/task-space/work-item-tree.test.tsx src/stores/business-stores.test.ts
```

Expected: FAIL because `task-space-store` and the Task Space components do not exist; Task 2 has already removed every legacy store import.

- [ ] **Step 4: Implement the repository-backed Task Space store**

```typescript
// frontend/src/stores/task-space-store.ts
import { create } from 'zustand'
import { devtools } from 'zustand/middleware'

interface TaskSpaceState {
  spaceId: string | null
  projects: CachedProject[]
  definitions: CachedTaskDefinitions | null
  workItems: CachedWorkItem[]
  selectedProjectId: string | null
  selectedWorkItemId: string | null
  selectedLevel2WorkItemId: string | null
  isLoading: boolean
  error: string | null
  repository: TaskSpaceRepository | null
}

const initial: Omit<TaskSpaceState, 'repository'> = {
  spaceId: null, projects: [], definitions: null, workItems: [],
  selectedProjectId: null, selectedWorkItemId: null,
  selectedLevel2WorkItemId: null, isLoading: false, error: null,
}

export const useTaskSpaceStore = create<TaskSpaceState & TaskSpaceActions>()(
  devtools((set, get) => ({
    ...initial, repository: null,
    async hydrate(spaceId, repository) {
      const cached = await repository.readCachedOverview()
      set({ ...cached, spaceId, repository, isLoading: true, error: null })
      try {
        const remote = await repository.refreshOverview()
        set({ ...remote, isLoading: false })
      } catch (error) {
        set({ isLoading: false, error: (error as Error).message })
      }
    },
    selectProject(projectId) {
      set({ selectedProjectId: projectId, selectedWorkItemId: null, selectedLevel2WorkItemId: null })
      void get().loadTree(projectId)
    },
    selectWorkItem(workItemId) {
      const item = get().workItems.find((candidate) => candidate.id === workItemId) ?? null
      const level2 = item?.depth === 2 ? item :
        item?.depth === 3 ? get().workItems.find((candidate) => candidate.id === item.parentId) ?? null : null
      set({ selectedWorkItemId: workItemId, selectedLevel2WorkItemId: level2?.id ?? null })
    },
    reset: () => set({ ...initial, repository: null }),
  }), { name: 'task-space-store' }),
)
```

All mutation actions call the repository once, then replace the returned row. `createChild` passes only the chosen parent and user fields; it does not calculate `depth`, `displayKey`, or status legality.

- [ ] **Step 5: Implement the Project rail and semantic three-level tree**

```tsx
// frontend/src/components/task-space/work-item-tree.tsx
import { ChevronRight, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function WorkItemTree({ items, selectedId, onSelect, onCreateChild }: Props) {
  const children = new Map<string | null, CachedWorkItem[]>()
  for (const item of items) {
    const group = children.get(item.parentId) ?? []
    group.push(item)
    children.set(item.parentId, group)
  }
  for (const group of children.values()) group.sort((a, b) => a.childRank - b.childRank)



  const renderLevel = (parentId: string | null, level: 1 | 2 | 3): React.ReactNode =>
    (children.get(parentId) ?? []).map((item) => (
      <li key={item.id} role="treeitem" aria-level={level} aria-selected={item.id === selectedId}>
        <div className="group flex h-9 items-center gap-1 px-2" style={{ paddingInlineStart: `${level * 12}px` }}>
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <button className="min-w-0 flex-1 truncate text-left text-sm" onClick={() => onSelect(item.id)}>
            <span className="sr-only">{`L${level} `}</span>{item.title}
          </button>
          {level < 3 ? (
            <Button size="icon-sm" variant="ghost" aria-label={`Create child under ${item.title}`}
              onClick={() => onCreateChild(item.id)}>
              <Plus aria-hidden="true" />
            </Button>
          ) : null}
        </div>
        {level < 3 ? <ul role="group">{renderLevel(item.id, (level + 1) as 2 | 3)}</ul> : null}
      </li>
    ))

  return <ul role="tree" aria-label="Work items" className="min-w-0">{renderLevel(null, 1)}</ul>
}
```

`project-rail.tsx` renders a scan-friendly list plus an icon-only `Plus` button with tooltip and an online-only create dialog for `name`, `key`, and description. `work-item-detail.tsx` shows definition color swatches, status category, immutable display key, timing fields, and a Note editor mount; it does not expose status/type management UI.

- [ ] **Step 6: Replace the current `/tasks` stub with the real workbench**

```tsx
// frontend/src/app/(app)/tasks/page.tsx
'use client'

import { ProjectRail } from '@/components/task-space/project-rail'
import { WorkItemTree } from '@/components/task-space/work-item-tree'
import { WorkItemDetail } from '@/components/task-space/work-item-detail'
import { useTaskSpaceStore } from '@/stores/task-space-store'

export default function TasksPage() {
  const state = useTaskSpaceStore()
  return (
    <div className="grid min-h-full grid-cols-1 md:grid-cols-[180px_280px_minmax(0,1fr)]">
      <ProjectRail projects={state.projects} selectedId={state.selectedProjectId}
        onSelect={state.selectProject} onCreate={state.createProject} />
      <section className="border-b md:border-b-0 md:border-x" aria-label="Work item tree">
        <WorkItemTree items={state.workItems} selectedId={state.selectedWorkItemId}
          onSelect={state.selectWorkItem} onCreateChild={state.createChild} />
      </section>
      <WorkItemDetail workItemId={state.selectedWorkItemId} />
    </div>
  )
}
```

- [ ] **Step 7: Run Task Space UI, reset, type, and lint gates**

Run from `frontend/`:

```powershell
npm run test -- --run src/stores/task-space-store.test.ts src/components/task-space/project-rail.test.tsx src/components/task-space/work-item-tree.test.tsx src/stores/business-stores.test.ts
npm run typecheck
npm run lint -- src/stores/task-space-store.ts src/components/task-space 'src/app/(app)/tasks/page.tsx'
```

Expected: PASS; the page renders a Project plus three-level WorkItem workbench, formal creation is disabled offline, and no legacy `useTaskStore` import remains in the tested paths.

- [ ] **Step 8: Commit the Task Space projection and tree UI**

```powershell
git add -- frontend/src/stores/task-space-store.ts frontend/src/stores/task-space-store.test.ts frontend/src/stores/business-stores.test.ts frontend/src/components/task-space/project-rail.tsx frontend/src/components/task-space/project-rail.test.tsx frontend/src/components/task-space/work-item-tree.tsx frontend/src/components/task-space/work-item-tree.test.tsx frontend/src/components/task-space/work-item-detail.tsx 'frontend/src/app/(app)/tasks/page.tsx'
git commit -m "feat(frontend): add project work item workspace"
```

---

### Task 5: Deliver The Complete Two-Block Editor And Dual-Version Conflict Review

**Files:**
- Create: `frontend/src/lib/task-space/document-edit.ts`
- Create: `frontend/src/lib/task-space/document-edit.test.ts`
- Create: `frontend/src/components/task-space/work-item-note-editor.tsx`
- Create: `frontend/src/components/task-space/work-item-note-editor.test.tsx`
- Create: `frontend/src/components/task-space/note-block-editor.tsx`
- Create: `frontend/src/components/task-space/note-block-editor.test.tsx`
- Create: `frontend/src/components/task-space/note-conflict-panel.tsx`
- Create: `frontend/src/components/task-space/note-conflict-panel.test.tsx`
- Modify: `frontend/src/components/task-space/work-item-detail.tsx`
- Modify: `frontend/src/stores/task-space-store.ts`
- Modify: `frontend/src/stores/task-space-store.test.ts`

**Interfaces:**
- Consumes: Task 1 paragraph/checklist-only schema; Task 3 Note repository/autosave/conflict resolutions; Task 4 selected tree.
- Produces: pure `insertBlock/updateBlock/removeBlock/moveBlock/insertChecklistItem/updateChecklistItem/indentChecklistItem/outdentChecklistItem`; complete `WorkItemNoteEditor`; explicit two-version conflict panel; executable absence gates for richer Blocks, WorkItem-reference items, and Note Item promotion.

- [ ] **Step 1: Write failing two-Block reducer and two-level Checklist tests**

```typescript
// frontend/src/lib/task-space/document-edit.test.ts
import { describe, expect, it } from 'vitest'
import { indentChecklistItem, insertBlock, updateChecklistItem } from './document-edit'

it('creates both v1 Blocks with stable caller-supplied IDs', () => {
  let document = { contentVersion: 1 as const, blocks: [] }
  document = insertBlock(document, { type: 'paragraph', blockId: 'p', text: '' }, 0)
  document = insertBlock(document, { type: 'checklist', blockId: 'c', items: [] }, 1)
  expect(document.blocks.map((block) => block.type)).toEqual(['paragraph', 'checklist'])
})

it('rejects assigning an item under an existing child', () => {
  const document = twoLevelChecklistDocument()
  expect(() => indentChecklistItem(document, 'checklist-1', 'root-2', 'child-1'))
    .toThrow('Checklist supports at most two levels')
})

it('updates Checklist text and checked state without changing item identity', () => {
  const next = updateChecklistItem(
    twoLevelChecklistDocument(), 'checklist-1', 'root-1',
    { text: 'Ship', checked: true },
  )
  expect(next.blocks[0].items[0]).toMatchObject({ itemId: 'root-1', text: 'Ship', checked: true })
})
```

- [ ] **Step 2: Write failing editor, Checklist independence, no-promotion, and conflict tests**

```typescript
// frontend/src/components/task-space/work-item-note-editor.test.tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { WorkItemNoteEditor } from './work-item-note-editor'

it('offers only paragraph and Checklist Block commands', () => {
  const onChange = vi.fn()
  render(<WorkItemNoteEditor document={emptyDocument()} onChange={onChange} conflict={null} />)
  for (const name of ['Add paragraph', 'Add checklist']) {
    expect(screen.getByRole('button', { name })).toBeEnabled()
  }
  for (const name of ['Add heading', 'Add ordered list', 'Add unordered list']) {
    expect(screen.queryByRole('button', { name })).toBeNull()
  }
  fireEvent.click(screen.getByRole('button', { name: 'Add checklist' }))
  expect(onChange.mock.calls.at(-1)![0].blocks[0].type).toBe('checklist')
})

it('toggles checklist content without invoking a WorkItem transition', () => {
  const onChange = vi.fn()
  const onTransition = vi.fn()
  render(<WorkItemNoteEditor document={checklistDocument(false)} onChange={onChange}
    onWorkItemTransition={onTransition} conflict={null} />)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Ship' }))
  expect(onChange.mock.calls.at(-1)![0].blocks[0].items[0].checked).toBe(true)
  expect(onTransition).not.toHaveBeenCalled()
})

it('exposes no Note Item promotion action', () => {
  render(<WorkItemNoteEditor document={checklistDocument(false)}
    onChange={vi.fn()} conflict={null} />)
  expect(screen.queryByRole('button', { name: /promote/i })).toBeNull()
  expect(screen.queryByRole('link', { name: /work item/i })).toBeNull()
})
```

- [ ] **Step 3: Run editor tests and verify the red state**

Run from `frontend/`:

```powershell
npm run test -- --run src/lib/task-space/document-edit.test.ts src/components/task-space/work-item-note-editor.test.tsx src/components/task-space/note-block-editor.test.tsx src/components/task-space/note-conflict-panel.test.tsx src/stores/task-space-store.test.ts
```

Expected: FAIL because the document reducers and complete editor components do not exist.

- [ ] **Step 4: Implement schema-validated immutable document reducers**

```typescript
// frontend/src/lib/task-space/document-edit.ts
import { workItemNoteDocumentSchema, type NoteBlock, type WorkItemNoteDocument } from '@/lib/contracts/task-space'

const checked = (document: WorkItemNoteDocument): WorkItemNoteDocument =>
  workItemNoteDocumentSchema.parse(document)

export function insertBlock(
  document: WorkItemNoteDocument, block: NoteBlock, index: number,
): WorkItemNoteDocument {
  const blocks = document.blocks.slice()
  blocks.splice(index, 0, block)
  return checked({ ...document, blocks })
}

export function updateBlock(
  document: WorkItemNoteDocument, blockId: string, replacement: NoteBlock,
): WorkItemNoteDocument {
  if (replacement.blockId !== blockId) throw new Error('Block ID is immutable')
  return checked({
    ...document,
    blocks: document.blocks.map((block) => block.blockId === blockId ? replacement : block),
  })
}

export function indentChecklistItem(
  document: WorkItemNoteDocument, blockId: string, itemId: string, targetItemId: string,
): WorkItemNoteDocument {
  const block = document.blocks.find((candidate) => candidate.blockId === blockId)
  if (!block || block.type !== 'checklist') throw new Error('Checklist block not found')
  const target = locateNestedItem(block.items, targetItemId)
  if (!target || target.depth !== 0) throw new Error('Checklist supports at most two levels')
  const removal = removeNestedItem(block.items, itemId)
  if (!removal.item || removal.item.itemId === target.item.itemId) {
    throw new Error('Checklist item cannot parent itself')
  }
  const items = appendChildById(removal.items, target.item.itemId, removal.item)
  return updateBlock(document, blockId, {
    ...block, items,
  } as NoteBlock)
}
```

`locateNestedItem`, `removeNestedItem`, and `appendChildById` walk only root Checklist items and their direct `children`. `outdentChecklistItem` removes one child and inserts it immediately after its former parent in the root array. `removeBlock`, `moveBlock`, `insertChecklistItem`, `updateChecklistItem`, `removeChecklistItem`, `indentChecklistItem`, and `outdentChecklistItem` all return `workItemNoteDocumentSchema.parse(...)`; IDs never change during nesting, reorder, or text edit, and no rank or `parentItemId` is created.

- [ ] **Step 5: Implement paragraph and Checklist controls only**

```tsx
// frontend/src/components/task-space/work-item-note-editor.tsx
import { CheckSquare, Pilcrow, Plus } from 'lucide-react'

const BLOCK_COMMANDS = [
  { type: 'paragraph', label: 'Add paragraph', icon: Pilcrow },
  { type: 'checklist', label: 'Add checklist', icon: CheckSquare },
] as const

export function WorkItemNoteEditor(props: WorkItemNoteEditorProps) {
  if (props.conflict) return <NoteConflictPanel conflict={props.conflict}
    onReloadRemote={props.onReloadRemote} onOverwriteLocal={props.onOverwriteLocal} />
  return (
    <section aria-label="Work item note" className="min-w-0 space-y-2">
      <div role="toolbar" aria-label="Insert note Block" className="flex flex-wrap gap-1">
        {BLOCK_COMMANDS.map(({ type, label, icon: Icon }) => (
          <Button key={type} type="button" size="icon-sm" variant="ghost"
            aria-label={label} title={label} onClick={() => props.onChange(addEmptyBlock(props.document, type))}>
            <Icon aria-hidden="true" />
          </Button>
        ))}
      </div>
      <ol className="space-y-2">
        {props.document.blocks.map((block) => (
          <li key={block.blockId}>
            <NoteBlockEditor block={block}
              onChange={(next) => props.onChange(updateBlock(props.document, block.blockId, next))} />
          </li>
        ))}
      </ol>
      <output aria-live="polite" className="text-xs text-muted-foreground">{props.saveLabel}</output>
    </section>
  )
}
```

`note-block-editor.tsx` uses a plain `textarea` for paragraph and native checkboxes plus plain text inputs for Checklist items. Indent/outdent buttons use Lucide `IndentIncrease`/`IndentDecrease`, are disabled when a third level would result, and expose tooltips. There is no heading, ordered/unordered list Block, WorkItem reference, `contentEditable`, inline mark toolbar, attachment, code, media, or Markdown conversion.

- [ ] **Step 6: Lock the no-promotion and no-reference boundary**

```typescript
// append to frontend/src/stores/task-space-store.test.ts
it('has no Note Item promotion action or WorkItem-reference projection', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/stores/task-space-store.ts'), 'utf8')
  expect(source).not.toMatch(/promoteListItem|promoteNoteItem|expectedSourceWorkItemVersion/)
  expect(source).not.toMatch(/work_item_ref|titleSnapshot/)
})
```

The same negative test scans `task-space-api.ts`, `work-item-note-repository.ts`, `work-item-note-editor.tsx`, and `note-block-editor.tsx`. Any promotion route/method/action, WorkItem-reference item, source-trace field, or promotion CAS field fails the Task before UI integration. Formal WorkItems remain creatable only through the explicit WorkItem command path.

- [ ] **Step 7: Implement explicit two-version conflict review**

```tsx
// frontend/src/components/task-space/note-conflict-panel.tsx
export function NoteConflictPanel({ conflict, onReloadRemote, onOverwriteLocal }: Props) {
  return (
    <section role="alert" aria-labelledby="note-conflict-title" className="space-y-3">
      <h3 id="note-conflict-title" className="text-sm font-semibold">Work item note conflict</h3>
      <div className="grid gap-3 lg:grid-cols-2">
        <ReadonlyNoteDocument title={`Local revision ${conflict.localRevision}`}
          document={conflict.localDocument} />
        <ReadonlyNoteDocument title={`Remote version ${conflict.remoteVersion}`}
          document={conflict.remoteDocument} />
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={onReloadRemote}>Reload remote</Button>
        <Button onClick={onOverwriteLocal}>Use reviewed local copy</Button>
      </div>
    </section>
  )
}
```

No control says merge. `Use reviewed local copy` calls Task 3's new-command resolution; automatic dispatch stays paused until one action succeeds.

- [ ] **Step 8: Run editor, no-promotion, conflict, type, and lint gates**

Run from `frontend/`:

```powershell
npm run test -- --run src/lib/task-space/document-edit.test.ts src/components/task-space/work-item-note-editor.test.tsx src/components/task-space/note-block-editor.test.tsx src/components/task-space/note-conflict-panel.test.tsx src/stores/task-space-store.test.ts
npm run typecheck
npm run lint -- src/lib/task-space src/components/task-space src/stores/task-space-store.ts
```

Expected: PASS; paragraph and Checklist are the only editable Blocks, Checklist nesting is capped at two levels, Checklist changes call no WorkItem transition, no promotion/reference surface exists, and conflicts expose two preserved versions only.

- [ ] **Step 9: Commit the complete WorkItemNote P0 editor**

```powershell
git add -- frontend/src/lib/task-space/document-edit.ts frontend/src/lib/task-space/document-edit.test.ts frontend/src/components/task-space/work-item-note-editor.tsx frontend/src/components/task-space/work-item-note-editor.test.tsx frontend/src/components/task-space/note-block-editor.tsx frontend/src/components/task-space/note-block-editor.test.tsx frontend/src/components/task-space/note-conflict-panel.tsx frontend/src/components/task-space/note-conflict-panel.test.tsx frontend/src/components/task-space/work-item-detail.tsx frontend/src/stores/task-space-store.ts frontend/src/stores/task-space-store.test.ts
git commit -m "feat(frontend): edit complete work item note documents"
```

---

### Task 6: Persist FocusSession Aggregates, Timestamp Clock Facts, Plans, And Offline Provisional Starts

**Files:**
- Create: `frontend/src/lib/focus-session/clock.ts`
- Create: `frontend/src/lib/focus-session/clock.test.ts`
- Create: `frontend/src/lib/focus-session/focus-session-repository.ts`
- Create: `frontend/src/lib/focus-session/focus-session-repository.test.ts`
- Create: `frontend/src/lib/focus-session/provisional-start-recovery.ts`
- Create: `frontend/src/lib/focus-session/provisional-start-recovery.test.ts`
- Create: `frontend/src/lib/focus-session/provisional-operation-lock.ts`
- Create: `frontend/src/lib/focus-session/provisional-operation-lock.test.ts`
- Create: `frontend/src/stores/focus-session-store.ts`
- Create: `frontend/src/stores/focus-session-store.test.ts`
- Modify: `frontend/src/stores/business-stores.test.ts`

**Interfaces:**
- Consumes: Task 1 parsed Session contracts; Task 2 Session tables and Meta provisional operations; Task Space cached level-2/level-3 versions.
- Produces: `deriveSessionClock(session, nowMs)`; shared cross-Tab `ProvisionalOperationLock`; `cacheFocusSession(database, expectedSpaceId, aggregate)`; `cacheAuthoritativeActivation(database, operation, result, provisional)` with exact absorbed-outbox cleanup; `OwnedActiveSessionMutations`; `FocusSessionRepository.cacheAggregate/startProvisional/pauseProvisional/resumeProvisional/endProvisional/setCurrentPlanItem/setCompletionDraft/addPlanItem/removePlanItem/updateSessionNote/saveReviewCache`; explicit authoritative-versus-provisional persistence branch; recoverable Meta-to-Space provisional start; nonterminal-only `buildActivateProvisionalPayload`; terminal `awaiting_s4` import post-image; `useFocusSessionStore` current-Space history/review projection.

- [ ] **Step 1: Write failing timestamp reconstruction tests**

```typescript
// frontend/src/lib/focus-session/clock.test.ts
import { describe, expect, it } from 'vitest'
import { deriveSessionClock } from './clock'

it('reconstructs running time from timestamps and persisted pause total', () => {
  const clock = deriveSessionClock({
    startedAt: '2026-07-15T08:00:00Z', endedAt: null, pauseStartedAt: null,
    plannedSeconds: 1500, pausedSeconds: 120, focusedSeconds: 0,
    clockState: 'running',
  }, Date.parse('2026-07-15T08:12:00Z'))
  expect(clock).toEqual({ elapsedSeconds: 600, remainingSeconds: 900, overtimeSeconds: 0 })
})

it('freezes focused time while paused and uses terminal persisted facts after end', () => {
  const paused = deriveSessionClock({
    startedAt: '2026-07-15T08:00:00Z', endedAt: null,
    pauseStartedAt: '2026-07-15T08:10:00Z', plannedSeconds: 1500,
    pausedSeconds: 60, focusedSeconds: 0, clockState: 'paused',
  }, Date.parse('2026-07-15T08:20:00Z'))
  expect(paused.elapsedSeconds).toBe(540)

  const ended = deriveSessionClock({
    startedAt: '2026-07-15T08:00:00Z', endedAt: '2026-07-15T08:25:00Z',
    pauseStartedAt: null, plannedSeconds: 1500, pausedSeconds: 150,
    focusedSeconds: 1350, clockState: 'ended',
  }, Date.parse('2026-07-15T09:00:00Z'))
  expect(ended.elapsedSeconds).toBe(1350)
})
```

- [ ] **Step 2: Write failing aggregate-cache and offline-provisional coordination tests**

```typescript
// frontend/src/lib/focus-session/focus-session-repository.test.ts
import type { ProvisionalOperationRow } from '@/services/meta-database'

const provisionalOperationFixture = (
  overrides: Partial<ProvisionalOperationRow> = {},
): ProvisionalOperationRow => ({
  operationId: 'offline-op-1', deviceId: 'device-local', tabId: 'tab-local',
  spaceId: 'space-a', sessionId: 'fs-1', cachedOwnershipEpoch: null,
  intentJson: '{"spaceId":"space-a","sessionId":"fs-1"}',
  payloadHash: 'a'.repeat(64), state: 'pending',
  createdAt: '2026-07-15T08:00:00Z', updatedAt: '2026-07-15T08:00:00Z',
  ...overrides,
})

it('stores aggregate rows and local outbox effects in one Space transaction', async () => {
  const repository = sessionRepositoryFixture('space-a')
  await repository.cacheAggregate(focusSessionAggregate())
  expect(await repository.db.focusSessions.get('fs-1')).toMatchObject({
    sessionId: 'fs-1', ownershipState: 'authoritative',
  })
  expect(await repository.db.sessionTaskContexts.get('fs-1')).toBeDefined()
  expect(await repository.db.sessionWorkItemPlans.where('sessionId').equals('fs-1').count()).toBe(2)
})

it('creates one local_provisional Session from cached immutable snapshots', async () => {
  const repository = sessionRepositoryFixture('space-a', { online: false })
  const result = await repository.startProvisional({
    sessionId: 'offline-1', operationId: 'offline-op-1', level2WorkItemId: 'l2',
    level3WorkItemIds: ['l3'], plannedSeconds: 1500,
    expectedWorkItemVersions: { l2: 4, l3: 2 },
    startedAt: '2026-07-15T08:00:00Z', deviceId: 'device-a', tabId: 'tab-a',
  })
  expect(result.session).toMatchObject({ ownershipState: 'local_provisional', validity: 'pending' })
  expect(await repository.meta.provisionalOperations.get('offline-op-1')).toMatchObject({
    state: 'pending', spaceId: 'space-a', sessionId: 'offline-1',
  })
  expect(result.context?.level2VersionSnapshot).toBe(4)
  expect(result.plan[0].workItemVersionSnapshot).toBe(2)
})

it('does not expose a pending Meta claim before its Space snapshot is durable', async () => {
  const fixture = integratedProvisionalFixture({ pauseAfterMetaClaim: true })
  const start = fixture.repository.startProvisional(provisionalStartInput())
  await fixture.waitUntilMetaClaimed('offline-op-1')
  const reconcile = fixture.coordinator.reconcileProvisional('offline-op-1')
  expect(fixture.api.activateProvisional).not.toHaveBeenCalled()
  fixture.releaseSpacePersist()
  await start
  await reconcile
  expect(fixture.api.activateProvisional).toHaveBeenCalledOnce()
  expect(await fixture.db.focusSessions.get('offline-1')).toBeDefined()
  expect(fixture.activationObservedCompleteSnapshot()).toBe(true)
})

it('persists the compound create in semantic order with per-entity IDs and hashes', async () => {
  const fixture = sessionRepositoryFixture('space-a', { online: false })
  const result = await fixture.repository.startProvisional(provisionalStartInput({
    operationId: 'r'.repeat(128), level3WorkItemIds: ['l3-b', 'l3-a'],
  }))
  const rows = await fixture.db.outbox
    .where('compoundOperationId').equals('r'.repeat(128)).sortBy('compoundOrder')
  expect(rows.map((row) => row.entityType)).toEqual([
    'focusSession', 'sessionTaskContext', 'sessionAttributionRevision',
    'sessionWorkItemPlan', 'sessionWorkItemPlan',
  ])
  expect(rows.map((row) => row.compoundOrder)).toEqual([0, 1, 2, 3, 4])
  expect(new Set(rows.map((row) => row.operationId)).size).toBe(rows.length)
  expect(rows.every((row) => /^[\x21-\x7e]{1,128}$/.test(row.operationId))).toBe(true)
  expect(rows.map((row) => row.payloadHash)).toEqual(
    await provisionalS4CreateHashVector(result),
  )

  const prepared = prepareHeldProvisionalBatch([...rows].reverse())
  expect(prepared.batchId).toBe('r'.repeat(128))
  expect(prepared.items.map((item) => item.requestIndex)).toEqual([0, 1, 2, 3, 4])
  expect(prepared.items.map((item) => item.entityType)).toEqual(rows.map((row) => row.entityType))
  expect(new Set(prepared.items.map((item) => item.operationId)).size).toBe(prepared.items.length)
  expect(() => assertMatchesTrackedS4EntityCreateVector(prepared)).not.toThrow()

  fixture.db.close()
  await fixture.reopen()
  const afterRestart = prepareHeldProvisionalBatch(
    await fixture.db.outbox.where('compoundOperationId').equals('r'.repeat(128)).toArray(),
  )
  expect(afterRestart).toEqual(prepared)
})

it('rejects review_materialized from a local provisional/import compound', async () => {
  const fixture = sessionRepositoryFixture('space-a', {
    provisionalPlanSource: 'review_materialized',
  })
  await expect(fixture.repository.startProvisional(provisionalStartInput()))
    .rejects.toThrow('invalid_initial_provisional_aggregate')
  expect(await fixture.db.outbox.count()).toBe(0)
})

it('pauses, resumes, and ends a provisional Session as one held closed post-image', async () => {
  const fixture = sessionRepositoryFixture('space-a', { online: false })
  await fixture.repository.startProvisional(provisionalStartInput({
    startedAt: '2026-07-15T08:00:00Z',
  }))
  await fixture.repository.pauseProvisional('offline-1', '2026-07-15T08:05:00Z')
  await fixture.repository.resumeProvisional('offline-1', '2026-07-15T08:06:00Z')
  await fixture.repository.endProvisional('offline-1', {
    occurredAt: '2026-07-15T08:10:00Z', timerCompletion: 'ended_early',
  })
  expect(await fixture.db.focusSessions.get('offline-1')).toMatchObject({
    endedAt: '2026-07-15T08:10:00Z', pauseStartedAt: null,
    grossSeconds: 600, pausedSeconds: 60, focusedSeconds: 540,
    clockState: 'ended', timerCompletion: 'ended_early', validity: 'pending',
  })
  expect(await fixture.meta.provisionalOperations.get('offline-op-1'))
    .toMatchObject({ state: 'awaiting_s4' })
  const held = await fixture.db.outbox.where('entityId').equals('offline-1').first()
  expect(held).toMatchObject({ action: 'create', expectedVersion: null,
    transportState: 'awaiting_s4' })

  await fixture.repository.startProvisional(provisionalStartInput({
    sessionId: 'offline-2', operationId: 'offline-op-2',
    startedAt: '2026-07-15T08:11:00Z',
  }))
  expect(await fixture.meta.provisionalOperations.get('offline-op-1'))
    .toMatchObject({ state: 'awaiting_s4' })
  expect(await fixture.meta.provisionalOperations.get('offline-op-2'))
    .toMatchObject({ state: 'pending' })
  expect(await fixture.db.focusSessions.get('offline-1'))
    .toMatchObject({ clockState: 'ended', ownershipState: 'local_provisional' })
})

it.each([
  ['updateSessionNote', ['fs-1', 'Observed']],
  ['setCurrentPlanItem', ['fs-1', 'l3-a']],
  ['setCompletionDraft', ['fs-1', 'plan-a', true]],
  ['addPlanItem', ['fs-1', 'l3-b', 2, '2026-07-15T08:05:00Z']],
  ['removePlanItem', ['fs-1', 'plan-a', '2026-07-15T08:06:00Z', 'Replanned']],
] as const)('routes authoritative %s through the owner Coordinator only', async (method, args) => {
  const fixture = sessionRepositoryFixture('space-a', { ownershipState: 'authoritative' })
  await (fixture.repository[method] as (...values: unknown[]) => Promise<void>)(...args)
  expect(fixture.active[method]).toHaveBeenCalledOnce()
  expect(await fixture.db.outbox.count()).toBe(0)
})

it('keeps local-provisional running-content writes held from ordinary transport', async () => {
  const fixture = sessionRepositoryFixture('space-a', { ownershipState: 'local_provisional' })
  await fixture.repository.updateSessionNote('fs-1', 'Offline note')
  await fixture.repository.setCurrentPlanItem('fs-1', 'l3-a')
  await fixture.repository.setCompletionDraft('fs-1', 'plan-a', true)
  await fixture.repository.addPlanItem('fs-1', 'l3-b', 2, '2026-07-15T08:05:00Z')
  await fixture.repository.removePlanItem(
    'fs-1', 'plan-a', '2026-07-15T08:06:00Z', 'Replanned',
  )
  expect(Object.values(fixture.active).every((mock) => mock.mock.calls.length === 0)).toBe(true)
  expect((await fixture.db.outbox.toArray()).every(
    (row) => row.transportState === 'awaiting_s4',
  )).toBe(true)
  for (const row of await fixture.db.outbox.toArray()) {
    const payload = JSON.parse(row.payload) as Record<string, unknown>
    expect(payload).not.toHaveProperty('spaceId')
    expect(payload).not.toHaveProperty('clockState')
    expect(payload).toMatchObject({ id: row.entityId })
    expect(payload).toHaveProperty('createdAt')
    expect(payload).toHaveProperty('updatedAt')
    expect(payload).toHaveProperty('version')
    if (row.entityType === 'focusSession') {
      expect(payload).toMatchObject({ overallProgress: null, mood: null })
    }
  }
})

it('rejects activation-conflict note, plan, and timer writes with zero durable effect', async () => {
  const fixture = sessionRepositoryFixture('space-a', { ownershipState: 'activation_conflict' })
  const before = {
    session: await fixture.db.focusSessions.get('fs-1'),
    plans: await fixture.db.sessionWorkItemPlans.orderBy('id').toArray(),
    outbox: await fixture.db.outbox.orderBy('id').toArray(),
  }
  const attempts = [
    () => fixture.repository.updateSessionNote('fs-1', 'Blocked note'),
    () => fixture.repository.setCurrentPlanItem('fs-1', 'l3-a'),
    () => fixture.repository.setCompletionDraft('fs-1', 'plan-a', true),
    () => fixture.repository.addPlanItem('fs-1', 'l3-b', 2, '2026-07-15T08:05:00Z'),
    () => fixture.repository.removePlanItem(
      'fs-1', 'plan-a', '2026-07-15T08:06:00Z', 'Replanned',
    ),
    () => fixture.repository.pauseProvisional('fs-1', '2026-07-15T08:05:00Z'),
    () => fixture.repository.resumeProvisional('fs-1', '2026-07-15T08:06:00Z'),
    () => fixture.repository.endProvisional('fs-1', {
      occurredAt: '2026-07-15T08:07:00Z', timerCompletion: 'ended_early',
    }),
    () => fixture.repository.submitReview(reviewDraft({
      sessionId: 'fs-1', operationId: 'blocked-review-1',
    })),
  ]
  for (const attempt of attempts) {
    await expect(attempt()).rejects.toThrow('blocked_conflict')
  }
  expect(await fixture.db.focusSessions.get('fs-1')).toEqual(before.session)
  expect(await fixture.db.sessionWorkItemPlans.orderBy('id').toArray()).toEqual(before.plans)
  expect(await fixture.db.outbox.orderBy('id').toArray()).toEqual(before.outbox)
  expect(Object.values(fixture.active).every((mock) => mock.mock.calls.length === 0)).toBe(true)
})

it('rejects an observer Tab before any provisional local effect', async () => {
  const fixture = sessionRepositoryFixture('space-a', {
    ownershipState: 'local_provisional', provisionalOwnerTabId: 'tab-owner',
    localTabId: 'tab-observer',
  })
  const before = await fixture.db.focusSessions.get('fs-1')
  await expect(fixture.repository.updateSessionNote('fs-1', 'Observer write'))
    .rejects.toThrow('active_session_not_owned')
  expect(await fixture.db.focusSessions.get('fs-1')).toEqual(before)
  expect(await fixture.db.outbox.count()).toBe(0)
  expect(fixture.active.updateSessionNote).not.toHaveBeenCalled()
})

it('fences every provisional local write after activation enters flight', async () => {
  const fixture = sessionRepositoryFixture('space-a', {
    ownershipState: 'local_provisional', provisionalOperationState: 'activating',
  })
  const sessionBefore = await fixture.db.focusSessions.get('fs-1')
  const outboxBefore = await fixture.db.outbox.toArray()
  await expect(fixture.repository.updateSessionNote('fs-1', 'Late local edit'))
    .rejects.toThrow('active_session_not_owned')
  await expect(fixture.repository.pauseProvisional('fs-1', '2026-07-15T08:05:00Z'))
    .rejects.toThrow('active_session_not_owned')
  expect(await fixture.db.focusSessions.get('fs-1')).toEqual(sessionBefore)
  expect(await fixture.db.outbox.toArray()).toEqual(outboxBefore)
})

it('does not authorize a same-ID provisional operation from another Space', async () => {
  const fixture = sessionRepositoryFixture('space-a', {
    ownershipState: 'local_provisional', omitLocalProvisionalOperation: true,
  })
  await fixture.meta.provisionalOperations.put(provisionalOperationFixture({
    spaceId: 'space-b', sessionId: 'fs-1', deviceId: 'device-local', tabId: 'tab-local',
  }))
  await expect(fixture.repository.setCompletionDraft('fs-1', 'plan-a', true))
    .rejects.toThrow('active_session_not_owned')
  expect(await fixture.db.outbox.count()).toBe(0)
})
```

- [ ] **Step 3: Run FocusSession persistence tests and verify the red state**

Run from `frontend/`:

```powershell
npm run test -- --run src/lib/focus-session/clock.test.ts src/lib/focus-session/focus-session-repository.test.ts src/lib/focus-session/provisional-operation-lock.test.ts src/lib/focus-session/provisional-start-recovery.test.ts src/stores/focus-session-store.test.ts src/stores/business-stores.test.ts
```

Expected: FAIL because the clock, repository, recovery, and replacement store do not exist.

- [ ] **Step 4: Implement the pure clock projection**

```typescript
// frontend/src/lib/focus-session/clock.ts
const seconds = (milliseconds: number) => Math.max(0, Math.floor(milliseconds / 1000))

export function deriveSessionClock(session: ClockFacts, nowMs: number): DerivedClock {
  let elapsedSeconds: number
  if (session.clockState === 'ended') {
    elapsedSeconds = session.focusedSeconds
  } else {
    const end = session.clockState === 'paused'
      ? Date.parse(session.pauseStartedAt!)
      : nowMs
    elapsedSeconds = Math.max(0, seconds(end - Date.parse(session.startedAt)) - session.pausedSeconds)
  }
  return {
    elapsedSeconds,
    remainingSeconds: Math.max(0, session.plannedSeconds - elapsedSeconds),
    overtimeSeconds: Math.max(0, elapsedSeconds - session.plannedSeconds),
  }
}
```

Only React repaint state stores `nowMs`; no Dexie or Zustand business row stores `remaining`, `tick`, or a decremented duration.

```typescript
// frontend/src/lib/focus-session/provisional-operation-lock.ts
export interface ProvisionalOperationLock {
  run<T>(operationId: string, effect: () => Promise<T>): Promise<T>
}

export class BrowserProvisionalOperationLock implements ProvisionalOperationLock {
  run<T>(operationId: string, effect: () => Promise<T>): Promise<T> {
    if (!/^[\x21-\x7e]{1,128}$/.test(operationId)) {
      return Promise.reject(new Error('invalid provisional operation ID'))
    }
    return navigator.locks.request(
      `pxii:provisional-operation:${operationId}`,
      { mode: 'exclusive' },
      effect,
    )
  }
}
```

The provider constructs one `BrowserProvisionalOperationLock` and injects it into both `FocusSessionRepository` and `ActiveSessionCoordinatorClient`. The Web Lock name is operation-scoped and therefore serializes same-Tab promises and any stale cross-Tab contender; owner proof is still rechecked inside the lock and remains the authorization boundary.

- [ ] **Step 5: Implement parsed aggregate caching and ownership-branched running-content mutations**

```typescript
// frontend/src/lib/focus-session/focus-session-repository.ts
import Dexie from 'dexie'
import { hashCommandPayload, type JsonValue } from '@/lib/contracts/payload-hash'
import {
  activeSessionSchema, activateProvisionalPayloadSchema,
  focusSessionCommandPostImageSchema,
  sessionAttributionRevisionCommandPostImageSchema,
  sessionTaskContextCommandPostImageSchema,
  sessionWorkItemOutcomeCommandPostImageSchema,
  sessionWorkItemPlanCommandPostImageSchema,
  type ActiveSessionView, type FocusSessionAggregateView,
  type ProvisionalActivationPayload,
} from '@/lib/contracts/focus-session'

type FocusSessionRows = ReturnType<typeof toSpaceRows>

export async function putFocusSessionRows(
  database: PomodoroXIDB,
  rows: FocusSessionRows,
): Promise<void> {
  await database.focusSessions.put(rows.session)
  if (rows.context) await database.sessionTaskContexts.put(rows.context)
  await database.sessionAttributionRevisions.bulkPut(rows.attributions)
  await database.sessionWorkItemPlans.bulkPut(rows.plans)
  await database.sessionWorkItemOutcomes.bulkPut(rows.outcomes)
  await database.sessionCommandEnvelopes.bulkPut(rows.envelopes)
  await database.sessionCommandReceipts.bulkPut(rows.receipts)
}

export async function cacheFocusSession(
  database: PomodoroXIDB, expectedSpaceId: string, raw: unknown,
): Promise<CachedFocusSession> {
  const aggregate = focusSessionAggregateSchema.parse(raw)
  assertResponseSpace(aggregate.session, expectedSpaceId)
  const rows = toSpaceRows(aggregate)
  await database.transaction(
    'rw', database.focusSessions, database.sessionTaskContexts,
    database.sessionAttributionRevisions, database.sessionWorkItemPlans,
    database.sessionWorkItemOutcomes, database.sessionCommandEnvelopes,
    database.sessionCommandReceipts,
    () => putFocusSessionRows(database, rows),
  )
  return rows.session
}

export const provisionalOutboxKey = (entityType: string, entityId: string) =>
  `${entityType}\0${entityId}`

export function absorbedProvisionalOutboxKeys(
  provisional: LocalFocusSessionAggregate,
): Set<string> {
  const sessionId = provisional.session.sessionId
  if (!provisional.context || provisional.context.sessionId !== sessionId ||
      provisional.attribution.sessionId !== sessionId ||
      !provisional.attribution.effective ||
      provisional.plan.some((item) => item.sessionId !== sessionId)) {
    throw new Error('authoritative_activation_snapshot_identity_mismatch')
  }
  return new Set([
    provisionalOutboxKey('focusSession', sessionId),
    provisionalOutboxKey('sessionTaskContext', provisional.context.id),
    provisionalOutboxKey('sessionAttributionRevision', provisional.attribution.id),
    ...provisional.plan.map((item) =>
      provisionalOutboxKey('sessionWorkItemPlan', item.id)),
  ])
}

export function absorbedProvisionalEntityIds(
  provisional: LocalFocusSessionAggregate,
): string[] {
  absorbedProvisionalOutboxKeys(provisional)
  return [...new Set([
    provisional.session.sessionId,
    provisional.context!.id,
    provisional.attribution.id,
    ...provisional.plan.map((item) => item.id),
  ])]
}

export async function cacheAuthoritativeActivation(
  database: PomodoroXIDB,
  operation: ProvisionalOperationRow,
  rawResult: unknown,
  provisional: LocalFocusSessionAggregate,
): Promise<CachedFocusSession> {
  const result = activeSessionSchema.parse(rawResult)
  if (result.kind !== 'authoritative' && result.kind !== 'resumed') {
    throw new Error('authoritative_activation_result_kind_required')
  }
  const aggregate = result.session
  assertResponseSpace(aggregate.session, operation.spaceId)
  if (operation.sessionId !== provisional.session.sessionId ||
      result.spaceId !== operation.spaceId || result.sessionId !== operation.sessionId ||
      aggregate.session.id !== operation.sessionId) {
    throw new Error('authoritative_activation_snapshot_identity_mismatch')
  }
  const rows = toSpaceRows(aggregate)
  const resultHash = await hashCommandPayload(result as unknown as JsonValue)
  const absorbedKeys = absorbedProvisionalOutboxKeys(provisional)
  const absorbedEntityIds = absorbedProvisionalEntityIds(provisional)

  await database.transaction(
    'rw', database.focusSessions, database.sessionTaskContexts,
    database.sessionAttributionRevisions, database.sessionWorkItemPlans,
    database.sessionWorkItemOutcomes, database.sessionCommandEnvelopes,
    database.sessionCommandReceipts, database.sessionActivationApplications,
    database.outbox,
    async () => {
      const possibleRows = await database.outbox
        .where('entityId').anyOf(absorbedEntityIds).toArray()
      const absorbedRows = possibleRows.filter((row) =>
        absorbedKeys.has(provisionalOutboxKey(row.entityType, row.entityId)))
      const existingReceipt = await database.sessionActivationApplications
        .get(operation.operationId)
      if (existingReceipt) {
        if (existingReceipt.resultHash !== resultHash ||
            existingReceipt.resultKind !== result.kind ||
            existingReceipt.provisionalSpaceId !== operation.spaceId ||
            existingReceipt.provisionalSessionId !== operation.sessionId ||
            existingReceipt.activeSpaceId !== result.spaceId ||
            existingReceipt.activeSessionId !== result.sessionId ||
            existingReceipt.activeSessionVersion !== aggregate.session.version ||
            existingReceipt.ownershipEpoch !== result.ownershipEpoch ||
            absorbedRows.length !== 0) {
          throw new Error('activation_application_receipt_mismatch')
        }
        await putFocusSessionRows(database, rows)
        return
      }
      const unsafe = absorbedRows.find((row) =>
        row.transportState !== 'awaiting_s4' || row.attemptCount !== 0 || row.synced ||
        row.action !== 'create' || row.expectedVersion !== null ||
        row.requiresVersionRebase || row.lastError !== null ||
        row.lastErrorCode !== null || row.failedAt !== null)
      if (unsafe) {
        throw new Error(`authoritative_activation_outbox_not_consumable:${unsafe.id}`)
      }
      const seenKeys = new Set(absorbedRows.map((row) =>
        provisionalOutboxKey(row.entityType, row.entityId)))
      if (absorbedRows.length !== absorbedKeys.size || seenKeys.size !== absorbedKeys.size ||
          [...absorbedKeys].some((key) => !seenKeys.has(key))) {
        throw new Error('authoritative_activation_outbox_incomplete')
      }
      await putFocusSessionRows(database, rows)
      await database.sessionActivationApplications.add({
        operationId: operation.operationId,
        provisionalSpaceId: operation.spaceId,
        provisionalSessionId: operation.sessionId,
        resultKind: result.kind,
        resultHash,
        resultJson: JSON.stringify(result),
        activeSpaceId: result.spaceId,
        activeSessionId: result.sessionId,
        activeSessionVersion: aggregate.session.version,
        ownershipEpoch: result.ownershipEpoch,
        absorbedOutboxIds: absorbedRows.map((row) => row.id!).sort((a, b) => a - b),
        appliedAt: result.updatedAt,
      })
      await database.outbox.bulkDelete(absorbedRows.map((row) => row.id!))
    },
  )
  return rows.session
}

export async function cacheResolvedProvisionalWinner(
  database: PomodoroXIDB,
  operation: Pick<ProvisionalOperationRow, 'operationId' | 'spaceId' | 'sessionId'>,
  conflict: SessionActivationConflictRow,
  resolution: { operationId: string; selectedRole: 'candidate'; resolvedAt: string },
  rawResult: unknown,
): Promise<CachedFocusSession> {
  const result = activationResolutionSchema.parse(rawResult)
  if (conflict.provisionalOperationId !== operation.operationId ||
      conflict.provisionalSpaceId !== operation.spaceId ||
      conflict.provisionalSessionId !== operation.sessionId ||
      result.spaceId !== operation.spaceId || result.sessionId !== operation.sessionId ||
      result.session.session.id !== operation.sessionId) {
    throw new Error('resolved_candidate_identity_mismatch')
  }
  const rows = toSpaceRows(result.session)
  const resultHash = await hashCommandPayload(result as unknown as JsonValue)
  await database.transaction(
    'rw', database.focusSessions, database.sessionTaskContexts,
    database.sessionAttributionRevisions, database.sessionWorkItemPlans,
    database.sessionWorkItemOutcomes, database.sessionCommandEnvelopes,
    database.sessionCommandReceipts, database.sessionActivationApplications,
    database.outbox,
    async () => {
      const conflictReceipt = await database.sessionActivationApplications
        .get(operation.operationId)
      if (!conflictReceipt || conflictReceipt.resultKind !== 'activation_conflict' ||
          conflictReceipt.provisionalSpaceId !== operation.spaceId ||
          conflictReceipt.provisionalSessionId !== operation.sessionId ||
          conflictReceipt.activeSpaceId !== conflict.authoritativeSpaceId ||
          conflictReceipt.activeSessionId !== conflict.authoritativeSessionId) {
        throw new Error('activation_conflict_receipt_missing_or_mismatched')
      }
      const heldRows = await database.outbox.bulkGet(conflictReceipt.absorbedOutboxIds)
      const existing = await database.sessionActivationApplications.get(resolution.operationId)
      if (existing) {
        if (existing.resultKind !== 'authoritative' || existing.resultHash !== resultHash ||
            existing.provisionalSpaceId !== operation.spaceId ||
            existing.provisionalSessionId !== operation.sessionId ||
            existing.activeSpaceId !== result.spaceId ||
            existing.activeSessionId !== result.sessionId ||
            existing.activeSessionVersion !== result.session.session.version ||
            existing.ownershipEpoch !== result.ownershipEpoch ||
            existing.appliedAt !== resolution.resolvedAt ||
            JSON.stringify(existing.absorbedOutboxIds) !==
              JSON.stringify(conflictReceipt.absorbedOutboxIds) ||
            heldRows.some((row) => row !== undefined)) {
          throw new Error('activation_resolution_application_receipt_mismatch')
        }
        await putFocusSessionRows(database, rows)
        return
      }
      const unsafe = heldRows.find((row) => !row ||
        row.transportState !== 'blocked_conflict' || row.attemptCount !== 0 || row.synced ||
        row.action !== 'create' || row.expectedVersion !== null ||
        row.requiresVersionRebase || row.lastError !== null ||
        row.lastErrorCode !== null || row.failedAt !== null)
      if (unsafe !== undefined || heldRows.some((row) => row === undefined)) {
        throw new Error('resolved_candidate_outbox_not_consumable')
      }
      await putFocusSessionRows(database, rows)
      await database.sessionActivationApplications.add({
        operationId: resolution.operationId,
        provisionalSpaceId: operation.spaceId,
        provisionalSessionId: operation.sessionId,
        resultKind: 'authoritative', resultHash,
        resultJson: JSON.stringify(result),
        activeSpaceId: result.spaceId,
        activeSessionId: result.sessionId,
        activeSessionVersion: result.session.session.version,
        ownershipEpoch: result.ownershipEpoch,
        absorbedOutboxIds: [...conflictReceipt.absorbedOutboxIds],
        appliedAt: resolution.resolvedAt,
      })
      await database.outbox.bulkDelete(conflictReceipt.absorbedOutboxIds)
    },
  )
  return rows.session
}

export interface OwnedActiveSessionMutations {
  updateSessionNote(input: {
    sessionId: string; sessionNote: string;
  }): Promise<FocusSessionAggregateView>
  setCurrentPlanItem(input: {
    sessionId: string; workItemId: string | null;
  }): Promise<FocusSessionAggregateView>
  setCompletionDraft(input: {
    sessionId: string; planItemId: string; completionDraft: boolean;
  }): Promise<FocusSessionAggregateView>
  addPlanItem(input: {
    sessionId: string; workItemId: string; expectedWorkItemVersion: number;
    planRank: number; addedAt: string;
  }): Promise<FocusSessionAggregateView>
  removePlanItem(input: {
    sessionId: string; planItemId: string; removedAt: string; removalReason: string;
  }): Promise<FocusSessionAggregateView>
}

const localTransportState = (session: CachedFocusSession) => {
  if (session.ownershipState === 'local_provisional') return 'awaiting_s4' as const
  throw new Error('authoritative running content must use ActiveSessionCoordinator')
}

const assertLocalContentWritable = (session: CachedFocusSession): void => {
  if (session.ownershipState === 'activation_conflict') {
    throw new Error('blocked_conflict')
  }
}

interface LocalOwnerProof {
  operation: ProvisionalOperationRow
  transportState: 'awaiting_s4'
}

const serializeFocusSessionCommandPostImage = (row: CachedFocusSession) => {
  const { sessionId, clockState: _derived, ...persisted } = row
  return focusSessionCommandPostImageSchema.parse({ id: sessionId, ...persisted })
}

const serializeSessionTaskContextCommandPostImage =
  (row: CachedSessionTaskContext) => sessionTaskContextCommandPostImageSchema.parse(row)

const serializeSessionAttributionCommandPostImage =
  (row: CachedSessionAttributionRevision) =>
    sessionAttributionRevisionCommandPostImageSchema.parse(row)

const serializeSessionPlanCommandPostImage =
  (row: CachedSessionWorkItemPlan) => sessionWorkItemPlanCommandPostImageSchema.parse(row)

const serializeSessionOutcomeCommandPostImage =
  (row: CachedSessionWorkItemOutcome) =>
    sessionWorkItemOutcomeCommandPostImageSchema.parse(row)

const localPlanCreateHashPayload = (row: CachedSessionWorkItemPlan): JsonValue => ({
  session_id: row.sessionId,
  work_item_id: row.workItemId,
  title_snapshot: row.titleSnapshot,
  level2_work_item_id_snapshot: row.level2WorkItemIdSnapshot,
  work_item_version_snapshot: row.workItemVersionSnapshot,
  plan_rank: row.planRank,
  source: row.source,
  added_at: row.addedAt,
  removed_at: row.removedAt,
  removal_reason: row.removalReason,
  current_during_session: row.currentDuringSession,
  completion_draft: row.completionDraft,
})

const localContextCreateHashPayload = (row: CachedSessionTaskContext): JsonValue => ({
  session_id: row.sessionId,
  project_id: row.projectId,
  level2_work_item_id: row.level2WorkItemId,
  project_title_snapshot: row.projectTitleSnapshot,
  level2_title_snapshot: row.level2TitleSnapshot,
  level2_parent_id_snapshot: row.level2ParentIdSnapshot,
  level2_status_definition_id_snapshot: row.level2StatusDefinitionIdSnapshot,
  level2_version_snapshot: row.level2VersionSnapshot,
  level2_effort_lower_seconds_snapshot: row.level2EffortLowerSecondsSnapshot,
  level2_effort_upper_seconds_snapshot: row.level2EffortUpperSecondsSnapshot,
  linked_at: row.linkedAt,
  link_method: row.linkMethod,
})

const localAttributionCreateHashPayload = (
  row: CachedSessionAttributionRevision,
): JsonValue => ({
  session_id: row.sessionId,
  revision: row.revision,
  project_id: row.projectId,
  level2_work_item_id: row.level2WorkItemId,
  reason: row.reason,
  corrected_from_revision: row.correctedFromRevision,
  effective: row.effective,
  created_at: row.createdAt,
})

async function reindexUnattemptedProvisionalPlanOutbox(
  db: PomodoroXIDB,
  compoundOperationId: string,
  sessionId: string,
): Promise<void> {
  const plans = await db.sessionWorkItemPlans.where('sessionId').equals(sessionId).toArray()
  plans.sort((left, right) => left.planRank - right.planRank || left.id.localeCompare(right.id))
  const outboxRows = await db.outbox.where('compoundOperationId')
    .equals(compoundOperationId)
    .and((row) => row.entityType === 'sessionWorkItemPlan').toArray()
  const byEntityId = new Map(outboxRows.map((row) => [row.entityId, row]))
  for (const [index, plan] of plans.entries()) {
    const row = byEntityId.get(plan.id)
    const expectedOperationId = await Dexie.waitFor(
      boundedChildOperationId(compoundOperationId, `plan:${plan.id}`),
    )
    if (!row || row.attemptCount !== 0 || row.operationId !== expectedOperationId ||
        row.transportState !== 'awaiting_s4') {
      throw new Error('provisional_plan_outbox_not_reindexable')
    }
    await db.outbox.update(row.id!, { compoundOrder: 3 + index })
  }
}

const localSessionCreateHashPayload = (row: CachedFocusSession): JsonValue => ({
  session_revision: row.sessionRevision,
  started_at: row.startedAt,
  ended_at: row.endedAt,
  pause_started_at: row.pauseStartedAt,
  planned_seconds: row.plannedSeconds,
  gross_seconds: row.grossSeconds,
  paused_seconds: row.pausedSeconds,
  break_seconds: row.breakSeconds,
  focused_seconds: row.focusedSeconds,
  timer_completion: row.timerCompletion,
  validity: row.validity,
  validity_reason: row.validityReason,
  overall_progress: row.overallProgress,
  mood: row.mood,
  review_state: row.reviewState,
  ownership_state: row.ownershipState,
  session_note: row.sessionNote,
})

export class FocusSessionRepository {
  constructor(
    readonly db: PomodoroXIDB,
    readonly meta: MetaDB,
    private readonly spaceId: string,
    private readonly identity: TabIdentity,
    private readonly active: OwnedActiveSessionMutations,
    private readonly provisionalLock: ProvisionalOperationLock,
  ) {}

  async cacheAggregate(raw: unknown): Promise<CachedFocusSession> {
    return cacheFocusSession(this.db, this.spaceId, raw)
  }

  private async cacheAuthoritative(
    action: Promise<FocusSessionAggregateView>,
  ): Promise<void> {
    await cacheFocusSession(this.db, this.spaceId, await action)
  }

  private async requireSession(sessionId: string): Promise<CachedFocusSession> {
    const session = await this.db.focusSessions.get(sessionId)
    if (!session) throw new Error('focus_session_not_found')
    return session
  }

  private async requireLocalOwner(session: CachedFocusSession): Promise<LocalOwnerProof> {
    assertLocalContentWritable(session)
    if (session.ownershipState !== 'local_provisional') {
      throw new Error('active_session_not_owned')
    }
    const operations = await this.meta.provisionalOperations
      .where('sessionId').equals(session.sessionId)
      .and((row) => row.spaceId === this.spaceId && row.state === 'pending')
      .toArray()
    const tab = await this.meta.sessionTabs.get(this.identity.tabId)
    const operation = operations.length === 1 ? operations[0] : null
    if (!operation || operation.deviceId !== this.identity.deviceId ||
        operation.tabId !== this.identity.tabId || !tab ||
        tab.deviceId !== this.identity.deviceId || tab.closedAt !== null) {
      throw new Error('active_session_not_owned')
    }
    return { operation, transportState: localTransportState(session) }
  }

  private async withLocalOwner<T>(
    staleSession: CachedFocusSession,
    effect: (
      session: CachedFocusSession,
      proof: LocalOwnerProof,
    ) => Promise<T>,
  ): Promise<T> {
    assertLocalContentWritable(staleSession)
    const candidates = await this.meta.provisionalOperations
      .where('sessionId').equals(staleSession.sessionId)
      .and((row) => row.spaceId === this.spaceId &&
        row.deviceId === this.identity.deviceId && row.tabId === this.identity.tabId &&
        (row.state === 'pending' || row.state === 'activating'))
      .toArray()
    if (candidates.length !== 1) throw new Error('active_session_not_owned')
    return this.provisionalLock.run(candidates[0]!.operationId, async () => {
      const current = await this.requireSession(staleSession.sessionId)
      const proof = await this.requireLocalOwner(current)
      return effect(current, proof)
    })
  }

  private clockAt(
    session: CachedFocusSession,
    occurredAt: string,
  ): { grossSeconds: number; pausedSeconds: number; focusedSeconds: number } {
    if (!occurredAt.endsWith('Z') || !Number.isFinite(Date.parse(occurredAt))) {
      throw new Error('occurredAt must be canonical UTC')
    }
    const occurredMs = Date.parse(occurredAt)
    const startedMs = Date.parse(session.startedAt)
    if (occurredMs < startedMs) throw new Error('session_clock_time_regression')
    const extraPause = session.pauseStartedAt === null
      ? 0 : Math.floor((occurredMs - Date.parse(session.pauseStartedAt)) / 1000)
    const grossSeconds = Math.floor((occurredMs - startedMs) / 1000)
    const pausedSeconds = session.pausedSeconds + extraPause
    return {
      grossSeconds,
      pausedSeconds,
      focusedSeconds: Math.max(0, grossSeconds - pausedSeconds - session.breakSeconds),
    }
  }

  private async persistProvisionalClock(
    previous: CachedFocusSession,
    next: CachedFocusSession,
    operation: ProvisionalOperationRow,
  ): Promise<CachedFocusSession> {
    const payloadHash = await hashCommandPayload(localSessionCreateHashPayload(next))
    const operationId = await boundedChildOperationId(
      operation.operationId, 'focus_session',
    )
    await this.db.transaction('rw', this.db.focusSessions, this.db.outbox, async () => {
      await this.db.focusSessions.put(next)
      await enqueueOutbox(this.db, this.spaceId, 'focusSession', next.sessionId,
        previous.version === 0 ? 'create' : 'update',
        serializeFocusSessionCommandPostImage(next), {
          operationId,
          payloadHash,
          expectedVersion: previous.version === 0 ? null : previous.version,
          transportState: 'awaiting_s4',
          createdAt: next.updatedAt,
        })
    })
    return next
  }

  async pauseProvisional(sessionId: string, occurredAt: string): Promise<CachedFocusSession> {
    const session = await this.requireSession(sessionId)
    assertLocalContentWritable(session)
    if (session.ownershipState !== 'local_provisional' || session.clockState !== 'running') {
      throw new Error('provisional_session_not_running')
    }
    return this.withLocalOwner(session, (current, { operation }) =>
      this.persistProvisionalClock(current, {
        ...current, ...this.clockAt(current, occurredAt),
        sessionRevision: current.sessionRevision + 1,
        pauseStartedAt: occurredAt, clockState: 'paused', updatedAt: occurredAt,
      }, operation))
  }

  async resumeProvisional(sessionId: string, occurredAt: string): Promise<CachedFocusSession> {
    const session = await this.requireSession(sessionId)
    assertLocalContentWritable(session)
    if (session.ownershipState !== 'local_provisional' || session.clockState !== 'paused') {
      throw new Error('provisional_session_not_paused')
    }
    return this.withLocalOwner(session, (current, { operation }) =>
      this.persistProvisionalClock(current, {
        ...current, ...this.clockAt(current, occurredAt),
        sessionRevision: current.sessionRevision + 1,
        pauseStartedAt: null, clockState: 'running', updatedAt: occurredAt,
      }, operation))
  }

  async endProvisional(sessionId: string, input: {
    occurredAt: string; timerCompletion: TimerCompletion;
  }): Promise<CachedFocusSession> {
    const session = await this.requireSession(sessionId)
    assertLocalContentWritable(session)
    if (session.ownershipState !== 'local_provisional' || session.clockState === 'ended') {
      throw new Error('provisional_session_not_active')
    }
    return this.withLocalOwner(session, async (current, { operation }) => {
      const next = await this.persistProvisionalClock(current, {
        ...current, ...this.clockAt(current, input.occurredAt),
        sessionRevision: current.sessionRevision + 1,
        endedAt: input.occurredAt, pauseStartedAt: null, clockState: 'ended',
        timerCompletion: input.timerCompletion, validity: 'pending', reviewState: 'pending',
        updatedAt: input.occurredAt,
      }, operation)
      await this.meta.provisionalOperations.update(operation.operationId, {
        state: 'awaiting_s4', updatedAt: input.occurredAt,
      })
      return next
    })
  }

  async setCurrentPlanItem(sessionId: string, workItemId: string | null): Promise<void> {
    const session = await this.requireSession(sessionId)
    assertLocalContentWritable(session)
    const rows = await this.db.sessionWorkItemPlans.where('sessionId').equals(sessionId).toArray()
    if (workItemId !== null && !rows.some(
      (row) => row.workItemId === workItemId && row.removedAt === null,
    )) throw new Error('session_plan_item_not_found')
    if (session.ownershipState === 'authoritative') {
      await this.cacheAuthoritative(this.active.setCurrentPlanItem({
        sessionId, workItemId,
      }))
      return
    }
    const createdAt = new Date().toISOString()
    await this.withLocalOwner(session, async (_current, { operation, transportState }) => {
      const lockedRows = await this.db.sessionWorkItemPlans
        .where('sessionId').equals(sessionId).toArray()
      if (workItemId !== null && !lockedRows.some(
        (row) => row.workItemId === workItemId && row.removedAt === null,
      )) throw new Error('session_plan_item_not_found')
      await this.db.transaction('rw', this.db.sessionWorkItemPlans, this.db.outbox, async () => {
      for (const row of lockedRows) {
        const next = {
          ...row,
          currentDuringSession: row.removedAt === null && row.workItemId === workItemId,
          updatedAt: createdAt,
        }
        if (next.currentDuringSession === row.currentDuringSession) continue
        const localCreate = row.version === 0
        const payloadHash = await Dexie.waitFor(
          hashCommandPayload(localPlanCreateHashPayload(next)),
        )
        const operationId = await Dexie.waitFor(boundedChildOperationId(
          operation.operationId, `plan:${row.id}`,
        ))
        await this.db.sessionWorkItemPlans.put(next)
        await enqueueOutbox(this.db, this.spaceId, 'sessionWorkItemPlan', row.id,
          localCreate ? 'create' : 'update', serializeSessionPlanCommandPostImage(next), {
          operationId, payloadHash,
          expectedVersion: localCreate ? null : row.version,
          transportState,
          createdAt,
        })
        }
      })
    })
  }

  async updateSessionNote(sessionId: string, sessionNote: string): Promise<void> {
    const session = await this.requireSession(sessionId)
    assertLocalContentWritable(session)
    if (session.ownershipState === 'authoritative') {
      await this.cacheAuthoritative(this.active.updateSessionNote({
        sessionId, sessionNote,
      }))
      return
    }
    const createdAt = new Date().toISOString()
    await this.withLocalOwner(session, async (current, { operation, transportState }) => {
      const operationId = await boundedChildOperationId(
        operation.operationId, 'focus_session',
      )
      await this.db.transaction('rw', this.db.focusSessions, this.db.outbox, async () => {
      const next = { ...current, sessionNote, updatedAt: createdAt }
      const localCreate = current.version === 0
      const payloadHash = await Dexie.waitFor(
        hashCommandPayload(localSessionCreateHashPayload(next)),
      )
      await this.db.focusSessions.put(next)
      await enqueueOutbox(this.db, this.spaceId, 'focusSession', sessionId,
        localCreate ? 'create' : 'update',
        serializeFocusSessionCommandPostImage(next), {
          operationId, payloadHash,
          expectedVersion: localCreate ? null : current.version,
          transportState,
          createdAt,
        })
      })
    })
  }

  async setCompletionDraft(
    sessionId: string, planItemId: string, completionDraft: boolean,
  ): Promise<void> {
    const session = await this.requireSession(sessionId)
    assertLocalContentWritable(session)
    const row = await this.db.sessionWorkItemPlans.get(planItemId)
    if (!row || row.sessionId !== sessionId) throw new Error('session_plan_item_not_found')
    if (session.ownershipState === 'authoritative') {
      await this.cacheAuthoritative(this.active.setCompletionDraft({
        sessionId, planItemId, completionDraft,
      }))
      return
    }
    const createdAt = new Date().toISOString()
    await this.withLocalOwner(session, async (_current, { operation, transportState }) => {
      const lockedRow = await this.db.sessionWorkItemPlans.get(planItemId)
      if (!lockedRow || lockedRow.sessionId !== sessionId) {
        throw new Error('session_plan_item_not_found')
      }
      const next = { ...lockedRow, completionDraft, updatedAt: createdAt }
      const localCreate = lockedRow.version === 0
      const payloadHash = await hashCommandPayload(localPlanCreateHashPayload(next))
      const operationId = await boundedChildOperationId(
        operation.operationId, `plan:${lockedRow.id}`,
      )
      await this.db.transaction('rw', this.db.sessionWorkItemPlans, this.db.outbox, async () => {
        await this.db.sessionWorkItemPlans.put(next)
        await enqueueOutbox(this.db, this.spaceId, 'sessionWorkItemPlan', lockedRow.id,
          localCreate ? 'create' : 'update', serializeSessionPlanCommandPostImage(next), {
          operationId, payloadHash,
          expectedVersion: localCreate ? null : lockedRow.version,
          transportState,
          createdAt,
        })
      })
    })
  }

  async addPlanItem(
    sessionId: string, workItemId: string, planRank: number, addedAt: string,
  ): Promise<void> {
    const session = await this.requireSession(sessionId)
    assertLocalContentWritable(session)
    const context = await this.db.sessionTaskContexts.get(sessionId)
    const workItem = await this.db.workItems.get(workItemId)
    if (!context || !workItem || workItem.depth !== 3 ||
        workItem.parentId !== context.level2WorkItemId) {
      throw new Error('plan_item_must_be_same_parent_level3')
    }
    if (session.ownershipState === 'authoritative') {
      await this.cacheAuthoritative(this.active.addPlanItem({
        sessionId, workItemId, expectedWorkItemVersion: workItem.version, planRank, addedAt,
      }))
      return
    }
    await this.withLocalOwner(session, async (_current, { operation, transportState }) => {
      const lockedContext = await this.db.sessionTaskContexts.get(sessionId)
      const lockedWorkItem = await this.db.workItems.get(workItemId)
      if (!lockedContext || !lockedWorkItem || lockedWorkItem.depth !== 3 ||
          lockedWorkItem.parentId !== lockedContext.level2WorkItemId) {
        throw new Error('plan_item_must_be_same_parent_level3')
      }
      const next: CachedSessionWorkItemPlan = {
        id: crypto.randomUUID(), sessionId, workItemId, titleSnapshot: lockedWorkItem.title,
        level2WorkItemIdSnapshot: lockedContext.level2WorkItemId,
        workItemVersionSnapshot: lockedWorkItem.version, planRank, source: 'during_session',
        addedAt, removedAt: null, removalReason: null,
        currentDuringSession: false, completionDraft: false, version: 0,
        createdAt: addedAt, updatedAt: addedAt,
      }
      const payloadHash = await hashCommandPayload(localPlanCreateHashPayload(next))
      const operationId = await boundedChildOperationId(operation.operationId, `plan:${next.id}`)
      await this.db.transaction('rw', this.db.sessionWorkItemPlans, this.db.outbox, async () => {
        await this.db.sessionWorkItemPlans.add(next)
        await enqueueOutbox(
          this.db, this.spaceId, 'sessionWorkItemPlan', next.id, 'create',
          serializeSessionPlanCommandPostImage(next), {
          operationId, payloadHash, expectedVersion: null, transportState, createdAt: addedAt,
          compoundOperationId: operation.operationId, compoundOrder: 0,
        })
        await reindexUnattemptedProvisionalPlanOutbox(
          this.db, operation.operationId, sessionId,
        )
      })
    })
  }

  async removePlanItem(
    sessionId: string, planItemId: string, removedAt: string, removalReason: string,
  ): Promise<void> {
    const session = await this.requireSession(sessionId)
    assertLocalContentWritable(session)
    const row = await this.db.sessionWorkItemPlans.get(planItemId)
    if (!row || row.sessionId !== sessionId) throw new Error('session_plan_item_not_found')
    if (!removalReason.trim()) throw new Error('removalReason must be nonblank')
    if (session.ownershipState === 'authoritative') {
      await this.cacheAuthoritative(this.active.removePlanItem({
        sessionId, planItemId, removedAt, removalReason,
      }))
      return
    }
    await this.withLocalOwner(session, async (_current, { operation, transportState }) => {
      const lockedRow = await this.db.sessionWorkItemPlans.get(planItemId)
      if (!lockedRow || lockedRow.sessionId !== sessionId) {
        throw new Error('session_plan_item_not_found')
      }
      const next = {
        ...lockedRow, removedAt, removalReason, currentDuringSession: false,
        updatedAt: removedAt,
      }
      const localCreate = lockedRow.version === 0
      const payloadHash = await hashCommandPayload(localPlanCreateHashPayload(next))
      const operationId = await boundedChildOperationId(
        operation.operationId, `plan:${lockedRow.id}`,
      )
      await this.db.transaction('rw', this.db.sessionWorkItemPlans, this.db.outbox, async () => {
        await this.db.sessionWorkItemPlans.put(next)
        await enqueueOutbox(this.db, this.spaceId, 'sessionWorkItemPlan', lockedRow.id,
          localCreate ? 'create' : 'update', serializeSessionPlanCommandPostImage(next), {
          operationId, payloadHash,
          expectedVersion: localCreate ? null : lockedRow.version,
          transportState,
          createdAt: removedAt,
        })
      })
    })
  }
}
```

For outbox-backed EntityCommand rows, `payloadHash` always hashes the same
complete entity business projection that can be recomputed from the persisted
post-image: WorkItemNote uses exactly `{document}`, FocusSession uses
`localSessionCreateHashPayload`, and every Session context/attribution/plan row
uses its complete corresponding `local*HashPayload` projection for both create
and update. Partial ActiveSession REST command hashes such as
`{session_note}` or `{completion_draft}` remain Adapter-only and are never
stored as an outbox row's hash. This keeps S4 admission deterministic from
`entityType + action + postImage` without a hidden mutation-intent field.

`toSpaceRows` maps the parsed API contract through explicit cache projectors:
`aggregate.session` passes `projectFocusSessionViewToCache`, which verifies the
derived clock and maps `id -> sessionId`; each context/attribution/plan/outcome
row first verifies the same response `spaceId`, strips only that Space field,
and preserves its real `id/createdAt/updatedAt/version`. The context Dexie key is
`sessionId`, but the row's Sync identity remains `id`. `aggregate.attribution`
becomes the current attribution row and `aggregate.plan` becomes the ordered
plan-row array. It never reads retired `aggregate.attributions` or
`aggregate.plans` properties.

The ownership branch occurs before any local write. `authoritative` calls the injected Task 7 owner-gated Coordinator contract and caches its parsed aggregate; it never enqueues an ordinary S4 `EntityCommand`. Only `local_provisional` reaches `withLocalOwner`, which acquires the shared operation Web Lock, reloads the Session, and then `requireLocalOwner` verifies the exact-Space Meta operation is still `pending`, its device/Tab identity matches, and its `SessionTabRow` remains open before holding that lock through the complete Dexie transaction. Reconcile/start/resolution use the same lock, so there is no Meta-check/Space-write TOCTOU. `assertLocalContentWritable` runs both before lock acquisition and after the locked reload; `activation_conflict` returns `blocked_conflict` with zero Session, plan, command, or outbox effect, even when a resolution is concurrently in flight. The pre-conflict activation snapshot remains the only `blocked_conflict` outbox set. A version-zero provisional Session/Plan mutation replaces its still-unattempted held `create` post-image with a full explicit snake_case hash while preserving its bounded child/compound identity; it never creates an invalid `update expectedVersion=0` behind that create. `setCompletionDraft` changes only the matching `SessionWorkItemPlan`; it never writes `workItems`. Add/remove validates cached same-parent level-3 membership under the lock.

- [ ] **Step 6: Implement recoverable offline provisional start across Meta and Space Dexie**

```typescript
// frontend/src/lib/focus-session/focus-session-repository.ts
export function buildActivateProvisionalPayload(
  aggregate: LocalFocusSessionAggregate,
  operation: ProvisionalOperationRow,
): ProvisionalActivationPayload {
  if (!aggregate.context) throw new Error('provisional_context_required')
  if (aggregate.session.endedAt !== null || aggregate.session.clockState === 'ended') {
    throw new Error('terminal_provisional_requires_s4_import')
  }
  const expectedWorkItemVersions: Record<string, number> = {
    [aggregate.context.level2WorkItemId]: aggregate.context.level2VersionSnapshot,
  }
  for (const item of aggregate.plan) {
    expectedWorkItemVersions[item.workItemId] = item.workItemVersionSnapshot
  }
  return activateProvisionalPayloadSchema.parse({
    cachedAt: operation.createdAt,
    cachedOwnershipEpoch: operation.cachedOwnershipEpoch,
    ownerDeviceId: operation.deviceId,
    ownerTabId: operation.tabId,
    snapshot: {
      session: {
        sessionRevision: aggregate.session.sessionRevision,
        startedAt: aggregate.session.startedAt,
        pauseStartedAt: aggregate.session.pauseStartedAt,
        plannedSeconds: aggregate.session.plannedSeconds,
        grossSeconds: aggregate.session.grossSeconds,
        pausedSeconds: aggregate.session.pausedSeconds,
        breakSeconds: aggregate.session.breakSeconds,
        focusedSeconds: aggregate.session.focusedSeconds,
        validity: aggregate.session.validity,
        validityReason: aggregate.session.validityReason,
        reviewState: aggregate.session.reviewState,
        ownershipState: aggregate.session.ownershipState,
        sessionNote: aggregate.session.sessionNote,
      },
      context: {
        projectId: aggregate.context.projectId,
        projectTitleSnapshot: aggregate.context.projectTitleSnapshot,
        level2WorkItemId: aggregate.context.level2WorkItemId,
        level2TitleSnapshot: aggregate.context.level2TitleSnapshot,
        level2ParentIdSnapshot: aggregate.context.level2ParentIdSnapshot,
        level2StatusDefinitionIdSnapshot: aggregate.context.level2StatusDefinitionIdSnapshot,
        level2VersionSnapshot: aggregate.context.level2VersionSnapshot,
        level2EffortLowerSecondsSnapshot: aggregate.context.level2EffortLowerSecondsSnapshot,
        level2EffortUpperSecondsSnapshot: aggregate.context.level2EffortUpperSecondsSnapshot,
        linkedAt: aggregate.context.linkedAt,
        linkMethod: aggregate.context.linkMethod,
      },
      plan: aggregate.plan.map((item) => ({
        id: item.id,
        workItemId: item.workItemId,
        titleSnapshot: item.titleSnapshot,
        level2WorkItemIdSnapshot: item.level2WorkItemIdSnapshot,
        workItemVersionSnapshot: item.workItemVersionSnapshot,
        planRank: item.planRank,
        source: item.source,
        addedAt: item.addedAt,
        removedAt: item.removedAt,
        removalReason: item.removalReason,
        currentDuringSession: item.currentDuringSession,
        completionDraft: item.completionDraft,
      })),
    },
    expectedWorkItemVersions,
  })
}

// Merge these two methods into the FocusSessionRepository class defined in the
// preceding step; the class shell keeps this implementation fence executable.
export class FocusSessionRepository {
private async persistProvisionalAggregateAndOutbox(
  aggregate: LocalFocusSessionAggregate,
  operation: ProvisionalOperationRow,
): Promise<void> {
  if (!aggregate.context || aggregate.attribution.revision !== 1 ||
      !aggregate.attribution.effective ||
      aggregate.plan.some((item) => item.source === 'review_materialized')) {
    throw new Error('invalid_initial_provisional_aggregate')
  }
  const orderedPlan = [...aggregate.plan].sort((left, right) =>
    left.planRank - right.planRank || left.id.localeCompare(right.id))
  const descriptors = [
    { entityType: 'focusSession' as const, entityId: aggregate.session.sessionId,
      suffix: 'focus_session', row: aggregate.session,
      postImage: serializeFocusSessionCommandPostImage(aggregate.session),
      businessPayload: localSessionCreateHashPayload(aggregate.session) },
    { entityType: 'sessionTaskContext' as const, entityId: aggregate.context.id,
      suffix: 'session_task_context', row: aggregate.context,
      postImage: serializeSessionTaskContextCommandPostImage(aggregate.context),
      businessPayload: localContextCreateHashPayload(aggregate.context) },
    { entityType: 'sessionAttributionRevision' as const,
      entityId: aggregate.attribution.id, suffix: 'attribution:0001',
      row: aggregate.attribution,
      postImage: serializeSessionAttributionCommandPostImage(aggregate.attribution),
      businessPayload: localAttributionCreateHashPayload(aggregate.attribution) },
    ...orderedPlan.map((row) => ({
      entityType: 'sessionWorkItemPlan' as const, entityId: row.id,
      suffix: `plan:${row.id}`, row,
      postImage: serializeSessionPlanCommandPostImage(row),
      businessPayload: localPlanCreateHashPayload(row),
    })),
  ]
  const prepared = await Promise.all(descriptors.map(async (descriptor, compoundOrder) => ({
    ...descriptor, compoundOrder,
    operationId: await boundedChildOperationId(operation.operationId, descriptor.suffix),
    payloadHash: await hashCommandPayload(descriptor.businessPayload),
  })))
  if (new Set(prepared.map((item) => item.operationId)).size !== prepared.length) {
    throw new Error('duplicate_provisional_child_operation_id')
  }

  await this.db.transaction(
    'rw', this.db.focusSessions, this.db.sessionTaskContexts,
    this.db.sessionAttributionRevisions, this.db.sessionWorkItemPlans,
    this.db.outbox,
    async () => {
      for (const item of prepared) {
        await this.db.table(TS3_LOCAL_ENTITY_TO_TABLE[item.entityType]).put(item.row)
        await enqueueOutbox(
          this.db, this.spaceId, item.entityType, item.entityId, 'create', item.postImage, {
          operationId: item.operationId,
          payloadHash: item.payloadHash,
          expectedVersion: null,
          transportState: 'awaiting_s4',
          createdAt: operation.createdAt,
          compoundOperationId: operation.operationId,
          compoundOrder: item.compoundOrder,
        })
      }
    },
  )
}

async startProvisional(input: ProvisionalStartInput): Promise<LocalFocusSessionAggregate> {
  return this.provisionalLock.run(input.operationId, async () => {
    const snapshots = await this.requireCachedStartSnapshots(input)
    const cachedLocator = await this.meta.activeSessionLocator.get('active')
    const metaRow = await buildProvisionalOperationRow(
      { ...input, spaceId: this.spaceId,
        expectedWorkItemVersions: input.expectedWorkItemVersions },
      cachedLocator?.ownershipEpoch ?? null,
    )
    const claim = await this.meta.claimProvisional(metaRow)
    if (claim.disposition === 'existing') {
      return this.resumeExistingProvisionalStart(input, snapshots, claim.row)
    }
    try {
      const aggregate = buildLocalProvisionalAggregate(input, snapshots)
      await this.persistProvisionalAggregateAndOutbox(aggregate, metaRow)
      return aggregate
    } catch (error) {
      await this.meta.transaction('rw', this.meta.provisionalOperations, async () => {
        const current = await this.meta.provisionalOperations.get(metaRow.operationId)
        if (current?.intentJson === metaRow.intentJson &&
            current.payloadHash === metaRow.payloadHash &&
            current.state === 'activating') {
          await this.meta.provisionalOperations.update(metaRow.operationId, {
            state: 'pending', updatedAt: new Date().toISOString(),
          })
        }
      })
      throw error
    }
  })
}
}
```

`buildLocalProvisionalAggregate` creates complete cache rows before calling this
function. The Session uses `sessionId=input.sessionId`, `version=0`,
`createdAt=updatedAt=input.startedAt`, `overallProgress=null`, and `mood=null`.
The context receives its own stable `id` (distinct from the Dexie `sessionId`
key), `version=0`, and `createdAt=updatedAt=linkedAt`; attribution and every plan
row likewise carry their real entity `id`, version zero, and complete system
timestamps. No serializer invents these fields after the row has been written.
The descriptor `entityId` is always that real entity ID; only Dexie table lookup
uses `sessionId` for the one-to-one context.

`resumeExistingProvisionalStart` is the only same-root resume path. It reloads
the exact composite Meta row plus the complete Space aggregate/compound outbox
under the operation Web Lock. `awaiting_s4`, `conflict`, and `resolved` rows are
read-only recovery evidence and can only return their already persisted view;
they never execute `persistProvisionalAggregateAndOutbox` and never transition
to `pending`. For `pending|activating`, an exact complete aggregate returns
idempotently, a completely absent Space phase may execute the original frozen
intent once, and any partial/mismatched child set is
`provisional_start_recovery_required`. Tests inject a crash before the Space
phase, after its commit, and after every Meta state transition, then prove an
identical retry cannot rewrite a child payload or downgrade terminal evidence.

The provisional create is one ordered compound intent, not one reused command identity. It persists `focusSession -> sessionTaskContext -> effective attribution revision 1 -> plan rows sorted by (planRank, id)` with contiguous `compoundOrder`. Every entity receives its own S3-compatible bounded child ID and its own explicit snake_case business-payload hash; no activation/root hash is reused. A later unattempted version-zero merge retains the entity's child ID and compound root. Adding a provisional plan derives `plan:<stable plan id>` and atomically reindexes only unattempted plan rows by `(planRank, id)` under the operation lock; attempted/unknown rows fail closed. `prepareHeldProvisionalBatch` ignores Dexie auto IDs, validates the persisted parent-before-child order and unique caller IDs, and produces the real S4 `execute_prepared_batch` shape. The tracked integration vector runs those commands through the registered S4 entity mappers/policies and proves every create is accepted in that order.

```typescript
// frontend/src/lib/focus-session/provisional-start-recovery.ts
export async function recoverProvisionalStarts(meta: MetaDB, openSpace: OpenSpaceDatabase) {
  const pending = await meta.provisionalOperations
    .filter((row) => row.state === 'pending' || row.state === 'activating').toArray()
  for (const operation of pending) {
    const db = await openSpace(operation.spaceId)
    if (operation.state === 'activating') {
      const receipt = await db.sessionActivationApplications.get(operation.operationId)
      if (receipt) continue // ActiveSessionCoordinator verifies and completes phase two.
    }
    const session = await db.focusSessions.get(operation.sessionId)
    if (!session) {
      await meta.provisionalOperations.delete(operation.operationId)
      continue
    }
    if (session.ownershipState !== 'local_provisional') {
      throw new Error(`provisional_operation_mismatch:${operation.operationId}`)
    }
  }


}
```

The Meta row is the durable coordinator. A crash before the initial Space write releases an orphaned Meta claim. An `activating` row is never inferred from the current Session: a matching Space activation-application receipt is left for `ActiveSessionCoordinator` phase-two recovery, while missing/mismatched receipt state surfaces `activation_application_recovery_error` and preserves evidence. No cross-Dexie atomicity is claimed; the receipt makes the ordered two-phase boundary idempotently recoverable.

- [ ] **Step 7: Replace the Session stub with a repository-backed FocusSession store**

```typescript
// frontend/src/stores/focus-session-store.ts
export const useFocusSessionStore = create<FocusSessionState & FocusSessionActions>()(
  devtools((set, get) => ({
    sessions: [], selectedSessionId: null, reviewDraft: null,
    isLoading: false, error: null, repository: null,
    async hydrate(repository) {
      set({ repository, sessions: await repository.listCached(), isLoading: true })
      try {
        const sessions = await repository.refreshHistory()
        set({ sessions, isLoading: false })
      } catch (error) {
        set({ isLoading: false, error: (error as Error).message })
      }
    },
    selectSession: (selectedSessionId) => set({ selectedSessionId }),
    setReviewDraft: (reviewDraft) => set({ reviewDraft }),
    reset: () => set({
      sessions: [], selectedSessionId: null, reviewDraft: null,
      isLoading: false, error: null, repository: null,
    }),
  }), { name: 'focus-session-store' }),
)
```

- [ ] **Step 8: Run persistence, recovery, store, type, and legacy-import gates**

Run from `frontend/`:

```powershell
npm run test -- --run src/lib/focus-session/clock.test.ts src/lib/focus-session/focus-session-repository.test.ts src/lib/focus-session/provisional-operation-lock.test.ts src/lib/focus-session/provisional-start-recovery.test.ts src/stores/focus-session-store.test.ts src/stores/business-stores.test.ts
npm run typecheck
$legacy = @(& rg -n "session-store|useSessionStore" src -g "*.ts" -g "*.tsx" 2>$null)
if ($LASTEXITCODE -eq 0) { $legacy; throw "legacy session store import remains" }
if ($LASTEXITCODE -ne 1) { throw "rg failed" }
```

Expected: PASS; refresh reconstructs the same clock, the provisional operation survives the tested crash boundary, plans/Session note are locally durable, and no legacy Session store import remains.

- [ ] **Step 9: Commit FocusSession persistence and projection**

```powershell
git add -- frontend/src/lib/focus-session/clock.ts frontend/src/lib/focus-session/clock.test.ts frontend/src/lib/focus-session/focus-session-repository.ts frontend/src/lib/focus-session/focus-session-repository.test.ts frontend/src/lib/focus-session/provisional-operation-lock.ts frontend/src/lib/focus-session/provisional-operation-lock.test.ts frontend/src/lib/focus-session/provisional-start-recovery.ts frontend/src/lib/focus-session/provisional-start-recovery.test.ts frontend/src/stores/focus-session-store.ts frontend/src/stores/focus-session-store.test.ts frontend/src/stores/business-stores.test.ts
git commit -m "feat(frontend): persist focus session aggregates"
```

---

### Task 7: Add The Global ActiveSession Coordinator, Tab Ownership, Fencing, And Timestamp Timer Store

**Files:**
- Create: `frontend/src/lib/focus-session/tab-identity.ts`
- Create: `frontend/src/lib/focus-session/tab-identity.test.ts`
- Create: `frontend/src/lib/focus-session/active-session-coordinator.ts`
- Create: `frontend/src/lib/focus-session/active-session-coordinator.test.ts`
- Create: `frontend/src/lib/focus-session/active-session-provider.tsx`
- Create: `frontend/src/lib/focus-session/active-session-provider.test.tsx`
- Modify: `frontend/src/services/space-db.ts`
- Modify: `frontend/src/services/space-db.test.ts`
- Modify: `frontend/src/lib/cross-tab-sync.tsx`
- Modify: `frontend/src/stores/timer-store.ts`
- Modify: `frontend/src/stores/business-stores.test.ts`
- Modify: `frontend/src/app/providers.tsx`

**Interfaces:**
- Consumes: Task 1 `activeSessionApi`; Task 2 Meta locator/device/Tab mirrors; Task 6 `deriveSessionClock` and `OwnedActiveSessionMutations`; TS2 owner epoch and `stale_session_owner` contract.
- Produces: `getDeviceIdentity`, `openTabIdentity`, `ActiveSessionCoordinatorClient.bootstrap/heartbeat/takeover/start/pause/resume/end/updateSessionNote/setCurrentPlanItem/setCompletionDraft/addPlanItem/removePlanItem/reconcileProvisional`; `ActiveSessionProvider` plus `useActiveSessionCoordinator`/`useActiveSessionIdentity`; global `useTimerStore`; `selectDerivedClock`; BroadcastChannel owner/read-only mirrors.

- [ ] **Step 1: Write failing device, Tab, owner/read-only, and stale-fence tests**

```typescript
// frontend/src/lib/focus-session/tab-identity.test.ts
import { describe, expect, it } from 'vitest'
import { MetaDB } from '@/services/meta-database'
import { getDeviceIdentity, openTabIdentity } from './tab-identity'

it('reuses one device ID but assigns a session-scoped Tab ID', async () => {
  const meta = new MetaDB(`identity-${crypto.randomUUID()}`)
  await meta.open()
  const first = await getDeviceIdentity(meta)
  const second = await getDeviceIdentity(meta)
  expect(second).toBe(first)
  const tab = await openTabIdentity(meta, first, emptySessionStorage())
  expect(tab.deviceId).toBe(first)
  expect(await meta.sessionTabs.get(tab.tabId)).toMatchObject({ closedAt: null })
  await meta.delete()
})
```

```typescript
// frontend/src/lib/focus-session/active-session-coordinator.test.ts
it('treats a foreign Tab as read-only until explicit takeover', async () => {
  const fixture = coordinatorFixture({
    locator: locator({ ownerTabId: 'tab-owner', ownershipEpoch: 4 }),
    localTabId: 'tab-observer',
  })
  await fixture.coordinator.bootstrap()
  expect(fixture.timerState().ownershipMode).toBe('read_only')
  expect(fixture.api.pause).not.toHaveBeenCalled()
  await expect(fixture.coordinator.updateSessionNote({
    sessionId: 'fs-1', sessionNote: 'Observer write',
  })).rejects.toThrow('active_session_not_owned')
  expect(fixture.api.updateNote).not.toHaveBeenCalled()

  await fixture.coordinator.takeover()
  expect(fixture.api.takeover).toHaveBeenCalledWith(expect.objectContaining({ ownershipEpoch: 4 }))
  expect(fixture.timerState()).toMatchObject({ ownershipMode: 'owner', ownershipEpoch: 5 })
})

it('fences itself and refreshes when the server rejects a stale epoch', async () => {
  const fixture = coordinatorFixture({ locator: locator({ ownershipEpoch: 7 }) })
  fixture.api.pause.mockRejectedValue(appError('stale_session_owner'))
  await expect(fixture.coordinator.pause('2026-07-15T08:10:00Z')).rejects.toThrow()
  expect(fixture.timerState().ownershipMode).toBe('read_only')
  expect(fixture.api.locate).toHaveBeenCalledTimes(2)
})

it('uses BroadcastChannel only for invalidation and never forwards a write command', async () => {
  const fixture = coordinatorFixture({
    locator: locator({ ownerTabId: 'tab-owner', ownershipEpoch: 9 }),
    localTabId: 'tab-observer',
  })
  await fixture.coordinator.bootstrap()
  fixture.deliverBroadcast({ type: 'locator-changed', epoch: 9 })
  await fixture.settled()
  expect(fixture.api.locate).toHaveBeenCalledTimes(2)
  expect(fixture.api.pause).not.toHaveBeenCalled()
  expect(fixture.api.heartbeat).not.toHaveBeenCalled()
})

it.each(['pause', 'resume', 'end'] as const)(
  'includes current owner proof on %s', async (action) => {
    const fixture = coordinatorFixture({
      locator: locator({
        ownerDeviceId: 'device-local', ownerTabId: 'tab-local', ownershipEpoch: 6,
      }),
      localDeviceId: 'device-local', localTabId: 'tab-local',
    })
    if (action === 'pause') await fixture.coordinator.pause('2026-07-15T08:10:00Z')
    if (action === 'resume') await fixture.coordinator.resume('2026-07-15T08:10:00Z')
    if (action === 'end') await fixture.coordinator.end({
      occurredAt: '2026-07-15T08:10:00Z', timerCompletion: 'ended_early',
      validity: 'pending', validityReason: null,
    })
    expect(fixture.api[action]).toHaveBeenCalledWith(expect.objectContaining({
      ownerDeviceId: 'device-local', ownerTabId: 'tab-local', ownershipEpoch: 6,
    }))
  },
)

it('retries one heartbeat intent and preserves a newer Session aggregate', async () => {
  const fixture = coordinatorFixture({
    locator: locator({ ownershipEpoch: 6, sessionVersion: 1 }),
  })
  fixture.api.heartbeat
    .mockRejectedValueOnce(networkTimeout())
    .mockResolvedValueOnce(locatorOnly({
      operationId: 'heartbeat-server-result', ownershipEpoch: 6,
      leaseExpiresAt: '2026-07-15T08:03:00Z',
    }))
  await expect(fixture.coordinator.heartbeat()).rejects.toThrow()

  fixture.api.updateNote.mockResolvedValue(locator({
    ownershipEpoch: 6, sessionVersion: 2, sessionNote: 'Newer content',
  }))
  await fixture.coordinator.updateSessionNote({ sessionId: 'fs-1', sessionNote: 'Newer content' })
  fixture.api.locate.mockResolvedValue(locator({
    ownershipEpoch: 6, sessionVersion: 2, sessionNote: 'Newer content',
  }))
  await expect(fixture.coordinator.heartbeat()).rejects.toThrow('stale_active_session_response')

  const [first, retry] = fixture.api.heartbeat.mock.calls.map(([input]) => input)
  expect(retry).toMatchObject({
    operationId: first!.operationId, heartbeatAt: first!.heartbeatAt,
  })
  expect(fixture.timerState().locator!.session.session).toMatchObject({
    version: 2, sessionNote: 'Newer content',
  })
  expect(fixture.api.locate).toHaveBeenCalled()
  expect(await fixture.meta.activeSessionLocator.get('active')).not.toHaveProperty('session')
})

it('does not let an in-flight old-epoch heartbeat undo takeover', async () => {
  const pendingHeartbeat = deferred<ActiveSessionLocatorView>()
  const fixture = coordinatorFixture({ locator: locator({ ownershipEpoch: 4 }) })
  fixture.api.heartbeat.mockReturnValueOnce(pendingHeartbeat.promise)
  const heartbeat = fixture.coordinator.heartbeat()
  await fixture.apiCallStarted('heartbeat')
  fixture.api.takeover.mockResolvedValue(locator({
    ownershipEpoch: 5, ownerDeviceId: 'device-local', ownerTabId: 'tab-local',
  }))
  await fixture.coordinator.takeover()
  fixture.api.locate.mockResolvedValue(locator({
    ownershipEpoch: 5, ownerDeviceId: 'device-local', ownerTabId: 'tab-local',
  }))
  pendingHeartbeat.resolve(locatorOnly({ ownershipEpoch: 4 }))
  await expect(heartbeat).rejects.toThrow('stale_active_session_response')
  expect(fixture.timerState().ownershipEpoch).toBe(5)
  expect(fixture.api.locate).toHaveBeenCalled()
})

it('rejects same-epoch responses with older Session or plan versions', async () => {
  const fixture = coordinatorFixture({
    locator: locator({ ownershipEpoch: 4, sessionVersion: 5, planVersion: 7 }),
  })
  fixture.api.updateNote.mockResolvedValue(locator({
    ownershipEpoch: 4, sessionVersion: 4, planVersion: 6,
  }))
  fixture.api.locate.mockResolvedValue(locator({
    ownershipEpoch: 4, sessionVersion: 5, planVersion: 7,
  }))
  await expect(fixture.coordinator.updateSessionNote({
    sessionId: 'fs-1', sessionNote: 'Stale response',
  })).rejects.toThrow('stale_active_session_response')
  expect(fixture.timerState().locator!.session.session.version).toBe(5)
  expect(fixture.timerState().locator!.session.plan[0]!.version).toBe(7)
})

it('never lets delayed end clear a different live Session', async () => {
  const delayedEnd = deferred<TerminalActiveSessionResponse>()
  const fixture = coordinatorFixture({ locator: locator({ sessionId: 'fs-old', ownershipEpoch: 4 }) })
  fixture.api.end.mockReturnValueOnce(delayedEnd.promise)
  const ending = fixture.coordinator.end({
    occurredAt: '2026-07-15T08:10:00Z', timerCompletion: 'ended_early',
    validity: 'pending', validityReason: null,
  })
  await fixture.apiCallStarted('end')
  fixture.installLive(locator({ sessionId: 'fs-new', ownershipEpoch: 1 }))
  fixture.api.locate.mockResolvedValue(locator({ sessionId: 'fs-new', ownershipEpoch: 1 }))
  delayedEnd.resolve(terminalResult({ sessionId: 'fs-old', version: 5 }))
  await expect(ending).rejects.toThrow('stale_active_session_response')
  expect(fixture.timerState().locator?.sessionId).toBe('fs-new')
})

it('does not let an older locate-null response clear a newly started Session', async () => {
  const delayedLocate = deferred<null>()
  const fixture = coordinatorFixture({ locator: null })
  fixture.api.locate.mockReturnValueOnce(delayedLocate.promise)
  const refresh = fixture.coordinator.refresh()
  fixture.api.start.mockImplementation(async (input) => locator({
    sessionId: input.sessionId, spaceId: input.spaceId,
    operationId: input.operationId, ownerDeviceId: input.ownerDeviceId,
    ownerTabId: input.ownerTabId, ownershipEpoch: 1,
  }))
  await fixture.coordinator.start(startInput({ sessionId: 'fs-new', spaceId: 'space-b' }))
  delayedLocate.resolve(null)
  await refresh
  expect(fixture.timerState().locator).toMatchObject({
    spaceId: 'space-b', sessionId: 'fs-new', ownershipEpoch: 1,
  })
  expect(await fixture.meta.activeSessionLocator.get('active')).toMatchObject({
    spaceId: 'space-b', sessionId: 'fs-new',
  })
})
```

- [ ] **Step 2: Write failing timer-store no-tick-persistence and one-active tests**

```typescript
// append to frontend/src/stores/business-stores.test.ts
it('timer-store derives remaining time and refuses a second active Session', () => {
  useTimerStore.getState().installLocator(locatorWithSession({
    sessionId: 'fs-1', startedAt: '2026-07-15T08:00:00Z', plannedSeconds: 1500,
  }), ownerIdentity())
  useTimerStore.getState().setNow(Date.parse('2026-07-15T08:05:00Z'))
  expect(selectDerivedClock(useTimerStore.getState()).remainingSeconds).toBe(1200)
  expect(() => useTimerStore.getState().assertCanStart('space-b')).toThrow('active_session_exists')
  expect(Object.keys(useTimerStore.getState())).not.toContain('tick')
})
```

- [ ] **Step 3: Run ownership tests and verify the red state**

Run from `frontend/`:

```powershell
npm run test -- --run src/lib/focus-session/tab-identity.test.ts src/lib/focus-session/active-session-coordinator.test.ts src/lib/focus-session/active-session-provider.test.tsx src/stores/business-stores.test.ts
```

Expected: FAIL because the identities, coordinator, provider, and rewritten timer store do not exist.

- [ ] **Step 4: Implement stable device identity and session-scoped Tab registration**

```typescript
// frontend/src/lib/focus-session/tab-identity.ts
const TAB_KEY = 'pxii:focus-session-tab-id'

export async function getDeviceIdentity(meta: MetaDB): Promise<string> {
  const existing = await meta.deviceIdentity.get('device')
  if (existing) return existing.deviceId
  const created = { key: 'device' as const, deviceId: crypto.randomUUID(), createdAt: new Date().toISOString() }
  await meta.deviceIdentity.add(created)
  return created.deviceId
}

export async function openTabIdentity(
  meta: MetaDB, deviceId: string, storage: Pick<Storage, 'getItem' | 'setItem'> = sessionStorage,
): Promise<TabIdentity> {
  let tabId = storage.getItem(TAB_KEY)
  if (!tabId) {
    tabId = crypto.randomUUID()
    storage.setItem(TAB_KEY, tabId)
  }
  const now = new Date().toISOString()
  await meta.sessionTabs.put({ tabId, deviceId, openedAt: now, lastSeenAt: now, closedAt: null })
  return { deviceId, tabId }
}
```

`closeTabIdentity` records `closedAt` on `pagehide`; heartbeat updates `lastSeenAt`. A closed/stale mirror never grants ownership by itself because the server epoch remains authoritative.

- [ ] **Step 5: Rewrite timer-store as the application-global locator projection**

```typescript
// frontend/src/stores/timer-store.ts
import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import { deriveSessionClock } from '@/lib/focus-session/clock'

export type OwnershipMode = 'none' | 'owner' | 'read_only' | 'conflict'

interface TimerState {
  locator: ActiveSessionView | null
  session: FocusSessionView | null
  ownershipMode: OwnershipMode
  ownershipEpoch: number | null
  deviceId: string | null
  tabId: string | null
  nowMs: number
  error: string | null
}

const initial: TimerState = {
  locator: null, session: null, ownershipMode: 'none', ownershipEpoch: null,
  deviceId: null, tabId: null, nowMs: Date.now(), error: null,
}

export const useTimerStore = create<TimerState & TimerActions>()(
  devtools((set, get) => ({
    ...initial,
    installLocator(locator, identity) {
      set({
        locator, session: locator?.session.session ?? null,
        ownershipEpoch: locator?.ownershipEpoch ?? null,
        deviceId: identity.deviceId, tabId: identity.tabId,
        ownershipMode: !locator ? 'none' :
          locator.ownerDeviceId === identity.deviceId && locator.ownerTabId === identity.tabId
            ? 'owner' : 'read_only',
      })
    },
    setNow: (nowMs) => set({ nowMs }),
    fence: (error) => set({ ownershipMode: 'read_only', error }),
    assertCanStart(spaceId) {
      const locator = get().locator
      if (locator) throw new Error(`active_session_exists:${locator.spaceId}:${spaceId}`)
    },
    reset: () => set(initial),
  }), { name: 'timer-store' }),
)

export const selectDerivedClock = (state: TimerState) =>
  state.session ? deriveSessionClock(state.session, state.nowMs) : null
```

The store has no `remaining`, `duration`, `status`, persisted interval counter, or local `tick()` mutation. `setNow` is repaint input only.

- [ ] **Step 6: Implement global Adapter coordination and stale-owner fencing**

```typescript
// append to frontend/src/services/space-db.ts
export async function withDetachedSpaceDatabase<T>(
  spaceId: string, action: (database: PomodoroXIDB) => Promise<T>,
): Promise<T> {
  const database = await openPomodoroXIDB(spaceId)
  try {
    return await action(database)
  } finally {
    database.close()
  }
}
```

This helper opens local IndexedDB by locator-derived Space identity without changing `spaceDBManager.current`, current tokens, Zustand Space state, or dispatching a Space event. Tests prove the current proxy still points at the user-selected Space before, during, and after the callback.

```typescript
// frontend/src/lib/focus-session/active-session-coordinator.ts
import { isAxiosError } from 'axios'

interface IssuedLocatorWrite {
  sequence: number
  operationId: string
  spaceId: string
  sessionId: string
  ownershipEpoch: number
  ownerDeviceId: string
  ownerTabId: string
}
interface IssuedStartWrite {
  sequence: number
  operationId: string
  spaceId: string
  sessionId: string
  ownerDeviceId: string
  ownerTabId: string
}

const activeFromLocated = (
  response: LocatedActiveSessionResponse | null,
): ActiveSessionView | null => response?.kind === 'activation_conflict'
  ? response.active : response

export class ActiveSessionCoordinatorClient {
  private readonly channel = new BroadcastChannel('pxii:active-session')
  private heartbeatHandle: ReturnType<typeof setInterval> | null = null
  private pendingHeartbeat: {
    operationId: string; heartbeatAt: string; issued: IssuedLocatorWrite;
  } | null = null
  private nextWriteSequence = 0
  private latestAppliedSequence = 0
  private nextRefreshSequence = 0
  private latestInstalledRefresh = 0
  private installGeneration = 0

  constructor(
    private readonly api: typeof activeSessionApi,
    private readonly meta: MetaDB,
    private readonly identity: TabIdentity,
    private readonly timer = useTimerStore,
  ) {
    this.channel.onmessage = () => { void this.refresh(false) }
  }

  async bootstrap(): Promise<void> {
    await this.installLocated(await this.api.locate(), false)
    this.startHeartbeatIfOwner()
  }

  async refresh(notifyPeers = false): Promise<void> {
    const sequence = ++this.nextRefreshSequence
    const appliedAtIssue = this.latestAppliedSequence
    const located = await this.api.locate()
    const response = activeFromLocated(located)
    if (sequence < this.latestInstalledRefresh || appliedAtIssue < this.latestAppliedSequence) return
    const live = this.timer.getState().locator
    if (response && live && (
      Date.parse(response.updatedAt) < Date.parse(live.updatedAt) ||
      (response.spaceId === live.spaceId && response.sessionId === live.sessionId && (
        response.ownershipEpoch < live.ownershipEpoch ||
        !this.aggregateIsNotOlder(response.session, live.session)
      ))
    )) return
    this.latestInstalledRefresh = sequence
    await this.installLocated(located, notifyPeers)
  }

  async start(input: Omit<GlobalStartActiveSessionRequest, 'ownerDeviceId' | 'ownerTabId'>) {
    if (!input.spaceId) throw new Error('spaceId is required for global start')
    this.timer.getState().assertCanStart(input.spaceId)
    const issued: IssuedStartWrite = {
      sequence: ++this.nextWriteSequence,
      operationId: input.operationId, spaceId: input.spaceId, sessionId: input.sessionId,
      ownerDeviceId: this.identity.deviceId, ownerTabId: this.identity.tabId,
    }
    const locator = await this.guarded(() => this.api.start({
      ...input, ownerDeviceId: this.identity.deviceId, ownerTabId: this.identity.tabId,
    }))
    await this.installStartResponse(locator, issued, true)
    return locator
  }

  async takeover(): Promise<void> {
    const locator = this.requireLocator()
    const operationId = crypto.randomUUID()
    const issued = this.captureWrite(locator, operationId)
    const next = await this.guarded(() => this.api.takeover({
      sessionId: locator.sessionId,
      ownershipEpoch: locator.ownershipEpoch, operationId,
      newOwnerDeviceId: this.identity.deviceId, newOwnerTabId: this.identity.tabId,
    }))
    await this.installTakeoverResponse(next, issued, true)
  }

  async pause(occurredAt: string): Promise<void> {
    const locator = this.requireOwnedLocator()
    const operationId = crypto.randomUUID()
    const issued = this.captureWrite(locator, operationId)
    const next = await this.guarded(() => this.api.pause({
      sessionId: locator.sessionId,
      ownershipEpoch: locator.ownershipEpoch, expectedVersion: locator.session.session.version,
      ownerDeviceId: this.identity.deviceId, ownerTabId: this.identity.tabId,
      occurredAt, operationId,
    }))
    await this.installOwnedResponse(next, issued, true)
  }

  async resume(occurredAt: string): Promise<void> {
    const locator = this.requireOwnedLocator()
    const operationId = crypto.randomUUID()
    const issued = this.captureWrite(locator, operationId)
    const next = await this.guarded(() => this.api.resume({
      sessionId: locator.sessionId,
      ownershipEpoch: locator.ownershipEpoch, expectedVersion: locator.session.session.version,
      ownerDeviceId: this.identity.deviceId, ownerTabId: this.identity.tabId,
      occurredAt, operationId,
    }))
    await this.installOwnedResponse(next, issued, true)
  }

  async heartbeat(): Promise<void> {
    const current = this.requireOwnedLocator()
    const operationId = crypto.randomUUID()
    const pending = this.pendingHeartbeat ?? {
      operationId,
      heartbeatAt: new Date().toISOString(),
      issued: this.captureWrite(current, operationId),
    }
    this.pendingHeartbeat = pending
    try {
      const locator = await this.guarded(() => this.api.heartbeat({
        sessionId: current.sessionId, ownershipEpoch: current.ownershipEpoch,
        ownerDeviceId: this.identity.deviceId, ownerTabId: this.identity.tabId,
        heartbeatAt: pending.heartbeatAt, operationId: pending.operationId,
      }))
      await this.installHeartbeat(locator, pending.issued, true)
      this.pendingHeartbeat = null
    } catch (error) {
      if (!isAxiosError(error) || error.response !== undefined) {
        this.pendingHeartbeat = null
      }
      throw error
    }
  }

  async updateSessionNote(input: {
    sessionId: string; sessionNote: string;
  }): Promise<FocusSessionAggregateView> {
    const locator = this.requireOwnedSession(input.sessionId)
    const operationId = crypto.randomUUID()
    const issued = this.captureWrite(locator, operationId)
    const next = await this.guarded(() => this.api.updateNote({
      sessionId: locator.sessionId, ownershipEpoch: locator.ownershipEpoch,
      expectedVersion: locator.session.session.version, sessionNote: input.sessionNote,
      ownerDeviceId: this.identity.deviceId, ownerTabId: this.identity.tabId,
      operationId,
    }))
    await this.installOwnedResponse(next, issued, true)
    return next.session
  }

  async setCurrentPlanItem(input: {
    sessionId: string; workItemId: string | null;
  }): Promise<FocusSessionAggregateView> {
    const locator = this.requireOwnedSession(input.sessionId)
    const expectedPlanVersions = Object.fromEntries(
      locator.session.plan.map((row) => [row.id, row.version]),
    )
    const operationId = crypto.randomUUID()
    const issued = this.captureWrite(locator, operationId)
    const next = await this.guarded(() => this.api.setCurrentPlanItem({
      sessionId: locator.sessionId, ownershipEpoch: locator.ownershipEpoch,
      workItemId: input.workItemId, expectedPlanVersions,
      ownerDeviceId: this.identity.deviceId, ownerTabId: this.identity.tabId,
      operationId,
    }))
    await this.installOwnedResponse(next, issued, true)
    return next.session
  }

  async setCompletionDraft(input: {
    sessionId: string; planItemId: string; completionDraft: boolean;
  }): Promise<FocusSessionAggregateView> {
    const locator = this.requireOwnedSession(input.sessionId)
    const plan = locator.session.plan.find((row) => row.id === input.planItemId)
    if (!plan) throw new Error('session_plan_item_not_found')
    const operationId = crypto.randomUUID()
    const issued = this.captureWrite(locator, operationId)
    const next = await this.guarded(() => this.api.setCompletionDraft({
      sessionId: locator.sessionId, ownershipEpoch: locator.ownershipEpoch,
      planItemId: input.planItemId, expectedPlanVersion: plan.version,
      completionDraft: input.completionDraft,
      ownerDeviceId: this.identity.deviceId, ownerTabId: this.identity.tabId,
      operationId,
    }))
    await this.installOwnedResponse(next, issued, true)
    return next.session
  }

  async addPlanItem(input: {
    sessionId: string; workItemId: string; expectedWorkItemVersion: number;
    planRank: number; addedAt: string;
  }): Promise<FocusSessionAggregateView> {
    const locator = this.requireOwnedSession(input.sessionId)
    const operationId = crypto.randomUUID()
    const issued = this.captureWrite(locator, operationId)
    const next = await this.guarded(() => this.api.addPlanItem({
      ...input, sessionId: locator.sessionId, ownershipEpoch: locator.ownershipEpoch,
      ownerDeviceId: this.identity.deviceId, ownerTabId: this.identity.tabId,
      operationId,
    }))
    await this.installOwnedResponse(next, issued, true)
    return next.session
  }

  async removePlanItem(input: {
    sessionId: string; planItemId: string; removedAt: string; removalReason: string;
  }): Promise<FocusSessionAggregateView> {
    const locator = this.requireOwnedSession(input.sessionId)
    const plan = locator.session.plan.find((row) => row.id === input.planItemId)
    if (!plan) throw new Error('session_plan_item_not_found')
    const operationId = crypto.randomUUID()
    const issued = this.captureWrite(locator, operationId)
    const next = await this.guarded(() => this.api.removePlanItem({
      ...input, sessionId: locator.sessionId, ownershipEpoch: locator.ownershipEpoch,
      expectedPlanVersion: plan.version,
      ownerDeviceId: this.identity.deviceId, ownerTabId: this.identity.tabId,
      operationId,
    }))
    await this.installOwnedResponse(next, issued, true)
    return next.session
  }

  async end(input: {
    occurredAt: string; timerCompletion: TimerCompletion;
    validity: 'pending' | 'valid' | 'invalid'; validityReason: string | null;
  }): Promise<FocusSessionView> {
    const locator = this.requireOwnedLocator()
    const operationId = crypto.randomUUID()
    const issued = this.captureWrite(locator, operationId)
    const result = await this.guarded(() => this.api.end({
      sessionId: locator.sessionId,
      ownershipEpoch: locator.ownershipEpoch, expectedVersion: locator.session.session.version,
      ownerDeviceId: this.identity.deviceId, ownerTabId: this.identity.tabId,
      ...input, operationId,
    }))
    await this.installEndResponse(result, issued, true)
    return result.session.session
  }

  private requireOwnedSession(sessionId: string): ActiveSessionView {
    const locator = this.requireOwnedLocator()
    if (locator.sessionId !== sessionId) throw new Error('active_session_identity_mismatch')
    return locator
  }

  private async installStartResponse(
    response: ActiveSessionView,
    issued: IssuedStartWrite,
    notifyPeers: boolean,
  ): Promise<void> {
    const live = this.timer.getState().locator
    if (issued.sequence < this.latestAppliedSequence || live !== null ||
        response.operationId !== issued.operationId ||
        response.spaceId !== issued.spaceId || response.sessionId !== issued.sessionId ||
        response.ownerDeviceId !== issued.ownerDeviceId ||
        response.ownerTabId !== issued.ownerTabId) {
      return this.rejectStaleResponse()
    }
    this.latestAppliedSequence = issued.sequence
    await this.install(response, notifyPeers)
  }

  private captureWrite(locator: ActiveSessionView, operationId: string): IssuedLocatorWrite {
    return {
      sequence: ++this.nextWriteSequence,
      operationId,
      spaceId: locator.spaceId,
      sessionId: locator.sessionId,
      ownershipEpoch: locator.ownershipEpoch,
      ownerDeviceId: locator.ownerDeviceId,
      ownerTabId: locator.ownerTabId,
    }
  }

  private async rejectStaleResponse(): Promise<never> {
    this.timer.getState().fence('stale_active_session_response')
    try { await this.refresh(false) } catch { /* retain the newer local fence */ }
    throw new Error('stale_active_session_response')
  }

  private async requireLiveFence(issued: IssuedLocatorWrite): Promise<ActiveSessionView> {
    const live = this.timer.getState().locator
    if (!live || issued.sequence < this.latestAppliedSequence ||
        live.spaceId !== issued.spaceId || live.sessionId !== issued.sessionId ||
        live.ownershipEpoch !== issued.ownershipEpoch ||
        live.ownerDeviceId !== issued.ownerDeviceId || live.ownerTabId !== issued.ownerTabId) {
      return this.rejectStaleResponse()
    }
    return live
  }

  private aggregateIsNotOlder(
    candidate: FocusSessionAggregateView,
    live: FocusSessionAggregateView,
  ): boolean {
    if (candidate.session.id !== live.session.id ||
        candidate.session.spaceId !== live.session.spaceId ||
        candidate.session.version < live.session.version) return false
    const candidatePlans = new Map(candidate.plan.map((row) => [row.id, row.version]))
    return live.plan.every((row) =>
      candidatePlans.has(row.id) && candidatePlans.get(row.id)! >= row.version)
  }

  private activeRootMatches(
    response: ActiveSessionView,
    issued: IssuedLocatorWrite,
    live: ActiveSessionView,
  ): boolean {
    return response.operationId === issued.operationId &&
      response.spaceId === issued.spaceId && response.sessionId === issued.sessionId &&
      response.ownershipEpoch === issued.ownershipEpoch &&
      response.ownerDeviceId === issued.ownerDeviceId &&
      response.ownerTabId === issued.ownerTabId &&
      Date.parse(response.updatedAt) >= Date.parse(live.updatedAt) &&
      this.aggregateIsNotOlder(response.session, live.session)
  }

  private async installOwnedResponse(
    response: ActiveSessionView,
    issued: IssuedLocatorWrite,
    notifyPeers: boolean,
  ): Promise<void> {
    const live = await this.requireLiveFence(issued)
    if (!this.activeRootMatches(response, issued, live)) {
      return this.rejectStaleResponse()
    }
    this.latestAppliedSequence = issued.sequence
    await this.install(response, notifyPeers)
  }

  private async guarded<T>(action: () => Promise<T>): Promise<T> {
    try { return await action() }
    catch (error) {
      if (getAppErrorCode(error) === 'stale_session_owner') {
        this.timer.getState().fence('stale_session_owner')
        await this.refresh(false)
      }
      throw error
    }
  }

  private async install(
    locator: ActiveSessionView | null, notifyPeers: boolean,
  ): Promise<void> {
    const generation = ++this.installGeneration
    this.timer.getState().installLocator(locator, this.identity)
    if (locator) await this.meta.activeSessionLocator.put(toMirror(locator))
    else await this.meta.activeSessionLocator.delete('active')
    if (generation !== this.installGeneration) {
      const latest = this.timer.getState().locator
      if (latest) await this.meta.activeSessionLocator.put(toMirror(latest))
      else await this.meta.activeSessionLocator.delete('active')
      return
    }
    if (notifyPeers) {
      this.channel.postMessage({ type: 'locator-changed', epoch: locator?.ownershipEpoch ?? null })
    }
  }

  private async installLocated(
    response: LocatedActiveSessionResponse | null,
    notifyPeers: boolean,
  ): Promise<void> {
    await this.install(activeFromLocated(response), notifyPeers)
  }

  private async installHeartbeat(
    patch: ActiveSessionLocatorView,
    issued: IssuedLocatorWrite,
    notifyPeers: boolean,
  ): Promise<void> {
    const live = await this.requireLiveFence(issued)
    if (patch.operationId !== issued.operationId ||
        patch.spaceId !== issued.spaceId || patch.sessionId !== issued.sessionId ||
        patch.ownerDeviceId !== issued.ownerDeviceId ||
        patch.ownerTabId !== issued.ownerTabId ||
        patch.ownershipEpoch !== issued.ownershipEpoch ||
        Date.parse(patch.updatedAt) < Date.parse(live.updatedAt)) {
      return this.rejectStaleResponse()
    }
    this.latestAppliedSequence = issued.sequence
    await this.install(activeSessionSchema.parse({ ...patch, session: live.session }), notifyPeers)
  }

  private async installTakeoverResponse(
    response: ActiveSessionView,
    issued: IssuedLocatorWrite,
    notifyPeers: boolean,
  ): Promise<void> {
    const live = await this.requireLiveFence(issued)
    if (response.operationId !== issued.operationId ||
        response.spaceId !== issued.spaceId || response.sessionId !== issued.sessionId ||
        response.ownershipEpoch !== issued.ownershipEpoch + 1 ||
        response.ownerDeviceId !== this.identity.deviceId ||
        response.ownerTabId !== this.identity.tabId ||
        Date.parse(response.updatedAt) < Date.parse(live.updatedAt) ||
        !this.aggregateIsNotOlder(response.session, live.session)) {
      return this.rejectStaleResponse()
    }
    this.latestAppliedSequence = issued.sequence
    await this.install(response, notifyPeers)
  }

  private async installEndResponse(
    response: TerminalActiveSessionResponse,
    issued: IssuedLocatorWrite,
    notifyPeers: boolean,
  ): Promise<void> {
    let live = await this.requireLiveFence(issued)
    if (response.locator !== null || !this.aggregateIsNotOlder(response.session, live.session)) {
      return this.rejectStaleResponse()
    }
    await withDetachedSpaceDatabase(issued.spaceId, (db) =>
      cacheFocusSession(db, issued.spaceId, response.session))
    live = await this.requireLiveFence(issued)
    if (response.session.session.id !== live.sessionId ||
        response.session.session.version < live.session.session.version) {
      return this.rejectStaleResponse()
    }
    this.latestAppliedSequence = issued.sequence
    await this.install(null, notifyPeers)
  }
}
```

`requireOwnedLocator` checks both the local Tab identity and latest installed positive `ownershipEpoch` before heartbeat, pause, resume, end, Session-note update, or any running-plan write. `requireOwnedSession` additionally rejects a repository/session identity mismatch. Every request captures Space, Session, epoch, owner, operation ID, and a monotonically increasing client sequence. After `await`, `installOwnedResponse` rejects a changed live fence, mismatched/older operation response, lower Session version, or lower/missing Plan version; rejection sets `stale_active_session_response` and refreshes instead of installing. Takeover alone accepts exactly epoch+1 and the requested new owner. End validates the captured live fence both before and after detached terminal caching, so delayed `{ locator: null }` can never clear a different Session.

Heartbeat is the one locator-only success response: `installHeartbeat` applies the same live-fence/operation/updated-time checks, then overlays only locator fields onto the latest installed aggregate. It never passes a locator-only object to `install`, never stores Session content in Meta, and a transport retry reuses operation ID plus `heartbeatAt`. If a Session mutation or takeover wins while that heartbeat is in flight, the old response is fenced/refreshed rather than merged. `BroadcastChannel` carries locator invalidations only; it never carries a business command, and `takeover` is the only write an observer Tab may request. No method imports `tokenStorage` or `spaceDBManager`.

`refresh` has its own request sequence, records the latest applied write at issue time, and rejects delayed null/lower-epoch/lower-version responses. `install` synchronously updates the timer projection under an install generation, then mirrors Meta; if an older async Meta write finishes after a newer install began, it repairs Meta from the latest timer locator and emits no stale broadcast. Thus generic locate/bootstrap plumbing cannot bypass write-response sequencing.

- [ ] **Step 7: Mount the coordinator once and render from persisted timestamps after refresh**

```tsx
// frontend/src/lib/focus-session/active-session-provider.tsx
'use client'

interface ActiveSessionClientContext {
  coordinator: ActiveSessionCoordinatorClient
  identity: TabIdentity
  provisionalLock: ProvisionalOperationLock
}
const ActiveSessionCoordinatorContext = createContext<ActiveSessionClientContext | null>(null)

export function useActiveSessionCoordinator(): ActiveSessionCoordinatorClient {
  const value = useContext(ActiveSessionCoordinatorContext)
  if (!value) throw new Error('active_session_coordinator_not_ready')
  return value.coordinator
}

export function useActiveSessionIdentity(): TabIdentity {
  const value = useContext(ActiveSessionCoordinatorContext)
  if (!value) throw new Error('active_session_coordinator_not_ready')
  return value.identity
}

export function ActiveSessionProvider({ children }: { children: React.ReactNode }) {
  const [mountedClient, setMountedClient] = useState<ActiveSessionClientContext | null>(null)
  useEffect(() => {
    let coordinator: ActiveSessionCoordinatorClient | null = null
    let frame = 0
    let cancelled = false
    void (async () => {
      const deviceId = await getDeviceIdentity(metaDB)
      const identity = await openTabIdentity(metaDB, deviceId)
      if (cancelled) return
      const provisionalLock = new BrowserProvisionalOperationLock()
      coordinator = new ActiveSessionCoordinatorClient(
        activeSessionApi, metaDB, identity, provisionalLock,
      )
      await coordinator.bootstrap()
      setMountedClient({ coordinator, identity, provisionalLock })
      const repaint = () => {
        useTimerStore.getState().setNow(Date.now())
        frame = window.setTimeout(repaint, 250) as unknown as number
      }
      repaint()
    })()
    return () => {
      cancelled = true
      window.clearTimeout(frame)
      coordinator?.destroy()
      setMountedClient(null)
    }
  }, [])
  return (
    <ActiveSessionCoordinatorContext.Provider value={mountedClient}>
      {children}
    </ActiveSessionCoordinatorContext.Provider>
  )
}
```

Wrap `SpaceSwitchProvider` with one `ActiveSessionProvider` in `app/providers.tsx`. Extend the existing cross-Tab provider to route only invalidation messages; business writes remain in the owning coordinator.

- [ ] **Step 8: Run owner, provider, store, type, and token-boundary gates**

Run from `frontend/`:

```powershell
npm run test -- --run src/lib/focus-session/tab-identity.test.ts src/lib/focus-session/active-session-coordinator.test.ts src/lib/focus-session/active-session-provider.test.tsx src/stores/business-stores.test.ts
npm run typecheck
$forbidden = @(& rg -n "tokenStorage|setSpaceToken|setCurrentSpaceId|spaceDBManager\.switchTo" src/lib/focus-session/active-session-coordinator.ts src/services/active-session-api.ts 2>$null)
if ($LASTEXITCODE -eq 0) { $forbidden; throw "global active-session path switches current Space" }
if ($LASTEXITCODE -ne 1) { throw "rg failed" }
```

Expected: PASS; observer Tabs are read-only, takeover advances the epoch, stale owners self-fence, refresh reconstructs from timestamps, and the global path never changes current-Space credentials.

- [ ] **Step 9: Commit global active ownership and timer projection**

```powershell
git add -- frontend/src/lib/focus-session/tab-identity.ts frontend/src/lib/focus-session/tab-identity.test.ts frontend/src/lib/focus-session/active-session-coordinator.ts frontend/src/lib/focus-session/active-session-coordinator.test.ts frontend/src/lib/focus-session/active-session-provider.tsx frontend/src/lib/focus-session/active-session-provider.test.tsx frontend/src/services/space-db.ts frontend/src/services/space-db.test.ts frontend/src/lib/cross-tab-sync.tsx frontend/src/stores/timer-store.ts frontend/src/stores/business-stores.test.ts frontend/src/app/providers.tsx
git commit -m "feat(frontend): coordinate one active focus session"
```

---

### Task 8: Build The Session Launcher, Running Timer, Plan Workspace, And Compact Note Editor

**Files:**
- Create: `frontend/src/components/timer/session-launcher.tsx`
- Create: `frontend/src/components/timer/session-launcher.test.tsx`
- Create: `frontend/src/components/timer/session-clock.tsx`
- Create: `frontend/src/components/timer/session-clock.test.tsx`
- Create: `frontend/src/components/timer/session-workspace.tsx`
- Create: `frontend/src/components/timer/session-workspace.test.tsx`
- Create: `frontend/src/components/timer/focused-work-item-note.tsx`
- Create: `frontend/src/components/timer/focused-work-item-note.test.tsx`
- Create: `frontend/src/lib/critical-draft-registry.ts`
- Create: `frontend/src/lib/critical-draft-registry.test.ts`
- Create: `frontend/src/lib/task-space/timer-note-composer-draft-registry.ts`
- Create: `frontend/src/lib/task-space/timer-note-composer-draft-registry.test.ts`
- Modify: `frontend/src/app/(app)/timer/page.tsx`
- Modify: `frontend/src/stores/timer-store.ts`
- Modify: `frontend/src/lib/focus-session/active-session-coordinator.ts`

**Interfaces:**
- Consumes: Task 2 `timerNoteComposerDrafts`; Task 4 selected WorkItem tree; Task 5 Note editor/repository/autosave; Task 6 Session repository; Task 7 coordinator/timer projection.
- Produces: level-aware `SessionLauncher`; immediate local-provisional timer projection; ownership-branched pause/resume/end controls; owner-aware `SessionClock`; `SessionWorkspace` for same-parent L3 add/remove/current item/completion draft/Session note through the ownership-branched repository; read-only existing WorkItemNote preview plus a Space/WorkItem-bound durable append-only paragraph/Checklist composer; real `/timer` page.

- [ ] **Step 1: Write failing launch-rule and empty-plan tests**

```typescript
// frontend/src/components/timer/session-launcher.test.tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

it('maps a level-3 start to its level-2 parent and freezes the selected level 3', async () => {
  const start = vi.fn().mockResolvedValue(undefined)
  render(<SessionLauncher items={threeLevelFixture()} initialWorkItemId="l3" onStart={start} />)
  fireEvent.click(screen.getByRole('button', { name: 'Start focus session' }))
  expect(start).toHaveBeenCalledWith(expect.objectContaining({
    level2WorkItemId: 'l2', level3WorkItemIds: ['l3'],
  }))
})

it('allows a level-2 Session with no level-3 plan', async () => {
  const start = vi.fn().mockResolvedValue(undefined)
  render(<SessionLauncher items={threeLevelFixture()} initialWorkItemId="l2" onStart={start} />)
  fireEvent.click(screen.getByRole('button', { name: 'Start focus session' }))
  expect(start).toHaveBeenCalledWith(expect.objectContaining({ level3WorkItemIds: [] }))
})

it('requires selecting or creating a level-2 child for a level-1 start', () => {
  render(<SessionLauncher items={threeLevelFixture()} initialWorkItemId="l1" onStart={vi.fn()} />)
  expect(screen.getByRole('button', { name: 'Start focus session' })).toBeDisabled()
  expect(screen.getByLabelText('Level 2 attribution')).toBeRequired()
})
```

- [ ] **Step 2: Write failing current-item, compact-Note, and time-preservation tests**

```typescript
// frontend/src/components/timer/session-workspace.test.tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

it('switches current level 3 without reallocating Session minutes', () => {
  const setCurrent = vi.fn()
  const allocate = vi.fn()
  render(<SessionWorkspace session={runningSession()} plans={twoPlans()}
    onSetCurrent={setCurrent} onAllocateMinutes={allocate} />)
  fireEvent.click(screen.getByRole('button', { name: 'Work on Verify output' }))
  expect(setCurrent).toHaveBeenCalledWith('l3-b')
  expect(allocate).not.toHaveBeenCalled()
})

it('keeps Session note separate from WorkItemNote', () => {
  const updateSessionNote = vi.fn()
  const updateWorkItemNote = vi.fn()
  render(<SessionWorkspace session={runningSession()} plans={twoPlans()}
    onUpdateSessionNote={updateSessionNote} onUpdateWorkItemNote={updateWorkItemNote} />)
  fireEvent.change(screen.getByLabelText('Session note'), { target: { value: 'Felt focused' } })
  expect(updateSessionNote).toHaveBeenCalledWith('Felt focused')
  expect(updateWorkItemNote).not.toHaveBeenCalled()
})
```

```typescript
// frontend/src/components/timer/focused-work-item-note.test.tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

it('allows Timer WorkItemNote interaction only through paragraph/checklist append', () => {
  const append = vi.fn()
  render(<FocusedWorkItemNote note={paragraphAndChecklistNote()}
    spaceId="space-a" workItemId="wi-a" draftRegistry={memoryTimerDraftRegistry()}
    onAppendBlocks={append} onFlush={vi.fn()} />)
  expect(screen.queryByRole('textbox', { name: /existing paragraph/i })).toBeNull()
  expect(screen.queryByRole('checkbox', { name: /existing checklist/i })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Checklist' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'New checklist item 1' }), {
    target: { value: 'Verify output' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Add child under Verify output' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Child of Verify output' }), {
    target: { value: 'Record evidence' },
  })
  expect(append).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Append checklist' }))
  expect(append).toHaveBeenCalledWith('wi-a', [
    expect.objectContaining({
      type: 'checklist', blockId: expect.any(String),
      items: [expect.objectContaining({
        text: 'Verify output', checked: false,
        children: [expect.objectContaining({ text: 'Record evidence', checked: false })],
      })],
    }),
  ])
})

it('appends a nonempty paragraph only after explicit submit and clears the draft', async () => {
  const append = vi.fn().mockResolvedValue(undefined)
  render(<FocusedWorkItemNote note={paragraphAndChecklistNote()}
    spaceId="space-a" workItemId="wi-a" draftRegistry={memoryTimerDraftRegistry()}
    onAppendBlocks={append} onFlush={vi.fn()} />)
  const draft = screen.getByRole('textbox', { name: 'New paragraph' })
  expect(screen.getByRole('button', { name: 'Append paragraph' })).toBeDisabled()
  fireEvent.change(draft, { target: { value: 'Investigate retry ordering' } })
  fireEvent.click(screen.getByRole('button', { name: 'Append paragraph' }))
  await waitFor(() => expect(append).toHaveBeenCalledWith('wi-a', [
    expect.objectContaining({ type: 'paragraph', text: 'Investigate retry ordering' }),
  ]))
  expect(draft).toHaveValue('')
})

it('retains the composer draft when append fails', async () => {
  const append = vi.fn().mockRejectedValue(new Error('offline append failed'))
  render(<FocusedWorkItemNote note={paragraphAndChecklistNote()}
    spaceId="space-a" workItemId="wi-a" draftRegistry={memoryTimerDraftRegistry()}
    onAppendBlocks={append} onFlush={vi.fn()} />)
  const draft = screen.getByRole('textbox', { name: 'New paragraph' })
  fireEvent.change(draft, { target: { value: 'Keep this draft' } })
  fireEvent.click(screen.getByRole('button', { name: 'Append paragraph' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('offline append failed')
  expect(draft).toHaveValue('Keep this draft')
})
```

```typescript
// frontend/src/lib/task-space/timer-note-composer-draft-registry.test.ts
it('flushes a structured composer draft and restores it after reopen', async () => {
  const fixture = await timerComposerDraftFixture('space-a', 'wi-a')
  await fixture.controller.update(paragraphComposerDraft('Keep across switch'))
  await fixture.registry.flushDatabase(fixture.db, 'space-switch')
  const reopened = await fixture.reopen('space-a', 'wi-a')
  expect(await reopened.controller.hydrate()).toEqual(
    paragraphComposerDraft('Keep across switch'),
  )
})

it('persists A before hydrating B and never appends A content to B', async () => {
  const fixture = await timerComposerDraftFixture('space-a', 'wi-a')
  await fixture.controller.update(paragraphComposerDraft('Draft A'))
  await fixture.controller.switchTo({ spaceId: 'space-a', workItemId: 'wi-b' })
  await fixture.controller.update(paragraphComposerDraft('Draft B'))
  await fixture.controller.switchTo({ spaceId: 'space-a', workItemId: 'wi-a' })
  expect(fixture.controller.currentDraft()).toEqual(paragraphComposerDraft('Draft A'))
  await fixture.controller.appendExplicitly()
  expect(fixture.append).toHaveBeenCalledWith('wi-a', [
    expect.objectContaining({ type: 'paragraph', text: 'Draft A' }),
  ], expect.any(String))
  expect(fixture.append).not.toHaveBeenCalledWith('wi-b', expect.anything())
})

it('clears only after append succeeds and retains the exact structured draft on failure', async () => {
  const fixture = await timerComposerDraftFixture('space-a', 'wi-a')
  const draft = checklistComposerDraft('Verify', 'Record evidence')
  await fixture.controller.update(draft)
  fixture.append.mockRejectedValueOnce(new Error('offline append failed'))
  await expect(fixture.controller.appendExplicitly()).rejects.toThrow('offline append failed')
  expect(await fixture.controller.hydrate()).toEqual(draft)
  fixture.append.mockResolvedValueOnce(undefined)
  await fixture.controller.appendExplicitly()
  expect(await fixture.db.timerNoteComposerDrafts.get(['space-a', 'wi-a'])).toBeUndefined()
})

it('does not replay a committed append when local draft cleanup fails', async () => {
  const fixture = await timerComposerDraftFixture('space-a', 'wi-a', {
    failFirstDraftDeleteAfterAppend: true,
  })
  await fixture.controller.update(paragraphComposerDraft('Append once'))
  await expect(fixture.controller.appendExplicitly())
    .rejects.toThrow('injected_draft_delete_failure')
  const held = await fixture.db.timerNoteComposerDrafts.get(['space-a', 'wi-a'])
  expect(held).toMatchObject({
    appendState: 'committed', appendOperationId: expect.any(String),
  })

  const reopened = await fixture.reopen('space-a', 'wi-a')
  await reopened.controller.hydrate()
  expect(reopened.append).not.toHaveBeenCalled()
  expect(await reopened.db.timerNoteComposerDrafts.get(['space-a', 'wi-a']))
    .toBeUndefined()
  expect(await reopened.noteContainsBlock(JSON.parse(held!.submittedBlockJson!).blockId))
    .toBe(true)
})
```

```typescript
// append to frontend/src/components/timer/session-workspace.test.tsx
it('exposes current, completion-draft, add, and remove as distinct plan commands', () => {
  const actions = {
    onSetCurrent: vi.fn(), onSetCompletionDraft: vi.fn(),
    onAddPlanItem: vi.fn(), onRemovePlanItem: vi.fn(),
  }
  render(<SessionWorkspace session={runningSession()} plans={twoPlans()}
    availableLevel3={sameParentCandidates()} {...actions} />)
  fireEvent.click(screen.getByRole('radio', { name: 'Work on Verify output' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Mark Build output complete' }))
  fireEvent.click(screen.getByRole('button', { name: 'Add Test output to plan' }))
  fireEvent.click(screen.getByRole('button', { name: 'Remove Build output from plan' }))
  expect(actions.onSetCurrent).toHaveBeenCalledWith('l3-b')
  expect(actions.onSetCompletionDraft).toHaveBeenCalledWith('plan-a', true)
  expect(actions.onAddPlanItem).toHaveBeenCalledWith('l3-c')
  expect(actions.onRemovePlanItem).toHaveBeenCalledWith('plan-a')
})
```

```typescript
// frontend/src/components/timer/session-clock.test.tsx
it('persists terminal clock facts even when Note flush rejects', async () => {
  const flushNote = vi.fn().mockRejectedValue(new Error('note conflict'))
  const end = vi.fn().mockResolvedValue(endedSession())
  render(<SessionClock clock={runningClock()} owner onFlushNote={flushNote} onEnd={end} />)
  fireEvent.click(screen.getByRole('button', { name: 'End session' }))
  await screen.findByText('Session ended; note needs attention')
  expect(end).toHaveBeenCalledOnce()
})

it('installs an offline start immediately and routes its controls only to the repository', async () => {
  const fixture = timerPageFixture({ online: false })
  await fixture.start(launchSelection())
  expect(fixture.timerState().localProvisional?.session).toMatchObject({
    sessionId: expect.any(String), ownershipState: 'local_provisional', clockState: 'running',
  })
  await fixture.controls.pause('2026-07-15T08:05:00Z')
  await fixture.controls.resume('2026-07-15T08:06:00Z')
  await fixture.controls.end('2026-07-15T08:10:00Z')
  expect(fixture.repository.pauseProvisional).toHaveBeenCalledOnce()
  expect(fixture.repository.resumeProvisional).toHaveBeenCalledOnce()
  expect(fixture.repository.endProvisional).toHaveBeenCalledOnce()
  expect(fixture.coordinator.pause).not.toHaveBeenCalled()
  expect(fixture.coordinator.resume).not.toHaveBeenCalled()
  expect(fixture.coordinator.end).not.toHaveBeenCalled()
  expect(fixture.timerState().localProvisional?.session.clockState).toBe('ended')
})

it('routes authoritative controls only to the Master coordinator', async () => {
  const fixture = timerPageFixture({ ownershipState: 'authoritative' })
  await fixture.controls.pause('2026-07-15T08:05:00Z')
  expect(fixture.coordinator.pause).toHaveBeenCalledOnce()
  expect(fixture.repository.pauseProvisional).not.toHaveBeenCalled()
})
```

- [ ] **Step 3: Run Timer component tests and verify the current stub route remains**

Run from `frontend/`:

```powershell
npm run test -- --run src/lib/task-space/timer-note-composer-draft-registry.test.ts src/components/timer/session-launcher.test.tsx src/components/timer/session-clock.test.tsx src/components/timer/session-workspace.test.tsx src/components/timer/focused-work-item-note.test.tsx
```

Expected: FAIL because the Timer product components do not exist and `/timer` still renders the existing F2 stub.

- [ ] **Step 4: Implement deterministic level-2 attribution and same-parent planning**

```tsx
// frontend/src/components/timer/session-launcher.tsx
export function deriveLaunchSelection(items: CachedWorkItem[], selectedId: string | null) {
  const selected = items.find((item) => item.id === selectedId) ?? null
  if (!selected) return { level2Id: null, level3Ids: [] as string[], requiresLevel2: false }
  if (selected.depth === 3) {
    return { level2Id: selected.parentId, level3Ids: [selected.id], requiresLevel2: false }
  }
  if (selected.depth === 2) return { level2Id: selected.id, level3Ids: [], requiresLevel2: false }
  return { level2Id: null, level3Ids: [], requiresLevel2: true }
}

export function SessionLauncher({ items, initialWorkItemId, onStart }: Props) {
  const initial = deriveLaunchSelection(items, initialWorkItemId)
  const [level2Id, setLevel2Id] = useState(initial.level2Id)
  const [level3Ids, setLevel3Ids] = useState(initial.level3Ids)
  const candidates = items.filter((item) => item.depth === 3 && item.parentId === level2Id)
  return (
    <form onSubmit={(event) => {
      event.preventDefault()
      if (!level2Id) return
      void onStart({ level2WorkItemId: level2Id, level3WorkItemIds: level3Ids,
        plannedSeconds: Number(new FormData(event.currentTarget).get('plannedSeconds')) })
    }} className="space-y-4">
      <Level2Select required items={items} value={level2Id} onChange={(id) => {
        setLevel2Id(id); setLevel3Ids([])
      }} />
      <PlanChecklist items={candidates} selectedIds={level3Ids} onChange={setLevel3Ids} />
      <DurationInput name="plannedSeconds" defaultValue={1500} />
      <Button type="submit" disabled={!level2Id}>Start focus session</Button>
    </form>
  )
}
```

```typescript
async function startFromLauncher(selection: LaunchSelection): Promise<void> {
  const spaceId = useSpaceStore.getState().currentSpaceId
  if (!spaceId) throw new Error('spaceId is required for global start')
  const operationId = crypto.randomUUID()
  const input = {
    ...selection, spaceId, sessionId: crypto.randomUUID(), operationId,
    startedAt: new Date().toISOString(),
    expectedWorkItemVersions: await readCachedStartVersions(selection),
  }
  if (navigator.onLine) {
    await activeSessionCoordinator.start(input)
  } else {
    const aggregate = await focusSessionRepository.startProvisional({
      ...input, deviceId: timerIdentity.deviceId, tabId: timerIdentity.tabId,
    })
    useTimerStore.getState().installLocalProvisional({
      spaceId, operationId, ownerDeviceId: timerIdentity.deviceId,
      ownerTabId: timerIdentity.tabId, aggregate,
    })
  }
}
```

```typescript
async function applyClockAction(
  action: 'pause' | 'resume' | 'end', occurredAt: string,
): Promise<void> {
  const timer = useTimerStore.getState()
  if (timer.localProvisional) {
    const sessionId = timer.localProvisional.aggregate.session.sessionId
    const next = action === 'pause'
      ? await focusSessionRepository.pauseProvisional(sessionId, occurredAt)
      : action === 'resume'
        ? await focusSessionRepository.resumeProvisional(sessionId, occurredAt)
        : await focusSessionRepository.endProvisional(sessionId, {
          occurredAt, timerCompletion: 'ended_early',
        })
    timer.updateLocalProvisionalSession(next)
    return
  }
  if (action === 'pause') await activeSessionCoordinator.pause({ occurredAt })
  else if (action === 'resume') await activeSessionCoordinator.resume({ occurredAt })
  else await activeSessionCoordinator.end({
    occurredAt, timerCompletion: 'ended_early', validity: 'pending', validityReason: null,
  })
}
```

The global start body always carries the explicitly selected current `spaceId` because a Master Token has no implicit current Space. It also carries cached versions for the level-2 item and every selected level-3 item. An offline start installs its returned durable aggregate synchronously into the timer projection; repaint derives time from its timestamps exactly like an authoritative aggregate. Pause/resume/end accept no UI-selected Space. A local provisional projection routes only to the owner-gated Repository and writes the returned row back into the projection; an authoritative locator routes only to Task 7's Master-scope coordinator, which derives Space, Session, and epoch. The client never calls public Space-scoped start/pause/resume/end routes, resumes paused/waiting WorkItems, or changes status automatically.

- [ ] **Step 5: Implement owner/read-only clock controls and timestamp repaint**

```tsx
// frontend/src/components/timer/session-clock.tsx
export function SessionClock({ clock, session, owner, onPause, onResume, onEnd, onFlushNote }: Props) {
  const endSession = async () => {
    let noteError: Error | null = null
    try {
      await onFlushNote('session-end')
    } catch (error) {
      noteError = error as Error
    }
    const ended = await onEnd(new Date().toISOString())
    if (noteError) announce('Session ended; note needs attention')
    return ended
  }
  return (
    <section aria-label="Focus session clock" className="grid justify-items-center gap-4">
      <output aria-live="off" className="font-mono text-5xl tabular-nums">
        {formatClock(clock.remainingSeconds, clock.overtimeSeconds)}
      </output>
      <div className="flex gap-2">
        {session.clockState === 'running' ?
          <Button onClick={() => onPause(new Date().toISOString())} disabled={!owner}>Pause</Button> :
          <Button onClick={() => onResume(new Date().toISOString())} disabled={!owner}>Resume</Button>}
        <Button variant="destructive" onClick={endSession} disabled={!owner}>End session</Button>
      </div>
      {!owner ? <p role="status">Read-only in this Tab</p> : null}
    </section>
  )
}
```

The Note flush is attempted before end but cannot block `onEnd`; a local persistence error is retained as an actionable Note state after terminal Session facts return.

- [ ] **Step 6: Implement current plan, reversible completion drafts, compact Note, and Session note**

```typescript
// frontend/src/lib/critical-draft-registry.ts
import type { PomodoroXIDB } from '@/services/database'

export type DraftFlushReason =
  | 'blur' | 'current-item-change' | 'before-append' | 'append-failed'
  | 'append-committed' | 'before-submit' | 'space-switch' | 'logout' | 'unmount'

export interface CriticalDraftController {
  readonly database: PomodoroXIDB
  flush(reason: DraftFlushReason): Promise<void>
}

export function createCriticalDraftRegistry<T extends CriticalDraftController>() {
  const controllers = new Set<T>()
  return {
    register(controller: T): () => void {
      controllers.add(controller)
      return () => controllers.delete(controller)
    },
    async flushDatabase(database: PomodoroXIDB, reason: DraftFlushReason): Promise<void> {
      const matching = [...controllers]
        .filter((controller) => controller.database.name === database.name)
      for (const controller of matching) await controller.flush(reason)
    },
  }
}
```

```typescript
// frontend/src/lib/task-space/timer-note-composer-draft-registry.ts
import { canonicalize } from 'json-canonicalize'
import { z } from 'zod'
import { noteBlockSchema, type NoteBlock } from '@/lib/contracts/task-space'
import { createCriticalDraftRegistry, type DraftFlushReason } from '@/lib/critical-draft-registry'
import { canonicalNow } from '@/lib/direct-command-intents'
import type { PomodoroXIDB } from '@/services/database'
import type { TimerNoteComposerDraftRow } from '@/types'

export interface ChecklistDraftItem {
  itemId: string
  text: string
  children: Array<{ itemId: string; text: string; children: [] }>
}

const childDraftSchema = z.object({
  itemId: z.string().min(1), text: z.string(), children: z.tuple([]),
}).strict()
const rootDraftSchema = z.object({
  itemId: z.string().min(1), text: z.string(), children: z.array(childDraftSchema),
}).strict()

export type TimerNoteComposerDraft = {
  contentVersion: 1
  block:
    | { type: 'paragraph'; blockId: string; text: string }
    | { type: 'checklist'; blockId: string; items: ChecklistDraftItem[] }
}

export const timerNoteComposerDraftSchema = z.object({
  contentVersion: z.literal(1),
  block: z.discriminatedUnion('type', [
    z.object({ type: z.literal('paragraph'), blockId: z.string().min(1), text: z.string() }).strict(),
    z.object({ type: z.literal('checklist'), blockId: z.string().min(1),
      items: z.array(rootDraftSchema) }).strict(),
  ]),
}).strict()

const emptyParagraphComposerDraft = (): TimerNoteComposerDraft => ({
  contentVersion: 1,
  block: { type: 'paragraph', blockId: crypto.randomUUID(), text: '' },
})

function noteBlockFromStructuredComposerDraft(draft: TimerNoteComposerDraft): NoteBlock {
  const parsed = timerNoteComposerDraftSchema.parse(draft)
  if (parsed.block.type === 'paragraph') {
    if (!parsed.block.text.trim()) throw new Error('Paragraph draft is empty')
    return noteBlockSchema.parse({ ...parsed.block, text: parsed.block.text.trim() })
  }
  if (parsed.block.items.length === 0 || parsed.block.items.some((item) =>
    !item.text.trim() || item.children.some((child) => !child.text.trim()))) {
    throw new Error('Checklist draft is empty')
  }
  return noteBlockSchema.parse({
    ...parsed.block,
    items: parsed.block.items.map((item) => ({
      ...item, text: item.text.trim(), checked: false,
      children: item.children.map((child) => ({
        ...child, text: child.text.trim(), checked: false,
      })),
    })),
  })
}

export class TimerNoteComposerDraftController {
  private key: { spaceId: string; workItemId: string }
  private draft: TimerNoteComposerDraft
  private appendState: TimerNoteComposerDraftRow['appendState'] = 'draft'
  private appendOperationId: string | null = null
  private submittedBlock: NoteBlock | null = null

  constructor(
    readonly database: PomodoroXIDB,
    key: { spaceId: string; workItemId: string },
    private readonly append: (
      workItemId: string, blocks: NoteBlock[], operationId: string,
    ) => Promise<void>,
    private readonly hasAppliedAppendIntent: (
      workItemId: string, blockId: string, operationId: string,
    ) => Promise<boolean>,
  ) {
    this.key = key
    this.draft = emptyParagraphComposerDraft()
    timerNoteComposerDraftRegistry.register(this)
  }

  currentDraft(): TimerNoteComposerDraft { return structuredClone(this.draft) }

  async hydrate(): Promise<TimerNoteComposerDraft> {
    const row = await this.database.timerNoteComposerDrafts.get([
      this.key.spaceId, this.key.workItemId,
    ])
    this.draft = row
      ? timerNoteComposerDraftSchema.parse(JSON.parse(row.draftJson))
      : emptyParagraphComposerDraft()
    this.appendState = row?.appendState ?? 'draft'
    this.appendOperationId = row?.appendOperationId ?? null
    this.submittedBlock = row?.submittedBlockJson
      ? noteBlockSchema.parse(JSON.parse(row.submittedBlockJson)) : null
    if (this.appendState !== 'draft') {
      if (!this.appendOperationId || !this.submittedBlock) {
        throw new Error('timer_note_append_intent_corrupt')
      }
      const applied = await this.hasAppliedAppendIntent(
        this.key.workItemId, this.submittedBlock.blockId, this.appendOperationId,
      )
      if (applied) {
        await this.database.timerNoteComposerDrafts.delete([
          this.key.spaceId, this.key.workItemId,
        ])
        this.resetAfterCommittedAppend()
      } else if (this.appendState === 'committed') {
        throw new Error('timer_note_committed_append_evidence_missing')
      }
    }
    return this.currentDraft()
  }

  update(draft: TimerNoteComposerDraft): void {
    this.draft = timerNoteComposerDraftSchema.parse(draft)
  }

  async flush(reason: DraftFlushReason): Promise<void> {
    const draftJson = canonicalize(this.draft)
    if (draftJson === undefined) throw new Error('timer_note_draft_not_canonical')
    await this.database.timerNoteComposerDrafts.put({
      ...this.key, contentVersion: 1, draftJson,
      appendState: this.appendState,
      appendOperationId: this.appendOperationId,
      submittedBlockJson: this.submittedBlock
        ? canonicalize(this.submittedBlock) ?? null : null,
      updatedAt: canonicalNow(),
    })
  }

  async switchTo(next: { spaceId: string; workItemId: string }): Promise<void> {
    await this.flush('current-item-change')
    this.key = next
    await this.hydrate()
  }

  async appendExplicitly(
    block = noteBlockFromStructuredComposerDraft(this.draft),
  ): Promise<void> {
    if (this.appendState === 'draft') {
      this.appendState = 'submitting'
      this.appendOperationId = crypto.randomUUID()
      this.submittedBlock = block
      await this.flush('before-append')
    }
    if (!this.appendOperationId || !this.submittedBlock) {
      throw new Error('timer_note_append_intent_missing')
    }
    try {
      await this.append(
        this.key.workItemId, [this.submittedBlock], this.appendOperationId,
      )
    } catch (error) {
      await this.flush('append-failed')
      throw error
    }
    // From this point the Note/outbox owns the fixed append intent. A local
    // cleanup failure must never turn it back into a fresh append.
    this.appendState = 'committed'
    await this.flush('append-committed')
    await this.database.timerNoteComposerDrafts.delete([
      this.key.spaceId, this.key.workItemId,
    ])
    this.resetAfterCommittedAppend()
  }

  private resetAfterCommittedAppend(): void {
    this.draft = emptyParagraphComposerDraft()
    this.appendState = 'draft'
    this.appendOperationId = null
    this.submittedBlock = null
  }
}

export const timerNoteComposerDraftRegistry = createCriticalDraftRegistry<
  TimerNoteComposerDraftController
>({
  databaseOf: (controller) => controller.database,
  flush: (controller, reason) => controller.flush(reason),
})
```

```tsx
// frontend/src/components/timer/focused-work-item-note.tsx
import { useState } from 'react'
import { IndentIncrease, ListChecks, ListPlus, Pilcrow, Plus, Trash2 } from 'lucide-react'
import { workItemNoteDocumentSchema, type NoteBlock } from '@/lib/contracts/task-space'
import type { ChecklistDraftItem } from '@/lib/task-space/timer-note-composer-draft-registry'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const emptyChecklistDraftItem = (): ChecklistDraftItem => ({
  itemId: crypto.randomUUID(), text: '', children: [],
})
const emptyChecklistDraftChild = (): ChecklistDraftItem['children'][number] => ({
  itemId: crypto.randomUUID(), text: '', children: [],
})

const validateSingleBlock = (block: NoteBlock): NoteBlock =>
  workItemNoteDocumentSchema.parse({ contentVersion: 1, blocks: [block] }).blocks[0]!

const paragraphBlockFromDraft = (text: string): NoteBlock => {
  const normalized = text.trim()
  if (!normalized) throw new Error('Paragraph draft is empty')
  return validateSingleBlock({
    type: 'paragraph', blockId: crypto.randomUUID(), text: normalized,
  })
}

const checklistBlockFromDraft = (items: ChecklistDraftItem[]): NoteBlock => {
  if (items.length === 0 || items.some((item) =>
    !item.text.trim() || item.children.some((child) =>
      !child.text.trim() || child.children.length !== 0))) {
    throw new Error('Checklist draft is empty or exceeds two levels')
  }
  return validateSingleBlock({
    type: 'checklist', blockId: crypto.randomUUID(),
    items: items.map((item) => ({
      itemId: item.itemId, text: item.text.trim(), checked: false,
      children: item.children.map((child) => ({
        itemId: child.itemId, text: child.text.trim(), checked: false, children: [],
      })),
    })),
  })
}

const isAppendableDraft = (
  mode: 'paragraph' | 'checklist', paragraph: string, items: ChecklistDraftItem[],
): boolean => mode === 'paragraph'
  ? paragraph.trim().length !== 0
  : items.length !== 0 && items.every((item) =>
    item.text.trim().length !== 0 && item.children.every((child) =>
      child.text.trim().length !== 0 && child.children.length === 0))

function ChecklistDraftEditor({ items, onChange }: {
  items: ChecklistDraftItem[]
  maxDepth: 2
  onChange(items: ChecklistDraftItem[]): void
}) {
  const updateRoot = (index: number, next: ChecklistDraftItem) =>
    onChange(items.map((item, position) => position === index ? next : item))
  return (
    <div className="space-y-2">
      {items.map((item, rootIndex) => (
        <div key={item.itemId} className="space-y-1">
          <div className="flex gap-1">
            <Input aria-label={`New checklist item ${rootIndex + 1}`} value={item.text}
              onChange={(event) => updateRoot(rootIndex, { ...item, text: event.target.value })} />
            <Button size="icon-sm" variant="ghost"
              aria-label={`Add child under ${item.text || `item ${rootIndex + 1}`}`}
              title="Add child" onClick={() => updateRoot(rootIndex, {
                ...item, children: [...item.children, emptyChecklistDraftChild()],
              })}>
              <IndentIncrease aria-hidden="true" />
            </Button>
          </div>
          {item.children.map((child, childIndex) => (
            <div key={child.itemId} className="ml-5 flex gap-1">
              <Input aria-label={`Child of ${item.text || `item ${rootIndex + 1}`}`}
                value={child.text} onChange={(event) => updateRoot(rootIndex, {
                  ...item,
                  children: item.children.map((candidate, position) =>
                    position === childIndex ? { ...candidate, text: event.target.value } : candidate),
                })} />
              <Button size="icon-sm" variant="ghost" title="Remove child"
                aria-label={`Remove child ${childIndex + 1}`}
                onClick={() => updateRoot(rootIndex, {
                  ...item, children: item.children.filter((_, position) => position !== childIndex),
                })}>
                <Trash2 aria-hidden="true" />
              </Button>
            </div>
          ))}
        </div>
      ))}
      <Button variant="outline" onClick={() => onChange([...items, emptyChecklistDraftItem()])}>
        <Plus aria-hidden="true" /> Add checklist item
      </Button>
    </div>
  )
}

export function FocusedWorkItemNote({
  note, spaceId, workItemId, draftRegistry, onAppendBlocks, onFlush,
}: Props) {
  const focused = note.document.blocks.filter((block) =>
    block.type === 'paragraph' || block.type === 'checklist')
  const composer = useTimerNoteComposerDraft({
    registry: draftRegistry, spaceId, workItemId,
    append: (targetWorkItemId, blocks) => onAppendBlocks(targetWorkItemId, blocks),
  })
  const { mode, paragraphDraft, checklistDraft } = composer.view
  const [submitting, setSubmitting] = useState(false)
  const [appendError, setAppendError] = useState<string | null>(null)

  const appendDraft = async () => {
    setSubmitting(true)
    setAppendError(null)
    try {
      const block = mode === 'paragraph'
        ? paragraphBlockFromDraft(paragraphDraft)
        : checklistBlockFromDraft(checklistDraft)
      await composer.appendExplicitly(block)
    } catch (error) {
      await composer.flush('append-failed')
      setAppendError(error instanceof Error ? error.message : 'Append failed')
    } finally {
      setSubmitting(false)
    }
  }
  return (
    <section aria-label="Focused work item note" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
        void composer.flush('blur').then(() => onFlush('blur')).catch(setActionableDraftError)
      }
    }}>
      {focused.map((block) => <CompactBlockPreview key={block.blockId} block={block} />)}
      <div role="group" aria-label="New note Block type" className="flex gap-1">
        <Button aria-pressed={mode === 'paragraph'} onClick={() => composer.setMode('paragraph')}>
          <Pilcrow aria-hidden="true" /> Paragraph
        </Button>
        <Button aria-pressed={mode === 'checklist'} onClick={() => composer.setMode('checklist')}>
          <ListChecks aria-hidden="true" /> Checklist
        </Button>
      </div>
      {mode === 'paragraph' ? (
        <textarea aria-label="New paragraph" value={paragraphDraft}
          className="min-h-20 w-full resize-y border p-2"
          onChange={(event) => composer.setParagraph(event.target.value)} />
      ) : (
        <ChecklistDraftEditor items={checklistDraft} maxDepth={2}
          onChange={composer.setChecklist} />
      )}
      <Button onClick={() => { void appendDraft() }}
        disabled={submitting || !isAppendableDraft(mode, paragraphDraft, checklistDraft)}>
        <ListPlus aria-hidden="true" />
        {mode === 'paragraph' ? 'Append paragraph' : 'Append checklist'}
      </Button>
      {appendError ? <p role="alert">{appendError}</p> : null}
    </section>
  )
}
```

Timer Note interaction holds a structured `contentVersion: 1` local composer draft and calls only `WorkItemNoteRepository.appendBlocks` after explicit submit with a newly generated, nonempty paragraph or Checklist Block. `useTimerNoteComposerDraft` registers one controller, hydrates the exact `(spaceId, workItemId)` key before editing, keeps a ref to the latest structured draft for unmount flush, and unregisters only after that flush settles. `ChecklistDraftEditor` supports root items and direct children only; it validates through the shared WorkItemNote schema before dispatch. Existing Blocks render through `CompactBlockPreview`; there is no replace, toggle, reorder, indent/outdent, heading, ordered/unordered list, WorkItem-reference, or promotion control for persisted content. A successful append deletes only that composite draft row; a failed append writes and retains it. Validation and CAS remain in the repository/backend authority. `session-workspace.tsx` renders same-parent active plans, add/remove controls, one current radio-style selection, independent completion-draft checkboxes, the focused Note component, and a separate `textarea` labelled `Session note`. Its container obtains Task 7's coordinator and registered Tab identity with `useActiveSessionCoordinator()`/`useActiveSessionIdentity()`, injects both into `FocusSessionRepository`, and calls only the repository's five running-content methods. Before current-item change it awaits both `onFlushWorkItemNote('current-item-change')` and `composer.switchTo({ spaceId, workItemId: nextId })`; either failure keeps the old current item selected. The append callback receives and rechecks the same explicit WorkItem ID, so an A draft cannot dispatch through a B repository binding. The repository routes authoritative writes to the Master Coordinator, keeps only owner-verified `local_provisional` writes local, and surfaces `blocked_conflict` without mutating business rows or outbox.

- [ ] **Step 7: Replace `/timer` with launcher/running/ended routing**

```tsx
// frontend/src/app/(app)/timer/page.tsx
'use client'

export default function TimerPage() {
  const locator = useTimerStore((state) => state.locator)
  const session = useTimerStore((state) => state.session)
  const clock = useTimerStore(selectDerivedClock)
  if (!locator || !session) return <SessionLauncherContainer />
  if (session.clockState === 'ended') return <SessionReviewContainer sessionId={session.sessionId} />
  return (
    <div className="mx-auto grid w-full max-w-6xl gap-6 p-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      <SessionClockContainer session={session} clock={clock!} />
      <SessionWorkspaceContainer session={session} />
    </div>
  )
}
```

- [ ] **Step 8: Run Timer product, repository, type, and lint gates**

Run from `frontend/`:

```powershell
npm run test -- --run src/lib/task-space/timer-note-composer-draft-registry.test.ts src/components/timer/session-launcher.test.tsx src/components/timer/session-clock.test.tsx src/components/timer/session-workspace.test.tsx src/components/timer/focused-work-item-note.test.tsx src/lib/focus-session/focus-session-repository.test.ts
npm run typecheck
npm run lint -- src/lib/task-space/timer-note-composer-draft-registry.ts src/components/timer 'src/app/(app)/timer/page.tsx'
```

Expected: PASS; level-3 start attributes level 2, empty L3 plans work, current-item switch persists A before hydrating B, A-B-A restores the exact structured draft with zero cross-Note append, successful append clears its composite row, failed append/reopen retains the same fixed intent, and a post-append cleanup failure is reconciled from the Note/outbox evidence without a duplicate append. Session note remains separate, and terminal time survives a Note failure.

- [ ] **Step 9: Commit the Timer vertical loop**

```powershell
git add -- frontend/src/lib/critical-draft-registry.ts frontend/src/lib/critical-draft-registry.test.ts frontend/src/lib/task-space/timer-note-composer-draft-registry.ts frontend/src/lib/task-space/timer-note-composer-draft-registry.test.ts frontend/src/components/timer/session-launcher.tsx frontend/src/components/timer/session-launcher.test.tsx frontend/src/components/timer/session-clock.tsx frontend/src/components/timer/session-clock.test.tsx frontend/src/components/timer/session-workspace.tsx frontend/src/components/timer/session-workspace.test.tsx frontend/src/components/timer/focused-work-item-note.tsx frontend/src/components/timer/focused-work-item-note.test.tsx 'frontend/src/app/(app)/timer/page.tsx' frontend/src/stores/timer-store.ts frontend/src/lib/focus-session/active-session-coordinator.ts
git commit -m "feat(frontend): run task-aware focus sessions"
```

---

### Task 9: Persist Review Outcomes And Reconcile Immutable Per-Item Command Receipts

**Files:**
- Create: `frontend/src/lib/focus-session/command-reconciliation.ts`
- Create: `frontend/src/lib/focus-session/command-reconciliation.test.ts`
- Create: `frontend/src/components/timer/session-review.tsx`
- Create: `frontend/src/components/timer/session-review.test.tsx`
- Create: `frontend/src/components/timer/command-receipt-list.tsx`
- Create: `frontend/src/components/timer/command-receipt-list.test.tsx`
- Create: `frontend/src/lib/focus-session/session-review-draft-registry.ts`
- Create: `frontend/src/lib/focus-session/session-review-draft-registry.test.ts`
- Modify: `frontend/src/lib/focus-session/focus-session-repository.ts`
- Modify: `frontend/src/lib/focus-session/focus-session-repository.test.ts`
- Modify: `frontend/src/stores/focus-session-store.ts`
- Modify: `frontend/src/app/(app)/timer/page.tsx`

**Interfaces:**
- Consumes: Task 1 Space-scoped review/reconcile Adapter; Task 2 immutable envelope/receipt tables, command queue, `sessionReviewDrafts`, and `directCommandIntents`; Task 3 durable direct-command helper; Task 6 repository; Task 8 terminal Session.
- Produces: Space-scoped structured `SessionReviewDraftRow` with a fixed required submit operation ID; one complete `toReviewRows` aggregate identity projector plus one shared `applyAuthoritativeReviewAndClearDraft` transaction used by both online review and S4 imported-review recovery; pre-import provisional review that leaves Session/Outcome/outbox/direct-intent state unchanged while retaining that draft for S4; exact same-POST authoritative review recovery after response loss/restart; `CommandReconciliation.queryOriginalBeforeReplay/reconcile/abandon`; two-permission replay gating from explicit caller choice plus immutable server `replaySafe`; query-first immutable `abandoned` receipts with real-terminal-result precedence; review durability cache; partial-success receipt list; explicit unknown/conflict/abandon actions; review UI that does not hold the global locator.

- [ ] **Step 1: Write failing review-order, immutable-envelope, and partial-success tests**

```typescript
// frontend/src/lib/focus-session/command-reconciliation.test.ts
it('persists review and immutable envelopes before querying command results', async () => {
  const fixture = reconciliationFixture()
  fixture.api.submitReview.mockResolvedValue(reviewWithReceipts([
    receipt('cmd-a', 'succeeded'), receipt('cmd-b', 'unknown'),
  ]))
  await fixture.repository.submitReview(reviewDraft())
  expect(fixture.order).toEqual(['cache-review', 'cache-envelopes', 'cache-receipts'])
  expect(await fixture.db.sessionCommandEnvelopes.get('cmd-b')).toMatchObject({
    commandId: 'cmd-b', payloadHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    replaySafe: true,
  })
})

it.each([
  'session_space', 'session_id', 'context_space', 'context_session',
  'attribution_space', 'attribution_session', 'plan_space', 'plan_session',
  'outcome_space', 'outcome_session', 'envelope_space', 'envelope_session',
  'foreign_receipt', 'foreign_outcome_command',
])('rejects authoritative review aggregate identity drift %s atomically', async (mutation) => {
  const fixture = reconciliationFixture()
  const before = await fixture.reviewBusinessSnapshot()
  fixture.api.submitReview.mockResolvedValue(
    mutateReviewAggregateIdentity(completedReviewAggregate(), mutation),
  )
  await expect(fixture.repository.submitReview(reviewDraft()))
    .rejects.toThrow(/authoritative_review_response_(identity|receipt|command_link)_mismatch/)
  expect(await fixture.reviewBusinessSnapshot()).toEqual(before)
  expect(await fixture.db.sessionReviewDrafts.get(['space-a', 'fs-1']))
    .toMatchObject({ operationId: 'review-op-1' })
})

it.each(['validity', 'reviewedAt', 'outcomes'])(
  'does not delete a same-operation draft whose %s changed in flight',
  async (field) => {
    const fixture = reconciliationFixture({ deferredReviewResponse: true })
    const businessBefore = await fixture.authoritativeReviewRows()
    const pending = fixture.repository.submitReview(reviewDraft())
    await fixture.waitUntilReviewRequestIsInFlight()
    const changedDraft = await fixture.mutateDraftBusinessKeepingOperationId(field)
    fixture.resolveReviewResponse(completedReviewAggregate())
    await expect(pending).rejects.toThrow(
      'authoritative_review_draft_changed_before_apply',
    )
    expect(await fixture.authoritativeReviewRows()).toEqual(businessBefore)
    expect(await fixture.persistedDraft()).toEqual(changedDraft)
  },
)

it('rejects authoritative review apply outside its durable transaction', async () => {
  const fixture = reconciliationFixture()
  await expect(applyAuthoritativeReviewAndClearDraft(
    fixture.db, 'space-a', 'fs-1', fixture.intent.requestJson, 'exact',
    completedReviewAggregate(),
  )).rejects.toThrow('authoritative_review_transaction_required')
  expect(await fixture.persistedDraft()).toMatchObject({ operationId: 'review-op-1' })
})

it.each([
  'directCommandIntents', 'focusSessions', 'sessionWorkItemOutcomes',
  'sessionCommandEnvelopes', 'sessionCommandReceipts', 'sessionCommandQueue',
  'sessionReviewDrafts',
])('requires the review transaction to include %s', async (missingStore) => {
  const fixture = reconciliationFixture()
  await expect(fixture.applyReviewInsideTransactionMissing(missingStore))
    .rejects.toThrow('authoritative_review_transaction_required')
  expect(await fixture.persistedDraft()).toMatchObject({ operationId: 'review-op-1' })
})

it('keeps an ended provisional review draft pending without widening the held import', async () => {
  const fixture = reconciliationFixture({ localProvisionalEnded: true })
  const outboxBefore = await fixture.db.outbox.toArray()
  await fixture.repository.submitReview(reviewDraft({
    sessionId: 'offline-1', operationId: 'offline-review-1',
  }))
  expect(fixture.api.submitReview).not.toHaveBeenCalled()
  expect(await fixture.db.focusSessions.get('offline-1')).toMatchObject({
    clockState: 'ended', ownershipState: 'local_provisional',
    validity: 'pending', reviewState: 'pending',
  })
  expect(await fixture.meta.provisionalOperations.get('offline-op-1'))
    .toMatchObject({ state: 'awaiting_s4' })
  expect(await fixture.db.sessionWorkItemOutcomes.where('sessionId').equals('offline-1').count())
    .toBe(0)
  expect(await fixture.db.outbox.toArray()).toEqual(outboxBefore)
  expect(await fixture.db.sessionReviewDrafts.get(['space-a', 'offline-1']))
    .toMatchObject({ operationId: 'offline-review-1' })
})

it('queries the original unknown command before any replay decision', async () => {
  const fixture = reconciliationFixture({ unknown: 'cmd-b' })
  await fixture.reconciliation.queryOriginalBeforeReplay('fs-1', 'cmd-b')
  expect(fixture.api.calls).toEqual([
    ['reconcileCommands', {
      spaceId: 'space-a', sessionId: 'fs-1',
      commandIds: ['cmd-b'], replaySafe: false,
      abandonCommandIds: [], decisionAt: null,
    }],
  ])
  expect(fixture.api.replayCommand).toBeUndefined()
})

it.each([
  [false, false, false],
  [false, true, false],
  [true, false, false],
  [true, true, true],
] as const)(
  'sends replay permission only when requested=%s and serverSafe=%s',
  async (requested, serverSafe, sent) => {
    const fixture = reconciliationFixture({ unknown: 'cmd-b', replaySafe: serverSafe })
    await fixture.reconciliation.reconcile('fs-1', 'cmd-b', requested)
    expect(fixture.api.reconcileCommands).toHaveBeenCalledWith(expect.objectContaining({
      commandIds: ['cmd-b'], replaySafe: sent,
      abandonCommandIds: [], decisionAt: null,
    }))
  },
)

it('keeps a real terminal result when abandon races original completion', async () => {
  const fixture = reconciliationFixture({
    unknown: 'cmd-b', abandonResponse: receipt('cmd-b', 'succeeded'),
  })
  await fixture.reconciliation.abandon(
    'fs-1', 'cmd-b', '2026-07-15T09:00:00Z',
  )
  expect(fixture.api.reconcileCommands).toHaveBeenCalledWith(expect.objectContaining({
    commandIds: ['cmd-b'], replaySafe: false,
    abandonCommandIds: ['cmd-b'], decisionAt: '2026-07-15T09:00:00Z',
  }))
  expect(await fixture.db.sessionCommandQueue.get('cmd-b'))
    .toMatchObject({ state: 'terminal', lastReceiptState: 'succeeded' })
  expect(await fixture.db.sessionCommandEnvelopes.get('cmd-b')).toBeDefined()
})

it('persists abandoned as terminal without deleting or replaying the envelope', async () => {
  const fixture = reconciliationFixture({
    unknown: 'cmd-b', abandonResponse: receipt('cmd-b', 'abandoned'),
  })
  await fixture.reconciliation.abandon(
    'fs-1', 'cmd-b', '2026-07-15T09:00:00Z',
  )
  expect(await fixture.db.sessionCommandReceipts.where('commandId').equals('cmd-b')
    .filter((row) => row.state === 'abandoned').count()).toBe(1)
  expect(await fixture.db.sessionCommandEnvelopes.get('cmd-b')).toBeDefined()
  expect(await fixture.db.sessionCommandQueue.get('cmd-b'))
    .toMatchObject({ state: 'terminal', lastReceiptState: 'abandoned' })
  expect(fixture.api.reconcileCommands).toHaveBeenCalledTimes(1)
})

it('reuses the exact durable root and payload after server commit, client crash, and restart', async () => {
  const fixture = reconciliationFixture({
    unknown: 'cmd-b', firstReconcileServerCommittedThenClientCrashed: true,
  })
  await expect(fixture.reconciliation.reconcile('fs-1', 'cmd-b', true))
    .rejects.toThrow('client_crash_after_server_commit')
  const attempt = await fixture.db.sessionCommandReconciliationAttempts
    .where('state').equals('in_flight').first()
  const exactRequest = {
    spaceId: 'space-a', sessionId: 'fs-1', commandIds: ['cmd-b'],
    replaySafe: true, abandonCommandIds: [], decisionAt: null,
  }
  expect(attempt).toMatchObject({
    operationId: expect.any(String),
    requestJson: canonicalJson(exactRequest),
    requestHash: await hashCommandPayload(reconciliationHashPayload(exactRequest)),
    state: 'in_flight',
  })
  expect(fixture.claimObservedAtFirstTransport).toEqual(attempt)
  expect(fixture.server.committedOperationIds()).toContain(attempt!.operationId)

  const restarted = fixture.restartReconciliation()
  await restarted.reconcile('fs-1', 'cmd-b', true)

  const [first, retry] = fixture.api.reconcileCommands.mock.calls.map(([input]) => input)
  expect(retry).toMatchObject({
    operationId: first!.operationId,
    commandIds: first!.commandIds,
    replaySafe: first!.replaySafe,
    abandonCommandIds: first!.abandonCommandIds,
    decisionAt: first!.decisionAt,
  })
  expect(retry).toEqual(first)
  expect(fixture.server.executionCount(attempt!.operationId)).toBe(1)
  expect(await fixture.db.sessionCommandReconciliationAttempts.get(attempt!.operationId))
    .toMatchObject({ state: 'terminal' })
})

it('rotates a reconciliation root only after the prior HTTP attempt is terminal', async () => {
  const fixture = reconciliationFixture({ unknown: 'cmd-b' })
  await fixture.reconciliation.reconcile('fs-1', 'cmd-b', true)
  const first = fixture.api.reconcileCommands.mock.calls[0]![0]
  expect(await fixture.db.sessionCommandReconciliationAttempts.get(first.operationId))
    .toMatchObject({ state: 'terminal' })

  await fixture.reconciliation.reconcile('fs-1', 'cmd-b', true)
  const second = fixture.api.reconcileCommands.mock.calls[1]![0]
  expect(second.operationId).not.toBe(first.operationId)
  expect(second).toMatchObject({
    commandIds: first.commandIds,
    replaySafe: first.replaySafe,
    abandonCommandIds: first.abandonCommandIds,
    decisionAt: first.decisionAt,
  })
})

it('rejects a changed payload under one persisted reconciliation root', async () => {
  const fixture = reconciliationFixture({ unknown: 'cmd-b' })
  const request = reconciliationRequest({ commandIds: ['cmd-b'], replaySafe: false })
  const attempt = await prepareReconciliationAttempt(
    fixture.db, request, 'reconcile-root-1',
  )
  await expect(prepareReconciliationAttempt(fixture.db, {
    ...request, replaySafe: true,
  }, attempt.operationId)).rejects.toThrow('reconciliation_operation_payload_mismatch')
  expect(fixture.api.reconcileCommands).not.toHaveBeenCalled()
})
```

```typescript
// frontend/src/components/timer/session-review.test.tsx
it('shows successful and failed siblings independently and keeps time visible', () => {
  render(<SessionReview session={endedSession({ focusedSeconds: 1350 })}
    plans={twoPlans()} receipts={[
      receipt('cmd-a', 'succeeded'), receipt('cmd-b', 'failed'),
    ]} onSubmit={vi.fn()} onReconcile={vi.fn()} />)
  expect(screen.getByText('22:30 focused')).toBeVisible()
  expect(screen.getByText('Succeeded')).toBeVisible()
  expect(screen.getByText('Failed')).toBeVisible()
})
```

```typescript
// frontend/src/components/timer/command-receipt-list.test.tsx
it('offers same-envelope retry only for a server-declared replay-safe command', () => {
  const reconcile = vi.fn()
  const abandon = vi.fn()
  render(<CommandReceiptList
    envelopes={[
      envelope('cmd-safe', { replaySafe: true }),
      envelope('cmd-unsafe', { replaySafe: false }),
    ]}
    receipts={[receipt('cmd-safe', 'unknown'), receipt('cmd-unsafe', 'unknown')]}
    onReconcile={reconcile} onAbandon={abandon}
  />)
  expect(screen.getByRole('button', { name: 'Retry cmd-safe' })).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Retry cmd-unsafe' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Query cmd-unsafe' }))
  expect(reconcile).toHaveBeenCalledWith('cmd-unsafe', false)
  fireEvent.click(screen.getByRole('button', { name: 'Retry cmd-safe' }))
  expect(reconcile).toHaveBeenCalledWith('cmd-safe', true)
  fireEvent.click(screen.getByRole('button', { name: 'Abandon cmd-unsafe' }))
  expect(abandon).toHaveBeenCalledWith('cmd-unsafe')
})

it('keeps pending visible and gives abandoned receipts no further action', () => {
  render(<CommandReceiptList
    envelopes={[envelope('cmd-pending'), envelope('cmd-abandoned')]}
    receipts={[receipt('cmd-pending', 'pending'), receipt('cmd-abandoned', 'abandoned')]}
    onReconcile={vi.fn()} onAbandon={vi.fn()} />)
  expect(screen.getByText('Pending')).toBeVisible()
  expect(screen.getByText('Abandoned')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Abandon cmd-pending' })).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Retry cmd-abandoned' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Abandon cmd-abandoned' })).toBeNull()
})
```

```typescript
// frontend/src/lib/focus-session/session-review-draft-registry.test.ts
it('persists the structured review draft and fixed operation ID before transport', async () => {
  const fixture = await reviewDraftFixture('space-a', 'fs-1')
  await fixture.registry.update(reviewDraft({ operationId: 'review-op-1' }))
  await fixture.registry.flushDatabase(fixture.db, 'before-submit')
  const row = await fixture.db.sessionReviewDrafts.get(['space-a', 'fs-1'])
  expect(row).toMatchObject({ operationId: 'review-op-1', draftJson: expect.any(String) })
  expect(JSON.parse(row!.draftJson)).toEqual(reviewDraft({ operationId: 'review-op-1' }))
})

it('restarts a committed review with the exact same TS2/S3 POST and no S4 query', async () => {
  const fixture = await reviewSubmissionFixture({ commitThenLoseResponse: true })
  await expect(fixture.repository.submitReview(fixture.draft))
    .rejects.toThrow('transport_response_lost')
  const held = await fixture.db.directCommandIntents.get(fixture.draft.operationId)
  expect(held).toMatchObject({ kind: 'submit_review', state: 'in_flight' })
  const restarted = await fixture.reopen({ returnStoredIdempotentResult: true })
  await restarted.resumePendingDirectCommandIntents()
  expect(restarted.api.submitReview.mock.calls[1])
    .toEqual(restarted.api.submitReview.mock.calls[0])
  expect(restarted.api.queryOperations).toBeUndefined()
  expect(await restarted.db.directCommandIntents.get(fixture.draft.operationId))
    .toMatchObject({ state: 'terminal' })
  expect(await restarted.db.sessionReviewDrafts.get(['space-a', 'fs-1']))
    .toBeUndefined()
})
```

- [ ] **Step 2: Run review/reconciliation tests and verify the red state**

Run from `frontend/`:

```powershell
npm run test -- --run src/lib/focus-session/session-review-draft-registry.test.ts src/lib/direct-command-intents.test.ts src/lib/focus-session/command-reconciliation.test.ts src/components/timer/session-review.test.tsx src/components/timer/command-receipt-list.test.tsx src/lib/focus-session/focus-session-repository.test.ts
```

Expected: FAIL because the durable review-draft/direct-intent integration, reconciliation modules, and components do not exist.

- [ ] **Step 3: Implement immutable local envelopes, queue state, and query-first reconciliation**

```typescript
// frontend/src/lib/focus-session/command-reconciliation.ts
type ReconciliationRequestIntent = Omit<
  ReconcileFocusSessionCommandsInput, 'operationId'
>

const reconciliationHashPayload = (request: ReconciliationRequestIntent): JsonValue => ({
  command_ids: request.commandIds,
  replay_safe: request.replaySafe,
  abandon_command_ids: request.abandonCommandIds,
  decision_at: request.decisionAt,
})

export async function prepareReconciliationAttempt(
  db: PomodoroXIDB,
  request: ReconciliationRequestIntent,
  requestedOperationId?: string,
): Promise<CommandReconciliationAttemptRow> {
  const requestJson = canonicalJson(request)
  const requestHash = await hashCommandPayload(reconciliationHashPayload(request))
  return db.transaction('rw', db.sessionCommandReconciliationAttempts, async () => {
    if (requestedOperationId) {
      const bound = await db.sessionCommandReconciliationAttempts.get(requestedOperationId)
      if (bound && (bound.requestHash !== requestHash || bound.requestJson !== requestJson)) {
        throw new Error('reconciliation_operation_payload_mismatch')
      }
      if (bound?.state === 'terminal') {
        throw new Error('reconciliation_operation_terminal')
      }
      if (bound) return bound
    }
    const activeForSession = await db.sessionCommandReconciliationAttempts
      .where('sessionId').equals(request.sessionId)
      .and((row) => row.spaceId === request.spaceId && row.state !== 'terminal')
      .toArray()
    const reusable = activeForSession.filter((row) => {
      const bound = JSON.parse(row.requestJson) as ReconciliationRequestIntent
      return JSON.stringify(bound.commandIds) === JSON.stringify(request.commandIds)
    })
    if (reusable.length > 1) {
      throw new Error('reconciliation_attempt_ambiguous')
    }
    if (reusable[0]) {
      if (reusable[0].requestHash !== requestHash || reusable[0].requestJson !== requestJson) {
        throw new Error('reconciliation_operation_payload_mismatch')
      }
      return reusable[0]
    }
    const now = new Date().toISOString()
    const row: CommandReconciliationAttemptRow = {
      operationId: requestedOperationId ?? crypto.randomUUID(),
      spaceId: request.spaceId, sessionId: request.sessionId,
      requestJson, requestHash, state: 'prepared', createdAt: now, updatedAt: now,
    }
    await db.sessionCommandReconciliationAttempts.add(row)
    return row
  })
}

export class CommandReconciliation {
  constructor(
    private readonly db: PomodoroXIDB,
    private readonly api: typeof focusSessionApi,
  ) {}

  async queryOriginalBeforeReplay(sessionId: string, commandId: string) {
    return this.run(sessionId, commandId, false, [], null)
  }

  async reconcile(
    sessionId: string, commandId: string, requestedReplaySafe: boolean,
  ) {
    return this.run(sessionId, commandId, requestedReplaySafe, [], null)
  }

  async abandon(sessionId: string, commandId: string, decisionAt: string) {
    return this.run(sessionId, commandId, false, [commandId], decisionAt)
  }

  private async run(
    sessionId: string,
    commandId: string,
    requestedReplaySafe: boolean,
    abandonCommandIds: string[],
    decisionAt: string | null,
  ) {
    const envelope = await this.db.sessionCommandEnvelopes.get(commandId)
    if (!envelope) throw new Error('command_envelope_not_found')
    const request = {
      spaceId: envelope.spaceId, sessionId, commandIds: [commandId],
      replaySafe: requestedReplaySafe && envelope.replaySafe,
      abandonCommandIds, decisionAt,
    }
    const attempt = await prepareReconciliationAttempt(this.db, request)
    const boundRequest = JSON.parse(attempt.requestJson) as ReconciliationRequestIntent
    if (canonicalJson(boundRequest) !== attempt.requestJson ||
        canonicalJson(boundRequest) !== canonicalJson(request)) {
      throw new Error('reconciliation_operation_payload_mismatch')
    }
    await this.db.transaction(
      'rw', this.db.sessionCommandQueue, this.db.sessionCommandReconciliationAttempts,
      async () => {
        const claimed = await this.db.sessionCommandReconciliationAttempts
          .get(attempt.operationId)
        if (!claimed || claimed.state === 'terminal' ||
            claimed.requestJson !== attempt.requestJson ||
            claimed.requestHash !== attempt.requestHash) {
          throw new Error('reconciliation_claim_lost')
        }
        await this.db.sessionCommandQueue.update(commandId, {
          state: 'querying', updatedAt: new Date().toISOString(),
        })
        await this.db.sessionCommandReconciliationAttempts.update(attempt.operationId, {
          state: 'in_flight', updatedAt: new Date().toISOString(),
        })
      },
    )
    const aggregate = await this.api.reconcileCommands({
      operationId: attempt.operationId,
      ...boundRequest,
    })
    const receipts = aggregate.commandReceipts
    await this.persistReceipts(receipts)
    const terminal = latestReceipt(receipts, commandId)
    await this.db.transaction(
      'rw', this.db.sessionCommandQueue, this.db.sessionCommandReconciliationAttempts,
      async () => {
        await this.db.sessionCommandQueue.update(commandId, {
          state: terminal && !['pending', 'unknown'].includes(terminal.state)
            ? 'terminal' : 'held',
          lastReceiptState: terminal?.state ?? 'unknown', updatedAt: new Date().toISOString(),
        })
        await this.db.sessionCommandReconciliationAttempts.update(attempt.operationId, {
          state: 'terminal', updatedAt: new Date().toISOString(),
        })
      },
    )
    return terminal
  }
}
```

There is no blind generic `replay(commandId)` method. The first action always calls `queryOriginalBeforeReplay(..., false)`. A later same-envelope retry is offered only when the immutable server envelope declares `replaySafe=true`; even then `reconcile(..., true)` requires an explicit user click. The Adapter sends the conjunction of those two permissions and TS2 still queries the original operation before executing. `abandon(..., decisionAt)` sends `replaySafe=false` plus the one selected ID in `abandonCommandIds`; TS2 queries the original first, returns any already-terminal truth unchanged, and only otherwise appends `abandoned`. Before the first HTTP call, `prepareReconciliationAttempt` commits the root operation ID, canonical full request JSON, request hash, and `in_flight` claim. Transport always parses and sends that persisted JSON. A server commit followed by response loss or client crash leaves the row reusable after restart; the identical root and payload query the server's idempotent result. The attempt becomes `terminal` only after a parsed HTTP aggregate is durably applied, and only then may a later user action allocate a new root. A nonterminal root can never bind changed replay, abandon, time, command-order, Session, or Space intent. The frontend never deletes or edits the envelope, never retries an abandoned command, and retains pending/unknown rows for continued visibility. A user-approved corrected Outcome is submitted as a new review revision and therefore creates a new command ID.

- [ ] **Step 4: Cache review, append-only outcomes, envelopes, and receipts atomically**

```typescript
// frontend/src/lib/focus-session/session-review-draft-registry.ts
import { canonicalize } from 'json-canonicalize'
import { sessionReviewDraftSchema, type SessionReviewDraft } from '@/lib/contracts/focus-session'
import { createCriticalDraftRegistry, type DraftFlushReason } from '@/lib/critical-draft-registry'
import { canonicalNow } from '@/lib/direct-command-intents'
import type { JsonValue } from '@/lib/contracts/payload-hash'
import type { PomodoroXIDB } from '@/services/database'

export class SessionReviewDraftController {
  private constructor(
    readonly database: PomodoroXIDB,
    readonly spaceId: string,
    readonly sessionId: string,
    private draft: SessionReviewDraft,
  ) {}

  static async open(input: {
    db: PomodoroXIDB; spaceId: string; sessionId: string; initialDraft: JsonValue;
  }): Promise<SessionReviewDraftController> {
    const existing = await input.db.sessionReviewDrafts.get([input.spaceId, input.sessionId])
    const draft = existing
      ? sessionReviewDraftSchema.parse(JSON.parse(existing.draftJson))
      : sessionReviewDraftSchema.parse({ ...input.initialDraft, operationId: crypto.randomUUID() })
    const controller = new SessionReviewDraftController(
      input.db, input.spaceId, input.sessionId, draft,
    )
    sessionReviewDraftRegistry.register(controller)
    if (!existing) await controller.flush('before-submit')
    return controller
  }

  currentDraft(): SessionReviewDraft { return structuredClone(this.draft) }

  update(next: SessionReviewDraft): void {
    if (next.spaceId !== this.spaceId || next.sessionId !== this.sessionId ||
        next.operationId !== this.draft.operationId) {
      throw new Error('review_draft_identity_change_forbidden')
    }
    this.draft = sessionReviewDraftSchema.parse(next)
  }

  async flush(_reason: DraftFlushReason): Promise<void> {
    const draftJson = canonicalize(this.draft)
    if (draftJson === undefined) throw new Error('review_draft_not_canonical')
    await this.database.sessionReviewDrafts.put({
      spaceId: this.spaceId, sessionId: this.sessionId,
      draftJson, operationId: this.draft.operationId, updatedAt: canonicalNow(),
    })
  }
}

export async function createOrHydrateSessionReviewDraft(input: {
  db: PomodoroXIDB; spaceId: string; sessionId: string; initialDraft: JsonValue;
}): Promise<SessionReviewDraft> {
  return (await SessionReviewDraftController.open(input)).currentDraft()
}

export const sessionReviewDraftRegistry =
  createCriticalDraftRegistry<SessionReviewDraftController>()

export async function requirePersistedExactSessionReviewDraft(
  db: PomodoroXIDB,
  input: SessionReviewDraft,
): Promise<void> {
  const row = await db.sessionReviewDrafts.get([input.spaceId, input.sessionId])
  const exact = canonicalize(sessionReviewDraftSchema.parse(input))
  if (!row || exact === undefined || row.operationId !== input.operationId ||
      row.draftJson !== exact) {
    throw new Error('review_draft_not_durably_bound')
  }
}
```

```typescript
// Merge these helpers and methods into the FocusSessionRepository module from
// Task 6. Extend that module's existing Dexie, PomodoroXIDB,
// CachedFocusSession, and FocusSessionAggregateView imports; do not duplicate
// their declarations. The class shell keeps this fence executable.
import { canonicalize } from 'json-canonicalize'
import {
  focusSessionAggregateSchema, projectFocusSessionViewToCache,
  sessionReviewDraftSchema,
  type SessionReviewDraft,
} from '@/lib/contracts/focus-session'
import {
  canonicalNow, executeDurableDirectCommand, prepareDirectCommandIntent,
} from '@/lib/direct-command-intents'
import { requirePersistedExactSessionReviewDraft } from './session-review-draft-registry'
import { focusSessionApi } from '@/services/focus-session-api'

export function toReviewRows(
  response: FocusSessionAggregateView,
  expectedSpaceId: string,
  expectedSessionId: string,
) {
  const wrongAggregateIdentity =
    response.session.spaceId !== expectedSpaceId ||
    response.session.id !== expectedSessionId ||
    (response.context !== null &&
      (response.context.spaceId !== expectedSpaceId ||
        response.context.sessionId !== expectedSessionId)) ||
    response.attribution.spaceId !== expectedSpaceId ||
    response.attribution.sessionId !== expectedSessionId ||
    response.plan.some((row) =>
      row.spaceId !== expectedSpaceId || row.sessionId !== expectedSessionId) ||
    response.outcomes.some((row) =>
      row.spaceId !== expectedSpaceId || row.sessionId !== expectedSessionId) ||
    response.commandEnvelopes.some((row) =>
      row.spaceId !== expectedSpaceId || row.sessionId !== expectedSessionId)
  if (wrongAggregateIdentity) {
    throw new Error('authoritative_review_response_identity_mismatch')
  }
  const envelopeCommandIds = new Set(
    response.commandEnvelopes.map((row) => row.commandId),
  )
  const receiptKeys = new Set(
    response.commandReceipts.map((row) => `${row.commandId}\0${row.attempt}`),
  )
  if (envelopeCommandIds.size !== response.commandEnvelopes.length ||
      receiptKeys.size !== response.commandReceipts.length ||
      response.commandReceipts.some((row) => !envelopeCommandIds.has(row.commandId))) {
    throw new Error('authoritative_review_response_receipt_mismatch')
  }
  if (response.outcomes.some((row) =>
      row.commandId !== null && !envelopeCommandIds.has(row.commandId))) {
    throw new Error('authoritative_review_response_command_link_mismatch')
  }
  return {
    session: projectFocusSessionViewToCache(response.session),
    outcomes: response.outcomes.map(({ spaceId: _spaceId, ...row }) => row),
    envelopes: response.commandEnvelopes.map((row) => ({ ...row })),
    receipts: response.commandReceipts.map((row) => ({ ...row })),
  }
}

export type CachedSessionReview = ReturnType<typeof toReviewRows>

type ReviewExpectedVersionMode = 'exact' | 'import_rebased'

type ReviewDraftIdentityRow = {
  spaceId: string
  sessionId: string
  operationId: string
  draftJson: string
}

function parseExactBoundReviewRequest(requestJson: string): SessionReviewDraft {
  let request: SessionReviewDraft
  try {
    request = sessionReviewDraftSchema.parse(JSON.parse(requestJson))
  } catch {
    throw new Error('authoritative_review_bound_request_invalid')
  }
  if (canonicalize(request) !== requestJson) {
    throw new Error('authoritative_review_bound_request_invalid')
  }
  return request
}

function requireReviewDraftMatchesBoundRequest(
  row: ReviewDraftIdentityRow | undefined,
  spaceId: string,
  sessionId: string,
  boundRequest: SessionReviewDraft,
  expectedVersionMode: ReviewExpectedVersionMode,
  stage: 'apply' | 'delete',
): void {
  const error = `authoritative_review_draft_changed_before_${stage}`
  if (!row || row.spaceId !== spaceId || row.sessionId !== sessionId ||
      row.operationId !== boundRequest.operationId) {
    throw new Error(error)
  }
  let current: SessionReviewDraft
  try {
    current = sessionReviewDraftSchema.parse(JSON.parse(row.draftJson))
  } catch {
    throw new Error(error)
  }
  const { expectedVersion: currentExpectedVersion, ...currentBusiness } = current
  const { expectedVersion: boundExpectedVersion, ...boundBusiness } = boundRequest
  if (current.spaceId !== spaceId || current.sessionId !== sessionId ||
      current.operationId !== row.operationId ||
      canonicalize(current) !== row.draftJson ||
      canonicalize(currentBusiness) !== canonicalize(boundBusiness) ||
      (expectedVersionMode === 'exact' &&
        currentExpectedVersion !== boundExpectedVersion) ||
      (expectedVersionMode === 'import_rebased' && boundExpectedVersion <= 0)) {
    throw new Error(error)
  }
}

function requireAuthoritativeReviewTransaction(db: PomodoroXIDB): void {
  const transaction = Dexie.currentTransaction
  const requiredStoreNames = [
    'directCommandIntents', 'focusSessions', 'sessionWorkItemOutcomes',
    'sessionCommandEnvelopes', 'sessionCommandReceipts', 'sessionCommandQueue',
    'sessionReviewDrafts',
  ]
  if (!transaction || transaction.db !== db ||
      requiredStoreNames.some((name) => !transaction.storeNames.includes(name))) {
    throw new Error('authoritative_review_transaction_required')
  }
}

function latestReviewReceipt(
  receipts: FocusSessionAggregateView['commandReceipts'],
  commandId: string,
) {
  let latest: FocusSessionAggregateView['commandReceipts'][number] | undefined
  for (const receipt of receipts) {
    if (receipt.commandId === commandId &&
        (latest === undefined || receipt.attempt > latest.attempt)) {
      latest = receipt
    }
  }
  return latest
}

export async function applyAuthoritativeReviewAndClearDraft(
  db: PomodoroXIDB,
  spaceId: string,
  sessionId: string,
  boundRequestJson: string,
  expectedVersionMode: ReviewExpectedVersionMode,
  response: FocusSessionAggregateView,
): Promise<void> {
  requireAuthoritativeReviewTransaction(db)
  const boundRequest = parseExactBoundReviewRequest(boundRequestJson)
  const draft = await db.sessionReviewDrafts.get([spaceId, sessionId])
  requireReviewDraftMatchesBoundRequest(
    draft, spaceId, sessionId, boundRequest, expectedVersionMode, 'apply',
  )
  const rows = toReviewRows(response, spaceId, sessionId)
  await db.focusSessions.put(rows.session)
  await db.sessionWorkItemOutcomes.bulkPut(rows.outcomes)
  await db.sessionCommandEnvelopes.bulkPut(rows.envelopes)
  await db.sessionCommandReceipts.bulkPut(rows.receipts)
  for (const envelope of rows.envelopes) {
    const receipt = latestReviewReceipt(rows.receipts, envelope.commandId)
    const envelopeJson = canonicalize(envelope)
    if (envelopeJson === undefined) {
      throw new Error('authoritative_review_envelope_not_canonical')
    }
    await db.sessionCommandQueue.put({
      commandId: envelope.commandId, spaceId, sessionId,
      payloadHash: envelope.payloadHash, replaySafe: envelope.replaySafe,
      envelopeJson,
      state: !receipt || ['pending', 'unknown'].includes(receipt.state)
        ? 'held' : 'terminal',
      lastReceiptState: receipt?.state ?? 'pending',
      createdAt: envelope.createdAt, updatedAt: canonicalNow(),
    })
  }
  const currentDraft = await db.sessionReviewDrafts.get([spaceId, sessionId])
  requireReviewDraftMatchesBoundRequest(
    currentDraft, spaceId, sessionId, boundRequest, expectedVersionMode, 'delete',
  )
  await db.sessionReviewDrafts.delete([spaceId, sessionId])
}

export class FocusSessionRepository {
private async holdProvisionalReviewDraftUntilImport(
  input: SessionReviewDraft,
  staleSession: CachedFocusSession,
): Promise<CachedSessionReview> {
  if (input.spaceId !== this.spaceId || input.sessionId !== staleSession.sessionId) {
    throw new Error('provisional_review_space_or_session_mismatch')
  }
  const candidates = await this.meta.provisionalOperations
    .where('sessionId').equals(input.sessionId)
    .and((row) => row.spaceId === this.spaceId &&
      row.deviceId === this.identity.deviceId && row.tabId === this.identity.tabId &&
      row.state === 'awaiting_s4')
    .toArray()
  if (candidates.length !== 1) throw new Error('provisional_review_import_not_pending')
  const rootOperationId = candidates[0]!.operationId
  return this.provisionalLock.run(rootOperationId, async () => {
    const operation = await this.meta.provisionalOperations.get(rootOperationId)
    const tab = await this.meta.sessionTabs.get(this.identity.tabId)
    const current = await this.requireSession(input.sessionId)
    const draft = await this.db.sessionReviewDrafts.get([this.spaceId, input.sessionId])
    const outcomeCount = await this.db.sessionWorkItemOutcomes
      .where('sessionId').equals(input.sessionId).count()
    const heldOutcomeCount = await this.db.outbox
      .where('compoundOperationId').equals(rootOperationId)
      .and((row) => row.entityType === 'sessionWorkItemOutcome').count()
    const directIntent = await this.db.directCommandIntents.get(input.operationId)
    if (!operation || operation.spaceId !== this.spaceId ||
        operation.sessionId !== input.sessionId || operation.state !== 'awaiting_s4' ||
        operation.deviceId !== this.identity.deviceId ||
        operation.tabId !== this.identity.tabId || !tab ||
        tab.deviceId !== this.identity.deviceId || tab.closedAt !== null ||
        current.endedAt === null || current.clockState !== 'ended' ||
        current.ownershipState !== 'local_provisional' ||
        current.validity !== 'pending' || current.reviewState !== 'pending' ||
        !draft || draft.operationId !== input.operationId ||
        outcomeCount !== 0 || heldOutcomeCount !== 0 || directIntent !== undefined) {
      throw new Error('provisional_review_import_boundary_mismatch')
    }
    return {
      session: current, outcomes: [], commandEnvelopes: [], commandReceipts: [],
    }
  })
}

async submitReview(input: SessionReviewDraft): Promise<CachedSessionReview> {
  if (!input.operationId) throw new Error('review_operation_id_required')
  if (input.spaceId !== this.spaceId) throw new Error('space_scope_mismatch')
  await requirePersistedExactSessionReviewDraft(this.db, input)
  const cached = await this.requireSession(input.sessionId)
  assertLocalContentWritable(cached)
  if (cached.ownershipState === 'local_provisional') {
    if (cached.endedAt === null || cached.clockState !== 'ended') {
      throw new Error('provisional_review_requires_terminal_session')
    }
    return this.holdProvisionalReviewDraftUntilImport(input, cached)
  }
  const intent = await prepareDirectCommandIntent(this.db, {
    kind: 'submit_review', spaceId: input.spaceId, targetId: input.sessionId,
    request: input, now: canonicalNow(),
  }, input.operationId)
  const response = await executeDurableDirectCommand({
    db: this.db, intent,
    businessTables: [
      this.db.focusSessions, this.db.sessionWorkItemOutcomes,
      this.db.sessionCommandEnvelopes, this.db.sessionCommandReceipts,
      this.db.sessionCommandQueue, this.db.sessionReviewDrafts,
    ],
    sendExactRequest: (request) => focusSessionApi.submitReview(request),
    parseResult: (value) => focusSessionAggregateSchema.parse(value),
    applyResult: (authoritative) => applyAuthoritativeReviewAndClearDraft(
      this.db, this.spaceId, input.sessionId, intent.requestJson, 'exact', authoritative,
    ),
    now: canonicalNow,
  })
  return toReviewRows(response, this.spaceId, input.sessionId)
}
}
```

`holdProvisionalReviewDraftUntilImport` acquires the ended Session's own
operation lock and rechecks the exact composite Meta row in `awaiting_s4` plus
device/Tab identity. It is deliberately read-only: the Session stays ended,
`local_provisional`, `validity=pending`, and `reviewState=pending`; the original
Session/Context/Attribution/Plan held batch is byte-for-byte unchanged; there is
no Outcome or review Outbox row; no direct-command intent exists yet; and the
complete structured draft plus its fixed review operation ID remain durable.
S4 imports only that original held batch. Its post-transport recovery handoff
waits for exact `meta_reconciled` all-applied terminal evidence, matching Meta
`transport_resolved` hashes, the expected FocusSession child, and the
authoritative imported Session version before it creates the TS2/S3 review
intent from the original draft. A response-loss restart validates and reuses an
existing prepared/in-flight request and its original CAS before consulting any
newer local Session version. Only the authoritative review response writes
Outcomes, marks the review complete, and deletes the draft. Online review and
S4 recovery both call the same `applyAuthoritativeReviewAndClearDraft`; no
second inline apply path remains. Its `toReviewRows` validator binds the full
aggregate's Session, optional context, attribution, plans, Outcomes, and
envelopes to the expected Space/Session and rejects any receipt whose command
ID, or any nonnull Outcome command ID, is absent from that response's unique
envelope set before projection or the first write. The helper parses the exact
canonical request JSON owned by the durable direct intent. Before business
writes and again immediately before delete, it parses the current draft and
requires canonical equality of operation/Space/Session and every review
business field; only the imported path may differ on `expectedVersion`. It also
requires `Dexie.currentTransaction` to belong to the same database and include
the intent, Session, Outcome, envelope, receipt, queue, and review-draft stores.
Draft deletion remains the helper's final write. A newer active
Session may coexist because the old `awaiting_s4` operation no longer occupies
the active claim slot. Existing authoritative Outcome rows are never deleted
when a later correction arrives; the UI selects `effective=true` for the current
review while separately listing every unresolved older envelope.

- [ ] **Step 5: Implement Outcome review and per-command receipt UI**

```tsx
// frontend/src/components/timer/command-receipt-list.tsx
export function CommandReceiptList({ envelopes, receipts, onReconcile, onAbandon }: Props) {
  return (
    <ul aria-label="Work item command results" className="divide-y">
      {envelopes.map((envelope) => {
        const receipt = latestReceipt(receipts, envelope.commandId)
        const receiptState = receipt?.state ?? 'pending'
        return (
          <li key={envelope.commandId} className="flex min-h-12 items-center gap-3 py-2">
            <ReceiptStateIcon state={receipt?.state ?? 'pending'} />
            <span className="min-w-0 flex-1 truncate">{envelope.targetTransition}</span>
            <span className="text-sm">{receiptLabel(receiptState)}</span>
            {receiptState === 'unknown' ? <>
              <Button variant="outline" aria-label={`Query ${envelope.commandId}`}
                onClick={() => onReconcile(envelope.commandId, false)}>
                Query original result
              </Button>
              {envelope.replaySafe ?
                <Button aria-label={`Retry ${envelope.commandId}`}
                  onClick={() => onReconcile(envelope.commandId, true)}>
                  Retry original command
                </Button> : null}
            </> : null}
            {receiptState === 'unknown' || receiptState === 'pending' ?
              <Button variant="outline" aria-label={`Abandon ${envelope.commandId}`}
                onClick={() => onAbandon(envelope.commandId)}>
                Abandon command
              </Button> : null}
          </li>
        )
      })}
    </ul>
  )
}
```

`session-review.tsx` captures validity, review state, one Outcome per planned L3, reversible completion draft, result, and explicit `stateCommand`. It always displays focused time from terminal Session facts. Receipt `failed`, `conflict`, and `unknown` never hide successful siblings.

- [ ] **Step 6: Prove locator release is independent of review completion**

```typescript
// append to frontend/src/components/timer/session-review.test.tsx
it('allows a new Session while an older review and command remain pending', () => {
  useTimerStore.setState({ locator: null, session: null, ownershipMode: 'none' })
  useFocusSessionStore.setState({
    reviewDraft: reviewDraft({ sessionId: 'ended-old' }),
    sessions: [endedSession({ sessionId: 'ended-old' })],
  })
  expect(() => useTimerStore.getState().assertCanStart('space-a')).not.toThrow()
  expect(useFocusSessionStore.getState().reviewDraft?.sessionId).toBe('ended-old')
})
```

- [ ] **Step 7: Run review, partial receipt, type, and lint gates**

Run from `frontend/`:

```powershell
npm run test -- --run src/lib/focus-session/session-review-draft-registry.test.ts src/lib/direct-command-intents.test.ts src/lib/focus-session/command-reconciliation.test.ts src/components/timer/session-review.test.tsx src/components/timer/command-receipt-list.test.tsx src/lib/focus-session/focus-session-repository.test.ts src/stores/focus-session-store.test.ts
npm run typecheck
npm run lint -- src/lib/direct-command-intents.ts src/lib/focus-session/session-review-draft-registry.ts src/lib/focus-session/command-reconciliation.ts src/components/timer/session-review.tsx src/components/timer/command-receipt-list.tsx
```

Expected: PASS; a review draft and fixed operation ID persist before transport. An ended provisional Session remains pending and its held batch is unchanged until S4 imports it; no Outcome, review Outbox row, or direct intent exists before that handoff. For an already authoritative Session, server-commit/response-loss/restart resends the same TS2/S3 POST without S4 query and atomically clears the draft on success. Time is visible before commands settle, successes survive sibling failure, unknown envelope commands query first, envelopes never change, and a new Session can start after terminal release while old review/import remains pending.

The authoritative apply tests also mutate every aggregate Space/Session edge,
foreign receipt and Outcome command links, and same-operation draft business
fields while the response is in flight. They require zero partial business
writes, retain the changed draft, and prove the shared helper rejects both no
transaction and each missing required transaction store before its first read.

- [ ] **Step 8: Commit review and command reconciliation**

```powershell
git add -- frontend/src/lib/focus-session/session-review-draft-registry.ts frontend/src/lib/focus-session/session-review-draft-registry.test.ts frontend/src/lib/focus-session/command-reconciliation.ts frontend/src/lib/focus-session/command-reconciliation.test.ts frontend/src/components/timer/session-review.tsx frontend/src/components/timer/session-review.test.tsx frontend/src/components/timer/command-receipt-list.tsx frontend/src/components/timer/command-receipt-list.test.tsx frontend/src/lib/focus-session/focus-session-repository.ts frontend/src/lib/focus-session/focus-session-repository.test.ts frontend/src/stores/focus-session-store.ts 'frontend/src/app/(app)/timer/page.tsx'
git commit -m "feat(frontend): review session command outcomes"
```

---

### Task 10: Make Space Switch And Logout Flush-Critical While Preserving The Global Session

**Files:**
- Modify: `frontend/src/services/space-db.ts`
- Modify: `frontend/src/services/space-db.test.ts`
- Modify: `frontend/src/stores/space-store.ts`
- Modify: `frontend/src/stores/space-store.test.ts`
- Modify: `frontend/src/stores/index.ts`
- Modify: `frontend/src/stores/stores-index.test.ts`
- Modify: `frontend/src/lib/on-space-switch.tsx`
- Modify: `frontend/src/lib/on-space-switch.test.tsx`
- Modify: `frontend/src/lib/logout.ts`
- Modify: `frontend/src/lib/logout.test.ts`
- Modify: `frontend/src/services/meta-database.ts`
- Modify: `frontend/src/services/meta-database.test.ts`
- Create: `frontend/src/components/timer/global-active-session-bar.tsx`
- Create: `frontend/src/components/timer/global-active-session-bar.test.tsx`
- Modify: `frontend/src/components/layout/app-shell.tsx`

**Interfaces:**
- Consumes: Task 3 Note/direct-intent durability; Task 8 structured Timer composer forced flush; Task 9 review-draft flush; Task 6 Session-draft flush; Task 7 global timer/coordinator and Master-scope old-Space actions.
- Produces: rejecting `SpaceDBManager.runBeforeSwitchListeners`; transactionally ordered `selectSpace`; `SPACE_SCOPED_RESET_FNS` and `LOGOUT_GLOBAL_RESET_FNS`; persistent global active bar and return action; logout that clears global state only after critical flush.

- [ ] **Step 1: Replace the current ignored-failure tests with fail-fast flush tests**

```typescript
// replace permissive cases in frontend/src/services/space-db.test.ts
it('aborts switching and preserves the old DB when a critical flush rejects', async () => {
  await spaceDBManager.switchTo('space-a')
  const previous = spaceDBManager.current
  const unsubscribe = spaceDBManager.onBeforeSwitch(async () => {
    throw new Error('note flush failed')
  })
  await expect(spaceDBManager.switchTo('space-b')).rejects.toThrow('note flush failed')
  expect(spaceDBManager.currentSpaceId).toBe('space-a')
  expect(spaceDBManager.current).toBe(previous)
  unsubscribe()
})

it('flushes the old Space Timer composer before opening the target database', async () => {
  const fixture = await spaceSwitchWithTimerDraftFixture('space-a', 'wi-a', 'Draft A')
  await fixture.selectSpace('space-b')
  expect(fixture.order).toEqual([
    'persist:space-a:wi-a', 'close:space-a', 'open:space-b', 'commit-token:space-b',
  ])
  expect(await fixture.readTimerDraft('space-a', 'wi-a'))
    .toEqual(paragraphComposerDraft('Draft A'))
})

it('awaits every listener but reports all rejected flushes', async () => {
  await spaceDBManager.switchTo('space-a')
  const completed: string[] = []
  const first = spaceDBManager.onBeforeSwitch(async () => { completed.push('note'); throw new Error('note') })
  const second = spaceDBManager.onBeforeSwitch(async () => { completed.push('session'); throw new Error('session') })
  await expect(spaceDBManager.switchTo('space-b')).rejects.toThrow(AggregateError)
  expect(completed.sort()).toEqual(['note', 'session'])
  first(); second()
})
```

- [ ] **Step 2: Write failing token-order, reset-scope, and old-Space action tests**

```typescript
// append to frontend/src/stores/space-store.test.ts
it('does not install target token or Space when old-Space flush fails', async () => {
  tokenStorage.setCurrentSpaceId('space-a')
  tokenStorage.setSpaceToken('token-a')
  issueToken.mockResolvedValue('token-b')
  switchTo.mockRejectedValue(new Error('flush failed'))
  await expect(useSpaceStore.getState().selectSpace('space-b')).rejects.toThrow('flush failed')
  expect(tokenStorage.getCurrentSpaceId()).toBe('space-a')
  expect(tokenStorage.getSpaceToken()).toBe('token-a')
})
```

```typescript
// frontend/src/components/timer/global-active-session-bar.test.tsx
it('uses the global Adapter to pause an old-Space Session', () => {
  const pause = vi.fn()
  render(<GlobalActiveSessionBar locator={locator({ spaceId: 'space-old' })}
    currentSpaceId="space-new" ownershipMode="owner" onPause={pause} onReturn={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Pause active session' }))
  expect(pause).toHaveBeenCalledOnce()
})
```

- [ ] **Step 3: Run lifecycle tests and verify permissive switching fails expectations**

Run from `frontend/`:

```powershell
npm run test -- --run src/services/space-db.test.ts src/stores/space-store.test.ts src/stores/stores-index.test.ts src/lib/on-space-switch.test.tsx src/lib/logout.test.ts src/components/timer/global-active-session-bar.test.tsx
```

Expected: FAIL because `Promise.allSettled` results are ignored, target credentials are installed before switch success, timer is reset on Space switch, and the global active bar does not exist.

- [ ] **Step 4: Convert before-switch listeners into an awaited rejection barrier**

```typescript
// frontend/src/services/space-db.ts
private async runBeforeSwitchListeners(context: BeforeSpaceSwitchContext): Promise<void> {
  const results = await Promise.allSettled(
    Array.from(this.beforeSwitchListeners, (listener) =>
      Promise.resolve().then(() => listener(context)),
    ),
  )
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  )
  if (failures.length !== 0) {
    throw new AggregateError(failures, `critical Space flush failed for ${context.fromSpaceId}`)
  }
}
```

After that barrier, `switchTo` uses this exact order:

```typescript
const previous = this.current
await this.runBeforeSwitchListeners({ fromSpaceId: this.currentSpaceId!, database: previous })
const target = await openPomodoroXIDB(nextSpaceId)
this.current = target
this.currentSpaceId = nextSpaceId
previous.close()
```

The old database is therefore open while every Note and Session draft flushes,
and it closes only after all `Promise.allSettled` results are fulfilled and the
target database has opened. Any flush or target-open rejection leaves the old
handle, pointer, credentials, and Space event untouched. `flushBeforeClose`
uses the same rejection barrier for logout.

- [ ] **Step 5: Commit credentials only after database transition succeeds**

```typescript
// replace selectSpace core in frontend/src/stores/space-store.ts
selectSpace: async (spaceId, spacePassword) => {
  set({ isLoading: true, error: null })
  try {
    const targetToken = await get().issueSpaceToken(spaceId, spacePassword)
    await spaceDBManager.switchTo(spaceId, { dispatchEvent: false })
    tokenStorage.setSpaceToken(targetToken)
    tokenStorage.setCurrentSpaceId(spaceId)
    set({ currentSpaceId: spaceId, spaceToken: targetToken, isLoading: false })
    useBootstrapStore.getState().setReady()
    window.dispatchEvent(new CustomEvent(PXII_SPACE_SWITCHED_EVENT, { detail: { spaceId } }))
  } catch (error) {
    set({ isLoading: false, error: (error as Error).message })
    throw error
  }
},
```

The issued target token remains only in a local variable until old-Space durability succeeds. A failed target DB open also preserves old credentials and DB.

- [ ] **Step 6: Separate Space-scoped reset from logout-global reset**

```typescript
// frontend/src/stores/index.ts
export const SPACE_SCOPED_RESET_ORDER = [
  'sync', 'focus-session', 'task-space', 'note', 'quick-note', 'folder',
  'habit', 'schedule', 'time-block', 'reflection', 'stats', 'search',
  'trash', 'settings', 'ui', 'app',
] as const

export const SPACE_SCOPED_RESET_FNS = [
  () => useSyncStore.getState().reset(),
  () => useFocusSessionStore.getState().reset(),
  () => useTaskSpaceStore.getState().reset(),
  () => useNoteStore.getState().reset(),
  () => useQuickNoteStore.getState().reset(),
  () => useFolderStore.getState().reset(),
  () => useHabitStore.getState().reset(),
  () => useScheduleStore.getState().reset(),
  () => useTimeBlockStore.getState().reset(),
  () => useReflectionStore.getState().reset(),
  () => useStatsStore.getState().reset(),
  () => useSearchStore.getState().reset(),
  () => useTrashStore.getState().reset(),
  () => useSettingsStore.getState().reset(),
  () => useUIStore.getState().reset(),
  () => useAppStore.getState().reset(),
]

export const LOGOUT_GLOBAL_RESET_FNS = [
  ...SPACE_SCOPED_RESET_FNS,
  () => useTimerStore.getState().reset(),
]
```

```typescript
// append to frontend/src/services/meta-database.ts
async clearForLogout(): Promise<void> {
  await this.transaction(
    'rw', this.spaces, this.activeSessionLocator, this.sessionTabs,
    this.provisionalOperations,
    async () => {
      await Promise.all([
        this.spaces.clear(), this.activeSessionLocator.clear(),
        this.sessionTabs.clear(), this.provisionalOperations.clear(),
      ])
    },
  )
}
```

`SpaceSwitchProvider` uses only `SPACE_SCOPED_RESET_FNS`, then refreshes the global coordinator. `performLogout` uses `LOGOUT_GLOBAL_RESET_FNS` after `flushBeforeClose`, calls `metaDB.clearForLogout()`, and clears tokens last. Stable device identity is intentionally retained; locator, Tab, and provisional operation mirrors clear only after the critical flush succeeds.

- [ ] **Step 7: Register Note, structured Timer composer, review, and Session forced flushes against the old DB handle**

```typescript
// mounted once by the Task Space/Timer repository composition
const removeNoteFlush = spaceDBManager.onBeforeSwitch(async ({ database }) => {
  await noteAutosaveRegistry.flushDatabase(database, 'space-switch')
})
const removeTimerComposerFlush = spaceDBManager.onBeforeSwitch(async ({ database }) => {
  await timerNoteComposerDraftRegistry.flushDatabase(database, 'space-switch')
})
const removeReviewDraftFlush = spaceDBManager.onBeforeSwitch(async ({ database }) => {
  await sessionReviewDraftRegistry.flushDatabase(database, 'space-switch')
})
const removeSessionFlush = spaceDBManager.onBeforeSwitch(async ({ database }) => {
  await sessionDraftRegistry.flushDatabase(database, 'space-switch')
})
```

Each registry keys controllers by `database.name`, not by current global proxy, so the callback writes the old Space even after a target has been requested. Cleanup removes all four listeners on provider unmount.

- [ ] **Step 8: Add the compact global active bar without current-token switching**

```tsx
// frontend/src/components/timer/global-active-session-bar.tsx
export function GlobalActiveSessionBar(props: Props) {
  if (!props.locator) return null
  const foreign = props.locator.spaceId !== props.currentSpaceId
  return (
    <aside aria-label="Global active session" className="flex min-h-10 items-center gap-2 border-b px-3">
      <Timer aria-hidden="true" className="size-4" />
      <span className="min-w-0 flex-1 truncate">
        {foreign ? `Session running in ${props.ownerSpaceName}` : props.sessionTitle}
      </span>
      {props.ownershipMode === 'read_only' ?
        <Button variant="outline" onClick={props.onTakeover}>Take over</Button> :
        <Button size="icon-sm" variant="ghost" aria-label="Pause active session" onClick={props.onPause}>
          <Pause aria-hidden="true" />
        </Button>}
      {foreign ? <Button variant="outline" onClick={props.onReturn}>Return to Space</Button> : null}
    </aside>
  )
}
```

Mount it in `AppShell` below the header. Pause/end/takeover callbacks call Task 7's Master-scope coordinator. `Return to Space` invokes the normal guarded `selectSpace`, including critical flushes.

- [ ] **Step 9: Run Space switch, logout, global bar, type, and lint gates**

Run from `frontend/`:

```powershell
npm run test -- --run src/services/space-db.test.ts src/stores/space-store.test.ts src/stores/stores-index.test.ts src/lib/on-space-switch.test.tsx src/lib/logout.test.ts src/components/timer/global-active-session-bar.test.tsx src/lib/task-space/note-autosave-controller.test.ts
npm run typecheck
npm run lint -- src/services/space-db.ts src/stores/space-store.ts src/stores/index.ts src/lib/on-space-switch.tsx src/lib/logout.ts src/components/timer/global-active-session-bar.tsx
```

Expected: PASS; a failed critical flush leaves old DB/token/Space intact, timer locator survives a successful switch, and old-Space business actions use the global Adapter.

- [ ] **Step 10: Commit critical Space lifecycle and global locator UI**

```powershell
git add -- frontend/src/services/space-db.ts frontend/src/services/space-db.test.ts frontend/src/stores/space-store.ts frontend/src/stores/space-store.test.ts frontend/src/stores/index.ts frontend/src/stores/stores-index.test.ts frontend/src/lib/on-space-switch.tsx frontend/src/lib/on-space-switch.test.tsx frontend/src/lib/logout.ts frontend/src/lib/logout.test.ts frontend/src/services/meta-database.ts frontend/src/services/meta-database.test.ts frontend/src/components/timer/global-active-session-bar.tsx frontend/src/components/timer/global-active-session-bar.test.tsx frontend/src/components/layout/app-shell.tsx
git commit -m "fix(frontend): make Space draft flushes critical"
```

---

### Task 11: Reconcile Offline Provisional Starts And Require Explicit Activation-Conflict Resolution

**Files:**
- Modify: `frontend/src/lib/contracts/focus-session.ts`
- Modify: `frontend/src/lib/contracts/focus-session.test.ts`
- Modify: `frontend/src/services/active-session-api.ts`
- Modify: `frontend/src/services/active-session-api.test.ts`
- Modify: `frontend/src/lib/focus-session/active-session-coordinator.ts`
- Modify: `frontend/src/lib/focus-session/active-session-coordinator.test.ts`
- Create: `frontend/src/lib/focus-session/online-reconciliation-provider.tsx`
- Create: `frontend/src/lib/focus-session/online-reconciliation-provider.test.tsx`
- Create: `frontend/src/components/timer/activation-conflict-dialog.tsx`
- Create: `frontend/src/components/timer/activation-conflict-dialog.test.tsx`
- Modify: `frontend/src/stores/stats-store.ts`
- Modify: `frontend/src/stores/business-stores.test.ts`
- Modify: `frontend/src/app/providers.tsx`
- Modify: `frontend/src/components/layout/app-shell.tsx`

**Interfaces:**
- Consumes: Task 2 Meta provisional operation and per-Space conflict tables; Task 6 recoverable provisional Session; Task 7 coordinator; TS2 activation outcomes `authoritative`, `resumed`, and `activation_conflict`.
- Produces: strict `activationResolutionSchema`; reconnect reconciliation; `ActivationConflictDialog`; `selectEffortEligibleSessions`; role-keyed explicit winner selection; atomic authoritative activation cache plus exact pristine held-outbox consumption; held command/outbox state and preserved dual records until resolution.

- [ ] **Step 1: Write failing no-locator, same-Session, competing-Session, and effort-exclusion tests**

```typescript
// append to frontend/src/lib/focus-session/active-session-coordinator.test.ts
it('promotes a provisional Session when no authoritative locator exists', async () => {
  const fixture = provisionalCoordinatorFixture({ serverOutcome: 'authoritative' })
  await fixture.coordinator.reconcileProvisional('offline-op-1')
  expect(fixture.api.activateProvisional).toHaveBeenCalledOnce()
  expect(await fixture.meta.provisionalOperations.get('offline-op-1')).toMatchObject({
    state: 'resolved',
  })
  expect(fixture.timerState().ownershipMode).toBe('owner')
})

it('resumes the same provisional Session after epoch validation', async () => {
  const fixture = provisionalCoordinatorFixture({ serverOutcome: 'resumed', ownershipEpoch: 3 })
  await fixture.coordinator.reconcileProvisional('offline-op-1')
  expect(fixture.timerState()).toMatchObject({ ownershipMode: 'owner', ownershipEpoch: 3 })
  expect(await fixture.spaceDb.focusSessions.count()).toBe(1)
})

it('leaves an ended provisional Session held for S4 without activating it', async () => {
  const fixture = provisionalCoordinatorFixture({
    localSessionEnded: true, metaState: 'pending',
    provisionalOutbox: 'activation_snapshot',
  })
  await fixture.coordinator.reconcileProvisional('offline-op-1')
  expect(fixture.api.activateProvisional).not.toHaveBeenCalled()
  expect(await fixture.meta.provisionalOperations.get('offline-op-1'))
    .toMatchObject({ state: 'awaiting_s4' })
  expect(await absorbedActivationOutboxRows(fixture.spaceDb)).toHaveLength(4)
  expect((await absorbedActivationOutboxRows(fixture.spaceDb)).every(
    (row) => row.transportState === 'awaiting_s4',
  )).toBe(true)
})

it('includes a local write that acquired the operation lock before activation', async () => {
  const fixture = provisionalCoordinatorFixture({ serverOutcome: 'authoritative' })
  fixture.operationLock.pauseHolderAfterAcquire()
  const write = fixture.repository.updateSessionNote('offline-1', 'Before snapshot')
  await fixture.operationLock.waitUntilHeld()
  const reconcile = fixture.coordinator.reconcileProvisional('offline-op-1')
  fixture.operationLock.releaseHolder()
  await write
  await reconcile
  expect(fixture.api.activateProvisional).toHaveBeenCalledWith(expect.objectContaining({
    payload: expect.objectContaining({ snapshot: expect.objectContaining({
      session: expect.objectContaining({ sessionNote: 'Before snapshot' }),
    }) }),
  }))
})

it('rejects a local write queued after activation acquires the operation lock', async () => {
  const fixture = provisionalCoordinatorFixture({
    serverOutcome: 'authoritative', deferActivationResponse: true,
  })
  const reconcile = fixture.coordinator.reconcileProvisional('offline-op-1')
  await fixture.api.waitUntilActivateProvisionalCalled()
  const write = fixture.repository.updateSessionNote('offline-1', 'After snapshot')
  fixture.api.resolveDeferredActivation()
  await reconcile
  await expect(write).rejects.toThrow('active_session_not_owned')
  expect(await fixture.spaceDb.focusSessions.get('offline-1')).not.toMatchObject({
    sessionNote: 'After snapshot',
  })
})

it.each(['authoritative', 'resumed'] as const)(
  'atomically caches %s activation and consumes only its pristine held snapshot rows',
  async (serverOutcome) => {
    const fixture = provisionalCoordinatorFixture({
      serverOutcome, provisionalOutbox: 'activation_snapshot',
      unrelatedOutbox: heldCreateOutbox('workItemNote', 'unrelated-note'),
    })
    expect((await absorbedActivationOutboxRows(fixture.spaceDb)).map(
      (row) => `${row.entityType}:${row.entityId}`,
    )).toEqual([
      'focusSession:offline-1',
      'sessionTaskContext:offline-1',
      'sessionAttributionRevision:offline-attribution-1',
      'sessionWorkItemPlan:offline-plan-1',
    ])

    await fixture.coordinator.reconcileProvisional('offline-op-1')

    expect(await absorbedActivationOutboxRows(fixture.spaceDb)).toEqual([])
    expect(await fixture.spaceDb.outbox.where('entityId').equals('unrelated-note').count()).toBe(1)
    expect(await fixture.spaceDb.focusSessions.get('offline-1')).toMatchObject({
      ownershipState: 'authoritative', version: expect.any(Number),
    })
    expect(await fixture.meta.provisionalOperations.get('offline-op-1'))
      .toMatchObject({ state: 'resolved' })
  },
)

it.each([
  ['sent', { attemptCount: 1 }],
  ['unknown result', { attemptCount: 1, lastErrorCode: 'unknown_result' }],
  ['unexpected state', { transportState: 'ready' }],
] as const)(
  'fails closed and preserves an absorbed %s outbox row',
  async (_case, unsafePatch) => {
    const fixture = provisionalCoordinatorFixture({
      serverOutcome: 'authoritative', provisionalOutbox: 'activation_snapshot',
    })
    const sessionOutbox = await fixture.spaceDb.outbox
      .where('entityId').equals('offline-1')
      .and((row) => row.entityType === 'focusSession').first()
    await fixture.spaceDb.outbox.update(sessionOutbox!.id!, unsafePatch)
    const localBefore = await fixture.spaceDb.focusSessions.get('offline-1')

    await expect(fixture.coordinator.reconcileProvisional('offline-op-1'))
      .rejects.toThrow('authoritative_activation_outbox_not_consumable')

    expect(await fixture.spaceDb.focusSessions.get('offline-1')).toEqual(localBefore)
    expect(await absorbedActivationOutboxRows(fixture.spaceDb)).toHaveLength(4)
    expect(await fixture.meta.provisionalOperations.get('offline-op-1'))
      .not.toMatchObject({ state: 'resolved' })
  },
)

it.each(['authoritative', 'resumed'] as const)(
  'recovers %s after Space apply commits but before Meta resolves',
  async (serverOutcome) => {
    const fixture = provisionalCoordinatorFixture({
      serverOutcome, provisionalOutbox: 'activation_snapshot',
    })
    await fixture.applyServerResultToSpaceOnly('offline-op-1')
    expect(await fixture.spaceDb.sessionActivationApplications.get('offline-op-1'))
      .toMatchObject({ resultKind: serverOutcome, provisionalSpaceId: 'space-offline' })
    expect(await absorbedActivationOutboxRows(fixture.spaceDb)).toEqual([])
    expect(await fixture.meta.provisionalOperations.get('offline-op-1'))
      .toMatchObject({ state: 'activating' })

    const restarted = fixture.restartCoordinator()
    await restarted.reconcileProvisional('offline-op-1')

    expect(fixture.api.activateProvisional).not.toHaveBeenCalled()
    expect(await fixture.meta.provisionalOperations.get('offline-op-1'))
      .toMatchObject({ state: 'resolved' })
    expect(fixture.timerState().locator).toMatchObject({
      spaceId: 'space-offline', sessionId: 'offline-1',
    })
  },
)

it('recovers a conflict after Space apply commits but before Meta conflict state', async () => {
  const fixture = provisionalCoordinatorFixture({
    serverOutcome: 'activation_conflict', provisionalOutbox: 'activation_snapshot',
  })
  await fixture.applyServerResultToSpaceOnly('offline-op-1')
  expect(await fixture.spaceDb.sessionActivationApplications.get('offline-op-1'))
    .toMatchObject({ resultKind: 'activation_conflict' })
  expect((await absorbedActivationOutboxRows(fixture.spaceDb)).every(
    (row) => row.transportState === 'blocked_conflict',
  )).toBe(true)

  await fixture.restartCoordinator().reconcileProvisional('offline-op-1')

  expect(fixture.api.activateProvisional).not.toHaveBeenCalled()
  expect(await fixture.meta.provisionalOperations.get('offline-op-1'))
    .toMatchObject({ state: 'conflict' })
  expect(fixture.timerState().activationConflict).not.toBeNull()
})

it('accepts an identical Space result retry but rejects a different result hash', async () => {
  const fixture = provisionalCoordinatorFixture({
    serverOutcome: 'authoritative', provisionalOutbox: 'activation_snapshot',
  })
  const result = fixture.serverResult()
  await fixture.applyServerResultToSpaceOnly('offline-op-1', result)
  const receipt = await fixture.spaceDb.sessionActivationApplications.get('offline-op-1')
  await fixture.applyServerResultToSpaceOnly('offline-op-1', result)
  expect(await fixture.spaceDb.sessionActivationApplications.toArray()).toEqual([receipt])
  await expect(fixture.applyServerResultToSpaceOnly(
    'offline-op-1', activationResult({ ...result, ownershipEpoch: result.ownershipEpoch + 1 }),
  )).rejects.toThrow('activation_application_receipt_mismatch')
})

it.each(['missing', 'hash_mismatch'] as const)(
  'preserves activating state when the Space receipt is %s',
  async (receiptFault) => {
    const fixture = provisionalCoordinatorFixture({
      serverOutcome: 'authoritative', metaState: 'activating', receiptFault,
    })
    await expect(fixture.restartCoordinator().reconcileProvisional('offline-op-1'))
      .rejects.toThrow('activation_application_recovery_error')
    expect(fixture.api.activateProvisional).not.toHaveBeenCalled()
    expect(await fixture.meta.provisionalOperations.get('offline-op-1'))
      .toMatchObject({ state: 'activating' })
  },
)

it('restores a same-ID cross-Space conflict from locate after reload', async () => {
  const fixture = provisionalCoordinatorFixture({
    serverOutcome: 'activation_conflict', persistedConflict: true,
    activeSpaceId: 'space-online', candidateSpaceId: 'space-offline',
    activeSessionId: 'shared-1', candidateSessionId: 'shared-1',
  })
  fixture.api.locate.mockResolvedValue(sameIdCrossSpaceActivationConflict())
  await fixture.coordinator.bootstrap()
  expect(fixture.timerState().locator).toMatchObject({
    spaceId: 'space-online', sessionId: 'shared-1',
  })
  expect(fixture.timerState().activationConflict).toMatchObject({
    provisionalOperationId: 'offline-op-1',
    active: { spaceId: 'space-online', sessionId: 'shared-1' },
    candidate: { spaceId: 'space-offline', sessionId: 'shared-1' },
    selectedRole: null,
  })
  expect(screenForShell(fixture).getByRole('dialog', {
    name: 'Choose the session to continue',
  })).toBeVisible()
})

it('preserves both competing Sessions and blocks held outbox plus commands', async () => {
  const fixture = provisionalCoordinatorFixture({
    serverOutcome: 'activation_conflict', provisionalOutbox: 'activation_snapshot',
  })
  await fixture.coordinator.reconcileProvisional('offline-op-1')
  expect(await fixture.spaceDb.sessionActivationConflicts.count()).toBe(1)
  expect(await fixture.spaceDb.focusSessions.get('offline-1')).toMatchObject({
    ownershipState: 'activation_conflict', validity: 'pending',
  })
  const absorbedRows = await absorbedActivationOutboxRows(fixture.spaceDb)
  expect(absorbedRows).toHaveLength(4)
  expect(absorbedRows.every((row) => row.transportState === 'blocked_conflict')).toBe(true)
  expect(await fixture.spaceDb.sessionCommandQueue.filter((row) => row.state !== 'held').count()).toBe(0)
})

it.each([
  ['candidate', 0],
  ['active', 4],
] as const)(
  'applies the %s winner without releasing unrelated blocked rows',
  async (selectedRole, expectedCandidateRows) => {
    const fixture = provisionalCoordinatorFixture({
      serverOutcome: 'activation_conflict', provisionalOutbox: 'activation_snapshot',
    })
    await fixture.coordinator.reconcileProvisional('offline-op-1')
    fixture.api.resolveActivationConflict.mockResolvedValue(selectedRole === 'candidate'
      ? resolvedActivation('space-offline', 'offline-1')
      : resolvedActivation('space-online', 'online-1'))

    await fixture.coordinator.resolveActivationConflict(selectedRole)

    const remaining = await absorbedActivationOutboxRows(fixture.spaceDbFor('space-offline'))
    expect(remaining).toHaveLength(expectedCandidateRows)
    expect(remaining.every((row) => row.transportState === 'blocked_conflict')).toBe(true)
    expect(await fixture.spaceDbFor('space-offline').outbox
      .filter((row) => !fixture.absorbedOutboxIds.includes(row.id!)).count())
      .toBe(fixture.unrelatedOutboxCount)
  },
)

it('resolves with a persisted role, one canonical resolvedAt, and exact loser correction', async () => {
  vi.setSystemTime(new Date('2026-07-15T08:06:00Z'))
  const fixture = provisionalCoordinatorFixture({ serverOutcome: 'activation_conflict' })
  await fixture.coordinator.reconcileProvisional('offline-op-1')
  fixture.api.resolveActivationConflict.mockResolvedValue(
    resolvedActivation('space-offline', 'offline-1'),
  )
  await fixture.coordinator.resolveActivationConflict('candidate')
  const intent = await fixture.meta.provisionalOperations.get('offline-op-1')
  expect(intent).toMatchObject({
    resolutionOperationId: expect.any(String),
    resolutionConflictIdentityJson: expect.any(String),
    resolutionSelectedRole: 'candidate',
    resolutionResolvedAt: '2026-07-15T08:06:00.000Z',
    resolutionRequestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
  })
  expect(fixture.api.resolveActivationConflict).toHaveBeenCalledWith(expect.objectContaining({
    winnerRole: 'candidate',
    decisionAt: intent!.resolutionResolvedAt,
    validityCorrection: {
      loserValidity: 'invalid', loserValidityReason: 'activation_conflict_loser',
    },
  }))
  const request = fixture.api.resolveActivationConflict.mock.calls[0]![0]
  expect(request).not.toHaveProperty('deviceId')
  expect(request).not.toHaveProperty('tabId')
  expect(request).not.toHaveProperty('spaceId')
  expect(request).not.toHaveProperty('winnerSessionId')
  expect(request).not.toHaveProperty('loserSessionId')
})

it('resolves equal Session IDs in different Spaces by role and marks both caches', async () => {
  const fixture = provisionalCoordinatorFixture({
    serverOutcome: 'activation_conflict',
    activeSpaceId: 'space-online', candidateSpaceId: 'space-offline',
    activeSessionId: 'shared-1', candidateSessionId: 'shared-1',
  })
  await fixture.coordinator.reconcileProvisional('offline-op-1')
  fixture.api.resolveActivationConflict.mockResolvedValue(
    resolvedActivation('space-offline', 'shared-1'),
  )

  await fixture.coordinator.resolveActivationConflict('candidate')

  expect(fixture.api.resolveActivationConflict).toHaveBeenCalledWith(
    expect.objectContaining({ winnerRole: 'candidate' }),
  )
  const activeCache = await fixture.spaceDbFor('space-online')
    .sessionActivationConflicts.get('offline-op-1')
  const candidateCache = await fixture.spaceDbFor('space-offline')
    .sessionActivationConflicts.get('offline-op-1')
  const intent = await fixture.meta.provisionalOperations.get('offline-op-1')
  expect(activeCache).toMatchObject({
    resolutionOperationId: intent!.resolutionOperationId,
    resolvedAt: intent!.resolutionResolvedAt,
    selectedRole: 'candidate',
  })
  expect(candidateCache).toMatchObject({
    resolutionOperationId: intent!.resolutionOperationId,
    resolvedAt: intent!.resolutionResolvedAt,
    selectedRole: 'candidate',
  })
})

it('recovers a committed resolution after its client response is lost', async () => {
  const fixture = provisionalCoordinatorFixture({
    serverOutcome: 'activation_conflict', resolutionResponseLostAfterCommit: true,
  })
  await fixture.coordinator.reconcileProvisional('offline-op-1')
  await expect(fixture.coordinator.resolveActivationConflict('candidate'))
    .rejects.toThrow('transport_lost')
  const intent = await fixture.meta.provisionalOperations.get('offline-op-1')
  expect(intent).toMatchObject({
    state: 'conflict', resolutionOperationId: expect.any(String),
    resolutionConflictIdentityJson: expect.any(String),
    resolutionSelectedRole: 'candidate', resolutionResolvedAt: expect.any(String),
    resolutionRequestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
  })

  fixture.api.locate.mockResolvedValue(resolvedActivation(
    'space-offline', 'offline-1', { operationId: intent!.resolutionOperationId! },
  ))
  await fixture.restartCoordinator().bootstrap()

  expect(fixture.api.resolveActivationConflict).toHaveBeenCalledTimes(1)
  expect(await fixture.meta.provisionalOperations.get('offline-op-1'))
    .toMatchObject({ state: 'resolved' })
  expect(await fixture.spaceDbFor('space-online').sessionActivationConflicts
    .get('offline-op-1')).toMatchObject({
      resolutionOperationId: intent!.resolutionOperationId,
      resolvedAt: intent!.resolutionResolvedAt, selectedRole: 'candidate',
    })
  expect(await fixture.spaceDbFor('space-offline').sessionActivationConflicts
    .get('offline-op-1')).toMatchObject({
      resolutionOperationId: intent!.resolutionOperationId,
      resolvedAt: intent!.resolutionResolvedAt, selectedRole: 'candidate',
    })
})

it('reuses one resolvedAt after the first Space commit and finishes the second Space plus Meta', async () => {
  const fixture = provisionalCoordinatorFixture({
    serverOutcome: 'activation_conflict', crashAfterFirstResolutionSpaceCommit: true,
  })
  await fixture.coordinator.reconcileProvisional('offline-op-1')
  await expect(fixture.coordinator.resolveActivationConflict('candidate'))
    .rejects.toThrow('client_crash_after_first_resolution_space_commit')
  const intent = await fixture.meta.provisionalOperations.get('offline-op-1')
  const committed = await fixture.spaceDbFor(fixture.firstResolutionCommitSpaceId)
    .sessionActivationConflicts.get('offline-op-1')
  expect(committed).toMatchObject({
    resolutionOperationId: intent!.resolutionOperationId,
    resolvedAt: intent!.resolutionResolvedAt,
    selectedRole: intent!.resolutionSelectedRole,
  })
  expect(intent).toMatchObject({ state: 'conflict' })

  fixture.api.locate.mockResolvedValue(resolvedActivation(
    'space-offline', 'offline-1', { operationId: intent!.resolutionOperationId! },
  ))
  await fixture.restartCoordinator().bootstrap()

  for (const spaceId of ['space-online', 'space-offline']) {
    expect(await fixture.spaceDbFor(spaceId).sessionActivationConflicts
      .get('offline-op-1')).toMatchObject({
        resolutionOperationId: intent!.resolutionOperationId,
        resolvedAt: intent!.resolutionResolvedAt,
        selectedRole: 'candidate',
      })
  }
  expect(await fixture.meta.provisionalOperations.get('offline-op-1'))
    .toMatchObject({ state: 'resolved', resolutionResolvedAt: intent!.resolutionResolvedAt })
})

it('retries an unresolved conflict with the exact persisted resolution intent', async () => {
  const fixture = provisionalCoordinatorFixture({
    serverOutcome: 'activation_conflict', firstResolutionTransportLostBeforeCommit: true,
  })
  await fixture.coordinator.reconcileProvisional('offline-op-1')
  await expect(fixture.coordinator.resolveActivationConflict('active'))
    .rejects.toThrow('transport_lost')
  await expect(fixture.coordinator.resolveActivationConflict('candidate'))
    .rejects.toThrow('activation_resolution_intent_mismatch')
  await fixture.coordinator.resolveActivationConflict('active')
  const [first, retry] = fixture.api.resolveActivationConflict.mock.calls.map(([input]) => input)
  expect(retry).toMatchObject({
    operationId: first!.operationId,
    winnerRole: first!.winnerRole,
    decisionAt: first!.decisionAt,
  })
})

it('fails closed when one resolution root is rebound to a changed persisted time', async () => {
  const fixture = provisionalCoordinatorFixture({
    serverOutcome: 'activation_conflict', firstResolutionTransportLostBeforeCommit: true,
  })
  await fixture.coordinator.reconcileProvisional('offline-op-1')
  await expect(fixture.coordinator.resolveActivationConflict('active'))
    .rejects.toThrow('transport_lost')
  await fixture.meta.provisionalOperations.update('offline-op-1', {
    resolutionResolvedAt: '2026-07-15T09:00:00.000Z',
  })
  await expect(fixture.coordinator.resolveActivationConflict('active'))
    .rejects.toThrow('activation_resolution_intent_mismatch')
  expect(fixture.api.resolveActivationConflict).toHaveBeenCalledTimes(1)
})

it('keeps conflict content read-only while resolution holds the operation lock', async () => {
  const fixture = provisionalCoordinatorFixture({
    serverOutcome: 'activation_conflict', deferResolutionResponse: true,
  })
  await fixture.coordinator.reconcileProvisional('offline-op-1')
  const beforeSession = await fixture.spaceDb.focusSessions.get('offline-1')
  const beforeOutbox = await fixture.spaceDb.outbox.orderBy('id').toArray()
  const resolution = fixture.coordinator.resolveActivationConflict('active')
  await fixture.api.waitUntilResolveActivationConflictCalled()
  await expect(fixture.repository.updateSessionNote('offline-1', 'Too late'))
    .rejects.toThrow('blocked_conflict')
  expect(await fixture.spaceDb.focusSessions.get('offline-1')).toEqual(beforeSession)
  expect(await fixture.spaceDb.outbox.orderBy('id').toArray()).toEqual(beforeOutbox)
  fixture.api.resolveDeferredResolution()
  await resolution
})
```

```typescript
// append to frontend/src/stores/business-stores.test.ts
it('excludes pending activation conflicts from focused effort', () => {
  const eligible = selectEffortEligibleSessions([
    session({ sessionId: 'valid', validity: 'valid', ownershipState: 'authoritative' }),
    session({ sessionId: 'pending', validity: 'pending', ownershipState: 'activation_conflict' }),
  ])
  expect(eligible.map((item) => item.sessionId)).toEqual(['valid'])
})
```

- [ ] **Step 2: Write failing explicit winner-selection UI tests**

```typescript
// frontend/src/components/timer/activation-conflict-dialog.test.tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

it('shows both time records and resolves only after an explicit choice', () => {
  const resolve = vi.fn()
  render(<ActivationConflictDialog
    conflict={activationConflictFixture({ sameSessionIdAcrossSpaces: true })}
    open onResolve={resolve} />)
  expect(screen.getByText('Authoritative session')).toBeVisible()
  expect(screen.getByText('Offline session')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Continue selected session' })).toBeDisabled()
  fireEvent.click(screen.getByRole('radio', { name: /Offline session/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue selected session' }))
  expect(resolve).toHaveBeenCalledWith('candidate')
})

it('has no dismiss action while the conflict is unresolved', () => {
  render(<ActivationConflictDialog conflict={activationConflictFixture()} open onResolve={vi.fn()} />)
  expect(screen.queryByRole('button', { name: /close/i })).toBeNull()
  expect(screen.queryByRole('button', { name: /later/i })).toBeNull()
})
```

- [ ] **Step 3: Run offline reconciliation tests and verify missing explicit flow**

Run from `frontend/`:

```powershell
npm run test -- --run src/lib/contracts/focus-session.test.ts src/services/active-session-api.test.ts src/lib/focus-session/active-session-coordinator.test.ts src/lib/focus-session/online-reconciliation-provider.test.tsx src/components/timer/activation-conflict-dialog.test.tsx src/stores/business-stores.test.ts
```

Expected: FAIL because the activation resolution schema, reconnect provider, explicit dialog, and effort selector do not exist.

- [ ] **Step 4: Lock the generated active/conflict response union and local conflict metadata**

```typescript
// append to frontend/src/lib/contracts/focus-session.ts
export const localActivationConflictSchema = activationConflictSchema.extend({
  conflictId: id,
  provisionalOperationId: id,
  detectedAt: utc,
  resolvedAt: utc.nullable(),
  selectedRole: activationConflictRoleSchema.nullable(),
}).strict().superRefine((conflict, context) => {
  const identities = [
    ['active', conflict.active],
    ['candidate', conflict.candidate],
  ] as const
  for (const [role, selected] of identities) {
    if (selected.session.session.spaceId !== selected.spaceId ||
        selected.session.session.id !== selected.sessionId) {
      context.addIssue({
        code: 'custom', path: [role],
        message: `${role} aggregate must match its composite identity`,
      })
    }
  }
})

export const activationResolutionSchema = activeSessionSchema.extend({
  kind: z.literal('authoritative'),
}).strict()

export type ActivationResolutionView = z.infer<typeof activationResolutionSchema>
export type LocalActivationConflictView = z.infer<typeof localActivationConflictSchema>
```

```typescript
// in frontend/src/services/active-session-api.ts, retain Task 1's exact request
// builder and replace only its final response parse:
return activationResolutionSchema.parse(data)
```

Generated-type tests require the response to match the synchronized TS2 OpenAPI: active/resumed/resolved results use root locator fields plus nested `session` aggregate, while a conflict is exactly `{ kind: 'activation_conflict', active, candidate }`. `conflictId`, provisional operation identity, timestamps, and selection are frontend-local coordination metadata and never masquerade as server response fields.

- [ ] **Step 5: Reconcile reconnect outcomes and persist conflicts without deleting either Session**

```typescript
// add to frontend/src/lib/focus-session/active-session-coordinator.ts
const toConflictRow = (
  conflict: LocalActivationConflictView,
): SessionActivationConflictRow => ({
  conflictId: conflict.conflictId,
  provisionalOperationId: conflict.provisionalOperationId,
  authoritativeSpaceId: conflict.active.spaceId,
  authoritativeSessionId: conflict.active.sessionId,
  provisionalSpaceId: conflict.candidate.spaceId,
  provisionalSessionId: conflict.candidate.sessionId,
  detectedAt: conflict.detectedAt,
  resolutionOperationId: null,
  resolvedAt: conflict.resolvedAt,
  selectedRole: conflict.selectedRole,
})

async function persistActivationConflict(
  db: PomodoroXIDB,
  conflict: LocalActivationConflictView,
  provisional: LocalFocusSessionAggregate,
  operation: ProvisionalOperationRow,
  rawResult: unknown,
): Promise<void> {
  const result = activationConflictSchema.parse(rawResult)
  if (result.candidate.spaceId !== operation.spaceId ||
      result.candidate.sessionId !== operation.sessionId ||
      result.candidate.session.session.id !== operation.sessionId) {
    throw new Error('activation_conflict_candidate_identity_mismatch')
  }
  const resultHash = await hashCommandPayload(result as unknown as JsonValue)
  const absorbedKeys = absorbedProvisionalOutboxKeys(provisional)
  const entityIds = absorbedProvisionalEntityIds(provisional)

  await db.transaction(
    'rw', db.focusSessions, db.sessionActivationConflicts,
    db.sessionCommandQueue, db.sessionActivationApplications, db.outbox,
    async () => {
      const possibleRows = await db.outbox.where('entityId').anyOf(entityIds).toArray()
      const absorbedRows = possibleRows.filter((row) =>
        absorbedKeys.has(provisionalOutboxKey(row.entityType, row.entityId)))
      const seenKeys = new Set(absorbedRows.map((row) =>
        provisionalOutboxKey(row.entityType, row.entityId)))
      if (absorbedRows.length !== absorbedKeys.size || seenKeys.size !== absorbedKeys.size ||
          [...absorbedKeys].some((key) => !seenKeys.has(key)) ||
          absorbedRows.some((row) => row.synced ||
            (row.transportState !== 'awaiting_s4' &&
             row.transportState !== 'blocked_conflict'))) {
        throw new Error('activation_conflict_outbox_mismatch')
      }
      const absorbedOutboxIds = absorbedRows.map((row) => row.id!).sort((a, b) => a - b)
      const existingReceipt = await db.sessionActivationApplications.get(operation.operationId)
      if (existingReceipt) {
        if (existingReceipt.resultKind !== 'activation_conflict' ||
            existingReceipt.resultHash !== resultHash ||
            existingReceipt.provisionalSpaceId !== operation.spaceId ||
            existingReceipt.provisionalSessionId !== operation.sessionId ||
            existingReceipt.activeSpaceId !== result.active.spaceId ||
            existingReceipt.activeSessionId !== result.active.sessionId ||
            existingReceipt.activeSessionVersion !== result.active.session.session.version ||
            existingReceipt.ownershipEpoch !== result.active.ownershipEpoch ||
            JSON.stringify(existingReceipt.absorbedOutboxIds) !==
              JSON.stringify(absorbedOutboxIds)) {
          throw new Error('activation_application_receipt_mismatch')
        }
      } else {
        await db.sessionActivationApplications.add({
          operationId: operation.operationId,
          provisionalSpaceId: operation.spaceId,
          provisionalSessionId: operation.sessionId,
          resultKind: 'activation_conflict', resultHash,
          resultJson: JSON.stringify(result),
          activeSpaceId: result.active.spaceId,
          activeSessionId: result.active.sessionId,
          activeSessionVersion: result.active.session.session.version,
          ownershipEpoch: result.active.ownershipEpoch,
          absorbedOutboxIds,
          appliedAt: result.active.updatedAt,
        })
      }
      await db.sessionActivationConflicts.put(toConflictRow(conflict))
      await db.focusSessions.update(operation.sessionId, {
        ownershipState: 'activation_conflict', validity: 'pending',
      })
      for (const row of absorbedRows) {
        await db.outbox.update(row.id!, { transportState: 'blocked_conflict' })
      }
      await db.sessionCommandQueue.where('sessionId').equals(operation.sessionId)
        .modify({ state: 'held' })
    },
  )
}

private async recoverAppliedActivation(operation: ProvisionalOperationRow): Promise<void> {
  const sequence = ++this.nextWriteSequence
  try {
    await withDetachedSpaceDatabase(operation.spaceId, async (db) => {
      const receipt = await db.sessionActivationApplications.get(operation.operationId)
      if (!receipt) throw new Error('receipt_missing')
      const result = activeSessionSchema.or(activationConflictSchema)
        .parse(JSON.parse(receipt.resultJson))
      const resultHash = await hashCommandPayload(result as unknown as JsonValue)
      const locator = result.kind === 'activation_conflict' ? result.active : result
      const resultKind = result.kind
      if (!resultKind || receipt.resultHash !== resultHash ||
          receipt.resultKind !== resultKind ||
          receipt.provisionalSpaceId !== operation.spaceId ||
          receipt.provisionalSessionId !== operation.sessionId ||
          receipt.activeSpaceId !== locator.spaceId ||
          receipt.activeSessionId !== locator.sessionId ||
          receipt.activeSessionVersion !== locator.session.session.version ||
          receipt.ownershipEpoch !== locator.ownershipEpoch) {
        throw new Error('receipt_identity_or_hash_mismatch')
      }

      if (result.kind === 'activation_conflict') {
        const conflictRow = await db.sessionActivationConflicts
          .where('provisionalOperationId').equals(operation.operationId).first()
        const heldRows = await db.outbox.bulkGet(receipt.absorbedOutboxIds)
        if (!conflictRow ||
            result.candidate.spaceId !== operation.spaceId ||
            result.candidate.sessionId !== operation.sessionId ||
            heldRows.some((row) => !row || row.transportState !== 'blocked_conflict')) {
          throw new Error('conflict_application_not_durable')
        }
        const conflict = localActivationConflictSchema.parse({
          ...result,
          conflictId: conflictRow.conflictId,
          provisionalOperationId: operation.operationId,
          detectedAt: conflictRow.detectedAt,
          resolvedAt: conflictRow.resolvedAt,
          selectedRole: conflictRow.selectedRole,
        })
        await this.installProvisionalActivationResponse(result, operation, sequence, true)
        await this.meta.provisionalOperations.update(operation.operationId, {
          state: 'conflict', updatedAt: new Date().toISOString(),
        })
        this.timer.getState().setActivationConflict(conflict)
        return
      }

      const cached = await db.focusSessions.get(operation.sessionId)
      const deletedRows = await db.outbox.bulkGet(receipt.absorbedOutboxIds)
      if (!cached || cached.ownershipState !== 'authoritative' ||
          cached.version !== receipt.activeSessionVersion ||
          deletedRows.some((row) => row !== undefined)) {
        throw new Error('authoritative_application_not_durable')
      }
      await this.installProvisionalActivationResponse(result, operation, sequence, true)
      await this.meta.provisionalOperations.update(operation.operationId, {
        state: 'resolved', updatedAt: new Date().toISOString(),
      })
    })
  } catch (error) {
    throw new Error(`activation_application_recovery_error:${(error as Error).message}`)
  }
}

async reconcileProvisional(operationId: string): Promise<void> {
  return this.provisionalLock.run(operationId, () =>
    this.reconcileProvisionalLocked(operationId))
}

private async reconcileProvisionalLocked(operationId: string): Promise<void> {
  const operation = await this.meta.provisionalOperations.get(operationId)
  if (!operation || operation.state === 'resolved') return
  if (operation.deviceId !== this.identity.deviceId || operation.tabId !== this.identity.tabId) {
    throw new Error('active_session_not_owned')
  }
  if (operation.state === 'awaiting_s4' || operation.state === 'conflict') return
  if (operation.state === 'activating') {
    await this.recoverAppliedActivation(operation)
    return
  }
  await withDetachedSpaceDatabase(operation.spaceId, async (db) => {
    const aggregate = await loadProvisionalAggregate(db, operation.sessionId)
    if (aggregate.session.endedAt !== null || aggregate.session.clockState === 'ended') {
      await this.meta.provisionalOperations.update(operationId, {
        state: 'awaiting_s4', updatedAt: new Date().toISOString(),
      })
      return
    }
    const sequence = ++this.nextWriteSequence
    await this.meta.provisionalOperations.update(operationId, {
      state: 'activating', updatedAt: new Date().toISOString(),
    })
    const result = await this.api.activateProvisional({
      spaceId: operation.spaceId,
      sessionId: operation.sessionId,
      operationId,
      payload: buildActivateProvisionalPayload(aggregate, operation),
    })
    await this.assertProvisionalActivationResponse(result, operation, sequence)
    if (result.kind === 'activation_conflict') {
      const conflict = localActivationConflictSchema.parse({
        ...result,
        conflictId: operationId,
        provisionalOperationId: operationId,
        detectedAt: new Date().toISOString(),
        resolvedAt: null,
        selectedRole: null,
      })
      await persistActivationConflict(db, conflict, aggregate, operation, result)
      await this.installProvisionalActivationResponse(result, operation, sequence, true)
      await this.meta.provisionalOperations.update(operationId, {
        state: 'conflict', updatedAt: new Date().toISOString(),
      })
      this.timer.getState().setActivationConflict(conflict)
      return
    }
    await cacheAuthoritativeActivation(db, operation, result, aggregate)
    await this.installProvisionalActivationResponse(result, operation, sequence, true)
    await this.meta.provisionalOperations.update(operationId, {
      state: 'resolved', updatedAt: new Date().toISOString(),
    })
  })
}

private async assertProvisionalActivationResponse(
  result: ActiveSessionView | ActivationConflictResponse,
  operation: ProvisionalOperationRow,
  sequence: number,
): Promise<void> {
  const currentOperation = await this.meta.provisionalOperations.get(operation.operationId)
  const locator = result.kind === 'activation_conflict' ? result.active : result
  const live = this.timer.getState().locator
  const candidateMatches = result.kind !== 'activation_conflict' || (
    result.candidate.spaceId === operation.spaceId &&
    result.candidate.sessionId === operation.sessionId &&
    result.candidate.session.session.id === operation.sessionId
  )
  const directMatches = result.kind === 'activation_conflict' || (
    locator.operationId === operation.operationId &&
    locator.spaceId === operation.spaceId && locator.sessionId === operation.sessionId
  )
  if (!currentOperation || currentOperation.state !== 'activating' ||
      currentOperation.deviceId !== this.identity.deviceId ||
      currentOperation.tabId !== this.identity.tabId ||
      sequence < this.latestAppliedSequence || !candidateMatches || !directMatches ||
      (live !== null && Date.parse(locator.updatedAt) < Date.parse(live.updatedAt))) {
    return this.rejectStaleResponse()
  }
}

private async installProvisionalActivationResponse(
  result: ActiveSessionView | ActivationConflictResponse,
  operation: ProvisionalOperationRow,
  sequence: number,
  notifyPeers: boolean,
): Promise<void> {
  await this.assertProvisionalActivationResponse(result, operation, sequence)
  const locator = result.kind === 'activation_conflict' ? result.active : result
  this.latestAppliedSequence = sequence
  await this.install(locator, notifyPeers)
}

private async recoverCommittedResolutionFromLocate(
  response: ActiveSessionView | null,
): Promise<void> {
  const operations = await this.meta.provisionalOperations
    .where('state').equals('conflict')
    .and((row) => Boolean(row.resolutionOperationId)).toArray()
  if (operations.length === 0) return
  if (operations.length !== 1 || !response) {
    throw new Error('active_session_resolution_recovery_required')
  }
  const operation = operations[0]!
  await this.provisionalLock.run(operation.operationId, async () => {
    const conflict = await withDetachedSpaceDatabase(operation.spaceId, async (db) => {
      const row = await db.sessionActivationConflicts
        .where('provisionalOperationId').equals(operation.operationId).first()
      if (!row) throw new Error('active_session_resolution_recovery_required')
      return row
    })
    if (!operation.resolutionOperationId || !operation.resolutionConflictIdentityJson ||
        !operation.resolutionSelectedRole || !operation.resolutionResolvedAt ||
        !operation.resolutionRequestHash ||
        activationConflictIdentityJson(conflict) !== operation.resolutionConflictIdentityJson) {
      throw new Error('active_session_resolution_recovery_required')
    }
    const intent: ActivationResolutionIntent = {
      operationId: operation.resolutionOperationId,
      conflictIdentityJson: operation.resolutionConflictIdentityJson,
      selectedRole: operation.resolutionSelectedRole,
      resolvedAt: operation.resolutionResolvedAt,
      requestHash: operation.resolutionRequestHash,
    }
    const expectedWinner = intent.selectedRole === 'active'
      ? { spaceId: conflict.authoritativeSpaceId,
        sessionId: conflict.authoritativeSessionId }
      : { spaceId: conflict.provisionalSpaceId,
        sessionId: conflict.provisionalSessionId }
    const requestHash = await hashCommandPayload({
      winner_role: intent.selectedRole,
      decision_at: intent.resolvedAt,
      validity_correction: {
        loser_validity: 'invalid', loser_validity_reason: 'activation_conflict_loser',
      },
    })
    if (requestHash !== intent.requestHash || response.operationId !== intent.operationId ||
        response.spaceId !== expectedWinner.spaceId ||
        response.sessionId !== expectedWinner.sessionId ||
        response.session.session.spaceId !== expectedWinner.spaceId ||
        response.session.session.id !== expectedWinner.sessionId) {
      throw new Error('active_session_resolution_recovery_required')
    }
    await applyAuthoritativeResolutionResult(conflict, intent, response)
    await markPersistedConflictResolvedInBothSpaces(conflict, intent)
    await this.meta.provisionalOperations.update(operation.operationId, {
      state: 'resolved', updatedAt: intent.resolvedAt,
    })
  })
}

// Replace Task 7's base helper so locate()/refresh() restore unresolved conflicts.
private async installLocated(
  response: LocatedActiveSessionResponse | null,
  notifyPeers: boolean,
): Promise<void> {
  if (response?.kind !== 'activation_conflict') {
    await this.recoverCommittedResolutionFromLocate(response)
    await this.install(activeFromLocated(response), notifyPeers)
    this.timer.getState().clearActivationConflict()
    return
  }
  await this.install(response.active, notifyPeers)
  const operations = await this.meta.provisionalOperations
    .where('sessionId').equals(response.candidate.sessionId)
    .and((row) => row.spaceId === response.candidate.spaceId && row.state === 'conflict')
    .toArray()
  if (operations.length !== 1) throw new Error('active_session_recovery_required')
  const operation = operations[0]!
  await withDetachedSpaceDatabase(operation.spaceId, async (db) => {
    const existing = await db.sessionActivationConflicts
      .where('provisionalOperationId').equals(operation.operationId).first()
    if (!existing || existing.resolvedAt !== null) {
      throw new Error('active_session_recovery_required')
    }
    const conflict = localActivationConflictSchema.parse({
      ...response,
      conflictId: existing.conflictId,
      provisionalOperationId: operation.operationId,
      detectedAt: existing.detectedAt,
      resolvedAt: existing.resolvedAt,
      selectedRole: existing.selectedRole,
    })
    this.timer.getState().setActivationConflict(conflict)
  })
}
```

`installProvisionalActivationResponse` verifies the still-activating exact Meta operation, device/Tab owner, selected Space/Session identity, client response sequence, and non-older live locator before installing either the direct result or `result.active`. For `authoritative` or `resumed`, `cacheAuthoritativeActivation` parses the returned aggregate, verifies its Space/Session against the local snapshot, and in one Space Dexie transaction validates then deletes only matching Session/context/initial effective attribution/plan outbox rows whose exact shape is pristine `awaiting_s4`, `attemptCount=0`, `synced=false`, `action='create'`, and `expectedVersion=null`, while caching the authoritative aggregate. Any attempted, unknown-result, already-synced, rebased, failed, or otherwise unexpected absorbed row aborts that whole transaction; unrelated outbox rows remain untouched and the Meta operation is not marked resolved. For `activation_conflict`, `persistActivationConflict` instead writes the conflict row, provisional `ownershipState/validity`, changes only that pre-conflict snapshot to `blocked_conflict`, and sets every queued task command to `state='held'` in one per-Space transaction. Conflict-time content controls are read-only and cannot alter those rows. It never deletes either Session or any held outbox row.

- [ ] **Step 6: Persist explicit winner/loser resolution before clearing conflict UI**

```typescript
// add to frontend/src/lib/focus-session/active-session-coordinator.ts
interface ActivationResolutionIntent {
  operationId: string
  conflictIdentityJson: string
  selectedRole: ActivationConflictRole
  resolvedAt: string
  requestHash: string
}

const activationConflictIdentityJson = (
  conflict: SessionActivationConflictRow,
): string => canonicalJson({
  conflict_id: conflict.conflictId,
  provisional_operation_id: conflict.provisionalOperationId,
  active: {
    space_id: conflict.authoritativeSpaceId,
    session_id: conflict.authoritativeSessionId,
  },
  candidate: {
    space_id: conflict.provisionalSpaceId,
    session_id: conflict.provisionalSessionId,
  },
})

async function applyAuthoritativeResolutionResult(
  conflict: SessionActivationConflictRow,
  intent: ActivationResolutionIntent,
  result: ActivationResolutionView,
): Promise<void> {
  if (activationConflictIdentityJson(conflict) !== intent.conflictIdentityJson) {
    throw new Error('activation_resolution_intent_mismatch')
  }
  const expectedWinner = intent.selectedRole === 'active'
    ? { spaceId: conflict.authoritativeSpaceId, sessionId: conflict.authoritativeSessionId }
    : { spaceId: conflict.provisionalSpaceId, sessionId: conflict.provisionalSessionId }
  if (result.spaceId !== expectedWinner.spaceId || result.sessionId !== expectedWinner.sessionId ||
      result.session.session.spaceId !== expectedWinner.spaceId ||
      result.session.session.id !== expectedWinner.sessionId) {
    throw new Error('activation_resolution_winner_identity_mismatch')
  }
  if (intent.selectedRole === 'candidate') {
    await withDetachedSpaceDatabase(conflict.provisionalSpaceId, (db) =>
      cacheResolvedProvisionalWinner(db, {
        operationId: conflict.provisionalOperationId,
        spaceId: conflict.provisionalSpaceId,
        sessionId: conflict.provisionalSessionId,
      }, conflict, {
        operationId: intent.operationId,
        selectedRole: 'candidate',
        resolvedAt: intent.resolvedAt,
      }, result))
    return
  }
  await withDetachedSpaceDatabase(result.spaceId, (db) =>
    cacheFocusSession(db, result.spaceId, result.session))
  // The losing candidate's receipt-bound blocked snapshot remains untouched.
}

async function markPersistedConflictResolvedInBothSpaces(
  conflict: SessionActivationConflictRow,
  intent: ActivationResolutionIntent,
): Promise<void> {
  if (activationConflictIdentityJson(conflict) !== intent.conflictIdentityJson) {
    throw new Error('activation_resolution_intent_mismatch')
  }
  const spaceIds = [...new Set([
    conflict.authoritativeSpaceId, conflict.provisionalSpaceId,
  ])].sort()
  for (const spaceId of spaceIds) {
    await withDetachedSpaceDatabase(spaceId, async (db) => {
      await db.transaction('rw', db.sessionActivationConflicts, async () => {
          const existing = await db.sessionActivationConflicts.get(conflict.conflictId)
          if (existing && (
            existing.provisionalOperationId !== conflict.provisionalOperationId ||
            existing.authoritativeSpaceId !== conflict.authoritativeSpaceId ||
            existing.authoritativeSessionId !== conflict.authoritativeSessionId ||
            existing.provisionalSpaceId !== conflict.provisionalSpaceId ||
            existing.provisionalSessionId !== conflict.provisionalSessionId ||
            (existing.resolutionOperationId !== null &&
             existing.resolutionOperationId !== intent.operationId) ||
            (existing.resolvedAt !== null && existing.resolvedAt !== intent.resolvedAt) ||
            (existing.selectedRole !== null && existing.selectedRole !== intent.selectedRole)
          )) throw new Error('activation_conflict_cache_identity_mismatch')
          await db.sessionActivationConflicts.put({
            ...(existing ?? conflict),
            resolutionOperationId: intent.operationId,
            resolvedAt: intent.resolvedAt,
            selectedRole: intent.selectedRole,
          })
          // This metadata transaction never edits commands or outbox rows.
        })
    })
  }
}

async function markConflictResolvedInBothSpaces(
  conflict: LocalActivationConflictView,
  intent: ActivationResolutionIntent,
): Promise<void> {
  await markPersistedConflictResolvedInBothSpaces(toConflictRow(conflict), intent)
}

async resolveActivationConflict(selectedRole: ActivationConflictRole): Promise<void> {
  const conflict = this.timer.getState().activationConflict
  if (!conflict) throw new Error('session_activation_conflict_not_found')
  return this.provisionalLock.run(conflict.provisionalOperationId, () =>
    this.resolveActivationConflictLocked(selectedRole))
}

private async prepareActivationResolutionIntent(
  conflictView: LocalActivationConflictView,
  selectedRole: ActivationConflictRole,
): Promise<ActivationResolutionIntent> {
  const conflict = toConflictRow(conflictView)
  const conflictIdentityJson = activationConflictIdentityJson(conflict)
  const provisionalOperationId = conflict.provisionalOperationId
  return this.meta.transaction('rw', this.meta.provisionalOperations, async () => {
    const operation = await this.meta.provisionalOperations.get(provisionalOperationId)
    if (!operation || operation.state !== 'conflict' ||
        operation.spaceId !== conflict.provisionalSpaceId ||
        operation.sessionId !== conflict.provisionalSessionId) {
      throw new Error('session_activation_conflict_not_found')
    }
    if (operation.resolutionOperationId) {
      if (operation.resolutionConflictIdentityJson !== conflictIdentityJson ||
          operation.resolutionSelectedRole !== selectedRole ||
          !operation.resolutionResolvedAt || !operation.resolutionRequestHash) {
        throw new Error('activation_resolution_intent_mismatch')
      }
      const expectedHash = await Dexie.waitFor(hashCommandPayload({
        winner_role: selectedRole,
        decision_at: operation.resolutionResolvedAt,
        validity_correction: {
          loser_validity: 'invalid', loser_validity_reason: 'activation_conflict_loser',
        },
      }))
      if (expectedHash !== operation.resolutionRequestHash) {
        throw new Error('activation_resolution_intent_mismatch')
      }
      return {
        operationId: operation.resolutionOperationId,
        conflictIdentityJson,
        selectedRole, resolvedAt: operation.resolutionResolvedAt,
        requestHash: operation.resolutionRequestHash,
      }
    }
    const operationId = crypto.randomUUID()
    const resolvedAt = new Date().toISOString()
    const requestHash = await Dexie.waitFor(hashCommandPayload({
      winner_role: selectedRole, decision_at: resolvedAt,
      validity_correction: {
        loser_validity: 'invalid', loser_validity_reason: 'activation_conflict_loser',
      },
    }))
    await this.meta.provisionalOperations.update(provisionalOperationId, {
      resolutionOperationId: operationId,
      resolutionConflictIdentityJson: conflictIdentityJson,
      resolutionSelectedRole: selectedRole,
      resolutionResolvedAt: resolvedAt,
      resolutionRequestHash: requestHash,
      updatedAt: resolvedAt,
    })
    return { operationId, conflictIdentityJson, selectedRole, resolvedAt, requestHash }
  })
}

private async resolveActivationConflictLocked(
  selectedRole: ActivationConflictRole,
): Promise<void> {
  const conflict = this.timer.getState().activationConflict
  if (!conflict) throw new Error('session_activation_conflict_not_found')
  selectedRole = activationConflictRoleSchema.parse(selectedRole)
  const locator = this.requireOwnedLocator()
  const expectedWinner = selectedRole === 'active'
    ? { spaceId: conflict.active.spaceId, sessionId: conflict.active.sessionId }
    : { spaceId: conflict.candidate.spaceId, sessionId: conflict.candidate.sessionId }
  const intent = await this.prepareActivationResolutionIntent(conflict, selectedRole)
  const issued = this.captureWrite(locator, intent.operationId)
  const result = await this.guarded(() => this.api.resolveActivationConflict({
    sessionId: locator.sessionId,
    ownershipEpoch: locator.ownershipEpoch,
    winnerRole: intent.selectedRole,
    decisionAt: intent.resolvedAt,
    validityCorrection: {
      loserValidity: 'invalid', loserValidityReason: 'activation_conflict_loser',
    },
    operationId: intent.operationId,
  }))
  await this.assertResolutionResponse(result, issued, expectedWinner)
  await applyAuthoritativeResolutionResult(toConflictRow(conflict), intent, result)
  await markConflictResolvedInBothSpaces(conflict, intent)
  await this.meta.provisionalOperations.update(conflict.provisionalOperationId, {
    state: 'resolved', updatedAt: intent.resolvedAt,
  })
  await this.installResolutionResponse(result, issued, expectedWinner, true)
  this.timer.getState().clearActivationConflict()
}

private async assertResolutionResponse(
  response: ActivationResolutionView,
  issued: IssuedLocatorWrite,
  expectedWinner: { spaceId: string; sessionId: string },
): Promise<ActiveSessionView> {
  const live = await this.requireLiveFence(issued)
  const sameWinner = expectedWinner.spaceId === live.spaceId &&
    expectedWinner.sessionId === live.sessionId
  if (response.operationId !== issued.operationId ||
      response.spaceId !== expectedWinner.spaceId ||
      response.sessionId !== expectedWinner.sessionId ||
      response.session.session.spaceId !== expectedWinner.spaceId ||
      response.session.session.id !== expectedWinner.sessionId ||
      response.ownershipEpoch !== issued.ownershipEpoch + 1 ||
      response.ownerDeviceId !== issued.ownerDeviceId ||
      response.ownerTabId !== issued.ownerTabId ||
      Date.parse(response.updatedAt) < Date.parse(live.updatedAt) ||
      (sameWinner && !this.aggregateIsNotOlder(response.session, live.session))) {
    return this.rejectStaleResponse()
  }
  return live
}

private async installResolutionResponse(
  response: ActivationResolutionView,
  issued: IssuedLocatorWrite,
  expectedWinner: { spaceId: string; sessionId: string },
  notifyPeers: boolean,
): Promise<void> {
  await this.assertResolutionResponse(response, issued, expectedWinner)
  this.latestAppliedSequence = issued.sequence
  await this.install(response, notifyPeers)
}
```

The whole resolution path holds the same provisional operation Web Lock used by conflict installation and reconciliation. Before the first transport call, `prepareActivationResolutionIntent` atomically persists one immutable root operation ID, the canonical JSON of both conflict composite identities, `selectedRole`, one canonical `resolvedAt`, and the exact request hash on the Meta operation. The wire `decisionAt`, both Space conflict rows' `resolvedAt`, resolution-application receipt `appliedAt`, Meta `updatedAt`, direct retry, and locate/restart recovery all reuse that one value; none may call `new Date()` after the attempt exists. Rebinding the same root to a changed role, conflict identity, time, or hash fails before transport. The request still carries only the persisted `winnerRole`, locator-derived Session/epoch, `decisionAt: resolvedAt`, and the fixed loser correction; it carries no caller-selected Space or winner/loser Session IDs. `applyAuthoritativeResolutionResult` consumes the exact receipt-bound pristine blocked snapshot only when the candidate wins, in the same transaction that caches the authoritative aggregate and writes the resolution application receipt. When the active Session wins, it caches that authoritative aggregate and preserves every candidate blocked row. Unrelated outbox is untouched in both branches. Cross-Space conflict metadata is then written in sorted order with the persisted root/time; a crash after either Space is idempotently resumable because an existing matching row is accepted. `recoverCommittedResolutionFromLocate` closes its initial detached Space database before applying the winner and opening the sorted Space list, so it never recursively opens the same detached database. Missing or mismatched evidence fails closed without clearing the dialog.

- [ ] **Step 7: Mount reconnect reconciliation and the non-dismissible conflict dialog**

```tsx
// frontend/src/lib/focus-session/online-reconciliation-provider.tsx
'use client'

export function OnlineReconciliationProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const reconcile = () => {
      if (!navigator.onLine) return
      void reconcileEveryPendingProvisionalOperation()
    }
    window.addEventListener('online', reconcile)
    reconcile()
    return () => window.removeEventListener('online', reconcile)
  }, [])
  return children
}
```

`reconcileEveryPendingProvisionalOperation()` selects only `pending` and `activating`. It never sends `awaiting_s4` terminal rows to REST activation and never reopens a `conflict`; the former waits for S4 closed import and the latter is restored through the persisted conflict/receipt path.

```tsx
// frontend/src/components/timer/activation-conflict-dialog.tsx
export function ActivationConflictDialog({ conflict, open, onResolve }: Props) {
  const [selectedRole, setSelectedRole] = useState<ActivationConflictRole | null>(null)
  return (
    <Dialog open={open} onOpenChange={() => undefined}>
      <DialogContent hideCloseButton aria-describedby="activation-conflict-description">
        <DialogHeader>
          <DialogTitle>Choose the session to continue</DialogTitle>
          <DialogDescription id="activation-conflict-description">
            Both time records are preserved until this choice is applied.
          </DialogDescription>
        </DialogHeader>
        <fieldset className="grid gap-2">
          <SessionChoice label="Authoritative session" session={conflict.active.session.session}
            checked={selectedRole === 'active'}
            onChange={() => setSelectedRole('active')} />
          <SessionChoice label="Offline session" session={conflict.candidate.session.session}
            checked={selectedRole === 'candidate'}
            onChange={() => setSelectedRole('candidate')} />
        </fieldset>
        <DialogFooter>
          <Button disabled={!selectedRole} onClick={() => onResolve(selectedRole!)}>
            Continue selected session
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

Mount the provider in `app/providers.tsx` and the dialog once in `AppShell`. Escape, overlay click, and close icon do not dismiss unresolved state.

- [ ] **Step 8: Exclude unresolved ownership/validity from local effort projections**

```typescript
// frontend/src/stores/stats-store.ts
export function selectEffortEligibleSessions(sessions: readonly CachedFocusSession[]) {
  return sessions.filter((session) =>
    session.validity === 'valid' && session.ownershipState === 'authoritative',
  )
}
```

Every local focused-time aggregate calls this selector before summing. S4/backend EffortProjection remains authoritative and applies the latest effective Attribution revision independently of task command results.

- [ ] **Step 9: Run offline conflict, effort, type, and lint gates**

Run from `frontend/`:

```powershell
npm run test -- --run src/lib/contracts/focus-session.test.ts src/services/active-session-api.test.ts src/lib/focus-session/active-session-coordinator.test.ts src/lib/focus-session/online-reconciliation-provider.test.tsx src/components/timer/activation-conflict-dialog.test.tsx src/stores/business-stores.test.ts
npm run typecheck
npm run lint -- src/lib/focus-session src/components/timer/activation-conflict-dialog.tsx src/stores/stats-store.ts
```

Expected: PASS; all three activation outcomes are explicit, unresolved conflicts retain two records and zero eligible effort, commands remain held, and only an explicit user selection clears the dialog.

- [ ] **Step 10: Commit offline activation reconciliation**

```powershell
git add -- frontend/src/lib/contracts/focus-session.ts frontend/src/lib/contracts/focus-session.test.ts frontend/src/services/active-session-api.ts frontend/src/services/active-session-api.test.ts frontend/src/lib/focus-session/active-session-coordinator.ts frontend/src/lib/focus-session/active-session-coordinator.test.ts frontend/src/lib/focus-session/online-reconciliation-provider.tsx frontend/src/lib/focus-session/online-reconciliation-provider.test.tsx frontend/src/components/timer/activation-conflict-dialog.tsx frontend/src/components/timer/activation-conflict-dialog.test.tsx frontend/src/stores/stats-store.ts frontend/src/stores/business-stores.test.ts frontend/src/app/providers.tsx frontend/src/components/layout/app-shell.tsx
git commit -m "feat(frontend): resolve offline session activation conflicts"
```

---

### Task 12: Close Responsive, Accessibility, Browser, Static-Boundary, And TS3 Handoff Gates

**Files:**
- Modify: `frontend/package.json`
- Modify: `frontend/package-lock.json`
- Create: `frontend/playwright.config.ts`
- Create: `frontend/e2e/support/mock-task-space-backend.ts`
- Create: `frontend/e2e/task-space-session.spec.ts`
- Create: `frontend/scripts/verify-ts3-boundaries.mjs`
- Create: `frontend/src/lib/task-space-session-acceptance.test.ts`
- Create: `backend/tests/fixtures/ts3_provisional_compound_entity_commands.json`
- Create: `backend/tests/test_ts3_provisional_compound_entity_commands.py`
- Modify: `frontend/src/app/globals.css`
- Create: `docs/task-space-design/analysis/ts3-exit-report.md`

**Interfaces:**
- Consumes: Tasks 1-11, tracked TS0-TS2 OpenAPI, S3 v17, exactly TS3 v18, real Next.js build, and all approved design acceptance criteria that belong to frontend/local-first scope; it does not inspect or name a later frontend Dexie revision.
- Produces: desktop/mobile Playwright coverage; Axe checks; exact static boundary verifier; byte-identical frontend/S4 provisional compound vector exercised through real registered backend entity policies; final TS3 evidence report that says local loop is green and overall end-to-end exit remains pending S4 REST/Sync/MCP parity.

- [ ] **Step 1: Add Playwright/Axe dependencies and failing browser scripts**

Run from `frontend/`:

```powershell
npm install --save-dev @playwright/test @axe-core/playwright
npx playwright install chromium
```

Then add exact scripts:

```json
{
  "scripts": {
    "test:e2e": "playwright test",
    "verify:ts3": "node scripts/verify-ts3-boundaries.mjs"
  }
}
```

Expected: `package.json` and `package-lock.json` change; `npm run test:e2e` initially FAILS because `playwright.config.ts` and the spec do not exist.

- [ ] **Step 2: Write the failing cross-layer acceptance test**

```typescript
// frontend/src/lib/task-space-session-acceptance.test.ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('TS3 acceptance boundary', () => {
  it('has final stores and no legacy store modules', () => {
    expect(source('src/stores/task-space-store.ts')).toContain('useTaskSpaceStore')
    expect(source('src/stores/focus-session-store.ts')).toContain('useFocusSessionStore')
    expect(() => source('src/stores/task-store.ts')).toThrow()
    expect(() => source('src/stores/session-store.ts')).toThrow()
    expect(() => source('src/types/phase1.ts')).toThrow()
    expect(() => source('src/types/phase2.ts')).toThrow()
  })

  it('pins Dexie exactly at v18 and forbids a later local revision', () => {
    const database = source('src/services/database.ts')
    const versions = [...database.matchAll(/this\.version\((\d+)\)/g)]
      .map((match) => Number(match[1]))
    expect(Math.max(...versions)).toBe(18)
    expect(database).not.toMatch(/override\s+open\s*\(/)
    const cutover = source('src/services/dexie-v18-cutover.ts')
    for (const store of [
      'tasks', 'sessions', 'sessionEvents', 'sessionContexts', 'cognitiveMarks',
      'taskTags', 'taskRelations', 'focusPatterns', 'taskQuickNotes', 'sessionQuickNotes',
    ]) {
      expect(cutover).toContain(`'${store}'`)
    }
    expect(cutover).toContain('scanLegacyV17InsideUpgrade')
    expect(cutover).toContain('applyNativeV18Schema')
    expect(cutover).toContain('transaction.abort()')
  })

  it('contains only the two Note Block kinds and master-scoped global actions', () => {
    const note = source('src/lib/contracts/task-space.ts')
    for (const kind of ['paragraph', 'checklist']) {
      expect(note).toContain(`literal('${kind}')`)
    }
    for (const kind of ['heading', 'ordered_list', 'unordered_list', 'work_item_ref']) {
      expect(note).not.toContain(`literal('${kind}')`)
    }
    const active = source('src/services/active-session-api.ts')
    for (const action of ['heartbeat', 'pause', 'resume', 'end', 'takeover', 'activate-provisional']) {
      expect(active).toContain(`/active-session/${action}`)
    }
    expect(active).toContain('spaceId is required for global start')
    expect(active).toContain('spaceId is required for provisional activation')
    const taskApi = source('src/services/task-space-api.ts')
    for (const suffix of ['/note', '/note/append-blocks',
      '/note/toggle-checklist-item']) {
      expect(taskApi).toContain(suffix)
    }
    expect(taskApi).not.toMatch(/promote|expectedSourceWorkItemVersion/)
    expect(taskApi).not.toContain(['/note', 'commands'].join('/'))
    expect(taskApi).toContain('params: { projectId }')
    const focusApi = source('src/services/focus-session-api.ts')
    for (const action of ['start', 'pause', 'resume', 'end']) {
      expect(focusApi).not.toContain(`/focus-sessions/${action}`)
    }
  })
})
```

```python
# backend/tests/test_ts3_provisional_compound_entity_commands.py
import json
from pathlib import Path

import pytest


@pytest.mark.asyncio
async def test_ts3_provisional_compound_vector_runs_real_registered_policies(
    prepared_batch_harness,
) -> None:
    vector = json.loads(
        Path('tests/fixtures/ts3_provisional_compound_entity_commands.json').read_text('utf-8')
    )
    result = await prepared_batch_harness.execute_vector(vector)
    assert [item['entity_type'] for item in result.applied] == [
        'focusSession', 'sessionTaskContext', 'sessionAttributionRevision',
        'sessionWorkItemPlan', 'sessionWorkItemPlan',
    ]
    assert [item['request_index'] for item in result.applied] == list(range(5))
    assert len({item['operation_id'] for item in result.applied}) == 5
    assert result.rejected == []
    assert prepared_batch_harness.used_registered_policies is True
```

The JSON fixture is canonical UTF-8 and contains the exact frontend `prepareHeldProvisionalBatch` output plus each explicit snake_case business hash preimage. The frontend vector test must byte-compare its generated object to this file. The backend harness parses it through S4's real EntityCommand mapper, registered catalog policy, and `execute_prepared_batch` validation; a shape-only mock or reimplemented test policy is forbidden.

- [ ] **Step 3: Configure isolated desktop and mobile Chromium projects**

```typescript
// frontend/playwright.config.ts
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: '../output/playwright/ts3-report', open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:3100', trace: 'retain-on-failure' },
  webServer: {
    command: 'npm run dev -- --hostname 127.0.0.1 --port 3100',
    url: 'http://127.0.0.1:3100', reuseExistingServer: false, timeout: 120_000,
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'], viewport: { width: 412, height: 915 } } },
  ],
})
```

- [ ] **Step 4: Build a stateful generated-contract browser fixture**

```typescript
// frontend/e2e/support/mock-task-space-backend.ts
import type { Page, Route } from '@playwright/test'

export interface MockBackendState {
  currentSpaceId: string
  projects: Array<Record<string, unknown>>
  workItems: Array<Record<string, unknown>>
  notes: Map<string, Record<string, unknown>>
  locator: Record<string, unknown> | null
  sessions: Map<string, Record<string, unknown>>
  receiptMode: 'success' | 'partial' | 'unknown'
}

export async function installMockTaskSpaceBackend(page: Page, state: MockBackendState) {
  await page.addInitScript(() => {
    localStorage.setItem('pxii_master_token', 'e2e-master')
    localStorage.setItem('pxii_space_token', 'e2e-space')
    localStorage.setItem('pxii_current_space_id', 'space-a')
  })
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace('/api/v1', '')
    const body = request.postDataJSON() as Record<string, unknown> | null
    const operationId = request.headers()['idempotency-key'] ?? 'e2e-read'

    const featureWrite = request.method() !== 'GET' && (
      path === '/projects' || path === '/work-items' ||
      path.startsWith('/work-items/') || path.startsWith('/active-session/') ||
      path.startsWith('/focus-sessions/')
    )
    if (featureWrite && !/^[0-9a-f]{64}$/.test(String(body?.payloadHash ?? ''))) {
      return json(route, { code: 'invalid_payload_hash' }, 422)
    }

    if (request.method() === 'GET' && path === '/projects') {
      return json(route, { items: state.projects, nextCursor: null })
    }
    if (request.method() === 'GET' && path === '/work-items') {
      const projectId = url.searchParams.get('projectId')
      return json(route, {
        items: state.workItems.filter((item) => item.projectId === projectId),
        nextCursor: null,
      })
    }
    const noteMatch = path.match(/^\/work-items\/([^/]+)\/note$/)
    if (request.method() === 'GET' && noteMatch) {
      return json(route, state.notes.get(noteMatch[1]!) ?? null)
    }
    if (request.method() === 'PUT' && noteMatch) {
      const current = state.notes.get(noteMatch[1]!)!
      const next = replaceNoteDocument(current, body!, operationId)
      state.notes.set(noteMatch[1]!, next)
      return json(route, next)
    }
    const noteAction = path.match(
      /^\/work-items\/([^/]+)\/note\/(append-blocks|toggle-checklist-item)$/,
    )
    if (request.method() === 'POST' && noteAction) {
      const current = state.notes.get(noteAction[1]!)!
      const next = applyNoteAction(current, noteAction[2]!, body!, operationId, state)
      state.notes.set(noteAction[1]!, next)
      return json(route, next)
    }
    if (request.method() === 'GET' && path === '/active-session') {
      return json(route, state.locator)
    }
    if (request.method() === 'POST' && path === '/active-session/start') {
      if (!body?.spaceId) return json(route, { code: 'space_scope_mismatch' }, 403)
      state.locator = startLocator(body!, operationId, state)
      return json(route, state.locator, 201)
    }
    if (request.method() === 'POST' && path === '/active-session/takeover') {
      state.locator = takeoverLocator(state.locator!, body!)
      return json(route, state.locator)
    }
    if (request.method() === 'POST' && path === '/active-session/end') {
      const session = endSessionAndReleaseLocator(state.locator!, body!, state)
      state.locator = null
      return json(route, { session, locator: null })
    }
    if (request.method() === 'POST' && /\/focus-sessions\/[^/]+\/review$/.test(path)) {
      return json(route, reviewResponse(body!, operationId, state.receiptMode))
    }
    return json(route, { code: 'fixture_route_missing', path, method: request.method() }, 500)
  })
}

async function json(route: Route, value: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) })
}
```

The same file implements the helpers shown above plus Space listing/token, Project/WorkItem creation, pause/resume, provisional activation, conflict resolution, and command reconciliation. Every response uses the Task 1 Zod contract and stable operation echo; no test bypasses the repository by mutating UI state directly.

- [ ] **Step 5: Write the complete desktop/mobile vertical-loop and accessibility test**

```typescript
// frontend/e2e/task-space-session.spec.ts
import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { createMockState, installMockTaskSpaceBackend } from './support/mock-task-space-backend'

test.beforeEach(async ({ page }) => {
  await installMockTaskSpaceBackend(page, createMockState())
})

test('creates a three-level plan, edits both Note Blocks, and starts from L3', async ({ page }) => {
  await page.goto('/tasks')
  await page.getByRole('button', { name: 'Create project' }).click()
  await page.getByLabel('Project name').fill('Launch')
  await page.getByLabel('Project key').fill('LN')
  await page.getByRole('button', { name: 'Save project' }).click()
  await createWorkItemLevels(page, ['Outcome', 'Build', 'Verify'])
  for (const command of ['Add paragraph', 'Add checklist']) {
    await page.getByRole('button', { name: command }).click()
  }
  await page.getByLabel('Paragraph text').fill('Session guidance')
  await page.getByLabel('Checklist item 1').fill('Verify me')
  await page.getByRole('checkbox', { name: 'Verify me' }).check()
  await expect(page.getByRole('button', { name: /promote/i })).toHaveCount(0)

  await page.goto('/timer')
  await page.getByLabel('Level 2 attribution').selectOption({ label: 'Build' })
  await page.getByLabel('Plan Verify').check()
  await page.getByRole('button', { name: 'Start focus session' }).click()
  await expect(page.getByRole('region', { name: 'Focus session clock' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('region', { name: 'Focus session clock' })).toBeVisible()

  const accessibility = await new AxeBuilder({ page }).analyze()
  expect(accessibility.violations).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})
```

- [ ] **Step 6: Add ownership, Space-switch, offline-conflict, and partial-receipt browser cases**

```typescript
// append to frontend/e2e/task-space-session.spec.ts
test('keeps the old-Space Session, fences the old Tab, and requires takeover', async ({ browser }) => {
  const context = await browser.newContext()
  const owner = await context.newPage()
  const observer = await context.newPage()
  const state = createMockState({ activeSession: true })
  await installMockTaskSpaceBackend(owner, state)
  await installMockTaskSpaceBackend(observer, state)
  await owner.goto('/timer')
  await observer.goto('/timer')
  await expect(observer.getByText('Read-only in this Tab')).toBeVisible()
  await observer.getByRole('button', { name: 'Take over' }).click()
  await expect(observer.getByRole('button', { name: 'Pause' })).toBeEnabled()
  await expect(owner.getByText('Read-only in this Tab')).toBeVisible()

  await observer.getByRole('button', { name: /space/i }).click()
  await observer.getByRole('menuitem', { name: 'Space B' }).click()
  await expect(observer.getByText('Session running in Space A')).toBeVisible()
  await observer.getByRole('button', { name: 'Pause active session' }).click()
})

test('preserves competing offline Sessions and shows partial command receipts', async ({ page, context }) => {
  const state = createMockState({ receiptMode: 'partial' })
  await installMockTaskSpaceBackend(page, state)
  await page.goto('/timer')
  await context.setOffline(true)
  await startCachedSession(page)
  await context.setOffline(false)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(page.getByRole('dialog', { name: 'Choose the session to continue' })).toBeVisible()
  await page.getByRole('radio', { name: /Offline session/ }).check()
  await page.getByRole('button', { name: 'Continue selected session' }).click()
  await page.getByRole('button', { name: 'End session' }).click()
  await submitReview(page)
  await expect(page.getByText('Succeeded')).toBeVisible()
  await expect(page.getByText('Failed')).toBeVisible()
  await expect(page.getByText(/focused/)).toBeVisible()
})

test('holds a complete offline start-pause-resume-end-review chain for S4 import', async ({
  page, context,
}) => {
  const state = createMockState({ failOnUnexpectedActiveCall: true })
  await installMockTaskSpaceBackend(page, state)
  await page.goto('/timer')
  await context.setOffline(true)
  await startCachedSession(page)
  await page.getByRole('button', { name: 'Pause timer' }).click()
  await page.getByRole('button', { name: 'Resume timer' }).click()
  await page.getByRole('button', { name: 'End session' }).click()
  await submitReview(page)
  await context.setOffline(false)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))

  await expect(page.getByText('Awaiting sync import')).toBeVisible()
  const durable = await readSessionDurability(page, 'offline-session')
  expect(durable).toMatchObject({
    clockState: 'ended', reviewState: 'completed', metaState: 'awaiting_s4',
    allOutboxHeld: true,
  })
  expect(state.calls.activateProvisional).toHaveLength(0)
  expect(state.calls.submitReview).toHaveLength(0)

  await page.getByRole('button', { name: 'Start another session' }).click()
  await expect(page.getByText('Session running')).toBeVisible()
  expect((await readMetaOperations(page)).find((row) => row.operationId === 'offline-op-1'))
    .toMatchObject({ state: 'awaiting_s4' })
})
```

- [ ] **Step 7: Add a structural verifier for exact TS3/S4 boundaries**

```javascript
// frontend/scripts/verify-ts3-boundaries.mjs
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const root = process.cwd()
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')
const fail = (message) => { throw new Error(`TS3_BOUNDARY_FAIL ${message}`) }

for (const removed of [
  'src/stores/task-store.ts', 'src/stores/session-store.ts',
  'src/types/phase1.ts', 'src/types/phase2.ts',
]) {
  if (fs.existsSync(path.join(root, removed))) fail(`legacy file exists: ${removed}`)
}

const database = read('src/services/database.ts')
const databaseAst = ts.createSourceFile('database.ts', database, ts.ScriptTarget.Latest, true)
const versions = []
let v18Statement = ''
let declaresOpenMethod = false
const visitDatabase = (node) => {
  if (ts.isMethodDeclaration(node) && node.name &&
      ((ts.isIdentifier(node.name) && node.name.text === 'open') ||
       (ts.isStringLiteral(node.name) && node.name.text === 'open'))) {
    declaresOpenMethod = true
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'version' && node.arguments.length === 1 &&
      ts.isNumericLiteral(node.arguments[0])) {
    const version = Number(node.arguments[0].text)
    versions.push(version)
    if (version === 18) {
      let owner = node
      while (owner.parent && !ts.isExpressionStatement(owner)) owner = owner.parent
      v18Statement = owner.getText(databaseAst)
    }
  }
  ts.forEachChild(node, visitDatabase)
}
visitDatabase(databaseAst)
if (Math.max(...versions) !== 18) fail(`latest Dexie version is ${Math.max(...versions)}`)
if (!v18Statement || !v18Statement.includes('toDexieStoreStrings(V18_STORE_DEFINITIONS)')) {
  fail('v18 does not consume the structured native/Dexie schema authority')
}
if (/\.upgrade\s*\(/.test(v18Statement)) fail('v18 cutover performs row conversion')
if (declaresOpenMethod) fail('Dexie open override bypasses its PromiseExtended contract')
for (const declaration of [
  'tasks!:', 'sessions!:', 'sessionEvents!:', 'sessionContexts!:',
  'cognitiveMarks!:', 'taskTags!:', 'taskRelations!:', 'focusPatterns!:',
  'taskQuickNotes!:', 'sessionQuickNotes!:',
]) {
  if (database.includes(declaration)) fail(`legacy table property remains: ${declaration}`)
}

const cutover = read('src/services/dexie-v18-cutover.ts')
const v18Schema = read('src/services/dexie-v18-schema.ts')
for (const marker of [
  'atomicDexieV18Cutover', 'indexedDB.open(dbName, DEXIE_V18_NATIVE_VERSION)',
  'DEXIE_V17_NATIVE_VERSION', 'request.onupgradeneeded',
  'scanLegacyV17InsideUpgrade', 'transaction.abort()', 'applyNativeV18Schema',
  'openPomodoroXIDB', 'config.task_ids', 'config.dimensions',
]) {
  if (!cutover.includes(marker)) fail(`v18 atomic scan-before-DDL cutover missing: ${marker}`)
}
const cutoverAst = ts.createSourceFile('dexie-v18-cutover.ts', cutover, ts.ScriptTarget.Latest, true)
const cutoverBindings = new Set()
const visitCutover = (node) => {
  if (ts.isFunctionDeclaration(node) && node.name) cutoverBindings.add(node.name.text)
  if (ts.isImportSpecifier(node)) cutoverBindings.add(node.name.text)
  ts.forEachChild(node, visitCutover)
}
visitCutover(cutoverAst)
for (const requiredBinding of [
  'scanLegacyV17InsideUpgrade', 'atomicDexieV18Cutover', 'openPomodoroXIDB',
  'applyNativeV18Schema', 'DEXIE_V17_NATIVE_VERSION', 'DEXIE_V18_NATIVE_VERSION',
]) {
  if (!cutoverBindings.has(requiredBinding)) {
    fail(`v18 cutover binding is undefined/unimported: ${requiredBinding}`)
  }
}
for (const marker of [
  'V18_STORE_DEFINITIONS', 'toDexieStoreStrings', 'applyNativeV18Schema',
  'DEXIE_V17_NATIVE_VERSION = 170', 'DEXIE_V18_NATIVE_VERSION = 180',
  'expectedV18SchemaInventory', 'removed: true', 'deleteObjectStore',
  'directCommandIntents', 'sessionReviewDrafts', 'timerNoteComposerDrafts',
]) {
  if (!v18Schema.includes(marker)) fail(`v18 shared schema authority missing: ${marker}`)
}
if (/indexedDB\.open\(dbName,\s*(?:17|18)\s*\)/.test(cutover)) {
  fail('raw IndexedDB cutover uses Dexie logical rather than native x10 version')
}
if (/from\s+['\"].*dexie-v18-cutover/.test(database)) {
  fail('database imports cutover and creates an ESM cycle')
}
if (/from\s+['\"].*(?:database|dexie-v18-cutover)/.test(v18Schema)) {
  fail('schema authority imports database/cutover and creates an ESM cycle')
}
for (const removedStore of [
  'tasks', 'sessions', 'sessionEvents', 'sessionContexts', 'cognitiveMarks',
  'taskTags', 'taskRelations', 'focusPatterns', 'taskQuickNotes', 'sessionQuickNotes',
]) {
  if (!new RegExp(`['\"]${removedStore}['\"]`).test(cutover)) {
    fail(`v18 cutover does not delete/scan ${removedStore}`)
  }
}
const databaseTest = read('src/services/database.test.ts')
for (const marker of [
  'REQUIRED_V18_ACTIVE_STORE_NAMES',
  'expect(expected.map((store) => store.name)).toEqual(REQUIRED_V18_ACTIVE_STORE_NAMES)',
  'const survivingRows = Object.freeze(',
  'toEqual(expectedRow)',
]) {
  if (!databaseTest.includes(marker)) fail(`independent v18 schema/data oracle missing: ${marker}`)
}
for (const marker of [
  'directCommandIntents!:', 'sessionReviewDrafts!:', 'timerNoteComposerDrafts!:',
]) {
  if (!database.includes(marker)) fail(`Dexie v18 local durability table missing: ${marker}`)
}

const allSourceFiles = []
const collectSources = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) collectSources(absolute)
    else if (/\.(?:ts|tsx)$/.test(entry.name)) allSourceFiles.push(absolute)
  }
}
collectSources(path.join(root, 'src'))
for (const absolute of allSourceFiles) {
  const relative = path.relative(root, absolute).replaceAll('\\', '/')
  const source = fs.readFileSync(absolute, 'utf8')
  if (/(?:task-store|session-store|types\/phase1|types\/phase2)/.test(source)) {
    fail(`legacy import/reference remains: ${relative}`)
  }
  if (/\b(?:interface|type|class)\s+(?:Task|Session|CachedTask|CachedSession)\b/.test(source)) {
    fail(`legacy Task/Session type declaration remains: ${relative}`)
  }
  if (relative !== 'src/services/dexie-v18-cutover.ts' && /new\s+PomodoroXIDB\s*\(/.test(source)) {
    fail(`direct PomodoroXIDB construction bypasses atomic factory: ${relative}`)
  }
}

const syncTypesSource = read('src/lib/sync/types.ts')
const syncTypesAst = ts.createSourceFile(
  'sync-types.ts', syncTypesSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS,
)
const namedSyncDeclaration = (name) => {
  let found = null
  const visit = (node) => {
    if ((ts.isTypeAliasDeclaration(node) || ts.isVariableDeclaration(node)) &&
        node.name?.getText(syncTypesAst) === name) found = node
    ts.forEachChild(node, visit)
  }
  visit(syncTypesAst)
  if (!found) fail(`required Sync declaration missing: ${name}`)
  return found
}
const stringLiteralsIn = (node) => {
  const values = new Set()
  const visit = (child) => {
    if (ts.isStringLiteral(child)) values.add(child.text)
    ts.forEachChild(child, visit)
  }
  visit(node)
  return values
}
const legacyEntityKeys = ['task', 'session', 'taskQuickNote', 'sessionQuickNote']
const legacyPullKeys = ['tasks', 'sessions', 'taskQuickNotes', 'sessionQuickNotes']
const syncEntityLiterals = stringLiteralsIn(namedSyncDeclaration('SyncEntityType'))
for (const key of legacyEntityKeys) {
  if (syncEntityLiterals.has(key)) fail(`SyncEntityType retains legacy key: ${key}`)
}
for (const declarationName of ['ENTITY_TYPE_TO_TABLE', 'PULL_KEY_TO_TABLE', 'SYNC_PULL_KEYS']) {
  const literals = stringLiteralsIn(namedSyncDeclaration(declarationName))
  for (const key of [...legacyEntityKeys, ...legacyPullKeys]) {
    if (literals.has(key)) fail(`${declarationName} retains legacy key: ${key}`)
  }
}

const activeFiles = ['src/services/active-session-api.ts', 'src/lib/focus-session/active-session-coordinator.ts']
for (const file of activeFiles) {
  const source = read(file)
  for (const forbidden of ['tokenStorage', 'setSpaceToken', 'setCurrentSpaceId', 'spaceDBManager.switchTo']) {
    if (source.includes(forbidden)) fail(`${file} contains ${forbidden}`)
  }
}

const taskApi = read('src/services/task-space-api.ts')
for (const lockedPath of [
  '/note`', '/note/append-blocks', '/note/toggle-checklist-item',
]) {
  if (!taskApi.includes(lockedPath)) fail(`Task Space Adapter misses ${lockedPath}`)
}
const genericNoteCommandPath = ['/note', 'commands'].join('/')
if (taskApi.includes(genericNoteCommandPath)) fail('aggregate Note command route reintroduced')
for (const forbidden of ['promoteListItem', 'promote-list-item', 'expectedSourceWorkItemVersion']) {
  if (taskApi.includes(forbidden)) fail(`Note promotion surface reintroduced: ${forbidden}`)
}

const focusedNote = read('src/components/timer/focused-work-item-note.tsx')
for (const marker of [
  'CompactBlockPreview', 'New paragraph', 'New checklist item',
  'isAppendableDraft', 'await composer.appendExplicitly(block)',
  'ChecklistDraftEditor', 'maxDepth={2}', 'spaceId', 'workItemId',
]) {
  if (!focusedNote.includes(marker)) fail(`Timer append composer missing: ${marker}`)
}
for (const forbidden of [
  'onAppendBlocks([emptyParagraphBlock()])',
  'onAppendBlocks([emptyChecklistBlock()])',
]) {
  if (focusedNote.includes(forbidden)) fail(`Timer appends empty Block immediately: ${forbidden}`)
}
const timerDraftRegistry = read('src/lib/task-space/timer-note-composer-draft-registry.ts')
for (const marker of [
  'TimerNoteComposerDraft', 'contentVersion: 1', 'timerNoteComposerDrafts',
  'spaceId', 'workItemId', 'switchTo', "flush('current-item-change')",
  'appendExplicitly', "flush('before-append')", "flush('append-failed')",
  "appendState = 'committed'", 'hasAppliedAppendIntent',
  'timerNoteComposerDraftRegistry',
]) {
  if (!timerDraftRegistry.includes(marker)) fail(`Timer structured draft rule missing: ${marker}`)
}
const timerDraftTest = read('src/lib/task-space/timer-note-composer-draft-registry.test.ts')
for (const marker of [
  'restores it after reopen', 'never appends A content to B',
  'clears only after append succeeds', 'retains the exact structured draft on failure',
  'does not replay a committed append when local draft cleanup fails',
]) {
  if (!timerDraftTest.includes(marker)) fail(`Timer draft recovery test missing: ${marker}`)
}

const activeApi = read('src/services/active-session-api.ts')
if (!activeApi.includes('spaceId is required for global start')) {
  fail('global start does not require explicit spaceId')
}
if (!activeApi.includes('spaceId is required for provisional activation')) {
  fail('provisional activation does not require explicit spaceId')
}
for (const lockedPath of [
  '/active-session/note', '/active-session/plan/current',
  '/active-session/plan/completion-draft', '/active-session/plan/add',
  '/active-session/plan/remove',
]) {
  if (!activeApi.includes(lockedPath)) fail(`active running-content Adapter misses ${lockedPath}`)
}
for (const marker of [
  'activateProvisionalHashPayload', 'level2_version_snapshot',
  'work_item_version_snapshot', 'owner_device_id', 'owner_tab_id',
  'loser_validity_reason', 'winner_role', 'heartbeatResponseSchema.parse',
]) {
  if (!activeApi.includes(marker)) fail(`active Adapter contract marker missing: ${marker}`)
}
for (const forbidden of ['winnerSessionId', 'loserSessionId']) {
  if (activeApi.includes(forbidden)) fail(`bare conflict identity remains: ${forbidden}`)
}
const stalePlaceholders = [
  ['Provisional', 'ActivationRequest'].join(''),
  ['provisionalActivation', 'Payloads'].join(''),
  ['toActivation', 'Request'].join(''),
  ['validityCorrection:', ' JsonValue'].join(''),
]
for (const stalePlaceholder of stalePlaceholders) {
  if (activeApi.includes(stalePlaceholder)) fail(`active Adapter placeholder remains: ${stalePlaceholder}`)
}
const focusApi = read('src/services/focus-session-api.ts')
for (const forbidden of ['start', 'pause', 'resume', 'end']) {
  if (new RegExp(`async\\s+${forbidden}\\s*\\(`).test(focusApi)) {
    fail(`Space-scoped Session action reintroduced: ${forbidden}`)
  }
}
for (const allowed of ['async get(', 'async submitReview(', 'async reconcileCommands(']) {
  if (!focusApi.includes(allowed)) fail(`Space FocusSession Adapter misses ${allowed}`)
}
const reconcileSource = focusApi.slice(focusApi.indexOf('async reconcileCommands('))
if (reconcileSource.includes('expectedVersion')) fail('reconciliation Session CAS reintroduced')
for (const marker of ['abandonCommandIds', 'decisionAt', 'abandon_command_ids', 'decision_at']) {
  if (!reconcileSource.includes(marker)) fail(`command abandon contract missing: ${marker}`)
}
if (reconcileSource.includes('operationId ?? crypto.randomUUID()')) {
  fail('reconciliation Adapter invents a non-durable root operation ID')
}

const focusContracts = read('src/lib/contracts/focus-session.ts')
for (const marker of [
  'positiveOwnershipEpoch', 'cachedOwnershipEpoch: z.number().int().positive().nullable()',
  'replaySafe: z.boolean()', 'heartbeatResponseSchema',
  'updateActiveSessionNoteRequestSchema', 'removePlanItemRequestSchema',
  "'abandoned'", 'abandonCommandIds', 'selectedRole',
]) {
  if (!focusContracts.includes(marker)) fail(`FocusSession contract marker missing: ${marker}`)
}

const localTypes = read('src/types/index.ts')
if (!localTypes.includes('replaySafe: boolean')) fail('Dexie envelope/queue loses replaySafe')
for (const marker of [
  'SessionActivationApplicationReceiptRow', 'absorbedOutboxIds',
  'CommandReconciliationAttemptRow',
  'resolutionOperationId: string | null',
  "selectedRole: 'active' | 'candidate' | null", "'abandoned'",
]) {
  if (!localTypes.includes(marker)) fail(`local durable type missing: ${marker}`)
}
const localTypesAst = ts.createSourceFile('index.ts', localTypes, ts.ScriptTarget.Latest, true)
for (const legacyTypeName of ['Task', 'Session', 'CachedTask', 'CachedSession']) {
  let found = false
  const visitLegacyType = (node) => {
    if ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ||
         ts.isClassDeclaration(node)) && node.name?.text === legacyTypeName) found = true
    ts.forEachChild(node, visitLegacyType)
  }
  visitLegacyType(localTypesAst)
  if (found) fail(`legacy type declaration remains: ${legacyTypeName}`)
}
const declarationText = (name) => {
  let found = ''
  const visit = (node) => {
    if ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
        node.name.text === name) found = node.getText(localTypesAst)
    ts.forEachChild(node, visit)
  }
  visit(localTypesAst)
  if (!found) fail(`required surviving type missing: ${name}`)
  return found
}
for (const [name, forbiddenFields] of [
  ['QuickNote', ['session_id']],
  ['TimeBlock', ['task_id']],
  ['Reflection', ['related_task_ids', 'auto_linked_session_ids']],
  ['ReportDimension', ["'task_type'", "'session_type'"]],
  ['CustomReportConfig', ['task_ids', 'session_types']],
]) {
  const body = declarationText(name)
  for (const field of forbiddenFields) {
    if (body.includes(field)) fail(`${name} retains legacy Task/Session field ${field}`)
  }
}

const databaseSource = read('src/services/database.ts')
for (const marker of [
  'sessionActivationApplications', 'sessionCommandReconciliationAttempts',
]) {
  if (!databaseSource.includes(marker)) fail(`Dexie v18 local recovery table missing: ${marker}`)
}
const metaDatabase = read('src/services/meta-database.ts')
for (const marker of [
  "'pending', 'activating', 'conflict'", 'buildProvisionalOperationRow',
  'intentJson', 'payloadHash', 'get(row.operationId)',
  "throw new Error('idempotency_conflict')", 'provisionalOperations.add(row)',
  'resolutionConflictIdentityJson', 'resolutionResolvedAt',
]) {
  if (!metaDatabase.includes(marker)) fail(`Meta provisional claim rule missing: ${marker}`)
}
if (metaDatabase.includes('provisionalOperations.put(row)')) {
  fail('Meta provisional claim can overwrite terminal operation evidence')
}
const metaDatabaseTest = read('src/services/meta-database.test.ts')
for (const marker of [
  'provisionalOperationFixture', 'Partial<ProvisionalOperationRow>',
  'never rebinds an operation ID or downgrades terminal evidence',
]) {
  if (!metaDatabaseTest.includes(marker)) fail(`Meta operation binding test missing: ${marker}`)
}

const directIntents = read('src/lib/direct-command-intents.ts')
for (const marker of [
  'prepareDirectCommandIntent', 'executeDurableDirectCommand',
  'resumePendingDirectCommandIntents', 'requestJson', 'requestHash',
  "state: 'in_flight'", "state: 'terminal'", 'resultJson', 'resultHash',
]) {
  if (!directIntents.includes(marker)) fail(`durable direct-command intent missing: ${marker}`)
}
for (const forbidden of ['queryOperations', '/sync/v2/operations/query']) {
  if (directIntents.includes(forbidden)) fail(`TS3 direct command imports S4 query: ${forbidden}`)
}
const taskRepository = read('src/lib/task-space/task-space-repository.ts')
for (const marker of [
  "kind: 'create_project'", "kind: 'create_work_item'",
  "kind: 'move_work_item'", "kind: 'transition_work_item'",
  'prepareDirectCommandIntent', 'executeDurableDirectCommand',
]) {
  if (!taskRepository.includes(marker)) fail(`Task Space durable direct intent missing: ${marker}`)
}
if (/operationId\s*:\s*crypto\.randomUUID\(\)|const operationId\s*=\s*crypto\.randomUUID\(\)/
  .test(taskRepository)) {
  fail('Task Space repository allocates an operation ID after durable intent preparation')
}
const reviewDraftRegistry = read('src/lib/focus-session/session-review-draft-registry.ts')
for (const marker of [
  'createOrHydrateSessionReviewDraft', 'sessionReviewDrafts',
  'operationId', 'flushDatabase',
]) {
  if (!reviewDraftRegistry.includes(marker)) fail(`review draft durability missing: ${marker}`)
}

const outboxSource = read('src/lib/sync/outbox.ts')
for (const marker of [
  'boundedChildOperationId', 'compoundOperationId', 'compoundOrder',
  'prepareHeldProvisionalBatch', 'provisional_compound_parent_before_child_order_invalid',
  'batchId: compoundOperationId', 'requireCanonicalUtcRfc3339',
  'childp:', 'childh:', "ASCII.encode('child-v1\\0')",
  'parentBytes.byteLength >>> 8', 'PRINTABLE_ASCII_CHARACTER',
  'CHILD_SUFFIX_CHARACTER', 'isExactAscii(suffix, 512',
]) {
  if (!outboxSource.includes(marker)) fail(`provisional compound outbox rule missing: ${marker}`)
}
if (outboxSource.includes('const candidate = `${parentId}:${suffix}`') ||
    outboxSource.includes('return `child:${digest}`')) {
  fail('ambiguous pre-child-v1 operation ID derivation remains')
}
const outboxTypes = read('src/types/index.ts')
if (!outboxTypes.includes('createdAt: string') || outboxTypes.includes('createdAt: number')) {
  fail('outbox createdAt is not a canonical string contract')
}
for (const forbidden of ['new Date(row.createdAt)', 'new Date(e.createdAt)']) {
  if (outboxSource.includes(forbidden)) fail(`outbox intent timestamp is reformatted: ${forbidden}`)
}
const backendChildVectorPath = path.join(
  root, '../backend/tests/fixtures/task_space_session_child_operation_id_vectors.json',
)
const frontendChildVectorPath = path.join(
  root, 'src/lib/contracts/fixtures/task-space-session-child-operation-id-vectors.json',
)
if (!fs.existsSync(backendChildVectorPath) || !fs.existsSync(frontendChildVectorPath)) {
  fail('child operation ID vector authority or frontend copy missing')
}
const backendChildVectorBytes = fs.readFileSync(backendChildVectorPath)
const frontendChildVectorBytes = fs.readFileSync(frontendChildVectorPath)
if (!backendChildVectorBytes.equals(frontendChildVectorBytes)) {
  fail('child operation ID vector frontend copy differs from S3 bytes')
}

const sessionRepository = read('src/lib/focus-session/focus-session-repository.ts')
for (const marker of [
  "ownershipState === 'authoritative'", 'requireLocalOwner',
  'withLocalOwner', 'ProvisionalOperationLock',
  "return 'awaiting_s4'", 'assertLocalContentWritable',
  "throw new Error('blocked_conflict')", 'cacheResolvedProvisionalWinner',
  'cacheAuthoritativeActivation', 'sessionAttributionRevision',
  'authoritative_activation_outbox_not_consumable',
  'terminal_provisional_requires_s4_import', 'invalid_initial_provisional_aggregate',
  'review_operation_id_required', "kind: 'submit_review'",
  'prepareDirectCommandIntent', 'executeDurableDirectCommand',
  'holdProvisionalReviewDraftUntilImport',
]) {
  if (!sessionRepository.includes(marker)) fail(`Session repository ownership branch misses ${marker}`)
}
if (/operationId\s*:\s*input\.operationId\s*(?:\|\||\?\?)\s*crypto\.randomUUID\(\)/
  .test(sessionRepository)) {
  fail('review repository invents a non-durable operation ID')
}
if (sessionRepository.includes("return 'blocked_conflict'")) {
  fail('activation_conflict content can still enqueue blocked outbox')
}

const activeCoordinator = read('src/lib/focus-session/active-session-coordinator.ts')
for (const marker of [
  'installHeartbeat', 'installOwnedResponse', 'installEndResponse',
  'stale_active_session_response', 'aggregateIsNotOlder',
  'latestInstalledRefresh', 'installGeneration', 'recoverAppliedActivation',
  'activation_application_recovery_error', 'selectedRole', 'winnerRole',
  'provisionalLock.run', 'prepareActivationResolutionIntent',
  'recoverCommittedResolutionFromLocate', 'resolutionRequestHash',
  'resolutionConflictIdentityJson', 'resolutionResolvedAt',
  'activationConflictIdentityJson', 'applyAuthoritativeResolutionResult',
]) {
  if (!activeCoordinator.includes(marker)) fail(`active response sequencing misses ${marker}`)
}
const resolutionRecoverySource = activeCoordinator.slice(
  activeCoordinator.indexOf('private async recoverCommittedResolutionFromLocate'),
  activeCoordinator.indexOf('private async installLocated'),
)
const directResolutionSource = activeCoordinator.slice(
  activeCoordinator.indexOf('private async resolveActivationConflictLocked'),
  activeCoordinator.indexOf('private async assertResolutionResponse'),
)
for (const forbidden of ['const resolvedAt = new Date', 'resolvedAt: new Date']) {
  if (`${resolutionRecoverySource}\n${directResolutionSource}`.includes(forbidden)) {
    fail(`resolution regenerates persisted time: ${forbidden}`)
  }
}

const reconciliation = read('src/lib/focus-session/command-reconciliation.ts')
for (const marker of [
  'prepareReconciliationAttempt', 'sessionCommandReconciliationAttempts',
  'reconciliation_operation_payload_mismatch', "state: 'in_flight'",
  "state: 'terminal'", 'abandonCommandIds', 'boundRequest',
  'reconciliation_claim_lost', 'requestJson',
]) {
  if (!reconciliation.includes(marker)) fail(`durable reconciliation rule missing: ${marker}`)
}
if (activeCoordinator.includes(stalePlaceholders[2])) {
  fail('provisional activation request placeholder remains')
}

const taskContracts = read('src/lib/contracts/task-space.ts')
if (taskContracts.includes('parentItemId')) fail('Checklist item stores parentItemId')
if (!taskContracts.includes('children')) fail('Checklist nesting field is missing')
for (const forbidden of [
  "literal('heading')", "literal('ordered_list')", "literal('unordered_list')",
  "literal('work_item_ref')", 'titleSnapshot',
]) {
  if (taskContracts.includes(forbidden)) fail(`forbidden WorkItemNote v1 surface: ${forbidden}`)
}
for (const limit of [
  'MAX_NOTE_DOCUMENT_BYTES = 128 * 1024',
  'MAX_NOTE_BLOCKS = 256',
  'MAX_NOTE_ITEMS = 2048',
]) {
  if (!taskContracts.includes(limit)) fail(`WorkItemNote limit missing: ${limit}`)
}
if (/z\.array\([^\n]+\)\.max\(500\)/.test(taskContracts)) {
  fail('hidden 500-item Note ceiling remains')
}

for (const [file, markers] of [
  [taskApi, ['normalizeProjectKey', 'parent_id', 'block_id', 'item_id']],
  [activeApi, ['level2_work_item_id', 'occurred_at', 'payload:']],
  [focusApi, ['review_state', 'command_ids', 'payload:']],
]) {
  for (const marker of markers) {
    if (!file.includes(marker)) fail(`canonical internal hash mapping misses ${marker}`)
  }
}

const moveHash = taskApi.slice(
  taskApi.indexOf('const moveWorkItemHashPayload'),
  taskApi.indexOf('const transitionWorkItemHashPayload'),
)
if (moveHash.includes('projectId')) fail('Move business hash includes projectId')
for (const genericConverter of ['camelToSnake', 'snakecaseKeys', 'snakeCaseKeys']) {
  if (`${taskApi}\n${activeApi}\n${focusApi}`.includes(genericConverter)) {
    fail(`generic recursive command key conversion exists: ${genericConverter}`)
  }
}

const timerAst = ts.createSourceFile('timer-store.ts', read('src/stores/timer-store.ts'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const forbiddenNames = new Set(['tick', 'remaining'])
function scan(node) {
  if ((ts.isPropertySignature(node) || ts.isMethodSignature(node)) && node.name &&
      forbiddenNames.has(node.name.getText(timerAst))) fail(`timer persists ${node.name.getText(timerAst)}`)
  ts.forEachChild(node, scan)
}
scan(timerAst)
const timerSource = read('src/stores/timer-store.ts')
for (const marker of ['localProvisional', 'installLocalProvisional', 'updateLocalProvisionalSession']) {
  if (!timerSource.includes(marker)) fail(`local provisional timer projection missing: ${marker}`)
}

console.log('TS3_BOUNDARY_OK dexie=18 later-revision=absent legacy=absent global-token-switch=absent')
```

- [ ] **Step 8: Add restrained responsive styles and reduced-motion behavior**

```css
/* append to frontend/src/app/globals.css */
@layer components {
  .task-space-workbench,
  .focus-session-workbench {
    min-width: 0;
  }

  .work-item-note-editor textarea,
  .session-note-editor {
    field-sizing: content;
    min-height: 2.5rem;
    max-width: 100%;
    overflow-wrap: anywhere;
  }

  @media (max-width: 767px) {
    .task-space-workbench {
      grid-template-columns: minmax(0, 1fr);
    }
    .global-active-session-bar {
      align-items: flex-start;
      flex-wrap: wrap;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .task-space-workbench *,
    .focus-session-workbench * {
      scroll-behavior: auto;
      transition-duration: 0.01ms;
      animation-duration: 0.01ms;
      animation-iteration-count: 1;
    }
  }
}
```

No viewport-scaled font sizes, decorative orbs, nested cards, or marketing composition are added. Fixed icon controls keep stable dimensions; long titles truncate or wrap without covering adjacent actions.

- [ ] **Step 9: Run unit, contract, static, build, browser, and accessibility gates**

Run from `frontend/`:

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
npm run generate:api
git diff --exit-code -- openapi.json src/types/api-generated.ts
npm run test -- --run src/lib/contracts/task-space.test.ts src/lib/contracts/focus-session.test.ts src/services/database.test.ts src/services/meta-database.test.ts src/lib/direct-command-intents.test.ts src/lib/task-space src/lib/focus-session src/stores/task-space-store.test.ts src/stores/focus-session-store.test.ts src/stores/business-stores.test.ts src/services/space-db.test.ts src/stores/space-store.test.ts src/lib/on-space-switch.test.tsx src/lib/logout.test.ts src/components/task-space src/components/timer src/lib/task-space-session-acceptance.test.ts
npm run verify:ts3
npm run typecheck
npm run lint
npm run build
npm run test:e2e
Set-Location ../backend
.venv/Scripts/python.exe -m pytest -q tests/test_ts3_provisional_compound_entity_commands.py -p no:cacheprovider
```

Expected:

- generated OpenAPI/types are unchanged after regeneration;
- all selected Vitest files PASS with no unhandled rejection;
- `TS3_BOUNDARY_OK dexie=18 later-revision=absent legacy=absent global-token-switch=absent` prints;
- TypeScript, ESLint, and Next production build PASS;
- desktop and mobile Chromium projects PASS the vertical loop, refresh, Tab takeover, Space switch, offline conflict, partial receipt, zero horizontal overflow, and Axe checks.

- [ ] **Step 10: Record an honest TS3 exit report**

```markdown
# TS3 Frontend Local Loop Exit Report

- Date: 2026-07-15
- Scope: Task Space + FocusSession TS3 frontend/local-first loop
- Result: local TS3 gates passed
- Dexie: v18 final business cutover
- Legacy client Task/Session surfaces: absent
- WorkItemNote: contentVersion 1, paragraph/checklist only, two-level Checklist, whole-document CAS
- Active Session: one global locator, cross-Tab fencing, old-Space global Adapter
- Offline: local_provisional and explicit activation_conflict resolution passed
- Review: terminal time survives partial WorkItem command failure
- Browser: desktop/mobile Chromium and Axe passed

This is not final Task Space + FocusSession exit certification. New final-model
outbox events remain awaiting_s4. REST/Sync/MCP catalog parity, remote conflict
transport, recovery streaming, S5 delivery recovery, and S6 95+ recertification
remain open and must pass after expanded S4 transport convergence lands.
```

Write this exact evidence framing to `docs/task-space-design/analysis/ts3-exit-report.md`, replacing command-result words only with the observed test counts and timestamps. Do not label the project `95+`, `certified`, or fully synchronized.

- [ ] **Step 11: Commit the independently reviewable TS3 exit gate**

```powershell
git add -- frontend/package.json frontend/package-lock.json frontend/playwright.config.ts frontend/e2e/support/mock-task-space-backend.ts frontend/e2e/task-space-session.spec.ts frontend/scripts/verify-ts3-boundaries.mjs frontend/src/lib/task-space-session-acceptance.test.ts frontend/src/app/globals.css backend/tests/fixtures/ts3_provisional_compound_entity_commands.json backend/tests/test_ts3_provisional_compound_entity_commands.py docs/task-space-design/analysis/ts3-exit-report.md
git commit -m "test(frontend): close the TS3 local loop gate" -m "TS3 proves the local-first Task Space and FocusSession frontend across Dexie v18, stores, UI, ownership, offline conflict, and browser gates. Final remote REST/Sync/MCP parity remains an explicit later S4 requirement."
```

---

## TS3 Review Gate

Before execution is accepted, a reviewer must verify all of these facts from the implementation and fresh command output:

- Dexie v18 uses one native exclusive versionchange transaction whose read-only scan precedes every DDL operation; a rejection aborts at v17 with identical store/index/row inventory, and a last write from a closing v17 Tab is observed. It rejects rows in all ten removed stores, every surviving QuickNote/TimeBlock/Reflection/report legacy reference, and any old outbox row. Clean install and empty-v17 upgrade have identical final schema inventories; every old type/store/import/test consumer is gone before the first v18 typecheck; all application callers use `openPomodoroXIDB` rather than overriding/bypassing Dexie `open()`; v18 contains every final local table plus immutable activation-application receipts and declares no later frontend Dexie revision.
- Runtime schemas reject unknown Note content versions, invalid Block discriminators, duplicate IDs, Checklist nesting deeper than two levels, invalid Session axes, malformed/unknown/abandoned receipts, epoch zero/Boolean/float, cached epoch zero, `review_materialized` provisional plans, invalid abandon subsets/timestamps, and unknown active request fields before persistence. Cache view, command post-image, and recovery wire parsers are independent; command FocusSession payloads reject `clockState`, include progress/mood, and all five recovery wire entities require complete system identity and real primary keys. Outcome persona accepts only `ox|pig|hajimi|wukong` or null.
- The complete Task detail editor supports only paragraph and two-level Checklist Blocks; it contains no WorkItem-reference item or Note Item promotion action.
- The Timer compact editor shares WorkItemNote authority but Session note remains separate.
- Local Note/outbox writes are atomic; every Note path uses one six-field complete-row serializer while hashing only `{document}`; 800 ms autosave and every forced-flush boundary are covered; old responses cannot overwrite new input.
- Note conflicts retain local and remote documents and never auto-merge.
- Timer clock state comes only from persisted timestamps/pause facts; no business tick counter exists. Offline start installs a visible local projection immediately, and local pause/resume/end never call the server Coordinator.
- Observer Tabs are read-only for authoritative and provisional writes, explicit takeover increments the epoch, and stale owners are fenced before any API, business-row, or outbox effect. An `activation_conflict` is content-read-only even for its former owner: note, plan, review, and timer attempts return `blocked_conflict` with byte-for-byte unchanged business/outbox rows. One shared operation Web Lock covers final Meta owner recheck through each permitted local Space transaction and activation snapshot/apply; both write-first and reconcile-first interleavings are tested.
- Global pause/resume/end/takeover, Session-note, and all four running-plan actions use Master-scope `/active-session`, include current owner proof, and never switch the current Space token. Only owner-verified `local_provisional` content may enter `awaiting_s4`; `blocked_conflict` contains only the frozen pre-conflict activation snapshot.
- Heartbeat parses a locator-only response, retries the identical operation ID/timestamp after transport loss, preserves the latest nested aggregate, and cannot undo takeover or a newer Session mutation.
- Every active response is sequenced against the captured live fence and nondecreasing Session/Plan versions; delayed end cannot clear another Session.
- A Space switch aborts on any critical old-Space flush failure and preserves old credentials/database; a successful switch retains the global Session.
- Offline provisional competition preserves both composite identities, holds commands, contributes zero local effort, and cannot be dismissed without explicit `active | candidate` role selection; equal Session IDs in different Spaces survive reload and resolve correctly. Resolution holds the operation lock and persists its conflict identity, root, role, one canonical `resolvedAt`, and request hash before transport. Direct retry, lost-response locate recovery, and a restart after only the first Space metadata commit reuse those exact values; changed identity/role/time fails closed.
- Provisional compound outbox rows have unique S3-bounded child IDs, entity-specific canonical hashes, and persisted parent-before-child order independent of Dexie auto IDs. Successful authoritative/resumed activation atomically consumes exactly pristine Session/context/effective-attribution/plan rows and leaves unrelated rows; conflict blocks and preserves them; attempted/unknown/unexpected rows fail closed.
- Frontend `boundedChildOperationId` consumes a byte-identical copy of S3's `child-v1` vectors, uses injective length-prefixed `childp:` IDs through 128 ASCII bytes, switches to the disjoint domain-separated `childh:` namespace on first overflow, and rejects non-ASCII or suffixes over 512 bytes.
- Authoritative and conflict Space application commits an immutable result-hashed receipt before Meta/store phase two. Fresh restart validates that receipt and completes without resending; missing/mismatched receipts preserve `activating` evidence and fail recovery.
- Session terminal facts remain visible when Note or WorkItem commands fail. Before S4 import, an ended provisional Session stays `awaiting_s4`, `local_provisional`, `validity=pending`, and `reviewState=pending`; submitting its review changes no Session/Outcome/outbox row, creates no direct-command intent, and retains the exact structured draft plus original review operation ID. It never calls REST activation/review before import and releases the local active slot so a new Session can start. Partial receipts remain independent; immutable envelopes persist server `replaySafe`; each reconciliation root plus canonical payload is claimed before transport, reused after server-commit/client-crash/restart, and rotated only after that HTTP attempt is terminal. Unknown queries the original result first, same-envelope replay requires both caller and server permission, and explicit abandonment preserves the envelope while a real terminal result wins.
- New Session start is permitted after locator release or a local terminal `awaiting_s4` transition even if an older review/import/reconciliation remains pending.
- Desktop/mobile Playwright, Axe, TypeScript, ESLint, Next build, focused Vitest, generated-contract, and static boundary gates are green.
- The exit report says `local TS3 gates passed` and explicitly says final remote parity and overall certification remain pending S4-S6.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-15-task-space-session-ts3-frontend-loop.md`. Two execution options:

1. **Subagent-Driven (recommended)** - dispatch a fresh subagent per Task, run spec and quality review between Tasks, and preserve the serialized Task 1 through Task 12 order.
2. **Inline Execution** - use `superpowers:executing-plans` in this session, execute Tasks in small batches, and stop at each commit/checkpoint for review.
