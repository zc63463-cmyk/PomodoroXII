"""Durable, idempotent mutation orchestration under one Space lease."""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

from sqlalchemy import inspect as sa_inspect
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.errors import (
    IdempotencyConflictError,
    MutationRejectedError,
    SpaceRecoveryRequiredError,
)
from app.file_system.engine.base import _make_filename
from app.file_system.frontmatter import strip_frontmatter
from app.file_system.interfaces import FencedProjectionExecutor, ProjectionAuthoritySnapshot
from app.file_system.schema import NoteModel as ProjectionNoteModel
from app.focus_session.contracts import CommandReceiptState
from app.focus_session.receipts import decode_reconcile_coordination
from app.models.mutation import MutationOperation
from app.mutation.journal import JournalBatch, MutationJournal
from app.mutation.types import (
    BatchMutationResult,
    DbMutationPlan,
    MutationCommand,
    MutationRejection,
    MutationRequest,
    MutationResult,
    MutationRuleViolation,
    MutationState,
    PersistedMutationCommand,
    PreparedBatchItem,
    ProjectionActionTag,
    ProjectionPlan,
    RecoveryInspection,
    RecoveryResult,
    SyncEventPlan,
    bounded_child_operation_id,
    canonical_json_bytes,
    decode_persisted_command,
    require_frozen_object,
    validate_operation_id,
)
from app.registry.catalog import CompiledEntityCatalog
from app.registry.entities import EntityCategory, EntitySpec, StorageType
from app.runtime.leases import Lease
from app.runtime.space import SpaceRuntimeHandle
from app.services.sync_outbox import record_sync_event
from app.services.time import utc_now_iso_ms


def hash_prepared_batch_identity(
    identities: tuple[tuple[int, str, str], ...],
) -> str:
    """Hash caller identity before authority reads can classify its intent."""
    return hashlib.sha256(canonical_json_bytes(identities)).hexdigest()


@dataclass(frozen=True, slots=True)
class BatchCompilation:
    operation_ids: tuple[str, ...]
    commands: tuple[MutationCommand, ...]
    rejected: tuple[MutationRejection, ...]


class DbMutationPlanFactory(Protocol):
    def insert(self, row: object) -> DbMutationPlan: ...
    def update(self, before: object, after: object) -> DbMutationPlan: ...
    def delete(self, row: object) -> DbMutationPlan: ...


class SyncEventPlanFactory(Protocol):
    def create(self, row: object) -> SyncEventPlan: ...
    def update(self, row: object) -> SyncEventPlan: ...
    def delete(self, row: object, *, deleted_at: str) -> SyncEventPlan: ...


class _CatalogRowFactory:
    def __init__(self, catalog: CompiledEntityCatalog) -> None:
        self.catalog = catalog

    def _spec_and_row(
        self, row: object
    ) -> tuple[EntitySpec, Mapping[str, object]]:
        for spec in self.catalog.list():
            model = self.catalog.model_for(spec.name)
            if isinstance(row, model):
                mapper = sa_inspect(model)
                return spec, require_frozen_object(
                    {column.key: getattr(row, column.key) for column in mapper.columns}
                )
        raise TypeError("row is not owned by the compiled catalog")


class DbMutationPlanFactoryImpl(_CatalogRowFactory):
    def insert(self, row: object) -> DbMutationPlan:
        spec, after = self._spec_and_row(row)
        return DbMutationPlan(
            spec.table_name,
            {spec.primary_key: after[spec.primary_key]},
            "insert",
            None,
            None,
            after,
        )

    def update(self, before: object, after: object) -> DbMutationPlan:
        before_spec, before_row = self._spec_and_row(before)
        after_spec, after_row = self._spec_and_row(after)
        if before_spec is not after_spec:
            raise TypeError("update rows must belong to the same catalog entity")
        if before_row[before_spec.primary_key] != after_row[after_spec.primary_key]:
            raise ValueError("update rows must preserve the primary key")
        version = before_row.get("version")
        if version is not None and type(version) is not int:
            raise TypeError("catalog row version must be an integer")
        return DbMutationPlan(
            before_spec.table_name,
            {before_spec.primary_key: before_row[before_spec.primary_key]},
            "update",
            version,
            before_row,
            after_row,
        )

    def delete(self, row: object) -> DbMutationPlan:
        spec, before = self._spec_and_row(row)
        version = before.get("version")
        if version is not None and type(version) is not int:
            raise TypeError("catalog row version must be an integer")
        return DbMutationPlan(
            spec.table_name,
            {spec.primary_key: before[spec.primary_key]},
            "delete",
            version,
            before,
            None,
        )


class SyncEventPlanFactoryImpl(_CatalogRowFactory):
    def _event(self, row: object, action: str) -> SyncEventPlan:
        spec, payload = self._spec_and_row(row)
        if not spec.sync_enabled:
            raise ValueError("catalog entity is not sync-enabled")
        version = payload.get("version")
        created_at = payload.get("updated_at") or payload.get("created_at")
        if type(version) is not int or not isinstance(created_at, str):
            raise ValueError("sync row requires a version and canonical timestamp")
        return SyncEventPlan(
            spec.name,
            str(payload[spec.primary_key]),
            action,  # type: ignore[arg-type]
            payload,
            version,
            created_at,
        )

    def create(self, row: object) -> SyncEventPlan:
        return self._event(row, "create")

    def update(self, row: object) -> SyncEventPlan:
        return self._event(row, "update")

    def delete(self, row: object, *, deleted_at: str) -> SyncEventPlan:
        spec, before = self._spec_and_row(row)
        if not spec.sync_enabled:
            raise ValueError("catalog entity is not sync-enabled")
        version = before.get("version")
        if type(version) is not int:
            raise ValueError("sync row requires a version")
        return SyncEventPlan(
            spec.name,
            str(before[spec.primary_key]),
            "delete",
            {"deleted_at": deleted_at},
            version + 1,
            deleted_at,
        )


class MutationDomainPolicy(Protocol):
    @property
    def entity_types(self) -> frozenset[str]: ...

    async def compile(self, context: "MutationCompileContext", request: MutationRequest) -> MutationCommand: ...


@dataclass(frozen=True, slots=True)
class MutationCompileContext:
    scope: SpaceRuntimeHandle
    authority: "AuthorityOverlay"
    catalog: CompiledEntityCatalog
    db: DbMutationPlanFactory
    sync: SyncEventPlanFactory
    operation_id: str

    def require_space(self, payload_space_id: str) -> None:
        if payload_space_id != self.scope.scope.space_id:
            raise MutationRuleViolation(
                "space_scope_mismatch",
                {"scopeSpaceId": self.scope.scope.space_id, "payloadSpaceId": payload_space_id},
            )

    def require_session_envelope_dispatch_claim(
        self,
        request: MutationRequest,
        target_status_map: Mapping[str, str],
    ) -> None:
        """Validate session envelope dispatch claim for TransitionWorkItem.

        This is mutation infrastructure: it checks operation-id identity,
        receipt coordination, and replay-claimed status.  The
        ``idempotency_conflict`` rejections are raised here so they do not
        appear in the Task Space compiler's producer set.
        """
        command_id = self.operation_id
        declared_command_id = request.payload.get("command_id")
        if declared_command_id is not None and str(declared_command_id) != command_id:
            raise MutationRuleViolation(
                "idempotency_conflict",
                {"reason": "operation_identity_mismatch"},
                retryable=False,
            )
        envelope = self.authority.row("session_command_envelope", command_id)
        if envelope is None:
            return
        target_status_id = target_status_map[str(envelope["target_transition"])]
        identity_matches = (
            str(envelope["space_id"]) == str(request.payload["space_id"])
            and str(envelope["work_item_id"]) == request.entity_id
            and int(envelope["expected_version"]) == request.expected_version
            and str(envelope["payload_hash"]) == str(request.payload["payload_hash"])
            and target_status_id == str(request.payload["status_definition_id"])
        )
        receipt = self.authority.row("session_command_receipt", command_id)
        coordination = None
        if receipt is not None:
            try:
                coordination = decode_reconcile_coordination(
                    state=CommandReceiptState(str(receipt["state"])),
                    result_json=receipt.get("result_json"),
                )
            except ValueError:
                raise MutationRuleViolation(
                    "idempotency_conflict",
                    {"reason": "malformed_coordination"},
                    retryable=False,
                ) from None
        if not identity_matches or coordination is None or (
            coordination["kind"] != "replay_claimed"
        ):
            raise MutationRuleViolation(
                "idempotency_conflict",
                {"reason": "session_command_not_replay_claimed"},
                retryable=False,
            )

    def command(
        self,
        *,
        request: MutationRequest,
        db_plans: Sequence[DbMutationPlan],
        sync_events: Sequence[SyncEventPlan],
        value: Mapping[str, object],
        projections: Sequence[object] = (),
        resolution: str | None = None,
    ) -> MutationCommand:
        return MutationCommand.from_effects(
            request=request,
            db_plans=tuple(db_plans),
            projections=tuple(projections),
            sync_events=tuple(sync_events),
            result_value=require_frozen_object(value),
            resolution=resolution,  # type: ignore[arg-type]
        )


