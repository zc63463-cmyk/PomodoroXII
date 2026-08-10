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


# --------------------------------------------------------------------------- #
# Frozen resolution coordination proof (internal service evidence)
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class FrozenSpaceSessionId:
    """Immutable composite (space_id, session_id) identity."""

    space_id: str
    session_id: str


@dataclass(frozen=True, slots=True)
class FrozenConflictPair:
    """Immutable conflict pair frozen from the persisted resolution intent."""

    active: FrozenSpaceSessionId
    candidate: FrozenSpaceSessionId

    def to_dict(self) -> dict[str, object]:
        return {
            "active": {
                "space_id": self.active.space_id,
                "session_id": self.active.session_id,
            },
            "candidate": {
                "space_id": self.candidate.space_id,
                "session_id": self.candidate.session_id,
            },
        }

    @classmethod
    def from_dict(cls, value: object) -> "FrozenConflictPair":
        if not isinstance(value, Mapping):
            raise ValueError("conflict pair must be a mapping")
        active = value.get("active")
        candidate = value.get("candidate")
        if not isinstance(active, Mapping) or not isinstance(candidate, Mapping):
            raise ValueError("conflict pair must name active and candidate")
        pair = cls(
            FrozenSpaceSessionId(
                str(active.get("space_id") or ""),
                str(active.get("session_id") or ""),
            ),
            FrozenSpaceSessionId(
                str(candidate.get("space_id") or ""),
                str(candidate.get("session_id") or ""),
            ),
        )
        if not pair.active.space_id or not pair.active.session_id:
            raise ValueError("conflict pair active identity is incomplete")
        if not pair.candidate.space_id or not pair.candidate.session_id:
            raise ValueError("conflict pair candidate identity is incomplete")
        if pair.active == pair.candidate:
            raise ValueError("conflict pair sides must be distinct")
        return pair

    def side(self, role: str) -> FrozenSpaceSessionId:
        if role == "active":
            return self.active
        if role == "candidate":
            return self.candidate
        raise ValueError(f"unknown pair role: {role!r}")


@dataclass(frozen=True, slots=True)
class ResolutionCoordinationProof:
    """Deeply immutable Meta authority proof for one resolution child.

    Built by the ActiveSessionCoordinator *after* the Meta transaction from
    the freshly persisted locator, resolution operation and canonical intent.
    It is carried inside the Space child MutationRequest as internal service
    evidence (``payload["resolution_proof"]``, excluded from the business
    payload hash).  The Space policy verifies the proof against the injected
    locator reader and the shared child derivation contract -- it never opens
    the Meta database itself.
    """

    resolution_operation_id: str
    conflict_operation_id: str
    phase: str
    locator_state: str
    locator_operation_id: str
    locator_space_id: str
    locator_session_id: str
    ownership_epoch: int
    pair: FrozenConflictPair
    winner_role: str
    winner_child_operation_id: str
    winner_child_payload_hash: str
    loser_child_operation_id: str
    loser_child_payload_hash: str
    intent_hash: str

    def to_dict(self) -> dict[str, object]:
        return {
            "resolution_operation_id": self.resolution_operation_id,
            "conflict_operation_id": self.conflict_operation_id,
            "phase": self.phase,
            "locator_state": self.locator_state,
            "locator_operation_id": self.locator_operation_id,
            "locator_space_id": self.locator_space_id,
            "locator_session_id": self.locator_session_id,
            "ownership_epoch": self.ownership_epoch,
            "pair": self.pair.to_dict(),
            "winner_role": self.winner_role,
            "winner_child_operation_id": self.winner_child_operation_id,
            "winner_child_payload_hash": self.winner_child_payload_hash,
            "loser_child_operation_id": self.loser_child_operation_id,
            "loser_child_payload_hash": self.loser_child_payload_hash,
            "intent_hash": self.intent_hash,
        }

    @classmethod
    def from_dict(cls, value: object) -> "ResolutionCoordinationProof":
        if not isinstance(value, Mapping):
            raise ValueError("resolution proof must be a mapping")
        required = {
            "resolution_operation_id", "conflict_operation_id", "phase",
            "locator_state", "locator_operation_id", "locator_space_id",
            "locator_session_id", "ownership_epoch", "pair", "winner_role",
            "winner_child_operation_id", "winner_child_payload_hash",
            "loser_child_operation_id", "loser_child_payload_hash", "intent_hash",
        }
        if set(value) != required:
            raise ValueError("resolution proof fields do not match the frozen contract")
        for name in (
            "resolution_operation_id", "conflict_operation_id", "phase",
            "locator_state", "locator_operation_id", "locator_space_id",
            "locator_session_id", "winner_role", "winner_child_operation_id",
            "winner_child_payload_hash", "loser_child_operation_id",
            "loser_child_payload_hash", "intent_hash",
        ):
            if not isinstance(value[name], str) or not value[name]:
                raise ValueError(f"resolution proof {name} must be a nonempty string")
        epoch = value["ownership_epoch"]
        if type(epoch) is not int or epoch <= 0:
            raise ValueError("resolution proof ownership_epoch must be a positive int")
        return cls(
            resolution_operation_id=str(value["resolution_operation_id"]),
            conflict_operation_id=str(value["conflict_operation_id"]),
            phase=str(value["phase"]),
            locator_state=str(value["locator_state"]),
            locator_operation_id=str(value["locator_operation_id"]),
            locator_space_id=str(value["locator_space_id"]),
            locator_session_id=str(value["locator_session_id"]),
            ownership_epoch=epoch,
            pair=FrozenConflictPair.from_dict(value["pair"]),
            winner_role=str(value["winner_role"]),
            winner_child_operation_id=str(value["winner_child_operation_id"]),
            winner_child_payload_hash=str(value["winner_child_payload_hash"]),
            loser_child_operation_id=str(value["loser_child_operation_id"]),
            loser_child_payload_hash=str(value["loser_child_payload_hash"]),
            intent_hash=str(value["intent_hash"]),
        )
