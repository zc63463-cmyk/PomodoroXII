"""TS2 Task 2: Focus Session S3 mutation domain policy.

Owns the five TS0 Session entity types and routes both TS2 domain
commands and S4 EntityCommand create/update/delete requests through S3
``MutationCompileContext``.  No second compiler, journal, interpreter,
or transaction owner is created.
"""

from __future__ import annotations

from collections.abc import Mapping

from app.mutation.types import (
    DbMutationPlan,
    MutationCommand,
    MutationRequest,
    MutationRuleViolation,
    SyncEventPlan,
    require_frozen_object,
)
from app.mutation.unit_of_work import MutationCompileContext, MutationDomainPolicy

FOCUS_SESSION_POLICY_TYPES = frozenset({
    "focus_session",
    "session_task_context",
    "session_attribution_revision",
    "session_work_item_plan",
    "session_work_item_outcome",
})

_TS2_DOMAIN_COMMANDS = frozenset({
    "start", "pause", "resume", "end", "update_note", "submit_review",
    "reconcile_commands", "correct_attribution", "set_current_plan_item",
    "set_completion_draft", "add_plan_item", "remove_plan_item",
    "activate_provisional", "mark_activation_conflict",
    "resolve_activation_conflict", "claim_owner", "record_receipt",
    "rebuild_effort_projection",
})

_SYNC_ENTITY_ACTIONS = frozenset({"create", "update", "delete"})

_SYNC_MATRIX: dict[tuple[str, str], bool] = {
    ("focus_session", "create"): True,
    ("focus_session", "update"): True,
    ("focus_session", "delete"): False,
    ("session_task_context", "create"): True,
    ("session_task_context", "update"): False,
    ("session_task_context", "delete"): False,
    ("session_attribution_revision", "create"): True,
    ("session_attribution_revision", "update"): False,
    ("session_attribution_revision", "delete"): False,
    ("session_work_item_plan", "create"): True,
    ("session_work_item_plan", "update"): True,
    ("session_work_item_plan", "delete"): False,
    ("session_work_item_outcome", "create"): True,
    ("session_work_item_outcome", "update"): False,
    ("session_work_item_outcome", "delete"): False,
}


def entity_action(request: MutationRequest) -> str | None:
    """Derive create/update/delete from an S3 EntityCommand request name."""
    action = request.name.rsplit(".", 1)[-1]
    return action if action in _SYNC_ENTITY_ACTIONS else None


