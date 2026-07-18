from __future__ import annotations

import asyncio
import dataclasses
import inspect
import os
import sqlite3
import subprocess
import sys
import tomllib
import zipfile
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


def _write_fake_wheel_receipt(
    root: Path,
    platform_id: str,
    *,
    wheel_platform: str | None = None,
) -> tuple[Path, Path]:
    from scripts.verify_pxii_vfs_source_hash import (
        _binary_build_id,
        _canonical_bytes,
        _sha256_bytes,
        _sha256_file,
        verify_sources,
    )

    actual_platform = wheel_platform or platform_id
    if actual_platform == "windows-x86_64":
        wheel_tag = "win_amd64"
        member = "pomodoroxii_native/_pxii_vfs.pyd"
        extension = b"fake-windows-extension"
    else:
        wheel_tag = "manylinux_2_28_x86_64"
        member = "pomodoroxii_native/_pxii_vfs.so"
        extension = b"fake-linux-extension"
    if platform_id == "windows-x86_64":
        system, architecture = "Windows", "AMD64"
    else:
        system, architecture = "Linux", "x86_64"
    directory = root / platform_id
    directory.mkdir(parents=True)
    wheel = directory / (
        f"pomodoroxii_backend-0.1.0-cp313-cp313-{wheel_tag}.whl"
    )
    with zipfile.ZipFile(wheel, "w") as archive:
        archive.writestr(member, extension)
    junit = directory / "pxii-vfs.junit.xml"
    junit.write_text(
        '<testsuite tests="1" failures="0" errors="0" skipped="0">'
        '<testcase classname="pxii" name="bound"/></testsuite>',
        encoding="utf-8",
    )
    receipt = {
        "schema": "pxii-vfs-build-receipt-v1",
        "platform_id": platform_id,
        "source": verify_sources(),
        "runtime": {
            "control_sqlite_source_id": "same-source",
            "extension_sqlite_source_id": "same-source",
            "control_sqlite_version": "3.50.0",
            "extension_sqlite_version": "3.50.0",
            "vfs_name": "pxii-vfs",
            "extension_loading_enabled_after_bootstrap": False,
        },
        "tests": {"tests": 1, "failures": 0, "errors": 0, "skipped": 0},
        "junit": {
            "filename": junit.name,
            "sha256": _sha256_file(junit),
            "size": junit.stat().st_size,
        },
        "environment": {
            "os": system,
            "architecture": architecture,
            "python": "3.13.1",
            "compiler": "test-compiler",
            "cmake": "cmake version 3.31.0",
            "ninja": "1.12.0",
            "scikit_build_core": "0.11.0",
            "cibuildwheel": "3.1.0",
        },
        "wheel": {
            "filename": wheel.name,
            "sha256": _sha256_file(wheel),
            "size": wheel.stat().st_size,
        },
        "extension": {
            "filename": member,
            "sha256": _sha256_bytes(extension),
            "size": len(extension),
            "build_id": _binary_build_id(member, extension),
        },
    }
    (directory / "build-receipt.json").write_bytes(_canonical_bytes(receipt))
    return wheel, junit


def test_wheel_manifest_rehashes_uploaded_junit(tmp_path: Path) -> None:
    from scripts.verify_pxii_vfs_source_hash import assemble_manifest

    inputs = tmp_path / "inputs"
    _wheel, junit = _write_fake_wheel_receipt(inputs, "windows-x86_64")
    junit.write_text("tampered", encoding="utf-8")
    current = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    with pytest.raises(SystemExit, match="JUnit hash mismatch"):
        assemble_manifest(inputs, current, tmp_path / "manifest.json")


def test_wheel_manifest_rejects_platform_tag_mismatch(tmp_path: Path) -> None:
    from scripts.verify_pxii_vfs_source_hash import assemble_manifest

    inputs = tmp_path / "inputs"
    _write_fake_wheel_receipt(
        inputs, "windows-x86_64", wheel_platform="linux-x86_64"
    )
    current = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    with pytest.raises(SystemExit, match="wheel tag does not match platform"):
        assemble_manifest(inputs, current, tmp_path / "manifest.json")


def test_wheel_manifest_rejects_subject_sha_not_current_head(tmp_path: Path) -> None:
    from scripts.verify_pxii_vfs_source_hash import assemble_manifest

    inputs = tmp_path / "inputs"
    _write_fake_wheel_receipt(inputs, "windows-x86_64")
    current = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], text=True
    ).strip()
    assemble_manifest(inputs, current, tmp_path / "valid-manifest.json")
    with pytest.raises(SystemExit, match="subject SHA does not match current checkout"):
        assemble_manifest(inputs, "a" * 40, tmp_path / "invalid-manifest.json")


