# Task Space + FocusSession Integration Master Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute the approved Task Space + FocusSession model through the Backend 95+ program without retaining legacy Task/Session compatibility or certifying the pre-integration catalog.

**Architecture:** This file is the orchestration authority; the linked wave plans own code-level TDD steps. The immutable order is S3 generic mutation infrastructure, TS0 final contracts/schema, TS1 Task Space, TS2 FocusSession coordination, TS3 frontend vertical loop, S4 final Sync/MCP convergence, then S5/S6 delivery and certification.

**Tech Stack:** Python 3.13, FastAPI, SQLAlchemy 2 async, Alembic dual environments, SQLite, FastMCP 3, Pydantic 2, Next.js 15, TypeScript 5, React 19, Zustand 5, Dexie 4, Zod 4, Vitest 4, Playwright.

## Global Constraints

- The approved authority is `docs/superpowers/specs/2026-07-15-task-space-session-integration-design.md`.
- There is no real data to migrate. Breaking schema removal is required; compatibility code is forbidden.
- Do not start a later wave until every command and review gate in the immediately preceding detailed plan passes at one reviewed commit.
- Space rows never repeat `space_id`; scope, commands, events, and transport objects carry effective `spaceId`.
- WorkItemNote P0 is one aggregate with `contentVersion = 1`, exactly `paragraph` and `checklist` Blocks, nested Checklist `children[]` at no more than two levels, 128 KiB/256-Block/2048-item bounds, whole-document CAS, and dual-version conflict retention. Heading/list/rich-text Blocks, WorkItem-reference items, and Note Item promotion are forbidden in v1.
- Task detail owns full paragraph/checklist structural editing. Timer may only append a new paragraph or Checklist Block while rendering existing content read-only; it cannot replace/toggle/reorder existing Note content or expose promotion.
- Timer composer recovery is a separate structured `contentVersion = 1` draft keyed by explicit `(spaceId, workItemId)`. Current-item change persists the old key before hydrating the new key; blur/unmount/Space switch/reopen preserve it, successful explicit append clears it, failed append retains its fixed operation/Block intent, and content never crosses WorkItem keys. If append is locally durable but draft deletion fails, reopen proves the same Note/outbox operation and cleans up without a duplicate append.
- FocusSession owns time, immutable snapshots, revisions, review, envelopes, and receipts. Task Space alone owns formal WorkItem status and WorkItemNote.
- FocusSession has no `sessionType` fact in the approved final model. Plan/Outcome/state-command/persona/progress/mood vocabulary comes from the TS0 enums copied from the upstream contract; aliases are forbidden.
- Provisional activation uses TS0's strict nested `session + context + plan` snapshot. Cached ownership epoch and the exact expected-WorkItem-version map are guards; no arbitrary JSON snapshot or validity correction is accepted.
- Activation-conflict resolution selects only the persisted `active|candidate` role, derives the winner/loser composite Space/Session identities, preserves both raw histories, continues the winner as pending/authoritative, and closes the loser as interrupted/invalid with reason `activation_conflict_loser`. Equal Session IDs across Spaces remain resolvable; the request carries no candidate Session ID or Space. Conflict-period local content writes are zero-effect/read-only. One persisted operation ID and `resolvedAt` are reused across direct, retry, and restart paths. P0 does not rewrite timer counters.
- Meta `ActiveSessionOperation` durably binds every active command ID/hash/closed intent/phase and a bounded immutable result descriptor once returnable; Space business content stays in original S3 operation results. Cross-Space conflict pairs come only from that journal, and resolution transfers `claiming` directly to the winner with epoch+1 in one Meta CAS; it never clears to an ABA-prone empty slot.
- Frontend Meta provisional roots persist canonical full start `intentJson` plus `payloadHash`. Claim reads by operation ID first: changed intent is an idempotency conflict, identical replay cannot downgrade terminal state, and only a new operation may pass the active-slot check and insert its row.
- Immutable command reconciliation carries ordered `commandIds`, caller `replaySafe`, an `abandonCommandIds` subset, and canonical `decisionAt`, with no Session `expectedVersion`; later Session revisions cannot block receipt convergence. The client persists and reuses one root operation ID before sending. Replay and abandonment are serialized by a durable root claim, direct Task Space execution of an unclaimed/abandoned envelope is fenced, `abandoned` is terminal, and a real stored Task Space result always wins.
- Command `payloadHash` is RFC 8785 SHA-256 over only the command-specific business payload. S3 owns the backend helper/vector authority; TS3 consumes it with the exact frontend canonicalizer. S3 `app.mutation.types` also uniquely owns the versioned `child-v1` operation-ID helper and tracked backend vectors; TS1/TS2 call that owner and TS3 verifies its port against a byte-identical fixture copy.
- Master-scoped `/active-session` is the only public running-lifecycle surface. Start/provisional activation explicitly authorize `spaceId`; later actions derive the owner from durable locator or activation-conflict state. Space-scoped `/focus-sessions` exposes only history, review, and command reconciliation.
- The owner-fenced running-content set is exactly Session note update, current-plan selection, completion-draft update, plan-item add, and plan-item remove. Authoritative active writes use the master Coordinator; ordinary S4 `EntityCommand` cannot bypass it. Local provisional/conflict records remain eligible for the closed offline Sync path.
- The migration ledger is fixed:

