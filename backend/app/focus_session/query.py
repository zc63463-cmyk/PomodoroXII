"""TS2 Task 2: Read-only focus session aggregate query.

Projects persisted facts into the TS0 camelCase aggregate.  Does not
create a second transaction owner — all reads go through the supplied
``scope.session_factory``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import select

from app.models.focus_session import FocusSession, SessionTaskContext
from app.models.session_command import SessionCommandEnvelope, SessionCommandReceipt
from app.models.session_revision import (
    SessionAttributionRevision,
    SessionWorkItemOutcome,
    SessionWorkItemPlan,
)

if TYPE_CHECKING:
    from app.runtime.space import SpaceRuntimeHandle


class FocusSessionQuery:
    """Read-only projector for the focus session aggregate."""

    async def load(
        self, scope: SpaceRuntimeHandle, session_id: str,
    ) -> dict[str, object]:
        """Load the full aggregate for *session_id* and project to camelCase."""
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
                    .order_by(SessionAttributionRevision.revision)
                )
            ).scalars().all()
            plan_rows = (
                await session.execute(
                    select(SessionWorkItemPlan)
                    .where(SessionWorkItemPlan.session_id == session_id)
                    .order_by(SessionWorkItemPlan.plan_rank)
                )
            ).scalars().all()
            outcome_rows = (
                await session.execute(
                    select(SessionWorkItemOutcome)
                    .where(SessionWorkItemOutcome.session_id == session_id)
                    .order_by(SessionWorkItemOutcome.revision)
                )
            ).scalars().all()
            envelope_rows = (
                await session.execute(
                    select(SessionCommandEnvelope)
                    .where(SessionCommandEnvelope.session_id == session_id)
                    .order_by(SessionCommandEnvelope.command_id)
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
                    .order_by(SessionCommandReceipt.command_id)
                )
            ).scalars().all()
        return {
            "session": _project_session(session_row),
            "context": _project_context(context_row) if context_row else None,
            "attributions": [_project_attribution(a) for a in attribution_rows],
            "plans": [_project_plan(p) for p in plan_rows],
            "outcomes": [_project_outcome(o) for o in outcome_rows],
            "envelopes": [_project_envelope(e) for e in envelope_rows],
            "receipts": [_project_receipt(r) for r in receipt_rows],
        }


# ---------------------------------------------------------------------------
# camelCase projectors
# ---------------------------------------------------------------------------

def _project_session(row: FocusSession) -> dict[str, object]:
    return {
        "id": row.id,
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
        "version": row.version,
    }


def _project_context(row: SessionTaskContext) -> dict[str, object]:
    return {
        "id": row.id,
        "sessionId": row.session_id,
        "projectId": row.project_id,
        "level2WorkItemId": row.level2_work_item_id,
        "titleSnapshot": row.title_snapshot,
        "parentSnapshot": row.parent_snapshot,
        "estimateSnapshot": row.estimate_snapshot,
        "statusSnapshot": row.status_snapshot,
        "structureSnapshot": row.structure_snapshot,
        "linkedAt": row.linked_at,
        "linkMethod": row.link_method,
        "version": row.version,
    }


def _project_attribution(row: SessionAttributionRevision) -> dict[str, object]:
    return {
        "id": row.id,
        "sessionId": row.session_id,
        "revision": row.revision,
        "projectId": row.project_id,
        "level2WorkItemId": row.level2_work_item_id,
        "reason": row.reason,
        "correctedFromRevision": row.corrected_from_revision,
        "effective": row.effective,
        "version": row.version,
    }


def _project_plan(row: SessionWorkItemPlan) -> dict[str, object]:
    return {
        "id": row.id,
        "sessionId": row.session_id,
        "workItemId": row.work_item_id,
        "titleSnapshot": row.title_snapshot,
        "level2Snapshot": row.level2_snapshot,
        "planRank": row.plan_rank,
        "source": row.source,
        "addedAt": row.added_at,
        "removedAt": row.removed_at,
        "removalReason": row.removal_reason,
        "currentDuringSession": row.current_during_session,
        "completionDraft": row.completion_draft,
        "version": row.version,
    }


def _project_outcome(row: SessionWorkItemOutcome) -> dict[str, object]:
    return {
        "id": row.id,
        "sessionId": row.session_id,
        "sessionRevision": row.session_revision,
        "revision": row.revision,
        "correctedFromRevision": row.corrected_from_revision,
        "effective": row.effective,
        "workItemId": row.work_item_id,
        "touched": row.touched,
        "result": row.result,
        "persona": row.persona,
        "stateCommand": row.state_command,
        "commandId": row.command_id,
        "reviewedAt": row.reviewed_at,
        "version": row.version,
    }


def _project_envelope(row: SessionCommandEnvelope) -> dict[str, object]:
    return {
        "commandId": row.command_id,
        "sessionId": getattr(row, "session_id", None),
        "workItemId": getattr(row, "work_item_id", None),
        "action": getattr(row, "action", None),
        "payloadHash": getattr(row, "payload_hash", None),
        "version": getattr(row, "version", None),
    }


def _project_receipt(row: SessionCommandReceipt) -> dict[str, object]:
    return {
        "commandId": row.command_id,
        "state": getattr(row, "state", None),
        "errorCode": getattr(row, "error_code", None),
        "retryable": getattr(row, "retryable", None),
        "updatedAt": getattr(row, "updated_at", None),
    }
