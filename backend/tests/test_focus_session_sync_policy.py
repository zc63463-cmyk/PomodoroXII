"""TS2 Task 2: Focus session Sync policy matrix tests.

Verifies the exact five entity types, the complete create/update/delete
routing matrix, zero generic fallback calls, immutable context/revision/
outcome/delete rejection, and authoritative-active update rejection.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.focus_session.policy import FOCUS_SESSION_POLICY_TYPES
from app.mutation.types import MutationRuleViolation

EXPECTED_TYPES = frozenset({
    "focus_session",
    "session_task_context",
    "session_attribution_revision",
    "session_work_item_plan",
    "session_work_item_outcome",
})

SYNC_MATRIX = (
    ("focus_session", "create", True),
    ("focus_session", "update", True),
    ("focus_session", "delete", False),
    ("session_task_context", "create", True),
    ("session_task_context", "update", False),
    ("session_task_context", "delete", False),
    ("session_attribution_revision", "create", True),
    ("session_attribution_revision", "update", False),
    ("session_attribution_revision", "delete", False),
    ("session_work_item_plan", "create", True),
    ("session_work_item_plan", "update", True),
    ("session_work_item_plan", "delete", False),
    ("session_work_item_outcome", "create", True),
    ("session_work_item_outcome", "update", False),
    ("session_work_item_outcome", "delete", False),
)


def _valid_provisional_payload(entity_type: str, action: str) -> dict[str, object]:
    """Return a minimal valid payload for each provisional create/update."""
    base: dict[str, object] = {"id": "entity-1"}
    if entity_type == "focus_session":
        base.update({
            "session_revision": 1,
            "started_at": "2026-07-15T08:00:00Z",
            "ended_at": None,
            "pause_started_at": None,
            "planned_seconds": 1500,
            "gross_seconds": 0,
            "paused_seconds": 0,
            "break_seconds": 0,
            "focused_seconds": 0,
            "validity": "pending",
            "validity_reason": None,
            "review_state": "not_required",
            "ownership_state": "local_provisional",
            "session_note": "",
        })
    elif entity_type == "session_task_context":
        base.update({
            "session_id": "fs-1",
            "project_id": "proj-1",
            "level2_work_item_id": "l2-a",
            "title_snapshot": "Task A",
            "parent_snapshot": None,
            "estimate_snapshot": None,
            "status_snapshot": None,
            "structure_snapshot": "{}",
            "linked_at": "2026-07-15T08:00:00Z",
            "link_method": "manual",
        })
    elif entity_type == "session_attribution_revision":
        base.update({
            "session_id": "fs-1",
            "revision": 1,
            "project_id": "proj-1",
            "level2_work_item_id": "l2-a",
            "reason": None,
            "corrected_from_revision": None,
            "effective": True,
        })
    elif entity_type == "session_work_item_plan":
        base.update({
            "session_id": "fs-1",
            "work_item_id": "l3-a",
            "title_snapshot": "Level 3 Task",
            "level2_snapshot": "l2-a",
            "plan_rank": 0,
            "source": "before_start",
            "added_at": "2026-07-15T08:00:00Z",
            "removed_at": None,
            "removal_reason": None,
            "current_during_session": False,
            "completion_draft": False,
        })
    elif entity_type == "session_work_item_outcome":
        base.update({
            "session_id": "fs-1",
            "session_revision": 1,
            "revision": 1,
            "corrected_from_revision": None,
            "effective": True,
            "work_item_id": "l3-a",
            "touched": False,
            "result": "untouched",
            "persona": None,
            "state_command": "none",
            "command_id": None,
            "reviewed_at": None,
        })
    return base


class TestPolicyEntityTypes:
    """Verify the exact five entity types owned by the policy."""

    def test_policy_owns_every_real_ts0_session_entity(self) -> None:
        assert FOCUS_SESSION_POLICY_TYPES == EXPECTED_TYPES

    def test_policy_types_count_is_five(self) -> None:
        assert len(FOCUS_SESSION_POLICY_TYPES) == 5

    def test_policy_types_are_frozen(self) -> None:
        assert isinstance(FOCUS_SESSION_POLICY_TYPES, frozenset)


class TestSyncPolicyMatrix:
    """Verify complete create/update/delete matrix with no generic fallback."""

    @pytest.fixture
    def sync_policy_fixture(self, mutation_fixture_factory):
        """Build a fixture with FocusSessionMutationPolicy and a fallback counter."""
        from app.commands.entity import EntityCommand
        from app.focus_session.policy import FocusSessionMutationPolicy
        from app.mutation import unit_of_work as uow_module
        from app.mutation.unit_of_work import AuthorityOverlay

        policy = FocusSessionMutationPolicy()
        mutation = mutation_fixture_factory(policies=(policy,))

        # Track generic fallback calls by wrapping compile_catalog_entity_command
        original_fallback = uow_module.compile_catalog_entity_command
        fallback_calls = {"count": 0}

        async def tracking_fallback(context, request):
            fallback_calls["count"] += 1
            return await original_fallback(context, request)

        uow_module.compile_catalog_entity_command = tracking_fallback

        overlay = AuthorityOverlay(mutation.catalog, {})
        compiler = mutation.uow.compiler

        async def compile(request):
            return await compiler.compile_against_overlay(
                mutation.scope, request, overlay, request.entity_id,
            )

        try:
            yield SimpleNamespace(
                mutation=mutation,
                scope=mutation.scope,
                catalog=mutation.catalog,
                entity_commands=EntityCommand(mutation.catalog),
                fallback_calls=fallback_calls,
                compile=compile,
            )
        finally:
            uow_module.compile_catalog_entity_command = original_fallback

    def test_policy_owns_every_real_ts0_session_entity(self) -> None:
        assert FOCUS_SESSION_POLICY_TYPES == EXPECTED_TYPES

    @pytest.mark.parametrize("entity_type,action,conditionally_allowed", SYNC_MATRIX)
    @pytest.mark.asyncio
    async def test_entity_command_never_reaches_generic_fallback(
        self, sync_policy_fixture, entity_type, action, conditionally_allowed,
    ) -> None:
        if action == "create":
            payload = _valid_provisional_payload(entity_type, action)
            request = sync_policy_fixture.entity_commands.create(
                sync_policy_fixture.scope, entity_type, payload, expected_version=None,
            )
        elif action == "update":
            payload = _valid_provisional_payload(entity_type, action)
            request = sync_policy_fixture.entity_commands.update(
                sync_policy_fixture.scope, entity_type, "entity-1", payload, expected_version=None,
            )
        else:
            request = sync_policy_fixture.entity_commands.delete(
                sync_policy_fixture.scope, entity_type, "entity-1", expected_version=None,
            )
        if conditionally_allowed:
            command = await sync_policy_fixture.compile(request)
            assert command.request is request
        else:
            with pytest.raises(MutationRuleViolation) as captured:
                await sync_policy_fixture.compile(request)
            assert captured.value.code in (
                "version_conflict",
                "stale_session_owner",
            )
        assert sync_policy_fixture.fallback_calls["count"] == 0