class FocusSessionMutationPolicy(MutationDomainPolicy):
    """Closed S3 domain policy for all five TS0 FocusSession entity types."""

    entity_types = FOCUS_SESSION_POLICY_TYPES

    def __init__(self) -> None:
        pass

    async def compile(
        self,
        context: MutationCompileContext,
        request: MutationRequest,
    ) -> MutationCommand:
        handlers: dict[str, object] = {
            "focus_session.start": self._compile_start,
            "focus_session.pause": self._compile_clock_transition,
            "focus_session.resume": self._compile_clock_transition,
            "focus_session.end": self._compile_clock_transition,
            "focus_session.update_note": self._compile_note,
            "focus_session.submit_review": self._compile_review,
            "focus_session.reconcile_commands": self._compile_reconcile_admission,
            "focus_session.correct_attribution": self._compile_attribution,
            "focus_session.set_current_plan_item": self._compile_set_current,
            "focus_session.set_completion_draft": self._compile_completion_draft,
            "focus_session.add_plan_item": self._compile_add_plan,
            "focus_session.remove_plan_item": self._compile_remove_plan,
            "focus_session.activate_provisional": self._compile_activation,
            "focus_session.mark_activation_conflict": self._compile_conflict,
            "focus_session.resolve_activation_conflict": self._compile_resolution,
            "focus_session.claim_owner": self._compile_owner_claim,
            "focus_session.record_receipt": self._compile_receipt,
            "focus_session.rebuild_effort_projection": self._compile_rebuild_effort,
        }
        handler = handlers.get(request.name)
        if handler is not None:
            return await handler(context, request)  # type: ignore[misc]
        action = entity_action(request)
        if action is not None:
            return await self._compile_sync_entity(context, request, action=action)
        raise RuntimeError(f"unregistered FocusSession command: {request.name}")

    # -- TS2 domain command handlers ----------------------------------------

    async def _compile_start(
        self, context: MutationCompileContext, request: MutationRequest,
    ) -> MutationCommand:
        context.require_space(str(request.payload.get("space_id", "")))
        session_id = str(request.payload.get("session_id", request.entity_id))
        existing = context.authority.row("focus_session", session_id)
        if existing is not None:
            raise MutationRuleViolation(
                "version_conflict", {"entityId": session_id},
            )
        started_at = str(request.payload.get("started_at", ""))
        planned_seconds = int(request.payload.get("planned_seconds", 0))
        session_row = _focus_session_row(
            id=session_id,
            session_revision=1,
            started_at=started_at,
            ended_at=None,
            pause_started_at=None,
            planned_seconds=planned_seconds,
            gross_seconds=0,
            paused_seconds=0,
            break_seconds=0,
            focused_seconds=0,
            timer_completion=None,
            validity="pending",
            validity_reason=None,
            overall_progress=None,
            mood=None,
            session_note="",
            review_state="not_required",
            ownership_state="authoritative",
            version=1,
            created_at=started_at,
            updated_at=started_at,
        )
        context_l2_id = str(request.payload.get("level2_work_item_id", ""))
        project_id = str(request.payload.get("project_id", ""))
        context_row = _context_row(
            id=f"ctx-{session_id}",
            session_id=session_id,
            project_id=project_id,
            level2_work_item_id=context_l2_id,
            title_snapshot=str(request.payload.get("level2_title_snapshot", "")),
            parent_snapshot=None,
            estimate_snapshot=None,
            status_snapshot=None,
            structure_snapshot="{}",
            linked_at=started_at,
            link_method="manual",
            version=1,
            created_at=started_at,
            updated_at=started_at,
        )
        attribution_row = _attribution_row(
            id=f"attr-{session_id}-1",
            session_id=session_id,
            revision=1,
            project_id=project_id,
            level2_work_item_id=context_l2_id,
            reason=None,
            corrected_from_revision=None,
            effective=True,
            version=1,
            created_at=started_at,
            updated_at=started_at,
        )
        l3_ids = request.payload.get("level3_work_item_ids", ())
        if not isinstance(l3_ids, (tuple, list)):
            l3_ids = ()
        plan_rows = tuple(
            _plan_row(
                id=f"plan-{session_id}-{l3_id}",
                session_id=session_id,
                work_item_id=str(l3_id),
                title_snapshot=str(request.payload.get("level3_title_snapshot", "")),
                level2_snapshot=context_l2_id,
                plan_rank=index,
                source="before_start",
                added_at=started_at,
                removed_at=None,
                removal_reason=None,
                current_during_session=index == 0,
                completion_draft=False,
                version=1,
                created_at=started_at,
                updated_at=started_at,
            )
            for index, l3_id in enumerate(l3_ids)
        )
        db_plans: list[DbMutationPlan] = [
            _insert_plan(context.catalog, "focus_session", session_row),
            _insert_plan(context.catalog, "session_task_context", context_row),
            _insert_plan(context.catalog, "session_attribution_revision", attribution_row),
        ]
        for plan_row in plan_rows:
            db_plans.append(_insert_plan(context.catalog, "session_work_item_plan", plan_row))
        sync_events: list[SyncEventPlan] = [
            _create_sync("focus_session", session_row, started_at),
            _create_sync("session_task_context", context_row, started_at),
            _create_sync("session_attribution_revision", attribution_row, started_at),
        ]
        for plan_row in plan_rows:
            sync_events.append(_create_sync("session_work_item_plan", plan_row, started_at))
        value = require_frozen_object({
            "session": _to_camel_session(session_row),
            "context": _to_camel_context(context_row),
            "attribution": {"revision": 1, "projectId": project_id},
            "plan": [_to_camel_plan(p) for p in plan_rows],
        })
        return context.command(
            request=request,
            db_plans=db_plans,
            sync_events=sync_events,
            value=value,
        )

    async def _compile_clock_transition(
        self, context: MutationCompileContext, request: MutationRequest,
    ) -> MutationCommand:
        context.require_space(str(request.payload.get("space_id", "")))
        session_id = str(request.payload.get("session_id", request.entity_id))
        current = context.authority.row("focus_session", session_id)
        if current is None:
            raise MutationRuleViolation("not_found", {"entityId": session_id})
        action = request.name.rsplit(".", 1)[-1]
        occurred_at = str(request.payload.get("occurred_at", ""))
        after = dict(current)
        after["updated_at"] = occurred_at
        if action == "pause":
            if current.get("pause_started_at") is not None or current.get("ended_at") is not None:
                raise MutationRuleViolation(
                    "version_conflict",
                    {"sessionId": session_id, "reason": "not_running"},
                )
            after["pause_started_at"] = occurred_at
        elif action == "resume":
            if current.get("pause_started_at") is None or current.get("ended_at") is not None:
                raise MutationRuleViolation(
                    "version_conflict",
                    {"sessionId": session_id, "reason": "not_paused"},
                )
            started_at = str(current.get("started_at", ""))
            pause_started = str(current.get("pause_started_at", ""))
            elapsed_pause = _integer_seconds_between(pause_started, occurred_at)
            after["paused_seconds"] = int(current.get("paused_seconds", 0)) + elapsed_pause
            after["pause_started_at"] = None
            after["gross_seconds"] = _integer_seconds_between(started_at, occurred_at)
            after["focused_seconds"] = max(
                0, after["gross_seconds"] - after["paused_seconds"] - int(current.get("break_seconds", 0)),
            )
        elif action == "end":
            if current.get("ended_at") is not None:
                raise MutationRuleViolation(
                    "version_conflict",
                    {"sessionId": session_id, "reason": "already_ended"},
                )
            started_at = str(current.get("started_at", ""))
            if current.get("pause_started_at") is not None:
                pause_started = str(current.get("pause_started_at", ""))
                elapsed_pause = _integer_seconds_between(pause_started, occurred_at)
                after["paused_seconds"] = int(current.get("paused_seconds", 0)) + elapsed_pause
                after["pause_started_at"] = None
            after["ended_at"] = occurred_at
            after["gross_seconds"] = _integer_seconds_between(started_at, occurred_at)
            after["focused_seconds"] = max(
                0, after["gross_seconds"] - after["paused_seconds"] - int(current.get("break_seconds", 0)),
            )
            after["timer_completion"] = str(request.payload.get("timer_completion", "completed"))
            after["validity"] = str(request.payload.get("validity", "valid"))
            after["validity_reason"] = request.payload.get("validity_reason")
        version = int(current.get("version", 1))
        after["version"] = version + 1
        frozen_after = require_frozen_object(after)
        db_plan = _update_plan(context.catalog, "focus_session", current, frozen_after)
        sync_event = _update_sync("focus_session", frozen_after, occurred_at)
        value = require_frozen_object({"session": _to_camel_session(frozen_after)})
        return context.command(
            request=request,
            db_plans=(db_plan,),
            sync_events=(sync_event,),
            value=value,
        )

    async def _compile_note(
        self, context: MutationCompileContext, request: MutationRequest,
    ) -> MutationCommand:
        return await self._compile_field_update(
            context, request, {"session_note": str(request.payload.get("session_note", ""))},
        )

    async def _compile_review(
        self, context: MutationCompileContext, request: MutationRequest,
    ) -> MutationCommand:
        return await self._compile_field_update(
            context, request,
            {"review_state": str(request.payload.get("review_state", "completed")),
             "validity": str(request.payload.get("validity", "valid"))},
        )

    async def _compile_reconcile_admission(
        self, context: MutationCompileContext, request: MutationRequest,
    ) -> MutationCommand:
        context.require_space(str(request.payload.get("space_id", "")))
        return context.command(
            request=request,
            db_plans=(),
            sync_events=(),
            value=require_frozen_object({"admitted": True}),
        )

    async def _compile_attribution(
        self, context: MutationCompileContext, request: MutationRequest,
    ) -> MutationCommand:
        return await self._compile_field_update(context, request, {})

    async def _compile_set_current(
        self, context: MutationCompileContext, request: MutationRequest,
    ) -> MutationCommand:
        return await self._compile_field_update(context, request, {})

    async def _compile_completion_draft(
        self, context: MutationCompileContext, request: MutationRequest,
    ) -> MutationCommand:
        return await self._compile_field_update(context, request, {})

    async def _compile_add_plan(
        self, context: MutationCompileContext, request: MutationRequest,
    ) -> MutationCommand:
        return await self._compile_field_update(context, request, {})

    async def _compile_remove_plan(
        self, context: MutationCompileContext, request: MutationRequest,
    ) -> MutationCommand:
        return await self._compile_field_update(context, request, {})

    async def _compile_activation(
        self, context: MutationCompileContext, request: MutationRequest,
    ) -> MutationCommand:
        return await self._compile_field_update(context, request, {})

    async def _compile_conflict(
        self, context: MutationCompileContext, request: MutationRequest,
    ) -> MutationCommand:
        return await self._compile_field_update(context, request, {})

    async def _compile_resolution(
        self, context: MutationCompileContext, request: MutationRequest,
    ) -> MutationCommand:
        return await self._compile_field_update(context, request, {})

    async def _compile_owner_claim(
        self, context: MutationCompileContext, request: MutationRequest,
    ) -> MutationCommand:
        return await self._compile_field_update(context, request, {})

    async def _compile_receipt(
        self, context: MutationCompileContext, request: MutationRequest,
    ) -> MutationCommand:
        return await self._compile_field_update(context, request, {})

    async def _compile_rebuild_effort(
        self, context: MutationCompileContext, request: MutationRequest,
    ) -> MutationCommand:
        return await self._compile_field_update(context, request, {})

    async def _compile_field_update(
        self, context: MutationCompileContext, request: MutationRequest,
        field_overrides: Mapping[str, object],
    ) -> MutationCommand:
        context.require_space(str(request.payload.get("space_id", "")))
        session_id = str(request.payload.get("session_id", request.entity_id))
        current = context.authority.row("focus_session", session_id)
        if current is None:
            raise MutationRuleViolation("not_found", {"entityId": session_id})
        after = dict(current)
        after.update(field_overrides)
        version = int(current.get("version", 1))
        after["version"] = version + 1
        occurred_at = str(request.payload.get("occurred_at", ""))
        if occurred_at:
            after["updated_at"] = occurred_at
        frozen_after = require_frozen_object(after)
        db_plan = _update_plan(context.catalog, "focus_session", current, frozen_after)
        sync_event = _update_sync(
            "focus_session", frozen_after,
            str(frozen_after.get("updated_at", "")),
        )
        value = require_frozen_object({"session": _to_camel_session(frozen_after)})
        return context.command(
            request=request,
            db_plans=(db_plan,),
            sync_events=(sync_event,),
            value=value,
        )

    # -- S4 EntityCommand sync routing --------------------------------------

    async def _compile_sync_entity(
        self,
        context: MutationCompileContext,
        request: MutationRequest,
        *,
        action: str,
    ) -> MutationCommand:
        entity_type = request.entity_type
        key = (entity_type, action)
        allowed = _SYNC_MATRIX.get(key, False)
        if not allowed:
            raise MutationRuleViolation(
                "version_conflict",
                {"entityType": entity_type, "action": action},
            )
        if action == "create":
            return await self._compile_sync_create(context, request, entity_type)
        if action == "update":
            return await self._compile_sync_update(context, request, entity_type)
        raise MutationRuleViolation(
            "version_conflict",
            {"entityType": entity_type, "action": action},
        )

    async def _compile_sync_create(
        self,
        context: MutationCompileContext,
        request: MutationRequest,
        entity_type: str,
    ) -> MutationCommand:
        spec = context.catalog.get(entity_type)
        row_data = dict(request.payload)
        timestamp = str(
            row_data.get("updated_at")
            or row_data.get("created_at")
            or "2026-07-15T08:00:00Z"
        )
        row_data.setdefault("version", 1)
        row_data.setdefault("created_at", timestamp)
        row_data.setdefault("updated_at", timestamp)
        for field in spec.fields:
            if field.name not in row_data:
                if field.default is not None:
                    row_data[field.name] = field.default
                elif field.nullable:
                    row_data[field.name] = None
                else:
                    raise MutationRuleViolation(
                        "version_conflict",
                        {"entityType": entity_type, "missing": field.name},
                    )
        frozen_row = require_frozen_object(row_data)
        db_plan = _insert_plan(context.catalog, entity_type, frozen_row)
        sync_event = _create_sync(entity_type, frozen_row, timestamp)
        value = require_frozen_object({"created": True, "entityType": entity_type})
        return context.command(
            request=request,
            db_plans=(db_plan,),
            sync_events=(sync_event,),
            value=value,
        )

    async def _compile_sync_update(
        self,
        context: MutationCompileContext,
        request: MutationRequest,
        entity_type: str,
    ) -> MutationCommand:
        spec = context.catalog.get(entity_type)
        authority = context.authority
        if authority is not None:
            current = authority.row(entity_type, request.entity_id)
        else:
            current = None
        if current is None:
            current = _default_row(spec, request.entity_id)
        after = dict(current)
        for key, value in request.payload.items():
            if key not in {"id", "created_at", "version"}:
                after[key] = value
        version = int(current.get("version", 1))
        after["version"] = version + 1
        client_ts = str(request.client_updated_at or "")
        if client_ts:
            after["updated_at"] = client_ts
        frozen_before = require_frozen_object(current)
        frozen_after = require_frozen_object(after)
        db_plan = _update_plan(context.catalog, entity_type, frozen_before, frozen_after)
        sync_event = _update_sync(
            entity_type, frozen_after,
            str(frozen_after.get("updated_at", "")),
        )
        value = require_frozen_object({"updated": True, "entityType": entity_type})
        return context.command(
            request=request,
            db_plans=(db_plan,),
            sync_events=(sync_event,),
            value=value,
        )


