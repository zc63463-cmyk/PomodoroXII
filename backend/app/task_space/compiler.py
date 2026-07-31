"""Task Space mutation compiler: virtual REST commands and real entity sync."""

from __future__ import annotations

import uuid
from collections.abc import Callable, Mapping
from datetime import datetime, timedelta

from app.errors import thaw_json
from app.mutation.types import (
    DbMutationPlan,
    MutationCommand,
    MutationRequest,
    SyncEventPlan,
    canonical_payload_hash,
)
from app.mutation.unit_of_work import MutationCompileContext
from app.services.time import utc_now_iso_ms
from app.task_space.contracts import (
    SYSTEM_STATUS_IDS,
    SYSTEM_TYPE_ID,
    format_work_item_display_key,
)
from app.task_space.document import InvalidNoteDocument, UnsupportedContentVersion

TASK_SPACE_POLICY_ENTITY_TYPES = frozenset({
    "task_space", "project", "status_definition", "type_definition", "label",
    "work_item_label", "work_item", "work_item_note",
})


def _require_space_scope(context: MutationCompileContext, request: MutationRequest) -> None:
    """Validate that the request's space_id matches the authorised scope.

    This check is raised directly in the Task Space compiler so that
    ``space_scope_mismatch`` appears in the compiler's producer set.
    """
    from app.mutation.types import MutationRuleViolation

    payload_space_id = str(request.payload["space_id"])
    if payload_space_id != context.scope.scope.space_id:
        raise MutationRuleViolation(
            "space_scope_mismatch",
            {"scopeSpaceId": context.scope.scope.space_id, "payloadSpaceId": payload_space_id},
        )


class TaskSpaceCompiler:
    """Owns virtual Task Space REST commands and all seven real entity types.

    Registered as a single ``MutationDomainPolicy`` so that every Task Space
    entity_type is policy-owned; none fall through to the generic catalog
    compiler.
    """

    namespace = "task_space."
    entity_types = TASK_SPACE_POLICY_ENTITY_TYPES

    def __init__(self, now_iso_ms: Callable[[], str] = utc_now_iso_ms) -> None:
        self.now_iso_ms = now_iso_ms

    async def compile(
        self,
        context: MutationCompileContext,
        request: MutationRequest,
    ) -> MutationCommand:
        try:
            if not request.name.startswith(self.namespace):
                return await self.compile_sync_entity(context, request)
            _require_space_scope(context, request)
            handler_name = request.name.removeprefix(self.namespace)
            handler = getattr(self, f"compile_{handler_name}", None)
            if handler is None:
                raise RuntimeError(f"unregistered closed Task Space command: {request.name}")
            return await handler(context, request)
        except UnsupportedContentVersion as exc:
            from app.mutation.types import MutationRuleViolation

            raise MutationRuleViolation(
                "unsupported_content_version",
                {"reason": str(exc)},
                retryable=False,
            ) from exc
        except InvalidNoteDocument as exc:
            from app.mutation.types import MutationRuleViolation

            raise MutationRuleViolation(
                "invalid_note_document", {"reason": str(exc)}, retryable=False
            ) from exc


# -- read-only sync entity rejection -----------------------------------------

READ_ONLY_SYNC_TYPES = frozenset({
    "project", "status_definition", "type_definition", "label",
    "work_item_label",
})
ENTITY_ACTIONS = frozenset({"entity.create", "entity.update", "entity.delete"})


def _reject_formal_sync(request: MutationRequest, reason: str):
    from app.mutation.types import MutationRuleViolation

    raise MutationRuleViolation(
        "offline_formal_creation_forbidden",
        {"entity_type": request.entity_type, "reason": reason},
        retryable=False,
    )


