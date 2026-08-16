from __future__ import annotations

import asyncio
import ctypes
import hashlib
import inspect
import json
import os
import threading
from dataclasses import fields, replace
from pathlib import Path
from typing import cast

import pytest

import app.mutation.types as mutation_types
from app.errors import PathOutsideSpaceError
from app.mutation.staging import StageIntegrityError, StageStore, UnsafeProjectionPathError
from app.runtime.contained_io import BoundDirectoryHandle, BoundStageDirectory
from app.runtime.leases import FenceReceipt, LeaseMode, LeaseOrderError, RuntimeLeaseCoordinator


def _projection_api():
    names = (
        "ContainedProjectionActionField",
        "MaterializedProjectionAction",
        "PersistedProjectionDescriptor",
        "ProjectionActionTag",
        "ProjectionPlan",
    )
    missing = tuple(name for name in names if not hasattr(mutation_types, name))
    assert missing == (), f"missing closed projection API: {missing}"
    return tuple(getattr(mutation_types, name) for name in names)


def _field(value: str):
    contained_field, *_ = _projection_api()
    return contained_field(value)


def _plan(
    tag: str,
    target: str,
    ordinal: int,
    before: bytes | None,
    after: bytes | None,
    *,
    source: str | None = None,
):
    *_, projection_tag, projection_plan = _projection_api()
    return projection_plan(
        projection_tag(tag),
        None if source is None else _field(source),
        _field(target),
        ordinal,
        before,
        after,
    )


async def _exclusive(tmp_path):
    coordinator = RuntimeLeaseCoordinator(tmp_path / ".runtime")
    global_lease = await coordinator.acquire_global(LeaseMode.SHARED, "test", 2)
    space_lease = await coordinator.acquire_spaces(["space-a"], LeaseMode.EXCLUSIVE, "stage", 2)
    return global_lease, space_lease


def _authority(tmp_path) -> BoundStageDirectory:
    parent = BoundDirectoryHandle._create(tmp_path.parent)
    try:
        return BoundStageDirectory._from_parent_handle(parent, tmp_path.name)
    finally:
        parent._close()


@pytest.mark.asyncio
async def test_stage_publication_is_durable_and_idempotent(tmp_path) -> None:
    calls: list[str] = []
    authority = _authority(tmp_path)
    store = StageStore(authority, observer=calls.append)
    global_lease, lease = await _exclusive(tmp_path)
    plans = (
        _plan("markdown_write", "notes/n1.md", 0, b"old", b"new"),
        _plan("index_replace", "rows/n1.json", 1, None, b'{"id":"n1"}'),
    )
    try:
        first = await store.publish("op-1", plans, lease=lease, space_id="space-a")
        second = await store.publish("op-1", plans, lease=lease, space_id="space-a")
        assert first == second == store.verify("op-1")
        assert first.directory_key == hashlib.sha256(b"op-1").hexdigest()
        assert authority.direct_children() == (first.directory_key,)
        durability_events = {
            "fsync-after-directory",
            "fsync-before-directory",
            "fsync-temp-directory",
            "rename-published-directory",
            "fsync-parent-directory",
        }
        assert [event for event in calls if event in durability_events] == [
            "fsync-before-directory",
            "fsync-after-directory",
            "fsync-temp-directory",
            "rename-published-directory",
            "fsync-parent-directory",
        ]
        assert calls.index("fsync-namespace-parent") < calls.index("before-temp-create")
    finally:
        store.close()
        await lease.release()
        await global_lease.release()


@pytest.mark.asyncio
async def test_same_operation_with_different_stage_content_fails_closed(tmp_path) -> None:
    authority = _authority(tmp_path)
    store = StageStore(authority)
    global_lease, lease = await _exclusive(tmp_path)
    try:
        await store.publish(
            "same-op",
            (_plan("markdown_write", "notes/n.md", 0, None, b"first"),),
            lease=lease,
            space_id="space-a",
        )
        with pytest.raises(StageIntegrityError, match="different content"):
            await store.publish(
                "same-op",
                (_plan("markdown_write", "notes/n.md", 0, None, b"second"),),
                lease=lease,
                space_id="space-a",
            )
    finally:
        store.close()
        await lease.release()
        await global_lease.release()


