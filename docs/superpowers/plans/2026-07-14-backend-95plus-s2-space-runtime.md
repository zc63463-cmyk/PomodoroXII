# Backend 95+ S2 Space Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立可证明持久化的双 Alembic 迁移、单进程所有权、全局/Space 租约、权威 Space 运行时、不可变实体目录和独立 `index.db` schema，使所有请求只能进入已登记、已迁移且可恢复的 Space。

**Architecture:** S2 保持 Space Alembic head 为 `space_008_sync_retention_snapshot`，不新增任何 Space revision。`RuntimeLeaseCoordinator` 将独立 process-owner 锁与跨进程 global/per-Space portalocker shared/exclusive 锁分开，并在进程内叠加公平排队；`MigrationCoordinator` 在全局排他租约下通过 SQLite online backup、临时升级、校验、原子替换和 fsync 完成迁移；`AuthorizedSpaceScope` 解析授权并调用 `SpaceRuntime`，后者只从 Meta 登记路径构造受租约保护的 `SpaceRuntimeHandle`，请求路径只验证、不懒迁移也不隐式创建存储。

**Tech Stack:** Python 3.13, FastAPI lifespan/dependencies, SQLAlchemy 2 async, Alembic dual environments, SQLite backup/WAL/FTS5, `filelock`, `portalocker>=3.1,<4`, `asyncio`, pytest/pytest-asyncio, Ruff.

---

## Preconditions And Locked Decisions

- 在独立 S2 分支执行；S0 与 S1 的 review gate 必须已通过，出现新的 P0 立即停止本波。
- S1 的授权输出固定为 `AuthorizedSpaceScopeResult`，只携带私有构造的 `SpaceContainmentCapability`；runtime 必须使用 `async with scope.containment.open_verified() as opens:`，其中 `ContainedSpaceOpens` 只含已打开/identity-bound 的 opaque handles和 `BoundSQLiteTarget`。四字段 `ContainedSpacePaths(space_root, db_path, notes_dir, index_db)` 仅是 capability-private non-authority snapshot，不得成为 S2 consumer 参数。`BoundSQLiteTarget` 的 caller surface 只有 `identity`、`make_async_engine(options)`、`open_maintenance(options)`、`aclose()`；S2 不得取得 host path、URI/token、fd/HANDLE、sidecar 或 raw connector。S1 不得定义 `SpaceRuntimeHandle`；其唯一最终定义在 `backend/app/runtime/space.py`，且不得把 capability 或 opaque target 降级成裸 Path。
- 支持拓扑固定为“每个持久化 data root 只有一个活动后端进程”。不宣称网络文件系统或 active-active 多写。
- `RuntimeLeaseCoordinator` 的最终公开签名固定为：

```text
acquire_process_owner(purpose, timeout_seconds) -> Lease
acquire_global(mode, purpose, timeout_seconds) -> Lease
acquire_spaces(space_ids, mode, purpose, timeout_seconds) -> Lease
```

  `Lease` 是已获取的 async context manager，公开只读 `fence`；`_HeldOrder` 与 Lease 都记录 acquiring `asyncio.Task`。调用者必须在该 Task 中进入、断言 fence、执行 destructive operation 和 release。ContextVar 复制到 child Task 时 owner identity 不匹配，任何 acquire/use/release 都 fail closed，避免 child 继承伪造锁顺序或在错误 Context 中 reset token。
- process-owner 使用独立 `filelock` OS advisory lock 文件，并以 `thread_local=False` 支持 joined worker 获取/释放；所有 filelock/portalocker offload 都通过 S1 `run_joined_thread`，release capability 通过 package-private `run_joined_awaitable` 到终态。`_PortalHandle`、`ProcessOwnerReceipt`、`_ReleaseStage` 的 terminal state 只能由 owner Task 中的同步 `on_success` hook提交，不能在 helper 的 `await` 之后另行标记。process-owner 从 OS lock acquisition 到 live `Lease` publication 的每个异常、取消和 corrupt-fence 边界都必须 joined-release、撤销 partial token/receipt 并让 fresh child 成功 acquire。global 和 per-Space 各使用一对 `portalocker` OS advisory 文件：writer turnstile 与 data lock。reader 短持 shared turnstile、取得 shared data 后立即释放 turnstile；writer 持 exclusive turnstile 再取得并持有 exclusive data，直到 lease release。这样已进入 turnstile 的 writer 会阻止跨进程 late reader 越过；每个进程内再叠加 writer-fair queue。禁止用进程内互斥量或 process-owner 冒充跨进程 RW 语义。
- 锁顺序固定为：process owner（仅进程/维护入口）→ global → 字典序 Space IDs → Meta/Space/Index/filesystem。禁止反向获取。
- 在线 snapshot 只需要 global-exclusive；会替换 SQLite 或 data root 的 migration/cutover/restore/relocation 必须由当前 owner 进程在 drain engine 后执行，或在后端停止后由离线 CLI 先取得 process-owner 再取得 global-exclusive。独立维护进程不得在活动 owner 仍持锁时 rename/replace 数据文件。
- `backend/app/runtime/scope.py::AuthorizedSpaceScope.open(principal, space_id, mode) -> SpaceRuntimeHandle` 是唯一授权到 request runtime 的公开入口；`SpaceRuntime.open_resolved` 是 package-internal，公开运维面只有 `provision/health/close` 与后续明确增加的只读 root inspection。S5 不绕过 scope 构造 live request 路径。
- `MigrationCoordinator.upgrade(kind, path)` 是 standalone/offline 入口，使用 keyed serialization但 `_upgrade_once` 必须在当前 caller Task inline执行，禁止 `create_task(_upgrade_once)`；内部依次取得 process-owner 和 global-exclusive。Fail-once pending cleanup 在 top-level 退出前由同一 owner Task 收敛；persistent cleanup进入显式 process-exit-required fail-closed state，不返回 migration success、不允许 readiness，且物理 locks 保持 live 直到 offline process退出。已经在同 Task 持有 process-owner + global-exclusive 的 startup/provision 路径调用 `upgrade_under_lease(kind, path, lease)`，禁止重入。没有 process-owner lineage 的 global lease 不得 replace SQLite。
- Existing-file migration 的 drain/resume owner 只有 `MigrationCoordinator.upgrade_under_lease()`；startup preparation 只排序、持有 global/Space leases 并调用 coordinator，不得在 coordinator 外再次 drain 或 resume 同一路径。
- Startup migration has one fleet-wide read-only preflight before any Meta/Space backup, checkpoint, recovery write, Alembic DDL, index rebuild, or replacement. Under the already-held process owner and global-exclusive lease it opens the existing Meta database and every registered Space in sorted order through read-only bound handles, executes all registered target-revision preflight policies, and closes every handle before migration starts. A missing store, nonempty breaking-cutover legacy authority, unresolved journal, or any probe error rejects the entire data root with zero migration calls and byte-identical Meta/Space/Index/Notes inventory. Per-file Alembic checks remain defense in depth and never substitute for this fleet gate.
- S1 的 session-bound `CredentialAuthority` 只存在于单次 Meta session 内。S2 bootstrap 必须调用 S1 的 `bootstrap_credential_epoch()`，长期 `RuntimeServices` 只保存无状态的 `verify_with_fresh_meta_session` callable；每次验证都重新获取并关闭 Meta session。
- Bootstrap/S3 startup recovery 借用唯一 global-exclusive 时，package-internal `SpaceRuntimeHandle` 必须显式记录 `owns_global_lease=False` 和 `owns_space_lease=False`，并 pin exact Space/global/process lineage直到 filesystem/engine/pending cleanup完成。它只关闭该 Space 的 filesystem/engine引用；per-Space cleanup 完成后外层才释放 Space-exclusive。任何 runtime handle、Meta、pending-resume 或 release-stage cleanup failure 都阻止 bootstrap释放 process-owner并进入 process-exit-required状态；只有全部 cleanup收敛后最外层才按 Space→global→process顺序各释放一次。
- canonical active layout 固定为 `{data_root}/meta.db`, `{data_root}/spaces/{space_id}/{space.db,index.db,notes/}`, `{data_root}/.runtime/`。`POMODOROXII_DATA_ROOT` 是唯一根配置；legacy `database_url`/`spaces_data_dir` 仅作为兼容输入，若不分别解析为 `{data_root}/meta.db` 与 `{data_root}/spaces` 则 startup fail closed。S5 snapshot 可使用自己的 manifest-relative layout，但 restore/cutover 必须映射回这个 active layout。
- `CompiledEntityCatalog` 的最终公开面固定为属性 `version`、`hash`，以及 `get(name)`、`get_by_sync_key(key)`、`try_get_by_sync_key(key)`、`model_for(name)`、`list_sync_enabled()`。`model_for` 返回 compile-time 已解析并冻结的 ORM model；后续 snapshot/command code 不重新 import `model_path`。
- S2 不创建 mutation journal；S3 才创建 `space_009_mutation_journal`。S2 测试和表清单必须继续断言 Space head 为 `space_008_sync_retention_snapshot`。
- 不删除现有未跟踪文件、`backend/tests/pytest-of-20564/` 或保留的测试产物。
- Every shell block in this plan starts independently with `backend/` as its working directory; no block inherits a prior `cd`. Therefore Python/Ruff/test paths and every `git add` path in S2 are backend-relative.

## File Responsibility Map

### New runtime Modules

- `backend/app/runtime/__init__.py`: 只重导出稳定的 runtime 类型和单例访问器。
- `backend/app/runtime/durability.py`: SQLite online backup、integrity check、文件/目录 fsync、原子替换、单调 fence 文件；不懂 Alembic 或 FastAPI。
- `backend/app/runtime/leases.py`: 独立 process-owner lock、portalocker global/per-Space cross-process writer-turnstile/data-lock pairs、进程内公平 queue、超时、字典序和 fence；不创建数据库引擎。
- `backend/app/runtime/scope.py`: `AuthorizedSpaceScope` 的授权/登记/containment 入口，只通过内部 `SpaceRuntime.open_resolved()` 返回 handle。
- `backend/app/runtime/space.py`: `SpaceRuntime`, ownership-explicit `SpaceRuntimeHandle`, `SpaceHealth`, provision/open/close，以及 package-internal borrowed-global preparation context；只接受 Meta 权威路径和 S1 scope result。
- `backend/app/runtime/bootstrap.py`: FastAPI 与 FastMCP 共用的 process-owner/fleet-wide read-only migration preflight/startup migration/short-lived credential epoch helper/catalog/Space preparation async context；同一 Task 负责 acquire 与 shutdown release，不保存 session-bound authority。

### Existing runtime and migration files

- `backend/app/db/migrations.py`: `MigrationStatus`, `MigrationResult`, `MigrationPreflightPolicy`, `MigrationCoordinator.preflight_fleet_under_lease/upgrade/upgrade_under_lease/create_isolated_under_lease`; fleet preflight only reads existing bound databases and closed policy registrations. Existing-file replace 要求 process-owner lineage、engine quiescence、关闭 backup connection、checkpoint 并清理 `-wal`/`-shm` sidecar；isolated-new 入口只接受带 provision marker 的不存在路径且绝不替换现有文件。保留 `run_migrations()` 作为测试/离线兼容入口，但生产启动和 Space 创建只调用 coordinator。
- `backend/app/db/meta_session.py`: 仅打开已经迁移的 Meta DB；移除生产路径中的隐式 migration。
- `backend/app/space_manager.py`: 引擎缓存与引用计数；request acquisition 接受 `ContainedSpaceOpens`，一次性转移 `BoundSQLiteTarget`并只调用 `target.make_async_engine(options)`；hidden `async_creator` 属于 S1 Module。它不接受 `ContainedSpacePaths`/裸 `db_path` overload，不计算或缓存 host path、不创建目录、不迁移，engine dispose 完成后才 `await target.aclose()`。
- `backend/app/main.py`: lifespan 持有 process-owner，先迁移 Meta 和全部登记 Space、升级 index schema，再启动请求；shutdown 等待 handle 并释放 owner。
- `backend/app/mcp/server.py`: 使用同一个 async runtime bootstrap 和 `FastMCP.run_async()`；不得保留独立 `init_meta_db()` shortcut。
- `backend/app/settings.py`: 定义并校验唯一 canonical `data_root` 与 active layout；legacy Meta/Spaces settings 必须与派生路径完全相等。
- `backend/app/deps.py`: 将 S1 `AuthorizedSpaceScopeResult` 打开为 `SpaceRuntimeHandle`，从 handle 派生 session/filesystem 并在请求末关闭。
- `backend/app/routes/v1/spaces.py`: 通过 `SpaceRuntime.provision()` 执行 provision-and-migrate-before-register。
- `backend/pyproject.toml`, `backend/uv.lock`: 锁定 `portalocker>=3.1,<4`，使 Windows/Linux maintenance CLI 和 live process 使用同一 advisory lock implementation。

### Catalog and index schema files

- `backend/app/registry/catalog.py`: 编译、验证、冻结并 hash `EntitySpec`；唯一协议 key 解析入口。
- `backend/app/registry/__init__.py`: mutable builder 只允许 startup 注册，编译后 sealed；导出 `CATALOG` 访问器。
- `backend/app/registry/sync_registry.py`, `backend/app/services/sync_entity_types.py`, `backend/app/routes/v1/meta.py`, `backend/app/services/meta.py`, `backend/app/schemas/meta.py`: 消费 compiled catalog 并公开 version/hash。
- `backend/app/file_system/index_schema.py`: `IndexStoreSchema.verify/upgrade/rebuild_indexes`，schema version 与普通索引/FTS/triggers 的唯一 authority。
- `backend/app/file_system/schema.py`: 只保留 ORM/DDL 声明和向 `IndexStoreSchema` 的兼容委托；不得继续维护第二套版本 runner。
- `backend/app/file_system/engine/base.py`: 消费 S1 已落地的 `_NotesAuthority`/`_IndexAuthority` port；初始化只调用 `IndexStoreSchema`，请求 open 只 verify，且不得重新引入 `root`/`index_db` host Path 或 pathname connector。
- `backend/app/file_system/api.py`: `open_existing_file_system(ContainedSpaceOpens)` 只转移已打开的 distinct Notes/index handles/targets并调用 S1 `FileSystemStorage.from_bound_handles`，后续操作保持 descriptor/HANDLE-relative；`provision_file_system()` 是隔离 provision 的唯一 mkdir/init/upgrade factory。S1 的 path-backed constructor 仍只服务既有测试/N-1，contained import/export 在没有独立外部路径 capability 时继续稳定 fail closed。

### Tests

- `backend/tests/test_migration_wal_durability.py`: committed WAL、故障点、fsync/replacement、并发单 owner。
- `backend/tests/test_runtime_leases.py`: process death、RW fairness、顺序、timeout、fence、handle drain，以及逐 stage fail-once release 重试和 body/cancellation primary 聚合。
- `backend/tests/test_space_lifecycle.py`: startup fleet preflight-before-any-DDL、all-space migration、missing storage、legacy-bearing byte equality、provision compensation、无请求期 lazy migration。
- `backend/tests/test_runtime_bootstrap.py`, `backend/tests/test_mcp_http_lifespan.py`: FastAPI/FastMCP 共用完整 bootstrap，且 success/failure/cancel 都释放 owner/handles。
- `backend/tests/test_file_system/test_api.py`: request open 不 mkdir、不 init、不 upgrade；provision factory 才允许创建。
- `backend/tests/test_compiled_entity_catalog.py`: 所有冲突维度、不可变性、稳定 hash。
- `backend/tests/test_index_store_schema.py`: fresh/upgrade/rebuild、普通索引、FTS、版本和数据保持。
- `backend/tests/test_migration_runner.py`, `backend/tests/test_alembic_dual_environments.py`, `backend/tests/test_space_manager.py`, `backend/tests/test_routes_auth_spaces.py`, `backend/tests/test_registry.py`, `backend/tests/test_registry_integration.py`: 更新已有契约。

## Task 1: Add Durable SQLite And Filesystem Primitives

**Files:**
- Modify: `backend/app/runtime/__init__.py`
- Create: `backend/app/runtime/durability.py`
- Modify: `backend/app/runtime/contained_io.py`
- Modify: `backend/app/runtime/sqlite_vfs.py`
- Create: `backend/tests/test_migration_wal_durability.py`
- Modify: `backend/tests/test_pxii_vfs.py`

**Interfaces:**
- Consumes: S1 `BoundSQLiteTarget` source/destination authorities, expected fences, and non-database filesystem paths whose parents are already owned.
- Produces: WAL-complete bound-target backup, integrity verification, native write-through non-database replace, file/tree fsync, and monotonic persisted fence primitives.
- Extends only the private maintenance adapter: `_MaintenanceConnection.backup(destination)` performs authority-preserving maintenance-to-maintenance backup without changing the four-member public `BoundSQLiteTarget` surface (`identity`, `make_async_engine(options)`, `open_maintenance(options)`, `aclose()`).

- [ ] **Step 1: Write the failing committed-WAL backup and fsync tests**

在 `backend/tests/test_migration_wal_durability.py` 写入以下首组测试；测试保持 writer connection 打开，确保数据仍可位于 `-wal`：

```python
from __future__ import annotations

import os
from pathlib import Path

from app.runtime.durability import (
    atomic_replace_durable,
    fsync_directory,
    sqlite_online_backup,
)
from app.runtime.sqlite_vfs import MaintenanceOptions


def test_online_backup_captures_committed_wal_row(bound_sqlite_pair) -> None:
    source, backup = bound_sqlite_pair
    with source.open_maintenance(MaintenanceOptions(read_only=False)) as writer:
        writer.execute("PRAGMA journal_mode=WAL")
        writer.execute("CREATE TABLE marker (value TEXT NOT NULL)")
        writer.commit()
        checkpoint = writer.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
        assert checkpoint is not None
        busy, log_frames, checkpointed_frames = checkpoint
        assert busy == 0
        assert log_frames == checkpointed_frames
        writer.execute("INSERT INTO marker VALUES ('committed-in-wal')")
        writer.commit()

        sqlite_online_backup(source, backup)

        with backup.open_maintenance(MaintenanceOptions(read_only=True)) as copied:
            assert copied.execute("PRAGMA integrity_check").fetchone() == ("ok",)
            assert copied.execute("SELECT value FROM marker").fetchone() == (
                "committed-in-wal",
            )


def test_atomic_replace_fsyncs_file_and_parent(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "replacement.bin"
    target = tmp_path / "target.bin"
    source.write_bytes(b"new")
    target.write_bytes(b"old")
    calls: list[tuple[str, Path]] = []

    monkeypatch.setattr(
        "app.runtime.durability._replace_with_write_through",
        lambda src, dst: calls.append(("replace", Path(dst))),
    )
    monkeypatch.setattr(
        "app.runtime.durability.fsync_file",
        lambda path: calls.append(("file", Path(path))),
    )
    monkeypatch.setattr(
        "app.runtime.durability.fsync_directory",
        lambda path: calls.append(("directory", Path(path))),
    )

    atomic_replace_durable(source, target)

    assert calls == [
        ("file", source),
        ("replace", target),
        ("directory", tmp_path),
    ]
```

In `backend/tests/test_pxii_vfs.py`, add the exact boundary regressions `test_maintenance_backup_copies_committed_wal`, `test_maintenance_backup_rejects_raw_sqlite_destination`, `test_maintenance_backup_rejects_read_only_destination`, `test_maintenance_backup_rejects_self_and_same_identity`, `test_maintenance_backup_rejects_closed_source_or_destination`, `test_maintenance_backup_never_reopens_by_path`, and `test_maintenance_backup_does_not_expand_bound_target_surface`. They must prove maintenance-to-maintenance backup succeeds, a committed WAL row is copied, a raw `sqlite3.Connection` destination is rejected, a read-only destination is rejected, self-backup and a different connection for the same storage identity are rejected, closed source and destination adapters are rejected, no pathname reopen occurs, and the public `BoundSQLiteTarget` surface remains exactly four members. The tests may inspect the private adapter only through values returned by `open_maintenance()` and must never recover a raw connection, token, URI, path, fd/HANDLE, sidecar, or connector.

- [ ] **Step 2: Run the tests and verify the missing Module failure**

Run from `backend/`:

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_migration_wal_durability.py -p no:cacheprovider
.\.venv\Scripts\python.exe -m pytest -q `
  tests/test_pxii_vfs.py::test_maintenance_backup_copies_committed_wal `
  tests/test_pxii_vfs.py::test_maintenance_backup_rejects_raw_sqlite_destination `
  tests/test_pxii_vfs.py::test_maintenance_backup_rejects_read_only_destination `
  tests/test_pxii_vfs.py::test_maintenance_backup_rejects_self_and_same_identity `
  tests/test_pxii_vfs.py::test_maintenance_backup_rejects_closed_source_or_destination `
  tests/test_pxii_vfs.py::test_maintenance_backup_never_reopens_by_path `
  tests/test_pxii_vfs.py::test_maintenance_backup_does_not_expand_bound_target_surface `
  -p no:cacheprovider
```

Expected: the durability file FAILS during collection with `ModuleNotFoundError: No module named 'app.runtime.durability'`; the separately executed adapter nodeids FAIL because `_MaintenanceConnection.backup` and its lifecycle state do not exist. S1's existing `app.runtime` package and scope exports remain present. Both RED commands are mandatory; one failure may not mask or replace the other.

- [ ] **Step 3: Implement the durability primitives**

First extend the private adapter in `backend/app/runtime/sqlite_vfs.py`. `_MaintenanceConnection` records the bound `StorageIdentity`, the requested read-only state, and an internal closed sentinel supplied by `BoundSQLiteTarget.open_maintenance()`; none is public or returned. Its authority-preserving adapter is:

```python
def backup(self, destination: _MaintenanceConnection) -> None:
    source_connection = self._require_open()
    if not isinstance(destination, _MaintenanceConnection):
        raise TypeError("backup destination must be a maintenance connection")
    destination_connection = destination._require_open()
    if destination._read_only:
        raise ValueError("backup destination is read-only")
    if destination is self or destination._identity == self._identity:
        raise ValueError("backup source and destination must be distinct authorities")
    source_connection.backup(destination_connection)
```

`_require_open()` raises a stable `RuntimeError("maintenance connection is closed")` after `_close()` atomically detaches the raw connection. `_close()` still closes every cursor and the detached connection with collect-all-errors behavior. `open_maintenance()` passes only its already-bound `StorageIdentity` and `MaintenanceOptions.read_only` into the private adapter; it does not reopen, parse, or expose any Path, URI/token, fd/HANDLE, sidecar, connector, or raw `sqlite3.Connection`. Python's underlying `sqlite3.Connection.backup()` is called only inside this private method. Any backup exception propagates as the primary failure; neither adapter is silently closed or reported as a successful backup, and their surrounding maintenance contexts retain deterministic cleanup ownership. The public `BoundSQLiteTarget` four-member surface remains unchanged.

`backend/app/runtime/durability.py` 必须提供以下真实实现；Windows 目录或 volume flush 不受支持、无法验证或 `FlushFileBuffers` 失败时立即抛错并禁止发布，绝不以 debug 日志继续；Linux/macOS 的目录 fsync 失败同样抛出：

```python
from __future__ import annotations

import logging
import os
from pathlib import Path

from app.runtime.contained_io import flush_owned_directory, replace_file_write_through
from app.runtime.sqlite_vfs import BoundSQLiteTarget, MaintenanceOptions

logger = logging.getLogger(__name__)


def fsync_file(path: Path) -> None:
    with Path(path).open("rb") as handle:
        os.fsync(handle.fileno())


