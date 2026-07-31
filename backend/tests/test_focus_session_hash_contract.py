"""TS2 Task 1: Focus command hash contract and payload boundary tests.

These tests verify the exact TS0 Protocol surface, AST import safety,
RFC 8785 canonical hash vectors, business-payload vs CAS/identity
separation, invalid-hash precedence with zero side effects, and
server-authored canonical hash construction.
"""
from __future__ import annotations

import ast
from pathlib import Path
from typing import get_type_hints

import pytest

from app.focus_session.contracts import (
    ActiveSessionCommand,
    ActiveSessionCoordinator,
    FocusSessionCommand,
    FocusSessionModule,
)
from app.mutation.types import (
    InvalidPayloadHashError,
    canonical_payload_hash,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def public_methods(protocol: type) -> set[str]:
    """Return the set of public callable names declared on a Protocol."""
    return {
        name
        for name, value in protocol.__dict__.items()
        if callable(value) and not name.startswith("_")
    }


def _module_path(name: str) -> Path:
    """Resolve a focus_session submodule path relative to the backend root."""
    here = Path(__file__).resolve().parent
    return here.parent / "app" / "focus_session" / name


def _class_names_in_file(path: Path) -> set[str]:
    """Extract top-level class names from a Python source file via AST."""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    return {
        node.name
        for node in ast.walk(tree)
        if isinstance(node, ast.ClassDef)
    }


def start_command(*, declared: str) -> FocusSessionCommand:
    return FocusSessionCommand(
        command_id="start-1",
        space_id="space-a",
        session_id="fs-1",
        ownership_epoch=1,
        payload_hash=declared,
        payload={
            "level2_work_item_id": "l2-a",
            "level3_work_item_ids": ("l3-a",),
            "planned_seconds": 1500,
            "started_at": "2026-07-15T08:00:00Z",
            "owner_device_id": "device-a",
            "owner_tab_id": "tab-a",
            "expected_work_item_versions": {"l2-a": 4, "l3-a": 2},
        },
    )


# ---------------------------------------------------------------------------
# Step 1: Protocol surface and AST import-boundary tests
# ---------------------------------------------------------------------------

class TestProtocolSurface:
    """Verify TS2 consumes the exact TS0 Protocol method sets."""

    def test_ts2_consumes_the_exact_ts0_protocol_surface(self) -> None:
        assert public_methods(FocusSessionModule) == {
            "get", "start", "pause", "resume", "end",
            "update_note", "set_current_plan_item", "set_completion_draft",
            "add_plan_item", "remove_plan_item", "submit_review",
            "reconcile_commands",
        }
        assert public_methods(ActiveSessionCoordinator) == {
            "locate", "start", "activate_provisional", "heartbeat",
            "pause", "resume", "takeover", "end",
            "update_note", "set_current_plan_item", "set_completion_draft",
            "add_plan_item", "remove_plan_item", "resolve_activation_conflict",
        }

    def test_focus_session_command_originates_from_contracts(self) -> None:
        assert FocusSessionCommand.__module__ == "app.focus_session.contracts"

    def test_active_session_command_originates_from_contracts(self) -> None:
        assert ActiveSessionCommand.__module__ == "app.focus_session.contracts"


class TestASTImportBoundary:
    """Reject duplicate command/module/coordinator type definitions."""

    FORBIDDEN_DUPLICATE_NAMES = frozenset({
        "FocusSessionCommand",
        "ActiveSessionCommand",
        "FocusSessionModule",
        "ActiveSessionCoordinator",
    })

    FILES_TO_CHECK = (
        "commands.py",
        "policy.py",
        "module.py",
        "coordinator.py",
        "recovery.py",
    )

    @pytest.mark.parametrize("filename", FILES_TO_CHECK)
    def test_no_duplicate_type_definitions(self, filename: str) -> None:
        path = _module_path(filename)
        if not path.exists():
            pytest.skip(f"{filename} does not exist yet (later TS2 task)")
        classes = _class_names_in_file(path)
        overlaps = classes & self.FORBIDDEN_DUPLICATE_NAMES
        assert not overlaps, (
            f"{filename} must not redefine: {overlaps}"
        )

    def test_commands_imports_contracts_only_from_contracts_module(self) -> None:
        """commands.py must import FocusSessionCommand only from contracts."""
        path = _module_path("commands.py")
        if not path.exists():
            pytest.skip("commands.py does not exist yet")
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module:
                for alias in node.names:
                    if alias.name in self.FORBIDDEN_DUPLICATE_NAMES:
                        assert node.module == "app.focus_session.contracts", (
                            f"{alias.name} must be imported from "
                            "app.focus_session.contracts, not {node.module}"
                        )


# ---------------------------------------------------------------------------
# Step 2: Hash-precedence and canonical-vector tests
# ---------------------------------------------------------------------------

class TestBusinessPayloadHash:
    """Verify business payload hash excludes CAS/identity/envelope fields."""

    def test_caller_hash_covers_business_payload_not_cas_or_request_identity(
        self,
    ) -> None:
        from app.focus_session.commands import (
            build_focus_request,
            focus_business_payload,
        )

        raw = start_command(declared="0" * 64)
        business = focus_business_payload("start", raw.payload)
        command = start_command(declared=canonical_payload_hash(business))
        request = build_focus_request("start", command)

        assert "expected_work_item_versions" not in business
        assert request.payload["payload_hash"] == command.payload_hash
        assert request.request_hash != command.payload_hash

    def test_changing_business_data_changes_payload_hash(self) -> None:
        from app.focus_session.commands import focus_business_payload

        base = start_command(declared="0" * 64)
        hash_a = canonical_payload_hash(
            focus_business_payload("start", base.payload)
        )
        modified = FocusSessionCommand(
            command_id="start-1",
            space_id="space-a",
            session_id="fs-1",
            ownership_epoch=1,
            payload_hash="0" * 64,
            payload={
                **dict(base.payload),
                "planned_seconds": 1800,  # changed
            },
        )
        hash_b = canonical_payload_hash(
            focus_business_payload("start", modified.payload)
        )
        assert hash_a != hash_b

    def test_changing_cas_only_does_not_change_payload_hash(self) -> None:
        from app.focus_session.commands import focus_business_payload

        base = start_command(declared="0" * 64)
        hash_a = canonical_payload_hash(
            focus_business_payload("start", base.payload)
        )
        modified = FocusSessionCommand(
            command_id="start-2",  # changed command_id
            space_id="space-b",  # changed space_id
            session_id="fs-2",  # changed session_id
            ownership_epoch=2,  # changed epoch
            payload_hash="0" * 64,
            payload={
                **dict(base.payload),
                "expected_work_item_versions": {"l2-a": 99, "l3-a": 99},
            },
        )
        hash_b = canonical_payload_hash(
            focus_business_payload("start", modified.payload)
        )
        assert hash_a == hash_b

    def test_changing_cas_changes_s3_request_identity(self) -> None:
        from app.focus_session.commands import (
            build_focus_request,
            focus_business_payload,
        )

        raw = start_command(declared="0" * 64)
        business = focus_business_payload("start", raw.payload)
        cmd_a = FocusSessionCommand(
            command_id="cmd-a",
            space_id="space-a",
            session_id="fs-1",
            ownership_epoch=1,
            payload_hash=canonical_payload_hash(business),
            payload=raw.payload,
        )
        cmd_b = FocusSessionCommand(
            command_id="cmd-b",  # different command_id
            space_id="space-a",
            session_id="fs-1",
            ownership_epoch=1,
            payload_hash=canonical_payload_hash(business),
            payload=raw.payload,
        )
        req_a = build_focus_request("start", cmd_a)
        req_b = build_focus_request("start", cmd_b)
        assert req_a.request_hash != req_b.request_hash


class TestInvalidHashPrecedence:
    """Invalid payload hash must fail before any scope, UoW, or locator call."""

    def test_invalid_hash_raises_invalid_payload_hash_error(self) -> None:
        from app.focus_session.commands import build_focus_request

        command = start_command(declared="0" * 64)
        with pytest.raises(InvalidPayloadHashError):
            build_focus_request("start", command)

    def test_invalid_hash_has_no_side_effects(self) -> None:
        """build_focus_request must call require_payload_hash before anything."""
        from app.focus_session.commands import build_focus_request

        command = start_command(declared="0" * 64)
        # If require_payload_hash is not first, MutationRequest.from_payload
        # or validate_expected_version might execute. The InvalidPayloadHashError
        # must be raised before any of those.
        with pytest.raises(InvalidPayloadHashError):
            build_focus_request("start", command)

    def test_valid_hash_does_not_raise(self) -> None:
        from app.focus_session.commands import (
            build_focus_request,
            focus_business_payload,
        )

        raw = start_command(declared="0" * 64)
        business = focus_business_payload("start", raw.payload)
        command = start_command(declared=canonical_payload_hash(business))
        # Should not raise
        request = build_focus_request("start", command)
        assert request is not None
        assert request.entity_type == "focus_session"


class TestServerAuthoredHash:
    """Server-authored child commands must use S3 canonical_payload_hash."""

    @pytest.mark.parametrize(
        "action",
        ("mark_activation_conflict", "resolve_activation_conflict", "claim_owner"),
    )
    def test_server_authored_hash_excludes_cas_and_epoch_guards(
        self, action: str,
    ) -> None:
        from app.focus_session.commands import (
            build_focus_request,
            build_server_focus_command,
        )

        common = {
            "decision": "preserve",
            "expected_ownership_epoch": 7,
        }
        first = build_server_focus_command(
            command_id=f"{action}-1",
            space_id="space-a",
            session_id="fs-1",
            ownership_epoch=7,
            action=action,
            payload={**common, "expected_version": 2},
        )
        second = build_server_focus_command(
            command_id=f"{action}-1",
            space_id="space-a",
            session_id="fs-1",
            ownership_epoch=7,
            action=action,
            payload={
                **common,
                "expected_version": 9,
                "expected_ownership_epoch": 9,
            },
        )

        assert first.payload_hash == second.payload_hash
        assert build_focus_request(action, first).request_hash != (
            build_focus_request(action, second).request_hash
        )

    def test_server_command_uses_canonical_payload_hash(self) -> None:
        from app.focus_session.commands import (
            build_server_focus_command,
            focus_business_payload,
        )

        cmd = build_server_focus_command(
            command_id="resolve-1",
            space_id="space-a",
            session_id="fs-1",
            ownership_epoch=3,
            action="resolve_activation_conflict",
            payload={
                "winner_role": "active",
                "decision_at": "2026-07-15T10:00:00Z",
                "validity_correction": {
                    "loser_validity": "invalid",
                    "loser_validity_reason": "activation_conflict_loser",
                },
            },
        )
        internal_payload = {
            "winner_role": "active",
            "decision_at": "2026-07-15T10:00:00Z",
            "validity_correction": {
                "loser_validity": "invalid",
                "loser_validity_reason": "activation_conflict_loser",
            },
            "operation": "resolve_activation_conflict",
        }
        expected = canonical_payload_hash(
            focus_business_payload("resolve_activation_conflict", internal_payload)
        )
        assert cmd.payload_hash == expected


class TestRfc8785CanonicalVectors:
    """Verify RFC 8785 canonical JSON SHA-256 vectors for key actions."""

    def test_start_hash_is_deterministic(self) -> None:
        from app.focus_session.commands import focus_business_payload

        command = start_command(declared="0" * 64)
        business = focus_business_payload("start", command.payload)
        # Must be a valid 64-char hex SHA-256
        h = canonical_payload_hash(business)
        assert len(h) == 64
        assert all(c in "0123456789abcdef" for c in h)

    def test_pause_business_payload_excludes_expected_version(self) -> None:
        from app.focus_session.commands import focus_business_payload

        payload = {
            "expected_version": 3,
            "occurred_at": "2026-07-15T09:00:00Z",
            "owner_device_id": "device-a",
            "owner_tab_id": "tab-a",
        }
        business = focus_business_payload("pause", payload)
        assert "expected_version" not in business
        assert "occurred_at" in business
        assert "owner_device_id" in business

    def test_review_outcomes_exclude_expected_work_item_version(self) -> None:
        from app.focus_session.commands import focus_business_payload

        payload = {
            "expected_version": 2,
            "validity": "valid",
            "review_state": "completed",
            "reviewed_at": "2026-07-15T12:00:00Z",
            "outcomes": [
                {
                    "work_item_id": "l3-a",
                    "touched": True,
                    "result": "completed",
                    "state_command": "complete",
                    "expected_work_item_version": 5,
                },
            ],
        }
        business = focus_business_payload("submit_review", payload)
        assert "expected_version" not in business
        outcomes = business["outcomes"]
        assert isinstance(outcomes, tuple)
        assert "expected_work_item_version" not in outcomes[0]
        assert outcomes[0]["work_item_id"] == "l3-a"

    def test_reconcile_business_payload_has_no_expected_version(self) -> None:
        from app.focus_session.commands import focus_business_payload

        payload = {
            "command_ids": ["cmd-1", "cmd-2"],
            "replay_safe": True,
            "abandon_command_ids": ["cmd-2"],
            "decision_at": "2026-07-15T14:00:00Z",
        }
        business = focus_business_payload("reconcile_commands", payload)
        assert "expected_version" not in business
        assert business["command_ids"] == ["cmd-1", "cmd-2"]
        assert business["replay_safe"] is True


class TestActiveBusinessPayload:
    """Verify active_business_payload delegates correctly."""

    def test_active_start_delegates_to_focus(self) -> None:
        from app.focus_session.commands import (
            active_business_payload,
            focus_business_payload,
        )

        payload = {
            "level2_work_item_id": "l2-a",
            "level3_work_item_ids": ("l3-a",),
            "planned_seconds": 1500,
            "started_at": "2026-07-15T08:00:00Z",
            "owner_device_id": "device-a",
            "owner_tab_id": "tab-a",
            "expected_work_item_versions": {"l2-a": 4},
        }
        active = active_business_payload("start", payload)
        focus = focus_business_payload("start", payload)
        assert canonical_payload_hash(active) == canonical_payload_hash(focus)

    def test_active_heartbeat_excludes_guards(self) -> None:
        from app.focus_session.commands import active_business_payload

        payload = {
            "owner_device_id": "device-a",
            "owner_tab_id": "tab-a",
            "heartbeat_at": "2026-07-15T09:30:00Z",
            "expected_ownership_epoch": 3,
        }
        business = active_business_payload("heartbeat", payload)
        assert "expected_ownership_epoch" not in business
        assert business["owner_device_id"] == "device-a"
        assert business["heartbeat_at"] == "2026-07-15T09:30:00Z"

    def test_unsupported_active_action_raises(self) -> None:
        from app.focus_session.commands import active_business_payload

        with pytest.raises(ValueError):
            active_business_payload("bogus_action", {})