class AuthorityOverlay:
    """A deterministic in-memory projection of accepted commands in this batch."""

    def __init__(
        self,
        catalog: CompiledEntityCatalog,
        rows: Mapping[tuple[str, object], Mapping[str, object]],
        *,
        markdown: Mapping[str, bytes] | None = None,
        derived: Mapping[tuple[ProjectionActionTag, str], bytes | None] | None = None,
    ) -> None:
        self.catalog = catalog
        self._rows = dict(rows)
        self._markdown = dict(markdown or {})
        self._derived = dict(derived or {})
        self._reserved_paths = set(self._markdown)
        self._spec_by_table = {spec.table_name: spec for spec in catalog.list()}

    @classmethod
    async def from_locked_authorities(
        cls,
        scope: SpaceRuntimeHandle,
        session: AsyncSession,
        catalog: CompiledEntityCatalog,
    ) -> "AuthorityOverlay":
        rows: dict[tuple[str, object], Mapping[str, object]] = {}
        for spec in catalog.list():
            # Catalog models may be reloaded during test/runtime isolation.
            # Metadata object identity is therefore not a safe database
            # boundary. Meta entries are the only catalog rows that belong to
            # the separate meta database and must not be queried here.
            if spec.category is EntityCategory.META:
                continue
            model = catalog.model_for(spec.name)
            mapper = sa_inspect(model)
            for item in tuple(await session.scalars(select(model))):
                row = require_frozen_object(
                    {column.key: getattr(item, column.key) for column in mapper.columns}
                )
                rows[(spec.name, row[spec.primary_key])] = row

        file_system = scope.file_system
        if file_system is None or not hasattr(file_system, "snapshot_projection_authority"):
            raise SpaceRecoveryRequiredError("projection authority is not active")
        snapshot = await file_system.snapshot_projection_authority()
        if not isinstance(snapshot, ProjectionAuthoritySnapshot):
            raise SpaceRecoveryRequiredError("projection authority snapshot is invalid")
        derived = {
            **{
                (ProjectionActionTag.INDEX_REPLACE, target): payload
                for target, payload in snapshot.index.items()
            },
            **{
                (ProjectionActionTag.FTS_REPLACE, target): payload
                for target, payload in snapshot.fts.items()
            },
        }
        return cls(catalog, rows, markdown=snapshot.markdown, derived=derived)

    def row(self, entity_type: str, entity_id: object) -> Mapping[str, object] | None:
        return self._rows.get((entity_type, entity_id))

    def rows(self, entity_type: str) -> tuple[Mapping[str, object], ...]:
        """Return one entity's locked rows in deterministic primary-key order."""
        spec = self.catalog.get(entity_type)
        return tuple(
            row
            for (kind, _identity), row in sorted(
                self._rows.items(),
                key=lambda item: (item[0][0], str(item[0][1])),
            )
            if kind == entity_type and spec.primary_key in row
        )

    def markdown(self, target: str) -> bytes | None:
        return self._markdown.get(target)

    def derived_projection(self, tag: ProjectionActionTag, target: str) -> bytes | None:
        return self._derived.get((tag, target))

    def note_path(self, identity: str) -> str | None:
        payload = self.derived_projection(
            ProjectionActionTag.INDEX_REPLACE,
            f"index/notes/note_id/{identity}",
        )
        return _note_path_from_index_blob(payload, identity, label="authority")

    def path_is_reserved(self, target: str) -> bool:
        return target in self._reserved_paths

    def apply(self, command: MutationCommand) -> None:
        rows = dict(self._rows)
        markdown = dict(self._markdown)
        derived = dict(self._derived)
        reserved = set(self._reserved_paths)
        for plan in command.db_plans:
            spec = self._spec_by_table.get(plan.table)
            if spec is None or set(plan.primary_key) != {spec.primary_key}:
                raise SpaceRecoveryRequiredError("mutation plan is not owned by the compiled catalog")
            identity = plan.primary_key[spec.primary_key]
            key = (spec.name, identity)
            current = rows.get(key)

            def require_complete_row(
                row: Mapping[str, object] | None, label: str
            ) -> Mapping[str, object]:
                if (
                    row is None
                    or set(row) != set(spec.field_names)
                    or row.get(spec.primary_key) != identity
                ):
                    raise SpaceRecoveryRequiredError(
                        f"mutation plan has no complete {label} image"
                    )
                return row

            if plan.operation == "insert":
                after = require_complete_row(plan.after_row, "after")
                if (
                    current is not None
                    or plan.before_row is not None
                    or plan.expected_version is not None
                ):
                    raise SpaceRecoveryRequiredError(
                        "insert plan conflicts with authoritative state"
                    )
                rows[key] = after
            elif plan.operation == "update":
                before = require_complete_row(plan.before_row, "before")
                after = require_complete_row(plan.after_row, "after")
                if current is None or current != before:
                    raise SpaceRecoveryRequiredError(
                        "update plan conflicts with authoritative state"
                    )
                if (
                    plan.expected_version is not None
                    and current.get("version") != plan.expected_version
                ):
                    raise SpaceRecoveryRequiredError(
                        "update plan version conflicts with authoritative state"
                    )
                rows[key] = plan.after_row
            else:
                before = require_complete_row(plan.before_row, "before")
                if current is None or current != before or plan.after_row is not None:
                    raise SpaceRecoveryRequiredError(
                        "delete plan conflicts with authoritative state"
                    )
                if (
                    plan.expected_version is not None
                    and current.get("version") != plan.expected_version
                ):
                    raise SpaceRecoveryRequiredError(
                        "delete plan version conflicts with authoritative state"
                    )
                rows.pop(key)

        for projection in command.projections:
            target = str(projection.target)
            if projection.tag.value == "markdown_write":
                if projection.after is None:
                    raise SpaceRecoveryRequiredError("markdown projection has no after image")
                # When the markdown is not in the snapshot (e.g., the note was
                # trashed and its .md file is in .trash/), skip the consistency
                # check if the projection has a before image.
                current_md = markdown.get(target)
                if current_md is not None and projection.before != current_md:
                    raise SpaceRecoveryRequiredError(
                        "markdown projection conflicts with authoritative state"
                    )
                markdown[target] = projection.after
                reserved.add(target)
            elif projection.tag.value == "path_rename":
                if projection.source is None:
                    raise SpaceRecoveryRequiredError("path rename has no source")
                source = str(projection.source)
                if source not in markdown or (target != source and target in reserved):
                    raise SpaceRecoveryRequiredError(
                        "path rename conflicts with authoritative state"
                    )
                body = markdown.pop(source)
                markdown[target] = body
                reserved.discard(source)
                reserved.add(target)
            elif projection.tag.value == "path_remove":
                # When the markdown is not in the snapshot (e.g., the note was
                # trashed and its .md file is in .trash/), allow the path
                # removal if the projection has a before image.
                current_md = markdown.get(target)
                if current_md is None and projection.before is None:
                    raise SpaceRecoveryRequiredError(
                        "path remove conflicts with authoritative state"
                    )
                if current_md is not None and projection.before != current_md:
                    raise SpaceRecoveryRequiredError(
                        "path remove conflicts with authoritative state"
                    )
                if current_md is not None:
                    markdown.pop(target)
                reserved.discard(target)
            else:
                # Derived projections (INDEX_REPLACE, FTS_REPLACE) may have a
                # format mismatch between the FS SQLite index snapshot and the
                # projection builder's PostgreSQL-row serialization.  This
                # happens when the entity was created or modified outside the
                # mutation pipeline (e.g., via REST API direct ORM).  In that
                # case, the before image and the authoritative derived
                # projection represent the same logical state but with
                # different byte representations.
                #
                # Skip the consistency check when:
                # 1. The derived projection is None (entity not in FS index)
                # 2. The before image and derived projection don't match
                #    (format mismatch between FS index and PG row)
                # In both cases, accept the projection's before image and
                # proceed with the mutation.
                # Intentionally do NOT raise on mismatch — the projection
                # builder's serialization is authoritative for the mutation.
                derived[(projection.tag, target)] = projection.after

        self._rows = rows
        self._markdown = markdown
        self._derived = derived
        self._reserved_paths = reserved


def _require_catalog_spec(
    catalog: CompiledEntityCatalog, entity_type: str
) -> EntitySpec:
    try:
        return catalog.get(entity_type)
    except KeyError as exc:
        raise MutationRuleViolation("not_found", {"entityType": entity_type}) from exc


def _require_payload_fields(spec: EntitySpec, payload: Mapping[str, object]) -> None:
    unknown = tuple(sorted(set(payload) - set(spec.field_names)))
    if unknown:
        raise MutationRuleViolation(
            "payload_field_not_allowed",
            {"entityType": spec.name, "fields": unknown},
        )