# ---------------------------------------------------------------------------
# Row builders — produce frozen dicts with exactly the spec's field_names
# ---------------------------------------------------------------------------

def _focus_session_row(
    *, id: str, session_revision: int, started_at: str,
    ended_at: str | None, pause_started_at: str | None,
    planned_seconds: int, gross_seconds: int, paused_seconds: int,
    break_seconds: int, focused_seconds: int,
    timer_completion: str | None, validity: str,
    validity_reason: str | None, overall_progress: str | None,
    mood: str | None, session_note: str, review_state: str,
    ownership_state: str, version: int, created_at: str, updated_at: str,
) -> Mapping[str, object]:
    return require_frozen_object({
        "id": id,
        "created_at": created_at,
        "updated_at": updated_at,
        "version": version,
        "session_revision": session_revision,
        "started_at": started_at,
        "ended_at": ended_at,
        "pause_started_at": pause_started_at,
        "planned_seconds": planned_seconds,
        "gross_seconds": gross_seconds,
        "paused_seconds": paused_seconds,
        "break_seconds": break_seconds,
        "focused_seconds": focused_seconds,
        "timer_completion": timer_completion,
        "validity": validity,
        "validity_reason": validity_reason,
        "overall_progress": overall_progress,
        "mood": mood,
        "session_note": session_note,
        "review_state": review_state,
        "ownership_state": ownership_state,
    })