async def _compile_sync_entity(self, context, request):
    if request.name not in ENTITY_ACTIONS:
        raise RuntimeError(f"unregistered EntityCommand action: {request.name}")
    if request.entity_type in READ_ONLY_SYNC_TYPES:
        _reject_formal_sync(request, "typed_command_required")
    if request.entity_type == "work_item":
        return await self.compile_sync_work_item(context, request)
    if request.entity_type == "work_item_note":
        return await self.compile_sync_work_item_note(context, request)
    raise RuntimeError(f"unowned Task Space entity: {request.entity_type}")


TaskSpaceCompiler.compile_sync_entity = _compile_sync_entity


# -- CreateProject compilation -----------------------------------------------

TASK_SPACE_NAMESPACE = uuid.UUID("2d20283e-826f-45d2-9993-cf6609987aaa")


def _stable_id(kind: str, command_id: str) -> str:
    return uuid.uuid5(TASK_SPACE_NAMESPACE, f"{kind}\0{command_id}").hex


async def _compile_CreateProject(self, context, request):
    from app.mutation.types import MutationRuleViolation
    from app.task_space.contracts import normalize_project_key

    overlay = context.authority
    try:
        key = normalize_project_key(str(request.payload["key"]))
    except ValueError as exc:
        raise MutationRuleViolation(
            "invalid_project_key",
            {"key": str(request.payload["key"])},
            retryable=False,
        ) from exc
    if any(str(row["key"]) == key for row in overlay.rows("project")):
        raise MutationRuleViolation("project_key_conflict", {"key": key}, retryable=False)
    project_id = _stable_id("project", str(request.payload["command_id"]))
    now = self.now_iso_ms()
    after = {
        "id": project_id,
        "key": key,
        "name": str(request.payload["name"]).strip(),
        "description": request.payload.get("description"),
        "rank": len(overlay.rows("project")),
        "next_work_item_number": 1,
        "default_status_definition_id": SYSTEM_STATUS_IDS["not_started"],
        "default_type_definition_id": SYSTEM_TYPE_ID,
        "archived_at": None,
        "created_at": now,
        "updated_at": now,
        "version": 1,
    }
    plan = DbMutationPlan("projects", {"id": project_id}, "insert", None, None, after)
    event = SyncEventPlan("project", project_id, "create", after, 1, now)
    return context.command(
        request=request,
        db_plans=(plan,),
        sync_events=(event,),
        value=after,
    )


TaskSpaceCompiler.compile_CreateProject = _compile_CreateProject


# -- WorkItem Sync field sets -------------------------------------------------

WORK_ITEM_SYNC_FIELDS = frozenset({
    "id", "project_id", "display_key", "title", "description",
    "type_definition_id", "status_definition_id", "priority", "parent_id",
    "child_rank", "completion_window_start", "completion_window_end",
    "review_point", "hard_deadline", "effort_estimate_lower_seconds",
    "effort_estimate_upper_seconds", "effort_actual_seconds", "confidence",
    "completed_at", "cancelled_at", "archived_at", "marked_as_attention",
    "created_at", "updated_at", "version",
})
WORK_ITEM_SCALAR_FIELDS = frozenset({
    "title", "description", "type_definition_id", "priority",
    "completion_window_start", "completion_window_end", "review_point",
    "hard_deadline", "effort_estimate_lower_seconds",
    "effort_estimate_upper_seconds", "confidence", "archived_at",
    "marked_as_attention",
})
WORK_ITEM_MOVE_FIELDS = frozenset({"project_id", "parent_id", "child_rank"})
WORK_ITEM_STATUS_FIELDS = frozenset({
    "status_definition_id", "completed_at", "cancelled_at",
})
WORK_ITEM_IMMUTABLE_FIELDS = frozenset({
    "display_key", "effort_actual_seconds", "created_at",
})


def _monotonic_updated_at(previous: str, candidate: str) -> str:
    if candidate > previous:
        return candidate
    timestamp = datetime.fromisoformat(previous.removesuffix("Z") + "+00:00")
    return (timestamp + timedelta(milliseconds=1)).isoformat(
        timespec="milliseconds"
    ).replace("+00:00", "Z")