def test_wheel_manifest_rejects_linux_receipt(tmp_path: Path) -> None:
    from scripts.verify_pxii_vfs_source_hash import assemble_manifest

    inputs = tmp_path / "inputs"
    _write_fake_wheel_receipt(inputs, "windows-x86_64")
    _write_fake_wheel_receipt(inputs, "linux-x86_64")
    current = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()

    with pytest.raises(SystemExit, match="unsupported platform receipt: linux-x86_64"):
        assemble_manifest(inputs, current, tmp_path / "manifest.json")


def test_maintenance_setup_failure_closes_connection_and_preserves_primary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app.runtime.sqlite_vfs as sqlite_vfs_module

    class BrokenConnection:
        def __init__(self) -> None:
            self.closed = False

        def execute(self, _sql, _parameters=()):
            raise RuntimeError("setup failed")

        def close(self) -> None:
            self.closed = True
            raise OSError("close failed")

        def enable_load_extension(self, _enabled):
            raise AssertionError("setup must fail before extension configuration")

        def set_authorizer(self, _authorizer):
            raise AssertionError("setup must fail before authorizer configuration")

    broken = BrokenConnection()
    monkeypatch.setattr(sqlite_vfs_module.sqlite3, "connect", lambda *_a, **_k: broken)
    from app.runtime.sqlite_vfs import BoundSQLiteTarget, MaintenanceOptions

    target = object.__new__(BoundSQLiteTarget)
    target._authority = type("Authority", (), {"revoked": False, "sealed": False})()
    target._identity = None
    monkeypatch.setattr(sqlite_vfs_module, "_virtual_uri", lambda _authority: "file:test")
    with pytest.raises(BaseExceptionGroup, match="maintenance setup and close failed"):
        target.open_maintenance(MaintenanceOptions(read_only=False))
    assert broken.closed is True


def test_contained_opens_cleanup_collects_all_resource_errors() -> None:
    from app.runtime.contained_io import ContainedSpaceOpens

    class FailingTarget:
        async def aclose(self):
            raise OSError("target close")

    class FailingHandle:
        def _close(self):
            raise OSError("notes close")

    opens = ContainedSpaceOpens._create(FailingTarget(), FailingTarget(), FailingHandle())
    with pytest.raises(BaseExceptionGroup) as error:
        asyncio.run(opens.close_all())
    assert len(error.value.exceptions) == 3


def test_build_receipt_binds_runtime_extension_to_wheel_member(tmp_path: Path) -> None:
    from scripts.verify_pxii_vfs_source_hash import emit_build_receipt

    wheel, junit = _write_fake_wheel_receipt(
        tmp_path / "inputs", "windows-x86_64"
    )
    with pytest.raises(
        SystemExit, match="installed runtime extension does not match wheel member"
    ):
        emit_build_receipt(
            "windows-x86_64",
            wheel,
            junit,
            wheel.parent / "new-build-receipt.json",
        )


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


def test_bound_replacement_commits_identity_checked_main_atomically(
    tmp_path: Path,
) -> None:
    from app.runtime.sqlite_vfs import (
        MaintenanceOptions,
        _bind_existing_target,
        begin_bound_replacement,
        bind_marked_isolated_target,
        commit_closed_isolated_target,
    )

    marker = tmp_path / ".pxii-create"
    marker.write_text("replacement-commit", encoding="utf-8")
    source, cleanup = bind_marked_isolated_target(
        parent_path=tmp_path,
        exact_absent_basename="source.db",
        marker_basename=marker.name,
        marker_nonce="replacement-commit",
    )
    with source.open_maintenance(MaintenanceOptions(read_only=False)) as connection:
        connection.execute("CREATE TABLE proof(value TEXT NOT NULL)")
        connection.execute("INSERT INTO proof VALUES ('source')")
        connection.commit()

    replacement = begin_bound_replacement(source)
    private_values = _walk_private_values(replacement)
    assert not any(isinstance(value, Path) for value in private_values)
    assert not any(
        os.fspath(tmp_path).casefold() in value.casefold()
        for value in private_values
        if isinstance(value, str)
    )
    with replacement.target.open_maintenance(
        MaintenanceOptions(read_only=False, create_if_missing=True)
    ) as connection:
        connection.execute("CREATE TABLE proof(value TEXT NOT NULL)")
        connection.execute("INSERT INTO proof VALUES ('replacement')")
        connection.commit()
    checkpoint = replacement.checkpoint_and_seal_source()
    assert len(checkpoint) == 3

    source_identity = source.identity
    asyncio.run(source.aclose())
    asyncio.run(replacement.target.aclose())
    committed = replacement.commit_bound_replace()
    assert replacement.commit_bound_replace() == committed

    reopened = _bind_existing_target(tmp_path / "source.db", create_authority=False)
    with reopened.open_maintenance(MaintenanceOptions(read_only=True)) as connection:
        assert connection.execute("SELECT value FROM proof").fetchone()[0] == (
            "replacement"
        )
    asyncio.run(reopened.aclose())
    commit_closed_isolated_target(cleanup, source_identity)