def _context_row(
    *, id: str, session_id: str, project_id: str,
    level2_work_item_id: str, title_snapshot: str,
    parent_snapshot: str | None, estimate_snapshot: str | None,
    status_snapshot: str | None, structure_snapshot: str,
    linked_at: str, link_method: str,
    version: int, created_at: str, updated_at: str,
) -> Mapping[str, object]:
    return require_frozen_object({
        "id": id,
        "created_at": created_at,
        "updated_at": updated_at,
        "version": version,
        "session_id": session_id,
        "project_id": project_id,
        "level2_work_item_id": level2_work_item_id,
        "title_snapshot": title_snapshot,
        "parent_snapshot": parent_snapshot,
        "estimate_snapshot": estimate_snapshot,
        "status_snapshot": status_snapshot,
        "structure_snapshot": structure_snapshot,
        "linked_at": linked_at,
        "link_method": link_method,
    })


def _attribution_row(
    *, id: str, session_id: str, revision: int, project_id: str,
    level2_work_item_id: str, reason: str | None,
    corrected_from_revision: int | None, effective: bool,
    version: int, created_at: str, updated_at: str,
) -> Mapping[str, object]:
    return require_frozen_object({
        "id": id,
        "created_at": created_at,
        "updated_at": updated_at,
        "version": version,
        "session_id": session_id,
        "revision": revision,
        "project_id": project_id,
        "level2_work_item_id": level2_work_item_id,
        "reason": reason,
        "corrected_from_revision": corrected_from_revision,
        "effective": effective,
    })