```text
Space: space_008_sync_retention_snapshot
    -> space_009_mutation_journal
    -> space_010_task_space_focus_session
    -> space_011_sync_clients_streaming

Meta:  meta_001
    -> meta_002_active_session_locator

Dexie: v16 current sync tables
    -> v17 S3 operation identity
    -> v18 TS3 final business/local conflict schema
    -> v19 S4 opaque Sync recovery protocol
```

- The final public catalog contains no `task`, `session`, `taskQuickNote`, or `sessionQuickNote` entry. S4 operates on the TS0 31-entry catalog.
- Startup performs one fleet-wide, dual-database, read-only cutover preflight against Meta and every registered Space before any recovery write, backup/checkpoint, Alembic DDL, index rebuild, or file replacement. Any rejection preserves the complete data-root inventory byte-for-byte; a per-Space revision check is defense in depth, not authorization to migrate Meta or an earlier Space first.
- Dexie v18 deletes every legacy Task/Session authority or derivative store: `tasks`, `sessions`, `sessionEvents`, `sessionContexts`, `cognitiveMarks`, `taskTags`, `taskRelations`, `focusPatterns`, `taskQuickNotes`, and `sessionQuickNotes`. One native exclusive versionchange transaction first scans all old stores/references/outbox read-only, aborts at v17 before DDL on rejection, and applies v18 DDL only after a clean scan in that same transaction; Dexie 4 logical 17/18 are native IndexedDB 170/180, and a separate probe/open sequence or raw 17/18 request is forbidden. Surviving `quickNotes` and `timeBlocks` schemas and row types contain no `session_id` or `task_id`; Reflection/report types contain no legacy Task/Session link/filter fields. All frontend code/tests migrate before the first v18 typecheck gate, and all callers use the typed `openPomodoroXIDB` factory rather than overriding Dexie `open()`.
- Dexie v18 includes local `directCommandIntents`, `sessionReviewDrafts`, and `timerNoteComposerDrafts`. A frozen active-store oracle independent from the schema definition exact-compares clean/upgrade/native/Dexie inventories, and positive surviving rows compare field-for-field. S4 v19 spreads the complete v18 definitions unchanged before adding protocol state.
- Direct online `createProject`, `createWorkItem`, `moveWorkItem`, `transitionWorkItem`, and `submitReview` persist a fixed operation ID plus canonical complete request JSON/hash before transport. Response loss or restart resends the same TS1/TS2/S3 idempotent POST, then atomically caches the parsed result and terminates the intent. Note stays on its outbox path, ActiveSession stays on locator/Meta recovery, and TS3 does not use S4 operation-query.
- S4 exposes exactly six shared Sync operations: operation query, push, pull, recover, ACK, and status. Every selected persisted operation ID is queried before push receipt creation or replay. Terminal results reuse their immutable original batch receipt; pending/recovery-required results block; only confirmed-unknown operations send. A TS3 provisional compound uses `prepareHeldProvisionalBatch(...).batchId` unchanged as its persisted batch authority, and Dexie v19 admits valid `awaiting_s4` groups through `pending -> meta_pending -> ready` without transmitting `blocked_conflict`. One exclusive per-Space Browser Web Lock token fences all authority writers through query/push response application; full post-image bytes and command-specific business hashes are separately verified; query/push terminal results use crash-safe Space evidence before exact Meta reconciliation; retained terminal conflict/error rows are non-sendable and retry only by a new operation.
- S5 snapshots and S6 certification must assert `space_011_sync_clients_streaming`; no pre-TS score or report is certification evidence.

