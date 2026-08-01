"""TS2 Task 2: Focus session Sync policy matrix tests.

Verifies the exact five entity types, the complete create/update/delete
routing matrix, zero generic fallback calls, immutable context/revision/
outcome/delete rejection, and authoritative-active update rejection.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.errors import MutationRejectedError
from app.focus_session.policy import FOCUS_SESSION_POLICY_TYPES
from app.mutation.types import MutationRequest, MutationRuleViolation

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


def _provisional_session_row(
    *,
    session_id: str = "fs-1",
    updated_at: str = "2026-07-15T08:00:00Z",
    pause_started_at: str | None = None,
    ended_at: str | None = None,
) -> dict[str, object]:
    row = _valid_provisional_payload("focus_session", "create")
    row.update({
        "id": session_id,
        "created_at": "2026-07-15T08:00:00Z",
        "updated_at": updated_at,
        "version": 1,
        "pause_started_at": pause_started_at,
        "ended_at": ended_at,
        "timer_completion": None,
        "overall_progress": None,
        "mood": None,
    })
    return row


def _sync_event(entity_id: str, payload: dict[str, object], timestamp: str) -> SimpleNamespace:
    return SimpleNamespace(
        entity_type="focusSession",
        entity_id=entity_id,
        action="update",
        payload=payload,
        expected_version=1,
        client_updated_at=timestamp,
    )


def _activation_request(
    *,
    session: dict[str, object] | None = None,
    plan: list[dict[str, object]] | None = None,
    expected_versions: dict[str, int] | None = None,
) -> MutationRequest:
    raw_session = {
        "id": "ignored-wire-id",
        "session_revision": 1,
        "started_at": "2026-07-15T08:00:00Z",
        "ended_at": None,
        "pause_started_at": None,
        "planned_seconds": 1500,
        "gross_seconds": 600,
        "paused_seconds": 0,
        "break_seconds": 0,
        "focused_seconds": 600,
        "timer_completion": None,
        "validity": "pending",
        "validity_reason": None,
        "overall_progress": None,
        "mood": None,
        "session_note": "",
        "ownership_state": "local_provisional",
    }
    if session:
        raw_session.update(session)
    raw_plan = plan or [{
        "id": "plan-fs-import-l3-a",
        "work_item_id": "l3-a",
        "work_item_version_snapshot": 1,
        "title_snapshot": "Level 3",
        "level2_work_item_id_snapshot": "l2-a",
        "plan_rank": 0,
        "source": "before_start",
        "added_at": "2026-07-15T08:00:00Z",
        "removed_at": None,
        "removal_reason": None,
        "current_during_session": True,
        "completion_draft": False,
    }]
    raw_context = {
        "project_id": "proj-1",
        "project_title_snapshot": "Project 1",
        "level2_work_item_id": "l2-a",
        "level2_version_snapshot": 1,
        "level2_title_snapshot": "Level 2",
        "level2_parent_id_snapshot": "root",
        "level2_status_definition_id_snapshot": None,
        "linked_at": "2026-07-15T08:00:00Z",
        "link_method": "offline_activation",
    }
    return MutationRequest.from_payload(
        name="focus_session.activate_provisional",
        entity_type="focus_session",
        entity_id="fs-import",
        payload={
            "space_id": "space-test",
            "cached_at": "2026-07-15T08:10:00Z",
            "owner_device_id": "device-a",
            "owner_tab_id": "tab-a",
            "ownership_epoch": 1,
            "expected_work_item_versions": expected_versions or {"l2-a": 1, "l3-a": 1},
            "snapshot": {"session": raw_session, "context": raw_context, "plan": raw_plan},
        },
        expected_version=None,
    )


def _activation_rows() -> dict[tuple[str, str], dict[str, object]]:
    return {
        ("project", "proj-1"): {"id": "proj-1", "title": "Project 1", "version": 1},
        ("work_item", "root"): {
            "id": "root", "project_id": "proj-1", "parent_id": None,
            "title": "Root", "version": 1, "completed_at": None, "cancelled_at": None,
            "status_definition_id": None,
        },
        ("work_item", "l2-a"): {
            "id": "l2-a", "project_id": "proj-1", "parent_id": "root",
            "title": "Level 2", "version": 1, "completed_at": None, "cancelled_at": None,
            "status_definition_id": None,
        },
        ("work_item", "l3-a"): {
            "id": "l3-a", "project_id": "proj-1", "parent_id": "l2-a",
            "title": "Level 3", "version": 1, "completed_at": None, "cancelled_at": None,
            "status_definition_id": None,
        },
    }


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

        def locator_reader(_scope, request):
            payload = request.payload
            return {
                "state": "claiming",
                "space_id": payload.get("space_id", "space-test"),
                "session_id": payload.get("session_id", request.entity_id),
                "operation_id": payload.get("command_id", request.entity_id),
                "owner_device_id": payload.get("owner_device_id"),
                "owner_tab_id": payload.get("owner_tab_id"),
                "ownership_epoch": payload.get("ownership_epoch"),
            }

        policy = FocusSessionMutationPolicy(locator_reader=locator_reader)
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
                policy=policy,
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
            try:
                command = await sync_policy_fixture.compile(request)
            except MutationRuleViolation as captured:
                # An allowed matrix branch still requires its authoritative
                # provisional parent/row; this empty overlay intentionally
                # exercises the fail-closed path without generic fallback.
                assert captured.code in {"not_found", "version_conflict", "stale_session_owner"}
            else:
                assert command.request is request
        else:
            with pytest.raises(MutationRuleViolation) as captured:
                await sync_policy_fixture.compile(request)
            assert captured.value.code == "work_item_structure_changed"
        assert sync_policy_fixture.fallback_calls["count"] == 0

    @pytest.mark.asyncio
    async def test_sync_update_missing_authority_row_is_not_found(
        self, sync_policy_fixture,
    ) -> None:
        """Sync cannot synthesize an update image for a missing Session row."""
        request = sync_policy_fixture.entity_commands.update(
            sync_policy_fixture.scope,
            "focus_session",
            "missing-session",
            _valid_provisional_payload("focus_session", "update"),
            expected_version=1,
        )
        with pytest.raises(MutationRuleViolation) as captured:
            await sync_policy_fixture.compile(request)
        assert captured.value.code == "not_found"

    @pytest.mark.asyncio
    async def test_start_requires_a_matching_locator_claim(
        self, sync_policy_fixture,
    ) -> None:
        request = MutationRequest.from_payload(
            name="focus_session.start",
            entity_type="focus_session",
            entity_id="missing-session",
            payload={
                "space_id": "space-test",
                "session_id": "missing-session",
                "started_at": "2026-07-15T08:00:00Z",
                "planned_seconds": 1500,
                "level2_work_item_id": "l2-a",
                "level3_work_item_ids": (),
                "ownership_epoch": 1,
                "command_id": "different-operation",
            },
            expected_version=None,
        )
        with pytest.raises(MutationRuleViolation) as captured:
            await sync_policy_fixture.compile(request)
        assert captured.value.code == "stale_session_owner"

    def test_policy_requires_locator_reader(self) -> None:
        from app.focus_session.policy import FocusSessionMutationPolicy

        with pytest.raises(TypeError, match="locator_reader is required"):
            FocusSessionMutationPolicy(None)

    @pytest.mark.asyncio
    async def test_sync_focus_update_allows_only_non_clock_provisional_fields(
        self, sync_policy_fixture,
    ) -> None:
        from app.mutation.unit_of_work import AuthorityOverlay

        current = _provisional_session_row()
        event = _sync_event(
            "fs-1",
            {"id": "fs-1", "session_note": "offline note", "updated_at": "2026-07-15T08:10:00Z"},
            "2026-07-15T08:10:00Z",
        )
        request = sync_policy_fixture.entity_commands.from_sync_event(
            sync_policy_fixture.scope, event,
        )
        overlay = AuthorityOverlay(
            sync_policy_fixture.catalog, {("focus_session", "fs-1"): current},
        )
        command = await sync_policy_fixture.mutation.uow.compiler.compile_against_overlay(
            sync_policy_fixture.scope, request, overlay, "fs-1",
        )
        after = command.db_plans[0].after_row
        assert after["session_note"] == "offline note"
        assert after["version"] == 2
        assert after["updated_at"] == "2026-07-15T08:10:00Z"

    @pytest.mark.asyncio
    async def test_sync_focus_update_uses_derived_pause_counters(
        self, sync_policy_fixture,
    ) -> None:
        from app.mutation.unit_of_work import AuthorityOverlay

        current = _provisional_session_row()
        event = _sync_event(
            "fs-1",
            {
                **current,
                "pause_started_at": "2026-07-15T08:10:00Z",
                "gross_seconds": 600,
                "focused_seconds": 600,
                "updated_at": "2026-07-15T08:10:00Z",
            },
            "2026-07-15T08:10:00Z",
        )
        request = sync_policy_fixture.entity_commands.from_sync_event(
            sync_policy_fixture.scope, event,
        )
        overlay = AuthorityOverlay(
            sync_policy_fixture.catalog, {("focus_session", "fs-1"): current},
        )
        command = await sync_policy_fixture.mutation.uow.compiler.compile_against_overlay(
            sync_policy_fixture.scope, request, overlay, "fs-1",
        )
        after = command.db_plans[0].after_row
        assert after["pause_started_at"] == "2026-07-15T08:10:00Z"
        assert after["gross_seconds"] == 600
        assert after["focused_seconds"] == 600
        assert after["paused_seconds"] == 0

    @pytest.mark.asyncio
    async def test_sync_focus_update_rejects_direct_clock_counter_forgery(
        self, sync_policy_fixture,
    ) -> None:
        from app.mutation.unit_of_work import AuthorityOverlay

        current = _provisional_session_row()
        event = _sync_event(
            "fs-1",
            {"id": "fs-1", "gross_seconds": 1, "updated_at": "2026-07-15T08:10:00Z"},
            "2026-07-15T08:10:00Z",
        )
        request = sync_policy_fixture.entity_commands.from_sync_event(
            sync_policy_fixture.scope, event,
        )
        overlay = AuthorityOverlay(
            sync_policy_fixture.catalog, {("focus_session", "fs-1"): current},
        )
        with pytest.raises(MutationRuleViolation) as captured:
            await sync_policy_fixture.mutation.uow.compiler.compile_against_overlay(
                sync_policy_fixture.scope, request, overlay, "fs-1",
            )
        assert captured.value.code == "work_item_structure_changed"
        assert captured.value.details["reason"] == "clock_counter_direct_update"

    @pytest.mark.asyncio
    async def test_sync_focus_update_rejects_fake_pause_post_image(
        self, sync_policy_fixture,
    ) -> None:
        from app.mutation.unit_of_work import AuthorityOverlay

        current = _provisional_session_row()
        event = _sync_event(
            "fs-1",
            {
                **current,
                "pause_started_at": "2026-07-15T08:10:00Z",
                "gross_seconds": 1,
                "focused_seconds": 1,
                "updated_at": "2026-07-15T08:10:00Z",
            },
            "2026-07-15T08:10:00Z",
        )
        request = sync_policy_fixture.entity_commands.from_sync_event(
            sync_policy_fixture.scope, event,
        )
        overlay = AuthorityOverlay(
            sync_policy_fixture.catalog, {("focus_session", "fs-1"): current},
        )
        with pytest.raises(MutationRuleViolation) as captured:
            await sync_policy_fixture.mutation.uow.compiler.compile_against_overlay(
                sync_policy_fixture.scope, request, overlay, "fs-1",
            )
        assert captured.value.details["reason"] == "clock_post_image_mismatch"

    @pytest.mark.asyncio
    async def test_activation_snapshot_rejects_stale_work_item_version(
        self, sync_policy_fixture,
    ) -> None:
        from app.mutation.unit_of_work import AuthorityOverlay

        request = _activation_request(
            plan=[{
                **_activation_request().payload["snapshot"]["plan"][0],
                "work_item_version_snapshot": 2,
            }],
            expected_versions={"l2-a": 1, "l3-a": 2},
        )
        overlay = AuthorityOverlay(sync_policy_fixture.catalog, _activation_rows())
        with pytest.raises(MutationRuleViolation) as captured:
            await sync_policy_fixture.mutation.uow.compiler.compile_against_overlay(
                sync_policy_fixture.scope, request, overlay, request.entity_id,
            )
        assert captured.value.code == "version_conflict"

    @pytest.mark.asyncio
    async def test_activation_snapshot_rejects_cross_parent_plan_item(
        self, sync_policy_fixture,
    ) -> None:
        from app.mutation.unit_of_work import AuthorityOverlay

        rows = _activation_rows()
        rows[("work_item", "l3-a")]["parent_id"] = "root"
        request = _activation_request()
        overlay = AuthorityOverlay(sync_policy_fixture.catalog, rows)
        with pytest.raises(MutationRuleViolation) as captured:
            await sync_policy_fixture.mutation.uow.compiler.compile_against_overlay(
                sync_policy_fixture.scope, request, overlay, request.entity_id,
            )
        assert captured.value.code == "invalid_work_item_tree"

    @pytest.mark.asyncio
    async def test_activation_snapshot_rejects_materialized_review_item(
        self, sync_policy_fixture,
    ) -> None:
        from app.mutation.unit_of_work import AuthorityOverlay

        rows = _activation_rows()
        rows[("work_item", "l3-a")]["completed_at"] = "2026-07-15T07:00:00Z"
        request = _activation_request()
        overlay = AuthorityOverlay(sync_policy_fixture.catalog, rows)
        with pytest.raises(MutationRuleViolation) as captured:
            await sync_policy_fixture.mutation.uow.compiler.compile_against_overlay(
                sync_policy_fixture.scope, request, overlay, request.entity_id,
            )
        assert captured.value.code == "version_conflict"

    @pytest.mark.asyncio
    async def test_terminal_activation_snapshot_is_rejected_before_locator_claim(
        self, sync_policy_fixture,
    ) -> None:
        from app.mutation.unit_of_work import AuthorityOverlay

        request = _activation_request(session={
            "ended_at": "2026-07-15T08:10:00Z",
            "timer_completion": "interrupted",
        })
        overlay = AuthorityOverlay(sync_policy_fixture.catalog, _activation_rows())
        with pytest.raises(MutationRuleViolation) as captured:
            await sync_policy_fixture.mutation.uow.compiler.compile_against_overlay(
                sync_policy_fixture.scope, request, overlay, request.entity_id,
            )
        assert captured.value.code == "work_item_structure_changed"
        assert captured.value.details["reason"] == "terminal_snapshot"

    @pytest.mark.asyncio
    async def test_activation_conflict_sync_update_has_no_db_or_outbox_effects(
        self, sync_policy_fixture,
    ) -> None:
        seed = _provisional_session_row(session_id="fs-conflict")
        seed["ownership_state"] = "activation_conflict"
        seed_request = sync_policy_fixture.entity_commands.create(
            sync_policy_fixture.scope, "focus_session", seed, expected_version=None,
        )
        await sync_policy_fixture.mutation.uow.execute(
            sync_policy_fixture.scope, seed_request, "seed-conflict",
        )
        before_events = await sync_policy_fixture.mutation.visible_events(
            operation_id="seed-conflict",
        )
        request = sync_policy_fixture.entity_commands.update(
            sync_policy_fixture.scope,
            "focus_session",
            "fs-conflict",
            {"session_note": "must be blocked"},
            expected_version=1,
        )
        with pytest.raises(MutationRejectedError) as captured:
            await sync_policy_fixture.mutation.uow.execute(
                sync_policy_fixture.scope, request, "blocked-conflict",
            )
        assert captured.value.rejection.code == "session_activation_conflict"
        after_events = await sync_policy_fixture.mutation.visible_events(
            operation_id="seed-conflict",
        )
        assert len(after_events) == len(before_events) == 1
        entity_type, rows = next(
            entry for entry in sync_policy_fixture.mutation.overlay_snapshot()[0]
            if entry[0] == "focus_session"
        )
        assert entity_type == "focus_session"
        row = next(db_row for db_row in rows if db_row[0] == "fs-conflict")
        assert row[-1] == "activation_conflict"
