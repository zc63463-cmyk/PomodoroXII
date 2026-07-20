"""Durable projection staging over an opaque contained authority."""

from __future__ import annotations

import hashlib
import json
import re
import secrets
from dataclasses import dataclass
from typing import Callable, Literal

from app.mutation.types import (
    ContainedProjectionActionField,
    MaterializedProjectionAction,
    PersistedProjectionDescriptor,
    ProjectionActionTag,
    ProjectionPlan,
    validate_projection_ordinals,
)
from app.runtime.contained_io import BoundStageDirectory
from app.runtime.joined_thread import run_joined_thread
from app.runtime.leases import Lease, LeaseMode, LeaseOrderError

_KEY = r"[0-9a-f]{64}"
_PUBLISHED = re.compile(rf"{_KEY}")
_TEMP = re.compile(rf"\.tmp-({_KEY})-([0-9a-z]+)")


class UnsafeProjectionPathError(ValueError):
    pass


class StageIntegrityError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class StagedStep:
    descriptor: PersistedProjectionDescriptor


@dataclass(frozen=True, slots=True)
class StageManifest:
    operation_id: str
    directory_key: str
    steps: tuple[StagedStep, ...]
    manifest_sha256: str


def _image(value: bytes | None, relative_name: str) -> dict[str, object] | None:
    if value is None:
        return None
    return {
        "path": relative_name,
        "sha256": hashlib.sha256(value).hexdigest(),
        "size": len(value),
    }


