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
    BLOCKING_RELATION_TYPES,
    RELATION_RESOLUTION_CONFIRMED_NOT_REQUIRED,
    RELATION_TYPES,
    SYSTEM_STATUS_IDS,
    SYSTEM_TYPE_ID,
    WORK_ITEM_CONFIDENCE_VALUES,
    WORK_ITEM_PRIORITY_VALUES,
    StatusCategory,
    format_work_item_display_key,
    relation_id,
    require_enum_value,
)
from app.task_space.cycle_detector import detect_cycle_incremental
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
    "project", "type_definition",
    "work_item_label",
})
# ★ 2026-10-02（状态双轴阶段 2）：`status_definition` 已移出。
#   它原本是"Space 级锚点、极少变动"，但双轴下 status 变成**高频用户操作**
#   （用户要建"等设计 review"这类贴合流程的状态），继续只读会违背离线优先定位。
#   配套：`_compile_sync_entity` 必须新增 status_definition 分支，
#   否则这里放开后会在下方抛 `unowned Task Space entity`。
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
    # ★ 2026-10-02（状态双轴阶段 2）：status_definition 已移出 READ_ONLY_SYNC_TYPES，
    #   必须在这里有对应分支，否则放开后会落到下面抛 unowned。
    if request.entity_type == "status_definition":
        return await self.compile_sync_status_definition(context, request)
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
    "review_point", "hard_deadline", "due_at",
    "effort_estimate_lower_seconds",
    "effort_estimate_upper_seconds", "effort_actual_seconds", "confidence",
    "completed_at", "cancelled_at", "archived_at", "marked_as_attention",
    "created_at", "updated_at", "version", "label_ids",
})
# ★ 2026-09-12（ADR-0003）：等待前态列 —— 服务端自持，**只出站**。
#   不在 WORK_ITEM_SYNC_FIELDS（入站 push 精确相等，携带即拒 full_post_image_required）；
#   但 DB 行 / sync 事件 payload 必须包含它（行形状校验要求 set(row) == spec.field_names）。
#   唯一写入者 = 进入 Waiting 的那次迁移编译（见 _compile_TransitionWorkItem）。
PRE_WAITING_STATUS_FIELD = "pre_waiting_status_definition_id"

