"""TS2 Task 1: Focus session command policy tests.

These tests verify the action-set boundary, hash-guard field exclusion
policy, reconciliation shape validation, active-session delegation policy,
and server-authored canonical hash construction policy.
"""

from __future__ import annotations

import pytest

from app.focus_session.commands import (
    ACTIONS,
    HASH_GUARD_FIELDS,
    RECEIPT_RESERVATION_STATES,
    active_business_payload,
    build_focus_request,
    build_server_focus_command,
    focus_business_payload,
    validate_reconcile_shape,
)
from app.focus_session.contracts import FocusSessionCommand
from app.mutation.types import canonical_payload_hash

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _reconcile_command(
    *,
    command_id: str = "reconcile-1",
    session_id: str = "fs-1",
    ownership_epoch: int | None = None,
    command_ids: tuple[str, ...] = ("cmd-1", "cmd-2"),
    replay_safe: bool = True,
    abandon_command_ids: tuple[str, ...] = ("cmd-2",),
    decision_at: str | None = "2026-07-15T14:00:00Z",
) -> FocusSessionCommand:
    payload: dict[str, object] = {
        "command_ids": list(command_ids),
        "replay_safe": replay_safe,
        "abandon_command_ids": list(abandon_command_ids),
    }
    if decision_at is not None:
        payload["decision_at"] = decision_at
    business = focus_business_payload("reconcile_commands", payload)
    return FocusSessionCommand(
        command_id=command_id,
        space_id="space-a",
        session_id=session_id,
        ownership_epoch=ownership_epoch,
        payload_hash=canonical_payload_hash(business),
        payload=payload,
    )


# ---------------------------------------------------------------------------
# Action-set boundary
# ---------------------------------------------------------------------------

class TestActionSetBoundary:
    """Verify the closed action set matches TS0 protocol methods."""

    def test_focus_protocol_methods_are_subset_of_actions(self) -> None:
        focus_methods = {
            "start", "pause", "resume", "end", "update_note",
            "set_current_plan_item", "set_completion_draft",
            "add_plan_item", "remove_plan_item", "submit_review",
            "reconcile_commands",
        }
        assert focus_methods <= ACTIONS

    def test_server_authored_actions_are_in_actions(self) -> None:
        server_actions = {
            "mark_activation_conflict",
            "resolve_activation_conflict",
            "claim_owner",
        }
        assert server_actions <= ACTIONS

    def test_unsupported_focus_action_raises(self) -> None:
        with pytest.raises(ValueError, match="unsupported FocusSession action"):
            focus_business_payload("bogus", {})


# ---------------------------------------------------------------------------
# Hash-guard field policy
# ---------------------------------------------------------------------------

class TestHashGuardPolicy:
    """Verify CAS/authority/envelope fields are excluded from business hash."""

    def test_expected_version_is_guarded(self) -> None:
        assert "expected_version" in HASH_GUARD_FIELDS

    def test_expected_work_item_versions_is_guarded(self) -> None:
        assert "expected_work_item_versions" in HASH_GUARD_FIELDS

    def test_expected_work_item_version_is_guarded(self) -> None:
        assert "expected_work_item_version" in HASH_GUARD_FIELDS

    def test_expected_ownership_epoch_is_guarded(self) -> None:
        assert "expected_ownership_epoch" in HASH_GUARD_FIELDS

    def test_operation_is_guarded(self) -> None:
        assert "operation" in HASH_GUARD_FIELDS

    def test_ownership_epoch_is_guarded(self) -> None:
        assert "ownership_epoch" in HASH_GUARD_FIELDS

    def test_cached_ownership_epoch_is_guarded(self) -> None:
        assert "cached_ownership_epoch" in HASH_GUARD_FIELDS

    def test_plan_version_guards_are_present(self) -> None:
        assert "expected_plan_version" in HASH_GUARD_FIELDS
        assert "expected_plan_versions" in HASH_GUARD_FIELDS

    def test_guards_do_not_affect_business_hash(self) -> None:
        base = {"task": "write", "seconds": 1500}
        with_guards = {
            **base,
            "expected_version": 3,
            "expected_ownership_epoch": 1,
            "operation": "start",
        }
        hash_clean = canonical_payload_hash(
            focus_business_payload("start", base)
        )
        hash_guards = canonical_payload_hash(
            focus_business_payload("start", with_guards)
        )
        assert hash_clean == hash_guards


# ---------------------------------------------------------------------------
# Active-session delegation policy
# ---------------------------------------------------------------------------