def _require_expected_version(
    item: Mapping[str, object], expected_version: int | None
) -> None:
    if int(item["version"]) != expected_version:
        from app.mutation.types import MutationRuleViolation

        raise MutationRuleViolation(
            "version_conflict",
            {"current_version": item["version"]},
            retryable=False,
        )


def _work_item_update_command(context, request, before, after, timestamp):
    plan = DbMutationPlan(
        "work_items",
        {"id": before["id"]},
        "update",
        request.expected_version,
        before,
        after,
    )
    event = SyncEventPlan(
        "work_item",
        str(before["id"]),
        "update",
        after,
        int(after["version"]),
        timestamp,
    )
    return context.command(
        request=request,
        db_plans=(plan,),
        sync_events=(event,),
        value=after,
    )


# -- Tree helpers -------------------------------------------------------------


def _require_row(overlay, entity_type: str, entity_id: str) -> dict[str, object]:
    row = overlay.row(entity_type, entity_id)
    if row is None:
        from app.mutation.types import MutationRuleViolation

        raise MutationRuleViolation(
            "not_found",
            {"entity_type": entity_type, "id": entity_id},
            retryable=False,
        )
    return dict(row)


def _parent_depth(overlay, parent_id: str | None, project_id: str) -> int:
    depth = 0
    current = parent_id
    visited: set[str] = set()
    while current is not None:
        if current in visited:
            from app.mutation.types import MutationRuleViolation

            raise MutationRuleViolation(
                "invalid_work_item_tree", {"reason": "cycle"}, retryable=False
            )
        visited.add(current)
        parent = _require_row(overlay, "work_item", current)
        if parent["project_id"] != project_id:
            from app.mutation.types import MutationRuleViolation

            raise MutationRuleViolation(
                "invalid_work_item_tree",
                {"reason": "cross_project_parent"},
                retryable=False,
            )
        depth += 1
        current = parent["parent_id"]
    return depth


def _descendants(overlay, root_id: str) -> tuple[dict[str, object], ...]:
    rows = tuple(dict(row) for row in overlay.rows("work_item"))
    output: list[dict[str, object]] = []
    frontier = [root_id]
    while frontier:
        parent = frontier.pop()
        children = [row for row in rows if row["parent_id"] == parent]
        output.extend(children)
        frontier.extend(str(row["id"]) for row in children)
    return tuple(output)


def _subtree_relative_depth(overlay, root_id: str) -> int:
    rows = _descendants(overlay, root_id)
    if not rows:
        return 1
    parent_by_id = {str(row["id"]): row["parent_id"] for row in rows}
    maximum = 1
    for row in rows:
        depth = 2
        parent = row["parent_id"]
        while parent in parent_by_id:
            depth += 1
            parent = parent_by_id[str(parent)]
        maximum = max(maximum, depth)
    return maximum


# -- CreateWorkItem -----------------------------------------------------------