def _canonical(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode(
        "ascii"
    )


def _require_keys(value: object, expected: set[str], *, label: str) -> dict:
    if not isinstance(value, dict) or set(value) != expected:
        raise StageIntegrityError(f"{label} has an invalid shape")
    return value


class StageStore:
    def __init__(
        self,
        authority: BoundStageDirectory,
        *,
        observer: Callable[[str], None] | None = None,
    ) -> None:
        if not isinstance(authority, BoundStageDirectory):
            raise TypeError("StageStore requires BoundStageDirectory")
        self._authority = authority
        self._observer = observer or (lambda _event: None)

    @staticmethod
    def validate_target(target: str) -> str:
        if (
            not isinstance(target, str)
            or not target
            or target.startswith("/")
            or "\\" in target
            or ":" in target
            or any(part in {"", ".", ".."} for part in target.split("/"))
        ):
            raise UnsafeProjectionPathError("projection target is not contained")
        return target

    @staticmethod
    def _contained(value: object) -> ContainedProjectionActionField:
        return ContainedProjectionActionField(value)  # type: ignore[arg-type]

    @staticmethod
    def directory_key(operation_id: str) -> str:
        return hashlib.sha256(operation_id.encode("utf-8")).hexdigest()

    @staticmethod
    def _require_space_exclusive(lease: Lease | None, space_id: str):
        if lease is None:
            raise LeaseOrderError("staging requires a Space-exclusive lease")
        lease.assert_active_owner(mode=LeaseMode.EXCLUSIVE, scope=space_id)
        return lease.fence_receipt(space_id)

    def _manifest_value(
        self, operation_id: str, plans: tuple[ProjectionPlan, ...]
    ) -> dict[str, object]:
        validate_projection_ordinals(plans)
        key = self.directory_key(operation_id)
        steps: list[dict[str, object]] = []
        for plan in plans:
            target = self.validate_target(str(plan.target))
            steps.append(
                {
                    "after": _image(plan.after, f"after/{plan.ordinal}.bin"),
                    "before": _image(plan.before, f"before/{plan.ordinal}.bin"),
                    "ordinal": plan.ordinal,
                    "source": None if plan.source is None else str(plan.source),
                    "tag": plan.tag.value,
                    "target": target,
                }
            )
        return {"directoryKey": key, "operationId": operation_id, "steps": steps}

    async def publish(
        self,
        operation_id: str,
        plans: tuple[ProjectionPlan, ...],
        *,
        lease: Lease,
        space_id: str,
    ) -> StageManifest:
        receipt = self._require_space_exclusive(lease, space_id)
        frozen_plans = tuple(plans)
        return await run_joined_thread(
            lambda: self._publish_sync(operation_id, frozen_plans, receipt)
        )

    def _publish_sync(self, operation_id: str, plans: tuple[ProjectionPlan, ...], receipt):
        value = self._manifest_value(operation_id, plans)
        key = str(value["directoryKey"])
        manifest_bytes = _canonical(value)
        expected_hash = hashlib.sha256(manifest_bytes).hexdigest()
        if self._authority.exists(key):
            existing = self.verify(operation_id)
            if existing.manifest_sha256 != expected_hash:
                raise StageIntegrityError("operation stage already has different content")
            return existing

        temporary = f".tmp-{key}-{secrets.token_hex(8)}"
        self._observer("before-namespace-create")
        self._authority.ensure_directory("", receipt)
        self._authority.fsync_namespace_parent(receipt)
        self._observer("fsync-namespace-parent")
        self._observer("before-temp-create")
        self._authority.ensure_directory(temporary, receipt)
        self._observer("before-before-create")
        self._authority.ensure_directory(f"{temporary}/before", receipt)
        self._observer("before-after-create")
        self._authority.ensure_directory(f"{temporary}/after", receipt)
        for plan in plans:
            for side, image in (("before", plan.before), ("after", plan.after)):
                if image is not None:
                    self._observer(f"before-{side}-blob-{plan.ordinal}-write")
                    self._authority.write_fsynced(
                        f"{temporary}/{side}/{plan.ordinal}.bin", image, receipt
                    )
        self._authority.fsync_directory(f"{temporary}/before")
        self._observer("fsync-before-directory")
        self._authority.fsync_directory(f"{temporary}/after")
        self._observer("fsync-after-directory")
        self._observer("before-manifest-write")
        self._authority.write_fsynced(f"{temporary}/manifest.json", manifest_bytes, receipt)
        self._authority.fsync_directory(temporary)
        self._observer("fsync-temp-directory")
        try:
            self._observer("before-publish-rename")
            self._authority.rename_directory(temporary, key, receipt)
        except FileExistsError:
            self._authority.remove_tree(temporary, receipt)
            existing = self.verify(operation_id)
            if existing.manifest_sha256 != expected_hash:
                raise StageIntegrityError("racing stage has different content")
            return existing
        self._observer("rename-published-directory")
        self._authority.fsync_directory("")
        self._observer("fsync-parent-directory")
        return self.verify(operation_id)

    def verify(self, operation_id: str) -> StageManifest:
        key = self.directory_key(operation_id)
        try:
            encoded = self._authority.read_bytes(f"{key}/manifest.json")
            value = json.loads(encoded)
        except (FileNotFoundError, json.JSONDecodeError) as exc:
            raise StageIntegrityError("stage manifest is missing or invalid") from exc
        if _canonical(value) != encoded:
            raise StageIntegrityError("stage manifest is not canonical")
        value = _require_keys(value, {"directoryKey", "operationId", "steps"}, label="manifest")
        if (
            not isinstance(value["operationId"], str)
            or not isinstance(value["directoryKey"], str)
            or value["operationId"] != operation_id
            or value["directoryKey"] != key
        ):
            raise StageIntegrityError("stage identity mismatch")
        if not isinstance(value["steps"], list):
            raise StageIntegrityError("manifest steps must be an array")
        descriptors: list[StagedStep] = []
        for expected_ordinal, raw_item in enumerate(value["steps"]):
            item = _require_keys(
                raw_item,
                {"after", "before", "ordinal", "source", "tag", "target"},
                label="manifest step",
            )
            if type(item["ordinal"]) is not int or item["ordinal"] != expected_ordinal:
                raise StageIntegrityError("manifest ordinals must be contiguous")
            try:
                tag = ProjectionActionTag(item["tag"])
                source = None if item["source"] is None else type(self)._contained(item["source"])
                target = type(self)._contained(item["target"])
            except (TypeError, ValueError) as exc:
                raise StageIntegrityError("manifest projection action is invalid") from exc
            images: dict[str, tuple[str | None, int | None]] = {}
            for side in ("before", "after"):
                image = item[side]
                if image is None:
                    images[side] = (None, None)
                    continue
                image = _require_keys(image, {"path", "sha256", "size"}, label=f"{side} image")
                expected_path = f"{side}/{expected_ordinal}.bin"
                if image["path"] != expected_path:
                    raise StageIntegrityError("staged image path is not canonical")
                if (
                    not isinstance(image["sha256"], str)
                    or re.fullmatch(_KEY, image["sha256"]) is None
                    or type(image["size"]) is not int
                    or image["size"] < 0
                ):
                    raise StageIntegrityError("staged image descriptor is invalid")
                content = self._authority.read_bytes(f"{key}/{expected_path}")
                digest = hashlib.sha256(content).hexdigest()
                if digest != image["sha256"] or len(content) != image["size"]:
                    raise StageIntegrityError("staged image hash or size mismatch")
                images[side] = (digest, len(content))
            descriptors.append(
                StagedStep(
                    PersistedProjectionDescriptor(
                        tag,
                        source,
                        target,
                        item["ordinal"],
                        *images["before"],
                        *images["after"],
                    )
                )
            )
        expected_files = {"manifest.json"}
        for step in value["steps"]:
            for side in ("before", "after"):
                if step[side] is not None:
                    expected_files.add(step[side]["path"])
        if set(self._authority.relative_files(key)) != expected_files:
            raise StageIntegrityError("stage contains unreferenced or missing files")
        return StageManifest(
            operation_id,
            key,
            tuple(descriptors),
            hashlib.sha256(encoded).hexdigest(),
        )

    async def materialize(
        self,
        operation_id: str,
        descriptors: tuple[PersistedProjectionDescriptor, ...],
        *,
        image: Literal["before", "after"],
        receipt,
    ) -> tuple[MaterializedProjectionAction, ...]:
        if image not in ("before", "after"):
            raise ValueError("image must be before or after")
        return await run_joined_thread(
            lambda: self._materialize_sync(operation_id, tuple(descriptors), image, receipt)
        )

    def _materialize_sync(
        self,
        operation_id: str,
        descriptors: tuple[PersistedProjectionDescriptor, ...],
        image: Literal["before", "after"],
        receipt,
    ) -> tuple[MaterializedProjectionAction, ...]:
        receipt.assert_current()
        manifest = self.verify(operation_id)
        expected = tuple(step.descriptor for step in manifest.steps)
        if descriptors != expected:
            raise StageIntegrityError("staged descriptors do not exactly match manifest")
        actions: list[MaterializedProjectionAction] = []
        for descriptor in descriptors:
            digest = getattr(descriptor, f"{image}_sha256")
            size = getattr(descriptor, f"{image}_size")
            blob = None
            if digest is not None:
                blob = self._authority.read_bytes(
                    f"{manifest.directory_key}/{image}/{descriptor.ordinal}.bin"
                )
                if hashlib.sha256(blob).hexdigest() != digest or len(blob) != size:
                    raise StageIntegrityError("staged image hash or size mismatch")
            tag = descriptor.tag
            source = descriptor.source
            target = descriptor.target
            if image == "before":
                if tag is ProjectionActionTag.PATH_RENAME:
                    source, target = target, source
                elif tag is ProjectionActionTag.PATH_REMOVE:
                    tag = ProjectionActionTag.MARKDOWN_WRITE
                elif tag is ProjectionActionTag.MARKDOWN_WRITE and blob is None:
                    tag = ProjectionActionTag.PATH_REMOVE
            actions.append(MaterializedProjectionAction(tag, source, target, descriptor.ordinal, blob))
        return tuple(actions)

    async def collect_orphans(
        self,
        *,
        live_operation_ids: set[str],
        lease: Lease | None,
        space_id: str,
    ) -> tuple[str, ...]:
        receipt = self._require_space_exclusive(lease, space_id)
        live = frozenset(live_operation_ids)
        return await run_joined_thread(lambda: self._collect_sync(live, receipt))

    def _collect_sync(self, live_operation_ids: frozenset[str], receipt) -> tuple[str, ...]:
        live_keys = {self.directory_key(item) for item in live_operation_ids}
        candidates: list[str] = []
        for name in self._authority.direct_children():
            temp = _TEMP.fullmatch(name)
            if temp is not None:
                if temp.group(1) in live_keys:
                    continue
            elif _PUBLISHED.fullmatch(name) is not None:
                encoded = self._authority.read_bytes(f"{name}/manifest.json")
                try:
                    operation_id = json.loads(encoded)["operationId"]
                except (json.JSONDecodeError, KeyError, TypeError) as exc:
                    raise StageIntegrityError("orphan manifest is invalid") from exc
                if operation_id in live_operation_ids:
                    continue
                if self.directory_key(operation_id) != name:
                    raise StageIntegrityError("orphan manifest identity mismatch")
                self.verify(operation_id)
            else:
                raise StageIntegrityError("unknown staging child")
            candidates.append(name)
        removed: list[str] = []
        for name in candidates:
            self._observer(f"before-orphan-delete:{name}")
            self._authority.remove_tree(name, receipt)
            removed.append(name)
        return tuple(sorted(removed))

    def close(self) -> None:
        self._authority.close()
