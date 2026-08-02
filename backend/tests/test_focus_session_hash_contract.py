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

    @pytest.mark.parametrize("filename", FILES_TO_CHECK)
    def test_focus_modules_import_contract_types_only_from_contracts_module(
        self, filename: str,
    ) -> None:
        """All present focus modules must source shared types from contracts."""
        path = _module_path(filename)
        if not path.exists():
            pytest.skip(f"{filename} does not exist yet (later TS2 task)")
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
            payload={**raw.payload, "expected_version": 1},
        )
        cmd_b = FocusSessionCommand(
            command_id="cmd-a",
            space_id="space-a",
            session_id="fs-1",
            ownership_epoch=1,
            payload_hash=canonical_payload_hash(business),
            payload={**raw.payload, "expected_version": 2},
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

    def test_invalid_hash_precedes_version_and_request_construction(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Invalid hashes must precede CAS validation and request construction."""
        import app.focus_session.commands as focus_commands

        base = start_command(declared="0" * 64)
        command = FocusSessionCommand(
            command_id=base.command_id,
            space_id=base.space_id,
            session_id=base.session_id,
            ownership_epoch=base.ownership_epoch,
            payload_hash=base.payload_hash,
            payload={**base.payload, "expected_version": "malformed"},
        )
        calls: list[str] = []

        def forbidden(*args: object, **kwargs: object) -> None:
            calls.append("collaborator")

        monkeypatch.setattr(
            focus_commands,
            "validate_expected_version",
            forbidden,
        )
        monkeypatch.setattr(
            focus_commands.MutationRequest,
            "from_payload",
            classmethod(forbidden),
        )

        with pytest.raises(InvalidPayloadHashError):
            focus_commands.build_focus_request("start", command)
        assert calls == []

    def test_conflicting_operation_is_rejected(self) -> None:
        from app.focus_session.commands import build_focus_request, focus_business_payload

        base = start_command(declared="0" * 64)
        payload = {**base.payload, "operation": "pause"}
        command = FocusSessionCommand(
            command_id=base.command_id,
            space_id=base.space_id,
            session_id=base.session_id,
            ownership_epoch=base.ownership_epoch,
            payload_hash=canonical_payload_hash(
                focus_business_payload("start", payload)
            ),
            payload=payload,
        )
        with pytest.raises(ValueError, match="operation"):
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

    @pytest.mark.parametrize(
        ("action", "payload", "expected"),
        (
            ("start", {
                "level2_work_item_id": "l2-a",
                "level3_work_item_ids": ["l3-a"],
                "planned_seconds": 1500,
                "started_at": "2026-07-15T08:00:00Z",
                "owner_device_id": "device-a",
                "owner_tab_id": "tab-a",
                "expected_work_item_versions": {"l2-a": 4},
            }, "959b3a935a0b2cce0a3d51890baab71ee72bc1474d787699ef82690634180d92"),
            ("pause", {
                "occurred_at": "2026-07-15T09:00:00Z",
                "owner_device_id": "device-a",
                "owner_tab_id": "tab-a",
                "expected_version": 1,
            }, "780dee7ec8bd36aa6f523d1e712d351b660de1a893585d0799e5188f0c21bfc3"),
            ("resume", {
                "resumed_at": "2026-07-15T09:15:00Z",
                "owner_device_id": "device-a",
                "owner_tab_id": "tab-a",
                "expected_version": 1,
            }, "3b4b819dd6a329d127dadf852ad0fcf0faa4df1e2c26346725d4ba6aa442f7bf"),
            ("end", {
                "ended_at": "2026-07-15T10:00:00Z",
                "completion": "completed",
                "owner_device_id": "device-a",
                "owner_tab_id": "tab-a",
                "expected_version": 1,
            }, "873b3d823b50534becc3d55e016ae70cf7b55b4ff5e6f4ac2da55fb3f18cb0bc"),
            ("update_note", {
                "note": "focus",
                "updated_at": "2026-07-15T10:01:00Z",
                "expected_version": 1,
            }, "6b3d9dc7ed710d4886fb6d0941716a698bb5d9397acc2cd065c230329ef0c8d1"),
            ("set_current_plan_item", {
                "plan_item_id": "plan-1",
                "selected_at": "2026-07-15T10:02:00Z",
                "expected_plan_version": 3,
            }, "08b122c875ac02984136adcc4e0abdbc053674119e0aab480efb2a6ca5324446"),
            ("set_completion_draft", {
                "plan_item_id": "plan-1",
                "completion_draft": {
                    "result": "completed",
                    "state_command": "complete",
                },
                "expected_plan_version": 3,
            }, "77be832e22bb03470720828c0d1992e89423545e8da6b439593eaed26516f533"),
            ("add_plan_item", {
                "work_item_id": "l3-b",
                "title_snapshot": "Second",
                "added_at": "2026-07-15T10:03:00Z",
                "expected_plan_version": 3,
            }, "e9aa191b8717920aa1e5c954164ea5bf91599d190e728d896073129a8dc3e5fd"),
            ("remove_plan_item", {
                "plan_item_id": "plan-1",
                "removed_at": "2026-07-15T10:04:00Z",
                "removal_reason": "done",
                "expected_plan_version": 3,
            }, "9811fc11d2e53d5455ef57974a8b557e4ee3f2bc7284ace13455ecada89d7150"),
            ("submit_review", {
                "validity": "valid",
                "review_state": "completed",
                "reviewed_at": "2026-07-15T10:05:00Z",
                "outcomes": [{
                    "work_item_id": "l3-a",
                    "touched": True,
                    "result": "completed",
                    "state_command": "complete",
                    "expected_work_item_version": 5,
                }],
                "expected_version": 2,
            }, "d7cb5d4b219bd54f325b40b8b863b580f08a98a1cbc7239af242a49334f95d37"),
            ("reconcile_commands", {
                "command_ids": ["cmd-1", "cmd-2"],
                "replay_safe": True,
                "abandon_command_ids": ["cmd-2"],
                "decision_at": "2026-07-15T10:06:00Z",
            }, "f265b59fd14fa9c7c8e2e8eb1be8a8d4eb453396754b5f19b1e775be31fdd23b"),
            ("correct_attribution", {
                "work_item_id": "l3-a",
                "attribution": "manual",
                "corrected_at": "2026-07-15T10:07:00Z",
                "expected_source_work_item_version": 4,
            }, "eea3a40d066f063892880ce4e94dd03336f0b755099b3ce1f9e9a5cd440438af"),
            ("activate_provisional", {
                "cached_at": "2026-07-15T10:08:00Z",
                "cached_ownership_epoch": 2,
                "owner_device_id": "device-a",
                "owner_tab_id": "tab-a",
                "snapshot": {
                    "session": {"session_revision": 1, "validity": "pending"},
                    "context": {"level2_work_item_id": "l2-a"},
                    "plan": [{"id": "plan-1", "work_item_id": "l3-a"}],
                },
                "expected_work_item_versions": {"l2-a": 4},
            }, "a8ec2e0d5e21a6fa1a3fe25a9bf6cfea2b740fda9b4978f4522d6ada379080e5"),
            ("mark_activation_conflict", {
                "conflict_pair": {
                    "active_session_id": "fs-1",
                    "candidate_session_id": "fs-2",
                },
                "detected_at": "2026-07-15T10:09:00Z",
                "expected_ownership_epoch": 7,
            }, "84a4eff54825fc3f7bb963dc49a5371b3d1efd44bb26382e06ce34cb51fd4b76"),
            ("resolve_activation_conflict", {
                "winner_role": "active",
                "decision_at": "2026-07-15T10:10:00Z",
                "validity_correction": {
                    "loser_validity": "invalid",
                    "loser_validity_reason": "activation_conflict_loser",
                },
            }, "6dcaa8b4555bbf791e3f1bd6ad7b10961ab2f0bdbf0aa8473aaafc2d24d31b51"),
            ("claim_owner", {
                "owner_device_id": "device-a",
                "owner_tab_id": "tab-a",
                "claimed_at": "2026-07-15T10:11:00Z",
                "expected_ownership_epoch": 7,
            }, "103ed869ca027574ea589b7018da2ab812f4be305fc2aeb33e8444d184f00cfb"),
            ("record_receipt", {
                "receipt_id": "receipt-1",
                "state": "succeeded",
                "recorded_at": "2026-07-15T10:12:00Z",
                "expected_version": 1,
            }, "b98ab30caa32fa3a5d923732c965181c1055c4f11063037e59ca0fd8d972fcc6"),
            ("rebuild_effort_projection", {
                "projection_revision": 2,
                "rebuilt_at": "2026-07-15T10:13:00Z",
                "expected_version": 1,
            }, "59a3654548ce021dc554bb3b5cd0dfc7c031a4c6ee8b070a3769f00624d928a9"),
        ),
    )
    def test_action_hash_matches_fixed_golden_vector(
        self, action: str, payload: dict[str, object], expected: str,
    ) -> None:
        from app.focus_session.commands import focus_business_payload

        assert canonical_payload_hash(focus_business_payload(action, payload)) == expected

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