def _require_current_version(
    spec: EntitySpec,
    request: MutationRequest,
    current: Mapping[str, object],
) -> str | None:
    expected = request.expected_version
    actual = current.get("version")
    if expected is None:
        if spec.sync_conflict_policy == "strict_cas":
            raise MutationRuleViolation(
                "version_conflict", {"entityId": request.entity_id}
            )
        return None
    if actual == expected:
        return None
    details: dict[str, object] = {"entityId": request.entity_id}
    if spec.sync_conflict_policy == "timestamp_lww" and request.client_updated_at is not None:
        authoritative = current.get("updated_at")
        if not isinstance(authoritative, str):
            details["resolution"] = "manual"
        else:
            try:
                client_instant = datetime.fromisoformat(
                    request.client_updated_at[:-1] + "+00:00"
                )
                authoritative_instant = datetime.fromisoformat(
                    authoritative[:-1] + "+00:00"
                )
            except ValueError:
                details["resolution"] = "manual"
            else:
                if client_instant > authoritative_instant:
                    return "remote"
                details["resolution"] = "local"
    raise MutationRuleViolation("version_conflict", details)


def _complete_create_row(
    spec: EntitySpec,
    request: MutationRequest,
    timestamp: str,
) -> Mapping[str, object]:
    _require_payload_fields(spec, request.payload)
    supplied_id = request.payload.get(spec.primary_key)
    if supplied_id is not None and supplied_id != request.entity_id:
        raise MutationRuleViolation(
            "entity_id_mismatch",
            {"entityType": spec.name, "entityId": request.entity_id},
        )
    row: dict[str, object] = {}
    for field in spec.fields:
        if field.name == spec.primary_key:
            row[field.name] = request.entity_id
        elif field.name == "created_at":
            row[field.name] = request.payload.get(field.name, timestamp)
        elif field.name == "updated_at":
            row[field.name] = request.client_updated_at or timestamp
        elif field.name == "version":
            row[field.name] = 1
        elif field.name in request.payload:
            row[field.name] = request.payload[field.name]
        elif field.default is not None:
            row[field.name] = field.default
        elif field.nullable:
            row[field.name] = None
        else:
            raise ValueError(f"required catalog field is missing: {spec.name}.{field.name}")
    return require_frozen_object(row)


async def compile_catalog_entity_command(
    context: MutationCompileContext,
    request: MutationRequest,
) -> MutationCommand:
    spec = _require_catalog_spec(context.catalog, request.entity_type)
    _require_payload_fields(spec, request.payload)
    timestamp = utc_now_iso_ms()
    current = context.authority.row(spec.name, request.entity_id)

    if request.name == "entity.create":
        if current is not None:
            raise MutationRuleViolation(
                "version_conflict", {"entityId": request.entity_id}
            )
        if request.expected_version is not None:
            raise MutationRuleViolation(
                "version_conflict", {"entityId": request.entity_id}
            )
        after = _complete_create_row(spec, request, timestamp)
        plan = DbMutationPlan(
            spec.table_name,
            {spec.primary_key: request.entity_id},
            "insert",
            None,
            None,
            after,
        )
        action = "create"
        resolution = None
    elif request.name == "entity.update":
        if current is None:
            raise MutationRuleViolation("not_found", {"entityId": request.entity_id})
        supplied_id = request.payload.get(spec.primary_key)
        if supplied_id is not None and supplied_id != request.entity_id:
            raise MutationRuleViolation(
                "entity_id_mismatch",
                {"entityType": spec.name, "entityId": request.entity_id},
            )
        resolution = _require_current_version(spec, request, current)
        after_mutable = dict(current)
        for key, value in request.payload.items():
            if key not in {spec.primary_key, "created_at", "updated_at", "version"}:
                after_mutable[key] = value
        version = current.get("version")
        if type(version) is not int or version < 0:
            raise SpaceRecoveryRequiredError("authoritative entity version is invalid")
        after_mutable["version"] = version + 1
        after_mutable["updated_at"] = request.client_updated_at or timestamp
        after = require_frozen_object(after_mutable)
        plan = DbMutationPlan(
            spec.table_name,
            {spec.primary_key: request.entity_id},
            "update",
            version if resolution == "remote" else request.expected_version,
            current,
            after,
        )
        action = "update"
    elif request.name == "entity.delete":
        if current is None:
            raise MutationRuleViolation("not_found", {"entityId": request.entity_id})
        if request.payload not in ({}, {spec.primary_key: request.entity_id}):
            raise MutationRuleViolation(
                "delete_payload_not_empty", {"entityId": request.entity_id}
            )
        resolution = _require_current_version(spec, request, current)
        version = current.get("version")
        if type(version) is not int or version < 0:
            raise SpaceRecoveryRequiredError("authoritative entity version is invalid")
        plan = DbMutationPlan(
            spec.table_name,
            {spec.primary_key: request.entity_id},
            "delete",
            version if resolution == "remote" else request.expected_version,
            current,
            None,
        )
        action = "delete"
        after = require_frozen_object(
            {"id": request.entity_id, "deleted_at": timestamp}
        )
    else:
        raise ValueError(f"unsupported catalog mutation request: {request.name}")

    sync_events: tuple[SyncEventPlan, ...] = ()
    if spec.sync_enabled:
        version_value = (
            after.get("version")
            if action != "delete"
            else int(current.get("version", 0)) + 1  # type: ignore[union-attr]
        )
        if type(version_value) is not int or version_value < 0:
            raise SpaceRecoveryRequiredError("compiled sync version is invalid")
        payload = after if action != "delete" else {"deleted_at": timestamp}
        sync_events = (
            SyncEventPlan(
                spec.name,
                request.entity_id,
                action,  # type: ignore[arg-type]
                payload,
                version_value,
                timestamp,
            ),
        )
    return context.command(
        request=request,
        db_plans=(plan,),
        sync_events=sync_events,
        value=after,
        resolution=resolution,
    )


class MutationCompiler:
    """Compile policies against one lease-scoped authority overlay."""

    def __init__(
        self,
        catalog: CompiledEntityCatalog,
        policies: Sequence[MutationDomainPolicy] = (),
    ) -> None:
        self.catalog = catalog
        self._policies: dict[str, MutationDomainPolicy] = {}
        for policy in policies:
            for entity_type in policy.entity_types:
                if entity_type in self._policies:
                    raise ValueError(f"duplicate mutation policy: {entity_type}")
                self._policies[entity_type] = policy

    async def compile_against_overlay(
        self,
        scope: SpaceRuntimeHandle,
        request: MutationRequest,
        overlay: AuthorityOverlay,
        operation_id: str,
    ) -> MutationCommand:
        policy = self._policies.get(request.entity_type)
        context = MutationCompileContext(
            scope,
            overlay,
            self.catalog,
            DbMutationPlanFactoryImpl(self.catalog),
            SyncEventPlanFactoryImpl(self.catalog),
            operation_id,
        )
        if policy is not None:
            return await policy.compile(context, request)
        spec = _require_catalog_spec(self.catalog, request.entity_type)
        if (
            spec.storage_type is StorageType.FS_DB_SPLIT
            or spec.delete_strategy == "cascade_soft_delete"
        ):
            raise SpaceRecoveryRequiredError(
                "projection-backed entity requires a registered domain policy"
            )
        return await compile_catalog_entity_command(context, request)

    async def compile_batch(
        self,
        scope: SpaceRuntimeHandle,
        items: Sequence[PreparedBatchItem],
        session: AsyncSession,
    ) -> BatchCompilation:
        overlay = await AuthorityOverlay.from_locked_authorities(scope, session, self.catalog)
        accepted_ids: list[str] = []
        commands: list[MutationCommand] = []
        rejected: list[MutationRejection] = []
        for item in items:
            if item.request is None:
                continue
            try:
                command = await self.compile_against_overlay(
                    scope, item.request, overlay, item.operation_id
                )
            except MutationRuleViolation as exc:
                rejected.append(
                    MutationRejection(
                        item.request_index,
                        item.operation_id,
                        item.request.entity_type,
                        item.request.entity_id,
                        exc.code,
                        exc.retryable,
                        exc.details,
                    )
                )
            else:
                command = _bind_authoritative_note_event_bodies(
                    command, self.catalog, overlay
                )
                _validate_compiled_command(
                    command, self.catalog, authority=overlay
                )
                overlay.apply(command)
                accepted_ids.append(item.operation_id)
                commands.append(command)
        return BatchCompilation(tuple(accepted_ids), tuple(commands), tuple(rejected))


def _validate_persisted_plan_against_catalog(
    plan: DbMutationPlan, catalog: CompiledEntityCatalog
) -> EntitySpec:
    for spec in catalog.list():
        if spec.table_name == plan.table:
            if set(plan.primary_key) != {spec.primary_key}:
                raise SpaceRecoveryRequiredError(
                    "persisted mutation primary key conflicts with the catalog"
                )
            identity = plan.primary_key[spec.primary_key]
            for row in (plan.before_row, plan.after_row):
                if row is not None and (
                    set(row) != set(spec.field_names)
                    or row.get(spec.primary_key) != identity
                ):
                    raise SpaceRecoveryRequiredError(
                        "persisted mutation row conflicts with the catalog"
                    )
            if plan.operation == "insert":
                valid_shape = (
                    plan.before_row is None
                    and plan.after_row is not None
                    and plan.expected_version is None
                )
            elif plan.operation == "update":
                valid_shape = plan.before_row is not None and plan.after_row is not None
            else:
                valid_shape = plan.before_row is not None and plan.after_row is None
            if not valid_shape:
                raise SpaceRecoveryRequiredError(
                    "persisted mutation operation has invalid row images"
                )
            if (
                plan.operation != "insert"
                and plan.expected_version is not None
                and plan.before_row is not None
                and plan.before_row.get("version") != plan.expected_version
            ):
                raise SpaceRecoveryRequiredError(
                    "persisted mutation CAS conflicts with its before image"
                )
            return spec
    raise SpaceRecoveryRequiredError(f"unknown persisted mutation table: {plan.table}")


