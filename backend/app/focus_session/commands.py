"""TS2 Task 1: Generic focus command boundary and payload-hash guard.

This module bridges TS0 ``FocusSessionCommand`` contracts and the S3 mutation
authority.  Caller-declared payload hashes cover only business data, while S3
internal request identities cover the full command envelope.
"""

from __future__ import annotations

from collections.abc import Mapping

from app.focus_session.contracts import FocusSessionCommand
from app.mutation.types import (
    MutationRequest,
    bounded_child_operation_id,
    canonical_payload_hash,
    require_payload_hash,
    validate_canonical_timestamp,
    validate_expected_version,
    validate_operation_id,
)

ACTIONS = frozenset({
    "start", "pause", "resume", "end", "update_note", "submit_review",
    "reconcile_commands",
    "correct_attribution", "set_current_plan_item",
    "set_completion_draft", "add_plan_item", "remove_plan_item",
    "activate_provisional", "mark_activation_conflict",
    "resolve_activation_conflict", "resolve_conflict_loser",
    "claim_owner", "record_receipt", "rebuild_effort_projection",
})


def _without(mapping: Mapping[str, object], *keys: str) -> dict[str, object]:
    excluded = frozenset(keys)
    return {key: value for key, value in mapping.items() if key not in excluded}


HASH_GUARD_FIELDS = (
    "operation",
    "expected_version",
    "expected_work_item_versions",
    "expected_work_item_version",
    "expected_plan_version",
    "expected_plan_versions",
    "expected_source_work_item_version",
    "ownership_epoch",
    "expected_ownership_epoch",
    "cached_ownership_epoch",
)
RECEIPT_RESERVATION_STATES = (
    "not_needed", "pending", "succeeded", "failed", "conflict", "unknown",
)


def focus_business_payload(
    action: str, payload: Mapping[str, object],
) -> Mapping[str, object]:
    if action not in ACTIONS:
        raise ValueError(f"unsupported FocusSession action: {action}")
    payload = _without(payload, *HASH_GUARD_FIELDS)
    if action == "submit_review":
        cleaned = dict(payload)
        outcomes = cleaned.get("outcomes", ())
        if not isinstance(outcomes, (tuple, list)):
            return cleaned
        cleaned["outcomes"] = tuple(
            _without(item, "expected_work_item_version")
            if isinstance(item, Mapping) else item
            for item in outcomes
        )
        return cleaned
    return dict(payload)


def active_business_payload(
    action: str, payload: Mapping[str, object],
) -> Mapping[str, object]:
    if action in {
        "start", "pause", "resume", "end", "update_note",
        "set_current_plan_item", "set_completion_draft", "add_plan_item",
        "remove_plan_item", "activate_provisional",
    }:
        return focus_business_payload(action, payload)
    if action in {"heartbeat", "takeover", "resolve_activation_conflict"}:
        return _without(payload, *HASH_GUARD_FIELDS)
    raise ValueError(f"unsupported active Session action: {action}")


def build_focus_request(
    action: str, command: FocusSessionCommand,
) -> MutationRequest:
    business = focus_business_payload(action, command.payload)
    require_payload_hash(command.payload_hash, business)
    declared_operation = command.payload.get("operation")
    if declared_operation is not None and declared_operation != action:
        raise ValueError("payload operation must match action")
    expected_version = command.payload.get("expected_version")
    validate_expected_version(expected_version)
    return MutationRequest.from_payload(
        name=f"focus_session.{action}",
        entity_type="focus_session",
        entity_id=command.session_id or command.command_id,
        payload={
            **dict(command.payload),
            "action": action,
            "command_id": command.command_id,
            "space_id": command.space_id,
            "session_id": command.session_id,
            "ownership_epoch": command.ownership_epoch,
            "payload_hash": command.payload_hash,
        },
        expected_version=expected_version,
        client_updated_at=None,
    )


def validate_reconcile_shape(command: FocusSessionCommand) -> None:
    if command.ownership_epoch is not None:
        raise ValueError("post-terminal reconciliation requires no owner epoch")
    command_ids = command.payload.get("command_ids", ())
    if not isinstance(command_ids, (tuple, list)) or not command_ids or any(
        not isinstance(item, str) or not item for item in command_ids
    ):
        raise ValueError("command_ids must be an ordered string collection")
    if not isinstance(command.payload.get("replay_safe"), bool):
        raise ValueError("replay_safe must be a boolean")
    abandon_ids = command.payload.get("abandon_command_ids", ())
    if not isinstance(abandon_ids, (tuple, list)) or any(
        not isinstance(item, str) or not item for item in abandon_ids
    ):
        raise ValueError("abandon_command_ids must be an ordered string collection")
    if len(set(command_ids)) != len(command_ids) or len(set(abandon_ids)) != len(abandon_ids):
        raise ValueError("reconciliation command IDs must be unique")
    if not set(abandon_ids) <= set(command_ids):
        raise ValueError("abandon_command_ids must be a command_ids subset")
    decision_at = command.payload.get("decision_at")
    if bool(abandon_ids) != (decision_at is not None):
        raise ValueError("decision_at is required exactly for abandonment")
    if decision_at is not None:
        try:
            validate_canonical_timestamp(decision_at)
        except ValueError as exc:
            raise ValueError("decision_at must be a canonical UTC timestamp") from exc
    validate_operation_id(command.command_id)
    for operation_id in (*command_ids, *abandon_ids):
        validate_operation_id(operation_id)
    reserved_receipt_ids = tuple(
        bounded_child_operation_id(envelope_id, f"receipt:{state}")
        for envelope_id in command_ids
        for state in RECEIPT_RESERVATION_STATES
    )
    root_scoped_receipt_ids = tuple(
        bounded_child_operation_id(
            command.command_id, f"receipt:{envelope_id}:{state}"
        )
        for envelope_id in command_ids
        for state in RECEIPT_RESERVATION_STATES
    )
    operation_namespace = (
        command.command_id, *command_ids, *reserved_receipt_ids,
        *root_scoped_receipt_ids,
    )
    if len(set(operation_namespace)) != len(operation_namespace):
        raise ValueError("reconciliation operation namespace collision")


def build_server_focus_command(
    *, command_id: str, space_id: str, session_id: str,
    ownership_epoch: int | None, action: str,
    payload: Mapping[str, object],
) -> FocusSessionCommand:
    internal_payload = {**dict(payload), "operation": action}
    business = focus_business_payload(action, internal_payload)
    return FocusSessionCommand(
        command_id=command_id,
        space_id=space_id,
        session_id=session_id,
        ownership_epoch=ownership_epoch,
        payload_hash=canonical_payload_hash(business),
        payload=internal_payload,
    )