@pytest.mark.parametrize(
    "plan",
    [
        lambda: _plan("markdown_write", "notes/n.md", 1, None, b"new"),
        lambda: _plan("markdown_write", "notes/n.md", 0, None, None),
    ],
)
@pytest.mark.asyncio
async def test_invalid_projection_plan_is_rejected_before_staging(
    tmp_path, plan
) -> None:
    calls: list[str] = []
    authority = _authority(tmp_path)
    store = StageStore(authority, observer=calls.append)
    global_lease, lease = await _exclusive(tmp_path)
    try:
        with pytest.raises(ValueError):
            await store.publish(
                "invalid-plan", (plan(),), lease=lease, space_id="space-a"
            )
        assert calls == []
        assert authority.direct_children() == ()
    finally:
        store.close()
        await lease.release()
        await global_lease.release()


@pytest.mark.parametrize(
    "target", ["../escape", "/absolute", "C:/escape", "notes/../../escape", r"notes\x"]
)
def test_projection_target_must_be_relative_and_contained(tmp_path, target: str) -> None:
    store = StageStore(_authority(tmp_path))
    try:
        with pytest.raises(UnsafeProjectionPathError):
            store.validate_target(target)
    finally:
        store.close()


@pytest.mark.parametrize(
    "value",
    [
        "",
        "/absolute",
        "../escape",
        "notes/../../escape",
        r"notes\escape.md",
        "file://notes/n.md",
        "C:/notes/n.md",
        "notes/\x00n.md",
        ".mutations/operation/after/0.bin",
        f"{'a' * 64}/after/0.bin",
        "after/0.bin",
        "manifest.json",
    ],
)
def test_contained_projection_action_field_rejects_stage_and_host_names(value: str) -> None:
    with pytest.raises(ValueError):
        _field(value)


def _action_shape(action) -> tuple[str, str | None, str, int, bytes | None]:
    return (
        action.tag.value,
        None if action.source is None else str(action.source),
        str(action.target),
        action.ordinal,
        action.blob,
    )


@pytest.mark.asyncio
async def test_stage_materialize_after_returns_closed_actions(tmp_path) -> None:
    authority = _authority(tmp_path)
    store = StageStore(authority)
    global_lease, lease = await _exclusive(tmp_path)
    plans = (
        _plan("markdown_write", "notes/n.md", 0, b"old", b"new"),
        _plan(
            "path_rename",
            "notes/renamed.md",
            1,
            b"new",
            b"new",
            source="notes/n.md",
        ),
        _plan("path_remove", "notes/deleted.md", 2, b"deleted", None),
        _plan("index_replace", "rows/n.json", 3, b"old-index", b"new-index"),
        _plan("fts_replace", "fts/n.json", 4, b"old-fts", None),
    )
    try:
        manifest = await store.publish(
            "caller-secret.md", plans, lease=lease, space_id="space-a"
        )
        descriptors = tuple(step.descriptor for step in manifest.steps)
        actions = await store.materialize(
            "caller-secret.md",
            descriptors,
            image="after",
            receipt=lease.fence_receipt("space-a"),
        )

        assert tuple(_action_shape(action) for action in actions) == (
            ("markdown_write", None, "notes/n.md", 0, b"new"),
            ("path_rename", "notes/n.md", "notes/renamed.md", 1, b"new"),
            ("path_remove", None, "notes/deleted.md", 2, None),
            ("index_replace", None, "rows/n.json", 3, b"new-index"),
            ("fts_replace", None, "fts/n.json", 4, None),
        )
        materialized_action = _projection_api()[1]
        assert tuple(field.name for field in fields(materialized_action)) == (
            "tag",
            "source",
            "target",
            "ordinal",
            "blob",
        )
        exposed = repr(actions)
        assert manifest.directory_key not in exposed
        assert "caller-secret.md" not in exposed
        assert "after/0.bin" not in exposed
        assert not any(
            isinstance(getattr(action, field.name), Path)
            for action in actions
            for field in fields(action)
        )
        assert tuple(inspect.signature(store.materialize).parameters) == (
            "operation_id",
            "descriptors",
            "image",
            "receipt",
        )
    finally:
        store.close()
        await lease.release()
        await global_lease.release()


