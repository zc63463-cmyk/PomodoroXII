# Backend 95+ S1 Fail-Closed Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every S1 unsafe ingress by centralizing credential authority, authenticating MCP HTTP, proving Space path containment before engine creation, rejecting unsafe legacy Sync/retention operations, disabling the legacy Alembic entrypoint, and retaining only failed CI sandboxes.

**Architecture:** REST and FastMCP remain thin Adapters over two deep Modules: `CredentialAuthority` owns password policy, asynchronous bcrypt, JWT epoch verification, and revocation; `AuthorizedSpaceScope` owns identity/scope checks plus canonical registered-path containment. Domain failures share one deeply frozen, JSON-safe `DomainErrorRecord`; `app/errors.py::to_wire_json(value)` is the only recursive thaw/serialization authority later S3/S4 import. REST v1 maps the record back to exact legacy bodies while the opt-in v2 media type and MCP expose the canonical five-field contract. Path authority is carried by a privately constructed `SpaceContainmentCapability`; `open_verified()` performs descriptor/HANDLE-relative no-follow kernel opens and yields only opaque `ContainedSpaceOpens`. Its deep native SQLite Module binds those open identities to an unforgeable virtual name handled by the packaged `pxii-vfs`; no host pathname crosses the storage seam or is reopened after binding. The four-path snapshot is capability-private metadata, never storage authority. S1 does not create `SpaceRuntimeHandle`: it returns an authorization/containment result that S2 will consume internally without changing the public `open` call shape.

**Tech Stack:** CPython 3.13, FastAPI, Pydantic 2, SQLAlchemy asyncio, stock SQLite/`sqlite3`/aiosqlite, packaged C17 `pxii-vfs`, scikit-build-core, CMake, Ninja, cibuildwheel, PyJWT, bcrypt, FastMCP 3 `TokenVerifier`, pytest, httpx, Alembic, GitHub Actions

---

## Scope And Compatibility Locks

- S0's detached-subject evidence, schema/policy, verifier, external sandbox, and N-1 fixture exit gates must be approved at one commit before S1 starts; S1 never rewrites the audited S0 baseline.
- REST v1 default error bodies keep their exact existing keys and values. Existing Sync recovery fields remain top-level in v1.
- `Accept: application/vnd.pomodoroxii.error+json;version=2` returns exactly `code`, `message`, `retryable`, `request_id`, and `details`.
- Every REST error also carries `X-PomodoroXII-Error-Code`, `X-PomodoroXII-Retryable`, and `X-Request-ID`.
- Existing JWTs without `epoch` are rejected. S1 creates credential epoch `1`; there is no epoch-0 compatibility period.
- Passwords are 12-64 UTF-8 bytes. Length is checked before bcrypt; no byte truncation is allowed.
- In production, the JWT secret is at least 32 UTF-8 bytes and is not a known default.
- HTTP MCP always requires Bearer authentication. Stdio starts only with explicit `--trusted-stdio`; that principal still resolves registered Spaces through `AuthorizedSpaceScope`.
- A Space engine, parent directory, database, Notes directory, or index must not be created until scope and containment succeed.
- Containment is not a reusable Boolean check: every storage consumer receives only `ContainedSpaceOpens` produced by `SpaceContainmentCapability.open_verified()`. Linux opens are anchored by `dirfd`, `openat2`/`openat`, and `O_NOFOLLOW`; POSIX physical companion deletion is fail-closed in S1 because pathname `unlinkat` cannot provide exact-object deletion against an arbitrary same-UID concurrent actor. S5 recovery owns any future Linux delete capability. Windows uses `NtCreateFile` with `RootDirectory`, no reparse traversal, and no delete sharing. The packaged `pxii-vfs` receives only an unforgeable virtual identifier bound to duplicated open authority. Bootstrap may discover the packaged extension by host path, but no database host path, descriptor, HANDLE, virtual token, or sidecar name is exposed to a caller, crosses the storage seam, or is reopened after binding.
- `_containment_lock_for` returns one Task-reentrant asynchronous lock per canonical Space parent: nested acquisition by the owning `asyncio.Task` increments depth, different Tasks remain strictly mutually exclusive, every normal/error/cancellation exit restores owner/depth exactly, and cancelling a waiter cannot mutate the holder's state.
- `FileSystemStorage` contained mode stores only internal Notes/index authorities. Notes methods accept validated relative names and reach storage only through `BoundDirectoryHandle`; index connections come only from `BoundSQLiteTarget.open_maintenance`. The `(root_dir, index_db)` constructor remains a test/N-1 compatibility adapter and production dependencies are statically and dynamically forbidden from calling it.
- Contained `import_from_md(file_path)` and `export_folder(output_dir)` raise `ExternalPathCapabilityRequiredError` before inspecting, opening, creating, or serializing either host path. S1 defines no external import/export capability and never passes arbitrary host paths across the contained boundary.
- `BoundSQLiteTarget` has exactly four caller-visible members: read-only `identity`, `make_async_engine(options) -> AsyncEngine`, `open_maintenance(options) -> ContextManager[sqlite3.Connection]`, and `aclose()`. Stock `sqlite3`, aiosqlite, and SQLAlchemy remain Adapters behind that Module; arbitrary extension loading, `ATTACH`, and unsafe PRAGMAs are denied.
- Legacy Sync may return `cursor_upgrade_required`; it must never return a page whose global timestamp cursor can skip data.
- Ledger and tombstone deletion remain disabled until S4 provides registered-client ACK waterlines.
- Local pytest fixtures do not delete run roots. CI deletes the current run only after success and uploads it only after failure.
- Every local command in this plan starts at the repository root. Python/Ruff executables, pytest node IDs, Ruff targets/config, and Git pathspecs are all repository-root-relative; no step changes cwd.
- S1 does not add migrations, `SpaceRuntime`, leases, recovery, Unit of Work, frontend changes, or release certification claims.

## File Responsibility Map

- Modify `backend/app/errors.py`: define deeply frozen `DomainErrorRecord`, canonical codes, legacy aliases, `deep_freeze_json`, `thaw_json`, the sole shared `to_wire_json(value)`, and `AppError.to_domain_record(request_id)`.
- Modify `backend/app/schemas/common.py`: document the canonical five-field response model while preserving legacy schemas.
- Create `backend/tests/test_error_contract_v2.py`: exact REST v1, opt-in v2, headers, validation, path-redaction, and OpenAPI tests.
- Modify `backend/tests/test_openapi_contract.py`: accept both documented error media types while retaining exact v1 checks.
- Modify `backend/app/settings.py`: enforce the production secret policy after all settings fields are parsed.
- Modify `backend/app/auth/security.py`: non-truncating bcrypt primitives and epoch-bearing JWT codecs.
- Create `backend/app/auth/authority.py`: `Principal` and `CredentialAuthority.setup/login/verify/revoke`.
- Modify `backend/app/routes/v1/auth.py`: delegate setup/login/revoke/verify to `CredentialAuthority`.
- Modify `backend/app/routes/v1/spaces.py`: issue Space tokens with the verified credential epoch.
- Modify `backend/app/schemas/auth.py`: add the revoke response schema.
- Modify `backend/app/deps.py`: verify REST Bearer tokens through `CredentialAuthority` and open Space scope before storage dependencies.
- Modify `backend/app/space_manager.py`: accept opaque `ContainedSpaceOpens`, bind each cached Space engine to the database identity and `BoundSQLiteTarget.make_async_engine(options)`, and reject identity rebinding or any unpinned pathname connection.
- Modify `backend/app/file_system/api.py`: accept opaque `ContainedSpaceOpens`, call only `FileSystemStorage.from_bound_handles`, and never copy the FileSystem implementation or fall back to the path-backed constructor.
- Modify `backend/app/file_system/engine/base.py`: replace direct `root`/`index_db` pathname ownership with internal Notes/index authority ports; the contained index port opens only through `BoundSQLiteTarget.open_maintenance`, while the path-backed adapters remain test/N-1-only.
- Modify `backend/app/file_system/engine/note_ops.py`: express every Note content read/write/move/delete as validated relative names through the internal Notes authority.
- Modify `backend/app/file_system/engine/folder_ops.py`: express folder create/move/rename/cascade operations through relative authority methods without reconstructing a root path.
- Modify `backend/app/file_system/engine/search_ops.py`: read projected Note content and query the index only through the two internal authorities.
- Modify `backend/app/file_system/engine/trash_ops.py`: perform trash move/restore/purge with relative authority operations and no host pathname conversion.
- Modify `backend/app/file_system/engine/version_ops.py`: read/write version children through the Notes authority only.
- Modify `backend/app/file_system/engine/export_ops.py`: keep legacy path-backed import/export only for existing tests/N-1; contained `import_from_md(file_path)` and `export_folder(output_dir)` fail closed before inspecting either host path.
- Modify `backend/app/file_system/engine/consistency_ops.py`: enumerate, read, and repair contained Note children through relative authority operations.
- Modify `backend/app/file_system/engine/__init__.py`: add the sole contained factory `FileSystemStorage.from_bound_handles(notes_handle, index_target)` and retain the path-backed constructor only for existing tests/N-1.
- Modify `backend/app/main.py`: bootstrap epoch `1` after Meta initialization.
- Create `backend/tests/test_security_policy.py`: password bytes, secret bytes, no bcrypt aliasing, and event-loop offload.
- Create `backend/tests/test_auth_concurrency.py`: one-winner setup, epoch rollout, revocation, and stale-token rejection.
- Modify `backend/tests/test_prod_hardening.py`: replace raw epochless token setup with public setup/login/Space-token flows while retaining explicit epochless rejection coverage.
- Modify existing tests containing the seven-byte `test123` setup credential to use `test-password-123`.
- Create `backend/app/runtime/__init__.py`: export S1 runtime-scope contracts.
- Create `backend/app/runtime/scope.py`: `AuthorizedSpaceScope.open(principal, space_id, mode) -> AuthorizedSpaceScopeResult` plus private-constructor `SpaceContainmentCapability.open_verified() -> AsyncContextManager[ContainedSpaceOpens]`.
- Create `backend/app/runtime/contained_io.py`: Linux dirfd/openat2/openat no-follow openers and Windows root-HANDLE-relative no-reparse openers, opaque resource-transfer types, and the private authority binding for `pxii-vfs`. S1 companion deletion is POSIX fail-closed; anonymous temporary-file cleanup may use its own unlink authority.
- Create `backend/app/runtime/sqlite_vfs.py`: controlled stock-SQLite extension bootstrap and the closed `BoundSQLiteTarget` API; URI, token, fd/HANDLE, companion, and raw connection factories remain private.
- Create `backend/app/runtime/joined_thread.py`: cancellation-safe `run_joined_thread` plus general private `run_joined_awaitable`; terminal `on_success` commits happen before cancellation is rethrown and cancelled resources are disposed instead of published.
- Create `backend/native/pxii_vfs/pxii_vfs.c`, `backend/native/pxii_vfs/pxii_vfs.h`, and `backend/native/vendor/sqlite3ext.h`: C17 VFS and the hash-pinned upstream extension header; this is a loadable extension for the same stock SQLite library, not a replacement SQLite build.
- Create `backend/CMakeLists.txt`, `backend/cmake/pxii-vfs-source.sha256`, `backend/cibuildwheel.toml`, and `.github/workflows/pxii-vfs-wheels.yml`: reproducible scikit-build-core/CMake/Ninja builds and CPython 3.13 Windows x64/Linux x86_64 wheel feasibility gates.
- Create `backend/scripts/verify_pxii_vfs_source_hash.py`: verify every native/header input against the committed SHA-256 manifest before build.
- Create `backend/tests/test_space_path_containment.py` and `backend/tests/test_pxii_vfs.py`: traversal, swap, virtual-name closure, WAL/rollback/locking/ORM/Alembic/cancellation/revocation, path-role collision, and no-engine/no-files proof.
- Modify `backend/tests/conftest.py`: provide the test-only `bound_sqlite_pair` fixture through package-private S1 binders; application code cannot import or invoke that fixture path.
- Create `backend/app/mcp/auth.py`: FastMCP `TokenVerifier`, trusted-stdio Adapter state, and canonical MCP error mapping.
- Modify `backend/app/mcp/server.py`: authenticated HTTP server and scope-checked tools/resources.
- Create `backend/tests/test_mcp_authorization.py`: missing/invalid/revoked/cross-Space tokens, explicit stdio trust, and canonical failures.
- Modify `backend/tests/test_mcp_server.py` and `backend/tests/test_mcp_http_lifespan.py`: inject explicit trusted principals into direct tool/lifecycle tests.
- Modify `backend/app/services/sync.py`: reject unsafe legacy truncated shapes before returning a cursor.
- Create `backend/tests/test_sync_legacy_fail_closed.py`: cross-entity and tombstone truncation rejection plus safe-page compatibility.
- Modify `backend/tests/test_sync_cursor_pagination.py`: remove the critical strict `xfail` and assert the stable upgrade error.
- Modify `backend/app/services/sync_outbox.py`: disable floor advancement and ledger prune pending ACK.
- Modify `backend/app/services/tombstone.py`: disable tombstone expiry cleanup pending ACK.
- Modify `backend/app/routes/v1/trash.py`: keep `/cleanup` present but fail closed through the shared error contract.
- Modify `backend/tests/test_sync_ledger_retention.py`, `backend/tests/test_tombstone_service.py`, `backend/tests/test_routes_v1.py`, and `backend/tests/test_sync_routes.py`: prove no retention mutation occurs.
- Modify `backend/alembic/env.py`: terminate the default combined migration environment with named-environment instructions.
- Create `backend/tests/test_alembic_entrypoints.py`: default failure and named Meta/Space success.
- Modify `.github/workflows/ci.yml`: explicit external artifact root, JUnit/log creation, failure upload, and success cleanup.
- Create `backend/tests/test_ci_artifact_lifecycle.py`: workflow ordering and lifecycle contract.

## Interfaces Locked By S1

```python
type JsonValue = None | bool | int | float | str | list[JsonValue] | dict[str, JsonValue]


def deep_freeze_json(value: object) -> object: ...
def thaw_json(value: object) -> JsonValue: ...
def to_wire_json(value: object) -> JsonValue: ...


@dataclass(frozen=True, slots=True)
class DomainErrorRecord:
    code: str
    message: str
    retryable: bool
    request_id: str
    details: Mapping[str, Any]
    def to_wire_json(self) -> dict[str, JsonValue]: ...


class AppError(Exception):
    status_code: int
    legacy_error_type: str
    def to_domain_record(self, request_id: str) -> DomainErrorRecord: ...


class CredentialAuthority:
    async def bootstrap_epoch(self) -> int: ...
    async def setup(self, password: str) -> None: ...
    async def login(self, password: str) -> str: ...
    async def verify(
        self,
        token: str,
        required_scope: Literal["master", "space"] | None,
    ) -> Principal: ...
    async def revoke(self, subject: str) -> int: ...


async def bootstrap_credential_epoch() -> int: ...


async def verify_with_fresh_meta_session(
    token: str,
    required_scope: Literal["master", "space"] | None,
) -> Principal: ...


class AuthorizedSpaceScope:
    async def open(
        self,
        principal: Principal,
        space_id: str,
        mode: Literal["read", "write"],
    ) -> AuthorizedSpaceScopeResult: ...


@dataclass(frozen=True, slots=True)
class ContainedSpacePaths:
    space_root: Path
    db_path: Path
    notes_dir: Path
    index_db: Path


@dataclass(frozen=True, slots=True)
class AsyncEngineOptions:
    echo: bool = False
    pool_size: int = 5
    max_overflow: int = 10
    busy_timeout_ms: int = 5_000


@dataclass(frozen=True, slots=True)
class MaintenanceOptions:
    read_only: bool
    create_if_missing: bool = False
    busy_timeout_ms: int = 5_000


class BoundSQLiteTarget:
    @property
    def identity(self) -> StorageIdentity: ...
    def make_async_engine(self, options: AsyncEngineOptions) -> AsyncEngine: ...
    def open_maintenance(
        self, options: MaintenanceOptions
    ) -> ContextManager[sqlite3.Connection]: ...
    async def aclose(self) -> None: ...


class SQLiteReplacementAuthority:
    @property
    def target(self) -> BoundSQLiteTarget: ...
    def checkpoint_and_seal_source(self) -> tuple[int, int, int]: ...
    def commit_bound_replace(self) -> StorageIdentity: ...
    def discard_closed_replacement(self) -> None: ...


def begin_bound_replacement(
    source: BoundSQLiteTarget,
) -> SQLiteReplacementAuthority: ...


def bind_marked_isolated_target(
    *,
    parent_path: Path,
    exact_absent_basename: str,
    marker_basename: str,
    marker_nonce: str,
) -> tuple[BoundSQLiteTarget, object]: ...


def commit_closed_isolated_target(
    cleanup_authority: object, identity: StorageIdentity
) -> None: ...


def discard_closed_isolated_target(
    cleanup_authority: object, identity: StorageIdentity
) -> None: ...


class BoundDirectoryHandle:
    @property
    def identity(self) -> StorageIdentity: ...
    def open_child_no_follow(self, relative_name: str, flags: int) -> BinaryIO: ...


class ContainedSpaceOpens:
    @property
    def database_target(self) -> BoundSQLiteTarget: ...
    @property
    def index_target(self) -> BoundSQLiteTarget: ...
    def require_all_existing_roles(self) -> None: ...
    def take_database_target(self) -> BoundSQLiteTarget: ...
    def take_file_system_handles(
        self,
    ) -> tuple[BoundDirectoryHandle, BoundSQLiteTarget]: ...


class SpaceContainmentCapability:
    def open_verified(self) -> AsyncContextManager[ContainedSpaceOpens]: ...


class SpaceEngineManager:
    async def get_session(
        self,
        space_id: str,
        opens: ContainedSpaceOpens,
    ) -> AsyncSession: ...


async def open_contained_file_system(
    opens: ContainedSpaceOpens,
) -> FileSystem: ...
```