def test_bound_replacement_discard_preserves_source_and_is_idempotent(
    tmp_path: Path,
) -> None:
    from app.runtime.sqlite_vfs import (
        MaintenanceOptions,
        _bind_existing_target,
        begin_bound_replacement,
        bind_marked_isolated_target,
        commit_closed_isolated_target,
    )

    marker = tmp_path / ".pxii-create"
    marker.write_text("replacement-discard", encoding="utf-8")
    source, cleanup = bind_marked_isolated_target(
        parent_path=tmp_path,
        exact_absent_basename="source.db",
        marker_basename=marker.name,
        marker_nonce="replacement-discard",
    )
    with source.open_maintenance(MaintenanceOptions(read_only=False)) as connection:
        connection.execute("CREATE TABLE proof(value TEXT NOT NULL)")
        connection.execute("INSERT INTO proof VALUES ('source')")
        connection.commit()

    replacement = begin_bound_replacement(source)
    with replacement.target.open_maintenance(
        MaintenanceOptions(read_only=False, create_if_missing=True)
    ) as connection:
        connection.execute("CREATE TABLE discarded(value INTEGER NOT NULL)")
        connection.commit()
    replacement.checkpoint_and_seal_source()
    source_identity = source.identity
    asyncio.run(source.aclose())
    asyncio.run(replacement.target.aclose())
    replacement.discard_closed_replacement()
    replacement.discard_closed_replacement()

    reopened = _bind_existing_target(tmp_path / "source.db", create_authority=False)
    with reopened.open_maintenance(MaintenanceOptions(read_only=True)) as connection:
        assert connection.execute("SELECT value FROM proof").fetchone()[0] == "source"
    asyncio.run(reopened.aclose())
    commit_closed_isolated_target(cleanup, source_identity)


def _prepare_closed_replacement(tmp_path: Path, nonce: str):
    from app.runtime.sqlite_vfs import (
        MaintenanceOptions,
        begin_bound_replacement,
        bind_marked_isolated_target,
    )

    marker = tmp_path / f".{nonce}.marker"
    marker.write_text(nonce, encoding="utf-8")
    source, cleanup = bind_marked_isolated_target(
        parent_path=tmp_path,
        exact_absent_basename=f"{nonce}.db",
        marker_basename=marker.name,
        marker_nonce=nonce,
    )
    with source.open_maintenance(MaintenanceOptions(read_only=False)) as connection:
        connection.execute("CREATE TABLE proof(value TEXT NOT NULL)")
        connection.execute("INSERT INTO proof VALUES ('source')")
        connection.commit()
    replacement = begin_bound_replacement(source)
    with replacement.target.open_maintenance(
        MaintenanceOptions(read_only=False, create_if_missing=True)
    ) as connection:
        connection.execute("CREATE TABLE proof(value TEXT NOT NULL)")
        connection.execute("INSERT INTO proof VALUES ('replacement')")
        connection.commit()
    replacement.checkpoint_and_seal_source()
    source_identity = source.identity
    asyncio.run(source.aclose())
    asyncio.run(replacement.target.aclose())
    replacement_path = next(tmp_path.glob(".pxii-replacement-*.db"))
    return source, cleanup, replacement, replacement_path, source_identity


