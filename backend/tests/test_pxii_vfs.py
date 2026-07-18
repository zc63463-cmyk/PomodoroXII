from __future__ import annotations

import asyncio
import dataclasses
import inspect
import os
import sqlite3
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.errors import SQLiteAuthorityRevokedError
from app.runtime.sqlite_vfs import BoundSQLiteTarget, _extension_candidates


def _walk_private_values(value: object) -> tuple[object, ...]:
    """Inspect the opaque implementation without making it public API."""
    pending = [value]
    seen: set[int] = set()
    values: list[object] = []
    while pending:
        current = pending.pop()
        identity = id(current)
        if identity in seen:
            continue
        seen.add(identity)
        values.append(current)
        if dataclasses.is_dataclass(current) and not isinstance(current, type):
            pending.extend(getattr(current, field.name) for field in dataclasses.fields(current))
        for name in getattr(type(current), "__slots__", ()):
            if isinstance(name, str) and hasattr(current, name):
                pending.append(getattr(current, name))
    return tuple(values)


def _subprocess_env() -> dict[str, str]:
    backend = Path(__file__).resolve().parents[1]
    candidates = _extension_candidates()
    if len(candidates) != 1:
        raise RuntimeError(
            f"expected exactly one pxii-vfs extension for subprocess, found {len(candidates)}"
        )
    env = os.environ.copy()
    env["PYTHONPATH"] = os.fspath(backend)
    env["POMODOROXII_PXII_VFS_EXTENSION"] = os.fspath(candidates[0])
    return env


def _run_bound_subprocess(script: str, database: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-c", script, os.fspath(database)],
        cwd=Path(__file__).resolve().parents[2],
        env=_subprocess_env(),
        text=True,
        capture_output=True,
        timeout=30,
        check=False,
    )


def test_bound_sqlite_target_has_only_closed_public_surface() -> None:
    public = {name for name in dir(BoundSQLiteTarget) if not name.startswith("_")}
    assert public == {
        "identity",
        "make_async_engine",
        "open_maintenance",
        "aclose",
    }


def test_bound_target_options_reject_unsafe_combinations() -> None:
    from app.runtime.sqlite_vfs import AsyncEngineOptions, MaintenanceOptions

    with pytest.raises(ValueError):
        AsyncEngineOptions(pool_size=-1)
    with pytest.raises(ValueError):
        AsyncEngineOptions(busy_timeout_ms=0)
    with pytest.raises(ValueError):
        MaintenanceOptions(read_only=True, create_if_missing=True)


def test_stock_sqlite_bootstrap_registers_pxii_vfs_in_same_library() -> None:
    from app.runtime.sqlite_vfs import _bootstrap_receipt

    receipt = _bootstrap_receipt()
    assert receipt.vfs_name == "pxii-vfs"
    assert receipt.control_sqlite_source_id == receipt.extension_sqlite_source_id
    assert receipt.control_sqlite_version == receipt.extension_sqlite_version
    assert receipt.extension_loading_enabled_after_bootstrap is False


def test_bound_authority_retains_no_host_path_or_path_string(tmp_path: Path) -> None:
    from app.runtime.sqlite_vfs import bind_marked_isolated_target

    marker = tmp_path / ".pxii-create"
    marker.write_text("opaque-authority", encoding="utf-8")
    target, cleanup = bind_marked_isolated_target(
        parent_path=tmp_path,
        exact_absent_basename="opaque.db",
        marker_basename=marker.name,
        marker_nonce="opaque-authority",
    )
    del cleanup

    private_values = _walk_private_values(target)
    assert not any(isinstance(value, Path) for value in private_values)
    host_path = str(tmp_path).casefold()
    assert not any(
        host_path in value.casefold()
        for value in private_values
        if isinstance(value, str)
    )