@pytest.mark.asyncio
async def test_stage_materialize_before_derives_exact_inverse_actions(tmp_path) -> None:
    authority = _authority(tmp_path)
    store = StageStore(authority)
    global_lease, lease = await _exclusive(tmp_path)
    plans = (
        _plan("markdown_write", "notes/created.md", 0, None, b"created"),
        _plan("markdown_write", "notes/updated.md", 1, b"old", b"new"),
        _plan(
            "path_rename",
            "notes/new-name.md",
            2,
            b"renamed-body",
            b"renamed-body",
            source="notes/old-name.md",
        ),
        _plan("path_remove", "notes/removed.md", 3, b"removed", None),
        _plan("index_replace", "rows/n.json", 4, b"old-index", b"new-index"),
        _plan("fts_replace", "fts/n.json", 5, None, b"new-fts"),
    )
    try:
        manifest = await store.publish(
            "inverse-op", plans, lease=lease, space_id="space-a"
        )
        actions = await store.materialize(
            "inverse-op",
            tuple(step.descriptor for step in manifest.steps),
            image="before",
            receipt=lease.fence_receipt("space-a"),
        )

        assert tuple(_action_shape(action) for action in actions) == (
            ("path_remove", None, "notes/created.md", 0, None),
            ("markdown_write", None, "notes/updated.md", 1, b"old"),
            ("path_rename", "notes/new-name.md", "notes/old-name.md", 2, b"renamed-body"),
            ("markdown_write", None, "notes/removed.md", 3, b"removed"),
            ("index_replace", None, "rows/n.json", 4, b"old-index"),
            ("fts_replace", None, "fts/n.json", 5, None),
        )
    finally:
        store.close()
        await lease.release()
        await global_lease.release()


@pytest.mark.asyncio
async def test_stage_materialize_side_validates_only_requested_ordinals_and_side(
    tmp_path,
) -> None:
    authority = _authority(tmp_path)
    store = StageStore(authority)
    global_lease, lease = await _exclusive(tmp_path)
    plans = (
        _plan("markdown_write", "notes/a.md", 0, b"a0", b"a1"),
        _plan("index_replace", "rows/a.json", 1, b"i0", b"i1"),
        _plan("fts_replace", "fts/a.json", 2, b"f0", b"f1"),
    )
    try:
        manifest = await store.publish(
            "selective-side", plans, lease=lease, space_id="space-a"
        )
        descriptors = tuple(step.descriptor for step in manifest.steps)
        key = manifest.directory_key
        relative = f"{key}/after/2.bin"
        authority._handle._atomic_write_relative(
            authority._relative(relative), b"corrupt"
        )

        actions = await store.materialize_side(
            "selective-side",
            descriptors,
            image="before",
            ordinals=(2, 0),
            receipt=lease.fence_receipt("space-a"),
        )

        assert tuple(_action_shape(action) for action in actions) == (
            ("fts_replace", None, "fts/a.json", 2, b"f0"),
            ("markdown_write", None, "notes/a.md", 0, b"a0"),
        )
        with pytest.raises(StageIntegrityError, match="hash or size"):
            await store.materialize_side(
                "selective-side",
                descriptors,
                image="after",
                ordinals=(2,),
                receipt=lease.fence_receipt("space-a"),
            )
    finally:
        store.close()
        await lease.release()
        await global_lease.release()