async def _compile_CreateWorkItem(self, context, request):
    overlay = context.authority
    project = _require_row(overlay, "project", str(request.payload["project_id"]))
    parent_id = request.payload.get("parent_id")
    parent_depth = _parent_depth(overlay, parent_id, str(project["id"]))
    if parent_depth >= 3:
        from app.mutation.types import MutationRuleViolation

        raise MutationRuleViolation(
            "invalid_work_item_tree",
            {"reason": "depth_exceeds_three"},
            retryable=False,
        )
    number = int(project["next_work_item_number"])
    work_item_id = _stable_id("work_item", str(request.payload["command_id"]))
    now = _monotonic_updated_at(str(project["updated_at"]), self.now_iso_ms())
    type_definition_id = (
        request.payload.get("type_definition_id")
        or project["default_type_definition_id"]
    )
    status_definition_id = (
        request.payload.get("status_definition_id")
        or project["default_status_definition_id"]
    )
    _require_row(overlay, "type_definition", str(type_definition_id))
    status_definition = _require_row(
        overlay, "status_definition", str(status_definition_id)
    )
    status_definition_id = status_definition["id"]
    status_category = str(status_definition["category"])
    project_after = {
        **project,
        "next_work_item_number": number + 1,
        "updated_at": now,
        "version": int(project["version"]) + 1,
    }
    item_after = {
        "id": work_item_id,
        "project_id": project["id"],
        "display_key": format_work_item_display_key(str(project["key"]), number),
        "title": str(request.payload["title"]).strip(),
        "description": request.payload.get("description"),
        "type_definition_id": type_definition_id,
        "status_definition_id": status_definition_id,
        "priority": request.payload.get("priority"),
        "parent_id": parent_id,
        "child_rank": len([
            row
            for row in overlay.rows("work_item")
            if row["project_id"] == project["id"] and row["parent_id"] == parent_id
        ]),
        "completion_window_start": None,
        "completion_window_end": None,
        "review_point": None,
        "hard_deadline": None,
        "effort_estimate_lower_seconds": None,
        "effort_estimate_upper_seconds": None,
        "effort_actual_seconds": 0,
        "confidence": None,
        "completed_at": now if status_category == "completed" else None,
        "cancelled_at": now if status_category == "cancelled" else None,
        "archived_at": None,
        "marked_as_attention": False,
        "created_at": now,
        "updated_at": now,
        "version": 1,
    }
    plans = (
        DbMutationPlan(
            "projects", {"id": project["id"]}, "update",
            int(project["version"]), project, project_after,
        ),
        DbMutationPlan(
            "work_items", {"id": work_item_id}, "insert", None, None, item_after,
        ),
    )
    events = (
        SyncEventPlan(
            "project", str(project["id"]), "update",
            project_after, int(project_after["version"]), now,
        ),
        SyncEventPlan("work_item", work_item_id, "create", item_after, 1, now),
    )
    return context.command(
        request=request,
        db_plans=plans,
        sync_events=events,
        value=item_after,
    )


TaskSpaceCompiler.compile_CreateWorkItem = _compile_CreateWorkItem


# -- UpdateWorkItem -----------------------------------------------------------


async def _compile_UpdateWorkItem(self, context, request):
    overlay = context.authority
    item = _require_row(overlay, "work_item", request.entity_id)
    _require_expected_version(item, request.expected_version)
    patch = dict(request.payload["patch"])
    unexpected = set(patch) - WORK_ITEM_SCALAR_FIELDS
    if unexpected:
        raise RuntimeError(f"unregistered WorkItem patch fields: {sorted(unexpected)}")
    if patch.get("type_definition_id") is not None:
        _require_row(overlay, "type_definition", str(patch["type_definition_id"]))
    now = _monotonic_updated_at(str(item["updated_at"]), self.now_iso_ms())
    after = {
        **item,
        **patch,
        "updated_at": now,
        "version": int(item["version"]) + 1,
    }
    return _work_item_update_command(context, request, item, after, now)


TaskSpaceCompiler.compile_UpdateWorkItem = _compile_UpdateWorkItem


# -- MoveWorkItem -------------------------------------------------------------