def test_isolated_cleanup_authority_is_pathless_and_uses_exact_basename(
    tmp_path: Path,
) -> None:
    from app.runtime.sqlite_vfs import (
        bind_marked_isolated_target,
        discard_closed_isolated_target,
    )

    marker = tmp_path / ".pxii-create"
    marker.write_text("cleanup", encoding="utf-8")
    target, cleanup = bind_marked_isolated_target(
        parent_path=tmp_path,
        exact_absent_basename="arbitrary-name.db",
        marker_basename=marker.name,
        marker_nonce="cleanup",
    )
    private_values = _walk_private_values(cleanup)
    assert not any(isinstance(value, Path) for value in private_values)
    assert not any(
        os.fspath(tmp_path).casefold() in value.casefold()
        for value in private_values
        if isinstance(value, str)
    )
    identity = target.identity
    asyncio.run(target.aclose())
    companion = tmp_path / "arbitrary-name.db-wal"
    companion.write_bytes(b"closed-reserved-companion")
    discard_closed_isolated_target(cleanup, identity)
    assert not marker.exists()
    assert not (tmp_path / "arbitrary-name.db").exists()
    assert not companion.exists()


def test_isolated_binder_rejects_preexisting_companion_before_main_creation(
    tmp_path: Path,
) -> None:
    from app.runtime.sqlite_vfs import bind_marked_isolated_target

    marker = tmp_path / ".pxii-create"
    marker.write_text("preexisting-companion", encoding="utf-8")
    companion = tmp_path / "isolated.db-wal"
    companion.write_bytes(b"untrusted")

    with pytest.raises(RuntimeError, match="companion already exists"):
        bind_marked_isolated_target(
            parent_path=tmp_path,
            exact_absent_basename="isolated.db",
            marker_basename=marker.name,
            marker_nonce="preexisting-companion",
        )

    assert not (tmp_path / "isolated.db").exists()
    assert companion.read_bytes() == b"untrusted"


def test_isolated_binder_uses_only_parent_relative_child_operations() -> None:
    from app.runtime.sqlite_vfs import bind_marked_isolated_target

    source = inspect.getsource(bind_marked_isolated_target)
    assert "_open_parent_authority" in source
    assert ".stat(" not in source
    assert ".read_text(" not in source
    assert "target_path" not in source
    assert "_bind_existing_target" not in source


def test_virtual_identifier_and_native_reference_receipt_are_closed(tmp_path: Path) -> None:
    from app.runtime.sqlite_vfs import (
        MaintenanceOptions,
        _test_binding_receipt,
        bind_marked_isolated_target,
    )

    marker = tmp_path / ".pxii-create"
    marker.write_text("receipt", encoding="utf-8")
    target, _cleanup = bind_marked_isolated_target(
        parent_path=tmp_path,
        exact_absent_basename="receipt.db",
        marker_basename=marker.name,
        marker_nonce="receipt",
    )
    before = _test_binding_receipt(target)
    assert before.virtual_filename.startswith("file:pxii-")
    assert before.virtual_filename.endswith("?vfs=pxii")
    assert os.fsencode(tmp_path) not in before.virtual_filename.encode("utf-8")
    assert before.live_file_references == 0
    with target.open_maintenance(MaintenanceOptions(read_only=False)):
        during = _test_binding_receipt(target)
        assert during.live_file_references == 1
    assert _test_binding_receipt(target).live_file_references == 0


def test_absent_wal_cannot_be_injected_after_authority_binding(tmp_path: Path) -> None:
    from app.runtime.sqlite_vfs import MaintenanceOptions, bind_marked_isolated_target

    marker = tmp_path / ".pxii-create"
    marker.write_text("injected-wal", encoding="utf-8")
    target, _cleanup = bind_marked_isolated_target(
        parent_path=tmp_path,
        exact_absent_basename="injection.db",
        marker_basename=marker.name,
        marker_nonce="injected-wal",
    )
    injected = tmp_path / "injection.db-wal"
    injected.write_bytes(b"untrusted companion")
    with target.open_maintenance(MaintenanceOptions(read_only=False)) as connection:
        with pytest.raises(sqlite3.Error):
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("CREATE TABLE escaped(value INTEGER)")
    assert injected.read_bytes() == b"untrusted companion"