def fsync_directory(path: Path) -> None:
    directory = Path(path)
    if os.name == "nt":
        flush_owned_directory(directory)
        return
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def sqlite_online_backup(
    source: BoundSQLiteTarget, destination: BoundSQLiteTarget
) -> None:
    with source.open_maintenance(
        MaintenanceOptions(read_only=True)
    ) as source_db, destination.open_maintenance(
        MaintenanceOptions(read_only=False, create_if_missing=True)
    ) as target_db:
        source_db.backup(target_db)
        target_db.commit()
        if target_db.execute("PRAGMA integrity_check").fetchone() != ("ok",):
            raise RuntimeError("SQLite backup integrity check failed")


def _replace_with_write_through(source: Path, target: Path) -> None:
    if os.name == "nt":
        replace_file_write_through(source, target)
    else:
        os.replace(source, target)


def atomic_replace_durable(source: Path, target: Path) -> None:
    source_path = Path(source)
    target_path = Path(target)
    fsync_file(source_path)
    _replace_with_write_through(source_path, target_path)
    if os.name != "nt":
        fsync_directory(target_path.parent)


def next_fence(path: Path) -> int:
    fence_path = Path(path)
    fence_path.parent.mkdir(parents=True, exist_ok=True)
    current = int(fence_path.read_text(encoding="ascii")) if fence_path.exists() else 0
    temporary = fence_path.with_suffix(fence_path.suffix + ".tmp")
    value = current + 1
    temporary.write_text(str(value), encoding="ascii")
    atomic_replace_durable(temporary, fence_path)
    return value
```

`contained_io.flush_owned_directory()` and `contained_io.replace_file_write_through()` are complete native Windows implementations in this Task, not stubs: the former opens the already-owned directory with `CreateFileW(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)`, rejects reparse/identity drift, calls `FlushFileBuffers`, checks every return code, and raises if the filesystem does not provide a verifiable flush; the latter calls `MoveFileExW(MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)` and checks `GetLastError`. POSIX keeps file fsync + rename + parent-directory fsync. A Windows debug-and-return branch or plain `os.replace` is a gate failure. Database files never use `atomic_replace_durable`: bound-target backup/replace is owned by the S1 SQLite authority module, whose VFS performs database and parent synchronization without exposing a path.

在 `backend/app/runtime/__init__.py` 追加 durability exports，保留 S1 已有的 `AuthorizedSpaceScope`/`AuthorizedSpaceScopeResult` exports；后续 Task 再追加稳定 runtime types，任何步骤都不得清空或重建该文件。

- [ ] **Step 4: Run the focused tests and Ruff**

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_migration_wal_durability.py -p no:cacheprovider
.\.venv\Scripts\python.exe -m pytest -q tests/test_pxii_vfs.py -p no:cacheprovider
.\.venv\Scripts\ruff.exe check --no-cache app/runtime tests/test_migration_wal_durability.py tests/test_pxii_vfs.py
```

Expected: both commands PASS; WAL test reads `committed-in-wal` from the backup.

- [ ] **Step 5: Commit the durability boundary**

```powershell
git add app/runtime/__init__.py app/runtime/contained_io.py app/runtime/durability.py app/runtime/sqlite_vfs.py tests/test_migration_wal_durability.py tests/test_pxii_vfs.py
git commit -m "feat(runtime): add durable sqlite replacement primitives"
```

## Task 2: Implement Independent Process Ownership And Runtime RW Leases

**Files:**
- Create: `backend/app/runtime/leases.py`
- Consume unchanged: `backend/app/runtime/joined_thread.py`
- Modify: `backend/app/runtime/__init__.py`
- Modify: `backend/pyproject.toml`
- Modify: `backend/uv.lock`
- Create: `backend/tests/test_runtime_leases.py`

**Interfaces:**
- Consumes: canonical data root, acquiring `asyncio.Task`, lock scope/mode/purpose, and bounded timeout.
- Produces: owner-bound retryable `Lease` objects, process/global/Space OS locks, ordered ContextVar lineage, and persisted exclusive fences.

- [ ] **Step 1: Write failing public-contract, cross-process RW, ordering, timeout, process-owner, and fence tests**

使用真实 child process，而不是两个同进程 coordinator，证明 maintenance CLI 与 live request 共享 OS lock：

```python
from __future__ import annotations

import asyncio
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from app.runtime.leases import LeaseMode, LeaseOrderError, LeaseTimeoutError, RuntimeLeaseCoordinator

LOCK_HELPER = textwrap.dedent(
    """
    import asyncio
    import sys
    from pathlib import Path
    from app.runtime.leases import LeaseMode, RuntimeLeaseCoordinator

    async def main():
        root, kind, mode, space_id = sys.argv[1:5]
        coordinator = RuntimeLeaseCoordinator(Path(root))
        if kind == "owner":
            lease = await coordinator.acquire_process_owner("child", 2)
        elif kind == "global":
            lease = await coordinator.acquire_global(LeaseMode(mode), "child", 2)
        else:
            global_lease = await coordinator.acquire_global(
                LeaseMode.SHARED, "child-global", 2
            )
            lease = await coordinator.acquire_spaces(
                [space_id], LeaseMode(mode), "child-space", 2
            )
        print("LOCKED", flush=True)
        await asyncio.to_thread(sys.stdin.readline)
        await lease.release()
        if kind == "space":
            await global_lease.release()

    asyncio.run(main())
    """
)


def start_lock_holder(
    root: Path, kind: str, mode: str = "exclusive", space_id: str = "unused"
) -> subprocess.Popen[str]:
    process = subprocess.Popen(
        [sys.executable, "-c", LOCK_HELPER, str(root), kind, mode, space_id],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert process.stdout is not None
    assert process.stdout.readline().strip() == "LOCKED"
    return process


def stop_lock_holder(process: subprocess.Popen[str]) -> None:
    if process.stdin is not None:
        process.stdin.write("release\n")
        process.stdin.flush()
    process.wait(timeout=5)
    assert process.returncode == 0


@pytest.mark.asyncio
async def test_global_exclusive_times_out_while_other_process_holds_shared(
    tmp_path: Path,
) -> None:
    coordinator = RuntimeLeaseCoordinator(tmp_path)
    child = start_lock_holder(tmp_path, "global", "shared")
    try:
        with pytest.raises(LeaseTimeoutError) as captured:
            await coordinator.acquire_global(LeaseMode.EXCLUSIVE, "snapshot", 0.05)
        assert captured.value.code == "lease_timeout"
    finally:
        stop_lock_holder(child)
    async with await coordinator.acquire_global(LeaseMode.EXCLUSIVE, "snapshot", 1):
        return


@pytest.mark.asyncio
async def test_space_exclusive_blocks_same_space_cross_process_but_not_other_space(
    tmp_path: Path,
) -> None:
    coordinator = RuntimeLeaseCoordinator(tmp_path)
    child = start_lock_holder(tmp_path, "space", "shared", "space-a")
    global_lease = await coordinator.acquire_global(LeaseMode.SHARED, "request", 1)
    try:
        with pytest.raises(LeaseTimeoutError):
            await coordinator.acquire_spaces(
                ["space-a"], LeaseMode.EXCLUSIVE, "mutation", 0.05
            )
        other = await coordinator.acquire_spaces(
            ["space-b"], LeaseMode.EXCLUSIVE, "mutation", 1
        )
        await other.release()
    finally:
        await global_lease.release()
        stop_lock_holder(child)


@pytest.mark.asyncio
async def test_local_writer_queue_blocks_late_reader(tmp_path: Path) -> None:
    coordinator = RuntimeLeaseCoordinator(tmp_path)
    first = await coordinator.acquire_global(LeaseMode.SHARED, "reader-1", 1)
    writer_acquired = asyncio.Event()
    release_writer = asyncio.Event()
    late_reader_acquired = asyncio.Event()

    async def hold_writer() -> None:
        lease = await coordinator.acquire_global(LeaseMode.EXCLUSIVE, "writer", 1)
        writer_acquired.set()
        await release_writer.wait()
        await lease.release()

    async def hold_late_reader() -> None:
        lease = await coordinator.acquire_global(LeaseMode.SHARED, "reader-2", 1)
        late_reader_acquired.set()
        await lease.release()

    writer = asyncio.create_task(hold_writer())
    await asyncio.sleep(0)
    late_reader = asyncio.create_task(hold_late_reader())
    await asyncio.sleep(0)
    assert not writer.done()
    assert not late_reader.done()
    await first.release()
    await writer_acquired.wait()
    assert not late_reader_acquired.is_set()
    release_writer.set()
    await writer
    await late_reader
    assert late_reader_acquired.is_set()
```

同文件增加以下具名测试；跨进程 writer fairness 测试的 child writer 在取得 exclusive turnstile、仍等待第一个 reader 的 data lock 时写入 `writer-turnstile-acquired` marker，随后启动 late-reader child，证明 marker 存在期间 late reader 不能打印 `LOCKED`，释放首 reader 后 writer 必须先打印 `LOCKED`：

- process-owner child 被 terminate 后 OS 自动释放，新的 owner acquisition 成功；
- stale diagnostic JSON 不影响 OS lock 判定；
- `test_cross_process_writer_turnstile_blocks_late_reader` 证明 global writer 和 per-Space writer 都不会被 marker 之后到达的 reader 越过；
- global 未持有时 acquire_spaces 抛 `LeaseOrderError`；
- 持有 root A/coordinator A 的 owner 或 global 时，不能借 root B/coordinator B 获取 global/Space lease；ContextVar 必须同时校验 coordinator identity、canonical root 和层级；
- global→重复/字典序 Space IDs 成功，Space→global 失败；
- global exclusive 与每个 Space exclusive fence 持久单调，shared lease 不推进 fence；
- maintenance 60 秒与 request 5 秒 policy constants；
- process-owner 在一个 executor worker 获取、另一个 worker 释放后，fresh child 可立即重新获取；源码断言 `thread_local=False`；
- lease 被传给不同 `asyncio.Task` 释放时抛 `LeaseOrderError`，owner Task 仍可正常释放；
- child Task 从 ContextVar 继承 parent 的 global level 后，尝试 acquire Space 或使用 parent lease 均抛 `LeaseOrderError`；已释放 lease 的 `__aenter__`/fence/destructive assertion 同样失败；
- `test_release_fail_once_retries_only_unfinished_stages_and_defers_context_reset` 注入第一个 release stage 成功、第二个 callback 失败一次；第一次 release 后第一个 callback 不再执行、`_released` 为 false、ContextVar 仍保持原层级且 lease 不可继续用于数据操作，同一 owner Task 第二次 release 只重试未完成 callback并在全部成功后 reset；
- `test_lease_aexit_preserves_body_or_cancellation_before_release_failures` 分别用 `OSError` body 与 `asyncio.CancelledError` body叠加 fail-once cleanup，断言 `BaseExceptionGroup.exceptions == (primary, *cleanup_errors)`，然后由同一 owner Task 重试收敛；
- `test_child_release_failure_retains_live_process_owner_until_same_task_retry` 让 global release fail-once/persistent，再退出外层 process-owner context；反向 release 必须失败且 coordinator pending registry 同时强持 live parent receipt、global lease和OS owner，只有 acquiring Task先收敛 child 再释放 parent；
- `test_release_terminal_hooks_commit_before_double_cancellation_rethrow` 在 `_PortalHandle.release`、`_release_process_owner`、`_ReleaseStage.run` 的 worker 返回与 caller resume之间注入两次 cancellation，断言 `released`/`active=False`/`completed` 已由 owner Task 的 `on_success`提交，原始 cancellation仍是 element zero，重试不重复已成功物理操作；源码禁止 `await ...` 后才写这些 terminal fields；
- `test_portal_acquire_has_one_cleanup_owner_and_preserves_cancellation_primary` 让 nonblocking lock在 cancellation后成功，断言 lock-call本身没有 disposer，外层 acquire owner只执行一次幂等 unlock/close；同时注入 unlock失败时结果为 `[original_cancel, cleanup_error]`，而不是 cleanup覆盖 cancellation；
- `test_process_owner_every_post_acquire_failure_compensates_before_publication` 参数化 `after_os_acquire`、`during_fence_write`、`corrupt_fence_receipt`、`after_receipt`、`after_context_token`、`before_lease_return`以及 cancellation；每例都要求 joined OS release、partial ContextVar reset、live receipt deactivation、pending registry归零，随后真实 fresh child获取同一 process-owner；
- `test_global_and_space_acquire_cleanup_fail_once_retries_exact_remaining_stages` 分别在 global及第二个 Space的 data/turnstile/local release注入 fail-once；`_ReleaseSequence`只在前一 stage `completed`后继续，generic `PendingCleanup`强持 exact handles、parent receipt和owner Task，同一 Task重试后 fresh child立即 acquire；
- `test_acquire_cleanup_double_cancel_keeps_primary_and_continues_physically_completed_stage` 在 OS release物理完成但 helper重抛两次 cancellation时断言继续 local release，顺序严格为 `[original_cancel, *later_cancels, *terminal_errors]`且 registry为空；
- `test_acquire_cleanup_persistent_failure_blocks_readiness_and_parent_release_until_process_exit` 用真实 child进程让 acquisition cleanup持续失败，证明 registry保留OS/local/owner lineage、readiness false、process/global parent不释放；owner Task无法收敛时进入 `process_exit_required`，child退出后fresh child才可 acquire；
- `test_pending_cleanup_registry_is_same_task_strong_and_reverse_dependency_ordered` 覆盖 generic `PendingCleanup(owner_task, retry, holds)`、lease wrapper、migration/isolated closures、稳定插入与反向dependency retry；不同Task retry/complete失败，只有physical terminal success删除entry；
- `test_cancel_during_process_owner_or_portal_acquire_joins_and_compensates` 在 worker 已进入 filelock/nonblocking portalocker 调用时取消 host Task，要求 joined worker结束、任何晚到的 lock立即补偿释放、pending registry为零，fresh child随后可获取；
- cancellation/timeout 释放已获取的本地 gate、turnstile 和 data handles，随后 fresh child 能取得同一 lease。

这些测试还断言 public `Lease` 的 acquire/use/release始终发生在 acquiring Task。只有 `_ReleaseStage.run` 可把 private release callback包装成 `run_joined_awaitable` child；它的同步 `on_success`仍在 owner Task提交 state后才传播 cancellation。

其中 portal publication 与 generic registry 至少落实为以下可运行测试体；`lease_faults` 在同一测试文件中实现同步 hook，取消 acquiring Task发生在 native lock成功之后、helper return之前：

```python
@pytest.mark.asyncio
async def test_portal_cleanup_failure_before_helper_return_is_registered(
    tmp_path: Path, lease_faults
) -> None:
    coordinator = RuntimeLeaseCoordinator(tmp_path)
    fault = lease_faults.cancel_after_native_lock_before_helper_return()
    unlock = lease_faults.fail_unlock_once(OSError("unlock failed"))

    with pytest.raises(BaseExceptionGroup) as captured:
        await coordinator.acquire_global(LeaseMode.EXCLUSIVE, "portal-race", 1)

    assert isinstance(captured.value.exceptions[0], asyncio.CancelledError)
    assert unlock.error in captured.value.exceptions[1:]
    pending = coordinator.pending_cleanups_for_current_task()
    assert len(pending) == 1
    assert pending[0].owner_task is asyncio.current_task()
    assert fault.stream in pending[0].holds
    with pytest.raises(RuntimeCleanupPendingError):
        coordinator.assert_ready()

    await coordinator.retry_pending_cleanups_for_current_task()
    assert coordinator.pending_cleanups_for_current_task() == ()
    assert unlock.successful_unlock_count == 1


@pytest.mark.asyncio
async def test_pending_cleanup_is_same_task_strong_and_terminal_committed() -> None:
    held = object()
    terminal = {"value": False}
    calls = 0

    async def retry() -> None:
        nonlocal calls
        calls += 1
        terminal["value"] = True

    pending = PendingCleanup(
        owner_task=asyncio.current_task(),
        retry=retry,
        holds=(held,),
        physical_terminal=lambda: terminal["value"],
    )

    async def wrong_task() -> None:
        with pytest.raises(LeaseOrderError):
            await pending.run()

    await asyncio.create_task(wrong_task())
    assert pending.holds == (held,)
    assert not pending.completed
    await pending.run()
    assert pending.completed
    assert calls == 1
```

- [ ] **Step 2: Run the tests and verify the missing dependency/API failure**

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_runtime_leases.py -p no:cacheprovider
```

Expected: FAIL with missing `portalocker` or missing `LeaseMode`/`RuntimeLeaseCoordinator`; no test may skip cross-process assertions.

- [ ] **Step 3: Add and lock the cross-process dependency**

在 `backend/pyproject.toml` runtime dependencies 加入精确范围：

```toml
"portalocker>=3.1,<4",
```

刷新 lock 并证明 offline lock check：

```powershell
uv lock
uv lock --check --offline
uv sync --frozen --extra dev
.\.venv\Scripts\python.exe -c "import portalocker; print(portalocker.__version__)"
```

Expected: all commands PASS; `uv.lock` and the active `.venv` contain one portalocker 3.x package. Do not manually edit `uv.lock`.

- [ ] **Step 4: Implement the complete in-process writer-fair gate**

在 `backend/app/runtime/leases.py` 添加完整、可独立测试的 gate；没有未定义 helper：

```python
class _FairRwLock:
    def __init__(self) -> None:
        self._condition = asyncio.Condition()
        self._active_readers = 0
        self._writer_active = False
        self._waiting_writers = 0

    async def acquire(self, mode: LeaseMode) -> Callable[[], Awaitable[None]]:
        if mode is LeaseMode.SHARED:
            async with self._condition:
                await self._condition.wait_for(
                    lambda: not self._writer_active and self._waiting_writers == 0
                )
                self._active_readers += 1
        else:
            async with self._condition:
                self._waiting_writers += 1
                try:
                    await self._condition.wait_for(
                        lambda: not self._writer_active and self._active_readers == 0
                    )
                    self._writer_active = True
                finally:
                    self._waiting_writers -= 1
                    self._condition.notify_all()

        async def release() -> None:
            async with self._condition:
                if mode is LeaseMode.SHARED:
                    if self._active_readers <= 0:
                        raise RuntimeError("shared lease released without an owner")
                    self._active_readers -= 1
                else:
                    if not self._writer_active:
                        raise RuntimeError("exclusive lease released without an owner")
                    self._writer_active = False
                self._condition.notify_all()

        return release
```

- [ ] **Step 5: Implement cross-process writer turnstiles, data locks, ordered cleanup, ContextVar ordering, and fences**

同文件使用以下完整结构。global 的 OS lock pair 是 `.runtime/locks/global.turnstile` 与 `.runtime/locks/global.data`；per-Space pair 是 `.runtime/locks/spaces/{sha256}.turnstile` 与 `.runtime/locks/spaces/{sha256}.data`；process owner 仍是独立 `filelock`：

```python
from __future__ import annotations

import asyncio
import hashlib
from collections.abc import Awaitable, Callable
from contextvars import ContextVar, Token
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from types import MappingProxyType
from typing import BinaryIO, Literal, Mapping

import portalocker
from filelock import FileLock, Timeout as FileLockTimeout

from app.runtime.durability import next_fence
from app.runtime.joined_thread import run_joined_awaitable, run_joined_thread


class LeaseMode(StrEnum):
    SHARED = "shared"
    EXCLUSIVE = "exclusive"


class LeaseTimeoutError(RuntimeError):
    code = "lease_timeout"
    retryable = True


class LeaseOrderError(RuntimeError):
    code = "lease_order_invalid"
    retryable = False


class StaleFenceError(RuntimeError):
    code = "stale_fence"
    retryable = False


Release = Callable[[], Awaitable[None]]


@dataclass
class ProcessOwnerReceipt:
    coordinator_id: int
    root: str
    owner_task: object
    active: bool = True

    def deactivate(self) -> None:
        self.active = False

    def assert_current(self) -> None:
        held = _HELD_ORDER.get()
        if (
            not self.active
            or asyncio.current_task() is not self.owner_task
            or held.coordinator_id != self.coordinator_id
            or held.root != self.root
            or held.process_owner is not self
        ):
            raise LeaseOrderError("process-owner receipt is no longer live")


@dataclass(frozen=True)
class _HeldOrder:
    coordinator_id: int | None
    root: str | None
    owner_task: object | None
    level: Literal["none", "owner", "global", "spaces"]
    process_owner: ProcessOwnerReceipt | None = None
    space_ids: tuple[str, ...] = ()


_HELD_ORDER: ContextVar[_HeldOrder] = ContextVar(
    "runtime_lease_order", default=_HeldOrder(None, None, None, "none")
)


async def _release_process_owner(
    lock: FileLock, receipt: ProcessOwnerReceipt
) -> None:
    await run_joined_thread(
        lock.release,
        on_success=lambda _ignored: receipt.deactivate(),
    )


def _unlock_and_close(stream: BinaryIO) -> None:
    if stream.closed:
        return
    try:
        portalocker.unlock(stream)
    except (OSError, portalocker.exceptions.LockException):
        pass
    finally:
        stream.close()


@dataclass
class _PortalHandle:
    stream: BinaryIO
    released: bool = False

    async def release(self) -> None:
        if self.released:
            return
        await run_joined_thread(
            lambda: _unlock_and_close(self.stream),
            on_success=lambda _ignored: self._commit_released(),
        )

    def _commit_released(self) -> None:
        self.released = True


async def _acquire_portal_handle(
    path: Path,
    mode: LeaseMode,
    deadline: float,
    owned_handles: list[_PortalHandle],
) -> _PortalHandle:
    path.parent.mkdir(parents=True, exist_ok=True)
    flag = (
        portalocker.LockFlags.SHARED
        if mode is LeaseMode.SHARED
        else portalocker.LockFlags.EXCLUSIVE
    )
    stream = await run_joined_thread(
        lambda: path.open("a+b"),
        dispose_cancelled_result=lambda value: value.close(),
    )
    handle = _PortalHandle(stream)
    # Publish ownership synchronously before the first lock await. Any later
    # failure is therefore visible to the caller's unified release sequence.
    owned_handles.append(handle)
    while True:
        try:
            await run_joined_thread(
                lambda: portalocker.lock(
                    stream, flag | portalocker.LockFlags.NON_BLOCKING
                )
            )
            return handle
        except portalocker.exceptions.LockException as exc:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                raise LeaseTimeoutError(
                    f"runtime lease busy: {path.name}"
                ) from exc
            await asyncio.sleep(min(0.01, remaining))


@dataclass
class _CrossProcessRwLease:
    handles: tuple[_PortalHandle, ...]

    async def release(self) -> None:
        errors: list[BaseException] = []
        for handle in self.handles:
            try:
                await handle.release()
            except BaseException as exc:
                errors.append(exc)
        if errors:
            raise BaseExceptionGroup("cross-process RW release failed", errors)


@dataclass
class _ReleaseStage:
    callback: Release
    physical_terminal: Callable[[], bool] | None = None
    completed: bool = False

    async def run(self) -> None:
        if self.completed:
            return
        try:
            await run_joined_awaitable(
                self.callback(),
                on_success=lambda _ignored: self._commit_completed(),
            )
        except BaseException:
            if self.physical_terminal is not None and self.physical_terminal():
                self._commit_completed()
            raise

    def _commit_completed(self) -> None:
        self.completed = True


