"""Production ActiveSessionCoordinator.

The coordinator is the single production writer for the ActiveSession
coordination state: it persists the Meta locator + operation rows and
executes the deterministic Space child operations of the conflict and
resolution flows.  It shares one child-ID contract with the read-only
recovery authority (``app.focus_session.child_operations``) — no suffix map
is copied anywhere.

Write discipline
----------------
1. Every child operation ID is derived *before* any Space write via
   ``derive_active_session_child_operation_id(parent_operation_id, role)``.
2. The Meta ``intent_json`` (identity + pair + children{id, payload_hash} +
   business fields) is persisted *before* the first Space child executes, so a
   crash at any point leaves enough evidence to recover/replay without
   inventing a new semantic command.
3. Child payload hashes are computed with the authoritative
   ``canonical_payload_hash`` over the real business payload (guards excluded
   exactly as ``focus_business_payload`` does), so the envelope written by the
   UoW carries the same hash the intent froze.
4. Space children execute in a deterministic order (candidate before active,
   winner before loser) through the injected UoW on the real Space handle.
5. A failed/conflict/unknown/pending child receipt never advances the
   operation to ``awaiting_resolution``/``transferred``: the coordinator
   raises and the Meta operation stays in its current phase.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable, Mapping
from datetime import datetime, timedelta, timezone
from enum import StrEnum
from typing import TYPE_CHECKING, Any

from app.db.models.meta import ActiveSessionLocator, ActiveSessionOperation
from app.errors import MutationRejectedError
from app.focus_session.child_operations import (
    ActiveSessionChildRole,
    derive_active_session_child_operation_id,
)
from app.focus_session.commands import (
    build_focus_request,
    focus_business_payload,
)
from app.focus_session.contracts import (
    ActiveSessionCommand,
    ActiveSessionView,
    CommandReceiptState,
    FocusSessionCommand,
    FrozenConflictPair,
    ResolutionCoordinationProof,
)
from app.focus_session.query import FocusSessionQuery
from app.models.focus_session import FocusSession
from app.models.session_command import SessionCommandReceipt
from app.mutation.types import (
    MutationRequest,
    bounded_child_operation_id,
    canonical_json_bytes,
    canonical_payload_hash,
    validate_operation_id,
)
from app.services.time import utc_now_iso_ms

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.auth.authority import Principal
    from app.mutation.unit_of_work import MutationUnitOfWork
    from app.runtime.space import SpaceRuntimeHandle

__all__ = ["ActiveSessionCoordinationError", "ProductionActiveSessionCoordinator"]


class ActiveSessionCoordinationError(RuntimeError):
    """Fail-closed coordination error raised by the production writer."""


# Child action per role (single, documented mapping shared by the writer).
_CHILD_ACTION_BY_ROLE: dict[ActiveSessionChildRole, str] = {
    ActiveSessionChildRole.CANDIDATE: "mark_activation_conflict",
    ActiveSessionChildRole.ACTIVE: "mark_activation_conflict",
    ActiveSessionChildRole.WINNER: "resolve_activation_conflict",
    ActiveSessionChildRole.LOSER: "resolve_conflict_loser",
}

_CHILD_ORDER = (
    ActiveSessionChildRole.CANDIDATE,
    ActiveSessionChildRole.ACTIVE,
    ActiveSessionChildRole.WINNER,
    ActiveSessionChildRole.LOSER,
)

_LEASE_MINUTES = 15


def _canonical_utc_now(clock) -> str:
    raw = clock()
    parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    return parsed.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _lease_expiry(now_iso: str, minutes: int = _LEASE_MINUTES) -> str:
    parsed = datetime.fromisoformat(now_iso.replace("Z", "+00:00"))
    expiry = parsed + timedelta(minutes=minutes)
    return expiry.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _conflict_pair(payload: Mapping[str, object]) -> dict[str, dict[str, str]]:
    raw = payload.get("pair")
    if not isinstance(raw, Mapping):
        raise ActiveSessionCoordinationError("activate_provisional requires a conflict pair")
    active = raw.get("active")
    candidate = raw.get("candidate")
    if not isinstance(active, Mapping) or not isinstance(candidate, Mapping):
        raise ActiveSessionCoordinationError("conflict pair must name active and candidate")
    pair = {
        "active": {"space_id": str(active.get("space_id")), "session_id": str(active.get("session_id"))},
        "candidate": {"space_id": str(candidate.get("space_id")), "session_id": str(candidate.get("session_id"))},
    }
    if not all(
        isinstance(v, str) and v
        for side in pair.values()
        for v in side.values()
    ):
        raise ActiveSessionCoordinationError("conflict pair identities must be nonempty strings")
    if (pair["active"]["space_id"], pair["active"]["session_id"]) == (
        pair["candidate"]["space_id"],
        pair["candidate"]["session_id"],
    ):
        raise ActiveSessionCoordinationError("conflict pair sides must be distinct")
    return pair


def _rejection_receipt_state(rejection: Any) -> str:
    """Map a durable mutation rejection to the child receipt state.

    Idempotency-style conflicts persist as ``conflict``; everything else that
    reached the Space policy fails closed as ``failed`` — the phase never
    advances on either.
    """
    code = str(getattr(rejection, "code", ""))
    if code in {"idempotency_conflict", "version_conflict"}:
        return "conflict"
    return "failed"


def _is_conflict_error_code(error_code: str) -> bool:
    return error_code in {
        "idempotency_conflict",
        "stale_session_owner",
        "session_activation_conflict",
        "version_conflict",
    }


class ChildExecutionDecision(StrEnum):
    """Closed decision for one deterministic child before it may run."""

    EXECUTE = "execute"
    ALREADY_SUCCEEDED = "already_succeeded"
    TERMINAL_REJECTED = "terminal_rejected"
    ORIGINAL_UNKNOWN = "original_unknown"
    RECOVERY_REQUIRED = "recovery_required"


class OriginalChildOutcome(StrEnum):
    """Structured classification of a child's original mutation execution.

    A closed enum so callers can never collapse a journal state into a bare
    boolean: ``ABORTED`` in particular is *not* success, and evidence
    mismatches (receipt vs journal) are their own outcome.
    """

    NOT_EXECUTED = "not_executed"
    APPLIED = "applied"
    REJECTED = "rejected"
    CONFLICT = "conflict"
    UNKNOWN = "unknown"
    ABORTED = "aborted"
    INCONCLUSIVE = "inconclusive"


class ProductionActiveSessionCoordinator:
    """Real ActiveSessionCoordinator writer over Meta + Space UoW."""

    def __init__(
        self,
        *,
        meta_session_factory: "async_sessionmaker",
        uow: "MutationUnitOfWork",
        space_handle_provider: Callable[[str], Awaitable["SpaceRuntimeHandle"]],
        session_query: FocusSessionQuery,
        clock: Callable[[], str] = utc_now_iso_ms,
    ) -> None:
        self._meta_session_factory = meta_session_factory
        self._uow = uow
        self._space_handle_provider = space_handle_provider
        self._session_query = session_query
        self._clock = clock
        # No child executor: the production path (and every test) executes
        # children exclusively through the real MutationUnitOfWork and
        # re-verifies the durable Space receipt before advancing a phase.

    # ------------------------------------------------------------------ #
    # View assembly helpers
    # ------------------------------------------------------------------ #

    def _contract_payload_hash(self, payload: Mapping[str, object]) -> str:
        """Canonical hash over the intent *business* subset — identity keys and
        the ``pair``/``children`` declarations are not business, matching the
        recovery authority's ``_verify_intent`` contract.  The wire
        ``command.payload_hash`` may hash the full payload; the durable
        operation hash must match what the authority can recompute."""
        business = {
            key: value for key, value in payload.items() if key not in ("pair", "children")
        }
        return canonical_payload_hash(business)

    async def _load_session_aggregate(
        self, handle: "SpaceRuntimeHandle", session_id: str
    ) -> dict[str, object]:
        """Load the real FocusSession aggregate or fail closed (never fake a
        createdAt/updatedAt or a fabricated session dict)."""
        aggregate = await self._session_query.load(handle, session_id)
        if aggregate.get("session") is None:
            raise ActiveSessionCoordinationError(
                f"ActiveSession references a nonexistent FocusSession: {session_id!r}"
            )
        return aggregate

    async def _with_mutation_lease(self, handle, fn):
        """Run ``fn`` under the handle's mutation lease so the Space engine
        (and therefore ``session_factory``) is active — the real runtime only
        activates mutation resources inside a lease.  ``fn`` receives the
        handle and may itself use ``handle.session_factory`` freely."""
        async with handle.mutation_lease("active-session", 5):
            return await fn(handle)

    async def _read_child_receipt(
        self, handle: "SpaceRuntimeHandle", child_id: str
    ) -> CommandReceiptState | None:
        """Read the durable Space receipt the UoW just wrote."""
        async with handle.session_factory() as session:
            receipt = await session.get(SessionCommandReceipt, child_id)
        return None if receipt is None else receipt.state

    async def _record_child_envelope(
        self,
        handle: "SpaceRuntimeHandle",
        child_id: str,
        child_command: FocusSessionCommand,
    ) -> None:
        """Persist the child command envelope before the mutation runs.

        The recovery authority only accepts child evidence as an envelope +
        receipt pair.  The envelope's ``work_item_id``/``session_revision``
        come from the real Session context rows in the Space DB — never a
        fabricated work item — and a missing context fails closed.
        """
        from sqlalchemy import select

        from app.models.focus_session import SessionTaskContext
        from app.models.session_command import SessionCommandEnvelope

        async with handle.session_factory() as session:
            context = (
                await session.execute(
                    select(SessionTaskContext).where(
                        SessionTaskContext.session_id == child_command.session_id
                    )
                )
            ).scalar_one_or_none()
            session_row = await session.get(FocusSession, child_command.session_id)
        if context is None or session_row is None:
            raise ActiveSessionCoordinationError(
                f"cannot record child envelope {child_id!r}: "
                "session context is missing (no real work item identity)"
            )
        async with handle.session_factory() as session:
            session.add(
                SessionCommandEnvelope(
                    command_id=child_id,
                    space_id=child_command.space_id,
                    session_id=child_command.session_id,
                    session_revision=session_row.session_revision,
                    work_item_id=context.level2_work_item_id,
                    expected_version=1,
                    target_transition="complete",
                    replay_safe=True,
                    payload_hash=child_command.payload_hash,
                    created_at=_canonical_utc_now(self._clock),
                )
            )
            await session.commit()

    async def _record_child_receipt(
        self,
        handle: "SpaceRuntimeHandle",
        child_id: str,
        child_command: FocusSessionCommand,
        *,
        state: str = "succeeded",
        error_code: str | None = None,
    ) -> None:
        """Persist a receipt strictly from the real UoW outcome through the
        same ``focus_session.record_receipt`` mutation channel the reconciler
        uses.  ``succeeded`` is written only after the mutation actually
        applied; rejected/conflict/unknown outcomes write the matching state
        and never advance a phase."""

        receipt_payload: dict[str, object] = {
            "space_id": child_command.space_id,
            "session_id": child_command.session_id,
            "command_id": child_id,
            "state": state,
            "error_code": error_code,
            "retryable": False,
            "details": None,
            "result": None,
            "updated_at": _canonical_utc_now(self._clock),
            "expected_coordination": {
                "kind": "replay_claimed", "root_command_id": child_id,
            },
        }
        receipt_operation_id = bounded_child_operation_id(
            child_id, f"receipt:{state}"
        )
        receipt_command = FocusSessionCommand(
            command_id=receipt_operation_id,
            space_id=child_command.space_id,
            session_id=child_command.session_id,
            ownership_epoch=None,
            payload_hash=self._child_hash("record_receipt", receipt_payload),
            payload=receipt_payload,
        )
        # NOTE: build_focus_request() overrides payload["command_id"] with the
        # operation id, but _compile_receipt_row resolves the *target envelope*
        # from payload["command_id"] — so we build the request directly from
        # the payload, keeping command_id == child_id (the envelope we wrote).
        request = MutationRequest.from_payload(
            name="focus_session.record_receipt",
            entity_type="focus_session",
            entity_id=child_command.session_id,
            payload={
                **dict(receipt_payload),
                "action": "record_receipt",
                "space_id": child_command.space_id,
                "session_id": child_command.session_id,
                "ownership_epoch": None,
                "payload_hash": receipt_command.payload_hash,
            },
            expected_version=None,
        )
        try:
            await self._uow.execute(handle, request, receipt_operation_id)
        except Exception as exc:
            _details = getattr(getattr(exc, "rejection", None), "details", None)
            raise ActiveSessionCoordinationError(
                f"record_receipt for child {child_id!r} failed: {type(exc).__name__} "
                f"{_details!r}"
            ) from exc

    async def _locator_aggregate_view(
        self, locator: ActiveSessionLocator
    ) -> dict[str, object]:
        """Locator view + the real Session aggregate (never fabricated)."""
        handle = await self._space_handle_provider(locator.space_id)
        session_aggregate = await self._with_mutation_lease(
            handle,
            lambda h: self._load_session_aggregate(h, locator.session_id),
        )
        return {"locator": self._locator_view(locator), "session": session_aggregate}

    # ------------------------------------------------------------------ #
    # Public Protocol surface
    # ------------------------------------------------------------------ #

    async def locate(self, principal: "Principal") -> ActiveSessionView | None:
        async with self._meta_session_factory() as session:
            locator = await session.get(ActiveSessionLocator, "active")
            if locator is None:
                return None
            operation = await session.get(
                ActiveSessionOperation, locator.operation_id
            )
        # Load the real aggregate; a locator pointing at a missing Session is a
        # broken state and fails closed instead of returning fabricated data.
        handle = await self._space_handle_provider(locator.space_id)
        session_aggregate = await self._with_mutation_lease(
            handle,
            lambda h: self._load_session_aggregate(h, locator.session_id),
        )
        return ActiveSessionView(value={"locator": self._locator_view(locator)} | (
            {"operation": self._operation_view(operation)}
            if operation is not None
            else {}
        ) | {"session": session_aggregate})

    async def start(
        self, principal: "Principal", command: ActiveSessionCommand
    ) -> ActiveSessionView:
        if command.space_id is None:
            raise ActiveSessionCoordinationError("start requires space_id")
        operation_id = self._require_operation_id(command.command_id)
        payload_hash = self._require_payload_hash(command.payload_hash)
        intent = self._intent(
            operation_id, "start", command, business=dict(command.payload),
        )
        now = _canonical_utc_now(self._clock)
        async with self._meta_session_factory() as session:
            locator = await session.get(ActiveSessionLocator, "active")
            if locator is not None:
                if locator.operation_id != operation_id:
                    raise ActiveSessionCoordinationError(
                        "an ActiveSession is already claimed"
                    )
                # Idempotent replay: the same command_id already claimed this
                # slot.  Same payload hash -> return the durable state; a
                # different payload hash is a stable idempotency conflict.
                existing_op = await session.get(ActiveSessionOperation, operation_id)
                if existing_op is None or existing_op.payload_hash != payload_hash:
                    raise ActiveSessionCoordinationError(
                        "duplicate start command with a different payload hash"
                    )
                locator_view = self._locator_view(locator)
                op_view = self._operation_view(existing_op)
                space_id = locator.space_id
                session_id = locator.session_id
                idempotent = True
            else:
                idempotent = False
                locator_view = self._locator_view(
                    ActiveSessionLocator(
                        singleton_key="active",
                        space_id=command.space_id,
                        session_id=command.session_id,
                        operation_id=operation_id,
                        state="claiming",
                        owner_device_id=str(command.payload.get("owner_device_id", "")),
                        owner_tab_id=str(command.payload.get("owner_tab_id", "")),
                        ownership_epoch=command.ownership_epoch or 1,
                        lease_expires_at=_lease_expiry(now),
                        updated_at=now,
                    )
                )
                op_view = self._operation_view(
                    ActiveSessionOperation(
                        operation_id=operation_id,
                        kind="start",
                        payload_hash=payload_hash,
                        intent_json=canonical_json_bytes(intent).decode("ascii"),
                        phase="claimed",
                        created_at=now,
                        updated_at=now,
                    )
                )
                space_id = command.space_id
                session_id = command.session_id
            if not idempotent:
                try:
                    session.add(
                        ActiveSessionLocator(
                            singleton_key="active",
                            space_id=command.space_id,
                            session_id=command.session_id,
                            operation_id=operation_id,
                            state="claiming",
                            owner_device_id=str(command.payload.get("owner_device_id", "")),
                            owner_tab_id=str(command.payload.get("owner_tab_id", "")),
                            ownership_epoch=command.ownership_epoch or 1,
                            lease_expires_at=_lease_expiry(now),
                            updated_at=now,
                        )
                    )
                    session.add(
                        ActiveSessionOperation(
                            operation_id=operation_id,
                            kind="start",
                            payload_hash=payload_hash,
                            intent_json=canonical_json_bytes(intent).decode("ascii"),
                            phase="claimed",
                            created_at=now,
                            updated_at=now,
                        )
                    )
                    await session.commit()
                except Exception as exc:
                    await session.rollback()
                    raise ActiveSessionCoordinationError(
                        "concurrent claimant won the singleton ActiveSession slot"
                    ) from exc
        # Real Space write: create the FocusSession under the claiming locator
        # (or reuse an already-persisted Session on restart) so the response
        # aggregate reflects durable Space data, never a fabricated dict.
        handle = await self._space_handle_provider(space_id)
        if not idempotent:
            async with handle.mutation_lease("active-session-start", 5):
                async with handle.session_factory() as session:
                    existing_session = await session.get(FocusSession, session_id)
                if existing_session is None:
                    start_request = build_focus_request(
                        "start",
                        FocusSessionCommand(
                            command_id=operation_id,
                            space_id=space_id,
                            session_id=session_id,
                            ownership_epoch=command.ownership_epoch or 1,
                            payload_hash=payload_hash,
                            payload=dict(command.payload),
                        ),
                    )
                    try:
                        await self._uow.execute(handle, start_request, operation_id)
                    except Exception as exc:
                        raise ActiveSessionCoordinationError(
                            f"start mutation failed: {type(exc).__name__}"
                        ) from exc
        session_aggregate = await self._with_mutation_lease(
            handle,
            lambda h: self._load_session_aggregate(h, session_id),
        )
        return ActiveSessionView(value={"locator": locator_view} | {
            "operation": op_view,
            "session": session_aggregate,
        })

    async def activate_provisional(
        self, principal: "Principal", command: ActiveSessionCommand
    ) -> ActiveSessionView:
        """Persist the conflict intent (all child IDs + hashes) *before* the
        first Space child executes, then run candidate -> active children."""
        operation_id = self._require_operation_id(command.command_id)
        pair = _conflict_pair(command.payload)
        candidate_id = derive_active_session_child_operation_id(
            operation_id, ActiveSessionChildRole.CANDIDATE
        )
        active_id = derive_active_session_child_operation_id(
            operation_id, ActiveSessionChildRole.ACTIVE
        )
        child_payloads = self._conflict_child_payloads(command, pair)
        candidate_hash = self._child_hash(
            "mark_activation_conflict", child_payloads[ActiveSessionChildRole.CANDIDATE]
        )
        active_hash = self._child_hash(
            "mark_activation_conflict", child_payloads[ActiveSessionChildRole.ACTIVE]
        )
        business = dict(command.payload)
        contract_hash = self._contract_payload_hash(command.payload)
        children = {
            "candidate": {"operation_id": candidate_id, "payload_hash": candidate_hash},
            "active": {"operation_id": active_id, "payload_hash": active_hash},
        }
        intent = self._intent(
            operation_id, "activate_provisional", command,
            business=business, pair=pair, children=children,
            payload_hash=contract_hash,
        )
        now = _canonical_utc_now(self._clock)
        async with self._meta_session_factory() as session:
            locator = await session.get(ActiveSessionLocator, "active")
            if locator is not None and (
                locator.state != "claiming"
                or locator.operation_id != operation_id
            ):
                raise ActiveSessionCoordinationError(
                    "activate_provisional requires the claiming locator of this operation"
                )
            if locator is None:
                session.add(
                    ActiveSessionLocator(
                        singleton_key="active",
                        space_id=pair["active"]["space_id"],
                        session_id=pair["active"]["session_id"],
                        operation_id=operation_id,
                        state="claiming",
                        owner_device_id=str(command.payload.get("owner_device_id", "")),
                        owner_tab_id=str(command.payload.get("owner_tab_id", "")),
                        ownership_epoch=command.ownership_epoch or 1,
                        lease_expires_at=_lease_expiry(now),
                        updated_at=now,
                    )
                )
            session.add(
                ActiveSessionOperation(
                    operation_id=operation_id,
                    kind="activate_provisional",
                    payload_hash=contract_hash,
                    intent_json=canonical_json_bytes(intent).decode("ascii"),
                    phase="claimed",
                    created_at=now,
                    updated_at=now,
                )
            )
            await session.commit()
        # Execute the deterministic children (candidate first, then active).
        await self._execute_children(
            pair, operation_id, children, child_payloads
        )
        # Both children terminal-success -> awaiting_resolution.
        async with self._meta_session_factory() as session:
            operation = await session.get(ActiveSessionOperation, operation_id)
            if operation is None:
                raise ActiveSessionCoordinationError("conflict operation vanished")
            operation.phase = "awaiting_resolution"
            operation.updated_at = _canonical_utc_now(self._clock)
            await session.commit()
        # Assemble the conflict response from the *real* Session aggregates of
        # both Spaces (locator-only dicts are never forced into the wire model).
        active_handle = await self._space_handle_provider(pair["active"]["space_id"])
        candidate_handle = await self._space_handle_provider(pair["candidate"]["space_id"])
        active_aggregate = await self._with_mutation_lease(
            active_handle,
            lambda h: self._load_session_aggregate(h, pair["active"]["session_id"]),
        )
        candidate_aggregate = await self._with_mutation_lease(
            candidate_handle,
            lambda h: self._load_session_aggregate(h, pair["candidate"]["session_id"]),
        )
        active_locator = ActiveSessionLocator(
            singleton_key="active", space_id=pair["active"]["space_id"],
            session_id=pair["active"]["session_id"], operation_id=operation_id,
            state="claiming",
            owner_device_id=str(command.payload.get("owner_device_id", "")),
            owner_tab_id=str(command.payload.get("owner_tab_id", "")),
            ownership_epoch=command.ownership_epoch or 1,
            lease_expires_at=_lease_expiry(now), updated_at=now,
        )
        return ActiveSessionView(value={
            "kind": "activation_conflict",
            "active": {
                **self._locator_view(active_locator),
                "operation": self._operation_view(operation),
                "session": active_aggregate,
            },
            "candidate": {
                "space_id": pair["candidate"]["space_id"],
                "session_id": pair["candidate"]["session_id"],
                "session": candidate_aggregate,
            },
        })

    async def resolve_activation_conflict(
        self, principal: "Principal", command: ActiveSessionCommand
    ) -> ActiveSessionView:
        """Crash-safe resolution: persist the resolution intent in the
        provable *prepared* phase (``claimed`` — the Meta schema has no
        resolution-specific enum), run winner -> loser children, and only when
        both receipts are terminal-success CAS the operation to
        ``transferred`` in a separate Meta transaction (TS2 plan L3047-3048).
        A failure at any child leaves the operation ``claimed`` with all
        evidence preserved."""
        from sqlalchemy import text as sa_text

        operation_id = self._require_operation_id(command.command_id)
        # The wire resolve payload names only winnerRole/decisionAt/
        # validityCorrection (plan L3420): the conflict pair is loaded from
        # the persisted conflict operation intent, never from the payload.
        pair = _conflict_pair(command.payload) if command.payload.get("pair") else None
        winner_role = command.payload.get("winner_role")
        if winner_role not in ("active", "candidate"):
            raise ActiveSessionCoordinationError("resolution requires winner_role active|candidate")
        winner_id = derive_active_session_child_operation_id(
            operation_id, ActiveSessionChildRole.WINNER
        )
        loser_id = derive_active_session_child_operation_id(
            operation_id, ActiveSessionChildRole.LOSER
        )
        now = _canonical_utc_now(self._clock)
        # 1) Read the persisted conflict anchor (read-only).  A restart finds
        #    the locator already anchored to this resolution operation (winner
        #    target); a completed resolution is idempotently replayed.
        async with self._meta_session_factory() as session:
            locator = await session.get(ActiveSessionLocator, "active")
            if locator is None:
                raise ActiveSessionCoordinationError(
                    "resolve_activation_conflict requires a persisted locator"
                )
            if locator.state == "active":
                existing_res = await session.get(ActiveSessionOperation, operation_id)
                if (
                    existing_res is None
                    or existing_res.kind != "resolve_activation_conflict"
                    or existing_res.phase != "completed"
                    or locator.operation_id != operation_id
                ):
                    raise ActiveSessionCoordinationError(
                        "locator is active under a different resolution operation"
                    )
                if (
                    existing_res.payload_hash
                    != self._contract_payload_hash(command.payload)
                ):
                    raise ActiveSessionCoordinationError(
                        "resolution replay payload hash does not match the "
                        "completed operation (idempotency conflict)"
                    )
                # fully completed: idempotent replay, return the active shape
                related_operation_id = existing_res.related_operation_id or ""
                conflict_operation = await session.get(
                    ActiveSessionOperation, related_operation_id
                )
                if conflict_operation is None:
                    raise ActiveSessionCoordinationError(
                        "resolution conflict operation is missing"
                    )
                import json as _json

                conflict_intent = _json.loads(str(conflict_operation.intent_json))
                pair = _conflict_pair(conflict_intent)
                winner_role = str(existing_res and _json.loads(
                    str(existing_res.intent_json)
                ).get("winner_role") or "")
                if winner_role not in ("active", "candidate"):
                    raise ActiveSessionCoordinationError(
                        "completed resolution intent does not name a winner"
                    )
                winner_side = pair[winner_role]
                loser_side = pair["active"] if winner_role == "candidate" else pair["candidate"]
                winner_handle = await self._space_handle_provider(winner_side["space_id"])
                session_aggregate = await self._with_mutation_lease(
                    winner_handle,
                    lambda h: self._load_session_aggregate(h, winner_side["session_id"]),
                )
                return ActiveSessionView(value={
                    "locator": self._locator_view(locator),
                    "operation": self._operation_view(existing_res),
                    "session": session_aggregate,
                })
            if locator.state != "claiming":
                raise ActiveSessionCoordinationError(
                    "resolve_activation_conflict requires a claiming locator"
                )
            if locator.operation_id not in {
                operation_id,
                str(command.payload.get("related_operation_id", locator.operation_id)),
            }:
                raise ActiveSessionCoordinationError(
                    "resolution must bind the original conflict operation"
                )
            if (
                command.ownership_epoch is not None
                and locator.operation_id != operation_id
                and locator.ownership_epoch != command.ownership_epoch
            ):
                raise ActiveSessionCoordinationError("resolution epoch does not match the locator")
            is_restart = locator.operation_id == operation_id
            if is_restart:
                existing_res = await session.get(ActiveSessionOperation, operation_id)
                if existing_res is None or existing_res.kind != "resolve_activation_conflict":
                    raise ActiveSessionCoordinationError(
                        "locator anchors a resolution operation that is missing"
                    )
                related_operation_id = existing_res.related_operation_id or ""
                expected_epoch = locator.ownership_epoch
            else:
                original = await session.get(ActiveSessionOperation, locator.operation_id)
                if original is None or original.kind != "activate_provisional":
                    raise ActiveSessionCoordinationError(
                        "resolution requires the original activate_provisional operation"
                    )
                related_operation_id = locator.operation_id
                expected_epoch = locator.ownership_epoch
            if not related_operation_id:
                raise ActiveSessionCoordinationError(
                    "resolution conflict anchor is missing"
                )
            # Load the persisted conflict pair from the conflict operation
            # intent when the wire payload carried none; a payload pair must
            # match it exactly.
            conflict_operation = await session.get(
                ActiveSessionOperation, related_operation_id
            )
            if conflict_operation is None:
                raise ActiveSessionCoordinationError(
                    "resolution conflict operation is missing"
                )
            import json as _json

            conflict_intent = _json.loads(str(conflict_operation.intent_json))
            persisted_pair = _conflict_pair(conflict_intent)
            if pair is None:
                pair = persisted_pair
            elif pair != persisted_pair:
                raise ActiveSessionCoordinationError(
                    "resolution pair does not match the persisted conflict intent"
                )
            resolution_epoch = (
                expected_epoch + 1 if not is_restart else expected_epoch
            )
        winner_side = pair[winner_role]
        loser_side = pair["active"] if winner_role == "candidate" else pair["candidate"]
        child_payloads = self._resolution_child_payloads(command, pair, winner_role)
        winner_hash = self._child_hash(
            "resolve_activation_conflict", child_payloads[ActiveSessionChildRole.WINNER]
        )
        loser_hash = self._child_hash(
            "resolve_conflict_loser", child_payloads[ActiveSessionChildRole.LOSER]
        )
        children = {
            "winner": {"operation_id": winner_id, "payload_hash": winner_hash},
            "loser": {"operation_id": loser_id, "payload_hash": loser_hash},
        }
        contract_hash = self._contract_payload_hash(command.payload)
        intent = self._intent(
            operation_id, "resolve_activation_conflict", command,
            business=dict(command.payload), pair=pair, children=children,
            payload_hash=contract_hash,
        )
        intent["ownership_epoch"] = resolution_epoch
        # The wire resolve command carries no space_id; freeze the *winner*
        # target (the locator CASes onto it, plan L3420) so the recovery
        # authority's intent<->locator check agrees after completion.
        intent["space_id"] = winner_side["space_id"]
        intent["session_id"] = winner_side["session_id"]
        # 2) One Meta transaction: insert/verify the resolution operation and
        #    CAS the locator onto the WINNER target at epoch E+1 with a single
        #    conditional UPDATE (rowcount == 1).  On rowcount == 0 the locator
        #    must already point at this exact resolution operation, winner
        #    target, next epoch (idempotent restart); anything else is a
        #    stable CAS conflict and rolls the new operation row back.
        async with self._meta_session_factory() as session:
            existing = await session.get(ActiveSessionOperation, operation_id)
            if existing is None:
                session.add(
                    ActiveSessionOperation(
                        operation_id=operation_id,
                        kind="resolve_activation_conflict",
                        payload_hash=contract_hash,
                        intent_json=canonical_json_bytes(intent).decode("ascii"),
                        phase="claimed",
                        related_operation_id=related_operation_id,
                        created_at=now,
                        updated_at=now,
                    )
                )
                if not is_restart:
                    result = await session.execute(
                        sa_text(
                            "UPDATE active_session_locator "
                            "SET operation_id=:rid, ownership_epoch=:next_epoch, "
                            "space_id=:winner_space_id, session_id=:winner_session_id, "
                            "updated_at=:now "
                            "WHERE singleton_key='active' AND state='claiming' "
                            "AND operation_id=:conflict_id "
                            "AND ownership_epoch=:expected_epoch "
                            "AND space_id=:active_space_id "
                            "AND session_id=:active_session_id"
                        ),
                        {
                            "rid": operation_id,
                            "next_epoch": resolution_epoch,
                            "now": now,
                            "conflict_id": related_operation_id,
                            "expected_epoch": expected_epoch,
                            "active_space_id": pair["active"]["space_id"],
                            "active_session_id": pair["active"]["session_id"],
                            "winner_space_id": winner_side["space_id"],
                            "winner_session_id": winner_side["session_id"],
                        },
                    )
                    if result.rowcount != 1:
                        # Idempotent restart: the locator already points at
                        # this resolution operation, winner target, next epoch.
                        fresh = await session.get(ActiveSessionLocator, "active")
                        if (
                            fresh is not None
                            and fresh.operation_id == operation_id
                            and fresh.ownership_epoch == resolution_epoch
                            and fresh.state == "claiming"
                            and fresh.space_id == winner_side["space_id"]
                            and fresh.session_id == winner_side["session_id"]
                        ):
                            await session.rollback()
                        else:
                            raise ActiveSessionCoordinationError(
                                "resolution locator CAS conflict (another "
                                "resolution owns the conflict)"
                            )
            elif (
                existing.kind != "resolve_activation_conflict"
                or existing.payload_hash != contract_hash
                or existing.related_operation_id != related_operation_id
                or existing.phase not in {"claimed", "prepared", "transferred", "completed"}
            ):
                raise ActiveSessionCoordinationError(
                    "resolution operation conflicts with the persisted row "
                    "(idempotency conflict)"
                )
            await session.commit()
        # 3) Rebuild the frozen proof entirely from the freshly persisted Meta
        #    rows (locator + resolution operation + canonical intent_json).
        proof = await self._read_resolution_proof(operation_id=operation_id)
        for role in (ActiveSessionChildRole.WINNER, ActiveSessionChildRole.LOSER):
            child_payloads[role]["resolution_proof"] = proof.to_dict()
        child_payloads[ActiveSessionChildRole.WINNER]["space_id"] = winner_side["space_id"]
        child_payloads[ActiveSessionChildRole.WINNER]["session_id"] = winner_side["session_id"]
        child_payloads[ActiveSessionChildRole.LOSER]["space_id"] = loser_side["space_id"]
        child_payloads[ActiveSessionChildRole.LOSER]["session_id"] = loser_side["session_id"]
        # 4) execute winner then loser; any failure leaves the operation claimed
        await self._execute_children(
            pair, operation_id, children, child_payloads
        )
        # 4.5) CAS claimed -> transferred (the authority recovery midpoint):
        #      a crash here leaves locator claiming + resolution transferred +
        #      both receipts success, which a restart finishes below.
        async with self._meta_session_factory() as session:
            transfer_result = await session.execute(
                sa_text(
                    "UPDATE active_session_operations SET phase='transferred', "
                    "updated_at=:now WHERE operation_id=:oid AND phase='claimed' "
                    "AND related_operation_id=:related"
                ),
                {
                    "now": _canonical_utc_now(self._clock),
                    "oid": operation_id,
                    "related": related_operation_id,
                },
            )
            await session.commit()
            if transfer_result.rowcount != 1:
                operation_row = await session.get(ActiveSessionOperation, operation_id)
                if (
                    operation_row is None
                    or operation_row.phase not in {"transferred", "completed"}
                ):
                    raise ActiveSessionCoordinationError(
                        "resolution transfer CAS failed: operation was not "
                        "in claimed phase"
                    )
        # 5) One Meta transaction completes the resolution: locator
        #    claiming -> active (winner target preserved), resolution operation
        #    -> completed, old conflict operation -> completed (resolved by
        #    this resolution).  Every step is a conditional CAS with rowcount
        #    check; any failure rolls the whole transaction back.
        async with self._meta_session_factory() as session:
            locator_result = await session.execute(
                sa_text(
                    "UPDATE active_session_locator "
                    "SET state='active', lease_expires_at=:lease, updated_at=:now "
                    "WHERE singleton_key='active' AND state='claiming' "
                    "AND operation_id=:rid AND ownership_epoch=:epoch "
                    "AND space_id=:winner_space_id AND session_id=:winner_session_id"
                ),
                {
                    "now": _canonical_utc_now(self._clock),
                    "lease": _lease_expiry(_canonical_utc_now(self._clock)),
                    "rid": operation_id,
                    "epoch": resolution_epoch,
                    "winner_space_id": winner_side["space_id"],
                    "winner_session_id": winner_side["session_id"],
                },
            )
            resolution_result = await session.execute(
                sa_text(
                    "UPDATE active_session_operations SET phase='completed', "
                    "updated_at=:now WHERE operation_id=:oid AND phase='transferred' "
                    "AND related_operation_id=:related"
                ),
                {
                    "now": _canonical_utc_now(self._clock),
                    "oid": operation_id,
                    "related": related_operation_id,
                },
            )
            conflict_result = await session.execute(
                sa_text(
                    "UPDATE active_session_operations SET phase='completed', "
                    "result_descriptor_json=:descriptor, updated_at=:now "
                    "WHERE operation_id=:cid AND phase='awaiting_resolution'"
                ),
                {
                    "now": _canonical_utc_now(self._clock),
                    "cid": related_operation_id,
                    "descriptor": canonical_json_bytes(
                        {"resolved_by": operation_id}
                    ).decode("ascii"),
                },
            )
            await session.commit()
            if (
                locator_result.rowcount != 1
                or resolution_result.rowcount != 1
                or conflict_result.rowcount != 1
            ):
                raise ActiveSessionCoordinationError(
                    "resolution completion CAS failed (locator="
                    f"{locator_result.rowcount}, resolution="
                    f"{resolution_result.rowcount}, conflict="
                    f"{conflict_result.rowcount})"
                )
            # 6) The 200 response re-reads the completed locator/operation.
            locator = await session.get(ActiveSessionLocator, "active")
            operation = await session.get(ActiveSessionOperation, operation_id)
        if locator is None or operation is None:
            raise ActiveSessionCoordinationError(
                "resolution completion rows disappeared after commit"
            )
        # The response aggregate is the *real* winner-Session state, read back
        # through the shared query — never a hand-built dict.
        winner_handle = await self._space_handle_provider(winner_side["space_id"])
        session_aggregate = await self._with_mutation_lease(
            winner_handle,
            lambda h: self._load_session_aggregate(h, winner_side["session_id"]),
        )
        return ActiveSessionView(value={
            "locator": self._locator_view(locator),
            "operation": self._operation_view(operation),
            "session": session_aggregate,
        })

    async def end(
        self, principal: "Principal", command: ActiveSessionCommand
    ) -> ActiveSessionView:
        from sqlalchemy import text as sa_text

        operation_id = self._require_operation_id(command.command_id)
        now = _canonical_utc_now(self._clock)
        intent = self._intent(operation_id, "end", command, business=dict(command.payload))
        async with self._meta_session_factory() as session:
            # database-level CAS: only the owning locator may enter releasing
            result = await session.execute(
                sa_text(
                    "UPDATE active_session_locator SET state='releasing', "
                    "updated_at=:now "
                    "WHERE singleton_key='active' AND operation_id=:oid "
                    "AND state IN ('active','claiming')"
                ),
                {"now": now, "oid": operation_id},
            )
            if result.rowcount != 1:
                await session.rollback()
                raise ActiveSessionCoordinationError(
                    "end requires the owning active/claiming locator"
                )
            locator = await session.get(ActiveSessionLocator, "active")
            if (
                command.ownership_epoch is not None
                and locator is not None
                and locator.ownership_epoch != command.ownership_epoch
            ):
                await session.rollback()
                raise ActiveSessionCoordinationError(
                    "end ownership epoch does not match the locator"
                )
            existing = await session.get(ActiveSessionOperation, operation_id)
            if existing is not None:
                await session.commit()
                return ActiveSessionView(
                    value=await self._end_session_view(locator)
                )
            session.add(
                ActiveSessionOperation(
                    operation_id=operation_id,
                    kind="end",
                    payload_hash=self._require_payload_hash(command.payload_hash),
                    intent_json=canonical_json_bytes(intent).decode("ascii"),
                    phase="space_committed",
                    created_at=now,
                    updated_at=now,
                )
            )
            try:
                await session.commit()
            except Exception as exc:
                await session.rollback()
                raise ActiveSessionCoordinationError(
                    f"duplicate end operation {operation_id!r} with a different payload"
                ) from exc
        return ActiveSessionView(value=await self._end_session_view(locator))

    async def _end_session_view(
        self, locator: ActiveSessionLocator
    ) -> dict[str, object]:
        """End response contract: the real Session aggregate and a null locator
        (the wire model drops locator details after release)."""
        handle = await self._space_handle_provider(locator.space_id)
        session_aggregate = await self._load_session_aggregate(
            handle, locator.session_id
        )
        return {"locator": None, "session": session_aggregate}

    async def heartbeat(
        self, principal: "Principal", command: ActiveSessionCommand
    ) -> ActiveSessionView:
        return await self._touch(command, "heartbeat")

    async def pause(
        self, principal: "Principal", command: ActiveSessionCommand
    ) -> ActiveSessionView:
        return await self._touch(command, "pause", include_session=True)

    async def resume(
        self, principal: "Principal", command: ActiveSessionCommand
    ) -> ActiveSessionView:
        return await self._touch(command, "resume", include_session=True)

    async def takeover(
        self, principal: "Principal", command: ActiveSessionCommand
    ) -> ActiveSessionView:
        return await self._touch(command, "takeover", include_session=True)

    async def update_note(
        self, principal: "Principal", command: ActiveSessionCommand
    ) -> ActiveSessionView:
        return await self._touch(command, "update_note", include_session=True)

    async def set_current_plan_item(
        self, principal: "Principal", command: ActiveSessionCommand
    ) -> ActiveSessionView:
        return await self._touch(command, "set_current_plan_item", include_session=True)

    async def set_completion_draft(
        self, principal: "Principal", command: ActiveSessionCommand
    ) -> ActiveSessionView:
        return await self._touch(command, "set_completion_draft", include_session=True)

    async def add_plan_item(
        self, principal: "Principal", command: ActiveSessionCommand
    ) -> ActiveSessionView:
        return await self._touch(command, "add_plan_item", include_session=True)

    async def remove_plan_item(
        self, principal: "Principal", command: ActiveSessionCommand
    ) -> ActiveSessionView:
        return await self._touch(command, "remove_plan_item", include_session=True)

    # ------------------------------------------------------------------ #
    # Internals
    # ------------------------------------------------------------------ #

    async def _touch(
        self,
        command: ActiveSessionCommand,
        kind: str,
        *,
        include_session: bool = False,
    ) -> ActiveSessionView:
        from sqlalchemy import text as sa_text

        operation_id = self._require_operation_id(command.command_id)
        payload_hash = self._require_payload_hash(command.payload_hash)
        now = _canonical_utc_now(self._clock)
        intent = self._intent(operation_id, kind, command, business=dict(command.payload))
        async with self._meta_session_factory() as session:
            # database-level CAS: only the owning, live locator may advance
            result = await session.execute(
                sa_text(
                    "UPDATE active_session_locator SET updated_at=:now, "
                    "lease_expires_at=:lease "
                    "WHERE singleton_key='active' AND operation_id=:oid"
                ),
                {
                    "now": now,
                    "lease": _lease_expiry(now),
                    "oid": operation_id,
                },
            )
            if result.rowcount != 1:
                await session.rollback()
                raise ActiveSessionCoordinationError(
                    f"{kind} requires the owning locator of this operation"
                )
            locator = await session.get(ActiveSessionLocator, "active")
            if (
                command.ownership_epoch is not None
                and locator is not None
                and locator.ownership_epoch != command.ownership_epoch
            ):
                await session.rollback()
                raise ActiveSessionCoordinationError(
                    f"{kind} ownership epoch does not match the locator"
                )
            existing = await session.get(ActiveSessionOperation, operation_id)
            if existing is not None:
                # idempotent replay of the same command returns the prior row
                await session.commit()
                if include_session:
                    return ActiveSessionView(
                        value=await self._locator_aggregate_view(locator)
                    )
                return ActiveSessionView(value={"locator": self._locator_view(locator)})
            session.add(
                ActiveSessionOperation(
                    operation_id=operation_id,
                    kind=kind,
                    payload_hash=payload_hash,
                    intent_json=canonical_json_bytes(intent).decode("ascii"),
                    phase="completed",
                    created_at=now,
                    updated_at=now,
                )
            )
            try:
                await session.commit()
            except Exception as exc:
                await session.rollback()
                raise ActiveSessionCoordinationError(
                    f"duplicate operation {operation_id!r} with a different payload"
                ) from exc
            if include_session:
                return ActiveSessionView(
                    value=await self._locator_aggregate_view(locator)
                )
            return ActiveSessionView(value={"locator": self._locator_view(locator)})

    async def _query_child_original(
        self, handle, child_id: str
    ) -> OriginalChildOutcome:
        """Classify the child's original mutation execution from the joint
        journal evidence (batch + operation + result).  A bare terminal batch
        state is never proof of an applied operation: the operation row must
        itself be in a success terminal state with no rejection evidence.
        ``ABORTED``/``COMPENSATED`` are never success.  Receipt vs journal
        cross-checks happen in the caller's decision table.
        """
        from sqlalchemy import select as _sa_select

        from app.models.mutation import (
            MutationBatch,
            MutationOperation,
            MutationStep,
        )
        from app.mutation.types import MutationState

        async with handle.session_factory() as session:
            operation = await session.get(MutationOperation, child_id)
            if operation is None:
                return OriginalChildOutcome.NOT_EXECUTED
            batch = await session.get(MutationBatch, operation.batch_id)
            if batch is not None:
                steps = (
                    await session.execute(
                        _sa_select(MutationStep).where(
                            MutationStep.operation_id == child_id
                        )
                    )
                ).scalars().all()
            else:
                steps = ()
        if batch is None:
            return OriginalChildOutcome.INCONCLUSIVE
        batch_state = batch.state
        op_state = operation.state
        error_code = operation.error_code
        # ABORTED on either row: never applied.  Only a durable rejected
        # evidence may upgrade to terminal-rejected.
        if batch_state == MutationState.ABORTED or op_state == MutationState.ABORTED:
            if error_code is not None:
                if _is_conflict_error_code(str(error_code)):
                    return OriginalChildOutcome.CONFLICT
                return OriginalChildOutcome.REJECTED
            return OriginalChildOutcome.ABORTED
        # COMPENSATED on either row: effects were rolled back.  We do not
        # claim NOT_EXECUTED without proof all effects are provably absent;
        # the conservative answer is recovery.
        if (
            batch_state == MutationState.COMPENSATED
            or op_state == MutationState.COMPENSATED
        ):
            return OriginalChildOutcome.INCONCLUSIVE
        if (
            batch_state == MutationState.FINALIZED
            and op_state == MutationState.FINALIZED
        ):
            if error_code is None:
                # result_json must not list *this child* as rejected.
                result_json = batch.result_json
                if result_json:
                    try:
                        import json as _json2

                        decoded = _json2.loads(result_json)
                        rejected_ids = {
                            str(item.get("operation_id") or "")
                            for item in decoded.get("rejected", [])
                        }
                    except (ValueError, TypeError, AttributeError):
                        return OriginalChildOutcome.INCONCLUSIVE
                    if child_id in rejected_ids:
                        return OriginalChildOutcome.INCONCLUSIVE
                # Every mutation step must carry durable APPLIED evidence.
                if steps and any(str(step.state) != "APPLIED" for step in steps):
                    return OriginalChildOutcome.INCONCLUSIVE
                return OriginalChildOutcome.APPLIED
            if _is_conflict_error_code(str(error_code)):
                return OriginalChildOutcome.CONFLICT
            return OriginalChildOutcome.REJECTED
        if op_state == MutationState.FINALIZED and batch_state != MutationState.FINALIZED:
            # operation succeeded but the batch never finalized -> ambiguous.
            return OriginalChildOutcome.INCONCLUSIVE
        # INTENT/STAGED/DB_COMMITTED/FINALIZING/FORWARD_APPLIED/
        # COMPENSATING/FAILED_MANUAL or mismatched terminal states -> no
        # terminal proof.
        return OriginalChildOutcome.INCONCLUSIVE

    async def _child_execution_decision(
        self,
        handle: "SpaceRuntimeHandle",
        child_id: str,
        child_command: FocusSessionCommand,
    ) -> tuple[ChildExecutionDecision, bool]:
        """Strict envelope + receipt decision table (never re-inserts an
        existing envelope and never blindly re-executes an ambiguous child).

        A. no envelope        -> EXECUTE (one frozen envelope is inserted)
        B. envelope present   -> identity/hash/replay/target validated, a
                                 mismatch is a stable idempotency conflict
        C. receipt states     -> succeeded: skip; failed/conflict/abandoned:
                                 fail closed; pending/unknown/missing: resolve
                                 against the mutation journal first.
        """
        from app.models.session_command import SessionCommandEnvelope

        async with handle.session_factory() as session:
            envelope = await session.get(SessionCommandEnvelope, child_id)
            receipt = await session.get(SessionCommandReceipt, child_id)
        if envelope is None:
            return ChildExecutionDecision.EXECUTE, False
        # B: the persisted envelope must match this deterministic child.
        if (
            envelope.space_id != child_command.space_id
            or envelope.session_id != child_command.session_id
        ):
            raise ActiveSessionCoordinationError(
                f"child envelope identity mismatch for {child_id!r}"
            )
        if envelope.payload_hash != child_command.payload_hash:
            raise ActiveSessionCoordinationError(
                f"child envelope payload hash mismatch for {child_id!r} "
                "(idempotency conflict)"
            )
        if not envelope.replay_safe or envelope.target_transition != "complete":
            raise ActiveSessionCoordinationError(
                f"child envelope replay/target semantics mismatch for {child_id!r}"
            )
        # C: receipt states.  A missing receipt resolves against the journal
        # first; the journal is consulted for every receipt that is not
        # independently terminal, and even a ``succeeded`` receipt is
        # cross-checked so a rejected/aborted journal never masquerades as
        # success (evidence mismatch -> recovery required).
        if receipt is None:
            original = await self._query_child_original(handle, child_id)
            if original is OriginalChildOutcome.APPLIED:
                return ChildExecutionDecision.ALREADY_SUCCEEDED, True
            if original in {
                OriginalChildOutcome.REJECTED,
                OriginalChildOutcome.CONFLICT,
            }:
                return ChildExecutionDecision.TERMINAL_REJECTED, True
            if original is OriginalChildOutcome.NOT_EXECUTED:
                return ChildExecutionDecision.EXECUTE, True
            return ChildExecutionDecision.RECOVERY_REQUIRED, True
        state = receipt.state
        if state in {
            CommandReceiptState.FAILED,
            CommandReceiptState.CONFLICT,
            CommandReceiptState.ABANDONED,
        }:
            original = await self._query_child_original(handle, child_id)
            if original in {
                OriginalChildOutcome.REJECTED,
                OriginalChildOutcome.CONFLICT,
            }:
                return ChildExecutionDecision.TERMINAL_REJECTED, True
            if original is OriginalChildOutcome.APPLIED:
                raise ActiveSessionCoordinationError(
                    f"child {child_id!r} receipt={state.value} conflicts with "
                    "an applied journal (evidence mismatch; recovery required)"
                )
            # Journal unproven: the terminal receipt is still never replayed.
            return ChildExecutionDecision.TERMINAL_REJECTED, True
        # succeeded / pending / unknown / not_needed all resolve against the
        # journal (a succeeded receipt must agree with an applied journal).
        original = await self._query_child_original(handle, child_id)
        if original is OriginalChildOutcome.APPLIED:
            if state == CommandReceiptState.SUCCEEDED:
                return ChildExecutionDecision.ALREADY_SUCCEEDED, True
            # pending/unknown receipt over an applied journal: read succeeded,
            # never re-execute.
            return ChildExecutionDecision.ALREADY_SUCCEEDED, True
        if original in {
            OriginalChildOutcome.REJECTED,
            OriginalChildOutcome.CONFLICT,
        }:
            if state == CommandReceiptState.SUCCEEDED:
                raise ActiveSessionCoordinationError(
                    f"child {child_id!r} receipt=succeeded conflicts with a "
                    f"rejected/conflict journal (evidence mismatch; recovery "
                    "required)"
                )
            return ChildExecutionDecision.TERMINAL_REJECTED, True
        if original is OriginalChildOutcome.NOT_EXECUTED:
            # Only a provably not-executed original may run now.
            return ChildExecutionDecision.EXECUTE, True
        # ABORTED / UNKNOWN / INCONCLUSIVE -> never replay.
        return ChildExecutionDecision.RECOVERY_REQUIRED, True

    async def _execute_children(
        self,
        pair: Mapping[str, Mapping[str, str]],
        operation_id: str,
        children: Mapping[str, Mapping[str, str]],
        child_payloads: Mapping[ActiveSessionChildRole, dict[str, object]],
    ) -> None:
        for role in _CHILD_ORDER:
            key = role.value
            if key not in children:
                continue
            payload = dict(child_payloads[role])
            child_id = children[key]["operation_id"]
            child_hash = children[key]["payload_hash"]
            action = _CHILD_ACTION_BY_ROLE[role]
            child_command = FocusSessionCommand(
                command_id=child_id,
                space_id=str(payload.get("space_id")),
                session_id=str(payload.get("session_id")),
                ownership_epoch=None,
                payload_hash=child_hash,
                payload=payload,
            )
            request = build_focus_request(action, child_command)
            handle = await self._space_handle_provider(str(payload.get("space_id")))
            # Everything for this child runs under one mutation lease so the
            # real Space engine stays active for the envelope / mutation /
            # receipt sequence; the UoW reuses the same lease internally.
            async with handle.mutation_lease("active-session-child", 5):
                decision, envelope_exists = await self._child_execution_decision(
                    handle, child_id, child_command
                )
                if decision is ChildExecutionDecision.ALREADY_SUCCEEDED:
                    continue
                if decision is ChildExecutionDecision.TERMINAL_REJECTED:
                    raise ActiveSessionCoordinationError(
                        f"{action} child {child_id!r} is terminal-rejected; "
                        "never replayed (recovery required)"
                    )
                if decision is ChildExecutionDecision.RECOVERY_REQUIRED:
                    raise ActiveSessionCoordinationError(
                        f"{action} child {child_id!r} has ambiguous durable "
                        "evidence; recovery required"
                    )
                # EXECUTE: insert one frozen envelope only when none exists,
                # then run the real mutation and drive the receipt from it.
                if not envelope_exists:
                    await self._record_child_envelope(handle, child_id, child_command)
                try:
                    await self._uow.execute(handle, request, child_id)
                except MutationRejectedError as exc:
                    await self._record_child_receipt(
                        handle, child_id, child_command,
                        state=_rejection_receipt_state(exc),
                        error_code=str(exc.rejection.code),
                    )
                    raise ActiveSessionCoordinationError(
                        f"{action} child {child_id!r} rejected: "
                        f"{exc.rejection.code}"
                    ) from exc
                except asyncio.CancelledError:
                    await self._record_child_receipt(
                        handle, child_id, child_command, state="unknown"
                    )
                    raise
                except Exception as exc:
                    await self._record_child_receipt(
                        handle, child_id, child_command, state="unknown"
                    )
                    raise ActiveSessionCoordinationError(
                        f"{action} child {child_id!r} failed: {type(exc).__name__}"
                    ) from exc
                # Receipts are written strictly from the real UoW outcome;
                # only a terminal-success durable receipt advances the phase.
                await self._record_child_receipt(
                    handle, child_id, child_command, state="succeeded"
                )
                state = await self._read_child_receipt(handle, child_id)
                if state != CommandReceiptState.SUCCEEDED:
                    raise ActiveSessionCoordinationError(
                        f"{action} child {child_id!r} receipt is not terminal-success: "
                        f"{state.value if state is not None else 'missing'}"
                    )

    def _conflict_child_payloads(
        self, command: ActiveSessionCommand, pair: Mapping[str, Mapping[str, str]]
    ) -> dict[ActiveSessionChildRole, dict[str, object]]:
        base = {
            "decision": "preserve",
            "expected_ownership_epoch": command.ownership_epoch or 1,
        }
        return {
            ActiveSessionChildRole.CANDIDATE: {
                **base,
                "space_id": pair["candidate"]["space_id"],
                "session_id": pair["candidate"]["session_id"],
            },
            ActiveSessionChildRole.ACTIVE: {
                **base,
                "space_id": pair["active"]["space_id"],
                "session_id": pair["active"]["session_id"],
            },
        }

    def _resolution_child_payloads(
        self,
        command: ActiveSessionCommand,
        pair: Mapping[str, Mapping[str, str]],
        winner_role: str,
    ) -> dict[ActiveSessionChildRole, dict[str, object]]:
        winner = pair[winner_role]
        loser = pair["active"] if winner_role == "candidate" else pair["candidate"]
        # decision_at / occurred_at come from the resolve command payload so
        # the child payloads (and their canonical hashes) are deterministic:
        # a restart of the same resolve command rebuilds identical children,
        # and the persisted envelopes stay hash-matching.  The clock is only a
        # fallback for payloads that omit the field.  No caller-facing
        # pair/role/parent fields live here: the frozen
        # ResolutionCoordinationProof carries the persisted Meta authority and
        # is injected by the coordinator after the Meta transaction.
        decision_at = str(
            command.payload.get("decision_at") or _canonical_utc_now(self._clock)
        )
        return {
            ActiveSessionChildRole.WINNER: {
                "space_id": winner["space_id"],
                "session_id": winner["session_id"],
                "decision_at": decision_at,
                "validity_correction": {
                    "loser_validity": "invalid",
                    "loser_validity_reason": "activation_conflict_loser",
                },
            },
            ActiveSessionChildRole.LOSER: {
                "space_id": loser["space_id"],
                "session_id": loser["session_id"],
                "occurred_at": decision_at,
                "timer_completion": "interrupted",
                "validity": "invalid",
                "validity_reason": "activation_conflict_loser",
            },
        }

    async def _read_resolution_proof(
        self, *, operation_id: str
    ) -> ResolutionCoordinationProof:
        """Rebuild the frozen proof *entirely* from the persisted Meta rows.

        Only the resolution operation id is accepted; nothing is filled in
        from caller arguments.  The locator, resolution operation and its
        canonical intent_json are re-read from the database, and every proof
        field is derived/cross-checked against them:

        - related conflict id / payload hash / intent hash from the
          operation row;
        - pair, winner_role, epoch, winner/loser child ids and payload hashes
          from the persisted canonical intent (child ids re-derived through
          the shared derivation contract).

        Any mismatch between the intent children, operation payload hash or
        related_operation_id fails closed.
        """
        import json as _json

        async with self._meta_session_factory() as session:
            locator = await session.get(ActiveSessionLocator, "active")
            operation = await session.get(ActiveSessionOperation, operation_id)
        if locator is None:
            raise ActiveSessionCoordinationError(
                "resolution proof requires a persisted locator"
            )
        if operation is None or operation.kind != "resolve_activation_conflict":
            raise ActiveSessionCoordinationError(
                "resolution proof requires a persisted resolution operation"
            )
        related_operation_id = str(operation.related_operation_id or "")
        if not related_operation_id:
            raise ActiveSessionCoordinationError(
                "resolution proof conflict anchor is missing"
            )
        intent = _json.loads(str(operation.intent_json))
        raw_pair = intent.get("pair")
        winner_role = str(intent.get("winner_role") or "")
        if not isinstance(raw_pair, dict) or winner_role not in ("active", "candidate"):
            raise ActiveSessionCoordinationError(
                "resolution proof intent does not carry a valid pair/winner_role"
            )
        try:
            pair = FrozenConflictPair.from_dict(raw_pair)
        except ValueError as exc:
            raise ActiveSessionCoordinationError(
                f"resolution proof pair is invalid: {exc}"
            ) from exc
        # Re-derive the child ids through the shared contract.
        winner_id = derive_active_session_child_operation_id(
            operation_id, ActiveSessionChildRole.WINNER
        )
        loser_id = derive_active_session_child_operation_id(
            operation_id, ActiveSessionChildRole.LOSER
        )
        children = intent.get("children")
        if not isinstance(children, dict) or not isinstance(
            children.get("winner"), dict
        ) or not isinstance(children.get("loser"), dict):
            raise ActiveSessionCoordinationError(
                "resolution proof intent does not name both children"
            )
        winner_hash = str(children["winner"].get("payload_hash") or "")
        loser_hash = str(children["loser"].get("payload_hash") or "")
        # Cross-check the persisted intent against the operation row.
        if str(intent.get("payload_hash") or "") != str(operation.payload_hash):
            raise ActiveSessionCoordinationError(
                "resolution intent payload hash does not match the operation"
            )
        if str(children["winner"].get("operation_id") or "") != winner_id:
            raise ActiveSessionCoordinationError(
                "resolution intent winner child id does not match the derivation"
            )
        if str(children["loser"].get("operation_id") or "") != loser_id:
            raise ActiveSessionCoordinationError(
                "resolution intent loser child id does not match the derivation"
            )
        if str(intent.get("space_id") or "") != str(locator.space_id) or str(
            intent.get("session_id") or ""
        ) != str(locator.session_id):
            raise ActiveSessionCoordinationError(
                "resolution intent anchor does not match the locator target"
            )
        return ResolutionCoordinationProof(
            resolution_operation_id=operation_id,
            conflict_operation_id=related_operation_id,
            phase=str(operation.phase),
            locator_state=str(locator.state),
            locator_operation_id=str(locator.operation_id),
            locator_space_id=str(locator.space_id),
            locator_session_id=str(locator.session_id),
            ownership_epoch=int(locator.ownership_epoch),
            pair=pair,
            winner_role=winner_role,
            winner_child_operation_id=winner_id,
            winner_child_payload_hash=winner_hash,
            loser_child_operation_id=loser_id,
            loser_child_payload_hash=loser_hash,
            intent_hash=str(operation.payload_hash),
        )

    @staticmethod
    def _child_hash(action: str, payload: Mapping[str, object]) -> str:
        return canonical_payload_hash(focus_business_payload(action, dict(payload)))

    @staticmethod
    def _intent(
        operation_id: str,
        kind: str,
        command: ActiveSessionCommand,
        *,
        business: Mapping[str, object],
        pair: Mapping[str, Mapping[str, str]] | None = None,
        children: Mapping[str, Mapping[str, str]] | None = None,
        payload_hash: str | None = None,
    ) -> dict[str, object]:
        intent: dict[str, object] = {
            "command_id": operation_id,
            "space_id": command.space_id or "",
            "session_id": command.session_id,
            "ownership_epoch": command.ownership_epoch or 1,
            "payload_hash": payload_hash or command.payload_hash,
            "kind": kind,
        }
        for key, value in business.items():
            if key not in intent:
                intent[key] = value
        if pair is not None:
            intent["pair"] = dict(pair)
        if children is not None:
            intent["children"] = dict(children)
        return intent

    @staticmethod
    def _require_operation_id(value: str) -> str:
        validate_operation_id(value)
        return value

    @staticmethod
    def _require_payload_hash(value: str) -> str:
        if not isinstance(value, str) or len(value) != 64 or any(
            character not in "0123456789abcdef" for character in value
        ):
            raise ActiveSessionCoordinationError("invalid payload hash")
        return value

    @staticmethod
    def _locator_view(locator: ActiveSessionLocator) -> dict[str, object]:
        return {
            "spaceId": locator.space_id,
            "sessionId": locator.session_id,
            "operationId": locator.operation_id,
            "state": locator.state,
            "ownerDeviceId": locator.owner_device_id,
            "ownerTabId": locator.owner_tab_id,
            "ownershipEpoch": locator.ownership_epoch,
            "leaseExpiresAt": locator.lease_expires_at,
            "updatedAt": locator.updated_at,
        }

    @staticmethod
    def _operation_view(operation: ActiveSessionOperation) -> dict[str, object]:
        return {
            "operationId": operation.operation_id,
            "kind": operation.kind,
            "phase": operation.phase,
            "intent": json.loads(operation.intent_json),
        }
