"""Centralized entity commands and domain policies.

EntityCommand is a pure factory for MutationRequest — no DB access, no lease.
FolderDomainPolicy adds cycle detection, parent-active checks, cascade soft
delete, and INDEX_REPLACE projections required by the mutation compiler.
RelationDomainPolicy checks junction endpoint existence on create.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Literal, Protocol

from app.mutation.types import (
    ContainedProjectionActionField,
    DbMutationPlan,
    MutationCommand,
    MutationRequest,
    MutationRuleViolation,
    ProjectionActionTag,
    ProjectionPlan,
    SyncEventPlan,
    require_frozen_object,
    validate_canonical_timestamp,
)
from app.mutation.unit_of_work import (
    MutationCompileContext,
    _require_current_version,
    compile_catalog_entity_command,
)
from app.registry.catalog import CompiledEntityCatalog
from app.registry.entities import EntitySpec
from app.runtime.space import SpaceRuntimeHandle
from app.services.time import utc_now_iso_ms


class SyncEventLike(Protocol):
    """Structural type for sync events accepted by EntityCommand.from_sync_event."""

    entity_type: str
    entity_id: str
    action: Literal["create", "update", "delete"]
    payload: Mapping[str, object]
    expected_version: int | None
    client_updated_at: str


def serialize_folder_index_row(row: Mapping[str, object]) -> bytes:
    """Serialize a folder row to an INDEX_REPLACE blob."""
    projected = {
        key: row[key]
        for key in (
            "id",
            "name",
            "parent_id",
            "icon",
            "color",
            "sort_order",
            "is_system",
            "trashed_at",
            "created_at",
            "updated_at",
        )
    }
    return json.dumps(
        {"row": projected},
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("ascii")


def folder_index_target(identity: str) -> ContainedProjectionActionField:
    """Build the INDEX_REPLACE target path for a folder identity."""
    return ContainedProjectionActionField(f"index/folders/id/{identity}")


class EntityCommand:
    """Pure factory for MutationRequest — no DB access, no lease.

    All create/update/delete methods build a MutationRequest using the
    canonical ``entity.*`` name convention expected by
    ``compile_catalog_entity_command``.  Unknown payload fields flow through
    to the compiler where they are rejected by ``_require_payload_fields``.
    """

    def __init__(self, catalog: CompiledEntityCatalog) -> None:
        self._catalog = catalog

    # -- public API ---------------------------------------------------------

    def create(
        self,
        scope: SpaceRuntimeHandle,
        entity_type: str,
        payload: Mapping[str, object],
        expected_version: int | None,
    ) -> MutationRequest:
        spec = self._catalog.get(entity_type)
        return self._build_create(spec, payload, expected_version)

    def update(
        self,
        scope: SpaceRuntimeHandle,
        entity_type: str,
        entity_id: str,
        patch: Mapping[str, object],
        expected_version: int | None,
    ) -> MutationRequest:
        spec = self._catalog.get(entity_type)
        return self._build_update(spec, entity_id, patch, expected_version)

    def delete(
        self,
        scope: SpaceRuntimeHandle,
        entity_type: str,
        entity_id: str,
        expected_version: int | None,
    ) -> MutationRequest:
        spec = self._catalog.get(entity_type)
        return self._build_delete(spec, entity_id, expected_version)

    def from_sync_event(self, scope: SpaceRuntimeHandle, event: SyncEventLike) -> MutationRequest:
        spec = self._catalog.get_by_sync_key(event.entity_type)
        payload = dict(event.payload)
        supplied_id = payload.get(spec.primary_key)
        if supplied_id is not None and supplied_id != event.entity_id:
            raise MutationRuleViolation(
                "entity_id_mismatch",
                {"entityId": event.entity_id, "field": spec.primary_key},
            )
        expected = event.expected_version
        client_ts = event.client_updated_at
        if client_ts is None:
            raise ValueError("sync event client_updated_at must not be None")
        validate_canonical_timestamp(client_ts)
        if event.action == "create":
            payload[spec.primary_key] = event.entity_id
            return self._build_create(spec, payload, expected, client_updated_at=client_ts)
        if event.action == "update":
            payload.pop(spec.primary_key, None)
            return self._build_update(
                spec, event.entity_id, payload, expected, client_updated_at=client_ts
            )
        if event.action == "delete":
            if payload and payload != {spec.primary_key: event.entity_id}:
                raise MutationRuleViolation(
                    "delete_payload_not_empty",
                    {"entityId": event.entity_id},
                )
            return self._build_delete(
                spec, event.entity_id, expected, client_updated_at=client_ts
            )
        raise ValueError(f"unsupported sync action: {event.action!r}")

    # -- private helpers ----------------------------------------------------

    def _build_create(
        self,
        spec: EntitySpec,
        payload: Mapping[str, object],
        expected_version: int | None,
        *,
        client_updated_at: str | None = None,
    ) -> MutationRequest:
        entity_id = payload[spec.primary_key]
        return MutationRequest.from_payload(
            name="entity.create",
            entity_type=spec.name,
            entity_id=entity_id,
            payload=payload,
            expected_version=expected_version,
            client_updated_at=client_updated_at,
        )

    def _build_update(
        self,
        spec: EntitySpec,
        entity_id: str,
        patch: Mapping[str, object],
        expected_version: int | None,
        *,
        client_updated_at: str | None = None,
    ) -> MutationRequest:
        return MutationRequest.from_payload(
            name="entity.update",
            entity_type=spec.name,
            entity_id=entity_id,
            payload=patch,
            expected_version=expected_version,
            client_updated_at=client_updated_at,
        )

    def _build_delete(
        self,
        spec: EntitySpec,
        entity_id: str,
        expected_version: int | None,
        *,
        client_updated_at: str | None = None,
    ) -> MutationRequest:
        return MutationRequest.from_payload(
            name="entity.delete",
            entity_type=spec.name,
            entity_id=entity_id,
            payload={},
            expected_version=expected_version,
            client_updated_at=client_updated_at,
        )


class FolderDomainPolicy:
    """Domain policy for folder entities.

    Responsibilities:
    * Parent existence and active (non-trashed) check on create/update.
    * Cycle detection on update.
    * Cascade soft delete: trash the folder and all descendants.
    * INDEX_REPLACE projection injection — required by ``_required_projection_tags``
      for folder entities.  ``compile_catalog_entity_command`` returns commands
      with ``projections=()``, so this policy must rebuild the command with
      projections via ``MutationCommand.from_effects`` (HMAC prevents
      ``dataclasses.replace``).
    """

    @property
    def entity_types(self) -> frozenset[str]:
        return frozenset({"folder"})

    async def compile(
        self,
        context: MutationCompileContext,
        request: MutationRequest,
    ) -> MutationCommand:
        if request.name == "entity.create":
            parent_id = request.payload.get("parent_id")
            await self._require_parent_active(context, parent_id)
            base = await compile_catalog_entity_command(context, request)
            return self._with_folder_projection(context, base)
        if request.name == "entity.update":
            parent_id = request.payload.get("parent_id")
            if parent_id is not None:
                await self._require_parent_active(context, parent_id)
                self._require_no_cycle(context, request.entity_id, str(parent_id))
            base = await compile_catalog_entity_command(context, request)
            return self._with_folder_projection(context, base)
        if request.name == "entity.delete":
            return await self._compile_cascade_soft_delete(context, request)
        raise ValueError(f"unsupported folder mutation request: {request.name}")

    # -- invariant checks ---------------------------------------------------

    async def _require_parent_active(
        self,
        context: MutationCompileContext,
        parent_id: object,
    ) -> None:
        if parent_id is None:
            return
        row = context.authority.row("folder", parent_id)
        if row is None:
            raise MutationRuleViolation(
                "not_found",
                {"entityId": str(parent_id), "field": "parent_id"},
            )
        if row.get("trashed_at") is not None:
            raise MutationRuleViolation(
                "cycle_detected",
                {"entityId": str(parent_id), "field": "parent_id"},
            )

    def _require_no_cycle(
        self,
        context: MutationCompileContext,
        entity_id: str,
        new_parent_id: str,
    ) -> None:
        if new_parent_id == entity_id:
            raise MutationRuleViolation("cycle_detected", {"entityId": entity_id})
        visited: set[str] = {entity_id}
        current: str | None = new_parent_id
        while current is not None:
            if current in visited:
                raise MutationRuleViolation("cycle_detected", {"entityId": entity_id})
            visited.add(current)
            row = context.authority.row("folder", current)
            if row is None:
                break
            current = row.get("parent_id")
            if current is not None:
                current = str(current)

    # -- projection injection -----------------------------------------------

    def _with_folder_projection(
        self,
        context: MutationCompileContext,
        base: MutationCommand,
    ) -> MutationCommand:
        """Rebuild *base* with an INDEX_REPLACE projection for the folder row."""
        spec = context.catalog.get("folder")
        plan = base.db_plans[0]
        identity = str(plan.primary_key[spec.primary_key])
        target = folder_index_target(identity)
        before = context.authority.derived_projection(
            ProjectionActionTag.INDEX_REPLACE,
            str(target),
        )
        after = serialize_folder_index_row(plan.after_row)
        projection = ProjectionPlan(
            tag=ProjectionActionTag.INDEX_REPLACE,
            source=None,
            target=target,
            ordinal=0,
            before=before,
            after=after,
        )
        return context.command(
            request=base.request,
            db_plans=base.db_plans,
            sync_events=base.sync_events,
            value=base.result_value,
            projections=(projection,),
            resolution=base.resolution,
        )

    # -- cascade soft delete ------------------------------------------------

    def _children_of(
        self,
        context: MutationCompileContext,
        folder_id: str,
    ) -> list[str]:
        """Find all non-trashed children of *folder_id* from the authority overlay."""
        return [
            str(row_id)
            for (entity_type, row_id), row in context.authority._rows.items()
            if entity_type == "folder"
            and row.get("parent_id") is not None
            and str(row["parent_id"]) == folder_id
            and row.get("trashed_at") is None
        ]

    def _find_descendants(
        self,
        context: MutationCompileContext,
        folder_id: str,
    ) -> list[str]:
        result: list[str] = []
        for child_id in self._children_of(context, folder_id):
            result.append(child_id)
            result.extend(self._find_descendants(context, child_id))
        return result

    async def _compile_cascade_soft_delete(
        self,
        context: MutationCompileContext,
        request: MutationRequest,
    ) -> MutationCommand:
        spec = context.catalog.get("folder")
        if request.payload:
            raise MutationRuleViolation(
                "delete_payload_not_empty",
                {"entityId": request.entity_id},
            )
        current = context.authority.row("folder", request.entity_id)
        if current is None:
            raise MutationRuleViolation(
                "not_found",
                {"entityId": request.entity_id},
            )
        resolution = _require_current_version(spec, request, current)

        all_ids = [request.entity_id]
        all_ids.extend(self._find_descendants(context, request.entity_id))

        now = utc_now_iso_ms()
        db_plans: list[DbMutationPlan] = []
        sync_events: list[SyncEventPlan] = []
        projections: list[ProjectionPlan] = []
        root_after: Mapping[str, object] | None = None

        for ordinal, folder_id in enumerate(all_ids):
            row = context.authority.row("folder", folder_id)
            if row is None:
                raise MutationRuleViolation(
                    "not_found",
                    {"entityId": folder_id},
                )
            after = dict(row)
            after["trashed_at"] = now
            after["version"] = (row.get("version") or 0) + 1
            after["updated_at"] = now
            after_frozen = require_frozen_object(after)

            target = folder_index_target(folder_id)
            before_blob = context.authority.derived_projection(
                ProjectionActionTag.INDEX_REPLACE,
                str(target),
            )
            after_blob = serialize_folder_index_row(after_frozen)

            db_plans.append(
                DbMutationPlan(
                    spec.table_name,
                    {spec.primary_key: folder_id},
                    "update",
                    row.get("version"),
                    row,
                    after_frozen,
                )
            )

            if spec.sync_enabled:
                sync_events.append(
                    SyncEventPlan(
                        spec.name,
                        folder_id,
                        "update",
                        after_frozen,
                        after["version"],
                        now,
                    )
                )

            projections.append(
                ProjectionPlan(
                    tag=ProjectionActionTag.INDEX_REPLACE,
                    source=None,
                    target=target,
                    ordinal=ordinal,
                    before=before_blob,
                    after=after_blob,
                )
            )

            if folder_id == request.entity_id:
                root_after = after_frozen

        return context.command(
            request=request,
            db_plans=tuple(db_plans),
            sync_events=tuple(sync_events),
            value=root_after if root_after is not None else after_frozen,
            projections=tuple(projections),
            resolution=resolution,
        )


class RelationDomainPolicy:
    """Domain policy for junction entities: endpoint existence check on create.

    For ``schedule_quick_note``, verifies that both ``schedule_id`` and
    ``quick_note_id`` refer to existing entities before delegating to
    ``compile_catalog_entity_command``.  Junction entities are DB_ONLY and
    do not require projections.
    """

    @property
    def entity_types(self) -> frozenset[str]:
        return frozenset({"schedule_quick_note"})

    async def compile(
        self,
        context: MutationCompileContext,
        request: MutationRequest,
    ) -> MutationCommand:
        endpoints = context.catalog.junction_endpoints_for(request.entity_type)
        if endpoints is not None and request.name == "entity.create":
            for field_name, endpoint_entity_type in endpoints:
                endpoint_id = request.payload.get(field_name)
                if endpoint_id is not None:
                    endpoint_spec = context.catalog.get(endpoint_entity_type)
                    row = context.authority.row(endpoint_entity_type, endpoint_id)
                    if row is None:
                        raise MutationRuleViolation(
                            "relation_endpoint_missing",
                            {"field": field_name, "entityId": str(endpoint_id)},
                        )
                    if endpoint_spec.soft_delete and row.get("trashed_at") is not None:
                        raise MutationRuleViolation(
                            "relation_endpoint_missing",
                            {"field": field_name, "entityId": str(endpoint_id)},
                        )
        return await compile_catalog_entity_command(context, request)