@dataclass
class _ReleaseSequence:
    owner_task: object
    stages: list[_ReleaseStage]
    holds: tuple[object, ...]

    @property
    def completed(self) -> bool:
        return all(stage.completed for stage in self.stages)

    async def run(self) -> None:
        if asyncio.current_task() is not self.owner_task:
            raise LeaseOrderError("cleanup sequence belongs to another asyncio Task")
        errors: list[BaseException] = []
        for stage in self.stages:
            if stage.completed:
                continue
            try:
                await stage.run()
            except BaseException as error:
                errors.append(error)
                if not stage.completed:
                    break
        if errors:
            raise BaseExceptionGroup("release sequence failed", errors)
        if not self.completed:
            raise RuntimeError("release sequence stopped before physical terminal state")


class RuntimeCleanupPendingError(RuntimeError):
    code = "runtime_cleanup_pending"
    retryable = False


@dataclass
class PendingCleanup:
    owner_task: object
    retry: Release
    holds: tuple[object, ...]
    physical_terminal: Callable[[], bool]
    completed: bool = False

    async def run(self) -> None:
        if asyncio.current_task() is not self.owner_task:
            raise LeaseOrderError("pending cleanup belongs to another asyncio Task")
        try:
            await self.retry()
        except BaseException:
            if self.physical_terminal():
                self._commit_completed()
            raise
        if not self.physical_terminal():
            raise RuntimeError("pending retry returned before physical terminal state")
        self._commit_completed()

    def _commit_completed(self) -> None:
        self.completed = True


@dataclass
class _AcquiredRw:
    local_release: Release
    portal_handles: list[_PortalHandle] = field(default_factory=list)


async def _acquire_cross_process_rw(
    turnstile_path: Path,
    data_path: Path,
    mode: LeaseMode,
    deadline: float,
    owned_handles: list[_PortalHandle],
) -> _CrossProcessRwLease:
    turnstile = await _acquire_portal_handle(
        turnstile_path,
        LeaseMode.EXCLUSIVE if mode is LeaseMode.EXCLUSIVE else LeaseMode.SHARED,
        deadline,
        owned_handles,
    )
    data = await _acquire_portal_handle(
        data_path, mode, deadline, owned_handles
    )
    if mode is LeaseMode.SHARED:
        await turnstile.release()
        return _CrossProcessRwLease((data,))
    # Physical release order is data then turnstile.
    return _CrossProcessRwLease((data, turnstile))


@dataclass
class FenceReceipt:
    scope: str
    expected: int
    path: Path = field(repr=False)

    def assert_current(self) -> None:
        actual = int(self.path.read_text(encoding="ascii"))
        if actual != self.expected:
            raise StaleFenceError(f"stale fence for {self.scope}")


@dataclass
class Lease:
    purpose: str
    mode: LeaseMode
    fence: int
    space_ids: tuple[str, ...]
    fences: Mapping[str, int]
    process_owner: ProcessOwnerReceipt | None
    _fence_paths: Mapping[str, Path] = field(repr=False)
    _release_stages: list[_ReleaseStage] = field(repr=False)
    _entered_order: _HeldOrder = field(repr=False)
    _retain_pending: Callable[[object], None] = field(repr=False)
    _complete_pending: Callable[[object], None] = field(repr=False)
    _cleanup_dependencies: dict[int, object] = field(default_factory=dict, repr=False)
    _order_token: Token[_HeldOrder] | None = field(
        default=None, repr=False
    )
    _owner_task: object | None = field(default_factory=asyncio.current_task, repr=False)
    _release_started: bool = field(default=False, repr=False)
    _order_reset: bool = field(default=False, repr=False)
    _released: bool = field(default=False, repr=False)

    async def __aenter__(self) -> "Lease":
        self.assert_active_owner()
        return self

    async def __aexit__(self, exc_type, exc, traceback) -> bool:
        cleanup_errors: list[BaseException] = []
        try:
            await self.release()
        except BaseExceptionGroup as group:
            cleanup_errors.extend(group.exceptions)
        except BaseException as cleanup:
            cleanup_errors.append(cleanup)
        if exc is not None and cleanup_errors:
            raise BaseExceptionGroup(
                "lease body and release failed", [exc, *cleanup_errors]
            ) from None
        if cleanup_errors:
            raise BaseExceptionGroup("lease release failed", cleanup_errors) from None
        return False

    def assert_active_owner(
        self,
        *,
        mode: LeaseMode | None = None,
        scope: str | None = None,
        require_process_owner: bool = False,
    ) -> None:
        if (
            self._released
            or self._release_started
            or asyncio.current_task() is not self._owner_task
        ):
            raise LeaseOrderError("lease is not active in its acquiring asyncio Task")
        if mode is not None and self.mode is not mode:
            raise LeaseOrderError(f"lease mode must be {mode.value}")
        if scope is not None and scope not in self.fences:
            raise LeaseOrderError(f"lease does not own fence scope {scope}")
        if require_process_owner:
            if self.process_owner is None:
                raise LeaseOrderError("destructive lease requires process-owner lineage")
            self.process_owner.assert_current()

    def retain_cleanup_dependency(self, owner: object) -> None:
        self.assert_active_owner()
        self._cleanup_dependencies[id(owner)] = owner

    def complete_cleanup_dependency(self, owner: object) -> None:
        self.assert_active_owner()
        self._cleanup_dependencies.pop(id(owner), None)

    def fence_receipt(self, scope: str) -> FenceReceipt:
        self.assert_active_owner(scope=scope)
        return FenceReceipt(scope, self.fences[scope], self._fence_paths[scope])

    def assert_fence(self, scope: str) -> None:
        self.fence_receipt(scope).assert_current()

    async def release(self) -> None:
        if self._released:
            if asyncio.current_task() is not self._owner_task:
                raise LeaseOrderError("released lease belongs to another asyncio Task")
            return
        if asyncio.current_task() is not self._owner_task:
            raise LeaseOrderError("lease release belongs to another asyncio Task")
        if _HELD_ORDER.get() != self._entered_order:
            self._retain_pending(self)
            raise LeaseOrderError("lease release violates strict reverse acquisition order")
        if self._cleanup_dependencies:
            self._retain_pending(self)
            raise LeaseOrderError("lease still owns unfinished resource cleanup")
        self._release_started = True
        errors: list[BaseException] = []
        for stage in self._release_stages:
            try:
                await stage.run()
            except BaseException as exc:
                errors.append(exc)
                # Later stages may depend on this stage's resource still being held.
                break
        if errors:
            self._retain_pending(self)
            raise BaseExceptionGroup("lease release failed", errors)
        if not all(stage.completed for stage in self._release_stages):
            raise RuntimeError("lease release stopped with unfinished stages")
        if self._order_token is not None and not self._order_reset:
            _HELD_ORDER.reset(self._order_token)
            self._order_reset = True
        self._released = True
        self._complete_pending(self)


class RuntimeLeaseCoordinator:
    REQUEST_TIMEOUT_SECONDS = 5.0
    MAINTENANCE_TIMEOUT_SECONDS = 60.0

    def __init__(
        self,
        data_root: Path,
        *,
        failpoint: Callable[[str], None] | None = None,
    ) -> None:
        self._root = Path(data_root).expanduser().resolve()
        self._runtime_dir = self._root / ".runtime"
        self._lock_dir = self._runtime_dir / "locks"
        self._fence_dir = self._runtime_dir / "fences"
        self._runtime_dir.mkdir(parents=True, exist_ok=True)
        self._global_gate = _FairRwLock()
        self._space_gates: dict[str, _FairRwLock] = {}
        self._space_gates_guard = asyncio.Lock()
        self._failpoint = failpoint or (lambda _name: None)
        self._pending_cleanups: dict[int, PendingCleanup] = {}
        self._process_exit_required = False
        self._process_exit_holds: list[object] = []

    def register_pending_cleanup(
        self,
        owner: object,
        *,
        retry: Release,
        holds: tuple[object, ...],
        physical_terminal: Callable[[], bool],
    ) -> None:
        owner_task = asyncio.current_task()
        assert owner_task is not None
        key = id(owner)
        existing = self._pending_cleanups.get(key)
        if existing is not None:
            if existing.owner_task is not owner_task:
                raise LeaseOrderError("pending cleanup owner Task changed")
            return
        self._pending_cleanups[key] = PendingCleanup(
            owner_task, retry, (owner, *holds), physical_terminal
        )

    def complete_pending_cleanup(self, owner: object) -> None:
        pending = self._pending_cleanups.get(id(owner))
        if pending is None:
            return
        if asyncio.current_task() is not pending.owner_task:
            raise LeaseOrderError("pending cleanup completion changed Task")
        if not pending.physical_terminal():
            raise RuntimeError("cannot remove nonterminal pending cleanup")
        pending.completed = True
        self._pending_cleanups.pop(id(owner))

    def register_pending_lease_cleanup(self, lease: Lease) -> None:
        self.register_pending_cleanup(
            lease,
            retry=lease.release,
            holds=(lease.process_owner, *lease._release_stages),
            physical_terminal=lambda: (
                lease._released
                and all(stage.completed for stage in lease._release_stages)
            ),
        )

    def complete_pending_lease_cleanup(self, lease: Lease) -> None:
        self.complete_pending_cleanup(lease)

    async def retry_pending_cleanups_for_current_task(
        self,
    ) -> tuple[BaseException, ...]:
        owner_task = asyncio.current_task()
        errors: list[BaseException] = []
        # Newer child owners release before older parents.
        for key, pending in reversed(tuple(self._pending_cleanups.items())):
            if pending.owner_task is not owner_task:
                continue
            try:
                await pending.run()
            except BaseExceptionGroup as group:
                errors.extend(group.exceptions)
            except BaseException as error:
                errors.append(error)
            if pending.completed or pending.physical_terminal():
                pending.completed = True
                self._pending_cleanups.pop(key, None)
                continue
            break
        return tuple(errors)

    def has_pending_cleanups_for_current_task(self) -> bool:
        owner_task = asyncio.current_task()
        return any(
            pending.owner_task is owner_task
            for pending in self._pending_cleanups.values()
        )

    def pending_cleanups_for_current_task(self) -> tuple[PendingCleanup, ...]:
        owner_task = asyncio.current_task()
        return tuple(
            pending
            for pending in self._pending_cleanups.values()
            if pending.owner_task is owner_task
        )

    def mark_process_exit_required(
        self, reason: str, *, holds: tuple[object, ...]
    ) -> None:
        self._process_exit_required = True
        self._process_exit_holds.extend((reason, *holds))

    def assert_ready(self) -> None:
        if self._process_exit_required or self._pending_cleanups:
            raise RuntimeCleanupPendingError("runtime cleanup is not terminal")

    async def acquire_process_owner(
        self, purpose: str, timeout_seconds: float
    ) -> Lease:
        held = _HELD_ORDER.get()
        if held.level != "none":
            raise LeaseOrderError("process owner must be acquired first")
        lock = FileLock(
            str(self._runtime_dir / "process-owner.lock"), thread_local=False
        )
        acquired = False
        receipt: ProcessOwnerReceipt | None = None
        token: Token[_HeldOrder] | None = None

        def commit_acquired(_ignored: object) -> None:
            nonlocal acquired
            acquired = True

        try:
            await run_joined_thread(
                lambda: lock.acquire(timeout=timeout_seconds),
                on_success=commit_acquired,
            )
            self._failpoint("after_os_acquire")
            fence_path = self._fence_dir / "process.fence"
            fence = await run_joined_thread(lambda: next_fence(fence_path))
            self._failpoint("during_fence_write")
            self._failpoint("corrupt_fence_receipt")
            if (
                type(fence) is not int
                or fence < 1
                or not fence_path.is_file()
                or int(fence_path.read_text(encoding="ascii")) != fence
            ):
                raise StaleFenceError("corrupt process-owner fence receipt")
            receipt = ProcessOwnerReceipt(
                id(self), str(self._root), asyncio.current_task()
            )
            self._failpoint("after_receipt")
            entered = _HeldOrder(
                id(self), str(self._root), asyncio.current_task(), "owner", receipt
            )
            token = _HELD_ORDER.set(entered)
            self._failpoint("after_context_token")
            lease = Lease(
                purpose=purpose,
                mode=LeaseMode.EXCLUSIVE,
                fence=fence,
                space_ids=(),
                fences=MappingProxyType({"process": fence}),
                process_owner=receipt,
                _fence_paths=MappingProxyType({"process": fence_path}),
                _release_stages=[
                    _ReleaseStage(lambda: _release_process_owner(lock, receipt))
                ],
                _entered_order=entered,
                _retain_pending=self.register_pending_lease_cleanup,
                _complete_pending=self.complete_pending_lease_cleanup,
                _order_token=token,
            )
            self._failpoint("before_lease_return")
            return lease
        except FileLockTimeout as exc:
            raise LeaseTimeoutError(f"process owner busy: {purpose}") from exc
        except BaseException as primary:
            cleanup_errors: list[BaseException] = []
            if acquired:
                try:
                    await run_joined_thread(
                        lock.release,
                        on_success=(
                            (lambda _ignored: receipt.deactivate())
                            if receipt is not None
                            else None
                        ),
                    )
                except BaseException as cleanup:
                    cleanup_errors.append(cleanup)
            if not cleanup_errors and token is not None:
                _HELD_ORDER.reset(token)
            if cleanup_errors:
                self._process_exit_required = True
                self._process_exit_holds.extend([lock, receipt, token])
                raise BaseExceptionGroup(
                    "process-owner acquire and compensation failed",
                    [primary, *cleanup_errors],
                ) from None
            raise primary

    async def acquire_global(
        self, mode: LeaseMode, purpose: str, timeout_seconds: float
    ) -> Lease:
        held = _HELD_ORDER.get()
        if held.level != "none" and held.owner_task is not asyncio.current_task():
            raise LeaseOrderError("inherited lease order belongs to another asyncio Task")
        if held.level not in {"none", "owner"}:
            raise LeaseOrderError("global lease must be acquired first")
        if held.level == "owner" and (
            held.coordinator_id != id(self) or held.root != str(self._root)
        ):
            raise LeaseOrderError("process owner belongs to another coordinator/root")
        deadline = asyncio.get_running_loop().time() + timeout_seconds
        acquired: list[_AcquiredRw] = []
        try:
            async with asyncio.timeout(timeout_seconds):
                item = _AcquiredRw(await self._global_gate.acquire(mode))
                acquired.append(item)
                await _acquire_cross_process_rw(
                    self._lock_dir / "global.turnstile",
                    self._lock_dir / "global.data",
                    mode,
                    deadline,
                    item.portal_handles,
                )
                fence_path = self._fence_dir / "global.fence"
                fence = (
                    await run_joined_thread(lambda: next_fence(fence_path))
                    if mode is LeaseMode.EXCLUSIVE
                    else self._read_fence(fence_path)
                )
        except BaseException as error:
            primary = (
                LeaseTimeoutError(f"global lease timeout: {purpose}")
                if isinstance(error, (TimeoutError, LeaseTimeoutError))
                else error
            )
            await self._release_acquired(acquired, primary)
            raise AssertionError("_release_acquired never returns")
        sequence = self._acquisition_release_sequence(acquired)
        entered = _HeldOrder(
            id(self),
            str(self._root),
            asyncio.current_task(),
            "global",
            held.process_owner,
        )
        token = _HELD_ORDER.set(entered)
        return Lease(
            purpose=purpose,
            mode=mode,
            fence=fence,
            space_ids=(),
            fences=MappingProxyType({"global": fence}),
            process_owner=held.process_owner,
            _fence_paths=MappingProxyType({"global": fence_path}),
            _release_stages=sequence.stages,
            _entered_order=entered,
            _retain_pending=self.register_pending_lease_cleanup,
            _complete_pending=self.complete_pending_lease_cleanup,
            _order_token=token,
        )

    async def acquire_spaces(
        self,
        space_ids: list[str] | tuple[str, ...],
        mode: LeaseMode,
        purpose: str,
        timeout_seconds: float,
    ) -> Lease:
        canonical = tuple(sorted(set(space_ids)))
        if not canonical or any(not value.strip() for value in canonical):
            raise ValueError("space_ids must contain non-empty IDs")
        held = _HELD_ORDER.get()
        if (
            held.level != "global"
            or held.coordinator_id != id(self)
            or held.root != str(self._root)
            or held.owner_task is not asyncio.current_task()
        ):
            raise LeaseOrderError("space leases require a held global lease")
        deadline = asyncio.get_running_loop().time() + timeout_seconds
        acquired: list[_AcquiredRw] = []
        fences: dict[str, int] = {}
        fence_paths: dict[str, Path] = {}
        try:
            async with asyncio.timeout(timeout_seconds):
                for space_id in canonical:
                    gate = await self._space_gate(space_id)
                    item = _AcquiredRw(await gate.acquire(mode))
                    acquired.append(item)
                    await _acquire_cross_process_rw(
                        self._space_turnstile_path(space_id),
                        self._space_data_path(space_id),
                        mode,
                        deadline,
                        item.portal_handles,
                    )
                    fence_path = self._space_fence_path(space_id)
                    fence_paths[space_id] = fence_path
                    fences[space_id] = (
                        await run_joined_thread(lambda: next_fence(fence_path))
                        if mode is LeaseMode.EXCLUSIVE
                        else self._read_fence(fence_path)
                    )
        except BaseException as error:
            primary = (
                LeaseTimeoutError(f"space lease timeout: {purpose}")
                if isinstance(error, (TimeoutError, LeaseTimeoutError))
                else error
            )
            await self._release_acquired(acquired, primary)
            raise AssertionError("_release_acquired never returns")
        entered = _HeldOrder(
            id(self),
            str(self._root),
            asyncio.current_task(),
            "spaces",
            held.process_owner,
            canonical,
        )
        token = _HELD_ORDER.set(entered)
        sequence = self._acquisition_release_sequence(acquired)
        return Lease(
            purpose=purpose,
            mode=mode,
            fence=max(fences.values(), default=0),
            space_ids=canonical,
            fences=MappingProxyType(fences),
            process_owner=held.process_owner,
            _fence_paths=MappingProxyType(fence_paths),
            _release_stages=sequence.stages,
            _entered_order=entered,
            _retain_pending=self.register_pending_lease_cleanup,
            _complete_pending=self.complete_pending_lease_cleanup,
            _order_token=token,
        )

    async def _space_gate(self, space_id: str) -> _FairRwLock:
        async with self._space_gates_guard:
            return self._space_gates.setdefault(space_id, _FairRwLock())

    def _space_turnstile_path(self, space_id: str) -> Path:
        digest = hashlib.sha256(space_id.encode("utf-8")).hexdigest()
        return self._lock_dir / "spaces" / f"{digest}.turnstile"

    def _space_data_path(self, space_id: str) -> Path:
        digest = hashlib.sha256(space_id.encode("utf-8")).hexdigest()
        return self._lock_dir / "spaces" / f"{digest}.data"

    def _space_fence_path(self, space_id: str) -> Path:
        digest = hashlib.sha256(space_id.encode("utf-8")).hexdigest()
        return self._fence_dir / "spaces" / f"{digest}.fence"

    @staticmethod
    def _read_fence(path: Path) -> int:
        return int(path.read_text(encoding="ascii")) if path.exists() else 0

    def _acquisition_release_sequence(
        self, acquired: list[_AcquiredRw]
    ) -> _ReleaseSequence:
        owner_task = asyncio.current_task()
        assert owner_task is not None
        stages: list[_ReleaseStage] = []
        holds: list[object] = []
        for item in reversed(acquired):
            holds.append(item)
            for handle in reversed(item.portal_handles):
                holds.append(handle)
                stages.append(_ReleaseStage(
                    handle.release,
                    physical_terminal=lambda handle=handle: handle.released,
                    completed=handle.released,
                ))
            stages.append(_ReleaseStage(item.local_release))
        held = _HELD_ORDER.get()
        if held.process_owner is not None:
            holds.append(held.process_owner)
        return _ReleaseSequence(owner_task, stages, tuple(holds))

    async def _release_acquired(
        self, acquired: list[_AcquiredRw], primary: BaseException
    ) -> None:
        sequence = self._acquisition_release_sequence(acquired)
        cleanup_errors: list[BaseException] = []
        try:
            await sequence.run()
        except BaseExceptionGroup as group:
            cleanup_errors.extend(group.exceptions)
        except BaseException as cleanup:
            cleanup_errors.append(cleanup)
        if not sequence.completed:
            self.register_pending_cleanup(
                sequence,
                retry=sequence.run,
                holds=sequence.holds,
                physical_terminal=lambda: sequence.completed,
            )
        if cleanup_errors:
            raise BaseExceptionGroup(
                "lease acquisition and cleanup failed",
                [primary, *cleanup_errors],
            ) from None
        raise primary