## Plan Set

| Order | Detailed plan | Exit authority |
|---:|---|---|
| 1 | `2026-07-14-backend-95plus-s3-knowledge-consistency.md` | Generic multi-effect UoW, journal, policy seam, CAS |
| 2 | `2026-07-15-task-space-session-ts0-contract-schema.md` | Final dual schema, 31-entry catalog, breaking cutover, contract OpenAPI |
| 3 | `2026-07-15-task-space-session-ts1-task-space-note.md` | Project/WorkItem tree, paragraph/checklist WorkItemNote v1 |
| 4 | `2026-07-15-task-space-session-ts2-focus-session.md` | Session lifecycle, command reconciliation, global ownership |
| 5 | `2026-07-15-task-space-session-ts3-frontend-loop.md` | Local-first usable vertical loop, offline/conflict UX |
| 6 | `2026-07-14-backend-95plus-s4-sync-mcp.md` | Final REST/Sync/MCP/frontend protocol convergence |
| 7 | `2026-07-14-backend-95plus-s5-delivery.md` | Final-model recovery, deploy, rollback evidence |
| 8 | `2026-07-14-backend-95plus-s6-certification.md` | Final-model 95+ certification decision |

---

### Task 1: Land S3 Generic Mutation Infrastructure

**Files:**
- Execute: `docs/superpowers/plans/2026-07-14-backend-95plus-s3-knowledge-consistency.md`
- Verify: `scripts/audit-report/verify-backend-95-implementation-plans.cjs`

**Interfaces:**
- Consumes: S2 `SpaceRuntimeHandle`, compiled catalog, leases, fencing, and migration head `space_008_sync_retention_snapshot`.
- Produces: `space_009_mutation_journal`; `MutationCompileContext.command(...)`; `MutationDomainPolicy`; `MutationCommand.sync_events`; durable result values; UoW execute/recovery methods.

- [ ] **Step 1: Execute every S3 checkbox in order**

Use the detailed S3 plan without omitting its TDD, review, or commit steps.

- [ ] **Step 2: Verify the S3 and cross-wave plan contract**

Run from repository root:

```powershell
node scripts/audit-report/verify-backend-95-implementation-plans.cjs
```

Expected: `VERIFY_OK plans=7 tasks=59 steps=336 cross_wave=pass`.

- [ ] **Step 3: Hold the TS0 admission gate**

Run from `backend/`:

```powershell
.\.venv\Scripts\python.exe -m alembic -n alembic:space heads
.\.venv\Scripts\python.exe -m pytest -q tests/test_mutation_journal.py tests/test_mutation_recovery.py tests/test_entity_concurrency.py -p no:cacheprovider
```

Expected: the only Space head is `space_009_mutation_journal`; focused tests PASS.

