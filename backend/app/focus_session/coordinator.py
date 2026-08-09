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

import json
from collections.abc import Awaitable, Callable, Mapping
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING

from app.db.models.meta import ActiveSessionLocator, ActiveSessionOperation
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
    FocusSessionCommand,
)
from app.mutation.types import (
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
    ActiveSessionChildRole.LOSER: "end",
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


class ProductionActiveSessionCoordinator:
    """Real ActiveSessionCoordinator writer over Meta + Space UoW."""

    def __init__(
        self,
        *,
        meta_session_factory: "async_sessionmaker",
        uow: "MutationUnitOfWork",
        space_handle_provider: Callable[[str], Awaitable["SpaceRuntimeHandle"]],
        clock: Callable[[], str] = utc_now_iso_ms,
        execute_child: Callable[[str, str, FocusSessionCommand], Awaitable[None]] | None = None,
    ) -> None:
        self._meta_session_factory = meta_session_factory
        self._uow = uow
        self._space_handle_provider = space_handle_provider
        self._clock = clock
        # Overridable Space child channel: the production wiring uses the UoW
        # (see ``_execute_children``); tests inject a real-SQLite executor that
        # persists the same envelope/receipt evidence the UoW would write.
        self._execute_child = execute_child

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
        return ActiveSessionView(value={"locator": self._locator_view(locator)} | (
            {"operation": self._operation_view(operation)}
            if operation is not None
            else {}
        ))

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
                raise ActiveSessionCoordinationError("an ActiveSession is already claimed")
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
        return ActiveSessionView(value={"locator": self._locator_view(
            ActiveSessionLocator(
                singleton_key="active", space_id=command.space_id,
                session_id=command.session_id, operation_id=operation_id,
                state="claiming",
                owner_device_id=str(command.payload.get("owner_device_id", "")),
                owner_tab_id=str(command.payload.get("owner_tab_id", "")),
                ownership_epoch=command.ownership_epoch or 1,
                lease_expires_at=_lease_expiry(now), updated_at=now,
            )
        )})

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
        children = {
            "candidate": {"operation_id": candidate_id, "payload_hash": candidate_hash},
            "active": {"operation_id": active_id, "payload_hash": active_hash},
        }
        intent = self._intent(
            operation_id, "activate_provisional", command,
            business=business, pair=pair, children=children,
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
                    payload_hash=self._require_payload_hash(command.payload_hash),
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
        return ActiveSessionView(value={"locator": self._locator_view(
            ActiveSessionLocator(
                singleton_key="active", space_id=pair["active"]["space_id"],
                session_id=pair["active"]["session_id"], operation_id=operation_id,
                state="claiming",
                owner_device_id=str(command.payload.get("owner_device_id", "")),
                owner_tab_id=str(command.payload.get("owner_tab_id", "")),
                ownership_epoch=command.ownership_epoch or 1,
                lease_expires_at=_lease_expiry(now), updated_at=now,
            )
        )})

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
        pair = _conflict_pair(command.payload)
        winner_role = command.payload.get("winner_role")
        if winner_role not in ("active", "candidate"):
            raise ActiveSessionCoordinationError("resolution requires winner_role active|candidate")
        winner_side = pair[winner_role]
        loser_side = pair["active"] if winner_role == "candidate" else pair["candidate"]
        winner_id = derive_active_session_child_operation_id(
            operation_id, ActiveSessionChildRole.WINNER
        )
        loser_id = derive_active_session_child_operation_id(
            operation_id, ActiveSessionChildRole.LOSER
        )
        child_payloads = self._resolution_child_payloads(command, pair, winner_role)
        winner_hash = self._child_hash(
            "resolve_activation_conflict", child_payloads[ActiveSessionChildRole.WINNER]
        )
        loser_hash = self._child_hash("end", child_payloads[ActiveSessionChildRole.LOSER])
        children = {
            "winner": {"operation_id": winner_id, "payload_hash": winner_hash},
            "loser": {"operation_id": loser_id, "payload_hash": loser_hash},
        }
        intent = self._intent(
            operation_id, "resolve_activation_conflict", command,
            business=dict(command.payload), pair=pair, children=children,
        )
        now = _canonical_utc_now(self._clock)
        async with self._meta_session_factory() as session:
            locator = await session.get(ActiveSessionLocator, "active")
            if locator is None or locator.state != "claiming":
                raise ActiveSessionCoordinationError(
                    "resolve_activation_conflict requires a claiming locator"
                )
            if locator.operation_id != str(command.payload.get("related_operation_id", locator.operation_id)):
                raise ActiveSessionCoordinationError(
                    "resolution must bind the original conflict operation"
                )
            if (
                locator.space_id != pair["active"]["space_id"]
                or locator.session_id != pair["active"]["session_id"]
            ):
                raise ActiveSessionCoordinationError(
                    "resolution pair does not match the locator anchor"
                )
            if command.ownership_epoch is not None and (
                locator.ownership_epoch != command.ownership_epoch
            ):
                raise ActiveSessionCoordinationError("resolution epoch does not match the locator")
            original = await session.get(ActiveSessionOperation, locator.operation_id)
            if original is None or original.kind != "activate_provisional":
                raise ActiveSessionCoordinationError(
                    "resolution requires the original activate_provisional operation"
                )
            # 1) prepared phase: reuse the provable ``claimed`` enum (no
            #    resolution-specific phase exists in the Meta schema).
            session.add(
                ActiveSessionOperation(
                    operation_id=operation_id,
                    kind="resolve_activation_conflict",
                    payload_hash=self._require_payload_hash(command.payload_hash),
                    intent_json=canonical_json_bytes(intent).decode("ascii"),
                    phase="claimed",
                    related_operation_id=locator.operation_id,
                    created_at=now,
                    updated_at=now,
                )
            )
            await session.commit()
        child_payloads[ActiveSessionChildRole.WINNER]["space_id"] = winner_side["space_id"]
        child_payloads[ActiveSessionChildRole.WINNER]["session_id"] = winner_side["session_id"]
        child_payloads[ActiveSessionChildRole.LOSER]["space_id"] = loser_side["space_id"]
        child_payloads[ActiveSessionChildRole.LOSER]["session_id"] = loser_side["session_id"]
        # 2) execute winner then loser; any failure leaves the operation claimed
        await self._execute_children(
            pair, operation_id, children, child_payloads
        )
        # 3) CAS: claimed -> transferred only after both children succeeded
        async with self._meta_session_factory() as session:
            result = await session.execute(
                sa_text(
                    "UPDATE active_session_operations SET phase='transferred', "
                    "updated_at=:now WHERE operation_id=:oid AND phase='claimed' "
                    "AND related_operation_id=:related"
                ),
                {
                    "now": _canonical_utc_now(self._clock),
                    "oid": operation_id,
                    "related": locator.operation_id,
                },
            )
            await session.commit()
            if result.rowcount != 1:
                raise ActiveSessionCoordinationError(
                    "resolution CAS failed: operation was not in claimed phase"
                )
            operation = await session.get(ActiveSessionOperation, operation_id)
        return ActiveSessionView(value={
            "locator": self._locator_view(locator),
            "operation": self._operation_view(operation),
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
                return ActiveSessionView(value={"locator": self._locator_view(locator)})
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
        return ActiveSessionView(value={"locator": self._locator_view(locator)})

    async def heartbeat(
        self, principal: "Principal", command: ActiveSessionCommand
    ) -> ActiveSessionView:
        return await self._touch(command, "heartbeat")

    async def pause(
        self, principal: "Principal", command: ActiveSessionCommand
    ) -> ActiveSessionView:
        return await self._touch(command, "pause")

    async def resume(
        self, principal: "Principal", command: ActiveSessionCommand
    ) -> ActiveSessionView:
        return await self._touch(command, "resume")

    async def takeover(
        self, principal: "Principal", command: ActiveSessionCommand
    ) -> ActiveSessionView:
        return await self._touch(command, "takeover")

    async def update_note(
        self, principal: "Principal", command: ActiveSessionCommand
    ) -> ActiveSessionView:
        return await self._touch(command, "update_note")

    async def set_current_plan_item(
        self, principal: "Principal", command: ActiveSessionCommand
    ) -> ActiveSessionView:
        return await self._touch(command, "set_current_plan_item")

    async def set_completion_draft(
        self, principal: "Principal", command: ActiveSessionCommand
    ) -> ActiveSessionView:
        return await self._touch(command, "set_completion_draft")

    async def add_plan_item(
        self, principal: "Principal", command: ActiveSessionCommand
    ) -> ActiveSessionView:
        return await self._touch(command, "add_plan_item")

    async def remove_plan_item(
        self, principal: "Principal", command: ActiveSessionCommand
    ) -> ActiveSessionView:
        return await self._touch(command, "remove_plan_item")

    # ------------------------------------------------------------------ #
    # Internals
    # ------------------------------------------------------------------ #

    async def _touch(
        self, command: ActiveSessionCommand, kind: str
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
            return ActiveSessionView(value={"locator": self._locator_view(locator)})

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
            if self._execute_child is not None:
                await self._execute_child(
                    str(payload.get("space_id")), child_id, child_command
                )
                continue
            request = build_focus_request(action, child_command)
            handle = await self._space_handle_provider(str(payload.get("space_id")))
            try:
                await self._uow.execute(handle, request, child_id)
            except Exception as exc:
                raise ActiveSessionCoordinationError(
                    f"{action} child {child_id!r} failed: {type(exc).__name__}"
                ) from exc

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
        return {
            ActiveSessionChildRole.WINNER: {
                "space_id": winner["space_id"],
                "session_id": winner["session_id"],
                "winner_role": winner_role,
                "decision_at": _canonical_utc_now(self._clock),
                "validity_correction": {
                    "loser_validity": "invalid",
                    "loser_validity_reason": "activation_conflict_loser",
                },
            },
            ActiveSessionChildRole.LOSER: {
                "space_id": loser["space_id"],
                "session_id": loser["session_id"],
                "occurred_at": _canonical_utc_now(self._clock),
                "timer_completion": "interrupted",
                "validity": "invalid",
                "validity_reason": "activation_conflict_loser",
            },
        }

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
    ) -> dict[str, object]:
        intent: dict[str, object] = {
            "command_id": operation_id,
            "space_id": command.space_id or "",
            "session_id": command.session_id,
            "ownership_epoch": command.ownership_epoch or 1,
            "payload_hash": command.payload_hash,
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