S1's `AuthorizedSpaceScopeResult` contains only the verified principal, Space ID, mode, and privately constructed `containment: SpaceContainmentCapability`. `ContainedSpacePaths` retains exactly `space_root`, `db_path`, `notes_dir`, and `index_db`, but is only a non-authority snapshot passed privately into the capability factory; it is not a result field, runtime export, or storage-consumer parameter. `ContainedSpaceOpens` exposes no raw path and transfers only already-open/identity-bound resources. S2 keeps the same `open(principal, space_id, mode)` entrypoint, consumes `open_verified()` inside `SpaceRuntime`, and narrows the final return to `SpaceRuntimeHandle`.

### Task 1: Add The Shared Canonical Error Record And REST Adapters

**Files:**
- Modify: `backend/app/errors.py`
- Modify: `backend/app/schemas/common.py`
- Create: `backend/tests/test_error_contract_v2.py`
- Modify: `backend/tests/test_openapi_contract.py`

**Interfaces:**
- Consumes: existing `AppError` subclasses, request IDs, REST v1 schemas, and JSON-safe error details.
- Produces: frozen `DomainErrorRecord`, sole recursive `to_wire_json`, exact v1 adapters, opt-in v2 media, headers, and OpenAPI contracts.

- [ ] **Step 1: Write failing exact-body, canonical-media, and header tests**

Create `backend/tests/test_error_contract_v2.py`:

```python
from __future__ import annotations

import ast
from dataclasses import FrozenInstanceError, fields
from pathlib import Path

import pytest

CANONICAL_ACCEPT = "application/vnd.pomodoroxii.error+json;version=2"


def test_domain_error_record_is_frozen() -> None:
    from app.errors import DomainErrorRecord

    record = DomainErrorRecord(
        code="auth_required",
        message="Authentication required",
        retryable=False,
        request_id="req-fixed",
        details={},
    )
    with pytest.raises(FrozenInstanceError):
        record.code = "changed"  # type: ignore[misc]
    assert [field.name for field in fields(record)] == [
        "code", "message", "retryable", "request_id", "details"
    ]


def test_domain_error_record_deep_freezes_and_thaws_nested_json() -> None:
    from app.errors import DomainErrorRecord, to_wire_json

    source = {"recovery": {"actions": ["retry"], "attempt": 1}}
    record = DomainErrorRecord(
        code="lease_timeout",
        message="Lease timed out",
        retryable=True,
        request_id="req-nested",
        details=source,
    )
    source["recovery"]["actions"].append("mutated")
    with pytest.raises(TypeError):
        record.details["new"] = True  # type: ignore[index]
    assert record.details["recovery"]["actions"] == ("retry",)

    wire = record.to_wire_json()
    assert wire == to_wire_json(record)
    assert wire["details"] == {"recovery": {"actions": ["retry"], "attempt": 1}}
    wire["details"]["recovery"]["actions"].append("wire-only")
    assert record.details["recovery"]["actions"] == ("retry",)


def test_errors_module_is_the_only_recursive_wire_serializer_owner() -> None:
    app_root = Path(__file__).resolve().parents[1] / "app"
    owners = []
    for source_path in app_root.rglob("*.py"):
        tree = ast.parse(source_path.read_text(encoding="utf-8"))
        if any(
            isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            and node.name == "to_wire_json"
            for node in ast.walk(tree)
        ):
            owners.append(source_path.relative_to(app_root).as_posix())
    assert owners == ["errors.py"]
    error_source = (app_root / "errors.py").read_text(encoding="utf-8")
    assert "asdict(" not in error_source
    assert "dict(self.details)" not in error_source


@pytest.mark.asyncio
async def test_rest_v1_auth_body_remains_exact_and_adds_canonical_headers(client) -> None:
    response = await client.get(
        "/api/v1/auth/verify",
        headers={"X-Request-ID": "req-v1"},
    )
    assert response.status_code == 401
    assert response.json() == {
        "detail": "Missing or invalid Authorization header",
        "error_type": "authentication_error",
    }
    assert response.headers["X-PomodoroXII-Error-Code"] == "auth_required"
    assert response.headers["X-PomodoroXII-Retryable"] == "false"
    assert response.headers["X-Request-ID"] == "req-v1"


@pytest.mark.asyncio
async def test_rest_v2_auth_body_is_exact_canonical_record(client) -> None:
    response = await client.get(
        "/api/v1/auth/verify",
        headers={"Accept": CANONICAL_ACCEPT, "X-Request-ID": "req-v2"},
    )
    assert response.status_code == 401
    assert response.headers["content-type"].startswith(CANONICAL_ACCEPT)
    assert response.json() == {
        "code": "auth_required",
        "message": "Missing or invalid Authorization header",
        "retryable": False,
        "request_id": "req-v2",
        "details": {},
    }


@pytest.mark.asyncio
async def test_v1_validation_keys_stay_top_level_and_v2_puts_issues_in_details(client) -> None:
    legacy = await client.post("/api/v1/auth/setup", json={})
    assert set(legacy.json()) == {"detail", "error_type", "errors"}
    canonical = await client.post(
        "/api/v1/auth/setup", json={}, headers={"Accept": CANONICAL_ACCEPT}
    )
    assert set(canonical.json()) == {
        "code", "message", "retryable", "request_id", "details"
    }
    assert canonical.json()["code"] == "validation_error"
    assert canonical.json()["details"]["errors"]


@pytest.mark.asyncio
async def test_rest_v2_thaws_nested_frozen_details_without_mutating_carrier(
    client, nested_error_endpoint
) -> None:
    response = await client.get(
        nested_error_endpoint,
        headers={"Accept": CANONICAL_ACCEPT, "X-Request-ID": "req-nested"},
    )
    assert response.status_code == 409
    assert response.json() == {
        "code": "version_conflict",
        "message": "Version conflict",
        "retryable": False,
        "request_id": "req-nested",
        "details": {"resolution": {"kind": "local", "versions": [1, 2]}},
    }
```

Define `nested_error_endpoint` in the same test module. It installs a test-only route that raises an `AppError` whose source details contain a nested dict/list, mutates the source after exception construction, and removes the route during teardown. The expected response above must retain the pre-mutation frozen value.

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```powershell
.\backend\.venv\Scripts\python.exe -m pytest -q backend/tests/test_error_contract_v2.py -p no:cacheprovider
```

Expected: FAIL because `DomainErrorRecord` and canonical media negotiation do not exist.

- [ ] **Step 3: Implement the canonical record without changing legacy bodies**

Add to `backend/app/errors.py`:

```python
from collections.abc import Mapping
from dataclasses import dataclass, field, fields, is_dataclass
import math
from types import MappingProxyType
from typing import Any

CANONICAL_ERROR_MEDIA_TYPE = "application/vnd.pomodoroxii.error+json;version=2"


type JsonValue = None | bool | int | float | str | list[JsonValue] | dict[str, JsonValue]


def deep_freeze_json(value: object) -> object:
    if isinstance(value, Mapping):
        if not all(isinstance(key, str) for key in value):
            raise TypeError("JSON object keys must be strings")
        return MappingProxyType({
            key: deep_freeze_json(item) for key, item in value.items()
        })
    if isinstance(value, (tuple, list)):
        return tuple(deep_freeze_json(item) for item in value)
    if isinstance(value, float) and not math.isfinite(value):
        raise TypeError("JSON numbers must be finite")
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    raise TypeError(f"unsupported JSON value: {type(value).__name__}")


def thaw_json(value: object) -> JsonValue:
    if isinstance(value, Mapping):
        if not all(isinstance(key, str) for key in value):
            raise TypeError("JSON object keys must be strings")
        return {key: thaw_json(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [thaw_json(item) for item in value]
    if isinstance(value, float) and not math.isfinite(value):
        raise TypeError("JSON numbers must be finite")
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    raise TypeError(f"unsupported JSON value: {type(value).__name__}")


def to_wire_json(value: object) -> JsonValue:
    if is_dataclass(value) and not isinstance(value, type):
        return {
            item.name: to_wire_json(getattr(value, item.name))
            for item in fields(value)
        }
    return thaw_json(value)


@dataclass(frozen=True, slots=True)
class DomainErrorRecord:
    code: str
    message: str
    retryable: bool
    request_id: str
    details: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        frozen = deep_freeze_json(self.details)
        if not isinstance(frozen, Mapping):
            raise TypeError("error details must be a JSON object")
        object.__setattr__(self, "details", frozen)

    def to_wire_json(self) -> dict[str, JsonValue]:
        wire = to_wire_json(self)
        if not isinstance(wire, dict):
            raise TypeError("domain error did not serialize to an object")
        return wire
```

`app/errors.py::to_wire_json(value: object) -> JsonValue` is the single shared serializer owner. S3 and S4 import it; neither `app/sync/contracts.py` nor an Adapter defines another recursive dataclass/mapping serializer. It must handle nested dataclasses, mapping proxies/frozen mappings, tuples/lists, and JSON scalars, and reject non-string keys, non-finite floats, bytes, `Path`, callables, and unknown objects.

Change `AppError` to keep `status_code` and `legacy_error_type`, while retaining an `error_type` compatibility property for existing callers. Add `code`, `retryable`, and a `details` snapshot recursively copied/frozen with `deep_freeze_json` in the constructor; `DomainErrorRecord` independently revalidates/freezes its input, so caller mutation after exception construction cannot change the eventual response. Add:

```python
def to_domain_record(self, request_id: str) -> DomainErrorRecord:
    return DomainErrorRecord(
        code=self.code,
        message=self.detail,
        retryable=self.retryable,
        request_id=request_id,
        details=self.details,
    )
```

Set aliases exactly:

```python
AuthenticationError: code="auth_required", legacy_error_type="authentication_error"
AuthorizationError: code="forbidden", legacy_error_type="authorization_error"
NotFoundError: code="space_not_found" only in the Space-specific subclass; generic remains code="not_found"
ConflictError: code="conflict", legacy_error_type="conflict"
ValidationError: code="validation_error", legacy_error_type="validation_error"
SyncCursorExpiredError: code="cursor_expired", legacy_error_type="sync_cursor_expired"
```

The AppError handler obtains `request_id_var.get()` while the middleware context is active, renders the legacy body by default, and renders `record.to_wire_json()` only when the exact canonical media type is accepted. `dataclasses.asdict(record)`, `dict(record.details)`, `copy.deepcopy`, and any Adapter-local thaw are forbidden because persisted S3/S4 details may contain nested `MappingProxyType` and tuples. For both forms set:

```python
headers = {
    "X-PomodoroXII-Error-Code": record.code,
    "X-PomodoroXII-Retryable": str(record.retryable).lower(),
    "X-Request-ID": record.request_id,
}
```

Keep `floor`, `current_cursor`, and `recovery_action` in the existing v1 Sync body; put them under canonical `details` for v2. Apply the same negotiation to request validation and unexpected 500 errors. Never include exception text, SQL, tokens, passwords, or absolute paths in an unexpected response.

Add `CanonicalErrorResponse` with exactly the five fields to `backend/app/schemas/common.py`, and document both `application/json` and the canonical media type plus all three headers in OpenAPI. Update `test_openapi_contract.py` so `application/json` continues to reference only the existing legacy schemas and the canonical media references only `CanonicalErrorResponse`.

- [ ] **Step 4: Run error and OpenAPI tests**

Run:

```powershell
.\backend\.venv\Scripts\python.exe -m pytest -q backend/tests/test_errors.py backend/tests/test_error_contract_v2.py backend/tests/test_openapi_contract.py -p no:cacheprovider
```

Expected: all tests pass; default v1 bodies remain exact; v2 bodies have exactly five keys; nested frozen details thaw to JSON-native copies without `asdict`/pickle failures; headers use canonical codes.

- [ ] **Step 5: Commit**

```powershell
git add backend/app/errors.py backend/app/schemas/common.py backend/tests/test_error_contract_v2.py backend/tests/test_openapi_contract.py
git commit -m "feat: add shared backend error contract"
```

### Task 2: Enforce Secret And Password Byte Policies With Async Bcrypt

**Files:**
- Modify: `backend/app/settings.py`
- Modify: `backend/app/auth/security.py`
- Create: `backend/tests/test_security_policy.py`
- Modify: `backend/tests/test_settings.py`
- Modify: `backend/tests/test_auth_security.py`

**Interfaces:**
- Consumes: parsed settings, UTF-8 password bytes, JWT claims, and bcrypt primitives.
- Produces: 12-64-byte non-truncating password policy, production secret gate, async bcrypt wrappers, and mandatory epoch-bearing token codecs.

- [ ] **Step 1: Write failing byte-boundary and event-loop tests**

Create `backend/tests/test_security_policy.py`:

```python
from __future__ import annotations

import asyncio

import pytest


@pytest.mark.parametrize("password", ["", "x" * 11, "x" * 65, "\u5bc6" * 22])
def test_password_policy_rejects_outside_12_to_64_utf8_bytes(password: str) -> None:
    from app.auth.security import validate_password_policy

    with pytest.raises(ValueError, match="12 to 64 UTF-8 bytes"):
        validate_password_policy(password)


@pytest.mark.parametrize("password", ["x" * 12, "x" * 64, "\u5bc6" * 4, "\u5bc6" * 21])
def test_password_policy_accepts_boundaries(password: str) -> None:
    from app.auth.security import validate_password_policy

    assert validate_password_policy(password) == password.encode("utf-8")


def test_bcrypt_no_longer_creates_72_byte_aliases() -> None:
    from app.auth.security import hash_password

    with pytest.raises(ValueError, match="12 to 64 UTF-8 bytes"):
        hash_password("a" * 72 + "first")
    with pytest.raises(ValueError, match="12 to 64 UTF-8 bytes"):
        hash_password("a" * 72 + "second")


```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```powershell
.\backend\.venv\Scripts\python.exe -m pytest -q backend/tests/test_security_policy.py backend/tests/test_settings.py backend/tests/test_auth_security.py -p no:cacheprovider
```

Expected: FAIL because bcrypt truncates at 72 bytes and production accepts some secrets shorter than 32 bytes. Task 2 does not import the authority Module that Task 3 creates.

- [ ] **Step 3: Implement byte policy and production secret validation**

In `backend/app/auth/security.py`, replace slicing with:

```python
MIN_PASSWORD_BYTES = 12
MAX_PASSWORD_BYTES = 64


def validate_password_policy(password: str) -> bytes:
    encoded = password.encode("utf-8")
    if not MIN_PASSWORD_BYTES <= len(encoded) <= MAX_PASSWORD_BYTES:
        raise ValueError("Password must be 12 to 64 UTF-8 bytes")
    return encoded


def hash_password(password: str) -> str:
    encoded = validate_password_policy(password)
    return bcrypt.hashpw(encoded, bcrypt.gensalt(rounds=12)).decode("utf-8")


def verify_password(password: str, hashed: str) -> bool:
    try:
        encoded = validate_password_policy(password)
    except ValueError:
        return False
    return bcrypt.checkpw(encoded, hashed.encode("utf-8"))
```

