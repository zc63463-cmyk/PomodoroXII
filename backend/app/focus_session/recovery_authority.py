"""TS2 ActiveSession recovery authority contract.

This module is the *authoritative, read-only* ActiveSession coordination
authority that S5's ``RecoveryCoordinator`` can inject in place of its own
fail-closed classifier (``backend/app/recovery/coordinator.py``
``ActiveSessionCoordinationInspector``).  It proves the recovery decision table
from ``docs/superpowers/plans/2026-07-15-task-space-session-ts2-focus-session.md``
lines 3036-3054 using the *real* Meta and Space SQLite databases plus the real
ORM query path.  It never writes, never opens runtime writers, never fabricates
a ``SpaceRuntimeHandle``, and never returns a "looks recoverable" default: every
state/phase/child/Session combination that cannot be proven by the closed
decision set below fails closed with a stable ``failure_code``.

Supported (proven) classifications
-----------------------------------
``empty``                     zero-row locator with both coordination tables intact.
``active_consistent``         active + completed + matching nonterminal Session.
``recoverable_claiming``      claiming + claimed + exact original child
                              terminal-success + matching nonterminal Session.
``recoverable_releasing``     claiming + claimed end + ended Session, or
                              releasing + space_committed + ended Session.
``awaiting_resolution``       claiming + awaiting_resolution + valid conflict pair,
                              or claiming + claimed conflict children all
                              terminal-success (recovery may set
                              ``awaiting_resolution``).
``recovery_required``         every other combination (fail closed).

Intent contract
---------------
The persisted ``intent_json`` (``backend/app/db/models/meta.py:99``) is a closed
JSON object.  Identity keys ``command_id``, ``space_id``, ``session_id``,
``ownership_epoch``, ``payload_hash``, ``kind`` must match the locator/operation
row.  The business subset (all remaining top-level keys) re-hashes to
``payload_hash`` via S3 ``canonical_payload_hash``.  Two optional declaration
keys are excluded from the business hash and from identity comparison:

- ``pair``: ``{"active": {"space_id","session_id"}, "candidate": {...}}`` for
  provisional-conflict and resolution operations.
- ``children``: ``{"candidate"|"active"|"winner"|"loser": "<bounded child id>"}``.

Simple operations (``start``/``heartbeat``/``pause``/``resume``/``end``/
``update_note``/``set_current_plan_item``/``set_completion_draft``/
``add_plan_item``/``remove_plan_item``) keep their original Space child under
the *same* operation ID (the Coordinator forwards ``command.command_id`` to
``MutationUnitOfWork.execute``; see ``backend/app/focus_session/module.py:188``).

Contract gaps (fail closed, see the investigation note in
``docs/superpowers/plans/2026-07-15-task-space-session-ts2-authority-investigation.md``):
the ``related_operation_id`` semantics, the bounded child suffixes for
takeover/conflict/resolution children, and the production intent schema have no
implementation yet; they are validated structurally here and, when required but
absent, rejected.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any

from sqlalchemy import select
from sqlalchemy import text as sa_text
from sqlalchemy.ext.asyncio import AsyncEngine

from app.db.models.meta import ActiveSessionLocator, ActiveSessionOperation
from app.db.session import create_engine, create_session_factory
from app.errors import to_wire_json
from app.focus_session.child_operations import (
    ActiveSessionChildRole,
    derive_active_session_child_operation_id,
)
from app.focus_session.contracts import CommandReceiptState
from app.models.focus_session import FocusSession
from app.models.session_command import SessionCommandEnvelope, SessionCommandReceipt
from app.mutation.types import (
    canonical_json_bytes,
    canonical_payload_hash,
)

if TYPE_CHECKING:
    from app.knowledge.consistency import SpaceDataView

# --------------------------------------------------------------------------- #
# Closed vocabulary
# --------------------------------------------------------------------------- #

CLASSIFICATION_EMPTY = "empty"
CLASSIFICATION_ACTIVE_CONSISTENT = "active_consistent"
CLASSIFICATION_RECOVERABLE_CLAIMING = "recoverable_claiming"
CLASSIFICATION_RECOVERABLE_RELEASING = "recoverable_releasing"
CLASSIFICATION_AWAITING_RESOLUTION = "awaiting_resolution"
CLASSIFICATION_RECOVERY_REQUIRED = "recovery_required"

RESULT_CLEAN_OR_RECOVERABLE = "clean_or_recoverable"
RESULT_NOT_CLEAN = "not_clean"

_SINGLETON_KEY = "active"
_LOCATOR_STATES = frozenset({"claiming", "active", "releasing"})
_LOCATOR_COLUMNS = frozenset(
    {
        "singleton_key", "space_id", "session_id", "operation_id", "state",
        "owner_device_id", "owner_tab_id", "ownership_epoch",
        "lease_expires_at", "updated_at",
    }
)
_OPERATION_COLUMNS = frozenset(
    {
        "operation_id", "kind", "payload_hash", "intent_json", "phase",
        "result_descriptor_json", "related_operation_id", "created_at", "updated_at",
    }
)
_KNOWN_KINDS = frozenset(
    {
        "start", "heartbeat", "pause", "resume", "end", "takeover",
        "update_note", "set_current_plan_item", "set_completion_draft",
        "add_plan_item", "remove_plan_item", "activate_provisional",
        "resolve_activation_conflict",
    }
)
_KNOWN_PHASES = frozenset(
    {
        "prepared", "claimed", "space_committed", "awaiting_resolution",
        "transferred", "completed", "rejected", "manual_intervention",
    }
)
# Authoritative state/phase pairs (TS2 plan lines 2545-2557, 3036-3054).
# ``transferred`` is legal only for a ``resolve_activation_conflict`` operation.
_STATE_PHASE_RULES = {
    "active": frozenset({"completed"}),
    "claiming": frozenset({"claimed", "awaiting_resolution", "transferred"}),
    "releasing": frozenset({"space_committed"}),
}
# Simple operations keep the original Space child under the operation ID.
_SIMPLE_ORIGINAL_CHILD_KINDS = frozenset(
    {
        "start", "heartbeat", "pause", "resume", "end", "update_note",
        "set_current_plan_item", "set_completion_draft", "add_plan_item",
        "remove_plan_item",
    }
)
# Identity/CAS keys never enter the business payload hash (TS2 plan line 266).
_IDENTITY_KEYS = frozenset(
    {"command_id", "space_id", "session_id", "ownership_epoch", "payload_hash", "kind"}
)
# Authority-declared intent keys that are identity, never business.
_NON_BUSINESS_KEYS = frozenset({"pair", "children"})
_INTENT_EXCLUDED_KEYS = _IDENTITY_KEYS | _NON_BUSINESS_KEYS
_CHILD_ROLES = frozenset({"candidate", "active", "winner", "loser"})
# Child suffixes live in the shared public contract
# (``app.focus_session.child_operations``) used by both the production
# ``ProductionActiveSessionCoordinator`` writer and this read-only authority:
# candidate/active -> ``conflict:*``, winner/loser -> ``resolution:*``.
# Never copy the suffix map here — import the derivation function.
_CANONICAL_UTC_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$")
_OPERATION_ID_RE = re.compile(r"[\x21-\x7e]{1,128}")
_PAYLOAD_HASH_RE = re.compile(r"[0-9a-f]{64}")
_MAX_RELATION_CHAIN_DEPTH = 8
_MAX_RESULT_DESCRIPTOR_BYTES = 8192

# Stable fail-closed codes.
CODE_INVALID_VIEW = "invalid_meta_view"
CODE_META_UNREADABLE = "meta_db_unreadable"
CODE_MISSING_SCHEMA = "missing_coordination_schema"
CODE_MULTIPLE_LOCATORS = "multiple_locators"
CODE_INVALID_LOCATOR = "invalid_locator"
CODE_OPERATION_MISSING = "operation_missing"
CODE_INVALID_OPERATION = "invalid_operation"
CODE_INTENT_INVALID = "intent_invalid"
CODE_STATE_PHASE_INCONSISTENT = "state_phase_inconsistent"
CODE_MANUAL_INTERVENTION = "manual_intervention"
CODE_LEASE_EXPIRED = "lease_expired"
CODE_RELATION_MISSING = "relation_missing"
CODE_RELATION_INVALID = "relation_invalid"
CODE_RELATION_CYCLE = "relation_cycle"
CODE_SPACE_VIEW_MISSING = "space_view_missing"
CODE_SPACE_UNREADABLE = "space_db_unreadable"
CODE_SESSION_MISSING = "session_missing"
CODE_SESSION_UNEXPECTED_TERMINAL = "session_unexpected_terminal"
CODE_SESSION_UNEXPECTED_NONTERMINAL = "session_unexpected_nonterminal"
CODE_CONFLICT_PAIR_MISSING = "conflict_pair_missing"
CODE_CONFLICT_PAIR_INVALID = "conflict_pair_invalid"
CODE_CHILD_MISSING = "child_missing"
CODE_CHILD_UNKNOWN = "child_unknown"
CODE_CHILD_PENDING = "child_pending"
CODE_CHILD_REJECTED = "child_rejected"
CODE_CHILD_IDENTITY_MISMATCH = "child_identity_mismatch"
CODE_CHILD_PAYLOAD_HASH_MISMATCH = "child_payload_hash_mismatch"
CODE_CHILDREN_DECLARATION_MISSING = "children_declaration_missing"
CODE_CHILDREN_DECLARATION_INVALID = "children_declaration_invalid"
CODE_CHILDREN_DECLARATION_CONFLICT = "children_declaration_conflict"
CODE_CHILD_ID_DERIVATION_UNPROVEN = "child_id_derivation_unproven"
CODE_CHILD_ID_DERIVATION_MISMATCH = "child_id_derivation_mismatch"
CODE_SESSION_OWNERSHIP_INVALID = "session_ownership_invalid"
CODE_SESSION_INVALID_MARKER = "session_invalid_marker_mismatch"
CODE_UNPROVEN_COMBINATION = "unproven_combination"
CODE_INTERNAL = "authority_internal_error"


# --------------------------------------------------------------------------- #
# Public frozen contracts
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class ActiveSessionRecoveryView:
    """Read-only Meta database view (an S5 copied ``meta.db``)."""

    meta_db_path: Path


@dataclass(frozen=True, slots=True)
class LocatorIdentity:
    space_id: str
    session_id: str
    operation_id: str
    state: str
    owner_device_id: str
    owner_tab_id: str
    ownership_epoch: int
    lease_expires_at: str
    updated_at: str


@dataclass(frozen=True, slots=True)
class OperationIdentity:
    operation_id: str
    kind: str
    phase: str
    payload_hash: str
    related_operation_id: str | None


@dataclass(frozen=True, slots=True)
class SpaceChildOutcome:
    """One verified Space child (envelope + receipt) fact."""

    role: str
    space_id: str
    session_id: str
    child_operation_id: str
    envelope_present: bool
    receipt_state: str | None
    terminal_success: bool
    terminal_rejected: bool
    unknown: bool
    pending: bool


@dataclass(frozen=True, slots=True)
class SessionRecoveryFact:
    space_id: str
    session_id: str
    session_present: bool
    ended: bool | None
    ownership_state: str | None
    validity: str | None = None
    validity_reason: str | None = None


@dataclass(frozen=True, slots=True)
class ChildDeclaration:
    """One named Space child declared by an intent ``children`` entry.

    The declaration carries the exact operation ID *and* the payload hash the
    envelope must match; a string-only declaration (no payload hash) cannot be
    proven and is rejected (``children_declaration_invalid``).
    """

    operation_id: str
    payload_hash: str


@dataclass(frozen=True, slots=True)
class ConflictPairFact:
    active_space_id: str
    active_session_id: str
    candidate_space_id: str
    candidate_session_id: str


@dataclass(frozen=True, slots=True)
class ActiveSessionRecoveryDecision:
    """Immutable, serializable decision returned to the recovery caller."""

    classification: str
    result: str
    locator: LocatorIdentity | None
    operation: OperationIdentity | None
    child_outcomes: tuple[SpaceChildOutcome, ...]
    session_facts: tuple[SessionRecoveryFact, ...]
    conflict_pair: ConflictPairFact | None
    failure_code: str | None
    reason: str | None

    def to_wire(self) -> dict[str, Any]:
        value = to_wire_json(self)
        if not isinstance(value, dict):
            raise TypeError("ActiveSessionRecoveryDecision did not serialize to an object")
        return value

    def to_canonical_json(self) -> bytes:
        return canonical_json_bytes(self)


# --------------------------------------------------------------------------- #
# Read-only SQLite access
# --------------------------------------------------------------------------- #


def _readonly_engine(path: Path) -> AsyncEngine:
    resolved = path.resolve()
    url = f"sqlite+aiosqlite:///file:{resolved.as_posix()}?mode=ro&uri=true"
    return create_engine(url)


def _parse_canonical_utc(value: object) -> datetime | None:
    if not isinstance(value, str) or _CANONICAL_UTC_RE.fullmatch(value) is None:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _require_nonempty_ascii(value: object) -> bool:
    if not isinstance(value, str) or not value:
        return False
    try:
        value.encode("ascii")
    except UnicodeEncodeError:
        return False
    return "\x00" not in value and "\n" not in value and "\r" not in value


def _require_operation_id(value: object) -> bool:
    return isinstance(value, str) and _OPERATION_ID_RE.fullmatch(value) is not None


def _require_payload_hash(value: object) -> bool:
    return isinstance(value, str) and _PAYLOAD_HASH_RE.fullmatch(value) is not None


def _resolve_meta_path(view: object) -> Path | None:
    for name in ("meta_db_path", "db_path", "path"):
        value = getattr(view, name, None)
        if isinstance(value, Path):
            return value
        if isinstance(value, str) and value:
            return Path(value)
    return None


def _canonical_error(failure_code: str, reason: str) -> dict[str, object]:
    return {"code": failure_code, "reason": reason}


# --------------------------------------------------------------------------- #
# Inspector
# --------------------------------------------------------------------------- #


class ActiveSessionCoordinationInspector:
    """Strict fail-closed, evidence-validating ActiveSession classification.

    Read-only by construction: every engine is opened with ``mode=ro`` and every
    query is a SELECT against the real ORM models.  ``inspect_read_only`` never
    raises for damaged evidence — it returns a ``recovery_required`` decision
    with a stable ``failure_code`` instead.
    """

    def __init__(self, *, now: datetime | None = None) -> None:
        self._now = now

    async def inspect_read_only(
        self,
        view: Any,
        *,
        space_views: Mapping[str, SpaceDataView] | None = None,
    ) -> ActiveSessionRecoveryDecision:
        meta_path = _resolve_meta_path(view)
        if meta_path is None:
            return _fail(CODE_INVALID_VIEW, "active session view requires a Meta database path")
        engine = _readonly_engine(meta_path)
        try:
            missing = await _schema_problems(engine)
            if missing is not None:
                return _fail(CODE_MISSING_SCHEMA, f"coordination schema is incomplete: {missing}")
            locators = await _locator_rows(engine)
            if not locators:
                return _empty_decision()
            if len(locators) > 1:
                return _fail(CODE_MULTIPLE_LOCATORS, "multiple active session locator authorities")
            locator = _validated_locator(locators[0])
            if locator is None:
                return _fail(CODE_INVALID_LOCATOR, "active_session_locator row is invalid")
            operation = await _operation_row(engine, str(locator["operation_id"]))
            if operation is None:
                return _fail(
                    CODE_OPERATION_MISSING,
                    f"locator operation {locator['operation_id']!r} is missing",
                )
            operation = _validated_operation(_row_to_dict(operation), locator)
            if operation is None:
                return _fail(CODE_INVALID_OPERATION, "active_session_operations row is invalid")
            intent = _verify_intent(locator, operation)
            if intent is None:
                return _fail(
                    CODE_INTENT_INVALID,
                    "operation intent does not match its identity or payload hash",
                )
            if operation["phase"] == "manual_intervention":
                return _fail(
                    CODE_MANUAL_INTERVENTION,
                    "active session operation requires manual intervention",
                )
            allowed = _STATE_PHASE_RULES.get(str(locator["state"]))
            if allowed is None or str(operation["phase"]) not in allowed:
                return _fail(
                    CODE_STATE_PHASE_INCONSISTENT,
                    f"locator state and operation phase are inconsistent: "
                    f"{locator['state']!r}/{operation['phase']!r}",
                )
            if operation["phase"] == "transferred" and operation["kind"] != "resolve_activation_conflict":
                return _fail(
                    CODE_STATE_PHASE_INCONSISTENT,
                    "transferred phase requires a resolve_activation_conflict operation",
                )
            if locator["state"] == "active" and self._lease_expired(str(locator["lease_expires_at"])):
                return _fail(CODE_LEASE_EXPIRED, "active session lease has expired")
            relation_problem = await _verify_relation_chain(
                engine, operation, str(locator["space_id"]), str(locator["session_id"])
            )
            if relation_problem is not None:
                return _fail(relation_problem, _relation_reason(relation_problem))
            accessor = _SpaceAccessor(space_views)
            try:
                return await self._classify(locator, operation, intent, accessor)
            finally:
                await accessor.close()
        except Exception as exc:  # noqa: BLE001 - damaged evidence must fail closed
            return _fail(CODE_INTERNAL, f"unexpected authority failure: {type(exc).__name__}")
        finally:
            await engine.dispose()

    # ------------------------------------------------------------------ #
    # Locator / operation validation
    # ------------------------------------------------------------------ #

    def _lease_expired(self, lease_expires_at: str) -> bool:
        expires_at = _parse_canonical_utc(lease_expires_at)
        if expires_at is None:
            return True
        now = self._now if self._now is not None else datetime.now(timezone.utc)
        if now.tzinfo is None:
            now = now.replace(tzinfo=timezone.utc)
        return expires_at <= now

    async def _classify(
        self,
        locator: dict[str, object],
        operation: dict[str, object],
        intent: dict[str, object],
        accessor: "_SpaceAccessor",
    ) -> ActiveSessionRecoveryDecision:
        state = str(locator["state"])
        phase = str(operation["phase"])
        kind = str(operation["kind"])
        locator_identity = _locator_identity(locator)
        operation_identity = _operation_identity(operation)

        if state == "active" and phase == "completed":
            fact = await self._load_session_fact(accessor, locator)
            if isinstance(fact, str):
                return _fail(fact, f"active Session cannot be proven ({fact})", locator_identity, operation_identity)
            if not fact.session_present:
                return _fail(CODE_SESSION_MISSING, "active locator points at a missing Session", locator_identity, operation_identity)
            if fact.ended:
                return _fail(CODE_SESSION_UNEXPECTED_TERMINAL, "active locator points at an ended Session", locator_identity, operation_identity)
            return _decision(
                CLASSIFICATION_ACTIVE_CONSISTENT,
                RESULT_CLEAN_OR_RECOVERABLE,
                locator=locator_identity,
                operation=operation_identity,
                session_facts=(fact,),
            )

        if state == "releasing" and phase == "space_committed":
            if kind != "end":
                return _fail(CODE_UNPROVEN_COMBINATION, "releasing requires an end operation", locator_identity, operation_identity)
            fact = await self._load_session_fact(accessor, locator)
            if isinstance(fact, str):
                return _fail(fact, f"releasing Session cannot be proven ({fact})", locator_identity, operation_identity)
            if not fact.session_present:
                return _fail(CODE_SESSION_MISSING, "releasing locator points at a missing Session", locator_identity, operation_identity)
            if not fact.ended:
                return _fail(CODE_SESSION_UNEXPECTED_NONTERMINAL, "releasing locator requires an ended Session", locator_identity, operation_identity)
            return _decision(
                CLASSIFICATION_RECOVERABLE_RELEASING,
                RESULT_CLEAN_OR_RECOVERABLE,
                locator=locator_identity,
                operation=operation_identity,
                session_facts=(fact,),
            )

        if state == "claiming":
            if phase == "awaiting_resolution":
                return await self._classify_awaiting_resolution(
                    locator, operation, intent, accessor, locator_identity, operation_identity
                )
            if phase == "claimed":
                return await self._classify_claimed(
                    locator, operation, intent, accessor, locator_identity, operation_identity
                )
            if phase == "transferred":
                return await self._classify_transferred(
                    locator, operation, intent, accessor, locator_identity, operation_identity
                )
            return _fail(
                CODE_UNPROVEN_COMBINATION,
                f"claiming operation phase {phase!r} is outside the supported proof set",
                locator_identity,
                operation_identity,
            )

        return _fail(
            CODE_UNPROVEN_COMBINATION,
            f"state/phase {state!r}/{phase!r} is not proven by the authority decision table",
            locator_identity,
            operation_identity,
        )

    async def _classify_claimed(
        self,
        locator: dict[str, object],
        operation: dict[str, object],
        intent: dict[str, object],
        accessor: "_SpaceAccessor",
        locator_identity: LocatorIdentity,
        operation_identity: OperationIdentity,
    ) -> ActiveSessionRecoveryDecision:
        kind = str(operation["kind"])
        if kind == "activate_provisional":
            children = _decode_children(intent)
            if children is None:
                if "children" in intent:
                    return _fail(
                        CODE_CHILDREN_DECLARATION_INVALID,
                        "children declaration has no provable payload identity",
                        locator_identity, operation_identity,
                    )
                return _fail(
                    CODE_CHILDREN_DECLARATION_MISSING,
                    "activate_provisional requires a children declaration",
                    locator_identity, operation_identity,
                )
            if not {"candidate", "active"} <= set(children):
                return _fail(
                    CODE_CHILDREN_DECLARATION_MISSING,
                    "activate_provisional requires candidate and active children",
                    locator_identity, operation_identity,
                )
            outcomes = await self._verify_named_children(
                accessor, locator, intent, ("candidate", "active"),
            )
            if isinstance(outcomes, str):
                return _fail(outcomes, f"conflict child cannot be proven ({outcomes})", locator_identity, operation_identity)
            if not all(outcome.terminal_success for outcome in outcomes):
                return _fail(CODE_CHILD_REJECTED, "conflict children are not all terminal-success", locator_identity, operation_identity, outcomes)
            return _decision(
                CLASSIFICATION_AWAITING_RESOLUTION,
                RESULT_CLEAN_OR_RECOVERABLE,
                locator=locator_identity,
                operation=operation_identity,
                child_outcomes=outcomes,
                conflict_pair=_decode_pair(intent),
            )
        if kind == "resolve_activation_conflict":
            return _fail(CODE_UNPROVEN_COMBINATION, "resolution requires the transferred phase", locator_identity, operation_identity)
        if kind not in _SIMPLE_ORIGINAL_CHILD_KINDS:
            return _fail(CODE_UNPROVEN_COMBINATION, f"kind {kind!r} has no provable child proof", locator_identity, operation_identity)
        outcome = await self._verify_original_child(accessor, locator, operation)
        if isinstance(outcome, str):
            return _fail(outcome, f"original child cannot be proven ({outcome})", locator_identity, operation_identity)
        if outcome.unknown:
            return _fail(CODE_CHILD_UNKNOWN, "original child outcome is unknown", locator_identity, operation_identity, (outcome,))
        if outcome.pending:
            return _fail(CODE_CHILD_PENDING, "original child outcome is pending", locator_identity, operation_identity, (outcome,))
        if outcome.terminal_rejected:
            return _fail(CODE_CHILD_REJECTED, "original child outcome is terminal-rejected", locator_identity, operation_identity, (outcome,))
        if not outcome.terminal_success:
            return _fail(CODE_CHILD_MISSING, "original child has no terminal-success receipt", locator_identity, operation_identity, (outcome,))
        fact = await self._load_session_fact(accessor, locator)
        if isinstance(fact, str):
            return _fail(fact, f"Session cannot be proven ({fact})", locator_identity, operation_identity)
        if not fact.session_present:
            return _fail(CODE_SESSION_MISSING, "claimed operation requires a matching Session", locator_identity, operation_identity, (outcome,))
        if kind == "end":
            if not fact.ended:
                return _fail(CODE_SESSION_UNEXPECTED_NONTERMINAL, "end claim requires an ended Session", locator_identity, operation_identity, (outcome,))
            return _decision(
                CLASSIFICATION_RECOVERABLE_RELEASING,
                RESULT_CLEAN_OR_RECOVERABLE,
                locator=locator_identity,
                operation=operation_identity,
                child_outcomes=(outcome,),
                session_facts=(fact,),
            )
        if fact.ended:
            return _fail(CODE_SESSION_UNEXPECTED_TERMINAL, "active claim requires a nonterminal Session", locator_identity, operation_identity, (outcome,))
        return _decision(
            CLASSIFICATION_RECOVERABLE_CLAIMING,
            RESULT_CLEAN_OR_RECOVERABLE,
            locator=locator_identity,
            operation=operation_identity,
            child_outcomes=(outcome,),
            session_facts=(fact,),
        )

    async def _classify_awaiting_resolution(
        self,
        locator: dict[str, object],
        operation: dict[str, object],
        intent: dict[str, object],
        accessor: "_SpaceAccessor",
        locator_identity: LocatorIdentity,
        operation_identity: OperationIdentity,
    ) -> ActiveSessionRecoveryDecision:
        if str(operation["kind"]) != "activate_provisional":
            return _fail(CODE_UNPROVEN_COMBINATION, "awaiting_resolution requires activate_provisional", locator_identity, operation_identity)
        pair = _decode_pair(intent)
        if pair is None:
            return _fail(CODE_CONFLICT_PAIR_MISSING, "awaiting_resolution intent has no conflict pair", locator_identity, operation_identity)
        if str(locator["space_id"]) != pair.active_space_id or str(locator["session_id"]) != pair.active_session_id:
            return _fail(CODE_CONFLICT_PAIR_INVALID, "locator does not anchor the active conflict identity", locator_identity, operation_identity)
        outcomes = await self._verify_named_children(
            accessor, locator, intent, ("candidate", "active"),
        )
        if isinstance(outcomes, str):
            return _fail(outcomes, f"conflict child cannot be proven ({outcomes})", locator_identity, operation_identity)
        for outcome in outcomes:
            if not outcome.envelope_present:
                return _fail(
                    CODE_CHILD_MISSING,
                    f"conflict child {outcome.child_operation_id!r} has no envelope",
                    locator_identity, operation_identity, outcomes,
                )
            if outcome.unknown:
                return _fail(
                    CODE_CHILD_UNKNOWN,
                    f"conflict child {outcome.child_operation_id!r} outcome is unknown",
                    locator_identity, operation_identity, outcomes,
                )
            if outcome.pending:
                return _fail(
                    CODE_CHILD_PENDING,
                    f"conflict child {outcome.child_operation_id!r} outcome is pending",
                    locator_identity, operation_identity, outcomes,
                )
            if outcome.terminal_rejected:
                return _fail(
                    CODE_CHILD_REJECTED,
                    f"conflict child {outcome.child_operation_id!r} is terminal-rejected",
                    locator_identity, operation_identity, outcomes,
                )
            if not outcome.terminal_success:
                return _fail(
                    CODE_CHILD_MISSING,
                    f"conflict child {outcome.child_operation_id!r} has no terminal-success receipt",
                    locator_identity, operation_identity, outcomes,
                )
        facts = await self._load_pair_sessions(accessor, pair)
        if isinstance(facts, str):
            return _fail(facts, f"conflict Session cannot be proven ({facts})", locator_identity, operation_identity)
        return _decision(
            CLASSIFICATION_AWAITING_RESOLUTION,
            RESULT_CLEAN_OR_RECOVERABLE,
            locator=locator_identity,
            operation=operation_identity,
            child_outcomes=outcomes,
            session_facts=facts,
            conflict_pair=pair,
        )

    async def _classify_transferred(
        self,
        locator: dict[str, object],
        operation: dict[str, object],
        intent: dict[str, object],
        accessor: "_SpaceAccessor",
        locator_identity: LocatorIdentity,
        operation_identity: OperationIdentity,
    ) -> ActiveSessionRecoveryDecision:
        if str(operation["kind"]) != "resolve_activation_conflict":
            return _fail(CODE_UNPROVEN_COMBINATION, "transferred requires resolve_activation_conflict", locator_identity, operation_identity)
        pair = _decode_pair(intent)
        if pair is None:
            return _fail(CODE_CONFLICT_PAIR_MISSING, "resolution intent has no conflict pair", locator_identity, operation_identity)
        winner_role = intent.get("winner_role")
        if winner_role not in ("active", "candidate"):
            return _fail(CODE_CONFLICT_PAIR_INVALID, "resolution intent has no valid winner_role", locator_identity, operation_identity)
        outcomes = await self._verify_named_children(
            accessor, locator, intent, ("winner", "loser"),
        )
        if isinstance(outcomes, str):
            return _fail(outcomes, f"resolution child cannot be proven ({outcomes})", locator_identity, operation_identity)
        for outcome in outcomes:
            if not outcome.terminal_success:
                return _fail(
                    CODE_CHILD_REJECTED,
                    f"resolution child {outcome.child_operation_id!r} is not terminal-success",
                    locator_identity, operation_identity, outcomes,
                )
        winner_space, winner_session = _child_identity_for_role(pair, "winner", intent)
        loser_space, loser_session = _child_identity_for_role(pair, "loser", intent)
        if winner_space is None or loser_space is None:
            return _fail(CODE_CONFLICT_PAIR_INVALID, "resolution pair cannot name winner/loser", locator_identity, operation_identity)
        winner_fact = await self._load_session_fact_for(accessor, winner_space, winner_session)
        if isinstance(winner_fact, str):
            return _fail(winner_fact, f"winner Session cannot be proven ({winner_fact})", locator_identity, operation_identity)
        loser_fact = await self._load_session_fact_for(accessor, loser_space, loser_session)
        if isinstance(loser_fact, str):
            return _fail(loser_fact, f"loser Session cannot be proven ({loser_fact})", locator_identity, operation_identity)
        # Resolution outcome proof (TS2 plan lines 308-314, 3047): the winner
        # keeps running as the sole authoritative Session and the loser is
        # ended interrupted and marked invalid with the typed reason.
        if not winner_fact.session_present:
            return _fail(CODE_SESSION_MISSING, "winner Session is missing", locator_identity, operation_identity, outcomes)
        if winner_fact.ended:
            return _fail(CODE_SESSION_UNEXPECTED_TERMINAL, "winner Session has already ended", locator_identity, operation_identity, outcomes)
        if winner_fact.ownership_state != "authoritative":
            return _fail(CODE_SESSION_OWNERSHIP_INVALID, "winner Session ownership is not authoritative", locator_identity, operation_identity, outcomes)
        if not loser_fact.session_present:
            return _fail(CODE_SESSION_MISSING, "loser Session is missing", locator_identity, operation_identity, outcomes)
        if not loser_fact.ended:
            return _fail(CODE_SESSION_UNEXPECTED_NONTERMINAL, "loser Session has not ended", locator_identity, operation_identity, outcomes)
        if loser_fact.validity != "invalid" or loser_fact.validity_reason != "activation_conflict_loser":
            return _fail(CODE_SESSION_INVALID_MARKER, "loser Session is not marked invalid (activation_conflict_loser)", locator_identity, operation_identity, outcomes)
        return _decision(
            CLASSIFICATION_RECOVERABLE_CLAIMING,
            RESULT_CLEAN_OR_RECOVERABLE,
            locator=locator_identity,
            operation=operation_identity,
            child_outcomes=outcomes,
            session_facts=(winner_fact, loser_fact),
            conflict_pair=pair,
        )

    # ------------------------------------------------------------------ #
    # Space fact loading
    # ------------------------------------------------------------------ #

    async def _load_session_fact(
        self, accessor: "_SpaceAccessor", locator: dict[str, object]
    ) -> SessionRecoveryFact | str:
        return await self._load_session_fact_for(
            accessor, str(locator["space_id"]), str(locator["session_id"])
        )

    async def _load_session_fact_for(
        self, accessor: "_SpaceAccessor", space_id: str, session_id: str
    ) -> SessionRecoveryFact | str:
        if not accessor.has(space_id):
            return CODE_SPACE_VIEW_MISSING
        factory = await accessor.factory_for(space_id)
        if factory is None:
            return CODE_SPACE_UNREADABLE
        try:
            async with factory() as session:
                row = await session.get(FocusSession, session_id)
        except Exception:  # noqa: BLE001 - fail closed on unreadable space DB
            return CODE_SPACE_UNREADABLE
        if row is None:
            return SessionRecoveryFact(space_id, session_id, False, None, None)
        return SessionRecoveryFact(
            space_id,
            session_id,
            True,
            row.ended_at is not None,
            row.ownership_state,
            row.validity,
            row.validity_reason,
        )

    async def _load_pair_sessions(
        self, accessor: "_SpaceAccessor", pair: ConflictPairFact
    ) -> tuple[SessionRecoveryFact, ...] | str:
        active = await self._load_session_fact_for(accessor, pair.active_space_id, pair.active_session_id)
        if isinstance(active, str):
            return active
        candidate = await self._load_session_fact_for(accessor, pair.candidate_space_id, pair.candidate_session_id)
        if isinstance(candidate, str):
            return candidate
        for fact in (active, candidate):
            if not fact.session_present:
                return CODE_SESSION_MISSING
            if fact.ownership_state != "activation_conflict":
                return CODE_CONFLICT_PAIR_INVALID
        return (active, candidate)

    async def _verify_original_child(
        self, accessor: "_SpaceAccessor", locator: dict[str, object], operation: dict[str, object]
    ) -> SpaceChildOutcome | str:
        return await self._verify_child(
            accessor,
            role="original",
            space_id=str(locator["space_id"]),
            session_id=str(locator["session_id"]),
            child_id=str(operation["operation_id"]),
            payload_hash=str(operation["payload_hash"]),
        )

    async def _verify_named_children(
        self,
        accessor: "_SpaceAccessor",
        locator: dict[str, object],
        intent: dict[str, object],
        roles: tuple[str, ...],
    ) -> tuple[SpaceChildOutcome, ...] | str:
        children = _decode_children(intent)
        if children is None:
            if "children" in intent:
                return CODE_CHILDREN_DECLARATION_INVALID
            return CODE_CHILDREN_DECLARATION_MISSING
        if not set(roles) <= set(children):
            return CODE_CHILDREN_DECLARATION_MISSING
        child_ids = [children[role].operation_id for role in roles]
        if len(set(child_ids)) != len(child_ids):
            return CODE_CHILDREN_DECLARATION_CONFLICT
        derivation = _verify_child_derivation(str(locator["operation_id"]), intent, roles)
        if derivation is not None:
            return derivation
        pair = _decode_pair(intent)
        if pair is None:
            return CODE_CONFLICT_PAIR_MISSING
        outcomes: list[SpaceChildOutcome] = []
        for role in roles:
            space_id, session_id = _child_identity_for_role(pair, role, intent)
            if space_id is None:
                return CODE_CONFLICT_PAIR_INVALID
            declaration = children[role]
            outcome = await self._verify_child(
                accessor, role=role, space_id=space_id, session_id=session_id,
                child_id=declaration.operation_id, payload_hash=declaration.payload_hash,
            )
            if isinstance(outcome, str):
                return outcome
            outcomes.append(outcome)
        return tuple(outcomes)

    async def _verify_child(
        self,
        accessor: "_SpaceAccessor",
        *,
        role: str,
        space_id: str,
        session_id: str,
        child_id: str,
        payload_hash: str,
    ) -> SpaceChildOutcome | str:
        if not accessor.has(space_id):
            return CODE_SPACE_VIEW_MISSING
        factory = await accessor.factory_for(space_id)
        if factory is None:
            return CODE_SPACE_UNREADABLE
        try:
            async with factory() as session:
                envelope = await session.get(SessionCommandEnvelope, child_id)
                receipt = await session.get(SessionCommandReceipt, child_id)
        except Exception:  # noqa: BLE001 - fail closed on unreadable space DB
            return CODE_SPACE_UNREADABLE
        if envelope is None:
            return SpaceChildOutcome(role, space_id, session_id, child_id, False, None, False, False, False, False)
        if envelope.space_id != space_id or envelope.session_id != session_id:
            return CODE_CHILD_IDENTITY_MISMATCH
        if str(envelope.payload_hash) != payload_hash:
            return CODE_CHILD_PAYLOAD_HASH_MISMATCH
        if receipt is None:
            return SpaceChildOutcome(role, space_id, session_id, child_id, True, None, False, False, False, False)
        state = str(receipt.state)
        return SpaceChildOutcome(
            role=role,
            space_id=space_id,
            session_id=session_id,
            child_operation_id=child_id,
            envelope_present=True,
            receipt_state=state,
            terminal_success=state == CommandReceiptState.SUCCEEDED.value,
            terminal_rejected=state in {CommandReceiptState.FAILED.value, CommandReceiptState.CONFLICT.value},
            unknown=state == CommandReceiptState.UNKNOWN.value,
            pending=state == CommandReceiptState.PENDING.value,
        )


# --------------------------------------------------------------------------- #
# Space accessor
# --------------------------------------------------------------------------- #


class _SpaceAccessor:
    """Lazily open read-only Space engines, one per requested Space."""

    def __init__(self, space_views: Mapping[str, SpaceDataView] | None) -> None:
        self._views = dict(space_views or {})
        self._engines: dict[str, AsyncEngine] = {}

    def has(self, space_id: str) -> bool:
        return space_id in self._views

    async def factory_for(self, space_id: str):
        view = self._views.get(space_id)
        if view is None:
            return None
        engine = self._engines.get(space_id)
        if engine is None:
            try:
                engine = _readonly_engine(view.db_path)
            except Exception:  # noqa: BLE001
                return None
            self._engines[space_id] = engine
        return create_session_factory(engine)

    async def close(self) -> None:
        for engine in self._engines.values():
            await engine.dispose()
        self._engines.clear()


# --------------------------------------------------------------------------- #
# Meta schema / row access
# --------------------------------------------------------------------------- #


async def _schema_problems(engine: AsyncEngine) -> str | None:
    """Return a stable message when a coordination table or column is missing."""
    factory = create_session_factory(engine)
    try:
        async with factory() as session:
            connection = await session.connection()
            table_names = {
                str(row[0])
                for row in await connection.execute(
                    sa_text(
                        "SELECT name FROM sqlite_master WHERE type='table'"
                    )
                )
            }
            for name in ("active_session_locator", "active_session_operations"):
                if name not in table_names:
                    return f"{name} table is missing"
                columns = {
                    str(row[1])
                    for row in await connection.execute(
                        sa_text(f'PRAGMA table_info("{name}")')
                    )
                }
                expected = (
                    _LOCATOR_COLUMNS if name == "active_session_locator" else _OPERATION_COLUMNS
                )
                missing = expected - columns
                if missing:
                    return f"{name} is missing columns: {sorted(missing)}"
            return None
    except Exception as exc:  # noqa: BLE001 - unreadable/absent Meta DB fails closed
        return f"meta database is unreadable: {type(exc).__name__}"


async def _locator_rows(engine: AsyncEngine) -> list[dict[str, object]]:
    factory = create_session_factory(engine)
    async with factory() as session:
        rows = list(
            (await session.execute(select(ActiveSessionLocator))).scalars().all()
        )
    return [_row_to_dict(row) for row in rows]


def _row_to_dict(row: Any) -> dict[str, object]:
    return {
        column.name: getattr(row, column.name)
        for column in row.__table__.columns
    }


async def _operation_row(engine: AsyncEngine, operation_id: str) -> Any | None:
    factory = create_session_factory(engine)
    async with factory() as session:
        return await session.get(ActiveSessionOperation, operation_id)


def _validated_locator(row: dict[str, object]) -> dict[str, object] | None:
    if row.get("singleton_key") != _SINGLETON_KEY:
        return None
    state = row.get("state")
    if not isinstance(state, str) or state not in _LOCATOR_STATES:
        return None
    for name in ("space_id", "session_id", "owner_device_id", "owner_tab_id"):
        if not _require_nonempty_ascii(row.get(name)):
            return None
    if not _require_operation_id(row.get("operation_id")):
        return None
    epoch = row.get("ownership_epoch")
    if type(epoch) is not int or epoch <= 0:  # bool is an int subclass
        return None
    if _parse_canonical_utc(row.get("lease_expires_at")) is None:
        return None
    if _parse_canonical_utc(row.get("updated_at")) is None:
        return None
    return dict(row)


def _validated_operation(
    row: dict[str, object], locator: dict[str, object]
) -> dict[str, object] | None:
    if _validated_operation_shape(row) is None:
        return None
    if str(row.get("operation_id")) != str(locator.get("operation_id")):
        return None
    return dict(row)


def _validated_operation_shape(row: dict[str, object]) -> dict[str, object] | None:
    """Structurally validate an operation row on its own.

    ``operation_id`` binding to the locator is a separate concern
    (``_validated_operation``); relation-chain links must pass this shape check
    without requiring ``child.operation_id == parent.operation_id``.
    """
    if not _require_operation_id(row.get("operation_id")):
        return None
    kind = row.get("kind")
    if not isinstance(kind, str) or kind not in _KNOWN_KINDS:
        return None
    phase = row.get("phase")
    if not isinstance(phase, str) or phase not in _KNOWN_PHASES:
        return None
    if not _require_payload_hash(row.get("payload_hash")):
        return None
    intent_raw = row.get("intent_json")
    if not isinstance(intent_raw, str) or not intent_raw:
        return None
    if _parse_canonical_utc(row.get("created_at")) is None:
        return None
    if _parse_canonical_utc(row.get("updated_at")) is None:
        return None
    created = _parse_canonical_utc(row.get("created_at"))
    updated = _parse_canonical_utc(row.get("updated_at"))
    if created is None or updated is None or created > updated:
        return None
    descriptor = row.get("result_descriptor_json")
    if descriptor is not None:
        if not isinstance(descriptor, str) or len(descriptor.encode("utf-8")) > _MAX_RESULT_DESCRIPTOR_BYTES:
            return None
        try:
            decoded = json.loads(descriptor)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None
        if not isinstance(decoded, dict):
            return None
    related = row.get("related_operation_id")
    if related is not None and not _require_operation_id(related):
        return None
    return dict(row)


def _verify_intent(
    locator: dict[str, object], operation: dict[str, object]
) -> dict[str, object] | None:
    try:
        intent = json.loads(str(operation["intent_json"]))
    except (json.JSONDecodeError, UnicodeDecodeError, TypeError):
        return None
    if not isinstance(intent, dict):
        return None
    expected = {
        "command_id": operation["operation_id"],
        "space_id": locator["space_id"],
        "session_id": locator["session_id"],
        "ownership_epoch": locator["ownership_epoch"],
        "payload_hash": operation["payload_hash"],
        "kind": operation["kind"],
    }
    for key, expected_value in expected.items():
        value = intent.get(key)
        if isinstance(expected_value, int):
            if type(value) is not int or value != expected_value:
                return None
        elif not isinstance(value, str) or value != expected_value:
            return None
    business = {
        key: value for key, value in intent.items() if key not in _INTENT_EXCLUDED_KEYS
    }
    try:
        recomputed = canonical_payload_hash(business)
    except Exception:  # noqa: BLE001 - malformed business subset fails closed
        return None
    if recomputed != str(operation["payload_hash"]):
        return None
    return intent


async def _verify_relation_chain(
    engine: AsyncEngine, operation: dict[str, object], space_id: str, session_id: str
) -> str | None:
    """Structurally validate ``related_operation_id`` links without guessing
    their semantics: each link must exist, be well formed, acyclic, and agree
    on Space/Session identity within a bounded depth.

    Each related row is validated with ``_validated_operation_shape`` only —
    the ``operation_id == locator.operation_id`` binding is a separate
    concern owned by the inspect entry point, never applied to chain links.
    """
    seen = {str(operation["operation_id"])}
    current = operation
    # A resolution operation is the recovery root that *changes* the locator
    # target to the winner side (plan L3420): its first hop back to the
    # conflict operation is intentionally a different identity, so the
    # Space/Session agreement check starts at the conflict link, not the root.
    root_is_resolution = str(operation.get("kind")) == "resolve_activation_conflict"
    for _ in range(_MAX_RELATION_CHAIN_DEPTH):
        related = current.get("related_operation_id")
        if related is None:
            return None
        related = str(related)
        if related in seen:
            return CODE_RELATION_CYCLE
        child = await _operation_row(engine, related)
        if child is None:
            return CODE_RELATION_MISSING
        child_row = _row_to_dict(child)
        if _validated_operation_shape(child_row) is None:
            return CODE_RELATION_INVALID
        try:
            child_intent = json.loads(str(child_row["intent_json"]))
        except (json.JSONDecodeError, UnicodeDecodeError, TypeError):
            return CODE_RELATION_INVALID
        if not isinstance(child_intent, dict):
            return CODE_RELATION_INVALID
        epoch = child_intent.get("ownership_epoch")
        if type(epoch) is not int or epoch <= 0:
            return CODE_RELATION_INVALID
        if root_is_resolution:
            # The conflict link anchors the *original* active side; from here
            # deeper links must keep agreeing with that identity.
            root_is_resolution = False
            space_id = str(child_intent.get("space_id") or "")
            session_id = str(child_intent.get("session_id") or "")
        if child_intent.get("space_id") != space_id:
            return CODE_RELATION_INVALID
        if child_intent.get("session_id") != session_id:
            return CODE_RELATION_INVALID
        seen.add(related)
        current = child_row
    return CODE_RELATION_INVALID


# --------------------------------------------------------------------------- #
# Intent declaration helpers
# --------------------------------------------------------------------------- #


def _decode_pair(intent: Mapping[str, object]) -> ConflictPairFact | None:
    raw = intent.get("pair")
    if not isinstance(raw, dict):
        return None
    active = raw.get("active")
    candidate = raw.get("candidate")
    if not isinstance(active, dict) or not isinstance(candidate, dict):
        return None
    a_space = active.get("space_id")
    a_session = active.get("session_id")
    c_space = candidate.get("space_id")
    c_session = candidate.get("session_id")
    if not all(
        isinstance(value, str) and value
        for value in (a_space, a_session, c_space, c_session)
    ):
        return None
    return ConflictPairFact(
        active_space_id=a_space,
        active_session_id=a_session,
        candidate_space_id=c_space,
        candidate_session_id=c_session,
    )


def _verify_child_derivation(
    parent_operation_id: str, intent: Mapping[str, object], roles: tuple[str, ...]
) -> str | None:
    """Prove each named child ID is the deterministic derivation of the parent
    operation ID and the role's authoritative suffix from the *shared public
    contract* (``app.focus_session.child_operations``).

    ``parent_operation_id``, ``role`` and the derived child ID all participate
    so a child declared for another parent (cross-parent replay), an unknown
    role, or a role/suffix mismatch never passes.
    """
    children = intent.get("children")
    if not isinstance(children, dict):
        return CODE_CHILDREN_DECLARATION_MISSING
    for role in roles:
        declaration = children.get(role)
        if not isinstance(declaration, dict):
            return CODE_CHILDREN_DECLARATION_INVALID
        try:
            enum_role = ActiveSessionChildRole(role)
            expected = derive_active_session_child_operation_id(
                parent_operation_id, enum_role
            )
        except ValueError:
            return CODE_CHILD_ID_DERIVATION_UNPROVEN
        if str(declaration.get("operation_id")) != expected:
            return CODE_CHILD_ID_DERIVATION_MISMATCH
    return None


def _decode_children(intent: Mapping[str, object]) -> dict[str, ChildDeclaration] | None:
    """Decode the intent ``children`` declaration.

    Each entry must be an object ``{"operation_id": ..., "payload_hash": ...}``
    so the authority can prove the exact envelope payload identity.  A
    string-only declaration (no payload hash) has no provable source and is
    treated as invalid (the caller maps it to ``children_declaration_invalid``).
    """
    raw = intent.get("children")
    if raw is None:
        return None
    if not isinstance(raw, dict) or not raw:
        return None
    children: dict[str, ChildDeclaration] = {}
    for role, value in raw.items():
        if role not in _CHILD_ROLES or not isinstance(value, dict):
            return None
        operation_id = value.get("operation_id")
        payload_hash = value.get("payload_hash")
        if not _require_operation_id(operation_id) or not _require_payload_hash(payload_hash):
            return None
        children[role] = ChildDeclaration(str(operation_id), str(payload_hash))
    return children


def _child_identity_for_role(
    pair: ConflictPairFact, role: str, intent: Mapping[str, object]
) -> tuple[str | None, str | None]:
    """Map a child role to its (space_id, session_id) from the conflict pair."""
    if role == "active":
        return pair.active_space_id, pair.active_session_id
    if role == "candidate":
        return pair.candidate_space_id, pair.candidate_session_id
    # winner/loser: winner_role is a business field of the resolution intent.
    winner_role = intent.get("winner_role")
    if winner_role not in ("active", "candidate"):
        return None, None
    if role == "winner":
        if winner_role == "active":
            return pair.active_space_id, pair.active_session_id
        return pair.candidate_space_id, pair.candidate_session_id
    if role == "loser":
        if winner_role == "active":
            return pair.candidate_space_id, pair.candidate_session_id
        return pair.active_space_id, pair.active_session_id
    return None, None


# --------------------------------------------------------------------------- #
# Decision builders
# --------------------------------------------------------------------------- #


def _locator_identity(locator: Mapping[str, object]) -> LocatorIdentity:
    return LocatorIdentity(
        space_id=str(locator["space_id"]),
        session_id=str(locator["session_id"]),
        operation_id=str(locator["operation_id"]),
        state=str(locator["state"]),
        owner_device_id=str(locator["owner_device_id"]),
        owner_tab_id=str(locator["owner_tab_id"]),
        ownership_epoch=int(locator["ownership_epoch"]),
        lease_expires_at=str(locator["lease_expires_at"]),
        updated_at=str(locator["updated_at"]),
    )


def _operation_identity(operation: Mapping[str, object]) -> OperationIdentity:
    related = operation.get("related_operation_id")
    return OperationIdentity(
        operation_id=str(operation["operation_id"]),
        kind=str(operation["kind"]),
        phase=str(operation["phase"]),
        payload_hash=str(operation["payload_hash"]),
        related_operation_id=str(related) if related is not None else None,
    )


def _decision(
    classification: str,
    result: str,
    *,
    locator: LocatorIdentity | None = None,
    operation: OperationIdentity | None = None,
    child_outcomes: tuple[SpaceChildOutcome, ...] = (),
    session_facts: tuple[SessionRecoveryFact, ...] = (),
    conflict_pair: ConflictPairFact | None = None,
) -> ActiveSessionRecoveryDecision:
    return ActiveSessionRecoveryDecision(
        classification=classification,
        result=result,
        locator=locator,
        operation=operation,
        child_outcomes=child_outcomes,
        session_facts=session_facts,
        conflict_pair=conflict_pair,
        failure_code=None,
        reason=None,
    )


def _fail(
    failure_code: str,
    reason: str,
    locator: LocatorIdentity | None = None,
    operation: OperationIdentity | None = None,
    child_outcomes: tuple[SpaceChildOutcome, ...] = (),
) -> ActiveSessionRecoveryDecision:
    return ActiveSessionRecoveryDecision(
        classification=CLASSIFICATION_RECOVERY_REQUIRED,
        result=RESULT_NOT_CLEAN,
        locator=locator,
        operation=operation,
        child_outcomes=child_outcomes,
        session_facts=(),
        conflict_pair=None,
        failure_code=failure_code,
        reason=reason,
    )


def _empty_decision() -> ActiveSessionRecoveryDecision:
    return ActiveSessionRecoveryDecision(
        classification=CLASSIFICATION_EMPTY,
        result=RESULT_CLEAN_OR_RECOVERABLE,
        locator=None,
        operation=None,
        child_outcomes=(),
        session_facts=(),
        conflict_pair=None,
        failure_code=None,
        reason=None,
    )


def _relation_reason(code: str) -> str:
    return f"related operation chain is invalid ({code})"