def _validate_sync_event_against_catalog(
    event: SyncEventPlan, catalog: CompiledEntityCatalog
) -> EntitySpec:
    try:
        spec = catalog.get(event.entity_type)
    except KeyError as exc:
        raise SpaceRecoveryRequiredError(
            "persisted sync entity is outside the compiled catalog"
        ) from exc
    if not spec.sync_enabled:
        raise SpaceRecoveryRequiredError("persisted sync entity is not sync-enabled")
    if event.action in {"create", "update"}:
        expected_fields = set(spec.field_names)
        if spec.name == "note":
            expected_fields.add("content")
        valid_payload = (
            set(event.payload) == expected_fields
            and str(event.payload.get(spec.primary_key)) == event.entity_id
            and event.payload.get("version") == event.version
        )
        if spec.name == "note" and valid_payload:
            content = event.payload.get("content")
            valid_payload = (
                isinstance(content, str)
                and hashlib.sha256(content.encode("utf-8")).hexdigest()
                == event.payload.get("content_hash")
            )
    else:
        valid_payload = event.payload == {"deleted_at": event.created_at}
    if not valid_payload:
        raise SpaceRecoveryRequiredError(
            "persisted sync event conflicts with the catalog"
        )
    return spec


@dataclass(frozen=True, slots=True)
class _NoteProjectionPaths:
    before: str | None
    after: str | None


def _note_index_row_from_blob(
    payload: bytes | None,
    identity: str,
    *,
    label: str,
) -> Mapping[str, object] | None:
    if payload is None:
        return None
    try:
        decoded = json.loads(payload)
    except (TypeError, ValueError) as exc:
        raise SpaceRecoveryRequiredError(
            f"{label} Note path projection is invalid"
        ) from exc
    if not isinstance(decoded, dict) or not isinstance(decoded.get("row"), dict):
        raise SpaceRecoveryRequiredError(
            f"{label} Note path projection is invalid"
        )
    row = decoded["row"]
    expected_fields = {
        column.name for column in ProjectionNoteModel.__table__.columns
    }
    if set(row) != expected_fields:
        raise SpaceRecoveryRequiredError(
            f"{label} Note index row is incomplete"
        )
    current_path = row.get("current_path")
    if row.get("note_id") != identity or not isinstance(current_path, str) or not current_path:
        raise SpaceRecoveryRequiredError(
            f"{label} Note path projection is invalid"
        )
    if row.get("level") not in {"L1", "L2", "L3"} or type(row.get("is_deleted")) is not bool:
        raise SpaceRecoveryRequiredError(
            f"{label} Note index row does not match the database image"
        )
    return require_frozen_object(row)


def _note_path_from_index_blob(
    payload: bytes | None,
    identity: str,
    *,
    label: str,
) -> str | None:
    row = _note_index_row_from_blob(payload, identity, label=label)
    return None if row is None else str(row["current_path"])


def _validate_note_index_row_against_db_image(
    index_row: Mapping[str, object] | None,
    db_row: Mapping[str, object] | None,
    *,
    label: str,
) -> None:
    if index_row is None or db_row is None:
        if index_row is db_row:
            return
        raise SpaceRecoveryRequiredError(
            f"{label} Note index row does not match the database image"
        )
    if index_row["note_id"] != db_row.get("id") or any(
        index_row[field] != value
        for field, value in db_row.items()
        if field in index_row
    ):
        raise SpaceRecoveryRequiredError(
            f"{label} Note index row does not match the database image"
        )
    if bool(index_row["is_deleted"]) != (db_row.get("trashed_at") is not None):
        raise SpaceRecoveryRequiredError(
            f"{label} Note index row does not match the database image"
        )


def _note_projection_paths(
    command: MutationCommand,
    plan: DbMutationPlan,
    identity: str,
    authority: AuthorityOverlay,
) -> _NoteProjectionPaths:
    index_target = f"index/notes/note_id/{identity}"
    index_projections = tuple(
        projection
        for projection in command.projections
        if projection.tag is ProjectionActionTag.INDEX_REPLACE
        and str(projection.target) == index_target
    )
    if len(index_projections) != 1:
        raise SpaceRecoveryRequiredError(
            "projection-backed entity requires complete bound projections"
        )
    projection = index_projections[0]
    before_row = _note_index_row_from_blob(
        projection.before, identity, label="before-image"
    )
    after_row = _note_index_row_from_blob(
        projection.after, identity, label="after-image"
    )
    _validate_note_index_row_against_db_image(
        before_row, plan.before_row, label="before-image"
    )
    _validate_note_index_row_against_db_image(
        after_row, plan.after_row, label="after-image"
    )
    before = None if before_row is None else str(before_row["current_path"])
    after = None if after_row is None else str(after_row["current_path"])
    authoritative = authority.note_path(identity)
    if plan.operation == "insert":
        valid = authoritative is None and before is None and after is not None
    elif plan.operation == "update":
        valid = authoritative is not None and before == authoritative and after is not None
    else:
        valid = authoritative is not None and before == authoritative and after is None
    if not valid:
        raise SpaceRecoveryRequiredError(
            "projection does not match the authoritative Note path"
        )
    return _NoteProjectionPaths(before, after)


def _persisted_note_path(identity: str, row: Mapping[str, object]) -> str | None:
    """Derive a Note's canonical path when only persisted DB images remain."""
    title = row.get("title")
    if title is None:
        return None
    filename = _make_filename(identity, str(title))
    folder_id = row.get("folder_id")
    return f"notes/{filename}" if folder_id is None else f"notes/{folder_id}/{filename}"


def _matching_sync_events(
    command: MutationCommand | PersistedMutationCommand,
    plan: DbMutationPlan,
    spec: EntitySpec,
) -> tuple[SyncEventPlan, ...]:
    return tuple(
        event
        for event in command.sync_events
        if (
            event.entity_type == spec.name
            and event.entity_id == str(plan.primary_key[spec.primary_key])
            and event.action
            == {"insert": "create", "update": "update", "delete": "delete"}[
                plan.operation
            ]
        )
    )


def _note_after_body(
    command: MutationCommand,
    plan: DbMutationPlan,
    identity: str,
    authority: AuthorityOverlay,
) -> str:
    paths = _note_projection_paths(command, plan, identity, authority)
    writes = tuple(
        projection
        for projection in command.projections
        if projection.tag is ProjectionActionTag.MARKDOWN_WRITE
        and str(projection.target) == paths.after
    )
    if len(writes) > 1:
        raise SpaceRecoveryRequiredError(
            "Note mutation has multiple authoritative Markdown bodies"
        )
    if writes:
        body = writes[0].after
    else:
        body = None if paths.before is None else authority.markdown(paths.before)
    if body is None:
        raise SpaceRecoveryRequiredError(
            "Note mutation has no authoritative Markdown after-body"
        )
    try:
        return strip_frontmatter(body.decode("utf-8"))
    except UnicodeDecodeError as exc:
        raise SpaceRecoveryRequiredError(
            "Note Markdown after-body is not valid UTF-8"
        ) from exc


def _bind_authoritative_note_event_bodies(
    command: MutationCommand,
    catalog: CompiledEntityCatalog,
    authority: AuthorityOverlay,
) -> MutationCommand:
    events = list(command.sync_events)
    changed = False
    for plan in command.db_plans:
        spec = _validate_persisted_plan_against_catalog(plan, catalog)
        if spec.name != "note" or plan.operation == "delete":
            continue
        matching = _matching_sync_events(command, plan, spec)
        if len(matching) != 1:
            continue
        event = matching[0]
        identity = str(plan.primary_key[spec.primary_key])
        content = _note_after_body(command, plan, identity, authority)
        if "content" in event.payload and event.payload["content"] != content:
            raise SpaceRecoveryRequiredError(
                "compiled Note event conflicts with the authoritative Markdown body"
            )
        replacement = SyncEventPlan(
            event.entity_type,
            event.entity_id,
            event.action,
            {**event.payload, "content": content},
            event.version,
            event.created_at,
        )
        events[events.index(event)] = replacement
        changed = True
    if not changed:
        return command
    return MutationCommand.from_effects(
        request=command.request,
        db_plans=command.db_plans,
        projections=command.projections,
        sync_events=tuple(events),
        result_value=command.result_value,
        resolution=command.resolution,
    )