JWT codec functions accept a required keyword-only `epoch: int` and include it in both master and Space payloads. Decoding continues to verify signature, algorithm, and expiry; epoch comparison belongs to `CredentialAuthority` in Task 3.

In `backend/app/settings.py`, use a Pydantic `model_validator(mode="after")` so `environment` is available. Development retains its current default; production rejects empty, known-default, or `<32` UTF-8-byte secrets with the existing generation guidance.

Update old truncation tests to assert rejection, and add production tests for 31/32 ASCII bytes and 30/33 UTF-8 bytes.

- [ ] **Step 4: Run security primitive tests**

Run:

```powershell
.\backend\.venv\Scripts\python.exe -m pytest -q backend/tests/test_security_policy.py backend/tests/test_settings.py backend/tests/test_auth_security.py -p no:cacheprovider
```

Expected: all tests pass; no function slices password bytes; production accepts exactly 32 strong bytes and rejects 31.

- [ ] **Step 5: Commit**

```powershell
git add backend/app/settings.py backend/app/auth/security.py backend/tests/test_security_policy.py backend/tests/test_settings.py backend/tests/test_auth_security.py
git commit -m "feat: enforce credential byte policies"
```

### Task 3: Implement CredentialAuthority, Epoch Rollout, And Revocation

**Files:**
- Create: `backend/app/auth/authority.py`
- Modify: `backend/app/routes/v1/auth.py`
- Modify: `backend/app/routes/v1/spaces.py`
- Modify: `backend/app/schemas/auth.py`
- Modify: `backend/app/deps.py`
- Modify: `backend/app/main.py`
- Create: `backend/tests/test_auth_concurrency.py`
- Modify: `backend/tests/test_routes_auth_spaces.py`
- Modify: `backend/tests/test_integration.py`
- Modify: `backend/tests/test_notes_patch_content.py`
- Modify: `backend/tests/test_notes_search.py`
- Modify: `backend/tests/test_notes_versions.py`
- Modify: `backend/tests/test_openapi_contract.py`
- Modify: `backend/tests/test_put_routes.py`
- Modify: `backend/tests/test_quick_note_convert.py`
- Modify: `backend/tests/test_registry_integration.py`
- Modify: `backend/tests/test_response_contract.py`
- Modify: `backend/tests/test_routes_meta.py`
- Modify: `backend/tests/test_routes_pagination.py`
- Modify: `backend/tests/test_routes_v1.py`
- Modify: `backend/tests/test_prod_hardening.py`

**Interfaces:**
- Consumes: fresh Meta sessions, Task 2 security primitives, exact token scope, and S1 error adapters.
- Produces: `CredentialAuthority`, epoch bootstrap/setup/login/verify/revoke, stateless fresh-session helpers, and updated REST dependency flows.

- [ ] **Step 1: Write failing concurrency, epoch, and revoke tests**

Create `backend/tests/test_auth_concurrency.py` with:

```python
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import jwt
import pytest


@pytest.mark.asyncio
async def test_credential_bcrypt_runs_through_to_thread(monkeypatch) -> None:
    from app.auth.authority import CredentialAuthority

    calls: list[tuple[object, tuple[object, ...]]] = []

    async def fake_to_thread(function, *args):
        calls.append((function, args))
        return "$2b$12$" + "x" * 53

    monkeypatch.setattr(asyncio, "to_thread", fake_to_thread)
    await CredentialAuthority.hash_for_storage("test-password-123")
    assert calls and calls[0][1] == ("test-password-123",)


@pytest.mark.asyncio
async def test_concurrent_setup_has_one_created_and_one_stable_conflict(client) -> None:
    responses = await asyncio.gather(*[
        client.post("/api/v1/auth/setup", json={"password": "test-password-123"})
        for _ in range(2)
    ])
    assert sorted(response.status_code for response in responses) == [201, 409]
    conflict = next(response for response in responses if response.status_code == 409)
    assert conflict.json() == {
        "detail": "Admin password is already set",
        "error_type": "conflict",
    }


@pytest.mark.asyncio
async def test_epoch_one_is_issued_and_pre_epoch_token_is_rejected(client) -> None:
    from app.settings import settings

    await client.post("/api/v1/auth/setup", json={"password": "test-password-123"})
    login = await client.post(
        "/api/v1/auth/login", json={"password": "test-password-123"}
    )
    issued = jwt.decode(
        login.json()["access_token"], settings.secret_key, algorithms=[settings.algorithm]
    )
    assert issued["epoch"] == 1
    legacy = jwt.encode(
        {
            "sub": "admin",
            "type": "master",
            "exp": datetime.now(timezone.utc) + timedelta(hours=1),
        },
        settings.secret_key,
        algorithm=settings.algorithm,
    )
    rejected = await client.get(
        "/api/v1/auth/verify", headers={"Authorization": f"Bearer {legacy}"}
    )
    assert rejected.status_code == 401


@pytest.mark.asyncio
async def test_revoke_advances_epoch_and_invalidates_master_and_space_tokens(client) -> None:
    await client.post("/api/v1/auth/setup", json={"password": "test-password-123"})
    login = await client.post(
        "/api/v1/auth/login", json={"password": "test-password-123"}
    )
    master = login.json()["access_token"]
    created = await client.post(
        "/api/v1/spaces",
        json={"name": "epoch"},
        headers={"Authorization": f"Bearer {master}"},
    )
    space = await client.post(
        f"/api/v1/spaces/{created.json()['id']}/token",
        headers={"Authorization": f"Bearer {master}"},
    )
    revoked = await client.post(
        "/api/v1/auth/revoke", headers={"Authorization": f"Bearer {master}"}
    )
    assert revoked.status_code == 200
    for token in (master, space.json()["space_token"]):
        response = await client.get(
            "/api/v1/auth/verify", headers={"Authorization": f"Bearer {token}"}
        )
        assert response.status_code == 401
    relogin = await client.post(
        "/api/v1/auth/login", json={"password": "test-password-123"}
    )
    assert relogin.status_code == 200
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```powershell
.\backend\.venv\Scripts\python.exe -m pytest -q backend/tests/test_auth_concurrency.py -p no:cacheprovider
```

Expected: FAIL because setup is check-then-insert, tokens have no epoch, and `/auth/revoke` is absent.

- [ ] **Step 3: Implement CredentialAuthority and thin REST Adapters**

Create `backend/app/auth/authority.py` with these contracts:

```python
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Literal

from sqlalchemy import Integer, cast, select, update
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.security import (
    create_master_token, decode_access_token, hash_password, verify_password
)
from app.db.models.meta import MetaSetting, Space
from app.errors import AuthenticationError, AuthorizationError, ConflictError, ValidationError

PASSWORD_KEY = "admin_password"
EPOCH_KEY = "credential_epoch"


@dataclass(frozen=True, slots=True)
class Principal:
    subject: str
    token_type: Literal["master", "space", "trusted_stdio"]
    epoch: int
    expires_at: int | None
    space_id: str | None = None


class CredentialAuthority:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    @staticmethod
    async def hash_for_storage(password: str) -> str:
        return await asyncio.to_thread(hash_password, password)

    @staticmethod
    async def verify_hash(password: str, hashed: str) -> bool:
        return await asyncio.to_thread(verify_password, password, hashed)

    async def bootstrap_epoch(self) -> int:
        statement = sqlite_insert(MetaSetting).values(key=EPOCH_KEY, value="1")
        await self.db.execute(statement.on_conflict_do_nothing(index_elements=["key"]))
        await self.db.commit()
        value = await self.db.scalar(
            select(MetaSetting.value).where(MetaSetting.key == EPOCH_KEY)
        )
        if value is None:
            raise RuntimeError("credential epoch bootstrap did not persist")
        return int(value)


async def bootstrap_credential_epoch() -> int:
    factory = get_meta_session_factory()
    async with factory() as db:
        return await CredentialAuthority(db).bootstrap_epoch()


async def verify_with_fresh_meta_session(
    token: str,
    required_scope: Literal["master", "space"] | None,
) -> Principal:
    factory = get_meta_session_factory()
    async with factory() as db:
        return await CredentialAuthority(db).verify(token, required_scope)
```

Import `get_meta_session_factory` from `app.db.meta_session`. The two module helpers above create a fresh, short-lived Meta session and delegate all policy decisions to `CredentialAuthority`; they do not decode JWTs, inspect epochs, or query settings themselves.

Implement `setup` with one SQLite `INSERT ... ON CONFLICT DO NOTHING` for `admin_password`, check `rowcount == 1`, insert epoch `1` with the same conflict-safe pattern, and commit the two settings atomically. Roll back and raise `ConflictError("Admin password is already set")` for the loser.

`CredentialAuthority.bootstrap_epoch(self) -> int` is the only epoch initialization implementation. FastAPI `main.lifespan` calls `bootstrap_credential_epoch()` immediately after `init_meta_db` and before readiness or request serving. Implement `login` by loading both settings, running `verify_hash` outside the event loop, and returning `create_master_token("admin", epoch=epoch)`. Invalid length, missing setup, and wrong credentials all return the existing `AuthenticationError("Invalid password")` to avoid a password-policy oracle.

Implement `verify` to decode signature/expiry, require non-empty `sub`, an exact token type, integer `epoch`, equality with the stored epoch, required scope, and registered Space existence for a Space token. Missing or stale epoch raises `AuthenticationError("Invalid or expired token")`; scope mismatch raises `AuthorizationError`; missing Space raises the stable Space-not-found domain error.

Implement `revoke(subject)` only for `subject == "admin"`; atomically increment the stored epoch using `UPDATE ... SET value = CAST(value AS INTEGER) + 1 RETURNING value`, commit, and return the new integer.

REST changes:

- `setup_password` calls `CredentialAuthority(db).setup`.
- `login` calls `CredentialAuthority(db).login`.
- `get_current_user` calls `verify(..., required_scope=None)` and returns legacy-compatible claims including `sub`, `type`, `space_id`, `epoch`, and `exp`.
- `require_master_token` verifies `type == master` through the authority result.
- `POST /auth/revoke` requires master auth, revokes the current subject, and returns exactly `{"message": "Tokens revoked"}`.
- `issue_space_token` uses the already verified master principal's epoch when calling `create_space_token`.
- `GET /auth/verify` preserves its exact existing success body.

Replace every S1-listed test setup/login literal `test123` with `test-password-123`; leave deliberately wrong credentials unchanged. In `backend/tests/test_prod_hardening.py` and route-level tests, replace raw `create_master_token`/`create_space_token` setup with public `POST /auth/setup`, `POST /auth/login`, `POST /spaces`, and `POST /spaces/{id}/token` flows so all successful tokens carry the persisted epoch. Raw JWT construction remains only in tests whose asserted subject is an intentionally malformed, epochless, expired, or wrong-scope token.

- [ ] **Step 4: Run auth, route, and production compatibility tests**

Run:

```powershell
.\backend\.venv\Scripts\python.exe -m pytest -q backend/tests/test_security_policy.py backend/tests/test_auth_concurrency.py backend/tests/test_routes_auth_spaces.py backend/tests/test_prod_hardening.py backend/tests/test_openapi_contract.py -p no:cacheprovider
```

Expected: all tests pass; concurrent setup produces one 201/one 409; epochless and revoked tokens produce stable 401 responses; bcrypt calls are offloaded.

- [ ] **Step 5: Commit**

```powershell
git add backend/app/auth/authority.py backend/app/routes/v1/auth.py backend/app/routes/v1/spaces.py backend/app/schemas/auth.py backend/app/deps.py backend/app/main.py backend/tests/test_auth_concurrency.py backend/tests/test_routes_auth_spaces.py backend/tests/test_integration.py backend/tests/test_notes_patch_content.py backend/tests/test_notes_search.py backend/tests/test_notes_versions.py backend/tests/test_openapi_contract.py backend/tests/test_put_routes.py backend/tests/test_quick_note_convert.py backend/tests/test_registry_integration.py backend/tests/test_response_contract.py backend/tests/test_routes_meta.py backend/tests/test_routes_pagination.py backend/tests/test_routes_v1.py backend/tests/test_prod_hardening.py
git commit -m "feat: centralize credential authority"
```

Before committing, inspect `git diff --cached --name-only` and unstage any test file not listed in this task.

### Task 4: Prove Authorized Space Containment Before Storage Creation

#### Task 4 architecture amendment: S1 native storage is Windows-only

This amendment supersedes every later S1 Task 4 reference to a Linux/POSIX supported runtime, Linux wheel, multi-platform receipt/manifest, Linux capability probe, or POSIX deferred-delete runtime acceptance gate. Those references are retained only as historical design context and are not executable S1 requirements.

**S1 platform support contract.** Windows x64 on CPython 3.13 is the only supported native `pxii-vfs` runtime in S1. A production request that would initialize or use contained native storage on Linux or another POSIX platform must fail before extension bootstrap, SQLite connection creation, companion enumeration, or storage I/O with stable canonical code `platform_unsupported`, HTTP status 501, `retryable=false`, and no host path or native SQLite error in the response. Linux must never silently run, downgrade, or surface `SQLITE_IOERR_DELETE`/`disk I/O error` as if deferred deletion succeeded.

**Evidence contract.** Task 4 GO requires one Windows CPython 3.13 x64 wheel built from the candidate commit, a Windows JUnit run with tests greater than zero and failures/errors/skipped all zero, a canonical Windows build receipt whose source-tree hash matches the candidate, and an independent subject manifest with `subject_sha == HEAD`, Git object type `commit`, and platform set exactly `["windows-x86_64"]`. S1 does not build or publish a Linux wheel, does not require a Linux receipt, and does not accept Linux runtime evidence.

**Platform-track transfer.** Linux native `pxii-vfs` runtime, Linux wheels, POSIX exact/deferred-delete compatibility, Linux receipts/manifests, and Linux filesystem capability gates move together to S5 or an independently authorized Platform Track. That later track must define its own runtime capability probe, WAL/journal behavior, recovery inventory, artifact closure, and GO gate; it cannot inherit Windows S1 certification.

**Retained fail-closed defense.** Existing POSIX C branches remain fail-closed and may not restore pathname `unlinkat`, quarantine names, sleeps, race hooks, or successful delete receipts. They are defense-in-depth for accidental invocation, not a supported S1 runtime. S1 GO additionally requires static and runtime tests proving the production Linux entry returns `platform_unsupported` before loading `pxii-vfs` or opening storage.

The following POSIX analysis records why Linux was removed from S1; it does not define S1 acceptance evidence.

**POSIX proof.** `openat`/`fstat` authenticates an inode at time `t0`, but `unlinkat(dirfd, basename, 0)` resolves the directory entry again at time `t1`. A same-permission concurrent actor can rename the authenticated inode away and install a different inode at the same basename in `(t0, t1)`. Holding the authenticated fd, repeating `fstat`, adding a sleep, or rechecking after `unlinkat` cannot make the already-issued pathname deletion undoable. Standard POSIX has no portable `unlinkat`-by-fd or exact-object delete primitive.

**Threat-model evaluation.**

| Option | Security claim | SQLite/operational cost | Decision |
| --- | --- | --- | --- |
| A. Single backend / controlled data-root | A deployment may restrict directory mutation to the backend UID and trusted operators. This is useful operational hardening, but it is not a library-level guarantee against an arbitrary same-UID actor and cannot close the S1 contract. | Normal WAL/journal cleanup remains available, but the proof depends on deployment policy outside this Module. | Reject as the S1 correctness contract. |
| B. POSIX physical delete fail-closed | S1 never performs a POSIX companion pathname delete. It returns a stable deferred-delete error and preserves both the verified object and any replacement. S5 recovery later owns a separately authorized physical cleanup capability. | WAL/checkpoint or rollback-journal close may leave a companion behind and must propagate the stable deferred-delete error; no durability or cleanup success is claimed. Recovery must account for retained `-wal`, `-shm`, and `-journal` files before any later deletion. | **Selected.** |
| C. Linux handle-based capability gate | Enable physical delete only when a future Linux-specific capability proves an exact-object primitive for the mounted filesystem; otherwise fail closed. The capability probe and evidence contract are not available in S1 and must not silently downgrade to pathname `unlinkat`. | Capability absence makes WAL/journal cleanup deferred; capability presence requires a new S5-owned probe and artifact binding. | Reserved for S5, not implemented in S1. |

**Historical POSIX contract.** The current POSIX branch returns `pxii_posix_delete_deferred`/`SQLITE_IOERR_DELETE` without pathname `unlinkat` and publishes no successful delete receipt. This behavior is not S1 runtime support and is not a Task 4 GO condition; production Linux admission must reject earlier with `platform_unsupported`.

**Native acceptance contract.** S1 executes Windows identity-bound deletion, replacement rejection, WAL/journal recovery, cleanup, and wheel-install tests. It also executes a Linux admission regression that asserts `platform_unsupported`, zero extension bootstrap, zero SQLite/native opens, and zero storage I/O. POSIX native runtime tests and Linux wheel execution belong only to S5/Platform Track. No S1 test may accept a quarantine name, sleep, post-delete recheck, `SQLITE_IOERR_DELETE`, or disk I/O error as successful behavior.

The Windows native wheel job is the only S1 wheel job. The required Windows regression remains `test_windows_companion_delete_uses_bound_delete_handle`; the Linux admission regression is named `test_linux_native_storage_returns_platform_unsupported_before_bootstrap`.

**S5 recovery-only delete authority.** S5 may define a Linux capability probe and recovery-only delete authority after it proves the mounted filesystem, kernel primitive, namespace ownership, crash behavior, and receipt binding. Until then, retained companions are recovery inventory, not evidence of successful deletion.

**Files:**
- Create: `backend/app/runtime/__init__.py`
- Create: `backend/app/runtime/scope.py`
- Create: `backend/app/runtime/contained_io.py`
- Create: `backend/app/runtime/sqlite_vfs.py`
- Create: `backend/app/runtime/joined_thread.py`
- Modify: `backend/pyproject.toml`
- Modify: `backend/uv.lock`
- Create: `backend/CMakeLists.txt`
- Create: `backend/cmake/pxii-vfs-source.sha256`
- Create: `backend/cibuildwheel.toml`
- Create: `backend/native/pxii_vfs/pxii_vfs.c`
- Create: `backend/native/pxii_vfs/pxii_vfs.h`
- Create: `backend/native/vendor/sqlite3ext.h`
- Create: `backend/scripts/verify_pxii_vfs_source_hash.py`
- Create: `.github/workflows/pxii-vfs-wheels.yml`
- Modify: `.github/workflows/ci.yml`
- Modify: `backend/app/deps.py`
- Modify: `backend/app/space_manager.py`
- Modify: `backend/app/file_system/api.py`
- Modify: `backend/app/file_system/engine/base.py`
- Modify: `backend/app/file_system/engine/note_ops.py`
- Modify: `backend/app/file_system/engine/folder_ops.py`
- Modify: `backend/app/file_system/engine/search_ops.py`
- Modify: `backend/app/file_system/engine/trash_ops.py`
- Modify: `backend/app/file_system/engine/version_ops.py`
- Modify: `backend/app/file_system/engine/export_ops.py`
- Modify: `backend/app/file_system/engine/consistency_ops.py`
- Modify: `backend/app/file_system/engine/__init__.py`
- Modify: `backend/app/main.py`
- Modify: `backend/app/settings.py`
- Modify: `backend/app/file_system/backup.py`
- Modify: `backend/app/errors.py`
- Create: `backend/tests/test_space_path_containment.py`
- Create: `backend/tests/test_pxii_vfs.py`
- Modify: `backend/tests/test_deps_space_validation.py`
- Modify: `backend/tests/test_deps.py`
- Modify: `backend/tests/test_space_manager.py`
- Create: `backend/tests/test_file_system/test_api.py`
- Modify: `backend/tests/test_backup_lifespan.py`
- Modify: `backend/tests/test_settings.py`
- Modify: `backend/tests/fixtures/certification/populate_n_minus_one.py`
- Modify: `backend/tests/conftest.py`

**Interfaces:**
- Consumes: an epoch-verified `Principal`, exact Meta registration, canonical spaces-root anchor, and a private four-field `ContainedSpacePaths` snapshot.
- Produces: `AuthorizedSpaceScopeResult.containment`, `open_verified() -> AsyncContextManager[ContainedSpaceOpens]`, public `run_joined_thread(call, *, on_success=None, dispose_cancelled_result=None)`, private/general `run_joined_awaitable(awaitable, *, on_success=None, dispose_cancelled_result=None)`, and the closed `BoundSQLiteTarget.identity`/`make_async_engine(options)`/`open_maintenance(options)`/`aclose()` surface. Storage consumers receive only transferred opaque handles/SQLite targets; callers never receive a host path, virtual URI/token, fd/HANDLE, or sidecar name, and no cancelled worker may publish an orphan result.

- [ ] **Step 1: Write failing no-engine/no-file containment tests**

Create `backend/tests/test_space_path_containment.py`:

```python
from __future__ import annotations