class TestActiveDelegationPolicy:
    """Verify active_business_payload delegates correctly."""

    @pytest.mark.parametrize(
        "action",
        (
            "start", "pause", "resume", "end", "update_note",
            "set_current_plan_item", "set_completion_draft",
            "add_plan_item", "remove_plan_item", "activate_provisional",
        ),
    )
    def test_shared_actions_delegate_to_focus(self, action: str) -> None:
        payload = {"field": "value", "expected_version": 1}
        active = active_business_payload(action, payload)
        focus = focus_business_payload(action, payload)
        assert canonical_payload_hash(active) == canonical_payload_hash(focus)

    @pytest.mark.parametrize("action", ("heartbeat", "takeover"))
    def test_active_only_actions_strip_guards(self, action: str) -> None:
        payload = {
            "owner_device_id": "dev-1",
            "expected_ownership_epoch": 3,
            "expected_version": 2,
        }
        business = active_business_payload(action, payload)
        assert "expected_ownership_epoch" not in business
        assert "expected_version" not in business
        assert business["owner_device_id"] == "dev-1"

    def test_resolve_activation_conflict_strips_guards(self) -> None:
        payload = {
            "winner_role": "active",
            "decision_at": "2026-07-15T10:00:00Z",
            "expected_ownership_epoch": 5,
        }
        business = active_business_payload("resolve_activation_conflict", payload)
        assert "expected_ownership_epoch" not in business
        assert business["winner_role"] == "active"


# ---------------------------------------------------------------------------
# Server-authored command policy
# ---------------------------------------------------------------------------

class TestServerCommandPolicy:
    """Verify server-authored commands use S3 canonical_payload_hash."""

    def test_server_command_payload_includes_operation(self) -> None:
        cmd = build_server_focus_command(
            command_id="srv-1",
            space_id="space-a",
            session_id="fs-1",
            ownership_epoch=2,
            action="mark_activation_conflict",
            payload={"conflict_pair": ("fs-1", "fs-2")},
        )
        assert cmd.payload["operation"] == "mark_activation_conflict"

    def test_server_command_hash_matches_canonical(self) -> None:
        payload = {"decision": "preserve"}
        cmd = build_server_focus_command(
            command_id="srv-1",
            space_id="space-a",
            session_id="fs-1",
            ownership_epoch=None,
            action="claim_owner",
            payload=payload,
        )
        business = focus_business_payload("claim_owner", {**payload, "operation": "claim_owner"})
        assert cmd.payload_hash == canonical_payload_hash(business)

    def test_server_command_passes_hash_guard(self) -> None:
        cmd = build_server_focus_command(
            command_id="srv-1",
            space_id="space-a",
            session_id="fs-1",
            ownership_epoch=1,
            action="resolve_activation_conflict",
            payload={
                "winner_role": "active",
                "decision_at": "2026-07-15T10:00:00Z",
            },
        )
        request = build_focus_request("resolve_activation_conflict", cmd)
        assert request.entity_type == "focus_session"
        assert request.payload["payload_hash"] == cmd.payload_hash


# ---------------------------------------------------------------------------
# Reconciliation shape validation
# ---------------------------------------------------------------------------

class TestReconcileShapeValidation:
    """Verify validate_reconcile_shape enforces post-terminal invariants."""

    def test_valid_reconcile_with_abandonment_passes(self) -> None:
        command = _reconcile_command()
        validate_reconcile_shape(command)  # should not raise

    def test_valid_reconcile_without_abandonment_passes(self) -> None:
        command = _reconcile_command(
            abandon_command_ids=(),
            decision_at=None,
        )
        validate_reconcile_shape(command)

    def test_ownership_epoch_must_be_none(self) -> None:
        command = _reconcile_command(ownership_epoch=1)
        with pytest.raises(ValueError, match="owner epoch"):
            validate_reconcile_shape(command)

    def test_command_ids_must_be_strings(self) -> None:
        command = _reconcile_command(command_ids=("cmd-1", 123))  # type: ignore[arg-type]
        with pytest.raises(ValueError, match="command_ids"):
            validate_reconcile_shape(command)

    def test_replay_safe_must_be_boolean(self) -> None:
        command = _reconcile_command(replay_safe="yes")  # type: ignore[arg-type]
        with pytest.raises(ValueError, match="replay_safe"):
            validate_reconcile_shape(command)

    def test_abandon_ids_must_be_subset(self) -> None:
        command = _reconcile_command(
            command_ids=("cmd-1", "cmd-2"),
            abandon_command_ids=("cmd-3",),
        )
        with pytest.raises(ValueError, match="subset"):
            validate_reconcile_shape(command)

    def test_decision_at_required_for_abandonment(self) -> None:
        command = _reconcile_command(decision_at=None)
        with pytest.raises(ValueError, match="decision_at"):
            validate_reconcile_shape(command)

    def test_decision_at_must_not_appear_without_abandonment(self) -> None:
        command = _reconcile_command(
            abandon_command_ids=(),
            decision_at="2026-07-15T14:00:00Z",
        )
        with pytest.raises(ValueError, match="decision_at"):
            validate_reconcile_shape(command)

    def test_duplicate_command_ids_rejected(self) -> None:
        command = _reconcile_command(
            command_ids=("cmd-1", "cmd-1"),
            abandon_command_ids=("cmd-1",),
        )
        with pytest.raises(ValueError, match="unique"):
            validate_reconcile_shape(command)


# ---------------------------------------------------------------------------
# Receipt reservation states
# ---------------------------------------------------------------------------

class TestReceiptReservationStates:
    """Verify the receipt reservation state constant is closed."""

    def test_receipt_reservation_states_match_ts0_enum(self) -> None:
        assert set(RECEIPT_RESERVATION_STATES) == {
            "not_needed", "pending", "succeeded",
            "failed", "conflict", "unknown",
        }