def test_path_rename_requires_equal_non_null_content_images() -> None:
    with pytest.raises(ValueError, match="equal before and after"):
        _plan(
            "path_rename",
            "notes/new.md",
            0,
            b"old",
            b"different",
            source="notes/old.md",
        )


@pytest.mark.parametrize("drift", ["target", "hash", "size"])
@pytest.mark.asyncio
async def test_stage_materialize_rejects_nonexact_descriptors(
    tmp_path, drift: str
) -> None:
    authority = _authority(tmp_path)
    store = StageStore(authority)
    global_lease, lease = await _exclusive(tmp_path)
    try:
        manifest = await store.publish(
            "descriptor-op",
            (_plan("markdown_write", "notes/n.md", 0, b"old", b"new"),),
            lease=lease,
            space_id="space-a",
        )
        descriptor = manifest.steps[0].descriptor
        if drift == "target":
            descriptor = replace(descriptor, target=_field("notes/other.md"))
        elif drift == "hash":
            descriptor = replace(descriptor, after_sha256="f" * 64)
        else:
            assert descriptor.after_size is not None
            descriptor = replace(descriptor, after_size=descriptor.after_size + 1)

        with pytest.raises(StageIntegrityError):
            await store.materialize(
                "descriptor-op",
                (descriptor,),
                image="after",
                receipt=lease.fence_receipt("space-a"),
            )
    finally:
        store.close()
        await lease.release()
        await global_lease.release()


@pytest.mark.parametrize("tampered", [b"tam", b"longer-tamper"])
@pytest.mark.asyncio
async def test_stage_materialize_rejects_selected_blob_hash_or_size_drift(
    tmp_path, tampered: bytes
) -> None:
    authority = _authority(tmp_path)
    store = StageStore(authority)
    global_lease, lease = await _exclusive(tmp_path)
    try:
        manifest = await store.publish(
            "blob-op",
            (_plan("markdown_write", "notes/n.md", 0, None, b"new"),),
            lease=lease,
            space_id="space-a",
        )
        relative = f"{manifest.directory_key}/after/0.bin"
        authority._handle._atomic_write_relative(authority._relative(relative), tampered)

        with pytest.raises(StageIntegrityError, match="hash or size"):
            await store.materialize(
                "blob-op",
                tuple(step.descriptor for step in manifest.steps),
                image="after",
                receipt=lease.fence_receipt("space-a"),
            )
    finally:
        store.close()
        await lease.release()
        await global_lease.release()


@pytest.mark.asyncio
async def test_stage_materialize_binds_operation_and_rejects_invalid_image_side(
    tmp_path,
) -> None:
    authority = _authority(tmp_path)
    store = StageStore(authority)
    global_lease, lease = await _exclusive(tmp_path)
    try:
        manifest = await store.publish(
            "bound-op",
            (_plan("markdown_write", "notes/n.md", 0, None, b"new"),),
            lease=lease,
            space_id="space-a",
        )
        descriptors = tuple(step.descriptor for step in manifest.steps)
        with pytest.raises(StageIntegrityError):
            await store.materialize(
                "other-op",
                descriptors,
                image="after",
                receipt=lease.fence_receipt("space-a"),
            )
        with pytest.raises(ValueError, match="before or after"):
            await store.materialize(
                "bound-op",
                descriptors,
                image=cast(str, "sideways"),
                receipt=cast(FenceReceipt, lease.fence_receipt("space-a")),
            )
        with pytest.raises(ValueError, match="operation"):
            await store.materialize(
                "计划",
                descriptors,
                image="after",
                receipt=lease.fence_receipt("space-a"),
            )
    finally:
        store.close()
        await lease.release()
        await global_lease.release()