import inspect
from dataclasses import fields
from pathlib import Path
from typing import get_type_hints

import pytest

from app.errors import PathOutsideSpaceError


def test_contained_paths_and_storage_consumer_signatures_are_closed() -> None:
    from app.file_system.api import open_contained_file_system
    from app.runtime.contained_io import ContainedSpaceOpens
    from app.runtime.scope import ContainedSpacePaths
    from app.space_manager import SpaceEngineManager

    assert [item.name for item in fields(ContainedSpacePaths)] == [
        "space_root", "db_path", "notes_dir", "index_db"
    ]
    manager = inspect.signature(SpaceEngineManager.get_session).parameters
    file_system = inspect.signature(open_contained_file_system).parameters
    assert "opens" in manager and "canonical_db_path" not in manager
    assert list(file_system) == ["opens"]
    assert (
        get_type_hints(SpaceEngineManager.get_session)["opens"]
        is ContainedSpaceOpens
    )
    assert (
        get_type_hints(open_contained_file_system)["opens"]
        is ContainedSpaceOpens
    )
    app_root = Path(__file__).resolve().parents[1] / "app"
    for relative in ("deps.py", "space_manager.py", "file_system/api.py"):
        source = (app_root / relative).read_text(encoding="utf-8")
        assert "scope_result.paths" not in source
        assert "ContainedSpacePaths" not in source
        assert ".db_path" not in source
        assert ".notes_dir" not in source


@pytest.mark.asyncio
async def test_registered_path_outside_root_fails_before_engine_creation(
    client, monkeypatch, tmp_path: Path
) -> None:
    from app.db.meta_session import get_meta_session
    from app.db.models.meta import Space
    from app.space_manager import get_space_engine_manager

    outside = tmp_path.parent / "outside-scope" / "space.db"
    async for session in get_meta_session():
        session.add(Space(
            id="spc_escape",
            name="escape",
            db_path=str(outside),
            notes_dir=str(outside.parent / "notes"),
        ))
        await session.commit()
        break
    created = False

    async def forbidden_get_session(*args, **kwargs):
        nonlocal created
        created = True
        raise AssertionError("engine creation must not run")

    monkeypatch.setattr(get_space_engine_manager(), "get_session", forbidden_get_session)
    token = await issue_test_space_token(client, "spc_escape")
    response = await client.get(
        "/api/v1/tasks", headers={"Authorization": f"Bearer {token}"}
    )
    assert response.status_code == 403
    assert response.headers["X-PomodoroXII-Error-Code"] == "path_outside_space"
    assert created is False
    assert outside.exists() is False


@pytest.mark.asyncio
async def test_unregistered_traversal_id_creates_nothing(client, tmp_path: Path) -> None:
    token = await sign_test_space_token(client, "../../escaped")
    response = await client.get(
        "/api/v1/tasks", headers={"Authorization": f"Bearer {token}"}
    )
    assert response.status_code in {401, 404}
    assert not (tmp_path.parent / "escaped").exists()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "fault_point",
    [
        "after_final_check_before_kernel_open",
        "before_sqlite_bound_connect",
        "before_filesystem_handle_open",
    ],
)
async def test_ancestor_swap_fails_inside_actual_open_primitive(
    containment_fixture, fault_point: str
) -> None:
    scope = await containment_fixture.authorized_scope()
    containment_fixture.swap_parent_to_outside_at(fault_point)

    with pytest.raises(PathOutsideSpaceError):
        await containment_fixture.open_consumers(scope)

    assert containment_fixture.engine_open_count == 0
    assert containment_fixture.file_system_open_count == 0
    assert containment_fixture.outside_files() == []


@pytest.mark.asyncio
async def test_external_swap_after_final_check_cannot_redirect_kernel_open(
    containment_fixture,
) -> None:
    scope = await containment_fixture.authorized_scope()
    gate = containment_fixture.pause_after_final_check_before_kernel_open()
    opening = asyncio.create_task(containment_fixture.open_consumers(scope))
    await gate.reached.wait()
    containment_fixture.swap_parent_to_outside_now()
    gate.resume.set()

    with pytest.raises(PathOutsideSpaceError):
        await opening

    assert containment_fixture.outside_files() == []
    assert containment_fixture.path_based_sqlite_open_count == 0
    assert containment_fixture.path_based_file_system_open_count == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "collision", ["notes_equals_db", "notes_equals_index", "db_equals_index"]
)
async def test_storage_path_roles_must_be_pairwise_distinct(
    containment_fixture, collision: str
) -> None:
    containment_fixture.register_role_collision(collision)
    with pytest.raises(PathOutsideSpaceError, match="roles overlap"):
        await containment_fixture.authorized_scope()
    assert containment_fixture.total_storage_open_count == 0
```

Add these lock regressions to the same file. `open_twice_in_owner_task` enters the same capability twice in one Task; `hold_scope_until` and `enter_scope_and_signal` are complete local async helpers that set their entered event only after `open_verified()` returns and always release through their context manager:

```python
@pytest.mark.asyncio
async def test_containment_lock_is_reentrant_for_the_same_task(
    containment_fixture,
) -> None:
    scope = await containment_fixture.authorized_scope()
    async with asyncio.timeout(2):
        async with scope.containment.open_verified():
            async with scope.containment.open_verified():
                pass


@pytest.mark.asyncio
async def test_containment_lock_excludes_a_different_task(
    containment_fixture,
) -> None:
    scope = await containment_fixture.authorized_scope()
    release = asyncio.Event()
    entered = asyncio.Event()
    async with scope.containment.open_verified():
        contender = asyncio.create_task(
            containment_fixture.enter_scope_and_signal(scope, entered, release)
        )
        with pytest.raises(TimeoutError):
            async with asyncio.timeout(0.1):
                await entered.wait()
        assert not contender.done()
    await asyncio.wait_for(entered.wait(), timeout=2)
    release.set()
    await asyncio.wait_for(contender, timeout=2)


@pytest.mark.asyncio
async def test_containment_lock_restores_owner_and_depth_after_error_and_cancel(
    containment_fixture,
) -> None:
    scope = await containment_fixture.authorized_scope()
    with pytest.raises(RuntimeError, match="body failure"):
        async with scope.containment.open_verified():
            async with scope.containment.open_verified():
                raise RuntimeError("body failure")

    cancelled = asyncio.create_task(
        containment_fixture.hold_scope_until(scope, asyncio.Event())
    )
    await containment_fixture.wait_until_scope_entered(cancelled)
    cancelled.cancel()
    with pytest.raises(asyncio.CancelledError):
        await cancelled
    async with asyncio.timeout(2):
        async with scope.containment.open_verified():
            pass


@pytest.mark.asyncio
async def test_cancelled_waiter_does_not_corrupt_containment_lock_owner(
    containment_fixture,
) -> None:
    scope = await containment_fixture.authorized_scope()
    holder_release = asyncio.Event()
    holder = asyncio.create_task(
        containment_fixture.hold_scope_until(scope, holder_release)
    )
    await containment_fixture.wait_until_scope_entered(holder)
    waiter = asyncio.create_task(containment_fixture.enter_scope_once(scope))
    await asyncio.sleep(0)
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    assert not holder.done()
    successor = asyncio.create_task(containment_fixture.enter_scope_once(scope))
    await asyncio.sleep(0)
    assert not successor.done()
    holder_release.set()
    await asyncio.wait_for(holder, timeout=2)
    await asyncio.wait_for(successor, timeout=2)
```

The interrupted implementation already produced a focused RED `TimeoutError` for the first nested-acquisition regression and a subsequent GREEN `1 passed` after a Task-reentrant prototype. Preserve that receipt as worktree-only TDD evidence and rerun all four tests at the Batch A commit SHA; it is not S1 exit evidence until then.

Add the two small helpers in the same test file using the public setup/login API and epoch-bearing `create_space_token`; do not bypass `CredentialAuthority` for the registered-space case. Add a Windows-capable symlink/junction/reparse test guarded by `pytest.skip` only when the host cannot create that primitive. Add a cached-engine regression: open `spc_bound` with one verified capability, then call the manager with the same Space ID and a capability for a different canonical path and assert a stable `SpaceEnginePathMismatchError` before a second engine or directory is created.

Add deterministic swap-race hooks at three distinct boundaries. The mandatory boundary is after the capability's final namespace/identity check but before its first kernel-relative open: replace an in-root parent with a symlink/junction/reparse point to an outside directory, then prove the anchored open cannot touch the outside target and fails before publishing `ContainedSpaceOpens`. Repeat immediately before the private VFS authority bind and immediately before Notes/index handle transfer. Linux probes swap the main name and each exact `-wal`, `-shm`, and `-journal` companion after binding; Windows probes perform the equivalent file-ID/reparse swaps. Each probe asserts zero outside reads/writes/deletes and proves SQLite saw only `file:pxii-<token>?vfs=pxii`, where the token is never returned by a public object. Add a role-collision table for `notes_dir == db_path`, `notes_dir == index_db`, and `db_path == index_db`; all fail before storage I/O.

Create `backend/tests/test_file_system/test_api.py` with contained-entry regressions. The `contained_file_system_fixture` supplies real `ContainedSpaceOpens`, initializes through `open_contained_file_system`, and retains the capability context until the FileSystem closes:

```python
from __future__ import annotations

import inspect
from pathlib import Path

import pytest


@pytest.mark.asyncio
async def test_contained_entry_never_calls_path_backed_constructor(
    contained_file_system_fixture, monkeypatch
) -> None:
    from app.file_system.api import open_contained_file_system
    from app.file_system.engine import FileSystemStorage

    def forbidden_path_constructor(*args, **kwargs):
        raise AssertionError("contained production path used path-backed constructor")

    monkeypatch.setattr(FileSystemStorage, "__init__", forbidden_path_constructor)
    async with contained_file_system_fixture.opens() as opens:
        file_system = await open_contained_file_system(opens)
        assert file_system._storage_mode == "contained"
        await file_system.close()


def test_contained_entry_and_engine_operations_have_no_path_fallback() -> None:
    from app.file_system.api import open_contained_file_system

    entry_source = inspect.getsource(open_contained_file_system)
    assert "FileSystemStorage.from_bound_handles" in entry_source
    assert "FileSystemStorage(" not in entry_source
    assert "get_file_system(" not in entry_source
    engine_root = Path(__file__).resolve().parents[2] / "app" / "file_system" / "engine"
    for name in (
        "note_ops.py", "folder_ops.py", "search_ops.py", "trash_ops.py",
        "version_ops.py", "consistency_ops.py",
    ):
        source = (engine_root / name).read_text(encoding="utf-8")
        assert "self.root" not in source
        assert "self.index_db" not in source
        assert "sqlite3.connect(" not in source


@pytest.mark.asyncio
async def test_contained_import_and_export_require_external_path_capability(
    contained_file_system_fixture, tmp_path: Path
) -> None:
    from app.errors import ExternalPathCapabilityRequiredError

    source = tmp_path / "outside.md"
    source.write_text("do not read", encoding="utf-8")
    output = tmp_path / "outside-export"
    async with contained_file_system_fixture.file_system() as file_system:
        with pytest.raises(ExternalPathCapabilityRequiredError) as imported:
            await file_system.import_from_md(str(source))
        with pytest.raises(ExternalPathCapabilityRequiredError) as exported:
            await file_system.export_folder("folder", str(output))
    assert imported.value.to_domain_record("req-import").code == (
        "external_path_capability_required"
    )
    assert exported.value.to_domain_record("req-export").code == (
        "external_path_capability_required"
    )
    assert source.read_text(encoding="utf-8") == "do not read"
    assert not output.exists()