async def _compile_MoveWorkItem(self, context, request):
    overlay = context.authority
    item = _require_row(overlay, "work_item", request.entity_id)
    _require_expected_version(item, request.expected_version)
    requested_project_id = str(request.payload["project_id"])
    _require_row(overlay, "project", requested_project_id)
    if requested_project_id != str(item["project_id"]):
        from app.mutation.types import MutationRuleViolation

        raise MutationRuleViolation(
            "invalid_work_item_tree",
            {"reason": "cross_project_move"},
            retryable=False,
        )
    parent_id = request.payload.get("new_parent_id")
    if parent_id is not None:
        parent = _require_row(overlay, "work_item", str(parent_id))
        if str(parent["project_id"]) != requested_project_id:
            from app.mutation.types import MutationRuleViolation

            raise MutationRuleViolation(
                "invalid_work_item_tree",
                {"reason": "cross_project_parent"},
                retryable=False,
            )
    if parent_id == item["id"] or parent_id in {
        row["id"] for row in _descendants(overlay, str(item["id"]))
    }:
        from app.mutation.types import MutationRuleViolation

        raise MutationRuleViolation(
            "invalid_work_item_tree", {"reason": "cycle"}, retryable=False
        )
    new_parent_depth = _parent_depth(overlay, parent_id, str(item["project_id"]))
    if new_parent_depth + _subtree_relative_depth(overlay, str(item["id"])) > 3:
        from app.mutation.types import MutationRuleViolation

        raise MutationRuleViolation(
            "invalid_work_item_tree", {"reason": "subtree_depth"}, retryable=False
        )
    now = _monotonic_updated_at(str(item["updated_at"]), self.now_iso_ms())
    after = {
        **item,
        "parent_id": parent_id,
        "child_rank": int(request.payload["child_rank"]),
        "updated_at": now,
        "version": int(item["version"]) + 1,
    }
    return _work_item_update_command(context, request, item, after, now)


TaskSpaceCompiler.compile_MoveWorkItem = _compile_MoveWorkItem


# -- TransitionWorkItem with Session envelope fence ---------------------------


async def _compile_TransitionWorkItem(self, context, request):
    overlay = context.authority
    context.require_session_envelope_dispatch_claim(
        request,
        {
            "complete": SYSTEM_STATUS_IDS["completed"],
            "cancel": SYSTEM_STATUS_IDS["cancelled"],
        },
    )
    item = _require_row(overlay, "work_item", request.entity_id)
    status = _require_row(
        overlay, "status_definition", str(request.payload["status_definition_id"])
    )
    _require_expected_version(item, request.expected_version)
    item_depth = _parent_depth(
        overlay, item["parent_id"], str(item["project_id"])
    ) + 1
    if status["category"] == "completed" and item_depth == 2:
        active_categories = {"not_started", "in_progress", "paused", "waiting"}
        statuses = {
            row["id"]: row["category"] for row in overlay.rows("status_definition")
        }
        active_children = [
            row["id"] for row in overlay.rows("work_item")
            if row["parent_id"] == item["id"]
            and statuses[row["status_definition_id"]] in active_categories
        ]
        if active_children:
            from app.mutation.types import MutationRuleViolation

            raise MutationRuleViolation(
                "active_child_conflict",
                {"work_item_ids": active_children},
                retryable=False,
            )
    now = _monotonic_updated_at(str(item["updated_at"]), self.now_iso_ms())
    category = str(status["category"])
    after = {
        **item,
        "status_definition_id": status["id"],
        "completed_at": now if category == "completed" else None,
        "cancelled_at": now if category == "cancelled" else None,
        "updated_at": now,
        "version": int(item["version"]) + 1,
    }
    return _work_item_update_command(context, request, item, after, now)


TaskSpaceCompiler.compile_TransitionWorkItem = _compile_TransitionWorkItem


# -- WorkItem Sync entity compilation -----------------------------------------


def _reject_work_item_sync(reason: str, **details) -> None:
    from app.mutation.types import MutationRuleViolation

    raise MutationRuleViolation(
        "work_item_structure_changed",
        {"reason": reason, **details},
        retryable=False,
    )


def _typed_sync_request(
    context,
    original: MutationRequest,
    handler_name: str,
    payload: Mapping[str, object],
) -> MutationRequest:
    return MutationRequest.from_payload(
        name=f"task_space.{handler_name}",
        entity_type="task_space",
        entity_id=original.entity_id,
        payload={
            "command_id": context.operation_id,
            "space_id": context.scope.scope.space_id,
            "payload_hash": canonical_payload_hash(payload),
            **payload,
        },
        expected_version=original.expected_version,
        client_updated_at=None,
    )


