"""TS2 Task 2: Focus Session S3 mutation domain policy.

Owns the five TS0 Session entity types and routes both TS2 domain
commands and S4 EntityCommand create/update/delete requests through S3
``MutationCompileContext``.  No second compiler, journal, interpreter,
or transaction owner is created.
"""

from __future__ import annotations

import inspect
import json
from collections.abc import Callable, Mapping
from datetime import datetime, timedelta

from app.mutation.types import (
    DbMutationPlan,
    MutationCommand,
    MutationRequest,
    SyncEventPlan,
    require_frozen_object,
    validate_canonical_timestamp,
)
from app.mutation.types import (
    MutationRuleViolation as _MutationRuleViolation,
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

    def __init__(self, locator_reader: Callable[..., object] | object | None = None) -> None:
        """Create the policy with the TS0 locator reader.

        The reader is deliberately injected instead of opening the Meta
        database from S3.  Test-only callers from the first Task 2 draft may
        omit it; in that compatibility mode owner fencing is unavailable, but
        every production/coordinator path must provide the reader.
        """
        self._locator = locator_reader

    async def _read_locator(
        self, context: MutationCompileContext, request: MutationRequest,
    ) -> Mapping[str, object] | None:
        reader = self._locator
        if reader is None:
            return None
        if callable(reader):
            try:
                value = reader(context.scope, request)
            except TypeError:
                value = reader()
        elif hasattr(reader, "read"):
            value = reader.read(context.scope, request)
        elif hasattr(reader, "get"):
            value = reader.get()
        else:
            value = reader
        if inspect.isawaitable(value):
            value = await value
        if value is None:
            return None
        if isinstance(value, Mapping):
            return value
        return {
            name: getattr(value, name)
            for name in (
                "state", "space_id", "session_id", "operation_id",
                "owner_device_id", "owner_tab_id", "ownership_epoch",
            )
            if hasattr(value, name)
        }

    @staticmethod
    def _locator_value(row: Mapping[str, object], name: str) -> object:
        return row.get(name, row.get(_snake_to_camel(name)))

    async def _require_locator_claim(
        self,
        context: MutationCompileContext,
        request: MutationRequest,
        *,
        require_owner: bool = True,
    ) -> Mapping[str, object] | None:
        if self._locator is None:
            return None
        row = await self._read_locator(context, request)
        payload = request.payload
        expected_epoch = payload.get("ownership_epoch")
        if (
            row is None
            or self._locator_value(row, "state") != "claiming"
            or self._locator_value(row, "operation_id") != context.operation_id
            or self._locator_value(row, "space_id") != payload.get("space_id")
            or self._locator_value(row, "session_id") != payload.get("session_id", request.entity_id)
            or (
                expected_epoch is not None
                and self._locator_value(row, "ownership_epoch") != expected_epoch
            )
        ):
            raise _MutationRuleViolation(
                "stale_session_owner",
                {"sessionId": request.entity_id, "operationId": context.operation_id},
            )
        if require_owner:
            for payload_name, locator_name in (
                ("owner_device_id", "owner_device_id"),
                ("owner_tab_id", "owner_tab_id"),
            ):
                supplied = payload.get(payload_name)
                if supplied is not None and supplied != self._locator_value(row, locator_name):
                    raise _MutationRuleViolation(
                        "stale_session_owner",
                        {"sessionId": request.entity_id, "reason": payload_name},
                    )
        return row

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
        await self._require_locator_claim(context, request, require_owner=True)
        session_id = str(request.payload.get("session_id", request.entity_id))
        existing = context.authority.row("focus_session", session_id)
        if existing is not None:
            raise _MutationRuleViolation(
                "version_conflict", {"entityId": session_id},
            )
        started_at = str(request.payload.get("started_at", ""))
        try:
            validate_canonical_timestamp(started_at)
        except (TypeError, ValueError) as exc:
            raise _MutationRuleViolation(
                "version_conflict", {"entityId": session_id, "reason": "invalid_timestamp"},
            ) from exc
        planned_value = request.payload.get("planned_seconds", 0)
        if type(planned_value) is not int or planned_value <= 0:
            raise _MutationRuleViolation(
                "version_conflict", {"entityId": session_id, "reason": "invalid_planned_seconds"},
            )
        planned_seconds = planned_value
        context_l2_id = str(request.payload.get("level2_work_item_id", ""))
        l3_ids = request.payload.get("level3_work_item_ids", ())
        if not isinstance(l3_ids, (tuple, list)):
            raise _MutationRuleViolation(
                "invalid_work_item_tree", {"reason": "level3_ids_not_collection"},
            )
        l3_ids = tuple(str(item) for item in l3_ids)
        if len(set(l3_ids)) != len(l3_ids):
            raise _MutationRuleViolation(
                "invalid_work_item_tree", {"reason": "duplicate_level3_ids"},
            )
        work_item_versions = request.payload.get("expected_work_item_versions")
        if work_item_versions is not None:
            self._validate_start_work_items(
                context, context_l2_id, l3_ids, work_item_versions,
            )
        l2 = context.authority.row("work_item", context_l2_id)
        project_id = str(request.payload.get("project_id", ""))
        if l2 is not None:
            project_id = str(l2.get("project_id", project_id))
        if not project_id:
            project_id = str(request.payload.get("project_id", ""))
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
        context_row = _context_row(
            id=f"ctx-{session_id}",
            session_id=session_id,
            project_id=project_id,
            level2_work_item_id=context_l2_id,
            title_snapshot=str(
                l2.get("title", request.payload.get("level2_title_snapshot", ""))
                if l2 is not None else request.payload.get("level2_title_snapshot", "")
            ),
            parent_snapshot=(l2.get("parent_id") if l2 is not None else None),
            estimate_snapshot=(
                l2.get("effort_estimate_upper_seconds") if l2 is not None else None
            ),
            status_snapshot=(
                l2.get("status_definition_id") if l2 is not None else None
            ),
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
        plan_rows = tuple(
            _plan_row(
                id=f"plan-{session_id}-{l3_id}",
                session_id=session_id,
                work_item_id=str(l3_id),
                title_snapshot=str(
                    (
                        context.authority.row("work_item", str(l3_id)) or {}
                    ).get("title", request.payload.get("level3_title_snapshot", ""))
                ),
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
            "attribution": [_to_camel_attribution(attribution_row)],
            "plan": [_to_camel_plan(p) for p in plan_rows],
        })
        return context.command(
            request=request,
            db_plans=db_plans,
            sync_events=sync_events,
            value=value,
        )

    def _validate_start_work_items(
        self,
        context: MutationCompileContext,
        level2_id: str,
        level3_ids: tuple[str, ...],
        expected_versions: object,
    ) -> None:
        if not isinstance(expected_versions, Mapping):
            raise _MutationRuleViolation(
                "invalid_work_item_tree", {"reason": "expected_versions_not_mapping"},
            )
        expected_ids = {level2_id, *level3_ids}
        if set(expected_versions) != expected_ids or any(
            type(value) is not int or value < 0 for value in expected_versions.values()
        ):
            raise _MutationRuleViolation(
                "work_item_structure_changed", {"reason": "expected_versions"},
            )
        level2 = context.authority.row("work_item", level2_id)
        if level2 is None:
            raise _MutationRuleViolation("not_found", {"entityId": level2_id})
        project_id = str(level2.get("project_id", ""))
        if _work_item_depth(context.authority, level2) != 2:
            raise _MutationRuleViolation(
                "invalid_work_item_tree", {"reason": "level2_depth"},
            )
        self._validate_work_item_snapshot(context, level2, expected_versions[level2_id])
        for item_id in level3_ids:
            item = context.authority.row("work_item", item_id)
            if item is None:
                raise _MutationRuleViolation("not_found", {"entityId": item_id})
            if str(item.get("project_id")) != project_id or item.get("parent_id") != level2_id:
                raise _MutationRuleViolation(
                    "invalid_work_item_tree", {"reason": "parent_project_mismatch", "entityId": item_id},
                )
            if _work_item_depth(context.authority, item) != 3:
                raise _MutationRuleViolation(
                    "invalid_work_item_tree", {"reason": "level3_depth", "entityId": item_id},
                )
            self._validate_work_item_snapshot(context, item, expected_versions[item_id])

    @staticmethod
    def _validate_work_item_snapshot(
        context: MutationCompileContext,
        row: Mapping[str, object],
        expected_version: object,
    ) -> None:
        if row.get("version") != expected_version:
            raise _MutationRuleViolation(
                "version_conflict", {"entityId": row.get("id"), "expectedVersion": expected_version},
            )
        if row.get("completed_at") is not None or row.get("cancelled_at") is not None:
            raise _MutationRuleViolation(
                "version_conflict", {"entityId": row.get("id"), "reason": "terminal_work_item"},
            )
        status_id = row.get("status_definition_id")
        if status_id is not None:
            status = context.authority.row("status_definition", status_id)
            if status is not None and status.get("category") in {"completed", "cancelled"}:
                raise _MutationRuleViolation(
                    "version_conflict", {"entityId": row.get("id"), "reason": "terminal_work_item"},
                )

    async def _compile_clock_transition(
        self, context: MutationCompileContext, request: MutationRequest,
    ) -> MutationCommand:
        context.require_space(str(request.payload.get("space_id", "")))
        await self._require_locator_claim(context, request, require_owner=True)
        session_id = str(request.payload.get("session_id", request.entity_id))
        current = context.authority.row("focus_session", session_id)
        if current is None:
            raise _MutationRuleViolation("not_found", {"entityId": session_id})
        expected_version = request.expected_version
        if expected_version is None or current.get("version") != expected_version:
            raise _MutationRuleViolation(
                "version_conflict",
                {"entityId": session_id, "expectedVersion": expected_version},
            )
        action = request.name.rsplit(".", 1)[-1]
        occurred_at = str(request.payload.get("occurred_at", ""))
        _require_canonical_timestamp(occurred_at)
        _require_non_regressing_timestamp(current, occurred_at)
        _validate_duration_row(current)
        after = dict(current)
        after["updated_at"] = occurred_at
        if "break_seconds" in request.payload:
            break_seconds = request.payload["break_seconds"]
            if type(break_seconds) is not int or break_seconds < 0:
                raise _MutationRuleViolation(
                    "version_conflict", {"sessionId": session_id, "reason": "invalid_duration"}
                )
            after["break_seconds"] = break_seconds
        started_at = str(current.get("started_at", ""))
        _require_canonical_timestamp(started_at)
        if action == "pause":
            if current.get("pause_started_at") is not None or current.get("ended_at") is not None:
                raise _MutationRuleViolation(
                    "version_conflict",
                    {"sessionId": session_id, "reason": "not_running"},
                )
            after["pause_started_at"] = occurred_at
            after["gross_seconds"] = _integer_seconds_between(started_at, occurred_at)
            after["focused_seconds"] = _focused_seconds(after)
        elif action == "resume":
            if current.get("pause_started_at") is None or current.get("ended_at") is not None:
                raise _MutationRuleViolation(
                    "version_conflict",
                    {"sessionId": session_id, "reason": "not_paused"},
                )
            pause_started = str(current.get("pause_started_at", ""))
            elapsed_pause = _integer_seconds_between(pause_started, occurred_at)
            after["paused_seconds"] = int(current.get("paused_seconds", 0)) + elapsed_pause
            after["pause_started_at"] = None
            after["gross_seconds"] = _integer_seconds_between(started_at, occurred_at)
            after["focused_seconds"] = _focused_seconds(after)
        elif action == "end":
            if current.get("ended_at") is not None:
                raise _MutationRuleViolation(
                    "version_conflict",
                    {"sessionId": session_id, "reason": "already_ended"},
                )
            if current.get("pause_started_at") is not None:
                pause_started = str(current.get("pause_started_at", ""))
                elapsed_pause = _integer_seconds_between(pause_started, occurred_at)
                after["paused_seconds"] = int(current.get("paused_seconds", 0)) + elapsed_pause
                after["pause_started_at"] = None
            after["ended_at"] = occurred_at
            after["gross_seconds"] = _integer_seconds_between(started_at, occurred_at)
            after["focused_seconds"] = _focused_seconds(after)
            after["timer_completion"] = str(request.payload.get("timer_completion", "completed"))
            after["validity"] = str(request.payload.get("validity", "valid"))
            after["validity_reason"] = request.payload.get("validity_reason")
            if after["timer_completion"] not in {"completed", "ended_early", "interrupted"}:
                raise _MutationRuleViolation(
                    "version_conflict", {"sessionId": session_id, "reason": "invalid_timer_completion"}
                )
            if after["validity"] not in {"pending", "valid", "invalid"}:
                raise _MutationRuleViolation(
                    "version_conflict", {"sessionId": session_id, "reason": "invalid_validity"}
                )
        else:
            raise _MutationRuleViolation(
                "version_conflict", {"sessionId": session_id, "reason": "unsupported_clock_action"},
            )
        _validate_duration_row(after)
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
            context,
            request,
            {"session_note": str(request.payload.get("session_note", ""))},
            require_owner=True,
            require_cas=True,
        )

    async def _compile_review(
        self, context: MutationCompileContext, request: MutationRequest,
    ) -> MutationCommand:
        context.require_space(str(request.payload.get("space_id", "")))
        session_id = str(request.payload.get("session_id", request.entity_id))
        current = context.authority.row("focus_session", session_id)
        if current is None:
            raise _MutationRuleViolation("not_found", {"entityId": session_id})
        if current.get("ended_at") is None:
            raise _MutationRuleViolation(
                "version_conflict", {"sessionId": session_id, "reason": "session_not_ended"}
            )
        if request.expected_version is None or current.get("version") != request.expected_version:
            raise _MutationRuleViolation(
                "version_conflict", {"entityId": session_id, "expectedVersion": request.expected_version}
            )
        reviewed_at = _require_canonical_timestamp(
            request.payload.get("reviewed_at", current.get("ended_at"))
        )
        if _parse_timestamp(reviewed_at) < _parse_timestamp(str(current["ended_at"])):
            raise _MutationRuleViolation(
                "version_conflict", {"sessionId": session_id, "reason": "review_time_regression"}
            )
        review_state = str(request.payload.get("review_state", "completed"))
        validity = str(request.payload.get("validity", "valid"))
        if review_state not in {"completed", "skipped"} or validity not in {"valid", "invalid"}:
            raise _MutationRuleViolation(
                "work_item_structure_changed", {"reason": "review_state"}
            )
        after = dict(current)
        after.update({
            "review_state": review_state,
            "validity": validity,
            "validity_reason": request.payload.get("validity_reason"),
            "updated_at": reviewed_at,
            "version": int(current["version"]) + 1,
        })
        frozen_after = require_frozen_object(after)
        return context.command(
            request=request,
            db_plans=(_update_plan(context.catalog, "focus_session", current, frozen_after),),
            sync_events=(_update_sync("focus_session", frozen_after, reviewed_at),),
            value=require_frozen_object({"session": _to_camel_session(frozen_after)}),
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
        return await self._compile_attribution_append(context, request)

    async def _compile_set_current(
        self, context: MutationCompileContext, request: MutationRequest,
    ) -> MutationCommand:
        return await self._compile_plan_transition(context, request, "current")

    async def _compile_completion_draft(
        self, context: MutationCompileContext, request: MutationRequest,
    ) -> MutationCommand:
        return await self._compile_plan_transition(context, request, "completion_draft")

    async def _compile_add_plan(
        self, context: MutationCompileContext, request: MutationRequest,
    ) -> MutationCommand:
        return await self._compile_plan_transition(context, request, "add")

    async def _compile_remove_plan(
        self, context: MutationCompileContext, request: MutationRequest,
    ) -> MutationCommand:
        return await self._compile_plan_transition(context, request, "remove")

    async def _compile_activation(
        self, context: MutationCompileContext, request: MutationRequest,
    ) -> MutationCommand:
        return await self._compile_activation_snapshot(context, request)

    async def _compile_conflict(
        self, context: MutationCompileContext, request: MutationRequest,
    ) -> MutationCommand:
        return await self._compile_field_update(
            context, request, {"ownership_state": "activation_conflict"},
        )

    async def _compile_resolution(
        self, context: MutationCompileContext, request: MutationRequest,
    ) -> MutationCommand:
        winner = request.payload.get("winner_role")
        state = "authoritative" if winner in {"active", "candidate"} else "activation_conflict"
        return await self._compile_field_update(
            context, request, {"ownership_state": state},
        )

    async def _compile_owner_claim(
        self, context: MutationCompileContext, request: MutationRequest,
    ) -> MutationCommand:
        context.require_space(str(request.payload.get("space_id", "")))
        await self._require_locator_claim(context, request, require_owner=True)
        session_id = str(request.payload.get("session_id", request.entity_id))
        session = context.authority.row("focus_session", session_id)
        if session is None:
            raise _MutationRuleViolation("not_found", {"entityId": session_id})
        if session.get("ended_at") is not None:
            raise _MutationRuleViolation(
                "version_conflict", {"sessionId": session_id, "reason": "terminal_session"}
            )
        return context.command(
            request=request,
            db_plans=(),
            sync_events=(),
            value=require_frozen_object({"claimed": True}),
        )

    async def _compile_receipt(
        self, context: MutationCompileContext, request: MutationRequest,
    ) -> MutationCommand:
        return await self._compile_receipt_row(context, request)

    async def _compile_rebuild_effort(
        self, context: MutationCompileContext, request: MutationRequest,
    ) -> MutationCommand:
        return await self._compile_field_update(context, request, {})

    async def _compile_attribution_append(
        self, context: MutationCompileContext, request: MutationRequest,
    ) -> MutationCommand:
        context.require_space(str(request.payload.get("space_id", "")))
        session_id = str(request.payload.get("session_id", request.entity_id))
        session = context.authority.row("focus_session", session_id)
        if session is None:
            raise _MutationRuleViolation("not_found", {"entityId": session_id})
        rows = tuple(
            context.authority.rows("session_attribution_revision")
        )
        current = tuple(
            sorted(
                (row for row in rows if row.get("session_id") == session_id),
                key=lambda row: int(row.get("revision", 0)),
            )
        )
        revision = int(request.payload.get("revision", max((int(row.get("revision", 0)) for row in current), default=0) + 1))
        if revision != max((int(row.get("revision", 0)) for row in current), default=0) + 1:
            raise _MutationRuleViolation(
                "version_conflict", {"sessionId": session_id, "reason": "attribution_revision"},
            )
        effective = next((row for row in reversed(current) if row.get("effective") is True), None)
        project_id = str(request.payload.get("project_id", ""))
        level2_id = str(request.payload.get("level2_work_item_id", ""))
        context_row = context.authority.row("session_task_context", f"ctx-{session_id}")
        if context_row is not None:
            project_id = str(context_row.get("project_id", project_id))
            level2_id = str(context_row.get("level2_work_item_id", level2_id))
        if not project_id or not level2_id:
            raise _MutationRuleViolation(
                "work_item_structure_changed", {"reason": "attribution_target_missing"},
            )
        now = str(request.payload.get("occurred_at", session.get("updated_at", "")))
        _require_canonical_timestamp(now)
        new_row = _attribution_row(
            id=f"attr-{session_id}-{revision}",
            session_id=session_id,
            revision=revision,
            project_id=project_id,
            level2_work_item_id=level2_id,
            reason=request.payload.get("reason"),
            corrected_from_revision=(
                int(effective.get("revision")) if effective is not None else None
            ),
            effective=True,
            version=1,
            created_at=now,
            updated_at=now,
        )
        plans: list[DbMutationPlan] = []
        events: list[SyncEventPlan] = []
        session_image = require_frozen_object(dict(session))
        plans.append(_update_plan(context.catalog, "focus_session", session_image, session_image))
        events.append(_update_sync("focus_session", session_image, str(session_image.get("updated_at", now))))
        if effective is not None:
            old = dict(effective)
            old["effective"] = False
            old["version"] = int(old.get("version", 1)) + 1
            old["updated_at"] = now
            frozen_old = require_frozen_object(old)
            plans.append(_update_plan(context.catalog, "session_attribution_revision", effective, frozen_old))
            events.append(_update_sync("session_attribution_revision", frozen_old, now))
        plans.append(_insert_plan(context.catalog, "session_attribution_revision", new_row))
        events.append(_create_sync("session_attribution_revision", new_row, now))
        return context.command(
            request=request,
            db_plans=tuple(plans),
            sync_events=tuple(events),
            value=require_frozen_object({
                "session": _to_camel_session(session),
                "attribution": [_to_camel_attribution(new_row)],
            }),
        )

    async def _compile_plan_transition(
        self, context: MutationCompileContext, request: MutationRequest, action: str,
    ) -> MutationCommand:
        context.require_space(str(request.payload.get("space_id", "")))
        await self._require_locator_claim(context, request, require_owner=True)
        session_id = str(request.payload.get("session_id", request.entity_id))
        session = context.authority.row("focus_session", session_id)
        if session is None:
            raise _MutationRuleViolation("not_found", {"entityId": session_id})
        if session.get("ended_at") is not None:
            raise _MutationRuleViolation(
                "version_conflict", {"sessionId": session_id, "reason": "terminal_session"},
            )
        rows = [
            dict(row) for row in context.authority.rows("session_work_item_plan")
            if row.get("session_id") == session_id
        ]
        plans: list[DbMutationPlan] = []
        events: list[SyncEventPlan] = []
        now = str(request.payload.get("occurred_at") or request.payload.get("added_at") or session.get("updated_at", ""))
        _require_canonical_timestamp(now)
        # S3 validates that every domain command has an effect for its
        # request entity.  Plan-only commands intentionally do not advance
        # the FocusSession version, so bind a complete no-op post-image to
        # the request while the actual state change is carried by the Plan
        # row below.
        session_image = require_frozen_object(dict(session))
        plans.append(_update_plan(context.catalog, "focus_session", session_image, session_image))
        events.append(_update_sync("focus_session", session_image, str(session_image.get("updated_at", now))))
        if action == "current":
            expected = request.payload.get("expected_plan_versions", {})
            if not isinstance(expected, Mapping):
                raise _MutationRuleViolation("work_item_structure_changed", {"reason": "plan_versions"})
            row_ids = {str(row["id"]) for row in rows}
            if set(expected) != row_ids or any(type(value) is not int or value < 0 for value in expected.values()):
                raise _MutationRuleViolation("work_item_structure_changed", {"reason": "plan_versions"})
            target = request.payload.get("work_item_id")
            if target is not None and not any(
                row.get("work_item_id") == target and row.get("removed_at") is None for row in rows
            ):
                raise _MutationRuleViolation("not_found", {"entityId": target})
            for row in rows:
                if row["id"] not in expected or row["version"] != expected[row["id"]]:
                    raise _MutationRuleViolation("version_conflict", {"entityId": row["id"]})
                after = dict(row)
                after["current_during_session"] = (
                    target is not None and row.get("work_item_id") == target and row.get("removed_at") is None
                )
                after["updated_at"] = now
                after["version"] = int(row["version"]) + 1
                frozen_after = require_frozen_object(after)
                plans.append(_update_plan(context.catalog, "session_work_item_plan", row, frozen_after))
                events.append(_update_sync("session_work_item_plan", frozen_after, now))
        elif action == "completion_draft":
            row = _find_plan(rows, request.payload.get("plan_item_id"))
            _require_plan_version(row, request.payload.get("expected_plan_version"))
            if type(request.payload.get("completion_draft")) is not bool:
                raise _MutationRuleViolation("work_item_structure_changed", {"reason": "completion_draft"})
            after = dict(row)
            after["completion_draft"] = request.payload.get("completion_draft")
            after["updated_at"] = now
            after["version"] = int(row["version"]) + 1
            frozen_after = require_frozen_object(after)
            plans.append(_update_plan(context.catalog, "session_work_item_plan", row, frozen_after))
            events.append(_update_sync("session_work_item_plan", frozen_after, now))
        elif action == "add":
            work_item_id = str(request.payload.get("work_item_id", ""))
            if any(row.get("work_item_id") == work_item_id for row in rows):
                raise _MutationRuleViolation("version_conflict", {"entityId": work_item_id})
            work_item = context.authority.row("work_item", work_item_id)
            if work_item is None:
                raise _MutationRuleViolation("not_found", {"entityId": work_item_id})
            expected_work_item_version = request.payload.get("expected_work_item_version")
            self._validate_work_item_snapshot(context, work_item, expected_work_item_version)
            context_row = context.authority.row("session_task_context", f"ctx-{session_id}")
            level2_id = context_row.get("level2_work_item_id") if context_row else None
            if level2_id is not None and work_item.get("parent_id") != level2_id:
                raise _MutationRuleViolation("invalid_work_item_tree", {"reason": "plan_parent"})
            if _work_item_depth(context.authority, work_item) != 3:
                raise _MutationRuleViolation("invalid_work_item_tree", {"reason": "plan_depth"})
            plan = _plan_row(
                id=f"plan-{session_id}-{work_item_id}",
                session_id=session_id,
                work_item_id=work_item_id,
                title_snapshot=str(work_item.get("title", "")),
                level2_snapshot=level2_id,
                plan_rank=int(request.payload.get("plan_rank", len(rows))),
                source="during_session",
                added_at=str(request.payload.get("added_at", now)),
                removed_at=None,
                removal_reason=None,
                current_during_session=False,
                completion_draft=False,
                version=1,
                created_at=now,
                updated_at=now,
            )
            plans.append(_insert_plan(context.catalog, "session_work_item_plan", plan))
            events.append(_create_sync("session_work_item_plan", plan, now))
        elif action == "remove":
            row = _find_plan(rows, request.payload.get("plan_item_id"))
            _require_plan_version(row, request.payload.get("expected_plan_version"))
            if row.get("removed_at") is not None:
                raise _MutationRuleViolation("version_conflict", {"entityId": row.get("id")})
            reason = request.payload.get("removal_reason")
            if not isinstance(reason, str) or not reason.strip():
                raise _MutationRuleViolation("work_item_structure_changed", {"reason": "removal_reason"})
            after = dict(row)
            after.update({
                "removed_at": request.payload.get("removed_at", now),
                "removal_reason": reason,
                "current_during_session": False,
                "updated_at": now,
                "version": int(row["version"]) + 1,
            })
            _require_canonical_timestamp(after["removed_at"])
            frozen_after = require_frozen_object(after)
            plans.append(_update_plan(context.catalog, "session_work_item_plan", row, frozen_after))
            events.append(_update_sync("session_work_item_plan", frozen_after, now))
        else:
            raise _MutationRuleViolation("work_item_structure_changed", {"reason": "unknown_plan_action"})
        return context.command(
            request=request,
            db_plans=tuple(plans),
            sync_events=tuple(events),
            value=require_frozen_object({
                "session": _to_camel_session(session),
                "plan": [_to_camel_plan(row) for row in rows],
            }),
        )

    async def _compile_activation_snapshot(
        self, context: MutationCompileContext, request: MutationRequest,
    ) -> MutationCommand:
        context.require_space(str(request.payload.get("space_id", "")))
        await self._require_locator_claim(context, request, require_owner=True)
        snapshot = request.payload.get("snapshot")
        if not isinstance(snapshot, Mapping):
            raise _MutationRuleViolation(
                "work_item_structure_changed", {"reason": "snapshot_required"}
            )
        raw_session = snapshot.get("session")
        if not isinstance(raw_session, Mapping):
            raise _MutationRuleViolation("work_item_structure_changed", {"reason": "snapshot_session"})
        current = context.authority.row("focus_session", request.entity_id)
        if current is not None:
            raise _MutationRuleViolation(
                "version_conflict", {"entityId": request.entity_id, "reason": "session_exists"}
            )
        def get(name: str, camel: str | None = None) -> object:
            return raw_session.get(name, raw_session.get(camel or _snake_to_camel(name)))

        started_at = _require_canonical_timestamp(get("started_at", "startedAt"))
        cached_at = _require_canonical_timestamp(request.payload.get("cached_at"))
        if _parse_timestamp(started_at) > _parse_timestamp(cached_at):
            raise _MutationRuleViolation(
                "work_item_structure_changed", {"reason": "snapshot_time_range"}
            )
        row = _focus_session_row(
            id=request.entity_id,
            session_revision=int(get("session_revision", "sessionRevision") or 1),
            started_at=started_at,
            ended_at=get("ended_at", "endedAt"),
            pause_started_at=get("pause_started_at", "pauseStartedAt"),
            planned_seconds=get("planned_seconds", "plannedSeconds"),
            gross_seconds=get("gross_seconds", "grossSeconds"),
            paused_seconds=get("paused_seconds", "pausedSeconds"),
            break_seconds=get("break_seconds", "breakSeconds"),
            focused_seconds=get("focused_seconds", "focusedSeconds"),
            timer_completion=get("timer_completion", "timerCompletion"),
            validity="pending",
            validity_reason=get("validity_reason", "validityReason"),
            overall_progress=get("overall_progress", "overallProgress"),
            mood=get("mood"),
            session_note=str(get("session_note", "sessionNote") or ""),
            review_state="not_required",
            ownership_state="local_provisional",
            version=1,
            created_at=started_at,
            updated_at=cached_at,
        )
        _validate_duration_row(row)
        for field in ("ended_at", "pause_started_at"):
            value = row.get(field)
            if value is not None:
                _require_canonical_timestamp(value)
                if _parse_timestamp(str(value)) > _parse_timestamp(cached_at):
                    raise _MutationRuleViolation(
                        "work_item_structure_changed", {"reason": "snapshot_time_range", "field": field}
                    )
        context_row = _snapshot_context_row(request, snapshot)
        if not context_row.get("project_id") or not context_row.get("level2_work_item_id"):
            raise _MutationRuleViolation("work_item_structure_changed", {"reason": "snapshot_context"})
        plan_rows = snapshot.get("plan", ())
        if not isinstance(plan_rows, (tuple, list)):
            raise _MutationRuleViolation("work_item_structure_changed", {"reason": "snapshot_plan"})
        converted_plans: list[Mapping[str, object]] = []
        for item in plan_rows:
            if not isinstance(item, Mapping):
                raise _MutationRuleViolation("work_item_structure_changed", {"reason": "snapshot_plan_item"})
            def item_get(name: str, camel: str | None = None) -> object:
                return item.get(name, item.get(camel or _snake_to_camel(name)))
            added_at = _require_canonical_timestamp(item_get("added_at", "addedAt"))
            removed_at = item_get("removed_at", "removedAt")
            if removed_at is not None:
                _require_canonical_timestamp(removed_at)
            converted = _plan_row(
                id=str(item_get("id") or ""),
                session_id=request.entity_id,
                work_item_id=str(item_get("work_item_id", "workItemId") or ""),
                title_snapshot=str(item_get("title_snapshot", "titleSnapshot") or ""),
                level2_snapshot=str(item_get("level2_work_item_id_snapshot", "level2WorkItemIdSnapshot") or ""),
                plan_rank=item_get("plan_rank", "planRank"),
                source=str(item_get("source") or "before_start"),
                added_at=added_at,
                removed_at=removed_at,
                removal_reason=item_get("removal_reason", "removalReason"),
                current_during_session=bool(item_get("current_during_session", "currentDuringSession")),
                completion_draft=bool(item_get("completion_draft", "completionDraft")),
                version=1,
                created_at=added_at,
                updated_at=cached_at,
            )
            converted_plans.append(converted)
        attribution = _attribution_row(
            id=f"attr-{request.entity_id}-1",
            session_id=request.entity_id,
            revision=1,
            project_id=str(context_row["project_id"]),
            level2_work_item_id=str(context_row["level2_work_item_id"]),
            reason=None,
            corrected_from_revision=None,
            effective=True,
            version=1,
            created_at=started_at,
            updated_at=cached_at,
        )
        plans: list[DbMutationPlan] = [
            _insert_plan(context.catalog, "focus_session", row),
            _insert_plan(context.catalog, "session_task_context", context_row),
            _insert_plan(context.catalog, "session_attribution_revision", attribution),
        ]
        plans.extend(_insert_plan(context.catalog, "session_work_item_plan", item) for item in converted_plans)
        sync_events: list[SyncEventPlan] = [
            _create_sync("focus_session", row, cached_at),
            _create_sync("session_task_context", context_row, cached_at),
            _create_sync("session_attribution_revision", attribution, cached_at),
        ]
        sync_events.extend(_create_sync("session_work_item_plan", item, cached_at) for item in converted_plans)
        return context.command(
            request=request,
            db_plans=tuple(plans),
            sync_events=tuple(sync_events),
            value=require_frozen_object({
                "session": _to_camel_session(row),
                "context": _to_camel_context(context_row),
                "attribution": [_to_camel_attribution(attribution)],
                "plan": [_to_camel_plan(item) for item in converted_plans],
            }),
        )

    async def _compile_receipt_row(
        self, context: MutationCompileContext, request: MutationRequest,
    ) -> MutationCommand:
        context.require_space(str(request.payload.get("space_id", "")))
        command_id = str(request.payload.get("command_id", request.entity_id))
        envelope = context.authority.row("session_command_envelope", command_id)
        if envelope is None:
            raise _MutationRuleViolation("not_found", {"entityId": command_id})
        current = context.authority.row("session_command_receipt", command_id)
        now = str(request.payload.get("updated_at", envelope.get("created_at", "")))
        _require_canonical_timestamp(now)
        state = str(request.payload.get("state", "pending"))
        after = {
            "command_id": command_id,
            "state": state,
            "error_code": request.payload.get("error_code"),
            "retryable": bool(request.payload.get("retryable", False)),
            "details_json": _json_payload(request.payload.get("details")),
            "result_json": _json_payload(request.payload.get("result")),
            "updated_at": now,
        }
        frozen_after = require_frozen_object(after)
        if current is None:
            plan = _insert_plan(context.catalog, "session_command_receipt", frozen_after)
        else:
            plan = _update_plan(context.catalog, "session_command_receipt", current, frozen_after)
        session_id = str(request.payload.get("session_id", request.entity_id))
        session = context.authority.row("focus_session", session_id)
        if session is None:
            raise _MutationRuleViolation("not_found", {"entityId": session_id})
        session_image = require_frozen_object(dict(session))
        return context.command(
            request=request,
            db_plans=(
                _update_plan(context.catalog, "focus_session", session_image, session_image),
                plan,
            ),
            sync_events=(_update_sync("focus_session", session_image, str(session_image["updated_at"])),),
            value=require_frozen_object({"receipt": _project_receipt_mapping(frozen_after)}),
        )

    async def _compile_field_update(
        self, context: MutationCompileContext, request: MutationRequest,
        field_overrides: Mapping[str, object],
        *, require_owner: bool = False, require_cas: bool = False,
    ) -> MutationCommand:
        context.require_space(str(request.payload.get("space_id", "")))
        if require_owner:
            await self._require_locator_claim(context, request, require_owner=True)
        session_id = str(request.payload.get("session_id", request.entity_id))
        current = context.authority.row("focus_session", session_id)
        if current is None:
            raise _MutationRuleViolation("not_found", {"entityId": session_id})
        if require_cas:
            if request.expected_version is None or current.get("version") != request.expected_version:
                raise _MutationRuleViolation(
                    "version_conflict",
                    {"entityId": session_id, "expectedVersion": request.expected_version},
                )
        after = dict(current)
        after.update(field_overrides)
        version = int(current.get("version", 1))
        after["version"] = version + 1
        occurred_at = str(request.payload.get("occurred_at", ""))
        if occurred_at:
            _require_canonical_timestamp(occurred_at)
            _require_non_regressing_timestamp(current, occurred_at)
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
            raise _MutationRuleViolation(
                "work_item_structure_changed",
                {"entityType": entity_type, "action": action},
            )
        if action == "create":
            return await self._compile_sync_create(context, request, entity_type)
        if action == "update":
            return await self._compile_sync_update(context, request, entity_type)
        raise _MutationRuleViolation(
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
        unknown = set(row_data) - set(spec.field_names)
        if unknown:
            raise _MutationRuleViolation(
                "work_item_structure_changed", {"reason": "unknown_fields", "fields": tuple(sorted(unknown))}
            )
        if context.authority.row(entity_type, request.entity_id) is not None:
            raise _MutationRuleViolation("version_conflict", {"entityId": request.entity_id})
        timestamp = str(
            row_data.get("updated_at")
            or row_data.get("created_at")
            or request.client_updated_at
            or "2026-07-15T08:00:00Z"
        )
        _require_canonical_timestamp(timestamp)
        row_data.setdefault("version", 1)
        row_data.setdefault("created_at", timestamp)
        row_data.setdefault("updated_at", request.client_updated_at or timestamp)
        for field in spec.fields:
            if field.name not in row_data:
                if field.default is not None:
                    row_data[field.name] = field.default
                elif field.nullable:
                    row_data[field.name] = None
                else:
                    raise _MutationRuleViolation(
                        "version_conflict",
                        {"entityType": entity_type, "missing": field.name},
                    )
        _validate_sync_create_row(context, request, entity_type, row_data)
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
            raise _MutationRuleViolation("not_found", {"entityId": request.entity_id})
        if request.expected_version is None or current.get("version") != request.expected_version:
            raise _MutationRuleViolation(
                "version_conflict",
                {"entityId": request.entity_id, "expectedVersion": request.expected_version},
            )
        unknown = set(request.payload) - set(spec.field_names)
        if unknown:
            raise _MutationRuleViolation(
                "work_item_structure_changed", {"reason": "unknown_fields", "fields": tuple(sorted(unknown))}
            )
        _validate_sync_update_parent(context, entity_type, current)
        after = dict(current)
        for key, value in request.payload.items():
            if key not in {"id", "created_at", "version"}:
                after[key] = value
        version = int(current.get("version", 1))
        after["version"] = version + 1
        client_ts = str(request.client_updated_at or after.get("updated_at", ""))
        _require_canonical_timestamp(client_ts)
        if entity_type == "focus_session":
            _require_non_regressing_timestamp(current, client_ts)
        after["updated_at"] = client_ts
        _validate_sync_update_row(context, request, entity_type, current, after)
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
# Shared validation and projection helpers
# ---------------------------------------------------------------------------

_CAMEL_NAMES = {
    "space_id": "spaceId",
    "session_id": "sessionId",
    "operation_id": "operationId",
    "owner_device_id": "ownerDeviceId",
    "owner_tab_id": "ownerTabId",
    "ownership_epoch": "ownershipEpoch",
}


def _snake_to_camel(name: str) -> str:
    """Map the small locator field vocabulary without recursive conversion."""
    return _CAMEL_NAMES.get(name, name)


def _require_canonical_timestamp(value: object) -> str:
    if not isinstance(value, str):
        raise _MutationRuleViolation(
            "version_conflict", {"reason": "invalid_timestamp"}
        )
    try:
        validate_canonical_timestamp(value)
    except (TypeError, ValueError) as exc:
        raise _MutationRuleViolation(
            "version_conflict", {"reason": "invalid_timestamp"}
        ) from exc
    return value


def _parse_timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value[:-1] + "+00:00")


def _require_non_regressing_timestamp(
    current: Mapping[str, object], occurred_at: str,
) -> None:
    """Reject a transition earlier than any persisted lifecycle instant."""
    occurred = _parse_timestamp(occurred_at)
    persisted: list[datetime] = []
    for field in ("started_at", "pause_started_at", "ended_at", "updated_at"):
        value = current.get(field)
        if value is None:
            continue
        if not isinstance(value, str):
            raise _MutationRuleViolation(
                "version_conflict", {"reason": "invalid_timestamp", "field": field}
            )
        try:
            validate_canonical_timestamp(value)
            persisted.append(_parse_timestamp(value))
        except (TypeError, ValueError) as exc:
            raise _MutationRuleViolation(
                "version_conflict", {"reason": "invalid_timestamp", "field": field}
            ) from exc
    if persisted and occurred < max(persisted):
        raise _MutationRuleViolation(
            "version_conflict", {"reason": "time_regression"}
        )


def _strict_counter(row: Mapping[str, object], field: str) -> int:
    value = row.get(field)
    if type(value) is not int or value < 0:
        raise _MutationRuleViolation(
            "version_conflict", {"reason": "invalid_duration", "field": field}
        )
    return value


def _focused_seconds(row: Mapping[str, object]) -> int:
    gross = _strict_counter(row, "gross_seconds")
    paused = _strict_counter(row, "paused_seconds")
    breaks = _strict_counter(row, "break_seconds")
    if paused + breaks > gross:
        raise _MutationRuleViolation(
            "version_conflict", {"reason": "invalid_duration"}
        )
    return max(0, gross - paused - breaks)


def _validate_duration_row(row: Mapping[str, object]) -> None:
    planned = _strict_counter(row, "planned_seconds")
    if planned <= 0:
        raise _MutationRuleViolation(
            "version_conflict", {"reason": "invalid_duration", "field": "planned_seconds"}
        )
    expected = _focused_seconds(row)
    focused = _strict_counter(row, "focused_seconds")
    if focused != expected:
        raise _MutationRuleViolation(
            "version_conflict", {"reason": "invalid_duration", "field": "focused_seconds"}
        )


def _work_item_depth(authority: object, row: Mapping[str, object]) -> int:
    """Return a WorkItem's 1-based parent depth, failing closed on cycles."""
    depth = 1
    current = row
    visited = {str(row.get("id", ""))}
    while current.get("parent_id") is not None:
        parent_id = str(current["parent_id"])
        if parent_id in visited:
            raise _MutationRuleViolation(
                "invalid_work_item_tree", {"reason": "parent_cycle"}
            )
        visited.add(parent_id)
        parent = authority.row("work_item", parent_id)
        if parent is None:
            raise _MutationRuleViolation(
                "invalid_work_item_tree", {"reason": "missing_parent", "entityId": parent_id}
            )
        depth += 1
        current = parent
    return depth


def _find_plan(rows: list[Mapping[str, object]], plan_item_id: object) -> Mapping[str, object]:
    if not isinstance(plan_item_id, str) or not plan_item_id:
        raise _MutationRuleViolation("not_found", {"entityId": plan_item_id})
    for row in rows:
        if row.get("id") == plan_item_id:
            return row
    raise _MutationRuleViolation("not_found", {"entityId": plan_item_id})


def _require_plan_version(row: Mapping[str, object], expected: object) -> None:
    if type(expected) is not int or row.get("version") != expected:
        raise _MutationRuleViolation(
            "version_conflict",
            {"entityId": row.get("id"), "expectedVersion": expected},
        )


def _snapshot_context_row(
    request: MutationRequest, snapshot: Mapping[str, object],
) -> Mapping[str, object]:
    raw = snapshot.get("context")
    if not isinstance(raw, Mapping):
        raise _MutationRuleViolation("work_item_structure_changed", {"reason": "snapshot_context"})
    session_id = request.entity_id
    def get(snake: str, camel: str | None = None) -> object:
        return raw.get(snake, raw.get(camel or _snake_to_camel(snake)))
    linked_at = _require_canonical_timestamp(get("linked_at", "linkedAt"))
    upper = get("level2_effort_upper_seconds_snapshot", "level2EffortUpperSecondsSnapshot")
    return _context_row(
        id=f"ctx-{session_id}",
        session_id=session_id,
        project_id=str(get("project_id", "projectId") or ""),
        level2_work_item_id=str(get("level2_work_item_id", "level2WorkItemId") or ""),
        title_snapshot=str(get("level2_title_snapshot", "level2TitleSnapshot") or ""),
        parent_snapshot=get("level2_parent_id_snapshot", "level2ParentIdSnapshot"),
        estimate_snapshot=(None if upper is None else str(upper)),
        status_snapshot=get("level2_status_definition_id_snapshot", "level2StatusDefinitionIdSnapshot"),
        structure_snapshot="{}",
        linked_at=linked_at,
        link_method=str(get("link_method", "linkMethod") or ""),
        version=1,
        created_at=linked_at,
        updated_at=linked_at,
    )


def _json_payload(value: object) -> str | None:
    if value is None:
        return None
    try:
        return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
    except (TypeError, ValueError) as exc:
        raise _MutationRuleViolation("work_item_structure_changed", {"reason": "invalid_json"}) from exc


def _project_receipt_mapping(row: Mapping[str, object]) -> Mapping[str, object]:
    def decode(name: str) -> object | None:
        value = row.get(name)
        return None if value is None else json.loads(str(value))

    return require_frozen_object({
        "commandId": row.get("command_id"),
        "state": row.get("state"),
        "errorCode": row.get("error_code"),
        "retryable": row.get("retryable"),
        "details": decode("details_json"),
        "result": decode("result_json"),
        "updatedAt": row.get("updated_at"),
    })


def _require_provisional_session(
    context: MutationCompileContext, session_id: object,
) -> Mapping[str, object]:
    if not isinstance(session_id, str) or not session_id:
        raise _MutationRuleViolation("not_found", {"entityId": session_id})
    session = context.authority.row("focus_session", session_id)
    if session is None:
        raise _MutationRuleViolation("not_found", {"entityId": session_id})
    if session.get("ownership_state") not in {"local_provisional", "activation_conflict"}:
        raise _MutationRuleViolation(
            "stale_session_owner", {"sessionId": session_id, "reason": "authoritative_session"}
        )
    if session.get("validity") != "pending":
        raise _MutationRuleViolation(
            "work_item_structure_changed", {"sessionId": session_id, "reason": "session_not_pending"}
        )
    return session


def _validate_sync_create_row(
    context: MutationCompileContext,
    request: MutationRequest,
    entity_type: str,
    row: Mapping[str, object],
) -> None:
    if entity_type == "focus_session":
        if row.get("ownership_state") not in {"local_provisional", "activation_conflict"}:
            raise _MutationRuleViolation(
                "work_item_structure_changed", {"reason": "session_must_be_provisional"}
            )
        if row.get("validity") != "pending" or row.get("review_state") != "not_required":
            raise _MutationRuleViolation(
                "work_item_structure_changed", {"reason": "session_post_image_state"}
            )
        _require_canonical_timestamp(row.get("started_at"))
        _require_canonical_timestamp(row.get("updated_at"))
        _validate_duration_row(row)
        return
    session_id = row.get("session_id")
    session = _require_provisional_session(context, session_id)
    if entity_type == "session_task_context":
        if row.get("session_id") != session.get("id"):
            raise _MutationRuleViolation("work_item_structure_changed", {"reason": "context_session"})
        _require_canonical_timestamp(row.get("linked_at"))
        if context.authority.row(entity_type, request.entity_id) is not None:
            raise _MutationRuleViolation("version_conflict", {"entityId": request.entity_id})
        return
    if entity_type == "session_attribution_revision":
        _require_canonical_timestamp(row.get("created_at"))
        _require_canonical_timestamp(row.get("updated_at"))
        rows = [r for r in context.authority.rows(entity_type) if r.get("session_id") == session_id]
        expected = (max((int(r.get("revision", 0)) for r in rows), default=0) + 1)
        if row.get("revision") != expected or row.get("effective") is not True:
            raise _MutationRuleViolation("work_item_structure_changed", {"reason": "attribution_revision"})
        if any(r.get("effective") is True for r in rows):
            raise _MutationRuleViolation("work_item_structure_changed", {"reason": "attribution_effective"})
        return
    if entity_type == "session_work_item_plan":
        if row.get("session_id") != session_id or row.get("removed_at") is not None:
            raise _MutationRuleViolation("work_item_structure_changed", {"reason": "plan_post_image"})
        _require_canonical_timestamp(row.get("added_at"))
        if context.authority.row(entity_type, request.entity_id) is not None:
            raise _MutationRuleViolation("version_conflict", {"entityId": request.entity_id})
        level2 = context.authority.row("session_task_context", f"ctx-{session_id}")
        if level2 is not None and row.get("level2_snapshot") != level2.get("level2_work_item_id"):
            raise _MutationRuleViolation("work_item_structure_changed", {"reason": "plan_parent"})
        return
    if entity_type == "session_work_item_outcome":
        if row.get("session_id") != session_id or session.get("ended_at") is None:
            raise _MutationRuleViolation("work_item_structure_changed", {"reason": "outcome_session"})
        if row.get("reviewed_at") is not None:
            _require_canonical_timestamp(row.get("reviewed_at"))


def _validate_sync_update_parent(
    context: MutationCompileContext, entity_type: str, current: Mapping[str, object],
) -> None:
    if entity_type == "focus_session":
        _require_provisional_session(context, current.get("id"))
    elif entity_type in {"session_task_context", "session_attribution_revision", "session_work_item_plan", "session_work_item_outcome"}:
        _require_provisional_session(context, current.get("session_id"))


def _validate_sync_update_row(
    context: MutationCompileContext,
    request: MutationRequest,
    entity_type: str,
    before: Mapping[str, object],
    after: Mapping[str, object],
) -> None:
    if entity_type == "focus_session":
        immutable = ("id", "created_at", "ownership_state", "validity", "review_state")
        if any(before.get(key) != after.get(key) for key in immutable):
            raise _MutationRuleViolation("work_item_structure_changed", {"reason": "session_immutable_field"})
        _require_canonical_timestamp(after.get("started_at"))
        _require_canonical_timestamp(after.get("updated_at"))
        _validate_duration_row(after)
        return
    if entity_type == "session_work_item_plan":
        immutable = ("id", "session_id", "work_item_id", "title_snapshot", "level2_snapshot", "plan_rank", "source", "added_at")
        if any(before.get(key) != after.get(key) for key in immutable):
            raise _MutationRuleViolation("work_item_structure_changed", {"reason": "plan_immutable_field"})
        if after.get("removed_at") is None and after.get("removal_reason") is not None:
            raise _MutationRuleViolation("work_item_structure_changed", {"reason": "plan_removal_reason"})
        if after.get("removed_at") is not None and not str(after.get("removal_reason") or "").strip():
            raise _MutationRuleViolation("work_item_structure_changed", {"reason": "plan_removal_reason"})
        _require_canonical_timestamp(after.get("added_at"))
        if after.get("removed_at") is not None:
            _require_canonical_timestamp(after.get("removed_at"))
        return
    raise _MutationRuleViolation("work_item_structure_changed", {"entityType": entity_type, "action": "update"})


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


def _to_camel_attribution(row: Mapping[str, object]) -> Mapping[str, object]:
    return require_frozen_object({
        "id": row.get("id"),
        "sessionId": row.get("session_id"),
        "revision": row.get("revision"),
        "projectId": row.get("project_id"),
        "level2WorkItemId": row.get("level2_work_item_id"),
        "reason": row.get("reason"),
        "correctedFromRevision": row.get("corrected_from_revision"),
        "effective": row.get("effective"),
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
    start = _parse_timestamp(start_iso)
    end = _parse_timestamp(end_iso)
    return int((end - start) // timedelta(seconds=1))