```

实现中不得使用 `asyncio.local`；Python 没有该 API。每个 portalocker handle、`ProcessOwnerReceipt` 和 `Lease` callback stage 的 physical terminal state都由 `run_joined_thread`/`run_joined_awaitable` 的同步 `on_success`在 acquiring owner Task提交；禁止 `await worker` 后才执行 `released=True`、`active=False` 或 `completed=True`。Private release callback可在 helper child中运行，但 public `Lease` acquire/use/release、ContextVar reset和 terminal commit始终属于原 owner Task。Double cancellation与 worker/cleanup同时失败都保持 `[original_cancel, later_cancel, *worker_or_cleanup_errors]` 顺序。

Portal lock acquisition只有外层 `_acquire_portal_handle` 是 stream/late-lock cleanup owner；nonblocking `portalocker.lock` 是非资源结果，不得配置 disposer。`_unlock_and_close` 对已关闭 stream幂等，outer owner聚合 `[primary, *cleanup_errors]`且恰好执行一次 cleanup。process-owner 从 joined OS acquire成功直到 `Lease` return 都在同一 compensation envelope：fence写入/解析、receipt构造、ContextVar set、Lease构造或 publication的任一异常/取消先 joined-release物理 lock并由 hook deactivate live receipt，再 reset partial ContextVar token；若物理 release本身失败，则强持 lock/receipt/token并设置 process-exit-required，绝不伪装为已补偿。每个 injected边界的 fresh-child regression证明成功补偿后没有 orphan owner。

失败重试跳过已完成 stage。Global/Space acquisition从第一个local gate起就把每个physical portal handle与local release放入`_AcquiredRw`；失败时`_release_acquired`构造reverse-acquisition `_ReleaseSequence`（每组OS handles先于local）。即使 helper重抛cancellation，只要stage的physical receipt已terminal就标记completed并继续下一stage；未terminal才停止并注册generic `PendingCleanup`。Primary永远在`[primary, *cleanup_errors]`首位。Pending entry强持exact remaining handles、owner Task、parent receipt/order，按稳定插入的反向dependency顺序由同一Task重试；fail-once收敛，persistent阻断readiness/parent release，owner无法收敛时标记process-exit-required。

`PendingCleanup(owner_task, retry, holds, physical_terminal)`及`register_pending_cleanup`、`complete_pending_cleanup`、lease wrapper、`retry_pending_cleanups_for_current_task`、`has_pending_cleanups_for_current_task`、`pending_cleanups_for_current_task`、`mark_process_exit_required`均在上述code block中定义，不允许只引用未实现API。Migration/isolated cleanup由`MigrationCoordinator`创建closure后调用generic registry；lease coordinator不import或理解quiescer/marker。Registry只有physical terminal success才remove，且持有strong refs。

`Lease._released=True` 与 ContextVar token reset 都只能发生在全部 stage 成功后，partial release 后普通 use/fence/`__aenter__` fail closed，但同一 owner Task 可再次调用 `release()`。ContextVar token 必须按 spaces→global 顺序 reset。portalocker handle 在 local gate 之前释放；多 Space acquisition 任一点失败都逆序释放已持有的 OS/local locks。process-owner 和 RW files 分离：只读/online snapshot 维护入口只获取 global-exclusive，以便与 live process 的 global-shared 跨进程互斥；任何 migration、replace、restore、relocation 或 cutover CLI 必须先获取 process-owner，再由同一 asyncio Task获取 global-exclusive，并把该 lineage传给 destructive lease assertion。活动 backend持有 process-owner时，第二个 destructive CLI必须 timeout，即使当时没有请求 lease。不要使用 wall-clock ownership TTL。

- [ ] **Step 6: Run dependency, unit, and cross-process lease gates**

```powershell
uv lock --check --offline
.\.venv\Scripts\python.exe -m pytest -q tests/test_runtime_leases.py -p no:cacheprovider
.\.venv\Scripts\ruff.exe check --no-cache app/runtime/leases.py tests/test_runtime_leases.py
```

Expected: PASS; tests explicitly cover cross-process global and same-Space conflicts, different-Space concurrency, writer fairness, 5/60-second policy constants, timeout code, canonical order, reverse-order rejection, process-death release, stale diagnostics ignored only after OS acquisition, cancellation cleanup, fail-once stage retry without duplicate successful callbacks or early ContextVar reset, body-primary aggregation, and monotonic persisted fences.

- [ ] **Step 7: Commit lease coordination and its locked dependency**

```powershell
git add pyproject.toml uv.lock app/runtime/__init__.py app/runtime/leases.py tests/test_runtime_leases.py
git commit -m "feat(runtime): coordinate process and space leases"
```

## Task 3: Replace Copy-Based Migration With MigrationCoordinator

**Files:**
- Consume unchanged: `backend/app/runtime/joined_thread.py`
- Modify: `backend/app/runtime/sqlite_vfs.py`
- Modify: `backend/app/db/migrations.py`
- Modify: `backend/alembic_meta/env.py`
- Modify: `backend/alembic_space/env.py`
- Consume unchanged: `backend/app/runtime/contained_io.py`
- Modify: `backend/tests/test_pxii_vfs.py`
- Modify: `backend/tests/test_migration_wal_durability.py`
- Modify: `backend/tests/test_migration_runner.py`
- Modify: `backend/tests/test_alembic_dual_environments.py`

**Interfaces:**
- Consumes: process-owner/global-exclusive lineage, target or isolated provision marker, quiescer, expected Alembic kind/head, and durability primitives.
- Produces: `MigrationStatus`/`MigrationResult`, known-revision upgrade or unchanged failure, plus `verify_open(kind, BoundSQLiteTarget)` for request-time no-reopen checks.

- [ ] **Step 1: Write failing coordinator status, WAL, concurrent-owner, and failure-boundary tests**

参数化下列 failure points：`after_backup`, `after_upgrade`, `after_integrity_check`, `before_replace`, `after_replace`。每次注入后重新打开 target，要求 `PRAGMA integrity_check='ok'` 且 revision 只能是原 head 或当前 head；`after_replace` 允许新 head，其余点必须保持原状态。WAL 测试必须让 writer 子进程以 `os._exit(0)` 退出并遗留 committed `-wal`，replace 时不得保留活动 SQLite handle。另用注入的 checkpoint connection 分别返回 `(1, log, checkpointed)` 与 `(0, log, checkpointed)` 且 `log != checkpointed`；两种情况都必须抛稳定 migration-busy error，target/temporary 不 replace，原 `-wal`/`-shm` 的存在性与 SHA-256 不变。`test_drain_failure_or_cancellation_closes_target_and_resumes_partial_quiesce` 分别让 `drain_identity()` 抛异常和取消，并断言 maintenance target 已关闭、幂等 `resume_identity()` 恰调用一次、identity 不再阻止 acquire；若 resume 本身失败，quiescer 保留显式 pending-resume owner并使 readiness/shutdown fail closed，重试成功前不得继续 migration。

Add the real regressions `test_standalone_upgrade_serializes_key_but_upgrade_once_runs_inline_in_caller_task`, `test_standalone_fail_once_pending_cleanup_converges_before_top_level_exit_and_fresh_child_acquires`, and `test_standalone_persistent_cleanup_requires_process_exit_and_keeps_locks_until_exit`. The first records `asyncio.current_task()` in `upgrade`, `_upgrade_once`, process/global acquisition, destructive work, and release and requires one object throughout while two callers for the same key serialize. The fail-once case injects a resume/release failure, proves same-Task pending cleanup converges before the top-level call exits, and then lets a real child acquire. The persistent case runs the offline coordinator in a child process, proves it emits `process_exit_required`, never emits success/readiness, and keeps process/global locks unavailable until that child exits; only process death lets a fresh child acquire.

`test_cancel_during_upgrade_worker_joins_before_close_resume_and_unlock` and `test_cancel_during_isolated_create_worker_joins_before_cleanup_and_unlock` cancel after the worker enters checkpoint/replace/create. They require the worker to reach a terminal result while process/global/drain or provision cleanup dependencies remain pinned, then perform close→resume→Space/global/process release with cancellation at element zero. Any background replace/create observed after unlock fails. Tests use real files/sidecars and never mock unlink.

Adapter 与 Alembic env 的 RED/GREEN 合同还必须包含以下具名测试：`test_alembic_adapter_runs_meta_and_space_env_on_bound_authority`、`test_alembic_adapter_rejects_raw_sqlite_connection`、`test_alembic_adapter_rejects_path_uri_or_connector_input`、`test_alembic_adapter_enforces_identity_and_write_mode`、`test_alembic_adapter_rejects_closed_or_reentrant_use`、`test_alembic_adapter_rolls_back_and_closes_on_failure_or_cancellation`、`test_alembic_envs_require_the_same_package_private_adapter`、`test_alembic_adapter_does_not_expand_bound_target_surface` 和 `test_s2_does_not_add_a_space_revision`。测试必须证明 adapter 只由仍打开的合法 `_MaintenanceConnection` 创建，绑定同一 `StorageIdentity`、read/write mode 和 connection lifecycle；raw `sqlite3.Connection`、Path、URI、token、fd/HANDLE、host connector、wrong identity, closed/reentrant/self use 全部 fail closed。Meta/Space env 只能读取 `Config.attributes["maintenance_adapter"]`，不得读取 raw connection 或自行建立 URL；失败、rollback、close 和 cancellation 后 adapter 不可复用且 native live references 为零。`BoundSQLiteTarget` public surface 仍严格为 `identity`、`make_async_engine(options)`、`open_maintenance(options)`、`aclose()`，Space head 仍为 `space_008_sync_retention_snapshot`，不得创建 `009` revision。

`test_upgrade_close_failure_never_resumes_until_close_stage_physically_completes` injects close fail-once/persistent and cancellation after physical close: fail-once retries close then resumes once; persistent retains the drained identity and exact close/resume sequence without calling resume; cancellation after a completed close still advances resume while preserving cancellation first. `test_isolated_create_never_discards_an_open_vfs_target` injects create cancellation plus close fail-once/persistent and proves discard has its own stage strictly after close. `test_verify_body_and_close_failure_are_primary_first` injects verify error/cancellation plus close error and requires exact `[body_primary, *close_errors]`; no `finally` may mask the body.

```python
class RecordingMigrationQuiescer:
    def __init__(self) -> None:
        self.drained: list[StorageIdentity] = []
        self.resumed: list[StorageIdentity] = []

    async def drain_identity(self, identity: StorageIdentity) -> None:
        self.drained.append(identity)

    async def resume_identity(self, identity: StorageIdentity) -> None:
        self.resumed.append(identity)


@pytest.mark.asyncio
async def test_coordinator_preserves_committed_wal_and_reports_space_008(
    migration_vfs_fixture,
) -> None:
    case = migration_vfs_fixture.space_at_revision(
        "space_007_session_mood_check"
    )
    case.crash_commit_wal(key="wal-marker", value="present")
    assert case.native_companion_receipt().wal_present
    quiescer = RecordingMigrationQuiescer()
    coordinator = MigrationCoordinator(
        RuntimeLeaseCoordinator(case.runtime_root), quiescer
    )

    result = await coordinator.upgrade("space", case.maintenance_request)

    assert result.head == "space_008_sync_retention_snapshot"
    assert quiescer.drained == [case.original_identity]
    assert quiescer.resumed == [case.original_identity]
    assert case.native_companion_receipt().is_clean
    target = case.bind_existing()
    try:
        with target.open_maintenance(
            MaintenanceOptions(read_only=True)
        ) as connection:
            assert connection.execute(
                "SELECT value FROM settings WHERE key='wal-marker'"
            ).fetchone() == ("present",)
    finally:
        await target.aclose()


@pytest.mark.asyncio
async def test_two_concurrent_upgrades_have_one_migration_owner(
    migration_vfs_fixture,
) -> None:
    case = migration_vfs_fixture.space_at_revision(
        "space_007_session_mood_check"
    )
    calls: list[str] = []

    def counted_migrate(kind: DatabaseKind, target: BoundSQLiteTarget) -> None:
        calls.append(kind)
        _migrate_target(kind, target)

    coordinator = MigrationCoordinator(
        RuntimeLeaseCoordinator(case.runtime_root),
        RecordingMigrationQuiescer(),
        migrate_target=counted_migrate,
    )

    first, second = await asyncio.gather(
        coordinator.upgrade("space", case.maintenance_request),
        coordinator.upgrade("space", case.maintenance_request),
    )

    assert len(calls) == 1
    assert first.head == second.head == "space_008_sync_retention_snapshot"


@pytest.mark.asyncio
async def test_cancel_after_isolated_commit_never_discards_committed_target(
    isolated_migration_fixture,
) -> None:
    case = isolated_migration_fixture.cancel_after_commit_before_owner_resume()

    with pytest.raises(asyncio.CancelledError):
        await case.create_under_lease()

    assert case.commit_count == 1
    assert case.discard_count == 0
    assert case.cleanup_authority_count == 0
    assert case.pending_cleanup_count == 0
    assert case.created_target_integrity_check == "ok"
```

`migration_vfs_fixture`通过 S1 package-private test binder建立 revision fixture，并让独立 child使用同一 native authority协议产生 crash WAL；它只向测试暴露 opaque identities、初始 maintenance binding request和不可反解的 native companion receipt，不返回 virtual token或 companion pathname。`isolated_migration_fixture`的 commit hook在native authority已删除cleanup capability、owner Task恢复之前请求取消，真实执行上述 race，不用mock commit/discard。最终 `test_migration_*` source中禁止 `sqlite3.connect`、`aiosqlite.connect`、SQLite URL和 `with_name("*-wal/-shm")`；Alembic setup与断言均使用 bound connection。

- [ ] **Step 2: Run focused migration tests and observe missing coordinator failures**

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_migration_wal_durability.py tests/test_migration_runner.py tests/test_alembic_dual_environments.py -p no:cacheprovider
```

Expected: FAIL because `MigrationCoordinator`, `MigrationStatus`, and `MigrationResult` are not defined; existing copy-based runner also fails the live WAL assertion.

- [ ] **Step 3: Implement verification and durable upgrade**

在 `backend/app/db/migrations.py` 添加并使用以下公开 records；禁止在异常文本中包含绝对路径：

```python
from typing import Protocol

from app.runtime.joined_thread import run_joined_awaitable, run_joined_thread
from app.runtime.leases import _ReleaseSequence, _ReleaseStage
from app.runtime.sqlite_vfs import (
    _alembic_maintenance_adapter,
    _bind_existing_target,
)


class MigrationQuiescer(Protocol):
    async def drain_identity(self, identity: StorageIdentity) -> None: ...

    async def resume_identity(self, identity: StorageIdentity) -> None: ...


@dataclass(frozen=True)
class MigrationStatus:
    kind: DatabaseKind
    revision: str | None
    head: str
    at_head: bool
    integrity_ok: bool


@dataclass(frozen=True)
class MigrationResult:
    kind: DatabaseKind
    previous_revision: str | None
    head: str
    changed: bool


@dataclass
class _KeyedUpgradeGate:
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    users: int = 0


class ProcessExitRequiredError(RuntimeError):
    code = "process_exit_required"
    retryable = False


def _migrate_target(kind: DatabaseKind, target: BoundSQLiteTarget) -> None:
    config = _alembic_config_for_kind(kind, connection_only=True)
    with target.open_maintenance(
        MaintenanceOptions(read_only=False, create_if_missing=False)
    ) as connection:
        with _alembic_maintenance_adapter(
            connection,
            expected_identity=target.identity,
            require_write=True,
        ) as adapter:
            config.attributes["maintenance_adapter"] = adapter
            command.upgrade(config, "head")


class MigrationCoordinator:
    def __init__(
        self,
        leases: RuntimeLeaseCoordinator,
        quiescer: MigrationQuiescer,
        *,
        failpoint: Callable[[str], None] | None = None,
        migrate_target: Callable[[DatabaseKind, BoundSQLiteTarget], None] = _migrate_target,
    ) -> None:
        self._leases = leases
        self._quiescer = quiescer
        self._failpoint = failpoint or (lambda _name: None)
        self._migrate_target = migrate_target
        self._upgrade_gates: dict[tuple[DatabaseKind, Path], _KeyedUpgradeGate] = {}
        self._upgrade_gates_guard = asyncio.Lock()
        self._process_exit_holds: dict[
            tuple[DatabaseKind, Path], tuple[object, ...]
        ] = {}

    async def _run_or_register_cleanup(
        self,
        owner: object,
        sequence: _ReleaseSequence,
        *,
        on_success: Callable[[], None] | None = None,
    ) -> list[BaseException]:
        errors: list[BaseException] = []
        committed = {"value": on_success is None}

        def commit() -> None:
            if not committed["value"]:
                assert on_success is not None
                on_success()
                committed["value"] = True

        async def retry() -> None:
            await sequence.run()
            commit()

        try:
            await retry()
        except BaseExceptionGroup as group:
            errors.extend(group.exceptions)
        except BaseException as error:
            errors.append(error)
        if not (sequence.completed and committed["value"]):
            # This closure, not RuntimeLeaseCoordinator, owns quiescer/marker details.
            self._leases.register_pending_cleanup(
                owner,
                retry=retry,
                holds=(self, *sequence.holds),
                physical_terminal=lambda: (
                    sequence.completed and committed["value"]
                ),
            )
        return errors

    async def verify(self, kind: DatabaseKind, path: Path) -> MigrationStatus:
        target = _bind_existing_target(path, create_authority=False)
        primary: BaseException | None = None
        result: MigrationStatus | None = None
        try:
            result = await self.verify_open(kind, target)
        except BaseException as error:
            primary = error
        owner = object()
        task = asyncio.current_task()
        assert task is not None
        close = _ReleaseSequence(
            task,
            [_ReleaseStage(target.aclose)],
            (target,),
        )
        cleanup_errors = await self._run_or_register_cleanup(owner, close)
        if primary is not None and cleanup_errors:
            raise BaseExceptionGroup(
                "migration verify and close failed", [primary, *cleanup_errors]
            ) from None
        if primary is not None:
            raise primary
        if cleanup_errors:
            raise BaseExceptionGroup("migration verify close failed", cleanup_errors)
        assert result is not None
        return result

    async def verify_open(
        self, kind: DatabaseKind, target: BoundSQLiteTarget
    ) -> MigrationStatus:
        return await run_joined_thread(
            lambda: _verify_bound_target(kind, target)
        )

    async def upgrade(self, kind: DatabaseKind, path: Path) -> MigrationResult:
        if _HELD_ORDER.get().level != "none":
            raise LeaseOrderError("standalone upgrade cannot inherit an existing lease")
        key = (kind, Path(path).expanduser().resolve())
        async with self._upgrade_gates_guard:
            gate = self._upgrade_gates.setdefault(key, _KeyedUpgradeGate())
            gate.users += 1
        try:
            async with gate.lock:
                # Inline execution preserves process/global Lease ownership in
                # this public caller Task; keyed serialization is not a Task hop.
                return await self._upgrade_once(kind, key[1], key)
        finally:
            async with self._upgrade_gates_guard:
                gate.users -= 1
                if gate.users == 0 and not gate.lock.locked():
                    self._upgrade_gates.pop(key, None)

    async def _upgrade_once(
        self,
        kind: DatabaseKind,
        path: Path,
        key: tuple[DatabaseKind, Path],
    ) -> MigrationResult:
        owner = await self._leases.acquire_process_owner(f"migrate:{kind}", 5)
        lease: Lease | None = None
        result: MigrationResult | None = None
        primary: BaseException | None = None
        try:
            lease = await self._leases.acquire_global(
                LeaseMode.EXCLUSIVE, f"migrate:{kind}", 60
            )
            result = await self.upgrade_under_lease(kind, path, lease)
        except BaseException as error:
            primary = error

        cleanup_errors: list[BaseException] = []
        cleanup_errors.extend(
            await self._leases.retry_pending_cleanups_for_current_task()
        )
        if not self._leases.has_pending_cleanups_for_current_task() and lease is not None:
            try:
                await lease.release()
            except BaseException as cleanup:
                cleanup_errors.append(cleanup)
            cleanup_errors.extend(
                await self._leases.retry_pending_cleanups_for_current_task()
            )
        if not self._leases.has_pending_cleanups_for_current_task():
            try:
                await owner.release()
            except BaseException as cleanup:
                cleanup_errors.append(cleanup)
            cleanup_errors.extend(
                await self._leases.retry_pending_cleanups_for_current_task()
            )

        if self._leases.has_pending_cleanups_for_current_task():
            pending = self._leases.pending_cleanups_for_current_task()
            self._process_exit_holds[key] = (owner, lease, *pending)
            self._leases.mark_process_exit_required(
                "standalone migration cleanup did not converge",
                holds=self._process_exit_holds[key],
            )
            terminal = ProcessExitRequiredError(
                "standalone migration requires offline process exit"
            )
            failures = [
                *([primary] if primary is not None else []),
                terminal,
                *cleanup_errors,
            ]
            if len(failures) == 1:
                raise failures[0]
            raise BaseExceptionGroup(
                "standalone migration cannot release ownership", failures
            ) from None

        if primary is not None and cleanup_errors:
            raise BaseExceptionGroup(
                "standalone migration and cleanup failed",
                [primary, *cleanup_errors],
            ) from None
        if primary is not None:
            raise primary
        if cleanup_errors:
            raise BaseExceptionGroup(
                "standalone migration cleanup failed", cleanup_errors
            ) from None
        assert result is not None
        return result

    async def upgrade_under_lease(
        self, kind: DatabaseKind, path: Path, lease: Lease
    ) -> MigrationResult:
        lease.assert_active_owner(
            mode=LeaseMode.EXCLUSIVE,
            scope="global",
            require_process_owner=True,
        )
        target = Path(path).expanduser().resolve()
        fence_receipt = lease.fence_receipt("global")
        maintenance_target = _bind_existing_target(target, create_authority=False)
        identity = maintenance_target.identity
        cleanup_owner = object()
        lease.retain_cleanup_dependency(cleanup_owner)
        primary: BaseException | None = None
        result: MigrationResult | None = None
        try:
            await self._quiescer.drain_identity(identity)
            lease.assert_active_owner(
                mode=LeaseMode.EXCLUSIVE,
                scope="global",
                require_process_owner=True,
            )
            result = await run_joined_thread(
                lambda: self._upgrade_locked(
                    kind, maintenance_target, fence_receipt
                )
            )
        except BaseException as error:
            primary = error
        async def resume() -> None:
            await self._quiescer.resume_identity(identity)

        task = asyncio.current_task()
        assert task is not None
        cleanup = _ReleaseSequence(
            task,
            [
                _ReleaseStage(maintenance_target.aclose),
                _ReleaseStage(resume),
            ],
            (lease, maintenance_target, identity, self._quiescer),
        )
        cleanup_errors = await self._run_or_register_cleanup(
            cleanup_owner,
            cleanup,
            on_success=lambda: lease.complete_cleanup_dependency(cleanup_owner),
        )
        if primary is not None and cleanup_errors:
            raise BaseExceptionGroup(
                "migration and cleanup failed", [primary, *cleanup_errors]
            ) from None
        if primary is not None:
            raise primary
        if cleanup_errors:
            raise BaseExceptionGroup("migration cleanup failed", cleanup_errors)
        assert result is not None
        return result

    async def create_isolated_under_lease(
        self, kind: DatabaseKind, path: Path, lease: Lease, marker: ProvisionMarker
    ) -> MigrationResult:
        lease.assert_active_owner(mode=LeaseMode.EXCLUSIVE, scope="global")
        target = marker.bind_isolated_sqlite_target(path)
        receipt = lease.fence_receipt("global")
        cleanup_owner = object()
        lease.retain_cleanup_dependency(cleanup_owner)
        primary: BaseException | None = None
        result: MigrationResult | None = None
        try:
            result = await run_joined_thread(
                lambda: self._create_isolated_file(kind, target, marker, receipt)
            )
        except BaseException as error:
            primary = error

        task = asyncio.current_task()
        assert task is not None
        close_stage = _ReleaseStage(target.aclose)
        commit_terminal = {"value": False}

        def commit_terminal_success(_ignored: object) -> None:
            commit_terminal["value"] = True

        async def commit_isolated() -> None:
            await run_joined_thread(
                lambda: marker.commit_isolated_sqlite_target(target),
                on_success=commit_terminal_success,
            )

        commit_stage = _ReleaseStage(
            commit_isolated,
            physical_terminal=lambda: commit_terminal["value"],
        )
        close_only = _ReleaseSequence(
            task,
            [close_stage, commit_stage],
            (target, marker),
        )
        cleanup_errors: list[BaseException] = []
        if primary is None:
            try:
                await close_only.run()
            except BaseExceptionGroup as group:
                cleanup_errors.extend(group.exceptions)
            except BaseException as cleanup:
                cleanup_errors.append(cleanup)
            if cleanup_errors:
                primary, *cleanup_errors = cleanup_errors
        if primary is not None and commit_stage.completed:
            lease.complete_cleanup_dependency(cleanup_owner)
            if cleanup_errors:
                raise BaseExceptionGroup(
                    "isolated create committed before cancellation",
                    [primary, *cleanup_errors],
                ) from None
            raise primary
        if primary is not None:
            async def discard() -> None:
                await run_joined_thread(
                    lambda: marker.discard_isolated_sqlite_target(target)
                )

            cleanup = _ReleaseSequence(
                task,
                [
                    close_stage,
                    _ReleaseStage(discard),
                ],
                (lease, target, marker),
            )
            cleanup_errors.extend(
                await self._run_or_register_cleanup(
                    cleanup_owner,
                    cleanup,
                    on_success=lambda: lease.complete_cleanup_dependency(
                        cleanup_owner
                    ),
                )
            )
            if cleanup_errors:
                raise BaseExceptionGroup(
                    "isolated create and cleanup failed",
                    [primary, *cleanup_errors],
                ) from None
            raise primary
        lease.complete_cleanup_dependency(cleanup_owner)
        assert result is not None
        return result
```

`_alembic_config_for_kind()` 只选择固定 Meta/Space script location，移除/拒绝 `sqlalchemy.url`。`env.py` 必须且只能消费 `Config.attributes["maintenance_adapter"]` 并调用其 package-private execution entry；任何 raw `sqlite3.Connection`、Alembic URL、`Path`/URI connector 或新 connection 都失败。`_alembic_maintenance_adapter` 只能由合法、仍打开的 `_MaintenanceConnection` 创建，在 S1 Module 内部将同一 authority-bound DBAPI connection 临时适配成 Alembic 所需的受限 SQLAlchemy `Connection`，绑定 `StorageIdentity`、read/write mode 和生命周期；它不返回 raw connection，不允许 wrong identity、closed/reentrant/self use，并在 body failure、rollback、close 或 cancellation 后 fail closed。该 package-private integration 不增加 `BoundSQLiteTarget` 的四成员 public surface。`_upgrade_locked` 的固定顺序是：