def _retain_sync_request(
    context, original: MutationRequest, planned: MutationCommand
):
    return context.command(
        request=original,
        db_plans=planned.db_plans,
        projections=planned.projections,
        sync_events=planned.sync_events,
        value=planned.result_value,
    )


def _full_work_item_sync_candidate(
    request: MutationRequest,
    before: Mapping[str, object],
) -> dict[str, object]:
    from app.mutation.types import MutationRuleViolation

    expected_payload_fields = WORK_ITEM_SYNC_FIELDS - {"id"}
    actual_fields = set(request.payload)
    if actual_fields != expected_payload_fields:
        _reject_work_item_sync(
            "full_post_image_required",
            missing=sorted(expected_payload_fields - actual_fields),
            extra=sorted(actual_fields - expected_payload_fields),
        )
    if int(before["version"]) != request.expected_version:
        raise MutationRuleViolation(
            "version_conflict",
            {"current_version": before["version"]},
            retryable=False,
        )
    candidate = {"id": request.entity_id, **dict(request.payload)}
    if candidate["id"] != before["id"]:
        _reject_work_item_sync("entity_id_changed")
    version = candidate["version"]
    if type(version) is not int or version != int(before["version"]) + 1:
        _reject_work_item_sync("invalid_candidate_version")
    if candidate["updated_at"] != request.client_updated_at:
        _reject_work_item_sync("updated_at_not_client_timestamp")
    return candidate


async def _compile_sync_work_item(self, context, request):
    if request.name != "entity.update":
        _reject_formal_sync(request, "typed_create_or_delete_required")

    before = _require_row(context.authority, "work_item", request.entity_id)
    candidate = _full_work_item_sync_candidate(request, before)
    semantic_changes = {
        field
        for field in WORK_ITEM_SYNC_FIELDS - {"id", "version", "updated_at"}
        if candidate[field] != before[field]
    }
    immutable_changes = semantic_changes & WORK_ITEM_IMMUTABLE_FIELDS
    if immutable_changes:
        _reject_work_item_sync(
            "server_managed_field_changed", fields=sorted(immutable_changes)
        )

    scalar_changes = semantic_changes & WORK_ITEM_SCALAR_FIELDS
    move_changes = semantic_changes & WORK_ITEM_MOVE_FIELDS
    status_changes = semantic_changes & WORK_ITEM_STATUS_FIELDS
    known = (
        scalar_changes | move_changes | status_changes | WORK_ITEM_IMMUTABLE_FIELDS
    )
    unknown = semantic_changes - known
    if unknown:
        _reject_work_item_sync("unowned_field_changed", fields=sorted(unknown))
    if status_changes and "status_definition_id" not in status_changes:
        _reject_work_item_sync("status_projection_changed_without_transition")
    families = tuple(
        name
        for name, fields in (
            ("scalar", scalar_changes),
            ("move", move_changes),
            ("status", status_changes),
        )
        if fields
    )
    if len(families) != 1:
        _reject_work_item_sync(
            "exactly_one_operation_family_required", families=families
        )

    family = families[0]
    if family == "scalar":
        typed = _typed_sync_request(
            context,
            request,
            "UpdateWorkItem",
            {"patch": {field: candidate[field] for field in scalar_changes}},
        )
        planned = await _compile_UpdateWorkItem(self, context, typed)
    elif family == "move":
        if type(candidate["child_rank"]) is not int or candidate["child_rank"] < 0:
            _reject_work_item_sync("invalid_child_rank")
        typed = _typed_sync_request(
            context,
            request,
            "MoveWorkItem",
            {
                "project_id": candidate["project_id"],
                "new_parent_id": candidate["parent_id"],
                "child_rank": candidate["child_rank"],
            },
        )
        planned = await _compile_MoveWorkItem(self, context, typed)
    else:
        typed = _typed_sync_request(
            context,
            request,
            "TransitionWorkItem",
            {"status_definition_id": candidate["status_definition_id"]},
        )
        planned = await _compile_TransitionWorkItem(self, context, typed)
    return _retain_sync_request(context, request, planned)