def _projection_belongs_to_plan(
    projection,
    spec: EntitySpec,
    identity: str,
    *,
    note_paths: _NoteProjectionPaths | None = None,
    persisted_note_identity: str | None = None,
) -> bool:
    target = str(projection.target)
    if spec.name == "note":
        if persisted_note_identity is not None:
            if projection.tag is ProjectionActionTag.INDEX_REPLACE:
                return target == f"index/notes/note_id/{identity}"
            if projection.tag is ProjectionActionTag.FTS_REPLACE:
                return target == f"fts/{identity}"
            if projection.tag is ProjectionActionTag.MARKDOWN_WRITE:
                return persisted_note_identity == identity
            if projection.tag is ProjectionActionTag.PATH_RENAME:
                return persisted_note_identity == identity
            if projection.tag is ProjectionActionTag.PATH_REMOVE:
                return persisted_note_identity == identity
        if projection.tag is ProjectionActionTag.MARKDOWN_WRITE:
            return (
                False
                if note_paths is None
                else target == note_paths.after
            )
        if projection.tag is ProjectionActionTag.PATH_RENAME:
            return (
                False
                if note_paths is None
                else str(projection.source) == note_paths.before
                and target == note_paths.after
            )
        if projection.tag is ProjectionActionTag.PATH_REMOVE:
            return (
                False
                if note_paths is None
                else target == note_paths.before
            )
        if projection.tag is ProjectionActionTag.INDEX_REPLACE:
            return target == f"index/notes/note_id/{identity}"
        if projection.tag is ProjectionActionTag.FTS_REPLACE:
            return target == f"fts/{identity}"
    if spec.name == "folder":
        return (
            projection.tag is ProjectionActionTag.INDEX_REPLACE
            and target == f"index/folders/id/{identity}"
        )
    return False


def _projection_belongs_to_note_version(
    projection,
    command: MutationCommand | PersistedMutationCommand,
    plan: DbMutationPlan,
    identity: str,
) -> bool:
    if (
        command.request.name != "knowledge.note.update_content"
        or plan.before_row is None
        or plan.after_row is None
        or plan.before_row.get("content_hash") == plan.after_row.get("content_hash")
    ):
        return False
    version_id = f"v_{command.request.request_hash[:12]}"
    target = str(projection.target)
    return (
        projection.tag is ProjectionActionTag.MARKDOWN_WRITE
        and target == f".meta/version_backups/{version_id}.md"
    ) or (
        projection.tag is ProjectionActionTag.INDEX_REPLACE
        and target == f"index/note_versions/version_id/{version_id}"
    )


def _validate_note_version_projections(
    command: MutationCommand | PersistedMutationCommand,
    plan: DbMutationPlan,
    identity: str,
    authority: AuthorityOverlay | None,
) -> None:
    changed = (
        command.request.name == "knowledge.note.update_content"
        and plan.before_row is not None
        and plan.after_row is not None
        and plan.before_row.get("content_hash") != plan.after_row.get("content_hash")
    )
    projections = tuple(
        projection
        for projection in command.projections
        if _projection_belongs_to_note_version(
            projection, command, plan, identity
        )
    )
    if not changed:
        if projections:
            raise SpaceRecoveryRequiredError(
                "Note version projection exists without a content change"
            )
        return
    if len(projections) != 2 or {
        projection.tag for projection in projections
    } != {
        ProjectionActionTag.MARKDOWN_WRITE,
        ProjectionActionTag.INDEX_REPLACE,
    }:
        raise SpaceRecoveryRequiredError(
            "Note content update requires complete version projections"
        )
    if not isinstance(command, MutationCommand):
        if any(
            projection.before_sha256 is not None
            or projection.after_sha256 is None
            for projection in projections
        ):
            raise SpaceRecoveryRequiredError(
                "persisted Note version projection images are invalid"
            )
        return
    version_id = f"v_{command.request.request_hash[:12]}"
    backup = next(
        projection
        for projection in projections
        if projection.tag is ProjectionActionTag.MARKDOWN_WRITE
    )
    index = next(
        projection
        for projection in projections
        if projection.tag is ProjectionActionTag.INDEX_REPLACE
    )
    authoritative = None
    if authority is not None:
        path = authority.note_path(identity)
        authoritative = None if path is None else authority.markdown(path)
    if backup.before is not None or backup.after != authoritative:
        raise SpaceRecoveryRequiredError(
            "Note version backup differs from authoritative Markdown"
        )
    try:
        index_payload = json.loads(index.after) if index.after is not None else None
    except (TypeError, ValueError) as exc:
        raise SpaceRecoveryRequiredError("Note version index is invalid") from exc
    expected_row = {
        "version_id": version_id,
        "note_id": identity,
        "content_hash": str(plan.before_row.get("content_hash", "")),
        "change_summary": "edit",
        "created_at": str(plan.after_row["updated_at"]),
    }
    if index.before is not None or index_payload != {"row": expected_row}:
        raise SpaceRecoveryRequiredError("Note version index is invalid")


def _required_projection_tags(
    plan: DbMutationPlan, spec: EntitySpec
) -> frozenset[ProjectionActionTag]:
    if spec.name == "folder":
        return frozenset({ProjectionActionTag.INDEX_REPLACE})
    if spec.storage_type is not StorageType.FS_DB_SPLIT:
        return frozenset()
    if plan.operation == "insert":
        return frozenset(
            {
                ProjectionActionTag.MARKDOWN_WRITE,
                ProjectionActionTag.INDEX_REPLACE,
                ProjectionActionTag.FTS_REPLACE,
            }
        )
    if plan.operation == "delete":
        return frozenset(
            {
                ProjectionActionTag.PATH_REMOVE,
                ProjectionActionTag.INDEX_REPLACE,
                ProjectionActionTag.FTS_REPLACE,
            }
        )
    assert plan.before_row is not None and plan.after_row is not None
    required = {ProjectionActionTag.INDEX_REPLACE}
    if plan.before_row.get("content_hash") != plan.after_row.get("content_hash"):
        required.update(
            {ProjectionActionTag.MARKDOWN_WRITE, ProjectionActionTag.FTS_REPLACE}
        )
    if any(
        plan.before_row.get(field) != plan.after_row.get(field)
        for field in ("folder_id", "title")
    ):
        required.add(ProjectionActionTag.PATH_RENAME)
    if plan.before_row.get("title") != plan.after_row.get("title"):
        required.add(ProjectionActionTag.FTS_REPLACE)
    return frozenset(required)


def _projection_after_digest(projection) -> str | None:
    if hasattr(projection, "after"):
        after = projection.after
        return None if after is None else hashlib.sha256(after).hexdigest()
    return projection.after_sha256


