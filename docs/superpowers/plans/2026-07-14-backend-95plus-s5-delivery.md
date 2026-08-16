# Backend 95+ S5 Recovery And Production Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the complete PomodoroXII data root recoverable, observable, reproducibly deployable, and rollbackable from verified immutable artifacts, including the fixed `1e4f0fc6d82ce6203f4bada0e84b518b16fcd97f` N-1 fixture.

**Architecture:** `RecoveryCoordinator` owns coordinated snapshot, verification, restore-to-staging, and fenced offline cutover beneath the S2 process-owner/global leases. It treats Meta, every Space database, Markdown, and required indexes as one manifest-backed recovery unit and validates staging through read-only migration/index/journal/consistency Interfaces rather than live runtime handles. `OperationalSignals` and a distinct operations credential protect readiness/metrics/maintenance. Trusted `main`-push CI has one non-matrix, non-reusable build/push owner for the target SHA and publishes its immutable digest plus provenance exactly once. The release workflow is an explicit `publish -> drills -> release` DAG: `publish` consumes that subject and performs supply-chain publication without rebuilding, `drills` consumes only its immutable outputs, and the final `release` job is a read-only aggregator that validates and indexes every producer. Every CI, supply-chain, release, N-1, and fresh-volume producer emits the same closed S0 evidence envelope for S6.

**Tech Stack:** Python 3.13, FastAPI, SQLAlchemy 2 async, SQLite Online Backup API, Alembic dual chains, filelock/runtime leases, Prometheus client, pytest, Docker/BuildKit, GHCR, GitHub Actions, Trivy, Syft/SPDX, Cosign keyless signing, SLSA provenance, shell/Python system drills.

## Global Constraints

- Start only after S4 is merged and independently reviewed. S5 consumes the final S3/TS0-TS3/S4 storage, domain, and Sync contracts; it does not revise their authority or transaction rules.
- All local PowerShell commands and every Git pathspec in this plan run from the repository root. Workflow snippets state their own `working-directory` explicitly. Never rely on a previous code block having changed the caller's cwd, and always use file-level `git -C . add -- ...` pathspecs.
- Consume S2's canonical active `POMODOROXII_DATA_ROOT` layout exactly: `meta.db`, `spaces/{space_id}/space.db`, `spaces/{space_id}/index.db`, `spaces/{space_id}/notes/**`, and `.runtime/**`. Startup rejects legacy `database_url`/`spaces_data_dir` values that do not resolve to `meta.db` and `spaces/` under that one root; S5 does not infer a common parent. A snapshot may use manifest-relative `meta/meta.db`, but restore/relocation maps it back to active-root `meta.db` before publication.
- Supported production topology remains one active backend process per persistent data root. Do not claim active-active or network-filesystem multi-writer support.
- `RecoveryCoordinator` may consume only `RuntimeLeaseCoordinator`, `MigrationCoordinator.verify`, read-only `IndexStoreSchema.verify`, `KnowledgeConsistencyChecker.verify(SpaceDataView)`, `MutationUnitOfWork.inspect_recovery(view)`, TS2 `ActiveSessionCoordinationInspector.inspect_read_only(...)`, `EffortProjectionCompiler.verify_all(...)`, and compiled catalog public Interfaces; it may not import mutation journal/staging internals or forge a live `SpaceRuntimeHandle`.
- Online snapshot holds `RuntimeLeaseCoordinator.acquire_global(mode="exclusive", purpose="snapshot", timeout_seconds=60)`. Restore-to-staging writes only a new staging root. Cutover and relocation are offline destructive commands: after the service stops, the CLI acquires process-owner then global-exclusive, verifies both fences immediately before rename, and keeps both leases through rollback or success.
- Snapshot target and scheduled backup target must resolve outside the active data root. Restore never overwrites a live root; it restores to staging, verifies, preserves rollback state, then performs fenced cutover.
- A manifest covers `meta.db`, every registered `space.db`, Note Markdown, `index.db`, schema heads, final catalog hash plus exact entry count `31`, entity counts, Note hashes, Sync waterlines, a hashed active-coordination inspection receipt, and an EffortProjection verification receipt, with relative paths, byte sizes, and SHA-256 digests. Legacy `task`, `session`, `taskQuickNote`, and `sessionQuickNote` entries invalidate the manifest.
- Production certification restores from a separately mounted failure domain; a sibling directory on the same active volume is not sufficient evidence.
- The first N-1 subject is fixed to backend commit `1e4f0fc6d82ce6203f4bada0e84b518b16fcd97f`. Task 7 preserves the original legacy-bearing seed byte-for-byte as a required fail-closed lane and adds a separate empty-legacy profile from that same exact commit for successful upgrade. It may strengthen reviewed fixture contracts/receipts with schema heads, catalog, IndexStore objects, and canonical inventory; it may not delete or rewrite the original Task/Session seed, migrate it, or regenerate either profile from a newer commit. Never accept a prefix in any command, receipt, or comparison.
- Operations credentials are distinct from master/Space JWTs. Store only SHA-256 digest plus operations epoch; issue a random 32-byte token once; compare in constant time; no default token exists.
- Metrics use bounded labels; never label with user ID, Space ID, entity ID, Note title, request ID, token, path, or raw exception message.
- Production image deployment uses an immutable `sha256:` digest. Mutable `latest` may be a discovery alias but is never an accepted deploy or rollback input.
- GitHub Actions and container base images are digest/SHA pinned. The CI/release pipeline emits JUnit, coverage, logs, failed sandbox, scan, SBOM, signature, provenance, image digest, and drill artifacts for an exact commit.
- The S0 `schema_version: "1.0"` evidence envelope is the only producer contract. Every record has a stable `evidence_id`, exact `subject_sha`, command/cwd/runtime/start/end/exit/result, concrete artifact path/SHA-256/byte size, `trust_level`, confidence, modules, finding IDs, and `certification_tags`; producer-specific facts such as the immutable image digest live in the hashed artifact named by that record. Extra record keys fail closed.
- `backend/app/audit/producer_contracts.py::PRODUCER_CONTRACTS` is created in S5 before any release index exists and is the sole subject-neutral producer authority for S5 and S6. It reserves the complete CI/supply-chain/N-1/fresh/release plus fault/security/resource/pull matrix envelope paths and stable IDs. Derived `S5_INPUT_PRODUCERS` is exactly `ci,supply_chain,n_minus_one,fresh_deploy`; `release` is output-only and can be validated only after the non-self-referential index exists. The release contract owns two independent records: `EV-RELEASE-BUNDLE` over `release-artifact-index.json` and `EV-S5-HISTORY` over canonical `s5-history.json`. S6 imports the mapping unchanged and may not extend, shadow, or reconstruct it.
- For one target SHA, only the trusted `push` run on `refs/heads/main` may build and push the release image. The owner is one literal `docker/build-push-action` step in one job without `strategy.matrix`, a reusable-workflow `uses`, dynamic job expansion, composite-action build delegation, or shell/buildx fallback. A SHA-scoped non-cancelling concurrency group serializes candidates. `github.run_attempt > 1` and any later run for the same SHA are read-only reuse attempts: they must locate and validate the unique first successful digest/provenance artifact or fail; they never rebuild or repush. Static verification scans every tracked workflow, reusable workflow, composite action, and backend script, and the live selector rejects more than one successful producer run/attempt. Release, N-1, fresh-deploy, rollback, and certification jobs must never rebuild that target.
- `backend-release.yml` has workflow-level `contents: read` only. Tasks 6-7 keep it non-required and manual/static while its producer set is incomplete; Task 8 first commits every remaining producer/tool, then activates `pull_request` and trusted-main `push` in a separate descendant commit. In the final workflow the `release` job uses `if: always()`: on a pull request it requires `publish` and `drills` to be skipped and runs only static policy, while any other PR predecessor state runs an explicit nonzero rejection; on a main push it fails unless both predecessors succeeded and then runs the read-only aggregator. Write scopes and OIDC exist only on main-only producer jobs that need them, and no PR path has registry, signing, deployment, or drill side effects. The aggregator derives the unique activation and producer commits from the target Git history/tree/diffs, writes `s5-history.json`, and never accepts either identity from an environment variable or caller argument.
- Every GitHub Checks, Actions runs/jobs, and Actions artifacts query follows pagination to exhaustion before uniqueness is decided. The main-only `publish` job bounded-polls the exact-SHA trusted CI candidate: `queued` and `in_progress` wait, `completed/success` proceeds, any other terminal conclusion or timeout fails, and zero/multiple candidates never fall back to newest/first selection. With exact `contents: read`, `actions: read`, and `checks: read`, the final `release` job independently repeats the same-subject eligibility lookup and cross-checks event/ref/workflow/run/attempt/artifact identities and predecessor conclusions; the publish receipt is never its authority.
- A fresh-deploy drill starts with a run-unique volume that did not exist before the drill and an empty mounted data root. It retains exact command/runtime/timestamps/exit plus contained raw stdout and stderr path/SHA-256/byte size for pre-create lookup, empty-root inspection, and post-remove lookup, as well as immutable volume identity, prepare/mount/deploy receipts, smoke results, and terminal cleanup. An existing or merely emptied volume is ineligible.
- Do not delete existing untracked files or retained test artifacts. Test and drill output uses a run-scoped external root.
- Do not claim live restore, rollback, scan, signature, provenance, or GitHub evidence until the corresponding command succeeds for the exact subject SHA.

---

## File Structure And Responsibilities

### Recovery core

- Create `backend/app/recovery/contracts.py`: frozen `SnapshotManifest`, `PublishedSnapshotReceipt`, `VerificationResult`, `StagedRestore`, `CutoverResult`, `RelocationResult`, and file/Space manifest records.
- Create `backend/app/recovery/sqlite_copy.py`: SQLite Online Backup API copy plus integrity check/fsync; no orchestration.
- Create `backend/app/recovery/manifest.py`: canonical JSON serialization, relative-path validation, and digest verification.
- Create `backend/app/recovery/coordinator.py`: implement the approved four-method `RecoveryCoordinator` Interface under the global lease/fence.
- Create `backend/app/recovery/relocation.py`: explicit data-root relocation built from snapshot, staging verification, and cutover; never implicit path repair.
- Create `backend/app/recovery/scheduler.py`: initial required snapshot and bounded scheduled retention outside active root.
- Create `backend/app/recovery/__init__.py`: export only public recovery contracts/Modules, including every receipt added in Task 2.
- Delete after callers migrate: `backend/app/file_system/backup.py`; the partial index-only backup service must not remain an alternate production path.

### Operations and observability

- Create `backend/app/ops/credentials.py`: issue/rotate/revoke/verify operations bearer tokens.
- Create `backend/app/ops/signals.py`: low-cardinality metrics and startup/degraded state.
- Create `backend/app/ops/routes.py`: liveness, global readiness, protected metrics, and authorized per-Space health.
- Create `backend/app/ops/cli.py` and `backend/app/ops/__main__.py`: snapshot/verify/restore/cutover/relocate/credential commands with machine-readable results and nonzero failure exits.
- Modify `backend/app/main.py`: initialize runtime, required initial snapshot, scheduler, ops routes/signals, and orderly shutdown.
- Modify `backend/app/middleware.py`, `backend/app/logging.py`, `backend/app/settings.py`, `backend/app/routes/v1/spaces.py`, and `backend/pyproject.toml`: instrumentation, safe configuration, health Adapter, and Prometheus dependency.

### Tests, fixtures, CI, and delivery

- Modify `backend/app/audit/__init__.py`: preserve S0's `validate_evidence_envelope`, `resolve_bundle_artifact`, and `resolve_external_artifact` exports, then append `ProducerContract`, the one frozen complete S5/S6 `PRODUCER_CONTRACTS` authority, and computed `S5_INPUT_PRODUCERS`; create `backend/app/audit/producer_contracts.py` as their sole owner. No producer or consumer keeps a second filename/ID table.
- Create `backend/tests/test_recovery.py`: complete snapshot/verify/restore/cutover/fault contracts.
- Create `backend/tests/test_space_relocation.py`: explicit relocation success/reversal/containment contracts.
- Modify `backend/tests/test_backup_lifespan.py`: replace partial backup assumptions with required full snapshot/scheduler behavior.
- Create `backend/tests/test_operational_endpoints.py`: operations credential, readiness, metrics, and per-Space degradation.
- Create `backend/tests/test_observability.py`: bounded labels, counters/histograms/gauges, and redaction.
- Modify `backend/tests/test_prod_hardening.py`: immutable deploy/non-root/configuration contracts.
- Create `backend/scripts/certification/n_minus_one_drill.py`: fixed-subject build, upgrade, restore, and rollback orchestrator.
- Create `backend/scripts/certification/verify_drill.py`: validate machine drill artifact against the fixed fixture manifest.
- Create `backend/scripts/certification/fresh_deploy_drill.sh`: allocate a never-before-existing volume, prove its mounted data root empty, deploy the consumed digest, smoke it, and remove it with retained receipts.
- Create `backend/scripts/certification/verify_fresh_deploy.py`: validate the canonical fresh-volume drill receipt and its S0 evidence envelope.
- Create `backend/scripts/evidence_records.py`: shared closed S0 `EvidenceRecord`/envelope writer used unchanged by CI, supply-chain, release, N-1, and fresh-deploy producers.
- Create `backend/scripts/supply_chain.py`: verify action pins/base digest/SBOM/scan/signature/provenance inputs and normalize evidence.
- Modify `.github/workflows/ci.yml`: exact-SHA tests, actual external sandbox-root retention, and the single trusted-main image build/push with digest/provenance evidence.
- Create `.github/workflows/backend-release.yml`: consume the trusted CI digest/provenance, then scan/SBOM/sign and run system drills without a Docker build step.
- Modify `backend/Dockerfile`, `backend/docker-compose.yml`, and `backend/DEPLOY.md`: digest-pinned base/deploy, non-root bind preparation, upgrade and rollback commands.
- Create `backend/docs/SLO.md`, `backend/docs/runbooks/recovery.md`, `relocation.md`, `rollback.md`, and `incident.md`: executable operations contracts.

## Locked Public Interfaces

```python
class RecoveryCoordinator:
    async def snapshot(self, target: Path) -> PublishedSnapshotReceipt: ...
    async def verify(self, snapshot: Path) -> VerificationResult: ...
    async def restore_to_staging(self, snapshot: Path) -> StagedRestore: ...
    async def cutover(self, staged_restore: StagedRestore) -> CutoverResult: ...

class DataRootRelocator:
    async def relocate(self, target_root: Path) -> RelocationResult: ...

class OperationsCredentialStore:
    async def issue(self) -> IssuedCredential: ...
    async def rotate(self) -> IssuedCredential: ...
    async def revoke(self) -> None: ...
    async def verify(self, token: str) -> OperationsPrincipal: ...

class OperationalSignals:
    def observe_request(self, method: str, route: str, status_code: int, seconds: float) -> None: ...
    def set_space_health(self, space_id: str, health: SpaceHealth) -> None: ...
    def render_prometheus(self) -> bytes: ...
```

Recovery consumes these already locked dependencies without reaching behind them:

```python
RuntimeLeaseCoordinator.acquire_global(mode, purpose, timeout_seconds) -> Lease
RuntimeLeaseCoordinator.acquire_process_owner(purpose, timeout_seconds) -> Lease
MigrationCoordinator.verify(kind, path) -> MigrationStatus
IndexStoreSchema.verify(path) -> IndexSchemaStatus
KnowledgeConsistencyChecker.verify(view: SpaceDataView) -> ConsistencyReport
MutationUnitOfWork.inspect_recovery(view: SpaceDataView) -> RecoveryInspection
```

### Task 1: Create A Coordinated Full Snapshot And Canonical Manifest

**Files:**
- Create: `backend/app/recovery/__init__.py`
- Create: `backend/app/recovery/contracts.py`
- Create: `backend/app/recovery/sqlite_copy.py`
- Create: `backend/app/recovery/manifest.py`
- Create: `backend/app/recovery/coordinator.py`
- Create: `backend/tests/test_recovery.py`

**Interfaces:**
- Consumes: global exclusive lease/fence, Meta Space registry/canonical paths, SQLite files, Markdown/index files, schema heads, catalog hash, Sync waterlines.
- Produces: `RecoveryCoordinator.snapshot(target) -> PublishedSnapshotReceipt`, `verify(snapshot) -> VerificationResult`, canonical `manifest.json` plus `manifest.sha256`. `receipt.manifest` is the approved `SnapshotManifest`; receipt-only host paths are never serialized into `manifest.json`.

- [ ] **Step 1: Write failing complete-snapshot and safety tests**

```python
async def test_snapshot_covers_meta_all_spaces_notes_indexes_and_waterlines(recovery_env):
    published = await recovery_env.coordinator.snapshot(recovery_env.external_target)
    manifest = published.manifest
    assert published.root.is_dir()
    assert published.manifest_sha256 == sha256_file(published.root / "manifest.json")
    assert manifest.catalog_hash == recovery_env.catalog.hash
    assert manifest.catalog_entry_count == 31
    assert not {"task", "session", "taskQuickNote", "sessionQuickNote"} & set(
        manifest.catalog_entity_types
    )
    assert manifest.meta.schema_head == "meta_002_active_session_locator"
    assert manifest.meta.active_session_coordination.classification in {
        "empty", "active_consistent", "recoverable_claiming",
        "recoverable_releasing", "awaiting_resolution",
    }
    assert manifest.meta.active_session_coordination.result == "clean_or_recoverable"
    assert manifest.effort_projection.result == "verified"
    assert {space.space_id for space in manifest.spaces} == {"alpha", "beta"}
    assert all(space.space_head == "space_011_sync_clients_streaming" for space in manifest.spaces)
    assert all(space.index_schema_version == recovery_env.index_schema.version for space in manifest.spaces)
    assert {entry.relative_path for entry in manifest.files} >= {
        "meta/meta.db",
        "spaces/alpha/space.db",
        "spaces/alpha/index.db",
        "spaces/alpha/notes/note-a.md",
        "spaces/beta/space.db",
    }


async def test_snapshot_rejects_target_inside_active_root(recovery_env):
    with pytest.raises(DomainFailure) as raised:
        await recovery_env.coordinator.snapshot(recovery_env.active_root / "backups")
    assert raised.value.record.code == "snapshot_invalid"
    assert not (recovery_env.active_root / "backups").exists()


@pytest.mark.parametrize(
    "damage",
    ("missing_operation", "intent_hash_mismatch", "unknown_child", "bad_pair"),
)
async def test_snapshot_rejects_unrecoverable_active_coordination(
    recovery_env, damage
) -> None:
    await recovery_env.damage_active_coordination(damage)
    with pytest.raises(DomainFailure) as raised:
        await recovery_env.coordinator.snapshot(recovery_env.external_target)
    assert raised.value.record.code == "active_session_recovery_required"


async def test_snapshot_rejects_effort_projection_drift(recovery_env) -> None:
    await recovery_env.corrupt_effort_projection_for_test_only()
    with pytest.raises(DomainFailure) as raised:
        await recovery_env.coordinator.snapshot(recovery_env.external_target)
    assert raised.value.record.code == "snapshot_invalid"
```

Add tests proving snapshot waits for a live request, times out at 60 seconds without partial publication, records one fence, and does not include WAL-only data incorrectly. Inject failures after each database copy, Note copy, manifest write, fsync, and atomic publish; no failed snapshot may appear as complete.

- [ ] **Step 2: Run recovery tests and verify the red state**

Run:

```powershell
.\backend\.venv\Scripts\python.exe -m pytest -q backend/tests/test_recovery.py -p no:cacheprovider
```

Expected: FAIL with import errors for `app.recovery`.

- [ ] **Step 3: Define immutable manifest contracts and canonical serialization**

```python
@dataclass(frozen=True, slots=True)
class SnapshotFile:
    relative_path: str
    size: int
    sha256: str
    kind: Literal["meta_db", "space_db", "index_db", "note", "index_asset"]


@dataclass(frozen=True, slots=True)
class SpaceSnapshot:
    space_id: str
    space_head: str
    index_schema_version: int
    sync_waterline: str
    entity_counts: Mapping[str, int]
    note_hashes: Mapping[str, str]


@dataclass(frozen=True, slots=True)
class SnapshotManifest:
    schema_version: Literal[1]
    created_at: str
    source_fence: int
    catalog_hash: str
    catalog_entry_count: Literal[31]
    catalog_entity_types: tuple[str, ...]
    meta: MetaSnapshot
    spaces: tuple[SpaceSnapshot, ...]
    files: tuple[SnapshotFile, ...]


@dataclass(frozen=True, slots=True)
class PublishedSnapshotReceipt:
    root: Path
    manifest: SnapshotManifest
    manifest_sha256: str

    def __post_init__(self) -> None:
        if not self.root.is_absolute() or not self.root.is_dir():
            raise ValueError("published snapshot root must be an existing absolute directory")
        if not re.fullmatch(r"[0-9a-f]{64}", self.manifest_sha256):
            raise ValueError("published manifest SHA-256 is invalid")
```

`manifest.py` accepts only POSIX relative paths, rejects absolute/drive/`..`/NUL/symlink entries, sorts Spaces and files, writes UTF-8 canonical JSON with sorted keys and compact separators, then writes the lowercase SHA-256 plus newline to `manifest.sha256`.

- [ ] **Step 4: Implement WAL-safe SQLite copy and complete snapshot publication**

```python
def backup_sqlite(source: Path, destination: Path) -> SqliteBackupResult:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(source) as src, sqlite3.connect(destination) as dst:
        src.backup(dst, pages=256, sleep=0.01)
        integrity = dst.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise SnapshotIntegrityError(destination.name)
        dst.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    fsync_file(destination)
    fsync_directory(destination.parent)
    return SqliteBackupResult(size=destination.stat().st_size, sha256=sha256_file(destination))
```

`snapshot()` resolves and validates the external target before creation, acquires the global exclusive lease once, and delegates to `_snapshot_under_lease(target, lease) -> PublishedSnapshotReceipt`. The helper rejects any lease that is not the matching global-exclusive; it never reacquires a lease. It creates `{target}/.{uuid}.tmp`, copies `meta.db`, every registered `space.db`, and every `index.db` with the Online Backup API, copies only non-SQLite Note/index assets as regular files with symlinks rejected, computes counts/hashes/heads/waterlines from the copied databases, writes/fsyncs the manifest, verifies the lease fence, and atomically renames to `{target}/{UTC}-{catalog-prefix}`. Only the final directory is a valid snapshot. S5 cutover reuses this helper for its rollback snapshot while already holding the destructive lease, preventing self-deadlock. The receipt's `root` is the final directory, its `manifest` is the parsed canonical payload, and its `manifest_sha256` hashes the published `manifest.json` bytes.