@pytest.mark.asyncio
async def test_orphan_collection_requires_exclusive_and_preserves_live_temp(tmp_path) -> None:
    authority = _authority(tmp_path)
    store = StageStore(authority)
    global_lease, lease = await _exclusive(tmp_path)
    live_id = "childp:5:batch:0000"
    live_key = hashlib.sha256(live_id.encode()).hexdigest()
    unknown_key = "a" * 64
    try:
        receipt = lease.fence_receipt("space-a")
        authority.ensure_directory(f".tmp-{live_key}-live", receipt)
        authority.ensure_directory(f".tmp-{unknown_key}-orphan", receipt)
        with pytest.raises(LeaseOrderError):
            await store.collect_orphans(
                live_operation_ids={live_id}, lease=None, space_id="space-a"
            )
        removed = await store.collect_orphans(
            live_operation_ids={live_id}, lease=lease, space_id="space-a"
        )
        assert removed == (f".tmp-{unknown_key}-orphan",)
        assert authority.direct_children() == (f".tmp-{live_key}-live",)
    finally:
        store.close()
        await lease.release()
        await global_lease.release()


@pytest.mark.asyncio
async def test_published_batch_child_orphan_is_verified_before_deletion(tmp_path) -> None:
    authority = _authority(tmp_path)
    store = StageStore(authority)
    global_lease, lease = await _exclusive(tmp_path)
    operation_id = "childp:5:batch:0000"
    try:
        manifest = await store.publish(
            operation_id,
            (_plan("markdown_write", "notes/n.md", 0, None, b"new"),),
            lease=lease,
            space_id="space-a",
        )
        assert manifest.operation_id == operation_id
        assert manifest.directory_key == hashlib.sha256(operation_id.encode()).hexdigest()
        assert set(manifest.directory_key) <= set("0123456789abcdef")

        authority.write_fsynced(
            f"{manifest.directory_key}/unreferenced.bin",
            b"tampered",
            lease.fence_receipt("space-a"),
        )
        with pytest.raises(StageIntegrityError):
            await store.collect_orphans(
                live_operation_ids=set(), lease=lease, space_id="space-a"
            )
        assert authority.direct_children() == (manifest.directory_key,)
    finally:
        store.close()
        await lease.release()
        await global_lease.release()


@pytest.mark.asyncio
async def test_verified_published_orphan_is_deleted(tmp_path) -> None:
    authority = _authority(tmp_path)
    store = StageStore(authority)
    global_lease, lease = await _exclusive(tmp_path)
    try:
        manifest = await store.publish(
            "published-orphan",
            (_plan("markdown_write", "notes/n.md", 0, None, b"new"),),
            lease=lease,
            space_id="space-a",
        )
        removed = await store.collect_orphans(
            live_operation_ids=set(), lease=lease, space_id="space-a"
        )
        assert removed == (manifest.directory_key,)
        assert authority.direct_children() == ()
    finally:
        store.close()
        await lease.release()
        await global_lease.release()


@pytest.mark.asyncio
async def test_publish_cancellation_joins_worker_before_lease_release(tmp_path) -> None:
    entered = threading.Event()
    resume = threading.Event()

    def observer(event: str) -> None:
        if event == "before-manifest-write":
            entered.set()
            assert resume.wait(5)

    authority = _authority(tmp_path)
    store = StageStore(authority, observer=observer)
    global_lease, lease = await _exclusive(tmp_path)
    owner = asyncio.current_task()
    assert owner is not None

    async def cancel_owner() -> None:
        assert await asyncio.to_thread(entered.wait, 5)
        owner.cancel()
        resume.set()

    canceller = asyncio.create_task(cancel_owner())
    try:
        with pytest.raises(asyncio.CancelledError):
            await store.publish(
                "cancel-op",
                (_plan("markdown_write", "notes/n.md", 0, None, b"new"),),
                lease=lease,
                space_id="space-a",
            )
        await canceller
        assert authority.direct_children() == (hashlib.sha256(b"cancel-op").hexdigest(),)
    finally:
        resume.set()
        store.close()
        await lease.release()
        await global_lease.release()