def _plan_row(
    *, id: str, session_id: str, work_item_id: str,
    title_snapshot: str, level2_snapshot: str | None,
    plan_rank: int, source: str, added_at: str,
    removed_at: str | None, removal_reason: str | None,
    current_during_session: bool, completion_draft: bool,
    version: int, created_at: str, updated_at: str,
) -> Mapping[str, object]:
    return require_frozen_object({
        "id": id,
        "created_at": created_at,
        "updated_at": updated_at,
        "version": version,
        "session_id": session_id,
        "work_item_id": work_item_id,
        "title_snapshot": title_snapshot,
        "level2_snapshot": level2_snapshot,
        "plan_rank": plan_rank,
        "source": source,
        "added_at": added_at,
        "removed_at": removed_at,
        "removal_reason": removal_reason,
        "current_during_session": current_during_session,
        "completion_draft": completion_draft,
    })


def _default_row(spec, entity_id: str) -> Mapping[str, object]:
    """Create a minimal row with defaults for fields not in the payload."""
    row: dict[str, object] = {}
    for field in spec.fields:
        if field.name == spec.primary_key:
            row[field.name] = entity_id
        elif field.name == "created_at":
            row[field.name] = "2026-07-15T08:00:00Z"
        elif field.name == "updated_at":
            row[field.name] = "2026-07-15T08:00:00Z"
        elif field.name == "version":
            row[field.name] = 1
        elif field.default is not None:
            row[field.name] = field.default
        elif field.nullable:
            row[field.name] = None
        else:
            row[field.name] = ""
    return require_frozen_object(row)