```

Create `backend/tests/test_pxii_vfs.py` with named, real regressions rather than mocked pathname calls:

```python
def test_bound_sqlite_target_has_only_closed_public_surface() -> None:
    public = {
        name for name in dir(BoundSQLiteTarget)
        if not name.startswith("_")
    }
    assert public == {
        "identity", "make_async_engine", "open_maintenance", "aclose"
    }


def test_stock_sqlite_bootstrap_registers_pxii_vfs_in_same_library(
    pxii_vfs_fixture,
) -> None:
    receipt = pxii_vfs_fixture.bootstrap_receipt()
    assert receipt.vfs_name == "pxii-vfs"
    assert receipt.control_sqlite_source_id == receipt.extension_sqlite_source_id
    assert receipt.control_sqlite_version == receipt.extension_sqlite_version
    assert not receipt.extension_loading_enabled_after_bootstrap


def test_virtual_identifier_never_contains_or_resolves_to_host_path(
    pxii_vfs_fixture,
) -> None:
    probe = pxii_vfs_fixture.open_existing_probe()
    assert probe.sqlite_filename.startswith("file:pxii-")
    assert probe.sqlite_filename.endswith("?vfs=pxii")
    assert probe.host_path_bytes not in probe.sqlite_filename.encode("utf-8")
    assert probe.public_values_containing_token == ()


def test_main_and_reserved_companion_swaps_have_zero_outside_io(
    pxii_vfs_fixture,
) -> None:
    receipt = pxii_vfs_fixture.run_main_and_companion_swap_matrix()
    assert receipt.cases == ("main", "wal", "shm", "journal")
    assert receipt.outside_reads == receipt.outside_writes == receipt.outside_deletes == 0
    assert receipt.published_connections == 0


def test_wal_crash_recovery_and_checkpoint_use_bound_companions(
    pxii_vfs_fixture,
) -> None:
    receipt = pxii_vfs_fixture.run_wal_crash_checkpoint_probe()
    assert receipt.committed_row == "committed-before-crash"
    assert receipt.checkpoint == (0, receipt.log_frames, receipt.log_frames)
    assert receipt.pathname_open_count == 0


def test_hot_rollback_journal_recovers_without_path_reopen(pxii_vfs_fixture) -> None:
    receipt = pxii_vfs_fixture.run_hot_journal_probe()
    assert receipt.integrity_check == "ok"
    assert receipt.recovered_value == "pre-crash"
    assert receipt.pathname_open_count == 0


def test_pooled_and_cross_process_locks_match_stock_sqlite(pxii_vfs_fixture) -> None:
    receipt = pxii_vfs_fixture.run_lock_matrix()
    assert receipt.same_process_busy
    assert receipt.cross_process_busy
    assert receipt.writer_succeeds_after_release
    assert receipt.leaked_lock_count == 0


def test_async_session_savepoint_and_alembic_use_hidden_async_creator(
    pxii_vfs_fixture,
) -> None:
    receipt = pxii_vfs_fixture.run_orm_savepoint_alembic_probe()
    assert receipt.head == "space_008_sync_retention_snapshot"
    assert receipt.savepoint_rollback_preserved_outer_transaction
    assert receipt.pathname_open_count == 0


def test_cancel_connect_disposes_result_before_target_revocation(
    pxii_vfs_fixture,
) -> None:
    receipt = pxii_vfs_fixture.run_cancelled_connect_probe()
    assert isinstance(receipt.primary, asyncio.CancelledError)
    assert receipt.disposed_before_revocation
    assert receipt.live_vfs_files_after_close == 0


def test_pool_disposal_then_revocation_closes_every_vfs_file(pxii_vfs_fixture) -> None:
    receipt = pxii_vfs_fixture.run_pool_revoke_probe()
    assert receipt.engine_disposed_before_target_close
    assert receipt.live_main_files == receipt.live_temp_files == 0
    assert receipt.post_revoke_open_code == "sqlite_authority_revoked"


def test_attach_extension_loading_and_unsafe_pragmas_are_denied(
    pxii_vfs_fixture,
) -> None:
    denied = pxii_vfs_fixture.run_denied_sql_matrix()
    assert denied == {
        "attach": "not authorized",
        "detach": "not authorized",
        "load_extension": "not authorized",
        "writable_schema": "not authorized",
    }
```

`pxii_vfs_fixture` is implemented in this same test file with real subprocess crash/lock probes and OS I/O tracing; none of its receipt methods may mock SQLite, VFS callbacks, filesystem opens, Alembic, SQLAlchemy or cancellation. Each receipt is a frozen record built from observed calls/exit status and asserts a positive executed-operation count, so an empty matrix cannot pass.

The platform matrix runs these tests from the built wheel on CPython 3.13 Windows x64 and Linux x86_64. It additionally validates WAL crash/checkpoint, hot rollback-journal recovery, pooled and separate-process lock contention, `AsyncSession` transaction/savepoint behavior, Alembic upgrade, cancellation during open, pool disposal, and target revocation. A wheel that imports but uses another SQLite library, leaks a host pathname across the Module boundary, lacks required VFS methods, or performs any outside I/O fails the hard feasibility gate.

- [ ] **Step 2: Run the containment tests and verify they fail**

Run:

```powershell
.\backend\.venv\Scripts\python.exe -m pytest -q backend/tests/test_space_path_containment.py -p no:cacheprovider
```

Expected: FAIL because dependencies derive paths from `space_id`, `SpaceEngineManager` creates parent directories, and no descriptor/HANDLE-relative opaque-open boundary exists.

- [ ] **Step 3: Implement the S1-only scope result and wire dependencies**

Create `backend/app/runtime/joined_thread.py` first. `run_joined_awaitable` is package-private (it is not re-exported from `app.runtime`); S2 may import it only for release capabilities. The caller Task remains the owner, repeatedly consumes every cancellation while joining the child, and executes a synchronous `on_success` commit in that owner Task before rethrowing the original cancellation. If cancelled work produced a resource, it invokes `dispose_cancelled_result` instead of `on_success`. Later cancellations and worker/disposer failures are appended after the first cancellation in observed order:

```python
from __future__ import annotations

import asyncio
import inspect
from collections.abc import Awaitable, Callable
from typing import TypeVar

T = TypeVar("T")
Success = Callable[[T], None]
Disposer = Callable[[T], object | Awaitable[object]]
_MISSING = object()


async def _join_child(
    task: asyncio.Future[T], cancellations: list[asyncio.CancelledError]
) -> tuple[T | object, BaseException | None]:
    owner = asyncio.current_task()
    assert owner is not None
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError as error:
            if owner.cancelling():
                cancellations.append(error)
                owner.uncancel()
            elif task.done():
                break
        except BaseException:
            break
    if task.cancelled():
        return _MISSING, asyncio.CancelledError("joined worker cancelled")
    try:
        return task.result(), None
    except BaseException as error:
        return _MISSING, error


async def _run_terminal_effect(
    callback: Disposer[T],
    value: T,
    cancellations: list[asyncio.CancelledError],
) -> BaseException | None:
    try:
        effect = callback(value)
    except BaseException as error:
        return error
    if not inspect.isawaitable(effect):
        return None
    task = asyncio.ensure_future(effect)
    _ignored, error = await _join_child(task, cancellations)
    return error


async def run_joined_awaitable(
    awaitable: Awaitable[T],
    *,
    on_success: Success[T] | None = None,
    dispose_cancelled_result: Disposer[T] | None = None,
) -> T:
    worker = asyncio.ensure_future(awaitable)
    cancellations: list[asyncio.CancelledError] = []
    result, worker_error = await _join_child(worker, cancellations)
    terminal_error: BaseException | None = None
    if worker_error is None:
        assert result is not _MISSING
        if cancellations and dispose_cancelled_result is not None:
            terminal_error = await _run_terminal_effect(
                dispose_cancelled_result, result, cancellations
            )
        elif on_success is not None:
            try:
                on_success(result)
            except BaseException as error:
                terminal_error = error

    if cancellations:
        terminal_errors = [
            error for error in (worker_error, terminal_error) if error is not None
        ]
        if len(cancellations) == 1 and not terminal_errors:
            raise cancellations[0]
        raise BaseExceptionGroup(
            "joined operation cancelled with terminal failures",
            [cancellations[0], *cancellations[1:], *terminal_errors],
        ) from None
    if worker_error is not None:
        raise worker_error
    if terminal_error is not None:
        raise terminal_error
    assert result is not _MISSING
    return result


async def run_joined_thread(
    call: Callable[[], T],
    *,
    on_success: Success[T] | None = None,
    dispose_cancelled_result: Disposer[T] | None = None,
) -> T:
    return await run_joined_awaitable(
        asyncio.to_thread(call),
        on_success=on_success,
        dispose_cancelled_result=dispose_cancelled_result,
    )
```

The real tests `test_joined_accepts_precreated_future_and_custom_awaitable`, `test_joined_success_commits_before_original_cancel_is_rethrown`, `test_joined_cancelled_resource_disposes_instead_of_publishing`, and `test_double_cancel_worker_or_disposer_error_is_primary_first` drive `Future`, coroutine, and custom `Awaitable` inputs plus cancellation at worker-terminal and terminal-hook boundaries. `asyncio.ensure_future` is required because the Interface is genuinely general; using `create_task(awaitable)` is forbidden. Failure order is deterministic `[original_cancel, *later_cancels, *terminal_errors]`, never described as scheduler-observed interleaving. No terminal state is committed only in statements after an `await`.

Create `backend/app/runtime/contained_io.py` and `backend/app/runtime/scope.py`. The scope owns authorization and a private path snapshot; the platform module owns every kernel open and exports no pathname accessor:

```python
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import AsyncContextManager, AsyncIterator, Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.authority import Principal
from app.db.models.meta import Space
from app.errors import AuthorizationError, PathOutsideSpaceError, SpaceNotFoundError
from app.runtime.contained_io import (
    ContainedSpaceOpens,
    open_bound_space,
)
from app.runtime.joined_thread import run_joined_thread

AccessMode = Literal["read", "write"]


@dataclass(frozen=True, slots=True)
class ContainedSpacePaths:
    space_root: Path
    db_path: Path
    notes_dir: Path
    index_db: Path


class SpaceContainmentCapability:
    __slots__ = ("_paths", "_ancestor_identities", "_lock")

    def __init__(self, *_args, **_kwargs) -> None:
        raise TypeError("SpaceContainmentCapability is factory-only")

    @classmethod
    def _create(cls, paths: ContainedSpacePaths) -> "SpaceContainmentCapability":
        instance = object.__new__(cls)
        instance._paths = paths
        instance._ancestor_identities = _capture_safe_ancestor_identities(paths)
        instance._lock = _containment_lock_for(paths)
        return instance

    def open_verified(self) -> AsyncContextManager[ContainedSpaceOpens]:
        @asynccontextmanager
        async def verified() -> AsyncIterator[ContainedSpaceOpens]:
            async with self._lock:
                _require_same_safe_ancestors(
                    self._paths, self._ancestor_identities
                )
                await _fault_hook("after_final_check_before_kernel_open")
                opens = await run_joined_thread(
                    lambda: open_bound_space(
                        self._paths, self._ancestor_identities
                    ),
                    dispose_cancelled_result=lambda value: value.close_all(),
                )
                # open_bound_space closes all partial handles unless its anchored
                # component walk and immediate namespace recheck both succeed.
                primary: BaseException | None = None
                try:
                    yield opens
                except BaseException as error:
                    primary = error
                cleanup_errors: list[BaseException] = []
                try:
                    _require_same_safe_ancestors(
                        self._paths, self._ancestor_identities
                    )
                except BaseException as containment_error:
                    cleanup_errors.append(containment_error)
                    try:
                        await opens.revoke_transferred_resources()
                    except BaseException as revoke_error:
                        cleanup_errors.append(revoke_error)
                try:
                    await opens.close_untransferred_resources()
                except BaseException as close_error:
                    cleanup_errors.append(close_error)
                if primary is not None and cleanup_errors:
                    raise BaseExceptionGroup(
                        "storage body and containment cleanup failed",
                        [primary, *cleanup_errors],
                    ) from None
                if primary is not None:
                    raise primary
                if cleanup_errors:
                    raise BaseExceptionGroup(
                        "containment cleanup failed", cleanup_errors
                    ) from None

        return verified()


@dataclass(frozen=True, slots=True)
class AuthorizedSpaceScopeResult:
    principal: Principal
    space_id: str
    mode: AccessMode
    containment: SpaceContainmentCapability


class AuthorizedSpaceScope:
    def __init__(self, meta_db: AsyncSession, spaces_root: Path) -> None:
        self.meta_db = meta_db
        self.spaces_root = spaces_root

    async def open(
        self,
        principal: Principal,
        space_id: str,
        mode: AccessMode,
    ) -> AuthorizedSpaceScopeResult:
        if principal.token_type not in {"master", "space", "trusted_stdio"}:
            raise AuthorizationError("Token scope is not allowed")
        if principal.token_type == "space" and principal.space_id != space_id:
            raise AuthorizationError("Token is not valid for this Space")

        row = await self.meta_db.scalar(select(Space).where(Space.id == space_id))
        if row is None:
            raise SpaceNotFoundError("Space is not registered")

        paths = _lexical_registered_snapshot_without_following_links(
            self.spaces_root, row.db_path, row.notes_dir
        )
        containment = SpaceContainmentCapability._create(paths)
        return AuthorizedSpaceScopeResult(
            principal=principal,
            space_id=space_id,
            mode=mode,
            containment=containment,
        )