@pytest.mark.asyncio
async def test_collect_cancellation_joins_worker_before_lease_release(tmp_path) -> None:
    entered = threading.Event()
    resume = threading.Event()

    def observer(event: str) -> None:
        if event.startswith("before-orphan-delete:"):
            entered.set()
            assert resume.wait(5)

    authority = _authority(tmp_path)
    store = StageStore(authority, observer=observer)
    global_lease, lease = await _exclusive(tmp_path)
    receipt = lease.fence_receipt("space-a")
    authority.ensure_directory(f".tmp-{'a' * 64}-orphan", receipt)
    owner = asyncio.current_task()
    assert owner is not None

    async def cancel_owner() -> None:
        assert await asyncio.to_thread(entered.wait, 5)
        owner.cancel()
        resume.set()

    canceller = asyncio.create_task(cancel_owner())
    try:
        with pytest.raises(asyncio.CancelledError):
            await store.collect_orphans(
                live_operation_ids=set(), lease=lease, space_id="space-a"
            )
        await canceller
        assert authority.direct_children() == ()
    finally:
        resume.set()
        store.close()
        await lease.release()
        await global_lease.release()


@pytest.mark.asyncio
async def test_stale_fence_before_publish_rename_keeps_stage_invisible(tmp_path) -> None:
    authority = _authority(tmp_path)
    global_lease, lease = await _exclusive(tmp_path)
    receipt = lease.fence_receipt("space-a")

    def observer(event: str) -> None:
        if event == "before-publish-rename":
            receipt.path.write_text(str(receipt.expected + 1), encoding="ascii")

    store = StageStore(authority, observer=observer)
    try:
        from app.runtime.leases import StaleFenceError

        with pytest.raises(StaleFenceError):
            await store.publish(
                "stale-op",
                (_plan("markdown_write", "notes/n.md", 0, None, b"new"),),
                lease=lease,
                space_id="space-a",
            )
        children = authority.direct_children()
        assert len(children) == 1 and children[0].startswith(".tmp-")
    finally:
        store.close()
        await lease.release()
        await global_lease.release()


@pytest.mark.parametrize(
    "boundary",
    [
        "before-namespace-create",
        "before-temp-create",
        "before-before-create",
        "before-after-create",
        "before-before-blob-0-write",
        "before-after-blob-0-write",
        "before-after-blob-1-write",
        "before-manifest-write",
        "before-publish-rename",
    ],
)
@pytest.mark.asyncio
async def test_stale_fence_blocks_every_publish_write_boundary(
    tmp_path, boundary: str
) -> None:
    authority = _authority(tmp_path)
    global_lease, lease = await _exclusive(tmp_path)
    receipt = lease.fence_receipt("space-a")

    def observer(event: str) -> None:
        if event == boundary:
            receipt.path.write_text(str(receipt.expected + 1), encoding="ascii")

    store = StageStore(authority, observer=observer)
    try:
        from app.runtime.leases import StaleFenceError

        with pytest.raises(StaleFenceError):
            await store.publish(
                "all-boundaries",
                (
                    _plan("markdown_write", "notes/n.md", 0, b"old", b"new"),
                    _plan("index_replace", "rows/n.json", 1, None, b"indexed"),
                ),
                lease=lease,
                space_id="space-a",
            )
        assert hashlib.sha256(b"all-boundaries").hexdigest() not in authority.direct_children()
    finally:
        store.close()
        await lease.release()
        await global_lease.release()