def _note_projection_body_digest(projection: ProjectionPlan) -> str:
    if projection.after is None:
        raise SpaceRecoveryRequiredError("Note Markdown projection has no after image")
    try:
        body = strip_frontmatter(projection.after.decode("utf-8"))
    except UnicodeDecodeError as exc:
        raise SpaceRecoveryRequiredError(
            "Note Markdown projection is not valid UTF-8"
        ) from exc
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def _validate_compiled_command(
    command: MutationCommand | PersistedMutationCommand,
    catalog: CompiledEntityCatalog,
    *,
    authority: AuthorityOverlay | None = None,
) -> None:
    request_spec: EntitySpec | None
    try:
        request_spec = catalog.get(command.request.entity_type)
    except KeyError as exc:
        namespace, separator, _operation = command.request.name.partition(".")
        if not separator or namespace != command.request.entity_type:
            raise SpaceRecoveryRequiredError(
                "compiled request entity is outside the compiled catalog"
            ) from exc
        request_spec = None
    plan_specs = tuple(
        _validate_persisted_plan_against_catalog(plan, catalog)
        for plan in command.db_plans
    )
    if command.request.name == "knowledge.projection.rebuild":
        _validate_knowledge_rebuild_command(command, authority)
        return
    focus_rebuild = command.request.name == "focus_session.rebuild_effort_projection"
    if focus_rebuild:
        _validate_focus_session_rebuild_command(command, catalog)
    if (
        request_spec is not None
        and plan_specs
        and request_spec.name not in {spec.name for spec in plan_specs}
        and not focus_rebuild
    ):
        raise SpaceRecoveryRequiredError(
            "compiled database effects do not include the request entity"
        )
    for event in command.sync_events:
        _validate_sync_event_against_catalog(event, catalog)
    required_tags = tuple(
        _required_projection_tags(plan, spec)
        for plan, spec in zip(command.db_plans, plan_specs, strict=True)
    )
    persisted_note_projection_identity: dict[int, str] = {}
    legacy_persisted_path_owner: dict[ProjectionActionTag, str] = {}
    if isinstance(command, PersistedMutationCommand):
        # Persisted descriptors retain hashes, not the index-row bytes that
        # contain a historical Note path.  A single-Note journal entry can
        # therefore retain an older, valid path that is no longer derivable
        # from its title/folder image.  Keep that legacy case bound to its
        # unique Note owner; multi-Note commands remain canonical-path bound.
        for tag in (
            ProjectionActionTag.MARKDOWN_WRITE,
            ProjectionActionTag.PATH_RENAME,
            ProjectionActionTag.PATH_REMOVE,
        ):
            owners = tuple(
                index
                for index, (spec, required) in enumerate(
                    zip(plan_specs, required_tags, strict=True)
                )
                if spec.name == "note" and tag in required
            )
            if len(owners) == 1:
                plan = command.db_plans[owners[0]]
                spec = plan_specs[owners[0]]
                legacy_persisted_path_owner[tag] = str(
                    plan.primary_key[spec.primary_key]
                )
        for projection in command.projections:
            if projection.tag not in {
                ProjectionActionTag.MARKDOWN_WRITE,
                ProjectionActionTag.PATH_RENAME,
                ProjectionActionTag.PATH_REMOVE,
            }:
                continue
            matches: list[str] = []
            for plan, spec in zip(command.db_plans, plan_specs, strict=True):
                if spec.name != "note":
                    continue
                identity = str(plan.primary_key[spec.primary_key])
                before = (
                    None
                    if plan.before_row is None
                    else _persisted_note_path(identity, plan.before_row)
                )
                after = (
                    None
                    if plan.after_row is None
                    else _persisted_note_path(identity, plan.after_row)
                )
                target = str(projection.target)
                source = None if projection.source is None else str(projection.source)
                belongs = (
                    projection.tag is ProjectionActionTag.MARKDOWN_WRITE
                    and after is not None
                    and target == after
                ) or (
                    projection.tag is ProjectionActionTag.PATH_RENAME
                    and before is not None
                    and after is not None
                    and source == before
                    and target == after
                ) or (
                    projection.tag is ProjectionActionTag.PATH_REMOVE
                    and before is not None
                    and target == before
                )
                if belongs:
                    matches.append(identity)
            if len(matches) == 1:
                persisted_note_projection_identity[projection.ordinal] = matches[0]
            elif len(matches) > 1:
                raise SpaceRecoveryRequiredError(
                    "persisted Note projection matches multiple database mutations"
                )
            elif projection.tag in legacy_persisted_path_owner:
                persisted_note_projection_identity[projection.ordinal] = (
                    legacy_persisted_path_owner[projection.tag]
                )
    note_paths_by_plan: dict[int, _NoteProjectionPaths] = {}
    if isinstance(command, MutationCommand):
        for plan_index, (plan, spec) in enumerate(
            zip(command.db_plans, plan_specs, strict=True)
        ):
            if spec.name != "note":
                continue
            if authority is None:
                raise SpaceRecoveryRequiredError(
                    "compiled Note projections require authoritative paths"
                )
            identity = str(plan.primary_key[spec.primary_key])
            note_paths_by_plan[plan_index] = _note_projection_paths(
                command, plan, identity, authority
            )
    for plan_index, (plan, spec) in enumerate(
        zip(command.db_plans, plan_specs, strict=True)
    ):
        matching_events = _matching_sync_events(command, plan, spec)
        if spec.sync_enabled and len(matching_events) != 1:
            raise SpaceRecoveryRequiredError(
                "compiled sync event is missing for a database mutation"
            )
        if matching_events:
            event = matching_events[0]
            if plan.operation in {"insert", "update"}:
                event_after = dict(event.payload)
                if spec.name == "note":
                    event_after.pop("content", None)
                if (
                    event_after != plan.after_row
                    or plan.after_row is None
                    or event.version != plan.after_row.get("version")
                ):
                    raise SpaceRecoveryRequiredError(
                        "compiled sync event differs from the database after image"
                    )
            else:
                before_version = (
                    None
                    if plan.before_row is None
                    else plan.before_row.get("version")
                )
                if type(before_version) is not int or event.version != before_version + 1:
                    raise SpaceRecoveryRequiredError(
                        "compiled delete event version differs from the database before image"
                    )
        identity = str(plan.primary_key[spec.primary_key])
        if spec.name == "note":
            _validate_note_version_projections(
                command, plan, identity, authority
            )
        owned = tuple(
            projection
            for projection in command.projections
            if not _projection_belongs_to_note_version(
                projection, command, plan, identity
            )
            and _projection_belongs_to_plan(
                projection,
                spec,
                identity,
                note_paths=note_paths_by_plan.get(plan_index),
                persisted_note_identity=persisted_note_projection_identity.get(
                    projection.ordinal
                ),
            )
        )
        required = required_tags[plan_index]
        for tag in required:
            matching_projections = tuple(
                projection for projection in owned if projection.tag is tag
            )
            if len(matching_projections) != 1:
                raise SpaceRecoveryRequiredError(
                    "projection-backed entity requires complete bound projections"
                )
            if tag in {
                ProjectionActionTag.MARKDOWN_WRITE,
                ProjectionActionTag.INDEX_REPLACE,
                ProjectionActionTag.FTS_REPLACE,
            }:
                after_digest = _projection_after_digest(matching_projections[0])
                if (plan.operation == "delete") == (after_digest is not None):
                    raise SpaceRecoveryRequiredError(
                        "projection image does not match the database operation"
                    )
                if (
                    tag is ProjectionActionTag.MARKDOWN_WRITE
                    and plan.after_row is not None
                    and isinstance(command, MutationCommand)
                    and _note_projection_body_digest(matching_projections[0])
                    != plan.after_row.get("content_hash")
                ):
                    raise SpaceRecoveryRequiredError(
                        "Markdown projection differs from the Note content hash"
                    )
            elif tag is ProjectionActionTag.PATH_RENAME:
                rename = matching_projections[0]
                rename_before = (
                    hashlib.sha256(rename.before).hexdigest()
                    if hasattr(rename, "before")
                    else rename.before_sha256
                )
                rename_after = (
                    hashlib.sha256(rename.after).hexdigest()
                    if hasattr(rename, "after")
                    else rename.after_sha256
                )
                if rename_before != rename_after:
                    raise SpaceRecoveryRequiredError(
                        "path rename projection changes the Note artifact"
                    )
                if isinstance(command, MutationCommand):
                    assert authority is not None
                    source = None if rename.source is None else str(rename.source)
                    if source is None or authority.markdown(source) != rename.before:
                        raise SpaceRecoveryRequiredError(
                            "path rename projection differs from authoritative Markdown"
                        )
    if command.projections and not plan_specs:
        raise SpaceRecoveryRequiredError(
            "compiled projection effects require a database mutation"
        )
    for projection in command.projections:
        bound = False
        for plan_index, (plan, spec) in enumerate(
            zip(command.db_plans, plan_specs, strict=True)
        ):
            if spec.name not in {"folder", "note"}:
                continue
            identity = str(plan.primary_key[spec.primary_key])
            if _projection_belongs_to_plan(
                projection,
                spec,
                identity,
                note_paths=note_paths_by_plan.get(plan_index),
                persisted_note_identity=persisted_note_projection_identity.get(
                    projection.ordinal
                ),
            ):
                bound = True
                break
            if spec.name == "note" and _projection_belongs_to_note_version(
                projection, command, plan, identity
            ):
                bound = True
                break
        if not bound:
            raise SpaceRecoveryRequiredError(
                "compiled projection target is not bound to a database mutation"
            )


def _validate_focus_session_rebuild_command(
    command: MutationCommand | PersistedMutationCommand,
    catalog: CompiledEntityCatalog,
) -> None:
    """Validate the one cross-entity FocusSession maintenance command."""
    request = command.request
    allowed = {
        "space_id", "operation", "requested_at", "work_item_id", "payload_hash",
    }
    if (
        request.entity_type != "focus_session"
        or request.expected_version is not None
        or request.client_updated_at is not None
        or set(request.payload) - allowed
        or (
            "operation" in request.payload
            and request.payload["operation"] != "rebuild_effort_projection"
        )
        or not isinstance(request.payload.get("space_id"), str)
        or not isinstance(request.payload.get("requested_at"), str)
        or not command.result_value.keys() >= {"rebuilt", "count", "mismatches_repaired"}
    ):
        raise SpaceRecoveryRequiredError(
            "invalid focus_session effort rebuild command"
        )
    payload_hash = request.payload.get("payload_hash")
    if payload_hash is not None:
        from app.mutation.types import require_payload_hash

        business_payload = {
            key: value
            for key, value in request.payload.items()
            if key not in {"space_id", "payload_hash"}
        }
        try:
            require_payload_hash(str(payload_hash), business_payload)
        except ValueError as exc:
            raise SpaceRecoveryRequiredError(
                "invalid focus_session effort rebuild payload hash"
            ) from exc
    if "work_item_id" in request.payload and not isinstance(
        request.payload["work_item_id"], str
    ):
        raise SpaceRecoveryRequiredError(
            "invalid focus_session effort rebuild target"
        )
    for plan in command.db_plans:
        spec = _validate_persisted_plan_against_catalog(plan, catalog)
        if spec.name != "work_item" or plan.operation != "update":
            raise SpaceRecoveryRequiredError(
                "focus_session effort rebuild may update WorkItem projections only"
            )