- [ ] **Step 5: Implement independent verification from disk**

`verify()` rereads `manifest.sha256`, parses canonical JSON into frozen contracts, proves every listed path remains under the snapshot root, rejects unlisted regular files except `manifest.json`/`manifest.sha256`, verifies size/hash, runs `PRAGMA integrity_check` on all databases, verifies schema heads/catalog/waterlines/counts/Note hashes, reruns the read-only active-coordination and EffortProjection inspectors against the copied databases, requires exact receipt/digest equality, and returns a structured result. It must not trust values cached by `snapshot()`.

```python
@dataclass(frozen=True, slots=True)
class VerificationResult:
    valid: bool
    manifest_sha256: str
    manifest: SnapshotManifest | None
    checked_files: int
    checked_spaces: int
    failures: tuple[str, ...]

    def __post_init__(self) -> None:
        if self.valid and (self.manifest is None or self.failures):
            raise ValueError("valid verification requires a manifest and zero failures")
        if not self.valid and not self.failures:
            raise ValueError("invalid verification requires at least one failure")
```

Add explicit tests for `VerificationResult(valid=True, manifest=None, ...)`, `valid=True` with failures, and `valid=False` without failures. Every caller must branch on both `valid` and `manifest is not None`; no recovery safety check may depend on `assert`, because optimized Python removes assertions. Add this source regression after the behavioral tests:

```python
def test_restore_has_an_explicit_optional_manifest_guard() -> None:
    source = (BACKEND / "app/recovery/coordinator.py").read_text(encoding="utf-8")
    forbidden = (
        "assert verified.manifest is not None",
        "verified.manifest.source_fence",
    )
    assert all(value not in source for value in forbidden)
```

- [ ] **Step 6: Run snapshot, WAL, fault, and verification tests**

Run:

```powershell
.\backend\.venv\Scripts\python.exe -m pytest -q backend/tests/test_recovery.py -k "snapshot or verify or wal or manifest" -p no:cacheprovider
.\backend\.venv\Scripts\ruff.exe check --no-cache backend/app/recovery backend/tests/test_recovery.py
```

Expected: PASS; a committed WAL-only row exists in the copied DB; tampering, symlinks, path traversal, missing/unlisted files, schema/catalog/count/hash drift, and injected publication failure all return invalid/nonzero behavior without a complete snapshot.

- [ ] **Step 7: Commit coordinated snapshot support**

```powershell
git -C . add -- backend/app/recovery/__init__.py backend/app/recovery/contracts.py backend/app/recovery/sqlite_copy.py backend/app/recovery/manifest.py backend/app/recovery/coordinator.py backend/tests/test_recovery.py
git commit -m "feat(recovery): add coordinated full snapshots"
```

**Review gate:** Reject if snapshot uses online `tar`, raw-copies any SQLite main file, copies only Space/index databases, runs without a global exclusive lease, reacquires global inside `_snapshot_under_lease`, trusts Meta-computed paths without containment, publishes before fsync/verification, follows symlinks, or accepts a target inside the active root.

### Task 2: Restore To Staging, Fenced Cutover, And Explicit Relocation

**Files:**
- Modify: `backend/app/recovery/contracts.py`
- Modify: `backend/app/recovery/__init__.py`
- Modify: `backend/app/recovery/coordinator.py`
- Create: `backend/app/recovery/relocation.py`
- Modify: `backend/tests/test_recovery.py`
- Create: `backend/tests/test_space_relocation.py`

**Interfaces:**
- Consumes: `verify()`, public read-only migration/index/consistency/UoW inspection Interfaces, process-owner/global exclusive leases and fences, canonical Meta paths interpreted through a staged-root mapping.
- Produces: `restore_to_staging(snapshot) -> StagedRestore`, offline `cutover(staged_restore) -> CutoverResult`, `DataRootRelocator.relocate(target_root) -> RelocationResult`.

- [ ] **Step 1: Write failing restore/cutover/relocation fault tests**

```python
async def test_restore_never_overwrites_live_root(recovery_env):
    staged = await recovery_env.coordinator.restore_to_staging(recovery_env.snapshot)
    assert staged.root != recovery_env.active_root
    assert recovery_env.live_marker.read_text() == "live-before"
    assert staged.verification.valid


@pytest.mark.parametrize("fault", ["after_rollback_rename", "before_new_rename", "after_new_rename", "before_parent_fsync"])
async def test_cutover_fault_restores_a_single_openable_root(recovery_env, fault):
    staged = await recovery_env.staged_restore()
    result = await recovery_env.faulting_coordinator(fault).cutover(staged)
    assert result.success is False
    assert exactly_one_openable_root(recovery_env.active_root, result.rollback_root)
    assert recovery_env.catalog_matches_open_root()
```

Add a real child-process test that holds process-owner as the live backend: `cutover()` must return `lease_timeout`, perform zero rename, and leave staging intact. Add relocation tests for target outside configured containment, target with insufficient permissions, existing target, moved registered store, failure while rewriting staged Meta paths, stale owner/global fence, parent-lock contention, and reverse rollback. Old root must remain usable until the final atomic boundary.

- [ ] **Step 2: Run restore/relocation tests and verify the red state**

Run:

```powershell
.\backend\.venv\Scripts\python.exe -m pytest -q backend/tests/test_recovery.py backend/tests/test_space_relocation.py -k "restore or cutover or relocate" -p no:cacheprovider
```

Expected: FAIL because staging/cutover/relocation behavior is not implemented.

- [ ] **Step 3: Restore only into a new staging root and validate every public layer**

```python
@dataclass(frozen=True, slots=True)
class StagedRestore:
    snapshot_root: Path
    root: Path
    target_active_root: Path
    manifest_sha256: str
    staged_tree_sha256: str
    catalog_hash: str
    source_fence: int
    verification: VerificationResult


async def restore_to_staging(self, snapshot: Path) -> StagedRestore:
    verified = await self.verify(snapshot)
    manifest = verified.manifest
    if not verified.valid or manifest is None:
        failures = verified.failures or ("verified manifest is missing",)
        raise SnapshotInvalid(failures)
    staging = self.staging_parent / f"restore-{verified.manifest_sha256[:16]}"
    ensure_new_empty_directory(staging)
    copy_manifest_files(snapshot, staging)
    view = build_staged_root_view(
        staging, target_active_root=self.active_root, manifest=manifest
    )
    await self._inspect_staged_root_read_only(view)
    fsync_tree(staging)
    staged_hash = hash_staged_tree(staging)
    return StagedRestore(
        snapshot,
        staging,
        self.active_root,
        verified.manifest_sha256,
        staged_hash,
        self.catalog.hash,
        manifest.source_fence,
        verified,
    )
```

`build_staged_root_view()` never follows the absolute paths stored in copied Meta. It proves each Meta path equals the path expected after publication at `target_active_root`, then maps that registered record to manifest-listed files under `staging` and produces `SpaceDataView` records. A normal restore whose Meta paths target a different active root fails with an explicit relocation-required error.

`_inspect_staged_root_read_only()` calls `MigrationCoordinator.verify()` for staged Meta/every staged Space, `IndexStoreSchema.verify()` in SQLite URI `mode=ro`, `MutationUnitOfWork.inspect_recovery(view)`, `KnowledgeConsistencyChecker.verify(view)`, TS2 `ActiveSessionCoordinationInspector.inspect_read_only(...)`, and `EffortProjectionCompiler.verify_all(...)`. A Space mutation journal must be clean. Meta coordination may be empty, active-consistent, or deterministically recoverable only when its immutable intent, locator, named child outcomes, descriptor hashes, and Space facts all agree; the inspector never performs that recovery during staging. Projection mismatch and unknown/corrupt coordination reject restore/cutover. This path never calls `SpaceRuntime.open`, never acquires a request lease, and never upgrades, rewrites, rebuilds, or creates a file.

- [ ] **Step 4: Implement rollback-preserving fenced cutover**

`cutover()` is rejected while the live backend owns process-owner. After the service is stopped, the same CLI Task acquires process-owner then global-exclusive. Under those leases it re-verifies the staged-tree receipt/hash/catalog, calls `_snapshot_under_lease()` to create the rollback snapshot without reacquiring global, verifies owner/global fences, renames active root to a unique rollback root, renames staging to the configured active path, fsyncs the parent, and runs `_inspect_staged_root_read_only()` against the now-active paths while still holding the existing leases. It never calls `SpaceRuntime.open()` or another public lock-acquiring method. On any failure after the first rename, it reverses both renames under the same leases and read-only verifies the old root before returning failure.

```python
@dataclass(frozen=True, slots=True)
class CutoverResult:
    success: bool
    active_root: Path
    rollback_root: Path
    snapshot_sha256: str
    fence: int
    verified_spaces: tuple[str, ...]
```

Never delete the rollback root in `cutover()`. Retention is a separate operator action after the rollback window.

- [ ] **Step 5: Build relocation from snapshot/staging/cutover rather than path mutation**

`DataRootRelocator.relocate(target_root)` is also offline. It validates a new absent target, takes a rollback snapshot under the old root's owner/global leases, restores into staging beneath the target filesystem, rewrites only the staged Meta `db_path`/`notes_dir` records to canonical target paths, emits a new staged-tree receipt/hash, and re-runs read-only verification. It then takes a parent-level target publication lock, atomically renames staging to `target_root` on that filesystem, fsyncs the target parent, and preserves the old root unchanged as rollback. It does not call same-path `cutover()` and does not claim cross-volume `os.replace` atomicity. The operator changes the configured data-root only after verifying the `RelocationResult`; a missing/moved live store is never created implicitly.

The package-internal return shapes used below are exact: `_snapshot_under_lease(...) -> PublishedSnapshotReceipt`, `_restore_to_staging_for_target(...) -> StagedRestore`, `rewrite_staged_meta(...) -> StagedRestore` (a new immutable receipt), `verify_staged_receipt(...) -> StagedRestore`, and `_publish_target_under_parent_lock(...) -> RelocationResult`. Every rewritten/verified `StagedRestore` retains `target_active_root`, `manifest_sha256`, `staged_tree_sha256`, `catalog_hash`, and `source_fence`; callers never pass an untyped path or dictionary between these steps.

```python
@dataclass(frozen=True, slots=True)
class RelocationResult:
    success: bool
    source_root: Path
    target_root: Path
    rollback_snapshot_root: Path
    rollback_manifest_sha256: str
    staged_tree_sha256: str
    catalog_hash: str
    source_fence: int
    process_owner_fence: int
    global_fence: int
    verified_spaces: tuple[str, ...]


async def relocate(self, target_root: Path) -> RelocationResult:
    self.paths.validate_relocation_target(target_root)
    owner = await self.leases.acquire_process_owner("relocate", 60)
    async with owner:
        global_lease = await self.leases.acquire_global(
            LeaseMode.EXCLUSIVE, "relocate", 60
        )
        async with global_lease:
            snapshot = await self.recovery._snapshot_under_lease(
                self.backup_target, global_lease
            )
            staged = await self.recovery._restore_to_staging_for_target(
                snapshot.root, target_root
            )
            relocated = await self.paths.rewrite_staged_meta(staged, target_root)
            verified = await self.recovery.verify_staged_receipt(relocated)
            return await self._publish_target_under_parent_lock(
                verified, target_root, owner, global_lease
            )
```

`_publish_target_under_parent_lock(...) -> RelocationResult` must construct every field from verified receipts, never caller prose: `process_owner_fence=owner.fence`, `global_fence=global_lease.fence`, `source_fence=verified.source_fence`, and `catalog_hash=verified.catalog_hash`. A successful call returns `success=True`; every failure raises a canonical `DomainFailure` after preserving or reversing state, so there is no partially populated `success=False` receipt. Add a field-by-field serialization test and export `RelocationResult`/`PublishedSnapshotReceipt` from `app.recovery`.

- [ ] **Step 6: Run all restore, cutover, stale-fence, and relocation tests**

Run:

```powershell
.\backend\.venv\Scripts\python.exe -m pytest -q backend/tests/test_recovery.py backend/tests/test_space_relocation.py -p no:cacheprovider
```

Expected: PASS; every injected failure leaves exactly one active openable root plus a preserved rollback root/snapshot; stale fence aborts before rename; old-root service remains usable after relocation failure.

- [ ] **Step 7: Commit restore and relocation**

```powershell
git -C . add -- backend/app/recovery/__init__.py backend/app/recovery/contracts.py backend/app/recovery/coordinator.py backend/app/recovery/relocation.py backend/tests/test_recovery.py backend/tests/test_space_relocation.py
git commit -m "feat(recovery): add staged restore and fenced cutover"
```

**Review gate:** Reject if restore writes into the live root, follows copied Meta paths into the active root, mutates a snapshot during verification, calls recover instead of read-only journal inspection, nests global/process-owner acquisition, opens request runtime under a destructive lease, cuts over while the backend owner is live, lacks rollback state/fence verification, deletes rollback state automatically, claims cross-volume rename atomicity, or relocates by editing live Meta paths first.

### Task 3: Replace Partial Startup Backup With Required Scheduled Full Recovery

**Files:**
- Create: `backend/app/recovery/scheduler.py`
- Create: `backend/app/ops/__init__.py`
- Create: `backend/app/ops/cli.py`
- Create: `backend/app/ops/__main__.py`
- Create: `backend/app/ops/signals.py`
- Modify: `backend/app/settings.py`
- Modify: `backend/app/main.py`
- Modify: `backend/tests/test_backup_lifespan.py`
- Modify: `backend/tests/test_recovery.py`
- Delete: `backend/app/file_system/backup.py`

**Interfaces:**
- Consumes: `RecoveryCoordinator`, relocation Module, lifecycle task group, external backup target.
- Produces: `python -m app.ops snapshot|verify|restore|cutover|relocate`, `RecoveryScheduler.start()/close()`, and the initial `OperationalSignals` owner with only snapshot/readiness state. Task 4 extends that same class; it does not create or shadow it.

- [ ] **Step 1: Write failing CLI, initial-snapshot, scheduler, and retention tests**

```python
async def test_production_readiness_waits_for_required_initial_snapshot(app_factory, external_backup):
    app = app_factory(environment="production", backup_target=external_backup)
    async with app.router.lifespan_context(app):
        assert app.state.operational_signals.last_snapshot_success is not None


def test_task3_owns_initial_operational_signals_contract() -> None:
    from app.ops.signals import OperationalSignals

    assert tuple(OperationalSignals.snapshot_field_names()) == (
        "last_snapshot_started", "last_snapshot_success",
        "last_snapshot_manifest_sha256", "snapshot_failure_code",
    )


def test_snapshot_cli_returns_machine_json_and_nonzero_on_invalid_target(cli_runner, active_root):
    result = cli_runner("snapshot", "--target", str(active_root / "backup"), "--json")
    assert result.exit_code != 0
    body = json.loads(result.stdout)
    assert body["ok"] is False
    assert body["error"]["code"] == "snapshot_invalid"
```

Add a fake-clock scheduler test: retain the newest 30 verified snapshots, never delete a snapshot with invalid/unreadable manifest automatically, and never delete a path outside the configured backup target.

- [ ] **Step 2: Run lifecycle/CLI tests and verify the red state**

Run:

```powershell
.\backend\.venv\Scripts\python.exe -m pytest -q backend/tests/test_backup_lifespan.py backend/tests/test_recovery.py -k "scheduler or lifespan or cli or retention" -p no:cacheprovider
```

Expected: FAIL because the old lifespan still performs best-effort per-Space DB backups and no operations CLI exists.

- [ ] **Step 3: Add explicit external backup settings and fail-closed validation**

```python
backup_enabled: bool = True
backup_target_dir: Path | None = None
backup_interval_hours: PositiveInt = 24
backup_retention_count: PositiveInt = 30

@model_validator(mode="after")
def validate_backup_target(self) -> Self:
    if self.environment == "production" and self.backup_enabled and self.backup_target_dir is None:
        raise ValueError("POMODOROXII_BACKUP_TARGET_DIR is required in production")
    if self.backup_target_dir is not None:
        ensure_outside(self.backup_target_dir.resolve(), self.data_root.resolve())
    return self
```

Use one canonical `data_root` setting from S2; do not infer separate Meta/Space roots in scheduler code.

- [ ] **Step 4: Implement the scheduler and production startup gate**

`RecoveryScheduler.start()` performs and verifies one snapshot before setting global readiness complete, then starts one cancellable async loop. Each run records start/end/outcome/manifest digest through `OperationalSignals`. `close()` cancels and awaits the task. Retention sorts verified manifests by `created_at`, keeps 30, and logs invalid entries for operator review without deleting them.

Task 3 creates `app/ops/__init__.py` and the minimal concurrency-safe `OperationalSignals` snapshot state before `main.py` imports it. The Module exposes atomic `snapshot_started`, `snapshot_succeeded`, and `snapshot_failed` updates plus a read-only readiness view; it has no Prometheus dependency, credential logic, request labels, or Space metrics yet. Task 4 modifies this same owner to add those capabilities.

Replace `BackupService` use in `main.lifespan`; delete its module after all imports disappear. A required initial snapshot failure leaves readiness false and aborts production startup. Development can set `backup_enabled=false` explicitly.

- [ ] **Step 5: Implement exact CLI dispatch and exit behavior**

```python
COMMANDS = {
    "snapshot": run_snapshot,
    "verify": run_verify,
    "restore": run_restore,
    "cutover": run_cutover,
    "relocate": run_relocate,
}

def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = asyncio.run(COMMANDS[args.command](args))
        emit({"ok": True, "result": asdict(result)}, json_mode=args.json)
        return 0
    except DomainFailure as exc:
        emit({"ok": False, "error": asdict(exc.record)}, json_mode=args.json)
        return 2
```

Restore CLI always produces a `StagedRestore` receipt first; `cutover` requires that receipt path, source manifest hash, and staged-tree hash. `cutover`/`relocate` first prove the backend is stopped by acquiring process-owner and return stable `lease_timeout` without a rename when it is live. There is no `--force-live-overwrite` or online destructive mode.

- [ ] **Step 6: Run lifecycle/CLI tests and remove the alternate backup path**

Run:

```powershell
.\backend\.venv\Scripts\python.exe -m pytest -q backend/tests/test_backup_lifespan.py backend/tests/test_recovery.py -p no:cacheprovider
$backupMatches = rg -n "BackupService|file_system\.backup" backend/app backend/tests
if ($LASTEXITCODE -eq 0) { throw "obsolete backup path remains:`n$backupMatches" }
if ($LASTEXITCODE -ne 1) { throw "rg failed with exit code $LASTEXITCODE" }
```

Expected: tests PASS; `rg` returns no matches; production readiness occurs only after a verified full snapshot; scheduler shutdown leaves no live task.

- [ ] **Step 7: Commit scheduler and operations CLI**

```powershell
git -C . add -- backend/app/recovery/scheduler.py backend/app/ops/__init__.py backend/app/ops/cli.py backend/app/ops/__main__.py backend/app/ops/signals.py backend/app/settings.py backend/app/main.py backend/tests/test_backup_lifespan.py backend/tests/test_recovery.py backend/app/file_system/backup.py
git commit -m "feat(ops): require scheduled full recovery snapshots"
```

**Review gate:** Reject if production can be ready before the first verified full snapshot, backup target may be inside the active root, scheduler tasks are not awaited on shutdown, retention deletes unverifiable content, CLI can overwrite live data, or the old partial backup remains callable.

### Task 4: Add Distinct Operations Credentials, Readiness, Metrics, And SLO Signals

**Files:**
- Modify: `backend/app/ops/__init__.py`
- Create: `backend/app/ops/credentials.py`
- Modify: `backend/app/ops/signals.py`
- Create: `backend/app/ops/routes.py`
- Modify: `backend/app/ops/cli.py`
- Modify: `backend/app/main.py`
- Modify: `backend/app/middleware.py`
- Modify: `backend/app/logging.py`
- Modify: `backend/app/settings.py`
- Modify: `backend/app/routes/v1/spaces.py`
- Modify: `backend/pyproject.toml`
- Modify: `backend/uv.lock`
- Create: `backend/tests/test_operational_endpoints.py`
- Create: `backend/tests/test_observability.py`
- Create: `backend/docs/SLO.md`

**Interfaces:**
- Consumes: Meta settings store, constant-time hashing, `SpaceRuntime.health()`, Recovery/Sync/UoW signals, route-template middleware labels, and Task 3's initial `OperationalSignals` snapshot/readiness owner.
- Produces: `OperationsCredentialStore`, protected `/api/metrics`, global `/api/ready`, authorized `/api/v1/spaces/{space_id}/health`, low-cardinality Prometheus metrics, and SLO definitions while preserving Task 3's snapshot fields and update methods unchanged.

- [ ] **Step 1: Write failing credential, endpoint, metric, and redaction tests**

```python
async def test_ops_token_is_printed_once_and_only_digest_is_stored(meta_session, capsys, caplog):
    issued = await OperationsCredentialStore(meta_session).issue()
    assert len(issued.token_bytes) == 32
    assert issued.token not in caplog.text
    stored = await get_meta_setting(meta_session, "operations_token_sha256")
    assert stored == hashlib.sha256(issued.token.encode()).hexdigest()
    assert issued.token not in stored


async def test_master_and_space_tokens_cannot_read_metrics(client, master_headers, space_headers):
    assert (await client.get("/api/metrics", headers=master_headers)).status_code == 403
    assert (await client.get("/api/metrics", headers=space_headers)).status_code == 403


def test_metrics_have_bounded_label_names(signals):
    text = signals.render_prometheus().decode()
    forbidden = ("space_id=", "entity_id=", "request_id=", "token=", "path=")
    assert not any(value in text for value in forbidden)
```

Add rotate/revoke/constant-time comparison tests; a persistent data-root probe test; startup migration incomplete test; one degraded Space returns 503 at its health/requests while another remains healthy; logs never contain absolute data roots, secrets, tokens, passwords, or Note bodies.

- [ ] **Step 2: Add the Prometheus dependency and verify tests are red**

Add `prometheus-client>=0.22` to project dependencies, refresh `uv.lock`, then run:

```powershell
uv lock --project backend
.\backend\.venv\Scripts\python.exe -m pytest -q backend/tests/test_operational_endpoints.py backend/tests/test_observability.py -p no:cacheprovider
```

Expected: dependency lock succeeds; tests FAIL because credential/signals/routes do not exist.

- [ ] **Step 3: Implement digest-only credential lifecycle and CLI commands**

```python
async def issue(self) -> IssuedCredential:
    if await self._digest() is not None:
        raise DomainFailure(code="operations_credential_exists")
    raw = secrets.token_bytes(32)
    token = base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")
    epoch = await self._next_epoch()
    await self._store(hashlib.sha256(token.encode()).hexdigest(), epoch)
    return IssuedCredential(token=token, token_bytes=raw, epoch=epoch)