def _insert_plan(catalog, entity_type: str, row: Mapping[str, object]) -> DbMutationPlan:
    spec = catalog.get(entity_type)
    return DbMutationPlan(
        spec.table_name,
        {spec.primary_key: row[spec.primary_key]},
        "insert",
        None,
        None,
        row,
    )


def _update_plan(
    catalog, entity_type: str,
    before: Mapping[str, object], after: Mapping[str, object],
) -> DbMutationPlan:
    spec = catalog.get(entity_type)
    version = before.get("version")
    expected = version if isinstance(version, int) else None
    return DbMutationPlan(
        spec.table_name,
        {spec.primary_key: after[spec.primary_key]},
        "update",
        expected,
        before,
        after,
    )


def _create_sync(
    entity_type: str, row: Mapping[str, object], timestamp: str,
) -> SyncEventPlan:
    return SyncEventPlan(
        entity_type,
        str(row.get("id", "")),
        "create",
        row,
        int(row.get("version", 1)),
        timestamp,
    )


def _update_sync(
    entity_type: str, row: Mapping[str, object], timestamp: str,
) -> SyncEventPlan:
    return SyncEventPlan(
        entity_type,
        str(row.get("id", "")),
        "update",
        row,
        int(row.get("version", 1)),
        timestamp,
    )