```

Implement `open` in this order:

1. Accept only `master`, matching `space`, or explicit `trusted_stdio` principals; reject cross-Space tokens with code `forbidden`.
2. Query the Meta `Space` row by exact ID. Reject absence with code `space_not_found`.
3. Normalize the registered `db_path`/`notes_dir` lexically without following links or creating anything, then open the already-existing `spaces_root` as the capability's no-follow root anchor.
4. Require both registered roles below that lexical root, reject every existing symlink, Windows junction/reparse point, or non-directory ancestor, and capture private `(device, inode/file-index, reparse metadata)` identities by walking from the anchored root.
5. Require `db_path.parent == notes_dir.parent`, derive `index_db` only after containment, and require all three role paths to be pairwise distinct.
6. Construct the exact four-field non-authority `ContainedSpacePaths`, consume it privately in the factory-only capability, and return `AuthorizedSpaceScopeResult` without exposing the snapshot, creating directories, opening SQLite, migrating, or calling a storage consumer.

Implement `_capture_safe_ancestor_identities` and `_require_same_safe_ancestors` for both POSIX and Windows. They use anchored handle metadata rather than string comparison, reject symlink/junction/reparse components even when their resolved target remains in-root, and compare the complete captured ancestor chain. Missing, added, replaced, retargeted, or type-changed ancestors fail with `PathOutsideSpaceError` containing no host path. `_containment_lock_for(paths)` returns one process-local Task-reentrant lock shared by every capability for that canonical Space parent. The lock stores the owning `asyncio.Task` and depth only after its underlying mutex is acquired; same-owner entry increments depth without awaiting, different Tasks await the mutex, and only depth zero clears owner then releases. `__aexit__` restores depth for normal, error, and cancellation exits. Cancellation while waiting never changes owner/depth and removes only that waiter's future. If a body error/cancellation and close/revalidation fail together, preserve the body failure first in `[primary, *cleanup_errors]`. The private identity receipt is never a field on `ContainedSpacePaths` and never serialized.

Refactor the existing `FileSystemStorage`; do not copy it into `file_system/api.py`. `engine/base.py` defines package-private `_NotesAuthority` and `_IndexAuthority` ports plus two adapter pairs. `_BoundNotesAuthority` is the relative-name-only Notes authority: it owns one transferred `BoundDirectoryHandle`, accepts only normalized relative names, rejects absolute/drive/UNC/empty/`.`/`..` components, and implements child create/read/atomic-replace/enumerate/rename/unlink/mkdir through handle-relative methods. `_BoundIndexAuthority` owns one `BoundSQLiteTarget` and every connection is `target.open_maintenance(MaintenanceOptions(...))`. `_PathNotesAuthority` and `_PathIndexAuthority` are constructed only by the legacy `(root_dir, index_db)` constructor for existing tests and the fixed N-1 fixture. The path-backed constructor remains a test/N-1 compatibility adapter. `StorageBase` stores the two ports and a private `_storage_mode`; contained mode has no `root`, `index_db`, host `Path`, connector, or stringified path field.

Modify `note_ops.py`, `folder_ops.py`, `search_ops.py`, `trash_ops.py`, `version_ops.py`, and `consistency_ops.py` so their storage I/O calls only the ports with relative names. Pure relative parsing uses `PurePosixPath`; none of these modules calls `Path.resolve`, `read_text`, `write_text`, `mkdir`, `rename`, `unlink`, `os.replace`, or `sqlite3.connect`. `engine/__init__.py::FileSystemStorage.from_bound_handles(notes_handle, index_target)` is the sole contained constructor and bypasses the path-backed `__init__` without invoking it. `file_system/api.py::open_contained_file_system(opens)` transfers the two authorities and calls only that factory. Static AST/source tests and a runtime constructor trap prove production dependencies cannot fall back to the path-backed constructor.

In `export_ops.py`, branch on `_storage_mode` before converting, normalizing, resolving, checking, reading, or creating either argument. Contained `import_from_md(file_path)` and `export_folder(output_dir)` raise `ExternalPathCapabilityRequiredError`, status 403, legacy alias `authorization_error`, canonical code `external_path_capability_required`, and retryable false. The message contains no supplied path. Path-backed tests/N-1 retain their current behavior; S1 introduces no external host-path capability.

`contained_io.py` is normative, not a best-effort wrapper. On POSIX, each `open_bound_space` call opens an `O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC` root descriptor, verifies its captured identity, and traverses each role component with `openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS)` or the single-component `openat`/`O_NOFOLLOW` fallback; compare every `fstat` receipt before publishing an opaque handle. On Windows, each call opens and verifies the root directory HANDLE, then opens descendants with `NtCreateFile` relative to the retained `RootDirectory`, requests reparse-point inspection, rejects any reparse component, and omits `FILE_SHARE_DELETE`. The swap hook between final namespace check and first kernel open must still produce no outside I/O: root/component identity mismatch closes every partial handle, and an immediate namespace recheck occurs inside `open_bound_space` before return. `run_joined_thread`/`run_joined_awaitable` repeatedly join worker and terminal effects after cancellation; a successful non-resource operation executes `on_success` in its owner Task before the original cancellation is re-raised, while a cancelled resource producer invokes its disposer instead of its publisher. `test_cancel_during_bound_open_joins_worker_and_closes_every_handle` covers POSIX and Windows fault hooks and proves zero orphan descriptor/HANDLE/SQLite target.

`sqlite_vfs.py` is a deep native authority-bound SQLite Module. At controlled bootstrap it locates the packaged extension binary, verifies `cmake/pxii-vfs-source.sha256`, opens one private stock-`sqlite3` control connection, enables extension loading only long enough to load that exact binary, confirms the extension and Python report the same `sqlite3_libversion`, registers `pxii-vfs`, and disables loading before any caller can obtain an Adapter. This bootstrap path discovery is allowed; a database host path is not. Every other connection has extension loading disabled, an authorizer that denies `ATTACH`/`DETACH`, `load_extension`, writable-schema controls, and the closed unsafe-PRAGMA set, plus a URI that is never logged or exposed.

 The private control connection binds a cryptographically random, unforgeable virtual token to duplicated already-open parent/main authority, or to a one-shot isolated-create authority whose exact absent basename was proved beneath an anchored parent. SQLite receives only `file:pxii-<token>?vfs=pxii`; `xFullPathname` preserves a virtual identifier and never resolves or returns a host pathname. `xOpen` dispatches on one validated stock open class: `SQLITE_OPEN_MAIN_DB` duplicates the bound main object; `SQLITE_OPEN_MAIN_JOURNAL` and `SQLITE_OPEN_WAL` accept only exact `<main>-journal` and `<main>-wal`, while `xShmMap` owns exact `<main>-shm`, all beneath the duplicated parent. Linux uses `openat2`/`openat` for companion opens and S1 companion `xDelete` fails closed; Windows uses `NtCreateFile(RootDirectory=parent_handle)` with no reparse traversal. Anonymous temporary files retain their separate unlink authority. `SQLITE_OPEN_SUPER_JOURNAL` is explicitly rejected because `ATTACH` is denied, rather than falling through to a host VFS. Arbitrary suffixes, absolute/relative host names, traversal, unknown/revoked tokens, create-on-existing mismatches, multiple primary class bits, and unsupported flag combinations fail before I/O.

`SQLITE_OPEN_TEMP_DB`, `SQLITE_OPEN_TRANSIENT_DB`, `SQLITE_OPEN_TEMP_JOURNAL`, and `SQLITE_OPEN_SUBJOURNAL` are anonymous authority-owned files even when stock SQLite supplies a suggested `zName`; `zName == NULL` is accepted only for those classes or `SQLITE_OPEN_MEMORY`. They use a private temp-root handle created at bootstrap: Linux prefers `O_TMPFILE` and otherwise uses random `openat` followed immediately by `unlinkat`; Windows uses random `NtCreateFile` relative to the retained temp `RootDirectory` with delete-on-close and no reparse. `SQLITE_OPEN_MEMORY` is heap-backed and never enters a namespace. `SQLITE_OPEN_DELETEONCLOSE` is valid only with an anonymous temp/memory class and must physically delete on last deferred close. No class delegates to the default VFS or treats SQLite's suggested temp name as host authority.

The C17 extension implements complete `xOpen`, `xAccess`, `xDelete`, and `xFullPathname`, ordinary read/write/truncate/file-size/sync and directory-sync behavior, `xLock`/`xUnlock`/`xCheckReservedLock`, `xFileControl`, `xSectorSize`, `xDeviceCharacteristics`, and WAL `xShmMap`/`xShmLock`/`xShmBarrier`/`xShmUnmap`. Its identity registry supplies SQLite-compatible pooled and cross-process locks. POSIX close is deferred per `(device,inode)` lock group so closing a duplicated descriptor cannot drop another live SQLite lock; deferred descriptors, mapped SHM, anonymous temp files, and delete-on-close state drain only after the last VFS file/lock owner. Windows duplicates HANDLEs and preserves share/byte-range-lock semantics. `xSync`, POSIX companion xDelete (which is S1 deferred/fail-closed), parent fsync, WAL checkpoint, hot-journal recovery, revocation, and extension shutdown all report failures rather than claiming durability. Real tests exercise savepoint subjournals, external sorts, TEMP tables/indexes, transient databases, hot main journals, `zName == NULL`, every single open-class flag, POSIX deferred-delete behavior, and every ambiguous pair; platform I/O tracing must remain inside the bound main parent or private temp root with zero outside access.

`BoundSQLiteTarget` owns the private control binding but exposes exactly `identity`, `make_async_engine(options)`, `open_maintenance(options)`, and `aclose()`. `AsyncEngineOptions` and `MaintenanceOptions` are the concrete immutable option records above; construction rejects negative pool values, non-positive timeouts, and `read_only=True` combined with `create_if_missing=True`. `create_if_missing=True` is accepted only when the target itself carries a one-shot isolated-create authority for an exact absent basename; it cannot turn an existing-target binding into create authority. `make_async_engine` internally supplies SQLAlchemy a hidden aiosqlite `async_creator`; `open_maintenance` is the only synchronous stock-`sqlite3` Adapter. No caller can retrieve the URI/token/fd/HANDLE/companion or a raw connector. `aclose()` first revokes new opens, awaits pool/connection disposal and outstanding VFS references, then removes the token binding. Direct file-backed `sqlite3.connect`/`aiosqlite.connect` outside this Module and every database `str(Path)` argument are forbidden by AST tests. `BoundDirectoryHandle` performs every Note child operation relative to its held directory handle. `ContainedSpaceOpens` is private-constructor, has no path property, and supports one-time transfer with revocation; a failed exit revalidation revokes every provisional cache/filesystem resource before return.

`backend/tests/conftest.py::bound_sqlite_pair` is the only shared test fixture allowed to request one existing and one exact-absent bound target from the package-private S1 test binder. The binder is reachable only from the tests package under pytest, returns the same opaque public types, and still uses anchored no-follow opens plus `pxii-vfs`; production modules importing the test binder fail the AST gate. Tests may call `open_maintenance(options)` on those targets but may not call file-backed `sqlite3.connect`, inspect virtual identifiers, or derive companion names.

`SQLiteReplacementAuthority`、`begin_bound_replacement`、`bind_marked_isolated_target`、`commit_closed_isolated_target`和`discard_closed_isolated_target`只定义在 `app.runtime.sqlite_vfs`，不从 `app.runtime` re-export，也不允许 route/service直接导入。Replacement authority只接受一个 live source target，私有绑定同父目录的随机 absent basename，关闭全部 source/replacement connections后才能 checkpoint/seal、write-through replace或discard；每个 terminal operation都幂等记录physical receipt。Isolated binder重新打开并核验 marker/parent，原子证明 main及所有companion class absent；commit/discard只接受 binder返回的opaque cleanup authority和exact identity。它们不增加 `BoundSQLiteTarget` 的四成员 public surface，也不返回 host path、virtual token或companion name。

Pin `scikit-build-core`, CMake, and Ninja build requirements in `backend/pyproject.toml`/`uv.lock`; compile with `C_STANDARD 17`, hidden symbols, warnings-as-errors, and no bundled SQLite library. `backend/cmake/pxii-vfs-source.sha256` covers `pxii_vfs.c`, `pxii_vfs.h`, and the exact vendored `sqlite3ext.h`; `verify_pxii_vfs_source_hash.py` runs before local and wheel builds. `backend/cibuildwheel.toml` and reusable `.github/workflows/pxii-vfs-wheels.yml` build/install/test CPython 3.13 Windows x64 and Linux x86_64 wheels in clean environments, inspect the wheel file list, reject an embedded SQLite library, and run the full feasibility matrix before S1 can pass.

`backend/CMakeLists.txt`至少包含以下真实 target；`pxii_vfs.c`中的唯一 exported entrypoint是 `sqlite3_pxiivfs_init`，其余 symbols hidden：

```cmake
cmake_minimum_required(VERSION 3.30...3.31)
project(pxii_vfs LANGUAGES C)

add_library(pxii_vfs MODULE
  native/pxii_vfs/pxii_vfs.c
  native/pxii_vfs/pxii_vfs.h
  native/vendor/sqlite3ext.h
)
target_compile_features(pxii_vfs PRIVATE c_std_17)
target_include_directories(pxii_vfs PRIVATE native/vendor native/pxii_vfs)
set_target_properties(pxii_vfs PROPERTIES
  C_VISIBILITY_PRESET hidden
  VISIBILITY_INLINES_HIDDEN YES
  PREFIX ""
  OUTPUT_NAME "_pxii_vfs"
)
if(MSVC)
  target_compile_options(pxii_vfs PRIVATE /W4 /WX)
else()
  target_compile_options(pxii_vfs PRIVATE -Wall -Wextra -Wpedantic -Werror)
endif()
install(TARGETS pxii_vfs
  LIBRARY DESTINATION pomodoroxii_native
  RUNTIME DESTINATION pomodoroxii_native
)
```

Reusable workflow的 build/test job固定为下面的 Windows-only 结构；aggregator job下载唯一 Windows platform artifact，调用同一个 source-hash工具的 `--assemble-wheel-manifest` 模式独立重算 wheel/member/extension hashes与build ID，然后才上传唯一稳定 artifact：

```yaml
name: pxii-vfs-wheels
on:
  workflow_call:
permissions:
  contents: read
jobs:
  wheel:
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: windows-2025
            platform_id: windows-x86_64
            cibw_arch: AMD64
    runs-on: ${{ matrix.os }}
    env:
      CIBW_BUILD: cp313-*
      CIBW_ARCHS: ${{ matrix.cibw_arch }}
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
      - uses: actions/setup-python@42375524e23c412d93fb67b49958b491fce71c38
        with:
          python-version: '3.13'
      - uses: astral-sh/setup-uv@e92bafb6253dcd438e0484186d7669ea7a8ca1cc
      - name: Sync locked build and test tools without building the project
        shell: pwsh
        run: |
          uv sync --project backend --frozen --no-install-project
          if ($LASTEXITCODE -ne 0) { throw "locked tool sync failed" }
      - name: Verify native source closure
        shell: pwsh
        run: python backend/scripts/verify_pxii_vfs_source_hash.py
      - name: Build one CPython 3.13 wheel
        shell: pwsh
        run: |
          $python = if ($IsWindows) { 'backend/.venv/Scripts/python.exe' } else { 'backend/.venv/bin/python' }
          & $python -m cibuildwheel --output-dir wheelhouse backend
          if ($LASTEXITCODE -ne 0) { throw "wheel build failed" }
      - name: Install and execute native feasibility matrix
        shell: pwsh
        run: |
          $python = if ($IsWindows) { 'backend/.venv/Scripts/python.exe' } else { 'backend/.venv/bin/python' }
          $wheel = @(Get-ChildItem -LiteralPath wheelhouse -Filter *.whl -File)
          if ($wheel.Count -ne 1) { throw "expected exactly one wheel" }
          uv pip install --python $python --no-index --no-deps $wheel[0].FullName
          if ($LASTEXITCODE -ne 0) { throw "wheel install failed" }
          & $python -m pytest -q backend/tests/test_pxii_vfs.py -p no:cacheprovider --junitxml=.test-results/pxii-vfs.xml
          if ($LASTEXITCODE -ne 0) { throw "native feasibility matrix failed" }
          & $python backend/scripts/verify_pxii_vfs_source_hash.py --emit-build-receipt ${{ matrix.platform_id }} --wheel $wheel[0].FullName --junit .test-results/pxii-vfs.xml --output wheelhouse/build-receipt.json
          if ($LASTEXITCODE -ne 0) { throw "build receipt failed" }
      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
        with:
          name: pxii-vfs-${{ matrix.platform_id }}
          path: wheelhouse/
          if-no-files-found: error
  manifest:
    needs: wheel
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
      - uses: actions/setup-python@42375524e23c412d93fb67b49958b491fce71c38
        with:
          python-version: '3.13'
      - uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093
        with:
          pattern: pxii-vfs-*
          path: ${{ runner.temp }}/pxii-vfs-inputs
      - name: Assemble closed Windows-only manifest
        run: python backend/scripts/verify_pxii_vfs_source_hash.py --assemble-wheel-manifest "${RUNNER_TEMP}/pxii-vfs-inputs" --subject-sha "${GITHUB_SHA}" --output pxii-vfs-wheel-manifest.json
      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
        with:
          name: pxii-vfs-wheel-manifest-v1
          path: pxii-vfs-wheel-manifest.json
          if-no-files-found: error
```

`verify_pxii_vfs_source_hash.py`的三个模式共用 canonical JSON writer；build receipt拒绝零测试、skip、非零 exit、额外 wheel、embedded SQLite library或extension/control SQLite identity不等，aggregator要求 platform ID集合恰为 `["windows-x86_64"]`并重新读取所有 artifact bytes，不能信任 receipt自报 hash。

`.github/workflows/ci.yml` invokes that reusable Windows-only job and publishes the stable artifact `pxii-vfs-wheel-manifest-v1`, containing one canonical JSON manifest with source-tree SHA-256, each native input hash, OS/architecture/CPython/compiler/CMake/Ninja/scikit-build-core/cibuildwheel IDs, wheel filename/hash/size, and unpacked extension filename/hash/size/build-id for Windows. CI downloads and rehashes the uploaded wheel before accepting the manifest. Linux image/release and POSIX capability work are deferred to S5/Platform Track; they may not silently consume this Windows-only evidence as Linux support. S5/S6 bind the stable artifact name and manifest schema into their producer closure.

Define Space-specific AppError subclasses for `space_not_found` and `path_outside_space`, with legacy aliases `not_found` and `authorization_error`. Error messages never include the rejected host path.

In `get_space_context`, reconstruct the frozen `Principal`, obtain a Meta session, call `AuthorizedSpaceScope.open(..., mode="read")`, and return the legacy dict plus a private `scope_result` entry. `get_space_db` and `get_file_system` each enter `scope_result.containment.open_verified()` and pass only the yielded `ContainedSpaceOpens` to their consumer. The manager stores the first `BoundSQLiteTarget.identity` under the Space ID while holding its manager lock; a later open for that ID must match exactly or raise `SpaceEnginePathMismatchError` before returning a cached engine or transferring a target. Disposal removes engine, bound target, and identity. The filesystem retains only transferred directory/index handles. Keying only by `space_id`, accepting `ContainedSpacePaths`, constructing a URL/path, or reopening by path fails this task. Write dependencies that mutate with `mode="write"` in S2 when Unit of Work is introduced; S1's route-level mode does not claim transaction enforcement.

```python
async def get_session(
    self, space_id: str, opens: ContainedSpaceOpens
) -> AsyncSession:
    target = opens.take_database_target()
    engine = target.make_async_engine(self._engine_options(space_id))
    return await self._open_bound_session(space_id, target, engine)