TaskSpaceCompiler.compile_sync_work_item = _compile_sync_work_item


# -- WorkItemNote canonical row loading and post-image compilation -------------

import json as _json

from app.task_space.document import (
    append_blocks as _append_blocks,
)
from app.task_space.document import (
    canonical_document_json as _canonical_document_json,
)
from app.task_space.document import (
    parse_document_v1 as _parse_document_v1,
)
from app.task_space.document import (
    set_checklist_item_checked as _set_checklist_item_checked,
)


def _note_for_work_item(overlay, work_item_id: str) -> dict[str, object] | None:
    matches = [
        dict(row) for row in overlay.rows("work_item_note")
        if str(row["work_item_id"]) == work_item_id
    ]
    if len(matches) > 1:
        from app.mutation.types import MutationRuleViolation

        raise MutationRuleViolation(
            "invalid_note_document",
            {"reason": "duplicate_note_rows"},
            retryable=False,
        )
    return matches[0] if matches else None


def _note_command(self, context, request, transform):
    overlay = context.authority
    _require_row(overlay, "work_item", str(request.payload["work_item_id"]))
    before = _note_for_work_item(overlay, str(request.payload["work_item_id"]))
    if before is None:
        if request.expected_version is not None:
            from app.mutation.types import MutationRuleViolation

            raise MutationRuleViolation(
                "version_conflict", {"current_version": None}, retryable=False
            )
        note_id = _stable_id("work_item_note", str(request.payload["work_item_id"]))
        current = None
        next_version = 1
        operation = "insert"
    else:
        if int(before["version"]) != request.expected_version:
            from app.mutation.types import MutationRuleViolation

            raise MutationRuleViolation(
                "version_conflict",
                {
                    "current_version": before["version"],
                    "current_document": _json.loads(
                        str(before["document_json"])
                    ),
                },
                retryable=False,
            )
        note_id = str(before["id"])
        current = _parse_document_v1(_json.loads(str(before["document_json"])))
        next_version = int(before["version"]) + 1
        operation = "update"
    document = transform(current)
    candidate_now = request.client_updated_at or self.now_iso_ms()
    now = (
        candidate_now
        if before is None
        else _monotonic_updated_at(str(before["updated_at"]), candidate_now)
    )
    after = {
        "id": note_id,
        "work_item_id": request.payload["work_item_id"],
        "document_json": _canonical_document_json(document),
        "created_at": before["created_at"] if before else now,
        "updated_at": now,
        "version": next_version,
    }
    plan = DbMutationPlan(
        "work_item_notes", {"id": note_id}, operation,
        request.expected_version, before, after,
    )
    event = SyncEventPlan(
        "work_item_note", note_id, "create" if before is None else "update",
        after, next_version, now,
    )
    return context.command(
        request=request,
        db_plans=(plan,),
        sync_events=(event,),
        value=after,
    )


async def _compile_ReplaceDocument(self, context, request):
    raw = thaw_json(request.payload["document"])
    document = _parse_document_v1(raw)
    return _note_command(self, context, request, lambda current: document)


async def _compile_AppendBlocks(self, context, request):
    def transform(current):
        if current is None:
            from app.mutation.types import MutationRuleViolation

            raise MutationRuleViolation(
                "not_found", {"entity_type": "work_item_note"}, retryable=False
            )
        blocks = tuple(thaw_json(block) for block in request.payload["blocks"])
        return _append_blocks(current, blocks)

    return _note_command(self, context, request, transform)


async def _compile_ToggleChecklistItem(self, context, request):
    def transform(current):
        if current is None:
            from app.mutation.types import MutationRuleViolation

            raise MutationRuleViolation(
                "not_found", {"entity_type": "work_item_note"}, retryable=False
            )
        return _set_checklist_item_checked(
            current,
            str(request.payload["item_id"]),
            bool(request.payload["checked"]),
        )

    return _note_command(self, context, request, transform)