### Task 2: Land TS0 Final Contract And Dual Schema

**Files:**
- Execute: `docs/superpowers/plans/2026-07-15-task-space-session-ts0-contract-schema.md`

**Interfaces:**
- Consumes: S3 multi-effect commands, domain-policy registration, strict-CAS catalog policy, and reserved TS error codes.
- Produces: one S2-registered whole-fleet TS0 cutover preflight; `space_010_task_space_focus_session`, `meta_002_active_session_locator`, 14 final Space tables, Meta locator plus internal active-operation journal, 31 catalog entries, contract routers, deterministic camelCase OpenAPI/types, fail-closed S3-journal cutover, and removal of legacy Task/Session surfaces.

- [ ] **Step 1: Execute every TS0 checkbox in order**

Follow the TS0 plan through its eight independent commits.

- [ ] **Step 2: Verify both migration heads and breaking removal**

Run from `backend/`:

```powershell
.\.venv\Scripts\python.exe -m alembic -n alembic:space heads
.\.venv\Scripts\python.exe -m alembic -n alembic:meta heads
.\.venv\Scripts\python.exe -m pytest -q tests/test_task_space_session_migration.py tests/test_active_session_locator_migration.py tests/test_task_space_breaking_cutover.py -p no:cacheprovider
```

Expected: a late legacy-bearing Space rejects before either head or any fleet byte changes; the clean fleet reaches `space_010_task_space_focus_session` and `meta_002_active_session_locator`; tests PASS and legacy endpoints/keys are absent.

### Task 3: Land TS1 Task Space And WorkItemNote

**Files:**
- Execute: `docs/superpowers/plans/2026-07-15-task-space-session-ts1-task-space-note.md`

**Interfaces:**
- Consumes: TS0 contracts/models/catalog and S3 `MutationCompileContext`/UoW.
- Produces: `TaskSpaceQueryModule`, `TaskSpaceCommandModule`, deterministic Project display-key allocation, tree/status invariants, bounded paragraph/checklist Note validation, whole-document CAS, and dual-version conflict preservation.

- [ ] **Step 1: Execute every TS1 checkbox in order**

Do not replace the final model with legacy Task compatibility or a pure-text
Note. Paragraph and Checklist are both required structured Block variants.

- [ ] **Step 2: Verify Task Space domain and Adapter gates**

Run from `backend/`:

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_work_item_note_document.py tests/test_task_space_project.py tests/test_task_space_tree.py tests/test_work_item_note_cas.py tests/test_task_space_routes.py -p no:cacheprovider
```

Expected: all tests PASS; only paragraph/checklist documents are accepted,
Checklist changes do not transition WorkItems, and CAS conflicts preserve both
client-visible versions without automatic merge.

### Task 4: Land TS2 FocusSession And Global Ownership

**Files:**
- Execute: `docs/superpowers/plans/2026-07-15-task-space-session-ts2-focus-session.md`

**Interfaces:**
- Consumes: TS0 FocusSession/ActiveSession Protocols, TS1 WorkItem commands, S3 UoW through public `FocusSessionModule` methods, and both TS0 migration heads.
- Produces: durable clock/revision/review facts, materialized valid-Session EffortProjection, immutable command envelopes, per-command receipts, caller/server replay double permission, the sole public active-lifecycle and five-command running-content Coordinator, explicit start-Space authorization, the Meta operation journal, request/startup `claiming/active/releasing` recovery, ownership-epoch fencing, and atomic provisional-conflict resolution transfer.

- [ ] **Step 1: Execute every TS2 checkbox in order**

Keep Session time persistence independent from Note and WorkItem command success.

- [ ] **Step 2: Verify lifecycle, reconciliation, and coordination gates**

Run from `backend/`:

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_focus_session_hash_contract.py tests/test_focus_session_module.py tests/test_focus_session_revisions.py tests/test_effort_projection.py tests/test_session_command_reconciliation.py tests/test_active_session_coordinator.py tests/test_active_session_recovery.py tests/test_offline_session_activation.py tests/test_focus_session_routes.py tests/test_active_session_routes.py -p no:cacheprovider
```