async def open_contained_file_system(
    opens: ContainedSpaceOpens,
) -> FileSystem:
    notes_handle, index_target = opens.take_file_system_handles()
    return await _open_file_system_with_bound_handles(notes_handle, index_target)
```

The returned filesystem retains only bound handles, and every later Note/index child operation is relative to them. The engine manager retains the `BoundSQLiteTarget` and calls only `target.make_async_engine(options)`; the target's hidden creator revalidates its live authority before each checkout and never consumes a cached host path. Engine disposal completes before `target.aclose()`. The capability owns provisional-transfer revocation until `open_verified()` exits successfully, so one successful namespace check never becomes pathname authority.

Commit Task 4 in three implementation batches before the final integration batch. Each command is repository-root-relative and each path belongs to exactly one batch:

**Batch A - scope, Task-reentrant lock, and joined cancellation**

```powershell
git add backend/app/runtime/__init__.py backend/app/runtime/scope.py backend/app/runtime/contained_io.py backend/app/runtime/joined_thread.py backend/app/errors.py backend/tests/test_space_path_containment.py
git commit -m "feat: add reentrant containment scope"
```

**Batch B - native pxii-vfs and platform build**

```powershell
git add backend/app/runtime/sqlite_vfs.py backend/pyproject.toml backend/uv.lock backend/CMakeLists.txt backend/cmake/pxii-vfs-source.sha256 backend/cibuildwheel.toml backend/native/pxii_vfs/pxii_vfs.c backend/native/pxii_vfs/pxii_vfs.h backend/native/vendor/sqlite3ext.h backend/scripts/verify_pxii_vfs_source_hash.py .github/workflows/pxii-vfs-wheels.yml backend/tests/test_pxii_vfs.py backend/tests/conftest.py
git commit -m "feat: bind sqlite through pxii vfs"
```

**Batch C - handle-relative FileSystem engine**

```powershell
git add backend/app/file_system/api.py backend/app/file_system/engine/base.py backend/app/file_system/engine/note_ops.py backend/app/file_system/engine/folder_ops.py backend/app/file_system/engine/search_ops.py backend/app/file_system/engine/trash_ops.py backend/app/file_system/engine/version_ops.py backend/app/file_system/engine/export_ops.py backend/app/file_system/engine/consistency_ops.py backend/app/file_system/engine/__init__.py backend/tests/test_file_system/test_api.py
git commit -m "feat: route filesystem through storage authorities"
```

- [ ] **Step 4: Run containment and dependency tests**

Run:

```powershell
.\backend\.venv\Scripts\python.exe backend/scripts/verify_pxii_vfs_source_hash.py
.\backend\.venv\Scripts\python.exe -m pytest -q backend/tests/test_space_path_containment.py backend/tests/test_deps_space_validation.py backend/tests/test_deps.py backend/tests/test_space_manager.py backend/tests/test_file_system/test_api.py -p no:cacheprovider
.\backend\.venv\Scripts\python.exe -m pytest -q backend/tests/test_pxii_vfs.py -p no:cacheprovider
.\backend\.venv\Scripts\python.exe -m cibuildwheel --print-build-identifiers
```

Expected: all tests pass; source hashes match; traversal, registered escape, symlink/junction/reparse escape, role overlap, and every injected main/companion swap create no outside I/O. The final-check-to-kernel-open swap cannot redirect either platform opener; SQLite receives only virtual identifiers, while filesystem children remain identity/handle-bound. Static signatures expose no `Path`, `ContainedSpacePaths`, URI/token/fd/HANDLE/sidecar, or raw connector. cibuildwheel lists only CPython 3.13 Windows x64 and Linux x86_64; CI installs both wheels, passes the WAL, rollback-journal, cross-process lock, AsyncSession/savepoint, Alembic, cancellation, pool-disposal, and revocation feasibility tests, then publishes and independently rehashes `pxii-vfs-wheel-manifest-v1` with both wheel/extension build identities.

After the commands pass, create the final integration batch:

**Batch D - dependency integration, crash recovery, and platform evidence**

```powershell
git add .github/workflows/ci.yml backend/app/deps.py backend/app/space_manager.py backend/tests/test_deps_space_validation.py backend/tests/test_deps.py backend/tests/test_space_manager.py
git commit -m "test: close contained storage integration"
```

S1 does not implement backup snapshot or restore; those capabilities remain owned by S5. It only removes the production-callable legacy path-backed startup backup. `backup_enabled` defaults to `False`. When disabled, application startup performs zero backup storage I/O and never enumerates a Space path. When explicitly enabled, startup fails before Meta or Space storage initialization with `LegacyBackupConfigurationError` and stable code `legacy_backup_unsupported`; it must not log-and-continue or silently degrade. `backend/app/file_system/backup.py` contains no production-callable `sqlite3.connect(str(path))` or equivalent host-path connector. The fixed N-1 fixture sets `POMODOROXII_BACKUP_ENABLED=false` explicitly so its historical data construction does not depend on the application default.

**Batch E - fail closed on the legacy startup backup**

```powershell
git add backend/app/main.py backend/app/settings.py backend/app/file_system/backup.py backend/tests/test_backup_lifespan.py backend/tests/test_settings.py backend/tests/fixtures/certification/populate_n_minus_one.py
git commit -m "fix: fail closed on legacy startup backup"
```

The focused regressions include `test_backup_enabled_defaults_false`, `test_disabled_backup_performs_no_backup_storage_io`, `test_enabled_legacy_backup_fails_before_storage_initialization`, and `test_backup_module_has_no_path_backed_sqlite_connector`.

- [ ] **Step 5: Review all five Task 4 batches**

Run one independent specification review and one independent native/storage security review across Batch A-E. Reviewers must verify Task-reentrant lock cancellation semantics, no production path-backed constructor call, relative-name-only Notes operations, `BoundSQLiteTarget.open_maintenance` as the sole index connector, contained import/export fail-closed behavior, legacy startup backup fail-closed behavior, native VFS swap/locking/recovery, and both platform receipts. Do not enter Task 5 until both reviews accept every Task 4 gate. If review changes are required, stage each corrected file with its owning Batch A-E command; do not stage a directory or unrelated retained artifacts.

### Task 5: Authenticate FastMCP HTTP And Require Explicit Trusted Stdio

**Files:**
- Create: `backend/app/mcp/auth.py`
- Modify: `backend/app/mcp/server.py`
- Create: `backend/tests/test_mcp_authorization.py`
- Modify: `backend/tests/test_mcp_server.py`
- Modify: `backend/tests/test_mcp_http_lifespan.py`

**Interfaces:**
- Consumes: epoch-aware credential verification, `AuthorizedSpaceScope`, HTTP bearer input, and explicit `--trusted-stdio` state.
- Produces: FastMCP `TokenVerifier`, authenticated HTTP transport, scope-checked tools/resources, and canonical MCP error records.

- [ ] **Step 1: Write failing HTTP verifier, cross-Space, and stdio-mode tests**

Create `backend/tests/test_mcp_authorization.py` with tests that assert:

```python
@pytest.mark.asyncio
async def test_http_verifier_rejects_missing_epoch(meta_session):
    verifier = PomodoroTokenVerifier()
    assert await verifier.verify_token(epochless_token()) is None


@pytest.mark.asyncio
async def test_http_verifier_returns_fastmcp_access_token_for_valid_space_token(
    configured_space_token,
):
    access = await PomodoroTokenVerifier().verify_token(configured_space_token)
    assert access is not None
    assert access.subject == "admin"
    assert access.scopes == ["space:spc_test"]
    assert access.claims["epoch"] == 1


def test_stdio_requires_explicit_trust(monkeypatch):
    monkeypatch.setattr("sys.argv", ["mcp", "--transport", "stdio"])
    with pytest.raises(SystemExit):
        main()


def test_http_rejects_trusted_stdio_flag(monkeypatch):
    monkeypatch.setattr(
        "sys.argv", ["mcp", "--transport", "http", "--trusted-stdio"]
    )
    with pytest.raises(SystemExit):
        main()


@pytest.mark.asyncio
async def test_rest_and_mcp_share_nested_frozen_error_wire_json(
    client, nested_error_endpoint, trusted_stdio_tool_runner
):
    rest = await client.get(
        nested_error_endpoint,
        headers={"Accept": CANONICAL_ACCEPT, "X-Request-ID": "req-parity"},
    )
    mcp = await trusted_stdio_tool_runner.raise_same_nested_app_error(
        request_id="req-parity"
    )
    assert mcp == rest.json()
    assert mcp == {
        "code": "version_conflict",
        "message": "Version conflict",
        "retryable": False,
        "request_id": "req-parity",
        "details": {"resolution": {"kind": "local", "versions": [1, 2]}},
    }
```

Also test that a valid token for Space A cannot run a Space B tool; an unregistered or outside-root Space returns canonical JSON with `code`, `message`, `retryable`, `request_id`, and `details`; verifier revocation is observed without restarting FastMCP. The nested parity fixture raises the same preconstructed `AppError` through the real REST handler and FastMCP tool-error Adapter after mutating its original nested dict/list. Both paths must import `app.errors.to_wire_json`; static source checks reject `asdict`, `deepcopy`, `dict(error.details)`, or another `def to_wire_json` below `app/mcp` or `app/sync`.

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```powershell
.\backend\.venv\Scripts\python.exe -m pytest -q backend/tests/test_mcp_authorization.py -p no:cacheprovider
```

Expected: FAIL because FastMCP has no `TokenVerifier`, direct tools bypass authorization, and stdio is implicitly trusted.

- [ ] **Step 3: Implement the installed FastMCP 3 authentication API**

Create `backend/app/mcp/auth.py` using the installed signatures:

```python
from fastmcp.server.auth import AccessToken, TokenVerifier
from fastmcp.server.dependencies import get_access_token


class PomodoroTokenVerifier(TokenVerifier):
    async def verify_token(self, token: str) -> AccessToken | None:
        try:
            principal = await verify_with_fresh_meta_session(
                token, required_scope=None
            )
        except AppError:
            return None
        scopes = (
            ["master"]
            if principal.token_type == "master"
            else [f"space:{principal.space_id}"]
        )
        return AccessToken(
            token=token,
            client_id=principal.subject,
            subject=principal.subject,
            scopes=scopes,
            expires_at=principal.expires_at,
            claims={
                "sub": principal.subject,
                "type": principal.token_type,
                "space_id": principal.space_id,
                "epoch": principal.epoch,
            },
        )
```

Construct `FastMCP(..., auth=PomodoroTokenVerifier())`. The standalone `app.mcp.server.main` startup order is fixed as argument validation, `init_meta_db()`, `bootstrap_credential_epoch()`, then `mcp.run(...)`; neither HTTP nor trusted stdio may begin serving before the helper returns epoch `1` or the current persisted epoch. Its existing `finally` still disposes Space engines and closes Meta. A FastMCP server mounted under FastAPI consumes FastAPI's already-completed lifespan bootstrap and does not initialize a second epoch authority. Add startup-order assertions for both standalone transports to `test_mcp_http_lifespan.py`.

Add a transport Adapter state object that is false by default and becomes trusted only after CLI parsing accepts `--transport stdio --trusted-stdio`. Reject `--trusted-stdio` with HTTP and reject stdio without it. A trusted stdio principal is:

```python
Principal(
    subject="trusted-stdio",
    token_type="trusted_stdio",
    epoch=0,
    expires_at=None,
)
```

For HTTP, derive the principal from `get_access_token().claims`; never trust tool arguments for identity. Every Space tool calls `AuthorizedSpaceScope.open` before `get_space_session`, and that session function accepts `AuthorizedSpaceScopeResult`, not raw `space_id`. Master-only tools/resources reject Space principals. Convert `AppError.to_domain_record(request_id)` with the imported `app.errors.to_wire_json` for FastMCP tool errors so nested mapping proxies/tuples and all five canonical fields survive rather than becoming prose. S4 imports this same owner and must not recreate it in `sync/contracts.py`.

Update direct MCP tests to enter an explicit test-only trusted-stdio context; do not set trust globally at import time.

- [ ] **Step 4: Run MCP and containment tests**

Run:

```powershell
.\backend\.venv\Scripts\python.exe -m pytest -q backend/tests/test_mcp_authorization.py backend/tests/test_mcp_server.py backend/tests/test_mcp_http_lifespan.py backend/tests/test_space_path_containment.py -p no:cacheprovider
```

Expected: all tests pass; unauthorized HTTP never reaches a tool; cross-Space and outside-root requests never create storage; stdio starts only with explicit trust.

- [ ] **Step 5: Commit**

```powershell
git add backend/app/mcp/auth.py backend/app/mcp/server.py backend/tests/test_mcp_authorization.py backend/tests/test_mcp_server.py backend/tests/test_mcp_http_lifespan.py
git commit -m "feat: authenticate MCP transports"
```

### Task 6: Reject Unsafe Legacy Sync Cursor Shapes

**Files:**
- Modify: `backend/app/errors.py`
- Modify: `backend/app/services/sync.py`
- Create: `backend/tests/test_sync_legacy_fail_closed.py`
- Modify: `backend/tests/test_sync_cursor_pagination.py`

**Interfaces:**
- Consumes: legacy timestamp cursor, entity/tombstone page shape, requested limit, and stable S1 errors.
- Produces: either a provably complete legacy page or `cursor_upgrade_required`; never a truncating cursor advance.

- [ ] **Step 1: Write failing unsafe-shape and compatibility tests**

Create `backend/tests/test_sync_legacy_fail_closed.py`:

```python
from __future__ import annotations

import pytest


@pytest.mark.asyncio
async def test_legacy_cross_entity_truncation_raises_upgrade_error(space_session) -> None:
    seed_three_old_tasks_and_one_newer_quick_note(space_session)
    from app.errors import CursorUpgradeRequiredError
    from app.services.sync import SyncService

    with pytest.raises(CursorUpgradeRequiredError) as raised:
        await SyncService(space_session).pull(since="", limit=2)
    assert raised.value.to_domain_record("req-sync").code == "cursor_upgrade_required"
    assert raised.value.details == {"truncated_groups": ["tasks"]}


@pytest.mark.asyncio
async def test_legacy_untruncated_page_remains_compatible(space_session) -> None:
    seed_two_tasks(space_session)
    page = await SyncService(space_session).pull(since="", limit=2)
    assert [item["id"] for item in page["tasks"]] == ["task-1", "task-2"]
    assert page["has_more"] is False


@pytest.mark.asyncio
async def test_cursor_v2_remains_available_for_same_dataset(space_session) -> None:
    seed_ledger_events(space_session, count=3)
    page = await SyncService(space_session).pull(cursor=0, limit=2)
    assert page["cursor_version"] == 2
    assert page["has_more"] is True
```

Define the seed helpers fully in the test file with fixed IDs/timestamps and explicit `flush` calls. Add tombstone truncation and REST v1/v2 contract tests.

- [ ] **Step 2: Run the new test and existing critical xfail**

Run:

```powershell
.\backend\.venv\Scripts\python.exe -m pytest -q backend/tests/test_sync_legacy_fail_closed.py backend/tests/test_sync_cursor_pagination.py::test_legacy_pull_global_cursor_skips_truncated_older_entity_rows -p no:cacheprovider
```

Expected: new test FAILS because a page is returned; the old test reports strict XFAIL.

- [ ] **Step 3: Reject every truncated legacy group before returning a cursor**

Add `CursorUpgradeRequiredError` with status 409, canonical code `cursor_upgrade_required`, legacy alias `conflict`, retryable false, and a path-free `details["truncated_groups"]` list.

In legacy `SyncService.pull`, collect group names when a `limit + 1` query overflows. Include `tombstones` when their query overflows. After all read queries but before audit writes or a result return:

```python
if truncated_groups:
    raise CursorUpgradeRequiredError(
        truncated_groups=sorted(truncated_groups)
    )