async def verify(self, token: str) -> OperationsPrincipal:
    expected = await self._digest()
    supplied = hashlib.sha256(token.encode()).hexdigest()
    if expected is None or not hmac.compare_digest(expected, supplied):
        raise DomainFailure(code="forbidden")
    return OperationsPrincipal(scope="operations", epoch=await self._epoch())
```

`rotate` replaces the digest and increments epoch in one transaction; `revoke` removes the digest and increments epoch. CLI `credentials issue|rotate` prints the token only to stdout once and a nonsecret receipt to stderr/JSON evidence; no logging call receives it.

- [ ] **Step 4: Implement bounded signals and instrument request/recovery/sync state**

Use route templates and status class only:

```python
REQUESTS = Counter(
    "pomodoroxii_http_requests_total", "HTTP requests", ("method", "route", "status_class")
)
LATENCY = Histogram(
    "pomodoroxii_http_request_duration_seconds", "HTTP latency", ("method", "route")
)
PENDING_MUTATIONS = Gauge("pomodoroxii_pending_mutations", "Nonterminal mutations")
SYNC_LAG = Gauge("pomodoroxii_sync_lag_events", "Visible events above minimum active ACK")
DEGRADED_SPACES = Gauge("pomodoroxii_degraded_spaces", "Degraded registered Spaces")
BACKUP_AGE = Gauge("pomodoroxii_backup_age_seconds", "Age of last verified full snapshot")
RECOVERY = Counter("pomodoroxii_recovery_operations_total", "Recovery operations", ("operation", "outcome"))
```

Allowed `operation` values are `snapshot`, `verify`, `restore`, `cutover`, `relocate`; allowed `outcome` values are `success`, `failure`, `timeout`. Middleware obtains the matched route template after dispatch; unmatched routes use `unmatched`, never the raw path.

Add `structured_log_path: Path | None = None` bound to `POMODOROXII_STRUCTURED_LOG_PATH`. When set by CI/certification, `app.logging` writes canonical redacted JSONL to that exact file and fsyncs on orderly shutdown; otherwise production continues to emit structured logs to stdout. It never creates a parent outside the caller-provided run-scoped evidence root. Tests set the path explicitly and require a nonempty parseable JSONL artifact with no forbidden values.

- [ ] **Step 5: Replace readiness/metrics and expose isolated Space health**

Global readiness checks Meta head, startup migration complete, runtime initialized, required initial snapshot complete, and a create/fsync/delete probe file under the persistent data root. `/api/metrics` accepts only operations Bearer credential. `/api/v1/spaces/{id}/health` uses an authorized principal and `SpaceRuntime.health(id)`; degraded Spaces return canonical per-Space 503 without setting global readiness false after startup.

```python
@router.get("/metrics", response_class=Response)
async def metrics(_: OperationsPrincipal = Depends(require_operations_token)) -> Response:
    return Response(signals.render_prometheus(), media_type="text/plain; version=0.0.4")
```

- [ ] **Step 6: Define measurable SLOs and alert bindings**

Write `backend/docs/SLO.md` with exact rolling windows and metric expressions:

- availability: 99.9% successful non-maintenance requests over 30 days;
- p95 request latency: under 500 ms over 5 minutes, excluding recovery commands;
- Sync lag: under 1,000 visible events for 99% of 15-minute windows;
- verified backup age: under 26 hours;
- degraded Spaces: zero for 10 continuous minutes;
- pending mutation age: no nonterminal operation older than 5 minutes.

Each objective names its metric, alert threshold, owner action, and runbook link. Do not encode a Space ID label.

- [ ] **Step 7: Run operations, redaction, production, and lock gates**

Run:

```powershell
uv lock --project backend --check --offline
.\backend\.venv\Scripts\python.exe -m pytest -q backend/tests/test_operational_endpoints.py backend/tests/test_observability.py backend/tests/test_prod_hardening.py -p no:cacheprovider
.\backend\.venv\Scripts\ruff.exe check --no-cache backend/app/ops backend/app/main.py backend/app/middleware.py backend/app/logging.py backend/tests/test_operational_endpoints.py backend/tests/test_observability.py
```

Expected: PASS; no default operations token; old master/Space JWTs receive 403; rotate invalidates old token; revoke disables metrics; readiness performs a persistent root write; label-set cardinality remains bounded.

- [ ] **Step 8: Commit operations security and signals**

```powershell
git -C . add -- backend/app/ops/__init__.py backend/app/ops/credentials.py backend/app/ops/signals.py backend/app/ops/routes.py backend/app/ops/cli.py backend/app/main.py backend/app/middleware.py backend/app/logging.py backend/app/settings.py backend/app/routes/v1/spaces.py backend/pyproject.toml backend/uv.lock backend/tests/test_operational_endpoints.py backend/tests/test_observability.py backend/docs/SLO.md
git commit -m "feat(ops): add protected operational signals"
```

**Review gate:** Reject if metrics accept master/Space credentials, raw tokens are stored/logged, comparison is not constant-time, readiness uses only a TEMP table, one degraded Space restarts/blocks healthy Spaces, labels contain unbounded identities/paths, or SLOs lack executable metric expressions.

### Task 5: Make CI Evidence Run-Scoped, Complete, And Retained

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `backend/app/audit/__init__.py`
- Create: `backend/app/audit/producer_contracts.py`
- Create: `backend/scripts/evidence_records.py`
- Create: `backend/scripts/ci/verify_artifacts.py`
- Create: `backend/audit/95plus/pxii-vfs-wheel-manifest.schema.json`
- Create: `backend/scripts/ci/verify_pxii_vfs_wheels.py`
- Create: `backend/tests/test_pxii_vfs_wheel_evidence.py`
- Create: `backend/tests/test_ci_evidence.py`
- Modify: `backend/tests/test_prod_hardening.py`
- Consume unchanged: `backend/audit/95plus/evidence.schema.json`
- Consume unchanged: `.github/workflows/pxii-vfs-wheels.yml`
- Consume unchanged: `backend/CMakeLists.txt`
- Consume unchanged: `backend/cibuildwheel.toml`
- Consume unchanged: `backend/cmake/pxii-vfs-source.sha256`
- Consume unchanged: `backend/native/pxii_vfs/pxii_vfs.c`
- Consume unchanged: `backend/native/pxii_vfs/pxii_vfs.h`
- Consume unchanged: `backend/native/vendor/sqlite3ext.h`
- Consume unchanged: `backend/scripts/verify_pxii_vfs_source_hash.py`

**Interfaces:**
- Consumes: S0 evidence schema, S0 pytest-cov dependency, S1 run-scoped test artifact root, backend tests, Docker smoke image.
- Produces: frozen `ProducerContract`/`PRODUCER_CONTRACTS` authority for all S5/S6 producers and computed non-self-referential `S5_INPUT_PRODUCERS`; exact-SHA JUnit/coverage/log/failed-sandbox/image-digest/provenance artifacts; a schema-verified two-platform `pxii-vfs-wheel-manifest-v1` input and closed `ci-evidence.json` for S6; on trusted `main` push, the only target image build/push.

- [ ] **Step 1: Write failing workflow and artifact-manifest tests**

```python
def test_ci_collects_real_outputs_and_failed_sandboxes() -> None:
    workflow = load_workflow(ROOT / ".github/workflows/ci.yml")
    test_job = workflow["jobs"]["test"]
    script = joined_run_scripts(test_job)
    assert "--junitxml=.test-results/junit.xml" in script
    assert "--cov-report=xml:.test-results/coverage.xml" in script
    assert test_job["env"]["POMODOROXII_TEST_ARTIFACTS_ROOT"] == (
        "${{ runner.temp }}/pomodoroxii-test-artifacts"
    )
    assert {key for key in test_job["env"] if key.startswith("POMODOROXII_TEST_ARTIFACT")} == {
        "POMODOROXII_TEST_ARTIFACTS_ROOT"
    }
    uploads = artifact_uploads(test_job)
    assert any(".test-results/junit.xml" in upload["path"] for upload in uploads)
    failed = [upload for upload in uploads if "failed-sandboxes" in upload["name"]]
    assert len(failed) == 1
    assert failed[0]["if"] == "failure()"
    assert failed[0]["path"] == "${{ env.POMODOROXII_TEST_ARTIFACTS_ROOT }}"


def test_ci_actions_are_full_sha_pinned() -> None:
    for use in all_action_uses(load_workflow(ROOT / ".github/workflows/ci.yml")):
        assert re.fullmatch(r"[^@]+@[0-9a-f]{40}", use), use


def test_one_producer_authority_reserves_s5_and_s6_ids() -> None:
    from app.audit.producer_contracts import PRODUCER_CONTRACTS, S5_INPUT_PRODUCERS

    expected = {
        "ci": (
            "EV-CI-JUNIT", "EV-CI-COVERAGE", "EV-CI-LOG", "EV-CI-SUBJECT",
            "EV-CI-IMAGE-DIGEST", "EV-CI-PROVENANCE",
            "EV-CI-PXII-VFS-WHEEL-MANIFEST",
        ),
        "supply_chain": (
            "EV-SUPPLY-IMAGE-DIGEST", "EV-SUPPLY-PROVENANCE", "EV-SUPPLY-SBOM-SPDX",
            "EV-SUPPLY-SBOM-CYCLONEDX", "EV-SUPPLY-SCAN", "EV-SUPPLY-SIGNATURE",
            "EV-SUPPLY-PXII-VFS-RUNTIME",
        ),
        "n_minus_one": ("EV-N-MINUS-ONE-DRILL",),
        "fresh_deploy": ("EV-FRESH-VOLUME-DEPLOY",),
        "release": ("EV-RELEASE-BUNDLE", "EV-S5-HISTORY"),
        "matrix_fault": ("EV-MUTATION-FAULT-MATRIX",),
        "matrix_security": ("EV-SECURITY-MATRIX",),
        "matrix_resource": ("EV-RESOURCE-MATRIX", "EV-SYNC-PULL-MEASUREMENT"),
    }
    assert tuple(PRODUCER_CONTRACTS) == tuple(expected)
    actual = {name: contract.evidence_ids for name, contract in PRODUCER_CONTRACTS.items()}
    assert actual == expected
    assert S5_INPUT_PRODUCERS == ("ci", "supply_chain", "n_minus_one", "fresh_deploy")
    assert "release" not in S5_INPUT_PRODUCERS
    assert PRODUCER_CONTRACTS["ci"].supplemental_artifact_name_templates == (
        "pxii-vfs-wheel-manifest-v1",
    )
    all_ids = [
        evidence_id
        for contract in PRODUCER_CONTRACTS.values()
        for evidence_id in contract.evidence_ids
    ]
    assert len(all_ids) == len(set(all_ids))
    for contract in PRODUCER_CONTRACTS.values():
        for artifact in contract.artifacts:
            assert artifact.modules and artifact.finding_ids and artifact.certification_tags
            assert len(artifact.modules) == len(set(artifact.modules))
            assert len(artifact.finding_ids) == len(set(artifact.finding_ids))
            assert len(artifact.certification_tags) == len(set(artifact.certification_tags))


def test_audit_package_preserves_s0_exports_when_adding_producers() -> None:
    from app import audit

    assert audit.__all__ == (
        "validate_evidence_envelope", "resolve_bundle_artifact", "resolve_external_artifact",
        "ProducerContract", "PRODUCER_CONTRACTS", "S5_INPUT_PRODUCERS",
    )
    assert callable(audit.validate_evidence_envelope)
    assert callable(audit.resolve_bundle_artifact)
    assert callable(audit.resolve_external_artifact)


def test_main_push_builds_and_pushes_the_target_once() -> None:
    workflow = load_workflow(ROOT / ".github/workflows/ci.yml")
    builds = docker_build_steps(workflow)
    assert len(builds) == 1
    assert builds[0]["with"]["provenance"] == "mode=max"
    assert builds[0]["with"]["sbom"] is True
    assert "github.event_name == 'push'" in str(builds[0]["with"]["push"])
    assert "github.ref == 'refs/heads/main'" in str(builds[0]["with"]["push"])
```

Add fixture tests for `verify_artifacts.py`: a missing/empty JUnit, coverage, log, image receipt, provenance receipt, wrong subject SHA, artifact byte size, or hash mismatch must return nonzero. A pull-request fixture succeeds with an inspected local image ID and `trust_level="pr_local"` but no repository digest/provenance claim; a trusted `main` push fixture additionally requires one inspected RepoDigest, one verified provenance artifact, `event="push"`, `ref="refs/heads/main"`, originating `run_attempt == 1`, workflow ID/path, and `trust_level="trusted_push"`. Test exact stable IDs through `PRODUCER_CONTRACTS`, global uniqueness, all S0-required keys, closed records, and nonempty `certification_tags`; certification input selection accepts only `trusted_push`.

Add `test_pxii_vfs_wheel_evidence.py` before implementation. Its valid fixture contains exactly the Windows x64 and Linux x86_64 CPython 3.13 wheels from the same first-attempt trusted-main CI run. Tamper cases remove/add a platform or member, change subject/source-tree/native-input/toolchain/wheel/extension/test hashes or sizes, change extension build ID, `sqlite3_source_id`, or `sqlite3_libversion`, add an embedded SQLite library, report skipped/failed/zero tests, select the Windows wheel for Linux, or add a source-build fallback. Every case must fail before an evidence record is emitted.

- [ ] **Step 2: Run the CI contract tests and verify the red state**

Run:

```powershell
.\backend\.venv\Scripts\python.exe -m pytest -q backend/tests/test_ci_evidence.py backend/tests/test_prod_hardening.py -p no:cacheprovider
```

Expected: FAIL because the shared producer-authority package does not exist, current CI uploads `.pytest_cache`/logs it does not produce, has no JUnit/coverage/image-digest evidence, and action refs are tags.

- [ ] **Step 3: Make test outputs and external artifact roots explicit**

Set the job environment and test command:

```yaml
env:
  POMODOROXII_TEST_ARTIFACTS_ROOT: ${{ runner.temp }}/pomodoroxii-test-artifacts
  POMODOROXII_EVIDENCE_ROOT: ${{ runner.temp }}/pomodoroxii-evidence/${{ github.run_id }}-${{ github.run_attempt }}

- name: Run backend suite with evidence
  working-directory: backend
  run: >-
    uv run pytest tests -q -p no:cacheprovider
    --junitxml=.test-results/junit.xml
    --cov=app --cov-branch
    --cov-report=xml:.test-results/coverage.xml
    --cov-report=term