Expected: all tests PASS; stale epochs have zero side effects and unknown command results query before replay.

### Task 5: Land TS3 Frontend Vertical Loop

**Files:**
- Execute: `docs/superpowers/plans/2026-07-15-task-space-session-ts3-frontend-loop.md`

**Interfaces:**
- Consumes: generated TS0-TS2 API types and working Task Space, FocusSession, and ActiveSession Adapters; S3 `child-v1` and `backend/tests/fixtures/task_space_session_child_operation_id_vectors.json` as the sole child-ID oracle.
- Produces: Dexie v18 final tables plus independent exact inventory/data-preservation proofs; local repositories/outbox; immutable provisional full-intent binding; durable direct Project/WorkItem/review intents with exact idempotent POST recovery; structured Space/WorkItem Timer composer and review drafts; explicit per-command RFC 8785 hashes; complete Task Space/Timer/review surfaces; Coordinator-only authoritative running-content writes; cross-Tab ownership; critical Space-switch flush; Note conflict retention; and provisional activation UX without claiming S4 transport parity.

- [ ] **Step 1: Execute every TS3 checkbox in order**

Do not add S4 cursor/ACK/recovery protocol code inside TS3.

- [ ] **Step 2: Verify frontend unit, integration, and browser gates**

Run from `frontend/`:

```powershell
npm run test
npm run lint
npm run typecheck
npm run build
npx playwright test e2e/task-space-session.spec.ts
```

Expected: all commands exit `0`; desktop/mobile scenarios preserve active Session, structured Note/Timer/review drafts, ownership, direct-command response-loss recovery, and conflict states. The TS3 boundary gate proves all four legacy Sync entity keys and plural pull/table keys absent and proves no TS3 direct command calls S4 operation-query.

### Task 6: Land S4 Final Sync And MCP Convergence

**Files:**
- Execute: `docs/superpowers/plans/2026-07-14-backend-95plus-s4-sync-mcp.md`

**Interfaces:**
- Consumes: final TS0 catalog, TS1/TS2 domain policies, TS3 Dexie v18 schema, and S3 UoW.
- Produces: `space_011_sync_clients_streaming`, Dexie v19 admission of TS3 held rows, opaque Sync v2 with six shared operations and query-before-push recovery, persisted standalone/compound batch authority, bounded recovery, strict runtime response validation, and complete REST/MCP/frontend parity.

- [ ] **Step 1: Execute every S4 checkbox in order**

The old Sync endpoints remain absent; WorkItemNote always uses strict CAS. Lost responses query the original operation ID first, and compound retries reuse the persisted TS3 batch root rather than hashing child IDs again.

- [ ] **Step 2: Verify final protocol and plan gates**

Run from repository root:

```powershell
node scripts/audit-report/verify-backend-95-implementation-plans.cjs
cd backend
.\.venv\Scripts\python.exe -m pytest -q tests/test_sync_mutation_ledger.py tests/test_sync_client_ack.py tests/test_sync_snapshot_streaming.py tests/test_mcp_sync_parity.py tests/test_openapi_contract.py -p no:cacheprovider
```

Expected: plan verifier prints `VERIFY_OK`; backend tests PASS; Space head is `space_011_sync_clients_streaming`.

### Task 7: Regenerate S5 Delivery Evidence Against The Final Model

**Files:**
- Execute: `docs/superpowers/plans/2026-07-14-backend-95plus-s5-delivery.md`

**Interfaces:**
- Consumes: reviewed S4 commit with final Space/Meta/catalog/Dexie contracts.
- Produces: final-model snapshot/restore/rollback, supply-chain, deployment, and release evidence.

- [ ] **Step 1: Execute every S5 checkbox and live gate**

