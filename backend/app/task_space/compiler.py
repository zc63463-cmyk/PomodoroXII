"""Task Space mutation compiler: virtual REST commands and real entity sync."""

from __future__ import annotations

import uuid
from collections.abc import Callable, Mapping
from datetime import datetime, timedelta
from types import MappingProxyType

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
    # This is the server-owned declaration consumed by FocusSession review
    # envelopes.  It is deliberately separate from caller payloads: the
    # review command may request a transition, but it cannot choose whether
    # that transition is safe to replay.
    REPLAY_SAFE_TRANSITIONS = MappingProxyType({
        "complete": True,
        "cancel": True,
    })

    @classmethod
    def replay_safe_policy(cls) -> Mapping[str, bool]:
        """Return the immutable server declaration for transition envelopes."""
        return cls.REPLAY_SAFE_TRANSITIONS

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
    "project", "status_definition", "type_definition",
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
    "created_at", "updated_at", "version", "label_ids",
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
# D5 Y: the label_ids projection is a virtual post-image field (never a DB
# column).  The junction table is the server-side projection source.
WORK_ITEM_LABELS_FIELDS = frozenset({"label_ids"})
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
    # D5 Y: every workItem post-image carries the label_ids projection (the
    # junction table is the projection source; the DB row never has the field).
    post = {
        **after,
        "label_ids": _label_ids_for_work_item(context.authority, str(before["id"])),
    }
    event = SyncEventPlan(
        "work_item",
        str(before["id"]),
        "update",
        post,
        int(after["version"]),
        timestamp,
    )
    return context.command(
        request=request,
        db_plans=(plan,),
        sync_events=(event,),
        value=post,
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


def _label_ids_for_work_item(overlay, work_item_id: str) -> tuple[str, ...]:
    """Server-authoritative label_ids projection for one work item.

    The junction table is the projection source: rows are read from the
    locked authority overlay (composite-key keyed), never from the sync
    protocol.  The emitted projection is a sorted tuple of label ids.
    """
    return tuple(sorted(
        str(row["label_id"])
        for row in overlay.rows("work_item_label")
        if str(row["work_item_id"]) == work_item_id
    ))


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


def _authoritative_child_rank(
    overlay, project_id: str, parent_id: str | None
) -> int:
    """Assign the authoritative append-only rank for one target parent.

    Online Create/Move always run this inside the same transaction as the
    target mutation: ``max(existing ranks, -1) + 1``.  Empty sibling sets
    therefore start at 0, and holes left by earlier moves never get reused.
    Sync replay does NOT call this — it applies the rank carried by the
    full post-image verbatim.
    """
    ranks = [
        int(row["child_rank"])
        for row in overlay.rows("work_item")
        if str(row["project_id"]) == project_id
        and row["parent_id"] == parent_id
    ]
    return max(ranks, default=-1) + 1


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
        # Authoritative append-only placement: max(existing ranks, -1) + 1
        # inside the same transaction.  The full post-image (including this
        # assigned rank) is what mutation/outbox persist and peers replay.
        "child_rank": _authoritative_child_rank(
            overlay, str(project["id"]), parent_id
        ),
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
    # D5 Y: even the create post-image carries the (empty) label_ids
    # projection so every workItem wire image has a uniform shape.
    post = {**item_after, "label_ids": []}
    events = (
        SyncEventPlan(
            "project", str(project["id"]), "update",
            project_after, int(project_after["version"]), now,
        ),
        SyncEventPlan("work_item", work_item_id, "create", post, 1, now),
    )
    return context.command(
        request=request,
        db_plans=plans,
        sync_events=events,
        value=post,
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
    declared_rank = request.payload.get("child_rank")
    if declared_rank is not None:
        # Sync replay path: the event carries the authoritative rank in its
        # full post-image.  Apply it verbatim — never recompute.  Only the
        # server-side replay (_typed_sync_request) may supply this field; the
        # online Move API rejects childRank at the wire layer and never
        # includes it in the payload.  Malformed values are rejected through
        # the same registered work_item_structure_changed gate the sync path
        # already uses.
        if type(declared_rank) is not int or declared_rank < 0:
            _reject_work_item_sync("invalid_child_rank")
        child_rank = declared_rank
    else:
        # Online path: authoritative append-only placement inside the same
        # transaction as the move.  Holes left by earlier moves are never
        # reused.
        child_rank = _authoritative_child_rank(
            overlay, str(item["project_id"]), parent_id
        )
    after = {
        **item,
        "parent_id": parent_id,
        "child_rank": child_rank,
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
    # The before image is the DB row (no label_ids column); project the
    # server-authoritative junction labels onto it for change detection.
    before_projected = {
        **before,
        "label_ids": _label_ids_for_work_item(
            context.authority, request.entity_id
        ),
    }
    semantic_changes = {
        field
        for field in WORK_ITEM_SYNC_FIELDS - {"id", "version", "updated_at"}
        if candidate[field] != before_projected[field]
    }
    immutable_changes = semantic_changes & WORK_ITEM_IMMUTABLE_FIELDS
    if immutable_changes:
        _reject_work_item_sync(
            "server_managed_field_changed", fields=sorted(immutable_changes)
        )

    scalar_changes = semantic_changes & WORK_ITEM_SCALAR_FIELDS
    move_changes = semantic_changes & WORK_ITEM_MOVE_FIELDS
    status_changes = semantic_changes & WORK_ITEM_STATUS_FIELDS
    labels_changes = semantic_changes & WORK_ITEM_LABELS_FIELDS
    known = (
        scalar_changes | move_changes | status_changes | labels_changes
        | WORK_ITEM_IMMUTABLE_FIELDS
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
            ("labels", labels_changes),
        )
        if fields
    )
    if len(families) != 1:
        _reject_work_item_sync(
            "exactly_one_operation_family_required", families=families
        )

    family = families[0]
    junction_plans: tuple[DbMutationPlan, ...] = ()
    if family == "scalar":
        typed = _typed_sync_request(
            context,
            request,
            "UpdateWorkItem",
            {"patch": {field: candidate[field] for field in scalar_changes}},
        )
        # Shared constraint validation only: the typed compiler re-validates
        # patch ownership / referenced definitions but would regenerate
        # ``updated_at``; replay adopts the candidate verbatim below.
        await _compile_UpdateWorkItem(self, context, typed)
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
        # Shared constraint validation (cross-project, cycle, subtree depth,
        # rank validity) — the replayed rank is taken from the candidate below.
        await _compile_MoveWorkItem(self, context, typed)
    elif family == "status":
        typed = _typed_sync_request(
            context,
            request,
            "TransitionWorkItem",
            {"status_definition_id": candidate["status_definition_id"]},
        )
        # Shared constraint validation (status machine, active-child conflict,
        # envelope claim).  completed_at/cancelled_at are adopted verbatim.
        await _compile_TransitionWorkItem(self, context, typed)
    else:
        # D5 Y labels family: the candidate carries the full label_ids
        # projection; replay diffs the junction table (present -> insert,
        # absent -> delete) inside the same transaction.
        declared_raw = candidate["label_ids"]
        if (
            not isinstance(declared_raw, (list, tuple))
            or not all(isinstance(value, str) for value in declared_raw)
            or sorted(declared_raw) != list(declared_raw)
        ):
            _reject_work_item_sync(
                "label_ids_must_be_sorted_unique_ids", label_ids=declared_raw
            )
        declared = list(declared_raw)
        for label_id in declared:
            _require_row(context.authority, "label", label_id)
        current = set(_label_ids_for_work_item(context.authority, request.entity_id))
        after_ids = set(declared)
        labels_plans: list[DbMutationPlan] = []
        for label_id in sorted(after_ids - current):
            row = {"work_item_id": request.entity_id, "label_id": label_id}
            labels_plans.append(
                DbMutationPlan("work_item_labels", dict(row), "insert", None, None, row)
            )
        for label_id in sorted(current - after_ids):
            row = {"work_item_id": request.entity_id, "label_id": label_id}
            labels_plans.append(
                DbMutationPlan("work_item_labels", dict(row), "delete", None, row, None)
            )
        junction_plans = tuple(labels_plans)

    # The validated candidate is the authoritative result of a sync replay:
    # every WORK_ITEM_SYNC_FIELDS value is adopted verbatim.  The typed
    # compilers above share the constraint validation but MUST NOT share the
    # "regenerate the result" behavior — online commands generate authoritative
    # server timestamps, replay never re-derives updated_at / completed_at /
    # cancelled_at / child_rank.  label_ids is a virtual projection field: it
    # travels in the sync event post-image but never in a work_items row.
    after = {key: value for key, value in candidate.items() if key != "label_ids"}
    plan = DbMutationPlan(
        "work_items", {"id": after["id"]}, "update",
        request.expected_version, before, after,
    )
    event = SyncEventPlan(
        "work_item", str(after["id"]), "update", dict(candidate),
        int(after["version"]), str(after["updated_at"]),
    )
    return context.command(
        request=request,
        db_plans=(plan, *junction_plans),
        sync_events=(event,),
        value=dict(candidate),
    )


TaskSpaceCompiler.compile_sync_work_item = _compile_sync_work_item


# -- Label definition lifecycle (D5 Y) ---------------------------------------


def _require_unique_label_name(overlay, name: str, *, excluding_id: str | None = None) -> None:
    """labels.name is globally unique (unique constraint) per Space."""
    from app.mutation.types import MutationRuleViolation

    for row in overlay.rows("label"):
        if str(row["name"]) == name and (
            excluding_id is None or str(row["id"]) != excluding_id
        ):
            raise MutationRuleViolation(
                "label_name_conflict", {"name": name}, retryable=False
            )


async def _compile_CreateLabel(self, context, request):
    overlay = context.authority
    name = str(request.payload["name"]).strip()
    if not name:
        from app.mutation.types import MutationRuleViolation

        raise MutationRuleViolation(
            "label_name_conflict",
            {"name": "", "reason": "name_required"},
            retryable=False,
        )
    _require_unique_label_name(overlay, name)
    label_id = _stable_id("label", str(request.payload["command_id"]))
    now = self.now_iso_ms()
    after = {
        "id": label_id,
        "name": name,
        "color": request.payload.get("color"),
        "archived_at": None,
        "created_at": now,
        "updated_at": now,
        "version": 1,
    }
    plan = DbMutationPlan("labels", {"id": label_id}, "insert", None, None, after)
    event = SyncEventPlan("label", label_id, "create", after, 1, now)
    return context.command(
        request=request,
        db_plans=(plan,),
        sync_events=(event,),
        value=after,
    )


async def _compile_UpdateLabel(self, context, request):
    overlay = context.authority
    label = _require_row(overlay, "label", request.entity_id)
    _require_expected_version(label, request.expected_version)
    patch = {
        key: request.payload[key]
        for key in ("name", "color")
        if key in request.payload
    }
    if not patch:
        # No-op update: return the authoritative unchanged post-image.
        return context.command(
            request=request, db_plans=(), sync_events=(), value=label
        )
    if "name" in patch:
        from app.mutation.types import MutationRuleViolation

        name = str(patch["name"]).strip()
        if not name:
            raise MutationRuleViolation(
                "label_name_conflict",
                {"name": "", "reason": "name_required"},
                retryable=False,
            )
        _require_unique_label_name(overlay, name, excluding_id=str(label["id"]))
        patch["name"] = name
    now = _monotonic_updated_at(str(label["updated_at"]), self.now_iso_ms())
    after = {
        **label,
        **patch,
        "updated_at": now,
        "version": int(label["version"]) + 1,
    }
    plan = DbMutationPlan(
        "labels", {"id": label["id"]}, "update",
        request.expected_version, label, after,
    )
    event = SyncEventPlan(
        "label", str(label["id"]), "update", after, int(after["version"]), now,
    )
    return context.command(
        request=request,
        db_plans=(plan,),
        sync_events=(event,),
        value=after,
    )


async def _compile_ArchiveLabel(self, context, request):
    overlay = context.authority
    label = _require_row(overlay, "label", request.entity_id)
    _require_expected_version(label, request.expected_version)
    now = _monotonic_updated_at(str(label["updated_at"]), self.now_iso_ms())
    after = {
        **label,
        "archived_at": now,
        "updated_at": now,
        "version": int(label["version"]) + 1,
    }
    plan = DbMutationPlan(
        "labels", {"id": label["id"]}, "update",
        request.expected_version, label, after,
    )
    event = SyncEventPlan(
        "label", str(label["id"]), "update", after, int(after["version"]), now,
    )
    return context.command(
        request=request,
        db_plans=(plan,),
        sync_events=(event,),
        value=after,
    )


TaskSpaceCompiler.compile_CreateLabel = _compile_CreateLabel
TaskSpaceCompiler.compile_UpdateLabel = _compile_UpdateLabel
TaskSpaceCompiler.compile_ArchiveLabel = _compile_ArchiveLabel


# -- WorkItem label-set mutations (D5 Y) -------------------------------------


def _compile_label_set_mutation(self, context, request, *, remove: bool):
    """One atomic AddWorkItemLabels / RemoveWorkItemLabels command.

    The caller declares the target label_ids set it expects AFTER this
    mutation.  The server read-modify-write converges the junction table to
    that set inside one mutation command, bumping only the work_item version
    when the set actually changes (idempotent no-op otherwise).  Stale
    expected_versions fail with version_conflict — never a silent merge — and
    a refreshed retry converges to the union.
    """
    overlay = context.authority
    entity_id = str(request.entity_id)
    item = _require_row(overlay, "work_item", entity_id)
    _require_expected_version(item, request.expected_version)
    declared = set(map(str, request.payload["label_ids"]))
    for label_id in declared:
        _require_row(overlay, "label", label_id)
    current = set(_label_ids_for_work_item(overlay, entity_id))
    after_ids = (current - declared) if remove else (current | declared)
    value_ids = sorted(after_ids)
    if after_ids == current:
        # Idempotent set semantics: nothing changed -> no version bump, no
        # sync event; the command is a zero-effect receipt (retry-safe).
        return context.command(
            request=request,
            db_plans=(),
            sync_events=(),
            value={**item, "label_ids": value_ids},
        )
    now = _monotonic_updated_at(str(item["updated_at"]), self.now_iso_ms())
    item_after = {
        **item,
        "updated_at": now,
        "version": int(item["version"]) + 1,
    }
    junction_plans: list[DbMutationPlan] = []
    for label_id in sorted(after_ids - current):
        row = {"work_item_id": entity_id, "label_id": label_id}
        junction_plans.append(
            DbMutationPlan("work_item_labels", dict(row), "insert", None, None, row)
        )
    for label_id in sorted(current - after_ids):
        row = {"work_item_id": entity_id, "label_id": label_id}
        junction_plans.append(
            DbMutationPlan("work_item_labels", dict(row), "delete", None, row, None)
        )
    plans = (
        DbMutationPlan(
            "work_items", {"id": entity_id}, "update",
            request.expected_version, item, item_after,
        ),
        *junction_plans,
    )
    event_payload = {**item_after, "label_ids": value_ids}
    event = SyncEventPlan(
        "work_item", entity_id, "update", event_payload,
        int(item_after["version"]), now,
    )
    return context.command(
        request=request,
        db_plans=plans,
        sync_events=(event,),
        value=event_payload,
    )


async def _compile_AddWorkItemLabels(self, context, request):
    return _compile_label_set_mutation(self, context, request, remove=False)


async def _compile_RemoveWorkItemLabels(self, context, request):
    return _compile_label_set_mutation(self, context, request, remove=True)


TaskSpaceCompiler.compile_AddWorkItemLabels = _compile_AddWorkItemLabels
TaskSpaceCompiler.compile_RemoveWorkItemLabels = _compile_RemoveWorkItemLabels


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
                    "entityId": request.entity_id,
                    # QN-S8b: authoritative remote post-image so clients can
                    # adopt the current remote Note on reload without a re-pull.
                    "snapshot": {
                        "id": str(before["id"]),
                        "work_item_id": str(before["work_item_id"]),
                        "document_json": str(before["document_json"]),
                        "created_at": str(before["created_at"]),
                        "updated_at": str(before["updated_at"]),
                        "version": int(before["version"]),
                    },
                    "version": int(before["version"]),
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
