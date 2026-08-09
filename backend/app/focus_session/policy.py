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
from types import MappingProxyType

from app.focus_session.child_operations import (
    ActiveSessionChildRole,
    derive_active_session_child_operation_id,
)
from app.focus_session.contracts import CommandReceiptState
from app.focus_session.effort_projection import EffortProjectionCompiler
from app.focus_session.receipts import decode_reconcile_coordination
from app.models.mutation import MutationOperation
from app.mutation.journal import MutationJournal
from app.mutation.types import (
    DbMutationPlan,
    MutationCommand,
    MutationRequest,
    MutationState,
    SyncEventPlan,
    decode_persisted_command,
    require_frozen_object,
    validate_canonical_timestamp,
)
from app.mutation.types import (
    MutationRuleViolation as _MutationRuleViolation,
)
from app.mutation.unit_of_work import MutationCompileContext, MutationDomainPolicy
from app.task_space.contracts import SYSTEM_STATUS_IDS, MutateWorkItem
from app.task_space.module import build_task_space_request

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


def _resolve_transition_status_id(target_transition: object) -> str:
    """Resolve the seeded Task Space status ID without leaking ``KeyError``.

    Historical envelopes are persisted input.  A malformed transition must
    become the same recoverable domain rejection as any other invalid
    reconciliation admission, rather than escaping from a dictionary lookup.
    """
    if not isinstance(target_transition, str):
        raise _MutationRuleViolation(
            "active_session_recovery_required",
            {"reason": "invalid_target_transition"},
            retryable=True,
        )
    status_key = {"complete": "completed", "cancel": "cancelled"}.get(target_transition)
    if status_key is None:
        raise _MutationRuleViolation(
            "active_session_recovery_required",
            {"reason": "invalid_target_transition", "transition": target_transition},
            retryable=True,
        )
    status_id = SYSTEM_STATUS_IDS.get(status_key)
    if not isinstance(status_id, str) or not status_id:
        raise _MutationRuleViolation(
            "active_session_recovery_required",
            {"reason": "invalid_target_transition", "transition": target_transition},
            retryable=True,
        )
    return status_id

_FOCUS_CLOCK_FIELDS = frozenset({
    "ended_at", "pause_started_at", "gross_seconds", "paused_seconds",
    "break_seconds", "focused_seconds", "timer_completion",
})
_FOCUS_SYNC_MUTABLE_FIELDS = frozenset({
    "session_note", "overall_progress", "mood",
})


def entity_action(request: MutationRequest) -> str | None:
    """Derive create/update/delete from an S3 EntityCommand request name."""
    action = request.name.rsplit(".", 1)[-1]
    return action if action in _SYNC_ENTITY_ACTIONS else None