1. quiescer 已确认 target 的 engine/pool/SQLite handle 全部关闭；调用 S1 SQLite Module 的 package-private `begin_bound_replacement(maintenance_target)` 获得 opaque replacement authority和其 `BoundSQLiteTarget`，不取得 temporary pathname；existing target 用 `sqlite_online_backup(maintenance_target, replacement.target)`，fresh target 仅由 one-shot isolated-create binding 创建；
2. `after_backup` failpoint；
3. `self._migrate_target(kind, replacement.target)`，Alembic只使用注入的 open connection；
4. `after_upgrade`；
5. `_verify_bound_target` 要求 known revision、single head、`integrity_check=ok`；
6. `after_integrity_check`；
7. 关闭 source/replacement 的全部 SQLite connection；由 replacement authority 内部对 source 执行 `PRAGMA wal_checkpoint(TRUNCATE)` 并读取 `(busy, log_frames, checkpointed_frames)`。只有 `busy == 0` 且 `log_frames == checkpointed_frames` 才封存；busy、缺行或 frame 数不等立即 fail closed。VFS 在 bound parent 内部处理并验证 WAL/SHM/journal companions，S2 不构造、读取或删除 sidecar 名称；
8. 在 `before_replace` 的紧邻位置调用传入的 `FenceReceipt.assert_current()` 重读持久 fence，值不等则拒绝 replace；不得只比较传入整数或访问已缓存值；
9. `before_replace`；
10. `replacement.commit_bound_replace()` 在 S1 authority 内部执行 write-through atomic replace、main/parent durability和identity receipt更新；
11. `after_replace`；
12. 通过 replacement 返回的新 bound identity再次 verify，确认没有旧 companion state，并返回 result。

`lease.fence_receipt("global")` 从 `lease.fences["global"]` 复制 expected value，并同时绑定持久 fence path；replace 前只调用 receipt 的重读断言，不能把该 expected value 当成当前值。`MigrationQuiescer.drain_identity(identity)` / `resume_identity(identity)` 是 existing-file replace 的成对异步 Interface；Task 6 由引用计数 manager 实现。Coordinator under exclusive lease只允许现有 S1 package-private `_bind_existing_target(path, create_authority=False)` 把初始 path一次性转换为 `BoundSQLiteTarget`/`StorageIdentity`；不存在且不得引入 `open_sqlite_target_for_maintenance` helper。此后 backup、migration、verification、checkpoint、replacement和discard全都消费 opaque authority。Manager从不按该 path reopen，`verify_open()`只借用调用方 target且不关闭/转成 pathname。`begin_bound_replacement`/`commit_bound_replace`/`discard_bound_replacement`不增加 `BoundSQLiteTarget` 的四成员 public surface，且只能由 migration Module在有效 process-owner + global-exclusive fence下调用。

`upgrade_under_lease()` 在 maintenance target打开后立即进入统一 primary/cleanup包络并在该包络内调用 drain。Destructive thread由 joined helper持有到 terminal，期间 process/global/drain cleanup dependency保持 live；随后`_ReleaseSequence`严格执行 target `aclose()`→幂等 `resume_identity(identity)`→cleanup dependency completion→global/process release。Resume stage只有close stage physical `completed`后才可运行；close failure保留drained identity及exact pending sequence。Outer cancellation若发生在physical close之后，close stage先commit terminal，sequence继续resume，再按`[original_cancel, *later_cancels, *terminal_errors]`传播。MigrationCoordinator创建捕获quiescer/target/lease的retry closure并交给generic registry；lease coordinator不理解quiescer。

`create_isolated_under_lease()` pin global/provision dependency直到create worker terminal。成功路径严格执行 target close→`commit_isolated_sqlite_target`，只有 package-private authority确认 main identity/durability并销毁 cleanup capability后才发布 result。`commit_terminal_success`由joined helper在owner Task同步提交；如果native commit已physical terminal后才重抛outer cancellation，`commit_stage.completed`使调用方完成lease dependency并传播该 cancellation，绝不进入discard。只有worker/close/commit在physical commit前的 cancellation或failure才进入close→discard→dependency sequence；discard有独立completion stage且永不在open VFS target上执行。`verify(path)`也使用primary envelope与close sequence，body error/cancellation始终位于close errors之前，禁止`finally`覆盖。Persistent close/discard保留strong pending owner并阻断success/readiness。

Standalone `upgrade()` 的 keyed gate只串行化相同 key；`_upgrade_once` inline运行于 public caller Task，源码禁止 `create_task(_upgrade_once)`。Top-level在释放 global/process前重试 same-Task pending cleanup；fail-once必须收敛并允许 fresh child acquire。Persistent pending cleanup把 exact owner/global/cleanup objects存入 process-exit hold，设置 `process_exit_required`，丢弃任何 result并保持物理locks直到 offline process退出；readiness和success都禁止。活动 backend即使无 request lease，第二进程也必须 timeout。删除 `shutil.copy2`。`run_migrations(kind, path)` 仅是明确持 process-owner的隔离进程 wrapper。Space仍固定 `space_008_sync_retention_snapshot`。

- [ ] **Step 4: Run migration and durability gates**

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_migration_wal_durability.py tests/test_migration_runner.py tests/test_alembic_dual_environments.py -p no:cacheprovider
.\.venv\Scripts\ruff.exe check --no-cache app/db/migrations.py app/runtime tests/test_migration_wal_durability.py tests/test_migration_runner.py
```

Expected: PASS; every failpoint leaves an openable known revision, concurrent calls execute one migration, committed WAL data survives, active handles are drained before replacement, and no stale `-wal`/`-shm` remains.

- [ ] **Step 5: Commit MigrationCoordinator**

```powershell
git add app/runtime/sqlite_vfs.py app/db/migrations.py alembic_meta/env.py alembic_space/env.py tests/test_pxii_vfs.py tests/test_migration_wal_durability.py tests/test_migration_runner.py tests/test_alembic_dual_environments.py
git commit -m "feat(migrations): make sqlite upgrades wal durable"
```

## Task 4: Compile And Freeze The Entity Catalog

**Files:**
- Create: `backend/app/registry/catalog.py`
- Modify: `backend/app/registry/__init__.py`
- Modify: `backend/app/registry/builtin.py`
- Modify: `backend/app/registry/resolve.py`
- Modify: `backend/app/registry/sync_registry.py`
- Modify: `backend/app/services/sync_entity_types.py`
- Modify: `backend/app/services/meta.py`
- Modify: `backend/app/schemas/meta.py`
- Modify: `backend/app/routes/v1/meta.py`
- Modify: `backend/app/routes/v1/trash.py`
- Create: `backend/tests/test_compiled_entity_catalog.py`
- Modify: `backend/tests/test_parity_registry_orm.py`
- Modify: `backend/tests/test_registry.py`
- Modify: `backend/tests/test_registry_integration.py`
- Modify: `backend/tests/test_routes_meta.py`
- Create: `backend/tests/test_trash_catalog_consumer.py`

**Interfaces:**
- Consumes: mutable startup `EntitySpec` registrations and compile version.
- Produces: sealed deterministic `CompiledEntityCatalog`, resolved ORM models, stable version/hash, and the sole protocol-key lookup surface.

- [ ] **Step 1: Write failing compilation and deterministic-hash tests**

```python
from dataclasses import replace

import pytest

from app.registry import REGISTRY
from app.registry.catalog import CatalogCompilationError, CompiledEntityCatalog


def test_builtin_catalog_is_immutable_and_resolves_effective_sync_key() -> None:
    catalog = CompiledEntityCatalog.compile(REGISTRY.list(), version="1")

    assert catalog.version == "1"
    assert len(catalog.hash) == 64
    assert catalog.get("quick_note").effective_sync_entity_type == "quickNote"
    assert catalog.get_by_sync_key("quickNote").name == "quick_note"
    assert tuple(spec.name for spec in catalog.list_sync_enabled()) == tuple(
        spec.name for spec in catalog.list_sync_enabled()
    )
    with pytest.raises(TypeError):
        catalog._by_name["new"] = catalog.get("note")


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("table_name", "notes", "table"),
        ("route_prefix", "/notes", "route"),
        ("sync_entity_type", "note", "sync"),
        ("primary_key", "missing", "primary key"),
        ("delete_strategy", "unknown", "delete strategy"),
    ],
)
def test_compile_rejects_every_effective_key_collision(field, value, message) -> None:
    note = REGISTRY.get("note")
    conflicting = replace(REGISTRY.get("quick_note"), name="conflict", **{field: value})
    with pytest.raises(CatalogCompilationError, match=message):
        CompiledEntityCatalog.compile([note, conflicting], version="1")
```

另加 unresolved model/service/schema、route enabled 但无 prefix/service/schema、MCP flag 不一致、复合/非字符串/nullable sync primary key、重复 compile、交换输入顺序 hash 不变以及 trash production consumer 不绕过 catalog 的测试。

- [ ] **Step 2: Run catalog tests and verify missing compiler failures**

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_compiled_entity_catalog.py tests/test_registry.py tests/test_registry_integration.py -p no:cacheprovider
```

Expected: FAIL on missing `app.registry.catalog`.

- [ ] **Step 3: Implement the immutable compiler and switch consumers**

`backend/app/registry/catalog.py` 的稳定公开面如下：

Startup calls `CATALOG = REGISTRY.compile(version="1")` exactly once. Meta,
Sync, parity, and trash production consumers receive this frozen catalog and
use `CATALOG.model_for(name)`; they never walk mutable `REGISTRY` or call a
dynamic resolver after startup.

Task-owned negative contracts explicitly cover `service_path`, `schema_module`,
`schema_prefix`, `mcp_schema_enabled`, composite primary key rejection, and
the rule that no production path dynamically resolves models after compile.

```python
@dataclass(frozen=True)
class CompiledEntityCatalog:
    version: str
    hash: str
    _by_name: Mapping[str, EntitySpec] = field(repr=False)
    _by_sync_key: Mapping[str, EntitySpec] = field(repr=False)
    _sync_enabled: tuple[EntitySpec, ...] = field(repr=False)
    _models_by_name: Mapping[str, type[Any]] = field(repr=False)

    @classmethod
    def compile(
        cls, specs: Iterable[EntitySpec], *, version: str
    ) -> "CompiledEntityCatalog":
        ordered = tuple(sorted(specs, key=lambda item: item.name))
        _validate_specs(ordered)
        canonical = json.dumps(
            [_canonical_spec(spec) for spec in ordered],
            ensure_ascii=True,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        return cls(
            version=version,
            hash=hashlib.sha256(canonical).hexdigest(),
            _by_name=MappingProxyType({spec.name: spec for spec in ordered}),
            _by_sync_key=MappingProxyType(
                {spec.effective_sync_entity_type: spec for spec in ordered if spec.sync_enabled}
            ),
            _sync_enabled=tuple(spec for spec in ordered if spec.sync_enabled),
            _models_by_name=MappingProxyType({
                spec.name: resolve_model_path(spec.model_path) for spec in ordered
            }),
        )

    def get(self, name: str) -> EntitySpec:
        return self._by_name[name]

    def get_by_sync_key(self, key: str) -> EntitySpec:
        return self._by_sync_key[key]

    def try_get_by_sync_key(self, key: str) -> EntitySpec | None:
        return self._by_sync_key.get(key)

    def model_for(self, name: str) -> type[Any]:
        return self._models_by_name[name]

    def list_sync_enabled(self) -> tuple[EntitySpec, ...]:
        return self._sync_enabled
```

`_validate_specs` 必须逐项验证：name/table/route/sync key 唯一（包括 disabled route declarations）；primary key 存在于单一已解析模型 mapper，拒绝复合 primary key；sync primary key 必须 non-null、字符串 mapper、1..64 identifier 合同；delete strategy 属于明确 allowlist；model、service、schema module 和 schema prefix 均须完成 import/attribute/协议解析；`route_enabled` 要求 route prefix/service/schema 三者完整且可解析；MCP schema flag 与可解析 schema 一致，禁止 enabled 但缺失或不可解析。compile 在构造返回值前只解析每个 model path 一次，并将精确 class identity 存入 `_models_by_name`；交换输入顺序不改变 hash/model mapping。`EntityRegistry.compile(version="1")` 是 startup-only 原子 seal；第二次 compile 必须以稳定 `CatalogCompilationError(code=catalog_already_compiled)` fail closed，不能返回新对象或改变 hash；之后 `register()` 同样拒绝。所有 production consumer（包括 trash 和 registry resolver）只能消费 frozen catalog 的 compiled model，不得重新遍历 mutable REGISTRY 或动态 resolve_model；`resolve.py` 仅保留明确的 package-private test/parity compatibility boundary，生产路径不得调用。Meta health 增加 additive `catalog_version`、`catalog_hash`，不改变现有字段。

For every `sync_enabled` spec, compilation additionally requires the declared primary-key mapper column to be nonnullable and string-typed with the public 1..64 identifier contract. A future integer/natural key is rejected at startup until the snapshot cursor is deliberately generalized; `_iter_records` may therefore use the empty-string lower bound safely. Tests include one non-`id` string primary key and explicit nullable/integer rejection.

- [ ] **Step 4: Run registry/meta contract tests**

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_compiled_entity_catalog.py tests/test_registry.py tests/test_registry_integration.py tests/test_routes_meta.py tests/test_trash_catalog_consumer.py -p no:cacheprovider
.\.venv\Scripts\ruff.exe check --no-cache app/registry app/services/meta.py app/schemas/meta.py app/routes/v1/meta.py tests/test_compiled_entity_catalog.py
```

Expected: PASS; hash is order-independent and all registry consumers use the same compiled instance.

- [ ] **Step 5: Commit catalog compilation**

```powershell
git add app/registry/catalog.py app/registry/__init__.py app/registry/builtin.py app/registry/resolve.py app/registry/sync_registry.py app/services/sync_entity_types.py app/services/meta.py app/schemas/meta.py app/routes/v1/meta.py app/routes/v1/trash.py tests/test_compiled_entity_catalog.py tests/test_parity_registry_orm.py tests/test_registry.py tests/test_registry_integration.py tests/test_routes_meta.py tests/test_trash_catalog_consumer.py
git commit -m "feat(registry): compile immutable entity catalog"
```

## Task 5: Make IndexStoreSchema The Only index.db Schema Authority

**Files:**
- Create: `backend/app/file_system/index_schema.py`
- Consume unchanged: `backend/app/runtime/contained_io.py`
- Modify: `backend/app/file_system/schema.py`
- Modify: `backend/app/file_system/engine/base.py`
- Create: `backend/tests/test_index_store_schema.py`
- Modify: `backend/tests/test_file_system/test_schema.py`

**Interfaces:**
- Consumes: isolated provision/upgrade SQLite target or identity-bound open index target plus expected schema version.
- Produces: sole index schema verify/upgrade/rebuild authority, including `verify_open(BoundSQLiteTarget)` with no pathname reopen.

- [ ] **Step 1: Write failing fresh, v1 upgrade, rebuild, and verification tests**

```python
from __future__ import annotations

import pytest

from app.errors import IndexStorageMissingError
from app.file_system.index_schema import INDEX_SCHEMA_VERSION, IndexStoreSchema
from app.runtime.sqlite_vfs import MaintenanceOptions

EXPECTED_INDEXES = {
    "ix_notes_folder_id",
    "ix_notes_level",
    "ix_notes_status",
    "ix_notes_updated_at",
    "ix_folders_parent_id",
    "ix_folders_trashed_at",
}


def test_fresh_index_store_has_tables_fts_triggers_and_declared_indexes(
    new_bound_index_target,
) -> None:
    schema = IndexStoreSchema()

    status = schema.upgrade_open(
        new_bound_index_target, create_if_missing=True
    )

    assert status.version == INDEX_SCHEMA_VERSION
    assert status.valid
    with new_bound_index_target.open_maintenance(
        MaintenanceOptions(read_only=True)
    ) as db:
        objects = dict(db.execute("SELECT name, type FROM sqlite_master"))
        indexes = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='index'")}
        assert {"notes", "folders", "note_paths", "note_versions", "note_links"} <= set(objects)
        assert objects["notes_fts"] == "table"
        assert {"notes_fts_insert", "notes_fts_update", "notes_fts_delete"} <= set(objects)
        assert EXPECTED_INDEXES <= indexes


def test_upgrade_from_v1_preserves_rows_and_creates_missing_indexes(
    v1_bound_index_target,
) -> None:
    with v1_bound_index_target.open_maintenance(
        MaintenanceOptions(read_only=False)
    ) as db:
        db.execute(
            "INSERT INTO folders (id, name, current_path) VALUES ('f1', 'Folder', 'Folder')"
        )
        db.commit()

    IndexStoreSchema().upgrade_open(
        v1_bound_index_target, create_if_missing=False
    )

    with v1_bound_index_target.open_maintenance(
        MaintenanceOptions(read_only=True)
    ) as db:
        assert db.execute("SELECT name FROM folders WHERE id='f1'").fetchone() == ("Folder",)
        assert db.execute("SELECT value FROM schema_meta WHERE key='version'").fetchone() == (
            str(INDEX_SCHEMA_VERSION),
        )


def test_read_only_binding_of_missing_index_does_not_create_file(
    missing_index_binding,
) -> None:
    with pytest.raises(IndexStorageMissingError):
        missing_index_binding.bind_existing()
    assert missing_index_binding.created_paths == ()


def test_verify_open_uses_identity_bound_connector_without_pathname_reopen(
    bound_index_target,
) -> None:
    with bound_index_target.forbid_host_path_connectors():
        status = IndexStoreSchema().verify_open(bound_index_target)

    assert status.valid
    assert bound_index_target.bound_connect_count == 1
```

`v1_bound_index_target` fixture 必须从 `schema.py` 的 DDL通过 bound connection创建真实 v1，不使用伪造空文件；`new_bound_index_target`来自 S1 one-shot test binder。另测删除一个 ordinary index 后 `verify_open()` 返回 stable missing list，`rebuild_open()` 修复且 Note/FTS 行数不变。所有 fixture在 test teardown中先关闭 connection再 `await target.aclose()`，禁止 pathname connector。

- [ ] **Step 2: Run index schema tests and verify the six-index failure**

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_index_store_schema.py tests/test_file_system/test_schema.py -p no:cacheprovider
```

Expected: FAIL because `IndexStoreSchema` is missing and the current fresh database lacks the six declared ordinary indexes.

- [ ] **Step 3: Implement version 2 and explicit CreateIndex execution**

`backend/app/file_system/index_schema.py` 固定提供：

```python
INDEX_SCHEMA_VERSION = 2


@dataclass(frozen=True)
class IndexSchemaStatus:
    version: int
    valid: bool
    missing_tables: tuple[str, ...]
    missing_indexes: tuple[str, ...]
    missing_fts_objects: tuple[str, ...]
    failure_code: str | None = None


class IndexStoreSchema:
    def verify_open(self, target: BoundSQLiteTarget) -> IndexSchemaStatus:
        with target.open_maintenance(MaintenanceOptions(read_only=True)) as connection:
            return _inspect_status(connection)

    def upgrade_open(
        self,
        target: BoundSQLiteTarget,
        *,
        create_if_missing: bool,
    ) -> IndexSchemaStatus:
        with target.open_maintenance(
            MaintenanceOptions(
                read_only=False,
                create_if_missing=create_if_missing,
            )
        ) as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA foreign_keys=ON")
            _create_tables(connection)
            _run_versioned_migrations(connection)
            _create_fts_objects(connection)
            _create_ordinary_indexes(connection)
            connection.commit()
        status = self.verify_open(target)
        if not status.valid:
            raise IndexSchemaError(f"index schema invalid: {status}")
        return status

    def rebuild_open(self, target: BoundSQLiteTarget) -> IndexSchemaStatus:
        with target.open_maintenance(
            MaintenanceOptions(read_only=False)
        ) as connection:
            for name in sorted(ORDINARY_INDEX_SQL):
                connection.execute(f'DROP INDEX IF EXISTS "{name}"')
                connection.execute(ORDINARY_INDEX_SQL[name])
            connection.commit()
        return self.verify_open(target)
```

`verify_open()`、`upgrade_open()`和`rebuild_open()`都只借用 S1 `BoundSQLiteTarget.open_maintenance(options)`，不接受/派生 host pathname且不关闭 target。Request/runtime只能调用 `verify_open()`；isolated provision/startup/maintenance owner在相应 exclusive lease下先通过 S1 binder取得 target，再调用 write入口，并在最后 `await target.aclose()`。`create_if_missing=True`只用于 marker-bound exact-absent target；existing target传 true 会由 S1 adapter拒绝。删除所有 sync path overload和内部 target factory。`ORDINARY_INDEX_SQL` 必须从 `Base.metadata.sorted_tables[*].indexes` 通过 SQLAlchemy `CreateIndex(index, if_not_exists=True)` 编译，不能再假设 `CreateTable` 包含普通索引。v2 migration 只补普通 indexes 并推进 `schema_meta.version`；FTS objects 单独校验。`schema.py.init_database(target: BoundSQLiteTarget, *, create_if_missing: bool)` 仅委托 `IndexStoreSchema().upgrade_open()`，不得保留 pathname overload、`_SCHEMA_VERSION_LATEST` 或 `_MIGRATIONS` 的第二 authority。

- [ ] **Step 4: Run fresh/upgrade/rebuild tests**

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_index_store_schema.py tests/test_file_system/test_schema.py tests/test_file_system/test_full_flow.py -p no:cacheprovider
.\.venv\Scripts\ruff.exe check --no-cache app/file_system/index_schema.py app/file_system/schema.py app/file_system/engine/base.py tests/test_index_store_schema.py
```

Expected: PASS; fresh and upgraded stores report version 2 and contain every declared ordinary index and FTS object without data loss; read-only verification cannot create an absent target, and all three operations succeed through bound targets while every pathname SQLite connector is forced to fail.

- [ ] **Step 5: Commit IndexStoreSchema**

```powershell
git add app/file_system/index_schema.py app/file_system/schema.py app/file_system/engine/base.py tests/test_index_store_schema.py tests/test_file_system/test_schema.py
git commit -m "feat(storage): verify and upgrade index store schema"
```

## Task 6: Make Engine Handles Reference-Counted And Migration-Free

**Files:**
- Modify: `backend/app/space_manager.py`
- Consume unchanged: `backend/app/runtime/contained_io.py`
- Modify: `backend/tests/test_space_manager.py`
- Modify: `backend/tests/conftest.py`

**Interfaces:**
- Consumes: Space ID and S1 `ContainedSpaceOpens` carrying a transferable identity-bound database target.
- Produces: awaited, reference-counted, retryable `EngineHandle`, identity-bound cache entries, and migration quiescer drain/resume.

- [ ] **Step 1: Write failing explicit-path and drain tests**

```python
@pytest.mark.asyncio
async def test_engine_manager_rejects_bare_path_without_touching_it(tmp_path: Path) -> None:
    manager = SpaceEngineManager(max_size=2)
    missing = tmp_path / "missing" / "space.db"

    with pytest.raises(TypeError, match="ContainedSpaceOpens"):
        await manager.acquire("space-1", missing)

    assert not missing.exists()
    assert not missing.parent.exists()


@pytest.mark.asyncio
async def test_eviction_waits_for_active_handle(containment_fixture) -> None:
    first_capability = await containment_fixture.register_migrated("one")
    second_capability = await containment_fixture.register_migrated("two")
    manager = SpaceEngineManager(max_size=1)
    async with first_capability.open_verified() as first_opens:
        first = await manager.acquire("one", first_opens)

    async def acquire_second() -> EngineHandle:
        async with second_capability.open_verified() as second_opens:
            return await manager.acquire("two", second_opens)

    second_task = asyncio.create_task(acquire_second())
    await asyncio.sleep(0)
    assert not second_task.done()

    await first.release()
    second = await second_task
    await second.release()
    await manager.dispose_all()


