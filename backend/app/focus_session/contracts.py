"""Closed, transport-neutral FocusSession and active-session contracts."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import TYPE_CHECKING, Mapping, Protocol

if TYPE_CHECKING:
    from app.auth.authority import Principal
    from app.runtime.space import SpaceRuntimeHandle


class ClockState(StrEnum):
    RUNNING = "running"
    PAUSED = "paused"
    ENDED = "ended"


class TimerCompletion(StrEnum):
    COMPLETED = "completed"
    ENDED_EARLY = "ended_early"
    INTERRUPTED = "interrupted"


class SessionValidity(StrEnum):
    PENDING = "pending"
    VALID = "valid"
    INVALID = "invalid"


class ReviewState(StrEnum):
    NOT_REQUIRED = "not_required"
    PENDING = "pending"
    COMPLETED = "completed"
    SKIPPED = "skipped"


class OwnershipState(StrEnum):
    AUTHORITATIVE = "authoritative"
    LOCAL_PROVISIONAL = "local_provisional"
    ACTIVATION_CONFLICT = "activation_conflict"


class SessionPlanSource(StrEnum):
    BEFORE_START = "before_start"
    DURING_SESSION = "during_session"
    REVIEW_MATERIALIZED = "review_materialized"


class SessionOutcomeResult(StrEnum):
    COMPLETED = "completed"
    PROGRESSED = "progressed"
    STUCK = "stuck"
    UNTOUCHED = "untouched"
    CANCELLED = "cancelled"


class SessionStateCommand(StrEnum):
    COMPLETE = "complete"
    CANCEL = "cancel"
    NONE = "none"


class ExecutionPersona(StrEnum):
    OX = "ox"
    PIG = "pig"
    HAJIMI = "hajimi"
    WUKONG = "wukong"


class OverallProgress(StrEnum):
    SMOOTH = "smooth"
    PROGRESSED = "progressed"
    STUCK = "stuck"
    INTERRUPTED = "interrupted"


class SessionMood(StrEnum):
    GREAT = "great"
    GOOD = "good"
    NORMAL = "normal"
    BAD = "bad"
    TERRIBLE = "terrible"


class CommandReceiptState(StrEnum):
    NOT_NEEDED = "not_needed"
    PENDING = "pending"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CONFLICT = "conflict"
    UNKNOWN = "unknown"
    ABANDONED = "abandoned"


@dataclass(frozen=True)
class FocusSessionCommand:
    command_id: str
    space_id: str
    session_id: str | None
    ownership_epoch: int | None
    payload_hash: str
    payload: Mapping[str, object]


@dataclass(frozen=True)
class ActiveSessionCommand:
    command_id: str
    space_id: str | None
    session_id: str
    ownership_epoch: int | None
    payload_hash: str
    payload: Mapping[str, object]


@dataclass(frozen=True)
class FocusSessionView:
    value: Mapping[str, object]


@dataclass(frozen=True)
class ActiveSessionView:
    value: Mapping[str, object]


class FocusSessionModule(Protocol):
    async def get(self, scope: SpaceRuntimeHandle, session_id: str) -> FocusSessionView: ...

    async def start(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand
    ) -> FocusSessionView: ...

    async def pause(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand
    ) -> FocusSessionView: ...

    async def resume(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand
    ) -> FocusSessionView: ...

    async def end(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand
    ) -> FocusSessionView: ...

    async def update_note(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand
    ) -> FocusSessionView: ...

    async def set_current_plan_item(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand
    ) -> FocusSessionView: ...

    async def set_completion_draft(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand
    ) -> FocusSessionView: ...

    async def add_plan_item(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand
    ) -> FocusSessionView: ...

    async def remove_plan_item(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand
    ) -> FocusSessionView: ...

    async def submit_review(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand
    ) -> FocusSessionView: ...

    async def reconcile_commands(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand
    ) -> FocusSessionView: ...


class ActiveSessionCoordinator(Protocol):
    async def locate(self, principal: Principal) -> ActiveSessionView | None: ...

    async def start(
        self, principal: Principal, command: ActiveSessionCommand
    ) -> ActiveSessionView: ...

    async def activate_provisional(
        self, principal: Principal, command: ActiveSessionCommand
    ) -> ActiveSessionView: ...

    async def heartbeat(
        self, principal: Principal, command: ActiveSessionCommand
    ) -> ActiveSessionView: ...

    async def pause(
        self, principal: Principal, command: ActiveSessionCommand
    ) -> ActiveSessionView: ...

    async def resume(
        self, principal: Principal, command: ActiveSessionCommand
    ) -> ActiveSessionView: ...

    async def takeover(
        self, principal: Principal, command: ActiveSessionCommand
    ) -> ActiveSessionView: ...

    async def end(
        self, principal: Principal, command: ActiveSessionCommand
    ) -> ActiveSessionView: ...

    async def update_note(
        self, principal: Principal, command: ActiveSessionCommand
    ) -> ActiveSessionView: ...

    async def set_current_plan_item(
        self, principal: Principal, command: ActiveSessionCommand
    ) -> ActiveSessionView: ...

    async def set_completion_draft(
        self, principal: Principal, command: ActiveSessionCommand
    ) -> ActiveSessionView: ...

    async def add_plan_item(
        self, principal: Principal, command: ActiveSessionCommand
    ) -> ActiveSessionView: ...

    async def remove_plan_item(
        self, principal: Principal, command: ActiveSessionCommand
    ) -> ActiveSessionView: ...

    async def resolve_activation_conflict(
        self, principal: Principal, command: ActiveSessionCommand
    ) -> ActiveSessionView: ...
