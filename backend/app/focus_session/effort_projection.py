"""TS2 Task 3: Fresh recomputation of WorkItem.effort_actual_seconds."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.mutation.unit_of_work import AuthorityOverlay
    from app.runtime.space import SpaceRuntimeHandle


class EffortProjectionCompiler:
    """Recompute WorkItem.effort_actual_seconds from authoritative Session facts.

    Formula:
        SUM(focus_session.focused_seconds)
        WHERE ended_at IS NOT NULL
          AND validity = 'valid'
          AND ownership_state = 'authoritative'
          AND attribution revision is the sole effective revision
          AND effective level2_work_item_id = target WorkItem
    """

    @staticmethod
    def compute_effort_for_work_item(
        authority: AuthorityOverlay,
        work_item_id: str,
    ) -> int:
        """Compute effort for a single WorkItem from authority overlay rows."""
        sessions = authority.rows("focus_session")
        attributions = authority.rows("session_attribution_revision")

        # Build effective attribution map: session_id -> level2_work_item_id
        effective_attribution: dict[str, str] = {}
        for attr in attributions:
            if attr.get("effective") is True:
                effective_attribution[str(attr.get("session_id"))] = str(
                    attr.get("level2_work_item_id")
                )

        total = 0
        for session in sessions:
            if session.get("ended_at") is None:
                continue
            if session.get("validity") != "valid":
                continue
            if session.get("ownership_state") != "authoritative":
                continue
            session_id = str(session.get("id", ""))
            if effective_attribution.get(session_id) != work_item_id:
                continue
            total += int(session.get("focused_seconds", 0))
        return total

    @staticmethod
    async def verify_all(scope: SpaceRuntimeHandle) -> None:
        """Verify all WorkItem projections match fresh recomputation."""
        from sqlalchemy import select

        from app.models.focus_session import FocusSession
        from app.models.session_revision import SessionAttributionRevision
        from app.models.work_item import WorkItem

        async with scope.session_factory() as session:
            work_items = (
                await session.execute(select(WorkItem))
            ).scalars().all()
            focus_sessions = (
                await session.execute(select(FocusSession))
            ).scalars().all()
            attributions = (
                await session.execute(select(SessionAttributionRevision))
            ).scalars().all()

        effective_attribution: dict[str, str] = {}
        for attr in attributions:
            if attr.effective:
                effective_attribution[attr.session_id] = attr.level2_work_item_id

        for wi in work_items:
            expected = 0
            for fs in focus_sessions:
                if fs.ended_at is None:
                    continue
                if fs.validity != "valid":
                    continue
                if fs.ownership_state != "authoritative":
                    continue
                if effective_attribution.get(fs.id) != wi.id:
                    continue
                expected += fs.focused_seconds
            if wi.effort_actual_seconds != expected:
                raise ValueError(
                    f"stale effort projection for {wi.id}: "
                    f"expected {expected}, got {wi.effort_actual_seconds}"
                )

    @staticmethod
    def collect_affected_work_item_ids(
        authority: AuthorityOverlay,
        session_id: str,
    ) -> tuple[str, ...]:
        """Find WorkItem IDs whose effort may change after a session mutation."""
        attributions = authority.rows("session_attribution_revision")
        ids: set[str] = set()
        for attr in attributions:
            if str(attr.get("session_id")) == session_id:
                ids.add(str(attr.get("level2_work_item_id")))
        return tuple(sorted(ids))