@pytest.mark.asyncio
async def test_engine_release_fail_once_is_retryable_by_owner_without_duplicate_success(
    containment_fixture,
) -> None:
    capability = await containment_fixture.register_migrated("retry")
    manager = SpaceEngineManager(max_size=1)
    async with capability.open_verified() as opens:
        handle = await manager.acquire("retry", opens)
    fault = manager.fail_next_release_before_effect("retry")

    with pytest.raises(OSError, match="injected engine release"):
        await handle.release()

    assert handle._released is False
    assert handle.session_access_is_blocked_after_release_started()
    await handle.release()
    await handle.release()
    assert fault.attempt_count == 2
    assert fault.successful_callback_count == 1
    assert manager.ref_count("retry") == 0
```

- [ ] **Step 2: Run manager tests and observe implicit creation behavior**

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_space_manager.py -p no:cacheprovider
```

Expected: FAIL because current `get_engine()` creates parents and calls migrations, and eviction schedules disposal without awaiting active users.

- [ ] **Step 3: Implement awaited EngineHandle ownership**

增加：

```python
@dataclass
class EngineHandle:
    space_id: str
    engine: AsyncEngine
    _session_factory: async_sessionmaker[AsyncSession] = field(repr=False)
    _release_callback: Callable[[], Awaitable[None]]
    _owner_task: object = field(default_factory=asyncio.current_task, repr=False)
    _release_started: bool = False
    _released: bool = False

    @property
    def session_factory(self) -> async_sessionmaker[AsyncSession]:
        if self._release_started or self._released:
            raise LeaseOrderError("engine handle release has started")
        return self._session_factory

    async def release(self) -> None:
        if self._released:
            if asyncio.current_task() is not self._owner_task:
                raise LeaseOrderError("engine handle belongs to another asyncio Task")
            return
        if asyncio.current_task() is not self._owner_task:
            raise LeaseOrderError("engine handle release belongs to another asyncio Task")
        self._release_started = True
        await self._release_callback()
        self._released = True
```

将唯一 public request acquisition 改为 `await manager.acquire(space_id: str, opens: ContainedSpaceOpens) -> EngineHandle`；删除所有 `ContainedSpacePaths`/`Path`/string/default-path overload。调用位于 `async with scope.containment.open_verified()` 内；manager一次性取得 `opens.take_database_target()`，只调用 `target.make_async_engine(options)`并缓存 `StorageIdentity` 与 target，绝不读取、保存或重开未钉住的 host pathname。获取前 target 已证明是 existing regular file；同 ID 不同 identity 直接失败。cache entry 持有 `ref_count` 和 `drained` event；LRU eviction 标记 draining，等待 ref_count 为 0 后 `await engine.dispose()`再 `await target.aclose()`，不得 `create_task` 后丢弃。若 capability context 的退出身份复验失败，revocation关闭刚转移的 target，manager移除 provisional entry并不得返回成功 handle。删除 `_init_schema` 以及 settings-derived default path。测试 fixture必须显式调用 offline migration helper，再通过 S1 capability取得 `ContainedSpaceOpens`。

`EngineHandle.release()` 的 callback 只有成功返回后才设置 `_released=True`；第一次 release 尝试后普通 session access fail closed，但同一 acquiring Task 可以重试未完成 callback。成功 callback不得重复，wrong-Task release稳定失败。fail-once regression必须证明第一次失败保留 ref，第二次成功归零，第三次 no-op。

同时实现 Task 3 的 `MigrationQuiescer` Interface：`await manager.drain_identity(storage_identity)` 在首次可取消 await 前登记该 identity 的 draining owner，阻止新 acquire、等待 ref_count 归零、`await engine.dispose()` 并关闭 bound target，只在幂等 `resume_identity()` 后重新允许获取。drain 任意阶段失败或取消时，coordinator 仍调用同一个 resume；resume 未完成或失败时，manager 保留绑定 acquiring Task/identity 的 pending-resume owner，`assert_ready()` 与 graceful shutdown 均失败，且同一 Task 的显式 retry 只重做未完成 cleanup，成功后才删除 owner。`MigrationCoordinator.upgrade_under_lease()` 在 exclusive lease下用 maintenance no-follow opener取得 target identity，在 replace 的整个边界保持它 drained，并在统一 cleanup 包络调用 `resume_identity()`；manager不按 maintenance path reopen。测试覆盖 Windows 风格“活动 handle 阻止 replace”、drain exception/cancellation、resume fail-once/persistent failure、same-Task retry和异常后的恢复获取。

- [ ] **Step 4: Run manager and fixture regressions**

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_space_manager.py tests/test_routes_v1.py tests/test_integration.py -p no:cacheprovider
.\.venv\Scripts\ruff.exe check --no-cache app/space_manager.py tests/test_space_manager.py tests/conftest.py
$rgOutput = & rg -n "run_migrations|space_db_path" app/space_manager.py 2>&1
$rgStatus = $LASTEXITCODE
if ($rgStatus -eq 0) {
    $rgOutput | Write-Output
    throw 'forbidden migration or settings-derived path remains in SpaceEngineManager'
}
if ($rgStatus -gt 1) {
    $rgOutput | Write-Output
    throw "rg failed with exit code $rgStatus"
}
```

Expected: PASS; fail-once engine release retries only its unfinished callback and reaches zero refs. The executed `rg` guard treats exit `0` as a forbidden match and fails, exit `1` as the required zero-match result, and any exit greater than `1` as a search failure.

- [ ] **Step 5: Commit engine ownership changes**

```powershell
git add app/space_manager.py tests/test_space_manager.py tests/conftest.py
git commit -m "refactor(runtime): require explicit leased engine handles"
```

## Task 7: Implement Authoritative SpaceRuntime Open And Health

**Files:**
- Create: `backend/app/runtime/space.py`
- Consume unchanged: `backend/app/runtime/contained_io.py`
- Consume unchanged: `backend/app/runtime/joined_thread.py`
- Modify: `backend/app/runtime/scope.py`
- Modify: `backend/app/runtime/__init__.py`
- Modify: `backend/app/runtime/leases.py`
- Modify: `backend/app/settings.py`
- Modify: `backend/app/file_system/api.py`
- Modify: `backend/app/deps.py`
- Modify: `backend/app/mcp/server.py`
- Create: `backend/tests/test_space_lifecycle.py`
- Modify: `backend/tests/test_file_system/test_api.py`
- Modify: `backend/tests/test_runtime_leases.py`
- Modify: `backend/tests/test_settings.py`
- Modify: `backend/tests/test_routes_v1.py`
- Modify: `backend/tests/test_deps.py`
- Modify: `backend/tests/test_space_path_containment.py`
- Modify: `backend/tests/test_mcp_authorization.py`
- Modify: `backend/tests/test_mcp_server.py`

**Interfaces:**
- Consumes: authorized scope capability, opaque `ContainedSpaceOpens`, global/Space leases, registered identities, migration/index open verifiers, and canonical root settings.
- Produces: the sole `SpaceRuntimeHandle`, authoritative read/mutation activation, fail-closed health, same-owner retryable cleanup, and request dependency lifetime.

- [ ] **Step 1: Write failing authoritative-path, missing-store, and lease-lifetime tests**

```python
@pytest.mark.asyncio
async def test_open_uses_registered_paths_not_settings_formula(runtime_fixture) -> None:
    principal, scope_service, registered = await runtime_fixture.register_relocated_space()

    handle = await scope_service.open(principal, registered.id, mode="read")
    async with handle:
        assert runtime_fixture.engine_opened_identity == (
            runtime_fixture.registered_database_identity(registered.id)
        )
        assert runtime_fixture.file_system_opened_identities == (
            runtime_fixture.registered_notes_identity(registered.id),
            runtime_fixture.registered_index_identity(registered.id),
        )
        assert runtime_fixture.all_resource_opens_were_inside_open_verified()
        assert runtime_fixture.pathname_reopen_count == 0


@pytest.mark.asyncio
async def test_missing_registered_store_fails_without_recreation(runtime_fixture) -> None:
    principal, scope_service, registered = await runtime_fixture.register_space()
    registered.db_path.unlink()

    with pytest.raises(SpaceStorageMissingError) as captured:
        await scope_service.open(principal, registered.id, mode="read")

    assert captured.value.code == "space_storage_missing"
    assert not registered.db_path.exists()


@pytest.mark.asyncio
async def test_open_verifies_but_does_not_upgrade_request_time(runtime_fixture, monkeypatch) -> None:
    principal, scope_service, registered = await runtime_fixture.register_space()
    runtime = scope_service.runtime
    monkeypatch.setattr(runtime.migrations, "upgrade", AsyncMock(side_effect=AssertionError("lazy")))

    async with await scope_service.open(principal, registered.id, mode="read"):
        return


@pytest.mark.asyncio
async def test_request_file_system_open_never_creates_or_initializes(tmp_path, monkeypatch):
    notes = tmp_path / "missing-notes"
    index_db = tmp_path / "missing-index.db"
    monkeypatch.setattr(FileSystemStorage, "init", AsyncMock(side_effect=AssertionError("init")))
    with pytest.raises(TypeError, match="ContainedSpaceOpens"):
        await open_existing_file_system(notes, index_db)
    assert not notes.exists()
    assert not index_db.exists()


@pytest.mark.parametrize("role", ["db", "notes", "index"])
@pytest.mark.parametrize("swap_kind", ["symlink", "junction", "same-name-replacement"])
@pytest.mark.asyncio
async def test_protected_open_rejects_role_swap_before_actual_resource_open(
    runtime_fixture,
    role: str,
    swap_kind: str,
) -> None:
    runtime_fixture.require_swap_support(swap_kind)
    principal, scope_service, registered = await runtime_fixture.register_space()
    gate = runtime_fixture.pause_immediately_before_resource_open(role)
    opening = asyncio.create_task(
        scope_service.open(principal, registered.id, mode="read")
    )
    await gate.reached.wait()
    runtime_fixture.swap_role_to_external_target(role, swap_kind)
    gate.resume.set()

    with pytest.raises((PathOutsideSpaceError, SpacePathIdentityChangedError)):
        await opening

    assert runtime_fixture.business_query_count == 0
    assert runtime_fixture.engine_ref_count(registered.id) == 0
    assert runtime_fixture.file_system_ref_count(registered.id) == 0
    assert runtime_fixture.active_space_lease_count(registered.id) == 0


@pytest.mark.asyncio
async def test_contained_roles_must_remain_distinct(runtime_fixture) -> None:
    principal, scope_service, registered = await runtime_fixture.register_space(
        alias_index_to_database=True
    )
    with pytest.raises(SpacePathIdentityChangedError):
        await scope_service.open(principal, registered.id, mode="read")
    assert runtime_fixture.total_storage_open_count == 0


@pytest.mark.asyncio
async def test_resolve_primary_and_fail_once_global_release_keep_retry_owner(
    runtime_fixture,
) -> None:
    principal, scope_service, registered = await runtime_fixture.register_space()
    primary = scope_service.fail_registered_resolve_once(OSError("meta read failed"))
    release_fault = scope_service.fail_global_release_once(OSError("unlock failed"))

    with pytest.raises(BaseExceptionGroup) as captured:
        await scope_service.open(principal, registered.id, mode="read")

    assert captured.value.exceptions == (primary, release_fault)
    owners = scope_service.runtime.pending_cleanups_for_current_task()
    assert len(owners) == 1
    owner = owners[0]
    assert owner.owner_task is asyncio.current_task()
    assert any(isinstance(held, Lease) and held.is_owned for held in owner.holds)
    await scope_service.runtime.retry_pending_cleanups_for_current_task()
    assert scope_service.runtime.pending_cleanup_count == 0
    assert release_fault.successful_release_count == 1


@pytest.mark.asyncio
async def test_persistent_global_release_failure_blocks_readiness_and_shutdown(
    runtime_fixture,
) -> None:
    principal, scope_service, registered = await runtime_fixture.register_space()
    scope_service.fail_registered_resolve_once(OSError("meta read failed"))
    release_fault = scope_service.fail_global_release_persistently(
        OSError("unlock remains unavailable")
    )

    with pytest.raises(BaseExceptionGroup):
        await scope_service.open(principal, registered.id, mode="read")
    with pytest.raises(RuntimeCleanupPendingError):
        scope_service.runtime.assert_ready()
    with pytest.raises(RuntimeCleanupPendingError):
        await scope_service.runtime.close()

    owners = scope_service.runtime.pending_cleanups_for_current_task()
    assert len(owners) == 1
    owner = owners[0]
    assert owner.owner_task is asyncio.current_task()
    assert any(isinstance(held, Lease) and held.is_owned for held in owner.holds)
    release_fault.clear()
    await scope_service.runtime.retry_pending_cleanups_for_current_task()
    assert scope_service.runtime.pending_cleanup_count == 0


@pytest.mark.parametrize(
    "stage", ["filesystem", "engine", "space_lease", "global_lease"]
)
@pytest.mark.asyncio
async def test_handle_aclose_retries_only_failed_stage_without_duplicate_success(
    runtime_fixture,
    stage: str,
) -> None:
    handle = await runtime_fixture.open_read_handle("retry-close")
    fault = runtime_fixture.fail_close_stage_once(handle, stage)

    with pytest.raises(BaseExceptionGroup):
        await handle.aclose()
    await handle.aclose()
    await handle.aclose()

    assert fault.attempt_count == 2
    assert fault.successful_callback_count == 1
    assert runtime_fixture.successful_close_counts(handle) == {
        "filesystem": 1,
        "engine": 1,
        "space_lease": 1,
        "global_lease": 1,
    }
    assert runtime_fixture.zero_refs_and_locks(handle.scope.space_id)


@pytest.mark.parametrize("primary", [OSError("read failed"), asyncio.CancelledError()])
@pytest.mark.asyncio
async def test_read_handle_aexit_preserves_primary_before_cleanup_failure(
    runtime_fixture,
    primary: BaseException,
) -> None:
    handle = await runtime_fixture.open_read_handle("aexit-primary")
    cleanup = runtime_fixture.fail_close_stage_once(handle, "engine")

    with pytest.raises(BaseExceptionGroup) as captured:
        async with handle:
            raise primary

    assert captured.value.exceptions == (primary, cleanup.error)
    await handle.aclose()
    assert runtime_fixture.zero_refs_and_locks(handle.scope.space_id)


@pytest.mark.asyncio
async def test_fastapi_dependencies_share_exactly_one_request_handle(
    production_client,
    runtime_fixture,
) -> None:
    response = await production_client.get("/api/v1/tasks")
    assert response.status_code == 200
    assert runtime_fixture.scope_open_count == 1
    assert runtime_fixture.database_handle is runtime_fixture.filesystem_handle
    assert runtime_fixture.request_handle_close_count == 1


@pytest.mark.asyncio
async def test_mcp_tool_uses_runtime_handle_without_independent_engine_open(
    runtime_fixture,
) -> None:
    result = await runtime_fixture.call_mcp_stats_tool()
    assert result is not None
    assert runtime_fixture.scope_open_count == 1
    assert runtime_fixture.direct_engine_manager_open_count == 0
    assert runtime_fixture.request_handle_close_count == 1
```

Containment negative tests call the package-private authorization-resolution primitive directly; they do not construct a runtime-less `AuthorizedSpaceScope` and do not exercise `open()` without a runtime. Those tests continue to prove missing/moved/type-invalid storage, role aliasing, symlink/junction/reparse, ancestor/target identity drift, and no storage I/O before the platform guard. The primitive is not a production request entry, cannot activate an engine or filesystem, and returns only `AuthorizedSpaceScopeResult` for capability verification.

- [ ] **Step 2: Run lifecycle tests and verify the missing runtime failure**

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_space_lifecycle.py -p no:cacheprovider
```

Expected: FAIL on missing `SpaceRuntime`/`SpaceRuntimeHandle`.

- [ ] **Step 3: Implement the unique final handle and request dependency**

`backend/app/settings.py` adds the one root and rejects split layouts during settings validation:

```python
data_root: Path = Path("./data")

@property
def meta_db_path(self) -> Path:
    return self.data_root.expanduser().resolve() / "meta.db"

@property
def canonical_spaces_root(self) -> Path:
    return self.data_root.expanduser().resolve() / "spaces"

@model_validator(mode="after")
def require_canonical_runtime_layout(self) -> "Settings":
    if sqlite_path_from_url(self.database_url).resolve() != self.meta_db_path:
        raise ValueError("database_url must equal data_root/meta.db")
    if self.spaces_data_dir.expanduser().resolve() != self.canonical_spaces_root:
        raise ValueError("spaces_data_dir must equal data_root/spaces")
    return self
```

`POMODOROXII_DATA_ROOT` drives the field. Defaults for the two legacy settings are derived from it before validation; explicit mismatches fail instead of creating a split root.

`backend/app/file_system/api.py` splits creation from request open:

```python
async def open_existing_file_system(opens: ContainedSpaceOpens) -> FileSystem:
    notes_handle, index_target = opens.take_file_system_handles()
    fs = FileSystemStorage.from_bound_handles(notes_handle, index_target)
    await fs.verify_existing_open()
    return fs


async def provision_file_system(root_dir: Path, index_db: Path) -> FileSystem:
    root_dir.mkdir(parents=True, exist_ok=False)
    index_db.parent.mkdir(parents=True, exist_ok=True)
    fs = FileSystemStorage(root_dir=root_dir, index_db=index_db)
    await fs.init()
    return fs
```

`open_existing_file_system()` has no `ContainedSpacePaths` or `(Path, Path)` overload and accepts only `ContainedSpaceOpens`; its caller invokes it inside the `scope.containment.open_verified()` context that produced those handles. It consumes the S1-owned contained constructor `FileSystemStorage.from_bound_handles()`, which retains the transferred Notes directory handle plus identity-bound index target through the S1 internal authority ports; S2 extends those ports but does not replace them or restore pathname state. `verify_existing_open()` calls `IndexStoreSchema.verify_open(index_target)` and contains no pathname reopen, `mkdir`, upgrade, DDL, or rebuild. Every Note child open is descriptor/HANDLE-relative. The legacy path-backed constructor remains test/N-1-only, and contained `import_from_md(file_path)`/`export_folder(output_dir)` continue to raise `ExternalPathCapabilityRequiredError` before inspecting a host path because S2 defines no external path capability. Test fixtures that need a fresh store call `provision_file_system`; request dependencies never call it.

`backend/app/runtime/space.py` 定义唯一最终 record：