TaskSpaceCompiler.compile_ReplaceDocument = _compile_ReplaceDocument
TaskSpaceCompiler.compile_AppendBlocks = _compile_AppendBlocks
TaskSpaceCompiler.compile_ToggleChecklistItem = _compile_ToggleChecklistItem


# -- WorkItemNote Sync entity compilation -------------------------------------

NOTE_SYNC_FIELDS = frozenset({
    "id", "work_item_id", "document_json", "created_at", "updated_at", "version",
})


def _invalid_sync_note(reason: str, **details) -> None:
    raise InvalidNoteDocument(_json.dumps(
        {"reason": reason, **details}, sort_keys=True, separators=(",", ":")
    ))


def _sync_note_document(request, before):
    expected_fields = (
        NOTE_SYNC_FIELDS
        if request.name == "entity.create"
        else NOTE_SYNC_FIELDS - {"id"}
    )
    actual_fields = set(request.payload)
    if actual_fields != expected_fields:
        _invalid_sync_note(
            "full_post_image_required",
            missing=sorted(expected_fields - actual_fields),
            extra=sorted(actual_fields - expected_fields),
        )
    candidate = {"id": request.entity_id, **dict(request.payload)}
    version = candidate["version"]
    if type(version) is not int:
        _invalid_sync_note("version_must_be_integer")
    if candidate["updated_at"] != request.client_updated_at:
        _invalid_sync_note("updated_at_not_client_timestamp")
    if not isinstance(candidate["document_json"], str):
        _invalid_sync_note("document_json_must_be_string")
    try:
        document = _parse_document_v1(_json.loads(candidate["document_json"]))
    except (TypeError, _json.JSONDecodeError) as exc:
        raise InvalidNoteDocument(
            "document_json must be canonical JSON"
        ) from exc
    if _canonical_document_json(document) != candidate["document_json"]:
        _invalid_sync_note("document_json_not_canonical")

    if request.name == "entity.create":
        expected_id = _stable_id("work_item_note", str(candidate["work_item_id"]))
        if request.expected_version is not None or version != 1:
            _invalid_sync_note("invalid_create_version")
        if candidate["id"] != expected_id:
            _invalid_sync_note("noncanonical_note_identity")
        if candidate["created_at"] != request.client_updated_at:
            _invalid_sync_note("created_at_not_client_timestamp")
    else:
        if before is None:
            from app.mutation.types import MutationRuleViolation

            raise MutationRuleViolation(
                "not_found", {"entity_type": "work_item_note"}, retryable=False
            )
        if str(before["id"]) != request.entity_id:
            _invalid_sync_note("note_identity_changed")
        if str(before["work_item_id"]) != str(candidate["work_item_id"]):
            _invalid_sync_note("note_owner_changed")
        if candidate["created_at"] != before["created_at"]:
            _invalid_sync_note("created_at_changed")
        if int(before["version"]) != request.expected_version:
            from app.mutation.types import MutationRuleViolation

            raise MutationRuleViolation(
                "version_conflict",
                {
                    "current_version": before["version"],
                    "current_document": _json.loads(
                        str(before["document_json"])
                    ),
                },
                retryable=False,
            )
        if version != int(before["version"]) + 1:
            _invalid_sync_note("invalid_candidate_version")
    return candidate, document


async def _compile_sync_work_item_note(self, context, request):
    if request.name == "entity.delete":
        _reject_formal_sync(request, "note_delete_requires_future_typed_command")
    if request.name not in {"entity.create", "entity.update"}:
        raise RuntimeError(f"unregistered WorkItemNote action: {request.name}")

    owner_id = str(request.payload.get("work_item_id", ""))
    before = _note_for_work_item(context.authority, owner_id) if owner_id else None
    candidate, document = _sync_note_document(request, before)
    return _note_command(self, context, request, lambda current: document)


TaskSpaceCompiler.compile_sync_work_item_note = _compile_sync_work_item_note