```

Redirect structured application logs to `.test-results/backend.jsonl` in the test configuration. Upload JUnit, coverage, and log with `if: always()` and `if-no-files-found: error`. The failed-sandbox upload uses `path: ${{ env.POMODOROXII_TEST_ARTIFACTS_ROOT }}`, exactly the configured external root named `pomodoroxii-test-artifacts`, and only `if: failure()`; it must not point at a synthetic `test-sandboxes` or `failed-sandboxes` sibling. S1's run directories remain immediate `run-<16 lowercase hex>` children of that root, and successful jobs upload none of them.

- [ ] **Step 4: Build/push once on trusted main and record exact checkout, digest, and provenance**

Checkout uses `fetch-depth: 1`, then a step with `working-directory: backend` writes `git rev-parse HEAD` to `.test-results/subject-sha.txt` and asserts it equals `${{ github.sha }}`. The workflow contains exactly one literal `docker/build-push-action` step in the `backend` job, and that job has no `strategy.matrix` and is not a reusable-workflow call. Pull requests execute it with `push: false` and record only the inspected local image ID. Only `github.event_name == 'push' && github.ref == 'refs/heads/main' && github.run_attempt == 1` may execute it with `push: true`, `sbom: true`, and `provenance: mode=max`; a SHA-scoped `concurrency.group` with `cancel-in-progress: false` serializes that owner. Before the publish step, an all-pages Actions/artifact lookup fails if another successful producer already exists for the SHA. A rerun or later same-SHA run is a reuse-only path that downloads and validates the first successful `backend-ci-${SHA}` digest/provenance, emits no build command, and fails if that unique subject is unavailable. The first producer inspects the action's returned RepoDigest, exports/downloads the BuildKit/GitHub provenance for that same digest, and writes the immutable run identity. A matrix expansion, reusable workflow, composite action, tag, workflow-dispatch run, rerun, or later release job cannot publish the target.

```powershell
$subjectSha = (Get-Content -Raw '.test-results/subject-sha.txt').Trim()
$localImageId = $env:LOCAL_IMAGE_ID
$trustLevel = $env:IMAGE_TRUST_LEVEL
$repositoryDigest = $env:IMAGE_REPOSITORY_DIGEST
$provenanceSha256 = $env:IMAGE_PROVENANCE_SHA256
$workflowId = [long]$env:CI_WORKFLOW_ID
if ($subjectSha -notmatch '^[0-9a-f]{40}$') { throw 'invalid subject SHA' }
if ($localImageId -notmatch '^sha256:[0-9a-f]{64}$') { throw 'invalid local image ID' }
if ($trustLevel -notin @('pr_local', 'trusted_push')) { throw 'invalid image trust level' }
if ($workflowId -le 0) { throw 'invalid workflow ID' }
if ($trustLevel -eq 'trusted_push' -and $repositoryDigest -notmatch '@sha256:[0-9a-f]{64}$') {
  throw 'trusted push requires an inspected repository digest'
}
if ($trustLevel -eq 'pr_local' -and $repositoryDigest) {
  throw 'pull request image receipt must not claim a repository digest'
}
if ($trustLevel -eq 'trusted_push' -and $provenanceSha256 -notmatch '^[0-9a-f]{64}$') {
  throw 'trusted push requires hashed provenance'
}
[ordered]@{
  subject_sha = $subjectSha
  local_image_id = $localImageId
  trust_level = $trustLevel
  repository_digest = if ($trustLevel -eq 'trusted_push') { $repositoryDigest } else { $null }
  provenance_sha256 = if ($trustLevel -eq 'trusted_push') { $provenanceSha256 } else { $null }
  event = '${{ github.event_name }}'
  ref = '${{ github.ref }}'
  run_id = [long]'${{ github.run_id }}'
  run_attempt = [int]'${{ github.run_attempt }}'
  workflow_id = $workflowId
  workflow_path = '.github/workflows/ci.yml'
  workflow_ref = '${{ github.workflow_ref }}'
} | ConvertTo-Json -Compress | Set-Content -Encoding utf8 '.test-results/image-digest.json'
```

The workflow sets `LOCAL_IMAGE_ID` from `docker image inspect` and obtains numeric `CI_WORKFLOW_ID` by reading the authenticated Actions API record for exactly `${{ github.run_id }}`; it must match `.github/workflows/ci.yml`. Only the first trusted `main` producer sets `IMAGE_TRUST_LEVEL=trusted_push`, `IMAGE_REPOSITORY_DIGEST`, and `IMAGE_PROVENANCE_SHA256` from verified build outputs; pull requests set `pr_local` and leave digest/provenance empty, while a reuse-only rerun copies the already verified producer record without changing its originating run ID/attempt. Never synthesize a digest or workflow identity from a tag, Dockerfile hash, display name, or release rebuild. Static tests recursively inspect `.github/workflows/**`, `.github/actions/**`, and `backend/scripts/**`, require one build action total, and reject `docker build`, `docker buildx build`, BuildKit API wrappers, reusable/composite delegation, or a matrix on the owner job. S6 rejects `pr_local` while retaining it as useful smoke evidence.

The same originating first-attempt trusted-main run invokes S1's reusable Windows x64/Linux x86_64 CPython 3.13 matrix and publishes exactly one supplemental GitHub artifact named `pxii-vfs-wheel-manifest-v1`. Before CI writes `EV-CI-PXII-VFS-WHEEL-MANIFEST`, it downloads that artifact without auto-extraction, safely extracts it beneath a fresh external root, validates the closed schema/canonical bytes, independently rehashes both wheel members, safely unpacks both wheels, and rehashes the packaged extension. The stable artifact and `backend-ci-${SHA}` must agree on full subject SHA, originating workflow/run/attempt, and hashes; neither may be selected by display time or first page. The verified manifest is retained at `pxii-vfs/pxii-vfs-wheel-manifest.json` in the canonical CI consumer layout, while the two wheel members remain under `pxii-vfs/wheels/` for the later Linux image and S6 re-verification.

- [ ] **Step 5: Implement artifact verification and evidence normalization**

Create `backend/app/audit/producer_contracts.py` before the verifier. Modify the existing S0 `backend/app/audit/__init__.py` additively: retain its evidence validator and two resolver imports first, append imports of `ProducerContract`, `PRODUCER_CONTRACTS`, and computed `S5_INPUT_PRODUCERS`, and set `__all__` to the exact six-name tuple asserted above. Never replace or narrow the S0 exports. The producer owner is complete even though S6 matrix artifacts do not exist yet:

```python
from dataclasses import dataclass
from types import MappingProxyType
from typing import Literal


@dataclass(frozen=True, slots=True)
class ProducerArtifactContract:
    relative_path: str
    evidence_id: str
    modules: tuple[str, ...]
    finding_ids: tuple[str, ...]
    certification_tags: tuple[str, ...]


def _a(
    relative_path: str,
    evidence_id: str,
    modules: tuple[str, ...],
    finding_ids: tuple[str, ...],
    certification_tags: tuple[str, ...],
) -> ProducerArtifactContract:
    return ProducerArtifactContract(
        relative_path, evidence_id, modules, finding_ids, certification_tags
    )


ALL_MODULES = (
    "runtime_auth", "migration_space_lifecycle", "registry_meta", "entity_commands",
    "sync_push", "sync_pull_recovery", "notes_fs", "deploy_operations", "mcp",
)


@dataclass(frozen=True, slots=True)
class ProducerContract:
    wave: Literal["S5", "S6"]
    envelope_path: str
    artifact_root: str
    artifacts: tuple[ProducerArtifactContract, ...]
    eligible_trust_levels: frozenset[str]
    workflow_path: str
    allowed_events: frozenset[str]
    allowed_refs: frozenset[str]
    artifact_name_template: str
    required_run_attempt: int | None = None
    supplemental_artifact_name_templates: tuple[str, ...] = ()

    @property
    def evidence_ids(self) -> tuple[str, ...]:
        return tuple(artifact.evidence_id for artifact in self.artifacts)

    @property
    def evidence_by_artifact(self) -> tuple[tuple[str, str], ...]:
        return tuple((artifact.relative_path, artifact.evidence_id) for artifact in self.artifacts)


PRODUCER_CONTRACTS = MappingProxyType({
    "ci": ProducerContract("S5", "inputs/ci/ci-evidence.json", "inputs/ci", (
        _a("junit.xml", "EV-CI-JUNIT", ALL_MODULES,
           ("P1-01","P1-02","P1-04","P1-05","P1-06","P1-07","P1-08","P1-09","P1-10","P1-13"),
           ("named_alembic_only","authoritative_space_path","entity_invariants","entity_cas","compiled_catalog","index_store_schema","client_ack_waterline","mcp_sync_parity","operational_probes","ci_artifact_lifecycle","documentation_contract")),
        _a("coverage.xml", "EV-CI-COVERAGE", ALL_MODULES, ("P1-10",), ("ci_artifact_lifecycle",)),
        _a("backend.jsonl", "EV-CI-LOG", ("runtime_auth","sync_push","sync_pull_recovery","deploy_operations"),
           ("P1-09","P1-10"), ("operational_probes","bounded_metrics","ci_artifact_lifecycle")),
        _a("subject-sha.txt", "EV-CI-SUBJECT", ALL_MODULES, ("P1-10","P1-13"),
           ("ci_artifact_lifecycle","documentation_contract")),
        _a("image-digest.json", "EV-CI-IMAGE-DIGEST", ("deploy_operations",), ("P1-12",), ("digest_deploy",)),
        _a("build-provenance.json", "EV-CI-PROVENANCE", ("deploy_operations",), ("P1-11",), ("immutable_supply_chain",)),
        _a("pxii-vfs/pxii-vfs-wheel-manifest.json", "EV-CI-PXII-VFS-WHEEL-MANIFEST",
           ("migration_space_lifecycle","entity_commands","sync_push","sync_pull_recovery","notes_fs","deploy_operations","mcp"),
           ("P1-02","P1-11"), ("authoritative_space_path","immutable_supply_chain")),
    ), frozenset({"trusted_push"}), ".github/workflows/ci.yml", frozenset({"push"}),
       frozenset({"refs/heads/main"}), "backend-ci-{subject_sha}", 1,
       ("pxii-vfs-wheel-manifest-v1",)),
    "supply_chain": ProducerContract("S5", "inputs/release/supply-chain-evidence.json", "inputs/release", (
        _a("image-digest.json", "EV-SUPPLY-IMAGE-DIGEST", ("deploy_operations",), ("P1-11","P1-12"), ("immutable_supply_chain","digest_deploy")),
        _a("build-provenance.json", "EV-SUPPLY-PROVENANCE", ("deploy_operations",), ("P1-11",), ("immutable_supply_chain",)),
        _a("sbom.spdx.json", "EV-SUPPLY-SBOM-SPDX", ("deploy_operations",), ("P1-11",), ("immutable_supply_chain",)),
        _a("sbom.cyclonedx.json", "EV-SUPPLY-SBOM-CYCLONEDX", ("deploy_operations",), ("P1-11",), ("immutable_supply_chain",)),
        _a("trivy.json", "EV-SUPPLY-SCAN", ("runtime_auth","deploy_operations"), ("P1-11",), ("immutable_supply_chain",)),
        _a("cosign-bundle.json", "EV-SUPPLY-SIGNATURE", ("runtime_auth","deploy_operations"), ("P1-11",), ("immutable_supply_chain",)),
        _a("pxii-vfs-runtime-extension.json", "EV-SUPPLY-PXII-VFS-RUNTIME",
           ("migration_space_lifecycle","entity_commands","sync_push","sync_pull_recovery","notes_fs","deploy_operations","mcp"),
           ("P1-02","P1-11","P1-12"),
           ("authoritative_space_path","immutable_supply_chain","digest_deploy")),
    ), frozenset({"release_drill"}), ".github/workflows/backend-release.yml", frozenset({"push"}),
       frozenset({"refs/heads/main"}), "backend-release-{subject_sha}"),
    "n_minus_one": ProducerContract("S5", "inputs/release/n-minus-one-evidence.json", "inputs/release",
        (_a("n-minus-one-drill.json", "EV-N-MINUS-ONE-DRILL",
            ("migration_space_lifecycle","registry_meta","entity_commands","sync_pull_recovery","notes_fs","deploy_operations"),
            ("P0-06","P1-03","P1-06","P1-12"),
            ("full_snapshot","independent_full_restore","n_minus_one_rollback","wal_durable_migration","index_store_schema","digest_deploy")),), frozenset({"release_drill"}),
        ".github/workflows/backend-release.yml", frozenset({"push"}), frozenset({"refs/heads/main"}),
        "backend-release-{subject_sha}"),
    "fresh_deploy": ProducerContract("S5", "inputs/release/fresh-deploy-evidence.json", "inputs/release",
        (_a("fresh-deploy-drill.json", "EV-FRESH-VOLUME-DEPLOY", ALL_MODULES,
            ("P1-09","P1-12"), ("operational_probes","bounded_metrics","digest_deploy","fresh_volume_deploy")),), frozenset({"release_drill"}),
        ".github/workflows/backend-release.yml", frozenset({"push"}), frozenset({"refs/heads/main"}),
        "backend-release-{subject_sha}"),
    "release": ProducerContract("S5", "inputs/release/release-evidence.json", "inputs/release", (
        _a("release-artifact-index.json", "EV-RELEASE-BUNDLE", ALL_MODULES,
           ("P0-06","P1-10","P1-11","P1-12","P1-13"),
           ("independent_full_restore","n_minus_one_rollback","ci_artifact_lifecycle","immutable_supply_chain","digest_deploy","fresh_volume_deploy","documentation_contract")),
        _a("s5-history.json", "EV-S5-HISTORY", ("deploy_operations",),
           ("P1-10","P1-11","P1-12"), ("producer_before_activation",)),
    ), frozenset({"release_drill"}),
        ".github/workflows/backend-release.yml", frozenset({"push"}), frozenset({"refs/heads/main"}),
        "backend-release-{subject_sha}"),
    "matrix_fault": ProducerContract("S6", "matrices/fault-evidence.json", "matrices",
        (_a("fault-receipt.json", "EV-MUTATION-FAULT-MATRIX",
            ("migration_space_lifecycle","registry_meta","entity_commands","sync_push","notes_fs"),
            ("P0-01","P0-02","P0-05","P1-03","P1-04","P1-05","P1-06"),
            ("knowledge_atomicity","projection_rebuild","mutation_fault_matrix","restart_recovery","catalog_ledger_exactly_once","trash_ledger","wal_durable_migration","fenced_replace","entity_invariants","entity_cas","compiled_catalog","index_store_schema")),), frozenset({"release_drill"}),
        ".github/workflows/backend-certification.yml", frozenset({"workflow_dispatch"}),
        frozenset({"refs/heads/main"}), "backend-95plus-certification-{subject_sha}"),
    "matrix_security": ProducerContract("S6", "matrices/security-evidence.json", "matrices",
        (_a("security-receipt.json", "EV-SECURITY-MATRIX",
            ("runtime_auth","migration_space_lifecycle","sync_pull_recovery","deploy_operations","mcp"),
            ("P0-03","P0-04","P0-07","P1-01","P1-02","P1-08"),
            ("mcp_authorization","space_containment","legacy_cursor_fail_closed","credential_policy","credential_concurrency","named_alembic_only","authoritative_space_path","mcp_sync_parity")),), frozenset({"release_drill"}),
        ".github/workflows/backend-certification.yml", frozenset({"workflow_dispatch"}),
        frozenset({"refs/heads/main"}), "backend-95plus-certification-{subject_sha}"),
    "matrix_resource": ProducerContract("S6", "matrices/resource-evidence.json", "matrices", (
        _a("resource-receipt.json", "EV-RESOURCE-MATRIX", ("sync_push","sync_pull_recovery","deploy_operations"),
           ("P1-07","P1-09"), ("client_ack_waterline","operational_probes","bounded_metrics")),
        _a("sync-pull-measurement.json", "EV-SYNC-PULL-MEASUREMENT", ("sync_pull_recovery",),
           ("P0-04",), ("opaque_cursor_paging","sync_pull_measurement")),
    ), frozenset({"release_drill"}), ".github/workflows/backend-certification.yml",
       frozenset({"workflow_dispatch"}), frozenset({"refs/heads/main"}),
       "backend-95plus-certification-{subject_sha}"),
})

S5_INPUT_PRODUCERS = tuple(
    name
    for name, contract in PRODUCER_CONTRACTS.items()
    if contract.wave == "S5" and name != "release"
)
assert S5_INPUT_PRODUCERS == ("ci", "supply_chain", "n_minus_one", "fresh_deploy")
```

Module import validates canonical POSIX paths, nonempty unique artifact paths/IDs/modules/findings/tags, known module/finding/tag vocabulary, globally unique evidence IDs, full workflow paths, legal event/ref combinations, and `required_run_attempt == 1` only for the CI owner. The CI owner alone has the exact supplemental artifact tuple `("pxii-vfs-wheel-manifest-v1",)`; every other tuple is empty. Every producer copies semantic fields from its `ProducerArtifactContract`; no `producer_modules`, `producer_findings`, `producer_tags`, or second semantic table exists. `artifact_root`/`envelope_path` name the canonical combined consumer layout (`inputs/ci`, `inputs/release`, or `matrices`), not a claim that all files originate in one ZIP. Tests require exact key order and frozen values. `S5_INPUT_PRODUCERS` is a computed view, not a second mapping: it excludes output-only `release` and all future S6 producers. S5 aggregation rejects any envelope outside that tuple and never copies filenames/IDs into another constant.

`pxii-vfs-wheel-manifest.schema.json` is closed. Its top-level keys are exactly `schema_version,subject_sha,source_tree_sha256,source_inputs,native_inputs,builds`; `schema_version` is `pxii-vfs-wheel-manifest-v1`. `source_inputs` is the sorted exact S1 Task 4 native/runtime/build/test closure, with `{path,sha256,size_bytes}` rows read from the target Git object; `source_tree_sha256` is SHA-256 over their canonical UTF-8 JSON. `native_inputs` is the exact three-row subset for `pxii_vfs.c`, `pxii_vfs.h`, and `sqlite3ext.h`, equal to `pxii-vfs-source.sha256`. `builds` contains exactly `windows-x86_64` and `linux-x86_64`, ordered by platform ID. Each closed row has `platform_id,os,architecture,cpython_id,compiler_id,cmake_id,ninja_id,scikit_build_core_id,cibuildwheel_id,sqlite3_source_id,sqlite3_libversion,wheel,extension,tests`; wheel and extension objects bind member/filename/hash/size plus extension build ID, and the test receipt binds positive test count, zero failures/errors/skips, exit zero, JUnit path/hash/size. `verify_pxii_vfs_wheels.py` recomputes every field, rejects embedded SQLite libraries, requires extension/control-connection `sqlite3_source_id` and `sqlite3_libversion` equality, and never accepts caller-provided hashes or a platform guess.

```python
from app.audit.producer_contracts import PRODUCER_CONTRACTS


CI_CONTRACT = PRODUCER_CONTRACTS["ci"]
CI_ARTIFACTS = {artifact.relative_path: artifact for artifact in CI_CONTRACT.artifacts}
REQUIRED = tuple(CI_ARTIFACTS)

def verify(root: Path, subject_sha: str, expected_trust: Literal["pr_local", "trusted_push"]) -> list[EvidenceRecord]:
    records = []
    for name in REQUIRED:
        path = root / name
        artifact = CI_ARTIFACTS[name]
        if not path.is_file() or path.stat().st_size == 0:
            raise ArtifactError(f"missing or empty artifact: {name}")
        records.append(EvidenceRecord.for_file(
            evidence_id=artifact.evidence_id,
            artifact_root=root,
            path=path,
            subject_sha=subject_sha,
            command=producer_command(name),
            cwd="backend",
            runtime=producer_runtime(name),
            started_at=producer_started_at(name),
            finished_at=producer_finished_at(name),
            exit_code=0,
            result="passed",
            trust_level=expected_trust,
            confidence="confirmed",
            modules=artifact.modules,
            finding_ids=artifact.finding_ids,
            certification_tags=artifact.certification_tags,
        ))
    if (root / "subject-sha.txt").read_text().strip() != subject_sha:
        raise ArtifactError("artifact subject SHA mismatch")
    image = json.loads((root / "image-digest.json").read_text(encoding="utf-8"))
    if image["trust_level"] != expected_trust:
        raise ArtifactError("image trust level mismatch")
    if expected_trust == "trusted_push" and image["repository_digest"] is None:
        raise ArtifactError("trusted CI evidence is missing RepoDigest")
    if expected_trust == "pr_local" and image["repository_digest"] is not None:
        raise ArtifactError("PR CI evidence must remain local-only")
    return records
```

Write `.test-results/ci-evidence.json` as the exact S0 envelope, not a bare array:

```python
payload = {
    "schema_version": "1.0",
    "records": [record.to_json() for record in records],
}
validate(payload, schema=Path("backend/audit/95plus/evidence.schema.json"))
write_canonical_json(output, payload)
```

`backend/scripts/evidence_records.py` is the sole S5 serializer. `for_file(artifact_root=..., path=...)` resolves both paths, requires a regular non-symlink file strictly below the explicit bundle root, stores only its POSIX bundle-relative path, independently computes `artifact_sha256` and `artifact_size_bytes`, requires RFC 3339 ordered timestamps, and refuses caller-supplied hash/size. Absolute/drive/UNC paths, `..`, backslashes, symlink escapes, the root itself, and a path outside the root fail before serialization. Each closed record contains exactly the complete S0 v1.0 fields, including `trust_level` and `certification_tags`; no producer writes a bare array or an ad hoc partial record. CI records use `exact_sha_ci`, with image/provenance records also using `image_digest`; the same tags may describe PR artifacts, but S0 trust policy prevents `pr_local` from satisfying a certification cap. Envelope validation rejects duplicate IDs within a file, and the release verifier later rejects duplicate IDs across all producer envelopes. Tests cover absolute producer paths, parent escapes, and a symlink inside the bundle that points outside.

- [ ] **Step 6: Pin currently used CI actions to full SHAs**

Use these reviewed pins and comments in `ci.yml`; Task 6's lock verifier keeps them synchronized:

```yaml
uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
uses: actions/setup-python@42375524e23c412d93fb67b49958b491fce71c38 # v5
uses: astral-sh/setup-uv@e92bafb6253dcd438e0484186d7669ea7a8ca1cc # v6
uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4.3.0
uses: docker/setup-buildx-action@e468171a9de216ec08956ac3ada2f0791b6bd435 # v3
uses: docker/login-action@74a5d142397b4f367a81961eba4e8cd7edddf772 # v3
uses: docker/build-push-action@263435318d21b8e681c14492fe198d362a7d2c83 # v6
```

The implementation review must verify each comment/tag against the action repository before merge; the executable trust boundary is the 40-character SHA, not the comment.

- [ ] **Step 7: Run workflow/static tests and local artifact verifier**

Run:

```powershell
.\backend\.venv\Scripts\python.exe -m pytest -q backend/tests/test_ci_evidence.py backend/tests/test_pxii_vfs_wheel_evidence.py backend/tests/test_prod_hardening.py -p no:cacheprovider
.\backend\.venv\Scripts\python.exe backend/scripts/ci/verify_pxii_vfs_wheels.py --fixture backend/tests/fixtures/ci/pxii-vfs-wheel-manifest --schema backend/audit/95plus/pxii-vfs-wheel-manifest.schema.json --subject-sha (git -C . rev-parse HEAD)
.\backend\.venv\Scripts\python.exe backend/scripts/ci/verify_artifacts.py --root backend/.test-results --subject-sha (git -C . rev-parse HEAD) --expected-trust pr_local --schema backend/audit/95plus/evidence.schema.json --output backend/.test-results/ci-evidence.json
.\backend\.venv\Scripts\ruff.exe check --no-cache backend/app/audit backend/scripts/evidence_records.py backend/scripts/ci/verify_artifacts.py backend/scripts/ci/verify_pxii_vfs_wheels.py backend/tests/test_ci_evidence.py backend/tests/test_pxii_vfs_wheel_evidence.py
```

Expected: tests PASS. The verifier passes only after a local evidence-producing test/image run; if image evidence is unavailable locally it must exit nonzero, and that local limitation is recorded rather than bypassed. The GitHub job must run the complete verifier before upload.

- [ ] **Step 8: Commit the CI evidence lifecycle**

```powershell
git -C . add -- .github/workflows/ci.yml backend/app/audit/__init__.py backend/app/audit/producer_contracts.py backend/audit/95plus/pxii-vfs-wheel-manifest.schema.json backend/scripts/evidence_records.py backend/scripts/ci/verify_artifacts.py backend/scripts/ci/verify_pxii_vfs_wheels.py backend/tests/test_ci_evidence.py backend/tests/test_pxii_vfs_wheel_evidence.py backend/tests/test_prod_hardening.py
git commit -m "ci: retain exact-sha backend evidence"
```

**Review gate:** Reject if S5 drops or replaces any S0 `app.audit` export, the plural sandbox variable/root/path drift, the frozen producer authority is missing/incomplete/duplicated, a consumer owns a second filename/ID table, workflow uploads a synthetic path, artifacts lack full S0 records/hash/size/trust/tags, stable IDs collide, successful sandboxes leak, any action uses a mutable tag, a non-main-push publishes, the build owner has a matrix/reusable/composite delegation, a rerun or later same-SHA run can rebuild, the target is built/pushed more than once, digest/provenance is derived rather than inspected, or upload silently ignores missing files. Also reject if the stable native artifact is missing/ambiguous/not tied to the same originating run, either platform is absent, any native/source/toolchain/wheel/extension/JUnit/build/SQLite identity is trusted rather than recomputed, the manifest schema is open, or an embedded SQLite library or source-build fallback is accepted.

### Task 6: Build, Scan, Describe, Sign, And Attest One Immutable Image Digest

**Files:**
- Create: `backend/supply-chain.lock.json`
- Create: `backend/scripts/supply_chain.py`
- Create: `backend/tests/test_supply_chain.py`
- Modify: `backend/Dockerfile`
- Modify: `.github/workflows/ci.yml`
- Create: `.github/workflows/backend-release.yml`
- Modify: `backend/tests/test_prod_hardening.py`
- Consume unchanged: `backend/app/audit/producer_contracts.py`
- Consume unchanged: `backend/scripts/evidence_records.py`
- Consume unchanged: `backend/audit/95plus/evidence.schema.json`
- Consume unchanged: `backend/audit/95plus/pxii-vfs-wheel-manifest.schema.json`
- Consume unchanged: `backend/scripts/ci/verify_pxii_vfs_wheels.py`

**Interfaces:**
- Consumes: exact target SHA, the one `trusted_push` CI RepoDigest and provenance, the same run's schema-verified `pxii-vfs-wheel-manifest-v1` plus both rehashed wheels, the S5-owned frozen producer authority, immutable source references for the uv base plus fresh-volume probe/init helpers, full-SHA actions, GHCR, GitHub OIDC.
- Produces: one subject-neutral lock containing exact digests for the uv base and separately named `fresh_volume_probe`/`fresh_volume_init` helper images; a Linux image that installs only the manifest-selected Linux wheel and never recompiles the native extension; `pxii-vfs-runtime-extension.json` proving the installed extension/SQLite identity; offline-verifiable SPDX/CycloneDX/scan/signature/provenance commands and closed S0 supply-chain evidence for a consumed digest; named tested `supply_chain.py verify-release-eligibility`, `derive-s5-history`, and `verify-s5-history` logic for the later read-only aggregator; plus a manual/static `backend-release.yml` scaffold that cannot run producer jobs on `push` or `pull_request`. Task 8 alone activates the complete producer DAG after both drill owners exist; Task 6 produces no second image build.

- [ ] **Step 1: Write failing lock, Dockerfile, workflow-permission, and artifact tests**

```python
def test_base_images_and_actions_are_immutable() -> None:
    dockerfile = (ROOT / "backend/Dockerfile").read_text()
    assert "ARG UV_IMAGE" in dockerfile
    assert dockerfile.count("FROM ${UV_IMAGE}") == 2
    lock = json.loads((ROOT / "backend/supply-chain.lock.json").read_text())
    assert all(re.fullmatch(r"[0-9a-f]{40}", action["sha"]) for action in lock["actions"])
    assert re.fullmatch(r"sha256:[0-9a-f]{64}", lock["base_images"][0]["digest"])
    assert set(lock["helper_images"]) == {"fresh_volume_probe", "fresh_volume_init"}
    assert all(
        re.fullmatch(r"sha256:[0-9a-f]{64}", item["digest"])
        for item in lock["helper_images"].values()
    )


def test_release_scaffold_is_inert_until_all_drill_owners_exist() -> None:
    workflow = load_workflow(ROOT / ".github/workflows/backend-release.yml")
    assert workflow["permissions"] == {"contents": "read"}
    assert set(workflow["on"]) == {"workflow_dispatch"}
    assert set(workflow["jobs"]) == {"static"}
    assert workflow["jobs"]["static"]["permissions"] == {"contents": "read"}
    assert not ({"publish", "drills", "release"} & set(workflow["jobs"]))
    assert docker_build_steps(workflow) == []


def test_target_is_built_and_pushed_only_by_trusted_main_ci() -> None:
    ci = load_workflow(ROOT / ".github/workflows/ci.yml")
    assert len(docker_build_steps(ci)) == 1
    release = workflow_text(load_workflow(ROOT / ".github/workflows/backend-release.yml"))
    assert "docker build" not in release
    assert "build-push-action" not in release


def test_image_installs_the_verified_linux_vfs_wheel_without_rebuild() -> None:
    ci = load_workflow(ROOT / ".github/workflows/ci.yml")
    dockerfile = (ROOT / "backend/Dockerfile").read_text()
    assert "pxii_vfs_wheel=" in workflow_text(ci)
    assert "COPY --from=pxii_vfs_wheel /selected.whl /tmp/pxii-vfs.whl" in dockerfile
    assert "uv pip install --system --no-index --no-deps /tmp/pxii-vfs.whl" in dockerfile
    assert "--no-install-project" in dockerfile
    forbidden = ("cibuildwheel", "cmake --build", "uv build", "pip install .", "uv pip install .")
    assert all(token not in dockerfile for token in forbidden)


def test_release_eligibility_is_owned_before_activation(release_api_fixture) -> None:
    result = run_supply_chain(
        "verify-release-eligibility",
        "--fixture", release_api_fixture.path,
        "--subject-sha", "a" * 40,
        "--current-run-id", "9001",
        "--current-job", "release",
    )
    assert result.returncode == 0
    assert result.json["producer_identities"] == ["ci", "supply_chain", "n_minus_one", "fresh_deploy"]
    assert result.json["current_check_excluded_by_exact_identity"] is True


def test_s5_history_identity_is_derived_from_git_objects(history_git_fixture) -> None:
    receipt = derive_s5_history(history_git_fixture.repo, history_git_fixture.target_sha)
    assert receipt.producer_commit == history_git_fixture.producer_sha
    assert receipt.activation_commit == history_git_fixture.activation_sha
    assert receipt.activation_parent == history_git_fixture.producer_sha
    assert receipt.producer_paths == history_git_fixture.expected_producer_paths
```

Add validator tests that reject mutable `latest`, tag-only base/action/helper refs, malformed/duplicate/cross-key digests, a CI envelope not marked `trusted_push`, event/ref/SHA/run-attempt/workflow drift, zero or multiple eligible CI artifacts, a release scaffold containing any build/producer command or `push`/`pull_request` trigger, scan reports with HIGH/CRITICAL findings, a signature for a different digest, or provenance whose subject/name/SHA does not equal the consumed digest/target SHA. Offline release-eligibility fixtures cover Checks, Actions runs, jobs, and artifacts on page 2; queued polling, timeout, failed/cancelled conclusions, duplicate producer/check identity, missing page, wrong predecessor, publish-hint disagreement, and exact exclusion of only the current App/workflow/run/job check. Separate temporary-Git fixtures require one unique activation commit whose subject and exact diff match the closed activation allowlist, derive its first parent as the producer commit, require that parent's exact producer-commit diff, verify the complete producer path/hash closure from the activation-parent tree, and prove both commits reachable from the target. Zero/duplicate activation candidates, a merge activation, changed/missing producer blob, extra activation path, squash, or caller/env SHA substitution fails. Valid offline fixtures produce exact stable supply-chain evidence IDs with artifact hashes, byte sizes, `trust_level="release_drill"`, and certification tags; no live release evidence is claimed in this Task.

- [ ] **Step 2: Run supply-chain tests and verify the red state**

Run:

```powershell
.\backend\.venv\Scripts\python.exe -m pytest -q backend/tests/test_supply_chain.py backend/tests/test_prod_hardening.py -p no:cacheprovider
```

Expected: FAIL because base images use a mutable tag, no lock/release workflow exists, and no scan/SBOM/signature/provenance contract exists.

- [ ] **Step 3: Implement one lock/verification tool and resolve the base digest**

`supply_chain.py resolve` queries the OCI registry manifest for the configured platform, requires `Docker-Content-Digest` to be `sha256:` followed by exactly 64 lowercase hexadecimal characters, and writes canonical sorted JSON. `verify` is offline and confirms Dockerfile/workflows/artifacts match the lock exactly.

```python
def require_digest(value: str) -> str:
    if re.fullmatch(r"sha256:[0-9a-f]{64}", value) is None:
        raise SupplyChainError(f"not an immutable digest: {value}")
    return value


def verify_action_ref(value: str) -> None:
    if re.fullmatch(r"[^@]+@[0-9a-f]{40}", value) is None:
        raise SupplyChainError(f"action is not SHA pinned: {value}")
```

Run with network access during implementation; the resolver writes only canonical lock/output files and never leaves a template token in Dockerfile:

```powershell
.\backend\.venv\Scripts\python.exe backend/scripts/supply_chain.py resolve --base-image ghcr.io/astral-sh/uv:python3.13-trixie-slim --helper-image fresh_volume_probe=docker.io/library/busybox:1.36.1 --helper-image fresh_volume_init=docker.io/library/alpine:3.20.3 --workflow .github/workflows/ci.yml --workflow .github/workflows/backend-release.yml --lock backend/supply-chain.lock.json --github-output backend/.test-results/supply-chain-outputs.txt
```

Expected: `LOCK_REFRESHED` followed by three registry-reported digests matching `^sha256:[0-9a-f]{64}$`; the lock records the base plus exact separately keyed probe/init references, and the GitHub output contains the base digest. A timeout, unauthenticated registry response, duplicate helper key, missing helper, mutable post-resolution reference, or cross-key digest substitution exits nonzero and leaves the lock unchanged.

- [ ] **Step 4: Build both stages from the same pinned base and prove non-root runtime**

```dockerfile
ARG UV_IMAGE
FROM ${UV_IMAGE} AS builder
# existing frozen uv build steps
FROM ${UV_IMAGE} AS runtime
RUN groupadd -g 1000 app && useradd -u 1000 -g app -m -s /bin/sh app
USER 1000:1000
```

Local developer build scripts and the single CI build step read `locked_image = base_images[0].reference + "@" + base_images[0].digest` from `supply-chain.lock.json` and pass `--build-arg`, `UV_IMAGE`, and `locked_image` as three argv entries; the CI build action uses the same value in `build-args`. `verify` rejects a missing build arg, a value without a digest, or a value different from the lock. Add a container test that mounts a UID/GID-1000 prepared data root, writes Meta/Space/Note/snapshot files, and asserts `id -u`/`id -g` are `1000`.

Before the build action, `verify_pxii_vfs_wheels.py select-wheel` revalidates both platform wheels and selects exactly the `linux-x86_64`/CPython 3.13 row. It copies that already-hashed member to a fresh `$RUNNER_TEMP` named build context as `selected.whl`; the action passes `build-contexts: pxii_vfs_wheel=<fresh-external-context>`. `Dockerfile` uses `COPY --from=pxii_vfs_wheel /selected.whl /tmp/pxii-vfs.whl` and `uv pip install --system --no-index --no-deps /tmp/pxii-vfs.whl`. Dependency synchronization uses `--no-install-project`. The Dockerfile and every delegated script are rejected if they invoke cibuildwheel, CMake/native compilation, PEP 517/project installation, `uv build`, `pip install .`, `uv pip install .`, or a plain project `uv sync`; a fallback after a failed wheel install is equally forbidden. The Windows wheel is still independently rehashed/unpacked/tested, but is never accepted for this Linux context.

Task 6 updates both `ci.yml` and `backend-release.yml` after the lock exists. CI has the only lock-reading/build step whose `uv_image` output is the exact `reference@digest` and whose Docker build action passes:

```yaml
build-args: |
  UV_IMAGE=${{ steps.locked-base.outputs.uv_image }}
```

The CI pull-request build remains `push: false` and records only its local image ID plus local build metadata. The first trusted `main` push builds/pushes once, records the returned RepoDigest, and publishes provenance for it; a rerun is reuse-only as locked above. `backend-release.yml` has no lock-reading build step and no Dockerfile context because it downloads and validates the trusted CI subject. Static tests enumerate every Docker build action and delegation path across all tracked workflows/composite actions/scripts, require exactly one non-matrix owner in CI and zero elsewhere, and reject any shell-level `docker build`/`buildx build` fallback. After push, a read-only container probe locates the installed packaged extension, streams and hashes its exact bytes, and obtains the stock SQLite `sqlite3_source_id`/`sqlite3_libversion` plus extension build ID through the packaged bootstrap API. `pxii-vfs-runtime-extension.json` binds those values to the image RepoDigest and manifest-selected Linux wheel; installed extension hash/size/build ID/SQLite IDs must equal the independently unpacked manifest row.

- [ ] **Step 5: Consume the one trusted CI digest/provenance, then inventory, scan, and sign it**

Implement the exact-SHA selector as a tested `supply_chain.py consume-ci` command, but do not place it in an event-triggered workflow yet. It bounded-polls at most 40 attempts at 15 seconds each and follows Actions-run pagination to exhaustion before filtering. A unique matching `queued` or `in_progress` run waits; a unique `completed/success` run proceeds; every other conclusion, timeout, zero terminal candidates, or multiple eligible identities fails. It binds event `push`, `refs/heads/main`, full SHA, workflow path/ID, originating `run_attempt == 1`, `trust_level="trusted_push"`, one non-expired subject artifact, RepoDigest, provenance, hashes/sizes, and run identity. Task 8 invokes this unchanged command from the final main-only `publish` job; there is no newest/first tie-break.

The same Task owns a separate `supply_chain.py verify-release-eligibility` command before any activation commit. It accepts repository, full subject SHA, current workflow/run/attempt/job identity, predecessor receipt roots, and output path; token comes only from environment. It independently bounded-polls and fully paginates Checks, Actions runs, jobs, and artifacts; correlates exact App/workflow/event/ref/run/attempt/artifact ID/name/hash; excludes only the current `release` check by exact identity; validates `publish`/`drills` conclusions and the four `S5_INPUT_PRODUCERS`; treats the publish selector receipt only as a cross-check hint; and writes one closed eligibility receipt. It has no signing/build/deploy capability. Eligibility additionally requires the stable native artifact from the exact originating CI run, revalidates both platform rows, and proves `pxii-vfs-runtime-extension.json` matches the selected Linux wheel and consumed image. `derive-s5-history --repo-root ROOT --subject-sha SHA --output FILE` and `verify-s5-history` are offline modes in this same committed tool. They enumerate the target's Git objects, require exactly one non-merge activation candidate with the exact subject/diff, derive the producer identity from that commit's first parent, verify the producer commit subject/diff, both ancestry relations, and every closed producer path by reading and SHA-256 hashing `ACTIVATION_PARENT:path`; neither mode accepts producer/activation SHA arguments or `S5_PRODUCER_COMMIT`/`S5_ACTIVATION_COMMIT` environment variables. Task 8's activation workflow invokes these unchanged named commands rather than embedding selection logic in YAML.

Every later command uses `IMAGE@${DIGEST}` only. Generate downloadable SPDX and CycloneDX SBOM files with a lock-pinned Syft action/tool, scan with a lock-pinned Trivy action/tool using `--severity HIGH,CRITICAL --exit-code 1`, sign keylessly with lock-pinned Cosign under GitHub OIDC, verify issuer/identity, and verify the CI-produced BuildKit/GitHub provenance for the same digest. Release may add signature/attestation material but must not create replacement build provenance or rebuild/push the image.

```yaml
- name: Download the exact trusted CI subject
  uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093
  with:
    name: backend-ci-${{ github.sha }}
    run-id: ${{ steps.trusted-ci.outputs.run_id }}
    path: .release-input/ci
    github-token: ${{ secrets.GITHUB_TOKEN }}

- name: Verify and expose the immutable subject
  id: subject
  working-directory: .
  run: >-
    uv run --project backend python backend/scripts/supply_chain.py consume-ci
    --root .release-input/ci --subject-sha "${GITHUB_SHA}"
    --expected-event push --expected-ref refs/heads/main
    --expected-workflow .github/workflows/ci.yml
    --output "$GITHUB_OUTPUT"
```

The lock contains full SHAs/checksums for Syft, Trivy, Cosign installer, artifact upload, artifact download, and provenance action. `supply_chain.py verify` rejects an unlisted tool/action and specifically rejects using the upload pin for `actions/download-artifact`.

- [ ] **Step 6: Normalize and upload closed supply-chain evidence**

Write a canonical producer receipt containing the exact image reference/digest, base digest, SBOM hashes, scan summary, signature bundle hash, certificate issuer/identity, verified CI provenance hash, selected native manifest/wheel identity, installed extension hash/size/build ID, SQLite source/version IDs, commands, runtimes, timestamps, and exit codes. The seven retained record artifacts are named exactly `image-digest.json`, `build-provenance.json`, `sbom.spdx.json`, `sbom.cyclonedx.json`, `trivy.json`, `cosign-bundle.json`, and `pxii-vfs-runtime-extension.json`. Use `backend/scripts/evidence_records.py` and `PRODUCER_CONTRACTS["supply_chain"].artifacts` to generate and verify the closed envelope against offline fixtures. Every record copies ID/modules/findings/tags from its artifact contract and points to one concrete nonempty artifact with independently computed SHA-256/byte size. Only Task 8's final `publish` job may emit and upload these producer records; Task 6 does not claim a live producer envelope, and the final `release` aggregator may validate/index records but cannot rewrite them.

- [ ] **Step 7: Run local static gates without activating release production**

Run locally:

```powershell
.\backend\.venv\Scripts\python.exe -m pytest -q backend/tests/test_supply_chain.py backend/tests/test_pxii_vfs_wheel_evidence.py backend/tests/test_prod_hardening.py -p no:cacheprovider
.\backend\.venv\Scripts\python.exe backend/scripts/supply_chain.py verify --lock backend/supply-chain.lock.json --dockerfile backend/Dockerfile --workflow .github/workflows/ci.yml --workflow .github/workflows/backend-release.yml
```

Expected: PASS offline, including fixture generation/verification of two nonempty SBOMs, zero-HIGH/CRITICAL Trivy JSON, Cosign/provenance equality, both independently verified native wheel rows, Linux selected-wheel/image extension equality, SQLite source/version equality, and a closed seven-record supply-chain envelope. The scaffold exposes only its manual read-only static job and cannot publish, sign, deploy, drill, or report the future required context. Do not run or claim live release evidence until Task 8 activates the complete producer set.

- [ ] **Step 8: Commit immutable supply-chain controls**

```powershell
git -C . add -- backend/supply-chain.lock.json backend/scripts/supply_chain.py backend/tests/test_supply_chain.py backend/Dockerfile .github/workflows/ci.yml .github/workflows/backend-release.yml backend/tests/test_prod_hardening.py
git commit -m "ci: attest immutable backend image"
```

**Review gate:** Reject if builder/runtime bases differ, any action/tool/base is mutable or absent from the lock, artifact upload/download reuse one pin, the same target is built/pushed outside its one trusted main-push CI owner, the scaffold contains a build/producer fallback or production trigger, exact-SHA CI selection is unbounded or first-page-only, CI identity/provenance is ambiguous, scan/sign/SBOM/provenance target different references, evidence records are partial/duplicate, HIGH/CRITICAL findings remain, `latest` appears in a deploy input, or Task 6 claims live release evidence. Also reject a missing/ambiguous stable native artifact, missing Windows verification, Linux platform-selection drift, any project/native rebuild path, or any installed extension/image/wheel/manifest/source/SQLite hash or identity mismatch. Final DAG permissions and live evidence are Task 8 gates.

### Task 7: Prove Legacy Fail-Closed, Fixed N-1 Upgrade, Independent Restore, And Rollback

**Files:**
- Create: `backend/scripts/certification/n_minus_one_drill.py`
- Create: `backend/scripts/certification/verify_drill.py`
- Create: `backend/tests/test_n_minus_one_drill.py`
- Modify: `backend/tests/fixtures/certification/n_minus_one_manifest.json`
- Create: `backend/tests/fixtures/certification/n_minus_one_empty_legacy_manifest.json`
- Modify: `backend/tests/fixtures/certification/populate_n_minus_one.py`
- Modify: `backend/tests/test_n_minus_one_fixture.py`
- Consume unchanged: `backend/app/audit/producer_contracts.py`
- Consume unchanged: `backend/scripts/evidence_records.py`
- Consume unchanged: `backend/audit/95plus/evidence.schema.json`

**Interfaces:**
- Consumes: fixed Git subject `1e4f0fc6d82ce6203f4bada0e84b518b16fcd97f`, immutable legacy-bearing and empty-legacy fixture profiles, `PRODUCER_CONTRACTS["n_minus_one"]`, target scanned image digest, Recovery CLI, Docker Engine, separate data/backup volumes.
- Produces: two immutable fixture contracts plus `n-minus-one-drill.json`, retained negative-lane logs, drill-only N-1 baseline manifest, final-model snapshot manifests, and closed `n-minus-one-evidence.json` proving nonempty legacy fail-closed/data preservation, empty-legacy N-1 startup, target upgrade, fresh restore, and rollback to recorded N-1 digest/data.

- [ ] **Step 1: Write failing fixed-subject, command, and artifact-verifier tests**

```python
def test_drill_refuses_a_moving_n_minus_one_subject(tmp_path):
    result = run_drill(["--n-minus-one", "main", "--dry-run"], cwd=tmp_path)
    assert result.returncode == 2
    assert "N-1 must be exactly 1e4f0fc6d82ce6203f4bada0e84b518b16fcd97f" in result.stderr


def test_valid_drill_requires_all_four_system_stages(valid_drill_artifact):
    verified = verify_drill(valid_drill_artifact, FIXTURE_MANIFEST)
    assert [stage.name for stage in verified.stages] == [
        "n_minus_one_boot", "target_upgrade", "fresh_restore", "n_minus_one_rollback"
    ]
    assert all(stage.exit_code == 0 for stage in verified.stages)
    assert verified.n_minus_one_sha == "1e4f0fc6d82ce6203f4bada0e84b518b16fcd97f"
    assert verified.target_image.startswith("ghcr.io/") and "@sha256:" in verified.target_image
    assert all(stage.runtime.name and stage.runtime.version and stage.runtime.platform for stage in verified.stages)
    assert all(stage.log_path == PurePosixPath(stage.log_path).as_posix() for stage in verified.stages)
    assert all(stage.log_size_bytes > 0 and len(stage.log_sha256) == 64 for stage in verified.stages)
    assert [check.name for check in verified.negative_checks] == [
        "legacy_nonempty_cutover_rejected"
    ]
    assert verified.negative_checks[0].error_code == (
        "breaking_cutover_requires_empty_legacy"
    )
    assert verified.negative_checks[0].before_inventory_sha256 == (
        verified.negative_checks[0].after_inventory_sha256
    )
```

Add negative fixtures for changed manifest hash, wrong Meta/Space head, catalog hash, IndexStore schema version, missing/extra table/FTS/ordinary-index object, missing/extra inventory entry, logical digest, file byte hash/size, entity count, Note hash, or Sync waterline; also reject mutable target/N-1 image tags, missing rollback snapshot, stage order changes, mixed target SHAs, and empty logs. Validate the producer output as the exact S0 contract entry `PRODUCER_CONTRACTS["n_minus_one"].artifacts[0]`; its artifact is `n-minus-one-drill.json`, its independently recomputed hash/size match, its `trust_level` is `release_drill`, and its modules/findings/tags exactly equal the frozen artifact contract. Extra keys or duplicate IDs fail.

- [ ] **Step 2: Run drill unit tests and verify the red state**

Run:

```powershell
.\backend\.venv\Scripts\python.exe -m pytest -q backend/tests/test_n_minus_one_drill.py -p no:cacheprovider
```

Expected: FAIL because the drill and verifier do not exist.

- [ ] **Step 3: Implement injection-safe process execution and fixed source extraction**

```python
N_MINUS_ONE = "1e4f0fc6d82ce6203f4bada0e84b518b16fcd97f"
BACKEND_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_MANIFEST = BACKEND_ROOT / "tests/fixtures/certification/n_minus_one_manifest.json"
EMPTY_LEGACY_FIXTURE_MANIFEST = (
    BACKEND_ROOT
    / "tests/fixtures/certification/n_minus_one_empty_legacy_manifest.json"
)
FIXTURE_POPULATOR = BACKEND_ROOT / "tests/fixtures/certification/populate_n_minus_one.py"

def run_checked(
    argv: Sequence[str], *, cwd_root: Literal["repo", "artifact"],
    cwd_relative: PurePosixPath, repo_root: Path, artifact_root: Path, log: Path
) -> CompletedStage:
    selected_root = repo_root if cwd_root == "repo" else artifact_root
    cwd = resolve_contained_directory(selected_root, cwd_relative)
    started = utc_now_iso()
    completed = subprocess.run(
        list(argv), cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT
    )
    log.write_text(completed.stdout, encoding="utf-8")
    log_relative = log.resolve(strict=True).relative_to(artifact_root.resolve(strict=True)).as_posix()
    return CompletedStage(
        argv=tuple(argv),
        cwd_root=cwd_root,
        cwd_relative=cwd.resolve(strict=True).relative_to(selected_root.resolve(strict=True)).as_posix() or ".",
        runtime=runtime_identity(),
        started_at=started,
        finished_at=utc_now_iso(),
        exit_code=completed.returncode,
        log_path=log_relative,
        log_sha256=sha256_file(log),
        log_size_bytes=log.stat().st_size,
    )
```

Never concatenate an image/path into `shell=True`. Resolve `git rev-parse 1e4f0fc6d82ce6203f4bada0e84b518b16fcd97f^{commit}` and require exact equality with `N_MINUS_ONE`; prefix matching is forbidden. Invoke `run_checked(("git", "archive", "--format=tar", f"--output={run_root / 'n-minus-one.tar'}", N_MINUS_ONE, "backend"), cwd_root="repo", cwd_relative=PurePosixPath("."), repo_root=repo_root, artifact_root=run_root, log=run_root / "logs/git-archive.log")`. Open that archive with `tarfile.open(run_root / "n-minus-one.tar", mode="r")` and call `bundle.extractall(run_root, filter="data")`; build only the extracted `backend/` directory. Each `CompletedStage` records `cwd_root` as exactly `repo` or `artifact` plus a contained POSIX `cwd_relative`; `run_checked` resolves against that declared root before execution and rejects outside/symlink/ambiguous containment. Tests prove external `run_root/backend` records as `{cwd_root: "artifact", cwd_relative: "backend"}` and that a repository `relative_to` operation is never applied to artifact-root commands. Every stage uses the same explicit `artifact_root`, stores a POSIX path strictly beneath it, and is independently rehashed and resized by `verify_drill.py`; absolute/drive/parent/backslash paths and symlink escapes fail.

- [ ] **Step 4: Populate and verify both fixed fixture profiles before upgrade**

Populate only through the exact archived N-1 source and a frozen runtime synchronized from its archived lock; the S0 seeder itself is read-only and hash-pinned by the fixture manifest:

```powershell
$runRoot = Join-Path ([IO.Path]::GetTempPath()) ('pomodoroxii-drill-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $runRoot | Out-Null
$n1Backend = Join-Path $runRoot 'backend'
$n1PythonRoot = Join-Path $runRoot 'n-minus-one-runtime'
$seeder = (Resolve-Path 'backend/tests/fixtures/certification/populate_n_minus_one.py').Path
$manifest = (Resolve-Path 'backend/tests/fixtures/certification/n_minus_one_manifest.json').Path
$env:UV_PROJECT_ENVIRONMENT = $n1PythonRoot
uv sync --project $n1Backend --frozen --offline
$n1Python = Join-Path $n1PythonRoot 'Scripts/python.exe'
& $n1Python -I -c 'import runpy,sys; root,script,*args=sys.argv[1:]; sys.path.insert(0,root); sys.argv=[script,*args]; runpy.run_path(script,run_name="__main__")' $n1Backend $seeder --profile legacy-bearing --data-root (Join-Path $runRoot 'legacy-bearing-data') --manifest $manifest
& $n1Python -I -c 'import runpy,sys; root,script,*args=sys.argv[1:]; sys.path.insert(0,root); sys.argv=[script,*args]; runpy.run_path(script,run_name="__main__")' $n1Backend $seeder --profile empty-legacy --data-root (Join-Path $runRoot 'empty-legacy-data') --manifest (Resolve-Path 'backend/tests/fixtures/certification/n_minus_one_empty_legacy_manifest.json').Path
```

Before the drill implementation, strengthen the original fixture manifest once without changing its `seed`, timestamp, IDs, bodies, Task row, other rows, or waterline. Its profile is exactly `legacy-bearing` and its `entity_counts.tasks` remains `1`. Add a second closed manifest with profile `empty-legacy`, its own seed/hash/inventory, and exact legacy Task/Session counts `0`; both pin the same archived N-1 commit/runtime and exact S0 seeder SHA-256. Each closed `expected` object contains literal `meta_head="meta_001"`, `space_head="space_008_sync_retention_snapshot"`, the full lowercase catalog hash computed from the fixed Git object, `index_schema_version=1`, and a literal sorted `index_objects` array of every `(type,name,tbl_name,normalized_sql_sha256)` row from `sqlite_master` excluding only SQLite's documented volatile internal sequence row. Each contains a sorted inventory for `meta.db`, registered `space.db`, `index.db`, and its Markdown files. Tests populate both profiles twice, prove stable logical hashes and exact profile differences, and prove the original legacy-bearing manifest/rows were not edited to make the positive lane pass. `test_n_minus_one_baseline_rejects_target_worktree_migration_import` deliberately makes a target-worktree migration/import path visible and requires fixture bootstrap to fail before either profile is written.

The orchestrator supplies the actual run-root path as a process argument. It records both fixture files' SHA-256 before execution and rejects any dirty diff afterward. The seeder Python executable, `sys.path`, application imports, Alembic configuration, and migration script locations must resolve exclusively beneath the archived N-1 runtime/source; any target-worktree import or migration lookup fails. Before any target image is mounted or executed, retained receipts prove both profiles at `meta_001`/`space_008_sync_retention_snapshot`. Build N-1 once from the archive, inspect its local immutable image ID, and boot/verify each profile as UID/GID 1000 against its own manifest.

Run the target image against the stopped legacy-bearing volume and require startup/migration to fail specifically with `breaking_cutover_requires_empty_legacy` before DDL. Rehash the complete raw/logical inventory and require exact before/after equality; do not call the final-model Recovery CLI because its manifest intentionally rejects legacy keys/heads. Record this separately as negative check `legacy_nonempty_cutover_rejected`. Then boot the empty-legacy profile with N-1 and record successful stage `n_minus_one_boot`.

- [ ] **Step 5: Take a drill-only N-1 baseline, upgrade empty legacy, and create the final snapshot**

Stop N-1. While the empty-legacy volume is offline, create a drill-only
`n_minus_one_baseline` with the archived N-1 runtime's SQLite Online Backup API
plus contained regular-file copies. Its separate closed schema records old
heads/catalog/index objects/inventory and raw hashes and is never accepted by
production `SnapshotManifest` or `RecoveryCoordinator.verify`. It performs no
migration or write to the source volume.

Start only the scanned target digest on the same empty-legacy data and let TS0's
breaking migration run. Wait for readiness and verify final Meta/Space heads,
31-entry catalog, target IndexStore objects, zero legacy rows/keys, coordination
clean-or-recoverable, and EffortProjection verified. Now use the target Recovery
CLI to create/verify the production final-model snapshot on a separate backup
volume. Record both distinct manifest types/hashes, the pre-upgrade N-1 image
ID, target digest, full post-upgrade inventory, migration logs, and stage
`target_upgrade`. No verifier may accept one manifest profile as the other.

- [ ] **Step 6: Restore into a fresh data volume and roll back to N-1**

For `fresh_restore`, mount the final-model production backup volume read-only, use target Recovery CLI to restore-to-staging/cutover into a newly created empty data volume, start target digest, and verify the complete restored inventory with byte hashes/sizes plus logical hashes, target heads/catalog/IndexStore objects, counts, Note hashes, Sync waterline, active coordination, and EffortProjection.

For `n_minus_one_rollback`, stop target, preserve its post-upgrade final-model snapshot, restore the drill-only `n_minus_one_baseline` into a newly empty rollback data volume with the drill-only offline restorer, start the recorded N-1 image ID (not a rebuilt/mutable tag), and verify every frozen empty-legacy N-1 head/catalog/IndexStore/logical-inventory field again while recording fresh byte hashes/sizes. The production Recovery CLI must reject the old-profile manifest if accidentally supplied. No stage reuses an earlier running container.

- [ ] **Step 7: Emit one canonical drill artifact and its closed evidence envelope**

```python
artifact = {
    "schema_version": 1,
    "subject_sha": target_sha,
    "n_minus_one_sha": n_minus_one_sha,
    "fixture_manifest_sha256": sha256_file(FIXTURE_MANIFEST),
    "n_minus_one_image": inspected_n_minus_one_digest,
    "target_image": target_image_at_digest,
    "baseline_snapshot_sha256": baseline_snapshot_sha256,
    "fixture_contract": {
        "meta_head": fixture.meta_head,
        "space_head": fixture.space_head,
        "catalog_hash": fixture.catalog_hash,
        "index_schema_version": fixture.index_schema_version,
        "index_objects": fixture.index_objects,
        "inventory": fixture.inventory,
    },
    "stages": [stage.to_json() for stage in completed_stages],
    "stage_inventories": {stage.name: stage.inventory.to_json() for stage in completed_stages},
}
```

Every variable above comes from a verified command receipt, not caller prose. Each stage inventory is closed and sorted; it carries every required relative path/role, raw file SHA-256/size, canonical logical digest, schema heads, catalog hash, IndexStore schema/object rows, entity counts, Note hashes, and Sync waterline. `verify_drill.py` validates all four stage inventories, stage order, argv, backend-relative cwd, runtime, ordered timestamps, exits, contained POSIX logs, subject consistency, and fixture equality. It independently rehashes/re-sizes every file/log and recomputes logical/database/object digests; a caller-supplied digest or size is never trusted.

After `verify_drill.py` passes, the orchestrator reads the complete `ProducerArtifactContract` from `PRODUCER_CONTRACTS["n_minus_one"]` and calls the shared S0 writer with its ID/modules/findings/tags, exact target SHA, verified target image digest inside the hashed drill artifact, exact command/runtime/timestamps/exit, and independently computed artifact SHA-256/byte size. It atomically emits `n-minus-one-evidence.json`; `verify_drill.py --evidence` validates the closed envelope and refuses a partial/ad hoc drill receipt or local filename/ID/semantic table.

- [ ] **Step 8: Freeze the N-1 workflow argv and artifact contract for Task 8**

Lock the following backend-root-relative argv in `test_n_minus_one_drill.py` as `EXPECTED_RELEASE_ARGV`; use it in fixture execution and require each referenced file to exist now. Task 7 does not modify or activate `backend-release.yml`, does not mention the future fresh script, and does not emit a live release envelope. Task 8 copies this exact argv into the final read-only `drills` job after it owns both drill implementations:

```bash
set -euo pipefail
uv run python scripts/certification/n_minus_one_drill.py \
  --n-minus-one 1e4f0fc6d82ce6203f4bada0e84b518b16fcd97f \
  --target-image "${IMAGE}@${DIGEST}" \
  --fixture-manifest tests/fixtures/certification/n_minus_one_manifest.json \
  --empty-legacy-fixture-manifest tests/fixtures/certification/n_minus_one_empty_legacy_manifest.json \
  --fixture-populator tests/fixtures/certification/populate_n_minus_one.py \
  --run-root "${RUNNER_TEMP}/pomodoroxii-drill/${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}" \
  --output .test-results/n-minus-one-drill.json \
  --evidence-output .test-results/n-minus-one-evidence.json
uv run python scripts/certification/verify_drill.py \
  --artifact .test-results/n-minus-one-drill.json \
  --evidence .test-results/n-minus-one-evidence.json \
  --evidence-schema audit/95plus/evidence.schema.json \
  --fixture tests/fixtures/certification/n_minus_one_manifest.json \
  --empty-legacy-fixture tests/fixtures/certification/n_minus_one_empty_legacy_manifest.json \
  --subject-sha "${GITHUB_SHA}"
```

Expected: both commands exit 0 in the isolated Linux fixture; the retained drill JSON, closed S0 envelope, four stage logs, complete stage inventories, baseline/target snapshot manifests/hashes, image evidence, and verification summary all reverify. No workflow file or live GitHub state changes in this Task.

- [ ] **Step 9: Commit the fixed N-1 system drill**

```powershell
git -C . add -- backend/scripts/certification/n_minus_one_drill.py backend/scripts/certification/verify_drill.py backend/tests/test_n_minus_one_drill.py backend/tests/fixtures/certification/n_minus_one_manifest.json backend/tests/fixtures/certification/n_minus_one_empty_legacy_manifest.json backend/tests/fixtures/certification/populate_n_minus_one.py backend/tests/test_n_minus_one_fixture.py
git commit -m "test(delivery): prove n-minus-one recovery and rollback"
```

**Review gate:** Reject if N-1 is a branch/tag/newer commit, seeded fixture data changes, the strengthened fixture bytes drift after their Task 7 commit, Meta/Space/catalog/IndexStore/inventory coverage is partial, the target image is rebuilt instead of consuming the trusted CI digest, rollback rebuilds instead of using its recorded digest/ID, backup shares active data, restore reuses live data, any stage field drifts, the S0 record is partial/duplicate, a stage lacks exact command/runtime/timestamp/exit/file/log hashes/sizes, or Task 7 activates/modifies the release workflow.

### Task 8: Make Digest Deployment, Non-Root Storage, Upgrade, Recovery, And Rollback Executable

**Files:**
- Create: `backend/scripts/prepare_bind_mount.sh`
- Create: `backend/scripts/deploy_digest.sh`
- Create: `backend/scripts/smoke_digest.sh`
- Create: `backend/scripts/certification/fresh_deploy_drill.sh`
- Create: `backend/scripts/certification/verify_fresh_deploy.py`
- Modify: `.github/workflows/backend-release.yml`
- Modify: `backend/docker-compose.yml`
- Modify: `backend/DEPLOY.md`
- Create: `backend/docs/runbooks/recovery.md`
- Create: `backend/docs/runbooks/relocation.md`
- Create: `backend/docs/runbooks/rollback.md`
- Create: `backend/docs/runbooks/incident.md`
- Create: `backend/tests/test_delivery_runbooks.py`
- Create: `backend/tests/test_release_workflow_contract.py`
- Modify: `backend/tests/test_prod_hardening.py`
- Consume unchanged: `backend/app/audit/producer_contracts.py`
- Consume unchanged: `backend/scripts/evidence_records.py`
- Consume unchanged: `backend/scripts/supply_chain.py`
- Consume unchanged: `backend/supply-chain.lock.json`
- Consume unchanged: `backend/scripts/certification/n_minus_one_drill.py`
- Consume unchanged: `backend/scripts/certification/verify_drill.py`
- Consume unchanged: `backend/tests/fixtures/certification/n_minus_one_manifest.json`
- Consume unchanged: `backend/tests/fixtures/certification/n_minus_one_empty_legacy_manifest.json`
- Consume unchanged: `backend/tests/fixtures/certification/populate_n_minus_one.py`
- Consume unchanged: `backend/audit/95plus/evidence.schema.json`
- Consume unchanged: `backend/audit/95plus/pxii-vfs-wheel-manifest.schema.json`
- Consume unchanged: `backend/scripts/ci/verify_pxii_vfs_wheels.py`
- Consume unchanged: `.github/workflows/pxii-vfs-wheels.yml`

**Interfaces:**
- Consumes: immutable target/previous digests; Task 6's committed `supply_chain.py`, exact `fresh_volume_probe`/`fresh_volume_init` entries from `supply-chain.lock.json`, and verified native manifest/wheel/runtime-extension chain; Task 7's committed N-1 drill/verifier/fixture; the complete frozen producer authority and its exact S5 subset; non-root UID/GID 1000; Recovery/credentials CLI; operations token; readiness/metrics/SLOs; and S5 system evidence.
- Produces: one producer commit with executable fresh deploy/upgrade/relocation/restore/rollback/incident commands and canonical `fresh-deploy-drill.json`/closed `fresh-deploy-evidence.json`; then one isolated descendant activation commit with the final release workflow/contract tests, independent aggregator eligibility verification, canonical `s5-history.json`, a closed `release-evidence.json` containing independent `EV-RELEASE-BUNDLE` and `EV-S5-HISTORY` records, and the final S5 gate.

- [ ] **Step 1: Write failing compose/script/runbook contract tests**

Keep compose/script/runbook tests in `test_delivery_runbooks.py` and place every final workflow trigger, permission, condition, pagination, activation-ancestry, and aggregator test in the separately owned `test_release_workflow_contract.py`; that file enters only the later activation commit.

```python
def test_compose_requires_digest_and_non_root_mounts() -> None:
    compose = yaml.safe_load((ROOT / "backend/docker-compose.yml").read_text())
    backend = compose["services"]["backend"]
    assert backend["image"] == "${POMODOROXII_IMAGE:?set an immutable image@sha256 digest}"
    assert backend["user"] == "1000:1000"
    assert backend["security_opt"] == ["no-new-privileges:true"]
    assert "ALL" in backend["cap_drop"]
    assert any("/backups" in volume and ":rw" in volume for volume in backend["volumes"])


def test_deploy_script_rejects_mutable_image() -> None:
    result = run_script("scripts/deploy_digest.sh", "ghcr.io/example/backend:latest")
    assert result.returncode != 0
    assert "image@sha256 digest is required" in result.stderr


def test_fresh_drill_requires_a_new_empty_volume(valid_fresh_receipt) -> None:
    verified = verify_fresh_deploy(valid_fresh_receipt)
    assert verified.volume.preexisting_lookup_exit == 1
    assert verified.volume.preexisting_error_kind == "docker_volume_not_found"
    assert verified.volume.preexisting_error_name == verified.volume.name
    assert verified.cleanup_trap_installed_immediately is True
    assert verified.empty_root.entry_count == 0
    assert verified.empty_root.checked_before_deploy is True
    assert verified.receipts == ("probe", "prepare", "mount", "deploy", "smoke", "cleanup")


def test_release_index_inputs_exclude_aggregator_outputs() -> None:
    from app.audit.producer_contracts import PRODUCER_CONTRACTS, S5_INPUT_PRODUCERS

    assert S5_INPUT_PRODUCERS == ("ci", "supply_chain", "n_minus_one", "fresh_deploy")
    assert "release" not in S5_INPUT_PRODUCERS
    input_envelopes = {PRODUCER_CONTRACTS[name].envelope_path for name in S5_INPUT_PRODUCERS}
    input_artifacts = {
        path
        for name in S5_INPUT_PRODUCERS
        for path, _ in PRODUCER_CONTRACTS[name].evidence_by_artifact
    }
    assert PRODUCER_CONTRACTS["release"].envelope_path not in input_envelopes
    assert "release-artifact-index.json" not in input_artifacts
    assert PRODUCER_CONTRACTS["ci"].evidence_ids[-1] == "EV-CI-PXII-VFS-WHEEL-MANIFEST"
    assert PRODUCER_CONTRACTS["supply_chain"].evidence_ids[-1] == "EV-SUPPLY-PXII-VFS-RUNTIME"
    assert PRODUCER_CONTRACTS["ci"].supplemental_artifact_name_templates == (
        "pxii-vfs-wheel-manifest-v1",
    )
    assert PRODUCER_CONTRACTS["release"].evidence_by_artifact == (
        ("release-artifact-index.json", "EV-RELEASE-BUNDLE"),
        ("s5-history.json", "EV-S5-HISTORY"),
    )


def test_s5_history_is_closed_and_tree_derived(valid_s5_history) -> None:
    verified = verify_s5_history(valid_s5_history.repo, valid_s5_history.path)
    assert verified.subject_sha == valid_s5_history.target_sha
    assert verified.activation_parent == verified.producer_commit
    assert verified.activation_paths == (
        ".github/workflows/backend-release.yml",
        "backend/tests/test_release_workflow_contract.py",
    )
    assert verified.producer_paths == COMPLETE_S5_PRODUCER_PATHS


def test_final_release_context_has_disjoint_pr_and_push_paths() -> None:
    workflow = load_workflow(ROOT / ".github/workflows/backend-release.yml")
    assert set(workflow["on"]) == {"pull_request", "push"}
    assert workflow["on"]["pull_request"]["branches"] == ["main"]
    assert workflow["on"]["push"]["branches"] == ["main"]
    assert "paths" not in workflow["on"]["pull_request"]
    assert "paths-ignore" not in workflow["on"]["pull_request"]
    assert "paths" not in workflow["on"]["push"]
    assert "paths-ignore" not in workflow["on"]["push"]
    assert workflow["permissions"] == {"contents": "read"}
    assert workflow["jobs"]["publish"]["permissions"] == {
        "contents": "read", "actions": "read", "packages": "write",
        "id-token": "write", "attestations": "write",
    }
    assert workflow["jobs"]["drills"]["permissions"] == {
        "contents": "read", "actions": "read", "packages": "read",
    }
    assert workflow["jobs"]["drills"]["needs"] == ["publish"]
    release = workflow["jobs"]["release"]
    assert release["needs"] == ["publish", "drills"]
    assert release["if"] == "${{ always() }}"
    assert release["permissions"] == {
        "contents": "read", "actions": "read", "checks": "read"
    }
    conditions = {step["name"]: step.get("if") for step in release["steps"]}
    assert conditions["PR static policy"] == (
        "${{ github.event_name == 'pull_request' && needs.publish.result == 'skipped' "
        "&& needs.drills.result == 'skipped' }}"
    )
    assert conditions["Aggregate trusted push"] == (
        "${{ github.event_name == 'push' && needs.publish.result == 'success' "
        "&& needs.drills.result == 'success' }}"
    )
    assert conditions["Reject failed trusted push"] == (
        "${{ github.event_name == 'push' && (needs.publish.result != 'success' "
        "|| needs.drills.result != 'success') }}"
    )
    assert conditions["Reject invalid PR predecessors"] == (
        "${{ github.event_name == 'pull_request' && (needs.publish.result != 'skipped' "
        "|| needs.drills.result != 'skipped') }}"
    )
    assert conditions["Reject unexpected event"] == (
        "${{ github.event_name != 'pull_request' && github.event_name != 'push' }}"
    )
    assert docker_build_steps(workflow) == []
```

Add tests that every runbook command names real CLI flags/files, upgrade starts with verified snapshot, rollback uses previous digest plus preserved snapshot, relocation uses its explicit CLI, metrics use operations token, and no online `tar` backup or `latest` deploy remains. Add fresh-deploy receipt fixtures that reject a tag, mixed subject/digest, non-1000 UID/GID, failed readiness/metrics/Space/mutation/ledger/ACK checks, nonzero exit, missing command/runtime/POSIX artifact/log path/hash/size, extra key, or stage other than `fresh_volume_deploy`. Also reject a pre-existing/reused volume, generic nonzero inspect failure, daemon/permission/transport failure, not-found text naming another volume, a cleanup trap installed after any post-create command, missing/changed volume identity, an empty-root check after deploy, nonzero pre-deploy entry count, missing raw stdout/stderr for any of the three volume proofs, absent probe/prepare/mount/deploy/smoke/cleanup receipts, cleanup of the wrong volume, post-cleanup errors other than exact not-found, a probe/create argv without the exact volume name, a raw inspect mount that does not bind that name/source to `/app/data`, a mutable probe/init image, direct host `find /app/data`, or a missing/partial `EV-FRESH-VOLUME-DEPLOY` record. Add negative workflow fixtures for non-main push/PR triggers, PR producer execution, PR predecessor success, push aggregation with a skipped/failed predecessor, missing `if: always()`, missing `checks: read`, a missing invalid-PR or unexpected-event rejection, publish-only eligibility, a page-2 Checks/runs/jobs/artifacts duplicate, current-check identity mismatch, or any overlap among static, aggregate, failed-push, invalid-PR, and unexpected-event conditions. Native fixtures additionally reject a missing/duplicate stable artifact, a run/subject mismatch, either platform omission, any manifest/wheel/extension/test/build/SQLite drift, an installed Linux extension mismatch, platform substitution, and every source-build fallback. Add explicit negative index fixtures that place `release`, `release-evidence.json`, `release-artifact-index.json`, `s5-history.json`, or any `wave == "S6"` entry in the pre-aggregation input set and require failure. History fixtures reject a missing/extra producer path, blob-hash drift, a noncanonical/extra key, caller/env identities, zero/duplicate activation candidates, changed activation or producer diff, merge activation, squash, and either failed ancestry relation. Validate `EV-RELEASE-BUNDLE` only after its canonical index exists, validate `EV-S5-HISTORY` independently over `s5-history.json`, and reject duplicate IDs across all envelopes.

- [ ] **Step 2: Run delivery/runbook tests and verify the red state**

Run:

```powershell
.\backend\.venv\Scripts\python.exe -m pytest -q backend/tests/test_delivery_runbooks.py backend/tests/test_prod_hardening.py -p no:cacheprovider
```

Expected: FAIL because Compose uses `latest`, bind preparation/deploy/smoke scripts do not exist, and current DEPLOY uses online `tar`/mutable upgrade.

- [ ] **Step 3: Require a digest and harden the non-root runtime contract**

```yaml
services:
  backend:
    image: ${POMODOROXII_IMAGE:?set an immutable image@sha256 digest}
    user: "1000:1000"
    read_only: true
    tmpfs:
      - /tmp:rw,nosuid,nodev,noexec,size=64m
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    volumes:
      - ${POMODOROXII_DATA_DIR:?set data dir}:/app/data:rw
      - ${POMODOROXII_BACKUP_DIR:?set backup dir}:/backups:rw
```

`prepare_bind_mount.sh` resolves absolute data/backup paths, rejects equality/containment between them, creates them with owner/group 1000 and mode 0750, performs a disposable UID-1000 write/fsync/remove probe in each, and prints a nonsecret JSON receipt. It never recursively `chown`s an unspecified/existing parent and is bind-mount-only: it cannot certify or prepare a named Docker volume. The certification fresh-deploy path instead uses the separately retained digest-pinned probe/init-container flow below and cannot certify an existing bind directory or volume.

- [ ] **Step 4: Implement digest deploy, fresh-volume orchestration, and smoke scripts**

`deploy_digest.sh ghcr.io/example/pomodoroxii-backend@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb` validates the concrete argument with `^.+@sha256:[0-9a-f]{64}$`, verifies the Cosign signature/provenance and zero-finding scan evidence, records the currently running digest, creates/verifies a full snapshot, stops the service, pulls exactly the target digest, runs the image's migration/startup check against the mounted data under one process-owner lease, starts Compose, and invokes `smoke_digest.sh`. On failure it prints the exact rollback command and leaves the snapshot/previous digest untouched.

`smoke_digest.sh` requires `--subject-sha`, `--image`, `--output`, and `--log-dir`. It asserts container digest, non-root UID/GID, `/api/health`, `/api/ready`, operations-authenticated `/api/metrics`, one healthy Space open/read, and one create/update/delete mutation whose ledger event is visible and ACKable. It uses a disposable certification Space and removes it through supported API/CLI, not raw file deletion. Every probe writes a command receipt and log before returning its smoke receipt to the orchestrator.

`fresh_deploy_drill.sh` accepts only the trusted-CI `IMAGE@DIGEST`, subject SHA, run ID/attempt, output directory, and explicit operations secret through an environment variable. It derives `pomodoroxii-fresh-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}` and captures stdout/stderr separately from every proof command. Absence is proven only when Docker exits `1` and normalized stderr is exactly the daemon's `no such volume` response naming that complete derived volume; daemon unavailable, permission denied, timeout, malformed output, another name, or any other nonzero result fails without cleanup. It never removes/empties a name that already exists. Immediately after `docker volume create` returns the expected labeled name, and before inspect/mount/find or any other fallible command, it sets the created flag and installs an `EXIT INT TERM` cleanup trap scoped to that exact name. The trap always attempts probe/init/service container removal, volume removal, and an exact post-remove not-found proof while preserving the primary exit code; normal completion invokes the same idempotent cleanup path once.

The empty-root proof executes only through a named probe container created with a digest-pinned helper image and a complete retained `--mount type=volume,src=$VOLUME_NAME,dst=/app/data,readonly` argv. Before the probe starts, raw `docker inspect` bytes must prove the exact created volume name/source, destination `/app/data`, read-only mode, image digest, and the literal `find /app/data -mindepth 1 -print -quit` command. Starting that exact inspected container must exit 0 with empty stdout. After the empty proof and before target deployment, a distinct digest-pinned init container mounts the same named volume read-write and prepares UID/GID 1000; its create/inspect/start outputs form the `prepare` receipt. `prepare_bind_mount.sh` is never invoked for this named-volume proof. Pre-create inspect, probe create/inspect/start, init prepare, target mount, and post-remove inspect each retain exact argv/cwd/runtime/timestamps/exit plus contained raw stdout/stderr path/hash/size; zero-byte stdout is valid only where the contract explicitly expects it, while not-found stderr must be nonempty. The script records the complete normalized volume identity and separate probe, prepare, mount, deploy, and smoke receipts. Only after trap-backed cleanup and verifier success does it atomically emit this closed canonical drill receipt:

```json
{
  "schema_version": 1,
  "subject_sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "image": "ghcr.io/example/pomodoroxii-backend@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "stage": "fresh_volume_deploy",
  "run": {"id": "123456", "attempt": 1},
  "volume": {
    "name": "pomodoroxii-fresh-123456-1",
    "driver": "local",
    "created_at": "2026-07-14T00:00:01Z",
    "labels": {"pomodoroxii.certification.run": "123456-1"},
    "inspect_sha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    "preexisting_lookup": {
      "command": ["docker", "volume", "inspect", "pomodoroxii-fresh-123456-1"],
      "cwd": "backend",
      "runtime": {"name": "docker", "version": "27.0.0", "platform": "linux-x86_64"},
      "started_at": "2026-07-14T00:00:00Z",
      "finished_at": "2026-07-14T00:00:00Z",
      "exit_code": 1,
      "checked_at": "2026-07-14T00:00:00Z",
      "error_kind": "docker_volume_not_found",
      "error_name": "pomodoroxii-fresh-123456-1",
      "stdout_path": "logs/preexisting-inspect.stdout",
      "stdout_sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "stdout_size_bytes": 0,
      "stderr_path": "logs/preexisting-inspect.stderr",
      "stderr_sha256": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      "stderr_size_bytes": 96
    }
  },
  "cleanup_trap_installed_immediately": true,
  "empty_root_proof": {
    "probe_container": "pomodoroxii-fresh-123456-1-probe",
    "probe_image": "docker.io/library/busybox@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "create_command": ["docker", "create", "--name", "pomodoroxii-fresh-123456-1-probe", "--mount", "type=volume,src=pomodoroxii-fresh-123456-1,dst=/app/data,readonly", "docker.io/library/busybox@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", "find", "/app/data", "-mindepth", "1", "-print", "-quit"],
    "inspect_command": ["docker", "inspect", "pomodoroxii-fresh-123456-1-probe"],
    "inspect_stdout_path": "logs/empty-root-inspect.stdout",
    "inspect_stdout_sha256": "7777777777777777777777777777777777777777777777777777777777777777",
    "inspect_stdout_size_bytes": 512,
    "start_command": ["docker", "start", "--attach", "pomodoroxii-fresh-123456-1-probe"],
    "mount": {"name": "pomodoroxii-fresh-123456-1", "source": "pomodoroxii-fresh-123456-1", "destination": "/app/data", "read_only": true},
    "find_argv": ["find", "/app/data", "-mindepth", "1", "-print", "-quit"],
    "cwd": "backend",
    "runtime": {"name": "docker", "version": "27.0.0", "platform": "linux-x86_64"},
    "checked_before_deploy": true,
    "started_at": "2026-07-14T00:00:02Z",
    "finished_at": "2026-07-14T00:00:02Z",
    "checked_at": "2026-07-14T00:00:02Z",
    "exit_code": 0,
    "entry_count": 0,
    "stdout_path": "logs/empty-root.stdout",
    "stdout_sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "stdout_size_bytes": 0,
    "stderr_path": "logs/empty-root.stderr",
    "stderr_sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "stderr_size_bytes": 0
  },
  "uid": 1000,
  "gid": 1000,
  "receipts": {
    "probe": {"command": ["docker", "start", "--attach", "pomodoroxii-fresh-123456-1-probe"], "cwd": "backend", "runtime": {"name": "docker", "version": "27.0.0", "platform": "linux-x86_64"}, "started_at": "2026-07-14T00:00:02Z", "finished_at": "2026-07-14T00:00:03Z", "exit_code": 0, "artifact_path": "receipts/probe.json", "artifact_sha256": "1111111111111111111111111111111111111111111111111111111111111111", "artifact_size_bytes": 256, "log_path": "logs/probe.log", "log_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "log_size_bytes": 64},
    "prepare": {"command": ["docker", "create", "--name", "pomodoroxii-fresh-123456-1-init", "--mount", "type=volume,src=pomodoroxii-fresh-123456-1,dst=/app/data", "docker.io/library/alpine@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", "chown", "1000:1000", "/app/data"], "cwd": "backend", "runtime": {"name": "docker", "version": "27.0.0", "platform": "linux-x86_64"}, "started_at": "2026-07-14T00:00:03Z", "finished_at": "2026-07-14T00:00:04Z", "exit_code": 0, "artifact_path": "receipts/prepare.json", "artifact_sha256": "2222222222222222222222222222222222222222222222222222222222222222", "artifact_size_bytes": 256, "log_path": "logs/prepare.log", "log_sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "log_size_bytes": 64},
    "mount": {"command": ["docker", "create", "--name", "pomodoroxii-fresh-123456-1-backend", "--user", "1000:1000", "--mount", "type=volume,src=pomodoroxii-fresh-123456-1,dst=/app/data", "ghcr.io/example/pomodoroxii-backend@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"], "cwd": "backend", "runtime": {"name": "docker", "version": "27.0.0", "platform": "linux-x86_64"}, "started_at": "2026-07-14T00:00:04Z", "finished_at": "2026-07-14T00:00:05Z", "exit_code": 0, "artifact_path": "receipts/mount.json", "artifact_sha256": "3333333333333333333333333333333333333333333333333333333333333333", "artifact_size_bytes": 256, "log_path": "logs/mount.log", "log_sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", "log_size_bytes": 64},
    "deploy": {"command": ["scripts/deploy_digest.sh"], "cwd": "backend", "runtime": {"name": "bash", "version": "5.2.0", "platform": "linux-x86_64"}, "started_at": "2026-07-14T00:00:04Z", "finished_at": "2026-07-14T00:00:30Z", "exit_code": 0, "artifact_path": "receipts/deploy.json", "artifact_sha256": "3333333333333333333333333333333333333333333333333333333333333333", "artifact_size_bytes": 128, "log_path": "logs/deploy.log", "log_sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", "log_size_bytes": 64},
    "smoke": {"command": ["scripts/smoke_digest.sh"], "cwd": "backend", "runtime": {"name": "bash", "version": "5.2.0", "platform": "linux-x86_64"}, "started_at": "2026-07-14T00:00:30Z", "finished_at": "2026-07-14T00:00:50Z", "exit_code": 0, "artifact_path": "receipts/smoke.json", "artifact_sha256": "4444444444444444444444444444444444444444444444444444444444444444", "artifact_size_bytes": 128, "log_path": "logs/smoke.log", "log_sha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", "log_size_bytes": 64},
    "cleanup": {"command": ["docker", "volume", "rm", "pomodoroxii-fresh-123456-1"], "cwd": "backend", "runtime": {"name": "docker", "version": "27.0.0", "platform": "linux-x86_64"}, "started_at": "2026-07-14T00:00:50Z", "finished_at": "2026-07-14T00:01:00Z", "exit_code": 0, "artifact_path": "receipts/cleanup.json", "artifact_sha256": "5555555555555555555555555555555555555555555555555555555555555555", "artifact_size_bytes": 128, "log_path": "logs/cleanup.log", "log_sha256": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", "log_size_bytes": 64, "removed": true, "post_remove_lookup": {"command": ["docker", "volume", "inspect", "pomodoroxii-fresh-123456-1"], "cwd": "backend", "runtime": {"name": "docker", "version": "27.0.0", "platform": "linux-x86_64"}, "started_at": "2026-07-14T00:00:59Z", "finished_at": "2026-07-14T00:01:00Z", "exit_code": 1, "error_kind": "docker_volume_not_found", "error_name": "pomodoroxii-fresh-123456-1", "stdout_path": "logs/post-remove-inspect.stdout", "stdout_sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "stdout_size_bytes": 0, "stderr_path": "logs/post-remove-inspect.stderr", "stderr_sha256": "abababababababababababababababababababababababababababababababab", "stderr_size_bytes": 96}}
  },
  "checks": {
    "health": true,
    "readiness": true,
    "metrics": true,
    "space_open_read": true,
    "mutation": true,
    "ledger_visible": true,
    "ack": true
  },
  "started_at": "2026-07-14T00:00:00Z",
  "finished_at": "2026-07-14T00:01:00Z",
  "commands": [["fresh_deploy_drill.sh", "--subject-sha", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"], ["smoke_digest.sh", "--subject-sha", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]],
  "exit_code": 0,
  "log_path": "logs/fresh-deploy-combined.log",
  "log_sha256": "9999999999999999999999999999999999999999999999999999999999999999",
  "log_size_bytes": 1024
}
```

`verify_fresh_deploy.py` rejects placeholders, an existing/reused volume even if later emptied, any pre/post inspect error other than exact Docker not-found for the derived name, a late/missing cleanup trap, an identity/label mismatch, an empty-root proof after deployment, a missing receipt/raw stream, or cleanup of any other name. It resolves every receipt/log/stdout/stderr path beneath the explicit artifact root using the shared S0 resolver, requires POSIX bundle-relative regular non-symlink files, and independently rehashes/re-sizes all bytes, including permitted zero-byte streams. It reparses raw Docker stderr rather than trusting normalized `error_kind`; reparses raw probe/init/backend `docker inspect` bytes; requires the exact volume name/source, `/app/data` destination, probe read-only flag, locked probe/init digests, literal `find` argv, UID/GID-1000 preparation, and target mount; recomputes empty-root entry count from raw stdout; and verifies exact create/inspect/start commands, cwd, runtime, ordered timestamps, and exits. A direct host `find /app/data`, an argv omitting the volume name, or a named-volume `prepare_bind_mount.sh` claim fails. After that verifier succeeds, the shared writer copies ID/modules/findings/tags from `PRODUCER_CONTRACTS["fresh_deploy"].artifacts[0]` and emits one closed record over `fresh-deploy-drill.json`; no local semantic table exists. Task 8's final workflow invokes the orchestrator only against consumed `IMAGE@DIGEST`, validates both files, and uploads every proof stream unchanged for S6.

- [ ] **Step 5: Replace deployment documentation with exact recovery-first flows**

`backend/DEPLOY.md` includes prerequisites, environment validation, bind preparation, operations credential issue/rotation/revocation, fresh deploy, verified snapshot, digest upgrade, smoke, rollback, and evidence paths. It states the one-process topology and backup failure-domain requirement.

The runbooks define:

- `recovery.md`: snapshot verify, restore-to-staging, cutover receipt, post-cutover verification, rollback-root retention;
- `relocation.md`: target validation, external snapshot, explicit relocate, old-root rollback;
- `rollback.md`: stop target, verify baseline snapshot, restore/cutover, start recorded previous digest, smoke;
- `incident.md`: `space_recovery_required`, `FAILED_MANUAL`, stale backup, Sync lag, credential compromise, scan/signature failure, and escalation/evidence capture.

Each command uses concrete flags from `python -m app.ops --help`. No command mutates raw database/filesystem state.

- [ ] **Step 6: Run focused gates and commit every producer/tool before activation**

Run:

```powershell
.\backend\.venv\Scripts\python.exe -m pytest -q backend/tests/test_delivery_runbooks.py backend/tests/test_prod_hardening.py backend/tests/test_recovery.py backend/tests/test_operational_endpoints.py backend/tests/test_observability.py -p no:cacheprovider
.\backend\.venv\Scripts\ruff.exe check --no-cache backend/app backend/tests backend/scripts
git -C . diff --exit-code -- .github/workflows/backend-release.yml
git -C . add -- backend/scripts/prepare_bind_mount.sh backend/scripts/deploy_digest.sh backend/scripts/smoke_digest.sh backend/scripts/certification/fresh_deploy_drill.sh backend/scripts/certification/verify_fresh_deploy.py backend/docker-compose.yml backend/DEPLOY.md backend/docs/runbooks/recovery.md backend/docs/runbooks/relocation.md backend/docs/runbooks/rollback.md backend/docs/runbooks/incident.md backend/tests/test_delivery_runbooks.py backend/tests/test_prod_hardening.py
git commit -m "docs(ops): make digest deploy and rollback executable"
```

Expected: PASS; no mutable deploy reference/online tar remains; every documented command parses; Compose validates with concrete digest/data/backup environment values. This producer commit contains every fresh/deploy tool and focused test while Task 6's inert `backend-release.yml` remains byte-identical.

- [ ] **Step 7: Activate the release workflow in one isolated descendant commit**

Only now replace Task 6's inert scaffold with the final workflow. Copy Task 7's locked N-1 argv, consume the committed fresh producer, and put workflow-only fixtures in `test_release_workflow_contract.py`. Do not author, stage, test, or commit activation content in the primary worktree or use its mutable `.venv`. First create a fresh registered linked worktree at the producer commit and a fresh external locked runtime. Make the two activation edits only inside that linked worktree. Before and after commit, enforce the complete producer path closure, producer-commit diff, exact activation path set, empty unstaged diff, zero extra untracked/ignored paths, staged-tree identity, and derived history. `s5-history.json` is canonical UTF-8 JSON with exactly `schema_version,subject_sha,producer_commit,activation_commit,activation_parent,producer_tree,activation_tree,producer_commit_paths,activation_paths,producer_paths`. The two path arrays are sorted exact strings; `producer_paths` is a sorted array of closed `{path,sha256,size_bytes}` objects read from `activation_parent:path`. It has no timestamp, caller identity, environment-derived SHA, stored pass boolean, or self hash. The independent `EV-S5-HISTORY` S0 record in `release-evidence.json` supplies its artifact hash/size.

Run this bootstrap from the original repository root immediately after Step 6 commits the producer and before editing either activation file. The Git-environment rejection precedes the first authority-bearing Git call; `$GIT`, `$UV`, and the eventual `$PYTHON` are absolute paths. Keep the same PowerShell session for the rest of Steps 7-8:

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
$authorityChangingGitEnvironment = @(
  Get-ChildItem Env: | Where-Object {
    $_.Name -match '^(?:GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_NAMESPACE|GIT_CEILING_DIRECTORIES|GIT_DISCOVERY_ACROSS_FILESYSTEM|GIT_CONFIG|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_[0-9]+|GIT_CONFIG_VALUE_[0-9]+|GIT_CONFIG_PARAMETERS|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|GIT_CONFIG_NOSYSTEM|GIT_ATTR_NOSYSTEM|GIT_EXEC_PATH|GIT_TEMPLATE_DIR|GIT_REPLACE_REF_BASE|GIT_NO_REPLACE_OBJECTS|GIT_SHALLOW_FILE|GIT_GRAFT_FILE|GIT_QUARANTINE_PATH|GIT_EXTERNAL_DIFF)$'
  }
)
if ($authorityChangingGitEnvironment.Count -ne 0) {
  throw "authority-changing Git environment must be unset before repository selection: $($authorityChangingGitEnvironment.Name -join ', ')"
}
$GIT = (Resolve-Path -LiteralPath (Get-Command git.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Source)).Path
$UV = (Resolve-Path -LiteralPath (Get-Command uv.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Source)).Path
if (-not [System.IO.Path]::IsPathFullyQualified($GIT) -or -not (Test-Path -LiteralPath $GIT -PathType Leaf)) { throw 'Git binding is not an absolute executable path' }
if (-not [System.IO.Path]::IsPathFullyQualified($UV) -or -not (Test-Path -LiteralPath $UV -PathType Leaf)) { throw 'uv binding is not an absolute executable path' }
$REPO_ROOT = (Resolve-Path -LiteralPath .).Path
$producerCommit = (& $GIT -C $REPO_ROOT rev-parse --verify "HEAD^{commit}").Trim()
if ($producerCommit -notmatch '^[0-9a-f]{40}$') { throw 'producer commit is not a full SHA' }
if ((& $GIT -C $REPO_ROOT show -s --format=%s $producerCommit).Trim() -ne 'docs(ops): make digest deploy and rollback executable') {
  throw 'activation parent is not the producer commit'
}
$activationRunId = [guid]::NewGuid().ToString('N')
$ACTIVATION_ROOT = Join-Path ([System.IO.Path]::GetTempPath()) "pomodoroxii-s5-activation-$producerCommit-$activationRunId"
$ACTIVATION_RUNTIME = Join-Path ([System.IO.Path]::GetTempPath()) "pomodoroxii-s5-activation-runtime-$producerCommit-$activationRunId"
$ACTIVATION_BRANCH = "s5-activation/$($producerCommit.Substring(0, 12))-$activationRunId"
if (Test-Path -LiteralPath $ACTIVATION_ROOT) { throw 'activation worktree must not pre-exist' }
if (Test-Path -LiteralPath $ACTIVATION_RUNTIME) { throw 'activation runtime must not pre-exist' }
& $GIT -C $REPO_ROOT worktree add -b $ACTIVATION_BRANCH -- $ACTIVATION_ROOT $producerCommit
$ACTIVATION_ROOT = (Resolve-Path -LiteralPath $ACTIVATION_ROOT).Path
$registeredRoots = @(
  & $GIT -C $REPO_ROOT worktree list --porcelain |
    Where-Object { $_ -like 'worktree *' } |
    ForEach-Object { [System.IO.Path]::GetFullPath($_.Substring(9)) }
)
if ($registeredRoots -notcontains [System.IO.Path]::GetFullPath($ACTIVATION_ROOT)) { throw 'activation root is not a registered linked worktree' }
if ((& $GIT -C $ACTIVATION_ROOT rev-parse --verify HEAD).Trim() -ne $producerCommit) { throw 'fresh activation worktree is not at the producer commit' }
if ((& $GIT -C $ACTIVATION_ROOT rev-parse --abbrev-ref HEAD).Trim() -ne $ACTIVATION_BRANCH) { throw 'fresh activation worktree is not on its dedicated branch' }
if (@(& $GIT -C $ACTIVATION_ROOT status --porcelain=v1 --untracked-files=all --ignored=matching).Count -ne 0) { throw 'fresh activation worktree is not strictly clean' }
New-Item -ItemType Directory -Path $ACTIVATION_RUNTIME | Out-Null
$env:UV_PROJECT_ENVIRONMENT = $ACTIVATION_RUNTIME
& $UV sync --frozen --offline --no-install-project --project (Join-Path $ACTIVATION_ROOT 'backend')
$PYTHON = (Resolve-Path -LiteralPath (Join-Path $ACTIVATION_RUNTIME 'Scripts\python.exe')).Path
if (-not [System.IO.Path]::IsPathFullyQualified($PYTHON) -or -not (Test-Path -LiteralPath $PYTHON -PathType Leaf)) { throw 'Python binding is not an absolute executable path' }
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:PYTHONNOUSERSITE = '1'
if (@(& $GIT -C $ACTIVATION_ROOT status --porcelain=v1 --untracked-files=all --ignored=matching).Count -ne 0) { throw 'external runtime bootstrap dirtied the activation worktree' }
Set-Location -LiteralPath $ACTIVATION_ROOT
```

Now edit only `$ACTIVATION_ROOT\.github\workflows\backend-release.yml` and `$ACTIVATION_ROOT\backend\tests\test_release_workflow_contract.py`. Do not copy a virtual environment, generated output, ignored file, or a primary-worktree edit into this worktree. Then run the following from the same PowerShell session. It stages the two files first, proves the worktree bytes equal that staged tree, tests those bytes with the external Python, re-proves the tree after tests, and commits that exact tree in the same registered worktree:

```powershell
$producerPaths = @(
  '.github/workflows/ci.yml',
  '.github/workflows/pxii-vfs-wheels.yml',
  'backend/Dockerfile',
  'backend/docker-compose.yml',
  'backend/pyproject.toml',
  'backend/uv.lock',
  'backend/CMakeLists.txt',
  'backend/cibuildwheel.toml',
  'backend/cmake/pxii-vfs-source.sha256',
  'backend/native/pxii_vfs/pxii_vfs.c',
  'backend/native/pxii_vfs/pxii_vfs.h',
  'backend/native/vendor/sqlite3ext.h',
  'backend/audit/95plus/evidence.schema.json',
  'backend/audit/95plus/pxii-vfs-wheel-manifest.schema.json',
  'backend/app/audit/__init__.py',
  'backend/app/audit/producer_contracts.py',
  'backend/app/runtime/__init__.py',
  'backend/app/runtime/scope.py',
  'backend/app/runtime/contained_io.py',
  'backend/app/runtime/sqlite_vfs.py',
  'backend/app/runtime/joined_thread.py',
  'backend/app/deps.py',
  'backend/app/space_manager.py',
  'backend/app/file_system/api.py',
  'backend/app/errors.py',
  'backend/scripts/evidence_records.py',
  'backend/scripts/ci/verify_artifacts.py',
  'backend/scripts/ci/verify_pxii_vfs_wheels.py',
  'backend/scripts/verify_pxii_vfs_source_hash.py',
  'backend/scripts/supply_chain.py',
  'backend/supply-chain.lock.json',
  'backend/scripts/prepare_bind_mount.sh',
  'backend/scripts/deploy_digest.sh',
  'backend/scripts/smoke_digest.sh',
  'backend/scripts/certification/fresh_deploy_drill.sh',
  'backend/scripts/certification/verify_fresh_deploy.py',
  'backend/scripts/certification/n_minus_one_drill.py',
  'backend/scripts/certification/verify_drill.py',
  'backend/tests/fixtures/certification/n_minus_one_manifest.json',
  'backend/tests/fixtures/certification/n_minus_one_empty_legacy_manifest.json',
  'backend/tests/fixtures/certification/populate_n_minus_one.py',
  'backend/tests/test_ci_evidence.py',
  'backend/tests/test_pxii_vfs_wheel_evidence.py',
  'backend/tests/test_space_path_containment.py',
  'backend/tests/test_pxii_vfs.py',
  'backend/tests/test_deps_space_validation.py',
  'backend/tests/test_deps.py',
  'backend/tests/test_space_manager.py',
  'backend/tests/test_file_system/test_api.py',
  'backend/tests/test_supply_chain.py',
  'backend/tests/test_n_minus_one_drill.py',
  'backend/tests/test_n_minus_one_fixture.py',
  'backend/tests/test_delivery_runbooks.py',
  'backend/tests/test_prod_hardening.py'
)
$producerCommitAllowed = @(
  'backend/DEPLOY.md',
  'backend/docker-compose.yml',
  'backend/docs/runbooks/incident.md',
  'backend/docs/runbooks/recovery.md',
  'backend/docs/runbooks/relocation.md',
  'backend/docs/runbooks/rollback.md',
  'backend/scripts/certification/fresh_deploy_drill.sh',
  'backend/scripts/certification/verify_fresh_deploy.py',
  'backend/scripts/deploy_digest.sh',
  'backend/scripts/prepare_bind_mount.sh',
  'backend/scripts/smoke_digest.sh',
  'backend/tests/test_delivery_runbooks.py',
  'backend/tests/test_prod_hardening.py'
)
$activationAllowed = @('.github/workflows/backend-release.yml', 'backend/tests/test_release_workflow_contract.py')
$producerCommitDiff = @(& $GIT -C $ACTIVATION_ROOT diff-tree --no-commit-id --name-only -r $producerCommit)
if (@(Compare-Object $producerCommitAllowed $producerCommitDiff).Count -ne 0) { throw 'producer commit diff escaped its allowlist' }
$PSNativeCommandUseErrorActionPreference = $false
foreach ($path in $producerPaths) {
  & $GIT -C $ACTIVATION_ROOT cat-file -e "$producerCommit`:$path"
  if ($LASTEXITCODE -ne 0) { throw "activation parent is missing producer/tool: $path" }
}
$PSNativeCommandUseErrorActionPreference = $true
& $GIT -C $ACTIVATION_ROOT add -- .github/workflows/backend-release.yml backend/tests/test_release_workflow_contract.py
$staged = @(& $GIT -C $ACTIVATION_ROOT diff --cached --name-only --)
if (($staged -join "`n") -cne ($activationAllowed -join "`n")) { throw 'activation staged paths are not the exact ordered allowlist' }
& $GIT -C $ACTIVATION_ROOT diff --cached --check
& $GIT -C $ACTIVATION_ROOT diff --exit-code --
$untracked = @(& $GIT -C $ACTIVATION_ROOT ls-files --others --exclude-standard --)
$ignored = @(& $GIT -C $ACTIVATION_ROOT ls-files --others --ignored --exclude-standard --)
if ($untracked.Count -ne 0 -or $ignored.Count -ne 0) { throw 'activation worktree contains extra untracked or ignored paths' }
$stagedTree = (& $GIT -C $ACTIVATION_ROOT write-tree).Trim()
if ($stagedTree -notmatch '^[0-9a-f]{40}$') { throw 'activation staged tree is not a full object ID' }
Push-Location $ACTIVATION_ROOT
try {
  & $PYTHON -m pytest -q backend/tests/test_release_workflow_contract.py backend/tests/test_supply_chain.py -p no:cacheprovider
}
finally { Pop-Location }
$stagedAfterTest = @(& $GIT -C $ACTIVATION_ROOT diff --cached --name-only --)
if (($stagedAfterTest -join "`n") -cne ($activationAllowed -join "`n")) { throw 'tests changed the exact activation staged path set' }
& $GIT -C $ACTIVATION_ROOT diff --exit-code --
$untrackedAfterTest = @(& $GIT -C $ACTIVATION_ROOT ls-files --others --exclude-standard --)
$ignoredAfterTest = @(& $GIT -C $ACTIVATION_ROOT ls-files --others --ignored --exclude-standard --)
if ($untrackedAfterTest.Count -ne 0 -or $ignoredAfterTest.Count -ne 0) { throw 'tests created untracked or ignored activation-worktree output' }
if ((& $GIT -C $ACTIVATION_ROOT write-tree).Trim() -ne $stagedTree) { throw 'tests changed the staged activation tree' }
& $GIT -C $ACTIVATION_ROOT -c commit.gpgSign=false commit --no-verify -m "ci(release): activate verified producer DAG"
$activation = (& $GIT -C $ACTIVATION_ROOT rev-parse --verify HEAD).Trim()
$activationParent = (& $GIT -C $ACTIVATION_ROOT rev-parse --verify "$activation^1").Trim()
if ($activationParent -ne $producerCommit) { throw 'activation first parent is not the derived producer commit' }
$activationTree = (& $GIT -C $ACTIVATION_ROOT rev-parse --verify "$activation^{tree}").Trim()
if ($activationTree -ne $stagedTree) { throw 'activation commit tree differs from the tested staged tree' }
$PSNativeCommandUseErrorActionPreference = $false
foreach ($path in $producerPaths) {
  & $GIT -C $ACTIVATION_ROOT cat-file -e "$activationParent`:$path"
  if ($LASTEXITCODE -ne 0) { throw "committed activation parent is missing producer/tool: $path" }
}
$PSNativeCommandUseErrorActionPreference = $true
$committed = @(& $GIT -C $ACTIVATION_ROOT diff-tree --no-commit-id --name-only -r $activation)
if (($committed -join "`n") -cne ($activationAllowed -join "`n")) { throw 'activation commit contains files outside its allowlist' }
if (@(& $GIT -C $ACTIVATION_ROOT status --porcelain=v1 --untracked-files=all --ignored=matching).Count -ne 0) { throw 'committed activation worktree is not strictly clean' }
$historyReceipt = Join-Path $env:TEMP "pomodoroxii-s5-history-$activation.json"
& $PYTHON (Join-Path $ACTIVATION_ROOT 'backend\scripts\supply_chain.py') derive-s5-history --repo-root $ACTIVATION_ROOT --subject-sha $activation --output $historyReceipt
& $PYTHON (Join-Path $ACTIVATION_ROOT 'backend\scripts\supply_chain.py') verify-s5-history --repo-root $ACTIVATION_ROOT --subject-sha $activation --receipt $historyReceipt
if (@(& $GIT -C $ACTIVATION_ROOT status --porcelain=v1 --untracked-files=all --ignored=matching).Count -ne 0) { throw 'history verification dirtied the committed activation worktree' }
```

Expected: workflow contract tests PASS against exactly the staged tree in the fresh registered activation worktree; the commit is created in that same worktree and its tree equals the tested tree. The activation commit's first parent already contains every referenced producer/tool and focused test; its own diff contains only the consumer workflow and workflow-contract test, with no unstaged, untracked, or ignored residue. Preserve both commits in the target history: squash-merging them into one commit is forbidden.

- [ ] **Step 8: Run the complete S5 local exit gate on the committed activation head**

Run:

```powershell
if ((& $GIT -C $ACTIVATION_ROOT rev-parse --verify HEAD).Trim() -ne $activation) { throw 'S5 exit gate is not running at the committed activation head' }
if (@(& $GIT -C $ACTIVATION_ROOT status --porcelain=v1 --untracked-files=all --ignored=matching).Count -ne 0) { throw 'activation worktree is not clean before the S5 exit gate' }
Push-Location $ACTIVATION_ROOT
try {
  & $PYTHON -m pytest -q backend/tests/test_recovery.py backend/tests/test_backup_lifespan.py backend/tests/test_operational_endpoints.py backend/tests/test_observability.py backend/tests/test_prod_hardening.py backend/tests/test_space_relocation.py backend/tests/test_ci_evidence.py backend/tests/test_supply_chain.py backend/tests/test_n_minus_one_drill.py backend/tests/test_delivery_runbooks.py backend/tests/test_release_workflow_contract.py -p no:cacheprovider
  & $UV lock --project (Join-Path $ACTIVATION_ROOT 'backend') --check --offline
}
finally { Pop-Location }
& $GIT -C $ACTIVATION_ROOT diff --exit-code --
& $GIT -C $ACTIVATION_ROOT diff --cached --exit-code --
if (@(& $GIT -C $ACTIVATION_ROOT status --porcelain=v1 --untracked-files=all --ignored=matching).Count -ne 0) { throw 'S5 exit gate dirtied the committed activation worktree' }
```

Expected: PASS in the same fresh registered activation worktree and external runtime, with no tracked, staged, untracked, or ignored change after the activation commit. This proves local contracts only; it does not replace the live release/drill artifacts.

- [ ] **Step 9: Merge without squash, then retain the exact-main-SHA release/system gates**

Merge the producer commit and its descendant activation commit into `main` without squashing either commit. Fetch `origin/main`; derive the unique activation and producer identities from its reachable Git objects, exact subjects, trees, and diffs; require the selected S5 SHA to contain the activation commit and that activation commit's first parent to be the producer commit; then run trusted-main CI and the final release workflow against exactly that fetched SHA. No tracked edit may follow selection.

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
$authorityChangingGitEnvironment = @(
  Get-ChildItem Env: | Where-Object { $_.Name -like 'GIT_*' }
)
if ($authorityChangingGitEnvironment.Count -ne 0) {
  throw "authority-changing Git environment must be unset before S5 target selection: $($authorityChangingGitEnvironment.Name -join ', ')"
}
$GIT = (Resolve-Path -LiteralPath (Get-Command git.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Source)).Path
$UV = (Resolve-Path -LiteralPath (Get-Command uv.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Source)).Path
if (-not [System.IO.Path]::IsPathFullyQualified($GIT) -or -not (Test-Path -LiteralPath $GIT -PathType Leaf)) { throw 'S5 Git binding is not an absolute executable path' }
if (-not [System.IO.Path]::IsPathFullyQualified($UV) -or -not (Test-Path -LiteralPath $UV -PathType Leaf)) { throw 'S5 uv binding is not an absolute executable path' }
$REPO_ROOT = (Resolve-Path -LiteralPath .).Path
& $GIT -C $REPO_ROOT fetch origin main
$S5_HEAD = (& $GIT -C $REPO_ROOT rev-parse refs/remotes/origin/main).Trim()
if ($S5_HEAD -notmatch '^[0-9a-f]{40}$') { throw 'fetched S5 head is not a full SHA' }
$runId = [guid]::NewGuid().ToString('N')
$S5_TOOL_ROOT = Join-Path ([System.IO.Path]::GetTempPath()) "pomodoroxii-s5-merged-$S5_HEAD-$runId"
$S5_RUNTIME_ROOT = Join-Path ([System.IO.Path]::GetTempPath()) "pomodoroxii-s5-merged-runtime-$S5_HEAD-$runId"
$historyRoot = Join-Path ([System.IO.Path]::GetTempPath()) "pomodoroxii-s5-history-$S5_HEAD-$runId"
foreach ($freshRoot in @($S5_TOOL_ROOT, $S5_RUNTIME_ROOT, $historyRoot)) {
  if (Test-Path -LiteralPath $freshRoot) { throw "S5 merged-head root must not pre-exist: $freshRoot" }
}
& $GIT -C $REPO_ROOT worktree add --detach $S5_TOOL_ROOT $S5_HEAD
$S5_TOOL_ROOT = (Resolve-Path -LiteralPath $S5_TOOL_ROOT).Path
$registeredRoots = @(
  & $GIT -C $REPO_ROOT worktree list --porcelain |
    Where-Object { $_ -like 'worktree *' } |
    ForEach-Object { [System.IO.Path]::GetFullPath($_.Substring(9)) }
)
if ($registeredRoots -notcontains [System.IO.Path]::GetFullPath($S5_TOOL_ROOT)) { throw 'S5 merged-head root is not a registered linked worktree' }
if ((& $GIT -C $S5_TOOL_ROOT rev-parse --verify HEAD).Trim() -ne $S5_HEAD) { throw 'S5 tool worktree HEAD differs from fetched S5 head' }
if ((& $GIT -C $S5_TOOL_ROOT rev-parse --abbrev-ref HEAD).Trim() -ne 'HEAD') { throw 'S5 tool worktree is not detached' }
if (@(& $GIT -C $S5_TOOL_ROOT status --porcelain=v1 --untracked-files=all --ignored=matching).Count -ne 0) { throw 'fresh S5 tool worktree is not strictly clean' }
New-Item -ItemType Directory -Path $S5_RUNTIME_ROOT | Out-Null
New-Item -ItemType Directory -Path $historyRoot | Out-Null
$env:UV_PROJECT_ENVIRONMENT = $S5_RUNTIME_ROOT
& $UV sync --frozen --offline --no-install-project --project (Join-Path $S5_TOOL_ROOT 'backend')
$PYTHON = (Resolve-Path -LiteralPath (Join-Path $S5_RUNTIME_ROOT 'Scripts\python.exe')).Path
if (-not [System.IO.Path]::IsPathFullyQualified($PYTHON) -or -not (Test-Path -LiteralPath $PYTHON -PathType Leaf)) { throw 'S5 Python binding is not an absolute executable path' }
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:PYTHONNOUSERSITE = '1'
if (@(& $GIT -C $S5_TOOL_ROOT status --porcelain=v1 --untracked-files=all --ignored=matching).Count -ne 0) { throw 'external S5 runtime bootstrap dirtied the detached tool worktree' }
$historyPath = Join-Path $historyRoot 's5-history.json'
Push-Location $S5_TOOL_ROOT
try {
  & $PYTHON (Join-Path $S5_TOOL_ROOT 'backend\scripts\supply_chain.py') derive-s5-history --repo-root $S5_TOOL_ROOT --subject-sha $S5_HEAD --output $historyPath
  & $PYTHON (Join-Path $S5_TOOL_ROOT 'backend\scripts\supply_chain.py') verify-s5-history --repo-root $S5_TOOL_ROOT --subject-sha $S5_HEAD --receipt $historyPath
  $history = Get-Content -Raw -LiteralPath $historyPath | ConvertFrom-Json
  $PRODUCER_COMMIT = [string]$history.producer_commit
  $ACTIVATION_COMMIT = [string]$history.activation_commit
  foreach ($sha in @($S5_HEAD, $PRODUCER_COMMIT, $ACTIVATION_COMMIT)) {
    if ($sha -notmatch '^[0-9a-f]{40}$') { throw "derived S5 history identity is not a full SHA: $sha" }
  }
  $ACTIVATION_PARENT = (& $GIT -C $S5_TOOL_ROOT rev-parse "$ACTIVATION_COMMIT^1").Trim()
  if ($ACTIVATION_PARENT -ne $PRODUCER_COMMIT -or [string]$history.activation_parent -ne $PRODUCER_COMMIT) {
    throw 'derived producer is not the activation first parent'
  }
  $PSNativeCommandUseErrorActionPreference = $false
  & $GIT -C $S5_TOOL_ROOT merge-base --is-ancestor $PRODUCER_COMMIT $ACTIVATION_PARENT
  if ($LASTEXITCODE -ne 0) { throw 'producer commit is not in activation first-parent ancestry' }
  & $GIT -C $S5_TOOL_ROOT merge-base --is-ancestor $ACTIVATION_COMMIT $S5_HEAD
  if ($LASTEXITCODE -ne 0) { throw 'activation commit is not contained by fetched origin/main' }
  $PSNativeCommandUseErrorActionPreference = $true
  $allowed = @('.github/workflows/backend-release.yml', 'backend/tests/test_release_workflow_contract.py')
  $actual = @(& $GIT -C $S5_TOOL_ROOT diff-tree --no-commit-id --name-only -r $ACTIVATION_COMMIT)
  if (@(Compare-Object $allowed $actual).Count -ne 0) { throw 'merged activation commit escaped its allowlist' }
  if (@(& $GIT -C $S5_TOOL_ROOT status --porcelain=v1 --untracked-files=all --ignored=matching).Count -ne 0) { throw 'merged-head history verification dirtied the detached S5 tool worktree' }
}
finally { Pop-Location }
& $GIT -C $REPO_ROOT diff --exit-code --
& $GIT -C $REPO_ROOT diff --cached --exit-code --
```

Expected: the fetched `origin/main` SHA is checked only through a fresh registered detached worktree at that exact object and a fresh external dependency-only runtime. The derive/verify script bytes, Git objects, activation diff, and history receipt all come from the same `$S5_HEAD`; both the detached tool worktree and the primary checkout remain clean. Retain `$historyRoot`, `$S5_TOOL_ROOT`, and `$S5_RUNTIME_ROOT` until the S5 review gate accepts the receipt, then remove the registered worktree through `git worktree remove` and delete only those recorded run-unique external roots.

Task 8 is the only Task that enables the unfiltered `pull_request`/main `push` triggers. The final workflow runs N-1 and fresh deploy serially in `drills`; no activation commit references an uncommitted producer. Expected: CI's single first-attempt owner supplies the only digest/provenance plus the stable two-platform native artifact; `publish` fully paginates and bounded-polls both artifacts, independently revalidates both native wheel/extension rows, consumes only the selected Linux wheel without rebuilding, proves the installed image extension/hash/build/SQLite identity, and produces two SBOMs/zero-finding scan/signature. `drills` completes never-existing-volume deploy, fixed N-1 upgrade, independent full restore, and rollback. The `release` job has `needs: [publish, drills]`, `if: always()`, and exact read-only `contents/actions/checks` permissions. It invokes Task 6's unchanged, focused-test-owned `supply_chain.py verify-release-eligibility`, `derive-s5-history`, and `verify-s5-history` commands. Eligibility independently bounded-polls and paginates Checks, Actions runs/jobs, and artifacts for the full SHA, excludes only its own current check by exact App/workflow/run/job identity, and cross-checks event/ref/workflow/run/attempt/artifact ID/name/hash and predecessor conclusions; the publish selector output is only an input hint, never authority. History derivation uses only the checked-out target Git objects and writes canonical `s5-history.json` into the release artifact root. Zero, duplicate, page-2 conflict, failed, cancelled, timed-out, missing, ambiguous producer identity, native manifest/runtime drift, rebuild fallback, or invalid history fails.

Its conditions are mutually exclusive and exhaustive: PR succeeds only when both producers are `skipped` and static policy passes; any other PR predecessor state runs `Reject invalid PR predecessors` and exits nonzero; main push aggregates only when both are `success`; any other push predecessor state runs `Reject failed trusted push`; any unexpected event fails. The aggregate path cannot sign, attest, push, deploy, mutate producer directories, or invoke a build tool. It imports `PRODUCER_CONTRACTS` and `S5_INPUT_PRODUCERS`, validates exactly the four non-self input producers including independent `EV-CI-PXII-VFS-WHEEL-MANIFEST` and `EV-SUPPLY-PXII-VFS-RUNTIME` records, and rejects release/S6/future outputs. Only after all four inputs pass does it write canonical `release-artifact-index.json`; it then derives and verifies canonical `s5-history.json` independently. The shared writer emits one closed `release-evidence.json` with two distinct records: `EV-RELEASE-BUNDLE` hashes the index and `EV-S5-HISTORY` hashes the history receipt. Neither output can feed back into the release index. On a pull request, only the valid skipped-producer static branch succeeds without write/OIDC/external effects. A rerun reuses the original producer. Validate every envelope and named artifact, require global stable-ID uniqueness, and retain both native wheel members/manifest/runtime receipt, the complete N-1 inventory, plus every fresh pre-create/probe/init/mount/empty-root/post-remove raw proof.

**Review gate:** Approve S5 only when local contracts and live exact-SHA workflows are green; exactly one non-matrix/non-reusable trusted-main build/push exists across reruns; Task 8's tree-derived producer commit precedes its isolated activation commit, both remain in target history, their exact diffs pass, and `s5-history.json` closes every producer/tool/schema/authority/writer/native-source/native-build/runtime/fixture/focused-test path with target-tree hashes; PR has skipped producers plus static success or explicit invalid-predecessor failure while push has two successful predecessors or explicit failure; the final aggregator independently paginates and revalidates same-SHA Checks/runs/jobs/artifacts; every producer copies the sole contract semantics into a closed envelope with unique IDs; both platform wheels and unpacked extensions rehash to the closed manifest, the Linux image installed extension equals the selected Linux row and stock SQLite source/version IDs, and no project/native rebuild path exists; fresh absence/empty-root/UID preparation/mount/cleanup are bound to the exact named volume by contained raw argv/inspect/stdout/stderr receipts; every stage has exact runtime/path/hash/size; the strengthened full-SHA N-1 heads/catalog/IndexStore/inventory contract is populated exclusively by the archived N-1 runtime and all four stages match it; the release index is non-self-referential; and rollback uses both preserved snapshot and previous digest. Missing live restore, rollback, provenance, native manifest/runtime, fresh-root, index, digest, history, or branch-result evidence blocks S6.

## Wave Completion Handoff

Attach the S5 head SHA, the unchanged closed S0 envelopes from CI, supply-chain, N-1, fresh deploy, and release (including `release-evidence.json`), together with `pxii-vfs-wheel-manifest-v1`, both wheel members, `pxii-vfs-runtime-extension.json`, `release-artifact-index.json`, and canonical `s5-history.json`. Review stable evidence-ID uniqueness, artifact hash/size/trust/tag completeness, tree-derived producer/activation identity and complete path/hash closure, trusted CI event/ref/workflow/run-attempt identity, one-build/one-digest/provenance equality, two-platform native source/tool/wheel/extension/test identity, installed Linux extension/SQLite identity, absence of native rebuild fallback, recovery atomicity, external failure-domain storage, operations credential separation, bounded metrics, action/base/tool pins, scan/SBOM/signature equality, fixed N-1 fixture equality, never-existing empty-volume proof, non-root smoke, independent restore, cleanup, and rollback. Start S6 only after that review explicitly accepts zero release blockers.