@pytest.mark.asyncio
async def test_target_close_waits_for_live_native_references(tmp_path: Path) -> None:
    from app.runtime.sqlite_vfs import MaintenanceOptions, bind_marked_isolated_target

    marker = tmp_path / ".pxii-create"
    marker.write_text("close-waits", encoding="utf-8")
    target, _cleanup = bind_marked_isolated_target(
        parent_path=tmp_path,
        exact_absent_basename="close-waits.db",
        marker_basename=marker.name,
        marker_nonce="close-waits",
    )
    context = target.open_maintenance(MaintenanceOptions(read_only=False))
    connection = context.__enter__()
    closing = asyncio.create_task(target.aclose())
    await asyncio.sleep(0.05)
    assert not closing.done()
    context.__exit__(None, None, None)
    await asyncio.wait_for(closing, timeout=2)
    assert connection is not None


@pytest.mark.asyncio
async def test_cancelled_close_can_be_retried_and_unlinks_native_binding(
    tmp_path: Path,
) -> None:
    from app.runtime.sqlite_vfs import (
        _BOOTSTRAP_LOCK,
        MaintenanceOptions,
        _bootstrap,
        bind_marked_isolated_target,
    )

    marker = tmp_path / ".pxii-create"
    marker.write_text("cancel-close", encoding="utf-8")
    target, _cleanup = bind_marked_isolated_target(
        parent_path=tmp_path,
        exact_absent_basename="cancel-close.db",
        marker_basename=marker.name,
        marker_nonce="cancel-close",
    )
    context = target.open_maintenance(MaintenanceOptions(read_only=False))
    context.__enter__()
    token = target._authority.token
    control, _receipt = _bootstrap()
    closing = asyncio.create_task(target.aclose())
    retry = None
    context_open = True
    try:
        await asyncio.sleep(0.05)
        assert not closing.done()
        closing.cancel()
        with pytest.raises(asyncio.CancelledError):
            await closing

        retry = asyncio.create_task(target.aclose())
        await asyncio.sleep(0)
        assert not retry.done()
        context.__exit__(None, None, None)
        context_open = False
        await asyncio.wait_for(retry, timeout=2)
        with _BOOTSTRAP_LOCK:
            references = control.execute(
                "SELECT pxii_live_references(?)", (token,)
            ).fetchone()[0]
        assert references == -1
    finally:
        if context_open:
            context.__exit__(None, None, None)
        if retry is not None and not retry.done():
            await retry
        with _BOOTSTRAP_LOCK:
            control.execute("SELECT pxii_revoke(?)", (token,)).fetchone()


def test_maintenance_adapter_cannot_restore_unsafe_connection_controls(
    tmp_path: Path,
) -> None:
    from app.runtime.sqlite_vfs import MaintenanceOptions, bind_marked_isolated_target

    marker = tmp_path / ".pxii-create"
    marker.write_text("closed-adapter", encoding="utf-8")
    target, _cleanup = bind_marked_isolated_target(
        parent_path=tmp_path,
        exact_absent_basename="closed-adapter.db",
        marker_basename=marker.name,
        marker_nonce="closed-adapter",
    )
    with target.open_maintenance(MaintenanceOptions(read_only=False)) as writer:
        writer.execute("CREATE TABLE proof(value INTEGER NOT NULL)")
        writer.commit()

    with target.open_maintenance(MaintenanceOptions(read_only=True)) as connection:
        assert not isinstance(connection, sqlite3.Connection)
        assert not hasattr(connection, "enable_load_extension")
        assert not hasattr(connection, "set_authorizer")
        cursor = connection.execute("SELECT 1")
        assert not hasattr(cursor, "connection")
        with pytest.raises(sqlite3.DatabaseError, match="not authorized"):
            connection.execute("PRAGMA query_only=OFF")
        with pytest.raises(sqlite3.DatabaseError):
            connection.execute("CREATE TABLE escaped(value INTEGER)")

    asyncio.run(target.aclose())


