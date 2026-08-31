from types import SimpleNamespace
from typing import get_type_hints

import pytest

from app.auth.authority import Principal
from app.errors import MUTATION_REJECTION_SPECS, RESERVED_TS_CODES
from app.focus_session.contracts import (
    ActiveSessionCoordinator,
    CommandReceiptState,
    FocusSessionModule,
    ReviewState,
)
from app.focus_session.receipts import (
    RECONCILE_COORDINATION_KEY,
    decode_reconcile_coordination,
    public_receipt_result,
    receipt_view,
)
from app.runtime.space import SpaceRuntimeHandle


def test_focus_session_interfaces_are_explicit() -> None:
    assert {
        name
        for name, value in FocusSessionModule.__dict__.items()
        if callable(value) and not name.startswith("_")
    } == {
        "get",
        "start",
        "pause",
        "resume",
        "end",
        "update_note",
        "set_current_plan_item",
        "set_completion_draft",
        "add_plan_item",
        "remove_plan_item",
        "submit_review",
        "reconcile_commands",
    }
    assert {
        name
        for name, value in ActiveSessionCoordinator.__dict__.items()
        if callable(value) and not name.startswith("_")
    } == {
        "locate",
        "start",
        "activate_provisional",
        "heartbeat",
        "pause",
        "resume",
        "takeover",
        "end",
        "update_note",
        "set_current_plan_item",
        "set_completion_draft",
        "add_plan_item",
        "remove_plan_item",
        "resolve_activation_conflict",
    }


def test_focus_session_protocol_receives_space_runtime_handle() -> None:
    for method in (
        FocusSessionModule.get,
        FocusSessionModule.start,
        FocusSessionModule.pause,
        FocusSessionModule.resume,
        FocusSessionModule.end,
        FocusSessionModule.update_note,
        FocusSessionModule.set_current_plan_item,
        FocusSessionModule.set_completion_draft,
        FocusSessionModule.add_plan_item,
        FocusSessionModule.remove_plan_item,
        FocusSessionModule.submit_review,
        FocusSessionModule.reconcile_commands,
    ):
        hints = get_type_hints(
            method,
            globalns={
                **method.__globals__,
                "SpaceRuntimeHandle": SpaceRuntimeHandle,
            },
        )
        assert hints["scope"] is SpaceRuntimeHandle


def test_active_session_coordinator_uses_principal_not_space_scope() -> None:
    for method_name in (
        "locate",
        "start",
        "activate_provisional",
        "heartbeat",
        "pause",
        "resume",
        "takeover",
        "end",
        "update_note",
        "set_current_plan_item",
        "set_completion_draft",
        "add_plan_item",
        "remove_plan_item",
        "resolve_activation_conflict",
    ):
        method = getattr(ActiveSessionCoordinator, method_name)
        hints = get_type_hints(
            method,
            globalns={**method.__globals__, "Principal": Principal},
        )
        assert hints["principal"] is Principal
        assert "scope" not in hints


def test_review_and_receipt_sets_are_closed() -> None:
    assert {item.value for item in ReviewState} == {
        "not_required",
        "pending",
        "completed",
        "skipped",
    }
    assert {item.value for item in CommandReceiptState} == {
        "not_needed",
        "pending",
        "succeeded",
        "failed",
        "conflict",
        "unknown",
        "abandoned",
    }


def test_ts0_error_codes_are_exact() -> None:
    assert RESERVED_TS_CODES == {
        "space_scope_mismatch",
        "version_conflict",
        "idempotency_conflict",
        "invalid_payload_hash",
        "invalid_project_key",
        "project_key_conflict",
        "unsupported_content_version",
        "invalid_note_document",
        "invalid_work_item_tree",
        "active_child_conflict",
        "active_session_exists",
        "stale_session_owner",
        "session_activation_conflict",
        "offline_formal_creation_forbidden",
        "command_result_unknown",
        "active_session_recovery_required",
        "work_item_structure_changed",
        "label_name_conflict",
    }
    assert RESERVED_TS_CODES <= set(MUTATION_REJECTION_SPECS)


def test_pending_receipt_coordination_is_private_and_terminal_result_is_public() -> None:
    raw = {
        RECONCILE_COORDINATION_KEY: {
            "kind": "replay_claimed",
            "rootCommandId": "root-command",
        }
    }
    decoded = decode_reconcile_coordination(
        state=CommandReceiptState.PENDING,
        result_json='{"_reconcileCoordination":{"kind":"replay_claimed","rootCommandId":"root-command"}}',
    )
    assert decoded == raw[RECONCILE_COORDINATION_KEY]
    assert (
        public_receipt_result(
            state=CommandReceiptState.PENDING,
            result_json='{"_reconcileCoordination":{"kind":"replay_claimed","rootCommandId":"root-command"}}',
        )
        is None
    )
    assert public_receipt_result(
        state=CommandReceiptState.SUCCEEDED,
        result_json='{"result":"ok"}',
    ) == {"result": "ok"}


def test_receipt_projector_rejects_malformed_coordination() -> None:
    with pytest.raises(ValueError, match="coordination"):
        decode_reconcile_coordination(
            state=CommandReceiptState.PENDING,
            result_json='{"result":"mixed"}',
        )

    row = SimpleNamespace(
        command_id="root-command",
        state=CommandReceiptState.PENDING,
        error_code=None,
        retryable=False,
        details_json=None,
        result_json='{"_reconcileCoordination":{"kind":"replay_claimed","rootCommandId":"root-command"}}',
        updated_at="2026-07-27T00:00:00.000Z",
    )
    assert receipt_view(row)["result"] is None