Reject any manifest whose Space head differs from `space_011_sync_clients_streaming`.

- [ ] **Step 2: Preserve the exact reviewed S5 evidence commit**

Run from repository root:

```powershell
git status --short
git rev-parse HEAD
```

Expected: the reviewed tree is clean and the full 40-character commit is recorded in S5 evidence.

### Task 8: Run S6 Final-Model Certification

**Files:**
- Execute: `docs/superpowers/plans/2026-07-14-backend-95plus-s6-certification.md`

**Interfaces:**
- Consumes: exact reviewed S5 evidence subject and every final-model producer artifact.
- Produces: a reproducible certified/not-certified decision; it does not inherit the pre-Task-Space score.

- [ ] **Step 1: Execute every S6 checkbox and detached verification gate**

Run only after S5 accepts zero release blockers.

- [ ] **Step 2: Verify certification claims bind the final model**

Require the final report to name all of these values:

```text
space_011_sync_clients_streaming
meta_002_active_session_locator
31-entry final catalog
Dexie v19
legacy Task/Session absent
```

Expected: a certification claim is valid only when every predicate and retained artifact verifies against one exact commit.

## Master Plan Integrity Gate

Run from repository root before admitting S3 implementation and again before the
Master exit review. Both verifiers and both mutation suites are required; a
normal green result cannot substitute for a self-test that proves the gate fails
closed when a protected contract is weakened.

```powershell
node scripts/audit-report/verify-backend-95-implementation-plans.cjs
node scripts/audit-report/verify-backend-95-implementation-plans.cjs --self-test
node scripts/audit-report/verify-task-space-session-plans.cjs
node scripts/audit-report/verify-task-space-session-plans.cjs --self-test
```

Expected: all four commands exit `0`; the normal runs report cross-wave PASS and
each self-test reports every declared mutation rejected before re-running its
normal verifier successfully.

## Master Exit Criteria

1. The implementation order is S3 -> TS0 -> TS1 -> TS2 -> TS3 -> S4 -> S5 -> S6 with no bypass.
2. Task Space and FocusSession facts have one owner each; no Adapter creates a second writable authority.
3. WorkItemNote v1 has only paragraph/checklist Blocks, stable IDs, at most two Checklist levels, whole-document CAS, and conflict preservation without automatic merge or Item promotion.
4. Session time survives Note/WorkItem failures; command receipts expose partial success and query unknown results first.
5. Level-2 actual effort equals a fresh recomputation from terminal valid Sessions and the effective attribution revision, independent of task-command receipts.
6. One active Session is enforced across Spaces/Tabs with durable recovery and ownership fencing.
7. Offline competing Sessions do not contribute effort until explicit resolution.
8. S4 certifies the final catalog and S5/S6 bind evidence to `space_011_sync_clients_streaming`.
9. Every active operation is recoverable from immutable Meta intent plus named
   Space child outcomes; a durable conflict stays visible after refresh and a
   partial/rejected cross-Space resolution never exposes a winner as active.
10. Running Session note/plan writes are owner-fenced Coordinator commands, while
   reconciliation replays only with caller and server permission.
11. A whole-fleet read-only preflight accepts every Meta/Space target before the
    first migration write; the legacy-bearing negative lane is byte-identical.
12. Dexie v18 performs its legacy scan before DDL in one exclusive versionchange
    transaction, observes a closing v17 Tab's last write, and aborts at v17 with
    identical inventory on any removed row/reference/outbox evidence.
13. S4 exposes six REST/MCP/frontend-equivalent operations; every push is
    query-first, and standalone or compound retries preserve their original
    operation/batch authority across lost responses and restarts.

## Execution Handoff

Use `superpowers:subagent-driven-development` for one fresh implementation agent per detailed-plan Task with specification and quality review between Tasks. Use `superpowers:executing-plans` only when the entire wave will be executed inline with explicit checkpoints.