def test_real_bound_maintenance_connection_uses_wal_and_denies_unsafe_sql(
    tmp_path,
) -> None:
    from app.runtime.sqlite_vfs import (
        MaintenanceOptions,
        bind_marked_isolated_target,
        commit_closed_isolated_target,
    )

    marker = tmp_path / ".pxii-create"
    marker.write_text("nonce-1", encoding="utf-8")
    target, cleanup = bind_marked_isolated_target(
        parent_path=tmp_path,
        exact_absent_basename="main.db",
        marker_basename=marker.name,
        marker_nonce="nonce-1",
    )
    with target.open_maintenance(
        MaintenanceOptions(read_only=False, create_if_missing=True)
    ) as connection:
        assert connection.execute("PRAGMA journal_mode=WAL").fetchone()[0] == "wal"
        connection.execute("CREATE TABLE proof(value TEXT NOT NULL)")
        connection.execute("INSERT INTO proof VALUES ('bound')")
        connection.commit()
        for statement in (
            "ATTACH DATABASE ':memory:' AS escaped",
            "DETACH DATABASE main",
            "PRAGMA writable_schema=ON",
            "SELECT load_extension('forbidden')",
        ):
            with pytest.raises(sqlite3.DatabaseError, match="not authorized"):
                connection.execute(statement)
    with target.open_maintenance(MaintenanceOptions(read_only=True)) as connection:
        assert connection.execute("SELECT value FROM proof").fetchone()[0] == "bound"
    identity = target.identity
    import asyncio

    asyncio.run(target.aclose())
    commit_closed_isolated_target(cleanup, identity)


@pytest.mark.asyncio
async def test_async_engine_savepoint_and_revocation_are_bound(tmp_path) -> None:
    from app.runtime.sqlite_vfs import (
        AsyncEngineOptions,
        MaintenanceOptions,
        bind_marked_isolated_target,
        discard_closed_isolated_target,
    )

    marker = tmp_path / ".pxii-create"
    marker.write_text("nonce-2", encoding="utf-8")
    target, cleanup = bind_marked_isolated_target(
        parent_path=tmp_path,
        exact_absent_basename="async.db",
        marker_basename=marker.name,
        marker_nonce="nonce-2",
    )
    with target.open_maintenance(
        MaintenanceOptions(read_only=False, create_if_missing=True)
    ) as connection:
        connection.execute("CREATE TABLE proof(value TEXT NOT NULL)")
        connection.commit()

    engine = target.make_async_engine(AsyncEngineOptions(pool_size=1, max_overflow=0))
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as session:
        async with session.begin():
            await session.execute(text("INSERT INTO proof VALUES ('outer')"))
            nested = await session.begin_nested()
            await session.execute(text("INSERT INTO proof VALUES ('nested')"))
            await nested.rollback()
        rows = (await session.execute(text("SELECT value FROM proof"))).scalars().all()
        assert rows == ["outer"]

    await engine.dispose()
    identity = target.identity
    await target.aclose()
    with pytest.raises(SQLiteAuthorityRevokedError):
        target.open_maintenance(MaintenanceOptions(read_only=True))
    discard_closed_isolated_target(cleanup, identity)


