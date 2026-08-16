"""Closed receipt coordination decoder and public result projector."""

from __future__ import annotations

import json
from collections.abc import Mapping

from app.focus_session.contracts import CommandReceiptState
from app.mutation.types import validate_operation_id

RECONCILE_COORDINATION_KEY = "_reconcileCoordination"
RECONCILE_COORDINATION_KINDS = frozenset({
    "replay_claimed",
    "replay_finished_unknown",
})


def decode_json_value_or_none(raw: str | None) -> object | None:
    return None if raw is None else json.loads(raw)


def decode_json_object_or_none(raw: str | None) -> Mapping[str, object] | None:
    value = decode_json_value_or_none(raw)
    if value is None:
        return None
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise ValueError("receipt result_json must be a JSON object")
    return value


def require_exact_string_mapping(value: object, keys: set[str]) -> Mapping[str, str]:
    if not isinstance(value, dict) or set(value) != keys or any(
        not isinstance(item, str) for item in value.values()
    ):
        raise ValueError("invalid reconciliation coordination projection")
    return value


def decode_reconcile_coordination(
    *, state: CommandReceiptState, result_json: str | None
) -> Mapping[str, str] | None:
    decoded = decode_json_value_or_none(result_json)
    nonterminal = state in {CommandReceiptState.PENDING, CommandReceiptState.UNKNOWN}
    if decoded is None:
        return None
    if not isinstance(decoded, dict) or RECONCILE_COORDINATION_KEY not in decoded:
        if nonterminal:
            raise ValueError("nonterminal receipt result must be reconciliation coordination")
        return None
    if not nonterminal:
        raise ValueError("terminal receipt cannot carry reconciliation coordination")
    if set(decoded) != {RECONCILE_COORDINATION_KEY}:
        raise ValueError("coordination result_json cannot mix public result fields")
    value = require_exact_string_mapping(
        decoded[RECONCILE_COORDINATION_KEY], {"kind", "rootCommandId"}
    )
    if value["kind"] not in RECONCILE_COORDINATION_KINDS:
        raise ValueError("unknown reconciliation coordination kind")
    validate_operation_id(value["rootCommandId"])
    return value


def public_receipt_result(*, state: CommandReceiptState, result_json: str | None) -> object | None:
    coordination = decode_reconcile_coordination(state=state, result_json=result_json)
    if coordination is not None or state in {
        CommandReceiptState.PENDING,
        CommandReceiptState.UNKNOWN,
    }:
        return None
    return decode_json_value_or_none(result_json)


def receipt_view(row: object) -> Mapping[str, object]:
    state = CommandReceiptState(str(row.state))
    return {
        "commandId": row.command_id,
        "state": state.value,
        "errorCode": row.error_code,
        "retryable": row.retryable,
        "details": decode_json_value_or_none(row.details_json),
        "result": public_receipt_result(state=state, result_json=row.result_json),
        "updatedAt": row.updated_at,
    }