def test_replacement_commit_rechecks_identity_after_pre_publish_swap(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    import app.runtime.sqlite_vfs as sqlite_vfs_module
    from app.runtime.sqlite_vfs import commit_closed_isolated_target

    source, cleanup, replacement, replacement_path, source_identity = (
        _prepare_closed_replacement(tmp_path, "commit-swap")
    )
    moved = tmp_path / "trusted-replacement.db"

    def swap(stage: str) -> None:
        if stage == "replacement_commit_before_publish":
            os.replace(replacement_path, moved)
            replacement_path.write_bytes(b"untrusted replacement")

    monkeypatch.setattr(sqlite_vfs_module, "_terminal_fault_hook", swap, raising=False)
    try:
        with pytest.raises(ValueError, match="replacement target identity changed"):
            replacement.commit_bound_replace()
        with sqlite3.connect(tmp_path / "commit-swap.db") as source_connection:
            assert source_connection.execute("SELECT value FROM proof").fetchone()[0] == (
                "source"
            )
        assert moved.exists()
        assert replacement_path.read_bytes() == b"untrusted replacement"
    finally:
        replacement_path.unlink(missing_ok=True)
        if moved.exists():
            os.replace(moved, replacement_path)
        replacement.discard_closed_replacement()
        commit_closed_isolated_target(cleanup, source_identity)
        del source


def test_replacement_commit_recovers_source_after_check_syscall_swap(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    import app.runtime.sqlite_vfs as sqlite_vfs_module
    from app.runtime.sqlite_vfs import commit_closed_isolated_target

    _source, cleanup, replacement, replacement_path, source_identity = (
        _prepare_closed_replacement(tmp_path, "commit-syscall-swap")
    )
    trusted = tmp_path / "trusted-before-syscall.db"

    def swap(stage: str) -> None:
        if stage == "replacement_commit_between_check_and_publish":
            os.replace(replacement_path, trusted)
            replacement_path.write_bytes(b"untrusted replacement")

    monkeypatch.setattr(sqlite_vfs_module, "_terminal_fault_hook", swap)
    with pytest.raises(ValueError, match="published replacement identity mismatch"):
        replacement.commit_bound_replace()
    with sqlite3.connect(tmp_path / "commit-syscall-swap.db") as source_connection:
        assert source_connection.execute("SELECT value FROM proof").fetchone()[0] == (
            "source"
        )
    assert trusted.exists()
    commit_closed_isolated_target(cleanup, source_identity)


def test_replacement_discard_rejects_initial_external_disappearance(
    tmp_path: Path,
) -> None:
    _source, _cleanup, replacement, replacement_path, _source_identity = (
        _prepare_closed_replacement(tmp_path, "discard-external-move")
    )
    moved = tmp_path / "externally-moved-replacement.db"
    os.replace(replacement_path, moved)
    with pytest.raises(ValueError, match="not reconcilable"):
        replacement.discard_closed_replacement()
    assert moved.exists()


@pytest.mark.parametrize("operation", ["commit", "discard"])
def test_replacement_intent_does_not_prove_missing_rename_completed(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    operation: str,
) -> None:
    import app.runtime.sqlite_vfs as sqlite_vfs_module

    _source, _cleanup, replacement, replacement_path, _source_identity = (
        _prepare_closed_replacement(tmp_path, f"intent-missing-{operation}")
    )
    moved = tmp_path / f"moved-after-{operation}-intent.db"
    stage_name = (
        "replacement_commit_after_publish_intent_before_syscall"
        if operation == "commit"
        else "replacement_discard_after_quarantine_intent_before_syscall"
    )

    def move_after_intent(stage: str) -> None:
        if stage == stage_name and replacement_path.exists():
            os.replace(replacement_path, moved)

    monkeypatch.setattr(sqlite_vfs_module, "_terminal_fault_hook", move_after_intent)
    call = (
        replacement.commit_bound_replace
        if operation == "commit"
        else replacement.discard_closed_replacement
    )
    with pytest.raises((FileNotFoundError, ValueError)):
        call()
    with pytest.raises(ValueError, match="not reconcilable"):
        call()
    if operation == "commit":
        with sqlite3.connect(tmp_path / "intent-missing-commit.db") as source_connection:
            assert source_connection.execute("SELECT value FROM proof").fetchone()[0] == (
                "source"
            )
    assert moved.exists()


@pytest.mark.parametrize(
    ("operation", "fault_stage"),
    [
        ("commit", "replacement_commit_after_publish"),
        ("discard", "replacement_discard_after_delete"),
    ],
)
def test_replacement_terminal_operation_retries_after_physical_completion(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    operation: str,
    fault_stage: str,
) -> None:
    import app.runtime.sqlite_vfs as sqlite_vfs_module
    from app.runtime.sqlite_vfs import commit_closed_isolated_target

    _source, cleanup, replacement, _replacement_path, source_identity = (
        _prepare_closed_replacement(tmp_path, f"partial-{operation}")
    )
    injected = False

    def fail_once(stage: str) -> None:
        nonlocal injected
        if stage == fault_stage and not injected:
            injected = True
            raise OSError(f"injected {stage}")

    monkeypatch.setattr(
        sqlite_vfs_module, "_terminal_fault_hook", fail_once, raising=False
    )
    call = (
        replacement.commit_bound_replace
        if operation == "commit"
        else replacement.discard_closed_replacement
    )
    with pytest.raises(OSError, match=fault_stage):
        call()
    call()
    call()
    commit_closed_isolated_target(cleanup, source_identity)


def test_replacement_discard_rejects_reappeared_name_after_physical_delete(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    import app.runtime.sqlite_vfs as sqlite_vfs_module
    from app.runtime.sqlite_vfs import commit_closed_isolated_target

    _source, cleanup, replacement, replacement_path, source_identity = (
        _prepare_closed_replacement(tmp_path, "discard-reappeared")
    )
    injected = False

    def recreate_after_delete(stage: str) -> None:
        nonlocal injected
        if stage == "replacement_discard_after_delete" and not injected:
            injected = True
            replacement_path.write_bytes(b"untrusted replacement")
            raise OSError("injected replacement_discard_after_delete")

    monkeypatch.setattr(
        sqlite_vfs_module, "_terminal_fault_hook", recreate_after_delete
    )
    with pytest.raises(OSError, match="replacement_discard_after_delete"):
        replacement.discard_closed_replacement()
    with pytest.raises(ValueError, match="replacement target name reappeared"):
        replacement.discard_closed_replacement()
    replacement_path.unlink()
    replacement.discard_closed_replacement()
    commit_closed_isolated_target(cleanup, source_identity)


@pytest.mark.parametrize(
    ("operation", "fault_stage"),
    [
        ("commit", "replacement_commit_after_source_quarantine_before_receipt"),
        ("discard", "replacement_discard_after_quarantine_before_receipt"),
    ],
)
def test_replacement_reconciles_rename_completed_before_receipt(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    operation: str,
    fault_stage: str,
) -> None:
    import app.runtime.sqlite_vfs as sqlite_vfs_module
    from app.runtime.sqlite_vfs import commit_closed_isolated_target

    _source, cleanup, replacement, _replacement_path, source_identity = (
        _prepare_closed_replacement(tmp_path, f"rename-before-receipt-{operation}")
    )
    injected = False

    def fail_once(stage: str) -> None:
        nonlocal injected
        if stage == fault_stage and not injected:
            injected = True
            raise OSError(f"injected {stage}")

    monkeypatch.setattr(sqlite_vfs_module, "_terminal_fault_hook", fail_once)
    call = (
        replacement.commit_bound_replace
        if operation == "commit"
        else replacement.discard_closed_replacement
    )
    with pytest.raises(OSError, match=fault_stage):
        call()
    call()
    commit_closed_isolated_target(cleanup, source_identity)


@pytest.mark.parametrize(
    ("operation", "fault_stage"),
    [
        ("commit", "isolated_commit_after_marker_delete"),
        ("discard", "isolated_discard_after_target_delete"),
    ],
)
def test_isolated_terminal_operation_retries_after_physical_completion(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    operation: str,
    fault_stage: str,
) -> None:
    import app.runtime.sqlite_vfs as sqlite_vfs_module
    from app.runtime.sqlite_vfs import (
        MaintenanceOptions,
        bind_marked_isolated_target,
        commit_closed_isolated_target,
        discard_closed_isolated_target,
    )

    marker = tmp_path / f".{operation}.marker"
    marker.write_text(operation, encoding="utf-8")
    target, cleanup = bind_marked_isolated_target(
        parent_path=tmp_path,
        exact_absent_basename=f"isolated-{operation}.db",
        marker_basename=marker.name,
        marker_nonce=operation,
    )
    with target.open_maintenance(MaintenanceOptions(read_only=False)) as connection:
        connection.execute("CREATE TABLE proof(value INTEGER NOT NULL)")
        connection.commit()
    identity = target.identity
    asyncio.run(target.aclose())
    injected = False

    def fail_once(stage: str) -> None:
        nonlocal injected
        if stage == fault_stage and not injected:
            injected = True
            raise OSError(f"injected {stage}")

    monkeypatch.setattr(
        sqlite_vfs_module, "_terminal_fault_hook", fail_once, raising=False
    )
    call = (
        commit_closed_isolated_target
        if operation == "commit"
        else discard_closed_isolated_target
    )
    with pytest.raises(OSError, match=fault_stage):
        call(cleanup, identity)
    call(cleanup, identity)
    call(cleanup, identity)


@pytest.mark.parametrize("operation", ["commit", "discard"])
def test_isolated_cleanup_reconciles_unlink_completed_before_receipt(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    operation: str,
) -> None:
    import app.runtime.sqlite_vfs as sqlite_vfs_module
    from app.runtime.sqlite_vfs import (
        MaintenanceOptions,
        bind_marked_isolated_target,
        commit_closed_isolated_target,
        discard_closed_isolated_target,
    )

    marker = tmp_path / f".{operation}-unlink.marker"
    marker.write_text(operation, encoding="utf-8")
    target, cleanup = bind_marked_isolated_target(
        parent_path=tmp_path,
        exact_absent_basename=f"isolated-{operation}-unlink.db",
        marker_basename=marker.name,
        marker_nonce=operation,
    )
    with target.open_maintenance(MaintenanceOptions(read_only=False)) as connection:
        connection.execute("CREATE TABLE proof(value INTEGER NOT NULL)")
        connection.commit()
    identity = target.identity
    asyncio.run(target.aclose())
    injected = False

    def fail_once(stage: str) -> None:
        nonlocal injected
        if stage == "delete_relative_after_unlink_before_receipt" and not injected:
            injected = True
            raise OSError("injected delete_relative_after_unlink_before_receipt")

    monkeypatch.setattr(sqlite_vfs_module, "_terminal_fault_hook", fail_once)
    call = (
        commit_closed_isolated_target
        if operation == "commit"
        else discard_closed_isolated_target
    )
    with pytest.raises(OSError, match="delete_relative_after_unlink_before_receipt"):
        call(cleanup, identity)
    call(cleanup, identity)


@pytest.mark.parametrize(("operation", "missing_role"), [("commit", "marker"), ("discard", "target")])
def test_isolated_cleanup_rejects_initial_external_disappearance(
    tmp_path: Path,
    operation: str,
    missing_role: str,
) -> None:
    from app.runtime.sqlite_vfs import (
        bind_marked_isolated_target,
        commit_closed_isolated_target,
        discard_closed_isolated_target,
    )

    marker = tmp_path / f".{operation}-external.marker"
    marker.write_text(operation, encoding="utf-8")
    target_path = tmp_path / f"isolated-{operation}-external.db"
    target, cleanup = bind_marked_isolated_target(
        parent_path=tmp_path,
        exact_absent_basename=target_path.name,
        marker_basename=marker.name,
        marker_nonce=operation,
    )
    identity = target.identity
    asyncio.run(target.aclose())
    victim = marker if missing_role == "marker" else target_path
    moved = tmp_path / f"moved-{victim.name}"
    os.replace(victim, moved)
    call = (
        commit_closed_isolated_target
        if operation == "commit"
        else discard_closed_isolated_target
    )
    with pytest.raises(FileNotFoundError):
        call(cleanup, identity)
    assert moved.exists()


@pytest.mark.parametrize(("operation", "role"), [("commit", "marker"), ("discard", "target")])
def test_isolated_delete_intent_does_not_prove_missing_unlink_completed(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    operation: str,
    role: str,
) -> None:
    import app.runtime.sqlite_vfs as sqlite_vfs_module
    from app.runtime.sqlite_vfs import (
        bind_marked_isolated_target,
        commit_closed_isolated_target,
        discard_closed_isolated_target,
    )

    marker = tmp_path / f".{operation}-intent.marker"
    marker.write_text(operation, encoding="utf-8")
    target_path = tmp_path / f"isolated-{operation}-intent.db"
    target, cleanup = bind_marked_isolated_target(
        parent_path=tmp_path,
        exact_absent_basename=target_path.name,
        marker_basename=marker.name,
        marker_nonce=operation,
    )
    identity = target.identity
    asyncio.run(target.aclose())
    victim = marker if role == "marker" else target_path
    moved = tmp_path / f"moved-after-intent-{victim.name}"

    def move_after_intent(stage: str) -> None:
        if stage == f"isolated_{role}_after_intent_before_delete" and victim.exists():
            os.replace(victim, moved)

    monkeypatch.setattr(sqlite_vfs_module, "_terminal_fault_hook", move_after_intent)
    call = (
        commit_closed_isolated_target
        if operation == "commit"
        else discard_closed_isolated_target
    )
    with pytest.raises(FileNotFoundError):
        call(cleanup, identity)
    with pytest.raises(FileNotFoundError):
        call(cleanup, identity)
    assert moved.exists()


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


def test_native_binding_state_reads_are_registry_guarded() -> None:
    source = (
        Path(__file__).parents[1] / "native" / "pxii_vfs" / "pxii_vfs.c"
    ).read_text(encoding="utf-8")
    assert "static int binding_is_revoked(PxiiBinding *binding)" in source
    assert "*result_out = !binding->revoked;" not in source
    assert "pxii->binding == NULL || pxii->binding->revoked" not in source
    assert "pxii->shm_identity = child->identity;" not in source


def test_posix_companion_delete_fails_closed_without_unlink() -> None:
    source = (
        Path(__file__).parents[1] / "native" / "pxii_vfs" / "pxii_vfs.c"
    ).read_text(encoding="utf-8")
    assert "posix_delete_via_quarantine" not in source
    assert "unlinkat(binding->parent, quarantine" not in source
    assert "pxii_posix_delete_deferred" in source


def test_posix_delete_preserves_verified_and_replacement_entries() -> None:
    source = (
        Path(__file__).parents[1] / "native" / "pxii_vfs" / "pxii_vfs.c"
    ).read_text(encoding="utf-8")
    posix_branch = source.split("#if !defined(_WIN32)", 1)[1].split("#else", 1)[0]
    assert "binding_release(binding);" in posix_branch
    assert "return PXII_POSIX_DELETE_DEFERRED;" in posix_branch
    assert "state = 0" not in posix_branch


def test_posix_wal_checkpoint_reports_deferred_delete() -> None:
    source = (
        Path(__file__).parents[1] / "native" / "pxii_vfs" / "pxii_vfs.c"
    ).read_text(encoding="utf-8")
    assert 'trace_event("pxii_posix_delete_deferred", PXII_POSIX_DELETE_DEFERRED, 0)' in source
    assert "PXII_POSIX_DELETE_DEFERRED SQLITE_IOERR_DELETE" in source


def test_posix_rollback_journal_reports_deferred_delete() -> None:
    source = (
        Path(__file__).parents[1] / "native" / "pxii_vfs" / "pxii_vfs.c"
    ).read_text(encoding="utf-8")
    assert "strcmp(suffix, \"-journal\")" in source
    assert "return PXII_POSIX_DELETE_DEFERRED;" in source


def test_windows_companion_delete_uses_bound_delete_handle() -> None:
    source = (
        Path(__file__).parents[1] / "native" / "pxii_vfs" / "pxii_vfs.c"
    ).read_text(encoding="utf-8")
    assert "SetFileInformationByHandle(handle, FileDispositionInfo" in source
    assert "relative_open(binding, child_name, 3, &handle)" in source
    assert "FILE_SHARE_DELETE" in source


def test_windows_cibuildwheel_is_the_only_supported_runtime() -> None:
    backend_root = Path(__file__).parents[1]
    config = tomllib.loads((backend_root / "cibuildwheel.toml").read_text("utf-8"))
    assert config["tool"]["cibuildwheel"]["build"] == "cp313-*"

    workflow = (
        backend_root.parent / ".github" / "workflows" / "pxii-vfs-wheels.yml"
    ).read_text("utf-8")
    assert "platform_id: windows-x86_64" in workflow
    assert "platform_id: linux-x86_64" not in workflow
    assert "Assemble closed Windows-only manifest" in workflow
    assert "PXII_VFS_LOAD_EXTENSION_CAPABILITY_OK" in workflow
    capability_probe = workflow.index("PXII_VFS_LOAD_EXTENSION_CAPABILITY_OK")
    wheel_install = workflow.index("uv pip install --python")
    native_matrix = workflow.index("-m pytest -q backend/tests/test_pxii_vfs.py")
    assert capability_probe < wheel_install < native_matrix


def test_delete_completion_receipt_covers_descriptor_close_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from types import SimpleNamespace

    import app.runtime.sqlite_vfs as sqlite_vfs_module

    monkeypatch.setattr(sqlite_vfs_module.os, "name", "posix")
    monkeypatch.setattr(sqlite_vfs_module.os, "open", lambda *_args, **_kwargs: 41)
    monkeypatch.setattr(
        sqlite_vfs_module.os,
        "fstat",
        lambda _descriptor: SimpleNamespace(st_dev=1, st_ino=2),
    )
    monkeypatch.setattr(sqlite_vfs_module.os, "unlink", lambda *_args, **_kwargs: None)

    def fail_close(_descriptor: int) -> None:
        raise OSError("injected descriptor close failure")

    monkeypatch.setattr(sqlite_vfs_module.os, "close", fail_close)
    with pytest.raises(OSError, match="descriptor close failure") as caught:
        sqlite_vfs_module._delete_relative(7, "target.db", None)
    assert sqlite_vfs_module._has_physical_completion(caught.value, "delete")


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


@pytest.mark.asyncio
async def test_alembic_upgrade_head_uses_bound_async_engine(tmp_path: Path) -> None:
    from alembic import command
    from alembic.script import ScriptDirectory

    from app.runtime.sqlite_vfs import (
        AsyncEngineOptions,
        bind_marked_isolated_target,
    )
    from tests.migrations import alembic_config

    marker = tmp_path / ".pxii-create"
    marker.write_text("bound-alembic", encoding="utf-8")
    target, _cleanup = bind_marked_isolated_target(
        parent_path=tmp_path,
        exact_absent_basename="alembic.db",
        marker_basename=marker.name,
        marker_nonce="bound-alembic",
    )
    engine = target.make_async_engine(
        AsyncEngineOptions(pool_size=1, max_overflow=0)
    )
    config = alembic_config("space")

    def upgrade(connection) -> None:
        config.attributes["connection"] = connection
        command.upgrade(config, "head")

    async with engine.begin() as connection:
        await connection.run_sync(upgrade)
    async with engine.connect() as connection:
        revision = await connection.scalar(
            text('SELECT version_num FROM "alembic_version_space"')
        )
    assert revision == ScriptDirectory.from_config(config).get_current_head()
    await engine.dispose()
    await target.aclose()


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
        _BOOTSTRAP_LOCK,
        AsyncEngineOptions,
        _bootstrap,
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
    token = target._authority.token
    await target.aclose()
    control, _receipt = _bootstrap()
    with _BOOTSTRAP_LOCK:
        references = control.execute(
            "SELECT pxii_live_references(?)", (token,)
        ).fetchone()[0]
    assert references == -1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "cancel_stage",
    ["enable_load_extension", "set_authorizer", "busy_timeout", "foreign_keys"],
)
async def test_cancelled_async_creator_configuration_closes_native_file(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    cancel_stage: str,
) -> None:
    import aiosqlite

    from app.runtime.sqlite_vfs import (
        AsyncEngineOptions,
        _test_binding_receipt,
        bind_marked_isolated_target,
    )

    marker = tmp_path / ".pxii-create"
    marker.write_text(f"cancel-{cancel_stage}", encoding="utf-8")
    target, _cleanup = bind_marked_isolated_target(
        parent_path=tmp_path,
        exact_absent_basename=f"cancel-{cancel_stage}.db",
        marker_basename=marker.name,
        marker_nonce=f"cancel-{cancel_stage}",
    )
    engine = target.make_async_engine(
        AsyncEngineOptions(pool_size=1, max_overflow=0, busy_timeout_ms=1_000)
    )
    original_execute = aiosqlite.Connection._execute
    entered = asyncio.Event()
    captured: list[aiosqlite.Connection] = []
    tripped = False

    def matches(function: object, arguments: tuple[object, ...]) -> bool:
        name = getattr(function, "__name__", "")
        if cancel_stage in {"enable_load_extension", "set_authorizer"}:
            return name == cancel_stage
        statement = str(arguments[0]) if name == "execute" and arguments else ""
        return statement.startswith(
            "PRAGMA busy_timeout" if cancel_stage == "busy_timeout" else "PRAGMA foreign_keys"
        )

    async def cancel_boundary(self, function, *arguments):
        nonlocal tripped
        if not tripped and matches(function, arguments):
            tripped = True
            captured.append(self)
            entered.set()
            await asyncio.Future()
        return await original_execute(self, function, *arguments)

    monkeypatch.setattr(aiosqlite.Connection, "_execute", cancel_boundary)
    opening = asyncio.ensure_future(engine.connect())
    await asyncio.wait_for(entered.wait(), timeout=5)
    opening.cancel()
    with pytest.raises(asyncio.CancelledError):
        await opening
    try:
        assert _test_binding_receipt(target).live_file_references == 0
    finally:
        if captured:
            await captured[0].close()
        await engine.dispose()
        await target.aclose()


def test_rollback_journal_swap_cannot_redirect_io(tmp_path: Path) -> None:
    from app.runtime.sqlite_vfs import MaintenanceOptions, bind_marked_isolated_target

    marker = tmp_path / ".pxii-create"
    marker.write_text("journal-swap", encoding="utf-8")
    target, _cleanup = bind_marked_isolated_target(
        parent_path=tmp_path,
        exact_absent_basename="journal-swap.db",
        marker_basename=marker.name,
        marker_nonce="journal-swap",
    )
    database = tmp_path / "journal-swap.db"
    outside = tmp_path / "outside-journal"
    outside.mkdir()
    with target.open_maintenance(MaintenanceOptions(read_only=False)) as connection:
        connection.execute("PRAGMA journal_mode=DELETE")
        connection.execute("CREATE TABLE proof(value TEXT NOT NULL)")
        connection.execute("INSERT INTO proof VALUES ('before-swap')")
        connection.commit()
        connection.execute("BEGIN IMMEDIATE")
        connection.execute("UPDATE proof SET value='uncommitted'")
        journal = database.with_name(f"{database.name}-journal")
        assert journal.exists()
        moved = outside / journal.name
        size_before = journal.stat().st_size
        try:
            os.replace(journal, moved)
        except PermissionError:
            assert not moved.exists()
        else:
            journal.write_bytes(b"untrusted replacement")
            with pytest.raises(sqlite3.Error):
                connection.commit()
            assert moved.stat().st_size == size_before
            os.replace(moved, journal)


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