@pytest.mark.parametrize(
    "mutation",
    ["missing-steps", "extra-key", "bool-size", "swapped-path", "bad-ordinal", "extra-file"],
)
@pytest.mark.asyncio
async def test_manifest_tamper_matrix_fails_closed(tmp_path, mutation: str) -> None:
    authority = _authority(tmp_path)
    store = StageStore(authority)
    global_lease, lease = await _exclusive(tmp_path)
    try:
        manifest = await store.publish(
            "tamper-op",
            (_plan("markdown_write", "notes/n.md", 0, b"old", b"new"),),
            lease=lease,
            space_id="space-a",
        )
        if mutation == "extra-file":
            authority.write_fsynced(
                f"{manifest.directory_key}/extra.bin",
                b"extra",
                lease.fence_receipt("space-a"),
            )
        else:
            relative = f"{manifest.directory_key}/manifest.json"
            value = json.loads(authority.read_bytes(relative))
            if mutation == "missing-steps":
                del value["steps"]
            elif mutation == "extra-key":
                value["unexpected"] = True
            elif mutation == "bool-size":
                value["steps"][0]["before"]["size"] = True
            elif mutation == "swapped-path":
                value["steps"][0]["before"] = value["steps"][0]["after"]
            else:
                value["steps"][0]["ordinal"] = True
            encoded = json.dumps(
                value, ensure_ascii=True, sort_keys=True, separators=(",", ":")
            ).encode("ascii")
            authority._handle._atomic_write_relative(authority._relative(relative), encoded)
        with pytest.raises(StageIntegrityError):
            store.verify("tamper-op")
    finally:
        store.close()
        await lease.release()
        await global_lease.release()


@pytest.mark.skipif(os.name != "nt", reason="Windows NTSTATUS contract")
@pytest.mark.asyncio
async def test_windows_directory_rename_collision_maps_to_file_exists(
    tmp_path, monkeypatch
) -> None:
    authority = _authority(tmp_path)
    global_lease, lease = await _exclusive(tmp_path)
    receipt = lease.fence_receipt("space-a")
    authority.ensure_directory("source", receipt)
    real = ctypes.windll.ntdll.NtSetInformationFile

    def collision(*_args):
        return ctypes.c_long(0xC0000035).value

    monkeypatch.setattr(ctypes.windll.ntdll, "NtSetInformationFile", collision)
    try:
        with pytest.raises(FileExistsError):
            authority.rename_directory("source", "destination", receipt)
    finally:
        monkeypatch.setattr(ctypes.windll.ntdll, "NtSetInformationFile", real)
        authority.close()
        await lease.release()
        await global_lease.release()


def test_posix_directory_rename_uses_atomic_no_replace(monkeypatch) -> None:
    import app.runtime.contained_io as contained_io_module

    calls: list[tuple[object, ...]] = []

    class RenameAt2:
        argtypes = None
        restype = None

        def __call__(self, *args):
            calls.append(args)
            return -1

    renameat2 = RenameAt2()
    monkeypatch.setattr(
        contained_io_module.ctypes,
        "CDLL",
        lambda *_args, **_kwargs: type("LibC", (), {"renameat2": renameat2})(),
    )
    monkeypatch.setattr(
        contained_io_module.ctypes,
        "get_errno",
        lambda: contained_io_module.errno.EEXIST,
    )

    with pytest.raises(FileExistsError):
        contained_io_module._rename_posix_relative_no_replace(7, "source", "destination")
    assert calls == [(7, b"source", 7, b"destination", 1)]


@pytest.mark.asyncio
async def test_bound_stage_authority_rejects_escape_and_unknown_children(tmp_path) -> None:
    authority = _authority(tmp_path)
    global_lease, lease = await _exclusive(tmp_path)
    try:
        with pytest.raises(PathOutsideSpaceError):
            authority.read_bytes("../escape")
        receipt = lease.fence_receipt("space-a")
        authority.ensure_directory("", receipt)
        authority.write_fsynced("foreign.txt", b"foreign", receipt)
        with pytest.raises(PathOutsideSpaceError):
            authority.direct_children()
    finally:
        authority.close()
        await lease.release()
        await global_lease.release()


