"""TS2 Task 2: Default focus session module with derived clock state.

All write operations go through S3 ``MutationUnitOfWork.execute``.
``clockState`` is derived from persisted timestamps, never stored.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from app.focus_session.commands import (
    build_focus_request,
    validate_reconcile_shape,
)
from app.focus_session.contracts import (
    FocusSessionCommand,
    FocusSessionModule,
    FocusSessionView,
)

if TYPE_CHECKING:
    from app.focus_session.query import FocusSessionQuery
    from app.mutation.unit_of_work import MutationUnitOfWork
    from app.runtime.space import SpaceRuntimeHandle


# ---------------------------------------------------------------------------
# Pure functions
# ---------------------------------------------------------------------------

def derive_clock_state(
    *,
    started_at: str | None,
    pause_started_at: str | None,
    ended_at: str | None,
) -> str:
    """Derive clock state from persisted timestamps.

    Priority: ended > paused > running.
    """
    if ended_at:
        return "ended"
    if pause_started_at:
        return "paused"
    if started_at:
        return "running"
    raise ValueError("started_at is required to derive clock state")


def focus_session_view(
    aggregate: dict[str, object],
) -> dict[str, object]:
    """Add derived ``clockState`` to the session projection.

    Does not persist or read any ``clock_state`` column.
    """
    session = aggregate.get("session")
    if session is None:
        raise TypeError("session is required in focus session view")
    if not isinstance(session, dict):
        session = dict(session)
    started_at = session.get("startedAt")
    if not isinstance(started_at, str) or not started_at:
        raise TypeError("startedAt is required in session projection")
    pause_started_at = session.get("pauseStartedAt")
    ended_at = session.get("endedAt")
    if pause_started_at is not None and not isinstance(pause_started_at, str):
        raise TypeError("pauseStartedAt must be a string or null")
    if ended_at is not None and not isinstance(ended_at, str):
        raise TypeError("endedAt must be a string or null")
    clock_state = derive_clock_state(
        started_at=started_at,
        pause_started_at=pause_started_at,
        ended_at=ended_at,
    )
    result = dict(aggregate)
    result["session"] = {**session, "clockState": clock_state}
    return result


def require_focus_scope(
    scope: SpaceRuntimeHandle,
    space_id: str,
    session_id: str | None,
) -> None:
    """Validate scope Space and session identity before UoW entry."""
    if scope.scope.space_id != space_id:
        raise ValueError("space_scope_mismatch")
    if session_id is None:
        raise ValueError("session_id is required")


# ---------------------------------------------------------------------------
# Default module
# ---------------------------------------------------------------------------

class DefaultFocusSessionModule(FocusSessionModule):
    """S3-backed focus session module with derived clock state."""

    def __init__(
        self,
        *,
        uow: MutationUnitOfWork,
        query: FocusSessionQuery,
        reconciler: object | None = None,
    ) -> None:
        self._uow = uow
        self._query = query
        self._reconciler = reconciler

    async def get(
        self, scope: SpaceRuntimeHandle, session_id: str,
    ) -> FocusSessionView:
        aggregate = await self._query.load(scope, session_id)
        view = focus_session_view(aggregate)
        return FocusSessionView(value=view)

    async def start(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand,
    ) -> FocusSessionView:
        request = build_focus_request("start", command)
        require_focus_scope(scope, command.space_id, command.session_id)
        result = await self._uow.execute(scope, request, command.command_id)
        view = focus_session_view(dict(result.value))
        return FocusSessionView(value=view)

    async def pause(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand,
    ) -> FocusSessionView:
        request = build_focus_request("pause", command)
        require_focus_scope(scope, command.space_id, command.session_id)
        result = await self._uow.execute(scope, request, command.command_id)
        view = focus_session_view(dict(result.value))
        return FocusSessionView(value=view)

    async def resume(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand,
    ) -> FocusSessionView:
        request = build_focus_request("resume", command)
        require_focus_scope(scope, command.space_id, command.session_id)
        result = await self._uow.execute(scope, request, command.command_id)
        view = focus_session_view(dict(result.value))
        return FocusSessionView(value=view)

    async def end(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand,
    ) -> FocusSessionView:
        request = build_focus_request("end", command)
        require_focus_scope(scope, command.space_id, command.session_id)
        result = await self._uow.execute(scope, request, command.command_id)
        view = focus_session_view(dict(result.value))
        return FocusSessionView(value=view)

    async def update_note(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand,
    ) -> FocusSessionView:
        request = build_focus_request("update_note", command)
        require_focus_scope(scope, command.space_id, command.session_id)
        result = await self._uow.execute(scope, request, command.command_id)
        view = focus_session_view(dict(result.value))
        return FocusSessionView(value=view)

    async def set_current_plan_item(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand,
    ) -> FocusSessionView:
        request = build_focus_request("set_current_plan_item", command)
        require_focus_scope(scope, command.space_id, command.session_id)
        result = await self._uow.execute(scope, request, command.command_id)
        view = focus_session_view(dict(result.value))
        return FocusSessionView(value=view)

    async def set_completion_draft(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand,
    ) -> FocusSessionView:
        request = build_focus_request("set_completion_draft", command)
        require_focus_scope(scope, command.space_id, command.session_id)
        result = await self._uow.execute(scope, request, command.command_id)
        view = focus_session_view(dict(result.value))
        return FocusSessionView(value=view)

    async def add_plan_item(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand,
    ) -> FocusSessionView:
        request = build_focus_request("add_plan_item", command)
        require_focus_scope(scope, command.space_id, command.session_id)
        result = await self._uow.execute(scope, request, command.command_id)
        view = focus_session_view(dict(result.value))
        return FocusSessionView(value=view)

    async def remove_plan_item(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand,
    ) -> FocusSessionView:
        request = build_focus_request("remove_plan_item", command)
        require_focus_scope(scope, command.space_id, command.session_id)
        result = await self._uow.execute(scope, request, command.command_id)
        view = focus_session_view(dict(result.value))
        return FocusSessionView(value=view)

    async def submit_review(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand,
    ) -> FocusSessionView:
        request = build_focus_request("submit_review", command)
        if command.ownership_epoch is not None:
            raise ValueError("post-terminal review requires no owner epoch")
        require_focus_scope(scope, command.space_id, command.session_id)
        result = await self._uow.execute(scope, request, command.command_id)
        view = focus_session_view(dict(result.value))
        return FocusSessionView(value=view)

    async def reconcile_commands(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand,
    ) -> FocusSessionView:
        request = build_focus_request("reconcile_commands", command)
        validate_reconcile_shape(command)
        require_focus_scope(scope, command.space_id, command.session_id)
        result = await self._uow.execute(scope, request, command.command_id)
        return FocusSessionView(value=dict(result.value))

    async def rebuild_effort_projection(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand,
    ) -> object:
        """Server-authored effort projection rebuild."""
        request = build_focus_request("rebuild_effort_projection", command)
        result = await self._uow.execute(scope, request, command.command_id)
        return result
