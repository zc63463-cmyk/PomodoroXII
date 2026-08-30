"""Read-only FocusSession aggregate projection.

The persisted Session tables intentionally keep the Space boundary outside
business rows.  This projector adds that boundary to every wire row and
projects the immutable WorkItem facts captured in ``structure_snapshot``.
There is one projector for historical reads and reconciliation responses;
mutation policy result values use the same field vocabulary.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import TYPE_CHECKING

from sqlalchemy import select

from app.errors import AppError
from app.focus_session.module import derive_clock_state
from app.focus_session.receipts import receipt_view
from app.models.focus_session import FocusSession, SessionTaskContext
from app.models.project import Project
from app.models.session_command import SessionCommandEnvelope, SessionCommandReceipt
from app.models.session_revision import (
    SessionAttributionRevision,
    SessionWorkItemOutcome,
    SessionWorkItemPlan,
)
from app.models.work_item import WorkItem

if TYPE_CHECKING:
    from app.runtime.space import SpaceRuntimeHandle


def _invalid_snapshot(*, field: str = "structure_snapshot") -> AppError:
    return AppError(
        code="active_session_recovery_required",
        details={"reason": "invalid_frozen_work_item_snapshot", "field": field},
    )


def _snapshot(value: object) -> Mapping[str, object]:
    if not isinstance(value, str) or not value:
        raise _invalid_snapshot()
    try:
        decoded = json.loads(value)
    except (TypeError, ValueError):
        raise _invalid_snapshot() from None
    if not isinstance(decoded, Mapping):
        raise _invalid_snapshot()
    return decoded


def _snapshot_row(value: object) -> Mapping[str, object]:
    return value if isinstance(value, Mapping) else {}


def _work_item_snapshot(
    context: SessionTaskContext,
    level2: WorkItem | None,
    *,
    project: Project | None,
) -> Mapping[str, object]:
    frozen = _snapshot(context.structure_snapshot)
    if not frozen:
        # Offline provisional imports carry no frozen WorkItem identity in
        # structure_snapshot ("{}" is the legitimate no-snapshot sentinel,
        # matching _parse_work_item_structure_snapshot). Fall back to the
        # live authoritative WorkItem/Project rows the loader already read.
        # Malformed non-empty snapshots still fail closed below.
        if level2 is None:
            return {}
        return {
            "project_title": project.name if project is not None else None,
            "level2_title": level2.title,
            "level2_parent_id": level2.parent_id,
            "level2_status_definition_id": level2.status_definition_id,
            "level2_version": level2.version,
            "effort_lower": level2.effort_estimate_lower_seconds,
            "effort_upper": level2.effort_estimate_upper_seconds,
            "plan": {},
        }
    frozen_project = frozen.get("project")
    frozen_level2 = frozen.get("level2")
    if not isinstance(frozen_project, Mapping) or not isinstance(frozen_level2, Mapping):
        raise _invalid_snapshot()
    required_level2 = (
        "id", "title", "parent_id", "status_definition_id", "version",
        "effort_estimate_lower_seconds", "effort_estimate_upper_seconds",
    )
    if any(field not in frozen_level2 for field in required_level2):
        raise _invalid_snapshot(field="level2")
    if frozen_level2.get("id") != context.level2_work_item_id:
        raise _invalid_snapshot(field="level2.id")
    project_name = frozen_project.get("name")
    if not isinstance(project_name, str) or not project_name:
        raise _invalid_snapshot(field="project.name")
    title = frozen_level2.get("title")
    status_id = frozen_level2.get("status_definition_id")
    version = frozen_level2.get("version")
    if (
        not isinstance(title, str) or not title
        or not isinstance(status_id, str) or not status_id
        or type(version) is not int or version < 0
    ):
        raise _invalid_snapshot(field="level2")
    for field in ("effort_estimate_lower_seconds", "effort_estimate_upper_seconds"):
        value = frozen_level2.get(field)
        if value is not None and (type(value) is not int or value < 0):
            raise _invalid_snapshot(field=f"level2.{field}")
    return {
        "project_title": project_name,
        "level2_title": title,
        "level2_parent_id": frozen_level2["parent_id"],
        "level2_status_definition_id": status_id,
        "level2_version": version,
        "effort_lower": frozen_level2["effort_estimate_lower_seconds"],
        "effort_upper": frozen_level2["effort_estimate_upper_seconds"],
        "plan": frozen.get("plan"),
    }


def _plan_snapshot(
    context: SessionTaskContext, work_item_id: str, work_item: WorkItem | None,
    *, source: str,
) -> Mapping[str, object]:
    frozen = _snapshot(context.structure_snapshot)
    plans = frozen.get("plan")
    raw = plans.get(work_item_id) if isinstance(plans, Mapping) else None
    row = _snapshot_row(raw)
    if raw is None:
        if source == "before_start":
            raise _invalid_snapshot(field=f"plan.{work_item_id}")
        return {
            "level2_work_item_id": context.level2_work_item_id,
            "work_item_version": 0,
        }
    version = row.get("version")
    parent_id = row.get("parent_id")
    if type(version) is not int or version < 0 or not isinstance(parent_id, str) or not parent_id:
        raise _invalid_snapshot(field=f"plan.{work_item_id}")
    return {
        "level2_work_item_id": parent_id,
        "work_item_version": version,
    }


class FocusSessionQuery:
    """Read-only projector for the full FocusSession aggregate."""

    async def load(
        self, scope: SpaceRuntimeHandle, session_id: str,
    ) -> dict[str, object]:
        async with scope.session_factory() as session:
            session_row = (
                await session.execute(
                    select(FocusSession).where(FocusSession.id == session_id)
                )
            ).scalar_one_or_none()
            if session_row is None:
                return {"session": None}
            context_row = (
                await session.execute(
                    select(SessionTaskContext).where(
                        SessionTaskContext.session_id == session_id
                    )
                )
            ).scalar_one_or_none()
            attribution_rows = (
                await session.execute(
                    select(SessionAttributionRevision)
                    .where(SessionAttributionRevision.session_id == session_id)
                    .where(SessionAttributionRevision.effective.is_(True))
                    .order_by(SessionAttributionRevision.revision.desc())
                )
            ).scalars().all()
            plan_rows = (
                await session.execute(
                    select(SessionWorkItemPlan)
                    .where(SessionWorkItemPlan.session_id == session_id)
                    .order_by(SessionWorkItemPlan.plan_rank, SessionWorkItemPlan.id)
                )
            ).scalars().all()
            outcome_rows = (
                await session.execute(
                    select(SessionWorkItemOutcome)
                    .where(SessionWorkItemOutcome.session_id == session_id)
                    .where(SessionWorkItemOutcome.effective.is_(True))
                    .order_by(
                        SessionWorkItemOutcome.work_item_id,
                        SessionWorkItemOutcome.revision.desc(),
                    )
                )
            ).scalars().all()
            envelope_rows = (
                await session.execute(
                    select(SessionCommandEnvelope)
                    .where(SessionCommandEnvelope.session_id == session_id)
                    .order_by(
                        SessionCommandEnvelope.created_at,
                        SessionCommandEnvelope.command_id,
                    )
                )
            ).scalars().all()
            receipt_rows = (
                await session.execute(
                    select(SessionCommandReceipt)
                    .where(
                        SessionCommandReceipt.command_id.in_(
                            [e.command_id for e in envelope_rows]
                        )
                    )
                    .order_by(
                        SessionCommandReceipt.updated_at,
                        SessionCommandReceipt.command_id,
                    )
                )
            ).scalars().all()
            context_work_item = None
            project = None
            plan_work_items: dict[str, WorkItem] = {}
            if context_row is not None:
                context_work_item = await session.get(
                    WorkItem, context_row.level2_work_item_id
                )
                project = await session.get(Project, context_row.project_id)
            if len(attribution_rows) != 1:
                raise AppError(
                    code="active_session_recovery_required",
                    details={
                        "reason": "effective_attribution_missing_or_ambiguous",
                        "sessionId": session_id,
                    },
                )
            for plan in plan_rows:
                work_item = await session.get(WorkItem, plan.work_item_id)
                if work_item is not None:
                    plan_work_items[plan.work_item_id] = work_item
            space_id = scope.scope.space_id
        context_snapshot = (
            _work_item_snapshot(context_row, context_work_item, project=project)
            if context_row is not None
            else None
        )
        return {
            "session": _project_session(session_row, space_id),
            "context": (
                _project_context(
                    context_row, space_id, snapshot=context_snapshot or {},
                )
                if context_row is not None
                else None
            ),
            "attribution": (
                _project_attribution(attribution_rows[0], space_id)
                if attribution_rows else None
            ),
            "plan": [
                _project_plan(
                    row,
                    space_id,
                    snapshot=(
                        _plan_snapshot(
                            context_row,
                            row.work_item_id,
                            plan_work_items.get(row.work_item_id),
                            source=str(row.source),
                        )
                        if context_row is not None else {}
                    ),
                )
                for row in plan_rows
            ],
            "outcomes": [_project_outcome(row, space_id) for row in outcome_rows],
            "commandEnvelopes": [_project_envelope(row) for row in envelope_rows],
            "commandReceipts": [dict(receipt_view(row)) for row in receipt_rows],
        }

    async def selected_envelopes_by_ids(
        self,
        scope: SpaceRuntimeHandle,
        session_id: str,
        command_ids: tuple[str, ...],
    ) -> tuple[SessionCommandEnvelope, ...]:
        if not command_ids:
            return ()
        async with scope.session_factory() as session:
            rows = tuple(
                await session.scalars(
                    select(SessionCommandEnvelope)
                    .where(SessionCommandEnvelope.session_id == session_id)
                    .where(SessionCommandEnvelope.command_id.in_(command_ids))
                )
            )
        by_id = {row.command_id: row for row in rows}
        if set(by_id) != set(command_ids):
            raise ValueError("selected command envelope is missing or cross-session")
        return tuple(by_id[command_id] for command_id in command_ids)

    async def receipt(
        self, scope: SpaceRuntimeHandle, command_id: str,
    ) -> SessionCommandReceipt | None:
        async with scope.session_factory() as session:
            return await session.get(SessionCommandReceipt, command_id)


# ---------------------------------------------------------------------------
# Unified row projectors
# ---------------------------------------------------------------------------


def _project_session(row: FocusSession, space_id: str) -> dict[str, object]:
    # clockState reuses the canonical derive_clock_state (ended > paused >
    # running); a missing started_at with no terminal/paused timestamp fails
    # closed instead of silently reporting running.
    clock_state = derive_clock_state(
        started_at=row.started_at,
        pause_started_at=row.pause_started_at,
        ended_at=row.ended_at,
    )
    return {
        "id": row.id,
        "spaceId": space_id,
        "createdAt": row.created_at,
        "updatedAt": row.updated_at,
        "version": row.version,
        "sessionRevision": row.session_revision,
        "startedAt": row.started_at,
        "endedAt": row.ended_at,
        "pauseStartedAt": row.pause_started_at,
        "plannedSeconds": row.planned_seconds,
        "grossSeconds": row.gross_seconds,
        "pausedSeconds": row.paused_seconds,
        "breakSeconds": row.break_seconds,
        "focusedSeconds": row.focused_seconds,
        "timerCompletion": row.timer_completion,
        "validity": row.validity,
        "validityReason": row.validity_reason,
        "overallProgress": row.overall_progress,
        "mood": row.mood,
        "sessionNote": row.session_note,
        "reviewState": row.review_state,
        "ownershipState": row.ownership_state,
        "clockState": clock_state,
    }


def _project_context(
    row: SessionTaskContext,
    space_id: str,
    *,
    snapshot: Mapping[str, object],
) -> dict[str, object]:
    return {
        "id": row.id,
        "spaceId": space_id,
        "createdAt": row.created_at,
        "updatedAt": row.updated_at,
        "version": row.version,
        "sessionId": row.session_id,
        "projectId": row.project_id,
        "level2WorkItemId": row.level2_work_item_id,
        "projectTitleSnapshot": snapshot.get("project_title"),
        "level2TitleSnapshot": snapshot.get("level2_title"),
        "level2ParentIdSnapshot": snapshot.get("level2_parent_id"),
        "level2StatusDefinitionIdSnapshot": snapshot.get("level2_status_definition_id"),
        "level2VersionSnapshot": snapshot.get("level2_version"),
        "level2EffortLowerSecondsSnapshot": snapshot.get("effort_lower"),
        "level2EffortUpperSecondsSnapshot": snapshot.get("effort_upper"),
        "linkedAt": row.linked_at,
        "linkMethod": "explicit" if row.link_method == "manual" else row.link_method,
    }


def _project_attribution(row: SessionAttributionRevision, space_id: str) -> dict[str, object]:
    return {
        "id": row.id,
        "spaceId": space_id,
        "createdAt": row.created_at,
        "updatedAt": row.updated_at,
        "version": row.version,
        "sessionId": row.session_id,
        "revision": row.revision,
        "projectId": row.project_id,
        "level2WorkItemId": row.level2_work_item_id,
        "reason": row.reason,
        "correctedFromRevision": row.corrected_from_revision,
        "effective": row.effective,
    }


def _project_plan(
    row: SessionWorkItemPlan,
    space_id: str,
    *,
    snapshot: Mapping[str, object],
) -> dict[str, object]:
    return {
        "id": row.id,
        "spaceId": space_id,
        "createdAt": row.created_at,
        "updatedAt": row.updated_at,
        "version": row.version,
        "sessionId": row.session_id,
        "workItemId": row.work_item_id,
        "titleSnapshot": row.title_snapshot,
        "level2WorkItemIdSnapshot": snapshot.get(
            "level2_work_item_id", row.level2_snapshot
        ),
        "workItemVersionSnapshot": row.work_item_version_snapshot,
        "planRank": row.plan_rank,
        "source": row.source,
        "addedAt": row.added_at,
        "removedAt": row.removed_at,
        "removalReason": row.removal_reason,
        "currentDuringSession": row.current_during_session,
        "completionDraft": row.completion_draft,
    }


def _project_outcome(row: SessionWorkItemOutcome, space_id: str) -> dict[str, object]:
    return {
        "id": row.id,
        "spaceId": space_id,
        "createdAt": row.created_at,
        "updatedAt": row.updated_at,
        "version": row.version,
        "sessionId": row.session_id,
        "sessionRevision": row.session_revision,
        "revision": row.revision,
        "correctedFromRevision": row.corrected_from_revision,
        "effective": row.effective,
        "workItemId": row.work_item_id,
        "touched": row.touched,
        "result": row.result,
        "executionPersona": row.execution_persona,
        "personaSwitched": row.persona_switched,
        "personaNote": row.persona_note,
        "stateCommand": row.state_command,
        "commandId": row.command_id,
        "reviewedAt": row.reviewed_at,
    }


def _project_envelope(row: SessionCommandEnvelope) -> dict[str, object]:
    return {
        "commandId": row.command_id,
        "spaceId": row.space_id,
        "sessionId": row.session_id,
        "sessionRevision": row.session_revision,
        "workItemId": row.work_item_id,
        "expectedVersion": row.expected_version,
        "targetTransition": row.target_transition,
        "replaySafe": row.replay_safe,
        "payloadHash": row.payload_hash,
        "createdAt": row.created_at,
    }


def _project_receipt(row: SessionCommandReceipt) -> dict[str, object]:
    return dict(receipt_view(row))