```

Do not run this branch when `cursor is not None`; v2 ledger pagination remains unchanged. Remove the strict `xfail` marker from the old regression and rewrite it to assert the canonical exception instead of expecting all rows from an unsafe legacy page.

- [ ] **Step 4: Run legacy/v2 Sync tests**

Run:

```powershell
.\backend\.venv\Scripts\python.exe -m pytest -q backend/tests/test_sync_legacy_fail_closed.py backend/tests/test_sync_cursor_pagination.py backend/tests/test_sync_routes.py -p no:cacheprovider
```

Expected: all tests pass; no critical xfail remains; unsafe legacy pages return stable 409/canonical errors; v2 pages still advance.

- [ ] **Step 5: Commit**

```powershell
git add backend/app/errors.py backend/app/services/sync.py backend/tests/test_sync_legacy_fail_closed.py backend/tests/test_sync_cursor_pagination.py
git commit -m "fix: fail closed on unsafe legacy sync cursors"
```

### Task 7: Disable Ledger And Tombstone Retention Until Client ACK Exists

**Files:**
- Modify: `backend/app/errors.py`
- Modify: `backend/app/services/sync_outbox.py`
- Modify: `backend/app/services/tombstone.py`
- Modify: `backend/app/routes/v1/trash.py`
- Modify: `backend/tests/test_sync_ledger_retention.py`
- Modify: `backend/tests/test_tombstone_service.py`
- Modify: `backend/tests/test_routes_v1.py`
- Modify: `backend/tests/test_sync_routes.py`
- Modify: `backend/tests/test_sync_cursor_pagination.py`

**Interfaces:**
- Consumes: ledger/tombstone cleanup requests without an S4 registered-client ACK waterline.
- Produces: stable fail-closed errors and proof that floor, ledger, tombstone, and trash rows remain unchanged.

- [ ] **Step 1: Write failing no-delete tests around every retention entrypoint**

Replace success-oriented retention tests with:

```python
@pytest.mark.asyncio
async def test_ledger_floor_and_prune_require_client_ack(space_session) -> None:
    from app.errors import RetentionAckRequiredError
    from app.services.sync_outbox import advance_retention_floor, prune_sync_events

    event = await _record_events(space_session, 1)
    with pytest.raises(RetentionAckRequiredError):
        await advance_retention_floor(space_session, floor=event[0].id)
    with pytest.raises(RetentionAckRequiredError):
        await prune_sync_events(space_session, before_id=event[0].id)
    assert await get_ledger_stats(space_session) == {
        "total_events": 1,
        "min_id": event[0].id,
        "max_id": event[0].id,
    }


@pytest.mark.asyncio
async def test_tombstone_cleanup_requires_client_ack_and_deletes_nothing(space_session) -> None:
    from app.errors import RetentionAckRequiredError
    from app.services.tombstone import TombstoneService

    old = await seed_old_tombstone(space_session)
    with pytest.raises(RetentionAckRequiredError):
        await TombstoneService(space_session).cleanup_expired()
    assert await space_session.get(Tombstone, old.id) is not None
```

Add an HTTP test asserting `/api/v1/trash/cleanup` returns legacy conflict by default, canonical `retention_ack_required` with v2 Accept, and leaves the tombstone count unchanged.

- [ ] **Step 2: Run the retention tests and verify they fail**

Run:

```powershell
.\backend\.venv\Scripts\python.exe -m pytest -q backend/tests/test_sync_ledger_retention.py backend/tests/test_tombstone_service.py -p no:cacheprovider
```

Expected: FAIL because both services currently delete data without client ACK.

- [ ] **Step 3: Fail closed before every retention mutation**

Add `RetentionAckRequiredError` with status 409, code `retention_ack_required`, legacy alias `conflict`, and retryable false. Make `advance_retention_floor`, `prune_sync_events`, and `TombstoneService.cleanup_expired` raise it as their first executable statement. Do not retain a callable unchecked deletion helper in production code; S4 reintroduces deletion only behind its client registry and minimum-ACK waterline.

Keep `/trash/cleanup` routed for compatibility, but let the service exception map through the shared error contract. Tests that need an expired cursor fixture must insert `SyncState` and delete test ledger rows directly inside the test transaction; they must not call a production bypass.

- [ ] **Step 4: Run retention, trash, and Sync recovery tests**

Run:

```powershell
.\backend\.venv\Scripts\python.exe -m pytest -q backend/tests/test_sync_ledger_retention.py backend/tests/test_tombstone_service.py backend/tests/test_routes_v1.py backend/tests/test_sync_routes.py backend/tests/test_sync_cursor_pagination.py -p no:cacheprovider
```

Expected: all tests pass; no production retention function deletes a row; `/trash/cleanup` is stable fail-closed; cursor-expired read behavior remains testable through explicit fixture state.

- [ ] **Step 5: Commit**

```powershell
git add backend/app/errors.py backend/app/services/sync_outbox.py backend/app/services/tombstone.py backend/app/routes/v1/trash.py backend/tests/test_sync_ledger_retention.py backend/tests/test_tombstone_service.py backend/tests/test_routes_v1.py backend/tests/test_sync_routes.py backend/tests/test_sync_cursor_pagination.py
git commit -m "fix: disable unsafe sync retention"
```

### Task 8: Disable The Legacy Default Alembic Environment

**Files:**
- Modify: `backend/alembic/env.py`
- Modify: `backend/alembic.ini`
- Create: `backend/tests/test_alembic_entrypoints.py`

**Interfaces:**
- Consumes: Alembic default and named Meta/Space invocations.
- Produces: deterministic rejection of the combined default environment and preserved named-environment upgrade/current behavior.

- [ ] **Step 1: Write failing default-rejection and named-success tests**

Create `backend/tests/test_alembic_entrypoints.py`:

```python
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

import pytest
BACKEND = Path(__file__).resolve().parents[1]


def isolated_ini(tmp_path: Path) -> Path:
    legacy = tmp_path / "legacy"
    shutil.copytree(BACKEND / "alembic", legacy)
    ini = tmp_path / "alembic.ini"
    ini.write_text(
        "\n".join(
            (
                "[alembic]",
                f"script_location = {legacy.as_posix()}",
                f"sqlalchemy.url = sqlite+aiosqlite:///{(tmp_path / 'legacy.db').as_posix()}",
                "revision_environment = true",
                "[alembic:meta]",
                f"script_location = {(BACKEND / 'alembic_meta').as_posix()}",
                f"sqlalchemy.url = sqlite+aiosqlite:///{(tmp_path / 'meta.db').as_posix()}",
                "version_table = alembic_version_meta",
                "[alembic:space]",
                f"script_location = {(BACKEND / 'alembic_space').as_posix()}",
                f"sqlalchemy.url = sqlite+aiosqlite:///{(tmp_path / 'space.db').as_posix()}",
                "version_table = alembic_version_space",
            )
        ) + "\n",
        encoding="utf-8",
    )
    return ini


@pytest.mark.parametrize(
    "arguments",
    (("upgrade", "head"), ("revision", "-m", "blocked", "--rev-id", "blocked")),
)
def test_default_alembic_environment_fails_with_named_instructions(
    tmp_path: Path, arguments: tuple[str, ...]
) -> None:
    ini = isolated_ini(tmp_path)
    result = subprocess.run(
        [sys.executable, "-m", "alembic", "-c", str(ini), *arguments],
        cwd=BACKEND,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode != 0
    output = result.stdout + result.stderr
    assert "alembic -n alembic:meta upgrade head" in output
    assert "alembic -n alembic:space upgrade head" in output


@pytest.mark.parametrize("environment", ["meta", "space"])
def test_named_alembic_environment_still_reaches_head(
    tmp_path: Path, environment: str
) -> None:
    ini = isolated_ini(tmp_path)
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "alembic",
            "-c",
            str(ini),
            "-n",
            f"alembic:{environment}",
            "upgrade",
            "head",
        ],
        cwd=BACKEND,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
```

- [ ] **Step 2: Run the tests and verify the default case fails**

Run:

```powershell
.\backend\.venv\Scripts\python.exe -m pytest -q backend/tests/test_alembic_entrypoints.py -p no:cacheprovider
```

Expected: FAIL because `alembic upgrade head` still runs the legacy combined chain.

- [ ] **Step 3: Replace legacy env behavior with an unconditional instruction error**

Replace `backend/alembic/env.py` with a minimal module that raises:

```python
raise RuntimeError(
    "Legacy combined Alembic environment is disabled. "
    "Use `alembic -n alembic:meta upgrade head` for meta.db or "
    "`alembic -n alembic:space upgrade head` for a Space database."
)
```

Set `revision_environment = true` in the default `[alembic]` section of `backend/alembic.ini` so `alembic revision` also executes the rejecting env before generating a file. Do not alter `alembic_meta`, `alembic_space`, or their version tables in S1.

- [ ] **Step 4: Run all migration entrypoint tests**

Run:

```powershell
.\backend\.venv\Scripts\python.exe -m pytest -q backend/tests/test_alembic_entrypoints.py backend/tests/test_alembic.py backend/tests/test_alembic_dual_environments.py backend/tests/test_migration_runner.py -p no:cacheprovider
```

Expected: all tests pass; default invocation exits non-zero with both exact named commands; Meta and Space reach their independent heads.

- [ ] **Step 5: Commit**

```powershell
git add backend/alembic/env.py backend/alembic.ini backend/tests/test_alembic_entrypoints.py
git commit -m "fix: disable legacy alembic entrypoint"
```

### Task 9: Retain Failed CI Sandboxes And Clean Successful Runs

**Files:**
- Modify: `.github/workflows/ci.yml`
- Create: `backend/tests/test_ci_artifact_lifecycle.py`

**Interfaces:**
- Consumes: S0 external run-root contract plus CI success/failure status.
- Produces: failure-only upload of the exact run root and success-only cleanup, with local retained artifacts untouched.

- [ ] **Step 1: Write the failing workflow lifecycle contract**

Create `backend/tests/test_ci_artifact_lifecycle.py`:

```python
from __future__ import annotations

from pathlib import Path


WORKFLOW = (Path(__file__).resolve().parents[2] / ".github" / "workflows" / "ci.yml")


def test_ci_uses_external_run_root_and_produces_real_failure_artifacts() -> None:
    source = WORKFLOW.read_text(encoding="utf-8")
    assert "POMODOROXII_TEST_ARTIFACTS_ROOT: ${{ runner.temp }}/pomodoroxii-test-artifacts" in source
    assert "--junitxml=.test-results/junit.xml" in source
    assert ".test-results/pytest.log" in source
    assert "${{ runner.temp }}/pomodoroxii-test-artifacts/**" in source


def test_ci_uploads_on_failure_and_cleans_only_on_success() -> None:
    source = WORKFLOW.read_text(encoding="utf-8")
    upload = source.index("name: Upload test artifacts on failure")
    cleanup = source.index("name: Clean successful test artifacts")
    assert "if: failure()" in source[upload:cleanup]
    assert "if: success()" in source[cleanup:]
    assert upload < cleanup
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```powershell
.\backend\.venv\Scripts\python.exe -m pytest -q backend/tests/test_ci_artifact_lifecycle.py -p no:cacheprovider
```

Expected: FAIL because CI uploads paths it does not produce and has no success cleanup.

- [ ] **Step 3: Make the CI lifecycle explicit and run-scoped**

In the test job, add:

```yaml
env:
  POMODOROXII_TEST_ARTIFACTS_ROOT: ${{ runner.temp }}/pomodoroxii-test-artifacts
```

Replace the pytest step with a Bash `set -o pipefail` pipeline that creates `.test-results`, runs pytest with `--junitxml=.test-results/junit.xml`, and tees to `.test-results/pytest.log`. Replace failure upload paths with:

```yaml
path: |
  backend/.test-results/
  ${{ runner.temp }}/pomodoroxii-test-artifacts/**
if-no-files-found: warn
retention-days: 7
```

Add after upload:

```yaml
- name: Clean successful test artifacts
  if: success()
  run: |
    rm -rf -- "$POMODOROXII_TEST_ARTIFACTS_ROOT"
    rm -rf -- .test-results
```

The cleanup target is the current ephemeral runner's exact environment path. Do not add local-workspace cleanup or a glob that can resolve above that path.

- [ ] **Step 4: Run workflow contract and Ruff**

Run:

```powershell
.\backend\.venv\Scripts\python.exe -m pytest -q backend/tests/test_ci_artifact_lifecycle.py backend/tests/test_test_isolation.py -p no:cacheprovider
.\backend\.venv\Scripts\ruff.exe check --no-cache --config backend/pyproject.toml backend/app backend/tests
```

Expected: lifecycle and isolation tests pass; Ruff prints `All checks passed!`; workflow failure paths now correspond to produced files.

- [ ] **Step 5: Commit**

```powershell
git add .github/workflows/ci.yml backend/tests/test_ci_artifact_lifecycle.py
git commit -m "ci: retain failed backend test sandboxes"
```

## S1 Exit Gate

Run from the repository root with a fresh external test run root:

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
$env:POMODOROXII_TEST_ARTIFACTS_ROOT = Join-Path ([IO.Path]::GetTempPath()) 'pomodoroxii-test-artifacts'
.\backend\.venv\Scripts\python.exe -m pytest -q backend/tests/test_security_policy.py backend/tests/test_auth_concurrency.py backend/tests/test_mcp_authorization.py backend/tests/test_space_path_containment.py backend/tests/test_file_system/test_api.py backend/tests/test_sync_legacy_fail_closed.py backend/tests/test_alembic_entrypoints.py -p no:cacheprovider
.\backend\.venv\Scripts\python.exe -m pytest -q backend/tests/test_error_contract_v2.py backend/tests/test_sync_ledger_retention.py backend/tests/test_tombstone_service.py backend/tests/test_ci_artifact_lifecycle.py -p no:cacheprovider
.\backend\.venv\Scripts\ruff.exe check --no-cache --config backend/pyproject.toml backend/app backend/tests
```

Expected:

- every focused test passes with zero xfail;
- empty, short, long, and bcrypt-alias passwords fail closed;
- production JWT secrets below 32 UTF-8 bytes fail settings construction;
- concurrent setup has exactly one success;
- the only recursive wire serializer is `app/errors.py::to_wire_json`; nested frozen REST/MCP details are byte-equivalent and no `asdict`/shallow-copy path remains;
- epochless and revoked JWTs fail on REST and MCP;
- MCP HTTP without valid Bearer auth never enters a tool;
- stdio without `--trusted-stdio` exits non-zero;
- traversal, registered outside-root paths, symlink/junction/reparse escapes, role collisions, and ancestor swaps create no outside file and no engine/filesystem;
- unsafe legacy timestamp pages return `cursor_upgrade_required` while cursor v2 remains operational;
- ledger/tombstone retention deletes zero rows until ACK support exists;
- default Alembic exits with named Meta/Space instructions;
- Ruff prints `All checks passed!`.

## Review Gate

Do not merge S1 until a reviewer verifies:

- `CredentialAuthority` is the only password/JWT policy authority used by REST and MCP;
- every bcrypt hash/check occurs via `asyncio.to_thread` from async request paths;
- credential epoch `1` is bootstrapped without a schema migration and old epochless tokens are rejected;
- revoke advances epoch atomically and invalidates both master and Space tokens;
- `DomainErrorRecord` is deeply frozen with exactly `code`, `message`, `retryable`, `request_id`, and `details`; `app/errors.py::to_wire_json` is the sole recursive thaw owner imported by REST, MCP, S3, and S4;
- default REST v1 error bodies remain exact, including validation and Sync recovery keys;
- MCP uses FastMCP 3 `TokenVerifier` and no implicit stdio bypass exists;
- `AuthorizedSpaceScope.open` returns identity/mode plus a factory-only `SpaceContainmentCapability`; its exact four-field `ContainedSpacePaths` is capability-private non-authority metadata and never a result/consumer input;
- `open_verified()` yields only opaque `ContainedSpaceOpens`; POSIX dirfd/openat and Windows root-HANDLE-relative no-reparse opens survive the final-check/kernel-open race without outside I/O, and SQLite main/sidecar connections remain bound to the opened identity rather than a reopened path;
- legacy cursor and retention fail-closed paths have stable errors and no partial writes;
- CI failure upload precedes success-only cleanup and points to files the test step produces;
- the diff adds no migration, SpaceRuntime, lease, Unit of Work, frontend, deployment, or unrelated cleanup work.

Record the reviewed wave with a final focused commit only when review changes are required. Reuse the owning task's exact file-level `git add` command for every corrected file; never stage `backend/app`, `backend/tests`, or another directory wholesale because retained sandboxes are intentionally untracked.

```powershell
git commit -m "fix: close backend S1 review findings"
```