```python
@dataclass(frozen=True)
class SpaceHealth:
    space_id: str
    available: bool
    migration_head: str
    index_schema_version: int
    catalog_hash: str
    degraded_reason: str | None


@dataclass
class SpaceRuntimeHandle:
    scope: AuthorizedSpaceScopeResult
    engine: EngineHandle | None
    file_system: FileSystem | None
    global_lease: Lease
    space_lease: Lease | None
    owns_global_lease: bool
    owns_space_lease: bool
    fence: int
    _runtime: "SpaceRuntime" = field(repr=False)
    _file_system_closed: bool = False
    _engine_released: bool = False
    _space_lease_released: bool = False
    _global_lease_released: bool = False
    _closed: bool = False

    @property
    def session_factory(self) -> async_sessionmaker[AsyncSession]:
        if self.engine is None or self._engine_released:
            raise LeaseOrderError("Space resources are not active under a lease")
        return self.engine.session_factory

    async def activate_space_resources_under_lease(self, lease: Lease) -> None:
        lease.assert_active_owner(scope=self.scope.space_id)
        if lease.mode not in {LeaseMode.SHARED, LeaseMode.EXCLUSIVE}:
            raise LeaseOrderError("Space resource activation requires a data lease")
        if self.engine is not None or self.file_system is not None:
            raise LeaseOrderError("Space resources are already active")
        engine: EngineHandle | None = None
        file_system: FileSystem | None = None
        try:
            async with self.scope.containment.open_verified() as opens:
                engine = await self._runtime.engines.acquire(
                    self.scope.space_id, opens
                )
                file_system = await open_existing_file_system(opens)
        except BaseException as primary:
            self.engine = engine
            self.file_system = file_system
            self._engine_released = engine is None
            self._file_system_closed = file_system is None
            try:
                await self.close_space_resources()
            except BaseExceptionGroup as cleanup_group:
                cleanup_errors = list(cleanup_group.exceptions)
                self._runtime.register_pending_cleanup(self)
            else:
                cleanup_errors = []
            if cleanup_errors:
                raise BaseExceptionGroup(
                    "Space activation and cleanup failed", [primary, *cleanup_errors]
                ) from None
            raise
        assert engine is not None and file_system is not None
        self.engine = engine
        self.file_system = file_system
        self._engine_released = False
        self._file_system_closed = False

    @asynccontextmanager
    async def exclusive_space_resources(
        self, purpose: str, timeout_seconds: float
    ) -> AsyncIterator[Lease]:
        if self.space_lease is not None and not self._space_lease_released:
            raise LeaseOrderError("handle already owns a Space lease")
        lease = await self._runtime.leases.acquire_spaces(
            [self.scope.space_id], LeaseMode.EXCLUSIVE, purpose, timeout_seconds
        )
        self.space_lease = lease
        self.owns_space_lease = True
        self._space_lease_released = False
        try:
            await self.activate_space_resources_under_lease(lease)
            yield lease
        except BaseException as primary:
            cleanup_errors = await self._finish_exclusive_attempt(lease)
            if cleanup_errors:
                self._runtime.register_pending_cleanup(self)
                raise BaseExceptionGroup(
                    "Space operation and cleanup failed", [primary, *cleanup_errors]
                ) from None
            raise
        else:
            cleanup_errors = await self._finish_exclusive_attempt(lease)
            if cleanup_errors:
                self._runtime.register_pending_cleanup(self)
                raise BaseExceptionGroup(
                    "Space operation cleanup failed", cleanup_errors
                ) from None
        finally:
            if self._space_lease_released:
                self.space_lease = None
                self.owns_space_lease = False

    async def _finish_exclusive_attempt(self, lease: Lease) -> list[BaseException]:
        errors: list[BaseException] = []
        try:
            await self.close_space_resources()
        except BaseExceptionGroup as group:
            errors.extend(group.exceptions)
        if self.file_system is None and self.engine is None:
            try:
                await lease.release()
            except BaseException as exc:
                errors.append(exc)
            else:
                self._space_lease_released = True
        return errors

    async def __aenter__(self) -> "SpaceRuntimeHandle":
        return self

    async def __aexit__(self, exc_type, exc, traceback) -> bool:
        cleanup_errors: list[BaseException] = []
        try:
            await self.aclose()
        except BaseExceptionGroup as group:
            cleanup_errors.extend(group.exceptions)
        except BaseException as cleanup:
            cleanup_errors.append(cleanup)
        if cleanup_errors:
            self._runtime.register_pending_cleanup(self)
        if exc is not None and cleanup_errors:
            raise BaseExceptionGroup(
                "SpaceRuntimeHandle body and cleanup failed",
                [exc, *cleanup_errors],
            ) from None
        if cleanup_errors:
            raise BaseExceptionGroup(
                "SpaceRuntimeHandle cleanup failed", cleanup_errors
            ) from None
        return False

    async def close_space_resources(self) -> None:
        errors: list[BaseException] = []
        if self.file_system is not None and not self._file_system_closed:
            try:
                await self.file_system.close()
            except BaseException as exc:
                errors.append(exc)
            else:
                self._file_system_closed = True
                self.file_system = None
        if self.engine is not None and not self._engine_released:
            try:
                await self.engine.release()
            except BaseException as exc:
                errors.append(exc)
            else:
                self._engine_released = True
                self.engine = None
        if errors:
            raise BaseExceptionGroup("Space runtime resource close failed", errors)

    async def aclose(self) -> None:
        if self._closed:
            self._runtime.complete_pending_cleanup(self)
            return
        errors: list[BaseException] = []
        try:
            await self.close_space_resources()
        except BaseExceptionGroup as cleanup_group:
            errors.extend(cleanup_group.exceptions)
        resources_closed = self.file_system is None and self.engine is None
        if resources_closed and self.space_lease is not None and self.owns_space_lease and not self._space_lease_released:
            try:
                await self.space_lease.release()
            except BaseException as exc:
                errors.append(exc)
            else:
                self._space_lease_released = True
        space_done = not self.owns_space_lease or self._space_lease_released
        if resources_closed and space_done and self.owns_global_lease and not self._global_lease_released:
            try:
                await self.global_lease.release()
            except BaseException as exc:
                errors.append(exc)
            else:
                self._global_lease_released = True
        global_done = not self.owns_global_lease or self._global_lease_released
        self._closed = resources_closed and space_done and global_done
        if self._closed:
            self._runtime.complete_pending_cleanup(self)
        if errors:
            raise BaseExceptionGroup("SpaceRuntimeHandle close failed", errors)


class SpaceRuntime:
    async def open_resolved(
        self,
        scope: AuthorizedSpaceScopeResult,
        mode: Literal["read", "mutation"],
        global_lease: Lease,
        *,
        owns_global_lease: bool,
        borrowed_space_lease: Lease | None = None,
    ) -> SpaceRuntimeHandle:
        space_lease = borrowed_space_lease
        owns_space_lease = False
        try:
            if mode == "read" and space_lease is None:
                space_lease = await self.leases.acquire_spaces(
                    [scope.space_id], LeaseMode.SHARED, "read", 5
                )
                owns_space_lease = True
            async with scope.containment.open_verified() as opens:
                opens.require_all_existing_roles()
                migration = await self.migrations.verify_open(
                    "space", opens.database_target
                )
                if not migration.at_head:
                    raise SpaceRecoveryRequiredError(
                        "registered space migration is not at head"
                    )
                index_status = self.index_schema.verify_open(opens.index_target)
                if not index_status.valid:
                    raise SpaceRecoveryRequiredError(
                        "registered index schema is not valid"
                    )
            handle = SpaceRuntimeHandle(
                scope, None, None, global_lease, space_lease,
                owns_global_lease, owns_space_lease,
                space_lease.fence if space_lease is not None else global_lease.fence,
                self,
            )
            if mode == "read" or borrowed_space_lease is not None:
                assert space_lease is not None
                await handle.activate_space_resources_under_lease(space_lease)
            return handle
        except BaseException as primary:
            cleanup_errors = await release_all_acquired(
                handle if "handle" in locals() else None,
                space_lease if owns_space_lease else None,
                global_lease if owns_global_lease else None,
            )
            if cleanup_errors:
                raise BaseExceptionGroup(
                    "runtime open and cleanup failed", [primary, *cleanup_errors]
                )
            raise

    @asynccontextmanager
    async def borrow_prepared_space(
        self,
        scope: AuthorizedSpaceScopeResult,
        global_lease: Lease,
        space_lease: Lease,
    ) -> AsyncIterator[SpaceRuntimeHandle]:
        global_lease.assert_active_owner(
            mode=LeaseMode.EXCLUSIVE, scope="global", require_process_owner=True
        )
        space_lease.assert_active_owner(
            mode=LeaseMode.EXCLUSIVE, scope=scope.space_id
        )
        handle = await self.open_resolved(
            scope,
            "mutation",
            global_lease,
            owns_global_lease=False,
            borrowed_space_lease=space_lease,
        )
        space_lease.retain_cleanup_dependency(handle)
        primary: BaseException | None = None
        try:
            yield handle
        except BaseException as exc:
            primary = exc
        cleanup_errors: list[BaseException] = []
        try:
            await handle.aclose()
        except BaseExceptionGroup as group:
            cleanup_errors.extend(group.exceptions)
            self.register_pending_cleanup(handle, parent_lease=space_lease)
        else:
            space_lease.complete_cleanup_dependency(handle)
        if primary is not None and cleanup_errors:
            raise BaseExceptionGroup(
                "borrowed Space runtime body and cleanup failed",
                [primary, *cleanup_errors],
            ) from None
        if primary is not None:
            raise primary
        if cleanup_errors:
            raise BaseExceptionGroup(
                "borrowed Space runtime cleanup failed", cleanup_errors
            ) from None


class AuthorizedSpaceScope:
    async def open(
        self,
        principal: Principal,
        space_id: str,
        mode: Literal["read", "write"],
    ) -> SpaceRuntimeHandle:
        self._verify_claims_without_storage_io(principal, space_id)
        global_lease = await self.runtime.leases.acquire_global(
            LeaseMode.SHARED, "request", 5
        )
        try:
            resolved = await self._resolve_registered_under_lease(principal, space_id)
        except BaseException as primary:
            cleanup_errors: list[BaseException] = []
            try:
                await global_lease.release()
            except BaseException as cleanup:
                cleanup_errors.append(cleanup)
                self.runtime.register_pending_lease_cleanup(global_lease)
            if cleanup_errors:
                raise BaseExceptionGroup(
                    "scope resolution and global lease cleanup failed",
                    [primary, *cleanup_errors],
                ) from None
            raise
        runtime_mode = "read" if mode == "read" else "mutation"
        return await self.runtime.open_resolved(
            resolved,
            runtime_mode,
            global_lease,
            owns_global_lease=True,
        )
```

`open_resolved(mode="mutation")` returns a handle holding S1's containment capability plus owned global-shared; it acquires no engine, filesystem, or Space lease and never snapshots naked paths for later use. A read handle activates resources only after it holds Space-shared; bootstrap borrowed handles activate only under their supplied Space-exclusive. Verification and activation each enter `async with scope.containment.open_verified() as opens:` and pass only opaque `ContainedSpaceOpens` to `verify_open`, `SpaceEngineManager.acquire()`, and `open_existing_file_system()`. Manager/filesystem transfer already-open or identity-bound resources; later engine checkout, SQLite sidecar, Note child, and index operations remain bound to those resources and never reopen a path. The handle publishes neither engine nor filesystem until capability exit succeeds; exit drift revokes provisional transfers and the caller closes/removes every just-opened resource under the still-held Space lease. S3/S4 mutation consumers use one runtime guard that acquires matching Space-exclusive, re-enters the capability, activates resources, runs recovery/work, closes resources, and only then releases exclusive. They must not write `async with lease, resources` as two independent context managers, because an inner close failure would still release the outer lease. The guard records a pending cleanup owner and retains the lease on persistent cleanup failure; fail-once callbacks are retried by `aclose()` before shutdown proceeds.

`release_all_acquired()` and `SpaceRuntimeHandle.aclose()` use per-resource completion flags, not an eager aggregate `_closed=True`. Filesystem, engine callback, each owned Space lease stage, and each owned global lease stage are marked complete only after that callback/stage returns successfully. Resource close attempts are independent; global release is dependency-aware and never runs while an owned Space lease or active resource remains. A failure leaves the exact resource owned for a later same-owner retry; a successful callback is never invoked twice, and `Lease` does not reset ContextVar or set `_released` early. Tests inject fail-once then success at filesystem close, engine release, Space release, and global release, call `aclose()` repeatedly, and assert zero refs/locks plus exactly one successful callback per stage. Both `Lease.__aexit__` and `SpaceRuntimeHandle.__aexit__` preserve a body exception or cancellation as the first group member and append cleanup failures in `[primary, *cleanup_errors]`; a cleanup failure never masks read or MCP cancellation. If `_resolve_registered_under_lease()` fails before a handle exists, `AuthorizedSpaceScope.open()` remains the cleanup owner: it catches that primary, attempts global release, and on release failure registers the same generic `PendingCleanup` with a retry closure plus strong `holds` for the still-owned lease and acquiring `asyncio.Task`; the raised group is exactly `[primary, *cleanup_errors]`. `retry_pending_cleanups_for_current_task()` may retry only owners acquired by that same current Task, removes an owner only after release succeeds, and never transfers lease ownership to a background/shutdown Task. A request error boundary performs that same-Task retry before it returns control; a fail-once callback therefore converges without a leak. Persistent failure remains visible in the cleanup registry, makes `assert_ready()` fail, and makes graceful shutdown return the defined `RuntimeCleanupPendingError(code="runtime_cleanup_pending", retryable=False)` without releasing process-owner or claiming success; operator termination/restart is the final fail-closed escape if the acquiring Task cannot complete cleanup. `close_space_resources()` remains the per-Space-only cleanup face used by S3 FAILED_MANUAL before drain/evict. Calling `open_resolved()` must explicitly declare global ownership; once runtime owns cleanup, scope never releases it again.

`AuthorizedSpaceScope.open(principal, space_id, mode: Literal["read", "write"]) -> SpaceRuntimeHandle` 仍是唯一外部 request 入口。`runtime` 是 `AuthorizedSpaceScope` 的 required constructor dependency with no `None`/default；`open()` 不存在 runtime-less fallback，也不得返回 `AuthorizedSpaceScopeResult`。claim/scope 的纯内存检查可在 lease 前执行；Meta registry 读取发生在 global-shared 后，并返回持有 `SpaceContainmentCapability` 的 `AuthorizedSpaceScopeResult`。package-private authorization-resolution primitive 只供 `open()` 内部与 containment 负向测试消费，不能激活 engine/filesystem，也不是 production request entry。S2 删除 `_validate_registered_paths` 及任何“resolve/containment 后返回裸 Path”的替代 helper；Space/Index verify只能在 `scope.containment.open_verified()` context 内消费 opaque database/index targets。它将 `write` 映射为 `mutation` 并调用内部 `SpaceRuntime.open_resolved()`。`mode="mutation"` 只持有 global shared与 capability；S3 `MutationUnitOfWork` 再获取 per-Space exclusive并在 activation 时重新 `open_verified()`，持有到 terminal state，避免嵌套重入与 check-then-use。`borrow_prepared_space()` 仅供同 Task 已持有 process-owner + global-exclusive + matching Space-exclusive 的 bootstrap/S3 startup recovery 使用：它不重取 lease，返回 ownership flags 都为 false 的 handle，并保证 context 退出时先关闭 filesystem/engine；body 与 cleanup 同时失败时按 `[primary, *cleanup_errors]` 聚合，仍不释放 borrowed leases。外层随后退出 Space-exclusive，最外层最后退出唯一 global-exclusive。Capability拒绝 missing/moved store、role alias、symlink/junction/reparse和 ancestor/target identity drift，映射为 stable `space_storage_missing`/`path_outside_space`/`space_path_identity_changed`且不调用 mkdir/migration。`health(space_id)` 只在短 `open_verified()` context 内调用 open-target verifier。

`deps.py` 的真实 FastAPI dependency graph 定义 `get_space_runtime(request: Request) -> SpaceRuntime`，只返回 bootstrap 写入 `app.state.runtime` 的实例；每个 request 由 `get_space_context` 恰好调用一次 `AuthorizedSpaceScope.open()`，并将同一个 request-scoped `SpaceRuntimeHandle` 传给 DB session 与 filesystem dependencies，finally 中只关闭一次。DB 与 filesystem 必须从该 handle 派生，禁止各 dependency 重复 `open()`、重新 resolve、直接调用 engine manager、或分别持有生命周期。`test_deps.py` 与真实 v1 route 测试证明 open count 为 1、DB/FS handle identity 相同、cleanup 一次；`test_space_path_containment.py` 保持 package-private resolution 的负向证据，不得通过 autouse runtime/provisioning fixture 掩盖 missing-store fail-closed。

`app/mcp/server.py` 在 Task 7 同步迁移 production consumer：每个 MCP tool invocation 通过已安装的同一个 `SpaceRuntime` 调用 `AuthorizedSpaceScope.open()` 一次，session/filesystem 从返回的 `SpaceRuntimeHandle` 派生，并在 tool invocation 的同一 Task 中关闭 handle。MCP 禁止保留 runtime-less `AuthorizedSpaceScope(meta_db, root).open(...)`、独立 `get_space_engine_manager().get_session(...)`、再次 `containment.open_verified()` 或任何第二次 scope open。Task 7 的 MCP authorization/normal-path 测试证明 unauthorized/unregistered/outside-root 在 storage activation 前失败，authorized call 恰好 open/close 一个 handle，且 direct engine-manager open count 为 0。Task 9 仍独占 FastAPI/FastMCP shared bootstrap、process owner、fleet migration、runtime installation/readiness 和 shutdown；Task 7 只要求 consumer 对缺失 runtime fail closed，不建立隐式 singleton、fallback 或独立 bootstrap。

Normative lease-dependency amendment: every active or partially closed handle is registered on the exact Space lease through `retain_cleanup_dependency()`. Successful `aclose()` removes it; failure registers one same-Task pending owner containing both handle and lease. A Space lease with a dependency cannot release, a global lease cannot release while the Space order remains current, and the live `ProcessOwnerReceipt` cannot release while either child remains. `test_borrowed_cleanup_failure_pins_space_and_parent_leases_until_same_task_retry` proves fail-once convergence, persistent fail-closed behavior, and no duplicate successful callback. This explicit dependency state machine supersedes any earlier shorthand that a non-owning borrowed handle can be tracked without pinning its parent lease.

Normative resource-lifetime amendment: `mode="mutation"` holds global-shared plus the protected-open capability only; even three preopened writer handles leave engine/filesystem refcount at zero and no `ContainedSpacePaths`, `Path`, or unbound SQLite URL escapes. S3 UoW and every S4 exclusive protocol operation enter the combined runtime guard, which owns Space-exclusive and lazily active resources as one cleanup unit. `borrow_prepared_space()` uses the same guard with borrowed lease ownership. Read mode retains active opaque resources only while its Space-shared lease remains held. This amendment overrides the earlier shorthand that `open_resolved()` always opens engine/filesystem.

- [ ] **Step 4: Run runtime/dependency tests**

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_space_lifecycle.py tests/test_file_system/test_api.py tests/test_runtime_leases.py tests/test_settings.py tests/test_routes_v1.py tests/test_space_manager.py tests/test_deps.py tests/test_space_path_containment.py -p no:cacheprovider
.\.venv\Scripts\python.exe -m pytest -q tests/test_mcp_authorization.py tests/test_mcp_server.py -p no:cacheprovider
.\.venv\Scripts\ruff.exe check --no-cache app/runtime/space.py app/runtime/scope.py app/runtime/leases.py app/file_system/api.py app/settings.py app/deps.py app/mcp/server.py tests/test_space_lifecycle.py tests/test_file_system/test_api.py tests/test_runtime_leases.py tests/test_deps.py tests/test_space_path_containment.py tests/test_mcp_authorization.py tests/test_mcp_server.py
```

Expected: PASS; missing paths remain missing, relocated registered identities work, request targets invoke `verify_open` but never `upgrade`, no consumer performs pathname reopen, every DB/Notes/index symlink/junction/reparse/identity swap returns no handle, fail-once close stages retry without duplicate success, and read body/cancellation remains first when cleanup also fails.

- [ ] **Step 5: Commit SpaceRuntime open path**

```powershell
git add app/runtime/__init__.py app/runtime/scope.py app/runtime/space.py app/runtime/leases.py app/settings.py app/file_system/api.py app/deps.py app/mcp/server.py tests/test_space_lifecycle.py tests/test_file_system/test_api.py tests/test_runtime_leases.py tests/test_settings.py tests/test_routes_v1.py tests/test_deps.py tests/test_space_path_containment.py tests/test_mcp_authorization.py tests/test_mcp_server.py
git commit -m "feat(runtime): open authoritative registered spaces"
```

## Task 8: Provision And Migrate Before Meta Registration

**Files:**
- Modify: `backend/app/runtime/space.py`
- Modify: `backend/app/routes/v1/spaces.py`
- Modify: `backend/tests/test_space_lifecycle.py`
- Modify: `backend/tests/test_routes_auth_spaces.py`

**Interfaces:**
- Consumes: `SpaceProvisionSpec`, process/global/target-Space exclusive lineage, canonical root, nonce marker, and isolated migration/filesystem factories.
- Produces: fully migrated/verified/fsynced Space visibility after Meta commit, or ownership-proved compensation confined to this attempt.

- [ ] **Step 1: Write failing visibility and compensation tests**

```python
@pytest.mark.asyncio
async def test_provision_is_at_space_008_and_index_v2_before_meta_visibility(runtime_fixture) -> None:
    runtime = runtime_fixture.runtime
    spec = SpaceProvisionSpec(space_id="space-new", name="New")

    handle = await runtime.provision(spec)
    async with handle:
        registered = await runtime_fixture.get_registered("space-new")
        assert registered is not None
        async with handle.scope.containment.open_verified() as opens:
            assert (await runtime.migrations.verify_open(
                "space", opens.database_target
            )).revision == (
                "space_008_sync_retention_snapshot"
            )
            assert runtime.index_schema.verify_open(opens.index_target).version == 2


@pytest.mark.asyncio
async def test_meta_commit_failure_removes_only_new_staging_tree(runtime_fixture, monkeypatch) -> None:
    runtime = runtime_fixture.runtime
    monkeypatch.setattr(runtime, "_commit_registration", AsyncMock(side_effect=RuntimeError("commit")))

    with pytest.raises(RuntimeError, match="commit"):
        await runtime.provision(SpaceProvisionSpec(space_id="space-fail", name="Fail"))

    assert await runtime_fixture.get_registered("space-fail") is None
    assert not (runtime_fixture.spaces_root / "space-fail").exists()
```

另测 migration/index/rename 三个失败点都没有 Meta row，且已存在目标目录导致 fail closed、绝不删除。

- [ ] **Step 2: Run lifecycle and route tests**

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_space_lifecycle.py tests/test_routes_auth_spaces.py -p no:cacheprovider
```

Expected: FAIL because route currently registers Meta first and only creates directories.

- [ ] **Step 3: Implement staged provision and thin route delegation**

`backend/app/runtime/space.py` 定义：

```python
@dataclass(frozen=True, slots=True)
class SpaceProvisionSpec:
    space_id: str
    name: str


@dataclass(slots=True)
class ProvisionMarker:
    staging_root: Path
    nonce: str
    _isolated_authorities: dict[StorageIdentity, object] = field(
        default_factory=dict, init=False, repr=False
    )

    @property
    def marker_path(self) -> Path:
        return self.staging_root / ".pomodoroxii-provision"

    def _validated_binding_request(self, path: Path) -> tuple[Path, str]:
        root = self.staging_root.expanduser().resolve(strict=True)
        marker = root / ".pomodoroxii-provision"
        if marker.is_symlink() or not marker.is_file():
            raise SpaceProvisionConflictError("provision marker is missing")
        if marker.read_text(encoding="ascii") != self.nonce:
            raise SpaceProvisionConflictError("provision marker does not match")

        requested = Path(path).expanduser()
        if requested.name in {"", ".", ".."}:
            raise SpaceProvisionConflictError("invalid provision target name")
        if requested.parent.resolve(strict=True) != root:
            raise SpaceProvisionConflictError(
                "provision target is outside staging root"
            )
        return root, requested.name

    def bind_isolated_sqlite_target(self, path: Path) -> BoundSQLiteTarget:
        root, basename = self._validated_binding_request(path)
        target, cleanup_authority = bind_marked_isolated_target(
            parent_path=root,
            exact_absent_basename=basename,
            marker_basename=self.marker_path.name,
            marker_nonce=self.nonce,
        )
        self._isolated_authorities[target.identity] = cleanup_authority
        return target

    def commit_isolated_sqlite_target(self, target: BoundSQLiteTarget) -> None:
        authority = self._isolated_authorities[target.identity]
        commit_closed_isolated_target(authority, target.identity)
        del self._isolated_authorities[target.identity]

    def discard_isolated_sqlite_target(self, target: BoundSQLiteTarget) -> None:
        authority = self._isolated_authorities[target.identity]
        discard_closed_isolated_target(authority, target.identity)
        del self._isolated_authorities[target.identity]
```

`bind_marked_isolated_target`、`commit_closed_isolated_target`和`discard_closed_isolated_target`是 S1 SQLite Module 的 package-private authority operations，不能从 route/service或测试业务代码导入。Binder用 no-follow parent handle重新读取 marker regular-file identity/nonce，原子证明 exact main basename及全部 SQLite companion classes均不存在，拒绝重复 live identity，并返回 opaque cleanup authority；S2 不得生成、枚举或删除 companion suffix。Commit/discard都要求 target 已完成 `aclose()`，只在 native authority 内按记录 identity封存或删除，失败时保留 `_isolated_authorities` entry供同一 Task retry。

`SpaceRuntime.provision(spec)` 固定执行：获取 global exclusive + target Space exclusive；在 canonical spaces root 下创建全新 staging 目录，将 nonce 以 ASCII 原样写入 `.pomodoroxii-provision`，fsync marker 和 staging parent，再构造上面的 `ProvisionMarker`；对不存在的 staging `space.db` 调用 `MigrationCoordinator.create_isolated_under_lease("space", staging_db, global_lease, marker)`，禁止 coordinator 重取 global 或进入 existing replace 分支；调用 `provision_file_system()` 创建 notes/index；verify 两者；fsync tree；分别校验 global 与 Space fence后原子 rename 为最终 Space ID 目录，并把本调用私有的 `renamed` flag 置为 true；最后在 Meta transaction 插入 canonical paths 并 commit。commit 成功后才删除 marker 并 fsync 最终目录。global exclusive 持续到 Meta 可见性或清理完成，避免请求观察半成品。失败时先 dispose handle，再选择精确 cleanup target：`renamed` 为 false 时只能是本次 staging path，为 true 时只能是本次 final path；重新 resolve 后要求该目录仍位于 canonical root、路径等于所选 target、marker 是 regular file且内容逐字等于本次 nonce，然后才删除。final target 在 rename 前必须被证明不存在；rename 冲突时 `renamed` 保持 false，因此绝不清理既有 final tree。任一 ownership/containment/marker 检查失败都保留目录并返回 cleanup error。`get_space_runtime(request: Request)` 使用 Task 7 的唯一 app-state accessor，route 不构造 runtime。

Route 变为：

```python
@router.post("", status_code=201, response_model=SpaceResponse)
async def create_space(
    body: SpaceCreateRequest,
    runtime: SpaceRuntime = Depends(get_space_runtime),
    user: dict = Depends(require_master_token),
) -> dict[str, Any]:
    spec = SpaceProvisionSpec(space_id=uuid.uuid4().hex, name=body.name)
    handle = await runtime.provision(spec)
    async with handle:
        return _space_to_dict(await runtime.get_registered(spec.space_id))
```