# DORMANT（2026-09-10 审查）：下列 9 个柔性计划字段
# （completion_window_start / completion_window_end / review_point /
#  hard_deadline / effort_estimate_lower_seconds /
#  effort_estimate_upper_seconds / confidence / marked_as_attention，
#  另含 effort_actual_seconds）
# 在模型 + 迁移 + CHECK 约束 + Registry FieldSpec + WORK_ITEM_SYNC_FIELDS +
# 本白名单中全部存在，但 CreateWorkItemRequest / UpdateWorkItemRequest 都没有
# 暴露它们，且 _compile_CreateWorkItem 创建时把它们硬编码为 None / False。
# ⇒ 目前没有任何 REST 通道可写，唯一写入途径是手工构造 sync post-image。
# 激活它等于开工 Phase 3（柔性计划），应先过产品裁决。
WORK_ITEM_SCALAR_FIELDS = frozenset({
    "title", "description", "type_definition_id", "priority",
    "completion_window_start", "completion_window_end", "review_point",
    "hard_deadline", "effort_estimate_lower_seconds",
    "effort_estimate_upper_seconds", "confidence", "archived_at",
    "marked_as_attention",
    # ★ 2026-10-03（space_018）：截止日期。在 SCALAR 白名单 ⇒ 在线 PATCH 可写
    #   （routes 层显式字段表 + sync 重放的 scalar 家族变更归属都经这里）。
    #   工单②起它同时在 WORK_ITEM_SYNC_FIELDS：入站全量 post-image 缺失时
    #   服务端从真实前像继承（路径 3），显式携带则正常写入。
    "due_at",
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


def _require_work_item_enum(
    field: str, value: object, allowed: tuple[str, ...]
) -> None:
    """Reject an out-of-domain WorkItem enum value before it can reach the DB.

    ★ 2026-09-11：priority / confidence 的值域与 Pydantic wire schema 共用
    contracts 常量。schema 层已 422 拦下在线请求；这里是**直接调用编译器**
    （含 sync post-image 重放）的纵深防御，稳定错误码为
    ``payload_field_not_allowed``、``details.reason`` 为 ``invalid_<field>``，
    绝不允许越界值落到 work_items 的 CHECK 约束（那里只能是 500）。
    """
    from app.mutation.types import MutationRuleViolation

    try:
        require_enum_value(field, value, allowed)
    except ValueError as exc:
        raise MutationRuleViolation(
            "payload_field_not_allowed",
            {
                "field": field,
                "value": value,
                "reason": str(exc),
                "allowed": list(allowed),
            },
            retryable=False,
        ) from exc


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
    # ★ 2026-09-11：值域校验先于一切副作用；越界 priority 直接给稳定领域错误。
    _require_work_item_enum(
        "priority", request.payload.get("priority"), WORK_ITEM_PRIORITY_VALUES
    )
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
        # DORMANT：无 REST 写入通道，见上方 WORK_ITEM_SCALAR_FIELDS 注释。
        "completion_window_start": None,
        "completion_window_end": None,
        "review_point": None,
        "hard_deadline": None,
        # ★ 2026-10-03（space_018）：行键集必须完整（unit_of_work 的
        #   require_complete_row 要求 set(row) == set(spec.field_names)）；
        #   创建即无截止，显式 None。
        "due_at": None,
        "effort_estimate_lower_seconds": None,
        "effort_estimate_upper_seconds": None,
        "effort_actual_seconds": 0,
        "confidence": None,
        "completed_at": now if status_category == "completed" else None,
        "cancelled_at": now if status_category == "cancelled" else None,
        "archived_at": None,
        "marked_as_attention": False,
        # ★ 2026-09-12（ADR-0003）：创建即 Waiting 没有「前态」——显式 None
        #   （行键集必须完整：unit_of_work 的 require_complete_row 要求
        #   set(row) == set(spec.field_names)）。
        PRE_WAITING_STATUS_FIELD: None,
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
    # ★ 2026-09-11：在线 PATCH 与 sync 重放共用这一层校验（sync 仅把它当
    # 只读的约束检查调用，随后按 post-image 原样落库）。
    if "priority" in patch:
        _require_work_item_enum("priority", patch["priority"], WORK_ITEM_PRIORITY_VALUES)
    if "confidence" in patch:
        _require_work_item_enum(
            "confidence", patch["confidence"], WORK_ITEM_CONFIDENCE_VALUES
        )
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
        # ★ 2026-10-02（状态双轴）：`paused` 已并入 in_progress（迁移 space_017）。
        #   这里**必须**同步 —— 否则被合并到 in_progress 的行不再属于「活动类目」，
        #   父项完成时会误触发 active_child_conflict（静默的行为错误，不报错）。
        active_categories = {"not_started", "in_progress", "waiting"}
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
    # ★ 2026-09-12（ADR-0003）：等待前态的**唯一写入者** = 进入 Waiting 的那次迁移
    #   （sync post-image 的 status 变更经 :1092-1101 二次编译也汇聚到这里）。
    #   - 目标类目 == waiting 且 当前类目 != waiting ⇒ 记录迁移前的状态 id（任意
    #     非 waiting 类目；终态也记录，是否提供一键恢复由读侧按 Q8 判据决定）。
    #   - 当前类目 == waiting（停在 / 在两个 waiting 类目状态间切换）⇒ 保留现值：
    #     这不是一次新的进入。
    #   - 其它（离开 Waiting、普通迁移）⇒ 不动该键（惰性保留，仅在 Waiting 时被消费）。
    #   由构造保证：前态永远不是 waiting 类目（写入条件是当前类目 != waiting）。
    #   当前状态定义查不到（理论不可达）⇒ 不写：无法证明前态可用时不猜。
    current_status = overlay.row(
        "status_definition", str(item["status_definition_id"])
    )
    if (
        category == "waiting"
        and current_status is not None
        and str(current_status["category"]) != "waiting"
    ):
        after[PRE_WAITING_STATUS_FIELD] = item["status_definition_id"]
    return _work_item_update_command(context, request, item, after, now)


TaskSpaceCompiler.compile_TransitionWorkItem = _compile_TransitionWorkItem


# -- TrashWorkItem / RestoreWorkItem (archived_at lifecycle) ------------------


def _compile_archived_at_mutation(self, context, request, *, trashed: bool):
    """One atomic TrashWorkItem / RestoreWorkItem command.

    ``archived_at`` is the single soft-delete projection of a WorkItem and is
    already part of ``WORK_ITEM_SCALAR_FIELDS``, so the sync replay path
    carries it through the generic update family.  The typed commands exist so
    the online API can flip it **without letting a caller choose the
    timestamp**: the server always stamps ``archived_at`` from its own
    monotonic clock, and the external schema carries no ``archived_at`` field
    at all (``extra="forbid"`` rejects any attempt to smuggle one in).

    Both directions are idempotent.  Re-trashing an already-trashed item (or
    restoring a live one) is a zero-effect receipt: no version bump, no sync
    event, no DB write.  That keeps a double-click or a resumed intent from
    producing a spurious version bump that would invalidate every other
    pending client CAS.
    """
    overlay = context.authority
    item = _require_row(overlay, "work_item", request.entity_id)
    _require_expected_version(item, request.expected_version)
    if (item["archived_at"] is not None) == trashed:
        return context.command(
            request=request,
            db_plans=(),
            sync_events=(),
            value={
                **item,
                "label_ids": _label_ids_for_work_item(overlay, str(item["id"])),
            },
        )
    now = _monotonic_updated_at(str(item["updated_at"]), self.now_iso_ms())
    after = {
        **item,
        "archived_at": now if trashed else None,
        "updated_at": now,
        "version": int(item["version"]) + 1,
    }
    return _work_item_update_command(context, request, item, after, now)


async def _compile_TrashWorkItem(self, context, request):
    return _compile_archived_at_mutation(self, context, request, trashed=True)


async def _compile_RestoreWorkItem(self, context, request):
    return _compile_archived_at_mutation(self, context, request, trashed=False)


TaskSpaceCompiler.compile_TrashWorkItem = _compile_TrashWorkItem
TaskSpaceCompiler.compile_RestoreWorkItem = _compile_RestoreWorkItem


# -- Relation (dependency domain) commands ------------------------------------


def _relation_rows(overlay, space_id: str) -> tuple[Mapping[str, object], ...]:
    """Every relation row of THIS Space, read from the locked overlay.

    Cross-Space edges are impossible by construction: the authority overlay
    only ever holds rows of the Space the command was authorised against, so
    a forged ``space_id`` cannot reach another Space's rows.
    """
    return tuple(
        row for row in overlay.rows("relation")
        if str(row["space_id"]) == space_id
    )


def _blocking_edges(rows) -> list[tuple[str, str]]:
    """Canonical ``(from, to)`` pairs that participate in blocking.

    Only ``depends_on`` / ``blocks`` close a dependency cycle; ``relates_to``
    is a non-blocking association and is deliberately excluded.
    """
    return [
        (str(row["from_work_item_id"]), str(row["to_work_item_id"]))
        for row in rows
        if str(row["relation_type"]) in BLOCKING_RELATION_TYPES
    ]


def _require_relation_endpoints(overlay, from_id: str, to_id: str) -> None:
    """Both endpoints must exist in this Space and must not be archived.

    D17: archived items keep their history but become immutable — no edge may
    be created that touches one, in either direction.
    """
    for work_item_id in (from_id, to_id):
        row = _require_row(overlay, "work_item", work_item_id)
        if row["archived_at"] is not None:
            from app.mutation.types import MutationRuleViolation

            raise MutationRuleViolation(
                "archived_work_item_immutable",
                {"workItemId": work_item_id},
                retryable=False,
            )


def _relation_identity(request: MutationRequest) -> tuple[str, str, str, str, str]:
    space_id = str(request.payload["space_id"])
    from_id = str(request.payload["from_work_item_id"])
    to_id = str(request.payload["to_work_item_id"])
    relation_type = str(request.payload["relation_type"])
    return (
        space_id,
        from_id,
        to_id,
        relation_type,
        relation_id(space_id, from_id, to_id, relation_type),
    )


async def _compile_CreateRelation(self, context, request):
    from app.mutation.types import MutationRuleViolation

    overlay = context.authority
    space_id, from_id, to_id, relation_type, edge_id = _relation_identity(request)
    if relation_type not in RELATION_TYPES:
        raise MutationRuleViolation(
            "payload_field_not_allowed",
            {"field": "relation_type", "value": relation_type},
            retryable=False,
        )

    # Existence + immutability BEFORE the self-loop check, so a caller that
    # points at a missing item gets not_found rather than a confusing cycle.
    _require_relation_endpoints(overlay, from_id, to_id)

    if from_id == to_id:
        raise MutationRuleViolation(
            "cycle_detected",
            {
                "cycle_path": [from_id, from_id],
                "conflicting_edge": [from_id, to_id],
                "reason": "self_loop",
            },
            retryable=False,
        )

    existing = overlay.row("relation", edge_id)
    if existing is not None:
        # D11/D15: the deterministic id makes a duplicate create a zero-effect
        # receipt instead of a constraint violation.  Two offline devices that
        # independently declared the same edge converge on one row.
        return context.command(
            request=request, db_plans=(), sync_events=(), value=dict(existing),
        )

    # D13: the detector runs against the SAME overlay the insert will be
    # compiled into — never a detached read at the route layer, which would
    # be a ToCTOU race against a concurrent command.
    has_cycle, cycle_path = detect_cycle_incremental(
        _blocking_edges(_relation_rows(overlay, space_id)),
        (from_id, to_id),
    )
    if has_cycle:
        raise MutationRuleViolation(
            "cycle_detected",
            {
                "cycle_path": cycle_path,
                "conflicting_edge": [from_id, to_id],
            },
            retryable=False,
        )

    now = self.now_iso_ms()
    after = {
        "id": edge_id,
        "space_id": space_id,
        "from_work_item_id": from_id,
        "to_work_item_id": to_id,
        "relation_type": relation_type,
        # ★ 2026-09-12（D2 / ADR-0004）：新建边恒为「未确认」——显式 None
        #   （行键集必须完整：unit_of_work 的 require_complete_row 要求
        #   set(row) == set(spec.field_names)；sync 事件载荷同样要求精确相等）。
        #   唯一写入点 = ResolveDependency 命令的编译。
        "resolution": None,
        "resolved_at": None,
        "created_at": now,
        "updated_at": now,
        "version": 1,
    }
    plan = DbMutationPlan(
        "relations", {"id": edge_id}, "insert", None, None, after,
    )
    event = SyncEventPlan("relation", edge_id, "create", after, 1, now)
    return context.command(
        request=request, db_plans=(plan,), sync_events=(event,), value=after,
    )


async def _compile_ResolveDependency(self, context, request):
    """解除确认：把「上游已取消且不再需要」落为显式用户事实（幂等 CAS）。

    ★ 2026-09-12（D2 / ADR-0004）。依赖域合同 §3.4/§4.2：cancelled 不是完成，
    不能自动解除依赖 —— 本命令是 resolution / resolved_at 的**唯一写入者**：

    - 只接受阻塞型边（``relates_to`` 的确认无意义，fail-closed 拒绝）；
    - 行不存在 → ``not_found``；expected_version 不符 → ``version_conflict``；
    - **幂等 CAS**（先例：TrashWorkItem / RestoreWorkItem）：已确认时重复确认 =
      零效果回执（db_plans=()、sync_events=()、无 version bump），防止双击 /
      意图重放产生伪 version bump 使其它 pending CAS 失效；
    - ``resolved_at`` 由服务端单调时钟打戳（防伪；外部 schema extra="forbid"
      本就拒收调用方自带时间戳，见 schemas/relation.py::ResolveRelationRequest）。
    """
    from app.mutation.types import MutationRuleViolation

    overlay = context.authority
    _space_id, _from_id, _to_id, relation_type, edge_id = _relation_identity(request)
    if relation_type not in BLOCKING_RELATION_TYPES:
        raise MutationRuleViolation(
            "payload_field_not_allowed",
            {"field": "relation_type", "value": relation_type},
            retryable=False,
        )
    row = overlay.row("relation", edge_id)
    if row is None:
        raise MutationRuleViolation(
            "not_found", {"entity_type": "relation", "id": edge_id},
            retryable=False,
        )
    before = dict(row)
    _require_expected_version(before, request.expected_version)
    if before["resolution"] is not None:
        # 幂等 CAS：重复确认 = 零效果回执（无 version bump、无 sync 事件、无 DB 写）。
        return context.command(
            request=request, db_plans=(), sync_events=(), value=before,
        )
    now = _monotonic_updated_at(str(before["updated_at"]), self.now_iso_ms())
    after = {
        **before,
        "resolution": RELATION_RESOLUTION_CONFIRMED_NOT_REQUIRED,
        "resolved_at": now,
        "updated_at": now,
        "version": int(before["version"]) + 1,
    }
    plan = DbMutationPlan(
        "relations", {"id": edge_id}, "update",
        request.expected_version, before, after,
    )
    event = SyncEventPlan(
        "relation", edge_id, "update", after, int(after["version"]), now,
    )
    return context.command(
        request=request, db_plans=(plan,), sync_events=(event,), value=after,
    )


async def _compile_RemoveRelation(self, context, request):
    overlay = context.authority
    space_id, from_id, to_id, relation_type, edge_id = _relation_identity(request)
    row = overlay.row("relation", edge_id)
    if row is None:
        # Removing an edge that does not exist is a hard error, not a no-op:
        # an unknown id almost always means the caller is stale.  Replays of a
        # *successful* remove are handled upstream by the operation journal,
        # which returns the stored result without recompiling.
        from app.mutation.types import MutationRuleViolation

        raise MutationRuleViolation(
            "not_found", {"entity_type": "relation", "id": edge_id},
            retryable=False,
        )
    before = dict(row)
    _require_expected_version(before, request.expected_version)
    # D17: the edge is history for archived endpoints; it may not be rewritten.
    _require_relation_endpoints(overlay, from_id, to_id)

    now = self.now_iso_ms()
    plan = DbMutationPlan(
        "relations",
        {"id": edge_id},
        "delete",
        before["version"],
        before,
        None,
    )
    # A delete sync event is what makes the UoW write the tombstone
    # (unit_of_work.py: tombstones.add on action == "delete"), which is how
    # other devices learn the edge is gone.  The compiler never calls
    # TombstoneService itself — that would mean a second write outside the plan.
    event = SyncEventPlan(
        "relation",
        edge_id,
        "delete",
        {"deleted_at": now},
        int(before["version"]) + 1,
        now,
    )
    return context.command(
        request=request, db_plans=(plan,), sync_events=(event,), value=before,
    )


TaskSpaceCompiler.compile_CreateRelation = _compile_CreateRelation
TaskSpaceCompiler.compile_RemoveRelation = _compile_RemoveRelation
TaskSpaceCompiler.compile_ResolveDependency = _compile_ResolveDependency


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
    context,
    request: MutationRequest,
    before: Mapping[str, object],
) -> dict[str, object]:
    from app.mutation.types import MutationRuleViolation

    expected_payload_fields = WORK_ITEM_SYNC_FIELDS - {"id"}
    actual_fields = set(request.payload)
    missing_fields = expected_payload_fields - actual_fields
    extra_fields = actual_fields - expected_payload_fields
    # ★ 2026-10-03（space_018 / 路径 3）：入站从「精确相等」放宽为「允许缺失」。
    #   协议没有 schema 版本协商（/sync/v2/* 全链路零版本参数），due_at 进白名单
    #   后，未升级客户端的 post-image 必然缺它 —— 缺失字段从真实前像继承服务端
    #   权威值（老客户端照常被接受），带齐的新客户端走全量校验。
    #   「多带」绝不放宽：extra 仍按 full_post_image_required 拒绝
    #   （pre_waiting_status_definition_id 等服务端自持字段依赖入站即拒，
    #   见 test_task_space_waiting_prior_state 的 extra 反例断言 —— 红线）。
    if extra_fields:
        _reject_work_item_sync(
            "full_post_image_required",
            missing=sorted(missing_fields),
            extra=sorted(extra_fields),
        )
    # ★ 2026-09-11：sync post-image（外部客户端 / 离线行）的 priority /
    # confidence 也必须在编译前 fail-closed。离线设备可能带着本地自由文本
    # （如「高」）重放；只靠 DB CHECK 会让整批同步以不可读的完整性错误收场。
    for enum_field, allowed_values in (
        ("priority", WORK_ITEM_PRIORITY_VALUES),
        ("confidence", WORK_ITEM_CONFIDENCE_VALUES),
    ):
        try:
            require_enum_value(enum_field, request.payload.get(enum_field), allowed_values)
        except ValueError as exc:
            _reject_work_item_sync(str(exc), field=enum_field)
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
    # 路径 3 的继承发生在全部 CAS/形态校验之后：before 的版本一致性已被证明，
    # 缺失字段才允许原样继承。label_ids 是虚拟投影列（无 DB 行可取），从
    # junction 表取服务端权威投影；其余字段取真实前像。
    for field in missing_fields:
        if field == "label_ids":
            candidate[field] = _label_ids_for_work_item(
                context.authority, request.entity_id
            )
        else:
            candidate[field] = before[field]
    return candidate


async def _compile_sync_work_item(self, context, request):
    if request.name != "entity.update":
        _reject_formal_sync(request, "typed_create_or_delete_required")

    before = _require_row(context.authority, "work_item", request.entity_id)
    candidate = _full_work_item_sync_candidate(context, request, before)
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
    # ★ 2026-09-12（ADR-0003）：pre_waiting 列是服务端自持的**只出站**列 ——
    #   客户端上行 post-image 从不携带它（WORK_ITEM_SYNC_FIELDS 精确相等不变）。
    #   缺省从真实前像**继承**（惰性保留：离开 Waiting / 普通迁移都不清除）；
    #   唯一覆盖点是下面 status 家族进入 Waiting 时的 typed 编译结果。
    pre_waiting_status = before[PRE_WAITING_STATUS_FIELD]
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
        # ★ 2026-09-12（ADR-0003）：typed 编译同时算出 pre_waiting 列的
        #   服务端权威值（进入 Waiting 的那一跳才写入）—— 取它覆盖继承值；
        #   其余字段仍按 candidate verbatim 采用（replay 不重新生成时间戳）。
        typed_command = await _compile_TransitionWorkItem(self, context, typed)
        pre_waiting_status = typed_command.db_plans[0].after_row[
            PRE_WAITING_STATUS_FIELD
        ]
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
    # ★ 2026-10-03（space_018 / 工单②）：due_at 已进 WORK_ITEM_SYNC_FIELDS ——
    #   老客户端缺失时由 _full_work_item_sync_candidate 从真实前像继承，
    #   candidate 恒携带完整字段集，落库行与事件 payload 无需再单独补列。
    # ★ 2026-09-12（ADR-0003）：落库行与 sync 事件 payload 都必须携带服务端自持的
    #   pre_waiting 列（行形状校验要求 set(row) == spec.field_names）。
    after[PRE_WAITING_STATUS_FIELD] = pre_waiting_status
    event_payload = {**dict(candidate), PRE_WAITING_STATUS_FIELD: pre_waiting_status}
    plan = DbMutationPlan(
        "work_items", {"id": after["id"]}, "update",
        request.expected_version, before, after,
    )
    event = SyncEventPlan(
        "work_item", str(after["id"]), "update", event_payload,
        int(after["version"]), str(after["updated_at"]),
    )
    return context.command(
        request=request,
        db_plans=(plan, *junction_plans),
        sync_events=(event,),
        value=event_payload,
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


# -- Status definition lifecycle（状态双轴阶段 2） ---------------------------
#
# ★ 双轴的核心不变量：**category 是固定轴，用户自定义的是 status 行**。
#   - 新建 status 时 category 必须命中现有 5 值闭集（DB CHECK +这里双保险）；
#     用户**不能**发明新 category（那是阶段 1 的 017 迁移管的事）。
#   - 同一 category 下可有多条 status（017 迁移把表级 UQ 换成部分唯一索引后成立）。
#   - 每个 category 至多一条**活跃系统行**（部分唯一索引保证）——
#     用户行（system=0）不受此限。
#
# ★ 为什么同步走 `_compile_sync_status_definition` 而不是复用 typed 命令：
#   sync 是离线重放，客户端带全量 post-image，必须校验 category 值域
#   （离线设备可能带本地自由文本，见 contracts.py 的枚举单一事实来源注释），
#   且要遵守「一次重放恰好命中一个操作族」的约束。

_STATUS_CATEGORY_VALUES: tuple[str, ...] = tuple(item.value for item in StatusCategory)


def _require_status_category(value: object) -> str:
    """fail-closed 校验 category 落在固定轴闭集内（离线设备可能带自由文本）。

    ★ `require_enum_value` 抛的是 ValueError，必须转成 MutationRuleViolation
      才能变成结构化拒绝而不是 500 —— 范式照 `_require_work_item_enum`。
    """
    from app.mutation.types import MutationRuleViolation
    from app.task_space.contracts import require_enum_value

    try:
        require_enum_value("category", value, _STATUS_CATEGORY_VALUES)
    except ValueError as exc:
        raise MutationRuleViolation(
            "payload_field_not_allowed",
            {
                "field": "category",
                "reason": str(exc),
                "allowed": list(_STATUS_CATEGORY_VALUES),
            },
            retryable=False,
        ) from exc
    return str(value)


def _require_live_status(overlay, status_id: str) -> Mapping[str, object]:
    """取status 行，且**拒绝已归档行**。

    ★ 这是双轴放大出来的一个既有漏洞：`require_row` 不查 archived_at，
      所以迁移到已归档的 status 一直可行。双轴后用户会真的创建并归档 status，
      这个洞会变得可达 ⇒ 这里显式挡住。
    """
    row = _require_row(overlay, "status_definition", status_id)
    if row.get("archived_at") is not None:
        from app.mutation.types import MutationRuleViolation

        raise MutationRuleViolation(
            "status_definition_archived",
            {"status_id": status_id},
            retryable=False,
        )
    return row


def _require_unique_status_name_in_category(overlay, name: str, category: str) -> None:
    """同 category 内status 名不重复（跨 category 可同名——那是不同分组）。"""
    from app.mutation.types import MutationRuleViolation

    for row in overlay.rows("status_definition"):
        if (
            str(row["name"]) == name
            and str(row["category"]) == category
            and row["archived_at"] is None
        ):
            raise MutationRuleViolation(
                "status_name_conflict",
                {"name": name, "category": category},
                retryable=False,
            )


def _authoritative_status_rank(overlay, category: str) -> int:
    """category 内下一个可用 rank（append 语义，与 work_item 的 child_rank 同款）。"""
    ranks = [
        int(row["rank"])
        for row in overlay.rows("status_definition")
        if str(row["category"]) == category
    ]
    return max(ranks, default=-1) + 1


async def _compile_CreateStatusDefinition(self, context, request):
    overlay = context.authority
    name = str(request.payload["name"]).strip()
    if not name:
        from app.mutation.types import MutationRuleViolation

        raise MutationRuleViolation(
            "status_name_conflict",
            {"name": "", "reason": "name_required"},
            retryable=False,
        )
    category = _require_status_category(request.payload.get("category"))
    _require_unique_status_name_in_category(overlay, name, category)
    status_id = _stable_id("status_definition", str(request.payload["command_id"]))
    now = self.now_iso_ms()
    rank = request.payload.get("rank")
    after = {
        "id": status_id,
        "name": name,
        "category": category,
        "icon": request.payload.get("icon"),
        "color": request.payload.get("color"),
        "rank": (
            int(rank) if rank is not None
            else _authoritative_status_rank(overlay, category)
        ),
        # ★ 用户建的行一律 system=0；系统代表行由迁移播种，不可由客户端创建。
        "system": False,
        "archived_at": None,
        "created_at": now,
        "updated_at": now,
        "version": 1,
    }
    plan = DbMutationPlan(
        "status_definitions", {"id": status_id}, "insert", None, None, after
    )
    # ★ snake，不是 camel：SyncEventPlan.entity_type 由
    #   `_validate_sync_event_against_catalog` 用 `catalog.get(event.entity_type)`
    #   查（registry/catalog.py:188按 `_by_name` 索引，即**注册名**）。
    #   registry 里那个 `sync_entity_type="statusDefinition"` 是 **wire 层**
    #   （pull/推给客户端的 JSON 键），不是同步事件的 entity_type。
    #   我最初写成 camel，实测报 KeyError → "persisted sync entity is
    #   outside the compiled catalog"。label 因snake==camel 掩盖了这个坑。
    event = SyncEventPlan("status_definition", status_id, "create", after, 1, now)
    return context.command(
        request=request, db_plans=(plan,), sync_events=(event,), value=after,
    )


async def _compile_UpdateStatusDefinition(self, context, request):
    overlay = context.authority
    row = _require_live_status(overlay, str(request.entity_id))
    _require_expected_version(row, request.expected_version)
    patch = {
        key: request.payload[key]
        for key in ("name", "category", "icon", "color", "rank")
        if key in request.payload
    }
    if not patch:
        # 幂等：零效果回执，返回权威 post-image
        return context.command(
            request=request, db_plans=(), sync_events=(), value=dict(row),
        )
    if "category" in patch:
        patch["category"] = _require_status_category(patch["category"])
    if "name" in patch:
        name = str(patch["name"]).strip()
        if not name:
            from app.mutation.types import MutationRuleViolation

            raise MutationRuleViolation(
                "status_name_conflict",
                {"name": "", "reason": "name_required"},
                retryable=False,
            )
        patch["name"] = name
    if "rank" in patch:
        patch["rank"] = int(patch["rank"])
    # 同 category 内改名要查重（category 本身变了也要查）
    target_category = str(patch.get("category", row["category"]))
    target_name = str(patch.get("name", row["name"]))
    _require_unique_status_name_in_category(overlay, target_name, target_category)
    now = _monotonic_updated_at(str(row["updated_at"]), self.now_iso_ms())
    after = {**row, **patch, "updated_at": now, "version": int(row["version"]) + 1}
    plan = DbMutationPlan(
        "status_definitions", {"id": row["id"]}, "update",
        request.expected_version, row, after,
    )
    event = SyncEventPlan(
        "status_definition", str(row["id"]), "update", after,
        int(after["version"]), now,
    )
    return context.command(
        request=request, db_plans=(plan,), sync_events=(event,), value=after,
    )


async def _compile_ArchiveStatusDefinition(self, context, request):
    """归档一个 status 定义。

    ★ 引用守卫：仍有 work_items 指向它时**拒绝归档**。
      否则那些工作项会悬空指向一个归档态状态，UI 上表现为"状态名消失"。
    （系统行由迁移保护，这里只挡用户行；系统行引用数必然 > 0。）
    """
    overlay = context.authority
    row = _require_live_status(overlay, str(request.entity_id))
    _require_expected_version(row, request.expected_version)
    status_id = str(row["id"])
    refs = [
        item
        for item in overlay.rows("work_item")
        if str(item["status_definition_id"]) == status_id
        and item.get("archived_at") is None
    ]
    if refs:
        from app.mutation.types import MutationRuleViolation

        raise MutationRuleViolation(
            "status_definition_in_use",
            {"status_id": status_id, "work_item_count": len(refs)},
            retryable=False,
        )
    now = _monotonic_updated_at(str(row["updated_at"]), self.now_iso_ms())
    after = {**row, "archived_at": now, "updated_at": now, "version": int(row["version"]) + 1}
    plan = DbMutationPlan(
        "status_definitions", {"id": status_id}, "update",
        request.expected_version, row, after,
    )
    event = SyncEventPlan(
        "status_definition", status_id, "update", after, int(after["version"]), now,
    )
    return context.command(
        request=request, db_plans=(plan,), sync_events=(event,), value=after,
    )


async def _compile_ReorderStatusDefinition(self, context, request):
    """把某个 status 移到同 category 内的指定位次。

    ★ 为什么 reorder **不带** expected_version：
      它是集合级操作——移动一个status 会连带改变同category 内其它行的 rank，
      逐行 CAS 会让并发下的两个 reorder 互相打架（后写者因兄弟行version
      变了而失败）。这里改为「读当前集合 → 计算目标顺序 → 写全部受影响行」，
      靠 expected_version 只锁住**被移动的那一行**（若客户端提供了的话）。
    """
    overlay = context.authority
    row = _require_live_status(overlay, str(request.entity_id))
    if request.expected_version is not None:
        _require_expected_version(row, request.expected_version)
    category = str(row["category"])
    target_rank = int(request.payload["rank"])
    siblings = sorted(
        (
            item
            for item in overlay.rows("status_definition")
            if str(item["category"]) == category and item["archived_at"] is None
        ),
        key=lambda item: (int(item["rank"]), str(item["id"])),
    )
    moving = next(item for item in siblings if str(item["id"]) == str(row["id"]))
    rest = [item for item in siblings if str(item["id"]) != str(row["id"])]
    rest.insert(max(0, min(target_rank, len(rest))), moving)
    now = _monotonic_updated_at(str(row["updated_at"]), self.now_iso_ms())
    plans: list[DbMutationPlan] = []
    events: list[SyncEventPlan] = []
    for index, item in enumerate(rest):
        if int(item["rank"]) == index:
            continue  # 位置未变，不写
        after = {
            **item,
            "rank": index,
            "updated_at": now,
            "version": int(item["version"]) + 1,
        }
        plans.append(
            DbMutationPlan(
                "status_definitions", {"id": item["id"]}, "update",
                int(item["version"]), item, after,
            )
        )
        events.append(
            SyncEventPlan(
                "status_definition", str(item["id"]), "update", after,
                int(after["version"]), now,
            )
        )
    if not plans:
        # 已经就位：幂等零效果
        return context.command(
            request=request, db_plans=(), sync_events=(), value=dict(row),
        )
    return context.command(
        request=request, db_plans=tuple(plans), sync_events=tuple(events),
        value={**row, "rank": target_rank},
    )


async def _compile_sync_status_definition(self, context, request):
    """离线重放 status_definition（create / update / delete）。

    ★ fail-closed 点：
      1. category 必须命中 5 值闭集 —— 离线设备可能带本地自由文本
         （与 priority / confidence 同一类问题，见 _full_work_item_sync_candidate 注释）。
      2. create 时system 必须为 false —— 客户端**不得**伪造系统代表行
         （那会破坏"每 category 至多一条活跃系统行"的不变量）。
      3. delete 走归档而非物理删除（保留引用完整性）。
    """
    from app.mutation.types import MutationRuleViolation

    overlay = context.authority
    action = request.name.removeprefix("entity.")
    now = self.now_iso_ms()

    if action == "create":
        payload = request.payload
        name = str(payload.get("name", "")).strip()
        if not name:
            raise MutationRuleViolation(
                "status_name_conflict",
                {"name": "", "reason": "name_required"},
                retryable=False,
            )
        category = _require_status_category(payload.get("category"))
        if bool(payload.get("system")):
            raise MutationRuleViolation(
                "server_managed_field_changed",
                {"fields": ["system"], "reason": "system_rows_are_server_seeded"},
                retryable=False,
            )
        _require_unique_status_name_in_category(overlay, name, category)
        after = {
            "id": str(payload["id"]),
            "name": name,
            "category": category,
            "icon": payload.get("icon"),
            "color": payload.get("color"),
            "rank": int(payload.get("rank", 0)),
            "system": False,
            "archived_at": None,
            "created_at": str(payload.get("created_at") or now),
            "updated_at": now,
            "version": 1,
        }
        plan = DbMutationPlan(
            "status_definitions", {"id": after["id"]}, "insert", None, None, after
        )
        event = SyncEventPlan(
            "status_definition", after["id"], "create", after, 1, now
        )
        return context.command(
            request=request, db_plans=(plan,), sync_events=(event,), value=after,
        )

    row = _require_row(overlay, "status_definition", str(request.entity_id))
    if action == "delete":
        # 物理删除会悬空所有引用 work_items ⇒ 一律归档
        after = {
            **row,
            "archived_at": now,
            "updated_at": now,
            "version": int(row["version"]) + 1,
        }
        plan = DbMutationPlan(
            "status_definitions", {"id": row["id"]}, "update",
            int(row["version"]), row, after,
        )
        event = SyncEventPlan(
            "status_definition", str(row["id"]), "update", after,
            int(after["version"]), now,
        )
        return context.command(
            request=request, db_plans=(plan,), sync_events=(event,), value=after,
        )

    # update
    if bool(request.payload.get("system")) or bool(row["system"]) != bool(
        request.payload.get("system", row["system"])
    ):
        raise MutationRuleViolation(
            "server_managed_field_changed",
            {"fields": ["system"]},
            retryable=False,
        )
    category = _require_status_category(request.payload.get("category", row["category"]))
    name = str(request.payload.get("name", row["name"])).strip()
    if not name:
        raise MutationRuleViolation(
            "status_name_conflict",
            {"name": "", "reason": "name_required"},
            retryable=False,
        )
    after = {
        **row,
        "name": name,
        "category": category,
        "icon": request.payload.get("icon", row["icon"]),
        "color": request.payload.get("color", row["color"]),
        "rank": int(request.payload.get("rank", row["rank"])),
        "updated_at": now,
        "version": int(row["version"]) + 1,
    }
    plan = DbMutationPlan(
        "status_definitions", {"id": row["id"]}, "update",
        int(row["version"]), row, after,
    )
    event = SyncEventPlan(
        "status_definition", str(row["id"]), "update", after,
        int(after["version"]), now,
    )
    return context.command(
        request=request, db_plans=(plan,), sync_events=(event,), value=after,
    )


TaskSpaceCompiler.compile_CreateStatusDefinition = _compile_CreateStatusDefinition
TaskSpaceCompiler.compile_UpdateStatusDefinition = _compile_UpdateStatusDefinition
TaskSpaceCompiler.compile_ArchiveStatusDefinition = _compile_ArchiveStatusDefinition
TaskSpaceCompiler.compile_ReorderStatusDefinition = _compile_ReorderStatusDefinition
TaskSpaceCompiler.compile_sync_status_definition = _compile_sync_status_definition


# -- WorkItem label-set mutations (D5 Y) -------------------------------------


def _compile_label_set_mutation(self, context, request, *, remove: bool):
    """One atomic AddWorkItemLabels / RemoveWorkItemLabels command.

    ★ 2026-09-20（TS-02a / 裁决一）：``payload["label_ids"]`` 是**本次操作完成
    后的完整目标集合**（labels-as-state），单条 REST、批量 REST 与未来 MCP 共用
    同一语义 —— 服务器把 junction 精确收敛到该集合，绝不按载荷内容猜「这是差量
    还是完整集合」。旧实现按差量解释（add 取并集、remove 取 current - declared），
    于是「当前 {A,B}、移除 A、声明 {B}」会被算成 {A,B}-{B} = {A}，「仅有 A 时
    声明空集」反而什么都不删 —— 那是本次修复的实际缺陷。

    操作方向由**权威集合**判定，不由载荷形状推断：add 只允许维持/增加
    （current ⊆ declared），remove 只允许维持/减少（declared ⊆ current）。越方向
    的声明以 ``label_set_direction_violated`` 明确拒绝（闭集成员，见
    app/errors.py::RESERVED_TS_CODES），避免 add 意外删除、remove 意外新增；
    拒绝发生在编译期 ⇒ 无 DB 写、无版本 bump、无同步事件、无账本。

    ★ 单标签 DELETE 的地址约束（TS-02a 补充）：当载荷带 ``require_removed_label_ids``
    （只有 ``DELETE /items/{id}/labels/{label_id}`` 这条路会注入，见
    routes/v1/work_items.py::remove_work_item_label）时，除方向门外还要求
    **``declared == current - required``**（相等，不是子集）。这条相等判定一次
    覆盖两种情形：
      * 被寻址标签**本来就不存在** ⇒ ``declared == current`` 即成立，命令落在下面的
        no-op 分支（零版本变化、零账本事件），而不是被拒；
      * 被寻址标签**必须消失**，且**不得顺带删掉任何未寻址标签**（declared 少任何一个
        未寻址标签即不等）。
    带地址约束时方向门的作用被包含关系吸收：``declared ⊆ current`` 与
    ``declared ⊇ current - required`` 都是等式的推论。批量 Remove 不带该字段，
    仍只走方向门（见 task_space/batch.py 与 schemas/task_space_batch.py）。

    ★ 已知且有意的行为变更（TS-02a / 裁决一）：旧实现里 add 是幂等**并集**
    （``current | declared``），所以「用 add 收敛到更小集合」过去会被接受并静默
    忽略差额；现在同一请求得到 422。这是裁决一「Add 只允许维持/增加标签……
    对越过操作方向的目标集合明确拒绝」的直接落地 —— 目标集合语义下若保留并集，
    add 与 remove 便无法区分「声明」与「差量」，正是本包要消除的歧义。需要缩小
    集合的调用方须改用 remove。仓库内盘点确认无按旧并集语义构造输入的调用方。

    集合不变时是 no-op（``db_plans=()`` / ``sync_events=()``，版本不动）。CAS 先于
    收敛：stale ``expected_version`` 一律 ``version_conflict``，绝不静默合并；客户端
    刷新后按新 ``commandId`` 重新声明完整目标集合重试。
    """
    from app.mutation.types import MutationRuleViolation

    overlay = context.authority
    entity_id = str(request.entity_id)
    item = _require_row(overlay, "work_item", entity_id)
    _require_expected_version(item, request.expected_version)
    declared = set(map(str, request.payload["label_ids"]))
    for label_id in declared:
        _require_row(overlay, "label", label_id)
    current = set(_label_ids_for_work_item(overlay, entity_id))
    # Address-level constraint (single-label DELETE only): the URL named one
    # specific label, and ``label_ids`` is the FULL post-mutation target set, so
    # the declaration must be EXACTLY "the current set minus the addressed
    # label(s)" — ``declared == current - required``.
    #
    # Equality is what makes the constraint complete; a subset test is not:
    #   * ``required <= (current - declared)`` only asks "is the addressed label
    #     absent from declared?", which (a) wrongly REJECTS removing a label the
    #     item never had — ``current - declared`` is then empty, so any non-empty
    #     ``required`` fails, even though "remove what is not there" is a no-op
    #     the zero-effect branch below handles; and (b) wrongly ACCEPTS a
    #     declaration that also drops un-addressed labels, because those extra
    #     removals never appear in ``required``.
    # The equality form covers both directions with one comparison: the addressed
    # label(s) must be gone (a surviving one makes ``declared`` too large) AND
    # nothing else may be dropped (an extra removal makes it too small).
    #
    # Deciding this here — inside the locked authority read — is the whole point;
    # a route-layer pre-read is unlocked and races a concurrent command.
    addressed = request.payload.get("require_removed_label_ids")
    if addressed is not None:
        required = set(map(str, addressed))
        expected_target = current - required
        if declared != expected_target:
            raise MutationRuleViolation(
                "label_set_direction_violated",
                {
                    "operation": "remove_labels",
                    # What this declaration would really do, computed against the
                    # locked authority set.
                    "would_remove": sorted(current - declared),
                    "would_add": sorted(declared - current),
                    # Why it does not equal ``current - required``: which addressed
                    # label(s) survive, and which un-addressed label(s) would be
                    # dropped as a side effect. Either list being non-empty means
                    # ``declared != current - required``.
                    "address_mismatch": {
                        "address_label_kept": sorted(declared & required),
                        "unaddressed_label_dropped": sorted(
                            (current - required) - declared
                        ),
                        "required_target_ids": sorted(expected_target),
                    },
                },
                retryable=False,
            )
    # Direction gate: the declared set is the TARGET, so an add may never drop
    # and a remove may never gain.  Both directions are computed against the
    # locked authority set (never against the payload shape) and the check runs
    # before any state is touched.
    removed_by_declaration = sorted(current - declared)
    added_by_declaration = sorted(declared - current)
    crossing = (
        added_by_declaration if remove else removed_by_declaration
    )
    if crossing:
        raise MutationRuleViolation(
            "label_set_direction_violated",
            {
                "operation": "remove_labels" if remove else "add_labels",
                "would_remove": removed_by_declaration,
                "would_add": added_by_declaration,
            },
            retryable=False,
        )
    after_ids = declared
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