class FocusSessionMutationPolicy(MutationDomainPolicy):
    """Closed S3 domain policy for all five TS0 FocusSession entity types."""

    entity_types = FOCUS_SESSION_POLICY_TYPES

    def __init__(
        self,
        locator_reader: Callable[..., object] | object,
        *,
        replay_safe_policy: Mapping[str, bool] | None = None,
    ) -> None:
        """Create the policy with the TS0 locator reader.

        The reader is deliberately injected instead of opening the Meta
        database from S3.  Omitting it would silently disable owner fencing,
        so construction fails closed instead.
        """
        if locator_reader is None:
            raise TypeError("locator_reader is required for owner fencing")
        self._locator = locator_reader
        if replay_safe_policy is not None:
            if not self._is_valid_replay_safe_policy(replay_safe_policy):
                raise TypeError("replay_safe_policy must map transition names to booleans")
            replay_safe_policy = MappingProxyType(dict(replay_safe_policy))
        self._replay_safe_policy = replay_safe_policy

    @staticmethod
    def _is_valid_replay_safe_policy(policy: object) -> bool:
        return isinstance(policy, Mapping) and all(
            isinstance(key, str) and type(value) is bool
            for key, value in policy.items()
        )

    async def _read_locator(
        self, context: MutationCompileContext, request: MutationRequest,
    ) -> Mapping[str, object] | None:
        reader = self._locator
        if callable(reader):
            try:
                parameters = inspect.signature(reader).parameters
            except (TypeError, ValueError):
                parameters = None
            if parameters is not None and not any(
                parameter.kind is inspect.Parameter.VAR_POSITIONAL
                for parameter in parameters.values()
            ) and len(parameters) == 0:
                value = reader()
            else:
                value = reader(context.scope, request)
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

    @staticmethod
    def _reject_activation_conflict(session: Mapping[str, object]) -> None:
        if session.get("ownership_state") == "activation_conflict":
            raise _MutationRuleViolation(
                "session_activation_conflict",
                {"sessionId": session.get("id"), "reason": "conflict_read_only"},
            )

    def _resolve_replay_safe(
        self, context: MutationCompileContext, target_transition: str,
    ) -> bool:
        """Resolve the immutable server declaration for one transition.

        The declaration is injected by the composition root (or exposed on
        the runtime scope for older callers).  Review payloads are never
        consulted.  Missing or malformed declarations fail closed before an
        envelope can be persisted.
        """
        policy = self._replay_safe_policy
        if policy is None:
            policy = getattr(context.scope, "task_space_replay_safe_policy", None)
        if not self._is_valid_replay_safe_policy(policy):
            raise _MutationRuleViolation(
                "work_item_structure_changed",
                {"reason": "missing_task_space_replay_safe_policy"},
            )
        policy = MappingProxyType(dict(policy))
        value = policy.get(target_transition)
        if type(value) is not bool:
            raise _MutationRuleViolation(
                "work_item_structure_changed",
                {
                    "reason": "missing_task_space_replay_safe_policy",
                    "transition": target_transition,
                },
            )
        return value

    def _recalc_effort_for_targets(
        self,
        context: MutationCompileContext,
        target_wi_ids: tuple[str, ...],
        reviewed_at: str,
        *,
        session_overrides: Mapping[str, Mapping[str, object]] | None = None,
        attribution_overrides: Mapping[
            str, Mapping[str, object] | tuple[Mapping[str, object], ...]
        ] | None = None,
    ) -> tuple[list[DbMutationPlan], list[SyncEventPlan]]:
        """Recompute effort_actual_seconds for the given WorkItem IDs.

        For each target, computes the fresh effort total from authoritative
        session facts.  If the stored value differs, emits an update plan
        and a complete WorkItem post-image Sync event.  Only
        effort_actual_seconds, updated_at, and version are modified.

        Optional ``session_overrides`` and ``attribution_overrides`` allow
        computing effort with the post-mutation state before the mutation
        is committed.

        Returns (db_plans, sync_events) for the changed WorkItems.
        """
        db_plans: list[DbMutationPlan] = []
        sync_events: list[SyncEventPlan] = []
        for wi_id in target_wi_ids:
            work_item = context.authority.row("work_item", wi_id)
            if work_item is None:
                raise _MutationRuleViolation(
                    "not_found", {"entityId": wi_id, "reason": "effort_target_missing"}
                )
            new_effort = EffortProjectionCompiler.compute_effort_for_work_item(
                context.authority, wi_id,
                session_overrides=session_overrides,
                attribution_overrides=attribution_overrides,
            )
            current_effort = int(work_item.get("effort_actual_seconds", 0))
            if current_effort == new_effort:
                continue
            wi_after = dict(work_item)
            wi_after["effort_actual_seconds"] = new_effort
            wi_after["updated_at"] = _non_regressing_timestamp(
                work_item.get("updated_at"), reviewed_at
            )
            wi_after["version"] = int(work_item.get("version", 1)) + 1
            frozen_wi_after = require_frozen_object(wi_after)
            db_plans.append(_update_plan(context.catalog, "work_item", work_item, frozen_wi_after))
            sync_events.append(
                _update_sync(
                    "work_item", frozen_wi_after, str(frozen_wi_after["updated_at"])
                )
            )
        return db_plans, sync_events

    @staticmethod
    def _collect_affected_work_item_ids(
        context: MutationCompileContext, session_id: str,
    ) -> tuple[str, ...]:
        """Collect all WorkItem IDs whose effort may change for a session.

        Includes both the current effective attribution target and any
        previously effective targets (for correction scenarios).
        """
        return EffortProjectionCompiler.collect_affected_work_item_ids(
            context.authority, session_id
        )

    async def _require_locator_claim(
        self,
        context: MutationCompileContext,
        request: MutationRequest,
        *,
        require_owner: bool = True,
    ) -> Mapping[str, object] | None:
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
            "focus_session.resolve_conflict_loser": self._compile_resolution_loser,
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

    async def _compile_rebuild_effort(
        self, context: MutationCompileContext, request: MutationRequest,
    ) -> MutationCommand:
        """Compile the server-authored rebuild through this policy/UoW."""
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
                raise _MutationRuleViolation(
                    "invalid_payload_hash", {"reason": "body_hash_mismatch"}
                ) from exc
        return await _compile_rebuild_effort_impl(context, request)

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
        level3_rows = tuple(
            context.authority.row("work_item", str(l3_id))
            for l3_id in l3_ids
        )
        project = context.authority.row("project", project_id)
        if project is None:
            raise _MutationRuleViolation("not_found", {"entityId": project_id})
        structure_snapshot = _work_item_structure_snapshot(
            l2,
            level3_rows,
            project,
        )
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
            structure_snapshot=structure_snapshot,
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
                    (level3_rows[index] or {}).get(
                        "title", request.payload.get("level3_title_snapshot", "")
                    )
                ),
                level2_snapshot=context_l2_id,
                work_item_version_snapshot=int((level3_rows[index] or {}).get("version", 0)),
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
            "session": _to_camel_session(session_row, context.scope.scope.space_id),
            "context": _to_camel_context(context_row, context.scope.scope.space_id),
            "attribution": _to_camel_attribution(attribution_row, context.scope.scope.space_id),
            "plan": [
                _to_camel_plan(p, context.scope.scope.space_id, _snapshot_mapping(context_row))
                for p in plan_rows
            ],
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
        self._reject_activation_conflict(current)
        after = dict(_clock_transition_after(current, action, occurred_at, request.payload))
        version = int(current.get("version", 1))
        after["version"] = version + 1
        frozen_after = require_frozen_object(after)
        db_plan = _update_plan(context.catalog, "focus_session", current, frozen_after)
        sync_event = _update_sync("focus_session", frozen_after, occurred_at)
        db_plans: list[DbMutationPlan] = [db_plan]
        sync_events: list[SyncEventPlan] = [sync_event]
        if action == "end":
            affected_ids = self._collect_affected_work_item_ids(context, session_id)
            if affected_ids:
                effort_plans, effort_events = self._recalc_effort_for_targets(
                    context,
                    affected_ids,
                    occurred_at,
                    session_overrides={session_id: frozen_after},
                )
                db_plans.extend(effort_plans)
                sync_events.extend(effort_events)
        value = require_frozen_object({"session": _to_camel_session(frozen_after, context.scope.scope.space_id)})
        return context.command(
            request=request,
            db_plans=tuple(db_plans),
            sync_events=tuple(sync_events),
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

    @staticmethod
    def _validate_review_snapshots(
        context: MutationCompileContext,
        session_id: str,
        plan_rows: tuple[Mapping[str, object], ...],
    ) -> None:
        """Revalidate immutable L2/L3 identity facts before review writes."""
        context_row = context.authority.row(
            "session_task_context", f"ctx-{session_id}"
        )
        if context_row is None:
            raise _MutationRuleViolation(
                "not_found", {"entityId": session_id, "reason": "session_context_missing"}
            )
        level2_id = str(context_row.get("level2_work_item_id", ""))
        level2 = context.authority.row("work_item", level2_id)
        if level2 is None:
            raise _MutationRuleViolation("not_found", {"entityId": level2_id})
        snapshot_fields = (
            ("project_id", "project_id"),
            ("title", "title_snapshot"),
            ("parent_id", "parent_snapshot"),
            ("status_definition_id", "status_snapshot"),
        )
        for current_name, snapshot_name in snapshot_fields:
            current_value = level2.get(current_name)
            snapshot_value = context_row.get(snapshot_name)
            if current_name == "parent_id":
                current_value = None if current_value is None else str(current_value)
                snapshot_value = None if snapshot_value is None else str(snapshot_value)
            elif current_value is not None or snapshot_value is not None:
                current_value = str(current_value)
                snapshot_value = str(snapshot_value)
            if current_value != snapshot_value:
                raise _MutationRuleViolation(
                    "work_item_structure_changed",
                    {
                        "reason": "session_context_snapshot_changed",
                        "entityId": level2_id,
                        "field": current_name,
                    },
                )
        current_estimate = level2.get("effort_estimate_upper_seconds")
        snapshot_estimate = context_row.get("estimate_snapshot")
        if current_estimate is not None or snapshot_estimate is not None:
            if str(current_estimate) != str(snapshot_estimate):
                raise _MutationRuleViolation(
                    "work_item_structure_changed",
                    {
                        "reason": "session_context_snapshot_changed",
                        "entityId": level2_id,
                        "field": "effort_estimate_upper_seconds",
                    },
                )
        frozen_structure = _parse_work_item_structure_snapshot(
            context_row.get("structure_snapshot")
        )
        if frozen_structure is not None:
            frozen_level2 = frozen_structure.get("level2")
            if not isinstance(frozen_level2, Mapping):
                raise _MutationRuleViolation(
                    "work_item_structure_changed",
                    {"reason": "invalid_frozen_work_item_snapshot"},
                )
            if str(frozen_level2.get("id")) != level2_id:
                raise _MutationRuleViolation(
                    "work_item_structure_changed",
                    {
                        "reason": "session_context_snapshot_changed",
                        "entityId": level2_id,
                        "field": "id",
                    },
                )
            _validate_frozen_work_item(
                level2,
                frozen_level2,
                reason="session_context_snapshot_changed",
                allow_effort_projection=True,
            )
            frozen_plan = frozen_structure.get("plan")
            if not isinstance(frozen_plan, Mapping):
                raise _MutationRuleViolation(
                    "work_item_structure_changed",
                    {"reason": "invalid_frozen_work_item_snapshot"},
                )
        else:
            frozen_plan = {}
        for plan in plan_rows:
            if plan.get("removed_at") is not None:
                continue
            work_item_id = str(plan.get("work_item_id", ""))
            current = context.authority.row("work_item", work_item_id)
            if current is None:
                raise _MutationRuleViolation("not_found", {"entityId": work_item_id})
            if (
                str(plan.get("source")) == "before_start"
                and work_item_id not in frozen_plan
            ):
                raise _MutationRuleViolation(
                    "work_item_structure_changed",
                    {
                        "reason": "missing_frozen_work_item_snapshot",
                        "entityId": work_item_id,
                    },
                )
            frozen_item = (
                frozen_plan.get(work_item_id)
                if isinstance(frozen_plan, Mapping)
                else None
            )
            if frozen_item is not None:
                if not isinstance(frozen_item, Mapping):
                    raise _MutationRuleViolation(
                        "work_item_structure_changed",
                        {"reason": "invalid_frozen_work_item_snapshot", "entityId": work_item_id},
                    )
                if str(frozen_item.get("id")) != work_item_id:
                    raise _MutationRuleViolation(
                        "work_item_structure_changed",
                        {
                            "reason": "session_plan_snapshot_changed",
                            "entityId": work_item_id,
                            "field": "id",
                        },
                    )
                _validate_frozen_work_item(
                    current,
                    frozen_item,
                    reason="session_plan_snapshot_changed",
                )
            if (
                str(plan.get("level2_snapshot")) != level2_id
                or str(current.get("project_id")) != str(context_row.get("project_id"))
                or current.get("parent_id") != level2_id
                or str(current.get("title")) != str(plan.get("title_snapshot"))
            ):
                raise _MutationRuleViolation(
                    "work_item_structure_changed",
                    {
                        "reason": "session_plan_snapshot_changed",
                        "entityId": work_item_id,
                    },
                )

    async def _compile_review(
        self, context: MutationCompileContext, request: MutationRequest,
    ) -> MutationCommand:
        from app.mutation.types import bounded_child_operation_id, canonical_payload_hash
        from app.task_space.contracts import SYSTEM_STATUS_IDS

        context.require_space(str(request.payload.get("space_id", "")))
        session_id = str(request.payload.get("session_id", request.entity_id))
        current = context.authority.row("focus_session", session_id)
        if current is None:
            raise _MutationRuleViolation("not_found", {"entityId": session_id})
        self._reject_activation_conflict(current)
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
        # A correction advances the Session updated_at even before the first
        # review, so compare against the latest attribution timestamp as well
        # as an already-materialized review timestamp.
        attribution_times = [
            str(row.get("updated_at"))
            for row in context.authority.rows("session_attribution_revision")
            if str(row.get("session_id")) == session_id and row.get("updated_at")
        ]
        latest_revision_at = max(
            (_parse_timestamp(value) for value in attribution_times),
            default=_parse_timestamp(str(current.get("ended_at"))),
        )
        if (
            current.get("review_state") != "not_required"
            and current.get("updated_at") is not None
            and isinstance(current.get("updated_at"), str)
            and _parse_timestamp(reviewed_at) <= _parse_timestamp(str(current["updated_at"]))
        ) or _parse_timestamp(reviewed_at) <= latest_revision_at:
            raise _MutationRuleViolation(
                "version_conflict",
                {"sessionId": session_id, "reason": "review_time_not_monotonic"},
            )
        # P1-12: Idempotent replay is handled by the MutationUnitOfWork
        # journal layer — if the same operation_id (command_id) is replayed
        # with the same request_hash, ``_resume_or_return`` returns the
        # cached result without invoking this policy compiler.  No
        # policy-level duplicate check is needed here.
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
            "session_revision": int(current.get("session_revision", 1)) + 1,
        })
        # P1-5: Terminal local_provisional adjudication — when a pending
        # local_provisional session is reviewed as valid, promote to
        # authoritative.  Invalid decisions keep the session provisional
        # (and contribute zero effort).
        if (
            current.get("ownership_state") == "local_provisional"
            and validity == "valid"
        ):
            after["ownership_state"] = "authoritative"
        frozen_after = require_frozen_object(after)

        # Build frozen plan set for outcome validation
        plan_rows = tuple(
            row for row in context.authority.rows("session_work_item_plan")
            if str(row.get("session_id")) == session_id and row.get("removed_at") is None
        )
        plan_work_item_ids = {str(row.get("work_item_id")) for row in plan_rows}

        # Process outcomes
        outcomes_raw = request.payload.get("outcomes", ())
        if not isinstance(outcomes_raw, (tuple, list)):
            raise _MutationRuleViolation(
                "work_item_structure_changed", {"reason": "outcomes_not_collection"}
            )
        self._validate_review_snapshots(context, session_id, plan_rows)

        # Get existing outcomes for this session
        existing_outcomes = tuple(
            sorted(
                (row for row in context.authority.rows("session_work_item_outcome")
                 if str(row.get("session_id")) == session_id),
                key=lambda row: int(row.get("revision", 0)),
            )
        )

        db_plans: list[DbMutationPlan] = [
            _update_plan(context.catalog, "focus_session", current, frozen_after),
        ]
        sync_events: list[SyncEventPlan] = [
            _update_sync("focus_session", frozen_after, reviewed_at),
        ]

        envelope_index = 0
        created_outcomes: list[Mapping[str, object]] = []
        for outcome_item in outcomes_raw:
            if not isinstance(outcome_item, Mapping):
                raise _MutationRuleViolation(
                    "work_item_structure_changed", {"reason": "outcome_not_mapping"}
                )
            work_item_id = str(outcome_item.get("work_item_id", ""))
            if not work_item_id or work_item_id not in plan_work_item_ids:
                raise _MutationRuleViolation(
                    "not_found", {"entityId": work_item_id, "reason": "not_in_frozen_plan"}
                )
            result = str(outcome_item.get("result", ""))
            if result not in {"completed", "progressed", "stuck", "untouched", "cancelled"}:
                raise _MutationRuleViolation(
                    "work_item_structure_changed", {"reason": "invalid_result", "value": result}
                )
            state_command = str(outcome_item.get("state_command", "none"))
            if state_command not in {"complete", "cancel", "none"}:
                raise _MutationRuleViolation(
                    "work_item_structure_changed", {"reason": "invalid_state_command"}
                )
            expected_wi_version = outcome_item.get("expected_work_item_version")
            work_item = context.authority.row("work_item", work_item_id)
            if work_item is None:
                raise _MutationRuleViolation("not_found", {"entityId": work_item_id})
            if type(expected_wi_version) is not int or work_item.get("version") != expected_wi_version:
                raise _MutationRuleViolation(
                    "version_conflict",
                    {"entityId": work_item_id, "expectedVersion": expected_wi_version},
                )

            # Find existing effective outcomes for this session+work_item_id
            all_known_outcomes = existing_outcomes + tuple(created_outcomes)
            existing_for_wi = tuple(
                row for row in all_known_outcomes
                if str(row.get("work_item_id")) == work_item_id and row.get("effective") is True
            )
            # Compute next revision
            all_for_wi = tuple(
                row for row in all_known_outcomes
                if str(row.get("work_item_id")) == work_item_id
            )
            next_revision = max((int(row.get("revision", 0)) for row in all_for_wi), default=0) + 1
            corrected_from = outcome_item.get("corrected_from_revision")
            if corrected_from is None and existing_for_wi:
                corrected_from = int(existing_for_wi[-1].get("revision"))

            # Mark old effective outcomes as ineffective
            for old_outcome in existing_for_wi:
                old_updated = dict(old_outcome)
                old_updated["effective"] = False
                old_updated["version"] = int(old_outcome.get("version", 1)) + 1
                old_updated["updated_at"] = reviewed_at
                frozen_old = require_frozen_object(old_updated)
                db_plans.append(_update_plan(context.catalog, "session_work_item_outcome", old_outcome, frozen_old))
                sync_events.append(_update_sync("session_work_item_outcome", frozen_old, reviewed_at))

            # Determine envelope command_id
            envelope_command_id = None
            if state_command in {"complete", "cancel"}:
                # Resolve the seeded system status ID, then verify the row's
                # category.  A first-match category scan could select a
                # user-created duplicate that Task Space cannot dispatch.
                target_category = "completed" if state_command == "complete" else "cancelled"
                resolved_status_id = SYSTEM_STATUS_IDS[target_category]
                resolved_status = context.authority.row(
                    "status_definition", resolved_status_id
                )
                if (
                    resolved_status is None
                    or str(resolved_status.get("category")) != target_category
                ):
                    raise _MutationRuleViolation(
                        "not_found", {"reason": "status_definition_not_found", "category": target_category}
                    )
                envelope_command_id = bounded_child_operation_id(
                    context.operation_id, f"command:{envelope_index:04d}"
                )
                envelope_index += 1
                payload_hash = canonical_payload_hash(
                    {"status_definition_id": resolved_status_id}
                )
                envelope_row = require_frozen_object({
                    "command_id": envelope_command_id,
                    "space_id": str(request.payload.get("space_id", "")),
                    "session_id": session_id,
                    "session_revision": int(after["session_revision"]),
                    "work_item_id": work_item_id,
                    "expected_version": expected_wi_version,
                    "target_transition": state_command,
                    "replay_safe": self._resolve_replay_safe(context, state_command),
                    "payload_hash": payload_hash,
                    "created_at": reviewed_at,
                })
                db_plans.append(_insert_plan(context.catalog, "session_command_envelope", envelope_row))

            # Create new outcome row
            outcome_row = require_frozen_object({
                "id": f"outcome-{session_id}-{work_item_id}-{next_revision}",
                "created_at": reviewed_at,
                "updated_at": reviewed_at,
                "version": 1,
                "session_id": session_id,
                "session_revision": int(after["session_revision"]),
                "revision": next_revision,
                "corrected_from_revision": corrected_from,
                "effective": True,
                "work_item_id": work_item_id,
                "touched": bool(outcome_item.get("touched", False)),
                "result": result,
                "persona": outcome_item.get("persona"),
                "execution_persona": outcome_item.get("execution_persona"),
                "persona_switched": outcome_item.get("persona_switched"),
                "persona_note": outcome_item.get("persona_note"),
                "state_command": state_command,
                "command_id": envelope_command_id,
                "reviewed_at": reviewed_at,
            })
            db_plans.append(_insert_plan(context.catalog, "session_work_item_outcome", outcome_row))
            sync_events.append(_create_sync("session_work_item_outcome", outcome_row, reviewed_at))
            created_outcomes.append(outcome_row)

        # P1-1, P1-2: Always recalculate effort for all affected WorkItem
        # targets.  When validity changes from valid to invalid, the
        # recalculation naturally produces 0 because the session_overrides
        # reflect the post-mutation validity.  When attribution has changed
        # (via correction), both old and new targets are recalculated.
        # Sessions that are pending/invalid/local_provisional contribute 0
        # and their targets' effort is updated accordingly.
        affected_ids = self._collect_affected_work_item_ids(context, session_id)
        if affected_ids:
            effort_plans, effort_events = self._recalc_effort_for_targets(
                context, affected_ids, reviewed_at,
                session_overrides={session_id: frozen_after},
            )
            db_plans.extend(effort_plans)
            sync_events.extend(effort_events)

        value_dict: dict[str, object] = {
            "session": _to_camel_session(frozen_after, context.scope.scope.space_id)
        }
        if outcomes_raw:
            value_dict["outcomes"] = len(outcomes_raw)
        return context.command(
            request=request,
            db_plans=tuple(db_plans),
            sync_events=tuple(sync_events),
            value=require_frozen_object(value_dict),
        )

    async def _compile_reconcile_admission(
        self, context: MutationCompileContext, request: MutationRequest,
    ) -> MutationCommand:
        context.require_space(str(request.payload.get("space_id", "")))
        session_id = str(request.payload.get("session_id", request.entity_id))
        session = context.authority.row("focus_session", session_id)
        if session is None:
            raise _MutationRuleViolation("not_found", {"entityId": session_id})
        command_ids = request.payload.get("command_ids", ())
        abandon_ids = set(request.payload.get("abandon_command_ids", ()))
        if not isinstance(command_ids, (tuple, list)) or not command_ids:
            raise _MutationRuleViolation(
                "active_session_recovery_required", {"reason": "command_ids"}
            )
        caller_replay_safe = request.payload.get("replay_safe") is True
        root_command_id = str(request.payload.get("command_id", context.operation_id))
        decision_at = request.payload.get("decision_at")
        envelope_rows = {
            str(row.get("command_id")): row
            for row in context.authority.rows("session_command_envelope")
            if str(row.get("session_id")) == session_id
        }
        decisions: dict[str, Mapping[str, object]] = {}
        db_plans: list[DbMutationPlan] = []

        def coordination(row: Mapping[str, object] | None) -> Mapping[str, object] | None:
            if row is None:
                return None
            try:
                value = decode_reconcile_coordination(
                    state=CommandReceiptState(str(row.get("state"))),
                    result_json=row.get("result_json"),
                )
            except (TypeError, ValueError) as exc:
                raise _MutationRuleViolation(
                    "idempotency_conflict", {"reason": "malformed_coordination"}
                ) from exc
            if value is None:
                return None
            return {"kind": value["kind"], "root_command_id": value["rootCommandId"]}

        async def original_state(envelope: Mapping[str, object]) -> str:
            command = MutateWorkItem(
                command_id=str(envelope["command_id"]),
                space_id=str(envelope["space_id"]),
                work_item_id=str(envelope["work_item_id"]),
                expected_version=int(envelope["expected_version"]),
                payload={
                    "operation": "transition",
                    "status_definition_id": _resolve_transition_status_id(
                        envelope.get("target_transition")
                    ),
                },
                payload_hash=str(envelope["payload_hash"]),
            )
            expected_request = build_task_space_request(command)
            async with context.scope.session_factory() as db_session:
                operation = await db_session.get(MutationOperation, str(envelope["command_id"]))
            if operation is None:
                return "absent"
            try:
                persisted = decode_persisted_command(operation.command_json)
            except (TypeError, ValueError) as exc:
                raise _MutationRuleViolation(
                    "idempotency_conflict", {"reason": "stored_request_invalid"}
                ) from exc
            if persisted.request.request_hash != expected_request.request_hash:
                raise _MutationRuleViolation(
                    "idempotency_conflict", {"reason": "stored_request_identity_mismatch"}
                )
            batch = await MutationJournal(context.scope.session_factory).find_batch(operation.batch_id)
            if batch is None or batch.state not in {MutationState.FINALIZED, MutationState.ABORTED}:
                return "nonterminal"
            return "terminal"

        def receipt_plan(
            envelope: Mapping[str, object],
            current: Mapping[str, object] | None,
            *,
            state: str,
            result: object | None,
            updated_at: str,
        ) -> None:
            after = require_frozen_object({
                "command_id": str(envelope["command_id"]),
                "state": state,
                "error_code": None,
                "retryable": False,
                "details_json": None,
                "result_json": _json_payload(result),
                "updated_at": updated_at,
            })
            if current is None:
                db_plans.append(_insert_plan(context.catalog, "session_command_receipt", after))
            else:
                db_plans.append(_update_plan(context.catalog, "session_command_receipt", current, after))

        for raw_id in command_ids:
            command_id = str(raw_id)
            envelope = envelope_rows.get(command_id)
            if envelope is None or str(envelope.get("space_id")) != str(request.payload.get("space_id")):
                raise _MutationRuleViolation(
                    "active_session_recovery_required", {"reason": "envelope_selection", "commandId": command_id}
                )
            current = context.authority.row("session_command_receipt", command_id)
            current_coordination = coordination(current)
            state = str(current.get("state")) if current is not None else "pending"
            original = await original_state(envelope)
            if original == "terminal" or state in {"succeeded", "failed", "conflict", "abandoned"}:
                decisions[command_id] = {"kind": "observe", "receipt_state": state}
                continue
            if command_id in abandon_ids:
                if original != "absent" or (
                    current_coordination is not None
                    and current_coordination.get("kind") == "replay_claimed"
                ):
                    raise _MutationRuleViolation(
                        "active_session_recovery_required", {"reason": "abandon_not_admissible", "commandId": command_id}
                    )
                timestamp = str(decision_at)
                _require_canonical_timestamp(timestamp)
                receipt_plan(
                    envelope,
                    current,
                    state="abandoned",
                    result={
                        "decision": "abandoned",
                        "decision_at": timestamp,
                        "root_command_id": root_command_id,
                    },
                    updated_at=timestamp,
                )
                decisions[command_id] = {
                    "kind": "abandoned",
                    "root_command_id": root_command_id,
                    "decision_at": timestamp,
                }
                continue
            if (
                original == "absent"
                and caller_replay_safe
                and bool(envelope.get("replay_safe"))
                and not (
                    current_coordination is not None
                    and current_coordination.get("kind") == "replay_claimed"
                    and current_coordination.get("root_command_id") != root_command_id
                )
            ):
                if current_coordination is None or current_coordination.get("kind") == "replay_finished_unknown":
                    state = state if state in {"pending", "unknown"} else "pending"
                    receipt_plan(
                        envelope,
                        current,
                        state=state,
                        result={
                            "_reconcileCoordination": {
                                "kind": "replay_claimed",
                                "rootCommandId": root_command_id,
                            }
                        },
                        updated_at=str(current.get("updated_at") if current else envelope.get("created_at")),
                    )
                decisions[command_id] = {"kind": "replay_claimed", "root_command_id": root_command_id}
                continue
            decisions[command_id] = {"kind": "observe", "receipt_state": state}

        # A FocusSession request must retain one authoritative Session post-image
        # even though reconciliation only changes system receipt rows.
        session_image = require_frozen_object(dict(session))
        db_plans.insert(0, _update_plan(context.catalog, "focus_session", session_image, session_image))
        sync_events = (_update_sync("focus_session", session_image, str(session_image["updated_at"])),)
        return context.command(
            request=request,
            db_plans=tuple(db_plans),
            sync_events=sync_events,
            value=require_frozen_object({
                "ordered_command_ids": tuple(str(item) for item in command_ids),
                "decisions": decisions,
            }),
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
        """Winner child of a persisted resolution.

        The winner is the deterministic ``resolution:winner`` child of the
        resolution operation.  The identity gate proves the child derivation
        against the frozen ResolutionCoordinationProof, the still-claiming
        Meta locator, and a non-ended ``activation_conflict`` Session.  The
        post-image flips ownership to ``authoritative`` and keeps the Session
        running; validity stays at its authoritative-allowed value.  No
        caller-declared winner flag is accepted: the role comes from the
        persisted proof only.
        """
        await self._verify_resolution_child(
            context, request, role=ActiveSessionChildRole.WINNER
        )
        return await self._compile_field_update(
            context, request, {"ownership_state": "authoritative"},
        )

    async def _compile_resolution_loser(
        self, context: MutationCompileContext, request: MutationRequest,
    ) -> MutationCommand:
        """Loser child of a persisted resolution (server-authored only).

        A distinct action so that the ordinary ``focus_session.end`` path stays
        closed for ``activation_conflict`` Sessions.  The identity gate proves
        the deterministic ``resolution:loser`` child derivation, the
        still-claiming locator anchored to the original conflict operation,
        and a non-ended ``activation_conflict`` Session.  The post-image is
        forced -- the caller cannot supply timer/validity/ownership fields: the
        loser ends ``interrupted``, is marked ``invalid`` with the typed
        ``activation_conflict_loser`` reason, and leaves the conflict
        ownership.  Clock invariants (ended_at >= started_at, valid duration
        counters, version +1, sync event) are recomputed by the shared
        transition helper.
        """
        current = await self._verify_resolution_child(
            context, request, role=ActiveSessionChildRole.LOSER
        )
        occurred_at = str(request.payload.get("occurred_at") or "")
        if not occurred_at:
            raise _MutationRuleViolation(
                "version_conflict", {"reason": "loser_occurred_at_required"}
            )
        forced = {
            "timer_completion": "interrupted",
            "validity": "invalid",
            "validity_reason": "activation_conflict_loser",
        }
        for field, value in forced.items():
            if field in request.payload and request.payload[field] != value:
                raise _MutationRuleViolation(
                    "work_item_structure_changed",
                    {"reason": "loser_post_image_mismatch", "field": field},
                )
        if "ended_at" in request.payload and request.payload["ended_at"] != occurred_at:
            raise _MutationRuleViolation(
                "work_item_structure_changed",
                {"reason": "loser_post_image_mismatch", "field": "ended_at"},
            )
        after = dict(
            _clock_transition_after(current, "end", occurred_at, dict(forced))
        )
        # Non-conflict terminal ownership: the loser is an ended Session, the
        # same ownership value an ordinary ended Session keeps.  The recovery
        # authority verifies the loser by ended + invalid marker only.
        after["ownership_state"] = "authoritative"
        after["version"] = int(current.get("version", 1)) + 1
        frozen_after = require_frozen_object(after)
        _require_canonical_timestamp(after.get("started_at"))
        _require_canonical_timestamp(after.get("updated_at"))
        _validate_duration_row(after)
        db_plan = _update_plan(context.catalog, "focus_session", current, frozen_after)
        sync_event = _update_sync("focus_session", frozen_after, occurred_at)
        return context.command(
            request=request,
            db_plans=(db_plan,),
            sync_events=(sync_event,),
            value=require_frozen_object({"updated": True, "entityType": "focus_session"}),
        )

    async def _verify_resolution_child(
        self,
        context: MutationCompileContext,
        request: MutationRequest,
        *,
        role: ActiveSessionChildRole,
    ) -> Mapping[str, object]:
        """Fail-closed identity gate for resolution children.

        Trusts only the frozen :class:`ResolutionCoordinationProof` carried as
        internal service evidence (``payload["resolution_proof"]``).  The
        proof is built by the coordinator from the freshly persisted Meta
        rows; the policy verifies it against the injected locator reader and
        the shared child derivation contract -- it never opens the Meta
        database and never accepts a caller-supplied pair/role/parent.

        Proves all of:

        - the proof is a well-formed frozen contract with a legal phase and
          distinct resolution/conflict operation ids;
        - the request operation is the deterministic child of the proof's
          resolution operation for ``role``;
        - the persisted locator matches the proof field-for-field
          (state/operation/space/session/epoch);
        - the proof's pair names the locator's active side and the request
          target is the exact side this role owns;
        - the request payload hash equals the proof's declared child hash;
        - the target Session is a non-ended ``activation_conflict`` row.

        Any missing/inconsistent proof fails closed with a stable code and
        never leaks the other side's identity.
        """
        from app.focus_session.contracts import (
            FrozenSpaceSessionId,
            ResolutionCoordinationProof,
        )

        context.require_space(str(request.payload.get("space_id", "")))
        raw_proof = request.payload.get("resolution_proof")
        if raw_proof is None:
            raise _MutationRuleViolation(
                "version_conflict", {"reason": "resolution_proof_required"}
            )
        try:
            proof = ResolutionCoordinationProof.from_dict(raw_proof)
        except ValueError as exc:
            raise _MutationRuleViolation(
                "version_conflict", {"reason": "resolution_proof_invalid"}
            ) from exc
        if proof.phase not in {"claimed", "prepared"}:
            raise _MutationRuleViolation(
                "version_conflict", {"reason": "resolution_phase"}
            )
        if proof.resolution_operation_id == proof.conflict_operation_id:
            raise _MutationRuleViolation(
                "version_conflict", {"reason": "resolution_anchor"}
            )
        expected_child = derive_active_session_child_operation_id(
            proof.resolution_operation_id, role
        )
        if context.operation_id != expected_child:
            raise _MutationRuleViolation(
                "version_conflict",
                {
                    "sessionId": request.entity_id,
                    "reason": "resolution_child_identity_mismatch",
                    "role": role.value,
                },
            )
        # The persisted locator must match the proof field-for-field.
        locator = await self._read_locator(context, request)
        if (
            locator is None
            or self._locator_value(locator, "state") != proof.locator_state
            or self._locator_value(locator, "operation_id") != proof.locator_operation_id
            or self._locator_value(locator, "space_id") != proof.locator_space_id
            or self._locator_value(locator, "session_id") != proof.locator_session_id
            or self._locator_value(locator, "ownership_epoch") != proof.ownership_epoch
            or proof.locator_operation_id != proof.resolution_operation_id
        ):
            raise _MutationRuleViolation(
                "stale_session_owner",
                {"sessionId": request.entity_id, "operationId": proof.resolution_operation_id},
            )
        if proof.winner_role not in ("active", "candidate"):
            raise _MutationRuleViolation(
                "version_conflict", {"reason": "invalid_winner_role"}
            )
        pair = proof.pair
        if pair.active != FrozenSpaceSessionId(
            proof.locator_space_id, proof.locator_session_id
        ):
            raise _MutationRuleViolation(
                "stale_session_owner",
                {"sessionId": request.entity_id, "reason": "resolution_pair_anchor"},
            )
        # The request target must be the exact side this role owns.
        if role is ActiveSessionChildRole.WINNER:
            expected_side = pair.side(proof.winner_role)
        else:
            expected_side = pair.side(
                "active" if proof.winner_role == "candidate" else "candidate"
            )
        if (
            request.payload.get("space_id") != expected_side.space_id
            or request.payload.get("session_id", request.entity_id) != expected_side.session_id
        ):
            raise _MutationRuleViolation(
                "version_conflict",
                {
                    "sessionId": request.entity_id,
                    "reason": "resolution_child_identity_mismatch",
                    "role": role.value,
                },
            )
        # The child payload hash must equal the proof's frozen declaration.
        declared_hash = (
            proof.winner_child_payload_hash
            if role is ActiveSessionChildRole.WINNER
            else proof.loser_child_payload_hash
        )
        if str(request.payload.get("payload_hash") or "") != declared_hash:
            raise _MutationRuleViolation(
                "version_conflict",
                {"sessionId": request.entity_id, "reason": "resolution_child_hash_mismatch"},
            )
        current = context.authority.row("focus_session", request.entity_id)
        if current is None:
            raise _MutationRuleViolation("not_found", {"entityId": request.entity_id})
        if current.get("ownership_state") != "activation_conflict":
            raise _MutationRuleViolation(
                "version_conflict",
                {"sessionId": request.entity_id, "reason": "not_activation_conflict"},
            )
        if current.get("ended_at") is not None:
            raise _MutationRuleViolation(
                "version_conflict", {"sessionId": request.entity_id, "reason": "terminal_session"}
            )
        return current


    async def _compile_owner_claim(
        self, context: MutationCompileContext, request: MutationRequest,
    ) -> MutationCommand:
        context.require_space(str(request.payload.get("space_id", "")))
        await self._require_locator_claim(context, request, require_owner=True)
        session_id = str(request.payload.get("session_id", request.entity_id))
        session = context.authority.row("focus_session", session_id)
        if session is None:
            raise _MutationRuleViolation("not_found", {"entityId": session_id})
        self._reject_activation_conflict(session)
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

    async def _compile_attribution_append(
        self, context: MutationCompileContext, request: MutationRequest,
    ) -> MutationCommand:
        context.require_space(str(request.payload.get("space_id", "")))
        session_id = str(request.payload.get("session_id", request.entity_id))
        session = context.authority.row("focus_session", session_id)
        if session is None:
            raise _MutationRuleViolation("not_found", {"entityId": session_id})
        self._reject_activation_conflict(session)
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
        if not project_id:
            if context_row is not None:
                project_id = str(context_row.get("project_id", ""))
            if not project_id:
                raise _MutationRuleViolation(
                    "work_item_structure_changed", {"reason": "attribution_target_missing"},
                )
        if not level2_id:
            raise _MutationRuleViolation(
                "work_item_structure_changed", {"reason": "attribution_target_missing"},
            )
        target_work_item = context.authority.row("work_item", level2_id)
        if target_work_item is None:
            raise _MutationRuleViolation("not_found", {"entityId": level2_id})
        if (
            effective is not None
            and str(effective.get("level2_work_item_id")) == level2_id
        ):
            raise _MutationRuleViolation(
                "version_conflict",
                {
                    "sessionId": session_id,
                    "reason": "attribution_target_unchanged",
                },
            )
        now = str(request.payload.get("occurred_at", session.get("updated_at", "")))
        _require_canonical_timestamp(now)
        _require_non_regressing_timestamp(session, now)
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
        session_image_dict = dict(session)
        session_image_dict["updated_at"] = _non_regressing_timestamp(
            session.get("updated_at"), now
        )
        session_image_dict["version"] = int(session.get("version", 1)) + 1
        session_image_dict["session_revision"] = int(
            session.get("session_revision", 1)
        ) + 1
        session_image = require_frozen_object(session_image_dict)
        # The before image must remain the authoritative Session row; the
        # previous no-op image bypassed the version guard and made correction
        # timestamps invisible to later review monotonicity.
        plans.append(_update_plan(context.catalog, "focus_session", session, session_image))
        events.append(
            _update_sync("focus_session", session_image, str(session_image["updated_at"])
            )
        )
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

        post_attributions: list[Mapping[str, object]] = []
        for row in current:
            if effective is not None and row.get("id") == effective.get("id"):
                post_attributions.append(frozen_old)
            else:
                post_attributions.append(row)
        post_attributions.append(new_row)

        # P1-1: Recalculate effort for both old and new targets.
        # The old target loses this session's contribution; the new target
        # gains it.  Use attribution_overrides to provide the post-mutation
        # state (old effective -> ineffective, new -> effective).
        affected_id_set = set(self._collect_affected_work_item_ids(context, session_id))
        affected_id_set.add(level2_id)
        affected_ids = tuple(sorted(affected_id_set))
        if affected_ids:
            effort_plans, effort_events = self._recalc_effort_for_targets(
                context, affected_ids, now,
                attribution_overrides={
                    session_id: tuple(post_attributions)
                },
            )
            plans.extend(effort_plans)
            events.extend(effort_events)

        return context.command(
            request=request,
            db_plans=tuple(plans),
            sync_events=tuple(events),
            value=require_frozen_object({
                "session": _to_camel_session(session_image, context.scope.scope.space_id),
                "attribution": _to_camel_attribution(new_row, context.scope.scope.space_id),
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
        self._reject_activation_conflict(session)
        if session.get("ended_at") is not None:
            raise _MutationRuleViolation(
                "version_conflict", {"sessionId": session_id, "reason": "terminal_session"},
            )
        rows = [
            dict(row) for row in context.authority.rows("session_work_item_plan")
            if row.get("session_id") == session_id
        ]
        response_rows = [dict(row) for row in rows]
        response_context = dict(
            context.authority.row("session_task_context", f"ctx-{session_id}") or {}
        )
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
            for index, row in enumerate(rows):
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
                response_rows[index] = dict(frozen_after)
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
            response_rows[response_rows.index(dict(row))] = dict(frozen_after)
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
            if context_row is None:
                raise _MutationRuleViolation(
                    "not_found", {"entityId": session_id, "reason": "session_context_missing"}
                )
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
                work_item_version_snapshot=int(work_item.get("version", 0)),
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
            frozen_structure = _parse_work_item_structure_snapshot(
                context_row.get("structure_snapshot")
            )
            if frozen_structure is None:
                raise _MutationRuleViolation(
                    "work_item_structure_changed",
                    {"reason": "invalid_frozen_work_item_snapshot"},
                )
            frozen_plan = frozen_structure.get("plan")
            if not isinstance(frozen_plan, Mapping):
                raise _MutationRuleViolation(
                    "work_item_structure_changed",
                    {"reason": "invalid_frozen_work_item_snapshot"},
                )
            structure_after = dict(frozen_structure)
            structure_after["plan"] = {
                **dict(frozen_plan),
                work_item_id: _work_item_identity_snapshot(work_item),
            }
            context_after = dict(context_row)
            context_after["structure_snapshot"] = json.dumps(
                structure_after,
                ensure_ascii=True,
                sort_keys=True,
                separators=(",", ":"),
            )
            context_after["updated_at"] = now
            context_after["version"] = int(context_row.get("version", 1)) + 1
            frozen_context_after = require_frozen_object(context_after)
            plans.append(_update_plan(
                context.catalog, "session_task_context", context_row, frozen_context_after,
            ))
            events.append(_update_sync("session_task_context", frozen_context_after, now))
            response_context = dict(frozen_context_after)
            response_rows.append(dict(plan))
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
            response_rows[response_rows.index(dict(row))] = dict(frozen_after)
        else:
            raise _MutationRuleViolation("work_item_structure_changed", {"reason": "unknown_plan_action"})
        return context.command(
            request=request,
            db_plans=tuple(plans),
            sync_events=tuple(events),
            value=require_frozen_object({
                "session": _to_camel_session(session, context.scope.scope.space_id),
                "plan": [
                    _to_camel_plan(
                        row,
                        context.scope.scope.space_id,
                        _snapshot_mapping(response_context),
                    )
                    for row in response_rows
                ],
            }),
        )

    async def _compile_activation_snapshot(
        self, context: MutationCompileContext, request: MutationRequest,
    ) -> MutationCommand:
        context.require_space(str(request.payload.get("space_id", "")))
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
        ownership_state = get("ownership_state", "ownershipState")
        if ownership_state != "local_provisional":
            raise _MutationRuleViolation(
                "work_item_structure_changed", {"reason": "snapshot_ownership_state"}
            )
        validity = get("validity")
        if validity != "pending":
            raise _MutationRuleViolation(
                "work_item_structure_changed", {"reason": "snapshot_validity"}
            )
        ended_at = get("ended_at", "endedAt")
        pause_started_at = get("pause_started_at", "pauseStartedAt")
        if ended_at is not None:
            raise _MutationRuleViolation(
                "work_item_structure_changed", {"reason": "terminal_snapshot"}
            )
        if get("timer_completion", "timerCompletion") is not None:
            raise _MutationRuleViolation(
                "work_item_structure_changed", {"reason": "nonterminal_timer_completion"}
            )
        review_state = "not_required"
        await self._require_locator_claim(context, request, require_owner=True)
        if pause_started_at is not None:
            pause_started_at = _require_canonical_timestamp(pause_started_at)
            if _parse_timestamp(pause_started_at) < _parse_timestamp(started_at) or (
                _parse_timestamp(pause_started_at) > _parse_timestamp(cached_at)
            ):
                raise _MutationRuleViolation(
                    "work_item_structure_changed", {"reason": "snapshot_time_range", "field": "pause_started_at"}
                )
        gross_seconds = get("gross_seconds", "grossSeconds")
        if type(gross_seconds) is not int or gross_seconds != _integer_seconds_between(started_at, cached_at):
            raise _MutationRuleViolation(
                "work_item_structure_changed", {"reason": "snapshot_gross_seconds"}
            )
        row = _focus_session_row(
            id=request.entity_id,
            session_revision=int(get("session_revision", "sessionRevision") or 1),
            started_at=started_at,
            ended_at=ended_at,
            pause_started_at=pause_started_at,
            planned_seconds=get("planned_seconds", "plannedSeconds"),
            gross_seconds=gross_seconds,
            paused_seconds=get("paused_seconds", "pausedSeconds"),
            break_seconds=get("break_seconds", "breakSeconds"),
            focused_seconds=get("focused_seconds", "focusedSeconds"),
            timer_completion=get("timer_completion", "timerCompletion"),
            validity="pending",
            validity_reason=get("validity_reason", "validityReason"),
            overall_progress=get("overall_progress", "overallProgress"),
            mood=get("mood"),
            session_note=str(get("session_note", "sessionNote") or ""),
            review_state=review_state,
            ownership_state="local_provisional",
            version=1,
            created_at=started_at,
            updated_at=cached_at,
        )
        _validate_duration_row(row)
        context_row = _snapshot_context_row(request, snapshot)
        if not context_row.get("project_id") or not context_row.get("level2_work_item_id"):
            raise _MutationRuleViolation("work_item_structure_changed", {"reason": "snapshot_context"})
        raw_context = snapshot.get("context")
        if not isinstance(raw_context, Mapping):
            raise _MutationRuleViolation("work_item_structure_changed", {"reason": "snapshot_context"})
        l2_id = str(context_row["level2_work_item_id"])
        l2 = context.authority.row("work_item", l2_id)
        if l2 is None:
            raise _MutationRuleViolation("not_found", {"entityId": l2_id})
        project_id = str(context_row["project_id"])
        if str(l2.get("project_id")) != project_id:
            raise _MutationRuleViolation(
                "invalid_work_item_tree", {"reason": "context_project_mismatch", "entityId": l2_id}
            )
        project = context.authority.row("project", project_id)
        if project is None:
            raise _MutationRuleViolation("not_found", {"entityId": project_id})
        def context_get(name: str, camel: str | None = None) -> object:
            return raw_context.get(name, raw_context.get(camel or _snake_to_camel(name)))
        if context_get("project_title_snapshot", "projectTitleSnapshot") != project.get("name"):
            raise _MutationRuleViolation("work_item_structure_changed", {"reason": "context_project_snapshot"})
        if context_row["title_snapshot"] != l2.get("title") or context_row["parent_snapshot"] != l2.get("parent_id"):
            raise _MutationRuleViolation("work_item_structure_changed", {"reason": "context_work_item_snapshot"})
        if context_row["status_snapshot"] != l2.get("status_definition_id"):
            raise _MutationRuleViolation("work_item_structure_changed", {"reason": "context_status_snapshot"})
        expected_versions = request.payload.get("expected_work_item_versions")
        if not isinstance(expected_versions, Mapping):
            raise _MutationRuleViolation("work_item_structure_changed", {"reason": "expected_versions"})
        plan_rows = snapshot.get("plan", ())
        if not isinstance(plan_rows, (tuple, list)):
            raise _MutationRuleViolation("work_item_structure_changed", {"reason": "snapshot_plan"})
        plan_work_item_ids: list[str] = []
        for item in plan_rows:
            if not isinstance(item, Mapping):
                raise _MutationRuleViolation("work_item_structure_changed", {"reason": "snapshot_plan_item"})
            item_id = str(item.get("work_item_id", item.get("workItemId", "")) or "")
            item_version = item.get("work_item_version_snapshot", item.get("workItemVersionSnapshot"))
            if not item_id or type(item_version) is not int or item_version < 0:
                raise _MutationRuleViolation("work_item_structure_changed", {"reason": "snapshot_plan_identity"})
            plan_work_item_ids.append(item_id)
            if expected_versions.get(item_id) != item_version:
                raise _MutationRuleViolation("version_conflict", {"entityId": item_id})
        expected_ids = {l2_id, *plan_work_item_ids}
        if set(expected_versions) != expected_ids or any(
            type(value) is not int or value < 0 for value in expected_versions.values()
        ):
            raise _MutationRuleViolation("work_item_structure_changed", {"reason": "expected_versions"})
        self._validate_start_work_items(
            context, l2_id, tuple(plan_work_item_ids), expected_versions,
        )
        if expected_versions[l2_id] != context_get("level2_version_snapshot", "level2VersionSnapshot"):
            raise _MutationRuleViolation("version_conflict", {"entityId": l2_id})
        converted_plans: list[Mapping[str, object]] = []
        plan_ids: set[str] = set()
        plan_ranks: set[int] = set()
        current_count = 0
        for item in plan_rows:
            if not isinstance(item, Mapping):
                raise _MutationRuleViolation("work_item_structure_changed", {"reason": "snapshot_plan_item"})
            def item_get(name: str, camel: str | None = None) -> object:
                return item.get(name, item.get(camel or _snake_to_camel(name)))
            item_id = str(item_get("id") or "")
            work_item_id = str(item_get("work_item_id", "workItemId") or "")
            source = item_get("source")
            plan_rank = item_get("plan_rank", "planRank")
            current_during_session = item_get("current_during_session", "currentDuringSession")
            completion_draft = item_get("completion_draft", "completionDraft")
            if not item_id or item_id in plan_ids or source not in {"before_start", "during_session"}:
                raise _MutationRuleViolation("work_item_structure_changed", {"reason": "snapshot_plan_identity"})
            if type(plan_rank) is not int or plan_rank < 0 or plan_rank in plan_ranks:
                raise _MutationRuleViolation("work_item_structure_changed", {"reason": "snapshot_plan_rank"})
            if type(current_during_session) is not bool or type(completion_draft) is not bool:
                raise _MutationRuleViolation("work_item_structure_changed", {"reason": "snapshot_plan_flags"})
            removed_at = item_get("removed_at", "removedAt")
            removal_reason = item_get("removal_reason", "removalReason")
            if removed_at is None and removal_reason is not None:
                raise _MutationRuleViolation("work_item_structure_changed", {"reason": "snapshot_plan_removal"})
            if removed_at is not None and (not isinstance(removal_reason, str) or not removal_reason.strip()):
                raise _MutationRuleViolation("work_item_structure_changed", {"reason": "snapshot_plan_removal"})
            added_at = _require_canonical_timestamp(item_get("added_at", "addedAt"))
            if removed_at is not None:
                _require_canonical_timestamp(removed_at)
                if _parse_timestamp(str(removed_at)) > _parse_timestamp(cached_at):
                    raise _MutationRuleViolation("work_item_structure_changed", {"reason": "snapshot_time_range"})
            if current_during_session and removed_at is not None:
                raise _MutationRuleViolation("work_item_structure_changed", {"reason": "snapshot_plan_flags"})
            current_count += int(bool(current_during_session and removed_at is None))
            plan_ids.add(item_id)
            plan_ranks.add(plan_rank)
            work_item = context.authority.row("work_item", work_item_id)
            if work_item is None:
                raise _MutationRuleViolation("not_found", {"entityId": work_item_id})
            if item_get("title_snapshot", "titleSnapshot") != work_item.get("title"):
                raise _MutationRuleViolation("work_item_structure_changed", {"reason": "snapshot_plan_title"})
            if item_get("level2_work_item_id_snapshot", "level2WorkItemIdSnapshot") != l2_id:
                raise _MutationRuleViolation("invalid_work_item_tree", {"reason": "plan_parent"})
            converted = _plan_row(
                id=item_id,
                session_id=request.entity_id,
                work_item_id=work_item_id,
                title_snapshot=str(item_get("title_snapshot", "titleSnapshot") or ""),
                level2_snapshot=l2_id,
                work_item_version_snapshot=int(work_item.get("version", 0)),
                plan_rank=plan_rank,
                source=str(source),
                added_at=added_at,
                removed_at=removed_at,
                removal_reason=removal_reason,
                current_during_session=current_during_session,
                completion_draft=completion_draft,
                version=1,
                created_at=added_at,
                updated_at=cached_at,
            )
            converted_plans.append(converted)
        if current_count > 1:
            raise _MutationRuleViolation("work_item_structure_changed", {"reason": "snapshot_plan_current"})
        # Offline imports must freeze the same authoritative WorkItem identity
        # facts as online starts.  Review uses this persisted snapshot to
        # distinguish an effort-projection version bump from unrelated edits.
        context_row = require_frozen_object({
            **dict(context_row),
            "structure_snapshot": _work_item_structure_snapshot(
                l2,
                tuple(
                    context.authority.row("work_item", str(item["work_item_id"]))
                    for item in converted_plans
                ),
                context.authority.row("project", str(context_row["project_id"])),
            ),
        })
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
                "session": _to_camel_session(row, context.scope.scope.space_id),
                "context": _to_camel_context(context_row, context.scope.scope.space_id),
                "attribution": _to_camel_attribution(attribution, context.scope.scope.space_id),
                "plan": [
                    _to_camel_plan(item, context.scope.scope.space_id, _snapshot_mapping(context_row))
                    for item in converted_plans
                ],
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
        if state not in {
            "not_needed", "pending", "succeeded", "failed", "conflict", "unknown", "abandoned",
        }:
            raise _MutationRuleViolation(
                "work_item_structure_changed", {"reason": "receipt_state"}
            )
        expected_coordination = request.payload.get("expected_coordination")
        if expected_coordination is not None:
            if not isinstance(expected_coordination, Mapping) or set(expected_coordination) != {
                "kind", "root_command_id"
            } or expected_coordination.get("kind") not in {
                "replay_claimed", "replay_finished_unknown"
            } or not isinstance(expected_coordination.get("root_command_id"), str):
                raise _MutationRuleViolation(
                    "active_session_recovery_required", {"reason": "receipt_coordination"}
                )
            try:
                from app.mutation.types import validate_operation_id
                validate_operation_id(str(expected_coordination["root_command_id"]))
            except (TypeError, ValueError) as exc:
                raise _MutationRuleViolation(
                    "active_session_recovery_required", {"reason": "receipt_coordination"}
                ) from exc
        current_coordination = None
        if current is not None:
            try:
                current_coordination = decode_reconcile_coordination(
                    state=CommandReceiptState(str(current.get("state"))),
                    result_json=current.get("result_json"),
                )
            except (TypeError, ValueError) as exc:
                raise _MutationRuleViolation(
                    "idempotency_conflict", {"reason": "malformed_coordination"}
                ) from exc
            current_coordination = (
                None
                if current_coordination is None
                else {
                    "kind": current_coordination["kind"],
                    "root_command_id": current_coordination["rootCommandId"],
                }
            )
            if str(current.get("state")) in {"succeeded", "failed", "conflict", "abandoned", "not_needed"}:
                raise _MutationRuleViolation(
                    "idempotency_conflict", {"reason": "terminal_receipt_immutable"}
                )
            if current_coordination != expected_coordination:
                raise _MutationRuleViolation(
                    "idempotency_conflict", {"reason": "session_command_not_replay_claimed"}
                )
        if state in {"pending", "unknown"}:
            result = request.payload.get("result")
            try:
                coordination_value = decode_reconcile_coordination(
                    state=CommandReceiptState(state),
                    result_json=_json_payload(result),
                )
            except (TypeError, ValueError) as exc:
                raise _MutationRuleViolation(
                    "active_session_recovery_required", {"reason": "receipt_coordination"}
                ) from exc
            if state == "unknown" and coordination_value is None:
                raise _MutationRuleViolation(
                    "active_session_recovery_required", {"reason": "unknown_receipt_coordination"}
                )
        elif isinstance(request.payload.get("result"), Mapping) and "_reconcileCoordination" in request.payload["result"]:
            raise _MutationRuleViolation(
                "active_session_recovery_required", {"reason": "terminal_receipt_coordination"}
            )
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
        if require_owner:
            self._reject_activation_conflict(current)
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
        value = require_frozen_object({"session": _to_camel_session(frozen_after, context.scope.scope.space_id)})
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
        if entity_type == "focus_session":
            return await self._compile_sync_focus_session_update(
                context, request, current,
            )
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

    async def _compile_sync_focus_session_update(
        self,
        context: MutationCompileContext,
        request: MutationRequest,
        current: Mapping[str, object],
    ) -> MutationCommand:
        """Compile a provisional Session post-image without opening a second clock API.

        Sync may carry a complete row, but it cannot invent timer facts.  A
        changed clock marker must describe exactly one legal transition and
        the shared transition helper computes all counters and timestamps.
        Non-clock Sync updates are limited to the three provisional content
        fields below.
        """
        payload = request.payload
        immutable = (
            "id", "created_at", "session_revision", "started_at",
            "planned_seconds", "ownership_state", "review_state",
        )
        for field in immutable:
            if field in payload and payload[field] != current.get(field):
                raise _MutationRuleViolation(
                    "work_item_structure_changed",
                    {"reason": "session_immutable_field", "field": field},
                )
        if "version" in payload and payload["version"] != current.get("version"):
            raise _MutationRuleViolation(
                "version_conflict", {"reason": "session_version_post_image"},
            )

        changed_clock_fields = {
            field for field in _FOCUS_CLOCK_FIELDS
            if field in payload and payload[field] != current.get(field)
        }
        clock_action: str | None = None
        if changed_clock_fields:
            if "ended_at" in changed_clock_fields:
                if current.get("ended_at") is not None or payload.get("ended_at") is None:
                    raise _MutationRuleViolation(
                        "work_item_structure_changed", {"reason": "invalid_clock_transition"},
                    )
                clock_action = "end"
            elif "pause_started_at" in changed_clock_fields:
                if (
                    current.get("ended_at") is None
                    and current.get("pause_started_at") is None
                    and payload.get("pause_started_at") is not None
                ):
                    clock_action = "pause"
                elif (
                    current.get("ended_at") is None
                    and current.get("pause_started_at") is not None
                    and payload.get("pause_started_at") is None
                ):
                    clock_action = "resume"
                else:
                    raise _MutationRuleViolation(
                        "work_item_structure_changed", {"reason": "invalid_clock_transition"},
                    )
            else:
                raise _MutationRuleViolation(
                    "work_item_structure_changed", {"reason": "clock_counter_direct_update"},
                )

            transition_at = request.client_updated_at or payload.get("updated_at")
            marker = payload.get(
                "ended_at" if clock_action == "end" else "pause_started_at",
            )
            if not isinstance(transition_at, str) or marker != transition_at:
                raise _MutationRuleViolation(
                    "work_item_structure_changed", {"reason": "clock_timestamp_mismatch"},
                )
            if request.client_updated_at is not None and payload.get("updated_at") not in {
                None, transition_at,
            }:
                raise _MutationRuleViolation(
                    "work_item_structure_changed", {"reason": "updated_at_mismatch"},
                )
            generated = dict(
                _clock_transition_after(current, clock_action, transition_at, {
                    key: value for key, value in payload.items()
                    if key != "break_seconds"
                }),
            )
            for field in _FOCUS_CLOCK_FIELDS | {"validity", "validity_reason", "updated_at"}:
                if field in payload and payload[field] != generated.get(field):
                    raise _MutationRuleViolation(
                        "work_item_structure_changed",
                        {"reason": "clock_post_image_mismatch", "field": field},
                    )
            after = generated
        else:
            if any(
                field in payload and payload[field] != current.get(field)
                for field in ("validity", "validity_reason")
            ):
                raise _MutationRuleViolation(
                    "work_item_structure_changed", {"reason": "session_state_direct_update"},
                )
            after = dict(current)
            client_ts = request.client_updated_at or payload.get("updated_at") or current.get("updated_at")
            if not isinstance(client_ts, str):
                raise _MutationRuleViolation(
                    "version_conflict", {"reason": "invalid_timestamp"},
                )
            _require_canonical_timestamp(client_ts)
            _require_non_regressing_timestamp(current, client_ts)
            if request.client_updated_at is not None and payload.get("updated_at") not in {
                None, client_ts,
            }:
                raise _MutationRuleViolation(
                    "work_item_structure_changed", {"reason": "updated_at_mismatch"},
                )
            after["updated_at"] = client_ts

        for field, value in payload.items():
            if field in _FOCUS_SYNC_MUTABLE_FIELDS:
                after[field] = value
            elif field not in {
                "id", "created_at", "version", "updated_at", "session_revision",
                "started_at", "planned_seconds", "validity", "validity_reason",
                "ownership_state", "review_state", *_FOCUS_CLOCK_FIELDS,
            }:
                raise _MutationRuleViolation(
                    "work_item_structure_changed", {"reason": "session_field_not_sync_mutable", "field": field},
                )

        _validate_sync_update_row(
            context, request, "focus_session", current, after,
            allow_terminal_validity=clock_action == "end",
        )
        after["version"] = int(current.get("version", 1)) + 1
        frozen_before = require_frozen_object(current)
        frozen_after = require_frozen_object(after)
        db_plan = _update_plan(context.catalog, "focus_session", frozen_before, frozen_after)
        sync_event = _update_sync(
            "focus_session", frozen_after, str(frozen_after["updated_at"]),
        )
        return context.command(
            request=request,
            db_plans=(db_plan,),
            sync_events=(sync_event,),
            value=require_frozen_object({"updated": True, "entityType": "focus_session"}),
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


def _non_regressing_timestamp(current: object, requested: str) -> str:
    """Return a canonical projection timestamp that never moves backwards."""
    if not isinstance(current, str) or not current:
        return requested
    try:
        validate_canonical_timestamp(current)
    except (TypeError, ValueError):
        return requested
    return current if _parse_timestamp(requested) < _parse_timestamp(current) else requested


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


def _clock_transition_after(
    current: Mapping[str, object],
    action: str,
    occurred_at: str,
    payload: Mapping[str, object],
) -> Mapping[str, object]:
    """Build and validate one legal running/paused/ended post-image.

    Both typed lifecycle commands and the restricted provisional Sync update
    path use this helper.  Keeping the transition arithmetic here prevents a
    wire post-image from inventing timer counters or state transitions.
    """
    _require_canonical_timestamp(occurred_at)
    _require_non_regressing_timestamp(current, occurred_at)
    _validate_duration_row(current)
    after = dict(current)
    after["updated_at"] = occurred_at
    if "break_seconds" in payload:
        break_seconds = payload["break_seconds"]
        if type(break_seconds) is not int or break_seconds < 0:
            raise _MutationRuleViolation(
                "version_conflict", {"reason": "invalid_duration", "field": "break_seconds"}
            )
        after["break_seconds"] = break_seconds
    started_at = str(current.get("started_at", ""))
    _require_canonical_timestamp(started_at)
    if action == "pause":
        if current.get("pause_started_at") is not None or current.get("ended_at") is not None:
            raise _MutationRuleViolation("version_conflict", {"reason": "not_running"})
        after["pause_started_at"] = occurred_at
        after["gross_seconds"] = _integer_seconds_between(started_at, occurred_at)
        after["focused_seconds"] = _focused_seconds(after)
    elif action == "resume":
        if current.get("pause_started_at") is None or current.get("ended_at") is not None:
            raise _MutationRuleViolation("version_conflict", {"reason": "not_paused"})
        pause_started = str(current.get("pause_started_at", ""))
        elapsed_pause = _integer_seconds_between(pause_started, occurred_at)
        after["paused_seconds"] = int(current.get("paused_seconds", 0)) + elapsed_pause
        after["pause_started_at"] = None
        after["gross_seconds"] = _integer_seconds_between(started_at, occurred_at)
        after["focused_seconds"] = _focused_seconds(after)
    elif action == "end":
        if current.get("ended_at") is not None:
            raise _MutationRuleViolation("version_conflict", {"reason": "already_ended"})
        if current.get("pause_started_at") is not None:
            pause_started = str(current.get("pause_started_at", ""))
            elapsed_pause = _integer_seconds_between(pause_started, occurred_at)
            after["paused_seconds"] = int(current.get("paused_seconds", 0)) + elapsed_pause
            after["pause_started_at"] = None
        after["ended_at"] = occurred_at
        after["gross_seconds"] = _integer_seconds_between(started_at, occurred_at)
        after["focused_seconds"] = _focused_seconds(after)
        after["timer_completion"] = str(
            payload.get("timer_completion", current.get("timer_completion") or "completed")
        )
        after["validity"] = str(payload.get("validity", current.get("validity", "pending")))
        after["validity_reason"] = payload.get(
            "validity_reason", current.get("validity_reason")
        )
        if after["timer_completion"] not in {"completed", "ended_early", "interrupted"}:
            raise _MutationRuleViolation("version_conflict", {"reason": "invalid_timer_completion"})
        if after["validity"] not in {"pending", "valid", "invalid"}:
            raise _MutationRuleViolation("version_conflict", {"reason": "invalid_validity"})
    else:
        raise _MutationRuleViolation(
            "version_conflict", {"reason": "unsupported_clock_action"}
        )
    _validate_duration_row(after)
    return require_frozen_object(after)


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
    if session.get("ownership_state") == "activation_conflict":
        raise _MutationRuleViolation(
            "session_activation_conflict",
            {"sessionId": session_id, "reason": "conflict_read_only"},
        )
    if session.get("ownership_state") != "local_provisional":
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
    *,
    allow_terminal_validity: bool = False,
) -> None:
    if entity_type == "focus_session":
        immutable = ("id", "created_at", "ownership_state", "review_state")
        if not allow_terminal_validity:
            immutable += ("validity",)
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


_WORK_ITEM_FROZEN_FIELDS = (
    "id", "created_at", "project_id", "display_key", "title", "description",
    "type_definition_id", "status_definition_id", "priority", "parent_id",
    "child_rank", "completion_window_start", "completion_window_end",
    "review_point", "hard_deadline", "effort_estimate_lower_seconds",
    "effort_estimate_upper_seconds", "effort_actual_seconds", "confidence",
    "completed_at", "cancelled_at", "archived_at", "marked_as_attention",
    "version",
)

_PROJECT_FROZEN_FIELDS = (
    "id", "created_at", "key", "name", "description", "rank",
    "default_status_definition_id", "default_type_definition_id",
    "archived_at", "version",
)


def _work_item_identity_snapshot(row: Mapping[str, object]) -> Mapping[str, object]:
    return {
        field: (str(row.get(field)) if field == "id" else row.get(field))
        for field in _WORK_ITEM_FROZEN_FIELDS
    }


def _project_identity_snapshot(row: Mapping[str, object] | None) -> Mapping[str, object]:
    if row is None:
        return {}
    return {
        field: (str(row.get(field)) if field == "id" else row.get(field))
        for field in _PROJECT_FROZEN_FIELDS
    }


def _work_item_structure_snapshot(
    level2: Mapping[str, object] | None,
    level3_rows: tuple[Mapping[str, object] | None, ...],
    project: Mapping[str, object] | None = None,
) -> str:
    if level2 is None:
        return "{}"
    plan = {
        str(row["id"]): _work_item_identity_snapshot(row)
        for row in level3_rows
        if row is not None and row.get("id")
    }
    return json.dumps(
        {
            "project": _project_identity_snapshot(project),
            "level2": _work_item_identity_snapshot(level2),
            "plan": plan,
        },
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    )


def _parse_work_item_structure_snapshot(
    raw: object,
) -> Mapping[str, object] | None:
    if raw in (None, "", "{}"):
        return None
    try:
        parsed = json.loads(str(raw))
    except (TypeError, ValueError) as exc:
        raise _MutationRuleViolation(
            "work_item_structure_changed",
            {"reason": "invalid_frozen_work_item_snapshot"},
        ) from exc
    if not isinstance(parsed, Mapping):
        raise _MutationRuleViolation(
            "work_item_structure_changed",
            {"reason": "invalid_frozen_work_item_snapshot"},
        )
    return parsed


def _validate_frozen_work_item(
    current: Mapping[str, object],
    frozen: Mapping[str, object],
    *,
    reason: str,
    allow_effort_projection: bool = False,
) -> None:
    for field in _WORK_ITEM_FROZEN_FIELDS:
        if field in {"id", "version", "effort_actual_seconds"}:
            continue
        if field not in frozen:
            raise _MutationRuleViolation(
                "work_item_structure_changed",
                {
                    "reason": "invalid_frozen_work_item_snapshot",
                    "entityId": current.get("id"),
                    "field": field,
                },
            )
        if current.get(field) != frozen.get(field):
            raise _MutationRuleViolation(
                "work_item_structure_changed",
                {
                    "reason": reason,
                    "entityId": current.get("id"),
                    "field": field,
                },
            )
    if current.get("version") != frozen.get("version"):
        if not (
            allow_effort_projection
            and current.get("effort_actual_seconds")
            != frozen.get("effort_actual_seconds")
        ):
            raise _MutationRuleViolation(
                "work_item_structure_changed",
                {
                    "reason": reason,
                    "entityId": current.get("id"),
                    "field": "version",
                },
            )


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
    work_item_version_snapshot: int,
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
        "work_item_version_snapshot": work_item_version_snapshot,
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

def _to_camel_session(
    row: Mapping[str, object], space_id: str | None = None,
) -> Mapping[str, object]:
    return require_frozen_object({
        "id": row.get("id"),
        "spaceId": row.get("space_id", space_id),
        "createdAt": row.get("created_at"),
        "updatedAt": row.get("updated_at"),
        "version": row.get("version"),
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
    })


def _snapshot_mapping(row: Mapping[str, object]) -> Mapping[str, object]:
    raw = row.get("structure_snapshot")
    if not isinstance(raw, str) or not raw:
        return {}
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, Mapping) else {}


def _to_camel_context(
    row: Mapping[str, object], space_id: str | None = None,
) -> Mapping[str, object]:
    snapshot = _snapshot_mapping(row)
    project = snapshot.get("project") if isinstance(snapshot.get("project"), Mapping) else {}
    level2 = snapshot.get("level2") if isinstance(snapshot.get("level2"), Mapping) else {}
    return require_frozen_object({
        "id": row.get("id"),
        "spaceId": row.get("space_id", space_id),
        "createdAt": row.get("created_at"),
        "updatedAt": row.get("updated_at"),
        "version": row.get("version"),
        "sessionId": row.get("session_id"),
        "projectId": row.get("project_id"),
        "level2WorkItemId": row.get("level2_work_item_id"),
        "projectTitleSnapshot": project.get("name") or row.get("project_title_snapshot"),
        "level2TitleSnapshot": level2.get("title") or row.get("title_snapshot"),
        "level2ParentIdSnapshot": level2.get("parent_id", row.get("parent_snapshot")),
        "level2StatusDefinitionIdSnapshot": level2.get("status_definition_id") or row.get("status_snapshot"),
        "level2VersionSnapshot": level2.get("version", row.get("level2_version_snapshot", 0)),
        "level2EffortLowerSecondsSnapshot": level2.get(
            "effort_estimate_lower_seconds", row.get("effort_lower")
        ),
        "level2EffortUpperSecondsSnapshot": level2.get(
            "effort_estimate_upper_seconds", row.get("effort_upper", row.get("estimate_snapshot"))
        ),
        "linkedAt": row.get("linked_at"),
        "linkMethod": "explicit" if row.get("link_method") == "manual" else row.get("link_method"),
    })


def _to_camel_attribution(
    row: Mapping[str, object], space_id: str | None = None,
) -> Mapping[str, object]:
    return require_frozen_object({
        "id": row.get("id"),
        "spaceId": row.get("space_id", space_id),
        "createdAt": row.get("created_at"),
        "updatedAt": row.get("updated_at"),
        "version": row.get("version"),
        "sessionId": row.get("session_id"),
        "revision": row.get("revision"),
        "projectId": row.get("project_id"),
        "level2WorkItemId": row.get("level2_work_item_id"),
        "reason": row.get("reason"),
        "correctedFromRevision": row.get("corrected_from_revision"),
        "effective": row.get("effective"),
    })


def _to_camel_plan(
    row: Mapping[str, object], space_id: str | None = None,
    snapshot: Mapping[str, object] | None = None,
) -> Mapping[str, object]:
    snapshot = snapshot or {}
    plan_snapshot = snapshot.get("plan")
    frozen = plan_snapshot.get(str(row.get("work_item_id")), {}) if isinstance(plan_snapshot, Mapping) else {}
    if not isinstance(frozen, Mapping):
        frozen = {}
    return require_frozen_object({
        "id": row.get("id"),
        "spaceId": row.get("space_id", space_id),
        "createdAt": row.get("created_at"),
        "updatedAt": row.get("updated_at"),
        "version": row.get("version"),
        "sessionId": row.get("session_id"),
        "workItemId": row.get("work_item_id"),
        "titleSnapshot": row.get("title_snapshot"),
        "level2WorkItemIdSnapshot": frozen.get("parent_id", row.get("level2_snapshot")),
        "workItemVersionSnapshot": row.get(
            "work_item_version_snapshot", frozen.get("version")
        ),
        "planRank": row.get("plan_rank"),
        "source": row.get("source"),
        "addedAt": row.get("added_at"),
        "removedAt": row.get("removed_at"),
        "removalReason": row.get("removal_reason"),
        "currentDuringSession": row.get("current_during_session"),
        "completionDraft": row.get("completion_draft"),
    })


def _to_camel_outcome(
    row: Mapping[str, object], space_id: str | None = None,
) -> Mapping[str, object]:
    return require_frozen_object({
        "id": row.get("id"),
        "spaceId": row.get("space_id", space_id),
        "createdAt": row.get("created_at"),
        "updatedAt": row.get("updated_at"),
        "version": row.get("version"),
        "sessionId": row.get("session_id"),
        "sessionRevision": row.get("session_revision"),
        "revision": row.get("revision"),
        "correctedFromRevision": row.get("corrected_from_revision"),
        "effective": row.get("effective"),
        "workItemId": row.get("work_item_id"),
        "touched": row.get("touched"),
        "result": row.get("result"),
        "executionPersona": row.get("execution_persona"),
        "personaSwitched": row.get("persona_switched"),
        "personaNote": row.get("persona_note"),
        "stateCommand": row.get("state_command"),
        "commandId": row.get("command_id"),
        "reviewedAt": row.get("reviewed_at"),
    })


def _integer_seconds_between(start_iso: str, end_iso: str) -> int:
    """Compute floor((end - start) / 1000) for canonical UTC RFC 3339 strings."""
    start = _parse_timestamp(start_iso)
    end = _parse_timestamp(end_iso)
    return int((end - start) // timedelta(seconds=1))


async def _compile_rebuild_effort_impl(
    context: MutationCompileContext, request: MutationRequest,
) -> MutationCommand:
    """Compile the server-authored effort rebuild for either policy entry."""
    context.require_space(str(request.payload.get("space_id", "")))
    target_wi_id = request.payload.get("work_item_id")

    db_plans: list[DbMutationPlan] = []
    sync_events: list[SyncEventPlan] = []
    now = str(request.payload.get("requested_at", "2026-07-15T12:00:00Z"))
    _require_canonical_timestamp(now)

    if target_wi_id is not None:
        target_ids = (str(target_wi_id),)
    else:
        target_ids = tuple(
            str(row.get("id")) for row in context.authority.rows("work_item")
        )

    repaired = 0
    for wi_id in target_ids:
        work_item = context.authority.row("work_item", wi_id)
        # P1-11: Fail closed on missing WorkItem instead of silently
        # skipping.  Silent skips produce incorrect count statistics
        # and hide data integrity problems.
        if work_item is None:
            raise _MutationRuleViolation(
                "not_found", {"entityId": wi_id, "reason": "rebuild_target_missing"}
            )
        new_effort = EffortProjectionCompiler.compute_effort_for_work_item(
            context.authority, wi_id
        )
        current_effort = int(work_item.get("effort_actual_seconds", 0))
        if current_effort == new_effort:
            continue
        wi_after = dict(work_item)
        wi_after["effort_actual_seconds"] = new_effort
        wi_after["updated_at"] = _non_regressing_timestamp(
            work_item.get("updated_at"), now
        )
        wi_after["version"] = int(work_item.get("version", 1)) + 1
        frozen_wi_after = require_frozen_object(wi_after)
        db_plans.append(_update_plan(context.catalog, "work_item", work_item, frozen_wi_after))
        sync_events.append(
            _update_sync("work_item", frozen_wi_after, str(frozen_wi_after["updated_at"]))
        )
        repaired += 1

    # P1-9: No fake folder, no folder Sync event, no INDEX_REPLACE
    # projection, no no-op FocusSession update.  The rebuild command
    # only produces real WorkItem post-image updates.
    return context.command(
        request=request,
        db_plans=tuple(db_plans),
        sync_events=tuple(sync_events),
        value=require_frozen_object({
            "rebuilt": True,
            "count": repaired,
            "mismatches_repaired": repaired,
        }),
    )