def test_cross_process_writer_lock_is_exclusive_and_recovers(tmp_path: Path) -> None:
    from app.runtime.sqlite_vfs import (
        MaintenanceOptions,
        bind_marked_isolated_target,
    )

    marker = tmp_path / ".pxii-create"
    marker.write_text("cross-process", encoding="utf-8")
    target, _cleanup = bind_marked_isolated_target(
        parent_path=tmp_path,
        exact_absent_basename="locks.db",
        marker_basename=marker.name,
        marker_nonce="cross-process",
    )
    with target.open_maintenance(MaintenanceOptions(read_only=False)) as connection:
        connection.execute("CREATE TABLE proof(value TEXT NOT NULL)")
        connection.commit()

    child_script = r"""
import asyncio
import sys
from pathlib import Path
from app.runtime.sqlite_vfs import MaintenanceOptions, _bind_existing_target
target = _bind_existing_target(Path(sys.argv[1]), create_authority=False)
with target.open_maintenance(MaintenanceOptions(read_only=False, busy_timeout_ms=100)) as connection:
    connection.execute("BEGIN IMMEDIATE")
    print("LOCKED", flush=True)
    sys.stdin.readline()
    connection.rollback()
asyncio.run(target.aclose())
"""
    child = subprocess.Popen(
        [sys.executable, "-c", child_script, os.fspath(tmp_path / "locks.db")],
        cwd=Path(__file__).resolve().parents[2],
        env=_subprocess_env(),
        text=True,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    assert child.stdout is not None
    with ThreadPoolExecutor(max_workers=1) as executor:
        assert executor.submit(child.stdout.readline).result(timeout=15).strip() == "LOCKED"
    with target.open_maintenance(
        MaintenanceOptions(read_only=False, busy_timeout_ms=100)
    ) as contender:
        with pytest.raises(sqlite3.OperationalError, match="locked"):
            contender.execute("BEGIN IMMEDIATE")
    assert child.stdin is not None
    child.stdin.write("release\n")
    child.stdin.flush()
    stdout, stderr = child.communicate(timeout=15)
    assert child.returncode == 0, (stdout, stderr)
    with target.open_maintenance(MaintenanceOptions(read_only=False)) as successor:
        successor.execute("BEGIN IMMEDIATE")
        successor.rollback()


def test_same_process_distinct_connections_keep_writer_lock(tmp_path: Path) -> None:
    from app.runtime.sqlite_vfs import MaintenanceOptions, bind_marked_isolated_target

    marker = tmp_path / ".pxii-create"
    marker.write_text("same-process", encoding="utf-8")
    target, _cleanup = bind_marked_isolated_target(
        parent_path=tmp_path,
        exact_absent_basename="same-process.db",
        marker_basename=marker.name,
        marker_nonce="same-process",
    )
    with target.open_maintenance(MaintenanceOptions(read_only=False)) as first:
        first.execute("CREATE TABLE proof(value INTEGER)")
        first.commit()
        first.execute("BEGIN IMMEDIATE")
        with target.open_maintenance(
            MaintenanceOptions(read_only=False, busy_timeout_ms=100)
        ) as second:
            with pytest.raises(sqlite3.OperationalError, match="locked"):
                second.execute("BEGIN IMMEDIATE")
        first.rollback()


def test_closing_unrelated_connection_does_not_drop_writer_lock(tmp_path: Path) -> None:
    from app.runtime.sqlite_vfs import MaintenanceOptions, bind_marked_isolated_target

    marker = tmp_path / ".pxii-create"
    marker.write_text("close-unrelated", encoding="utf-8")
    database = tmp_path / "close-unrelated.db"
    target, _cleanup = bind_marked_isolated_target(
        parent_path=tmp_path,
        exact_absent_basename=database.name,
        marker_basename=marker.name,
        marker_nonce="close-unrelated",
    )
    with target.open_maintenance(MaintenanceOptions(read_only=False)) as owner:
        owner.execute("CREATE TABLE proof(value INTEGER)")
        owner.commit()
        owner.execute("BEGIN IMMEDIATE")
        with target.open_maintenance(MaintenanceOptions(read_only=False)):
            pass
        contender = _run_bound_subprocess(
            r"""
import sys
from pathlib import Path
from app.runtime.sqlite_vfs import MaintenanceOptions, _bind_existing_target
target = _bind_existing_target(Path(sys.argv[1]), create_authority=False)
with target.open_maintenance(MaintenanceOptions(read_only=False, busy_timeout_ms=100)) as connection:
    try:
        connection.execute("BEGIN IMMEDIATE")
    except Exception:
        print("LOCKED")
    else:
        print("ACQUIRED")
""",
            database,
        )
        assert contender.returncode == 0, contender.stderr
        assert contender.stdout.strip() == "LOCKED"
        owner.rollback()


def test_wal_commit_survives_hard_process_exit_and_checkpoints(tmp_path: Path) -> None:
    from app.runtime.sqlite_vfs import (
        MaintenanceOptions,
        _bind_existing_target,
        bind_marked_isolated_target,
    )

    marker = tmp_path / ".pxii-create"
    marker.write_text("wal-crash", encoding="utf-8")
    target, _cleanup = bind_marked_isolated_target(
        parent_path=tmp_path,
        exact_absent_basename="wal-crash.db",
        marker_basename=marker.name,
        marker_nonce="wal-crash",
    )
    with target.open_maintenance(MaintenanceOptions(read_only=False)) as connection:
        assert connection.execute("PRAGMA journal_mode=WAL").fetchone()[0] == "wal"
        connection.execute("CREATE TABLE proof(value TEXT NOT NULL)")
        connection.commit()

    crashed = _run_bound_subprocess(
        r"""
import os
import sys
from pathlib import Path
from app.runtime.sqlite_vfs import MaintenanceOptions, _bind_existing_target
target = _bind_existing_target(Path(sys.argv[1]), create_authority=False)
connection = target.open_maintenance(MaintenanceOptions(read_only=False)).__enter__()
connection.execute("PRAGMA journal_mode=WAL")
connection.execute("INSERT INTO proof VALUES ('committed-before-crash')")
connection.commit()
os._exit(0)
""",
        tmp_path / "wal-crash.db",
    )
    assert crashed.returncode == 0, crashed.stderr
    asyncio.run(target.aclose())
    recovered_target = _bind_existing_target(
        tmp_path / "wal-crash.db", create_authority=False
    )
    with recovered_target.open_maintenance(MaintenanceOptions(read_only=False)) as recovered:
        assert recovered.execute("SELECT value FROM proof").fetchone()[0] == (
            "committed-before-crash"
        )
        checkpoint = recovered.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
        assert checkpoint[0] == 0


def test_hot_rollback_journal_recovers_pre_crash_value(tmp_path: Path) -> None:
    from app.runtime.sqlite_vfs import MaintenanceOptions, bind_marked_isolated_target

    marker = tmp_path / ".pxii-create"
    marker.write_text("journal-crash", encoding="utf-8")
    target, _cleanup = bind_marked_isolated_target(
        parent_path=tmp_path,
        exact_absent_basename="journal-crash.db",
        marker_basename=marker.name,
        marker_nonce="journal-crash",
    )
    with target.open_maintenance(MaintenanceOptions(read_only=False)) as connection:
        connection.execute("PRAGMA journal_mode=DELETE")
        connection.execute("CREATE TABLE proof(value TEXT NOT NULL)")
        connection.execute("INSERT INTO proof VALUES ('pre-crash')")
        connection.commit()

    crashed = _run_bound_subprocess(
        r"""
import os
import sys
from pathlib import Path
from app.runtime.sqlite_vfs import MaintenanceOptions, _bind_existing_target
target = _bind_existing_target(Path(sys.argv[1]), create_authority=False)
connection = target.open_maintenance(MaintenanceOptions(read_only=False)).__enter__()
connection.execute("PRAGMA journal_mode=DELETE")
connection.execute("BEGIN IMMEDIATE")
connection.execute("UPDATE proof SET value='uncommitted'")
os._exit(0)
""",
        tmp_path / "journal-crash.db",
    )
    assert crashed.returncode == 0, crashed.stderr
    with target.open_maintenance(MaintenanceOptions(read_only=False)) as recovered:
        assert recovered.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert recovered.execute("SELECT value FROM proof").fetchone()[0] == "pre-crash"


@pytest.mark.asyncio
async def test_cancelled_async_connect_joins_and_closes_native_file(tmp_path: Path) -> None:
    from app.runtime.sqlite_vfs import (
        AsyncEngineOptions,
        _test_binding_receipt,
        _test_set_open_delay,
        bind_marked_isolated_target,
    )

    marker = tmp_path / ".pxii-create"
    marker.write_text("cancel-connect", encoding="utf-8")
    target, _cleanup = bind_marked_isolated_target(
        parent_path=tmp_path,
        exact_absent_basename="cancel.db",
        marker_basename=marker.name,
        marker_nonce="cancel-connect",
    )
    _test_set_open_delay(target, 250)
    engine = target.make_async_engine(
        AsyncEngineOptions(pool_size=1, max_overflow=0, busy_timeout_ms=1_000)
    )
    opening = asyncio.ensure_future(engine.connect())
    await asyncio.sleep(0.05)
    opening.cancel()
    with pytest.raises(asyncio.CancelledError):
        await opening
    await engine.dispose()
    assert _test_binding_receipt(target).live_file_references == 0


def test_main_and_reserved_companion_swaps_cannot_redirect_io(tmp_path: Path) -> None:
    from app.runtime.sqlite_vfs import MaintenanceOptions, bind_marked_isolated_target

    marker = tmp_path / ".pxii-create"
    marker.write_text("swap-matrix", encoding="utf-8")
    target, _cleanup = bind_marked_isolated_target(
        parent_path=tmp_path,
        exact_absent_basename="swap.db",
        marker_basename=marker.name,
        marker_nonce="swap-matrix",
    )
    database = tmp_path / "swap.db"
    outside = tmp_path / "outside"
    outside.mkdir()

    moved_main = outside / "main-moved.db"
    try:
        os.replace(database, moved_main)
    except PermissionError:
        assert not moved_main.exists()
    else:
        database.write_bytes(b"untrusted replacement")
        with pytest.raises(sqlite3.Error):
            target.open_maintenance(MaintenanceOptions(read_only=False))
        assert moved_main.stat().st_size == 0
        os.replace(moved_main, database)

    with target.open_maintenance(MaintenanceOptions(read_only=False)) as connection:
        assert connection.execute("PRAGMA journal_mode=WAL").fetchone()[0] == "wal"
        connection.execute("CREATE TABLE IF NOT EXISTS proof(value TEXT NOT NULL)")
        connection.execute("INSERT INTO proof VALUES ('before-swap')")
        connection.commit()
        for suffix in ("-wal", "-shm"):
            companion = database.with_name(database.name + suffix)
            assert companion.exists()
            moved = outside / companion.name
            size_before = companion.stat().st_size
            try:
                os.replace(companion, moved)
            except PermissionError:
                assert not moved.exists()
                continue
            with pytest.raises(sqlite3.Error):
                connection.execute("INSERT INTO proof VALUES ('after-swap')")
                connection.commit()
            assert moved.stat().st_size == size_before
            os.replace(moved, companion)
            connection.rollback()


def test_temp_and_subjournal_operations_stay_on_native_vfs(tmp_path: Path) -> None:
    from app.runtime.sqlite_vfs import MaintenanceOptions, bind_marked_isolated_target

    marker = tmp_path / ".pxii-create"
    marker.write_text("temp-native", encoding="utf-8")
    target, _cleanup = bind_marked_isolated_target(
        parent_path=tmp_path,
        exact_absent_basename="temp.db",
        marker_basename=marker.name,
        marker_nonce="temp-native",
    )
    with target.open_maintenance(MaintenanceOptions(read_only=False)) as connection:
        connection.execute("PRAGMA temp_store=FILE")
        connection.execute("CREATE TEMP TABLE temp_probe(value INTEGER NOT NULL)")
        connection.executemany(
            "INSERT INTO temp_probe VALUES (?)", ((value,) for value in range(2_000))
        )
        connection.execute("CREATE INDEX temp_probe_idx ON temp_probe(value)")
        connection.execute("SAVEPOINT nested")
        connection.execute("DELETE FROM temp_probe WHERE value >= 1000")
        connection.execute("ROLLBACK TO nested")
        connection.execute("RELEASE nested")
        assert connection.execute(
            "SELECT COUNT(*) FROM temp_probe WHERE value >= 1000"
        ).fetchone()[0] == 1000


def test_anonymous_temp_uses_bootstrap_directory_authority() -> None:
    source = (
        Path(__file__).resolve().parents[1]
        / "native"
        / "pxii_vfs"
        / "pxii_vfs.c"
    ).read_text(encoding="utf-8")
    assert "g_temp_root" in source
    assert "mkstemp(" not in source
    assert "GetTempFileNameW(" not in source


def test_memory_open_class_is_heap_backed_and_namespace_free() -> None:
    from app.runtime.sqlite_vfs import _test_memory_open_probe

    receipt = _test_memory_open_probe()
    assert receipt == {
        "executed_operations": 5,
        "namespace_open_count": 0,
        "round_trip": True,
    }