- [ ] **Step 4: Run provision regression tests**

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_space_lifecycle.py tests/test_routes_auth_spaces.py tests/test_migration_runner.py tests/test_index_store_schema.py -p no:cacheprovider
.\.venv\Scripts\ruff.exe check --no-cache app/runtime/space.py app/routes/v1/spaces.py tests/test_space_lifecycle.py
```

Expected: PASS; no Meta row becomes visible before both schema gates pass, and failure cleanup is confined to the marked new tree.

- [ ] **Step 5: Commit provision-before-register**

```powershell
git add app/runtime/space.py app/routes/v1/spaces.py tests/test_space_lifecycle.py tests/test_routes_auth_spaces.py
git commit -m "feat(spaces): provision storage before registration"
```

## Task 9: Gate Startup On All Registered Stores And Await Shutdown

**Files:**
- Modify: `backend/app/db/meta_session.py`
- Create: `backend/app/runtime/bootstrap.py`
- Modify: `backend/app/main.py`
- Modify: `backend/app/mcp/server.py`
- Modify: `backend/app/runtime/space.py`
- Modify: `backend/tests/test_space_lifecycle.py`
- Create: `backend/tests/test_runtime_bootstrap.py`
- Modify: `backend/tests/test_main.py`
- Modify: `backend/tests/test_mcp_http_lifespan.py`
- Modify: `backend/tests/test_backup_lifespan.py`
- Modify: `backend/tests/conftest.py`

**Interfaces:**
- Consumes: process owner, global-exclusive startup lease, closed `MigrationPreflightPolicy` registrations, read-only Meta registration, credential bootstrap helper, catalog compiler, and every registered Space runtime.
- Produces: `FrozenFleetPreflight`, shared FastAPI/FastMCP `RuntimeServices`, readiness only after whole-fleet preflight plus full preparation, and shutdown that preserves body/cancellation primary while awaiting all cleanup.

- [ ] **Step 1: Write failing startup ordering and shutdown-drain tests**

```python
@pytest.mark.asyncio
async def test_lifespan_preflights_whole_fleet_then_migrates_before_ready(app_factory) -> None:
    calls: list[str] = []
    app = app_factory(migration_calls=calls, registered_spaces=["b", "a"])

    async with app.router.lifespan_context(app):
        assert calls == [
            "preflight:meta", "preflight:space:a", "preflight:space:b",
            "meta", "credential-epoch", "space:a", "index:a",
            "space:b", "index:b", "ready",
        ]


@pytest.mark.asyncio
async def test_legacy_in_late_space_rejects_before_any_fleet_byte_changes(app_factory) -> None:
    app, probe = app_factory(
        expose_fleet_inventory=True,
        registered_spaces=["a", "b"],
        preflight_rejections={"b": "breaking_cutover_requires_empty_legacy:tasks"},
    )
    before = probe.complete_data_root_inventory()

    with pytest.raises(RuntimeError, match="breaking_cutover_requires_empty_legacy"):
        async with app.router.lifespan_context(app):
            return

    assert probe.migration_calls == []
    assert probe.complete_data_root_inventory() == before


@pytest.mark.asyncio
async def test_missing_registered_space_aborts_startup(app_factory) -> None:
    app = app_factory(registered_spaces=["missing"], missing_spaces={"missing"})
    with pytest.raises(SpaceStorageMissingError):
        async with app.router.lifespan_context(app):
            return


@pytest.mark.asyncio
async def test_shutdown_waits_for_active_handle_then_releases_process_owner(app_factory) -> None:
    app, owner = app_factory(expose_owner=True, registered_spaces=["space-a"])
    started = asyncio.Event()
    request_shutdown = asyncio.Event()
    active_started = asyncio.Event()
    release_active = asyncio.Event()

    async def run_lifespan_in_one_task() -> None:
        async with app.router.lifespan_context(app):
            started.set()
            await request_shutdown.wait()

    close_task = asyncio.create_task(run_lifespan_in_one_task())
    await started.wait()

    async def hold_request_handle_in_one_task() -> None:
        async with await app.state.test_scope.open(
            app.state.test_principal, "space-a", mode="read"
        ):
            active_started.set()
            await release_active.wait()

    active_task = asyncio.create_task(hold_request_handle_in_one_task())
    await active_started.wait()
    request_shutdown.set()
    await asyncio.sleep(0)
    assert not close_task.done()
    release_active.set()
    await active_task
    await close_task
    assert owner.released


@pytest.mark.parametrize("entrypoint", ["fastapi", "mcp-stdio", "mcp-http"])
@pytest.mark.asyncio
async def test_every_entrypoint_uses_the_same_complete_bootstrap(entrypoint, bootstrap_probe):
    async with bootstrap_probe.run(entrypoint):
        assert bootstrap_probe.calls == [
            "owner", "global", "preflight:meta", "preflight:space:a",
            "meta", "credential-epoch", "catalog",
            "space:a", "index:a", "ready",
        ]
    assert bootstrap_probe.all_resources_released_once()


@pytest.mark.asyncio
async def test_multi_space_prepare_borrows_one_global_and_leaves_zero_refs(app_factory):
    app, probe = app_factory(
        expose_runtime_ownership=True, registered_spaces=["b", "a"]
    )

    async with app.router.lifespan_context(app):
        assert probe.prepared_order == ["a", "b"]

    assert probe.global_acquires == 1
    assert probe.global_releases == 1
    assert probe.space_releases == {"a": 1, "b": 1}
    assert probe.engine_ref_counts == {"a": 0, "b": 0}
    assert probe.file_system_ref_counts == {"a": 0, "b": 0}
    assert probe.migration_drains == ["a", "b"]
    assert probe.migration_resumes == ["a", "b"]


@pytest.mark.asyncio
async def test_multi_space_prepare_failure_closes_borrowed_refs_without_double_release(
    app_factory,
) -> None:
    app, probe = app_factory(
        expose_runtime_ownership=True,
        registered_spaces=["a", "b", "c"],
        fail_inside_borrowed_handle="b",
    )

    with pytest.raises(OSError, match="injected preparation failure"):
        async with app.router.lifespan_context(app):
            return

    assert probe.global_acquires == 1
    assert probe.global_releases == 1
    assert probe.space_releases == {"a": 1, "b": 1}
    assert probe.engine_ref_counts == {"a": 0, "b": 0, "c": 0}
    assert probe.file_system_ref_counts == {"a": 0, "b": 0, "c": 0}
    assert probe.migration_drains == ["a", "b"]
    assert probe.migration_resumes == ["a", "b"]


@pytest.mark.asyncio
async def test_prepare_rejects_mismatched_space_lease_before_migration(app_factory):
    app, probe = app_factory(
        expose_runtime_ownership=True,
        registered_spaces=["a"],
        substitute_space_lease={"a": "b"},
    )

    with pytest.raises(LeaseOrderError):
        async with app.router.lifespan_context(app):
            return

    assert probe.migration_drains == []
    assert probe.migration_resumes == []
    assert probe.engine_ref_counts == {"a": 0}
    assert probe.file_system_ref_counts == {"a": 0}
    assert probe.global_releases == 1


@pytest.mark.parametrize("entrypoint", ["mcp-stdio", "mcp-http"])
@pytest.mark.asyncio
async def test_mcp_cancelled_read_keeps_cancellation_before_cleanup_failure(
    entrypoint,
    bootstrap_probe,
) -> None:
    async with bootstrap_probe.run(entrypoint) as services:
        handle = await services.scope.open(
            bootstrap_probe.principal, "a", mode="read"
        )
        cleanup = bootstrap_probe.fail_handle_close_once(handle, "engine")
        primary = asyncio.CancelledError()

        with pytest.raises(BaseExceptionGroup) as captured:
            async with handle:
                raise primary

        assert captured.value.exceptions == (primary, cleanup.error)
        await handle.aclose()
        assert bootstrap_probe.zero_refs_and_locks("a")
```

- [ ] **Step 2: Run lifespan tests and observe early-ready/lazy-migration failures**

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_space_lifecycle.py tests/test_runtime_bootstrap.py tests/test_main.py tests/test_mcp_http_lifespan.py tests/test_backup_lifespan.py -p no:cacheprovider
```

Expected: FAIL because current lifespan has no whole-fleet read-only preflight, migrates Meta before learning that a later Space must reject, warms an empty manager, silently skips missing Space files during backup, and cannot preserve MCP read cancellation when handle cleanup also fails.

- [ ] **Step 3: Implement deterministic startup and process-owner lifetime**

`backend/app/runtime/bootstrap.py` 是唯一 startup/shutdown owner：

```python
@dataclass(frozen=True, slots=True)
class RuntimeServices:
    runtime: SpaceRuntime
    scope: AuthorizedSpaceScope
    credential_verifier: Callable[
        [str, Literal["master", "space"] | None], Awaitable[Principal]
    ]
    catalog: CompiledEntityCatalog


@asynccontextmanager
async def bootstrap_runtime(purpose: str) -> AsyncIterator[RuntimeServices]:
    owner = await leases.acquire_process_owner(purpose, 5)
    services: RuntimeServices | None = None
    try:
        global_lease = await leases.acquire_global(
            LeaseMode.EXCLUSIVE, "startup-migration", 60
        )
        async with global_lease:
            fleet = await runtime.preflight_registered_fleet(
                migrations, settings.meta_db_path, global_lease
            )
            await migrations.upgrade_under_lease("meta", settings.meta_db_path, global_lease)
            await init_meta_db()
            await bootstrap_credential_epoch()
            catalog = REGISTRY.compile(version="1")
            await runtime.prepare_registered_spaces(catalog, global_lease, fleet)
        services = RuntimeServices(
            runtime, scope, verify_with_fresh_meta_session, catalog
        )
        yield services
    except BaseException as primary:
        errors = await close_all_runtime_resources(
            services.runtime if services else runtime,
            close_meta_db,
            owner,
        )
        if errors:
            raise BaseExceptionGroup(
                "runtime bootstrap/body and cleanup failed",
                [primary, *errors],
            ) from None
        raise
    else:
        errors = await close_all_runtime_resources(
            services.runtime if services else runtime,
            close_meta_db,
            owner,
        )
        if errors:
            raise BaseExceptionGroup("runtime shutdown failed", errors)
```

`close_all_runtime_resources()` 依次尝试 runtime drain、Meta close、owner release并收集 `BaseException`，包括取消，不因首个清理失败停止；因此所有聚合都使用 `BaseExceptionGroup`。不得把清理放回无条件 `finally`：startup 或 context body 已有 primary 时，聚合顺序固定为 `[primary, *cleanup_errors]`，primary 必须是 group 的第一个成员；正常退出才可单独抛 `runtime shutdown failed`。增加 startup failure、body failure、body cancellation 各自叠加 drain/Meta/owner cleanup failure 的测试并断言顺序。owner acquisition/release 与 context body 始终在同一个 asyncio Task。

Normative shutdown amendment: the preceding “attempt every stage” wording does not authorize an owner release after an earlier failure. The cleanup owner records separate `runtime_drained`, `meta_closed`, and `owner_released` completion bits; runtime drain and Meta close may both be attempted for diagnostics, but the process-owner stage is not invoked until both bits are true, all pending handle/lease/migration-resume registries are empty, and no live child lease remains. Any failure retains the state machine plus OS owner in the acquiring Task's pending registry; retry runs only unfinished stages. Tests prove another process cannot acquire owner after runtime/global/Space/Meta cleanup failure and can do so only after same-Task convergence.

`bootstrap_credential_epoch()` 与 `verify_with_fresh_meta_session()` 直接复用 S1 `app/auth/authority.py` 的模块 helper：前者在 Meta migration/open 后创建并关闭自己的 session；后者作为无状态 callable 注入 `RuntimeServices`，REST/MCP 每次验证调用它并获得 fresh session。禁止在 `bootstrap_runtime()` 中构造 `CredentialAuthority(meta_session)`，也禁止把任何 session-bound authority 存入 `app.state`、FastMCP state 或 `RuntimeServices`。

`preflight_registered_fleet(migrations, meta_target, global_lease)` runs before `upgrade_under_lease("meta", ...)`. It asserts the same process/global lineage, opens the current Meta database read-only to freeze the sorted registration set, then opens every registered Space database read-only through its containment capability and invokes `MigrationCoordinator.preflight_fleet_under_lease(...)`. A policy receives only kind/current-head/target-head plus a query-only bound connection; it cannot checkpoint, recover, attach a writable database, issue mutating PRAGMA, create a backup, or call Alembic. Every handle closes before the method returns `FrozenFleetPreflight`. Any rejection reaches no migration API. Tests snapshot every Meta/Space/Index/Notes main/sidecar byte before the call and require exact equality afterwards, matching S5's `legacy-bearing` negative lane.

`prepare_registered_spaces(catalog, global_lease, fleet)` accepts only that frozen successful preflight. After Meta migration/open it re-reads registration identities and requires exact equality with `fleet`; drift fails before the first Space migration. It then processes Space IDs in dictionary order; for each Space it acquires the exclusive lease and, before any migration/drain, asserts process-owner, the passed global-exclusive, and the exact matching Space-exclusive are held by the current asyncio Task. Mismatch fails before coordinator/quiescer/Index/filesystem I/O. Prepare calls only `MigrationCoordinator.upgrade_under_lease(...)` (passing the same global lease so the coordinator performs exactly one existing-identity drain/resume) and exclusive startup index upgrade/verify; prepare itself never calls `drain_identity`/`resume_identity`. In the same Space-exclusive context it passes the same asserted global/Space leases to `async with runtime.borrow_prepared_space(scope, global_lease, space_lease) as handle` for prepared-handle verification; S3 inserts startup recovery only after the fleet preflight succeeded. The borrowed handle leaves filesystem/engine refcounts at zero before Space-exclusive exits. The outer `async with global_lease` remains the sole global release owner. A missing store aborts fleet preflight, creates no request handle, and reaches no Meta or Space migration. `init_meta_db()` only opens an already migrated file.

FastAPI lifespan uses `async with bootstrap_runtime("fastapi") as services`, installs services on `app.state`, calls `runtime.assert_ready()` immediately before setting ready, yields, then clears ready before leaving the context. `assert_ready()` requires an empty pending cleanup registry. Shutdown first asks the still-owning request Tasks to run `retry_pending_cleanups_for_current_task()` and waits for active handles; if any handle or lease-cleanup owner remains, it reports `RuntimeCleanupPendingError`, keeps process-owner held, and does not claim graceful completion. The shared backend `client` fixture in `tests/conftest.py` must exercise this same installed runtime path or explicitly install the same `RuntimeServices` test bootstrap; it may not bypass runtime installation while claiming full route regression. FastMCP applies the identical readiness and shutdown gate. It replaces the synchronous shortcut with one event loop and one Task:

```python
async def run_mcp(args: argparse.Namespace) -> None:
    async with bootstrap_runtime(f"mcp-{args.transport}") as services:
        install_mcp_runtime_services(services)
        await mcp.run_async(
            transport=args.transport,
            host=args.host if args.transport == "http" else None,
            port=args.port if args.transport == "http" else None,
        )


def main() -> None:
    asyncio.run(run_mcp(parse_args()))
```

No MCP code calls `init_meta_db`, engine manager disposal, or Meta close directly. MCP token verification calls `services.credential_verifier(...)`; it never retains a `CredentialAuthority` or Meta session. Tests cover stdio/http startup failure, cancellation, normal exit, multi-Space borrowed-handle cleanup, a failure inside the second Space, and a persistent registered cleanup owner; readiness for both entrypoints requires Meta at head, credential epoch initialized, catalog compiled, every registered Space prepared, zero borrowed engine/filesystem refs, an empty cleanup registry, exact-once coordinator drain/resume per attempted Space, and no double release of global. Shutdown may release process-owner only after all retryable owners have completed in their acquiring Tasks; a persistent or wrong-Task owner keeps readiness false and shutdown observably incomplete.

- [ ] **Step 4: Run startup plus S2 integration gate**

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_space_lifecycle.py tests/test_runtime_bootstrap.py tests/test_main.py tests/test_mcp_http_lifespan.py tests/test_backup_lifespan.py tests/test_auth_concurrency.py tests/test_migration_wal_durability.py tests/test_runtime_leases.py tests/test_compiled_entity_catalog.py tests/test_index_store_schema.py -p no:cacheprovider
.\.venv\Scripts\ruff.exe check --no-cache app tests/test_space_lifecycle.py tests/test_runtime_bootstrap.py tests/test_main.py tests/test_mcp_http_lifespan.py tests/test_backup_lifespan.py
```

Expected: PASS; readiness is unreachable until every registered store is at known heads, and owner release occurs only after handle drain.

- [ ] **Step 5: Commit startup gating**

```powershell
git add app/db/meta_session.py app/runtime/bootstrap.py app/main.py app/mcp/server.py app/runtime/space.py tests/test_space_lifecycle.py tests/test_runtime_bootstrap.py tests/test_main.py tests/test_mcp_http_lifespan.py tests/test_backup_lifespan.py tests/conftest.py
git commit -m "feat(runtime): gate startup on registered space readiness"
```

## Task 10: Run The S2 Exit Gate And Review The Wave

**Files:**
- Modify only if a failing assertion proves an S2 regression in files already listed in this plan.
- Commit: none when all gates pass without correction; conditional file-level commit only for a proven S2 regression in an already-owned file.

**Interfaces:**
- Consumes: approved S2 diff, fixed Space head, focused/adjacent test gates, static zero-match guards, and review answers.
- Produces: an execution/review record only when green; no mutable file and no commit unless a failing assertion requires a correction in an already-owned S2 file.

- [ ] **Step 1: Prove the Space chain has not advanced in S2**

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
rg -n --pcre2 "^(?:down_)?revision(?:\s*:\s*[^=]+)?\s*=" alembic_space/versions
.\.venv\Scripts\python.exe -m alembic -n alembic:space heads
.\.venv\Scripts\python.exe -m pytest -q tests/test_alembic_dual_environments.py::test_each_environment_has_exactly_one_independent_head -p no:cacheprovider
```

Expected: the Alembic command prints exactly `space_008_sync_retention_snapshot (head)`; the typed and untyped revision declarations are all listed; the exact existing pytest node passes; there is no `009` file in this branch.

- [ ] **Step 2: Run the exact approved S2 test gate**

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_migration_wal_durability.py tests/test_migration_runner.py tests/test_alembic_dual_environments.py tests/test_runtime_leases.py tests/test_space_lifecycle.py tests/test_space_manager.py tests/test_compiled_entity_catalog.py tests/test_index_store_schema.py -p no:cacheprovider
```

Expected: PASS with zero unexpected xfail/xpass. Evidence must show committed WAL survival, one migration owner, known-revision failure outcomes, missing-store non-creation, provision-before-visible, six ordinary index creation, lock order/timeouts/process-death/fences, and awaited handles.

- [ ] **Step 3: Run adjacent regressions and static checks**

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
.\.venv\Scripts\python.exe -m pytest -q tests/test_routes_auth_spaces.py tests/test_routes_meta.py tests/test_registry.py tests/test_registry_integration.py tests/test_file_system tests/test_integration.py -p no:cacheprovider
.\.venv\Scripts\ruff.exe check --no-cache app tests
```

Expected: PASS. Do not run the full retained-artifact suite in a dirty source tree unless S0's external run root is configured.

- [ ] **Step 4: Perform the mandatory self-review**

Run these zero-match guards in the actual shell; do not replace them with visual inspection:

```powershell
function Assert-NoRgMatch {
    param(
        [Parameter(Mandatory)] [string] $Pattern,
        [Parameter(Mandatory)] [string[]] $Paths,
        [Parameter(Mandatory)] [string] $FailureMessage
    )
    $rgOutput = & rg -n -- $Pattern @Paths 2>&1
    $rgStatus = $LASTEXITCODE
    if ($rgStatus -eq 0) {
        $rgOutput | Write-Output
        throw $FailureMessage
    }
    if ($rgStatus -gt 1) {
        $rgOutput | Write-Output
        throw "rg failed with exit code $rgStatus"
    }
}

Assert-NoRgMatch `
    -Pattern 'run_migrations|mkdir' `
    -Paths @('app/space_manager.py', 'app/deps.py') `
    -FailureMessage 'request-time open still migrates or creates storage'
Assert-NoRgMatch `
    -Pattern 'settings\.space_(db_path|notes_dir)' `
    -Paths @('app/runtime/scope.py', 'app/deps.py', 'app/space_manager.py') `
    -FailureMessage 'request adapter still derives a Space path from settings'
Assert-NoRgMatch `
    -Pattern 'authority:\s*CredentialAuthority|await authority\.bootstrap_epoch' `
    -Paths @('app/runtime/bootstrap.py') `
    -FailureMessage 'bootstrap retains or directly uses a session-bound authority'
Assert-NoRgMatch `
    -Pattern 'ContainedSpacePaths|sqlite3\.connect\([^)]*(path|str\()|aiosqlite\.connect\([^)]*(path|str\()' `
    -Paths @('app/space_manager.py', 'app/file_system/api.py', 'app/runtime/space.py') `
    -FailureMessage 'runtime storage consumer still accepts paths or reopens SQLite by pathname'
```

Each guard interprets `rg` exit `0` as “forbidden text found” and fails, exit `1` as the required zero-match result, and exit greater than `1` as a command failure.

Review the diff and record answers in the PR body:

1. The first executed guard proves request-time open does not migrate or create storage.
2. The second executed guard proves request adapters/managers do not derive registered paths from settings; separately review `app/runtime/space.py` and allow the canonical formula only inside provision-before-registration.
3. process-owner and global RW lock tests are independent and neither uses a wall-clock ownership TTL.
4. every exclusive destructive step checks the current persisted fence immediately before replace/rename.
5. catalog compilation rejects every approved collision dimension and exposes stable version/hash.
6. `IndexStoreSchema` is the sole schema version authority and explicit index creation is tested on fresh and upgraded databases.
7. no new Alembic Space revision exists, no S3 mutation type appears, the third executed guard proves bootstrap stores no session-bound authority, and multi-Space tests prove borrowed handles leave zero refs without releasing borrowed leases.
8. the fourth executed guard proves manager/filesystem/runtime accept only `ContainedSpaceOpens`/bound targets; final-check-to-kernel-open swap tests and pathname-connector traps pass on the supported platform.

- [ ] **Step 5: Create the focused wave commit if review fixes were required**

Reuse the exact file-level `git add` command from the owning task for each review correction; never stage `app` or `tests` as a directory because retained sandboxes and unrelated user work may be present.

```powershell
git commit -m "test(runtime): certify s2 space runtime gate"
```

If no review fix was needed, do not create an empty commit; attach the exact commands and outputs to the S2 PR.

## S2 Review Gate

S2 may merge only when all conditions are true at one commit:

- S0/S1 remain green and no P0 is reintroduced.
- backend has one process owner per data root; global exclusive work cannot overlap request global shared leases; per-Space exclusives are ordered and fenced.
- committed rows still in WAL survive migration; every injected migration failure leaves the target openable at a known revision.
- startup first read-only preflights Meta plus every registered Space as one fleet, then migrates Meta and every registered Space before ready; any rejection or missing registered store reaches zero DDL/migration calls, preserves a byte-identical complete inventory, returns the stable failure, and recreates nothing.
- new Space storage reaches Space head `space_008_sync_retention_snapshot` and index schema v2 before Meta visibility.
- compiled catalog is immutable, deterministic, collision-checked, and shared by Meta/Sync/parity consumers.
- fresh/upgraded `index.db` contains declared tables, FTS objects, triggers, and all ordinary indexes.
- request storage consumers receive only opaque opened/identity-bound resources; no SQLite/Notes/index path is reopened after containment.
- fail-once Lease/EngineHandle/SpaceRuntimeHandle release stages retry in the acquiring Task without repeating successful callbacks or resetting ContextVar early; read and MCP cancellation remains first in combined failure groups.
- shutdown awaits all runtime/engine handles before releasing the process owner.
- review is performed on an S2-only diff; frontend, mutation journal, Sync v2 cursor, recovery CLI, deployment, and historical report cleanup remain outside this wave.

After approval, create the separate S3 branch from the approved S2 commit and execute `2026-07-14-backend-95plus-s3-knowledge-consistency.md`; do not combine both waves in one PR.