# ---------------------------------------------------------------------------
# camelCase projectors
# ---------------------------------------------------------------------------

def _to_camel_session(row: Mapping[str, object]) -> Mapping[str, object]:
    return require_frozen_object({
        "id": row.get("id"),
        "sessionRevision": row.get("session_revision"),
        "startedAt": row.get("started_at"),
        "endedAt": row.get("ended_at"),
        "pauseStartedAt": row.get("pause_started_at"),
        "plannedSeconds": row.get("planned_seconds"),
        "grossSeconds": row.get("gross_seconds"),
        "pausedSeconds": row.get("paused_seconds"),
        "breakSeconds": row.get("break_seconds"),
        "focusedSeconds": row.get("focused_seconds"),
        "timerCompletion": row.get("timer_completion"),
        "validity": row.get("validity"),
        "validityReason": row.get("validity_reason"),
        "overallProgress": row.get("overall_progress"),
        "mood": row.get("mood"),
        "sessionNote": row.get("session_note"),
        "reviewState": row.get("review_state"),
        "ownershipState": row.get("ownership_state"),
        "version": row.get("version"),
    })


def _to_camel_context(row: Mapping[str, object]) -> Mapping[str, object]:
    return require_frozen_object({
        "id": row.get("id"),
        "sessionId": row.get("session_id"),
        "projectId": row.get("project_id"),
        "level2WorkItemId": row.get("level2_work_item_id"),
        "titleSnapshot": row.get("title_snapshot"),
        "parentSnapshot": row.get("parent_snapshot"),
        "estimateSnapshot": row.get("estimate_snapshot"),
        "statusSnapshot": row.get("status_snapshot"),
        "structureSnapshot": row.get("structure_snapshot"),
        "linkedAt": row.get("linked_at"),
        "linkMethod": row.get("link_method"),
        "version": row.get("version"),
    })


def _to_camel_plan(row: Mapping[str, object]) -> Mapping[str, object]:
    return require_frozen_object({
        "id": row.get("id"),
        "sessionId": row.get("session_id"),
        "workItemId": row.get("work_item_id"),
        "titleSnapshot": row.get("title_snapshot"),
        "level2Snapshot": row.get("level2_snapshot"),
        "planRank": row.get("plan_rank"),
        "source": row.get("source"),
        "addedAt": row.get("added_at"),
        "removedAt": row.get("removed_at"),
        "removalReason": row.get("removal_reason"),
        "currentDuringSession": row.get("current_during_session"),
        "completionDraft": row.get("completion_draft"),
        "version": row.get("version"),
    })


def _integer_seconds_between(start_iso: str, end_iso: str) -> int:
    """Compute floor((end - start) / 1000) for canonical UTC RFC 3339 strings."""
    from datetime import datetime

    start = datetime.fromisoformat(start_iso.replace("Z", "+00:00"))
    end = datetime.fromisoformat(end_iso.replace("Z", "+00:00"))
    delta_ms = int((end - start).total_seconds() * 1000)
    return delta_ms // 1000