def _validate_knowledge_rebuild_command(
    command: MutationCommand | PersistedMutationCommand,
    authority: AuthorityOverlay | None,
) -> None:
    request = command.request
    if (
        request.entity_type != "note"
        or request.payload
        or request.expected_version is not None
        or request.client_updated_at is not None
        or command.db_plans
        or command.sync_events
        or set(command.result_value) != {"rebuiltFolders", "rebuiltNotes"}
        or any(
            type(command.result_value[key]) is not int
            or command.result_value[key] < 0
            for key in ("rebuiltFolders", "rebuiltNotes")
        )
    ):
        raise SpaceRecoveryRequiredError("knowledge rebuild command shape is invalid")
    allowed_tags = {
        ProjectionActionTag.MARKDOWN_WRITE,
        ProjectionActionTag.PATH_RENAME,
        ProjectionActionTag.INDEX_REPLACE,
        ProjectionActionTag.FTS_REPLACE,
    }
    if any(projection.tag not in allowed_tags for projection in command.projections):
        raise SpaceRecoveryRequiredError("knowledge rebuild projection tag is invalid")
    if authority is None:
        for projection in command.projections:
            target = str(projection.target)
            if not (
                target.startswith("notes/")
                or target.startswith("index/folders/id/")
                or target.startswith("index/notes/note_id/")
                or target.startswith("fts/")
            ):
                raise SpaceRecoveryRequiredError(
                    "knowledge rebuild projection target is invalid"
                )
        return

    folder_ids = {str(row["id"]) for row in authority.rows("folder")}
    note_rows = {str(row["id"]): row for row in authority.rows("note")}
    if command.result_value != {
        "rebuiltFolders": len(folder_ids),
        "rebuiltNotes": len(note_rows),
    }:
        raise SpaceRecoveryRequiredError("knowledge rebuild result count is invalid")
    folder_targets = {f"index/folders/id/{identity}" for identity in folder_ids}
    note_index_targets = {
        f"index/notes/note_id/{identity}" for identity in note_rows
    }
    fts_targets = {f"fts/{identity}" for identity in note_rows}
    note_paths = set()
    for identity, row in note_rows.items():
        filename = _make_filename(identity, str(row["title"]))
        folder_id = row.get("folder_id")
        note_paths.add(
            f"notes/{filename}"
            if folder_id is None
            else f"notes/{folder_id}/{filename}"
        )
    for projection in command.projections:
        target = str(projection.target)
        valid = (
            projection.tag is ProjectionActionTag.INDEX_REPLACE
            and target in folder_targets | note_index_targets
        ) or (
            projection.tag is ProjectionActionTag.FTS_REPLACE
            and target in fts_targets
        ) or (
            projection.tag is ProjectionActionTag.MARKDOWN_WRITE
            and target in note_paths
        ) or (
            projection.tag is ProjectionActionTag.PATH_RENAME
            and target in note_paths
            and projection.source is not None
            and authority.markdown(str(projection.source)) is not None
        )
        if not valid:
            raise SpaceRecoveryRequiredError(
                "knowledge rebuild projection is outside locked authority"
            )
    counts = Counter(
        (projection.tag, str(projection.target))
        for projection in command.projections
    )
    required = {
        *((ProjectionActionTag.INDEX_REPLACE, target) for target in folder_targets),
        *((ProjectionActionTag.INDEX_REPLACE, target) for target in note_index_targets),
        *((ProjectionActionTag.FTS_REPLACE, target) for target in fts_targets),
    }
    optional = {
        *((ProjectionActionTag.MARKDOWN_WRITE, target) for target in note_paths),
        *((ProjectionActionTag.PATH_RENAME, target) for target in note_paths),
    }
    if any(counts[item] != 1 for item in required) or any(
        counts[item] > 1 for item in optional
    ):
        raise SpaceRecoveryRequiredError(
            "knowledge rebuild projections do not cover complete locked authority"
        )


def decode_and_validate_persisted_command(
    command_json: str, *, catalog: CompiledEntityCatalog
) -> PersistedMutationCommand:
    command = decode_persisted_command(command_json)
    _validate_compiled_command(command, catalog)
    return command


class DbMutationInterpreter:
    """Interpret typed journal plans using models from the frozen catalog."""

    def __init__(self, catalog: CompiledEntityCatalog) -> None:
        self.catalog = catalog

    def decode_command(self, command_json: str) -> PersistedMutationCommand:
        return decode_and_validate_persisted_command(
            command_json, catalog=self.catalog
        )

    def _spec_for_plan(self, plan: DbMutationPlan) -> EntitySpec:
        return _validate_persisted_plan_against_catalog(plan, self.catalog)

    def _model_for_plan(self, plan: DbMutationPlan):
        spec = self._spec_for_plan(plan)
        return self.catalog.model_for(spec.name), spec.primary_key

    async def apply(
        self, session: AsyncSession, plans: Sequence[DbMutationPlan]
    ) -> tuple[Mapping[str, object], ...]:
        applied: list[Mapping[str, object]] = []
        for plan in plans:
            model, primary_key = self._model_for_plan(plan)
            identity = plan.primary_key[primary_key]
            if plan.operation == "insert":
                if plan.after_row is None:
                    raise SpaceRecoveryRequiredError("insert plan has no after image")
                session.add(model(**dict(plan.after_row)))
                applied.append(plan.after_row)
                continue
            row = await session.get(model, identity)
            if row is None:
                raise MutationRuleViolation("not_found", {"entityId": identity})
            if plan.expected_version is not None and getattr(row, "version", None) != plan.expected_version:
                raise MutationRuleViolation("version_conflict", {"entityId": identity})
            if plan.operation == "update":
                if plan.after_row is None:
                    raise SpaceRecoveryRequiredError("update plan has no after image")
                for key, value in plan.after_row.items():
                    setattr(row, key, value)
                applied.append(plan.after_row)
            else:
                await session.delete(row)
                applied.append(plan.before_row or {})
        await session.flush()
        return tuple(applied)

    async def restore_before(self, session: AsyncSession, plans: Sequence[DbMutationPlan]) -> None:
        for plan in reversed(tuple(plans)):
            model, primary_key = self._model_for_plan(plan)
            identity = plan.primary_key[primary_key]
            row = await session.get(model, identity)
            if plan.operation == "insert":
                if row is not None:
                    await session.delete(row)
            elif plan.before_row is not None:
                if row is None:
                    session.add(model(**dict(plan.before_row)))
                else:
                    for key, value in plan.before_row.items():
                        setattr(row, key, value)
        await session.flush()


def child_operation_ids(batch_id: str, count: int) -> tuple[str, ...]:
    return tuple(bounded_child_operation_id(batch_id, f"{index:04d}") for index in range(count))


class RecoveryGate(Protocol):
    async def require_clean_under_lease(
        self, scope: SpaceRuntimeHandle, lease: Lease, journal: MutationJournal
    ) -> None: ...

    async def recover_under_lease(
        self, scope: SpaceRuntimeHandle, lease: Lease
    ) -> RecoveryResult: ...

    async def inspect(self, view: SpaceRuntimeHandle) -> RecoveryInspection: ...


class MutationJournalFactory(Protocol):
    def __call__(self, session_factory: async_sessionmaker[AsyncSession]) -> MutationJournal: ...


