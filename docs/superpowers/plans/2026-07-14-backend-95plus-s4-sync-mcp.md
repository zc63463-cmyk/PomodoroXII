# Backend 95+ S4 Sync And MCP Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build one lossless Sync v2 protocol shared by REST, MCP, and the official frontend, with opaque cursors, durable client acknowledgement, bounded resumable recovery, and ledger visibility governed by the S3 Unit of Work.

**Architecture:** `SyncProtocol` is the deep Module. It consumes the final TS0 `CompiledEntityCatalog`, S2 runtime scope/leases, and S3 `MutationUnitOfWork`; REST and MCP are transport Adapters over the same operation catalog. A durable client registry establishes the retention waterline, while manifest-backed gzip chunks make full recovery resumable and bounded. The frontend preserves TS3's final-business Dexie v18 schema, adds opaque protocol state and recovery chunks in Dexie v19, persists before ACK, and can resume after a browser crash without exposing a partial full recovery.

**Tech Stack:** Python 3.13, FastAPI, SQLAlchemy 2 async, Alembic Space chain, SQLite, FastMCP 3, Pydantic 2, RFC 8785 JCS, gzip/JSON Lines, pytest, tracemalloc, Next.js 15, TypeScript 5, Axios, Dexie 4, Vitest, OpenAPI TypeScript.

## Global Constraints

- Start only after TS0-TS3 are merged and their gates are green; consume `backend/app/mutation/unit_of_work.py::MutationUnitOfWork.execute(scope, request, operation_id)`, `execute_batch(scope, requests, batch_id, *, operation_ids=None)`, `execute_prepared_batch(scope, items, batch_id)`, `recover_under_lease(scope, lease)`, and `inspect_recovery(view)` without bypassing them.
- The compiled catalog contains exactly the TS0 31 entries. Its Sync-enabled final keys include `project`, `statusDefinition`, `typeDefinition`, `label`, `workItemLabel`, `workItem`, `workItemNote`, `focusSession`, `sessionTaskContext`, `sessionAttributionRevision`, `sessionWorkItemPlan`, and `sessionWorkItemOutcome`; `task`, `session`, `taskQuickNote`, and `sessionQuickNote` are forbidden.
- Consume `backend/app/runtime/leases.py::RuntimeLeaseCoordinator` and `backend/app/registry/catalog.py::CompiledEntityCatalog`; do not open an independent database session or derive an arbitrary Space path in Sync or MCP code.
- `space.db` remains authoritative for entity identity, lifecycle, Folder graph, version, and Sync state; Markdown remains authoritative for Note body; paths, frontmatter, `index.db`, and FTS remain derived projections.
- One active backend process per persistent data root is the supported topology; active-active and network-filesystem multi-writer operation remain out of scope.
- Every successful Sync-enabled effect emits exactly one visible event after its operation reaches `FINALIZED`; one compound operation may publish an ordered tuple of final post-images atomically, while a non-Sync mutation or rollback emits none.
- A clean v2 application appears in `PushResult.applied` with no resolution; an LWW remote application appears there with `resolution="remote"`. Server-local, tombstone, circular-reference, and unresolved CAS outcomes are rejected and never appear in `applied`.
- V2 preserves the TS3 official outbox's strict canonical UTC RFC3339 string `createdAt` byte-for-byte as `client_updated_at` through REST/MCP parsing and S3 request hashing. V18 rejects every old numeric/nonempty outbox before cutover, so S4 contains no numeric-to-date conversion or fallback. Only S3's under-lease compiler compares it with authoritative `updated_at`; transport code never reformats it, decides LWW, or invents a server timestamp.
- REST v1 default error bodies remain exact legacy `detail`/`error_type` bodies; canonical errors are opt-in and are always reflected in the approved headers.
- Every official-client operation-query, push, pull, recover, ACK, and status request sends `Accept: application/vnd.pomodoroxii.error+json;version=2` through one shared Sync v2 transport helper.
- Legacy numeric/timestamp Sync endpoints and old-client aliases are absent. Only `/sync/v2/*` is public after the TS0 breaking cutover.
- The opaque v2 cursor is an indivisible string at every public boundary. Callers cannot send or persist a numeric ledger ID.
- Active-client retention uses the minimum acknowledged cursor. An expired client is excluded only after it is durably marked as requiring full recovery.
- Recovery chunks contain at most 500 entities and at most 8 MiB uncompressed; the 10,000-Note fixture uses deterministic 4 KiB UTF-8 bodies.
- Incremental pull also returns at most 500 events and 8 MiB canonical wire JSON per page; count is a caller ceiling, not permission to materialize 500 maximum-size events.
- Snapshot generation must remain at or below 128 MiB peak Python heap under `tracemalloc`; the Linux system gate must remain at or below 256 MiB maximum RSS under `/usr/bin/time -v`.
- Frontend scope is limited to transport code, regenerated types, Dexie v19 protocol state layered on TS3's v18 final business schema, client ACK, and crash-safe full recovery. No UI or unrelated business feature is included.
- S4 consumes three independent TS3 representations: API/cache view, strict Outbox command post-image, and authoritative recovery wire snapshot. It never derives a post-image schema by omitting fields from the cache view. FocusSession command payloads map `sessionId -> id`, contain progress/mood, and reject derived `clockState`; recovery uses five complete wire schemas with `id/spaceId/createdAt/updatedAt/version`, verifies top-level entity identity/version/timestamp, then maps `id -> sessionId` only for the FocusSession local key and derives its clock. Outcome command hashes include all three persona fields.
- Both WorkItemNote write paths must already have used TS3's one six-field complete-next-row serializer. S4 accepts that complete post-image, continues to hash exactly `{document}`, and rejects a partial overwrite payload before admission.
- Dexie v19 must consume every valid TS3 `awaiting_s4` row: validate its immutable `spaceId` equals the owning `PomodoroXIDB.spaceId`, plus `transportState`, canonical `createdAt`, `compoundOperationId`, and `compoundOrder`; call the unchanged TS3 `prepareHeldProvisionalBatch`; persist/admit valid standalone or compound rows as transport-ready; and fail readiness on malformed groups. It retains `blocked_conflict` unchanged. Admission follows the durable `pending -> meta_pending -> ready` state machine; push is forbidden outside `ready`. The ready marker persists a canonical per-root ordered child identity tuple and SHA-256, not flat operation/root ID sets. Each child identity includes durable key, `spaceId`, `entityType`, `entityId`, `action`, canonical payload bytes plus recomputed `payloadHash`, `operationId`, `expectedVersion`, canonical `createdAt`, `transportState`, `compoundOperationId`, `compoundOrder`, and `attemptCount`. Ready proof compares every byte/field, root digest, and exact Meta `transport_ready` root identity; cross-Space/reparent/order/payload drift is an integrity failure.
- A TS3 review drafted for an ended offline Session never widens that held batch: before import it leaves the Session ended, `local_provisional`, `validity=pending`, and `reviewState=pending`, writes zero Outcome/review Outbox/direct-intent rows, and retains the structured draft plus its unsent fixed operation ID. S4 may resume that draft only after exact `meta_reconciled` terminal evidence and matching Meta `transport_resolved` hashes prove the original unchanged batch was fully applied with no conflict/error and the expected FocusSession child. With no existing intent, resume reads a still-pending authoritative imported Session with zero Outcomes, uses its version for CAS, and persists the original operation ID/review business fields through the durable direct-command helper. With a prepared/in-flight intent, it validates and reuses that exact canonical persisted request/version before consulting or gating on any newer local Session state or Outcomes. Only the authoritative response transaction may install the completed review/Outcomes and delete the draft; `prepareHeldProvisionalBatch` is not extended with review children.
- Every production writer of same-Space outbox, Meta provisional/admission state, local conflict/resolution state, pending receipt, terminal evidence, pull/recovery rebase, or push/query response application must hold one runtime-validated `SpaceAuthorityToken` issued only inside the exclusive Browser Web Lock `pomodoroxii:space-authority:v1:<spaceId>`. `pushAllPending()` holds that same lock continuously across terminal-evidence recovery, admission, selection, operation query, post-query transaction, `syncV2Push`, and terminal response application; the lock is not released until the network call has completed or thrown. Browser crash/Tab close releases it automatically. Missing Web Locks or a writer without the live token fails closed; there is no localStorage lease fallback and no optional-token writer overload. Fresh post-query Meta and Space checks remain defense in depth for direct IndexedDB corruption, not a substitute for the cross-Tab fence.
- Both an operation-query terminal result and a push terminal response must first persist exact Space-side `SyncTerminalApplicationEvidence` in the same transaction that applies outcomes and only then deletes matching applied outbox rows and the exact active receipt. A token-bound two-phase coordinator next reconciles the exact compound root, ordered operation/root digest, and canonical result SHA-256 from Meta `transport_ready` to `transport_resolved`; restart resumes any `space_committed` evidence after a crash before/during the Meta commit. Ready proof accepts a missing live root only through byte-identical durable terminal evidence and exact Meta reconciliation state, never as an unexplained orphan.
- Query-time drift handling is closed and bounded: only the typed `new_complete_paired_root` decision may rerun admission and selection/query, at most once per push cycle. Receipt corruption, missing/replaced children, reparent/order/action/entity/payload/hash/operation/version/timestamp/transport/attempt drift, Meta orphan, or terminal-evidence mismatch fails closed immediately. Exceeding the one restart budget exits with `push_authority_restart_exhausted`; no unbounded `continue`/requery loop is allowed.
- A terminal conflict/error never remains `ready`. S4 extends local transport state with `terminal_conflict|terminal_error`; exact terminal evidence explains those retained diagnostic rows, and selection excludes them. A retryable terminal error can create exactly one successor only through an explicit token-bound retry intent after `nextAttemptAt`, with a new operation ID and unchanged canonical business payload/hash. The terminal original persists its successor operation ID, the successor persists its predecessor, and a repeated intent returns that same linked ID rather than branching. The terminal original is never queried or pushed again.
- Before creating any push receipt or replaying an existing one, query every selected operation ID by its persisted `operationId`. The classifier checks `pending`/`recovery_required` before terminal settlement: either state blocks the authority unit even when another item is terminal, and a terminal/nonterminal mixture can never enter settlement. Settlement is allowed only when every requested item is terminal and the parser has proved one original batch identity plus byte-equivalent complete `PushResult` values; terminal/unknown mixtures fail closed. Only all-confirmed-unknown operations proceed. An existing active receipt is validated and queried again before every replay. An attempted direct WorkItemNote command that was committed but lost its response settles through this query. If it is unknown, its retry batch authority is its original `operationId`, never a newly hashed batch ID. A lost-response restart first queries the same persisted operation IDs before it may settle or resend the authority unit.
- A provisional compound's persisted `compoundOperationId` is its S3 batch authority. A compound uses only `prepareHeldProvisionalBatch(...).batchId` as that authority. `prepareHeldProvisionalBatch(rows).batchId` is sent unchanged to `execute_prepared_batch`; S4 never hashes the child IDs into a replacement batch. Unattempted unrelated standalone rows may still use the deterministic ordered-operation hash.
- REST and MCP call the same transport-neutral event parser. It applies the existing 256 KiB canonical UTF-8 payload ceiling per event, the 500-event ceiling, and `sync_canonical_batch_max_bytes=10*1024*1024` before registration/UoW work. ASGI separately uses `request_body_max_bytes=11*1024*1024` for raw HTTP envelope bytes; canonical size never reuses the raw-body setting.
- S3 already pins backend `rfc8785==0.1.4`, and TS3 already pins frontend `json-canonicalize@2.0.0` plus cross-language command-payload vectors. S4 verifies and reuses those exact dependencies; it must not introduce or upgrade a second canonicalizer.
- Public IDs use one strict ASCII allowlist: `client_id` is 1..64 bytes, `batch_id`/`operation_id` reuse S3's 1..128-byte validator, and cursor/page tokens are 16..2048 ASCII bytes. Pull `limit` is a non-Boolean integer in `1..500`; `expected_version` is a non-Boolean nonnegative integer or null under the action rule. REST, MCP, and the protocol entrypoint all call the same validator, with the Adapter call occurring before a runtime handle or registry write.
- The operation/batch validator accepts every 1-128-byte string in `[\x21-\x7e]`; `[A-Za-z0-9._:-]` is only the `child-v1` suffix grammar. Recovery responses satisfy `has_more === (next_page_token !== null)` at the runtime-parser boundary. Retained Schedule and TimeBlock `start_time/end_time` follow the locked Registry/OpenAPI union `HH:mm | canonical UTC RFC3339`, including existing ISO fixtures.
- Every S4 path that obtains matching Space-exclusive calls S3 `recover_under_lease(scope, lease)` immediately after acquisition and before opening/reading its own session state. This includes client registration, push pre-registration, pull, ACK, full recovery, retention, and manifest GC; open-time recovery is insufficient for a mutation handle that waited without a Space lease.
- This document is an implementation plan, not execution or certification evidence. Every expected PASS, review approval, score effect, and S4/S5 handoff below remains conditional on fresh evidence at the exact implementation SHA; this text awards no points and certifies no task.
- Do not delete retained test artifacts or any existing untracked file.
- Every shell block starts from the repository root and has no inherited working directory. A block that runs backend/frontend-local commands begins with `cd backend`/`cd frontend`; every `git add` block therefore uses repository-root paths.

---

## File Structure And Responsibilities

### Backend schema and protocol core

- Create `backend/alembic_space/versions/011_sync_clients_streaming.py`: add only S4 client/streaming schema on top of `space_010_task_space_focus_session`; never recreate S3 operation, batch, version, visibility, or TS0 business columns.
- Create `backend/app/models/sync_client.py`: durable client identity, acknowledgement, expiry, and full-recovery requirement.
- Create `backend/app/models/sync_recovery.py`: manifest and compressed chunk ORM rows.
- Modify `backend/app/models/tombstone.py`: link a tombstone to the visible delete-event sequence used by safe pruning.
- Modify `backend/app/models/__init__.py`: register the three S4 models with Space metadata.
- Create `backend/app/sync/cursor.py`: authenticated opaque cursor codec; this is the only code allowed to translate a cursor to a ledger sequence.
- Create `backend/app/sync/clients.py`: client registration, monotonic ACK, expiry, and minimum active waterline.
- Create `backend/app/sync/retention.py`: prune visible ledger rows and linked tombstones only at the registry waterline.
- Create `backend/app/sync/contracts.py`: transport-neutral frozen dataclasses plus the shared I-JSON/safe-integer/strict-UTC/record-and-byte parser for operation query, push, pull, recover, ACK, and status.
- Create `backend/app/sync/commands.py`: map validated Sync events to the S3 `EntityCommand` type.
- Create `backend/app/sync/protocol.py`: implement `query_operations`, `push`, `pull`, `recover`, `ack`, and `status` over journal/UoW/catalog/client/snapshot Modules.
- Create `backend/app/sync/snapshot.py`: stream current authoritative state into bounded JSONL+gzip chunks and resume by opaque page token.
- Create `backend/app/sync/operations.py`: immutable REST/MCP operation catalog used by parity tests.

### Backend Adapters and verification

- Modify `backend/app/middleware/body_size_limit.py`: expose only the already capped exact raw request bytes to the duplicate-preserving REST decoder; never materialize an unbounded second copy.
- Modify `backend/app/schemas/sync.py`: v2 Pydantic request/response schemas whose cursor fields are strings and whose safe-integer/UTC timestamp/record/page/base64 limits mirror the shared parser.
- Modify `backend/app/routes/v1/sync.py`: expose only thin `/sync/v2/*` Adapters and remove all legacy Sync operations plus route-owned commit logic.
- Create `backend/app/mcp/sync_tools.py`: register all six Sync operations against the same `SyncProtocol` factory.
- Modify `backend/app/mcp/server.py`: install `sync_tools` and remove the hand-written reduced Sync implementation.
- Create `backend/tests/test_sync_mutation_ledger.py`: catalog-wide exactly-once ledger and rollback/visibility contracts.
- Create `backend/tests/test_sync_client_ack.py`: client lifecycle, monotonic ACK, expiry, and safe retention.
- Modify `backend/tests/test_sync_cursor_pagination.py`: remove legacy cursor cases and assert lossless opaque v2 paging.
- Modify `backend/tests/test_sync_ledger_retention.py`: prove both ledger and tombstone pruning stop at the minimum active ACK.
- Create `backend/tests/test_sync_snapshot_streaming.py`: chunk bounds, resume, catalog/waterline pinning, and heap bound.
- Create `backend/tests/test_mcp_sync_parity.py`: bidirectional REST/MCP operation, schema, cursor, and canonical-error parity.
- Create `backend/tests/fixtures/sync_streaming.py`: deterministic 10,000-Note/4-KiB fixture.
- Create `backend/tests/fixtures/sync_recovery_jsonl_vectors.json`: Python-produced exact-byte recovery records shared by backend and frontend tests.
- Create `backend/scripts/measure_sync_snapshot.py`: isolated Linux RSS probe with machine-readable summary.
- Create `backend/scripts/measure_sync_pull.py`: isolated Linux incremental-pull RSS probe with exact canonical page-byte summary.

### Official frontend protocol maintenance

- Modify `frontend/src/services/database.ts`: Dexie v19 admission state with per-root ordered identities/digests, recovery manifest/chunk stores, exact-byte pending-push receipts, and durable terminal-application evidence; preserve TS3's v18 business tables and S3's v17 operation-ID/compound-identity fields.
- Modify `frontend/src/services/meta-database.ts`: Meta Dexie v3 backfill for four nonoptional S4 provisional-operation bindings and token-bound provisional-operation authority.
- Modify `frontend/src/lib/sync/outbox.ts`: keep the real TS3 `enqueueOutbox` name, require `spaceId + SpaceAuthorityToken`, and initialize every S4 outbox field on every new row.
- Modify `frontend/src/lib/task-space/work-item-note-repository.ts`, `frontend/src/lib/focus-session/focus-session-repository.ts`, `frontend/src/lib/focus-session/provisional-start-recovery.ts`, and `frontend/src/lib/focus-session/active-session-coordinator.ts`: acquire one Space fence at the public boundary and pass its token through every business/outbox/Meta provisional write; two-Space conflict resolution acquires both fences in sorted order.
- Modify `frontend/src/services/meta-database.ts`: distinguish TS3 `activation_resolved` from S4 `transport_resolved`, add nonterminal `transport_ready`, and bind transport terminal state to exact ready-root/evidence hashes.
- Create `frontend/src/lib/sync/space-authority-fence.ts`: issue runtime-branded per-Space tokens only while the exclusive Browser Web Lock is held, and reject every unfenced writer.
- Create `frontend/src/lib/sync/space-authority-fence.test.ts`: two-Tab mutual exclusion, crash release, unavailable-API fail-closed, token forgery/expiry, and production-writer inventory tests.
- Create `frontend/src/lib/sync/authority-identity.ts`: own and export `PushAuthority`, `PushSelection`, canonical SHA-256 helpers, frozen row/root construction, complete-root reload, authority equality, receipt validation, and receipt-to-selection conversion. It imports no push or terminal coordinator.
- Create `frontend/src/lib/sync/authority-identity.test.ts`: mutate every frozen field, canonical payload byte, payload hash, root membership/order, and digest independently.
- Create `frontend/src/lib/sync/admission.ts`: validate and atomically admit TS3 `awaiting_s4` standalone/compound rows, freeze ordered root identities, reconcile the separate Meta row through `meta_pending`, and provide the token-bound hard push-readiness guard.
- Create `frontend/src/lib/sync/terminal-application.ts`: import shared authority types/helpers only from `authority-identity.ts`, persist Space-side terminal evidence before queue/receipt deletion, and idempotently reconcile exact Meta resolution after either query-terminal or push-terminal results. It never imports `push-batch.ts`.
- Create `frontend/src/lib/sync/terminal-application.test.ts`: two-phase crash/restart, exact evidence identity, ready-proof recovery, and both terminal-source tests.
- Create `frontend/src/lib/sync/client-registry.ts`: persist one stable per-Space client ID through a token-bound create-or-read transaction; it does not own cursor or ACK state.
- Create `frontend/src/lib/sync/transport.ts`: the only official-client `/sync/v2/*` request surface; merge caller config while forcing the canonical v2 error `Accept` media type for all six operations.
- Create `frontend/src/lib/sync/response-schema.ts`: strict Zod runtime parsers for all six operation-query/push/pull/recover/ACK/status responses; generated TypeScript types are compile-time inputs only.
- Create `frontend/src/lib/sync/recovery.ts`: download, verify, stage, atomically apply, and resume full recovery.
- Modify `frontend/src/lib/sync/sync-meta.ts`: exclusively own opaque cursor strings, pending ACK, catalog hash, and `requiresFullRecovery`, with read-only loaders plus token-bound transaction-local writers and compare-and-clear ACK.
- Modify `frontend/src/lib/sync/types.ts`: consume generated v2 schemas and remove numeric public cursor assumptions.
- Modify `frontend/src/lib/sync/pull-loop.ts`: persist a page before ACK and recover on `cursor_expired`.
- Modify `frontend/src/lib/sync/push-batch.ts`: import shared authority types/helpers from `authority-identity.ts`; own `QueryDecision`, ready-row selection, exact receipt construction, operation query, and the query-to-push coordinator; settle only an all-terminal single-result authority, block pending/recovery before terminal handling, fail closed on terminal/unknown, and send the unchanged S3-persisted standalone/compound idempotency identity only for all-confirmed-unknown operations.
- Modify `frontend/src/lib/sync/merge.ts`: preserve operation identity/version/retry metadata while applying pull and push results.
- Modify `frontend/src/lib/sync/engine.ts`: run recovery before push and retry an unacknowledged persisted cursor.
- Create `frontend/src/lib/sync/recovery.test.ts`: crash-boundary and atomic cutover tests.
- Create `frontend/src/lib/sync/admission.test.ts`: TS3 v18 `awaiting_s4` admission, compound identity, Meta handoff, malformed-group fail-closed, and `blocked_conflict` preservation tests.
- Create `frontend/src/lib/sync/transport.test.ts`: six-operation header/runtime-parser coverage and canonical five-key error parsing.
- Create `frontend/src/lib/sync/fixtures/sync-event-canonical-vectors.json`: deterministic copy of the backend RFC 8785 event vectors, verified byte-for-byte during generation/tests.
- Modify `frontend/src/lib/sync/pull-loop.test.ts`, `push-batch.test.ts`, `sync-meta.test.ts`, `merge.test.ts`, and `engine.test.ts`: opaque cursor/ACK, durable push receipt, and restart-stable rejection contracts.
- Modify `backend/scripts/export_openapi.py`: reuse TS0's deterministic local OpenAPI export and include final Sync v2 routes.
- Regenerate `frontend/openapi.json`: tracked canonical input for frontend type generation.
- Verify `frontend/package.json`: retain TS0's local deterministic `generate:api` command unchanged.
- Verify `frontend/package.json` and `frontend/package-lock.json`: retain TS3's exact `json-canonicalize@2.0.0` resolution unchanged.
- Regenerate `frontend/src/types/api-generated.ts`: generated v2 transport types; never hand-edit.

## Locked Public Interfaces

```python
class SyncProtocol:
    async def query_operations(self, client_id: str, operation_ids: Sequence[str]) -> OperationQueryResult: ...
    async def push(self, client_id: str, events: Sequence[SyncEventInput], batch_id: str) -> PushResult: ...
    async def pull(self, client_id: str, opaque_cursor: str | None, limit: int) -> PullPage: ...
    async def recover(self, client_id: str, page_token: str | None) -> RecoveryPage: ...
    async def ack(self, client_id: str, cursor: str) -> AckResult: ...
    async def status(self, client_id: str | None = None) -> SyncStatusResult: ...

class SyncCursorCodec:
    def encode(self, position: CursorPosition) -> str: ...
    def decode(self, token: str) -> CursorPosition: ...

class SyncClientRegistry:
    def __init__(self, session: AsyncSession, catalog_hash: str, ttl_days: int) -> None: ...
    async def register_or_touch(self, client_id: str) -> ClientRegistration: ...
    async def acknowledge(self, client_id: str, position: CursorPosition) -> AckDecision: ...
    async def minimum_safe_retention_sequence(self) -> int | None: ...
    async def expire_inactive(self) -> tuple[str, ...]: ...
    async def collect_expired_recovery(self) -> int: ...
    async def delete_expired_registrations(self, limit: int = 100) -> int: ...

class SyncSnapshotStore:
    def __init__(self, session: AsyncSession, catalog: CompiledEntityCatalog, page_tokens: RecoveryPageTokenCodec, serializer: SyncSnapshotSerializer) -> None: ...
    async def create(self, scope: SpaceRuntimeHandle, lease: Lease, client_id: str) -> SnapshotCreateDecision: ...
    async def page(self, scope: SpaceRuntimeHandle, lease: Lease, client_id: str, page_token: str) -> SnapshotPageDecision: ...
```

`AckResult` has one owner: Task 2 defines it in `app/sync/clients.py`; Task 3 imports and re-exports that exact class from `contracts.py`. `SyncClientRegistry` and `SyncSnapshotStore` are both session-bound objects constructed inside the one Space-exclusive transaction shown by the protocol. Neither class has an optional-session overload, a second `*_under_lease` public API, or a method that commits. All failures are S1 `AppError` subclasses and cross Adapter boundaries through `AppError.to_domain_record(request_id)`; S4 does not define `DomainFailure`, `CursorExpiredDomainFailure`, or an independent idempotency exception. MCP serializes that same record. REST uses only the approved canonical v2 media-type mapping.

### Task 1: Add The S4 Space Schema Without Repeating S3 Journal Columns

**Files:**
- Create: `backend/alembic_space/versions/011_sync_clients_streaming.py`
- Create: `backend/app/models/sync_client.py`
- Create: `backend/app/models/sync_recovery.py`
- Modify: `backend/app/models/tombstone.py`
- Modify: `backend/app/models/__init__.py`
- Modify: `backend/tests/test_alembic_dual_environments.py`
- Modify: `backend/tests/test_parity_alembic_metadata.py`
- Modify: `backend/tests/test_migration_runner.py`
- Modify: `backend/tests/test_migration_wal_durability.py`
- Modify: `backend/tests/test_space_lifecycle.py`
- Create: `backend/tests/test_sync_client_ack.py`

**Interfaces:**
- Consumes: TS0 revision `space_010_task_space_focus_session`, S3 tables `mutation_batches`, `mutation_operations`, `mutation_steps`, final TS0 business tables, and existing `sync_outbox.operation_id`, `sync_outbox.batch_id`, checked nullable `sync_outbox.version`, `sync_outbox.visible`.
- Produces: ORM types `SyncClient`, `SyncRecoveryManifest`, `SyncRecoveryChunk`; nullable `Tombstone.delete_sequence` for legacy-safe retention.

- [ ] **Step 1: Write the failing migration and metadata tests**

```python
def test_space_011_is_strictly_after_final_task_space_schema() -> None:
    revision = load_space_revision("space_011_sync_clients_streaming")
    assert revision.down_revision == "space_010_task_space_focus_session"


def test_space_011_adds_only_s4_columns(migrated_space_010, upgrade_space) -> None:
    before = column_names(migrated_space_010, "sync_outbox")
    assert {"operation_id", "batch_id", "version", "visible"} <= before
    assert {"work_items", "work_item_notes", "focus_sessions"} <= table_names(
        migrated_space_010
    )
    upgrade_space(migrated_space_010, "space_011_sync_clients_streaming")
    assert column_names(migrated_space_010, "sync_outbox") == before
    assert {"sync_clients", "sync_recovery_manifests", "sync_recovery_chunks"} <= table_names(
        migrated_space_010
    )
    assert "delete_sequence" in column_names(migrated_space_010, "tombstones")
```

- [ ] **Step 2: Run the tests and verify the red state**

Run:

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
cd backend
.\.venv\Scripts\python.exe -m pytest -q tests/test_sync_client_ack.py tests/test_alembic_dual_environments.py tests/test_parity_alembic_metadata.py -p no:cacheprovider
```

Expected: FAIL because revision `space_011_sync_clients_streaming` and the three ORM tables do not exist; no existing migration or table is modified by the failed run.

- [ ] **Step 3: Add the exact migration and focused ORM models**

Use this revision identity and schema. `upgrade()` must inspect existing columns before adding `delete_sequence`, backfill it from the latest visible delete event, and leave unmatched legacy tombstones as `NULL` so they can never be pruned without proof.

```python
revision = "space_011_sync_clients_streaming"
down_revision = "space_010_task_space_focus_session"


def upgrade() -> None:
    op.create_table(
        "sync_clients",
        sa.Column("client_id", sa.String(64), primary_key=True),
        sa.Column("ack_sequence", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("catalog_hash", sa.String(64), nullable=False),
        sa.Column("registered_at", sa.String(32), nullable=False),
        sa.Column("last_seen_at", sa.String(32), nullable=False),
        sa.Column("expires_at", sa.String(32), nullable=False),
        sa.Column("requires_recovery", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("recovery_generation", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("recovery_manifest_token", sa.String(64), nullable=True),
        sa.Column("recovery_waterline", sa.Integer(), nullable=True),
        sa.Column("recovery_completed_at", sa.String(32), nullable=True),
        sa.CheckConstraint("ack_sequence >= 0", name="ck_sync_clients_ack_nonnegative"),
        sa.CheckConstraint("recovery_generation >= 0", name="ck_sync_clients_generation_nonnegative"),
        sa.CheckConstraint(
            "recovery_waterline IS NULL OR recovery_waterline >= 0",
            name="ck_sync_clients_recovery_waterline_nonnegative",
        ),
    )
    op.create_index("ix_sync_clients_expires_at", "sync_clients", ["expires_at"])
    op.create_table(
        "sync_recovery_manifests",
        sa.Column("token", sa.String(64), primary_key=True),
        sa.Column("space_id", sa.String(64), nullable=False),
        sa.Column("client_id", sa.String(64), nullable=False),
        sa.Column("generation", sa.Integer(), nullable=False),
        sa.Column("catalog_hash", sa.String(64), nullable=False),
        sa.Column("waterline", sa.Integer(), nullable=False),
        sa.Column("total_entities", sa.Integer(), nullable=False),
        sa.Column("total_chunks", sa.Integer(), nullable=False),
        sa.Column("total_uncompressed_bytes", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.String(32), nullable=False),
        sa.Column("expires_at", sa.String(32), nullable=False),
        sa.Column("manifest_sha256", sa.String(64), nullable=False),
        sa.CheckConstraint("generation >= 0", name="ck_sync_manifest_generation_nonnegative"),
        sa.CheckConstraint("waterline >= 0", name="ck_sync_manifest_waterline_nonnegative"),
        sa.CheckConstraint("total_entities >= 0", name="ck_sync_manifest_entities_nonnegative"),
        sa.CheckConstraint("total_chunks >= 0", name="ck_sync_manifest_chunks_nonnegative"),
        sa.CheckConstraint(
            "total_uncompressed_bytes >= 0",
            name="ck_sync_manifest_bytes_nonnegative",
        ),
    )
    op.create_table(
        "sync_recovery_chunks",
        sa.Column("manifest_token", sa.String(64), nullable=False),
        sa.Column("chunk_index", sa.Integer(), nullable=False),
        sa.Column("entity_count", sa.Integer(), nullable=False),
        sa.Column("uncompressed_bytes", sa.Integer(), nullable=False),
        sa.Column("payload_gzip", sa.LargeBinary(), nullable=False),
        sa.Column("payload_sha256", sa.String(64), nullable=False),
        sa.ForeignKeyConstraint(
            ["manifest_token"], ["sync_recovery_manifests.token"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("manifest_token", "chunk_index"),
        sa.CheckConstraint("chunk_index >= 0", name="ck_sync_chunk_index_nonnegative"),
        sa.CheckConstraint("entity_count BETWEEN 1 AND 500", name="ck_sync_chunk_entities"),
        sa.CheckConstraint(
            "uncompressed_bytes BETWEEN 1 AND 8388608", name="ck_sync_chunk_bytes"
        ),
    )
    with op.batch_alter_table("tombstones") as batch:
        batch.add_column(sa.Column("delete_sequence", sa.Integer(), nullable=True))
        batch.create_index("ix_tombstones_delete_sequence", ["delete_sequence"])
        batch.create_check_constraint(
            "ck_tombstones_delete_sequence_nonnegative",
            "delete_sequence IS NULL OR delete_sequence >= 0",
        )
    op.execute(
        "UPDATE tombstones SET delete_sequence = ("
        "SELECT MAX(sync_outbox.id) FROM sync_outbox "
        "WHERE sync_outbox.visible = 1 AND sync_outbox.action = 'delete' "
        "AND sync_outbox.entity_type = tombstones.entity_type "
        "AND sync_outbox.entity_id = tombstones.entity_id)"
    )
```

`SyncClient` uses `client_id` as its primary key and exposes the same columns and named CHECKs. A new client is recovery-required by DB default. `SyncRecoveryManifest` binds one Space/client/generation; the service enforces that the client's current manifest token points to the same row. `SyncRecoveryChunk` uses a composite primary key; do not introduce a second surrogate ID. A zero-entity Space has `total_chunks=0` and no chunk row; Task 4 defines its synthetic terminal page. Migration tests use raw SQL to prove every nullable/non-null numeric field above rejects negative values, and metadata parity proves ORM/migration constraint names and expressions match exactly. Add all three models to `app.models.__all__` so Alembic/ORM parity sees them. Update every TS0 current-head test to 011; the S4 gate runs migration runner, WAL durability, and lifecycle tests and scans those files for stale `space_010_task_space_focus_session` current-head assertions.

- [ ] **Step 4: Run migration, fresh-head, downgrade, and metadata parity tests**

Run:

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
cd backend
.\.venv\Scripts\python.exe -m pytest -q tests/test_sync_client_ack.py tests/test_alembic_dual_environments.py tests/test_parity_alembic_metadata.py tests/test_migration_runner.py tests/test_migration_wal_durability.py tests/test_space_lifecycle.py -p no:cacheprovider
.\.venv\Scripts\python.exe -m alembic -n alembic:space heads
$PSNativeCommandUseErrorActionPreference = $false
$stale = @(& rg -n "space_010_task_space_focus_session.*(head|current)|(head|current).*space_010_task_space_focus_session" tests/test_migration_runner.py tests/test_migration_wal_durability.py tests/test_space_lifecycle.py 2>$null)
$rgStatus = $LASTEXITCODE
$PSNativeCommandUseErrorActionPreference = $true
if ($rgStatus -eq 0) { $stale; throw "stale Space 010 current-head assertion" }
if ($rgStatus -ne 1) { throw "rg failed with exit $rgStatus" }
```

Expected: all tests PASS; the only Space head printed is `space_011_sync_clients_streaming (head)`; head-to-base-to-head roundtrip leaves no S4 table behind after downgrade; `rg` returns zero stale current-head assertions (the 010 down-revision fixture itself remains only in the migration-specific test).

- [ ] **Step 5: Commit the independently reviewable schema change**

```powershell
git add backend/alembic_space/versions/011_sync_clients_streaming.py backend/app/models/sync_client.py backend/app/models/sync_recovery.py backend/app/models/tombstone.py backend/app/models/__init__.py backend/tests/test_sync_client_ack.py backend/tests/test_alembic_dual_environments.py backend/tests/test_parity_alembic_metadata.py backend/tests/test_migration_runner.py backend/tests/test_migration_wal_durability.py backend/tests/test_space_lifecycle.py
git commit -m "feat(sync): add client and streaming recovery schema"
```

**Review gate:** Reject the task if `011` repeats or changes S3's `operation_id`, `batch_id`, checked nullable `version`, or `visible`, or changes any TS0 final-business table; if a tombstone without a provable delete event receives a fabricated sequence; if any recovery/client/tombstone sequence, generation, index, count, or byte total can be negative through raw SQL; or if fresh/downgrade schema parity is not exact.

### Task 2: Implement Opaque Cursors, Client ACK, And The Retention Waterline

**Files:**
- Create: `backend/app/sync/__init__.py`
- Create: `backend/app/sync/cursor.py`
- Create: `backend/app/sync/clients.py`
- Create: `backend/app/sync/retention.py`
- Modify: `backend/app/settings.py`
- Modify: `backend/tests/test_sync_client_ack.py`
- Modify: `backend/tests/test_sync_ledger_retention.py`

**Interfaces:**
- Consumes: `CompiledEntityCatalog.hash`, `SyncClient`, `SyncOutbox.visible`, `Tombstone.delete_sequence`, S3's authoritative allocated `SyncState.current_cursor`, durable `SyncState.retention_floor`, and S2 Space-exclusive leases.
- Produces: `CursorPosition`, `SyncCursorCodec`, `SyncClientRegistry`, `ClientRegistration`; `SyncClientRegistry.acknowledge(client_id: str, position: CursorPosition) -> AckDecision`; `AckResult(client_id, accepted, requires_recovery, catalog_hash)`; `minimum_safe_retention_sequence() -> int | None`; `RetentionCoordinator.prune(scope: SpaceRuntimeHandle) -> RetentionResult`.

- [ ] **Step 1: Write failing cursor tamper, monotonic ACK, expiry, and waterline tests**

```python
async def test_ack_is_monotonic_and_retention_uses_minimum_active_client(space_session):
    codec = SyncCursorCodec(b"x" * 32)
    registry = SyncClientRegistry(space_session, catalog_hash="c" * 64, ttl_days=30)
    await registry.register_or_touch("client-a")
    await registry.register_or_touch("client-b")
    await registry.acknowledge("client-a", codec.decode(codec.encode(
        CursorPosition(8, "c" * 64, "space-a", "client-a", 0)
    )))
    await registry.acknowledge("client-b", codec.decode(codec.encode(
        CursorPosition(5, "c" * 64, "space-a", "client-b", 0)
    )))
    assert await registry.minimum_safe_retention_sequence() == 5
    with pytest.raises(ValueError, match="backwards"):
        await registry.acknowledge(
            "client-a", CursorPosition(7, "c" * 64, "space-a", "client-a", 0)
        )
    with pytest.raises(SyncCursorExpiredError):
        await registry.acknowledge(
            "client-a", CursorPosition(11, "c" * 64, "space-a", "client-a", 0)
        )


async def test_no_safe_ack_or_recovery_pin_means_no_pruning(sync_runtime):
    async with sync_runtime.session() as session:
        registry = SyncClientRegistry(session, catalog_hash="c" * 64, ttl_days=30)
        registration = await registry.register_or_touch("new-client")
    assert registration.requires_recovery is True
    result = await sync_runtime.retention.prune(sync_runtime.scope)
    assert result.ledger_rows == 0


async def test_current_recovery_manifest_waterline_pins_pruning(sync_runtime):
    waterline = 12
    await sync_runtime.seed_current_recovery_manifest(
        client_id="recovering-client", generation=3, waterline=waterline
    )
    await sync_runtime.append_visible_events(after=waterline, count=20)
    await sync_runtime.ack_other_clients_past(waterline + 10)

    pruned = await sync_runtime.retention.prune(sync_runtime.scope)

    assert pruned.waterline == waterline


async def test_prune_advances_durable_floor_and_old_cursor_expires_after_restart(sync_runtime):
    await sync_runtime.ack_clients(5, 8)
    await sync_runtime.retention.prune(sync_runtime.scope)
    await sync_runtime.restart()
    assert await sync_runtime.retention_floor() == 5
    decoded = sync_runtime.codec.decode(sync_runtime.cursor_at(2, client_id="client-a"))
    assert decoded.sequence == 2
    assert decoded.sequence < await sync_runtime.retention_floor()


async def test_only_completed_current_generation_recovery_ack_unlocks(sync_runtime):
    await sync_runtime.seed_completed_recovery(
        client_id="client-a", generation=1, waterline=9
    )
    registry = await sync_runtime.registry()
    old_pending = CursorPosition(9, sync_runtime.catalog_hash, "space-a", "client-a", 0)
    with pytest.raises(SyncCursorExpiredError):
        await registry.acknowledge("client-a", old_pending)
    other = CursorPosition(9, sync_runtime.catalog_hash, "space-a", "client-b", 1)
    with pytest.raises(SyncCursorExpiredError):
        await registry.acknowledge("client-a", other)
    current = CursorPosition(9, sync_runtime.catalog_hash, "space-a", "client-a", 1)
    result = await registry.acknowledge("client-a", current)
    assert result.requires_recovery is False


async def test_equal_ack_is_idempotent_after_commit_response_loss_and_restart(sync_runtime):
    cursor = sync_runtime.cursor_at(8, client_id="client-a")
    await sync_runtime.ack_commit_then_drop_response("client-a", cursor)
    await sync_runtime.restart()

    result = await sync_runtime.protocol.ack("client-a", cursor)

    assert result.accepted is True
    assert result.requires_recovery is False
    assert await sync_runtime.client_ack_sequence("client-a") == 8
    assert await sync_runtime.ack_advance_count("client-a") == 1


async def test_completed_manifest_that_expires_before_ack_cannot_unlock(sync_runtime):
    final_cursor = await sync_runtime.finish_recovery_without_ack(
        client_id="client-a", generation=4, waterline=11
    )
    await sync_runtime.advance_past_manifest_expiry()
    async with sync_runtime.registry_transaction() as registry:
        await registry.collect_expired_recovery()
        with pytest.raises(SyncCursorExpiredError):
            await registry.acknowledge("client-a", sync_runtime.codec.decode(final_cursor))
    assert await sync_runtime.client_requires_recovery("client-a") is True


def test_cursor_rejects_tampering_without_leaking_sequence():
    codec = SyncCursorCodec(b"x" * 32)
    token = codec.encode(CursorPosition(42, "c" * 64, "space-a", "client-a", 0))
    with pytest.raises(SyncCursorExpiredError) as raised:
        codec.decode(token[:-1] + ("A" if token[-1] != "A" else "B"))
    assert raised.value.code == "cursor_expired"
    assert "42" not in raised.value.detail


def test_cursor_round_trips_when_raw_hmac_contains_a_period(monkeypatch):
    signature = b"." + bytes(range(31))
    monkeypatch.setattr(hmac, "digest", lambda *_args: signature)
    codec = SyncCursorCodec(b"x" * 32)

    position = CursorPosition(9, "c" * 64, "space-a", "client-a", 0)
    token = codec.encode(position)

    assert token.count(".") == 1
    assert codec.decode(token) == position


async def test_prune_to_empty_keeps_allocated_high_watermark(sync_runtime):
    await sync_runtime.append_visible_events(count=5)
    await sync_runtime.ack_clients(5)
    await sync_runtime.retention.prune(sync_runtime.scope)

    assert await sync_runtime.visible_ledger_sequences() == []
    state = await sync_runtime.sync_state()
    assert state.retention_floor == 5
    assert state.current_cursor == 5
    await sync_runtime.restart()
    assert (await sync_runtime.sync_state()).current_cursor == 5


async def test_expired_registration_gc_is_bounded_after_pointer_and_manifest_cleanup(
    sync_runtime,
) -> None:
    await sync_runtime.seed_expired_clients_with_manifests(250)

    deleted = []
    async with sync_runtime.registry_transaction() as registry:
        await registry.expire_inactive()
        await registry.collect_expired_recovery()
        deleted.append(await registry.delete_expired_registrations(limit=100))
        deleted.append(await registry.delete_expired_registrations(limit=100))
        deleted.append(await registry.delete_expired_registrations(limit=100))

    assert deleted == [100, 100, 50]
    assert await sync_runtime.expired_manifest_count() == 0
    assert await sync_runtime.expired_chunk_count() == 0
    assert await sync_runtime.expired_registration_count() == 0


@pytest.mark.parametrize("reason", ["ttl_expired", "catalog_mismatch"])
async def test_untransitioned_101st_client_still_pins_by_low_ack(
    sync_runtime, reason: str,
) -> None:
    await sync_runtime.seed_ready_client("stable", ack_sequence=90)
    await sync_runtime.seed_ready_maintenance_candidates(
        reason=reason,
        count=101,
        last_client_id="zz-low-ack",
        last_ack=3,
        other_ack=90,
    )
    async with sync_runtime.registry_transaction() as registry:
        changed = await registry.expire_inactive()
        assert len(changed) == 100
        assert await registry.minimum_safe_retention_sequence() == 3
    assert await sync_runtime.client_requires_recovery("zz-low-ack") is False

    async with sync_runtime.registry_transaction() as registry:
        assert len(await registry.expire_inactive()) == 1
        assert await registry.minimum_safe_retention_sequence() == 90


async def test_referenced_expired_manifest_pins_until_bounded_mark_and_clear(
    sync_runtime,
) -> None:
    await sync_runtime.seed_ready_client("steady", ack_sequence=80)
    await sync_runtime.seed_referenced_expired_manifest(
        client_id="recovering", waterline=4,
    )
    async with sync_runtime.registry_transaction() as registry:
        assert await registry.minimum_safe_retention_sequence() == 4
        sync_runtime.inject_crash_before_recovery_pointer_clear()
        with pytest.raises(InjectedCrash):
            await registry.collect_expired_recovery()
    await sync_runtime.restart()
    async with sync_runtime.registry_transaction() as registry:
        assert await registry.minimum_safe_retention_sequence() == 4
        assert await registry.collect_expired_recovery() == 1
        assert await registry.minimum_safe_retention_sequence() == 80
```

Also add a retention test with two ACKs at 5 and 8, visible ledger rows 1..10, and tombstones linked at 4, 6, and `NULL`. The first prune must remove only ledger rows `<=5` and the tombstone linked at 4; the `NULL` tombstone must remain. Repeat the 101-row boundary for referenced expired manifests: one `collect_expired_recovery()` pass may mark/clear at most 100; an unprocessed 101st pointer still contributes its low waterline, and only the next committed bounded transition releases that pin.

- [ ] **Step 2: Run focused tests and verify the red state**

Run:

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
cd backend
.\.venv\Scripts\python.exe -m pytest -q tests/test_sync_client_ack.py tests/test_sync_ledger_retention.py -p no:cacheprovider
```

Expected: FAIL with import errors for `app.sync.cursor`, `app.sync.clients`, and `app.sync.retention`.

- [ ] **Step 3: Implement the only sequence/token translation boundary**

Use canonical sorted JSON plus HMAC-SHA256. Decoding validates signature, version, nonnegative sequence, and 64-character catalog hash before returning a position.

```python
@dataclass(frozen=True, slots=True)
class CursorPosition:
    sequence: int
    catalog_hash: str
    space_id: str
    client_id: str
    generation: int


class SyncCursorCodec:
    def __init__(self, secret: bytes) -> None:
        if len(secret) < 32:
            raise ValueError("cursor secret must be at least 32 bytes")
        self._secret = secret

    def encode(self, position: CursorPosition) -> str:
        payload = json.dumps(
            {
                "catalog_hash": position.catalog_hash,
                "client_id": position.client_id,
                "generation": position.generation,
                "sequence": position.sequence,
                "space_id": position.space_id,
                "version": 2,
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode("ascii")
        signature = hmac.digest(self._secret, payload, "sha256")
        payload_segment = base64.urlsafe_b64encode(payload).rstrip(b"=").decode("ascii")
        signature_segment = base64.urlsafe_b64encode(signature).rstrip(b"=").decode("ascii")
        return f"{payload_segment}.{signature_segment}"

    def decode(self, token: str) -> CursorPosition:
        try:
            parts = token.split(".")
            if len(parts) != 2 or not all(parts):
                raise ValueError("segments")
            payload = _decode_base64url_segment(parts[0])
            signature = _decode_base64url_segment(parts[1])
            if len(signature) != hashlib.sha256().digest_size:
                raise ValueError("signature length")
            expected = hmac.digest(self._secret, payload, "sha256")
            if not hmac.compare_digest(signature, expected):
                raise ValueError("signature")
            data = json.loads(payload)
            if set(data) != {"catalog_hash", "client_id", "generation", "sequence", "space_id", "version"}:
                raise ValueError("fields")
            if type(data["version"]) is not int or data["version"] != 2:
                raise ValueError("version")
            if type(data["sequence"]) is not int or data["sequence"] < 0:
                raise ValueError("sequence")
            if type(data["generation"]) is not int or data["generation"] < 0:
                raise ValueError("generation")
            if not isinstance(data["catalog_hash"], str) or re.fullmatch(
                r"[0-9a-f]{64}", data["catalog_hash"]
            ) is None:
                raise ValueError("catalog")
            validate_identifier(data["space_id"], field="space_id")
            validate_identifier(data["client_id"], field="client_id")
            return CursorPosition(
                data["sequence"], data["catalog_hash"], data["space_id"],
                data["client_id"], data["generation"]
            )
        except (KeyError, TypeError, ValueError, UnicodeError, json.JSONDecodeError) as exc:
            raise SyncCursorExpiredError(recovery_action="full_recovery") from exc
```

`_decode_base64url_segment()` adds only the required padding and calls `base64.b64decode(..., altchars=b"-_", validate=True)`; it converts `binascii.Error` to `ValueError` before the fixed error Adapter handles it. `space_id` and `client_id` use the same 1..64 ASCII identifier allowlist as public contracts. Add invalid-token cases for extra/missing segments, non-base64 bytes, non-32-byte signatures, Boolean/float sequences, non-integer versions, uppercase/non-hex catalog hashes, invalid IDs, and unexpected JSON fields. Add a cross-Space/cross-client test: a valid Space A/client A cursor passed to any other scope/client fails `cursor_expired` before querying or ACKing rows.

The codec raises S1's existing `SyncCursorExpiredError` with fixed safe detail and `details={"recovery_action":"full_recovery"}`. The existing `AppError` handler supplies the request ID; the codec never constructs a `DomainErrorRecord` with an empty placeholder. Never include decoded content in logs or errors.

- [ ] **Step 4: Implement durable registration, ACK, expiry, and pruning**

`SyncClientRegistry` is session-bound and is constructed only inside a protocol/retention transaction that already holds the matching Space-exclusive lease; it has no lease-taking or optional-session overload. `clients.py` owns the frozen `AckResult(client_id, accepted, requires_recovery, catalog_hash)` type before `acknowledge()` is implemented. `register_or_touch()` creates a new row with `requires_recovery=True`, `ack_sequence=0`, or refreshes `last_seen_at` without advancing ACK. A fresh client cannot assume sequence zero is still retained. If an existing row has expired or its catalog hash differs, persist `requires_recovery=True`, clear prior recovery token/waterline/completed-at, and increment recovery generation when a new manifest begins; `push` and incremental `pull` reject it with `cursor_expired/full_recovery`, while `recover` remains allowed.

`acknowledge()` requires an existing registration and matching Space/client/catalog/generation, reads authoritative `SyncState.current_cursor` after clean recovery, rejects a sequence greater than that allocated high watermark, rejects a sequence below durable retention floor, and rejects only a strictly backward sequence. Equality with the already persisted `ack_sequence` is an idempotent success: it returns the same accepted result without another advance, including after the first ACK committed but its response was lost and the process restarted. While recovery-required it additionally requires `recovery_completed_at`, exact equality to current `recovery_waterline`, and an existing current manifest whose token equals `recovery_manifest_token`, whose Space/client/catalog/generation all match, and whose `expires_at` is still in the future; only then may it clear recovery fields. Thus an old pending ACK, another client's cursor, an unfinished manifest, or a final cursor whose generation expired before ACK cannot unlock.

Task 2 implements `minimum_safe_retention_sequence()`, `collect_expired_recovery()`, and `delete_expired_registrations(limit)` in `clients.py`. Retention eligibility is derived only from committed state, never from `now` or the current catalog hash inside the floor query: every row with `requires_recovery=False` contributes its `ack_sequence`, even when its stored `expires_at` is past or its stored catalog differs; every manifest still referenced by `recovery_manifest_token` contributes its `waterline`, even when the manifest is expired or catalog-mismatched. `expire_inactive()` processes one stable `client_id` keyset page of at most 100 TTL-expired/catalog-mismatched clients, atomically marks them `requires_recovery=True` and clears completion/pointer fields. `collect_expired_recovery()` likewise processes at most 100 clients that still reference expired/invalid manifests, commits the mark/clear first in the caller transaction, and deletes only manifests that are then unreferenced. An unprocessed 101st client/pointer remains a pin. Crash before that transaction commits leaves the old ACK/waterline pin intact; only the durable bounded mark/clear releases it. Registration GC accepts only a strict bounded `1..100` limit and deletes at most 100 already transitioned registrations per invocation after pointer/completion fields are null and no manifest references them. Repeated maintenance calls converge without one unbounded transaction. Every push, pull, and recovery page calls this registry through its own protocol method; no REST/MCP Adapter performs a separate registration call.

```python
@dataclass(frozen=True, slots=True)
class AckResult:
    client_id: str
    accepted: Literal[True]
    requires_recovery: bool
    catalog_hash: str


@dataclass(frozen=True, slots=True)
class AckDecision:
    result: AckResult | None
    error: AppError | None

    def __post_init__(self) -> None:
        if (self.result is None) == (self.error is None):
            raise ValueError("ACK decision requires exactly one outcome")
```

Expected client-state failures are outcomes, not exceptions inside a transaction. `register_or_touch()` returns `requires_recovery`; `acknowledge()` returns `AckDecision`. The protocol exits `session.begin()` normally so the new/expired/catalog-mismatched `requires_recovery` marker, cleared manifest pointer, and generation changes commit, then raises `decision.error` outside the transaction while the combined exclusive-resource guard is still held. Unexpected I/O/programming/cancellation exceptions still roll back. Tests inject a crash after mark, after commit, and immediately before the outside raise; restart always sees recovery required and an old pending ACK cannot make the client eligible.

```python
async def minimum_safe_retention_sequence(self) -> int | None:
    active_ack = await self.db.scalar(
        select(func.min(SyncClient.ack_sequence)).where(
            SyncClient.requires_recovery.is_(False),
        )
    )
    recovery_pin = await self.db.scalar(
        select(func.min(SyncRecoveryManifest.waterline))
        .join(
            SyncClient,
            SyncClient.recovery_manifest_token == SyncRecoveryManifest.token,
        )
        .where(
            SyncClient.recovery_manifest_token.is_not(None),
        )
    )
    candidates = [value for value in (active_ack, recovery_pin) if value is not None]
    return min(candidates) if candidates else None


async def prune(self, scope: SpaceRuntimeHandle) -> RetentionResult:
    async with scope.exclusive_space_resources("sync-retention", 60) as lease:
        await self.uow.recover_under_lease(scope, lease)
        pending_error: AppError | None = None
        result = RetentionResult(waterline=None, ledger_rows=0, tombstones=0)
        async with scope.session_factory() as session, session.begin():
            registry = SyncClientRegistry(
                session, catalog_hash=self.catalog.hash, ttl_days=self.ttl_days
            )
            await registry.expire_inactive()
            await registry.collect_expired_recovery()
            await registry.delete_expired_registrations(limit=100)
            floor = await registry.minimum_safe_retention_sequence()
            if floor is not None:
                state = await read_sync_state(session)
                if floor > state.current_cursor:
                    pending_error = RetentionInvariantError(
                        "ack waterline exceeds allocated cursor"
                    )
                else:
                    ledger = await session.execute(
                        delete(SyncOutbox).where(
                            SyncOutbox.visible.is_(True), SyncOutbox.id <= floor
                        )
                    )
                    tombstones = await session.execute(
                        delete(Tombstone).where(
                            Tombstone.delete_sequence.is_not(None),
                            Tombstone.delete_sequence <= floor,
                        )
                    )
                    await advance_retention_floor(session, floor)
                    lease.assert_fence(scope.scope.space_id)
                    result = RetentionResult(
                        floor, int(ledger.rowcount or 0),
                        int(tombstones.rowcount or 0),
                    )
        if pending_error is not None:
            raise pending_error
        return result
```

Delete and `advance_retention_floor()` share this one transaction; neither is committed alone. The advance is monotonic CAS, enforces `retention_floor <= SyncState.current_cursor`, and persists even across restart. Pruning never recomputes or lowers `current_cursor` from remaining rows: deleting the final visible ledger row leaves the allocated high watermark intact, so equal ACK/pull remains meaningful and `current_cursor + 1` is still future after restart. After mutation recovery proves clean and before calculating the floor, retention calls one bounded page each of `expire_inactive()`, `collect_expired_recovery()`, and `delete_expired_registrations()` in the same transaction. The subsequent floor query contains no `expires_at`, `catalog_hash`, or wall-clock predicate: an unprocessed row remains an ACK/waterline pin by its persisted fields. Only a mark/clear committed in that transaction can release it; only then may unreferenced manifest/chunk GC, eligible registration GC, and floor pruning proceed. Crash/restart tests interrupt after each client mark, pointer clear, manifest/chunk GC, bounded registration page, floor CAS, ledger delete, and tombstone delete for TTL expiry, catalog change, and expired manifest; no restart may treat an unmarked client as safely excluded or delete a referenced registration. The initial/fresh-client test may call a fixture wrapper that supplies `scope`; production has no session-only pruning entrypoint.

Add `sync_client_ttl_days: PositiveInt = 30` and a dedicated `sync_cursor_secret` setting. In production it must be at least 32 UTF-8 bytes and distinct from known defaults; do not silently reuse the JWT key.

- [ ] **Step 5: Run focused tests and verify the pass state**

Run:

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
cd backend
.\.venv\Scripts\python.exe -m pytest -q tests/test_sync_client_ack.py tests/test_sync_ledger_retention.py -p no:cacheprovider
.\.venv\Scripts\ruff.exe check --no-cache app/sync app/models/sync_client.py app/models/sync_recovery.py tests/test_sync_client_ack.py tests/test_sync_ledger_retention.py
```

Expected: PASS; tampered/numeric/backward/future cursors fail; `NULL`-linked legacy tombstones survive; no retention occurs without an active ACK.

- [ ] **Step 6: Commit the cursor and retention Module**

```powershell
git add backend/app/sync/__init__.py backend/app/sync/cursor.py backend/app/sync/clients.py backend/app/sync/retention.py backend/app/settings.py backend/tests/test_sync_client_ack.py backend/tests/test_sync_ledger_retention.py
git commit -m "feat(sync): add opaque cursors and ack waterline"
```

**Review gate:** Reject if any route/MCP/frontend code can decode a cursor; if expiry is applied only in memory; if ACK can move strictly backward, beyond `SyncState.current_cursor`, fail an exact-equality retry, or unlock from a missing/expired manifest; if the floor query filters raw expiry/catalog values before a persisted bounded transition, if an unprocessed 101st client/reference stops pinning, if GC is unbounded, deletes a referenced registration, or leaves a client pointing at a deleted manifest; if pruning lowers the allocated high watermark; if no-active-client state prunes data; or if a tombstone with no linked visible delete event is pruned.

### Task 3: Converge Push And Pull On Unit Of Work And Visible Ledger Events

**Files:**
- Create: `backend/app/sync/contracts.py`
- Create: `backend/app/sync/commands.py`
- Create: `backend/app/sync/protocol.py`
- Modify: `backend/app/settings.py`
- Modify: `backend/app/main.py`
- Modify: `backend/app/middleware/body_size_limit.py`
- Verify unchanged: `backend/pyproject.toml`
- Verify unchanged: `backend/uv.lock`
- Modify: `backend/app/services/sync_outbox.py`
- Create: `backend/tests/fixtures/sync_event_canonical_vectors.json`
- Create: `backend/tests/fixtures/sync_domain_policy_cases.py`
- Create: `backend/tests/test_sync_mutation_ledger.py`
- Modify: `backend/tests/test_sync_cursor_pagination.py`
- Modify: `backend/tests/test_sync_integration.py`
- Modify: `backend/tests/test_prod_hardening.py`
- Create: `backend/scripts/measure_sync_pull.py`

**Interfaces:**
- Consumes: `CompiledEntityCatalog.get_by_sync_key(key)`, `list_sync_enabled()`, `backend/app/commands/entity.py::EntityCommand.from_sync_event(scope, event) -> MutationRequest`, S3 immutable operation/batch receipts, `MutationUnitOfWork.execute_prepared_batch(scope, items, batch_id) -> BatchMutationResult`, and finalized `SyncOutbox.visible=True` rows.
- Produces: frozen `OperationQueryItem(state="unknown|pending|terminal|recovery_required")`, `OperationQueryResult`, `SyncEventInput`, `MappedSyncBatch`, `PushResult`, `PullPage`, `PullPageEnvelope`, `SyncStatusResult`; `SyncCommandMapper.to_request(scope, event) -> MutationRequest`; `SyncProtocol.query_operations(client_id, operation_ids) -> OperationQueryResult`; `push(client_id: str, events: Sequence[SyncEventInput], batch_id: str) -> PushResult`; `pull(client_id: str, opaque_cursor: str | None, limit: int) -> PullPage`; `ack(client_id: str, cursor: str) -> AckResult`; `status(client_id: str | None = None) -> SyncStatusResult`. A terminal query item carries the immutable complete `PushResult` projection of its original S3 batch receipt, not a newly evaluated per-operation result.

- [ ] **Step 1: Write failing catalog-wide ledger and interleaving tests**

```python
@pytest.mark.parametrize("case", sync_domain_policy_cases(), ids=lambda case: case.name)
async def test_push_obeys_generic_and_registered_domain_policies(
    runtime_scope, uow, case, ready_client_id
):
    protocol = make_protocol(runtime_scope, uow=uow)
    result = await protocol.push(
        ready_client_id, [case.event], batch_id="batch-" + case.name
    )
    if case.expected_error_code is not None:
        assert result.applied == ()
        assert result.errors[0].code == case.expected_error_code
        assert await visible_events(
            runtime_scope.db, case.event.entity_type, case.event.entity_id
        ) == []
    else:
        assert result.applied[0].entity_id == case.event.entity_id
        rows = await visible_events(
            runtime_scope.db, case.event.entity_type, case.event.entity_id
        )
        assert [(row.action, row.batch_id, row.visible) for row in rows] == [
            (case.event.action, "batch-" + case.name, True)
        ]


async def test_batch_finalize_failure_exposes_no_partial_events(
    runtime_scope, faulting_uow, ready_client_id
):
    protocol = make_protocol(
        runtime_scope, uow=faulting_uow(after_child_forward_applied=1)
    )
    with pytest.raises(SpaceRecoveryRequiredError) as raised:
        await protocol.push(
            ready_client_id, two_valid_events(), batch_id="batch-fail"
        )
    assert raised.value.code == "space_recovery_required"
    assert await visible_batch_events(runtime_scope.db, "batch-fail") == []


async def test_operation_query_returns_original_terminal_result_before_repush(
    sync_runtime, ready_client_id
) -> None:
    await sync_runtime.commit_direct_note_then_drop_response(
        operation_id="note-op-1", batch_id="note-op-1"
    )
    result = await sync_runtime.protocol.query_operations(
        ready_client_id, ["note-op-1", "never-seen"]
    )
    assert result.items[0].state == "terminal"
    assert result.items[0].batch_id == "note-op-1"
    assert result.items[0].result == sync_runtime.original_batch_push_result("note-op-1")
    assert result.items[1].state == "unknown"
    assert sync_runtime.uow_execute_calls == []


async def test_operation_query_distinguishes_pending_and_recovery_required_without_execution(
    sync_runtime, ready_client_id
) -> None:
    await sync_runtime.seed_operation("op-pending", "batch-pending", state="STAGED")
    await sync_runtime.seed_operation("op-manual", "batch-manual", state="FAILED_MANUAL")

    result = await sync_runtime.protocol.query_operations(
        ready_client_id, ["op-pending", "op-manual"]
    )

    assert [(item.state, item.batch_id, item.result) for item in result.items] == [
        ("pending", "batch-pending", None),
        ("recovery_required", "batch-manual", None),
    ]
    assert sync_runtime.uow_execute_calls == []


async def test_compound_push_preserves_ts3_root_and_child_operation_ids(
    sync_runtime, ready_client_id
) -> None:
    vector = sync_runtime.ts3_held_provisional_vector()

    await sync_runtime.protocol.push(
        ready_client_id, vector.events, batch_id=vector.compound_operation_id
    )

    call = sync_runtime.uow_execute_prepared_batch_calls.single()
    assert call.batch_id == vector.compound_operation_id
    assert tuple(item.operation_id for item in call.items) == vector.child_operation_ids
    queried = await sync_runtime.protocol.query_operations(
        ready_client_id, list(vector.child_operation_ids)
    )
    assert {item.batch_id for item in queried.items} == {vector.compound_operation_id}
    assert all(item.state == "terminal" for item in queried.items)
    assert len({canonical_bytes(item.result) for item in queried.items}) == 1


async def test_incremental_pull_below_durable_floor_expires_after_restart(
    sync_runtime, ready_client_id
):
    await sync_runtime.seed_and_ack(ready_client_id, sequences=(5, 8))
    old_cursor = sync_runtime.cursor_at(2, client_id=ready_client_id)
    await sync_runtime.retention.prune(sync_runtime.scope)
    await sync_runtime.restart()

    with pytest.raises(SyncCursorExpiredError):
        await sync_runtime.protocol.pull(ready_client_id, old_cursor, limit=10)


async def test_incremental_pull_rejects_future_cursor_before_page_query_or_return(
    sync_runtime, ready_client_id
):
    await sync_runtime.append_visible_events(count=5)
    future = sync_runtime.cursor_at(6, client_id=ready_client_id)

    with pytest.raises(SyncCursorExpiredError):
        await sync_runtime.protocol.pull(ready_client_id, future, limit=500)

    assert sync_runtime.visible_page_query_count == 0


async def test_empty_post_prune_pull_uses_persisted_allocated_watermark(
    sync_runtime, ready_client_id
):
    await sync_runtime.append_visible_events(count=5)
    await sync_runtime.ack_and_prune(ready_client_id, 5)
    await sync_runtime.restart()

    page = await sync_runtime.protocol.pull(
        ready_client_id,
        sync_runtime.cursor_at(5, client_id=ready_client_id),
        limit=500,
    )

    assert page.events == ()
    assert page.has_more is False
    assert sync_runtime.decode_test_cursor(page.next_cursor).sequence == 5


async def test_incremental_pull_512_max_payloads_peak_heap_is_bounded(
    sync_runtime, ready_client_id
):
    expected = await sync_runtime.seed_maximum_payload_events(count=512, bytes_each=262144)
    tracemalloc.start()
    actual = await collect_all_pull_ids(
        sync_runtime.protocol, ready_client_id, limit=500,
        assert_page_entities_at_most=500,
        assert_page_bytes_at_most=8 * 1024 * 1024,
    )
    peak = tracemalloc.get_traced_memory()[1]
    tracemalloc.stop()

    assert actual == expected
    assert len(actual) == len(set(actual))
    assert peak <= 128 * 1024 * 1024


async def test_pull_budgets_the_complete_envelope_before_appending_boundary_event(
    sync_runtime, ready_client_id
):
    first_id, deferred_id = await sync_runtime.seed_exact_pull_envelope_boundary()

    first = await sync_runtime.protocol.pull(ready_client_id, None, limit=500)
    assert canonical_pull_page_size(first) <= 8 * 1024 * 1024
    assert [event.event_id for event in first.events] == [first_id]
    assert first.has_more is True

    second = await sync_runtime.protocol.pull(
        ready_client_id, first.next_cursor, limit=500
    )
    assert canonical_pull_page_size(second) <= 8 * 1024 * 1024
    assert [event.event_id for event in second.events] == [deferred_id]
    assert second.has_more is False
```

`sync_domain_policy_cases()` is a closed test fixture, not production routing
metadata. It contains generic CRUD successes plus Task Space and FocusSession
cases supplied by their approved policy contracts: accepted WorkItem scalar/
move/transition and WorkItemNote full-document CAS cases; rejected formal
offline creation, invalid tree/document/reference cases; accepted Session
operations explicitly supported by TS2; and rejected attempts to rewrite
immutable context or append-only revisions. At least one negative case for each
real domain-policy entity type proves `EntityCommand.from_sync_event()` reaches
the registered policy rather than generic fallback. `SyncCommandMapper` still
delegates once and never branches on these cases.

The Session portion is an exact matrix, not the open phrase "supported by
TS2". It accepts only TS2-approved complete `local_provisional`/
`activation_conflict` imports and their closed pending note/plan transitions.
It includes five authoritative-active post-images corresponding to Session note,
current item, completion draft, plan add, and plan remove; every one must reach
`FocusSessionMutationPolicy`, reject with `stale_session_owner`, and leave
mutation journal, Session/Plan rows, outbox, and visible ledger byte-for-byte
unchanged. A matching version is not authority. The same five operations pass
only through the master Coordinator with its persisted Meta claim; S4 never
constructs that claim or calls a Coordinator.

```python
@pytest.mark.parametrize(
    "case",
    sync_domain_policy_cases().authoritative_running_content_rejections,
)
async def test_sync_cannot_bypass_active_session_owner(sync_runtime, case) -> None:
    before = await sync_runtime.durable_snapshot()
    result = await sync_runtime.push_one(case.event)
    assert result.error.code == "stale_session_owner"
    assert await sync_runtime.durable_snapshot() == before
    assert sync_runtime.focus_session_policy_calls == [case.expected_policy_call]
    assert sync_runtime.generic_fallback_calls == 0
```

The boundary fixture chooses two valid events whose event-only canonical bytes fit the limit but whose combined full `PullPage` (array framing, exact next cursor, `has_more`, catalog hash, and object framing) exceeds it by one byte. The first page must defer, not reject or drop, the second event. Add a property-style deterministic test that interleaves WorkItem, WorkItemNote, FocusSession, Note, and tombstone events across page sizes 1..7. Concatenated opaque-cursor pages must equal the visible ledger order exactly once.

- [ ] **Step 2: Run focused tests and verify the red state**

Run:

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
cd backend
.\.venv\Scripts\python.exe -m pytest -q tests/test_sync_mutation_ledger.py tests/test_sync_cursor_pagination.py tests/test_sync_integration.py -p no:cacheprovider
```

Expected: FAIL because `SyncProtocol` and transport-neutral contracts do not exist; the existing strict expected failure is still reported as XFAIL.

- [ ] **Step 3: Define transport-neutral immutable contracts and command mapping**

```python
from app.errors import to_wire_json  # S1 owns the shared recursive serializer
from app.sync.clients import AckResult  # re-export the Task 2 owner


@dataclass(frozen=True, slots=True)
class OperationQueryItem:
    operation_id: str
    state: Literal["unknown", "pending", "terminal", "recovery_required"]
    batch_id: str | None
    result: "PushResult | None"

    def __post_init__(self) -> None:
        validate_operation_id(self.operation_id)
        if self.state == "unknown" and (self.batch_id is not None or self.result is not None):
            raise ValueError("unknown operation cannot expose a binding")
        if self.state == "terminal":
            validate_batch_id(self.batch_id)
            if not isinstance(self.result, PushResult) or self.result.batch_id != self.batch_id:
                raise ValueError("terminal operation requires its original batch result")
        if self.state in {"pending", "recovery_required"}:
            validate_batch_id(self.batch_id)
        if self.state in {"pending", "recovery_required"} and self.result is not None:
            raise ValueError("nonterminal operation cannot expose a result")


@dataclass(frozen=True, slots=True)
class OperationQueryResult:
    items: tuple[OperationQueryItem, ...]

    def __post_init__(self) -> None:
        object.__setattr__(self, "items", tuple(self.items))
        if not 1 <= len(self.items) <= MAX_SYNC_RECORDS:
            raise ValueError("operation query count out of range")
        if len({item.operation_id for item in self.items}) != len(self.items):
            raise ValueError("duplicate operation query ID")


@dataclass(frozen=True, slots=True)
class SyncEventInput:
    entity_type: str
    entity_id: str
    action: Literal["create", "update", "delete"]
    payload: Mapping[str, Any]
    expected_version: int | None
    client_updated_at: str
    operation_id: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "payload", require_frozen_i_json_object(self.payload))
        require_safe_expected_version(self.expected_version)
        require_canonical_utc_rfc3339(self.client_updated_at)


@dataclass(frozen=True, slots=True)
class SyncEventRecord:
    operation_id: str
    batch_id: str
    entity_type: str
    entity_id: str
    action: Literal["create", "update", "delete"]
    payload: Mapping[str, Any]
    version: int
    created_at: str

    def __post_init__(self) -> None:
        require_nonnegative_version(self.version, field="version")
        require_canonical_utc_rfc3339(self.created_at)
        object.__setattr__(self, "payload", require_frozen_i_json_object(self.payload))


@dataclass(frozen=True, slots=True)
class PushApplied:
    operation_id: str
    entity_type: str
    entity_id: str
    version: int
    resolution: Literal["remote"] | None = None

    def __post_init__(self) -> None:
        require_nonnegative_version(self.version, field="version")


@dataclass(frozen=True, slots=True)
class PushConflict:
    operation_id: str
    entity_type: str
    entity_id: str
    code: Literal["version_conflict", "tombstone_conflict", "cycle_detected"]
    resolution: Literal["local", "tombstone", "circular_ref", "manual"]
    details: Mapping[str, Any]

    def __post_init__(self) -> None:
        object.__setattr__(self, "details", require_frozen_i_json_object(self.details))


@dataclass(frozen=True, slots=True)
class PushError:
    operation_id: str
    entity_type: str
    entity_id: str
    code: str
    retryable: bool
    details: Mapping[str, Any]

    def __post_init__(self) -> None:
        if type(self.retryable) is not bool:
            raise TypeError("retryable must be bool")
        object.__setattr__(self, "details", require_frozen_i_json_object(self.details))


@dataclass(frozen=True, slots=True)
class PushResult:
    batch_id: str
    applied: tuple[PushApplied, ...]
    conflicts: tuple[PushConflict, ...]
    errors: tuple[PushError, ...]


@dataclass(frozen=True, slots=True)
class RecoveryPage:
    payload_jsonl_base64: str
    entity_count: int
    chunk_sha256: str
    next_page_token: str | None
    has_more: bool
    catalog_hash: str
    waterline_cursor: str

    def __post_init__(self) -> None:
        require_record_count(self.entity_count)
        validate_recovery_base64_page(
            self.payload_jsonl_base64,
            expected_count=self.entity_count,
            expected_sha256=self.chunk_sha256,
        )


@dataclass(frozen=True, slots=True)
class SyncStatusResult:
    catalog_hash: str
    client_id: str | None
    registered: bool
    requires_recovery: bool | None
    recovery_action: Literal["full_recovery"] | None
    visible_event_count: int
    active_client_count: int
    recovery_client_count: int

    def __post_init__(self) -> None:
        for name in (
            "visible_event_count", "active_client_count", "recovery_client_count"
        ):
            require_safe_nonnegative_int(getattr(self, name), field=name)


@dataclass(frozen=True, slots=True)
class PullPage:
    events: tuple[SyncEventRecord, ...]
    next_cursor: str
    has_more: bool
    catalog_hash: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "events", tuple(self.events))
        if len(self.events) > MAX_SYNC_RECORDS:
            raise ValueError("pull page exceeds record limit")
        require_canonical_page_bytes(self, MAX_DECODED_CANONICAL_PAGE_BYTES)


@dataclass(frozen=True, slots=True)
class MappedSyncBatch:
    items: tuple[PreparedBatchItem, ...]
```

Define the cross-language limits once and import them from contracts/schemas/tests:

```python
MAX_JS_SAFE_INTEGER = 2**53 - 1
MAX_SYNC_RECORDS = 500
MAX_DECODED_CANONICAL_PAGE_BYTES = 8 * 1024 * 1024
MAX_RECOVERY_BASE64_CHARS = 4 * ((MAX_DECODED_CANONICAL_PAGE_BYTES + 2) // 3)
SYNC_UTC_RFC3339_PATTERN = re.compile(
    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z"
)
```

`require_nonnegative_version(value, field)` accepts only `type(value) is int and 0 <= value <= MAX_JS_SAFE_INTEGER`; it rejects `None`, Boolean, float, numeric string, negative, and `2**53`. The same safe-integer rule applies to `expected_version`, every protocol count/index/limit, and every integral value nested in payload/details/snapshot JSON; finite non-integral binary64 numbers remain legal I-JSON. `require_canonical_utc_rfc3339()` first requires the exact uppercase UTC grammar above, then calendar-parses it; offsets, lowercase `t/z`, space separators, missing seconds, more than nine fractional digits, leap-second `:60`, and impossible dates fail. It preserves the accepted source string byte-for-byte. Both dataclass constructors call these validators, and `SyncEventRecord.from_row()` fails closed on a migrated legacy `NULL` instead of manufacturing zero. The database column remains nullable only so pre-S3 migrated legacy rows can be recognized and forced through full recovery; every new S3/S4 write and every v2 event/applied result is non-null and nonnegative.

`backend/app/settings.py` owns the three separate budgets and their cross-field invariant; tests instantiate Settings with every invalid ordering. Use the actual fields and fixed framing allowance, not unnamed literals:

```python
SYNC_RAW_ENVELOPE_FRAMING_HEADROOM_BYTES = 1024 * 1024


class Settings(BaseSettings):
    sync_event_payload_max_bytes: PositiveInt = 256 * 1024
    sync_canonical_batch_max_bytes: PositiveInt = 10 * 1024 * 1024
    request_body_max_bytes: PositiveInt = 11 * 1024 * 1024

    @model_validator(mode="after")
    def validate_sync_payload_budgets(self) -> "Settings":
        if self.sync_event_payload_max_bytes > self.sync_canonical_batch_max_bytes:
            raise ValueError(
                "sync_event_payload_max_bytes must not exceed "
                "sync_canonical_batch_max_bytes"
            )
        required_raw = (
            self.sync_canonical_batch_max_bytes
            + SYNC_RAW_ENVELOPE_FRAMING_HEADROOM_BYTES
        )
        if self.request_body_max_bytes < required_raw:
            raise ValueError(
                "request_body_max_bytes must cover canonical batch plus "
                "fixed framing headroom"
            )
        return self
```

S1 `app.errors.to_wire_json()` is the sole recursive JSON-safe thaw/serialization owner for `DomainErrorRecord` and transport dataclasses. S4 imports and reuses it from REST and MCP; `app/sync/contracts.py`, routes, and MCP tools must not define a copy, use `dict(mappingproxy)`, `copy.deepcopy`, or `dataclasses.asdict`. S1's serializer recursively handles dataclasses, mapping proxies/frozen mappings, tuples, and lists, and rejects non-string mapping keys, non-finite floats, and unknown objects. S4 parity tests keep nested frozen event payloads and nested rejection `details`, run both real REST and FastMCP serialization, require byte-equivalent JSON-native structures, and prove neither side raises the Python 3.13 `mappingproxy` pickle error. A static test permits the definition only in `app/errors.py`.

All cross-language canonical event/snapshot bytes use the S3/TS3-pinned RFC 8785 implementations, not independently hand-rolled `json.dumps`/`JSON.stringify`: `backend/pyproject.toml` retains `rfc8785==0.1.4`, `backend/uv.lock` resolves exactly that version, and frontend manifests retain exact `json-canonicalize@2.0.0` with no caret/range. `backend/tests/fixtures/sync_event_canonical_vectors.json` is the generated Sync authority and Task 7's `frontend/src/lib/sync/fixtures/sync-event-canonical-vectors.json` is a deterministic byte-for-byte copy checked against it. The shared cases contain complete request events plus canonical bytes/length/SHA-256 for nested Unicode, escapes, floating exponent/negative-zero/safe-integer edges, per-event exact 256 KiB/+1, and ordered batch exact 10 MiB/+1 boundaries. Backend and frontend both execute every vector; frontend-selected persisted batch bytes are submitted through the real REST ASGI client and real FastMCP tool runner, whose shared parser must account the same per-event and ordered total bytes. Non-I-JSON/nonfinite/out-of-range values fail before a durable batch. JCS bytes are the single authority for client batch selection, server per-event/batch budgets, prepared intent hashes, and JSONL lines.

`contracts.py` imports and re-exports `AckResult` from `app.sync.clients`; it does not define a duplicate. `SyncEventRecord.from_row()` requires non-null S3 operation/batch identity and a non-Boolean safe nonnegative version for v2, deep-freezes payload through S1's freezer, validates canonical UTC `created_at`, and never exposes ledger sequence. Legacy null-version rows are below the mandatory recovery waterline and cannot enter v2 incremental pull.

REST parsing starts from the exact capped raw body bytes retained by `body_size_limit.py`, never from `Request.json()` or a dict already produced by Starlette. `decode_sync_i_json(raw: bytes)` rejects bytes above `request_body_max_bytes`, invalid UTF-8, BOM, trailing data, nonfinite constants, unpaired surrogates, and duplicate object keys at any nesting level by using a duplicate-detecting `object_pairs_hook`; it then recursively enforces string keys, Unicode scalar strings, finite numbers, and the safe-integer rule. Only that JSON-native value enters `validate_sync_push_object()`/`SyncEventInput.parse_batch()`, which uses S1 `deep_freeze_json`, validates action/version combinations and required canonical UTC `client_updated_at`, enforces `1..MAX_SYNC_RECORDS`, canonical RFC 8785 UTF-8 bytes `<= settings.sync_event_payload_max_bytes` per event, and total ordered canonical event bytes `<= settings.sync_canonical_batch_max_bytes` before any registration, lease, or UoW call. `settings.request_body_max_bytes` is only the coarse raw-envelope cap and is never evidence that decoding or canonical batch validation passed.

```python
def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise SyncInputError("duplicate_object_key", {"key": key})
        result[key] = value
    return result


def decode_sync_i_json(raw: bytes, *, max_bytes: int) -> object:
    if len(raw) > max_bytes:
        raise SyncInputError("request_too_large", {})
    text = raw.decode("utf-8", errors="strict")
    if text.startswith("\ufeff"):
        raise SyncInputError("invalid_json", {})
    try:
        value = json.loads(
            text,
            object_pairs_hook=_unique_object,
            parse_constant=lambda _value: (_ for _ in ()).throw(
                SyncInputError("non_i_json_number", {})
            ),
        )
    except (JSONDecodeError, UnicodeError) as exc:
        raise SyncInputError("invalid_json", {}) from exc
    validate_i_json_graph(value)
    return value
```

The production helper uses a named `reject_nonfinite_constant()` rather than exposing parser text; the inline lambda above only makes the required `json.loads` hook explicit. `validate_i_json_graph()` also rejects unpaired surrogate code points that UTF-8 decoding alone cannot catch when they came from `\uXXXX` escapes.

MCP accepts structured event objects only, not a JSON-text shortcut. Because duplicate names cannot survive an already materialized object, its boundary calls the same recursive `validate_i_json_graph()` before Pydantic/model construction and rejects non-string keys, unsafe integers, nonfinite values, lone surrogates, bytes, datetimes, and arbitrary Python objects. REST and MCP then call the same transport-neutral frozen parser and produce identical `AppError` records. Tests send raw REST bodies with duplicate top-level keys and duplicate keys inside an event payload/details object, plus MCP object graphs containing each remaining non-I-JSON case; every failure occurs before runtime handle/registry/UoW creation. No Adapter defines a second parser or treats Pydantic/FastMCP coercion as the semantic boundary.

The same module owns `validate_client_id`, `validate_batch_id`, `validate_operation_id`, `validate_cursor_token`, `validate_page_token`, and `validate_pull_limit`. IDs are ASCII and reject leading/trailing whitespace rather than stripping; token byte length is checked before HMAC/base64 decode; `type(limit) is int` and `1 <= limit <= 500`; expected/version/count integers require exact `int`, exclude Boolean, and stay in `0..MAX_JS_SAFE_INTEGER`. REST uses a validation-only dependency that returns the frozen parsed contract before `protocol_factory.open`; MCP validates before its `async with`; each `SyncProtocol` method repeats the same validator as a final direct-call boundary before acquiring a lease or touching the registry. Pydantic/MCP models may provide ergonomic outer-shape errors, but they do not own duplicate-ID, byte-budget, identity, or domain error mapping. The S4 error-spec regression extends S3's producer enumeration with the actual `SyncCommandMapper` branches and requires exact equality of all producible S3+S4 codes with the closed `MUTATION_REJECTION_SPECS`. Tests cover Unicode/whitespace IDs, Boolean/string/over-safe versions, 0/501 limits, 2049-byte tokens, duplicate IDs with identical and different payloads, and assert zero handle/registration/UoW calls.

`SyncCommandMapper.to_request()` resolves the effective Sync key through `catalog.get_by_sync_key()`, rejects non-Sync entities, and delegates exactly once to S3. It passes `event.expected_version` and canonical `event.client_updated_at` unchanged into `MutationRequest`; `expected_version=None` is legal only for create. It does not repeat parent, cycle, relation, CAS/LWW, ordering, or delete-strategy invariants.

```python
class SyncCommandMapper:
    def __init__(self, catalog: CompiledEntityCatalog, commands: EntityCommand) -> None:
        self.catalog = catalog
        self.commands = commands

    def to_request(self, scope: SpaceRuntimeHandle, event: SyncEventInput) -> MutationRequest:
        spec = self.catalog.try_get_by_sync_key(event.entity_type)
        if spec is None:
            raise MutationRuleViolation(
                "entity_not_sync_enabled",
                {"entity_type": event.entity_type, "entity_id": event.entity_id},
            )
        return self.commands.from_sync_event(scope, event)

    def partition(
        self, scope: SpaceRuntimeHandle, events: Sequence[SyncEventInput]
    ) -> MappedSyncBatch:
        event_operation_ids = tuple(event.operation_id for event in events)
        for operation_id in event_operation_ids:
            validate_operation_id(operation_id)
        if len(set(event_operation_ids)) != len(event_operation_ids):
            raise IdempotencyConflictError(
                "operation_id must be unique within one sync batch"
            )
        items: list[PreparedBatchItem] = []
        for index, event in enumerate(events):
            intent_hash = hashlib.sha256(canonical_sync_event_bytes(event)).hexdigest()
            try:
                request = self.to_request(scope, event)
            except MutationRuleViolation as exc:
                rejection = MutationRejection(
                    request_index=index,
                    operation_id=event.operation_id,
                    entity_type=event.entity_type,
                    entity_id=event.entity_id,
                    code=exc.code,
                    retryable=exc.retryable,
                    details=exc.details,
                )
                items.append(PreparedBatchItem(
                    index, event.operation_id, intent_hash,
                    request=None, pre_rejection=rejection,
                ))
            else:
                items.append(PreparedBatchItem(
                    index, event.operation_id, intent_hash,
                    request=request, pre_rejection=None,
                ))
        return MappedSyncBatch(tuple(items))
```

Unknown/alias Sync keys therefore never escape as `KeyError`: every effective alias resolves through the compiled catalog and an unknown key becomes a durable mapper pre-rejection. `EntityCommand.from_sync_event()` owns top-level/payload primary-key normalization; create/update mismatches and nonempty delete payloads enter this same `PreparedBatchItem` receipt, with zero operation/stage/ledger/entity writes.

- [ ] **Step 4: Implement operation query, push, and pull over durable receipts/UoW/ledger**

```python
async def query_operations(
    self, client_id: str, operation_ids: Sequence[str]
) -> OperationQueryResult:
    client_id, operation_ids = validate_operation_query_inputs(client_id, operation_ids)
    async with self.scope.exclusive_space_resources("sync-operation-query", 5) as lease:
        await self.uow.recover_under_lease(self.scope, lease)
        async with self.scope.session_factory() as session:
            await SyncClientRegistry(session, self.catalog.hash, self.ttl_days).register_or_touch(
                client_id
            )
            items = await self.operation_receipts.query_in_input_order(
                session, operation_ids
            )
            await session.commit()
    return OperationQueryResult(tuple(items))


async def push(
    self, client_id: str, events: Sequence[SyncEventInput], batch_id: str
) -> PushResult:
    client_id, batch_id, parsed_events = validate_sync_push_inputs(
        client_id, batch_id, events
    )
    mapped = self.mapper.partition(self.scope, parsed_events)
    registration = await self._register_client_under_exclusive(client_id)
    if registration.requires_recovery:
        raise SyncCursorExpiredError(recovery_action="full_recovery")
    outcome = await self.uow.execute_prepared_batch(
        self.scope, mapped.items, batch_id,
    )
    return PushResult.from_uow(
        batch_id=batch_id,
        events=parsed_events,
        applied=outcome.applied,
        rejected=outcome.rejected,
    )


async def pull(
    self, client_id: str, opaque_cursor: str | None, limit: int
) -> PullPage:
    client_id = validate_client_id(client_id)
    opaque_cursor = validate_optional_cursor_token(opaque_cursor)
    limit = validate_pull_limit(limit)
    async with self.scope.exclusive_space_resources("sync-pull", 5) as lease:
        await self.uow.recover_under_lease(self.scope, lease)
        pending_error: AppError | None = None
        page: PullPage | None = None
        async with self.scope.session_factory() as session, session.begin():
            registry = SyncClientRegistry(
                session, catalog_hash=self.catalog.hash, ttl_days=self.ttl_days
            )
            registration = await registry.register_or_touch(client_id)
            if registration.requires_recovery:
                pending_error = SyncCursorExpiredError(recovery_action="full_recovery")
            else:
                try:
                    position = (
                        self.cursor.decode(opaque_cursor)
                        if opaque_cursor
                        else CursorPosition(
                            0, self.catalog.hash, self.scope.scope.space_id, client_id,
                            registration.recovery_generation,
                        )
                    )
                except AppError as error:
                    pending_error = error
                if pending_error is None and (
                    position.catalog_hash != self.catalog.hash
                    or position.space_id != self.scope.scope.space_id
                    or position.client_id != client_id
                    or position.generation != registration.recovery_generation
                ):
                    pending_error = SyncCursorExpiredError(recovery_action="full_recovery")
                state = await read_sync_state(session)
                floor = state.retention_floor
                if pending_error is None and position.sequence < floor:
                    pending_error = SyncCursorExpiredError(recovery_action="full_recovery")
                if pending_error is None and position.sequence > state.current_cursor:
                    pending_error = SyncCursorExpiredError(recovery_action="full_recovery")
                if pending_error is None:
                    bounded = await read_visible_event_page_bounded(
                        session,
                        after_sequence=position.sequence,
                        max_events=limit,
                        max_canonical_page_bytes=8 * 1024 * 1024,
                        fetch_chunk_size=32,
                        page_envelope=PullPageEnvelope(
                            cursor=self.cursor,
                            catalog_hash=self.catalog.hash,
                            space_id=self.scope.scope.space_id,
                            client_id=client_id,
                            generation=registration.recovery_generation,
                        ),
                    )
                    page = bounded.page
        if pending_error is not None:
            raise pending_error
        assert page is not None
        return page


async def ack(self, client_id: str, cursor: str) -> AckResult:
    client_id = validate_client_id(client_id)
    cursor = validate_cursor_token(cursor)
    async with self.scope.exclusive_space_resources("sync-ack", 5) as lease:
        await self.uow.recover_under_lease(self.scope, lease)
        decision: AckDecision | None = None
        async with self.scope.session_factory() as session, session.begin():
            position = self.cursor.decode(cursor)
            registry = SyncClientRegistry(
                session, catalog_hash=self.catalog.hash, ttl_days=self.ttl_days
            )
            await registry.expire_inactive()
            decision = await registry.acknowledge(client_id, position)
            lease.assert_active_owner(
                mode=LeaseMode.EXCLUSIVE, scope=self.scope.scope.space_id
            )
        assert decision is not None
        if decision.error is not None:
            raise decision.error
        assert decision.result is not None
        return decision.result


async def status(self, client_id: str | None = None) -> SyncStatusResult:
    client_id = validate_optional_client_id(client_id)
    self.scope.global_lease.assert_active_owner(
        mode=LeaseMode.SHARED, scope="global"
    )
    if self.scope.space_lease is None:
        raise LeaseOrderError("sync status requires a Space-shared read handle")
    self.scope.space_lease.assert_active_owner(
        mode=LeaseMode.SHARED, scope=self.scope.scope.space_id
    )
    async with self.scope.session_factory() as session:
        snapshot = await read_sync_status_projection(
            session,
            catalog_hash=self.catalog.hash,
            client_id=client_id,
            now=utc_now_iso(),
        )
        return SyncStatusResult(**snapshot)
```

`query_operations()` validates one to 500 unique operation IDs before runtime access, then performs S3 recovery under the matching Space-exclusive lease before reading. It returns rows in caller order. An absent operation is exactly `unknown` with null binding/result. A remaining nonterminal safe journal state is `pending` with its immutable original `batch_id`; `FAILED_MANUAL` or an operation whose batch cannot be proven convergent is `recovery_required`; neither carries a result. `FINALIZED`, `ABORTED`, and `COMPENSATED` are `terminal` only when the original immutable S3 batch receipt can be decoded, and each terminal child carries the same complete `PushResult` projection with `result.batch_id == item.batch_id`. This full-batch result lets one applied child settle rejected siblings that intentionally have no `MutationOperation` row. The query never executes, rebinds, stages, recompiles, or exposes another Space. REST/MCP parity tests query a direct WorkItemNote command whose response was lost and a TS3 compound child, prove the exact original full-batch result is returned, and assert zero UoW execution calls.

`_register_client_under_exclusive()` validates the client ID, enters S2's combined `exclusive_space_resources` guard, immediately calls `uow.recover_under_lease(scope, lease)`, and only after a clean result opens one session transaction, constructs `SyncClientRegistry(session, ...)`, calls `register_or_touch`, commits, closes resources, and releases in the same Task. Push raises `cursor_expired` only after this helper has committed `requires_recovery`. Pull/ACK use outcome objects so expected failures also commit safety markers before raising outside `session.begin()`. Adapters request S2 public mode `write`; S2 maps it to a global-only mutation handle. Push registration completes before UoW enters its own combined guard; both independently run cleanliness preflight, closing the waiter window. Pull reads `SyncState` only after that recovery and rejects `position.sequence > current_cursor` before invoking the bounded page reader or constructing/returning a page; a future cursor can never be normalized to an empty success. ACK decodes once, never auto-registers, applies the same authoritative `current_cursor` future check, and cannot let an expired/catalog-mismatched pending ACK roll back its marker. Status validates optional client ID before its read-handle projection. An unknown client returns `registered=False`, and all public numbers are counts rather than cursor sequences.

`read_visible_event_page_bounded()` keyset-fetches at most 32 rows per query and converts each row to the complete frozen record. Before appending a candidate it asks `PullPageEnvelope` for the exact candidate cursor at that sequence and canonicalizes the tentative whole page: ordered events plus array/object framing, `next_cursor`, `catalog_hash`, and conservative `has_more=false` (one byte longer than `true`). If that complete page would exceed 8 MiB and at least one event is already selected, the candidate is deferred untouched to the next opaque-cursor page. A valid first event cannot exceed the whole-page cap because the per-event cap is 256 KiB; violation is a stable invariant error, never an oversize response. After selection it performs one indexed existence query after the last included sequence, constructs the actual `PullPage`, and asserts its canonical bytes remain within the same cap. It never materializes `limit+1` maximum-size rows or exposes the lookahead sequence. An empty post-prune ledger uses the caller's already validated position, while the future check still uses the persisted allocated high watermark rather than `MAX(remaining rows)`. Exact/+1 whole-envelope tests prove the boundary event is deferred and later delivered exactly once; heap tests seed maximum-size ledger payloads, request 500 through protocol/REST/MCP, assert full page bytes <=8 MiB, lossless cursor continuation, and tracemalloc <=128 MiB.

`backend/scripts/measure_sync_pull.py` owns the isolated incremental-pull system probe. It accepts `--events 512 --payload-bytes 262144 --limit 500 --output PATH`, creates a run-scoped Space with exactly 512 finalized visible events whose canonical payloads exercise the 256 KiB boundary, then iterates the production `SyncProtocol.pull` from the initial cursor through the terminal `has_more=false` page. It streams fixture insertion/comparison without building all payloads/pages in one Python list, asserts internally that every page has at most 500 events and 8 MiB canonical wire JSON, and fails on any missing or duplicate event. Its machine-readable object has exactly `events,payload_bytes,requested_limit,returned_events,canonical_page_bytes,has_more,pull_complete`: `returned_events` is the full traversal count, `canonical_page_bytes` is the maximum observed page size, and `has_more` records that the first bounded page required continuation. The script exits nonzero unless the exact input values round-trip, `returned_events == events`, `canonical_page_bytes <= 8 * 1024 * 1024`, first-page `has_more is true`, and `pull_complete is true`. A separate tracemalloc pytest proves peak Python heap <=128 MiB; Task 8 runs the script under `/usr/bin/time -v` for RSS <=256 MiB. JSON/time files are retained as separate S6 inputs with commit SHA and SHA-256, alongside but not conflated with snapshot artifacts.

`PushResult.from_uow()` indexes only the single durable UoW receipt's rejections and applied results by the original unique `operation_id`, then emits results in input event order. Mapper pre-rejections are already `PreparedBatchItem` branches and cannot be appended ephemerally after UoW. It maps clean success to `PushApplied(resolution=None)`, S3's persisted remote-wins result to `PushApplied(resolution="remote")`, rejected server-local/tombstone/cycle outcomes to the corresponding `PushConflict`, unresolved `version_conflict` to `PushConflict(resolution="manual")`, and all other rejections to `PushError(retryable=rejection.retryable)`. It never recomputes retryability from a mutable code table. An item may occur in exactly one result tuple. A rejected event creates neither a mutation operation nor a ledger row, but its original index/operation ID/retryable/result is in batch `result_json`. The same raw ordered events and `batch_id` must return the persisted identical ordered result after restart even if catalog/rules would now map them differently. Remove direct `record_sync_event()` calls from Sync push; keep one internal append primitive used only by `MutationUnitOfWork`.

Add mapper/result tests that cover create `expected_version=None`, update/delete exact integer and byte-identical canonical `client_updated_at` propagation, version conflict after restart, a final-catalog `schedule` timestamp-LWW vector, a `workItemNote` strict-CAS vector, persisted `resolution="remote"` only for catalog entries that declare LWW, strict-CAS conflict only in `conflicts`, and an ordinary validation failure only in `errors`. The WorkItemNote vector carries the full canonical paragraph/checklist post-image and proves a stale expected version can never become remote-wins. Both `SyncEventRecord` and `PushApplied` tests reject missing/null/negative/Boolean/numeric-string/`2**53` versions. Test mixed and all-mapper-rejected batches, restart plus catalog change, and assert the second response is byte-for-byte equivalent with zero rejected operation/stage/ledger rows. Duplicate `operation_id` values fail with canonical `idempotency_conflict` before registration, staging, or UoW execution; REST and MCP parity tests cover both identical and different duplicate payloads. Operation-query tests cover 0/501/duplicate IDs, all four states, full-batch terminal-result equality, direct Note commit plus lost response, restart, and cross-Space isolation. The TS3 compound vector passes its persisted `compoundOperationId` unchanged as `batch_id`, preserves the ordered child operation IDs through `execute_prepared_batch`, and returns one byte-identical terminal batch receipt from every queried terminal child. Load the shared RFC 8785 vectors through the real ASGI client and real FastMCP tool runner: the complete ordered canonical event sum exactly 10 MiB passes the shared limit (and its raw REST envelope is asserted at most 11 MiB), while the paired +1 vector returns the same canonical code/status with zero handle/registry/UoW writes; exact 256 KiB/+1 per-event vectors and the 500-event boundary use the same path. Also test a raw HTTP body above `request_body_max_bytes` is rejected by middleware independently. Add protocol ACK tests for exact current generation, strict backward/future/cross-client/cross-Space/below-floor/expired-manifest rejection, exact-equality lost-response replay after restart, and expired/catalog-mismatched pending ACK commit-before-error. Add status tests for known/unknown client, active/recovery counts, safe-integer exact/+1 bounds, zero row writes, and no numeric cursor/sequence field. These tests also prove response order follows input order when accepted and rejected events are interleaved.

- [ ] **Step 5: Delete legacy cursor coverage and prove final-catalog opaque paging**

Delete `test_legacy_pull_global_cursor_skips_truncated_older_entity_rows` and all calls to the old timestamp pull API. Replace it with a v2 test that interleaves final-catalog WorkItem, WorkItemNote, FocusSession and tombstone events and proves opaque pages preserve ledger order exactly once.

```python
pages = await collect_v2_pages(
    entity_types=("workItem", "workItemNote", "focusSession", "workItem"),
    actions=("create", "update", "create", "delete"),
    limit=2,
)
assert [event.entity_type for event in flatten(pages)] == [
    "workItem",
    "workItemNote",
    "focusSession",
    "workItem",
]
assert len({event.operation_id for event in flatten(pages)}) == 4
```

- [ ] **Step 6: Run the protocol tests and verify no critical expected failure remains**

Run:

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
cd backend
.\.venv\Scripts\python.exe -m pytest -q tests/test_sync_mutation_ledger.py tests/test_sync_cursor_pagination.py tests/test_sync_integration.py -p no:cacheprovider
.\.venv\Scripts\python.exe -m pytest -q tests/test_sync_cursor_pagination.py -rxX -p no:cacheprovider
```

Expected: PASS with no `XFAIL`/`XPASS`; cross-entity and tombstone interleaving has no loss or duplicate; failed/rolled-back/compensated batches expose zero visible events.

- [ ] **Step 7: Commit the protocol core**

```powershell
git add backend/app/sync/contracts.py backend/app/sync/commands.py backend/app/sync/protocol.py backend/app/settings.py backend/app/main.py backend/app/middleware/body_size_limit.py backend/app/services/sync_outbox.py backend/tests/fixtures/sync_event_canonical_vectors.json backend/tests/fixtures/sync_domain_policy_cases.py backend/tests/test_sync_mutation_ledger.py backend/tests/test_sync_cursor_pagination.py backend/tests/test_sync_integration.py backend/tests/test_prod_hardening.py backend/scripts/measure_sync_pull.py
git commit -m "feat(sync): converge push and pull on durable protocol"
```

**Review gate:** Reject if operation query has fewer/more than the four locked states, returns a per-child recomputation instead of the immutable original full-batch receipt, executes/rebinds an operation, or fails to preserve a TS3 compound root and ordered child IDs; if Sync writes domain rows directly; if an Adapter owns commit order; if mapper rejections are merged outside the durable UoW receipt; if any raw event identity is absent from the prepared batch hash; if REST does not begin from capped duplicate-preserving raw bytes; if MCP skips the shared I-JSON graph validator; if safe-integer/timestamp/500-record/8-MiB/base64 limits differ across shared contracts/Pydantic/Zod; if payload/batch byte limits or RFC 8785 vectors differ between REST and MCP; if settings accept event > canonical batch or raw < canonical batch + fixed headroom; if pull reads `visible=False` or returns a future cursor page; if ACK auto-registers or decodes outside its exclusive transaction; if status mutates/touches a client or exposes a numeric sequence; if the public cursor is numeric/decodable outside the codec; if batch effects can become visible separately; or if any old timestamp-pull path remains.

### Task 4: Build Manifest-Backed Bounded And Resumable Full Recovery

**Files:**
- Create: `backend/app/sync/snapshot.py`
- Modify: `backend/app/sync/contracts.py`
- Modify: `backend/app/sync/protocol.py`
- Create: `backend/tests/fixtures/sync_streaming.py`
- Create: `backend/tests/fixtures/sync_recovery_jsonl_vectors.json`
- Create: `backend/tests/test_sync_snapshot_streaming.py`
- Create: `backend/scripts/measure_sync_snapshot.py`

**Interfaces:**
- Consumes: catalog hash and stable sync-enabled entity order, injected `SyncSnapshotSerializer` with authoritative Markdown Note body reader, S3 authoritative allocated `SyncState.current_cursor`, `SyncRecoveryManifest`, `SyncRecoveryChunk`.
- Produces: `SnapshotDescriptor`, one-whole-chunk `RecoveryPage`, session-bound `SyncSnapshotStore.create()`/`page()`, `SyncProtocol.recover(client_id: str, page_token: str | None) -> RecoveryPage`; JSON summary from `measure_sync_snapshot.py`.

- [ ] **Step 1: Write failing chunk-bound, resume, tamper, and heap tests**

```python
async def test_10k_note_snapshot_is_bounded_and_resumable(streaming_space):
    populate_notes(streaming_space, count=10_000, body_bytes=4096, seed=95)
    tracemalloc.start()
    first = await streaming_space.protocol.recover("client-a", page_token=None)
    peak = tracemalloc.get_traced_memory()[1]
    tracemalloc.stop()
    chunks = await load_chunks(streaming_space.db, streaming_space.latest_manifest_token())
    assert all(chunk.entity_count <= 500 for chunk in chunks)
    assert all(chunk.uncompressed_bytes <= 8 * 1024 * 1024 for chunk in chunks)
    assert peak <= 128 * 1024 * 1024
    recovered = await resume_after_each_boundary(
        streaming_space.protocol, client_id="client-a", first_page=first
    )
    assert recovered.ids == expected_note_ids(10_000)
    assert len(recovered.ids) == len(set(recovered.ids))


async def test_in_progress_recovery_waterline_pins_concurrent_pruning(streaming_space):
    first = await streaming_space.protocol.recover("recovering-client", page_token=None)
    waterline = streaming_space.decode_test_cursor(first.waterline_cursor).sequence
    await streaming_space.append_visible_events(after=waterline, count=20)
    await streaming_space.ack_other_clients_past(waterline + 10)

    pruned = await streaming_space.retention.prune(streaming_space.scope)

    assert pruned.waterline == waterline
    final = await streaming_space.finish_recovery("recovering-client", first)
    ack = await streaming_space.protocol.ack(
        "recovering-client", final.waterline_cursor
    )
    assert ack.requires_recovery is False


async def test_snapshot_waterline_uses_allocated_cursor_not_visible_row_max(streaming_space):
    await streaming_space.seed_visible_events_through(5)
    await streaming_space.seed_clean_nonvisible_allocated_event(sequence=6)

    first = await streaming_space.protocol.recover("client-a", page_token=None)

    assert streaming_space.decode_test_cursor(first.waterline_cursor).sequence == 6
    assert await streaming_space.current_cursor() == 6
    assert await streaming_space.max_visible_sequence() == 5
```

Also mutate one stored gzip byte and assert canonical `snapshot_invalid` with `details={"recovery_action":"full_recovery"}`. Store a tiny gzip bomb that expands past `MAX_CHUNK_BYTES`, a stream whose recorded uncompressed size is wrong, a concatenated second gzip member, and valid gzip plus trailing bytes; every case must fail through bounded decoding with the same canonical error before a response body is allocated. Change the compiled catalog hash after manifest creation and assert `cursor_expired` with the same recovery action; add a post-snapshot mutation and prove it appears only in the subsequent incremental pull after the manifest waterline.

Add repeated-abort tests: start recovery, persist one page, restart with `page_token=None` for the same client five times, and assert only the current manifest remains after each committed generation and all superseded chunks cascade-delete. Advance the clock past manifest expiry, run collection under Space-exclusive, and assert the expired manifest/chunks are removed, the client remains `requires_recovery`, and its old token cannot resume.

- [ ] **Step 2: Run the streaming tests and verify the red state**

Run:

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
cd backend
.\.venv\Scripts\python.exe -m pytest -q tests/test_sync_snapshot_streaming.py -p no:cacheprovider
```

Expected: FAIL because `SyncSnapshotStore` and the deterministic fixture do not exist.

- [ ] **Step 3: Implement deterministic JSONL chunking without whole-snapshot materialization**

```python
MAX_CHUNK_ENTITIES = 500
MAX_CHUNK_BYTES = 8 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class SnapshotEntityRecord:
    kind: Literal["entity"]
    entity_type: str
    entity_id: str
    version: int
    updated_at: str
    payload: Mapping[str, JsonValue]

    def __post_init__(self) -> None:
        require_nonnegative_version(self.version, field="version")
        require_canonical_utc_rfc3339(self.updated_at)
        object.__setattr__(self, "payload", require_frozen_i_json_object(self.payload))


@dataclass(frozen=True, slots=True)
class SnapshotCreateDecision:
    descriptor: SnapshotDescriptor | None
    error: AppError | None


@dataclass(frozen=True, slots=True)
class SnapshotPageDecision:
    page: RecoveryPage | None
    error: AppError | None


async def _iter_records(self, scope: SpaceRuntimeHandle) -> AsyncIterator[bytes]:
    for spec in self.catalog.list_sync_enabled():
        model = self.catalog.model_for(spec.name)
        primary_key = getattr(model, spec.primary_key)
        last_primary_key = ""
        while True:
            rows = tuple((await self.db.scalars(
                select(model)
                .where(primary_key > last_primary_key)
                .order_by(primary_key.asc())
                .limit(MAX_CHUNK_ENTITIES)
            )).all())
            if not rows:
                break
            for row in rows:
                payload = await self.serializer.serialize(scope, spec, row)
                entity_id = getattr(row, spec.primary_key)
                record = SnapshotEntityRecord(
                    kind="entity",
                    entity_type=spec.effective_sync_entity_type,
                    entity_id=entity_id,
                    version=require_nonnegative_version(row),
                    updated_at=canonical_utc_timestamp(row.updated_at),
                    payload=payload,
                )
                yield canonical_snapshot_json_line(record)
            last_primary_key = getattr(rows[-1], spec.primary_key)
```

`SnapshotEntityRecord` has exactly `kind,entity_type,entity_id,version,updated_at,payload`; `kind` is literal `entity`, entity type is the compiled effective wire key, entity ID is the declared primary key and must equal the same field in payload, version is a non-Boolean `0..MAX_JS_SAFE_INTEGER`, timestamp passes the shared strict UTC RFC 3339 calendar validator, and payload is a deep-frozen I-JSON object whose integral values are also JS-safe. Every payload contains the exact camelCase `spaceId` from `scope`, even though the per-Space ORM row does not repeat it; a serializer-supplied or mismatched Space value is rejected. `canonical_snapshot_json_line()` uses the pinned RFC 8785 serializer bytes plus exactly one LF; no separate JSON encoder is allowed. It rejects extra/missing keys, invalid I-JSON values, primary-key disagreement, and a serializer that returns a non-object before any chunk row is written. `SyncSnapshotSerializer` is injected by `SyncProtocol`: for Note it reads the authoritative Markdown body through the current handle and combines it with the exact client post-image metadata; for DB-only entities it uses the final catalog/schema field allowlist. It never reads derived frontmatter/index/FTS as authority. Backend tests cover every one of the 22 sync-enabled aliases, the mandatory `spaceId`, at least one non-`id` declared primary key, exact Markdown body bytes, strict timestamp edge cases, safe-integer exact/+1 boundaries, and DB-only records.

The chunk writer appends one line only when both resulting limits remain valid, flushes the current chunk otherwise, computes SHA-256 over uncompressed bytes, stores deterministic `gzip.compress(data, mtime=0)`, and never retains more than the current query page plus current chunk. Before append, a single canonical line with `len(line) > MAX_CHUNK_BYTES` fails with `snapshot_entity_too_large`, persists the generation unusable, and writes no oversize/empty predecessor chunk; it is never allowed to violate the chunk cap. Tests cover exactly 8 MiB and one byte over after the LF. Page serving never calls unbounded `gzip.decompress()`: `decode_persisted_chunk_bounded()` uses a single-member gzip/zlib stream with an output limit of `MAX_CHUNK_BYTES + 1`, rejects `unconsumed_tail`, `unused_data`, missing EOF, concatenated members and trailing bytes, then requires exact equality with recorded `uncompressed_bytes`, SHA-256, entity count, and manifest descriptors. Limit/metadata failure returns canonical `snapshot_invalid/full_recovery` and marks that persisted generation unusable; it never logs or returns partial bytes.

- [ ] **Step 4: Pin the manifest to catalog hash and allocated cursor high watermark**

Create the manifest and chunks in one Space transaction under the runtime Space exclusive lease after `recover_under_lease()` proves the Space clean. Read the singleton `SyncState.current_cursor` in that transaction and use it unchanged as the snapshot waterline; never derive the waterline from `MAX(visible sync_outbox.id)` or remaining ledger rows. Starting a manifest increments the client's recovery generation and stores its manifest token/waterline while clearing `recovery_completed_at`. After the new manifest and client pointer are durable in that same transaction, delete that client's prior manifest so chunks cascade; rollback retains the old generation rather than neither. The manifest SHA-256 is computed from canonical JSON containing `space_id`, `client_id`, generation, `catalog_hash`, waterline, ordered chunk hashes/counts/sizes, and totals. `page_token` is authenticated and binds Space/client/generation/manifest token/next chunk index. A public page is exactly one persisted chunk, never an arbitrary slice: each response is therefore bounded to 500 entities and 8 MiB uncompressed without needing a record offset. The session-bound store's `page()` revalidates expiry, bindings, manifest SHA-256, bounded decoded chunk size/SHA/entity count, catalog hash, and matching Space lease on every call. Serving the final page atomically sets the current client's `recovery_completed_at`; stale generation/page tokens cannot mutate it.

`SyncClientRegistry.collect_expired_recovery()` runs only inside the caller's already asserted matching Space-exclusive transaction. It must not exclude/delete a manifest merely because a raw `expires_at`/catalog predicate says it is stale while a client still references it. In stable client-id order it processes at most 100 referenced stale manifests: mark the client recovery-required and clear pointer/completion fields in the same transaction, after which that manifest is persistently unreferenced and may be deleted with chunk cascade. It may also delete already-unreferenced manifests in a bounded page. An unprocessed 101st referenced expired manifest remains a waterline pin. Protocol recovery and retention call it inside their existing session transaction, so repeated aborted/superseded generations converge without premature pin release or unbounded GC.

```python
async def recover(self, client_id: str, page_token: str | None) -> RecoveryPage:
    client_id = validate_client_id(client_id)
    page_token = validate_optional_page_token(page_token)
    async with self.scope.exclusive_space_resources("sync-recovery", 5) as lease:
        await self.uow.recover_under_lease(self.scope, lease)
        decision: SnapshotPageDecision | None = None
        async with self.scope.session_factory() as session, session.begin():
            registry = SyncClientRegistry(
                session, catalog_hash=self.catalog.hash, ttl_days=self.ttl_days
            )
            await registry.expire_inactive()
            await registry.register_or_touch(client_id)
            await registry.collect_expired_recovery()
            snapshots = SyncSnapshotStore(
                session, self.catalog, self.page_tokens, self.snapshot_serializer
            )
            if page_token is None:
                created = await snapshots.create(self.scope, lease, client_id)
                if created.error is not None:
                    decision = SnapshotPageDecision(page=None, error=created.error)
                else:
                    assert created.descriptor is not None
                    decision = await snapshots.page(
                        self.scope, lease, client_id,
                        created.descriptor.first_page_token,
                    )
            else:
                decision = await snapshots.page(
                    self.scope, lease, client_id, page_token
                )
        assert decision is not None
        if decision.error is not None:
            raise decision.error
        assert decision.page is not None
        return decision.page
```

`SnapshotCreateDecision` and `SnapshotPageDecision` enforce exactly one of value/error. Expected oversize/corrupt/expired generation paths first persist the unusable marker and cleared client pointer, return an error decision, commit normally, and only then raise outside `session.begin()`. Unexpected exceptions roll back. Fault tests stop after marker write, transaction commit, and pre-raise; every restart rejects the old page token and no unusable generation becomes current again.

Recovery is the only protocol allowed while `requires_recovery=True`; each page durably touches the client under the same exclusive lease/session transaction. The final page returns a Space/client/generation-bound waterline cursor, which the client persists and ACKs before incremental pull/push becomes eligible. The response exposes opaque `next_page_token`, `has_more`, `catalog_hash`, `waterline_cursor`, `entity_count`, raw uncompressed canonical JSONL as canonical standard base64, and its SHA-256. Backend construction/response validation enforces `entity_count <= MAX_SYNC_RECORDS`, decoded canonical JSONL `<= MAX_DECODED_CANONICAL_PAGE_BYTES`, and encoded string length `<= MAX_RECOVERY_BASE64_CHARS == 11_184_812`; strict base64 decode must round-trip to the identical spelling and exact decoded bytes before returning. The frontend hashes those decoded bytes before parsing lines, so Python/TypeScript never reserialize records to verify integrity. A zero-entity manifest returns one synthetic terminal page with empty payload, `entity_count=0`, SHA-256 of empty bytes, no chunk row, and a valid waterline cursor. It never accepts a public `limit`, exposes manifest database keys/numeric sequences, or slices a chunk without a record offset.

`backend/tests/fixtures/sync_recovery_jsonl_vectors.json` is generated by the production Python serializer and committed with exact `record`, `jsonl_base64`, `sha256`, and `entity_count` for nested keys, Unicode, slash/newline, integer/decimal-safe JSON numbers, every effective alias, and the empty page. Backend reparses every vector; `frontend/src/lib/sync/recovery.test.ts` reads this same file from `../backend/tests/fixtures` and asserts byte decode/hash/schema/primary-key equality. Neither side keeps a handwritten parallel record shape.

- [ ] **Step 5: Add the isolated RSS probe**

`measure_sync_snapshot.py` accepts argv `("--notes", "10000", "--body-bytes", "4096", "--output", str(output_path))`, creates its data below the supplied run-scoped temp root, invokes the production snapshot path, and writes:

```json
{"notes":10000,"body_bytes":4096,"chunks":20,"max_chunk_entities":500,"max_chunk_bytes":8388608,"snapshot_complete":true}
```

The exact chunk count may exceed 20 when Note metadata crosses a byte boundary; tests assert lower bounds and limits rather than hard-code 20.

- [ ] **Step 6: Run heap, resume, and Linux RSS gates**

Run on Windows/macOS for the Python heap contract:

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
cd backend
.\.venv\Scripts\python.exe -m pytest -q tests/test_sync_snapshot_streaming.py -p no:cacheprovider
```

Run in the Linux CI/container environment:

```bash
set -euo pipefail
cd backend
mkdir -p .test-results
/usr/bin/time -v .venv/bin/python scripts/measure_sync_snapshot.py --notes 10000 --body-bytes 4096 --output .test-results/sync-snapshot.json 2> .test-results/sync-snapshot-time.txt
python -c "import re,pathlib; t=pathlib.Path('.test-results/sync-snapshot-time.txt').read_text(); rss=int(re.search(r'Maximum resident set size \(kbytes\):\s*(\d+)',t).group(1)); assert rss <= 262144, rss"
```

Expected: pytest PASS; JSON reports `snapshot_complete=true`; maximum resident set size is at most `262144` KiB; restarting at every page token produces no loss or duplicate.

- [ ] **Step 7: Commit streaming recovery**

```powershell
git add backend/app/sync/snapshot.py backend/app/sync/contracts.py backend/app/sync/protocol.py backend/tests/fixtures/sync_streaming.py backend/tests/fixtures/sync_recovery_jsonl_vectors.json backend/tests/test_sync_snapshot_streaming.py backend/scripts/measure_sync_snapshot.py
git commit -m "feat(sync): add bounded resumable full recovery"
```

**Review gate:** Reject if current state is assembled into one list/JSON document, if chunk limits are checked after persistence, if page serving uses unbounded decompression or accepts a gzip bomb/size mismatch/trailing member, if continuation accepts a changed catalog/hash/waterline, if a corrupted chunk reaches a client, or if either memory ceiling lacks fresh evidence.

### Task 5: Expose Thin REST V2 Adapters And Remove Legacy Sync Operations

**Files:**
- Modify: `backend/app/schemas/sync.py`
- Create: `backend/app/sync/operations.py`
- Modify: `backend/app/routes/v1/sync.py`
- Create: `backend/tests/test_sync_routes_v2.py`
- Modify: `backend/tests/test_sync_routes.py`
- Modify: `backend/tests/test_response_contract.py`
- Modify: `backend/tests/test_openapi_contract.py`

**Interfaces:**
- Consumes: Task 3 exact `SyncProtocol.query_operations/push/pull/ack/status` signatures, Task 4 `recover(client_id, page_token)`, capped raw-body/I-JSON decoder, S1 canonical error Adapter, authenticated S2 Space runtime dependency, and TS0's approved breaking-cutover gate.
- Produces: `POST /api/v1/sync/v2/operations/query`, `POST /push`, `GET /pull`, `GET /recover`, `POST /ack`, and `GET /status`; immutable six-entry `SYNC_OPERATIONS` metadata shared with MCP/parity.

- [ ] **Step 1: Write failing REST contract tests before changing routes**

```python
async def test_v2_pull_treats_cursor_as_opaque_string(
    authorized_client, seeded_ledger, ready_client_id
):
    response = await authorized_client.get(
        "/api/v1/sync/v2/pull",
        params={"client_id": ready_client_id, "limit": 2},
    )
    assert response.status_code == 200
    body = response.json()
    assert isinstance(body["next_cursor"], str)
    assert body["next_cursor"]
    assert "sequence" not in body
    assert "next_cursor_id" not in body


async def test_ack_requires_client_and_cursor(authorized_client):
    response = await authorized_client.post("/api/v1/sync/v2/ack", json={})
    assert response.status_code == 422


async def test_operation_query_preserves_order_and_returns_original_batch_receipt(
    authorized_client, protocol_spy
):
    protocol_spy.query_operations.return_value = OperationQueryResult((
        terminal_query_item("op-a", batch_id="compound-root", result=original_push_result()),
        unknown_query_item("op-b"),
    ))

    response = await authorized_client.post(
        "/api/v1/sync/v2/operations/query",
        json={"client_id": "client-a", "operation_ids": ["op-a", "op-b"]},
    )

    assert response.status_code == 200
    assert [item["operation_id"] for item in response.json()["items"]] == ["op-a", "op-b"]
    assert response.json()["items"][0]["result"]["batch_id"] == "compound-root"
    protocol_spy.query_operations.assert_awaited_once_with("client-a", ("op-a", "op-b"))


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("post", "/api/v1/sync/push"),
        ("get", "/api/v1/sync/pull"),
        ("get", "/api/v1/sync/full"),
        ("get", "/api/v1/sync/status"),
    ],
)
async def test_legacy_sync_operations_are_absent(authorized_client, method, path):
    response = await getattr(authorized_client, method)(path)
    assert response.status_code == 404


def test_openapi_contains_no_legacy_sync_operation(app):
    paths = app.openapi()["paths"]
    assert not {
        "/api/v1/sync/push",
        "/api/v1/sync/pull",
        "/api/v1/sync/full",
        "/api/v1/sync/status",
    } & paths.keys()
```

Add schema tests that reject a numeric v2 cursor, an empty `client_id`, missing or duplicate event `operation_id`, missing/noncanonical `client_updated_at`, a missing `expected_version` key, update/delete without a safe nonnegative value, create with a non-null value, and batches over 500 events. Response-model tests separately feed missing, `null`, negative, Boolean, float, numeric-string, `2**53`, and `2**53+1` into every integer slot; only strict integers in `0..2**53-1` pass. Exercise strict UTC RFC 3339 lexical/calendar cases for both `client_updated_at` and response `created_at`. Pull/recovery response tests enforce at most 500 records, at most 8 MiB exact decoded/canonical page bytes, and canonical base64 encoded length at most `11_184_812`, including exact/+1 cases.

Send raw ASGI bodies containing a duplicate `client_id`, duplicate event `operation_id` member, and duplicates nested two levels inside `payload`; all must return the shared canonical input error before Pydantic binding or handle creation. Also cover BOM, trailing JSON, invalid UTF-8, lone surrogate escape, `NaN`/`Infinity`, and unsafe integers nested in payload. Through the shared transport-neutral parser, test per-event and aggregate canonical UTF-8 limits at boundary/+1 and assert zero registry/UoW calls on rejection. Add an opt-in canonical error assertion with exactly five keys. Route fixtures complete and ACK recovery for `ready_client_id`; tests never bypass the registry merely to make incremental pull/push pass.

- [ ] **Step 2: Run REST/OpenAPI tests and verify the red state**

Run:

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
cd backend
.\.venv\Scripts\python.exe -m pytest -q tests/test_sync_routes_v2.py tests/test_sync_routes.py tests/test_response_contract.py tests/test_openapi_contract.py -p no:cacheprovider
```

Expected: FAIL with 404 for `/api/v1/sync/v2/*` and missing v2 schemas.

- [ ] **Step 3: Define exact v2 Pydantic schemas**

```python
SafeNonnegativeInt = Annotated[
    StrictInt, Field(ge=0, le=MAX_JS_SAFE_INTEGER)
]
CanonicalUtcTimestamp = Annotated[
    str,
    Field(min_length=20, max_length=30, pattern=SYNC_UTC_RFC3339_PATTERN.pattern),
    AfterValidator(require_canonical_utc_rfc3339),
]
CanonicalRecoveryBase64 = Annotated[
    str,
    Field(max_length=MAX_RECOVERY_BASE64_CHARS),
    AfterValidator(validate_canonical_recovery_base64),
]
IJsonObject = Annotated[
    dict[str, JsonValue], AfterValidator(require_i_json_object_graph)
]


class SyncV2Event(BaseModel):
    model_config = ConfigDict(extra="forbid")
    entity_type: str = Field(pattern=r"^[A-Za-z0-9._:-]{1,64}$")
    entity_id: str = Field(pattern=r"^[A-Za-z0-9._:-]{1,64}$")
    action: Literal["create", "update", "delete"]
    payload: IJsonObject
    expected_version: SafeNonnegativeInt | None
    client_updated_at: CanonicalUtcTimestamp
    operation_id: str = Field(pattern=r"^[A-Za-z0-9._:-]{1,128}$")

class SyncV2PushRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    client_id: str = Field(pattern=r"^[A-Za-z0-9._:-]{1,64}$")
    batch_id: str = Field(pattern=r"^[A-Za-z0-9._:-]{1,128}$")
    events: list[SyncV2Event] = Field(min_length=1, max_length=500)


class SyncV2EventRecord(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    operation_id: str = Field(pattern=r"^[A-Za-z0-9._:-]{1,128}$")
    batch_id: str = Field(pattern=r"^[A-Za-z0-9._:-]{1,128}$")
    entity_type: str = Field(pattern=r"^[A-Za-z0-9._:-]{1,64}$")
    entity_id: str = Field(pattern=r"^[A-Za-z0-9._:-]{1,64}$")
    action: Literal["create", "update", "delete"]
    payload: IJsonObject
    version: SafeNonnegativeInt
    created_at: CanonicalUtcTimestamp


class SyncV2PushApplied(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    operation_id: str
    entity_type: str
    entity_id: str
    version: SafeNonnegativeInt
    resolution: Literal["remote"] | None


class SyncV2PushConflict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    operation_id: str
    entity_type: str
    entity_id: str
    code: Literal["version_conflict", "tombstone_conflict", "cycle_detected"]
    resolution: Literal["local", "tombstone", "circular_ref", "manual"]
    details: IJsonObject


class SyncV2PushError(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    operation_id: str
    entity_type: str
    entity_id: str
    code: str
    retryable: bool
    details: IJsonObject


class SyncV2PushResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    batch_id: str
    applied: list[SyncV2PushApplied] = Field(max_length=MAX_SYNC_RECORDS)
    conflicts: list[SyncV2PushConflict] = Field(max_length=MAX_SYNC_RECORDS)
    errors: list[SyncV2PushError] = Field(max_length=MAX_SYNC_RECORDS)


class SyncV2PullResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    events: list[SyncV2EventRecord] = Field(max_length=MAX_SYNC_RECORDS)
    next_cursor: str = Field(min_length=1)
    has_more: bool
    catalog_hash: str = Field(min_length=64, max_length=64)


class SyncV2AckRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    client_id: str = Field(pattern=r"^[A-Za-z0-9._:-]{1,64}$")
    cursor: str = Field(pattern=r"^[A-Za-z0-9._~-]{16,2048}$")


class SyncV2AckResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    client_id: str
    accepted: Literal[True]
    requires_recovery: bool
    catalog_hash: str = Field(pattern=r"^[0-9a-f]{64}$")


class SyncV2StatusResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    catalog_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    client_id: str | None
    registered: bool
    requires_recovery: bool | None
    recovery_action: Literal["full_recovery"] | None
    visible_event_count: SafeNonnegativeInt
    active_client_count: SafeNonnegativeInt
    recovery_client_count: SafeNonnegativeInt


class SyncV2OperationQueryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    client_id: str = Field(pattern=r"^[A-Za-z0-9._:-]{1,64}$")
    operation_ids: list[str] = Field(min_length=1, max_length=MAX_SYNC_RECORDS)


class SyncV2OperationQueryItem(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    operation_id: str
    state: Literal["unknown", "pending", "terminal", "recovery_required"]
    batch_id: str | None
    result: SyncV2PushResponse | None

    @model_validator(mode="after")
    def validate_binding(self) -> "SyncV2OperationQueryItem":
        if self.state == "unknown":
            if self.batch_id is not None or self.result is not None:
                raise ValueError("unknown operation cannot expose a binding")
            return self
        if self.batch_id is None:
            raise ValueError("known operation requires its original batch ID")
        if self.state == "terminal":
            if self.result is None or self.result.batch_id != self.batch_id:
                raise ValueError("terminal operation requires its original batch result")
        elif self.result is not None:
            raise ValueError("nonterminal operation cannot expose a result")
        return self


class SyncV2OperationQueryResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    items: list[SyncV2OperationQueryItem] = Field(min_length=1, max_length=MAX_SYNC_RECORDS)


class SyncV2RecoveryResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    payload_jsonl_base64: CanonicalRecoveryBase64
    entity_count: SafeNonnegativeInt = Field(le=MAX_SYNC_RECORDS)
    chunk_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    next_page_token: Annotated[str, Field(min_length=16, max_length=2048)] | None
    has_more: bool
    catalog_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    waterline_cursor: str = Field(min_length=16, max_length=2048)
```

`validate_canonical_recovery_base64()` accepts only canonical standard base64, rejects whitespace/URL-safe variants/noncanonical padding, decodes with validation, requires `len(decoded) <= MAX_DECODED_CANONICAL_PAGE_BYTES`, and requires re-encoding to equal the original string. `SyncV2PullResponse` has a model validator that RFC-8785 serializes the JSON-native page once and requires the exact canonical bytes to be at most 8 MiB; `SyncV2RecoveryResponse` validates decoded JSONL bytes at the same cap. Neither response may claim more than 500 records/entities. These checks are repeated by the transport-neutral constructors so Pydantic is defense-in-depth, not the sole boundary.

`SyncV2RecoveryResponse` exposes the exact raw-byte fields above. It never exposes parsed `records`, an integer offset/cursor, or a recovery `limit`. The displayed `SyncV2EventRecord` and `SyncV2PushResponse` are the complete definitions; they mirror the frozen transport contracts exactly, including operation/batch identity, retryable, and mutually exclusive resolution semantics. Every v2 response version/count field is required, non-null, strict and JS-safe; Boolean and numeric strings never coerce. The database `sync_outbox.version` column stays nullable only for schema rollback/recovery proof, not to widen a v2 DTO. The push request deliberately has no duplicate-ID model validator: the shared parser owns that domain error so REST and MCP both return the same `idempotency_conflict` status/record with zero side effects. Delete legacy Sync request/response schemas and prove no OpenAPI reference reaches them.

`SyncV2OperationQueryRequest` uses the same duplicate-preserving raw-body path as push/ACK, requires one to 500 unique operation IDs in caller order, and never accepts a batch ID substitute. Its response preserves that order and the four transport-neutral states exactly. `unknown` has null `batch_id/result`; `pending` and `recovery_required` require the original `batch_id` and null result; `terminal` requires a complete strict `SyncV2PushResponse` whose `batch_id` is identical. The official-client response parser rejects a partial per-operation result, a fifth state, duplicate operation IDs anywhere inside a nested result, a terminal item whose declared operation is not present in exactly one outcome array, or terminal items that disagree on original batch identity or canonical complete-result bytes.

Runtime binding rule: FastAPI does not bind raw push/ACK bodies or query values directly to these strict documentation models before the shared validator. `body_size_limit.py` caps the stream and makes the exact bounded bytes available to the validation dependency; `validate_*_before_runtime(request)` starts with those bytes, invokes the duplicate-preserving `decode_sync_i_json()` and transport-neutral validator, and only then may use Pydantic models for a post-validation assertion/OpenAPI response. It never calls `Request.json()`, `json.loads()` without the duplicate hook, or re-reads an unbounded stream. Thus pattern/`StrictInt` errors cannot become transport-specific 422s. Non-object/malformed/non-I-JSON input is mapped by the same S1 `AppError` factory used by MCP. Real REST/MCP tests compare nested duplicates where representable, invalid Unicode/whitespace IDs, unsafe/Boolean/string versions, bad action/version combinations, and oversize tokens for exact status/code/details and zero handle creation.

- [ ] **Step 4: Lock the operation catalog and implement thin routes**

```python
@dataclass(frozen=True, slots=True)
class SyncOperationSpec:
    name: str
    rest_method: str
    rest_path: str
    mcp_tool: str
    runtime_mode: Literal["read", "write"]


SYNC_OPERATIONS = (
    SyncOperationSpec("query_operations", "POST", "/api/v1/sync/v2/operations/query", "sync_query_operations", "write"),
    SyncOperationSpec("push", "POST", "/api/v1/sync/v2/push", "sync_push", "write"),
    SyncOperationSpec("pull", "GET", "/api/v1/sync/v2/pull", "sync_pull", "write"),
    SyncOperationSpec("recover", "GET", "/api/v1/sync/v2/recover", "sync_recover", "write"),
    SyncOperationSpec("ack", "POST", "/api/v1/sync/v2/ack", "sync_ack", "write"),
    SyncOperationSpec("status", "GET", "/api/v1/sync/v2/status", "get_sync_status", "read"),
)
```

Each v2 handler looks up its `SyncOperationSpec`. An operation-specific `validate_sync_*_before_runtime` dependency performs the shared outer/semantic validation and returns a frozen `ValidatedSyncCall`; `get_sync_protocol_for_validated()` explicitly depends on that same cached object before it opens S2 `AuthorizedSpaceScope`. Thus invalid REST input cannot open a handle even if FastAPI dependency scheduling changes. MCP calls the same validator before its `async with`. Only then does the factory pass exactly public `read|write` mode, create `SyncProtocol`, call one protocol method, and map the returned dataclass. S2 maps `write` to its internal mutation handle, which retains global-shared but does not pre-acquire Space-shared, so protocol/UoW can acquire Space-exclusive without an upgrade. No S4 Adapter passes public mode `mutation` or widens S2's Interface. It never calls `db.commit()`, `record_sync_event()`, an ORM service, or `SpaceEngineManager`.

```python
@router.post("/v2/operations/query", response_model=SyncV2OperationQueryResponse)
async def query_operations_v2(
    call: ValidatedOperationQueryCall = Depends(validate_operation_query_before_runtime),
    protocol: SyncProtocol = Depends(get_sync_protocol_for_validated("query_operations")),
) -> SyncV2OperationQueryResponse:
    return SyncV2OperationQueryResponse.model_validate(
        to_wire_json(await protocol.query_operations(
            call.client_id, operation_ids=call.operation_ids
        ))
    )


@router.get("/v2/pull", response_model=SyncV2PullResponse)
async def pull_v2(
    call: ValidatedPullCall = Depends(validate_pull_before_runtime),
    protocol: SyncProtocol = Depends(get_sync_protocol_for_validated("pull")),
) -> SyncV2PullResponse:
    return SyncV2PullResponse.model_validate(
        to_wire_json(await protocol.pull(
            call.client_id, opaque_cursor=call.cursor, limit=call.limit
        ))
    )
```

`validate_pull_before_runtime()` accepts query text for `limit` only when it matches canonical decimal `^(?:[1-9]|[1-9][0-9]|[1-4][0-9]{2}|500)$`, then converts once; it rejects `true`, signs, whitespace, floats, 0, and 501. Equivalent validators own operation-query/push/recover/ACK/status. Operation query accepts one to 500 unique validated operation IDs and calls `protocol.query_operations(...)` exactly once. The recovery handler accepts only `client_id` and optional opaque `page_token`; it has no `limit` parameter and calls `protocol.recover(client_id, page_token)` once. Route/OpenAPI tests assert the six operation modes above, shared status/code parity with MCP, and zero handle creation for every invalid boundary.

- [ ] **Step 5: Run route, exact-body, and OpenAPI tests**

Run:

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
cd backend
.\.venv\Scripts\python.exe -m pytest -q tests/test_sync_routes_v2.py tests/test_sync_routes.py tests/test_response_contract.py tests/test_openapi_contract.py -p no:cacheprovider
```

Expected: PASS; OpenAPI declares exactly the six v2 operations, including `POST /api/v1/sync/v2/operations/query`, with opaque strings; operation query preserves ordered IDs and its four states/full-batch terminal receipt; every legacy Sync path returns 404 and is absent from OpenAPI; canonical media type and headers expose `cursor_expired` without host paths or token content.

- [ ] **Step 6: Commit the REST Adapter**

```powershell
git add backend/app/schemas/sync.py backend/app/sync/operations.py backend/app/routes/v1/sync.py backend/tests/test_sync_routes_v2.py backend/tests/test_sync_routes.py backend/tests/test_response_contract.py backend/tests/test_openapi_contract.py
git commit -m "feat(sync): expose v2 rest protocol adapters"
```

**Review gate:** Reject if the catalog/OpenAPI/route set is not exactly the six locked operations; if `/api/v1/sync/v2/operations/query` is missing, accepts duplicate/zero/501 IDs, changes caller order, omits `pending`, accepts a fifth state, or returns anything other than the original complete batch receipt for `terminal`; if a v2 handler commits, decodes a cursor, builds a storage path, contains domain/LWW rules, calls `Request.json()`, loses duplicate keys before validation, accepts non-I-JSON, or bypasses the shared event/batch byte parser; if Pydantic widens safe integers, UTC timestamps, 500 records, decoded 8 MiB, or canonical base64 limits; if `client_updated_at` is absent/noncanonical; if numeric cursors appear in OpenAPI; or if any legacy Sync route/schema/redirect remains.

### Task 6: Make MCP A Complete Adapter Over The Same Sync Protocol

**Files:**
- Create: `backend/app/mcp/sync_tools.py`
- Modify: `backend/app/mcp/server.py`
- Create: `backend/tests/test_mcp_sync_parity.py`
- Modify: `backend/tests/test_mcp_server.py`
- Modify: `backend/tests/test_mcp_authorization.py`
- Modify: `backend/tests/test_parity_stats_mcp.py`

**Interfaces:**
- Consumes: `SYNC_OPERATIONS`, S1 authenticated MCP principal/context, S2 `AuthorizedSpaceScope.open(...)`, Task 3/4 exact `SyncProtocol.query_operations/push/pull/recover/ack/status` signatures, shared I-JSON graph/parser boundary, S1 `DomainErrorRecord`.
- Produces: exactly six FastMCP tools `sync_query_operations`, `sync_push`, `sync_pull`, `sync_recover`, `sync_ack`, and `get_sync_status` with REST-equivalent inputs/results/errors.

- [ ] **Step 1: Write failing bidirectional parity and delegation tests**

```python
async def test_sync_operation_catalog_matches_rest_and_mcp(app, mcp):
    rest = {
        (route.path, method)
        for route in app.routes
        for method in getattr(route, "methods", set())
        if route.path.startswith("/api/v1/sync/v2/")
    }
    tools = {tool.name for tool in await mcp.list_tools()}
    assert rest == {(spec.rest_path, spec.rest_method) for spec in SYNC_OPERATIONS}
    assert tools & {spec.mcp_tool for spec in SYNC_OPERATIONS} == {
        spec.mcp_tool for spec in SYNC_OPERATIONS
    }


async def test_mcp_pull_delegates_opaque_cursor(protocol_spy, mcp_context):
    await sync_pull(
        space_id="space-a",
        client_id="client-a",
        cursor="opaque-token",
        limit=7,
        ctx=mcp_context,
    )
    protocol_spy.pull.assert_awaited_once_with(
        "client-a", opaque_cursor="opaque-token", limit=7
    )


async def test_mcp_operation_query_delegates_ordered_ids_and_full_batch_result(
    protocol_spy, mcp_context
):
    protocol_spy.query_operations.return_value = query_result_with_terminal_batch(
        operation_ids=("child-a", "child-b"), batch_id="compound-root"
    )

    result = await sync_query_operations(
        space_id="space-a",
        client_id="client-a",
        operation_ids=["child-a", "child-b"],
        ctx=mcp_context,
    )

    protocol_spy.query_operations.assert_awaited_once_with(
        "client-a", ("child-a", "child-b")
    )
    assert [item["operation_id"] for item in result["items"]] == ["child-a", "child-b"]
    assert result["items"][0]["result"]["batch_id"] == "compound-root"
```

Add one parametrized test per operation comparing REST and MCP normalized result schemas. Add canonical error parity for `cursor_expired`, `version_conflict`, `space_storage_missing`, and `lease_timeout`. Push parity invokes the same `SyncEventInput.parse_batch()` with exact/+1 per-event bytes and a 500-event aggregate over the 10 MiB ceiling; REST and MCP must return the same canonical error and make zero protocol calls. Direct MCP inputs also include nested unsafe integers, nonfinite floats, lone-surrogate strings, non-string mapping keys, bytes, datetime, and arbitrary objects; each is rejected by the shared I-JSON graph validator before a runtime handle opens. This is mandatory because MCP bypasses ASGI raw-body middleware and cannot rely on JSON decoding to enforce I-JSON semantics.

Add lifecycle tests for every tool factory path: a successful call, a protocol `AppError`, and cancellation after the handle opens must each await `SpaceRuntimeHandle.aclose()` exactly once and leave no active global/Space lease. `test_mcp_body_and_handle_cleanup_failure_preserve_primary_order` injects an `AppError` or cancellation from the protocol together with an `aclose()` failure and requires `BaseExceptionGroup.exceptions == (primary, *cleanup_errors)`; the retryable owner remains registered for same-Task cleanup. Authentication failure before a handle exists closes nothing. The cancellation test waits on an event rather than sleeping.

- [ ] **Step 2: Run MCP tests and verify the red state**

Run:

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
cd backend
.\.venv\Scripts\python.exe -m pytest -q tests/test_mcp_sync_parity.py tests/test_mcp_server.py tests/test_mcp_authorization.py tests/test_parity_stats_mcp.py -p no:cacheprovider
```

Expected: FAIL because MCP has only hand-written status/pull and lacks operation-query/push/recover/ack.

- [ ] **Step 3: Register all operations through one Adapter installer**

```python
class McpSyncProtocolFactory:
    async def authenticate(self, ctx: Context | None) -> Principal:
        return await self.authentication.principal(ctx)

    @asynccontextmanager
    async def open_authenticated(
        self, *, principal: Principal, space_id: str, operation_name: str
    ) -> AsyncIterator[SyncProtocol]:
        spec = SYNC_OPERATIONS_BY_NAME[operation_name]
        handle = await self.scopes.open(principal, space_id, spec.runtime_mode)
        async with handle:
            yield self.protocols.for_handle(handle)


def register_sync_tools(mcp: FastMCP, protocol_factory: McpSyncProtocolFactory) -> None:
    @mcp.tool(name="sync_query_operations")
    async def sync_query_operations(
        space_id: str,
        client_id: Annotated[StrictStr, Field(min_length=1, max_length=64)],
        operation_ids: Annotated[
            list[Annotated[StrictStr, Field(min_length=1, max_length=128)]],
            Field(min_length=1, max_length=500),
        ],
        ctx: Context | None = None,
    ) -> dict[str, Any]:
        principal = await protocol_factory.authenticate(ctx)
        call = validate_operation_query_inputs(client_id, operation_ids)
        async with protocol_factory.open_authenticated(
            principal=principal, space_id=space_id, operation_name="query_operations"
        ) as protocol:
            return to_wire_json(
                await protocol.query_operations(call.client_id, call.operation_ids)
            )

    @mcp.tool(name="sync_pull")
    async def sync_pull(
        space_id: str,
        client_id: Annotated[StrictStr, Field(min_length=1, max_length=64)],
        cursor: Annotated[StrictStr, Field(min_length=16, max_length=2048)] | None = None,
        limit: Annotated[StrictInt, Field(ge=1, le=500)] = 500,
        ctx: Context | None = None,
    ) -> dict[str, Any]:
        principal = await protocol_factory.authenticate(ctx)
        call = validate_sync_pull_inputs(client_id, cursor, limit)
        async with protocol_factory.open_authenticated(
            principal=principal, space_id=space_id, operation_name="pull"
        ) as protocol:
            return to_wire_json(
                await protocol.pull(
                    call.client_id, opaque_cursor=call.cursor, limit=call.limit
                )
            )

    @mcp.tool(name="sync_ack")
    async def sync_ack(
        space_id: str,
        client_id: Annotated[StrictStr, Field(min_length=1, max_length=64)],
        cursor: Annotated[StrictStr, Field(min_length=16, max_length=2048)],
        ctx: Context | None = None,
    ) -> dict[str, Any]:
        principal = await protocol_factory.authenticate(ctx)
        call = validate_sync_ack_inputs(client_id, cursor)
        async with protocol_factory.open_authenticated(
            principal=principal, space_id=space_id, operation_name="ack"
        ) as protocol:
            return to_wire_json(
                await protocol.ack(client_id=call.client_id, cursor=call.cursor)
            )
```

Implement `sync_push`, `sync_recover`, and `get_sync_status` with strict constrained MCP annotations/models generated from the same constants and the same `authenticate -> shared validate -> open_authenticated` sequence; the displayed `sync_query_operations`, `sync_pull`, and `sync_ack` complete the six-entry set. The FastMCP validation-error hook converts pre-function Pydantic failures through the shared `sync_input_error(field, reason)` AppError factory; it never returns FastMCP prose. Tool-schema tests require operation query `minItems=1,maxItems=500` with unique validated IDs, integer `minimum=1,maximum=500`, safe-integer maximum `9007199254740991` for versions/counts, string/token bounds, strict UTC timestamp schema, recovery base64 encoded cap `11184812`, and max 500 items. Direct `tool.run` tests pass duplicate/zero/501 operation IDs, `True`, `"7"`, and `2**53` for every integer slot (`limit`, `expected_version`, response-fixture `version`, and counts) plus Unicode/whitespace IDs and 2049-byte tokens; all are rejected where out of contract, never coerced, and match REST normalized status/code/details while creating zero handle.

`sync_push` accepts a structured list/object only and never a raw JSON string escape hatch. Immediately after authentication it calls `validate_i_json_graph()` on the original MCP object, then the same transport-neutral batch parser used by REST, before `AuthorizedSpaceScope`/registry/UoW work. Duplicate names are a REST raw-decoder concern because a materialized MCP mapping cannot represent them; every other I-JSON restriction is identical. Recovery accepts optional `page_token` and no limit. `open_authenticated()` opens only through `AuthorizedSpaceScope` and uses explicit trusted-stdio identity only in configured stdio mode. Its cleanup composes a primary `AppError`/unexpected error/cancellation with `handle.aclose()` errors in primary-first order and retains S2 pending cleanup ownership; cleanup never masks the body failure. The Adapter calls `AppError.to_domain_record(request_id)` and preserves all five keys; no tool reduces it to prose or chooses its own runtime mode. Tests assert invalid I-JSON/IDs/limits/tokens/batches authenticate but create zero runtime handle, while authentication failure creates nothing and does not reveal input-validation detail.

- [ ] **Step 4: Remove the reduced Sync implementation from `server.py`**

Delete direct `SyncService`, `get_space_session`, and path-derived Sync calls. Keep stats/registry tools unchanged. Install the new tools once after FastMCP construction:

```python
mcp = FastMCP(name="PomodoroXII", instructions=INSTRUCTIONS)
register_sync_tools(mcp, protocol_factory=get_mcp_sync_protocol_factory())
```

- [ ] **Step 5: Run MCP authorization, parity, and existing stats gates**

Run:

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
cd backend
.\.venv\Scripts\python.exe -m pytest -q tests/test_mcp_sync_parity.py tests/test_mcp_server.py tests/test_mcp_authorization.py tests/test_parity_stats_mcp.py -p no:cacheprovider
```

Expected: PASS; `FastMCP.list_tools()` contains exactly the six catalog Sync tools including `sync_query_operations`; REST/MCP preserve operation-query order/four-state/full-batch results, accept the same opaque tokens, and return equivalent normalized records/canonical errors; unauthorized/cross-Space calls create no engine or file.

- [ ] **Step 6: Commit complete MCP delegation**

```powershell
git add backend/app/mcp/sync_tools.py backend/app/mcp/server.py backend/tests/test_mcp_sync_parity.py backend/tests/test_mcp_server.py backend/tests/test_mcp_authorization.py backend/tests/test_parity_stats_mcp.py
git commit -m "feat(mcp): delegate complete sync protocol"
```

**Review gate:** Reject if MCP has an operation absent from the catalog, lacks any of the six REST v2 operations, does not expose `sync_query_operations`, changes query ID order/state/result shape, or fails bidirectional REST/MCP parity for the TS3 compound-root vector; if it accepts a JSON-text shortcut or skips I-JSON graph validation, widens any shared numeric/timestamp/page limit, opens sessions/paths directly, leaks a runtime handle on success/error/cancellation, bypasses HTTP authorization, changes stdio trust implicitly, or returns prose where REST carries a canonical record.

### Task 7: Upgrade The Official Frontend To Opaque Cursor, ACK, And Crash-Safe Recovery

**Files:**
- Modify: `frontend/src/services/database.ts`
- Modify: `frontend/src/services/database.test.ts`
- Modify: `frontend/src/services/dexie-v18-cutover.ts`
- Modify: `frontend/src/services/dexie-v18-cutover.test.ts`
- Modify: `frontend/src/services/space-db.ts`
- Modify: `frontend/src/services/space-db.test.ts`
- Modify: `frontend/src/services/meta-database.ts`
- Modify: `frontend/src/services/meta-database.test.ts`
- Modify: `frontend/src/types/index.ts`
- Modify: `frontend/src/lib/sync/outbox.ts`
- Modify: `frontend/src/lib/sync/outbox.test.ts`
- Create: `frontend/src/lib/sync/provisional-operation-authority.ts`
- Create: `frontend/src/lib/sync/provisional-operation-authority.test.ts`
- Modify: `frontend/src/lib/task-space/work-item-note-repository.ts`
- Modify: `frontend/src/lib/task-space/work-item-note-repository.test.ts`
- Modify: `frontend/src/lib/quick-notes/quick-note-repository.ts`
- Modify: `frontend/src/lib/quick-notes/quick-note-repository.test.ts`
- Modify: `frontend/src/lib/sync/quick-note-sync.integration.test.ts`
- Modify: `frontend/src/stores/trash-store.ts`
- Modify: `frontend/src/stores/trash-store.test.ts`
- Modify: `frontend/src/lib/focus-session/focus-session-repository.ts`
- Modify: `frontend/src/lib/focus-session/focus-session-repository.test.ts`
- Modify: `frontend/src/lib/focus-session/provisional-start-recovery.ts`
- Modify: `frontend/src/lib/focus-session/provisional-start-recovery.test.ts`
- Modify: `frontend/src/lib/focus-session/active-session-coordinator.ts`
- Modify: `frontend/src/lib/focus-session/active-session-coordinator.test.ts`
- Modify: `frontend/src/lib/contracts/task-space.ts`
- Modify: `frontend/src/lib/contracts/focus-session.ts`
- Create: `frontend/src/lib/sync/space-authority-fence.ts`
- Create: `frontend/src/lib/sync/space-authority-fence.test.ts`
- Create: `frontend/src/lib/sync/authority-identity.ts`
- Create: `frontend/src/lib/sync/authority-identity.test.ts`
- Create: `frontend/src/lib/sync/entity-payload-hash.ts`
- Create: `frontend/src/lib/sync/entity-payload-hash.test.ts`
- Create: `frontend/src/lib/sync/admission.ts`
- Create: `frontend/src/lib/sync/admission.test.ts`
- Create: `frontend/src/lib/sync/terminal-application.ts`
- Create: `frontend/src/lib/sync/terminal-application.test.ts`
- Create: `frontend/src/lib/sync/client-registry.ts`
- Create: `frontend/src/lib/sync/transport.ts`
- Create: `frontend/src/lib/sync/response-schema.ts`
- Create: `frontend/src/lib/sync/recovery.ts`
- Modify: `frontend/src/lib/sync/sync-meta.ts`
- Modify: `frontend/src/lib/sync/types.ts`
- Modify: `frontend/src/lib/sync/pull-loop.ts`
- Modify: `frontend/src/lib/sync/push-batch.ts`
- Modify: `frontend/src/lib/sync/merge.ts`
- Modify: `frontend/src/lib/sync/engine.ts`
- Create: `frontend/src/lib/sync/recovery.test.ts`
- Create: `frontend/src/lib/sync/transport.test.ts`
- Create: `frontend/src/lib/sync/fixtures/sync-event-canonical-vectors.json`
- Modify: `frontend/src/lib/sync/pull-loop.test.ts`
- Modify: `frontend/src/lib/sync/push-batch.test.ts`
- Modify: `frontend/src/lib/sync/merge.test.ts`
- Modify: `frontend/src/lib/sync/sync-meta.test.ts`
- Modify: `frontend/src/lib/sync/engine.test.ts`
- Modify: `backend/scripts/export_openapi.py`
- Regenerate: `frontend/openapi.json`
- Verify unchanged: `frontend/package.json`
- Verify unchanged: `frontend/package-lock.json`
- Regenerate: `frontend/src/types/api-generated.ts`
- Consume unchanged: `backend/tests/fixtures/sync_recovery_jsonl_vectors.json`
- Consume unchanged: `backend/tests/fixtures/sync_event_canonical_vectors.json`

**Interfaces:**
- Consumes: generated REST v2 schemas; TS3 Dexie v18 final-business tables and exact `PomodoroXIDB.spaceId`/database-name binding; unchanged `prepareHeldProvisionalBatch(rows)`; TS3 Task 9's single `toReviewRows` aggregate identity projector and `applyAuthoritativeReviewAndClearDraft` transaction helper; S3-persisted `OutboxEvent.operationId`/`expectedVersion`/`requiresVersionRebase`/`createdAt`; TS3 nonoptional `OutboxEvent.spaceId` plus `transportState`/`compoundOperationId`/`compoundOrder`; Meta `ProvisionalOperationRow.state="awaiting_s4"`; a structured pending `SessionReviewDraftRow` whose fixed operation ID has not been sent; v2 opaque cursors/page tokens; `client_id`; ACK; and recovery raw-byte chunk hashes.
- Produces: one exclusive Browser Web Lock and live `SpaceAuthorityToken` per Space; Dexie v19 `syncAdmissionState`/`syncRecoveryState`/`syncRecoveryChunks`/`syncPushBatches`/`syncTerminalApplications`; per-root ordered identity tuples/digests; Meta `transport_ready` plus exact terminal-evidence resolution bindings; post-`transport_resolved` durable resumption of the original TS2 review command; stable per-Space client ID; persisted `pendingAck`; a validated immutable pending-push receipt containing full frozen row/root identity, original batch/child identity, request headers/idempotency key/canonical request+event bytes+SHA-256; canonical-accept `SyncV2Transport`; six strict Zod runtime response parsers; fenced query-first `pushAllPending()`; ordered `applySyncEventRecord()`; `runFullRecovery()`; and regenerated TypeScript v2 contracts.

- [ ] **Step 1: Write failing Dexie v19 and crash-boundary tests**

```typescript
const runAdmission = (db: PomodoroXIDB, meta: MetaDB, spaceId = 'space-a') =>
  withSpaceAuthorityFence(spaceId, (token) =>
    admitTs3AwaitingS4(db, meta, spaceId, token))

const runRecovery = (
  db: PomodoroXIDB, api: AxiosInstance,
  spaceId = 'space-a', clientId = 'client-a',
) => withSpaceAuthorityFence(spaceId, (token) =>
  runFullRecovery(db, api, spaceId, clientId, token))

const runPull = (
  db: PomodoroXIDB, api: AxiosInstance,
  spaceId = 'space-a', clientId = 'client-a',
) => withSpaceAuthorityFence(spaceId, (token) =>
  runPullLoop(db, api, spaceId, clientId, token))

const seedSyncV2Meta = (
  db: PomodoroXIDB, value: Partial<SyncV2MetaSnapshot>, spaceId = 'space-a',
) => withSpaceAuthorityFence(spaceId, (token) =>
  writeSyncV2Meta(db, spaceId, token, value))

it('admits TS3 standalone and compound rows without changing their authority', async () => {
  const { db, meta, compoundRoot, childOperationIds } = await openV18AwaitingS4Fixture()

  await runAdmission(db, meta)

  const admitted = await db.outbox.orderBy('id').toArray()
  expect(admitted.filter((row) => row.transportState === 'awaiting_s4')).toHaveLength(0)
  expect(admitted.filter((row) => row.transportState === 'blocked_conflict'))
    .toEqual([expect.objectContaining({ entityId: 'conflicted-note' })])
  const compound = admitted.filter((row) => row.compoundOperationId === compoundRoot)
  const prepared = prepareHeldProvisionalBatch(compound)
  expect(prepared.batchId).toBe(compoundRoot)
  expect(prepared.items.map((item) => item.operationId)).toEqual(childOperationIds)
  expect(await db.syncAdmissionState.get('active')).toMatchObject({ state: 'ready' })
  expect(await meta.provisionalOperations.get(compoundRoot)).toMatchObject({
    state: 'transport_ready',
  })
})


it('fails readiness atomically when an awaiting compound is incomplete', async () => {
  const { db, meta, api, compoundRoot } = await openV18AwaitingS4Fixture({
    removeCompoundOrder: 2,
  })
  const before = await db.outbox.toArray()

  await expect(runAdmission(db, meta)).rejects.toThrow(
    'provisional_compound_batch_incomplete',
  )
  await expect(pushAllPending(db, meta, 'space-a', api)).rejects.toThrow(
    'S4 admission is not ready',
  )

  expect(await db.outbox.toArray()).toEqual(before)
  expect(await db.syncAdmissionState.get('active')).toMatchObject({ state: 'failed' })
  expect(await meta.provisionalOperations.get(compoundRoot)).toMatchObject({
    state: 'awaiting_s4',
  })
  expect(api.operationQueries).toHaveLength(0)
  expect(api.pushes).toHaveLength(0)
})


it('resumes meta_pending before any admitted compound can be selected', async () => {
  const { db, meta, api, compoundRoot } = await openV18AwaitingS4Fixture({
    crashAfterSpaceAdmissionCommit: true,
  })
  await expect(runAdmission(db, meta)).rejects.toThrow('injected crash')
  expect(await db.syncAdmissionState.get('active')).toMatchObject({ state: 'meta_pending' })
  await expect(pushAllPending(db, meta, 'space-a', api)).rejects.toThrow(
    'S4 admission is not ready',
  )

  await runAdmission(await openPomodoroXIDB('space-a'), new MetaDB(meta.name))

  expect(await db.syncAdmissionState.get('active')).toMatchObject({ state: 'ready' })
  expect(await meta.provisionalOperations.get(compoundRoot)).toMatchObject({
    state: 'transport_ready',
  })
  expect(api.pushes).toHaveLength(0)
})


it('does not trust a reopened ready marker when a new same-Space root is awaiting', async () => {
  const { db, meta, api, existingRoot } = await readyAdmissionFixture()
  const { compoundRoot: newRoot } = await seedCompleteAwaitingS4Compound(db, meta, {
    spaceId: 'space-a',
  })
  const reopenedDb = await openPomodoroXIDB('space-a')
  const reopenedMeta = new MetaDB(meta.name)

  await expect(pushAllPending(reopenedDb, reopenedMeta, 'space-a', api)).rejects.toThrow(
    'S4 admission is not ready',
  )
  expect(await reopenedDb.syncAdmissionState.get('active')).toMatchObject({ state: 'pending' })
  expect(api.operationQueries).toHaveLength(0)
  expect(api.pushes).toHaveLength(0)

  await runAdmission(reopenedDb, reopenedMeta)

  const marker = (await reopenedDb.syncAdmissionState.get('active'))!
  expect(marker.state).toBe('ready')
  expect(marker.readyRoots.filter((root) => root.rootKind === 'compound')
    .map((root) => root.rootId).sort()).toEqual([existingRoot, newRoot].sort())
  expect(marker.readyRootSetSha256).toMatch(/^[0-9a-f]{64}$/)
  expect(await reopenedMeta.provisionalOperations.get(newRoot)).toMatchObject({
    state: 'transport_ready',
  })
})


it('fails closed after restart when Meta has an orphan awaiting root', async () => {
  const { db, meta, api } = await readyAdmissionFixture()
  await meta.provisionalOperations.put(provisionalOperation({
    operationId: 'orphan-root', spaceId: 'space-a', state: 'awaiting_s4',
  }))
  const reopenedDb = await openPomodoroXIDB('space-a')
  const reopenedMeta = new MetaDB(meta.name)

  await expect(pushAllPending(reopenedDb, reopenedMeta, 'space-a', api)).rejects.toThrow(
    'provisional_meta_root_missing',
  )
  expect(await reopenedDb.syncAdmissionState.get('active')).toMatchObject({ state: 'failed' })
  expect(api.operationQueries).toHaveLength(0)
  expect(api.pushes).toHaveLength(0)

  await expect(runAdmission(reopenedDb, reopenedMeta)).rejects.toThrow(
    'provisional_meta_root_missing',
  )
})


it('fails closed when a reopened ready marker disagrees with Meta transport-ready roots', async () => {
  const { db, meta, api } = await readyAdmissionFixture()
  await db.syncAdmissionState.update('active', {
    readyRoots: [], readyRootSetSha256: '0'.repeat(64),
  })
  const reopenedDb = await openPomodoroXIDB('space-a')
  const reopenedMeta = new MetaDB(meta.name)

  await expect(pushAllPending(reopenedDb, reopenedMeta, 'space-a', api)).rejects.toThrow(
    'provisional_ready_root_identity_mismatch',
  )

  expect(await reopenedDb.syncAdmissionState.get('active')).toMatchObject({ state: 'failed' })
  expect(api.operationQueries).toHaveLength(0)
  expect(api.pushes).toHaveLength(0)
})


it('keeps old state visible when the browser crashes between recovery chunks', async () => {
  const db = await openV18DbWithWorkItemAndOperationIds({ id: 'old', title: 'old' })
  const api = recoveryApi([chunk(0, [{ kind: 'workItem', payload: { id: 'new-1' } }])], {
    crashAfterChunk: 0,
  })
  await expect(runRecovery(db, api)).rejects.toThrow('injected crash')
  expect(await db.workItems.toArray()).toEqual([expect.objectContaining({ id: 'old' })])
  const reopened = await openPomodoroXIDB('space-a')
  await runRecovery(reopened, recoveryApiForRemainingChunks())
  expect((await reopened.workItems.toArray()).map((row) => row.id)).toEqual(['new-1', 'new-2'])
})


it('persists cursor before ACK and retries ACK after a crash', async () => {
  const { db, api } = harness({ failAckOnce: true })
  await expect(runPull(db, api)).rejects.toThrow('ack unavailable')
  expect((await loadSyncV2Meta(db)).pendingAck).toBe('opaque-next')
  await runPull(db, api)
  expect(api.acks).toEqual(['opaque-next', 'opaque-next'])
  expect((await loadSyncV2Meta(db)).pendingAck).toBeNull()
})


it('settles a committed push by operation query after its response is lost', async () => {
  const { db, meta, api } = pushHarness({
    commitThenDropFirstResponse: true,
    operationQuerySequence: ['unknown', terminalOriginalBatchResult()],
  })
  await seedOutbox(db, twoPendingRows())
  await expect(pushAllPending(db, meta, 'space-a', api)).rejects.toThrow('response lost')
  const frozen = await db.syncPushBatches.get('active')
  expect(frozen).toMatchObject({
    operationIds: ['op-a', 'op-b'],
    batchId: await sha256Hex('op-a\nop-b'),
    idempotencyKey: await sha256Hex('op-a\nop-b'),
    requestMethod: 'POST',
    requestPath: '/api/v1/sync/v2/push',
  })
  expect(frozen!.requestSha256).toMatch(/^[0-9a-f]{64}$/)
  expect(frozen!.eventSha256).toHaveLength(2)

  await editEntityWhoseOperationIsInFlight(db, 'op-a')
  const successor = await currentOutboxRowForEntity(db, frozen!.events[0].entity_id)
  expect(successor.operationId).not.toBe('op-a')
  const reopened = await openPomodoroXIDB('space-a')
  await pushAllPending(reopened, meta, 'space-a', api)

  expect(api.operationQueries).toEqual([
    ['op-a', 'op-b'],
    ['op-a', 'op-b'],
  ])
  expect(api.rawRequestBodies).toHaveLength(1)
  expect(await reopened.syncPushBatches.get('active')).toBeUndefined()
  expect(await currentOutboxRowForEntity(reopened, successor.entityId)).toEqual(successor)
})


it('replays exact persisted bytes only when the restart query still says unknown', async () => {
  const { db, meta, api } = pushHarness({
    commitThenDropFirstResponse: false,
    dropFirstResponseBeforeCommit: true,
    operationQuerySequence: ['unknown', 'unknown'],
  })
  await seedOutbox(db, twoPendingRows())
  await expect(pushAllPending(db, meta, 'space-a', api)).rejects.toThrow('response lost')

  await pushAllPending(await openPomodoroXIDB('space-a'), meta, 'space-a', api)

  expect(api.rawRequestBodies[1]).toEqual(api.rawRequestBodies[0])
  expect(api.requestHeaders[1]).toEqual(api.requestHeaders[0])
})


it('reuses an attempted direct WorkItemNote operation as its retry batch authority', async () => {
  const { db, api } = pushHarness({ operationQuerySequence: ['unknown'] })
  await seedOutbox(db, [attemptedDirectWorkItemNote({ operationId: 'note-op-1' })])

  await persistPendingBatchWithoutSending(db, api)

  const frozen = await db.syncPushBatches.get('active')
  expect(api.operationQueries).toEqual([['note-op-1']])
  expect(frozen).toMatchObject({
    authorityKind: 'direct_note_retry',
    batchId: 'note-op-1',
    idempotencyKey: 'note-op-1',
    operationIds: ['note-op-1'],
  })
  expect((await db.outbox.toArray()).map((row) => row.operationId)).toEqual(['note-op-1'])
})


it('uses prepareHeldProvisionalBatch root and stable children after query-first', async () => {
  const { db, api, compoundRoot, childOperationIds } = await admittedCompoundPushHarness()

  await persistPendingBatchWithoutSending(db, api)

  const frozen = await db.syncPushBatches.get('active')
  expect(api.operationQueries).toEqual([childOperationIds])
  expect(frozen).toMatchObject({
    authorityKind: 'compound',
    batchId: compoundRoot,
    compoundOperationId: compoundRoot,
    operationIds: childOperationIds,
  })
  expect(frozen!.batchId).not.toBe(await sha256Hex(childOperationIds.join('\n')))
})


it.each(['pending', 'recovery_required'] as const)(
  'blocks %s operation authority without creating or sending a push receipt',
  async (state) => {
    const { db, meta, api } = pushHarness({ operationQuerySequence: [state] })
    await seedOutbox(db, twoPendingRows())

    const result = await pushAllPending(db, meta, 'space-a', api)

    expect(result.blockedByOperationState).toBe(state)
    expect(await db.syncPushBatches.get('active')).toBeUndefined()
    expect(api.rawRequestBodies).toHaveLength(0)
    expect((await db.outbox.toArray()).map((row) => row.operationId)).toEqual(['op-a', 'op-b'])
  },
)


it.each(['pending', 'recovery_required'] as const)(
  'blocks a mixed terminal/%s authority before settlement or push',
  async (state) => {
    const { db, meta, api } = pushHarness({
      operationQuerySequence: [[
        terminalQueryItem('op-a', completePushResult('batch-a', ['op-a'])),
        nonterminalQueryItem('op-b', state, 'batch-b'),
      ]],
    })
    await seedOutbox(db, twoPendingRows())
    const before = await db.outbox.toArray()

    const result = await pushAllPending(db, meta, 'space-a', api)

    expect(result.blockedByOperationState).toBe(state)
    expect(await db.outbox.toArray()).toEqual(before)
    expect(await db.syncPushBatches.get('active')).toBeUndefined()
    expect(api.rawRequestBodies).toHaveLength(0)
  },
)


it('fails closed on a mixed terminal/unknown authority instead of settling or pushing', async () => {
  const { db, meta, api } = pushHarness({
    operationQuerySequence: [[
      terminalQueryItem('op-a', completePushResult('batch-a', ['op-a'])),
      unknownQueryItem('op-b'),
    ]],
  })
  await seedOutbox(db, twoPendingRows())
  const before = await db.outbox.toArray()

  await expect(pushAllPending(db, meta, 'space-a', api)).rejects.toThrow(
    'operation query returned mixed terminal/nonterminal authority',
  )

  expect(await db.outbox.toArray()).toEqual(before)
  expect(await db.syncPushBatches.get('active')).toBeUndefined()
  expect(api.rawRequestBodies).toHaveLength(0)
})


it('fails closed on a corrupted pending push receipt instead of regenerating it', async () => {
  const { db, meta, api } = pushHarness()
  await seedOutbox(db, twoPendingRows())
  await persistPendingBatchWithoutSending(db)
  await db.syncPushBatches.update('active', { requestSha256: '0'.repeat(64) })

  await expect(pushAllPending(
    await openPomodoroXIDB('space-a'), meta, 'space-a', api,
  )).rejects.toThrow(
    'pending push receipt integrity',
  )

  expect(api.rawRequestBodies).toHaveLength(0)
  expect(await db.syncPushBatches.get('active')).toBeDefined()
})


it('stops the current push cycle when a whole batch makes zero progress', async () => {
  const { db, meta, api } = pushHarness({ result: allConflictAndErrorResult() })
  await seedOutbox(db, twoPendingRows())
  const result = await pushAllPending(db, meta, 'space-a', api)
  expect(result).toMatchObject({ requests: 1, applied: 0, stoppedForNoProgress: true })
  expect(api.requests).toHaveLength(1)
  expect((await db.outbox.toArray()).map((row) => row.operationId)).toEqual(['op-a', 'op-b'])
})


it('uses a v2 pull default within the server maximum', async () => {
  const { db, api } = harness()
  await runPull(db, api)
  expect(api.pullLimits).toEqual([500])
})


it('rejects a locally corrupted ready recovery set before live cutover', async () => {
  const { db, api } = await readyRecoveryHarness()
  await db.syncRecoveryChunks.update(['recovery-a', 1], { entityCount: 999 })
  const before = await snapshotLiveTables(db)
  await expect(runRecovery(db, api)).rejects.toThrow('staged recovery')
  expect(await snapshotLiveTables(db)).toEqual(before)
  expect(await db.syncRecoveryState.get('active')).toBeDefined()
})


it.each([
  ['operation-query', malformedOperationQueryResponse({ terminalResult: null })],
  ['push', malformedPushResponse({ appliedVersion: null })],
  ['pull', malformedPullResponse({ eventVersion: -1 })],
  ['recover', malformedRecoveryResponse({ has_more: true, next_page_token: null })],
  ['recover', malformedRecoveryResponse({
    has_more: false, next_page_token: 'continuation-token-1',
  })],
  ['ack', malformedAckResponse({ accepted: false })],
  ['status', malformedStatusResponse({ visible_event_count: '1' })],
])('rejects a malformed %s response at the runtime parser', async (operation, body) => {
  const { db, api } = malformedResponseHarness(operation, body)
  const before = await snapshotProtocolState(db)
  await expect(invokeSyncOperation(operation, db, api)).rejects.toThrow('response')
  expect(await snapshotProtocolState(db)).toEqual(before)
})


it.each(['op!a', 'op/a', 'op+a', 'op~a'])(
  'accepts the full public printable-ASCII operation ID grammar: %s',
  (operationId) => {
    expect(() => parseSyncV2PushResponse(
      completePushResult(operationId, [operationId]),
    )).not.toThrow()
  },
)


it.each(['op a', 'op\u007fa', '作业-a'])(
  'rejects an operation ID outside 0x21-0x7e: %s',
  (operationId) => {
    expect(() => parseSyncV2PushResponse(
      completePushResult(operationId, [operationId]),
    )).toThrow('operation/batch ID')
  },
)


it.each([
  [
    'different original terminal batch identities',
    ['op-a', 'op-b'],
    operationQueryResponse([
      terminalQueryItem('op-a', completePushResult('batch-a', ['op-a'])),
      terminalQueryItem('op-b', completePushResult('batch-b', ['op-b'])),
    ]),
  ],
  [
    'non-byte-equivalent complete results for one batch',
    ['op-a', 'op-b'],
    operationQueryResponse([
      terminalQueryItem('op-a', completePushResult('batch-a', ['op-a', 'op-b'])),
      terminalQueryItem('op-b', completePushResult('batch-a', ['op-a', 'op-b'], {
        versionOverride: { operationId: 'op-b', version: 2 },
      })),
    ]),
  ],
  [
    'one operation repeated across result outcome arrays',
    ['op-a'],
    operationQueryResponse([
      terminalQueryItem('op-a', pushResultWithDuplicateOutcome('batch-a', 'op-a')),
    ]),
  ],
  [
    'a terminal item whose declared authority is absent from its result',
    ['op-a'],
    operationQueryResponse([
      terminalQueryItem('op-a', completePushResult('batch-a', ['other-op'])),
    ]),
  ],
])('rejects operation query parser input with %s', (_name, expectedIds, body) => {
  expect(() => parseSyncV2OperationQueryResponse(body, expectedIds)).toThrow()
})


it('rejects a pull page that claims more without cursor progress', async () => {
  const { db, api } = pullHarness({
    events: [], next_cursor: 'opaque-current', has_more: true,
  })
  await seedSyncV2Meta(db, { cursor: 'opaque-current', pendingAck: null })

  await expect(runPull(db, api)).rejects.toThrow('pull cursor did not advance')

  expect((await loadSyncV2Meta(db)).cursor).toBe('opaque-current')
  expect(api.acks).toEqual([])
})


it('rejects a recovery page whose continuation token repeats', async () => {
  const { db, api } = recoveryHarnessWithPersistedToken('page-a', {
    has_more: true, next_page_token: 'page-a',
  })

  await expect(runRecovery(db, api)).rejects.toThrow(
    'recovery token did not advance',
  )

  expect(await db.syncRecoveryChunks.count()).toBe(0)
  expect((await db.syncRecoveryState.get('active'))!.nextPageToken).toBe('page-a')
})


it.each(['new_receipt', 'active_receipt'] as const)(
  'holds the cross-Tab authority fence through query and push for %s', async (path) => {
    const { tabA, tabB, metaA, api, queryStarted, releaseQuery } =
      await twoTabPushHarness({ path, queryResult: 'unknown' })
    const push = pushAllPending(tabA, metaA, 'space-a', api)
    await queryStarted
    let writerFinished = false
    const writer = withSpaceAuthorityFence('space-a', async (token) => {
      const row = anotherValidWorkItem()
      await enqueueOutbox(
        tabB, 'space-a', token, 'workItem', row.id, 'update', row,
        anotherValidOutboxIdentity(),
      )
      writerFinished = true
    })
    await flushTasks()
    expect(writerFinished).toBe(false)
    expect(api.pushes).toHaveLength(0)
    releaseQuery()
    await push
    await writer
    expect(writerFinished).toBe(true)
    expect(api.pushes).toHaveLength(1)
  },
)


it.each(['new_receipt', 'active_receipt'] as const)(
  'makes zero push when direct IndexedDB corruption bypasses the fence for %s', async (path) => {
    const { tabA, tabB, metaA, api, queryStarted, releaseQuery, selectedKey } =
      await twoTabPushHarness({ path, queryResult: 'unknown' })
    const push = pushAllPending(tabA, metaA, 'space-a', api)
    await queryStarted
    await tabB.outbox.update(selectedKey, { action: 'delete' }) // intentional bypass
    releaseQuery()
    await expect(push).rejects.toThrow('outbox_identity_drift:action')
    expect(api.pushes).toHaveLength(0)
  },
)


it.each(['operation_query', 'push_response'] as const)(
  'recovers exact terminal evidence after the Space commit for %s', async (source) => {
    const { db, meta, api, rootId } = terminalEvidenceHarness({
      source, crashAfterSpaceTerminalCommit: true,
    })
    await expect(pushAllPending(db, meta, 'space-a', api)).rejects.toThrow('injected crash')
    const evidence = (await db.syncTerminalApplications.toArray())[0]!
    expect(evidence).toMatchObject({ source, state: 'space_committed' })
    expect(await currentAppliedRows(db, evidence.operationIds)).toEqual([])
    expect(await db.syncPushBatches.get('active')).toBeUndefined()
    expect(await meta.provisionalOperations.get(rootId)).toMatchObject({
      state: 'transport_ready', transportReadyRootSha256: evidence.readyRoots[0]!.rootSha256,
    })

    await pushAllPending(
      await openPomodoroXIDB('space-a'), new MetaDB(meta.name), 'space-a', api,
    )

    expect(await db.syncTerminalApplications.get(evidence.evidenceId)).toMatchObject({
      state: 'meta_reconciled',
    })
    expect(await meta.provisionalOperations.get(rootId)).toMatchObject({
      state: 'transport_resolved', terminalEvidenceId: evidence.evidenceId,
      terminalResultSha256: evidence.resultSha256,
    })
    expect(api.pushes).toHaveLength(source === 'push_response' ? 1 : 0)
  },
)


it.each(FROZEN_OUTBOX_IDENTITY_KEYS)(
  'fails closed when frozen authority field %s drifts', async (field) => {
    const { db, meta, api, queryStarted, releaseQuery, selectedKey } =
      await deferredQueryHarness('unknown')
    const push = pushAllPending(db, meta, 'space-a', api)
    await queryStarted
    await mutateFrozenFieldBypassingFence(db, selectedKey, field)
    releaseQuery()
    await expect(push).rejects.toThrow('integrity')
    expect(api.pushes).toHaveLength(0)
  },
)


it('bounds recoverable new-root restart to one query retry', async () => {
  const { db, meta, api } = repeatedPairedRootDriftHarness()
  await expect(pushAllPending(db, meta, 'space-a', api)).rejects.toThrow(
    'push_authority_restart_exhausted',
  )
  expect(api.operationQueries.length).toBeLessThanOrEqual(2)
  expect(api.pushes).toHaveLength(0)
})
```

Add both v18-to-v19 and clean-install-to-v19 upgrade tests in `frontend/src/services/database.test.ts`. They prove TS3 business/conflict rows and every S3 outbox authority field survive unchanged before explicit admission, while v19 adds per-root marker identities, pending receipts, and terminal evidence without rewriting v18. `admission.test.ts` covers standalone/compound admission, unchanged `prepareHeldProvisionalBatch`, malformed groups, canonical payload/hash/timestamp validation, `blocked_conflict`, `pending -> meta_pending -> ready` recovery, Meta `awaiting_s4 -> transport_ready`, and exact per-root tuple/root-set digests. `entity-payload-hash.test.ts` executes every final Sync key/action, including both WorkItemNote writers with the identical six-field post-image and `{document}` business hash, a FocusSession whose `clockState` negative fails before hashing, progress/mood null-and-value vectors, and an Outcome whose three persona fields are independently mutated. It also covers one LWW schedule entity; duplicate JSON names, malformed/partial post-images, missing builders, and `SHA256(canonical(postImage))` substitution fail closed. A reopened marker accepts live roots only on byte/field-exact equality or disappeared roots only through exact terminal evidence; reparent/order/payload/hash drift and unexplained Meta roots fail closed. `space-authority-fence.test.ts` uses two independent Dexie/Meta handles plus a shared fake `LockManager` to prove a Tab-B writer remains blocked while Tab A awaits operation query and push response, then proceeds only after lock release; it also proves crash release, missing Web Locks fail-closed, forged/expired token rejection, and a static production-writer inventory. Both new-receipt and active-receipt paths repeat the pending-query test. Direct IndexedDB bypass mutations of each frozen field, Meta orphan/root binding, marker digest, and receipt bytes are injected while query is pending and must produce zero push. `authority-identity.test.ts` mutates every `FROZEN_OUTBOX_IDENTITY_KEYS` member, including immutable retry predecessor identity, plus canonical payload byte/hash, root membership/order, root digest, and root-set digest independently. `terminal-application.test.ts` injects a crash after Space commit and after Meta commit for both operation-query terminal and push-response terminal sources; exact evidence resumes, Meta resolves idempotently, ready proof does not misclassify it as an orphan, and no duplicate push occurs. Mixed applied/conflict/error results move retained rows to exact non-sendable terminal states; restart never re-queries the terminal original, and a retryable error creates exactly one explicitly linked new-operation standalone successor after its durable schedule. Sequential retry replay, commit/response loss, reopened storage, and two Dexie handles all return that same successor ID; missing, drifted, duplicate, or forked lineage fails closed, while a later terminal successor can extend only a linear chain. A repeated complete-paired-root injection proves one bounded restart and `push_authority_restart_exhausted` with at most two queries/zero push. Add tests that TypeScript rejects `cursor: number`; the client decodes base64, hashes the exact Python-produced bytes before JSONL parsing; a byte/hash or `entity_count` mismatch leaves old state intact; and the engine never calls push before admission, recovery, ACK, and pending terminal-evidence reconciliation are complete. `transport.test.ts` invokes operation-query, push with a validated persisted receipt, and pull/recover/ack/status with caller config, then asserts every final Axios config contains exactly `Accept: application/vnd.pomodoroxii.error+json;version=2`; each call rejects missing/extra/wrong-type response keys through its Zod parser before any Dexie mutation. The six parsers share safe-integer and strict UTC validators, reject `2**53`, cap arrays/entity counts at 500, reject a canonical pull/recovery page over decoded 8 MiB, reject both inconsistent `has_more/next_page_token` directions, and reject recovery base64 strings over `11_184_812` characters or with noncanonical padding. Operation/batch ID vectors accept `!`, `/`, `+`, and `~` but reject space, DEL, non-ASCII, empty, and 129 bytes; the suffix-only narrow grammar is tested separately. Operation-query parsing additionally enforces input order, the four states, state-dependent nullability, and, before classification/application, globally unique operation IDs inside every nested complete `PushResult`, exact one-of applied/conflicts/errors coverage for each terminal item's declared operation authority, one original batch identity, and RFC-8785 byte-equivalent complete results across all terminal items. Parser negatives independently mutate each invariant. Pull/recovery/merge tests pass the required live fence token into every outbox/conflict/rebase writer and prove tokenless calls fail before mutation. Resume tests expire/corrupt recovery state without allowing any unfenced authority write.

For terminal coverage specifically, Applied, Conflict, and Error each have two
independent negatives that retain the correct operation ID while drifting
`entity_type` or `entity_id`; all six must fail before evidence persistence,
diagnostic mutation, applied-row deletion, or receipt deletion.

`recovery.test.ts` executes all 22 final Sync wire projectors, requires strict retained-LWW/new-domain contract parsing and exact Space binding/stripping, covers WorkItemLabel's composite Dexie key separately from its wire Sync ID, and verifies recovered WorkItemNote local metadata. For all five FocusSession entities it supplies complete system fields, proves top-level `entity_id/version/updated_at` equality, preserves each child entity's real `id`, maps only the FocusSession wire `id` to local `sessionId`, uses context `sessionId` only as its Dexie key, and derives `clockState` from durable time facts. Missing/extra system fields, `clockState` on wire, child `id == sessionId` substitution, persona/progress/mood drift, and every identity/version/timestamp/projector mismatch fail before the first live write. Schedule and TimeBlock each pass both `HH:mm` and canonical UTC fixtures and reject malformed clock/offset forms. Dirty Note/non-Note rows and outbox-protected keys survive both replacement and absence deletion. The suite also proves a `blocked_conflict + requiresVersionRebase` row remains blocked with the same operation ID, while only a valid unattempted `ready|awaiting_s4` row receives a successor ID and authoritative base.

`database.test.ts`, `meta-database.test.ts`, `outbox.test.ts`, and
`provisional-operation-authority.test.ts` add
`test_v18_outbox_s4_fields_backfilled_atomically`,
`test_v19_new_outbox_rows_have_all_s4_fields`,
`test_meta_v2_provisional_s4_bindings_backfilled_at_v3`,
`test_new_provisional_rows_have_exact_s4_null_bindings`, and
`test_invalid_or_partial_s4_backfill_aborts_versionchange`. They assert own
properties, exact null/false values, unchanged old authority bytes, and an
all-old state after any injected invalid row. `space-authority-fence.test.ts`
adds `test_all_outbox_and_provisional_call_sites_require_live_tokens` and
`test_two_space_conflict_resolution_uses_sorted_fences`; its AST inventory
walks production imports/calls instead of trusting a manually maintained count.

- [ ] **Step 2: Run frontend tests and verify the red state**

Run:

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
cd frontend
npm run test -- --run src/services/database.test.ts src/services/meta-database.test.ts src/lib/sync/admission.test.ts src/lib/sync/transport.test.ts src/lib/sync/recovery.test.ts src/lib/sync/pull-loop.test.ts src/lib/sync/push-batch.test.ts src/lib/sync/merge.test.ts src/lib/sync/sync-meta.test.ts src/lib/sync/engine.test.ts
```

Expected: FAIL because Dexie v19 admission/recovery/evidence stores and five-field outbox backfill, Meta v3 four-field backfill, structured root identities, the Web Locks authority fence, token-bound real `enqueueOutbox`/Meta writer inventory, Meta terminal bindings, operation-query transport/parser, opaque metadata, and `runFullRecovery()` do not exist.

- [ ] **Step 3: Add focused Dexie v19 staging stores**

```typescript
import type { SyncEntityType } from '@/lib/sync/types'

export interface FrozenOutboxIdentity {
  durableKey: number
  spaceId: string
  entityType: SyncEntityType
  entityId: string
  action: ApiSyncV2Event['action']
  payloadCanonicalBase64: string
  payloadHash: string
  operationId: string
  retryPredecessorOperationId: string | null
  expectedVersion: number | null
  createdAt: string
  transportState: OutboxEvent['transportState']
  compoundOperationId: string | null
  compoundOrder: number | null
  attemptCount: number
}

export interface ReadyRootIdentity {
  rootKind: 'compound' | 'standalone'
  rootId: string
  orderedChildren: FrozenOutboxIdentity[]
  rootSha256: string
}

export interface SyncAdmissionState {
  key: 'active'
  state: 'pending' | 'meta_pending' | 'ready' | 'failed'
  readyRoots: ReadyRootIdentity[]
  readyRootSetSha256: string | null
  errorCode: string | null
}

export interface SyncRecoveryState {
  key: 'active'
  spaceId: string
  recoveryId: string
  clientId: string
  nextPageToken: string | null
  catalogHash: string
  waterlineCursor: string
  nextChunkIndex: number
  state: 'downloading' | 'ready'
}

export interface SyncRecoveryChunk {
    spaceId: string
    recoveryId: string
    index: number
    sha256: string
    entityCount: number
    payloadJsonlBase64: string
    pageTokenUsed: string | null
    nextPageToken: string | null
    hasMore: boolean
    catalogHash: string
    waterlineCursor: string
}

export interface SyncPendingPushBatch {
  key: 'active'
  spaceId: string
  clientId: string
  authorityKind: 'compound' | 'direct_note_retry' | 'standalone_batch'
  compoundOperationId: string | null
  batchId: string
  operationIds: string[]
  frozenRows: FrozenOutboxIdentity[]
  readyRoots: ReadyRootIdentity[]
  readyRootSetSha256: string
  events: ApiSyncV2Event[]
  idempotencyKey: string
  requestMethod: 'POST'
  requestPath: '/api/v1/sync/v2/push'
  headers: {
    accept: 'application/vnd.pomodoroxii.error+json;version=2'
    contentType: 'application/json'
    idempotencyKey: string
  }
  eventCanonicalBase64: string[]
  eventSha256: string[]
  requestCanonicalBase64: string
  requestSha256: string
  receiptCreatedAt: string
}

export interface SyncTerminalApplicationEvidence {
  evidenceId: string
  spaceId: string
  source: 'operation_query' | 'push_response'
  state: 'space_committed' | 'meta_reconciled'
  authorityKind: SyncPendingPushBatch['authorityKind']
  batchId: string
  compoundOperationId: string | null
  operationIds: string[]
  operationIdsSha256: string
  readyRoots: ReadyRootIdentity[]
  readyRootSetSha256: string
  resultCanonicalBase64: string
  resultSha256: string
  appliedCount: number
  committedAt: string
  metaReconciledAt: string | null
}

export interface PushCycleSummary {
  requests: number
  attempted: number
  applied: number
  stoppedForNoProgress: boolean
  blockedByOperationState: 'pending' | 'recovery_required' | null
}

export type S4OutboxTransportState =
  | 'ready' | 'awaiting_s4' | 'blocked_conflict'
  | 'terminal_conflict' | 'terminal_error'

export interface S4OutboxTerminalFields {
  serverOutcomeCanonicalBase64: string | null
  retryable: boolean
  nextAttemptAt: string | null
  retryPredecessorOperationId: string | null
  retrySuccessorOperationId: string | null
}

export const INITIAL_S4_OUTBOX_FIELDS = Object.freeze({
  serverOutcomeCanonicalBase64: null,
  retryable: false,
  nextAttemptAt: null,
  retryPredecessorOperationId: null,
  retrySuccessorOperationId: null,
} satisfies S4OutboxTerminalFields)

const S4_OUTBOX_FIELD_NAMES = [
  'serverOutcomeCanonicalBase64', 'retryable', 'nextAttemptAt',
  'retryPredecessorOperationId', 'retrySuccessorOperationId',
] as const satisfies readonly (keyof S4OutboxTerminalFields)[]

type V18OutboxUpgradeRow = Omit<OutboxEvent, keyof S4OutboxTerminalFields>

function requireStrictV18OutboxUpgradeRow(
  row: V18OutboxUpgradeRow,
  owningSpaceId: string,
): void {
  const compoundValid = (row.compoundOperationId === null && row.compoundOrder === null) ||
    (typeof row.compoundOperationId === 'string' && row.compoundOperationId.length > 0 &&
      Number.isSafeInteger(row.compoundOrder) && row.compoundOrder! >= 0)
  const expectedVersionValid = row.expectedVersion === null ||
    (Number.isSafeInteger(row.expectedVersion) && row.expectedVersion! >= 0)
  if (!Number.isSafeInteger(row.id) || row.id! < 1 ||
      owningSpaceId.length === 0 || row.spaceId !== owningSpaceId ||
      !FINAL_SYNC_ENTITY_TYPE_SET.has(row.entityType) ||
      !['create', 'update', 'delete'].includes(row.action) ||
      typeof row.payload !== 'string' || !/^[0-9a-f]{64}$/.test(row.payloadHash) ||
      !/^[\x21-\x7e]{1,128}$/.test(row.operationId) ||
      !expectedVersionValid ||
      (row.action === 'create' && row.expectedVersion !== null) ||
      (row.action !== 'create' && row.expectedVersion === null &&
        row.requiresVersionRebase !== true) ||
      typeof row.requiresVersionRebase !== 'boolean' ||
      !['ready', 'awaiting_s4', 'blocked_conflict'].includes(row.transportState) ||
      !compoundValid || !Number.isSafeInteger(row.attemptCount) || row.attemptCount < 0 ||
      typeof row.synced !== 'boolean') {
    throw new Error('invalid_v18_outbox_authority_for_v19')
  }
  requireCanonicalStoredTimestamp(row.createdAt)
  if (S4_OUTBOX_FIELD_NAMES.some((field) =>
      Object.prototype.hasOwnProperty.call(row, field))) {
    throw new Error('v19_outbox_fields_preexist_or_partial')
  }
}

export class PomodoroXIDB extends Dexie {
  syncAdmissionState!: Table<SyncAdmissionState, 'active'>
  syncRecoveryState!: Table<SyncRecoveryState>
  syncRecoveryChunks!: Table<SyncRecoveryChunk, [string, number]>
  syncPushBatches!: Table<SyncPendingPushBatch, 'active'>
  syncTerminalApplications!: Table<SyncTerminalApplicationEvidence, string>

  constructor(
    readonly spaceId: string,
    dbName = dexieDbNameForSpace(spaceId),
  ) {
    super(dbName)
    if (spaceId.length === 0 || dbName !== dexieDbNameForSpace(spaceId)) {
      throw new Error('space_database_identity_mismatch')
    }
    // Keep versions 1 through 18 byte-for-byte except for imports/types.
    // Version 18 remains the TS3 final-business cutover and is never rewritten here.
    this.version(19).stores({
      ...toDexieStoreStrings(V18_STORE_DEFINITIONS),
      syncAdmissionState: 'key, state',
      syncRecoveryState: 'key, spaceId, state',
      syncRecoveryChunks: '[recoveryId+index], spaceId, recoveryId, index',
      syncPushBatches: 'key, batchId, clientId, receiptCreatedAt',
      syncTerminalApplications: 'evidenceId, spaceId, state, compoundOperationId, resultSha256',
    }).upgrade(async (tx) => {
      await tx.table<V18OutboxUpgradeRow>('outbox').toCollection().modify((row) => {
        requireStrictV18OutboxUpgradeRow(row, spaceId)
        Object.assign(row, INITIAL_S4_OUTBOX_FIELDS)
      })
      await tx.table<SyncAdmissionState>('syncAdmissionState').put({
        key: 'active', state: 'pending', readyRoots: [],
        readyRootSetSha256: null, errorCode: null,
      })
    })
  }
}
```

Dexie v19 spreads TS3's existing structured `V18_STORE_DEFINITIONS` through its existing `toDexieStoreStrings()` before adding S4 stores; omitting that spread would delete final business tables and fails both clean-install and v18-upgrade tests. TS3 already made `OutboxEvent.spaceId` nonoptional and bound `PomodoroXIDB` to the exact `dexieDbNameForSpace(spaceId)` name. S4 widens `transportState` to the explicit `S4OutboxTransportState` and adds every nonoptional `S4OutboxTerminalFields` member with `null/false/null/null/null` defaults for nonterminal rows; no schema alias or optional fallback is retained. The versionchange transaction first validates every v18 outbox authority row without normalizing any S3/TS3 field, rejects a row whose existing `spaceId` differs from the verified DB owner, rejects pre-existing/partial S4 fields, and then atomically assigns only the five S4 defaults before installing v19 protocol state. It never writes, guesses, or backfills Space from payload/current UI state. Any invalid row or DB/name mismatch aborts the whole upgrade. Clean-v19 constructors preserve the TS3 Space binding and write `INITIAL_S4_OUTBOX_FIELDS`; reads may not use `?? null`, optional properties, or `undefined` compatibility. `spaceId` and `retryPredecessorOperationId` are immutable row identity and are frozen into admission/receipt authority; `retrySuccessorOperationId` is a nullable terminal-intent consumption link and can move only once from null to the newly created successor ID in the same transaction that inserts that successor. This is a transport-metadata upgrade over final TS3 rows, not a legacy Task/Session data migration. Do not stage recovered entities in live entity stores. Downloaded chunks are inert until one terminal Dexie transaction revalidates every chunk and applies every record, reconciles stale clean rows, writes cursor/pending ACK, and deletes both recovery staging stores. `syncPushBatches` is not recovery staging: its single `active` row is the durable network request receipt and survives response loss/restart until the exact response has been applied transactionally. The decoded `requestCanonicalBase64` bytes, not `events` or an Axios object, are the sole replay body authority; `events` remain only a typed response-correlation snapshot and must byte-match `eventCanonicalBase64` during receipt validation. `authorityKind` and `compoundOperationId` are immutable receipt fields: a compound requires `batchId == compoundOperationId`, a direct attempted Note retry requires `batchId == operationIds[0]`, and only an unattempted unrelated standalone batch may use the ordered-operation SHA-256.

The v19 upgrade never interprets a pre-v2 cursor as a v2 token. When v2 catalog hash/cursor state is absent, it atomically sets `requiresFullRecovery=true`, clears sendable cursor/pending ACK, and leaves TS3 business/conflict rows untouched. Startup runs the same classifier for a new database that skipped the upgrade callback. `runSyncCycle()` sees this flag and enters `runFullRecovery()` before any v2 pull/push. Tests cover a TS3 v18 database, a clean install, crash during upgrade, and prove no numeric or timestamp cursor can be sent to `/sync/v2/pull`.

```typescript
// frontend/src/services/dexie-v18-cutover.ts
export const DEXIE_V19_NATIVE_VERSION = 190

export async function readExistingNativeIndexedDbVersionWithoutUpgrade(
  dbName: string,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const request = indexedDB.open(dbName)
    let missing = false
    request.onupgradeneeded = () => {
      missing = true
      request.transaction!.abort()
    }
    request.onblocked = () => reject(new Error('indexeddb_version_read_blocked'))
    request.onerror = () => reject(missing
      ? new Error('space_database_missing')
      : request.error ?? new Error('indexeddb_version_read_failed'))
    request.onsuccess = () => {
      const database = request.result
      const version = database.version
      database.close()
      resolve(version)
    }
  })
}

async function requireAlreadyCompletedV19AfterVersionError(dbName: string): Promise<void> {
  const version = await readExistingNativeIndexedDbVersionWithoutUpgrade(dbName)
  if (version !== DEXIE_V19_NATIVE_VERSION) {
    throw new Error(`unsupported_client_schema:${version}`)
  }
}

export async function openPomodoroXIDB(spaceId: string): Promise<PomodoroXIDB> {
  const dbName = dexieDbNameForSpace(spaceId)
  try {
    await atomicDexieV18Cutover(dbName)
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== 'VersionError') throw error
    await requireAlreadyCompletedV19AfterVersionError(dbName)
  }
  const database = new PomodoroXIDB(spaceId, dbName)
  await database.open()
  if (database.verno !== 19 || database.spaceId !== spaceId) {
    database.close()
    throw new Error('space_database_open_identity_mismatch')
  }
  return database
}
```

`atomicDexieV18Cutover` remains the only v17 authorization scan and still runs
inside its original native versionchange transaction. The unified factory no
longer treats an already-native-190 database as an error: only the monotonic
`VersionError` branch may perform a no-upgrade version read, and it accepts
exactly 190; 181..189 and future versions fail closed. It never probes v17,
closes, and then authorizes a separate upgrade. `space-db.ts` and every app/test
caller continue to use `openPomodoroXIDB(spaceId)` and never call
`new PomodoroXIDB(...)` outside database/factory tests. Tests cover new, 170,
180, 190, invalid intermediate, and future versions plus two concurrent 180/190
openers without a stale authorization window.

Meta uses its own next schema version rather than pretending TS3 v2 rows already
have S4 bindings:

```typescript
// additions to frontend/src/services/meta-database.ts
export interface S4ProvisionalOperationFields {
  transportReadyRootSha256: string | null
  terminalEvidenceId: string | null
  terminalResultSha256: string | null
  terminalOperationIdsSha256: string | null
}

export type S4ProvisionalOperationState =
  | 'pending' | 'activating' | 'conflict' | 'awaiting_s4'
  | 'activation_resolved' | 'transport_ready' | 'transport_resolved'

export const S4_PROVISIONAL_OPERATION_STATES = [
  'pending', 'activating', 'conflict', 'awaiting_s4',
  'activation_resolved', 'transport_ready', 'transport_resolved',
] as const satisfies readonly S4ProvisionalOperationState[]

export const INITIAL_S4_PROVISIONAL_FIELDS = Object.freeze({
  transportReadyRootSha256: null,
  terminalEvidenceId: null,
  terminalResultSha256: null,
  terminalOperationIdsSha256: null,
} satisfies S4ProvisionalOperationFields)

const S4_PROVISIONAL_FIELD_NAMES = [
  'transportReadyRootSha256', 'terminalEvidenceId',
  'terminalResultSha256', 'terminalOperationIdsSha256',
] as const satisfies readonly (keyof S4ProvisionalOperationFields)[]

type MetaV2ProvisionalOperationRow = Omit<
  ProvisionalOperationRow, keyof S4ProvisionalOperationFields
>

function requireStrictMetaV2ProvisionalRow(row: MetaV2ProvisionalOperationRow): void {
  if (!/^[\x21-\x7e]{1,128}$/.test(row.operationId) ||
      typeof row.spaceId !== 'string' || row.spaceId.length === 0 ||
      typeof row.sessionId !== 'string' || row.sessionId.length === 0 ||
      typeof row.intentJson !== 'string' || !/^[0-9a-f]{64}$/.test(row.payloadHash) ||
      !['pending', 'activating', 'conflict', 'awaiting_s4', 'resolved']
        .includes(row.state)) {
    throw new Error('invalid_meta_v2_provisional_authority_for_v3')
  }
  requireCanonicalStoredTimestamp(row.createdAt)
  requireCanonicalStoredTimestamp(row.updatedAt)
  if (S4_PROVISIONAL_FIELD_NAMES.some((field) =>
      Object.prototype.hasOwnProperty.call(row, field))) {
    throw new Error('meta_v3_provisional_fields_preexist_or_partial')
  }
}

// Keep TS3 version(1) and version(2) declarations unchanged above this block.
this.version(3).stores({
  provisionalOperations: 'operationId, deviceId, spaceId, sessionId, state, createdAt',
}).upgrade(async (tx) => {
  await tx.table<MetaV2ProvisionalOperationRow>('provisionalOperations')
    .toCollection().modify((row) => {
      requireStrictMetaV2ProvisionalRow(row)
      Object.assign(row, {
        state: row.state === 'resolved' ? 'activation_resolved' : row.state,
        ...INITIAL_S4_PROVISIONAL_FIELDS,
      })
    })
})
```

`ProvisionalOperationRow` extends `S4ProvisionalOperationFields`, widens its
state to `S4ProvisionalOperationState`, and
`buildProvisionalOperationRow()` explicitly spreads
`INITIAL_S4_PROVISIONAL_FIELDS`. Meta v3 backfills the same four nulls inside one
native versionchange transaction after strict validation; partial/pre-existing
fields or malformed v2 authority abort the upgrade. A TS3 v2 `resolved` row is
deterministically renamed to `activation_resolved` with four null bindings; no
transport evidence is invented. All migrated active-session paths continue to
write `activation_resolved`, while only S4 terminal evidence may write
`transport_resolved`. This is protocol-state clarification within the accepted
clean-slate cutover, not legacy Task/Session compatibility. `MetaDB.claimProvisional`
is removed as a public tokenless writer. The new
`provisional-operation-authority.ts` owns token-bound
`claimProvisionalOperation`, `transitionProvisionalOperation`,
`persistProvisionalResolutionIntent`, `markTransportReady`,
`resolveTransportTerminal`, and `deleteProvisionalOperation`; each
accepts `(meta, spaceId, token, ...)`, calls
`requireSpaceAuthorityToken(token, spaceId)` before its first read, verifies the
durable row's `spaceId`, and performs its compare-and-write in one Meta
transaction. No production module calls `meta.provisionalOperations.add|put|update|delete`
outside that authority module after this migration. Generic
`transitionProvisionalOperation` rejects patches to
`transport_ready|transport_resolved`; only the two dedicated helpers own those
state bindings. No read path substitutes `undefined` with `?? null`.

```typescript
// production deltas in meta-database.ts and provisional-operation-authority.ts
// ProvisionalOperationRow extends S4ProvisionalOperationFields and replaces
// its state field with S4ProvisionalOperationState.
function assertCompleteS4ProvisionalFields(row: ProvisionalOperationRow): void {
  if (!S4_PROVISIONAL_OPERATION_STATES.includes(row.state)) {
    throw new Error('invalid_s4_provisional_state')
  }
  if (S4_PROVISIONAL_FIELD_NAMES.some((field) =>
      !Object.prototype.hasOwnProperty.call(row, field))) {
    throw new Error('incomplete_s4_provisional_fields')
  }
  const rootValid = row.transportReadyRootSha256 === null ||
    /^[0-9a-f]{64}$/.test(row.transportReadyRootSha256)
  const terminal = [
    row.terminalEvidenceId, row.terminalResultSha256,
    row.terminalOperationIdsSha256,
  ]
  const terminalNull = terminal.every((value) => value === null)
  const terminalBound = terminal.every((value) =>
    typeof value === 'string' && /^[0-9a-f]{64}$/.test(value))
  const valid = row.state === 'transport_ready'
    ? row.transportReadyRootSha256 !== null && terminalNull
    : row.state === 'transport_resolved'
      ? row.transportReadyRootSha256 !== null && terminalBound
      : row.transportReadyRootSha256 === null && terminalNull
  if (!rootValid || !valid) throw new Error('invalid_s4_provisional_state_bindings')
}

export async function buildProvisionalOperationRow(
  input: CanonicalProvisionalStartIntent,
  cachedOwnershipEpoch: number | null,
): Promise<ProvisionalOperationRow> {
  const intent = {
    spaceId: input.spaceId,
    sessionId: input.sessionId,
    deviceId: input.deviceId,
    tabId: input.tabId,
    level2WorkItemId: input.level2WorkItemId,
    level3WorkItemIds: input.level3WorkItemIds,
    plannedSeconds: input.plannedSeconds,
    startedAt: input.startedAt,
    expectedWorkItemVersions: input.expectedWorkItemVersions,
  }
  return {
    operationId: input.operationId,
    spaceId: input.spaceId,
    sessionId: input.sessionId,
    deviceId: input.deviceId,
    tabId: input.tabId,
    cachedOwnershipEpoch,
    intentJson: canonicalize(intent)!,
    payloadHash: await hashCommandPayload(intent as JsonValue),
    state: 'pending',
    createdAt: input.startedAt,
    updatedAt: input.startedAt,
    ...INITIAL_S4_PROVISIONAL_FIELDS,
  }
}

export async function claimProvisionalOperation(
  meta: MetaDB,
  spaceId: string,
  token: SpaceAuthorityToken,
  row: ProvisionalOperationRow,
): Promise<ProvisionalClaimResult> {
  requireSpaceAuthorityToken(token, spaceId)
  if (row.spaceId !== spaceId) throw new Error('provisional_operation_space_mismatch')
  assertCompleteS4ProvisionalFields(row)
  return meta.transaction('rw', meta.provisionalOperations, async () => {
    const existing = await meta.provisionalOperations.get(row.operationId)
    if (existing) {
      if (existing.spaceId !== spaceId || existing.intentJson !== row.intentJson ||
          existing.payloadHash !== row.payloadHash ||
          existing.sessionId !== row.sessionId || existing.deviceId !== row.deviceId ||
          existing.tabId !== row.tabId ||
          existing.cachedOwnershipEpoch !== row.cachedOwnershipEpoch ||
          existing.createdAt !== row.createdAt) {
        throw new Error('idempotency_conflict')
      }
      assertCompleteS4ProvisionalFields(existing)
      return { disposition: 'existing', row: existing } as const
    }
    const blockingStates = new Set<ProvisionalOperationRow['state']>([
      'pending', 'activating', 'conflict',
    ])
    const active = await meta.provisionalOperations.where('deviceId')
      .equals(row.deviceId).and((item) => blockingStates.has(item.state)).first()
    if (active) throw new Error('active_session_exists')
    await meta.provisionalOperations.add(row)
    return { disposition: 'created', row } as const
  })
}

export async function transitionProvisionalOperation(
  meta: MetaDB,
  spaceId: string,
  token: SpaceAuthorityToken,
  operationId: string,
  expectedStates: readonly ProvisionalOperationRow['state'][],
  patch: Readonly<Partial<ProvisionalOperationRow>>,
): Promise<ProvisionalOperationRow> {
  requireSpaceAuthorityToken(token, spaceId)
  if (expectedStates.length === 0 ||
      ['operationId', 'spaceId', 'sessionId', 'deviceId', 'tabId', 'intentJson',
        'payloadHash', 'createdAt'].some((field) =>
        Object.prototype.hasOwnProperty.call(patch, field)) ||
      patch.state === 'transport_ready' || patch.state === 'transport_resolved') {
    throw new Error('invalid_provisional_transition_patch')
  }
  return meta.transaction('rw', meta.provisionalOperations, async () => {
    const current = await meta.provisionalOperations.get(operationId)
    if (!current || current.spaceId !== spaceId ||
        !expectedStates.includes(current.state)) {
      throw new Error('provisional_operation_transition_conflict')
    }
    const next = { ...current, ...patch }
    assertCompleteS4ProvisionalFields(next)
    await meta.provisionalOperations.put(next)
    return next
  })
}

export async function markTransportReady(
  meta: MetaDB,
  spaceId: string,
  token: SpaceAuthorityToken,
  operationId: string,
  transportReadyRootSha256: string,
  updatedAt: string,
): Promise<ProvisionalOperationRow> {
  requireSpaceAuthorityToken(token, spaceId)
  if (!/^[0-9a-f]{64}$/.test(transportReadyRootSha256)) {
    throw new Error('invalid_transport_ready_root')
  }
  return meta.transaction('rw', meta.provisionalOperations, async () => {
    const current = await meta.provisionalOperations.get(operationId)
    if (!current || current.spaceId !== spaceId) {
      throw new Error('provisional_operation_transport_ready_conflict')
    }
    if (current.state === 'transport_ready') {
      if (current.transportReadyRootSha256 !== transportReadyRootSha256) {
        throw new Error('provisional_ready_root_identity_mismatch')
      }
      assertCompleteS4ProvisionalFields(current)
      return current
    }
    if (current.state !== 'awaiting_s4') {
      throw new Error('provisional_operation_not_awaiting_transport')
    }
    const next: ProvisionalOperationRow = {
      ...current, state: 'transport_ready', transportReadyRootSha256,
      terminalEvidenceId: null, terminalResultSha256: null,
      terminalOperationIdsSha256: null, updatedAt,
    }
    assertCompleteS4ProvisionalFields(next)
    await meta.provisionalOperations.put(next)
    return next
  })
}

export async function resolveTransportTerminal(
  meta: MetaDB,
  spaceId: string,
  token: SpaceAuthorityToken,
  input: Readonly<{
    operationId: string
    transportReadyRootSha256: string
    terminalEvidenceId: string
    terminalResultSha256: string
    terminalOperationIdsSha256: string
    updatedAt: string
  }>,
): Promise<ProvisionalOperationRow> {
  requireSpaceAuthorityToken(token, spaceId)
  for (const digest of [
    input.transportReadyRootSha256, input.terminalEvidenceId,
    input.terminalResultSha256, input.terminalOperationIdsSha256,
  ]) if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error('invalid_transport_terminal_hash')
  return meta.transaction('rw', meta.provisionalOperations, async () => {
    const current = await meta.provisionalOperations.get(input.operationId)
    if (!current || current.spaceId !== spaceId ||
        current.transportReadyRootSha256 !== input.transportReadyRootSha256) {
      throw new Error('terminal_meta_root_mismatch')
    }
    const next: ProvisionalOperationRow = {
      ...current, state: 'transport_resolved',
      terminalEvidenceId: input.terminalEvidenceId,
      terminalResultSha256: input.terminalResultSha256,
      terminalOperationIdsSha256: input.terminalOperationIdsSha256,
      updatedAt: input.updatedAt,
    }
    if (current.state === 'transport_resolved') {
      assertCompleteS4ProvisionalFields(current)
      if (canonicalize(current) !== canonicalize(next)) {
        throw new Error('terminal_meta_resolution_mismatch')
      }
      return current
    }
    if (current.state !== 'transport_ready') {
      throw new Error('terminal_meta_state_mismatch')
    }
    assertCompleteS4ProvisionalFields(next)
    await meta.provisionalOperations.put(next)
    return next
  })
}

export async function deleteProvisionalOperation(
  meta: MetaDB,
  spaceId: string,
  token: SpaceAuthorityToken,
  operationId: string,
  expectedStates: readonly ProvisionalOperationRow['state'][],
): Promise<void> {
  requireSpaceAuthorityToken(token, spaceId)
  await meta.transaction('rw', meta.provisionalOperations, async () => {
    const current = await meta.provisionalOperations.get(operationId)
    if (!current || current.spaceId !== spaceId ||
        !expectedStates.includes(current.state)) {
      throw new Error('provisional_operation_delete_conflict')
    }
    await meta.provisionalOperations.delete(operationId)
  })
}
```

`space-authority-fence.ts` is the sole token constructor and has this complete contract:

```typescript
import { dexieDbNameForSpace } from '@/lib/platform'
import type { PomodoroXIDB } from '@/services/database'

const TOKEN_BRAND: unique symbol = Symbol('SpaceAuthorityToken')
const liveTokens = new WeakSet<object>()

export interface SpaceAuthorityToken {
  readonly [TOKEN_BRAND]: true
  readonly spaceId: string
  readonly lockName: string
  readonly nonce: string
}

export class SpaceAuthorityFenceError extends Error {
  constructor(readonly code:
    'space_authority_lock_unavailable' |
    'space_authority_token_invalid' |
    'space_authority_token_expired' |
    'space_database_binding_mismatch') {
    super(code)
  }
}

export function requireSpaceAuthorityToken(
  token: SpaceAuthorityToken,
  spaceId: string,
): void {
  if (!token || token.spaceId !== spaceId || !liveTokens.has(token)) {
    throw new SpaceAuthorityFenceError('space_authority_token_invalid')
  }
}

export function requireSpaceDatabaseBinding(
  db: Pick<PomodoroXIDB, 'spaceId' | 'name'>,
  spaceId: string,
): void {
  if (db.spaceId !== spaceId || db.name !== dexieDbNameForSpace(spaceId)) {
    throw new SpaceAuthorityFenceError('space_database_binding_mismatch')
  }
}

export async function withSpaceAuthorityFence<T>(
  spaceId: string,
  work: (token: SpaceAuthorityToken) => Promise<T>,
): Promise<T> {
  const locks = globalThis.navigator?.locks
  if (!locks) throw new SpaceAuthorityFenceError('space_authority_lock_unavailable')
  const lockName = `pomodoroxii:space-authority:v1:${encodeURIComponent(spaceId)}`
  return locks.request(lockName, { mode: 'exclusive' }, async () => {
    const token = Object.freeze({
      [TOKEN_BRAND]: true as const,
      spaceId,
      lockName,
      nonce: crypto.randomUUID(),
    }) as SpaceAuthorityToken
    liveTokens.add(token)
    try {
      return await work(token)
    } finally {
      liveTokens.delete(token)
    }
  })
}

export async function withOrderedSpaceAuthorityFences<T>(
  spaceIds: readonly string[],
  work: (tokens: ReadonlyMap<string, SpaceAuthorityToken>) => Promise<T>,
): Promise<T> {
  const ordered = [...new Set(spaceIds)]
  if (ordered.length === 0 || ordered.some((spaceId) => spaceId.length === 0)) {
    throw new Error('space_authority_set_required')
  }
  ordered.sort((left, right) => left.localeCompare(right, 'en'))
  const tokens = new Map<string, SpaceAuthorityToken>()
  const acquire = (index: number): Promise<T> => index === ordered.length
    ? work(tokens)
    : withSpaceAuthorityFence(ordered[index]!, async (token) => {
        tokens.set(ordered[index]!, token)
        return acquire(index + 1)
      })
  return acquire(0)
}
```

The real TS3 outbox API is migrated in place; S4 does not invent an alias:

```typescript
// frontend/src/lib/sync/outbox.ts
export async function enqueueOutbox(
  db: PomodoroXIDB,
  spaceId: string,
  token: SpaceAuthorityToken,
  entityType: SyncEntityType,
  entityId: string,
  action: OutboxAction,
  payload: unknown,
  identity: OutboxIdentity,
): Promise<void> {
  requireSpaceAuthorityToken(token, spaceId)
  requireSpaceDatabaseBinding(db, spaceId)
  // Keep every TS3 validation and compound/default calculation unchanged.
  await mergeOrInsertOutbox(db, spaceId, token, entityType, entityId, action, payload, {
    ...identity,
    spaceId,
    compoundOperationId: identity.compoundOperationId ?? null,
    compoundOrder: identity.compoundOrder ?? null,
    ...INITIAL_S4_OUTBOX_FIELDS,
  })
}
```

The internal `mergeOrInsertOutbox` owner also requires
`(db, spaceId, token, ...)`, repeats `requireSpaceAuthorityToken` plus
`db.spaceId === spaceId` before its first query, scopes merge candidates by
`row.spaceId === spaceId`, and rejects any existing row with a different Space.
This prevents a future internal import from bypassing the public guard.

All production `enqueueOutbox(...)` call sites migrate to
`enqueueOutbox(db, spaceId, token, ...)`: two in
`work-item-note-repository.ts` and seven ordinary/provisional paths including the
initial compound loop in `focus-session-repository.ts`, plus the retained two
`quick-note-repository.ts` and four `trash-store.ts` callers (the implementation AST
inventory, not this prose count, is authoritative if TS3 changes before S4
lands). `saveLocal`, conflict overwrite, response acknowledgement/newer-note
successor, Session clock/note/plan edits, provisional start, and provisional
plan reindex all acquire at their public boundary and pass one live token into
their existing atomic business-row/outbox transaction. QuickNote conversion and
Note/Folder restore/purge do the same and retain their atomic entity/outbox
semantics. `merge.ts`'s attempted
in-flight successor constructor explicitly spreads
`INITIAL_S4_OUTBOX_FIELDS`; the terminal retry constructor does the same and
then overrides only `retryPredecessorOperationId`. No constructor writes an
optional/partial S4 field set.

`provisional-start-recovery.ts` and `active-session-coordinator.ts` replace every
direct Meta provisional write with `provisional-operation-authority.ts` and
pass the token for the durable row's `spaceId`. A one-Space operation uses
`withSpaceAuthorityFence`; activation-conflict persistence/resolution that
mutates both Space databases uses `withOrderedSpaceAuthorityFences` over the
two exact Space IDs and passes the matching token to each Space transaction.
Sorted acquisition is the only multi-Space order, so two Tabs cannot deadlock
by choosing opposite winner/loser order. The AST gate rejects every tokenless
`enqueueOutbox` overload/call, every fabricated enqueue alias, and every production
`provisionalOperations.add|put|update|delete` outside the
authority module.

Web Locks is the cross-Tab authority, not a performance hint: `request()` waits rather than using `ifAvailable`, the callback owns the token for its full async lifetime, and normal return/throw, Tab close, renderer crash, or browser process cleanup releases the lock. An expired/forged token cannot pass the module-private `WeakSet`. The official frontend declares Web Locks a required runtime capability for Sync writes; when it is absent, all affected writers and push fail before a transaction/network request. Do not add a localStorage/IndexedDB lease fallback in S4.

The writer inventory is closed. The real `enqueueOutbox`, the in-flight successor writer in `merge.ts`, `rebaseLegacyOutboxAgainstRecovery`, dirty-row/conflict writes in `applySyncEventRecord`, `resolveSyncConflict`, `admitTs3AwaitingS4`, every `syncAdmissionState`/`syncRecoveryState`/`syncRecoveryChunks`/`syncPushBatches`/`syncTerminalApplications` mutation, every `syncMeta` client/cursor/pending-ACK/catalog/recovery-flag mutation, Meta provisional create/admit/resolve helpers, and both terminal-result application paths accept a required `SpaceAuthorityToken` and call `requireSpaceAuthorityToken(token, spaceId)` before their first read/write transaction. Every writer that receives a `PomodoroXIDB` also calls `requireSpaceDatabaseBinding(db, spaceId)` before its first read, including public coordinators and exported internal test seams; a valid Space-B token can never authorize a Space-A handle. `runFullRecovery`, incremental pull, and `sendPendingAck` receive that same token; no public generic `saveSyncMeta`, `markPendingAck`, tokenless client-ID creator, tokenless `enqueueOutbox` overload, or direct production Meta provisional mutation remains. Space/Meta schema upgrade callbacks are the only tokenless store writers and are safe only under IndexedDB's version-change exclusivity. `space-authority-fence.test.ts` performs an AST/import inventory over production sources and fails on a direct `outbox`, provisional-operation, admission, recovery state/chunk, syncMeta, conflict/resolution, receipt, or terminal-evidence `add|put|update|delete|bulkPut` outside the enumerated token-bound modules. Its wrong-handle matrix passes `dbA + spaceIdB + tokenB` through recovery, new/active receipt, query-terminal, push-terminal, pull, ACK, conflict, and retry entrypoints and requires zero writes and zero network calls. Internal helpers never reacquire the non-reentrant Web Lock; public UI/engine entrypoints acquire once and pass the live token down.

`ProvisionalOperationRow` adds `transportReadyRootSha256`, `terminalEvidenceId`, `terminalResultSha256`, and `terminalOperationIdsSha256`, all nullable outside their state-specific rules. `activation_resolved` is the renamed TS3 activation/conflict terminal state and requires all four fields null. `transport_ready` requires the exact admitted compound root digest and null terminal fields. `transport_resolved` requires all terminal fields and preserves `transportReadyRootSha256`; a pre-existing `transport_resolved` row is idempotent only when every evidence binding matches byte-for-byte.

`admission.ts` owns the only `awaiting_s4` transition and every exported entry requires a live `SpaceAuthorityToken`. It imports TS3's unchanged `prepareHeldProvisionalBatch` plus `freezeOutboxIdentity`, `buildReadyRootIdentities`, `requireSameReadyRootSet`, `parseAndValidateTerminalEvidenceResult`, and `requireTerminalDiagnosticMatchesEvidence` from `authority-identity.ts`; it does not copy ordering, canonicalization, terminal-evidence parsing, or retry scheduling rules. Validation reads a stable Dexie transaction snapshot and completes before its first outbox write: every row has a canonical `createdAt`, valid immutable operation/base-version identity, and either both compound fields null or both present. `freezeOutboxIdentity()` strictly decodes the persisted JSON post-image, freezes its locked-`json-canonicalize@2.0.0` UTF-8 bytes, and separately asks the exhaustive final-catalog `recomputeEntityBusinessPayloadHash()` for the command-specific business hash. Those are deliberately different authorities: for example, a WorkItemNote post-image contains identity/version metadata while its TS1 hash payload is exactly `{document}`. The recomputed business hash must equal the persisted `payloadHash`. Every compound root is loaded in full through `[compoundOperationId+compoundOrder]`; all of its rows must be `awaiting_s4` or the exact already-admitted `ready` group named by Meta, and `prepareHeldProvisionalBatch(group)` must return that exact root plus exact ordered children. `buildReadyRootIdentities()` emits one canonical ordered tuple/digest for each compound and one single-child root for each standalone row, rejects a compound/standalone root-ID collision, then hashes the root list sorted by `rootId`. A root mixed with `blocked_conflict`, a missing/gapped/duplicate order, an attempted provisional child, malformed payload/business-hash mismatch, or a terminal Meta `awaiting_s4` row with no exact compound group is a stable admission failure. Standalone rows may have `attemptCount > 0` because TS3 direct WorkItemNote transport can lose a response. `blocked_conflict` is neither admitted nor cleared.

```typescript
export interface ActiveAdmissionMetaRow {
  operationId: string
  spaceId: string
  state: 'awaiting_s4' | 'transport_ready'
  transportReadyRootSha256: string | null
}

export interface ValidatedAdmissionSnapshot {
  admittedRows: OutboxEvent[]
  readyRootIdentities: ReadyRootIdentity[]
  readyRootSetSha256: string
}

async function loadSameSpaceAdmissionMeta(
  meta: MetaDB,
  spaceId: string,
): Promise<ActiveAdmissionMetaRow[]> {
  return meta.transaction('r', meta.provisionalOperations, async () =>
    (await meta.provisionalOperations.where('spaceId').equals(spaceId).toArray())
      .filter((row) => row.state === 'awaiting_s4' || row.state === 'transport_ready')
      .map((row) => ({
        operationId: row.operationId,
        spaceId: row.spaceId,
        state: row.state as ActiveAdmissionMetaRow['state'],
        transportReadyRootSha256: row.transportReadyRootSha256,
      })),
  )
}

async function validateAwaitingS4Snapshot(
  spaceId: string,
  allRows: readonly OutboxEvent[],
  awaitingRows: readonly OutboxEvent[],
  metaRows: readonly ActiveAdmissionMetaRow[],
): Promise<ValidatedAdmissionSnapshot> {
  if (new Set(allRows.map((row) => row.id)).size !== allRows.length ||
      new Set(allRows.map((row) => row.operationId)).size !== allRows.length ||
      canonicalize(allRows.filter((row) => row.transportState === 'awaiting_s4')) !==
        canonicalize(awaitingRows)) {
    throw new PushAuthorityIntegrityError('admission_input_identity_invalid')
  }
  for (const row of awaitingRows) {
    if ((row.compoundOperationId === null) !== (row.compoundOrder === null) ||
        !Number.isSafeInteger(row.attemptCount) || row.attemptCount < 0 ||
        (row.attemptCount > 0 &&
          (row.entityType !== 'workItemNote' || row.compoundOperationId !== null))) {
      throw new PushAuthorityIntegrityError('awaiting_s4_row_invalid')
    }
  }

  const admittedRows = awaitingRows.map((row) => ({
    ...row, transportState: 'ready' as const,
  }))
  const admittedByDurableKey = new Map(admittedRows.map((row) => [row.id, row]))
  const projectedRows = allRows.map((row) => admittedByDurableKey.get(row.id) ?? row)
  const projectedReadyRows = projectedRows.filter((row) => row.transportState === 'ready')
  const roots = await buildReadyRootIdentities(projectedReadyRows)

  const sourceByOperationId = new Map(allRows.map((row) => [row.operationId, row]))
  const metaByOperationId = new Map(metaRows.map((row) => [row.operationId, row]))
  if (metaByOperationId.size !== metaRows.length ||
      metaRows.some((row) => row.spaceId !== spaceId)) {
    throw new PushAuthorityIntegrityError('admission_meta_identity_invalid')
  }
  const expectedMetaIds = new Set<string>()
  for (const root of roots.readyRoots.filter((item) => item.rootKind === 'compound')) {
    const sourceRows = root.orderedChildren.map((child) =>
      sourceByOperationId.get(child.operationId))
    if (sourceRows.some((row) => !row) ||
        allRows.filter((row) => row.compoundOperationId === root.rootId).length !==
          sourceRows.length) {
      throw new PushAuthorityIntegrityError('admission_compound_membership_invalid')
    }
    const sourceStates = new Set(sourceRows.map((row) => row!.transportState))
    if (sourceStates.size !== 1 ||
        ![...sourceStates].every((state) => state === 'awaiting_s4' || state === 'ready')) {
      throw new PushAuthorityIntegrityError('admission_compound_state_mixed')
    }
    const expectedState = sourceStates.has('awaiting_s4')
      ? 'awaiting_s4' : 'transport_ready'
    const metaRow = metaByOperationId.get(root.rootId)
    if (!metaRow || metaRow.state !== expectedState ||
        (expectedState === 'awaiting_s4'
          ? metaRow.transportReadyRootSha256 !== null
          : metaRow.transportReadyRootSha256 !== root.rootSha256)) {
      throw new PushAuthorityIntegrityError('admission_meta_root_binding_invalid')
    }
    expectedMetaIds.add(root.rootId)
  }
  if (metaRows.some((row) => !expectedMetaIds.has(row.operationId))) {
    throw new PushAuthorityIntegrityError('admission_meta_orphan')
  }
  return {
    admittedRows,
    readyRootIdentities: roots.readyRoots,
    readyRootSetSha256: roots.readyRootSetSha256,
  }
}

function stableAdmissionErrorCode(error: unknown): string {
  return error instanceof PushAuthorityIntegrityError
    ? error.code : 's4_admission_validation_failed'
}

async function revalidateReadyRootIdentitiesInCurrentTransaction(
  db: PomodoroXIDB,
  pending: SyncAdmissionState,
): Promise<void> {
  const transaction = Dexie.currentTransaction
  if (!transaction || transaction.db !== db ||
      !transaction.storeNames.includes('outbox') ||
      !transaction.storeNames.includes('syncAdmissionState') ||
      pending.state !== 'meta_pending' || pending.readyRootSetSha256 === null) {
    throw new PushAuthorityIntegrityError('admission_revalidation_transaction_invalid')
  }
  const rows = (await db.outbox.orderBy('id').toArray())
    .filter((row) => row.transportState === 'ready')
  const actual = await Dexie.waitFor(buildReadyRootIdentities(rows))
  requireSameReadyRootSet(
    pending.readyRoots, pending.readyRootSetSha256,
    actual.readyRoots, actual.readyRootSetSha256,
  )
}

export async function assertS4AdmissionReady(
  db: PomodoroXIDB,
  meta: MetaDB,
  spaceId: string,
  token: SpaceAuthorityToken,
): Promise<void> {
  requireSpaceAuthorityToken(token, spaceId)
  requireSpaceDatabaseBinding(db, spaceId)
  const metaProof = await loadAndRequireSameSpaceReadyMetaProof(meta, spaceId, token)
  return db.transaction(
    'r', db.outbox, db.syncAdmissionState, db.syncTerminalApplications,
    async () => {
      const marker = await db.syncAdmissionState.get('active')
      const rows = await db.outbox.orderBy('id').toArray()
      const evidence = await db.syncTerminalApplications
        .where('spaceId').equals(spaceId).toArray()
      await Dexie.waitFor(assertSpaceAdmissionReadyInCurrentTransaction(
        db, spaceId, marker, rows, metaProof, evidence,
      ))
    },
  )
}


export async function admitTs3AwaitingS4(
  db: PomodoroXIDB,
  meta: MetaDB,
  spaceId: string,
  token: SpaceAuthorityToken,
): Promise<void> {
  requireSpaceAuthorityToken(token, spaceId)
  requireSpaceDatabaseBinding(db, spaceId)
  let pending = await db.syncAdmissionState.get('active')
  if (pending?.state === 'ready') {
    try {
      await assertS4AdmissionReady(db, meta, spaceId, token)
      return
    } catch (error: unknown) {
      if (error instanceof PushAuthorityIntegrityError) {
        const errorCode = error.code
        await db.syncAdmissionState.put({
          key: 'active', state: 'failed', readyRoots: [],
          readyRootSetSha256: null, errorCode,
        })
        throw error
      }
      if (!(error instanceof PushAuthorityDriftError) ||
          error.code !== 'new_complete_paired_root') throw error
    }
    pending = {
      key: 'active', state: 'pending', readyRoots: [],
      readyRootSetSha256: null, errorCode: null,
    }
    await db.syncAdmissionState.put(pending)
  }
  if (pending?.state !== 'meta_pending') {
    const metaAwaiting = await loadSameSpaceAdmissionMeta(meta, spaceId)
    const decision = await db.transaction(
      'rw', db.outbox, db.syncAdmissionState, async () => {
        const rows = await db.outbox.orderBy('id').toArray()
        const awaiting = rows.filter((row) => row.transportState === 'awaiting_s4')
        try {
          const validated = await Dexie.waitFor(
            validateAwaitingS4Snapshot(spaceId, rows, awaiting, metaAwaiting),
          )
          await db.outbox.bulkPut(validated.admittedRows.map((row) => ({
            ...row,
            transportState: 'ready' as const,
          })))
          const next: SyncAdmissionState = {
            key: 'active',
            state: 'meta_pending',
            readyRoots: validated.readyRootIdentities,
            readyRootSetSha256: validated.readyRootSetSha256,
            errorCode: null,
          }
          await db.syncAdmissionState.put(next)
          return { next, error: null }
        } catch (error: unknown) {
          const code = stableAdmissionErrorCode(error)
          await db.syncAdmissionState.put({
            key: 'active', state: 'failed', readyRoots: [],
            readyRootSetSha256: null, errorCode: code,
          })
          return { next: null, error: new Error(code) }
        }
      },
    )
    if (decision.error) throw decision.error
    pending = decision.next!
  }
  if (!pending || pending.state !== 'meta_pending') {
    throw new Error('invalid S4 admission state')
  }
  for (const root of pending.readyRoots.filter((item) => item.rootKind === 'compound')) {
    await markTransportReady(
      meta, spaceId, token, root.rootId, root.rootSha256, canonicalNow(),
    )
  }
  const ready = await db.transaction('rw', db.outbox, db.syncAdmissionState, async () => {
    await revalidateReadyRootIdentitiesInCurrentTransaction(db, pending)
    if (await db.outbox.filter((row) => row.transportState === 'awaiting_s4').count()) {
      await db.syncAdmissionState.put({
        key: 'active', state: 'pending', readyRoots: [],
        readyRootSetSha256: null, errorCode: null,
      })
      return false
    }
    await db.syncAdmissionState.put({ ...pending, state: 'ready' })
    return true
  })
  if (!ready) return admitTs3AwaitingS4(db, meta, spaceId, token)
  await assertS4AdmissionReady(db, meta, spaceId, token)
}
```

`classifyReadyAdmissionSnapshot()` and `assertS4AdmissionReady()` run only under the same live per-Space fence as their caller. They accept `ready` only when the marker's `readyRootSetSha256` matches a fresh recomputation, the outbox has zero `awaiting_s4`, and every persisted `ReadyRootIdentity` is in exactly one state: (a) its complete live child set is byte/field-identical and a compound's Meta row is `transport_ready` with the same `rootSha256`; or (b) the live root is gone only because one exact `SyncTerminalApplicationEvidence` contains the same root tuple/digest/result identity, with Meta still `transport_ready` for `space_committed` crash recovery or already `transport_resolved` with all exact evidence bindings. Evidence cannot excuse an extra root, wrong child/result, or unrelated orphan. `activation_resolved` is never transport evidence. A newly committed complete paired Meta/outbox root returns the typed recoverable decision `new_complete_paired_root`; missing/gapped roots, Meta-only orphans, extra/missing `transport_ready` roots, reparent/order/payload drift, or evidence mismatch return typed integrity errors. No decision is inferred from error-message text.

The Space admission commit deliberately reaches `meta_pending` first, so a crash cannot expose admitted rows to push; restart revalidates every recorded child byte/field and root digest, idempotently moves each exact Meta row to `transport_ready` with `transportReadyRootSha256`, and only then commits `ready`. `reconcilePendingTerminalApplications()` runs under the fence before ready classification, making `space_committed` evidence crash-recoverable. `assertS4AdmissionReady(db, meta, spaceId, token)` repeats the complete proof before selection/query/replay. `pushAllPendingUnderFence()` repeats it after query for direct-IndexedDB corruption, but correctness against compliant cross-Tab writers comes from holding the Web Lock through the network response. A malformed group commits `failed` while leaving outbox/Meta business rows and evidence unchanged. Only `applyTerminalResultTwoPhase()` may move exact Meta `transport_ready` to `transport_resolved`.

- [ ] **Step 4: Store opaque protocol state and one stable client ID**

`client-registry.ts` owns only the stable client ID. `sync-meta.ts` owns every other
Sync v2 protocol-meta key and the only production write APIs. Remove the legacy
generic `saveSyncMeta`, `clearSyncCursors`, numeric cursor/version parsing, and
tokenless `markPendingAck`; reads may be unfenced, but every write below is
same-Space token-bound.

```typescript
// frontend/src/lib/sync/sync-meta.ts
import type { AxiosInstance } from 'axios'
import type { PomodoroXIDB } from '@/services/database'
import {
  requireSpaceAuthorityToken, requireSpaceDatabaseBinding,
  type SpaceAuthorityToken,
} from './space-authority-fence'
import { syncV2Ack } from './transport'

export const SYNC_V2_META_KEYS = {
  CURSOR: 'sync_v2_cursor',
  PENDING_ACK: 'sync_v2_pending_ack',
  CATALOG_HASH: 'sync_v2_catalog_hash',
  REQUIRES_FULL_RECOVERY: 'sync_v2_requires_full_recovery',
} as const

export interface SyncV2MetaSnapshot {
  cursor: string | null
  pendingAck: string | null
  catalogHash: string | null
  requiresFullRecovery: boolean
}

function optionalOpaqueMetaValue(value: string | undefined, label: string): string | null {
  if (value === undefined || value === '') return null
  if (value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`invalid ${label}`)
  }
  return value
}

function requireValidSyncV2Meta(value: SyncV2MetaSnapshot): SyncV2MetaSnapshot {
  if (value.catalogHash !== null && !/^[0-9a-f]{64}$/.test(value.catalogHash)) {
    throw new Error('invalid sync v2 catalog hash')
  }
  if (value.pendingAck !== null && value.pendingAck !== value.cursor) {
    throw new Error('pending ACK must equal the durably installed cursor')
  }
  return value
}

export async function loadSyncV2Meta(db: PomodoroXIDB): Promise<SyncV2MetaSnapshot> {
  const keys = Object.values(SYNC_V2_META_KEYS)
  const rows = await db.syncMeta.bulkGet(keys)
  const values = new Map<string, string>()
  for (const row of rows) {
    if (row !== undefined) values.set(row.key, row.value)
  }
  const recovery = values.get(SYNC_V2_META_KEYS.REQUIRES_FULL_RECOVERY)
  if (recovery !== undefined && recovery !== 'true' && recovery !== 'false') {
    throw new Error('invalid sync v2 recovery flag')
  }
  return requireValidSyncV2Meta({
    cursor: optionalOpaqueMetaValue(values.get(SYNC_V2_META_KEYS.CURSOR), 'cursor'),
    pendingAck: optionalOpaqueMetaValue(
      values.get(SYNC_V2_META_KEYS.PENDING_ACK), 'pending ACK'),
    catalogHash: optionalOpaqueMetaValue(
      values.get(SYNC_V2_META_KEYS.CATALOG_HASH), 'catalog hash'),
    requiresFullRecovery: recovery === undefined ? true : recovery === 'true',
  })
}

/** @internal transaction-local writer; callers include db.syncMeta in the transaction. */
export async function persistSyncV2MetaInCurrentTransaction(
  db: PomodoroXIDB,
  spaceId: string,
  token: SpaceAuthorityToken,
  patch: Partial<SyncV2MetaSnapshot>,
): Promise<SyncV2MetaSnapshot> {
  requireSpaceAuthorityToken(token, spaceId)
  requireSpaceDatabaseBinding(db, spaceId)
  const next = requireValidSyncV2Meta({ ...await loadSyncV2Meta(db), ...patch })
  await db.syncMeta.bulkPut([
    { key: SYNC_V2_META_KEYS.CURSOR, value: next.cursor ?? '' },
    { key: SYNC_V2_META_KEYS.PENDING_ACK, value: next.pendingAck ?? '' },
    { key: SYNC_V2_META_KEYS.CATALOG_HASH, value: next.catalogHash ?? '' },
    { key: SYNC_V2_META_KEYS.REQUIRES_FULL_RECOVERY,
      value: String(next.requiresFullRecovery) },
  ])
  return next
}

export async function writeSyncV2Meta(
  db: PomodoroXIDB,
  spaceId: string,
  token: SpaceAuthorityToken,
  patch: Partial<SyncV2MetaSnapshot>,
): Promise<SyncV2MetaSnapshot> {
  requireSpaceAuthorityToken(token, spaceId)
  requireSpaceDatabaseBinding(db, spaceId)
  return db.transaction('rw', db.syncMeta, async () =>
    persistSyncV2MetaInCurrentTransaction(db, spaceId, token, patch))
}

export async function sendPendingAck(
  db: PomodoroXIDB,
  api: AxiosInstance,
  spaceId: string,
  clientId: string,
  token: SpaceAuthorityToken,
): Promise<void> {
  requireSpaceAuthorityToken(token, spaceId)
  requireSpaceDatabaseBinding(db, spaceId)
  const before = await loadSyncV2Meta(db)
  if (before.pendingAck === null) return
  if (before.catalogHash === null) throw new Error('pending ACK has no catalog binding')
  const acknowledged = before.pendingAck
  const response = (await syncV2Ack(
    api, { client_id: clientId, cursor: acknowledged })).data
  if (!response.accepted || response.requires_recovery ||
      response.catalog_hash !== before.catalogHash) {
    throw new Error('ACK response did not accept the bound recovery generation')
  }
  await db.transaction('rw', db.syncMeta, async () => {
    requireSpaceAuthorityToken(token, spaceId)
    const current = await loadSyncV2Meta(db)
    if (current.pendingAck !== acknowledged) return
    await persistSyncV2MetaInCurrentTransaction(db, spaceId, token, {
      pendingAck: null,
      requiresFullRecovery: false,
    })
  })
}

```

```typescript
// frontend/src/lib/sync/client-registry.ts
import Dexie from 'dexie'
import type { PomodoroXIDB } from '@/services/database'
import {
  requireSpaceAuthorityToken, requireSpaceDatabaseBinding,
  type SpaceAuthorityToken,
} from './space-authority-fence'

export const SYNC_CLIENT_META_KEY = 'sync_v2_client_id' as const

export async function getOrCreateClientId(
  db: PomodoroXIDB,
  spaceId: string,
  token: SpaceAuthorityToken,
): Promise<string> {
  requireSpaceAuthorityToken(token, spaceId)
  requireSpaceDatabaseBinding(db, spaceId)
  return db.transaction('rw', db.syncMeta, async () => {
    requireSpaceAuthorityToken(token, spaceId)
    const existing = await db.syncMeta.get(SYNC_CLIENT_META_KEY)
    if (existing?.value) return existing.value
    const candidate = crypto.randomUUID()
    try {
      await db.syncMeta.add({ key: SYNC_CLIENT_META_KEY, value: candidate })
    } catch (error: unknown) {
      if (!(error instanceof Dexie.ConstraintError)) throw error
    }
    const winner = await db.syncMeta.get(SYNC_CLIENT_META_KEY)
    if (!winner?.value) throw new Error('sync client ID creation lost without a winner')
    return winner.value
  })
}
```

The client-ID conflict path rereads the winning row and never replaces it on
retry, reload, or token refresh. `sendPendingAck()` sends the already persisted
opaque token, accepts only the same catalog generation, and compare-and-clears
only when `pendingAck` still equals that token. A newer committed page therefore
cannot be erased by an older ACK response. Tests use `@ts-expect-error` calls to
prove all four writers reject omitted tokens at compile time, plus forged/expired
token runtime tests that assert zero `syncMeta` writes and zero ACK requests.

`response-schema.ts` is the runtime authority for server responses. Generated OpenAPI types constrain these parsers at compile time but never validate `response.data` at runtime:

```typescript
import { z } from 'zod'
import { canonicalize } from 'json-canonicalize'
import type {
  ApiSyncV2AckResponse,
  ApiSyncV2OperationQueryResponse,
  ApiSyncV2PullResponse,
  ApiSyncV2PushResponse,
  ApiSyncV2RecoveryResponse,
  ApiSyncV2StatusResponse,
  OutboxAction,
  RetainedLwwSyncEntityType,
} from './types'

const MAX_DECODED_CANONICAL_PAGE_BYTES = 8 * 1024 * 1024
export type IJsonValue =
  | null | boolean | number | string
  | IJsonValue[] | { [key: string]: IJsonValue }

function requireRealUtcCalendarInstant(value: string, context: z.RefinementCtx): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(value)
  if (!match) return
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number)
  const instant = new Date(0)
  instant.setUTCFullYear(year!, month! - 1, day!)
  instant.setUTCHours(hour!, minute!, second!, 0)
  if (instant.getUTCFullYear() !== year || instant.getUTCMonth() !== month! - 1 ||
      instant.getUTCDate() !== day || instant.getUTCHours() !== hour ||
      instant.getUTCMinutes() !== minute || instant.getUTCSeconds() !== second) {
    context.addIssue({ code: 'custom', message: 'timestamp is not a real UTC instant' })
  }
}

function hasOnlyUnicodeScalarValues(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return false
      index += 1
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false
    }
  }
  return true
}

export function validateIJsonGraph(value: unknown): asserts value is IJsonValue {
  const pending: unknown[] = [value]
  const seen = new WeakSet<object>()
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === null || typeof current === 'boolean') continue
    if (typeof current === 'string') {
      if (!hasOnlyUnicodeScalarValues(current)) throw new Error('I-JSON lone surrogate')
      continue
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current) ||
          (Number.isInteger(current) && !Number.isSafeInteger(current))) {
        throw new Error('I-JSON number is not finite/JS-safe')
      }
      continue
    }
    if (typeof current !== 'object') throw new Error('value is not JSON')
    if (seen.has(current)) throw new Error('JSON graph is cyclic')
    seen.add(current)
    if (Array.isArray(current)) {
      pending.push(...current)
      continue
    }
    const prototype = Object.getPrototypeOf(current)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('JSON object has a non-JSON prototype')
    }
    for (const [key, child] of Object.entries(current)) {
      if (!hasOnlyUnicodeScalarValues(key)) throw new Error('I-JSON key has lone surrogate')
      pending.push(child)
    }
  }
}

export function parseIJsonTextRejectingDuplicateKeys(raw: string): IJsonValue {
  let offset = 0
  const fail = (message: string): never => {
    throw new Error(`${message} at byte/code-unit offset ${offset}`)
  }
  const skipWhitespace = (): void => {
    while (/[\t\n\r ]/.test(raw[offset] ?? '')) offset += 1
  }
  const scanString = (): string => {
    if (raw[offset] !== '"') return fail('expected JSON string')
    const start = offset++
    while (offset < raw.length) {
      const character = raw[offset++]!
      if (character === '"') {
        return JSON.parse(raw.slice(start, offset)) as string
      }
      if (character === '\\') {
        if (offset >= raw.length) return fail('incomplete JSON escape')
        const escaped = raw[offset++]!
        if (escaped === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(raw.slice(offset, offset + 4))) {
            return fail('invalid JSON Unicode escape')
          }
          offset += 4
        } else if (!/["\\/bfnrt]/.test(escaped)) {
          return fail('invalid JSON escape')
        }
      } else if (character.charCodeAt(0) < 0x20) {
        return fail('unescaped JSON control character')
      }
    }
    return fail('unterminated JSON string')
  }
  const scanScalar = (): void => {
    const start = offset
    while (offset < raw.length && !/[\t\n\r ,\]}]/.test(raw[offset]!)) offset += 1
    if (start === offset) return fail('missing JSON scalar')
    JSON.parse(raw.slice(start, offset))
  }
  const scanValue = (): void => {
    skipWhitespace()
    if (raw[offset] === '{') {
      offset += 1
      skipWhitespace()
      const keys = new Set<string>()
      if (raw[offset] === '}') { offset += 1; return }
      while (true) {
        const key = scanString()
        if (keys.has(key)) return fail(`duplicate JSON object key ${JSON.stringify(key)}`)
        keys.add(key)
        skipWhitespace()
        if (raw[offset++] !== ':') return fail('expected JSON name separator')
        scanValue()
        skipWhitespace()
        const separator = raw[offset++]
        if (separator === '}') return
        if (separator !== ',') return fail('expected JSON object separator')
        skipWhitespace()
      }
    }
    if (raw[offset] === '[') {
      offset += 1
      skipWhitespace()
      if (raw[offset] === ']') { offset += 1; return }
      while (true) {
        scanValue()
        skipWhitespace()
        const separator = raw[offset++]
        if (separator === ']') return
        if (separator !== ',') return fail('expected JSON array separator')
        skipWhitespace()
      }
    }
    if (raw[offset] === '"') { scanString(); return }
    scanScalar()
  }
  scanValue()
  skipWhitespace()
  if (offset !== raw.length) fail('trailing JSON text')
  const parsed: unknown = JSON.parse(raw)
  validateIJsonGraph(parsed)
  return parsed
}

function encodeStandardBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

export function decodeCanonicalStandardBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('recovery payload is not canonical standard base64')
  }
  let binary: string
  try { binary = atob(value) } catch { throw new Error('invalid recovery base64') }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  if (encodeStandardBase64(bytes) !== value) {
    throw new Error('recovery base64 does not round-trip canonically')
  }
  return bytes
}

function requireCanonicalPageAtMost8MiB(
  page: unknown,
  context: z.RefinementCtx,
): void {
  const canonical = canonicalize(page)
  if (canonical === undefined ||
      new TextEncoder().encode(canonical).length > MAX_DECODED_CANONICAL_PAGE_BYTES) {
    context.addIssue({ code: 'custom', message: 'canonical pull page exceeds 8 MiB' })
  }
}

function requireCanonicalDecodedRecoveryPageAtMost8MiB(
  page: { payload_jsonl_base64: string; entity_count: number },
  context: z.RefinementCtx,
): void {
  try {
    const bytes = decodeCanonicalStandardBase64(page.payload_jsonl_base64)
    if (bytes.length > MAX_DECODED_CANONICAL_PAGE_BYTES) {
      throw new Error('decoded recovery page exceeds 8 MiB')
    }
    if (bytes.length === 0) {
      if (page.entity_count !== 0) throw new Error('empty recovery page count mismatch')
      return
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (!text.endsWith('\n')) throw new Error('canonical JSONL must end with LF')
    const lines = text.slice(0, -1).split('\n')
    if (lines.length !== page.entity_count || lines.some((line) => line.length === 0)) {
      throw new Error('recovery JSONL entity count mismatch')
    }
    for (const line of lines) {
      const parsed = parseIJsonTextRejectingDuplicateKeys(line)
      if (canonicalize(parsed) !== line) throw new Error('recovery JSONL line is not canonical')
    }
  } catch (error: unknown) {
    context.addIssue({
      code: 'custom',
      message: error instanceof Error ? error.message : 'invalid canonical recovery page',
    })
  }
}

const utf8Encoder = new TextEncoder()
const shortId = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/)
const operationId = z.string().superRefine((value, context) => {
  const bytes = utf8Encoder.encode(value)
  if (bytes.length < 1 || bytes.length > 128 ||
      [...bytes].some((byte) => byte < 0x21 || byte > 0x7e)) {
    context.addIssue({
      code: 'custom',
      message: 'operation/batch ID must be 1-128 UTF-8 bytes of printable ASCII',
    })
  }
})
const hash = z.string().regex(/^[0-9a-f]{64}$/)
const token = z.string().min(16).max(2048)
const safeNonnegativeInt = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const version = safeNonnegativeInt
const canonicalUtcTimestamp = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/)
  .superRefine(requireRealUtcCalendarInstant)
const jsonNumber = z.number().finite().refine(
  (value) => !Number.isInteger(value) || Number.isSafeInteger(value),
  'integer JSON values must be JS-safe',
)
const jsonString = z.string().refine(hasOnlyUnicodeScalarValues)
const jsonValue: z.ZodType<unknown> = z.lazy(() => z.union([
  z.null(), z.boolean(), jsonNumber, jsonString,
  z.array(jsonValue), z.record(jsonString, jsonValue),
]))
const details = z.record(jsonString, jsonValue)
function byteArraysEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index])
}

const eventRecord = z.strictObject({
  operation_id: operationId,
  batch_id: operationId,
  entity_type: shortId,
  entity_id: shortId,
  action: z.enum(['create', 'update', 'delete']),
  payload: z.record(jsonString, jsonValue),
  version,
  created_at: canonicalUtcTimestamp,
})
const snapshotEntityRecord = z.strictObject({
  kind: z.literal('entity'),
  entity_type: shortId,
  entity_id: shortId,
  version,
  updated_at: canonicalUtcTimestamp,
  payload: z.record(jsonString, jsonValue),
})
export type SnapshotEntityRecord = z.infer<typeof snapshotEntityRecord>
const pushApplied = z.strictObject({
  operation_id: operationId,
  entity_type: shortId,
  entity_id: shortId,
  version,
  resolution: z.literal('remote').nullable(),
})
const pushConflict = z.strictObject({
  operation_id: operationId,
  entity_type: shortId,
  entity_id: shortId,
  code: z.enum(['version_conflict', 'tombstone_conflict', 'cycle_detected']),
  resolution: z.enum(['local', 'tombstone', 'circular_ref', 'manual']),
  details,
})
const pushError = z.strictObject({
  operation_id: operationId,
  entity_type: shortId,
  entity_id: shortId,
  code: z.string().min(1),
  retryable: z.boolean(),
  details,
})

const pushResponse = z.strictObject({
  batch_id: operationId,
  applied: z.array(pushApplied).max(500),
  conflicts: z.array(pushConflict).max(500),
  errors: z.array(pushError).max(500),
}).superRefine((result, context) => {
  const operationIds = [
    ...result.applied.map((item) => item.operation_id),
    ...result.conflicts.map((item) => item.operation_id),
    ...result.errors.map((item) => item.operation_id),
  ]
  if (operationIds.length > 500 || new Set(operationIds).size !== operationIds.length) {
    context.addIssue({
      code: 'custom',
      message: 'push result operation IDs must be globally unique and bounded',
    })
  }
})
const operationQueryItem = z.strictObject({
  operation_id: operationId,
  state: z.enum(['unknown', 'pending', 'terminal', 'recovery_required']),
  batch_id: operationId.nullable(),
  result: pushResponse.nullable(),
}).superRefine((item, context) => {
  if (item.state === 'unknown') {
    if (item.batch_id !== null || item.result !== null) {
      context.addIssue({ code: 'custom', message: 'unknown operation exposes a binding' })
    }
    return
  }
  if (item.batch_id === null) {
    context.addIssue({ code: 'custom', message: 'known operation has no batch binding' })
  }
  if (item.state === 'terminal') {
    if (item.result === null || item.result.batch_id !== item.batch_id) {
      context.addIssue({ code: 'custom', message: 'terminal operation result mismatch' })
    }
  } else if (item.result !== null) {
    context.addIssue({ code: 'custom', message: 'nonterminal operation exposes a result' })
  }
})
const operationQueryResponse = z.strictObject({
  items: z.array(operationQueryItem).min(1).max(500),
})
const pullResponse = z.strictObject({
  events: z.array(eventRecord).max(500),
  next_cursor: token,
  has_more: z.boolean(),
  catalog_hash: hash,
}).superRefine(requireCanonicalPageAtMost8MiB)
const recoveryResponse = z.strictObject({
  payload_jsonl_base64: z.string().max(11_184_812),
  entity_count: safeNonnegativeInt.max(500),
  chunk_sha256: hash,
  next_page_token: token.nullable(),
  has_more: z.boolean(),
  catalog_hash: hash,
  waterline_cursor: token,
}).superRefine((page, context) => {
  if (page.has_more !== (page.next_page_token !== null)) {
    context.addIssue({
      code: 'custom',
      message: 'recovery has_more must equal next_page_token presence',
    })
  }
}).superRefine(requireCanonicalDecodedRecoveryPageAtMost8MiB)
const ackResponse = z.strictObject({
  client_id: shortId,
  accepted: z.literal(true),
  requires_recovery: z.boolean(),
  catalog_hash: hash,
})
const statusResponse = z.strictObject({
  catalog_hash: hash,
  client_id: shortId.nullable(),
  registered: z.boolean(),
  requires_recovery: z.boolean().nullable(),
  recovery_action: z.literal('full_recovery').nullable(),
  visible_event_count: safeNonnegativeInt,
  active_client_count: safeNonnegativeInt,
  recovery_client_count: safeNonnegativeInt,
})

const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const clockText = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
const retainedClockOrUtc = z.union([clockText, canonicalUtcTimestamp])
const nullableUtc = canonicalUtcTimestamp.nullable()
const retainedBase = {
  spaceId: shortId,
  id: shortId,
  version,
  created_at: canonicalUtcTimestamp,
  updated_at: canonicalUtcTimestamp,
}

const retainedLwwPostImageSchemas = {
  note: z.strictObject({
    ...retainedBase,
    title: z.string().max(500), content: z.string(), summary: z.string().max(500),
    tags: z.array(z.string()), category: z.string().max(200).nullable(),
    folder_id: shortId.nullable(), status: z.enum(['active', 'archived']),
    trashed_at: nullableUtc,
  }),
  folder: z.strictObject({
    ...retainedBase,
    name: z.string().min(1).max(200), parent_id: shortId.nullable(),
    icon: z.string().max(50).nullable(), color: z.string().max(20).nullable(),
    sort_order: safeNonnegativeInt, is_system: z.boolean(), trashed_at: nullableUtc,
  }),
  quickNote: z.strictObject({
    ...retainedBase,
    content: z.string().max(50_000),
    mood: z.enum(['normal', 'happy', 'sad', 'tired', 'excited', 'calm']).nullable(),
    tags: z.array(z.string()), pinned: z.boolean(), archived_at: nullableUtc,
    archive_file_path: z.string().max(500).nullable(), folder_id: shortId.nullable(),
    trashed_at: nullableUtc, migrated_to_note_id: shortId.nullable(),
  }),
  reflection: z.strictObject({
    ...retainedBase,
    date: calendarDate, content: z.string().max(50_000),
    mood: z.enum(['great', 'good', 'normal', 'bad', 'terrible']).nullable(),
    tags: z.array(z.string()), sections: z.array(jsonValue), is_structured: z.boolean(),
  }),
  habit: z.strictObject({
    ...retainedBase,
    title: z.string().min(1).max(500), description: z.string().max(10_000),
    color: z.string().max(20), icon: z.string().max(20),
    target_count: safeNonnegativeInt, rest_day_protection: z.boolean(),
    rest_days: z.array(z.number().int().min(0).max(6)),
    sort_order: safeNonnegativeInt, archived: z.boolean(),
  }),
  habitCheckIn: z.strictObject({
    ...retainedBase,
    habit_id: shortId, date: calendarDate, count: safeNonnegativeInt,
    note: z.string().max(10_000),
  }),
  schedule: z.strictObject({
    ...retainedBase,
    title: z.string().min(1).max(500), due_at: canonicalUtcTimestamp,
    completed_at: nullableUtc, priority: z.enum(['high', 'medium', 'low']),
    color: z.string().max(20), all_day: z.boolean(),
    start_time: retainedClockOrUtc.nullable(), end_time: retainedClockOrUtc.nullable(),
  }),
  timeBlock: z.strictObject({
    ...retainedBase,
    title: z.string().max(500), date: calendarDate,
    start_time: retainedClockOrUtc, end_time: retainedClockOrUtc,
    planned_duration: safeNonnegativeInt, actual_duration: safeNonnegativeInt,
    block_type: z.enum(['work', 'short_break', 'long_break']),
    status: z.enum(['planned', 'in_progress', 'completed', 'skipped']),
    sort_order: safeNonnegativeInt,
  }),
  memoComment: z.strictObject({
    ...retainedBase,
    note_id: shortId, content: z.string().max(10_000),
  }),
  scheduleQuickNote: z.strictObject({
    ...retainedBase,
    schedule_id: shortId, quick_note_id: shortId,
  }),
} as const satisfies Record<RetainedLwwSyncEntityType, z.ZodTypeAny>

type MissingRetainedParser = Exclude<
  RetainedLwwSyncEntityType, keyof typeof retainedLwwPostImageSchemas
>
type ExtraRetainedParser = Exclude<
  keyof typeof retainedLwwPostImageSchemas, RetainedLwwSyncEntityType
>
const RETAINED_LWW_PARSER_MAP_IS_EXACT:
  MissingRetainedParser extends never
    ? (ExtraRetainedParser extends never ? true : never)
    : never = true
void RETAINED_LWW_PARSER_MAP_IS_EXACT

const retainedLwwOutboxPostImageSchemas = {
  note: retainedLwwPostImageSchemas.note.omit({ spaceId: true, version: true }),
  folder: retainedLwwPostImageSchemas.folder.omit({ spaceId: true, version: true }),
  quickNote: retainedLwwPostImageSchemas.quickNote.omit({ spaceId: true, version: true }),
  reflection: retainedLwwPostImageSchemas.reflection.omit({ spaceId: true, version: true }),
  habit: retainedLwwPostImageSchemas.habit.omit({ spaceId: true, version: true }),
  habitCheckIn: retainedLwwPostImageSchemas.habitCheckIn.omit({ spaceId: true, version: true }),
  schedule: retainedLwwPostImageSchemas.schedule.omit({ spaceId: true, version: true }),
  timeBlock: retainedLwwPostImageSchemas.timeBlock.omit({ spaceId: true, version: true }),
  memoComment: retainedLwwPostImageSchemas.memoComment.omit({ spaceId: true, version: true }),
  scheduleQuickNote: retainedLwwPostImageSchemas.scheduleQuickNote
    .omit({ spaceId: true, version: true }),
} as const satisfies Record<RetainedLwwSyncEntityType, z.ZodTypeAny>
const retainedDeletePostImageSchema = z.strictObject({ id: shortId })

export function parseRetainedLwwOutboxPostImage(
  entityType: RetainedLwwSyncEntityType,
  action: OutboxAction,
  postImage: unknown,
): IJsonValue {
  return (action === 'delete'
    ? retainedDeletePostImageSchema
    : retainedLwwOutboxPostImageSchemas[entityType]).parse(postImage) as IJsonValue
}

export function parseFinalSyncEntityPostImage(
  entityType: RetainedLwwSyncEntityType,
  payload: unknown,
  expectedSpaceId: string,
): Record<string, unknown> {
  const parsed = retainedLwwPostImageSchemas[entityType].parse(payload) as
    Record<string, unknown> & { spaceId: string }
  if (parsed.spaceId !== expectedSpaceId) {
    throw new Error('retained_lww_payload_space_mismatch')
  }
  const { spaceId: _verified, ...business } = parsed
  return { ...business, deletion_state: 'active', _dirty: false }
}

export const parseSyncV2PushResponse = (value: unknown): ApiSyncV2PushResponse =>
  pushResponse.parse(value)
export const parseSnapshotEntityRecord = (value: unknown): SnapshotEntityRecord =>
  snapshotEntityRecord.parse(value)
export const requireCanonicalStoredTimestamp = (value: string): string =>
  canonicalUtcTimestamp.parse(value)
export const parseSyncV2OperationQueryResponse = (
  value: unknown,
  expectedOperationIds: readonly string[],
): ApiSyncV2OperationQueryResponse => {
  if (new Set(expectedOperationIds).size !== expectedOperationIds.length) {
    throw new Error('operation query expected IDs are not unique')
  }
  const parsed = operationQueryResponse.parse(value)
  if (parsed.items.length !== expectedOperationIds.length ||
      parsed.items.some((item, index) => item.operation_id !== expectedOperationIds[index])) {
    throw new Error('operation query response order/coverage mismatch')
  }
  let terminalBatchId: string | null = null
  let terminalResultBytes: Uint8Array | null = null
  for (const item of parsed.items) {
    if (item.state !== 'terminal') continue
    if (item.batch_id === null || item.result === null) {
      throw new Error('operation query terminal binding missing')
    }
    const outcomeIds = [
      ...item.result.applied.map((outcome) => outcome.operation_id),
      ...item.result.conflicts.map((outcome) => outcome.operation_id),
      ...item.result.errors.map((outcome) => outcome.operation_id),
    ]
    if (outcomeIds.filter((operationId) => operationId === item.operation_id).length !== 1) {
      throw new Error('operation query terminal authority lacks exactly one outcome')
    }
    const resultBytes = utf8Encoder.encode(canonicalize(item.result))
    if (terminalBatchId === null) {
      terminalBatchId = item.batch_id
      terminalResultBytes = resultBytes
    } else if (item.batch_id !== terminalBatchId ||
               !byteArraysEqual(resultBytes, terminalResultBytes!)) {
      throw new Error('operation query terminal authorities disagree on original result')
    }
  }
  return parsed
}
export const parseSyncV2PullResponse = (value: unknown): ApiSyncV2PullResponse =>
  pullResponse.parse(value)
export const parseSyncV2RecoveryResponse = (value: unknown): ApiSyncV2RecoveryResponse =>
  recoveryResponse.parse(value)
export const parseSyncV2AckResponse = (value: unknown): ApiSyncV2AckResponse =>
  ackResponse.parse(value)
export const parseSyncV2StatusResponse = (value: unknown): ApiSyncV2StatusResponse =>
  statusResponse.parse(value)
```

Every `syncV2*` transport calls its corresponding parser on the raw Axios `response.data` and returns a response whose `data` is the parsed value. No caller may cast raw JSON to a generated type. `z.strictObject` rejects extra keys; shared JSON validation rejects unsafe integers/lone surrogates; required version/count fields reject missing/null/Boolean/string/negative/over-safe values; timestamps use the same UTC grammar/calendar profile as Python. Public operation/batch IDs use the 1-128-byte `0x21..0x7e` validator, not the child-suffix regex. Recovery parsing rejects either direction of token/`has_more` disagreement before download state changes. Retained time strings use the explicit `HH:mm | canonical UTC RFC3339` union shared by outbox and recovery parsers. The operation-query parser receives the exact requested ID tuple and rejects reordering, duplicates, omission, extras, or state/binding mismatch. At the parser boundary, before classifier/application code runs, every nested complete push result must have at most 500 globally unique operation IDs across `applied|conflicts|errors`; each terminal item's declared `operation_id` must occur in exactly one of those arrays; and all terminal items must carry one identical original `batch_id` plus RFC-8785 byte-equivalent complete results. `byteArraysEqual` compares the canonical UTF-8 arrays by length and every byte; object equality or a later application coverage check is not a substitute. `requireCanonicalDecodedRecoveryPageAtMost8MiB` first enforces canonical standard base64 spelling/padding and encoded cap, then decodes at most 8 MiB and validates canonical JSONL; `requireCanonicalPageAtMost8MiB` uses locked RFC 8785 canonicalization for the whole decoded pull page. `transport.test.ts` executes all six parsers through real Axios adapters at exact/+1 limits. Verify TS3's exact canonicalizer with `npm ls json-canonicalize@2.0.0 --depth=0`; neither frontend package manifest may change its version. The generation/test helper copies the backend event vector file byte-for-byte to the frontend fixture and fails on any content/hash drift.

- [ ] **Step 5: Implement resumable download and atomic recovery cutover**

```typescript
// frontend/src/lib/sync/recovery.ts
import Dexie from 'dexie'
import type { AxiosInstance, AxiosResponse } from 'axios'
import { canonicalize } from 'json-canonicalize'
import type {
  PomodoroXIDB,
  SyncRecoveryChunk,
  SyncRecoveryState,
} from '@/services/database'
import {
  assertResponseSpace,
  labelSchema,
  projectSchema,
  statusDefinitionSchema,
  typeDefinitionSchema,
  workItemLabelSchema,
  workItemNoteSchema,
  workItemSchema,
} from '@/lib/contracts/task-space'
import {
  focusSessionRecoveryWireSchema,
  projectFocusSessionRecoveryWireToCache,
  sessionAttributionRevisionRecoveryWireSchema,
  sessionTaskContextRecoveryWireSchema,
  sessionWorkItemOutcomeRecoveryWireSchema,
  sessionWorkItemPlanRecoveryWireSchema,
} from '@/lib/contracts/focus-session'
import {
  FINAL_SYNC_ENTITY_TO_TABLE,
  FINAL_SYNC_ENTITY_TYPE_SET,
  type ApiSyncV2RecoveryResponse,
  type OutboxEvent,
  type SyncEntityType,
} from './types'
import { sha256HexBytes } from './authority-identity'
import {
  decodeCanonicalStandardBase64,
  parseFinalSyncEntityPostImage,
  parseIJsonTextRejectingDuplicateKeys,
  parseSnapshotEntityRecord,
  type SnapshotEntityRecord,
} from './response-schema'
import {
  requireSpaceAuthorityToken, requireSpaceDatabaseBinding,
  type SpaceAuthorityToken,
} from './space-authority-fence'
import {
  persistSyncV2MetaInCurrentTransaction,
  sendPendingAck,
} from './sync-meta'
import { syncV2Recover } from './transport'

interface CanonicalRecoveryErrorRecord {
  code: 'cursor_expired' | 'snapshot_invalid'
  message: string
  retryable: boolean
  request_id: string
  details: { recovery_action: 'full_recovery' }
}

function isRecoveryGenerationInvalid(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const response = (error as { response?: {
    data?: unknown
    headers?: { get?: (name: string) => unknown; [name: string]: unknown }
  } }).response
  if (!response || response.data === null || typeof response.data !== 'object' ||
      Array.isArray(response.data)) return false
  const headers = response.headers
  const contentType = String(
    headers?.get?.('content-type') ?? headers?.['content-type'] ?? '',
  ).toLowerCase()
  if (!/^application\/vnd\.pomodoroxii\.error\+json\s*;\s*version=2(?:\s*;|$)/
    .test(contentType)) return false
  const record = response.data as Partial<CanonicalRecoveryErrorRecord>
  const details = record.details
  return Object.keys(record).sort().join(',') ===
      'code,details,message,request_id,retryable' &&
    (record.code === 'cursor_expired' || record.code === 'snapshot_invalid') &&
    typeof record.message === 'string' && record.message.length > 0 &&
    typeof record.retryable === 'boolean' &&
    typeof record.request_id === 'string' && record.request_id.length > 0 &&
    details !== null && typeof details === 'object' &&
    Object.keys(details).length === 1 && details.recovery_action === 'full_recovery'
}

async function verifyChunkSha256(bytes: Uint8Array, expected: string): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(expected) || await sha256HexBytes(bytes) !== expected) {
    throw new Error('Recovery chunk SHA-256 mismatch')
  }
}

function parseCanonicalJsonLines(bytes: Uint8Array): SnapshotEntityRecord[] {
  if (bytes.length === 0) return []
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (!text.endsWith('\n')) throw new Error('Recovery JSONL must end with LF')
  const lines = text.slice(0, -1).split('\n')
  if (lines.some((line) => line.length === 0)) {
    throw new Error('Recovery JSONL contains an empty record')
  }
  return lines.map((line) => {
    const value = parseIJsonTextRejectingDuplicateKeys(line)
    if (canonicalize(value) !== line) {
      throw new Error('Recovery JSONL record is not canonical')
    }
    return parseSnapshotEntityRecord(value)
  })
}

async function validateCompleteStagedRecovery(
  spaceId: string,
  state: SyncRecoveryState,
  chunks: readonly SyncRecoveryChunk[],
): Promise<SnapshotEntityRecord[]> {
  if (state.spaceId !== spaceId || state.state !== 'ready' || state.nextPageToken !== null ||
      chunks.length !== state.nextChunkIndex || chunks.length === 0) {
    throw new Error('Recovery staging is not complete')
  }
  const records: SnapshotEntityRecord[] = []
  let priorNextPageToken: string | null = null
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]!
    const final = index === chunks.length - 1
    if (chunk.spaceId !== spaceId || chunk.recoveryId !== state.recoveryId ||
        chunk.index !== index ||
        chunk.pageTokenUsed !== priorNextPageToken ||
        chunk.catalogHash !== state.catalogHash ||
        chunk.waterlineCursor !== state.waterlineCursor ||
        (final
          ? chunk.hasMore || chunk.nextPageToken !== null
          : !chunk.hasMore || chunk.nextPageToken === null)) {
      throw new Error('Recovery staging chain/binding mismatch')
    }
    const bytes = decodeCanonicalStandardBase64(chunk.payloadJsonlBase64)
    await verifyChunkSha256(bytes, chunk.sha256)
    const parsed = parseCanonicalJsonLines(bytes)
    if (parsed.length !== chunk.entityCount) {
      throw new Error('Recovery staged entity count mismatch')
    }
    records.push(...parsed)
    priorNextPageToken = chunk.nextPageToken
  }
  const entityKeys = records.map((record) =>
    `${record.entity_type}\u0000${record.entity_id}`)
  if (new Set(entityKeys).size !== entityKeys.length) {
    throw new Error('Recovery snapshot contains a duplicate entity key')
  }
  return records
}

type RecoveryTableName =
  (typeof FINAL_SYNC_ENTITY_TO_TABLE)[SyncEntityType]

type RecoveryLocalKey = string | [string, string]

interface PreparedRecoveryEntity {
  key: string
  entityType: SyncEntityType
  entityId: string
  version: number
  tableName: RecoveryTableName
  localKey: RecoveryLocalKey
  row: Record<string, unknown>
}

type RecoverySnapshotIndex = ReadonlyMap<string, PreparedRecoveryEntity>

function recoveryEntityKey(entityType: string, entityId: string): string {
  return `${entityType}\u0000${entityId}`
}

function isFinalSyncEntityType(value: string): value is SyncEntityType {
  return FINAL_SYNC_ENTITY_TYPE_SET.has(value)
}

function withoutVerifiedSpace(
  value: object & { spaceId: string },
  spaceId: string,
): Record<string, unknown> {
  const { spaceId: _verified, ...local } = assertResponseSpace(value, spaceId)
  return local as Record<string, unknown>
}

function asLocalRecord(value: object): Record<string, unknown> {
  return structuredClone(value) as Record<string, unknown>
}

function projectRecoveryWirePayload(
  spaceId: string,
  entityType: SyncEntityType,
  payload: SnapshotEntityRecord['payload'],
): Record<string, unknown> {
  switch (entityType) {
    case 'note':
    case 'folder':
    case 'quickNote':
    case 'reflection':
    case 'habit':
    case 'habitCheckIn':
    case 'schedule':
    case 'timeBlock':
    case 'memoComment':
    case 'scheduleQuickNote':
      return asLocalRecord(
        parseFinalSyncEntityPostImage(entityType, payload, spaceId),
      )
    case 'project':
      return asLocalRecord(withoutVerifiedSpace(projectSchema.parse(payload), spaceId))
    case 'statusDefinition':
      return asLocalRecord(withoutVerifiedSpace(
        statusDefinitionSchema.parse(payload), spaceId))
    case 'typeDefinition':
      return asLocalRecord(withoutVerifiedSpace(
        typeDefinitionSchema.parse(payload), spaceId))
    case 'label':
      return asLocalRecord(withoutVerifiedSpace(labelSchema.parse(payload), spaceId))
    case 'workItemLabel':
      return asLocalRecord(withoutVerifiedSpace(
        workItemLabelSchema.parse(payload), spaceId))
    case 'workItem':
      return asLocalRecord(withoutVerifiedSpace(workItemSchema.parse(payload), spaceId))
    case 'workItemNote':
      return {
        ...withoutVerifiedSpace(workItemNoteSchema.parse(payload), spaceId),
        localRevision: 0,
        syncState: 'clean',
      }
    case 'focusSession': {
      assertResponseSpace(focusSessionRecoveryWireSchema.parse(payload), spaceId)
      return asLocalRecord(projectFocusSessionRecoveryWireToCache(payload))
    }
    case 'sessionTaskContext':
      return asLocalRecord(withoutVerifiedSpace(
        sessionTaskContextRecoveryWireSchema.parse(payload), spaceId))
    case 'sessionAttributionRevision':
      return asLocalRecord(withoutVerifiedSpace(
        sessionAttributionRevisionRecoveryWireSchema.parse(payload), spaceId))
    case 'sessionWorkItemPlan':
      return asLocalRecord(withoutVerifiedSpace(
        sessionWorkItemPlanRecoveryWireSchema.parse(payload), spaceId))
    case 'sessionWorkItemOutcome':
      return asLocalRecord(withoutVerifiedSpace(
        sessionWorkItemOutcomeRecoveryWireSchema.parse(payload), spaceId))
    default: {
      const exhaustive: never = entityType
      throw new Error(`Missing recovery wire projector: ${String(exhaustive)}`)
    }
  }
}

function requireLocalString(row: Record<string, unknown>, field: string): string {
  const value = row[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Recovery local row is missing ${field}`)
  }
  return value
}

function recoveryWireEntityIdFromLocalRow(
  entityType: SyncEntityType,
  row: Record<string, unknown>,
): string {
  switch (entityType) {
    case 'workItemNote': return requireLocalString(row, 'noteId')
    case 'focusSession': return requireLocalString(row, 'sessionId')
    default: return requireLocalString(row, 'id')
  }
}

function recoveryLocalKeyFromLocalRow(
  entityType: SyncEntityType,
  row: Record<string, unknown>,
): RecoveryLocalKey {
  switch (entityType) {
    case 'workItemLabel':
      return [
        requireLocalString(row, 'workItemId'),
        requireLocalString(row, 'labelId'),
      ]
    case 'workItemNote':
      return requireLocalString(row, 'noteId')
    case 'sessionTaskContext':
      return requireLocalString(row, 'sessionId')
    case 'focusSession':
      return requireLocalString(row, 'sessionId')
    case 'project':
    case 'note':
    case 'folder':
    case 'quickNote':
    case 'reflection':
    case 'habit':
    case 'habitCheckIn':
    case 'schedule':
    case 'timeBlock':
    case 'memoComment':
    case 'scheduleQuickNote':
    case 'statusDefinition':
    case 'typeDefinition':
    case 'label':
    case 'workItem':
    case 'sessionAttributionRevision':
    case 'sessionWorkItemPlan':
    case 'sessionWorkItemOutcome':
      return requireLocalString(row, 'id')
    default: {
      const exhaustive: never = entityType
      throw new Error(`Missing recovery local key projector: ${String(exhaustive)}`)
    }
  }
}

function sameRecoveryLocalKey(
  left: RecoveryLocalKey,
  right: RecoveryLocalKey,
): boolean {
  if (typeof left === 'string' || typeof right === 'string') return left === right
  return left[0] === right[0] && left[1] === right[1]
}

function isRecoveryLocalRowDirty(
  entityType: SyncEntityType,
  row: Record<string, unknown>,
): boolean {
  return entityType === 'workItemNote'
    ? row.syncState !== 'clean'
    : row._dirty === true
}

function prepareRecoverySnapshot(
  spaceId: string,
  records: readonly SnapshotEntityRecord[],
): Map<string, PreparedRecoveryEntity> {
  const prepared = new Map<string, PreparedRecoveryEntity>()
  for (const record of records) {
    if (!isFinalSyncEntityType(record.entity_type)) {
      throw new Error(`Recovery entity type is not in the final local catalog: ${record.entity_type}`)
    }
    const tableName = FINAL_SYNC_ENTITY_TO_TABLE[record.entity_type]
    const projected = projectRecoveryWirePayload(spaceId, record.entity_type, record.payload)
    const row: Record<string, unknown> = {
      ...projected,
      ...(Object.prototype.hasOwnProperty.call(projected, 'version')
        ? {} : { version: record.version }),
      ...(Object.prototype.hasOwnProperty.call(projected, 'updatedAt') ||
          Object.prototype.hasOwnProperty.call(projected, 'updated_at')
        ? {} : { updatedAt: record.updated_at }),
    }
    const projectedUpdatedAt = row.updatedAt ?? row.updated_at
    if ('spaceId' in row ||
        recoveryWireEntityIdFromLocalRow(record.entity_type, row) !== record.entity_id ||
        row.version !== record.version || projectedUpdatedAt !== record.updated_at) {
      throw new Error('Recovery wire/local identity, version, or timestamp binding mismatch')
    }
    const localKey = recoveryLocalKeyFromLocalRow(record.entity_type, row)
    const key = recoveryEntityKey(record.entity_type, record.entity_id)
    if (prepared.has(key)) throw new Error('Recovery snapshot contains a duplicate entity key')
    prepared.set(key, {
      key,
      entityType: record.entity_type,
      entityId: record.entity_id,
      version: record.version,
      tableName,
      localKey,
      row,
    })
  }
  return prepared
}

/** @internal terminal-transaction writer owned by recovery.ts. */
export async function applyAndReconcileRecoveryRecords(
  db: PomodoroXIDB,
  spaceId: string,
  token: SpaceAuthorityToken,
  records: readonly SnapshotEntityRecord[],
): Promise<RecoverySnapshotIndex> {
  requireSpaceAuthorityToken(token, spaceId)
  requireSpaceDatabaseBinding(db, spaceId)
  const prepared = prepareRecoverySnapshot(spaceId, records)
  const outboxRows = await db.outbox.toArray()
  if (outboxRows.some((row) => row.spaceId !== spaceId)) {
    throw new Error('Recovery observed cross-Space outbox authority')
  }
  const protectedKeys = new Set(outboxRows
    .filter((row) => !row.synced)
    .map((row) => recoveryEntityKey(row.entityType, row.entityId)))

  const existingByTable = new Map<RecoveryTableName, Record<string, unknown>[]>()
  for (const tableName of Object.values(FINAL_SYNC_ENTITY_TO_TABLE)) {
    const table = db.table<Record<string, unknown>, RecoveryLocalKey>(tableName)
    existingByTable.set(tableName, await table.toArray())
  }

  const putsByTable = new Map<RecoveryTableName, Record<string, unknown>[]>()
  for (const entity of prepared.values()) {
    const current = (existingByTable.get(entity.tableName) ?? []).find((row) =>
      sameRecoveryLocalKey(
        recoveryLocalKeyFromLocalRow(entity.entityType, row),
        entity.localKey,
      ))
    if (protectedKeys.has(entity.key) ||
        (current !== undefined && isRecoveryLocalRowDirty(entity.entityType, current))) continue
    const puts = putsByTable.get(entity.tableName) ?? []
    puts.push(entity.row)
    putsByTable.set(entity.tableName, puts)
  }

  const deletesByTable = new Map<RecoveryTableName, RecoveryLocalKey[]>()
  for (const [entityType, tableName] of Object.entries(FINAL_SYNC_ENTITY_TO_TABLE) as
      [SyncEntityType, RecoveryTableName][]) {
    const deletes: RecoveryLocalKey[] = []
    for (const row of existingByTable.get(tableName) ?? []) {
      const localKey = recoveryLocalKeyFromLocalRow(entityType, row)
      const entityId = recoveryWireEntityIdFromLocalRow(entityType, row)
      const key = recoveryEntityKey(entityType, entityId)
      if (!isRecoveryLocalRowDirty(entityType, row) &&
          !protectedKeys.has(key) && !prepared.has(key)) {
        deletes.push(localKey)
      }
    }
    deletesByTable.set(tableName, deletes)
  }

  // Every record, local key, protected key, and delete candidate is validated above.
  // No mutation occurs before this point.
  for (const [tableName, rows] of putsByTable) {
    if (rows.length) {
      await db.table<Record<string, unknown>, RecoveryLocalKey>(tableName).bulkPut(rows)
    }
  }
  for (const [tableName, keys] of deletesByTable) {
    if (keys.length) {
      await db.table<Record<string, unknown>, RecoveryLocalKey>(tableName).bulkDelete(keys)
    }
  }
  return prepared
}

/** @internal terminal-transaction writer owned by recovery.ts. */
export async function rebaseLegacyOutboxAgainstRecovery(
  db: PomodoroXIDB,
  spaceId: string,
  token: SpaceAuthorityToken,
  snapshot: RecoverySnapshotIndex,
): Promise<void> {
  requireSpaceAuthorityToken(token, spaceId)
  requireSpaceDatabaseBinding(db, spaceId)
  const candidates = await db.outbox
    .filter((row) => !row.synced && row.requiresVersionRebase).toArray()
  const currentRows = await db.outbox.bulkGet(candidates.map((row) => row.id!))
  const updates: { id: number; expectedVersion: number; operationId: string }[] = []
  for (let index = 0; index < candidates.length; index += 1) {
    const row = candidates[index]!
    const current = currentRows[index]
    if (row.id === undefined || current === undefined ||
        row.spaceId !== spaceId || current.spaceId !== spaceId ||
        canonicalize(current) !== canonicalize(row)) {
      throw new Error('Recovery rebase candidate changed inside the terminal transaction')
    }
    if (row.transportState === 'blocked_conflict') continue
    if (row.action === 'create' || row.expectedVersion !== null ||
        row.attemptCount !== 0 || row.compoundOperationId !== null ||
        row.compoundOrder !== null ||
        (row.transportState !== 'ready' && row.transportState !== 'awaiting_s4')) {
      throw new Error('Recovery rebase candidate has invalid immutable authority')
    }
    const authoritative = snapshot.get(recoveryEntityKey(row.entityType, row.entityId))
    if (!authoritative) continue
    if (!Number.isSafeInteger(authoritative.version) || authoritative.version < 0) {
      throw new Error('Recovery rebase base version is invalid')
    }
    updates.push({
      id: row.id,
      expectedVersion: authoritative.version,
      operationId: crypto.randomUUID(),
    })
  }

  // Missing bases intentionally remain blocked with their prior operation identity.
  for (const update of updates) {
    await db.outbox.update(update.id, {
      expectedVersion: update.expectedVersion,
      operationId: update.operationId,
      requiresVersionRebase: false,
      transportState: 'awaiting_s4',
      synced: false,
      lastError: null,
      lastErrorCode: null,
      failedAt: null,
      attemptCount: 0,
    } satisfies Partial<OutboxEvent>)
  }
}

export async function runFullRecovery(
  db: PomodoroXIDB,
  api: AxiosInstance,
  spaceId: string,
  clientId: string,
  token: SpaceAuthorityToken,
): Promise<void> {
  requireSpaceAuthorityToken(token, spaceId)
  requireSpaceDatabaseBinding(db, spaceId)
  let state = await db.syncRecoveryState.get('active')
  if (state && (state.spaceId !== spaceId || state.clientId !== clientId)) {
    throw new Error('Recovery state belongs to another Space or sync client')
  }
  let restartedExpiredGeneration = false
  while (!state || state.state === 'downloading') {
    let response: AxiosResponse<ApiSyncV2RecoveryResponse>
    try {
      response = await syncV2Recover(api, {
        client_id: clientId,
        page_token: state?.nextPageToken ?? undefined,
      })
    } catch (error: unknown) {
      if (!isRecoveryGenerationInvalid(error) || restartedExpiredGeneration) throw error
      const staleRecoveryId = state?.recoveryId
      await db.transaction('rw', db.syncRecoveryState, db.syncRecoveryChunks, async () => {
        requireSpaceAuthorityToken(token, spaceId)
        if (staleRecoveryId) {
          await db.syncRecoveryChunks.where('recoveryId').equals(staleRecoveryId).delete()
        }
        await db.syncRecoveryState.delete('active')
      })
      state = undefined
      restartedExpiredGeneration = true
      continue
    }
    assertRecoveryTokenProgress(
      state?.nextPageToken ?? null,
      response.data,
    )
    const payloadBytes = decodeCanonicalStandardBase64(
      response.data.payload_jsonl_base64,
    )
    await verifyChunkSha256(payloadBytes, response.data.chunk_sha256)
    const records = parseCanonicalJsonLines(payloadBytes)
    if (records.length !== response.data.entity_count) {
      throw new Error('Recovery entity count mismatch')
    }
    const recoveryId = state?.recoveryId ?? crypto.randomUUID()
    if (state && (
      response.data.catalog_hash !== state.catalogHash ||
      response.data.waterline_cursor !== state.waterlineCursor
    )) {
      throw new Error('Recovery page bindings changed')
    }
    await db.transaction('rw', db.syncRecoveryState, db.syncRecoveryChunks, async () => {
      requireSpaceAuthorityToken(token, spaceId)
      await db.syncRecoveryChunks.put({
        spaceId,
        recoveryId,
        index: state?.nextChunkIndex ?? 0,
        sha256: response.data.chunk_sha256,
        entityCount: response.data.entity_count,
        payloadJsonlBase64: response.data.payload_jsonl_base64,
        pageTokenUsed: state?.nextPageToken ?? null,
        nextPageToken: response.data.next_page_token,
        hasMore: response.data.has_more,
        catalogHash: response.data.catalog_hash,
        waterlineCursor: response.data.waterline_cursor,
      })
      await db.syncRecoveryState.put({
        key: 'active',
        spaceId,
        recoveryId,
        clientId,
        nextPageToken: response.data.next_page_token,
        catalogHash: response.data.catalog_hash,
        waterlineCursor: response.data.waterline_cursor,
        nextChunkIndex: (state?.nextChunkIndex ?? 0) + 1,
        state: response.data.has_more ? 'downloading' : 'ready',
      })
    })
    state = await db.syncRecoveryState.get('active')
  }

  await db.transaction('rw', db.tables, async () => {
    requireSpaceAuthorityToken(token, spaceId)
    const chunks = await db.syncRecoveryChunks.where('recoveryId').equals(state.recoveryId).sortBy('index')
    const records = await Dexie.waitFor(
      validateCompleteStagedRecovery(spaceId, state, chunks))
    const snapshot = await applyAndReconcileRecoveryRecords(
      db, spaceId, token, records)
    await rebaseLegacyOutboxAgainstRecovery(db, spaceId, token, snapshot)
    await persistSyncV2MetaInCurrentTransaction(db, spaceId, token, {
      cursor: state.waterlineCursor,
      pendingAck: state.waterlineCursor,
      catalogHash: state.catalogHash,
      requiresFullRecovery: true,
    })
    await db.syncRecoveryChunks.where('recoveryId').equals(state.recoveryId).delete()
    await db.syncRecoveryState.delete('active')
  })
  await sendPendingAck(db, api, spaceId, clientId, token)
}
```

```typescript
function assertRecoveryTokenProgress(
  pageTokenUsed: string | null,
  page: ApiSyncV2RecoveryResponse,
): void {
  if (page.has_more) {
    if (page.next_page_token === null || page.next_page_token === pageTokenUsed) {
      throw new Error('Recovery token did not advance')
    }
    return
  }
  if (page.next_page_token !== null) {
    throw new Error('Terminal recovery page has a continuation token')
  }
}
```

`isRecoveryGenerationInvalid()` accepts only a canonical `cursor_expired` or server-declared `snapshot_invalid` record whose details say `recovery_action="full_recovery"`; backend corruption handling always emits that fixed detail to declare the persisted generation unusable. It never treats a timeout, 5xx, malformed response, client-local hash/parse failure, token no-progress, or arbitrary 409 as supersession. The one-restart guard prevents an invalid empty-generation loop. Discarding a superseded generation touches only `syncRecoveryState`/`syncRecoveryChunks`, never live entity/outbox stores. `syncV2Recover()` first applies the strict recovery response parser, then `assertRecoveryTokenProgress()` runs before base64 decode or any staging write: every nonfinal page has one nonnull token different from the token just used, and every final page has null. `decodeBase64Strict()` rejects malformed/padded variants outside the generated contract. `verifyChunkSha256()` hashes the decoded bytes, never parsed or reserialized objects; only after a match may `parseCanonicalJsonLines()` validate UTF-8 and the exact `SnapshotEntityRecord` shape.

`validateCompleteStagedRecovery()` runs inside the terminal transaction before its first write. It requires exact `spaceId` on state and every chunk, `chunks.length === state.nextChunkIndex`, exact indices `0..n-1`, first `pageTokenUsed=null`, every later token equal to the prior `nextPageToken`, all nonfinal pages `hasMore=true` with a nonnull next token, the final page `hasMore=false` with null next token, and every chunk catalog/waterline equal to state. It re-decodes, rehashes, reparses, and re-counts every stored chunk; primary key/version/type rules are rechecked. WebCrypto work inside the live Dexie transaction is always wrapped in `Dexie.waitFor(...)`; no raw external promise may auto-commit it. Empty recovery uses the explicit zero-page contract. Missing, duplicate, reordered, locally corrupted, cross-Space, or binding-mismatched chunks throw before entity/cursor/outbox mutation, retain inert staging, and leave the old live snapshot intact. A real Dexie/IndexedDB test runs multi-chunk hashing plus cutover and asserts no `PrematureCommitError` and one atomic commit.

`applyAndReconcileRecoveryRecords()` is the sole recovery live-table writer. Its production body resolves only exact `FINAL_SYNC_ENTITY_TO_TABLE` entries and uses an exhaustive 22-key projector: ten retained LWW payloads pass `parseFinalSyncEntityPostImage`, while twelve Task Space/FocusSession payloads use their strict contract schemas. `response-schema.ts` owns the retained ten-branch parser and its generated-schema imports; pull and recovery share it, and no raw wire object reaches Dexie. Wire rows carrying `spaceId` are exact-checked then stripped; camelCase local timestamps and fields are preserved, WorkItemNote receives explicit `localRevision=0`/`syncState='clean'`. Wire `entity_id` is validated separately from the explicitly projected local key: twenty-one entity types use their string key while `workItemLabel` uses the ordered `[workItemId,labelId]` Dexie key. Lookup and deletion compare those keys structurally and never depend on private/nonexistent Dexie schema helpers. The helper snapshots every local table and same-Space unsynced outbox key before its first write, rejects cross-Space authority, treats a WorkItemNote with non-clean `syncState` (and any other row with `_dirty=true`) as dirty, preserves every dirty/outbox-protected row, and deletes only clean rows whose projected wire identity is absent from the complete snapshot. It returns the exact prepared index consumed by `rebaseLegacyOutboxAgainstRecovery()` in the same terminal transaction. Rebase accepts only a same-Space unattempted standalone update/delete with `requiresVersionRebase=true`, `expectedVersion=null`, and transport state `ready|awaiting_s4`; `blocked_conflict` and terminal states can never be released by recovery. An exact authoritative nonnegative version produces a fresh `operationId`, that `expectedVersion`, cleared error fields, and `awaiting_s4`. A missing base remains blocked with its old ID; malformed candidate/base authority aborts the entire cutover, and an already-known base is never rewritten. A crash before the terminal transaction exposes all-old; IndexedDB commit exposes all-new plus rebased outbox rows and durable pending ACK. Both exported writers require `(spaceId, token)` and have no optional/tokenless overload.

- [ ] **Step 6: Make incremental pull persist-before-ACK and recovery-before-push**

`transport.ts` defines `SYNC_V2_ERROR_ACCEPT = 'application/vnd.pomodoroxii.error+json;version=2'` and one `syncV2RequestConfig(config)` built with `AxiosHeaders.from(config.headers)` before forcing `Accept`; caller params, `Idempotency-Key`, cancellation signal and retry metadata survive. Its exported `syncV2QueryOperations`, `syncV2Push`, `syncV2Pull`, `syncV2Recover`, `syncV2Ack`, and `syncV2Status` are the only official-client `/sync/v2/*` URL owners. `syncV2QueryOperations` posts to `/api/v1/sync/v2/operations/query` and passes the requested ordered IDs into the strict response parser. A static test rejects any direct `/sync/v2/` request outside `transport.ts`/tests. Axios 401/Cloudflare retries reuse the merged config, so the Accept header survives every retry.

`runPullLoop(db, api, spaceId, clientId, token, options?)` requires a live
same-Space `SpaceAuthorityToken` before its first read, revalidates it inside
every live-row/syncMeta transaction, and passes it unchanged to
`applySyncEventRecord`, `persistSyncV2MetaInCurrentTransaction`, full recovery,
and `sendPendingAck`. It never acquires the non-reentrant Web Lock itself. Before
a pull page enters its Dexie transaction it calls the strict pull parser and this
progress guard:

```typescript
function assertPullProgress(
  requestedCursor: string | null,
  page: ApiSyncV2PullResponse,
): void {
  if (page.has_more && page.events.length === 0) {
    throw new Error('Pull page claims more events without a record')
  }
  if ((page.has_more || page.events.length > 0) && page.next_cursor === requestedCursor) {
    throw new Error('Pull cursor did not advance')
  }
}
```

An invalid/no-progress page changes no live rows, cursor, or pending ACK and sends no ACK. An empty terminal page may echo the current opaque cursor; a nonempty page or any `has_more=true` page must advance it.

Set one official constant `SYNC_V2_PULL_LIMIT = 500`; remove the old `DEFAULT_PULL_LIMIT = 1000`. An optional caller override is accepted only by the same strict `1..500` validator, otherwise omit the query and use the server default. For each incremental page, parse raw `response.data`, assert pull progress against the requested cursor, then let one Dexie transaction call token-bound `applySyncEventRecord()` in response order and `persistSyncV2MetaInCurrentTransaction()` with `next_cursor` plus identical `pendingAck`; only after commit may token-bound `sendPendingAck()` call parsed `syncV2Ack`. `applySyncEventRecord()` consumes the complete v2 record: clean create/update writes the authoritative payload/version, clean delete removes/tombstones by top-level entity ID, while a local dirty/outbox entity is preserved and receives deterministic conflict metadata. It never keys on an internal snake_case entity name. `sendPendingAck()` compare-and-clears only if the durable pending value is still the acknowledged token. On startup, retry `pendingAck` before requesting a later page. Missing v2 protocol state sets `requiresFullRecovery=true` and enters token-bound full recovery without sending an invented cursor. Operation-query/pull/recovery/ACK/status all use the corresponding shared transport function and runtime parser. On `cursor_expired`, run full recovery. `engine.runSyncCycle()` acquires one fence, passes its token through admission/recovery/ACK/pull/push, and returns before `pushAllPendingUnderFence()` when any predecessor fails.

For push, one fenced authority unit is frozen, queried, and either settled from durable evidence or sent with its original authority. The dependency direction is fixed as `authority-identity.ts <- admission.ts|terminal-application.ts <- push-batch.ts`: the shared authority module imports neither coordinator, and `terminal-application.ts` never imports `push-batch.ts`. No string-matching classifier is permitted.

```typescript
// frontend/src/lib/sync/types.ts
export const RETAINED_LWW_SYNC_ENTITY_TYPES = [
  'note', 'folder', 'quickNote', 'reflection', 'habit', 'habitCheckIn',
  'schedule', 'timeBlock', 'memoComment', 'scheduleQuickNote',
] as const
export type RetainedLwwSyncEntityType =
  typeof RETAINED_LWW_SYNC_ENTITY_TYPES[number]

export const FINAL_SYNC_ENTITY_TYPES = [
  ...RETAINED_LWW_SYNC_ENTITY_TYPES,
  'project', 'statusDefinition', 'typeDefinition', 'label', 'workItemLabel',
  'workItem', 'workItemNote', 'focusSession', 'sessionTaskContext',
  'sessionAttributionRevision', 'sessionWorkItemPlan', 'sessionWorkItemOutcome',
] as const

export type SyncEntityType = typeof FINAL_SYNC_ENTITY_TYPES[number]
export const FINAL_SYNC_ENTITY_TYPE_SET = new Set<string>(FINAL_SYNC_ENTITY_TYPES)
export const FINAL_SYNC_ENTITY_TO_TABLE = {
  note: 'notes', folder: 'folders', quickNote: 'quickNotes',
  reflection: 'reflections', habit: 'habits', habitCheckIn: 'habitCheckIns',
  schedule: 'schedules', timeBlock: 'timeBlocks', memoComment: 'memoComments',
  scheduleQuickNote: 'scheduleQuickNotes',
  ...TS3_LOCAL_ENTITY_TO_TABLE,
} as const satisfies Record<SyncEntityType, string>

type MissingFinalSyncType = Exclude<
  SyncEntityType, keyof typeof FINAL_SYNC_ENTITY_TO_TABLE
>
type ExtraFinalSyncType = Exclude<
  keyof typeof FINAL_SYNC_ENTITY_TO_TABLE, SyncEntityType
>
export const FINAL_SYNC_ENTITY_MAP_IS_EXACT:
  MissingFinalSyncType extends never
    ? (ExtraFinalSyncType extends never ? true : never)
    : never = true
```

The frontend final Sync union is the ten retained LWW keys plus the twelve
Task Space/FocusSession keys. It excludes removed `task`, `session`,
`taskQuickNote`, and `sessionQuickNote`, and is byte-compared in generated
fixtures against TS0 catalog version 2's `list_sync_enabled()` output. Registry
count 31 is not misused as the Sync-enabled count.

`entity-payload-hash.ts` owns the frontend's one exhaustive final-catalog hash
dispatch. `taskSpaceEntityBusinessPayloadForHash` covers `project`,
`statusDefinition`, `typeDefinition`, `label`, `workItemLabel`, `workItem`, and
`workItemNote`; `focusSessionEntityBusinessPayloadForHash` covers
`focusSession`, `sessionTaskContext`, `sessionAttributionRevision`,
`sessionWorkItemPlan`, and `sessionWorkItemOutcome`. The ten retained LWW keys
use an equally exhaustive switch over their already-stripped command post-image.
All paths accept the action plus strict parsed post-image. An exact union/map
compile-time assertion and one vector per key/action prevent a missing key or
generic recursive converter.

The hash dispatcher consumes only TS3's exported strict command-post-image
schemas. It does not parse a FocusSession API/cache row and does not parse a
recovery snapshot. The FocusSession command shape has canonical `id`, complete
system timestamps/version, `overallProgress` and `mood`, and no `spaceId` or
derived `clockState`; the four child command shapes preserve their real `id`.
Authoritative recovery instead uses the five `*RecoveryWireSchema` values and
their dedicated local-key projectors. A test that adds `clockState` to an outbox
payload must fail before hashing, while the corresponding recovery fixture must
derive the same local clock from `endedAt/pauseStartedAt`.

The two domain contract modules own concrete full-business projections rather
than merely exporting names for `entity-payload-hash.ts` to call:

```typescript
// append to frontend/src/lib/contracts/task-space.ts
import type { JsonValue } from './payload-hash'
import type { OutboxAction, SyncEntityType } from '@/lib/sync/types'

type TaskSpaceSyncEntityType = Extract<SyncEntityType,
  'project' | 'statusDefinition' | 'typeDefinition' | 'label' |
  'workItemLabel' | 'workItem' | 'workItemNote'>

const cachedProjectSchema = projectSchema.omit({ spaceId: true })
const cachedStatusDefinitionSchema = statusDefinitionSchema.omit({ spaceId: true })
const cachedTypeDefinitionSchema = typeDefinitionSchema.omit({ spaceId: true })
const cachedLabelSchema = labelSchema.omit({ spaceId: true })
const cachedWorkItemLabelSchema = workItemLabelSchema.omit({ spaceId: true })
const cachedWorkItemSchema = workItemSchema.omit({ spaceId: true })
const cachedWorkItemNoteSchema = workItemNoteSchema.omit({ spaceId: true })
const genericDeleteSchema = z.strictObject({ id: entityId })

export function taskSpaceEntityBusinessPayloadForHash(
  entityType: TaskSpaceSyncEntityType,
  action: OutboxAction,
  postImage: JsonValue,
): JsonValue {
  if (action === 'delete') return genericDeleteSchema.parse(postImage)
  switch (entityType) {
    case 'project': {
      const row = cachedProjectSchema.parse(postImage)
      return {
        name: row.name, key: row.key, description: row.description,
        next_work_item_number: row.nextWorkItemNumber,
        rank: row.rank, archived_at: row.archivedAt,
      }
    }
    case 'statusDefinition': {
      const row = cachedStatusDefinitionSchema.parse(postImage)
      return {
        category: row.category, name: row.name, icon: row.icon, color: row.color,
        rank: row.rank, system: row.system, archived_at: row.archivedAt,
      }
    }
    case 'typeDefinition': {
      const row = cachedTypeDefinitionSchema.parse(postImage)
      return {
        name: row.name, icon: row.icon, color: row.color, rank: row.rank,
        system: row.system, archived_at: row.archivedAt,
      }
    }
    case 'label': {
      const row = cachedLabelSchema.parse(postImage)
      return { name: row.name, color: row.color, archived_at: row.archivedAt }
    }
    case 'workItemLabel': {
      const row = cachedWorkItemLabelSchema.parse(postImage)
      return { work_item_id: row.workItemId, label_id: row.labelId }
    }
    case 'workItem': {
      const row = cachedWorkItemSchema.parse(postImage)
      return {
        project_id: row.projectId, display_key: row.displayKey,
        title: row.title, description: row.description,
        type_definition_id: row.typeDefinitionId,
        status_definition_id: row.statusDefinitionId,
        priority: row.priority, parent_id: row.parentId, child_rank: row.childRank,
        depth: row.depth, completion_window_start: row.completionWindowStart,
        completion_window_end: row.completionWindowEnd,
        review_point: row.reviewPoint, hard_deadline: row.hardDeadline,
        effort_estimate_lower_seconds: row.effortEstimateLowerSeconds,
        effort_estimate_upper_seconds: row.effortEstimateUpperSeconds,
        effort_actual_seconds: row.effortActualSeconds, confidence: row.confidence,
        completed_at: row.completedAt, cancelled_at: row.cancelledAt,
        archived_at: row.archivedAt, marked_as_attention: row.markedAsAttention,
      }
    }
    case 'workItemNote': {
      const row = cachedWorkItemNoteSchema.parse(postImage)
      return { document: row.document }
    }
    default: {
      const exhaustive: never = entityType
      throw new Error(`missing Task Space hash builder: ${String(exhaustive)}`)
    }
  }
}
```

```typescript
// append to frontend/src/lib/contracts/focus-session.ts; move the TS3 local*
// projection helpers here and import them back into focus-session-repository.ts.
import type { JsonValue } from './payload-hash'
import type { OutboxAction, SyncEntityType } from '@/lib/sync/types'

type FocusSessionSyncEntityType = Extract<SyncEntityType,
  'focusSession' | 'sessionTaskContext' | 'sessionAttributionRevision' |
  'sessionWorkItemPlan' | 'sessionWorkItemOutcome'>

const focusDeleteSchema = z.strictObject({ id })

export const focusSessionBusinessPostImage = (
  row: z.infer<typeof focusSessionCommandPostImageSchema>,
): JsonValue => ({
  session_revision: row.sessionRevision, started_at: row.startedAt,
  ended_at: row.endedAt, pause_started_at: row.pauseStartedAt,
  planned_seconds: row.plannedSeconds, gross_seconds: row.grossSeconds,
  paused_seconds: row.pausedSeconds, break_seconds: row.breakSeconds,
  focused_seconds: row.focusedSeconds, timer_completion: row.timerCompletion,
  validity: row.validity, validity_reason: row.validityReason,
  overall_progress: row.overallProgress, mood: row.mood,
  review_state: row.reviewState, ownership_state: row.ownershipState,
  session_note: row.sessionNote,
})

export const sessionTaskContextBusinessPostImage =
  (row: z.infer<typeof sessionTaskContextCommandPostImageSchema>): JsonValue => ({
    session_id: row.sessionId, project_id: row.projectId,
    level2_work_item_id: row.level2WorkItemId,
    project_title_snapshot: row.projectTitleSnapshot,
    level2_title_snapshot: row.level2TitleSnapshot,
    level2_parent_id_snapshot: row.level2ParentIdSnapshot,
    level2_status_definition_id_snapshot: row.level2StatusDefinitionIdSnapshot,
    level2_version_snapshot: row.level2VersionSnapshot,
    level2_effort_lower_seconds_snapshot: row.level2EffortLowerSecondsSnapshot,
    level2_effort_upper_seconds_snapshot: row.level2EffortUpperSecondsSnapshot,
    linked_at: row.linkedAt, link_method: row.linkMethod,
  })

export const sessionAttributionBusinessPostImage =
  (row: z.infer<typeof sessionAttributionRevisionCommandPostImageSchema>): JsonValue => ({
    session_id: row.sessionId, revision: row.revision, project_id: row.projectId,
    level2_work_item_id: row.level2WorkItemId, reason: row.reason,
    corrected_from_revision: row.correctedFromRevision,
    effective: row.effective, created_at: row.createdAt,
  })

export const sessionPlanBusinessPostImage =
  (row: z.infer<typeof sessionWorkItemPlanCommandPostImageSchema>): JsonValue => ({
    session_id: row.sessionId, work_item_id: row.workItemId,
    title_snapshot: row.titleSnapshot,
    level2_work_item_id_snapshot: row.level2WorkItemIdSnapshot,
    work_item_version_snapshot: row.workItemVersionSnapshot,
    plan_rank: row.planRank, source: row.source, added_at: row.addedAt,
    removed_at: row.removedAt, removal_reason: row.removalReason,
    current_during_session: row.currentDuringSession,
    completion_draft: row.completionDraft,
  })

export const sessionOutcomeBusinessPostImage =
  (row: z.infer<typeof sessionWorkItemOutcomeCommandPostImageSchema>): JsonValue => ({
    session_id: row.sessionId, session_revision: row.sessionRevision,
    revision: row.revision, corrected_from_revision: row.correctedFromRevision,
    effective: row.effective, work_item_id: row.workItemId, touched: row.touched,
    result: row.result, execution_persona: row.executionPersona,
    persona_switched: row.personaSwitched, persona_note: row.personaNote,
    state_command: row.stateCommand,
    command_id: row.commandId, reviewed_at: row.reviewedAt,
  })

export function focusSessionEntityBusinessPayloadForHash(
  entityType: FocusSessionSyncEntityType,
  action: OutboxAction,
  postImage: JsonValue,
): JsonValue {
  if (action === 'delete') return focusDeleteSchema.parse(postImage)
  switch (entityType) {
    case 'focusSession':
      return focusSessionBusinessPostImage(
        focusSessionCommandPostImageSchema.parse(postImage))
    case 'sessionTaskContext':
      return sessionTaskContextBusinessPostImage(
        sessionTaskContextCommandPostImageSchema.parse(postImage))
    case 'sessionAttributionRevision':
      return sessionAttributionBusinessPostImage(
        sessionAttributionRevisionCommandPostImageSchema.parse(postImage))
    case 'sessionWorkItemPlan':
      return sessionPlanBusinessPostImage(
        sessionWorkItemPlanCommandPostImageSchema.parse(postImage))
    case 'sessionWorkItemOutcome':
      return sessionOutcomeBusinessPostImage(
        sessionWorkItemOutcomeCommandPostImageSchema.parse(postImage))
    default: {
      const exhaustive: never = entityType
      throw new Error(`missing FocusSession hash builder: ${String(exhaustive)}`)
    }
  }
}
```

```typescript
// frontend/src/lib/sync/entity-payload-hash.ts
import { hashCommandPayload, type JsonValue } from '@/lib/contracts/payload-hash'
import { taskSpaceEntityBusinessPayloadForHash } from '@/lib/contracts/task-space'
import { focusSessionEntityBusinessPayloadForHash } from '@/lib/contracts/focus-session'
import {
  RETAINED_LWW_SYNC_ENTITY_TYPES,
  type OutboxAction, type SyncEntityType,
} from './types'
import {
  parseIJsonTextRejectingDuplicateKeys, parseRetainedLwwOutboxPostImage,
  validateIJsonGraph,
} from './response-schema'

const TASK_SPACE_KEY_LIST = [
  'project', 'statusDefinition', 'typeDefinition', 'label', 'workItemLabel',
  'workItem', 'workItemNote',
] as const satisfies readonly SyncEntityType[]
const FOCUS_SESSION_KEY_LIST = [
  'focusSession', 'sessionTaskContext', 'sessionAttributionRevision',
  'sessionWorkItemPlan', 'sessionWorkItemOutcome',
] as const satisfies readonly SyncEntityType[]
const RETAINED_LWW_KEY_LIST = [
  ...RETAINED_LWW_SYNC_ENTITY_TYPES,
] as const satisfies readonly SyncEntityType[]
const TASK_SPACE_KEYS = new Set<SyncEntityType>(TASK_SPACE_KEY_LIST)
const FOCUS_SESSION_KEYS = new Set<SyncEntityType>(FOCUS_SESSION_KEY_LIST)
const RETAINED_LWW_KEYS = new Set<SyncEntityType>(RETAINED_LWW_KEY_LIST)
const ALL_HASH_KEYS = [
  ...RETAINED_LWW_KEY_LIST, ...TASK_SPACE_KEY_LIST, ...FOCUS_SESSION_KEY_LIST,
] as const
type MissingHashKey = Exclude<SyncEntityType, typeof ALL_HASH_KEYS[number]>
type ExtraHashKey = Exclude<typeof ALL_HASH_KEYS[number], SyncEntityType>
const ALL_HASH_KEYS_ARE_EXACT:
  MissingHashKey extends never ? (ExtraHashKey extends never ? true : never) : never = true
void ALL_HASH_KEYS_ARE_EXACT

function retainedLwwBusinessPayloadForHash(
  entityType: SyncEntityType,
  action: OutboxAction,
  postImage: JsonValue,
): JsonValue {
  switch (entityType) {
    case 'note':
    case 'folder':
    case 'quickNote':
    case 'reflection':
    case 'habit':
    case 'habitCheckIn':
    case 'schedule':
    case 'timeBlock':
    case 'memoComment':
    case 'scheduleQuickNote':
      return parseRetainedLwwOutboxPostImage(entityType, action, postImage)
    default:
      throw new Error(`not a retained LWW Sync key: ${entityType}`)
  }
}

export function parsePersistedOutboxPayload(raw: string): JsonValue {
  const parsed = parseIJsonTextRejectingDuplicateKeys(raw)
  validateIJsonGraph(parsed)
  return parsed
}

export async function recomputeEntityBusinessPayloadHash(
  entityType: SyncEntityType,
  action: OutboxAction,
  postImage: JsonValue,
): Promise<string> {
  const businessPayload = TASK_SPACE_KEYS.has(entityType)
    ? taskSpaceEntityBusinessPayloadForHash(entityType, action, postImage)
    : FOCUS_SESSION_KEYS.has(entityType)
      ? focusSessionEntityBusinessPayloadForHash(entityType, action, postImage)
      : RETAINED_LWW_KEYS.has(entityType)
        ? retainedLwwBusinessPayloadForHash(entityType, action, postImage)
        : (() => { throw new Error(`unregistered Sync hash builder: ${entityType}`) })()
  return hashCommandPayload(businessPayload)
}
```

`parseIJsonTextRejectingDuplicateKeys` and `validateIJsonGraph` are the same
frontend strict JSON primitives used by persisted receipt validation. They
reject duplicate names, trailing text, nonfinite/unsafe numbers, lone
surrogates, and non-JSON values before a hash builder runs. Tests prove that a
WorkItemNote full post-image freezes byte-for-byte while its recomputed business
hash is only `{document}`, and that a schedule/LWW entity uses its own explicit
business fields. Replacing either with `SHA256(canonical(postImage))` is a
required negative mutation.

`authority-identity.ts` owns the complete immutable identity and receipt-validation implementation:

```typescript
// frontend/src/lib/sync/authority-identity.ts
import Dexie from 'dexie'
import { canonicalize } from 'json-canonicalize'
import type {
  FrozenOutboxIdentity, PomodoroXIDB, ReadyRootIdentity, SyncPendingPushBatch,
  SyncTerminalApplicationEvidence,
} from '@/services/database'
import type { OutboxEvent } from '@/types'
import type { ApiSyncV2Event, ApiSyncV2PushResponse } from './types'
import { prepareHeldProvisionalBatch } from './outbox'
import {
  parsePersistedOutboxPayload, recomputeEntityBusinessPayloadHash,
} from './entity-payload-hash'
import {
  parseIJsonTextRejectingDuplicateKeys, parseSyncV2PushResponse,
  requireCanonicalStoredTimestamp,
} from './response-schema'
import {
  requireSpaceAuthorityToken, requireSpaceDatabaseBinding,
  type SpaceAuthorityToken,
} from './space-authority-fence'
import { SYNC_V2_ERROR_ACCEPT } from './transport'

export type RecoverableAuthorityDriftCode = 'new_complete_paired_root'

export class PushAuthorityDriftError extends Error {
  constructor(readonly code: RecoverableAuthorityDriftCode) { super(code) }
}

export class PushAuthorityIntegrityError extends Error {
  constructor(readonly code: string) { super(code) }
}

export type PushAuthority =
  | {
      kind: 'compound'
      batchId: string
      compoundOperationId: string
      orderedOperationIds: readonly string[]
    }
  | {
      kind: 'direct_note_retry' | 'standalone_batch'
      batchId: string
      compoundOperationId: null
      orderedOperationIds: readonly string[]
    }

export interface PushSelection {
  authority: PushAuthority
  operationIds: readonly string[]
  frozenRows: readonly FrozenOutboxIdentity[]
  readyRoots: readonly ReadyRootIdentity[]
  readyRootSetSha256: string
}

export const FROZEN_OUTBOX_IDENTITY_KEYS = [
  'durableKey', 'spaceId', 'entityType', 'entityId', 'action', 'payloadCanonicalBase64',
  'payloadHash', 'operationId', 'retryPredecessorOperationId',
  'expectedVersion', 'createdAt', 'transportState',
  'compoundOperationId', 'compoundOrder', 'attemptCount',
] as const satisfies readonly (keyof FrozenOutboxIdentity)[]
type MissingFrozenKey = Exclude<
  keyof FrozenOutboxIdentity, typeof FROZEN_OUTBOX_IDENTITY_KEYS[number]
>
export const ALL_FROZEN_KEYS_ARE_LISTED: MissingFrozenKey extends never ? true : never = true

export function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

export function decodeCanonicalBase64(value: string): Uint8Array {
  let binary: string
  try { binary = atob(value) } catch { throw new PushAuthorityIntegrityError('invalid_base64') }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  if (encodeBase64(bytes) !== value) {
    throw new PushAuthorityIntegrityError('noncanonical_base64')
  }
  return bytes
}

export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digestInput = new Uint8Array(bytes.byteLength)
  digestInput.set(bytes)
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', digestInput.buffer),
  )
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function sha256Utf8(value: string): Promise<string> {
  return sha256HexBytes(new TextEncoder().encode(value))
}

// Test fixtures and production receipt code use this one UTF-8 string helper.
export const sha256Hex = sha256Utf8

export async function sha256Canonical(value: unknown): Promise<string> {
  const canonical = canonicalize(value)
  if (canonical === undefined) {
    throw new PushAuthorityIntegrityError('canonical_json_unsupported')
  }
  return sha256HexBytes(new TextEncoder().encode(canonical))
}

/** @internal Shared Sync invariant; not exported from the public barrel. */
export function deterministicTerminalNextAttempt(
  attemptCount: number,
  terminalizedAt: string,
): string {
  const base = Date.parse(requireCanonicalStoredTimestamp(terminalizedAt))
  if (!Number.isFinite(base) || !Number.isSafeInteger(attemptCount) || attemptCount < 0) {
    throw new PushAuthorityIntegrityError('terminal_retry_schedule_input_invalid')
  }
  const delaySeconds = Math.min(3600, 2 ** Math.min(attemptCount, 10))
  return requireCanonicalStoredTimestamp(
    new Date(base + delaySeconds * 1000).toISOString(),
  )
}

/** @internal Shared Sync invariant; not exported from the public barrel. */
export async function parseAndValidateTerminalEvidenceResult(
  evidence: SyncTerminalApplicationEvidence,
): Promise<ApiSyncV2PushResponse> {
  requireCanonicalStoredTimestamp(evidence.committedAt)
  if (evidence.metaReconciledAt !== null) {
    requireCanonicalStoredTimestamp(evidence.metaReconciledAt)
  }
  const children = evidence.readyRoots.flatMap((root) => root.orderedChildren)
  const childOperationIds = children.map((child) => child.operationId)
  const rootIds = evidence.readyRoots.map((root) => root.rootId)
  const identity = {
    spaceId: evidence.spaceId, batchId: evidence.batchId,
    authorityKind: evidence.authorityKind,
    readyRootSetSha256: evidence.readyRootSetSha256,
    operationIds: evidence.operationIds,
    operationIdsSha256: evidence.operationIdsSha256,
    resultSha256: evidence.resultSha256,
  }
  const directRoot = evidence.readyRoots.length === 1
    ? evidence.readyRoots[0] : undefined
  const authorityShapeValid = evidence.authorityKind === 'compound'
    ? evidence.compoundOperationId !== null &&
      evidence.batchId === evidence.compoundOperationId &&
      evidence.readyRoots.length === 1 && directRoot?.rootKind === 'compound' &&
      directRoot.rootId === evidence.compoundOperationId
    : evidence.authorityKind === 'direct_note_retry'
      ? evidence.compoundOperationId === null && evidence.operationIds.length === 1 &&
        evidence.batchId === evidence.operationIds[0] &&
        directRoot?.rootKind === 'standalone' &&
        directRoot.orderedChildren.length === 1 &&
        directRoot.orderedChildren[0]!.entityType === 'workItemNote' &&
        directRoot.orderedChildren[0]!.attemptCount > 0
      : evidence.authorityKind === 'standalone_batch' &&
        evidence.compoundOperationId === null &&
        evidence.batchId === await sha256Utf8(evidence.operationIds.join('\n'))
  if (!authorityShapeValid ||
      !['operation_query', 'push_response'].includes(evidence.source) ||
      !['space_committed', 'meta_reconciled'].includes(evidence.state) ||
      (evidence.state === 'space_committed') !== (evidence.metaReconciledAt === null) ||
      new Set(rootIds).size !== rootIds.length ||
      new Set(evidence.operationIds).size !== evidence.operationIds.length ||
      new Set(childOperationIds).size !== childOperationIds.length ||
      new Set(children.map((child) => child.durableKey)).size !== children.length ||
      canonicalize([...childOperationIds].sort()) !==
        canonicalize([...evidence.operationIds].sort()) ||
      await sha256Canonical(evidence.operationIds) !== evidence.operationIdsSha256 ||
      await sha256Canonical(evidence.readyRoots) !== evidence.readyRootSetSha256 ||
      await sha256Canonical(identity) !== evidence.evidenceId) {
    throw new PushAuthorityIntegrityError('terminal_evidence_identity_invalid')
  }
  for (const root of evidence.readyRoots) {
    const rootDocument = {
      rootKind: root.rootKind, rootId: root.rootId,
      orderedChildren: root.orderedChildren,
    }
    if (await sha256Canonical(rootDocument) !== root.rootSha256) {
      throw new PushAuthorityIntegrityError('terminal_evidence_root_hash_mismatch')
    }
  }
  const bytes = decodeCanonicalBase64(evidence.resultCanonicalBase64)
  if (await sha256HexBytes(bytes) !== evidence.resultSha256) {
    throw new PushAuthorityIntegrityError('terminal_evidence_result_hash_mismatch')
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const result = parseSyncV2PushResponse(parseIJsonTextRejectingDuplicateKeys(text))
  if (canonicalize(result) !== text) {
    throw new PushAuthorityIntegrityError('terminal_evidence_result_not_canonical')
  }
  const resultOperationIds = [
    ...result.applied.map((item) => item.operation_id),
    ...result.conflicts.map((item) => item.operation_id),
    ...result.errors.map((item) => item.operation_id),
  ]
  if (result.batch_id !== evidence.batchId ||
      canonicalize([...resultOperationIds].sort()) !==
        canonicalize([...evidence.operationIds].sort()) ||
      result.applied.length !== evidence.appliedCount) {
    throw new PushAuthorityIntegrityError('terminal_evidence_result_coverage_mismatch')
  }
  return result
}

/** @internal Shared Sync invariant; not exported from the public barrel. */
export async function requireTerminalDiagnosticMatchesEvidence(
  row: OutboxEvent,
  evidence: SyncTerminalApplicationEvidence,
  result: ApiSyncV2PushResponse,
): Promise<void> {
  if (row.spaceId !== evidence.spaceId) {
    throw new PushAuthorityIntegrityError('terminal_row_space_mismatch')
  }
  const frozenMatches = evidence.readyRoots.flatMap((root) => root.orderedChildren)
    .filter((child) => child.operationId === row.operationId && child.durableKey === row.id)
  if (frozenMatches.length !== 1) {
    throw new PushAuthorityIntegrityError('terminal_row_evidence_coverage_mismatch')
  }
  const frozen = frozenMatches[0]!
  const actual = await freezeOutboxIdentity(row)
  for (const key of FROZEN_OUTBOX_IDENTITY_KEYS) {
    if (key !== 'transportState' &&
        canonicalize(frozen[key]) !== canonicalize(actual[key])) {
      throw new PushAuthorityIntegrityError(`terminal_row_identity_drift:${key}`)
    }
  }
  const conflictOutcome = result.conflicts.find((item) =>
    item.operation_id === row.operationId)
  const errorOutcome = result.errors.find((item) =>
    item.operation_id === row.operationId)
  if (Number(Boolean(conflictOutcome)) + Number(Boolean(errorOutcome)) !== 1) {
    throw new PushAuthorityIntegrityError('terminal_row_outcome_state_mismatch')
  }
  const expectedState = conflictOutcome ? 'terminal_conflict' : 'terminal_error'
  const expectedOutcomeCanonical = canonicalize(conflictOutcome ?? errorOutcome!)
  if (expectedOutcomeCanonical === undefined) {
    throw new PushAuthorityIntegrityError('terminal_row_outcome_not_canonical')
  }
  const expectedRetryable = errorOutcome?.retryable ?? false
  const expectedNextAttemptAt = expectedRetryable
    ? deterministicTerminalNextAttempt(frozen.attemptCount, evidence.committedAt)
    : null
  if (row.transportState !== expectedState ||
      row.serverOutcomeCanonicalBase64 !== encodeBase64(
        new TextEncoder().encode(expectedOutcomeCanonical),
      ) ||
      row.retryable !== expectedRetryable || row.nextAttemptAt !== expectedNextAttemptAt) {
    throw new PushAuthorityIntegrityError('terminal_row_diagnostic_mismatch')
  }
}

interface RootGroup {
  kind: 'compound' | 'standalone'
  rows: OutboxEvent[]
}

function groupCompleteRoots(rows: readonly OutboxEvent[]): RootGroup[] {
  if (new Set(rows.map((row) => row.id)).size !== rows.length ||
      new Set(rows.map((row) => row.operationId)).size !== rows.length) {
    throw new PushAuthorityIntegrityError('duplicate_authority_identity')
  }
  const grouped = new Map<string, RootGroup>()
  for (const row of rows) {
    const compound = row.compoundOperationId !== null || row.compoundOrder !== null
    if ((row.compoundOperationId === null) !== (row.compoundOrder === null)) {
      throw new PushAuthorityIntegrityError('partial_compound_identity')
    }
    const key = compound ? `compound:${row.compoundOperationId}` : `standalone:${row.operationId}`
    const group = grouped.get(key) ?? { kind: compound ? 'compound' : 'standalone', rows: [] }
    group.rows.push(row)
    grouped.set(key, group)
  }
  for (const group of grouped.values()) {
    if (group.kind === 'standalone' && group.rows.length !== 1) {
      throw new PushAuthorityIntegrityError('standalone_root_has_multiple_children')
    }
    if (group.kind === 'compound') {
      group.rows.sort((a, b) => a.compoundOrder! - b.compoundOrder!)
      group.rows.forEach((row, index) => {
        if (row.compoundOrder !== index) {
          throw new PushAuthorityIntegrityError('compound_order_gap_or_duplicate')
        }
      })
      const prepared = prepareHeldProvisionalBatch(group.rows)
      if (prepared.batchId !== group.rows[0]!.compoundOperationId) {
        throw new PushAuthorityIntegrityError('compound_root_authority_changed')
      }
    }
  }
  const groups = [...grouped.values()]
  const rootIds = groups.map((group) => group.kind === 'compound'
    ? group.rows[0]!.compoundOperationId! : group.rows[0]!.operationId)
  if (new Set(rootIds).size !== rootIds.length) {
    throw new PushAuthorityIntegrityError('duplicate_authority_root_id')
  }
  return groups.sort((a, b) => {
    const aId = a.kind === 'compound' ? a.rows[0]!.compoundOperationId! : a.rows[0]!.operationId
    const bId = b.kind === 'compound' ? b.rows[0]!.compoundOperationId! : b.rows[0]!.operationId
    return `${a.kind}:${aId}`.localeCompare(`${b.kind}:${bId}`)
  })
}

const compareRootKindAndId = (a: ReadyRootIdentity, b: ReadyRootIdentity): number =>
  `${a.rootKind}:${a.rootId}`.localeCompare(`${b.rootKind}:${b.rootId}`)

export async function freezeOutboxIdentity(row: OutboxEvent): Promise<FrozenOutboxIdentity> {
  const durableKey = row.id
  if (typeof durableKey !== 'number' || !Number.isSafeInteger(durableKey) || durableKey < 1) {
    throw new PushAuthorityIntegrityError('outbox_durable_key_invalid')
  }
  if (typeof row.spaceId !== 'string' || row.spaceId.length === 0) {
    throw new PushAuthorityIntegrityError('outbox_space_identity_invalid')
  }
  const payloadValue = parsePersistedOutboxPayload(row.payload)
  const payloadCanonical = canonicalize(payloadValue)
  if (payloadCanonical === undefined) {
    throw new PushAuthorityIntegrityError('outbox_payload_not_canonicalizable')
  }
  const payloadBytes = new TextEncoder().encode(payloadCanonical)
  const recomputedPayloadHash = await recomputeEntityBusinessPayloadHash(
    row.entityType, row.action, payloadValue,
  )
  if (recomputedPayloadHash !== row.payloadHash) {
    throw new PushAuthorityIntegrityError('outbox_payload_hash_mismatch')
  }
  return {
    durableKey,
    spaceId: row.spaceId,
    entityType: row.entityType,
    entityId: row.entityId,
    action: row.action,
    payloadCanonicalBase64: encodeBase64(payloadBytes),
    payloadHash: recomputedPayloadHash,
    operationId: row.operationId,
    retryPredecessorOperationId: row.retryPredecessorOperationId,
    expectedVersion: row.expectedVersion,
    createdAt: requireCanonicalStoredTimestamp(row.createdAt),
    transportState: row.transportState,
    compoundOperationId: row.compoundOperationId,
    compoundOrder: row.compoundOrder,
    attemptCount: row.attemptCount,
  }
}

export async function buildReadyRootIdentities(
  rows: readonly OutboxEvent[],
): Promise<{ readyRoots: ReadyRootIdentity[]; readyRootSetSha256: string }> {
  if (rows.length === 0) {
    return { readyRoots: [], readyRootSetSha256: await sha256Canonical([]) }
  }
  const groups = groupCompleteRoots(rows) // compound roots plus one row per standalone root
  const readyRoots: ReadyRootIdentity[] = []
  for (const group of groups) {
    const prepared = group.kind === 'compound'
      ? prepareHeldProvisionalBatch(group.rows) : null
    const byOperationId = new Map(group.rows.map((row) => [row.operationId, row]))
    const ordered = prepared
      ? prepared.items.map((item) => byOperationId.get(item.operationId)!)
      : group.rows
    const orderedChildren = await Promise.all(ordered.map(freezeOutboxIdentity))
    const rootId = prepared
      ? prepared.batchId
      : orderedChildren[0]!.operationId
    const rootDocument = { rootKind: group.kind, rootId, orderedChildren }
    readyRoots.push({
      ...rootDocument,
      rootSha256: await sha256Canonical(rootDocument),
    })
  }
  readyRoots.sort(compareRootKindAndId) // child order remains untouched
  return { readyRoots, readyRootSetSha256: await sha256Canonical(readyRoots) }
}

export function requireSameFrozenIdentity(
  expected: FrozenOutboxIdentity,
  actual: FrozenOutboxIdentity,
): void {
  for (const key of FROZEN_OUTBOX_IDENTITY_KEYS) {
    if (expected[key] !== actual[key]) {
      throw new PushAuthorityIntegrityError(`outbox_identity_drift:${key}`)
    }
  }
}

export function requireSameReadyRootSet(
  expectedRoots: readonly ReadyRootIdentity[], expectedDigest: string,
  actualRoots: readonly ReadyRootIdentity[], actualDigest: string,
): void {
  if (expectedDigest !== actualDigest ||
      canonicalize(expectedRoots) !== canonicalize(actualRoots)) {
    throw new PushAuthorityIntegrityError('ready_root_identity_drift')
  }
}
```

`FROZEN_OUTBOX_IDENTITY_KEYS` is a literal readonly tuple containing every field of `FrozenOutboxIdentity`; an `Exclude<keyof FrozenOutboxIdentity, typeof FROZEN_OUTBOX_IDENTITY_KEYS[number]>` compile-time assertion must be `never`. `groupCompleteRoots()` rejects duplicate durable/operation IDs, mixed root IDs, missing/duplicate/gapped orders, an extra child sharing the root, or a compound whose `prepareHeldProvisionalBatch(...).batchId` differs. `sha256Canonical()` hashes locked-canonical UTF-8 bytes and every WebCrypto call inside Dexie is wrapped with `Dexie.waitFor`. Tests independently mutate `entityType`, `entityId`, `action`, canonical payload bytes, persisted/recomputed `payloadHash`, `operationId`, `expectedVersion`, `createdAt`, `transportState`, `compoundOperationId`, `compoundOrder`, `attemptCount`, root membership/order, root hash, and root-set hash.

```typescript
export async function authorityForRows(
  rows: readonly OutboxEvent[],
): Promise<PushAuthority> {
  if (rows.length === 0) {
    throw new PushAuthorityIntegrityError('empty_push_authority')
  }
  if (rows[0]!.compoundOperationId !== null) {
    const prepared = prepareHeldProvisionalBatch([...rows])
    return {
      kind: 'compound', batchId: prepared.batchId,
      compoundOperationId: prepared.batchId,
      orderedOperationIds: prepared.items.map((item) => item.operationId),
    }
  }
  if (rows.length === 1 && rows[0]!.entityType === 'workItemNote' &&
      rows[0]!.attemptCount > 0) {
    return {
      kind: 'direct_note_retry', batchId: rows[0]!.operationId,
      compoundOperationId: null, orderedOperationIds: [rows[0]!.operationId],
    }
  }
  if (rows.some((row) => row.attemptCount > 0 || row.compoundOperationId !== null)) {
    throw new PushAuthorityIntegrityError('standalone_batch_authority_invalid')
  }
  const orderedOperationIds = rows.map((row) => row.operationId)
  return {
    kind: 'standalone_batch',
    batchId: await sha256Utf8(orderedOperationIds.join('\n')),
    compoundOperationId: null,
    orderedOperationIds,
  }
}

export function requireSameAuthority(
  actual: PushAuthority,
  expected: PushAuthority,
): void {
  if (canonicalize(actual) !== canonicalize(expected)) {
    throw new PushAuthorityIntegrityError('push_authority_drift')
  }
}

export function selectionFromReceipt(
  receipt: SyncPendingPushBatch,
): PushSelection {
  if (!['compound', 'direct_note_retry', 'standalone_batch'].includes(
    receipt.authorityKind,
  )) {
    throw new PushAuthorityIntegrityError('receipt_authority_kind_invalid')
  }
  const authority: PushAuthority = receipt.authorityKind === 'compound'
    ? {
        kind: 'compound', batchId: receipt.batchId,
        compoundOperationId: receipt.compoundOperationId!,
        orderedOperationIds: [...receipt.operationIds],
      }
    : {
        kind: receipt.authorityKind, batchId: receipt.batchId,
        compoundOperationId: null,
        orderedOperationIds: [...receipt.operationIds],
      }
  if ((authority.kind === 'compound') !== (receipt.compoundOperationId !== null) ||
      (authority.kind === 'compound' &&
        authority.batchId !== authority.compoundOperationId)) {
    throw new PushAuthorityIntegrityError('receipt_authority_shape_invalid')
  }
  return {
    authority,
    operationIds: [...receipt.operationIds],
    frozenRows: structuredClone(receipt.frozenRows),
    readyRoots: structuredClone(receipt.readyRoots),
    readyRootSetSha256: receipt.readyRootSetSha256,
  }
}

export async function reloadCompleteAuthorityAndRequireUnchangedSelection(
  db: PomodoroXIDB,
  selected: PushSelection,
): Promise<OutboxEvent[]> {
  const selectedRows = await db.outbox.bulkGet(selected.frozenRows.map((row) => row.durableKey))
  if (selectedRows.some((row) => !row)) {
    throw new PushAuthorityIntegrityError('selected_outbox_row_missing')
  }
  const rows = selectedRows as OutboxEvent[]
  if (selected.authority.kind === 'compound') {
    const completeRoot = await db.outbox
      .where('compoundOperationId').equals(selected.authority.compoundOperationId!).sortBy('compoundOrder')
    if (completeRoot.length !== rows.length ||
        completeRoot.some((row, index) => row.id !== rows[index]!.id)) {
      throw new PushAuthorityIntegrityError('compound_root_membership_drift')
    }
  } else if (rows.some((row) => row.compoundOperationId !== null)) {
    throw new PushAuthorityIntegrityError('standalone_row_reparented')
  }
  const actualFrozen = await Dexie.waitFor(Promise.all(rows.map(freezeOutboxIdentity)))
  selected.frozenRows.forEach((expected, index) =>
    requireSameFrozenIdentity(expected, actualFrozen[index]!))
  const actualRoots = await Dexie.waitFor(buildReadyRootIdentities(rows))
  requireSameReadyRootSet(
    selected.readyRoots, selected.readyRootSetSha256,
    actualRoots.readyRoots, actualRoots.readyRootSetSha256,
  )
  return rows
}

function requireSyncIdentifier(value: string, maxBytes: number, code: string): void {
  if (!new RegExp(`^[A-Za-z0-9._:-]{1,${maxBytes}}$`).test(value)) {
    throw new PushAuthorityIntegrityError(code)
  }
}

function canonicalText(value: unknown, code: string): string {
  const text = canonicalize(value)
  if (text === undefined) throw new PushAuthorityIntegrityError(code)
  return text
}

function decodeCanonicalJson(value: string, code: string): unknown {
  const bytes = decodeCanonicalBase64(value)
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { throw new PushAuthorityIntegrityError(`${code}:invalid_utf8`) }
  const parsed = parseIJsonTextRejectingDuplicateKeys(text)
  if (canonicalText(parsed, `${code}:not_json`) !== text) {
    throw new PushAuthorityIntegrityError(`${code}:not_canonical`)
  }
  return parsed
}

async function requireReceiptRootIntegrity(
  receipt: SyncPendingPushBatch,
): Promise<void> {
  const rootIds = receipt.readyRoots.map((root) => root.rootId)
  if (new Set(rootIds).size !== rootIds.length ||
      canonicalize([...receipt.readyRoots].sort(compareRootKindAndId)) !==
        canonicalize(receipt.readyRoots)) {
    throw new PushAuthorityIntegrityError('receipt_root_order_or_identity_invalid')
  }
  const children: FrozenOutboxIdentity[] = []
  for (const root of receipt.readyRoots) {
    const rootDocument = {
      rootKind: root.rootKind, rootId: root.rootId,
      orderedChildren: root.orderedChildren,
    }
    if (await sha256Canonical(rootDocument) !== root.rootSha256) {
      throw new PushAuthorityIntegrityError('receipt_root_hash_mismatch')
    }
    if (root.rootKind === 'standalone') {
      if (root.orderedChildren.length !== 1 ||
          root.orderedChildren[0]!.operationId !== root.rootId ||
          root.orderedChildren[0]!.compoundOperationId !== null ||
          root.orderedChildren[0]!.compoundOrder !== null) {
        throw new PushAuthorityIntegrityError('receipt_standalone_root_invalid')
      }
    } else {
      if (root.orderedChildren.length === 0 ||
          root.orderedChildren.some((child, index) =>
            child.compoundOperationId !== root.rootId || child.compoundOrder !== index)) {
        throw new PushAuthorityIntegrityError('receipt_compound_root_invalid')
      }
    }
    children.push(...root.orderedChildren)
  }
  const frozenByOperation = new Map(
    receipt.frozenRows.map((row) => [row.operationId, canonicalText(row, 'receipt_frozen_row')]),
  )
  if (frozenByOperation.size !== receipt.frozenRows.length ||
      children.length !== receipt.frozenRows.length ||
      children.some((child) => frozenByOperation.get(child.operationId) !==
        canonicalText(child, 'receipt_root_child'))) {
    throw new PushAuthorityIntegrityError('receipt_root_membership_mismatch')
  }
  if (await sha256Canonical(receipt.readyRoots) !== receipt.readyRootSetSha256) {
    throw new PushAuthorityIntegrityError('receipt_root_set_hash_mismatch')
  }
}

/** @internal Shared Sync invariant; not exported from the public barrel. */
export async function validatePendingPushReceipt(
  receipt: SyncPendingPushBatch,
): Promise<void> {
  if (receipt.key !== 'active' || !receipt.spaceId || receipt.operationIds.length < 1 ||
      receipt.operationIds.length > 500 ||
      receipt.events.length !== receipt.operationIds.length ||
      receipt.frozenRows.length !== receipt.operationIds.length ||
      receipt.eventCanonicalBase64.length !== receipt.operationIds.length ||
      receipt.eventSha256.length !== receipt.operationIds.length) {
    throw new PushAuthorityIntegrityError('pending_receipt_shape_invalid')
  }
  if (receipt.frozenRows.some((row) => row.spaceId !== receipt.spaceId) ||
      receipt.readyRoots.some((root) =>
        root.orderedChildren.some((row) => row.spaceId !== receipt.spaceId))) {
    throw new PushAuthorityIntegrityError('pending_receipt_space_identity_invalid')
  }
  if (new Set(receipt.frozenRows.map((row) => row.durableKey)).size !==
      receipt.frozenRows.length) {
    throw new PushAuthorityIntegrityError('pending_receipt_duplicate_durable_key')
  }
  if (!['compound', 'direct_note_retry', 'standalone_batch'].includes(
    receipt.authorityKind,
  )) {
    throw new PushAuthorityIntegrityError('pending_receipt_authority_kind_invalid')
  }
  requireSyncIdentifier(receipt.clientId, 64, 'pending_receipt_client_id_invalid')
  requireSyncIdentifier(receipt.batchId, 128, 'pending_receipt_batch_id_invalid')
  receipt.operationIds.forEach((id) =>
    requireSyncIdentifier(id, 128, 'pending_receipt_operation_id_invalid'))
  requireCanonicalStoredTimestamp(receipt.receiptCreatedAt)
  if (new Set(receipt.operationIds).size !== receipt.operationIds.length ||
      receipt.requestMethod !== 'POST' ||
      receipt.requestPath !== '/api/v1/sync/v2/push' ||
      receipt.idempotencyKey !== receipt.batchId ||
      receipt.headers.accept !== SYNC_V2_ERROR_ACCEPT ||
      receipt.headers.contentType !== 'application/json' ||
      receipt.headers.idempotencyKey !== receipt.idempotencyKey) {
    throw new PushAuthorityIntegrityError('pending_receipt_request_metadata_invalid')
  }

  const selection = selectionFromReceipt(receipt)
  if (canonicalize(selection.authority.orderedOperationIds) !==
      canonicalize(receipt.operationIds)) {
    throw new PushAuthorityIntegrityError('pending_receipt_authority_order_invalid')
  }
  if (selection.authority.kind === 'compound') {
    if (receipt.readyRoots.length !== 1 ||
        receipt.readyRoots[0]!.rootKind !== 'compound' ||
        receipt.readyRoots[0]!.rootId !== selection.authority.compoundOperationId) {
      throw new PushAuthorityIntegrityError('pending_receipt_compound_authority_invalid')
    }
  } else if (selection.authority.kind === 'direct_note_retry') {
    const row = receipt.frozenRows[0]
    if (receipt.frozenRows.length !== 1 || receipt.batchId !== receipt.operationIds[0] ||
        !row || row.entityType !== 'workItemNote' || row.attemptCount <= 0 ||
        row.compoundOperationId !== null) {
      throw new PushAuthorityIntegrityError('pending_receipt_direct_note_authority_invalid')
    }
  } else if (receipt.compoundOperationId !== null ||
      receipt.frozenRows.some((row) => row.compoundOperationId !== null || row.attemptCount > 0) ||
      receipt.batchId !== await sha256Utf8(receipt.operationIds.join('\n'))) {
    throw new PushAuthorityIntegrityError('pending_receipt_standalone_authority_invalid')
  }

  let canonicalEventBytes = 0
  for (let index = 0; index < receipt.frozenRows.length; index += 1) {
    const frozen = receipt.frozenRows[index]!
    const event = receipt.events[index]!
    requireSyncIdentifier(frozen.entityType, 64, 'pending_receipt_entity_type_invalid')
    requireSyncIdentifier(frozen.entityId, 64, 'pending_receipt_entity_id_invalid')
    if (frozen.durableKey < 1 || !Number.isSafeInteger(frozen.durableKey) ||
        frozen.transportState !== 'ready' || frozen.operationId !== receipt.operationIds[index] ||
        !/^[0-9a-f]{64}$/.test(frozen.payloadHash) ||
        !Number.isSafeInteger(frozen.attemptCount) || frozen.attemptCount < 0) {
      throw new PushAuthorityIntegrityError('pending_receipt_frozen_identity_invalid')
    }
    requireCanonicalStoredTimestamp(frozen.createdAt)
    const payloadBytes = decodeCanonicalBase64(frozen.payloadCanonicalBase64)
    if (payloadBytes.length > 256 * 1024) {
      throw new PushAuthorityIntegrityError('pending_receipt_payload_too_large')
    }
    const payload = decodeCanonicalJson(
      frozen.payloadCanonicalBase64, 'pending_receipt_payload',
    )
    if (payload === null || Array.isArray(payload) || typeof payload !== 'object' ||
        await recomputeEntityBusinessPayloadHash(
          frozen.entityType, frozen.action, payload,
        ) !== frozen.payloadHash) {
      throw new PushAuthorityIntegrityError('pending_receipt_payload_hash_mismatch')
    }
    const expectedVersionValid = frozen.action === 'create'
      ? frozen.expectedVersion === null
      : typeof frozen.expectedVersion === 'number' &&
        Number.isSafeInteger(frozen.expectedVersion) && frozen.expectedVersion >= 0
    if (!expectedVersionValid || event.operation_id !== frozen.operationId ||
        event.entity_type !== frozen.entityType || event.entity_id !== frozen.entityId ||
        event.action !== frozen.action || event.expected_version !== frozen.expectedVersion ||
        event.client_updated_at !== frozen.createdAt ||
        canonicalize(event.payload) !== canonicalize(payload)) {
      throw new PushAuthorityIntegrityError('pending_receipt_event_identity_mismatch')
    }
    const eventBytes = decodeCanonicalBase64(receipt.eventCanonicalBase64[index]!)
    canonicalEventBytes += eventBytes.length
    const parsedEvent = decodeCanonicalJson(
      receipt.eventCanonicalBase64[index]!, 'pending_receipt_event',
    )
    if (canonicalize(parsedEvent) !== canonicalize(event) ||
        await sha256HexBytes(eventBytes) !== receipt.eventSha256[index]) {
      throw new PushAuthorityIntegrityError('pending_receipt_event_bytes_mismatch')
    }
  }
  if (canonicalEventBytes > 10 * 1024 * 1024) {
    throw new PushAuthorityIntegrityError('pending_receipt_batch_too_large')
  }

  await requireReceiptRootIntegrity(receipt)
  const expectedRequest = {
    client_id: receipt.clientId, batch_id: receipt.batchId,
    events: receipt.events,
  }
  const requestBytes = decodeCanonicalBase64(receipt.requestCanonicalBase64)
  if (requestBytes.length > 11 * 1024 * 1024) {
    throw new PushAuthorityIntegrityError('pending_receipt_request_too_large')
  }
  const parsedRequest = decodeCanonicalJson(
    receipt.requestCanonicalBase64, 'pending_receipt_request',
  )
  if (canonicalize(parsedRequest) !== canonicalize(expectedRequest) ||
      await sha256HexBytes(requestBytes) !== receipt.requestSha256) {
    throw new PushAuthorityIntegrityError('pending_receipt_request_bytes_mismatch')
  }
}

export async function loadAndValidateActiveReceiptInCurrentTransaction(
  db: PomodoroXIDB,
): Promise<SyncPendingPushBatch | undefined> {
  const transaction = Dexie.currentTransaction
  if (!transaction || transaction.db !== db ||
      !transaction.storeNames.includes('syncPushBatches')) {
    throw new PushAuthorityIntegrityError('receipt_load_requires_current_transaction')
  }
  const receipt = await db.syncPushBatches.get('active')
  if (!receipt) return undefined
  await Dexie.waitFor(validatePendingPushReceipt(receipt))
  if (receipt.spaceId !== db.spaceId) {
    throw new PushAuthorityIntegrityError('pending_receipt_database_space_mismatch')
  }
  return receipt
}

/** @internal Shared Sync invariant; not exported from the public barrel. */
export async function loadAndValidateActiveReceipt(
  db: PomodoroXIDB,
): Promise<SyncPendingPushBatch | undefined> {
  return db.transaction('r', db.syncPushBatches, () =>
    loadAndValidateActiveReceiptInCurrentTransaction(db))
}

/** @internal Test seam; production callers use the terminal coordinator. */
export function requireReceiptMatchesFrozenAuthority(
  receipt: SyncPendingPushBatch,
  selected: PushSelection,
): void {
  requireSameAuthority(selectionFromReceipt(receipt).authority, selected.authority)
  if (canonicalize(receipt.frozenRows) !== canonicalize(selected.frozenRows) ||
      canonicalize(receipt.readyRoots) !== canonicalize(selected.readyRoots) ||
      receipt.readyRootSetSha256 !== selected.readyRootSetSha256 ||
      canonicalize(receipt.operationIds) !== canonicalize(selected.operationIds)) {
    throw new PushAuthorityIntegrityError('receipt_frozen_authority_mismatch')
  }
}
```

`authority-identity.ts` has no import from `push-batch.ts` or
`terminal-application.ts`. Receipt validation above is restart-local and
recomputes canonical payload/business hashes, every event/request byte hash,
authority shape, root membership/order, every root digest, and the root-set
digest before returning a receipt.

`push-batch.ts` imports that shared interface and owns selection, operation
query, receipt creation, and the bounded query-to-push coordinator:

```typescript
// frontend/src/lib/sync/push-batch.ts
import type { AxiosInstance } from 'axios'
import Dexie from 'dexie'
import { canonicalize } from 'json-canonicalize'
import { canonicalNow } from '@/lib/direct-command-intents'
import type {
  PomodoroXIDB, PushCycleSummary, SyncPendingPushBatch,
} from '@/services/database'
import type { MetaDB } from '@/services/meta-database'
import type { OutboxEvent } from '@/types'
import { resumeImportedProvisionalReviews } from '@/lib/focus-session/focus-session-repository'
import type {
  ApiSyncV2Event, ApiSyncV2OperationQueryResponse, ApiSyncV2PushResponse,
} from './types'
import { prepareHeldProvisionalBatch } from './outbox'
import { parsePersistedOutboxPayload } from './entity-payload-hash'
import {
  admitTs3AwaitingS4, assertS4AdmissionReady,
  assertSpaceAdmissionReadyInCurrentTransaction,
  loadAndRequireSameSpaceReadyMetaProof,
} from './admission'
import { getOrCreateClientId } from './client-registry'
import {
  requireSpaceAuthorityToken, requireSpaceDatabaseBinding,
  withSpaceAuthorityFence,
  type SpaceAuthorityToken,
} from './space-authority-fence'
import {
  applyTerminalResultTwoPhase, reconcilePendingTerminalApplications,
} from './terminal-application'
import { requireCanonicalStoredTimestamp } from './response-schema'
import { SYNC_V2_ERROR_ACCEPT, syncV2Push, syncV2QueryOperations } from './transport'
import {
  authorityForRows, buildReadyRootIdentities, decodeCanonicalBase64, encodeBase64,
  freezeOutboxIdentity,
  loadAndValidateActiveReceipt, loadAndValidateActiveReceiptInCurrentTransaction,
  PushAuthorityDriftError,
  PushAuthorityIntegrityError, reloadCompleteAuthorityAndRequireUnchangedSelection,
  requireReceiptMatchesFrozenAuthority,
  requireSameAuthority, requireSameFrozenIdentity, requireSameReadyRootSet,
  selectionFromReceipt, sha256Canonical, sha256HexBytes,
  validatePendingPushReceipt,
  type PushAuthority, type PushSelection,
} from './authority-identity'

const MAX_AUTHORITY_RESTARTS = 1
const MAX_SYNC_PUSH_EVENTS = 500

export type QueryDecision =
  | { kind: 'unknown' }
  | { kind: 'blocked'; state: 'pending' | 'recovery_required' }
  | { kind: 'terminal'; result: ApiSyncV2PushResponse }

type OperationQueryItem = ApiSyncV2OperationQueryResponse['items'][number]

/** @internal Shared Sync invariant; not exported from the public barrel. */
export function requireOneCanonicalTerminalBatchResult(
  items: readonly OperationQueryItem[],
): ApiSyncV2PushResponse {
  if (items.length === 0) {
    throw new PushAuthorityIntegrityError('operation_query_terminal_result_missing')
  }
  const first = items[0]!
  if (first.state !== 'terminal' || first.batch_id === null || first.result === null) {
    throw new PushAuthorityIntegrityError('operation_query_terminal_binding_missing')
  }
  const canonical = canonicalize(first.result)
  if (canonical === undefined || first.result.batch_id !== first.batch_id) {
    throw new PushAuthorityIntegrityError('operation_query_terminal_result_invalid')
  }
  for (const item of items) {
    if (item.state !== 'terminal' || item.batch_id !== first.batch_id || item.result === null ||
        item.result.batch_id !== first.batch_id || canonicalize(item.result) !== canonical) {
      throw new PushAuthorityIntegrityError('operation_query_terminal_result_disagreement')
    }
  }
  return structuredClone(first.result)
}

/** @internal Shared Sync invariant; not exported from the public barrel. */
export function toApiEvent(row: OutboxEvent): ApiSyncV2Event {
  const payload = parsePersistedOutboxPayload(row.payload)
  if (payload === null || Array.isArray(payload) || typeof payload !== 'object') {
    throw new PushAuthorityIntegrityError('outbox_payload_not_object')
  }
  return {
    operation_id: row.operationId,
    entity_type: row.entityType,
    entity_id: row.entityId,
    action: row.action,
    payload,
    expected_version: row.expectedVersion,
    client_updated_at: requireCanonicalStoredTimestamp(row.createdAt),
  }
}

function pushEventByteBudget(row: OutboxEvent): {
  payloadBytes: number; eventBytes: number;
} {
  const event = toApiEvent(row)
  const payloadCanonical = canonicalize(event.payload)
  const eventCanonical = canonicalize(event)
  if (payloadCanonical === undefined || eventCanonical === undefined) {
    throw new PushAuthorityIntegrityError('push_event_not_canonicalizable')
  }
  return {
    payloadBytes: new TextEncoder().encode(payloadCanonical).length,
    eventBytes: new TextEncoder().encode(eventCanonical).length,
  }
}

async function selectionForRows(rows: readonly OutboxEvent[]): Promise<PushSelection> {
  const authority = await authorityForRows(rows)
  const byOperationId = new Map(rows.map((row) => [row.operationId, row]))
  const orderedRows = authority.orderedOperationIds.map((id) => byOperationId.get(id))
  if (byOperationId.size !== rows.length || orderedRows.some((row) => !row)) {
    throw new PushAuthorityIntegrityError('selected_authority_order_invalid')
  }
  const budgets = (orderedRows as OutboxEvent[]).map(pushEventByteBudget)
  if (budgets.some((budget) => budget.payloadBytes > 256 * 1024) ||
      budgets.reduce((total, budget) => total + budget.eventBytes, 0) >
        10 * 1024 * 1024) {
    throw new PushAuthorityIntegrityError('selected_authority_byte_budget_exceeded')
  }
  const frozenRows = await Promise.all(
    (orderedRows as OutboxEvent[]).map(freezeOutboxIdentity),
  )
  const roots = await buildReadyRootIdentities(orderedRows as OutboxEvent[])
  return {
    authority, operationIds: [...authority.orderedOperationIds], frozenRows,
    readyRoots: roots.readyRoots, readyRootSetSha256: roots.readyRootSetSha256,
  }
}

/** @internal Shared Sync invariant; not exported from the public barrel. */
export async function selectOneAuthorityUnit(
  db: PomodoroXIDB,
  attempted: ReadonlySet<string>,
): Promise<PushSelection | undefined> {
  const ready = (await db.outbox.orderBy('id').toArray())
    .filter((row) => row.transportState === 'ready')
    .filter((row) => !attempted.has(row.operationId))
  if (ready.length === 0) return undefined

  const first = ready[0]!
  if (first.compoundOperationId !== null) {
    const completeRoot = (await db.outbox.orderBy('id').toArray())
      .filter((row) => row.compoundOperationId === first.compoundOperationId)
      .sort((left, right) => left.compoundOrder! - right.compoundOrder!)
    if (completeRoot.some((row) => row.transportState !== 'ready' ||
        attempted.has(row.operationId))) {
      throw new PushAuthorityIntegrityError('selected_compound_not_wholly_ready')
    }
    const rows = completeRoot
    const prepared = prepareHeldProvisionalBatch([...rows])
    if (prepared.batchId !== first.compoundOperationId ||
        prepared.items.length !== rows.length || rows.length > MAX_SYNC_PUSH_EVENTS) {
      throw new PushAuthorityIntegrityError('selected_compound_authority_invalid')
    }
    return selectionForRows(rows)
  }
  if (first.entityType === 'workItemNote' && first.attemptCount > 0) {
    return selectionForRows([first])
  }
  if (first.attemptCount > 0) {
    throw new PushAuthorityIntegrityError('attempted_non_note_requires_explicit_successor')
  }

  const prefix: OutboxEvent[] = []
  let canonicalEventBytes = 0
  for (const row of ready) {
    if (prefix.length >= MAX_SYNC_PUSH_EVENTS || row.compoundOperationId !== null ||
        row.attemptCount > 0) break
    const budget = pushEventByteBudget(row)
    if (budget.payloadBytes > 256 * 1024) {
      throw new PushAuthorityIntegrityError('selected_event_payload_too_large')
    }
    if (canonicalEventBytes + budget.eventBytes > 10 * 1024 * 1024) break
    prefix.push(row)
    canonicalEventBytes += budget.eventBytes
  }
  if (prefix.length === 0) {
    throw new PushAuthorityIntegrityError('empty_standalone_selection')
  }
  return selectionForRows(prefix)
}

/** @internal Shared Sync invariant; not exported from the public barrel. */
export async function buildPersistAndValidateExactReceipt(
  db: PomodoroXIDB, spaceId: string, token: SpaceAuthorityToken,
  clientId: string, rows: readonly OutboxEvent[],
  events: readonly ApiSyncV2Event[], authority: PushAuthority,
  selected: PushSelection,
): Promise<SyncPendingPushBatch> {
  requireSpaceAuthorityToken(token, spaceId)
  requireSpaceDatabaseBinding(db, spaceId)
  const active = await db.syncPushBatches.get('active')
  if (active) throw new PushAuthorityIntegrityError('pending_receipt_already_exists')
  requireSameAuthority(authority, selected.authority)
  if (rows.length !== events.length || rows.length !== selected.operationIds.length ||
      rows.length < 1 || rows.length > MAX_SYNC_PUSH_EVENTS) {
    throw new PushAuthorityIntegrityError('pending_receipt_input_shape_invalid')
  }
  const frozenRows = await Promise.all(rows.map(freezeOutboxIdentity))
  if (frozenRows.some((row) => row.spaceId !== spaceId)) {
    throw new PushAuthorityIntegrityError('pending_receipt_cross_space_row')
  }
  frozenRows.forEach((actual, index) =>
    requireSameFrozenIdentity(selected.frozenRows[index]!, actual))
  const roots = await buildReadyRootIdentities(rows)
  requireSameReadyRootSet(
    selected.readyRoots, selected.readyRootSetSha256,
    roots.readyRoots, roots.readyRootSetSha256,
  )

  const immutableEvents = events.map((event) => structuredClone(event))
  const eventTexts = immutableEvents.map((event) => {
    const text = canonicalize(event)
    if (text === undefined) {
      throw new PushAuthorityIntegrityError('push_event_not_canonicalizable')
    }
    return text
  })
  const eventBytes = eventTexts.map((text) => new TextEncoder().encode(text))
  if (frozenRows.some((row) =>
        decodeCanonicalBase64(row.payloadCanonicalBase64).length > 256 * 1024) ||
      eventBytes.reduce((total, bytes) => total + bytes.length, 0) > 10 * 1024 * 1024) {
    throw new PushAuthorityIntegrityError('push_canonical_batch_too_large')
  }
  const request = {
    client_id: clientId, batch_id: authority.batchId, events: immutableEvents,
  }
  const requestText = canonicalize(request)
  if (requestText === undefined) {
    throw new PushAuthorityIntegrityError('push_request_not_canonicalizable')
  }
  const requestBytes = new TextEncoder().encode(requestText)
  const receipt: SyncPendingPushBatch = {
    key: 'active', spaceId, clientId, authorityKind: authority.kind,
    compoundOperationId: authority.compoundOperationId,
    batchId: authority.batchId, operationIds: [...selected.operationIds],
    frozenRows: structuredClone(frozenRows), readyRoots: structuredClone(roots.readyRoots),
    readyRootSetSha256: roots.readyRootSetSha256, events: immutableEvents,
    idempotencyKey: authority.batchId, requestMethod: 'POST',
    requestPath: '/api/v1/sync/v2/push',
    headers: {
      accept: SYNC_V2_ERROR_ACCEPT, contentType: 'application/json',
      idempotencyKey: authority.batchId,
    },
    eventCanonicalBase64: eventBytes.map(encodeBase64),
    eventSha256: await Promise.all(eventBytes.map(sha256HexBytes)),
    requestCanonicalBase64: encodeBase64(requestBytes),
    requestSha256: await sha256HexBytes(requestBytes),
    receiptCreatedAt: canonicalNow(),
  }
  await validatePendingPushReceipt(receipt)
  await db.syncPushBatches.add(receipt)
  const persisted = await db.syncPushBatches.get('active')
  if (!persisted || canonicalize(persisted) !== canonicalize(receipt)) {
    throw new PushAuthorityIntegrityError('pending_receipt_persistence_mismatch')
  }
  await validatePendingPushReceipt(persisted)
  return persisted
}

async function classifyOperationQuery(
  api: AxiosInstance, clientId: string, operationIds: readonly string[],
): Promise<QueryDecision> {
  const response = await syncV2QueryOperations(api, {
    client_id: clientId, operation_ids: [...operationIds],
  })
  const items = response.data.items
  const blockerState = items.some((item) => item.state === 'recovery_required')
    ? 'recovery_required'
    : items.some((item) => item.state === 'pending') ? 'pending' : null
  if (blockerState !== null) return { kind: 'blocked', state: blockerState }
  const terminal = items.filter((item) => item.state === 'terminal')
  if (terminal.length !== 0) {
    if (terminal.length !== items.length) {
      throw new PushAuthorityIntegrityError('operation_query_mixed_terminal_authority')
    }
    return { kind: 'terminal', result: requireOneCanonicalTerminalBatchResult(terminal) }
  }
  if (!items.every((item) => item.state === 'unknown')) {
    throw new PushAuthorityIntegrityError('operation_query_inconsistent_authority')
  }
  return { kind: 'unknown' }
}

async function createPendingPushBatchAfterUnknown(
  db: PomodoroXIDB, meta: MetaDB, spaceId: string, clientId: string,
  selected: PushSelection, token: SpaceAuthorityToken,
): Promise<SyncPendingPushBatch> {
  requireSpaceAuthorityToken(token, spaceId)
  requireSpaceDatabaseBinding(db, spaceId)
  await assertS4AdmissionReady(db, meta, spaceId, token)
  return db.transaction('rw', db.outbox, db.syncAdmissionState, db.syncPushBatches,
    async () => {
      const rows = await reloadCompleteAuthorityAndRequireUnchangedSelection(db, selected)
      const authority = await Dexie.waitFor(authorityForRows(rows))
      requireSameAuthority(authority, selected.authority)
      const events = rows.map((row) => structuredClone({
        ...toApiEvent(row), operation_id: row.operationId,
        expected_version: row.expectedVersion,
        client_updated_at: requireCanonicalStoredTimestamp(row.createdAt),
      }))
      return Dexie.waitFor(buildPersistAndValidateExactReceipt(
        db, spaceId, token, clientId, rows, events, authority, selected,
      ))
    })
}
```

The Meta proof, ready classifier, and receipt binding are concrete `admission.ts`/`push-batch.ts` exports rather than implicit helpers:

```typescript
export interface ReadyMetaRootProof {
  operationId: string
  state: 'awaiting_s4' | 'transport_ready' | 'transport_resolved'
  transportReadyRootSha256: string | null
  terminalEvidenceId: string | null
  terminalResultSha256: string | null
  terminalOperationIdsSha256: string | null
}

export interface ReadyMetaProof {
  spaceId: string
  roots: ReadyMetaRootProof[]
  proofSha256: string
}

export type ReadyAdmissionDecision =
  | { kind: 'ready' }
  | { kind: 'recoverable'; code: 'new_complete_paired_root' }
  | { kind: 'integrity_error'; code: string }

export async function loadAndRequireSameSpaceReadyMetaProof(
  meta: MetaDB, spaceId: string, token: SpaceAuthorityToken,
): Promise<ReadyMetaProof> {
  requireSpaceAuthorityToken(token, spaceId)
  const roots = await meta.transaction('r', meta.provisionalOperations, async () =>
    (await meta.provisionalOperations.where('spaceId').equals(spaceId).toArray())
      .filter((row) => ['awaiting_s4', 'transport_ready', 'transport_resolved'].includes(row.state))
      .map((row) => {
        if (row.spaceId !== spaceId) {
          throw new PushAuthorityIntegrityError('cross_space_meta_root')
        }
        return {
          operationId: row.operationId,
          state: row.state as ReadyMetaRootProof['state'],
          transportReadyRootSha256: row.transportReadyRootSha256,
          terminalEvidenceId: row.terminalEvidenceId,
          terminalResultSha256: row.terminalResultSha256,
          terminalOperationIdsSha256: row.terminalOperationIdsSha256,
        }
      }).sort((a, b) => a.operationId.localeCompare(b.operationId)),
  )
  if (new Set(roots.map((root) => root.operationId)).size !== roots.length) {
    throw new PushAuthorityIntegrityError('duplicate_meta_root')
  }
  return {
    spaceId,
    roots,
    proofSha256: await sha256Canonical({ spaceId, roots }),
  }
}

export async function classifyReadyAdmissionSnapshot(
  marker: SyncAdmissionState | undefined,
  allRows: readonly OutboxEvent[],
  metaProof: ReadyMetaProof,
  evidenceRows: readonly SyncTerminalApplicationEvidence[],
): Promise<ReadyAdmissionDecision> {
  if (!marker || marker.state !== 'ready' || marker.readyRootSetSha256 === null) {
    return { kind: 'integrity_error', code: 'admission_marker_not_ready' }
  }
  if (new Set(marker.readyRoots.map((root) => root.rootId)).size !==
        marker.readyRoots.length ||
      await sha256Canonical(marker.readyRoots) !== marker.readyRootSetSha256) {
    return { kind: 'integrity_error', code: 'ready_marker_digest_mismatch' }
  }
  const awaitingRows = allRows.filter((row) => row.transportState === 'awaiting_s4')
  if (awaitingRows.length) {
    try {
      const awaiting = await buildReadyRootIdentities(awaitingRows)
      const metaAwaiting = metaProof.roots.filter((root) => root.state === 'awaiting_s4')
      const paired = awaiting.readyRoots.every((root) => root.rootKind === 'standalone' ||
        metaAwaiting.some((metaRoot) => metaRoot.operationId === root.rootId))
      if (paired && metaAwaiting.every((metaRoot) =>
        awaiting.readyRoots.some((root) => root.rootId === metaRoot.operationId))) {
        return { kind: 'recoverable', code: 'new_complete_paired_root' }
      }
    } catch { /* malformed awaiting rows are integrity failure below */ }
    return { kind: 'integrity_error', code: 'awaiting_s4_root_invalid_or_orphaned' }
  }

  const live = await buildReadyRootIdentities(
    allRows.filter((row) => row.transportState === 'ready'),
  )
  if (new Set(evidenceRows.map((evidence) => evidence.evidenceId)).size !==
      evidenceRows.length) {
    return { kind: 'integrity_error', code: 'duplicate_terminal_evidence_id' }
  }
  const evidenceResults = new Map<string, ApiSyncV2PushResponse>()
  for (const evidence of evidenceRows) {
    try {
      evidenceResults.set(
        evidence.evidenceId,
        await parseAndValidateTerminalEvidenceResult(evidence),
      )
    } catch (error: unknown) {
      if (!(error instanceof PushAuthorityIntegrityError)) throw error
      return { kind: 'integrity_error', code: error.code }
    }
  }
  const terminalRows = allRows.filter((row) =>
    row.transportState === 'terminal_conflict' || row.transportState === 'terminal_error')
  for (const row of terminalRows) {
    const matching = evidenceRows.filter((evidence) => evidence.readyRoots.some((root) =>
      root.orderedChildren.some((child) => child.operationId === row.operationId &&
        child.durableKey === row.id)))
    if (matching.length !== 1) {
      return { kind: 'integrity_error', code: 'terminal_row_evidence_coverage_mismatch' }
    }
    const evidence = matching[0]!
    try {
      await requireTerminalDiagnosticMatchesEvidence(
        row, evidence, evidenceResults.get(evidence.evidenceId)!,
      )
    } catch (error: unknown) {
      if (!(error instanceof PushAuthorityIntegrityError)) throw error
      return { kind: 'integrity_error', code: error.code }
    }
  }
  for (const expected of marker.readyRoots) {
    const liveRoot = live.readyRoots.find((root) =>
      root.rootKind === expected.rootKind && root.rootId === expected.rootId)
    if (liveRoot) {
      if (canonicalize(liveRoot) !== canonicalize(expected)) {
        return { kind: 'integrity_error', code: 'live_ready_root_identity_drift' }
      }
      if (expected.rootKind === 'compound' && !metaProof.roots.some((root) =>
        root.operationId === expected.rootId && root.state === 'transport_ready' &&
        root.transportReadyRootSha256 === expected.rootSha256)) {
        return { kind: 'integrity_error', code: 'live_ready_meta_binding_mismatch' }
      }
      continue
    }
    const matchingEvidence = evidenceRows.filter((evidence) =>
      evidence.readyRoots.some((root) => canonicalize(root) === canonicalize(expected)))
    if (matchingEvidence.length !== 1) {
      return { kind: 'integrity_error', code: 'ready_root_disappeared_without_evidence' }
    }
    const exactEvidence = matchingEvidence[0]!
    if (expected.rootKind === 'compound') {
      const metaRoot = metaProof.roots.find((root) => root.operationId === expected.rootId)
      const recovering = exactEvidence.state === 'space_committed' &&
        metaRoot?.state === 'transport_ready' &&
        metaRoot.transportReadyRootSha256 === expected.rootSha256
      const reconciled = exactEvidence.state === 'meta_reconciled' &&
        metaRoot?.state === 'transport_resolved' &&
        metaRoot.terminalEvidenceId === exactEvidence.evidenceId &&
        metaRoot.terminalResultSha256 === exactEvidence.resultSha256 &&
        metaRoot.terminalOperationIdsSha256 === exactEvidence.operationIdsSha256
      if (!recovering && !reconciled) {
        return { kind: 'integrity_error', code: 'terminal_evidence_meta_binding_mismatch' }
      }
    }
  }
  const explainedRootIds = new Set(marker.readyRoots.map((root) => root.rootId))
  if (live.readyRoots.some((root) => !explainedRootIds.has(root.rootId)) ||
      metaProof.roots.some((root) => root.state !== 'transport_resolved' &&
        !explainedRootIds.has(root.operationId))) {
    return { kind: 'integrity_error', code: 'unexplained_ready_root_or_meta_orphan' }
  }
  return { kind: 'ready' }
}

export async function assertSpaceAdmissionReadyInCurrentTransaction(
  db: PomodoroXIDB,
  spaceId: string,
  marker: SyncAdmissionState | undefined,
  allRows: readonly OutboxEvent[],
  metaProof: ReadyMetaProof,
  evidenceRows: readonly SyncTerminalApplicationEvidence[],
): Promise<void> {
  const transaction = Dexie.currentTransaction
  const requiredStores = [
    'outbox', 'syncAdmissionState', 'syncTerminalApplications',
  ] as const
  if (!transaction || transaction.db !== db ||
      requiredStores.some((name) => !transaction.storeNames.includes(name))) {
    throw new PushAuthorityIntegrityError('admission_check_requires_current_transaction')
  }
  if (metaProof.spaceId !== spaceId ||
      await sha256Canonical({ spaceId, roots: metaProof.roots }) !== metaProof.proofSha256) {
    throw new PushAuthorityIntegrityError('same_space_meta_proof_mismatch')
  }
  if (evidenceRows.some((item) => item.spaceId !== spaceId)) {
    throw new PushAuthorityIntegrityError('cross_space_terminal_evidence')
  }
  const decision = await classifyReadyAdmissionSnapshot(
    marker, allRows, metaProof, evidenceRows,
  )
  if (decision.kind === 'recoverable') {
    throw new PushAuthorityDriftError(decision.code)
  }
  if (decision.kind === 'integrity_error') {
    throw new PushAuthorityIntegrityError(decision.code)
  }
}

```

A static TypeScript test imports every named helper in this section and rejects declarations without a production definition. `admission.ts` imports shared identity helpers from `authority-identity.ts`; it imports neither push nor terminal coordinators. The post-query coordinator remains owned by `push-batch.ts` and is an explicit internal export for its direct-import race tests:

```typescript
/** @internal Test seam for query-to-push race injection. */
export async function reloadAndRevalidateReceiptImmediatelyBeforePush(
  db: PomodoroXIDB, meta: MetaDB, spaceId: string,
  selected: PushSelection, expectedReceipt: SyncPendingPushBatch,
  token: SpaceAuthorityToken,
): Promise<SyncPendingPushBatch> {
  requireSpaceAuthorityToken(token, spaceId)
  requireSpaceDatabaseBinding(db, spaceId)
  const metaProof = await loadAndRequireSameSpaceReadyMetaProof(meta, spaceId, token)
  return db.transaction(
    'r', db.outbox, db.syncAdmissionState, db.syncPushBatches,
    db.syncTerminalApplications, async () => {
      const marker = await db.syncAdmissionState.get('active')
      const rows = await db.outbox.orderBy('id').toArray()
      const evidence = await db.syncTerminalApplications.where('spaceId').equals(spaceId).toArray()
      await Dexie.waitFor(assertSpaceAdmissionReadyInCurrentTransaction(
        db, spaceId, marker, rows, metaProof, evidence,
      ))
      await reloadCompleteAuthorityAndRequireUnchangedSelection(db, selected)
      const currentReceipt = await loadAndValidateActiveReceiptInCurrentTransaction(db)
      if (!currentReceipt || canonicalize(currentReceipt) !== canonicalize(expectedReceipt)) {
        throw new PushAuthorityIntegrityError('pending_receipt_identity_drift')
      }
      requireReceiptMatchesFrozenAuthority(currentReceipt, selected)
      return currentReceipt
    },
  )
}

export async function pushAllPending(
  db: PomodoroXIDB, meta: MetaDB, spaceId: string, api: AxiosInstance,
): Promise<PushCycleSummary> {
  return withSpaceAuthorityFence(spaceId, (token) =>
    pushAllPendingUnderFence(db, meta, spaceId, api, token))
}

async function pushAllPendingUnderFence(
  db: PomodoroXIDB, meta: MetaDB, spaceId: string, api: AxiosInstance,
  token: SpaceAuthorityToken,
): Promise<PushCycleSummary> {
  requireSpaceAuthorityToken(token, spaceId)
  requireSpaceDatabaseBinding(db, spaceId)
  await reconcilePendingTerminalApplications(db, meta, spaceId, token)
  await resumeImportedProvisionalReviews(db, meta, spaceId, token)
  await admitTs3AwaitingS4(db, meta, spaceId, token)
  const clientId = await getOrCreateClientId(db, spaceId, token)
  const attempted = new Set<string>()
  let authorityRestarts = 0
  let summary: PushCycleSummary = {
    requests: 0, attempted: 0, applied: 0, stoppedForNoProgress: false,
    blockedByOperationState: null,
  }
  while (true) {
    await assertS4AdmissionReady(db, meta, spaceId, token)
    const active = await loadAndValidateActiveReceipt(db)
    const selected = active ? selectionFromReceipt(active) :
      await selectOneAuthorityUnit(db, attempted)
    if (!selected) return summary
    const query = await classifyOperationQuery(api, clientId, selected.operationIds)
    if (query.kind === 'terminal') {
      const applied = await applyTerminalResultTwoPhase(
        db, meta, spaceId, token, selected, query.result, 'operation_query',
      )
      await resumeImportedProvisionalReviews(db, meta, spaceId, token)
      selected.operationIds.forEach((id) => attempted.add(id))
      summary = { ...summary, applied: summary.applied + applied }
      continue
    }
    if (query.kind === 'blocked') {
      return { ...summary, blockedByOperationState: query.state }
    }
    let batch: SyncPendingPushBatch
    try {
      const expected = active ?? await createPendingPushBatchAfterUnknown(
        db, meta, spaceId, clientId, selected, token,
      )
      batch = await reloadAndRevalidateReceiptImmediatelyBeforePush(
        db, meta, spaceId, selected, expected, token,
      )
    } catch (error: unknown) {
      if (!(error instanceof PushAuthorityDriftError) ||
          error.code !== 'new_complete_paired_root') throw error
      if (authorityRestarts >= MAX_AUTHORITY_RESTARTS) {
        throw new PushAuthorityIntegrityError('push_authority_restart_exhausted')
      }
      authorityRestarts += 1
      await admitTs3AwaitingS4(db, meta, spaceId, token)
      continue
    }
    // No await or application work may occur between the transaction above and this call.
    // The same Web Lock remains held across this await and response application.
    const response = await syncV2Push(api, batch)
    const applied = await applyTerminalResultTwoPhase(
      db, meta, spaceId, token, selectionFromReceipt(batch),
      response.data, 'push_response',
    )
    await resumeImportedProvisionalReviews(db, meta, spaceId, token)
    batch.operationIds.forEach((id) => attempted.add(id))
    summary = {
      requests: summary.requests + 1,
      attempted: summary.attempted + batch.operationIds.length,
      applied: summary.applied + applied,
      stoppedForNoProgress: applied === 0,
      blockedByOperationState: null,
    }
    if (applied === 0) return summary
  }
}
```

The lock spans query latency and `syncV2Push` completion, so another compliant Tab cannot create/reparent/resolve/admit any authority row during proof-to-push. Both the new-receipt and active-receipt branches require post-query receipt reload plus transactional admission/complete-root revalidation immediately before every push; a test mutates each frozen Space/Meta/receipt authority after the query resolves and requires zero push. The post-query Meta/Space transaction detects direct IndexedDB bypass and performs zero push. `selectOneAuthorityUnit()` returns the complete `PushSelection` above, calls `prepareHeldProvisionalBatch()` for compounds, isolates one attempted direct WorkItemNote, and otherwise selects an unattempted standalone prefix. A direct Note keeps `batchId == operationId`; a compound keeps `batchId == prepareHeldProvisionalBatch(...).batchId`; only unrelated unattempted standalone rows use the ordered-operation hash. `validatePendingPushReceipt()` recomputes every frozen row/root/payload/request/event hash and requires exact receipt equality after restart; corruption is never classified as recoverable drift.

`terminal-application.ts` gives both terminal sources one two-phase coordinator:

```typescript
// frontend/src/lib/sync/terminal-application.ts
import Dexie from 'dexie'
import { canonicalize } from 'json-canonicalize'
import { canonicalNow } from '@/lib/direct-command-intents'
import {
  INITIAL_S4_OUTBOX_FIELDS,
  type PomodoroXIDB, type SyncTerminalApplicationEvidence,
} from '@/services/database'
import type { MetaDB } from '@/services/meta-database'
import type { OutboxEvent } from '@/types'
import type { ApiSyncV2PushResponse } from './types'
import { requireCanonicalStoredTimestamp } from './response-schema'
import {
  deterministicTerminalNextAttempt, encodeBase64, freezeOutboxIdentity,
  loadAndValidateActiveReceiptInCurrentTransaction,
  parseAndValidateTerminalEvidenceResult,
  PushAuthorityIntegrityError, reloadCompleteAuthorityAndRequireUnchangedSelection,
  requireReceiptMatchesFrozenAuthority, requireSameFrozenIdentity,
  requireTerminalDiagnosticMatchesEvidence,
  sha256Canonical, sha256HexBytes, type PushSelection,
} from './authority-identity'
import {
  requireSpaceAuthorityToken, requireSpaceDatabaseBinding,
  type SpaceAuthorityToken,
} from './space-authority-fence'

/** @internal Test seam; production callers use applyTerminalResultTwoPhase. */
export function requireExactTerminalCoverage(
  selected: PushSelection,
  result: ApiSyncV2PushResponse,
): void {
  if (result.batch_id !== selected.authority.batchId) {
    throw new PushAuthorityIntegrityError('terminal_batch_identity_mismatch')
  }
  const outcomeIds = [
    ...result.applied.map((item) => item.operation_id),
    ...result.conflicts.map((item) => item.operation_id),
    ...result.errors.map((item) => item.operation_id),
  ]
  if (new Set(outcomeIds).size !== outcomeIds.length ||
      canonicalize([...outcomeIds].sort()) !==
        canonicalize([...selected.operationIds].sort())) {
    throw new PushAuthorityIntegrityError('terminal_operation_coverage_mismatch')
  }
  const frozenByOperation = new Map(
    selected.frozenRows.map((row) => [row.operationId, row]),
  )
  for (const outcome of [
    ...result.applied, ...result.conflicts, ...result.errors,
  ]) {
    const frozen = frozenByOperation.get(outcome.operation_id)
    if (!frozen || outcome.entity_type !== frozen.entityType ||
        outcome.entity_id !== frozen.entityId) {
      throw new PushAuthorityIntegrityError('terminal_entity_identity_mismatch')
    }
  }
}

async function buildTerminalApplicationEvidence(
  spaceId: string, selected: PushSelection, result: ApiSyncV2PushResponse,
  source: SyncTerminalApplicationEvidence['source'],
): Promise<SyncTerminalApplicationEvidence> {
  requireExactTerminalCoverage(selected, result)
  const resultCanonical = canonicalize(result)
  if (resultCanonical === undefined) {
    throw new PushAuthorityIntegrityError('terminal_result_not_canonical')
  }
  const resultBytes = new TextEncoder().encode(resultCanonical)
  const resultSha256 = await sha256HexBytes(resultBytes)
  const operationIdsSha256 = await sha256Canonical(selected.operationIds)
  const identity = {
    spaceId, batchId: selected.authority.batchId,
    authorityKind: selected.authority.kind,
    readyRootSetSha256: selected.readyRootSetSha256,
    operationIds: [...selected.operationIds], operationIdsSha256, resultSha256,
  }
  return {
    evidenceId: await sha256Canonical(identity),
    spaceId, source, state: 'space_committed',
    authorityKind: selected.authority.kind,
    batchId: selected.authority.batchId,
    compoundOperationId: selected.authority.compoundOperationId,
    operationIds: [...selected.operationIds], operationIdsSha256,
    readyRoots: structuredClone([...selected.readyRoots]),
    readyRootSetSha256: selected.readyRootSetSha256,
    resultCanonicalBase64: encodeBase64(resultBytes), resultSha256,
    appliedCount: result.applied.length,
    committedAt: canonicalNow(), metaReconciledAt: null,
  }
}

/** @internal Test seam; production callers use applyTerminalResultTwoPhase. */
export function requireSameTerminalEvidence(
  existing: SyncTerminalApplicationEvidence,
  candidate: SyncTerminalApplicationEvidence,
): void {
  const identityKeys = [
    'evidenceId', 'spaceId', 'authorityKind', 'batchId', 'compoundOperationId',
    'operationIds', 'operationIdsSha256', 'readyRoots', 'readyRootSetSha256',
    'resultCanonicalBase64', 'resultSha256', 'appliedCount',
  ] as const
  for (const key of identityKeys) {
    if (canonicalize(existing[key]) !== canonicalize(candidate[key])) {
      throw new PushAuthorityIntegrityError(`terminal_evidence_mismatch:${key}`)
    }
  }
}

/** @internal Test seam; call only inside the coordinator transaction. */
export async function deleteOnlyAppliedFrozenRows(
  db: PomodoroXIDB, spaceId: string, token: SpaceAuthorityToken,
  selected: PushSelection, result: ApiSyncV2PushResponse,
): Promise<void> {
  requireSpaceAuthorityToken(token, spaceId)
  requireSpaceDatabaseBinding(db, spaceId)
  const applied = new Set(result.applied.map((item) => item.operation_id))
  for (const frozen of selected.frozenRows) {
    if (!applied.has(frozen.operationId)) continue
    const current = await db.outbox.get(frozen.durableKey)
    if (!current) throw new PushAuthorityIntegrityError('applied_outbox_row_missing')
    requireSameFrozenIdentity(frozen, await Dexie.waitFor(freezeOutboxIdentity(current)))
    await db.outbox.delete(frozen.durableKey)
  }
}

/** @internal Test seam; call only inside the coordinator transaction. */
export async function applyTerminalOutcomesWithoutDeletingSuccessors(
  db: PomodoroXIDB, spaceId: string, token: SpaceAuthorityToken,
  rows: readonly OutboxEvent[], result: ApiSyncV2PushResponse,
  terminalizedAt: string,
): Promise<void> {
  requireSpaceAuthorityToken(token, spaceId)
  requireSpaceDatabaseBinding(db, spaceId)
  const currentByOperation = new Map(rows.map((row) => [row.operationId, row]))
  for (const [kind, outcome] of [
    ...result.conflicts.map((item) => ['terminal_conflict', item] as const),
    ...result.errors.map((item) => ['terminal_error', item] as const),
  ]) {
    const row = currentByOperation.get(outcome.operation_id)
    if (!row) throw new PushAuthorityIntegrityError('terminal_rejection_row_missing')
    const outcomeCanonical = canonicalize(outcome)
    if (outcomeCanonical === undefined) {
      throw new PushAuthorityIntegrityError('terminal_outcome_not_canonical')
    }
    if (!Number.isSafeInteger(row.id) || row.id! < 1) {
      throw new PushAuthorityIntegrityError('terminal_rejection_durable_key_invalid')
    }
    await db.outbox.update(row.id!, {
      serverOutcomeCanonicalBase64: encodeBase64(
        new TextEncoder().encode(outcomeCanonical)),
      transportState: kind,
      retryable: 'retryable' in outcome ? outcome.retryable : false,
      nextAttemptAt: 'retryable' in outcome && outcome.retryable
        ? deterministicTerminalNextAttempt(row.attemptCount, terminalizedAt) : null,
    })
  }
}

const RETRY_SUCCESSOR_IMMUTABLE_KEYS = [
  'entityType', 'entityId', 'action', 'payload', 'payloadHash',
  'expectedVersion', 'requiresVersionRebase', 'createdAt',
] as const satisfies readonly (keyof OutboxEvent)[]

function requireRetrySuccessorMatchesOriginal(
  original: OutboxEvent,
  successor: OutboxEvent,
  successorOperationId: string,
): void {
  if (successor.operationId !== successorOperationId ||
      successorOperationId === original.operationId ||
      successor.retryPredecessorOperationId !== original.operationId ||
      successor.compoundOperationId !== null || successor.compoundOrder !== null) {
    throw new PushAuthorityIntegrityError('terminal_retry_successor_link_mismatch')
  }
  for (const key of RETRY_SUCCESSOR_IMMUTABLE_KEYS) {
    if (canonicalize(successor[key]) !== canonicalize(original[key])) {
      throw new PushAuthorityIntegrityError(`terminal_retry_successor_drift:${key}`)
    }
  }
}

async function requireExistingRetrySuccessor(
  db: PomodoroXIDB,
  original: OutboxEvent,
  successorOperationId: string,
  evidenceRows: readonly SyncTerminalApplicationEvidence[],
): Promise<void> {
  const liveSuccessors = await db.outbox
    .filter((row) => row.retryPredecessorOperationId === original.operationId)
    .toArray()
  const candidateEvidence = evidenceRows.filter((evidence) =>
    evidence.readyRoots.some((root) => root.orderedChildren.some((child) =>
      child.operationId === successorOperationId)))
  const appliedEvidence: SyncTerminalApplicationEvidence[] = []
  for (const evidence of candidateEvidence) {
    const result = await parseAndValidateTerminalEvidenceResult(evidence)
    if (result.applied.some((item) => item.operation_id === successorOperationId)) {
      appliedEvidence.push(evidence)
    }
  }
  if (liveSuccessors.length === 1 && appliedEvidence.length === 0) {
    requireRetrySuccessorMatchesOriginal(
      original, liveSuccessors[0]!, successorOperationId,
    )
    return
  }
  if (liveSuccessors.length === 0 && appliedEvidence.length === 1) return
  throw new PushAuthorityIntegrityError('terminal_retry_successor_lineage_invalid')
}

export async function createRetrySuccessorFromTerminalError(input: {
  db: PomodoroXIDB; spaceId: string; token: SpaceAuthorityToken;
  durableKey: number; operationId: string; now: string;
}): Promise<string> {
  requireSpaceAuthorityToken(input.token, input.spaceId)
  requireSpaceDatabaseBinding(input.db, input.spaceId)
  const now = requireCanonicalStoredTimestamp(input.now)
  const nowMs = Date.parse(now)
  return input.db.transaction(
    'rw', input.db.outbox, input.db.syncTerminalApplications, async () => {
    const original = await input.db.outbox.get(input.durableKey)
    if (!original || original.spaceId !== input.spaceId ||
        original.operationId !== input.operationId) {
      throw new PushAuthorityIntegrityError('terminal_error_not_retryable')
    }
    const spaceEvidence = await input.db.syncTerminalApplications
      .where('spaceId').equals(input.spaceId).toArray()
    const matchingEvidence = spaceEvidence
      .filter((evidence) => evidence.readyRoots.some((root) =>
        root.orderedChildren.some((child) =>
          child.operationId === original.operationId && child.durableKey === original.id)))
    if (matchingEvidence.length !== 1) {
      throw new PushAuthorityIntegrityError('terminal_retry_evidence_coverage_mismatch')
    }
    const evidence = matchingEvidence[0]!
    const result = await Dexie.waitFor(
      parseAndValidateTerminalEvidenceResult(evidence),
    )
    await Dexie.waitFor(
      requireTerminalDiagnosticMatchesEvidence(original, evidence, result),
    )
    const nextAttemptMs = original?.nextAttemptAt === null || !original
      ? Number.NaN : Date.parse(original.nextAttemptAt)
    if (original.transportState !== 'terminal_error' || !original.retryable ||
        original.nextAttemptAt === null || original.compoundOperationId !== null ||
        !Number.isFinite(nowMs) || !Number.isFinite(nextAttemptMs) ||
        nowMs < nextAttemptMs) {
      throw new PushAuthorityIntegrityError('terminal_error_not_retryable')
    }
    if (original.retrySuccessorOperationId !== null) {
      await Dexie.waitFor(requireExistingRetrySuccessor(
        input.db, original, original.retrySuccessorOperationId, spaceEvidence,
      ))
      return original.retrySuccessorOperationId
    }
    const successorOperationId = crypto.randomUUID()
    await input.db.outbox.add({
      ...original, id: undefined, operationId: successorOperationId,
      transportState: 'awaiting_s4', attemptCount: 0,
      compoundOperationId: null, compoundOrder: null,
      ...INITIAL_S4_OUTBOX_FIELDS,
      retryPredecessorOperationId: original.operationId,
      synced: false, lastError: null, lastErrorCode: null, failedAt: null,
    })
    const consumed = await input.db.outbox
      .where(':id').equals(original.id!)
      .and((row) => row.operationId === original.operationId &&
        row.retrySuccessorOperationId === null)
      .modify({ retrySuccessorOperationId: successorOperationId })
    if (consumed !== 1) {
      throw new PushAuthorityIntegrityError('terminal_retry_intent_cas_failed')
    }
    return successorOperationId
  })
}

/** @internal Test seam; call only inside the coordinator transaction. */
export async function deleteExactActiveReceiptIfPresent(
  db: PomodoroXIDB, spaceId: string, token: SpaceAuthorityToken,
  selected: PushSelection,
): Promise<void> {
  requireSpaceAuthorityToken(token, spaceId)
  requireSpaceDatabaseBinding(db, spaceId)
  const receipt = await loadAndValidateActiveReceiptInCurrentTransaction(db)
  if (!receipt) return
  requireReceiptMatchesFrozenAuthority(receipt, selected)
  await db.syncPushBatches.delete('active')
}

export async function applyTerminalResultTwoPhase(
  db: PomodoroXIDB, meta: MetaDB, spaceId: string,
  token: SpaceAuthorityToken, selected: PushSelection,
  result: ApiSyncV2PushResponse,
  source: SyncTerminalApplicationEvidence['source'],
): Promise<number> {
  requireSpaceAuthorityToken(token, spaceId)
  requireSpaceDatabaseBinding(db, spaceId)
  const evidence = await buildTerminalApplicationEvidence(spaceId, selected, result, source)
  await db.transaction(
    'rw', db.outbox, db.syncAdmissionState, db.syncPushBatches,
    db.syncTerminalApplications, db.syncConflicts, async () => {
      const rows = await reloadCompleteAuthorityAndRequireUnchangedSelection(db, selected)
      requireExactTerminalCoverage(selected, result)
      const existing = await db.syncTerminalApplications.get(evidence.evidenceId)
      if (existing) requireSameTerminalEvidence(existing, evidence)
      else await db.syncTerminalApplications.add(evidence) // first write in this transaction
      const terminalizedAt = existing?.committedAt ?? evidence.committedAt
      await applyTerminalOutcomesWithoutDeletingSuccessors(
        db, spaceId, token, rows, result, terminalizedAt,
      )
      await deleteOnlyAppliedFrozenRows(db, spaceId, token, selected, result)
      await deleteExactActiveReceiptIfPresent(db, spaceId, token, selected)
    },
  )
  await reconcileTerminalApplicationEvidence(db, meta, spaceId, token, evidence.evidenceId)
  return evidence.appliedCount
}

export async function reconcileTerminalApplicationEvidence(
  db: PomodoroXIDB, meta: MetaDB, spaceId: string,
  token: SpaceAuthorityToken, evidenceId: string,
): Promise<void> {
  requireSpaceAuthorityToken(token, spaceId)
  requireSpaceDatabaseBinding(db, spaceId)
  const evidence = await db.syncTerminalApplications.get(evidenceId)
  if (!evidence || evidence.spaceId !== spaceId) {
    throw new PushAuthorityIntegrityError('terminal_evidence_missing')
  }
  if (evidence.compoundOperationId !== null) {
    const root = evidence.readyRoots.find((item) =>
      item.rootKind === 'compound' && item.rootId === evidence.compoundOperationId)
    if (!root) throw new PushAuthorityIntegrityError('terminal_compound_root_missing')
    await resolveTransportTerminal(meta, spaceId, token, {
      operationId: evidence.compoundOperationId,
      transportReadyRootSha256: root.rootSha256,
      terminalEvidenceId: evidence.evidenceId,
      terminalResultSha256: evidence.resultSha256,
      terminalOperationIdsSha256: evidence.operationIdsSha256,
      updatedAt: evidence.committedAt,
    })
  }
  await db.transaction('rw', db.syncTerminalApplications, async () => {
    const current = await db.syncTerminalApplications.get(evidenceId)
    if (!current) throw new PushAuthorityIntegrityError('terminal_evidence_disappeared')
    requireSameTerminalEvidence(current, evidence)
    await db.syncTerminalApplications.update(evidenceId, {
      state: 'meta_reconciled', metaReconciledAt: canonicalNow(),
    })
  })
}

export async function reconcilePendingTerminalApplications(
  db: PomodoroXIDB, meta: MetaDB, spaceId: string, token: SpaceAuthorityToken,
): Promise<void> {
  requireSpaceAuthorityToken(token, spaceId)
  requireSpaceDatabaseBinding(db, spaceId)
  const pending = await db.syncTerminalApplications
    .where('spaceId').equals(spaceId)
    .and((row) => row.state === 'space_committed').sortBy('evidenceId')
  for (const evidence of pending) {
    await reconcileTerminalApplicationEvidence(db, meta, spaceId, token, evidence.evidenceId)
  }
}
```

The same Task 7 handoff resumes a review draft only after the imported root is
fully transport-resolved. Reuse TS3 Task 9's unchanged
`applyAuthoritativeReviewAndClearDraft`; merge only this recovery function into
`focus-session-repository.ts`:

```typescript
export async function resumeImportedProvisionalReviews(
  db: PomodoroXIDB,
  meta: MetaDB,
  spaceId: string,
  token: SpaceAuthorityToken,
): Promise<void> {
  requireSpaceAuthorityToken(token, spaceId)
  requireSpaceDatabaseBinding(db, spaceId)
  const draftRows = await db.sessionReviewDrafts
    .where('spaceId').equals(spaceId).sortBy('sessionId')
  for (const draftRow of draftRows) {
    const draft = sessionReviewDraftSchema.parse(JSON.parse(draftRow.draftJson))
    if (draft.spaceId !== spaceId || draft.sessionId !== draftRow.sessionId ||
        draft.operationId !== draftRow.operationId) {
      throw new Error('imported_review_draft_identity_mismatch')
    }
    const roots = await meta.provisionalOperations
      .where('sessionId').equals(draft.sessionId)
      .and((row) => row.spaceId === spaceId && row.state === 'transport_resolved')
      .toArray()
    if (roots.length === 0) continue
    if (roots.length !== 1) throw new Error('imported_review_root_ambiguous')
    const root = roots[0]!
    if (root.terminalEvidenceId === null || root.terminalResultSha256 === null ||
        root.terminalOperationIdsSha256 === null ||
        root.transportReadyRootSha256 === null) {
      throw new Error('imported_review_transport_resolution_incomplete')
    }
    const evidence = await db.syncTerminalApplications.get(root.terminalEvidenceId)
    if (!evidence || evidence.state !== 'meta_reconciled' ||
        evidence.spaceId !== spaceId ||
        evidence.compoundOperationId !== root.operationId ||
        evidence.resultSha256 !== root.terminalResultSha256 ||
        evidence.operationIdsSha256 !== root.terminalOperationIdsSha256 ||
        evidence.readyRoots.length !== 1 ||
        evidence.readyRoots[0]!.rootKind !== 'compound' ||
        evidence.readyRoots[0]!.rootId !== root.operationId ||
        evidence.readyRoots[0]!.rootSha256 !== root.transportReadyRootSha256) {
      throw new Error('imported_review_terminal_evidence_mismatch')
    }
    const terminalResult = await parseAndValidateTerminalEvidenceResult(evidence)
    const importedRoot = evidence.readyRoots[0]!
    const focusChildren = importedRoot.orderedChildren.filter((child) =>
      child.entityType === 'focusSession' && child.entityId === draft.sessionId &&
      child.action === 'create' && child.compoundOperationId === root.operationId)
    if (terminalResult.conflicts.length !== 0 || terminalResult.errors.length !== 0 ||
        terminalResult.applied.length !== evidence.operationIds.length ||
        evidence.appliedCount !== evidence.operationIds.length ||
        focusChildren.length !== 1 ||
        !terminalResult.applied.some((item) =>
          item.operation_id === focusChildren[0]!.operationId &&
          item.entity_type === 'focusSession' && item.entity_id === draft.sessionId)) {
      throw new Error('imported_review_root_not_fully_applied')
    }
    const existingIntent = await db.directCommandIntents.get(draft.operationId)
    let intent: NonNullable<typeof existingIntent>
    if (existingIntent) {
      const exactRequest = sessionReviewDraftSchema.parse(
        JSON.parse(existingIntent.requestJson),
      )
      const { expectedVersion: _persistedCas, ...persistedBusiness } = exactRequest
      const { expectedVersion: _preImportCas, ...draftBusiness } = draft
      if (existingIntent.kind !== 'submit_review' ||
          existingIntent.spaceId !== spaceId ||
          existingIntent.targetId !== draft.sessionId ||
          !['prepared', 'in_flight'].includes(existingIntent.state) ||
          exactRequest.operationId !== draft.operationId ||
          exactRequest.expectedVersion <= 0 ||
          canonicalize(exactRequest) !== existingIntent.requestJson ||
          canonicalize(persistedBusiness) !== canonicalize(draftBusiness) ||
          await hashCommandPayload(exactRequest as JsonValue) !== existingIntent.requestHash) {
        throw new Error('imported_review_existing_intent_mismatch')
      }
      intent = existingIntent
    } else {
      const session = await db.focusSessions.get(draft.sessionId)
      const outcomeCount = await db.sessionWorkItemOutcomes
        .where('sessionId').equals(draft.sessionId).count()
      if (!session || session.version <= 0 || session.endedAt === null ||
          session.clockState !== 'ended' ||
          session.ownershipState !== 'local_provisional' ||
          session.validity !== 'pending' || session.reviewState !== 'pending' ||
          outcomeCount !== 0) {
        throw new Error('imported_review_authoritative_session_not_ready')
      }
      const request = sessionReviewDraftSchema.parse({
        ...draft,
        expectedVersion: session.version,
      })
      intent = await prepareDirectCommandIntent(db, {
        kind: 'submit_review', spaceId, targetId: draft.sessionId,
        request, now: canonicalNow(),
      }, draft.operationId)
    }
    await executeDurableDirectCommand({
      db,
      intent,
      businessTables: [
        db.focusSessions, db.sessionWorkItemOutcomes,
        db.sessionCommandEnvelopes, db.sessionCommandReceipts,
        db.sessionCommandQueue, db.sessionReviewDrafts,
      ],
      sendExactRequest: (exact) => focusSessionApi.submitReview(exact),
      parseResult: (value) => focusSessionAggregateSchema.parse(value),
      applyResult: (response) => applyAuthoritativeReviewAndClearDraft(
        db, spaceId, draft.sessionId, intent.requestJson, 'import_rebased', response,
      ),
      now: canonicalNow,
    })
  }
}
```

TS3 Task 9 owns the only `applyAuthoritativeReviewAndClearDraft` transaction
helper. Both its ordinary online `submitReview` branch and this imported-review
resume call that same helper; Task 7 does not copy or inline a second apply
path. Before projection or writes, `toReviewRows` binds the response Session,
optional context, attribution, every plan/outcome/envelope, and every receipt's
envelope membership plus every nonnull Outcome command link to the expected
Space and Session. The helper receives `intent.requestJson` with the explicit
`import_rebased` expected-version policy, requires its canonical request and
the current draft's complete review business fields to match both before apply
and before delete, and refuses to run outside the same full-store Dexie
transaction. It installs the
parsed Session, Outcomes, immutable envelopes, receipts, and queue rows first,
then deletes exactly `[spaceId, sessionId]` only when its stored operation ID
still equals the original draft operation ID. It never runs before the HTTP
response is parsed. Resume first verifies the exact `meta_reconciled` terminal evidence,
all root/hash bindings, an all-applied result, and the expected FocusSession
create child. It then loads the existing direct intent before consulting the
current Session version. A prepared/in-flight intent must retain the original
operation ID, business fields, request bytes/hash, and its first authoritative
CAS version and is reused exactly; only when no intent exists does
`prepareDirectCommandIntent` create one from the current imported authoritative
Session version. Thus a server-commit/response-loss restart cannot rebuild the
request because a later pull changed the local version. The review business
fields and their hash input remain byte-for-byte the original draft values.

```typescript
// append to frontend/src/lib/focus-session/focus-session-repository.test.ts
it('resumes the original review only after exact transport resolution', async () => {
  const fixture = importedProvisionalReviewFixture({
    metaState: 'transport_ready', authoritativeVersion: 7,
    draftOperationId: 'offline-review-1',
  })
  const heldBatchBefore = await fixture.originalHeldBatch()
  await fixture.resumeImportedReviews()
  expect(fixture.api.submitReview).not.toHaveBeenCalled()
  expect(await fixture.draft()).toMatchObject({ operationId: 'offline-review-1' })
  expect(await fixture.originalHeldBatch()).toEqual(heldBatchBefore)
  expect(await fixture.outcomes()).toEqual([])

  await fixture.installExactTransportResolvedEvidence()
  fixture.api.submitReview.mockResolvedValue(authoritativeCompletedReview())
  await fixture.resumeImportedReviews()
  expect(fixture.api.submitReview).toHaveBeenCalledWith(expect.objectContaining({
    operationId: 'offline-review-1', expectedVersion: 7,
    validity: 'valid', reviewState: 'completed',
  }))
  expect(await fixture.draft()).toBeUndefined()
  expect(await fixture.outcomes()).not.toEqual([])
})

it.each([
  'space_committed', 'wrong_ready_root_sha', 'wrong_result_sha',
  'wrong_operation_ids_sha', 'terminal_conflict',
])('rejects imported-review evidence drift %s before TS2 review', async (mutation) => {
  const fixture = importedProvisionalReviewFixture({
    metaState: 'transport_resolved', authoritativeVersion: 7,
    draftOperationId: 'offline-review-1',
  })
  await fixture.installExactTransportResolvedEvidence()
  await fixture.mutateTerminalEvidence(mutation)
  await expect(fixture.resumeImportedReviews())
    .rejects.toThrow(/imported_review_terminal_evidence_mismatch|imported_review_root_not_fully_applied/)
  expect(fixture.api.submitReview).not.toHaveBeenCalled()
  expect(await fixture.draft()).toMatchObject({ operationId: 'offline-review-1' })
})

it('reuses one durable imported-review intent after response loss and restart', async () => {
  const fixture = importedProvisionalReviewFixture({
    metaState: 'transport_resolved', authoritativeVersion: 7,
    draftOperationId: 'offline-review-1', commitThenLoseResponse: true,
  })
  await expect(fixture.resumeImportedReviews()).rejects.toThrow('network_lost')
  expect(await fixture.draft()).toMatchObject({ operationId: 'offline-review-1' })
  expect(await fixture.directIntent()).toMatchObject({ operationId: 'offline-review-1' })

  await fixture.reopen()
  await fixture.installPulledCompletedReview({ version: 8, outcomeCount: 1 })
  expect(await fixture.session()).toMatchObject({ version: 8, reviewState: 'completed' })
  expect(await fixture.outcomes()).toHaveLength(1)
  await fixture.resumeImportedReviews()
  expect(fixture.api.operationIds()).toEqual([
    'offline-review-1', 'offline-review-1',
  ])
  expect(fixture.api.expectedVersions()).toEqual([7, 7])
  expect(await fixture.draft()).toBeUndefined()
})
```

`buildTerminalApplicationEvidence()` strictly validates complete response coverage, canonicalizes the entire parsed result once, hashes its exact UTF-8 bytes, hashes ordered operation IDs, and derives `evidenceId = SHA256(canonical({spaceId,batchId,authorityKind,readyRootSetSha256,operationIds,resultSha256}))`; `source` is recorded but deliberately excluded from identity so a later query can recognize the same pushed result. The Space transaction adds or exact-compares evidence before any applied-row/receipt delete. Conflicts/errors retain their frozen outbox row and exact server outcome; applied deletion requires every frozen identity field to still match and never deletes a successor operation.

For a compound, `reconcileTerminalApplicationEvidence()` reads the evidence, then one Meta transaction requires `operationId == compoundOperationId`, `state in {'transport_ready','transport_resolved'}`, and exact `transportReadyRootSha256`; `transport_ready` is updated to `transport_resolved` with `terminalEvidenceId`, `terminalResultSha256`, and the ordered-operation-ID SHA-256, while an already `transport_resolved` row succeeds only on exact equality. `activation_resolved` is rejected on this path. A final Space transaction changes evidence from `space_committed` to `meta_reconciled` only if those same bindings still match. Standalone/direct-Note evidence is marked `meta_reconciled` without a Meta row. `reconcilePendingTerminalApplications()` scans `space_committed` evidence under the fence at startup/before admission and invokes that same idempotent function. A crash after Space commit sees evidence plus applied-row/receipt deletion and Meta still `transport_ready`; a crash after Meta commit but before the final mark sees exact `transport_resolved` bindings; both converge without query/push replay. Ready proof treats only these exact evidence states as the explanation for a disappeared root.

Conflict/error rows retained for diagnosis are terminalized in that same Space
transaction, so they disappear from the `ready` selection without being
deleted. Ready classification requires each such row to match exactly one
evidence child on every frozen field other than the evidence-authorized
`transportState` transition; its `serverOutcomeCanonicalBase64`, `retryable`,
and `nextAttemptAt` must equal the exact canonical conflict/error outcome and
the schedule derived from the evidence's immutable `committedAt`. The same
proof requires the resolved Meta row's `terminalOperationIdsSha256`. An
unrelated or diagnostically drifted terminal-state row is corruption. Explicit retry
never reopens the terminal original: after the durable `nextAttemptAt`,
`createRetrySuccessorFromTerminalError` creates at most one new standalone
operation under the same fence and one transaction that also reloads exactly
one matching `syncTerminalApplications` row. The retry gate revalidates that
evidence's canonical result/hash/authority and the original row's exact
diagnostic bytes, retryability, and evidence-`committedAt` schedule before
comparing `now`. A null-to-new-ID conditional update consumes the original retry
intent in the same transaction that inserts the successor; the original retains
its immutable diagnostic fields plus `retrySuccessorOperationId`, while the new
row receives `retryPredecessorOperationId`. Repeating the call after commit or
response loss validates the only live linked successor, or exact applied
terminal evidence after that row was deleted, and returns the same ID. A missing,
drifted, duplicated, or forked link fails closed with zero writes. A later
retryable failure can extend the lineage only from that successor, producing a
linear chain. The successor preserves the original canonical payload/business
hash and `createdAt`, clears prior server-outcome fields, and enters normal
`awaiting_s4` admission. A compound child is not silently rebound to its already
resolved root.

`applyTerminalOutcomesWithoutDeletingSuccessors`, `deleteOnlyAppliedFrozenRows`, `deleteExactActiveReceiptIfPresent`, `requireExactTerminalCoverage`, and `requireSameTerminalEvidence` are explicit `/** @internal */ export` test seams in `terminal-application.ts`; `buildPersistAndValidateExactReceipt` and `requireReceiptMatchesFrozenAuthority` are the corresponding shared `/** @internal */` exports in `authority-identity.ts`. They are not part of the barrel/public product interface, but that annotation is not treated as access control: all four mutating exports require explicit `spaceId + SpaceAuthorityToken`, validate it before their first read/write, and receive the same live token from the coordinator call site. The helpers compare the full frozen identity/result canonical bytes and throw `PushAuthorityIntegrityError` before mutation on mismatch. No prior `applyExactPushResponse` or `applyQueriedTerminalBatchResult` path remains.

`terminal-application.test.ts` and `admission.test.ts` include
`test_ready_proof_requires_terminal_operation_ids_hash`,
`test_ready_proof_rejects_terminal_diagnostic_bytes_retryable_and_schedule_drift`,
`test_receipt_rejects_unknown_authority_kind_and_duplicate_root_operation_or_durable_ids`,
`test_retry_schedule_uses_committed_evidence_time_across_replay`,
`test_retry_intent_is_idempotent_after_commit_response_loss`,
`test_retry_intent_two_db_handles_creates_one_successor`,
`test_retry_lineage_missing_or_drift_fails_closed`, and
`test_retry_failure_forms_linear_successor_chain`. The first three independently
mutate every named field/identity class; the schedule test reapplies the same
evidence after a later wall-clock time and requires the original `nextAttemptAt`
byte string. The lineage tests require sequential replay, two-handle
serialization, and a reopened database to return one identical successor ID;
inject missing/wrong/forked links with zero new writes; prove an applied successor
through exact terminal evidence; and prove a later retry extends one linear chain
rather than creating a sibling operation.

- [ ] **Step 7: Extend TS0's OpenAPI gate and regenerate, never hand-edit, TypeScript types**

Keep TS0's deterministic writer and add the final-route assertion before writing:

```python
def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    document = create_app().openapi()
    paths = set(document["paths"])
    required = {spec.rest_path for spec in SYNC_OPERATIONS}
    forbidden = {
        "/api/v1/sync/push",
        "/api/v1/sync/pull",
        "/api/v1/sync/full",
        "/api/v1/sync/status",
    }
    if not required <= paths or forbidden & paths:
        raise RuntimeError("final Sync OpenAPI route set is inconsistent")
    args.output.write_text(
        json.dumps(document, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    return 0
```

Verify the TS0 package script remains exactly:

```json
{
  "scripts": {
    "generate:api": "uv run --project ../backend python ../backend/scripts/export_openapi.py --output openapi.json && openapi-typescript openapi.json -o src/types/api-generated.ts"
  }
}
```

Run:

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
cd frontend
npm ls json-canonicalize@2.0.0 --depth=0
Copy-Item ..\backend\tests\fixtures\sync_event_canonical_vectors.json .\src\lib\sync\fixtures\sync-event-canonical-vectors.json -Force
npm run generate:api
npm run typecheck
```

Expected: `package.json`/`package-lock.json` resolve exactly `json-canonicalize@2.0.0`; frontend vector bytes equal the backend authority; generated `SyncV2*` schemas contain all six operations including operation-query's four states/full terminal `SyncV2PushResponse`, use `string` cursors/page tokens, and compile without a handwritten cast to a numeric cursor.

- [ ] **Step 8: Run all focused frontend protocol tests**

Run:

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
cd frontend
npm run test -- --run src/services/database.test.ts src/services/meta-database.test.ts src/lib/sync/space-authority-fence.test.ts src/lib/sync/authority-identity.test.ts src/lib/sync/admission.test.ts src/lib/sync/terminal-application.test.ts src/lib/sync/transport.test.ts src/lib/sync/recovery.test.ts src/lib/sync/pull-loop.test.ts src/lib/sync/push-batch.test.ts src/lib/sync/merge.test.ts src/lib/sync/sync-meta.test.ts src/lib/sync/engine.test.ts
npm run test
npm run lint
npm run typecheck
```

Expected: PASS; TS3 v18 business/conflict rows and S3 operation/compound authority survive v19. Every admitted root persists an ordered full-field child tuple plus root/root-set SHA-256; any entity/action/payload/hash/operation/version/timestamp/transport/compound/order/attempt drift fails closed. All enumerated authority writers require a live same-Space token. Two Tabs prove Tab B cannot write while Tab A holds the Web Lock across query and push completion on both new/active receipt paths; missing/forged/expired tokens fail before writes, while direct IndexedDB bypass corruption is caught post-query with zero push. Both queried-terminal and pushed-terminal paths persist exact Space evidence before applied-row/receipt deletion, recover crashes on either side of the Meta commit, and idempotently bind `transport_ready -> transport_resolved` by root/operation/result identity without an orphan false positive; TS3 activation completion remains separate as `activation_resolved`. A pre-import review leaves the original held batch unchanged and retains its structured draft; only matching `transport_resolved` evidence resumes the original review operation against the authoritative imported Session version, and response-loss restart reuses one direct intent before authoritative success deletes the draft. Only `new_complete_paired_root` receives one restart; a second occurrence exits `push_authority_restart_exhausted` with at most two queries and zero stale push. Query-first, blocker-first classification, direct WorkItemNote `batchId == operationId`, compound `batchId == prepareHeldProvisionalBatch(...).batchId`, strict parsers, six transports, crash recovery, persist-before-ACK, and admission/recovery-before-push all remain green.

The payload proof also passes every entity/action hash vector: full canonical
post-image bytes are frozen independently from the command-specific business
hash, including WorkItemNote `{document}` and an LWW entity. Mixed terminal
results retain conflict/error diagnostics only in non-sendable terminal states;
restart does not query them again, and an explicit retry creates exactly one
durably linked new-operation successor without changing the original
compound/root or caller timestamp; repeat intent returns the same ID.

- [ ] **Step 9: Commit the minimal official-client protocol update**

```powershell
git add frontend/src/services/database.ts frontend/src/services/database.test.ts frontend/src/services/dexie-v18-cutover.ts frontend/src/services/dexie-v18-cutover.test.ts frontend/src/services/space-db.ts frontend/src/services/space-db.test.ts frontend/src/services/meta-database.ts frontend/src/services/meta-database.test.ts frontend/src/types/index.ts frontend/src/lib/contracts/task-space.ts frontend/src/lib/contracts/focus-session.ts frontend/src/lib/sync/outbox.ts frontend/src/lib/sync/outbox.test.ts frontend/src/lib/sync/provisional-operation-authority.ts frontend/src/lib/sync/provisional-operation-authority.test.ts frontend/src/lib/task-space/work-item-note-repository.ts frontend/src/lib/task-space/work-item-note-repository.test.ts frontend/src/lib/quick-notes/quick-note-repository.ts frontend/src/lib/quick-notes/quick-note-repository.test.ts frontend/src/lib/sync/quick-note-sync.integration.test.ts frontend/src/stores/trash-store.ts frontend/src/stores/trash-store.test.ts frontend/src/lib/focus-session/focus-session-repository.ts frontend/src/lib/focus-session/focus-session-repository.test.ts frontend/src/lib/focus-session/provisional-start-recovery.ts frontend/src/lib/focus-session/provisional-start-recovery.test.ts frontend/src/lib/focus-session/active-session-coordinator.ts frontend/src/lib/focus-session/active-session-coordinator.test.ts frontend/src/lib/sync/space-authority-fence.ts frontend/src/lib/sync/space-authority-fence.test.ts frontend/src/lib/sync/authority-identity.ts frontend/src/lib/sync/authority-identity.test.ts frontend/src/lib/sync/entity-payload-hash.ts frontend/src/lib/sync/entity-payload-hash.test.ts frontend/src/lib/sync/admission.ts frontend/src/lib/sync/admission.test.ts frontend/src/lib/sync/terminal-application.ts frontend/src/lib/sync/terminal-application.test.ts frontend/src/lib/sync/client-registry.ts frontend/src/lib/sync/transport.ts frontend/src/lib/sync/response-schema.ts frontend/src/lib/sync/recovery.ts frontend/src/lib/sync/sync-meta.ts frontend/src/lib/sync/types.ts frontend/src/lib/sync/pull-loop.ts frontend/src/lib/sync/push-batch.ts frontend/src/lib/sync/merge.ts frontend/src/lib/sync/engine.ts frontend/src/lib/sync/transport.test.ts frontend/src/lib/sync/recovery.test.ts frontend/src/lib/sync/pull-loop.test.ts frontend/src/lib/sync/push-batch.test.ts frontend/src/lib/sync/merge.test.ts frontend/src/lib/sync/sync-meta.test.ts frontend/src/lib/sync/engine.test.ts frontend/src/lib/sync/fixtures/sync-event-canonical-vectors.json backend/scripts/export_openapi.py frontend/openapi.json frontend/src/types/api-generated.ts
git commit -m "feat(frontend): adopt opaque sync recovery protocol"
```

**Review gate:** Reject if v19 rewrites TS3 v18 business/conflict stores or S3 operation/compound authority; if the exclusive `pomodoroxii:space-authority:v1:<spaceId>` Browser Web Lock is absent, optional, released before query/push response application, replaced by a two-read proof/local lease, or does not auto-release on failure; if any enumerated outbox, Meta provisional/admission, conflict/resolution, receipt, recovery-rebase, or terminal-result writer can mutate without a live runtime-branded same-Space token. Reject if the two-Tab tests do not prove writer blocking during both new- and active-receipt query/push waits, or if direct IndexedDB bypass corruption can reach push. Reject if a ready marker stores flat IDs instead of per-root ordered full-field child identities and canonical digests; if `entityType`, `entityId`, `action`, canonical payload bytes/recomputed `payloadHash`, operation/base-version/timestamp/transport/compound/order/attempt identity, membership, or ordering can drift; or if any new correctness helper lacks its concrete type/import/body/test contract. Reject if either queried-terminal or pushed-terminal application deletes an applied row/active receipt before exact Space evidence is written in the same transaction; if crash recovery cannot resume `space_committed` evidence; if Meta `transport_ready -> transport_resolved` does not exact-match root/ordered-operation/result hashes or can be confused with `activation_resolved`; or if ready proof treats unexplained disappearance as terminal evidence. Reject if drift classification uses strings, if anything except `new_complete_paired_root` restarts, if the current cycle can restart more than once or loop without a bound, or if integrity mismatch does not fail closed. Reject if query-first/blocker-first/full-result parser coverage weakens, terminal is pushed again, direct attempted WorkItemNote gets a new operation/batch ID, `prepareHeldProvisionalBatch(...).batchId` is replaced, a compound is split/mixed, a receipt is regenerated, exact canonical bytes/hashes/limits are not revalidated, ACK precedes durability, any of six transports lacks strict parsing/canonical Accept, or generated types are hand-edited.

Also reject if payload integrity equates the full post-image SHA-256 with the
command business hash instead of using the exhaustive final-catalog builders;
if WorkItemNote `{document}` and LWW vectors do not prove the distinction; if a
terminal conflict/error remains selectable as `ready`; if retained diagnostics
lack exact evidence coverage; or if a retry mutates/reuses the terminal original,
creates more than one successor for one terminal intent, or omits the durable
predecessor/successor lineage and null-to-new-ID conditional update.

Reject if a provisional review changes Session validity/review state, writes an
Outcome/review Outbox/direct intent, or deletes its draft before the original
held import reaches exact Meta `transport_resolved`; if it adds review children
to `prepareHeldProvisionalBatch`; if resume does not load the exact
`meta_reconciled` evidence, compare every Meta/evidence hash, require an
all-applied result with the expected FocusSession child, or reject any
conflict/error; if a new intent does not use the authoritative imported Session
version with the draft's original operation ID/business fields; if an existing
prepared/in-flight intent is rebuilt from a newer local Session version instead
of reusing its exact persisted request/hash/CAS; or if the draft can be deleted
before the authoritative review response transaction installs Session,
Outcome, envelope, receipt, and queue rows. Reject if online and imported review
retain separate apply implementations; if the shared projector accepts a
foreign Space/Session on the Session, context, attribution, plan, Outcome, or
envelope; if a receipt or nonnull Outcome command ID is not owned by an envelope
in that same response; if a same-operation draft can change any review business
field while the request is in flight and still be deleted; or if the shared
helper can execute without the same-DB direct-intent/Session/Outcome/envelope/
receipt/queue/draft transaction.

### Task 8: Lock Protocol Boundaries And Pass The Complete S4 Gate

**Files:**
- Create: `backend/tests/test_sync_protocol_boundaries.py`
- Modify: `backend/tests/test_mcp_sync_parity.py`
- Modify: `backend/tests/test_sync_snapshot_streaming.py`
- Modify: `frontend/src/lib/sync/index.test.ts`
- Consume unchanged: `backend/scripts/check_backend_authority.py`
- Consume unchanged: `backend/scripts/measure_sync_snapshot.py`
- Consume unchanged: `backend/scripts/measure_sync_pull.py`
- Modify: `backend/app/routes/v1/sync.py` (only when the boundary test names an offender)
- Modify: `backend/app/mcp/sync_tools.py` (only when the boundary test names an offender)
- Modify: `backend/app/mcp/server.py` (only when the boundary test names an offender)
- Modify: `backend/app/sync/protocol.py` (only when the boundary test names an offender)

**Interfaces:**
- Consumes: all S4 public Interfaces and exact S4 commands.
- Produces: static architecture guards and one independently reviewable S4 evidence set; no production behavior.

- [ ] **Step 1: Write failing static boundary tests**

```python
def test_sync_adapters_do_not_own_storage_or_commit() -> None:
    forbidden = {
        "app.routes.v1.sync": {"AsyncSession", "record_sync_event", "SpaceEngineManager"},
        "app.mcp.sync_tools": {"AsyncSession", "SyncService", "SpaceEngineManager"},
    }
    for module_name, names in forbidden.items():
        tree = ast.parse(module_source(module_name))
        imported = imported_names(tree)
        called = called_attribute_names(tree)
        assert not (names & (imported | called))
        assert "commit" not in called


def test_only_cursor_module_decodes_cursor_tokens() -> None:
    offenders = rg_python_calls("cursor.decode", root=BACKEND_APP)
    assert offenders == {Path("app/sync/protocol.py")}


def test_adapter_runtime_modes_are_only_the_s2_public_values() -> None:
    assert {spec.runtime_mode for spec in SYNC_OPERATIONS} <= {"read", "write"}
    for module_name in ("app.routes.v1.sync", "app.mcp.sync_tools"):
        assert not calls_scope_open_with_literal_mode(module_name, "mutation")
```

Add an AST/import test proving `app.sync.protocol` does not import FastAPI or FastMCP, and an operation-catalog test proving no REST/MCP Sync operation exists outside the exact six-entry `SYNC_OPERATIONS`. Frontend `index.test.ts` scans production Sync sources and requires every `/sync/v2/` URL literal to live in `transport.ts`, then invokes all six exported calls, including operation-query, and checks the canonical Accept media type plus strict runtime parser.

The backend boundary test loads S3's unchanged `backend/scripts/check_backend_authority.py` from `REPO_ROOT` and calls `run_gate(BACKEND_APP, (Path("routes/v1/sync.py"),))`; it does not run a cwd-dependent copied command. Because that gate discovers `SyncOutbox` reads across the complete application tree, this one call covers the new Sync route plus `app/sync/protocol.py`, `retention.py`, `snapshot.py`, and future Python modules. It must reject an injected unsafe S4 reader even when `services/sync_outbox.py` still contains a safe read.

- [ ] **Step 2: Run boundary tests and verify any remaining direct Adapter dependency fails**

Run:

```powershell
cd backend
.\.venv\Scripts\python.exe -m pytest -q tests/test_sync_protocol_boundaries.py -p no:cacheprovider
```

Expected before cleanup: FAIL naming any surviving route/MCP direct session, commit, old `SyncService`, or cursor decode. Remove only the reported boundary violation; do not broaden this task into unrelated refactoring.

- [ ] **Step 3: Make the smallest boundary cleanup and rerun the complete backend S4 exit gate**

Run:

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
& .\backend\.venv\Scripts\python.exe backend/scripts/check_backend_authority.py --app-root backend/app --include-route routes/v1/sync.py
if ($LASTEXITCODE -ne 0) { throw 'S4 authority gate failed' }
cd backend
.\.venv\Scripts\python.exe -m pytest -q tests/test_sync_cursor_pagination.py tests/test_sync_mutation_ledger.py tests/test_sync_integration.py tests/test_sync_client_ack.py tests/test_sync_ledger_retention.py tests/test_sync_snapshot_streaming.py tests/test_sync_routes_v2.py tests/test_sync_routes.py tests/test_sync_outbox_service.py tests/test_response_contract.py tests/test_openapi_contract.py tests/test_mcp_sync_parity.py tests/test_mcp_server.py tests/test_mcp_authorization.py tests/test_parity_stats_mcp.py tests/test_sync_protocol_boundaries.py -p no:cacheprovider
.\.venv\Scripts\ruff.exe check --no-cache app tests
```

Expected: the reused S3 authority gate reports nine routes (the unchanged eight-route S3 set plus `routes/v1/sync.py`) and all recognized application-wide `SyncOutbox` reads; then pytest/ruff PASS with zero critical XFAIL/XPASS, no invisible-read bypass, and no Adapter boundary violation.

- [ ] **Step 4: Run the official-client and generated-contract gate**

Run:

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
cd frontend
npm run generate:api
git diff --exit-code -- openapi.json src/types/api-generated.ts
npm run test -- --run src/services/database.test.ts src/services/meta-database.test.ts src/lib/sync/admission.test.ts src/lib/sync/transport.test.ts src/lib/sync/recovery.test.ts src/lib/sync/pull-loop.test.ts src/lib/sync/push-batch.test.ts src/lib/sync/merge.test.ts src/lib/sync/sync-meta.test.ts src/lib/sync/engine.test.ts src/lib/sync/index.test.ts
npm run test
npm run lint
npm run typecheck
```

Expected: no generated diff; all focused tests, lint, and typecheck PASS.

- [ ] **Step 5: Run the Linux RSS probe and retain its artifacts for S6**

Run:

```bash
set -euo pipefail
cd backend
mkdir -p .test-results
/usr/bin/time -v .venv/bin/python scripts/measure_sync_snapshot.py --notes 10000 --body-bytes 4096 --output .test-results/sync-snapshot.json 2> .test-results/sync-snapshot-time.txt
python -c "import json,pathlib,re; d=json.loads(pathlib.Path('.test-results/sync-snapshot.json').read_text()); t=pathlib.Path('.test-results/sync-snapshot-time.txt').read_text(); rss=int(re.search(r'Maximum resident set size \(kbytes\):\s*(\d+)',t).group(1)); assert d['snapshot_complete'] and rss <= 262144"
.venv/bin/python -m pytest -q tests/test_sync_cursor_pagination.py::test_incremental_pull_512_max_payloads_peak_heap_is_bounded -p no:cacheprovider
/usr/bin/time -v .venv/bin/python scripts/measure_sync_pull.py --events 512 --payload-bytes 262144 --limit 500 --output .test-results/sync-pull.json 2> .test-results/sync-pull-time.txt
python -c "import json,pathlib,re; d=json.loads(pathlib.Path('.test-results/sync-pull.json').read_text()); assert set(d)=={'events','payload_bytes','requested_limit','returned_events','canonical_page_bytes','has_more','pull_complete'}; t=pathlib.Path('.test-results/sync-pull-time.txt').read_text(); rss=int(re.search(r'Maximum resident set size \(kbytes\):\s*(\d+)',t).group(1)); assert d['events']==512 and d['payload_bytes']==262144 and d['requested_limit']==500 and d['returned_events']==512 and d['canonical_page_bytes'] <= 8*1024*1024 and d['has_more'] is True and d['pull_complete'] is True and rss <= 262144"
sha256sum .test-results/sync-snapshot.json .test-results/sync-snapshot-time.txt .test-results/sync-pull.json .test-results/sync-pull-time.txt > .test-results/sync-memory-artifacts.sha256
```

Expected: both probes and the separate pull heap test exit 0; the snapshot 10,000-Note fixture and 512-event maximum-payload pull meet their declared page/heap bounds and maximum RSS at most 256 MiB; the pull script's internal full traversal proves zero loss/duplicates. Record the exact commit and all four artifact SHA-256 values under the S0 evidence schema and hand them to S6 as distinct snapshot/pull inputs; do not call either a certification artifact until S6 reruns the exact commands on the target SHA.

- [ ] **Step 6: Commit the S4 boundary gate**

```powershell
git add backend/tests/test_sync_protocol_boundaries.py backend/tests/test_mcp_sync_parity.py backend/tests/test_sync_snapshot_streaming.py frontend/src/lib/sync/index.test.ts backend/app/routes/v1/sync.py backend/app/mcp/sync_tools.py backend/app/mcp/server.py backend/app/sync/protocol.py
git commit -m "test(sync): lock protocol convergence boundaries"
```

**Review gate:** Approve the S4 implementation for handoff to S5 only when the unchanged S3 authority gate, backend/frontend focused and full gates, generated-type cleanliness, Linux snapshot/pull bounds, and six-operation REST/MCP parity all pass on the same SHA. The reviewer must explicitly accept the exclusive per-Space Web Lock held across admission/selection/query/push response application; closed token-bound writer inventory; two-Tab blocking and bypass-corruption zero-push tests on both receipt paths; full-field per-root ordered identities/digests; typed one-restart drift boundary; and concrete helper/import/type contracts. The reviewer must also accept Space-first terminal evidence for both query and push results, crash recovery on both sides of exact Meta reconciliation, ready-proof evidence handling, query-first/blocker-first parser invariants, direct-Note original authority, unchanged `prepareHeldProvisionalBatch(...).batchId`/children, restart-safe receipts, and all six official-client parsers/Accept headers. Public Adapter modes remain only `read|write`; no critical expected failure remains. This is a future criterion, not plan-time approval, score, or certification. A reintroduced P0 pauses S5 and reapplies the score cap only after fresh evidence is recorded.

The reviewer must additionally accept separate post-image-byte and
entity-specific business-hash proofs for every final key, plus evidence-bound
non-sendable terminal diagnostics and idempotent one-successor retry lineage.

## Wave Completion Handoff

Record the S4 head SHA, every command above, runtime versions, timestamps, exit codes, and artifact digests using `backend/audit/95plus/evidence.schema.json`. Open a focused S4 review before starting S5. The reviewer must explicitly confirm ledger completeness, ACK waterline safety, restart-safe frontend recovery, six-operation REST/MCP authorization/parity, operation-query/query-first behavior, the cross-Tab authority fence/writer inventory, structured root identities, two-phase terminal evidence recovery, bounded drift handling, unchanged TS3 compound/direct-Note authority, and both memory ceilings. Until those commands run and that review is accepted on the exact SHA, S4 remains planned/not-certified and receives no score.