@pytest.mark.asyncio
async def test_unknown_child_prevents_all_orphan_deletion(tmp_path) -> None:
    authority = _authority(tmp_path)
    store = StageStore(authority)
    global_lease, lease = await _exclusive(tmp_path)
    receipt = lease.fence_receipt("space-a")
    orphan = f".tmp-{'a' * 64}-orphan"
    try:
        authority.ensure_directory(orphan, receipt)
        authority.ensure_directory("zzz-unknown", receipt)
        with pytest.raises(StageIntegrityError, match="unknown staging child"):
            await store.collect_orphans(
                live_operation_ids=set(), lease=lease, space_id="space-a"
            )
        assert authority.direct_children() == (orphan, "zzz-unknown")
    finally:
        authority.close()
        await lease.release()
        await global_lease.release()


@pytest.mark.parametrize("name", ["..", "../x", "x/y", r"x\y", "x:y"])
@pytest.mark.asyncio
async def test_bound_stage_authority_rejects_non_child_rename_and_remove(
    tmp_path, name: str
) -> None:
    authority = _authority(tmp_path)
    global_lease, lease = await _exclusive(tmp_path)
    receipt = lease.fence_receipt("space-a")
    try:
        with pytest.raises(PathOutsideSpaceError):
            authority.rename_directory(name, "destination", receipt)
        with pytest.raises(PathOutsideSpaceError):
            authority.rename_directory("source", name, receipt)
        with pytest.raises(PathOutsideSpaceError):
            authority.remove_tree(name, receipt)
    finally:
        authority.close()
        await lease.release()
        await global_lease.release()


@pytest.mark.parametrize("fail_at", range(1, 6))
@pytest.mark.asyncio
async def test_recursive_orphan_delete_checks_fence_at_every_boundary(
    tmp_path, fail_at: int
) -> None:
    authority = _authority(tmp_path)
    global_lease, lease = await _exclusive(tmp_path)
    receipt = lease.fence_receipt("space-a")
    orphan = f".tmp-{'a' * 64}-orphan"

    class BoundaryFence:
        def __init__(self) -> None:
            self.calls = 0

        def assert_current(self) -> None:
            self.calls += 1
            if self.calls == fail_at:
                raise RuntimeError("stale boundary")

    try:
        authority.ensure_directory(f"{orphan}/nested", receipt)
        authority.write_fsynced(f"{orphan}/nested/nested.bin", b"nested", receipt)
        authority.write_fsynced(f"{orphan}/root.bin", b"root", receipt)
        fence = BoundaryFence()
        with pytest.raises(RuntimeError, match="stale boundary"):
            authority.remove_tree(orphan, fence)
        assert fence.calls == fail_at
        assert orphan in authority.direct_children()
    finally:
        authority.close()
        await lease.release()
        await global_lease.release()


@pytest.mark.skipif(os.name == "nt", reason="POSIX symlink contract")
@pytest.mark.asyncio
async def test_orphan_collection_rejects_symlink_without_deleting_target(tmp_path) -> None:
    authority = _authority(tmp_path)
    store = StageStore(authority)
    global_lease, lease = await _exclusive(tmp_path)
    receipt = lease.fence_receipt("space-a")
    orphan = f".tmp-{'a' * 64}-orphan"
    target = tmp_path / "outside.txt"
    target.write_text("retained", encoding="utf-8")
    try:
        authority.ensure_directory(orphan, receipt)
        os.symlink(target, tmp_path / ".mutations" / orphan / "link")
        with pytest.raises(PathOutsideSpaceError):
            await store.collect_orphans(
                live_operation_ids=set(), lease=lease, space_id="space-a"
            )
        assert target.read_text(encoding="utf-8") == "retained"
    finally:
        store.close()
        await lease.release()
        await global_lease.release()