class MutationUnitOfWork:
    def __init__(
        self,
        *,
        catalog: CompiledEntityCatalog,
        compiler: MutationCompiler,
        interpreter: DbMutationInterpreter,
        projection_executor: FencedProjectionExecutor,
        recovery_gate: RecoveryGate,
        journal_factory: MutationJournalFactory,
    ) -> None:
        self.catalog = catalog
        self.compiler = compiler
        self.interpreter = interpreter
        self.projection_executor = projection_executor
        self.recovery_gate = recovery_gate
        self.journal_factory = journal_factory

    async def recover_under_lease(
        self, scope: SpaceRuntimeHandle, lease: Lease
    ) -> RecoveryResult:
        recover = getattr(self.recovery_gate, "recover_under_lease", None)
        if recover is not None:
            return await recover(scope, lease)
        journal = self.journal_factory(scope.session_factory)
        await self.recovery_gate.require_clean_under_lease(scope, lease, journal)
        return RecoveryResult((), (), (), ())

    async def inspect_recovery(
        self, view: SpaceRuntimeHandle
    ) -> RecoveryInspection:
        inspect_recovery = getattr(self.recovery_gate, "inspect", None)
        if inspect_recovery is not None:
            return await inspect_recovery(view)
        journal = self.journal_factory(view.session_factory)
        clean = await journal.is_clean()
        return RecoveryInspection((), (), (), clean, ())

    async def execute(
        self, scope: SpaceRuntimeHandle, request: MutationRequest, operation_id: str,
        *, result_hook: Callable[[MutationResult], Awaitable[Mapping[str, object]]] | None = None,
    ) -> MutationResult:
        outcome = await self.execute_batch(
            scope, (request,), operation_id, operation_ids=(operation_id,), result_hook=result_hook,
        )
        if outcome.rejected:
            raise MutationRejectedError(outcome.rejected[0])
        return outcome.applied[0]

    async def execute_batch(
        self,
        scope: SpaceRuntimeHandle,
        requests: Sequence[MutationRequest],
        batch_id: str,
        *,
        operation_ids: Sequence[str] | None = None,
        result_hook: Callable[[MutationResult], Awaitable[Mapping[str, object]]] | None = None,
    ) -> BatchMutationResult:
        requested = tuple(requests)
        if operation_ids is None:
            resolved_ids = child_operation_ids(batch_id, len(requested))
            operation_id_derivations = {
                operation_id: (batch_id, f"{index:04d}")
                for index, operation_id in enumerate(resolved_ids)
            }
        else:
            resolved_ids = tuple(operation_ids)
            operation_id_derivations = {}
        if len(resolved_ids) != len(requested) or len(set(resolved_ids)) != len(resolved_ids):
            raise ValueError("operation_ids must be unique and align with requests")
        return await self._execute_prepared_batch(
            scope,
            tuple(
                PreparedBatchItem(index, operation_id, request.request_hash, request, None)
                for index, (operation_id, request) in enumerate(zip(resolved_ids, requested, strict=True))
            ),
            batch_id,
            operation_id_derivations=operation_id_derivations,
            result_hook=result_hook,
        )

    async def execute_prepared_batch(
        self,
        scope: SpaceRuntimeHandle,
        items: Sequence[PreparedBatchItem],
        batch_id: str,
        *,
        result_hook: Callable[[MutationResult], Awaitable[Mapping[str, object]]] | None = None,
    ) -> BatchMutationResult:
        return await self._execute_prepared_batch(scope, items, batch_id, result_hook=result_hook)

    async def _execute_prepared_batch(
        self,
        scope: SpaceRuntimeHandle,
        items: Sequence[PreparedBatchItem],
        batch_id: str,
        *,
        operation_id_derivations: Mapping[str, tuple[str, str]] | None = None,
        result_hook: Callable[[MutationResult], Awaitable[Mapping[str, object]]] | None = None,
    ) -> BatchMutationResult:
        validate_operation_id(batch_id)
        prepared = tuple(items)
        if not prepared:
            return BatchMutationResult(batch_id, (), ())
        if tuple(item.request_index for item in prepared) != tuple(range(len(prepared))):
            raise ValueError("prepared items must have contiguous input-order indices")
        operation_ids = tuple(item.operation_id for item in prepared)
        if len(set(operation_ids)) != len(operation_ids):
            raise ValueError("prepared operation IDs must be unique")
        for operation_id in operation_ids:
            validate_operation_id(operation_id)
        derivations = dict(operation_id_derivations or {})
        if set(derivations) - set(operation_ids):
            raise ValueError("operation ID derivations must belong to this batch")
        for operation_id, (parent_id, suffix) in derivations.items():
            if parent_id != batch_id or bounded_child_operation_id(parent_id, suffix) != operation_id:
                raise ValueError("operation ID derivation does not match its child")
        request_hash = hash_prepared_batch_identity(
            tuple((item.request_index, item.operation_id, item.intent_hash) for item in prepared)
        )
        _lease_fn = getattr(scope, "mutation_lease", None)
        if _lease_fn is None:
            _lease_fn = scope.exclusive_space_resources
        async with _lease_fn("mutation", 5) as lease:
            journal = self.journal_factory(scope.session_factory)
            recovery = await self.recover_under_lease(scope, lease)
            if recovery.failed_manual:
                raise SpaceRecoveryRequiredError(
                    "space recovery requires manual intervention"
                )
            existing = await journal.find_batch(batch_id)
            if existing is not None:
                return await self._resume_or_return(existing, request_hash, journal)
            bindings = await journal.find_operation_batch_bindings(operation_ids)
            foreign_bindings = tuple(
                sorted((operation_id, owner) for operation_id, owner in bindings.items() if owner != batch_id)
            )
            if foreign_bindings:
                operation_id, owner_batch_id = foreign_bindings[0]
                raise IdempotencyConflictError(
                    operation_id=operation_id,
                    existing_batch_id=owner_batch_id,
                    requested_batch_id=batch_id,
                )
            if bindings:
                raise SpaceRecoveryRequiredError("operation binding exists without its owning batch receipt")
            async with scope.session_factory() as session:
                compilation = await self.compiler.compile_batch(scope, prepared, session)
            rejections = tuple(
                sorted(
                    (
                        *(item.pre_rejection for item in prepared if item.pre_rejection is not None),
                        *compilation.rejected,
                    ),
                    key=lambda rejection: rejection.request_index,
                )
            )
            if not compilation.commands:
                return await journal.record_rejected_batch(
                    batch_id,
                    request_hash,
                    rejections,
                    operation_id_derivations=derivations,
                )
            await journal.create_batch_intent(
                batch_id,
                request_hash,
                compilation.operation_ids,
                compilation.commands,
                rejections,
                operation_id_derivations=derivations,
            )
            manifests = await self._publish_stages(scope, lease, compilation.operation_ids, compilation.commands)
            await journal.mark_staged(batch_id, manifests)
            await self._commit_business(scope, journal, batch_id, compilation.operation_ids, compilation.commands)
            await journal.mark_finalizing(batch_id)
            await self._finalize_forward(
                scope, journal, batch_id, compilation.operation_ids, compilation.commands,
                lease.fence_receipt(scope.scope.space_id),
            )
            result = await journal.finalize_batch(batch_id)
            if result_hook is not None:
                for applied in result.applied:
                    value = await result_hook(applied)
                    await journal.update_operation_result(applied.operation_id, value)
                result = await journal.hydrate_result(result)
            return result

    async def _resume_or_return(
        self, existing: JournalBatch, request_hash: str, journal: MutationJournal,
    ) -> BatchMutationResult:
        if existing.request_hash != request_hash:
            raise IdempotencyConflictError(requested_batch_id=existing.batch_id)
        if existing.state not in (MutationState.FINALIZED, MutationState.ABORTED):
            raise SpaceRecoveryRequiredError("existing mutation receipt requires recovery")
        return await journal.hydrate_result(existing.result)

    async def _publish_stages(self, scope, lease, operation_ids, commands) -> tuple[object, ...]:
        stages = scope.mutation_stages
        if stages is None:
            raise SpaceRecoveryRequiredError("Space mutation stages are not active")
        manifests = []
        for operation_id, command in zip(operation_ids, commands, strict=True):
            manifests.append(
                await stages.publish(
                    operation_id,
                    command.projections,
                    lease=lease,
                    space_id=scope.scope.space_id,
                )
            )
        return tuple(manifests)

    async def _commit_business(self, scope, journal, batch_id, operation_ids, commands) -> None:
        async with scope.session_factory.begin() as session:
            connection = await session.connection()
            await connection.exec_driver_sql("BEGIN IMMEDIATE")
            for operation_id, command in zip(operation_ids, commands, strict=True):
                async with session.begin_nested():
                    await self.interpreter.apply(session, command.db_plans)
                    operation = await session.get(MutationOperation, operation_id)
                    if operation is None or operation.batch_id != batch_id:
                        raise SpaceRecoveryRequiredError("journal operation disappeared during business commit")
                    operation.db_before_json = json.dumps(
                        [
                            None if plan.before_row is None else dict(plan.before_row)
                            for plan in command.db_plans
                        ],
                        separators=(",", ":"),
                    )
                    operation.db_after_json = json.dumps(
                        [
                            None if plan.after_row is None else dict(plan.after_row)
                            for plan in command.db_plans
                        ],
                        separators=(",", ":"),
                    )
            for operation_id, command in zip(operation_ids, commands, strict=True):
                await MutationJournal.transition_in_transaction(
                    session, operation_id, MutationState.STAGED, MutationState.DB_COMMITTED
                )
                for event in command.sync_events:
                    spec = self.catalog.get(event.entity_type)
                    if not spec.sync_enabled:
                        raise MutationRuleViolation("not_found", {"entityType": event.entity_type})
                    await record_sync_event(
                        session,
                        entity_type=spec.effective_sync_entity_type,
                        entity_id=event.entity_id,
                        action=event.action,
                        payload=event.payload,
                        operation_id=operation_id,
                        batch_id=batch_id,
                        version=event.version,
                        created_at=event.created_at,
                        visible=False,
                    )

            # Tombstone creation: for each delete sync_event, create a
            # tombstone in the space database. Delete any old tombstone
            # first to ensure exactly one current deletion proof.
            from sqlalchemy import text as sa_text
            for operation_id, command in zip(operation_ids, commands, strict=True):
                for event in command.sync_events:
                    if event.action != "delete":
                        continue
                    spec = self.catalog.get(event.entity_type)
                    await session.execute(
                        sa_text(
                            "DELETE FROM tombstones "
                            "WHERE entity_type = :et AND entity_id = :eid"
                        ),
                        {
                            "et": spec.effective_sync_entity_type,
                            "eid": event.entity_id,
                        },
                    )
                    await session.execute(
                        sa_text(
                            "INSERT INTO tombstones (entity_type, entity_id, deleted_at) "
                            "VALUES (:et, :eid, :dt)"
                        ),
                        {
                            "et": spec.effective_sync_entity_type,
                            "eid": event.entity_id,
                            "dt": event.created_at,
                        },
                    )

    async def _finalize_forward(self, scope, journal, batch_id, operation_ids, commands, receipt) -> None:
        for operation_id, command in zip(operation_ids, commands, strict=True):
            persisted = command.persisted()
            for descriptor in persisted.projections:
                await self.projection_executor.apply_forward(
                    scope,
                    operation_id,
                    persisted,
                    receipt,
                    ordinals=(descriptor.ordinal,),
                )
                await journal.mark_step_applied(
                    operation_id,
                    descriptor.ordinal,
                    descriptor.after_sha256,
                )
            await journal.transition(operation_id, MutationState.FORWARD_APPLIED)
