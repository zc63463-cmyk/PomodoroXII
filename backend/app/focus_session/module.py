"""TS2 Task 2: Default focus session module with derived clock state.

All write operations go through S3 ``MutationUnitOfWork.execute``.
``clockState`` is derived from persisted timestamps, never stored.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING

from app.errors import SpaceRecoveryRequiredError
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
        return await self._execute(scope, "start", command)

    async def pause(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand,
    ) -> FocusSessionView:
        return await self._execute(scope, "pause", command)

    async def resume(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand,
    ) -> FocusSessionView:
        return await self._execute(scope, "resume", command)

    async def end(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand,
    ) -> FocusSessionView:
        return await self._execute(scope, "end", command)

    async def update_note(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand,
    ) -> FocusSessionView:
        return await self._execute(scope, "update_note", command)

    async def set_current_plan_item(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand,
    ) -> FocusSessionView:
        return await self._execute(scope, "set_current_plan_item", command)

    async def set_completion_draft(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand,
    ) -> FocusSessionView:
        return await self._execute(scope, "set_completion_draft", command)

    async def add_plan_item(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand,
    ) -> FocusSessionView:
        return await self._execute(scope, "add_plan_item", command)

    async def remove_plan_item(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand,
    ) -> FocusSessionView:
        return await self._execute(scope, "remove_plan_item", command)

    async def submit_review(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand,
    ) -> FocusSessionView:
        return await self._execute(scope, "submit_review", command)

    async def _execute(
        self, scope: SpaceRuntimeHandle, action: str,
        command: FocusSessionCommand,
    ) -> FocusSessionView:
        request = build_focus_request(action, command)
        if action == "submit_review" and command.ownership_epoch is not None:
            raise ValueError("post-terminal review requires no owner epoch")
        require_focus_scope(scope, command.space_id, command.session_id)
        if command.session_id is None:
            raise ValueError("FocusSession command requires session_id")

        async def post_image(_result: object) -> Mapping[str, object]:
            aggregate = await self._query.load(scope, command.session_id)
            if aggregate.get("session") is None:
                raise RuntimeError("FocusSession mutation committed without a queryable Session")
            return focus_session_view(dict(aggregate))

        result = await self._uow.execute(
            scope, request, command.command_id, result_hook=post_image,
        )
        required = {
            "session", "context", "attribution", "plan", "outcomes",
            "commandEnvelopes", "commandReceipts",
        }
        if not result.value.keys() >= required:
            raise SpaceRecoveryRequiredError("FocusSession replay post-image is unavailable")
        return FocusSessionView(value=result.value)

    async def reconcile_commands(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand,
    ) -> FocusSessionView:
        request = build_focus_request("reconcile_commands", command)
        validate_reconcile_shape(command)
        require_focus_scope(scope, command.space_id, command.session_id)
        result = await self._uow.execute(scope, request, command.command_id)
        if self._reconciler is None:
            raise RuntimeError("FocusSession command reconciler is not installed")
        reconcile = getattr(self._reconciler, "reconcile", None)
        if not callable(reconcile):
            raise TypeError("FocusSession command reconciler has no reconcile method")
        return await reconcile(
            scope,
            command,
            admission=dict(result.value),
        )
