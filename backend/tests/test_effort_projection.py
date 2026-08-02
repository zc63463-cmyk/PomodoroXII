"""TS2 Task 3: Effort projection rebuild from focus session facts.

RED-phase tests for the effort projection compiler that recomputes
WorkItem.effort_actual_seconds from ended, valid, authoritative focus
sessions with effective attribution revisions.

The formula:
    SUM(focus_session.focused_seconds)
    WHERE ended_at IS NOT NULL
      AND validity = 'valid'
      AND ownership_state = 'authoritative'
      AND attribution revision is the sole effective revision
      AND effective level2_work_item_id = target WorkItem

These tests will FAIL until ``app.focus_session.effort_projection`` is
implemented and the ``rebuild_effort_projection`` policy handler is
extended to produce real WorkItem post-images.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.errors import IdempotencyConflictError, MutationRejectedError
from app.focus_session.commands import build_focus_request, focus_business_payload
from app.focus_session.contracts import FocusSessionCommand

# EffortProjectionCompiler does not exist yet -- this import will fail
# until the module is implemented.  That is the expected RED signal.
from app.focus_session.effort_projection import (
    EffortMismatch,
    EffortProjectionCompiler,
    EffortProjectionRepairService,
)
from app.focus_session.module import DefaultFocusSessionModule
from app.focus_session.policy import EffortProjectionRepairPolicy, FocusSessionMutationPolicy
from app.focus_session.query import FocusSessionQuery
from app.mutation.types import MutationRequest, MutationRuleViolation, canonical_payload_hash
from app.task_space.compiler import TaskSpaceCompiler

# ---------------------------------------------------------------------------
# Fixture
# ---------------------------------------------------------------------------

@pytest.fixture
def focus_fixture(mutation_fixture_factory):
    """Build a focus session fixture with FocusSessionMutationPolicy."""

    def locator_reader(_scope, request):
        payload = request.payload
        return {
            "state": "claiming",
            "space_id": payload.get("space_id", "space-test"),
            "session_id": payload.get("session_id", request.entity_id),
            "operation_id": payload.get("command_id"),
            "owner_device_id": payload.get("owner_device_id"),
            "owner_tab_id": payload.get("owner_tab_id"),
            "ownership_epoch": payload.get("ownership_epoch"),
        }

    policy = FocusSessionMutationPolicy(
        locator_reader=locator_reader,
        replay_safe_policy=TaskSpaceCompiler.replay_safe_policy(),
    )
    repair_policy = EffortProjectionRepairPolicy()
    mutation = mutation_fixture_factory(policies=(policy, repair_policy))
    module = DefaultFocusSessionModule(
        uow=mutation.uow,
        query=FocusSessionQuery(),
        reconciler=None,
    )
    return SimpleNamespace(
        mutation=mutation,
        module=module,
        scope=mutation.scope,
        uow=mutation.uow,
        repair_service=EffortProjectionRepairService(uow=mutation.uow),
    )


# ---------------------------------------------------------------------------
# Catalog seeding
# ---------------------------------------------------------------------------

async def _seed_catalog(
    fixture,
    *,
    project_id: str = "proj-1",
    l2_ids: tuple[str, ...] = ("l2-a", "l2-b"),
    l3_ids: tuple[str, ...] = ("l3-a",),
) -> None:
    """Pre-seed project, definitions, and work_item rows for authority reads."""
    from app.models.project import Project
    from app.models.work_item import WorkItem
    from app.models.work_item_definition import StatusDefinition, TypeDefinition

    async with fixture.scope.session_factory() as session:
        session.add(TypeDefinition(id="type-task", name="Task", rank=0))
        session.add(StatusDefinition(
            id="status-todo", name="To Do", category="not_started", rank=0,
        ))
        session.add(StatusDefinition(
            id="status-done", name="Done", category="completed", rank=1,
        ))
        session.add(StatusDefinition(
            id="status-cancelled", name="Cancelled", category="cancelled", rank=2,
        ))
        session.add(Project(
            id=project_id,
            key="TEST",
            name="Test Project",
            default_status_definition_id="status-todo",
            default_type_definition_id="type-task",
        ))
        for l2_id in l2_ids:
            session.add(WorkItem(
                id=l2_id,
                project_id=project_id,
                display_key=f"TEST-{l2_id}",
                title=f"Level 2 Item {l2_id}",
                type_definition_id="type-task",
                status_definition_id="status-todo",
                parent_id=None,
                version=1,
            ))
        for l3_id in l3_ids:
            session.add(WorkItem(
                id=l3_id,
                project_id=project_id,
                display_key=f"TEST-{l3_id}",
                title=f"Level 3 Item {l3_id}",
                type_definition_id="type-task",
                status_definition_id="status-todo",
                parent_id="l2-a",
                version=1,
            ))
        await session.commit()


# ---------------------------------------------------------------------------
# Session insertion helper (direct DB, for controlled state)
# ---------------------------------------------------------------------------

async def _insert_session(
    fixture,
    *,
    session_id: str,
    level2_work_item_id: str,
    project_id: str = "proj-1",
    started_at: str = "2026-07-15T08:00:00Z",
    ended_at: str | None = "2026-07-15T08:25:00Z",
    focused_seconds: int = 1500,
    validity: str = "valid",
    ownership_state: str = "authoritative",
    review_state: str = "completed",
    revision: int = 1,
    effective: bool = True,
    corrected_from_revision: int | None = None,
) -> None:
    """Insert a focus session and attribution revision directly into the DB."""
    from app.models.focus_session import FocusSession
    from app.models.session_revision import SessionAttributionRevision

    async with fixture.scope.session_factory() as session:
        session.add(FocusSession(
            id=session_id,
            session_revision=1,
            started_at=started_at,
            ended_at=ended_at,
            pause_started_at=None,
            planned_seconds=max(focused_seconds, 1),
            gross_seconds=focused_seconds,
            paused_seconds=0,
            break_seconds=0,
            focused_seconds=focused_seconds,
            timer_completion="completed" if ended_at else None,
            validity=validity,
            validity_reason=None,
            overall_progress=None,
            mood=None,
            session_note="",
            review_state=review_state,
            ownership_state=ownership_state,
            version=1,
            created_at=started_at,
            updated_at=ended_at or started_at,
        ))
        session.add(SessionAttributionRevision(
            id=f"attr-{session_id}-{revision}",
            session_id=session_id,
            revision=revision,
            project_id=project_id,
            level2_work_item_id=level2_work_item_id,
            reason=None,
            corrected_from_revision=corrected_from_revision,
            effective=effective,
            version=1,
            created_at=started_at,
            updated_at=started_at,
        ))
        await session.commit()


async def _insert_session_with_context(
    fixture,
    *,
    session_id: str,
    level2_work_item_id: str,
    project_id: str = "proj-1",
    started_at: str = "2026-07-15T08:00:00Z",
    ended_at: str | None = "2026-07-15T08:25:00Z",
    focused_seconds: int = 1500,
    validity: str = "valid",
    ownership_state: str = "authoritative",
    review_state: str = "completed",
) -> None:
    """Insert a session with task context and attribution for full lifecycle."""
    from app.models.focus_session import FocusSession, SessionTaskContext
    from app.models.session_revision import SessionAttributionRevision

    async with fixture.scope.session_factory() as session:
        session.add(FocusSession(
            id=session_id,
            session_revision=1,
            started_at=started_at,
            ended_at=ended_at,
            pause_started_at=None,
            planned_seconds=max(focused_seconds, 1),
            gross_seconds=focused_seconds,
            paused_seconds=0,
            break_seconds=0,
            focused_seconds=focused_seconds,
            timer_completion="completed" if ended_at else None,
            validity=validity,
            validity_reason=None,
            overall_progress=None,
            mood=None,
            session_note="",
            review_state=review_state,
            ownership_state=ownership_state,
            version=1,
            created_at=started_at,
            updated_at=ended_at or started_at,
        ))
        session.add(SessionTaskContext(
            id=f"ctx-{session_id}",
            session_id=session_id,
            project_id=project_id,
            level2_work_item_id=level2_work_item_id,
            title_snapshot=f"Item {level2_work_item_id}",
            parent_snapshot=None,
            estimate_snapshot=None,
            status_snapshot="status-todo",
            structure_snapshot="{}",
            linked_at=started_at,
            link_method="manual",
            version=1,
            created_at=started_at,
            updated_at=started_at,
        ))
        session.add(SessionAttributionRevision(
            id=f"attr-{session_id}-1",
            session_id=session_id,
            revision=1,
            project_id=project_id,
            level2_work_item_id=level2_work_item_id,
            reason=None,
            corrected_from_revision=None,
            effective=True,
            version=1,
            created_at=started_at,
            updated_at=started_at,
        ))
        await session.commit()


# ---------------------------------------------------------------------------
# Rebuild command builder and executor
# ---------------------------------------------------------------------------

async def _rebuild_effort(
    fixture,
    *,
    work_item_id: str | None = None,
    requested_at: str = "2026-07-15T12:00:00Z",
    command_id: str | None = None,
):
    """Execute a rebuild_effort_projection command through the UoW.

    The rebuild uses ``entity_type="work_item"`` and routes through
    ``EffortProjectionRepairPolicy`` so that the S3 framework validation
    (db_plans must include the request entity) passes naturally.
    """
    if command_id is None:
        command_id = (
            f"rebuild-effort-{work_item_id}"
            if work_item_id is not None
            else "rebuild-effort-all"
        )
    payload: dict[str, object] = {
        "requested_at": requested_at,
        "space_id": "space-test",
    }
    if work_item_id is not None:
        payload["work_item_id"] = work_item_id
    request = MutationRequest.from_payload(
        name="work_item.rebuild_effort_projection",
        entity_type="work_item",
        entity_id=work_item_id or "all",
        payload=payload,
        expected_version=None,
        client_updated_at=None,
    )
    return await fixture.uow.execute(fixture.scope, request, command_id)


async def _get_effort_actual(fixture, work_item_id: str) -> int:
    """Read WorkItem.effort_actual_seconds from the database."""
    from app.models.work_item import WorkItem

    async with fixture.scope.session_factory() as session:
        row = (
            await session.execute(
                select(WorkItem).where(WorkItem.id == work_item_id)
            )
        ).scalar_one()
    return row.effort_actual_seconds


# ---------------------------------------------------------------------------
# Tests: Only valid/ended/effective sessions counted
# ---------------------------------------------------------------------------

class TestOnlyValidEndedEffectiveCounted:
    """Only valid, ended, authoritative sessions with effective attribution contribute."""

    @pytest.mark.asyncio
    async def test_multiple_sessions_only_valid_ended_contribute(
        self, focus_fixture,
    ) -> None:
        await _seed_catalog(focus_fixture)

        # Valid, ended, authoritative -> contributes 1500
        await _insert_session(
            focus_fixture,
            session_id="fs-1",
            level2_work_item_id="l2-a",
            focused_seconds=1500,
            validity="valid",
            ended_at="2026-07-15T08:25:00Z",
        )
        # Valid, ended, authoritative -> contributes 900
        await _insert_session(
            focus_fixture,
            session_id="fs-2",
            level2_work_item_id="l2-a",
            started_at="2026-07-15T09:00:00Z",
            ended_at="2026-07-15T09:15:00Z",
            focused_seconds=900,
            validity="valid",
        )
        # Invalid, ended -> does NOT contribute
        await _insert_session(
            focus_fixture,
            session_id="fs-3",
            level2_work_item_id="l2-a",
            started_at="2026-07-15T10:00:00Z",
            ended_at="2026-07-15T10:20:00Z",
            focused_seconds=1200,
            validity="invalid",
        )
        # Valid, NOT ended (running) -> does NOT contribute
        await _insert_session(
            focus_fixture,
            session_id="fs-4",
            level2_work_item_id="l2-a",
            started_at="2026-07-15T11:00:00Z",
            ended_at=None,
            focused_seconds=600,
            validity="valid",
            review_state="not_required",
        )

        await _rebuild_effort(focus_fixture, work_item_id="l2-a")

        effort = await _get_effort_actual(focus_fixture, "l2-a")
        assert effort == 1500 + 900


# ---------------------------------------------------------------------------
# Tests: Excluded states contribute 0
# ---------------------------------------------------------------------------

class TestExcludedStatesContributeZero:
    """pending, invalid, activation_conflict, local_provisional, and running sessions contribute 0."""

    @pytest.mark.asyncio
    async def test_pending_session_contributes_zero(self, focus_fixture) -> None:
        await _seed_catalog(focus_fixture)
        await _insert_session(
            focus_fixture,
            session_id="fs-pending",
            level2_work_item_id="l2-a",
            focused_seconds=1500,
            validity="pending",
            ended_at="2026-07-15T08:25:00Z",
        )
        await _rebuild_effort(focus_fixture, work_item_id="l2-a")
        assert await _get_effort_actual(focus_fixture, "l2-a") == 0

    @pytest.mark.asyncio
    async def test_invalid_session_contributes_zero(self, focus_fixture) -> None:
        await _seed_catalog(focus_fixture)
        await _insert_session(
            focus_fixture,
            session_id="fs-invalid",
            level2_work_item_id="l2-a",
            focused_seconds=1500,
            validity="invalid",
            ended_at="2026-07-15T08:25:00Z",
        )
        await _rebuild_effort(focus_fixture, work_item_id="l2-a")
        assert await _get_effort_actual(focus_fixture, "l2-a") == 0

    @pytest.mark.asyncio
    async def test_activation_conflict_contributes_zero(self, focus_fixture) -> None:
        await _seed_catalog(focus_fixture)
        await _insert_session(
            focus_fixture,
            session_id="fs-conflict",
            level2_work_item_id="l2-a",
            focused_seconds=1500,
            validity="valid",
            ownership_state="activation_conflict",
            ended_at="2026-07-15T08:25:00Z",
        )
        await _rebuild_effort(focus_fixture, work_item_id="l2-a")
        assert await _get_effort_actual(focus_fixture, "l2-a") == 0

    @pytest.mark.asyncio
    async def test_local_provisional_contributes_zero(self, focus_fixture) -> None:
        await _seed_catalog(focus_fixture)
        await _insert_session(
            focus_fixture,
            session_id="fs-provisional",
            level2_work_item_id="l2-a",
            focused_seconds=1500,
            validity="valid",
            ownership_state="local_provisional",
            ended_at="2026-07-15T08:25:00Z",
        )
        await _rebuild_effort(focus_fixture, work_item_id="l2-a")
        assert await _get_effort_actual(focus_fixture, "l2-a") == 0

    @pytest.mark.asyncio
    async def test_running_session_contributes_zero(self, focus_fixture) -> None:
        await _seed_catalog(focus_fixture)
        await _insert_session(
            focus_fixture,
            session_id="fs-running",
            level2_work_item_id="l2-a",
            focused_seconds=600,
            validity="valid",
            ended_at=None,
            review_state="not_required",
        )
        await _rebuild_effort(focus_fixture, work_item_id="l2-a")
        assert await _get_effort_actual(focus_fixture, "l2-a") == 0


# ---------------------------------------------------------------------------
# Tests: Attribution change recomputes both sides
# ---------------------------------------------------------------------------

class TestAttributionChangeRecomputesBothSides:
    """Moving a session's attribution from l2-a to l2-b recalculates both targets."""

    @pytest.mark.asyncio
    async def test_attribution_correction_recomputes_both_targets(
        self, focus_fixture,
    ) -> None:
        await _seed_catalog(focus_fixture)

        # Session attributed to l2-a with 1500 focused seconds
        await _insert_session_with_context(
            focus_fixture,
            session_id="fs-1",
            level2_work_item_id="l2-a",
            focused_seconds=1500,
            validity="valid",
            ended_at="2026-07-15T08:25:00Z",
        )

        # Initial rebuild: l2-a = 1500, l2-b = 0
        await _rebuild_effort(focus_fixture, work_item_id="l2-a")
        await _rebuild_effort(
            focus_fixture, work_item_id="l2-b",
            command_id="rebuild-effort-l2-b-init",
        )
        assert await _get_effort_actual(focus_fixture, "l2-a") == 1500
        assert await _get_effort_actual(focus_fixture, "l2-b") == 0

        # Correct attribution from l2-a to l2-b
        correct_payload: dict[str, object] = {
            "occurred_at": "2026-07-15T09:00:00Z",
            "level2_work_item_id": "l2-b",
            "owner_device_id": "device-a",
            "owner_tab_id": "tab-a",
        }
        correct_business = focus_business_payload("correct_attribution", correct_payload)
        correct_cmd = FocusSessionCommand(
            command_id="correct-attr-1",
            space_id="space-test",
            session_id="fs-1",
            ownership_epoch=None,
            payload_hash=canonical_payload_hash(correct_business),
            payload=correct_payload,
        )
        correct_request = build_focus_request("correct_attribution", correct_cmd)
        await focus_fixture.uow.execute(
            focus_fixture.scope, correct_request, correct_cmd.command_id,
        )

        # Rebuild both targets after correction
        await _rebuild_effort(
            focus_fixture, work_item_id="l2-a",
            command_id="rebuild-effort-l2-a-after",
        )
        await _rebuild_effort(
            focus_fixture, work_item_id="l2-b",
            command_id="rebuild-effort-l2-b-after",
        )

        assert await _get_effort_actual(focus_fixture, "l2-a") == 0
        assert await _get_effort_actual(focus_fixture, "l2-b") == 1500


# ---------------------------------------------------------------------------
# Tests: Validity change to invalid clears projection
# ---------------------------------------------------------------------------

class TestValidityChangeClearsProjection:
    """When session validity changes from valid to invalid, projection becomes 0."""

    @pytest.mark.asyncio
    async def test_validity_to_invalid_clears_effort(self, focus_fixture) -> None:
        from app.models.focus_session import FocusSession

        await _seed_catalog(focus_fixture)
        await _insert_session_with_context(
            focus_fixture,
            session_id="fs-1",
            level2_work_item_id="l2-a",
            focused_seconds=1500,
            validity="valid",
            ended_at="2026-07-15T08:25:00Z",
        )

        # Initial rebuild: l2-a = 1500
        await _rebuild_effort(focus_fixture, work_item_id="l2-a")
        assert await _get_effort_actual(focus_fixture, "l2-a") == 1500

        # Change validity to invalid directly (simulating a review correction)
        async with focus_fixture.scope.session_factory() as session:
            fs = (
                await session.execute(
                    select(FocusSession).where(FocusSession.id == "fs-1")
                )
            ).scalar_one()
            fs.validity = "invalid"
            await session.commit()

        # Rebuild: l2-a = 0
        await _rebuild_effort(
            focus_fixture, work_item_id="l2-a",
            command_id="rebuild-effort-l2-a-after-invalid",
        )
        assert await _get_effort_actual(focus_fixture, "l2-a") == 0


# ---------------------------------------------------------------------------
# Tests: Task Space command receipts don't affect projection
# ---------------------------------------------------------------------------

class TestReceiptsDoNotAffectProjection:
    """Command receipts are independent of effort projection calculation."""

    @pytest.mark.asyncio
    async def test_receipts_present_but_projection_unaffected(
        self, focus_fixture,
    ) -> None:
        from app.models.session_command import SessionCommandEnvelope, SessionCommandReceipt

        await _seed_catalog(focus_fixture)
        await _insert_session_with_context(
            focus_fixture,
            session_id="fs-1",
            level2_work_item_id="l2-a",
            focused_seconds=1500,
            validity="valid",
            ended_at="2026-07-15T08:25:00Z",
        )

        # Insert an envelope and receipt that should not affect projection
        async with focus_fixture.scope.session_factory() as session:
            session.add(SessionCommandEnvelope(
                command_id="cmd-envelope-1",
                space_id="space-test",
                session_id="fs-1",
                session_revision=1,
                work_item_id="l3-a",
                expected_version=1,
                target_transition="complete",
                replay_safe=True,
                payload_hash=canonical_payload_hash(
                    {"status_definition_id": "status-done"}
                ),
                created_at="2026-07-15T08:30:00Z",
            ))
            session.add(SessionCommandReceipt(
                command_id="cmd-envelope-1",
                state="succeeded",
                error_code=None,
                retryable=False,
                details_json=None,
                result_json=None,
                updated_at="2026-07-15T08:35:00Z",
            ))
            await session.commit()

        await _rebuild_effort(focus_fixture, work_item_id="l2-a")
        # Projection is still just the session's focused_seconds
        assert await _get_effort_actual(focus_fixture, "l2-a") == 1500


# ---------------------------------------------------------------------------
# Tests: Rebuild enters real policy not generic fallback
# ---------------------------------------------------------------------------

class TestRebuildEntersRealPolicy:
    """Rebuild must route through EffortProjectionRepairPolicy, not the generic compiler."""

    @pytest.mark.asyncio
    async def test_rebuild_routes_through_repair_policy(
        self, focus_fixture,
    ) -> None:
        await _seed_catalog(focus_fixture)
        await _insert_session(
            focus_fixture,
            session_id="fs-1",
            level2_work_item_id="l2-a",
            focused_seconds=1500,
            validity="valid",
            ended_at="2026-07-15T08:25:00Z",
        )

        # The rebuild request has entity_type="work_item", which is owned
        # by EffortProjectionRepairPolicy.  If the policy handler is not
        # invoked, the generic compiler would reject the unknown request name.
        result = await _rebuild_effort(focus_fixture, work_item_id="l2-a")
        assert result is not None
        assert result.state in ("FINALIZED", "DB_COMMITTED", "FORWARD_APPLIED")

    @pytest.mark.asyncio
    async def test_repair_service_uses_focus_session_policy(self, focus_fixture) -> None:
        await _seed_catalog(focus_fixture)
        await _insert_session(
            focus_fixture,
            session_id="fs-1",
            level2_work_item_id="l2-a",
            focused_seconds=1500,
            validity="valid",
            ended_at="2026-07-15T08:25:00Z",
        )

        report = await focus_fixture.repair_service.rebuild(
            focus_fixture.scope,
            operation_id="repair-effort-service-1",
            requested_at="2026-07-15T12:00:00Z",
            work_item_id="l2-a",
        )

        assert report.operation_id == "repair-effort-service-1"
        assert report.applied is True
        assert report.mismatches_repaired == 1
        assert await _get_effort_actual(focus_fixture, "l2-a") == 1500

    @pytest.mark.asyncio
    async def test_rebuild_updates_work_item_effort(self, focus_fixture) -> None:
        await _seed_catalog(focus_fixture)
        await _insert_session(
            focus_fixture,
            session_id="fs-1",
            level2_work_item_id="l2-a",
            focused_seconds=1500,
            validity="valid",
            ended_at="2026-07-15T08:25:00Z",
        )
        await _insert_session(
            focus_fixture,
            session_id="fs-2",
            level2_work_item_id="l2-a",
            started_at="2026-07-15T09:00:00Z",
            ended_at="2026-07-15T09:10:00Z",
            focused_seconds=600,
            validity="valid",
        )

        await _rebuild_effort(focus_fixture, work_item_id="l2-a")
        assert await _get_effort_actual(focus_fixture, "l2-a") == 2100


# ---------------------------------------------------------------------------
# Tests: Rebuild uses stable operation ID
# ---------------------------------------------------------------------------

class TestRebuildStableOperationId:
    """Same operation_id with different requested_at is an idempotency_conflict."""

    @pytest.mark.asyncio
    async def test_same_operation_id_different_requested_at_is_conflict(
        self, focus_fixture,
    ) -> None:
        await _seed_catalog(focus_fixture)
        await _insert_session(
            focus_fixture,
            session_id="fs-1",
            level2_work_item_id="l2-a",
            focused_seconds=1500,
            validity="valid",
            ended_at="2026-07-15T08:25:00Z",
        )

        # First rebuild succeeds
        await _rebuild_effort(
            focus_fixture, work_item_id="l2-a",
            requested_at="2026-07-15T12:00:00Z",
            command_id="rebuild-effort-l2-a",
        )

        # Second rebuild with same operation_id but different requested_at
        with pytest.raises((MutationRejectedError, IdempotencyConflictError)):
            await _rebuild_effort(
                focus_fixture, work_item_id="l2-a",
                requested_at="2026-07-15T13:00:00Z",
                command_id="rebuild-effort-l2-a",
            )

    @pytest.mark.asyncio
    async def test_same_operation_id_same_request_is_idempotent(
        self, focus_fixture,
    ) -> None:
        await _seed_catalog(focus_fixture)
        await _insert_session(
            focus_fixture,
            session_id="fs-1",
            level2_work_item_id="l2-a",
            focused_seconds=1500,
            validity="valid",
            ended_at="2026-07-15T08:25:00Z",
        )

        # First rebuild succeeds
        result1 = await _rebuild_effort(
            focus_fixture, work_item_id="l2-a",
            requested_at="2026-07-15T12:00:00Z",
            command_id="rebuild-effort-l2-a",
        )

        # Second rebuild with identical parameters is idempotent (no error)
        result2 = await _rebuild_effort(
            focus_fixture, work_item_id="l2-a",
            requested_at="2026-07-15T12:00:00Z",
            command_id="rebuild-effort-l2-a",
        )
        # Both results should be the same
        assert result1.operation_id == result2.operation_id


# ---------------------------------------------------------------------------
# Tests: Rebuild produces complete WorkItem post-image event
# ---------------------------------------------------------------------------

class TestRebuildProducesWorkItemEvent:
    """Rebuild must produce a complete WorkItem sync event (post-image)."""

    @pytest.mark.asyncio
    async def test_rebuild_emits_work_item_update_sync_event(
        self, focus_fixture,
    ) -> None:
        await _seed_catalog(focus_fixture)
        await _insert_session(
            focus_fixture,
            session_id="fs-1",
            level2_work_item_id="l2-a",
            focused_seconds=1500,
            validity="valid",
            ended_at="2026-07-15T08:25:00Z",
        )

        await _rebuild_effort(focus_fixture, work_item_id="l2-a")

        events = await focus_fixture.mutation.visible_events(
            entity_type="workItem",
        )
        assert len(events) == 1
        event = events[0]
        assert event.entity_type == "workItem"
        assert event.entity_id == "l2-a"
        assert event.action == "update"
        # The payload should contain the updated effort_actual_seconds
        assert event.payload.get("effort_actual_seconds") == 1500

    @pytest.mark.asyncio
    async def test_rebuild_work_item_version_advances(
        self, focus_fixture,
    ) -> None:
        from app.models.work_item import WorkItem

        await _seed_catalog(focus_fixture)
        await _insert_session(
            focus_fixture,
            session_id="fs-1",
            level2_work_item_id="l2-a",
            focused_seconds=1500,
            validity="valid",
            ended_at="2026-07-15T08:25:00Z",
        )

        await _rebuild_effort(focus_fixture, work_item_id="l2-a")

        async with focus_fixture.scope.session_factory() as session:
            l2 = (
                await session.execute(
                    select(WorkItem).where(WorkItem.id == "l2-a")
                )
            ).scalar_one()
        assert l2.version == 2
        assert l2.effort_actual_seconds == 1500


# ---------------------------------------------------------------------------
# Tests: EffortProjectionCompiler.verify_all
# ---------------------------------------------------------------------------

class TestEffortProjectionVerification:
    """EffortProjectionCompiler.verify_all validates projection consistency."""

    @pytest.mark.asyncio
    async def test_verify_all_passes_after_rebuild(self, focus_fixture) -> None:
        await _seed_catalog(focus_fixture)
        await _insert_session(
            focus_fixture,
            session_id="fs-1",
            level2_work_item_id="l2-a",
            focused_seconds=1500,
            validity="valid",
            ended_at="2026-07-15T08:25:00Z",
        )

        await _rebuild_effort(focus_fixture, work_item_id="l2-a")

        # verify_all should not raise after a successful rebuild
        await EffortProjectionCompiler.verify_all(focus_fixture.scope)

    @pytest.mark.asyncio
    async def test_verify_all_detects_stale_projection(self, focus_fixture) -> None:
        from app.models.work_item import WorkItem

        await _seed_catalog(focus_fixture)
        await _insert_session(
            focus_fixture,
            session_id="fs-1",
            level2_work_item_id="l2-a",
            focused_seconds=1500,
            validity="valid",
            ended_at="2026-07-15T08:25:00Z",
        )

        # Manually set a stale effort value without rebuilding
        async with focus_fixture.scope.session_factory() as session:
            l2 = (
                await session.execute(
                    select(WorkItem).where(WorkItem.id == "l2-a")
                )
            ).scalar_one()
            l2.effort_actual_seconds = 999
            await session.commit()

        # verify_all is a read-only report.  It shares the exact computation
        # path with rebuild and returns typed mismatches instead of throwing
        # for an ordinary stale materialized value.
        assert await EffortProjectionCompiler.verify_all(focus_fixture.scope) == (
            EffortMismatch(work_item_id="l2-a", stored=999, expected=1500),
        )


# ---------------------------------------------------------------------------
# Tests: Fault injection converges to all-old or all-new
# ---------------------------------------------------------------------------

class TestFaultInjectionConverges:
    """Injected projection fault must converge to all-old or all-new after recovery."""

    @pytest.mark.asyncio
    async def test_fault_injection_converges_after_recovery(
        self, focus_fixture,
    ) -> None:
        from app.models.work_item import WorkItem

        await _seed_catalog(focus_fixture)
        await _insert_session(
            focus_fixture,
            session_id="fs-1",
            level2_work_item_id="l2-a",
            focused_seconds=1500,
            validity="valid",
            ended_at="2026-07-15T08:25:00Z",
        )

        # Record the initial state
        initial_effort = await _get_effort_actual(focus_fixture, "l2-a")
        assert initial_effort == 0

        # Inject a failure at the real rebuild boundary.  Rebuilds deliberately
        # have no file projections, so a projection-forward fault would never
        # execute after the fake projection was removed.
        focus_fixture.mutation.inject_fault("db_commit")

        # Attempt rebuild -- should fail during projection
        with pytest.raises(RuntimeError, match="injected db commit failure"):
            await _rebuild_effort(
                focus_fixture, work_item_id="l2-a",
                command_id="rebuild-effort-l2-a-fault",
            )

        # Recover from the fault
        await focus_fixture.mutation.recover()

        # After recovery, state must be either all-old (0) or all-new (1500)
        recovered_effort = await _get_effort_actual(focus_fixture, "l2-a")
        assert recovered_effort in (0, 1500)

        # If converged to all-new, verify the WorkItem version advanced
        if recovered_effort == 1500:
            async with focus_fixture.scope.session_factory() as session:
                l2 = (
                    await session.execute(
                        select(WorkItem).where(WorkItem.id == "l2-a")
                    )
                ).scalar_one()
            assert l2.effort_actual_seconds == 1500

    @pytest.mark.asyncio
    async def test_rebuild_after_recovery_succeeds(self, focus_fixture) -> None:
        await _seed_catalog(focus_fixture)
        await _insert_session(
            focus_fixture,
            session_id="fs-1",
            level2_work_item_id="l2-a",
            focused_seconds=1500,
            validity="valid",
            ended_at="2026-07-15T08:25:00Z",
        )

        # Inject a real DB commit failure, then recover the staged journal.
        focus_fixture.mutation.inject_fault("db_commit")
        with pytest.raises(RuntimeError, match="injected db commit failure"):
            await _rebuild_effort(
                focus_fixture, work_item_id="l2-a",
                command_id="rebuild-effort-l2-a-fault",
            )
        await focus_fixture.mutation.recover()

        # After recovery, a fresh rebuild should succeed
        await _rebuild_effort(
            focus_fixture, work_item_id="l2-a",
            command_id="rebuild-effort-l2-a-retry",
        )
        assert await _get_effort_actual(focus_fixture, "l2-a") == 1500


# ---------------------------------------------------------------------------
# Helper: Build AuthorityOverlay from current DB state
# ---------------------------------------------------------------------------

async def _build_authority(fixture):
    """Build an AuthorityOverlay from the current committed DB state.

    The overlay is detached from the session because
    ``from_locked_authorities`` eagerly loads every row into memory.
    """
    from app.mutation.unit_of_work import AuthorityOverlay

    async with fixture.scope.session_factory() as session:
        return await AuthorityOverlay.from_locked_authorities(
            fixture.scope, session, fixture.mutation.catalog,
        )


# ---------------------------------------------------------------------------
# Tests: Multiple effective attribution fails closed
# ---------------------------------------------------------------------------

class TestMultipleEffectiveAttributionFailClosed:
    """A session with multiple effective attributions must fail closed."""

    @pytest.mark.asyncio
    async def test_multiple_effective_attribution_raises_violation(
        self, focus_fixture,
    ) -> None:
        from sqlalchemy import text

        from app.models.session_revision import SessionAttributionRevision

        await _seed_catalog(focus_fixture)
        await _insert_session(
            focus_fixture,
            session_id="fs-1",
            level2_work_item_id="l2-a",
            focused_seconds=1500,
            validity="valid",
            ended_at="2026-07-15T08:25:00Z",
        )

        # The DB partial unique index (uq_session_attribution_effective)
        # normally prevents two effective revisions for one session.  Drop
        # it temporarily so we can inject the corrupt state that the
        # computation layer must still detect and reject.
        async with focus_fixture.scope.session_factory() as session:
            await session.execute(
                text("DROP INDEX IF EXISTS uq_session_attribution_effective")
            )
            session.add(SessionAttributionRevision(
                id="attr-fs-1-dup",
                session_id="fs-1",
                revision=2,
                project_id="proj-1",
                level2_work_item_id="l2-a",
                reason=None,
                corrected_from_revision=None,
                effective=True,
                version=1,
                created_at="2026-07-15T08:00:00Z",
                updated_at="2026-07-15T08:00:00Z",
            ))
            await session.commit()

        authority = await _build_authority(focus_fixture)

        with pytest.raises(MutationRuleViolation) as exc_info:
            EffortProjectionCompiler.compute_effort_for_work_item(
                authority, "l2-a",
            )
        assert exc_info.value.details["reason"] == "multiple_effective_attribution"


# ---------------------------------------------------------------------------
# Tests: Attribution target validation fails closed
# ---------------------------------------------------------------------------

class TestAttributionTargetValidationFailClosed:
    """Missing, cross-Project, and non-level-2 attribution targets fail closed."""

    @pytest.mark.asyncio
    async def test_missing_target_raises_violation(self, focus_fixture) -> None:
        await _seed_catalog(focus_fixture)
        await _insert_session(
            focus_fixture,
            session_id="fs-1",
            level2_work_item_id="nonexistent-wi",
            focused_seconds=1500,
            validity="valid",
            ended_at="2026-07-15T08:25:00Z",
        )

        authority = await _build_authority(focus_fixture)

        with pytest.raises(MutationRuleViolation) as exc_info:
            EffortProjectionCompiler.compute_effort_for_work_item(
                authority, "nonexistent-wi",
            )
        assert exc_info.value.details["reason"] == "attribution_target_missing"

    @pytest.mark.asyncio
    async def test_non_level2_target_raises_violation(
        self, focus_fixture,
    ) -> None:
        await _seed_catalog(focus_fixture)
        await _insert_session(
            focus_fixture,
            session_id="fs-1",
            level2_work_item_id="l3-a",
            focused_seconds=1500,
            validity="valid",
            ended_at="2026-07-15T08:25:00Z",
        )

        authority = await _build_authority(focus_fixture)

        with pytest.raises(MutationRuleViolation) as exc_info:
            EffortProjectionCompiler.compute_effort_for_work_item(
                authority, "l3-a",
            )
        assert exc_info.value.details["reason"] == "attribution_target_not_level2"

    @pytest.mark.asyncio
    async def test_cross_project_target_raises_violation(
        self, focus_fixture,
    ) -> None:
        from app.models.project import Project
        from app.models.work_item import WorkItem

        await _seed_catalog(focus_fixture)

        # Seed a second project with a level-2 WorkItem.
        async with focus_fixture.scope.session_factory() as session:
            session.add(Project(
                id="proj-2",
                key="TEST2",
                name="Test Project 2",
                default_status_definition_id="status-todo",
                default_type_definition_id="type-task",
            ))
            session.add(WorkItem(
                id="l2-cross",
                project_id="proj-2",
                display_key="TEST2-l2-cross",
                title="Cross Project L2",
                type_definition_id="type-task",
                status_definition_id="status-todo",
                parent_id=None,
                version=1,
            ))
            await session.commit()

        # Attribution points to l2-cross (proj-2) but carries project_id=proj-1.
        await _insert_session(
            focus_fixture,
            session_id="fs-1",
            level2_work_item_id="l2-cross",
            project_id="proj-1",
            focused_seconds=1500,
            validity="valid",
            ended_at="2026-07-15T08:25:00Z",
        )

        authority = await _build_authority(focus_fixture)

        with pytest.raises(MutationRuleViolation) as exc_info:
            EffortProjectionCompiler.compute_effort_for_work_item(
                authority, "l2-cross",
            )
        assert exc_info.value.details["reason"] == "attribution_target_cross_project"


# ---------------------------------------------------------------------------
# Tests: Focused seconds validation fails closed
# ---------------------------------------------------------------------------

class TestFocusedSecondsValidationFailClosed:
    """Negative, non-integer, and unsafe-integer focused_seconds fail closed."""

    @pytest.mark.asyncio
    async def test_negative_focused_seconds_raises_violation(
        self, focus_fixture,
    ) -> None:
        await _seed_catalog(focus_fixture)
        await _insert_session(
            focus_fixture,
            session_id="fs-1",
            level2_work_item_id="l2-a",
            focused_seconds=1500,
            validity="valid",
            ended_at="2026-07-15T08:25:00Z",
        )

        authority = await _build_authority(focus_fixture)

        # Mutate the in-memory session row to simulate a negative
        # focused_seconds value that bypassed DB check constraints.
        original = dict(authority._rows[("focus_session", "fs-1")])
        original["focused_seconds"] = -100
        authority._rows[("focus_session", "fs-1")] = original

        with pytest.raises(MutationRuleViolation) as exc_info:
            EffortProjectionCompiler.compute_effort_for_work_item(
                authority, "l2-a",
            )
        assert exc_info.value.details["reason"] == "invalid_focused_seconds"

    @pytest.mark.asyncio
    async def test_non_integer_focused_seconds_raises_violation(
        self, focus_fixture,
    ) -> None:
        await _seed_catalog(focus_fixture)
        await _insert_session(
            focus_fixture,
            session_id="fs-1",
            level2_work_item_id="l2-a",
            focused_seconds=1500,
            validity="valid",
            ended_at="2026-07-15T08:25:00Z",
        )

        authority = await _build_authority(focus_fixture)

        # Mutate the in-memory session row to simulate a non-integer
        # focused_seconds value (string instead of int).
        original = dict(authority._rows[("focus_session", "fs-1")])
        original["focused_seconds"] = "1500"
        authority._rows[("focus_session", "fs-1")] = original

        with pytest.raises(MutationRuleViolation) as exc_info:
            EffortProjectionCompiler.compute_effort_for_work_item(
                authority, "l2-a",
            )
        assert exc_info.value.details["reason"] == "invalid_focused_seconds"

    @pytest.mark.asyncio
    async def test_unsafe_integer_total_raises_violation(
        self, focus_fixture,
    ) -> None:
        await _seed_catalog(focus_fixture)

        # Two sessions with very large focused_seconds that together
        # exceed the safe integer max (2^53 - 1 = 9007199254740991).
        large_value = 5_000_000_000_000_000
        await _insert_session(
            focus_fixture,
            session_id="fs-1",
            level2_work_item_id="l2-a",
            focused_seconds=large_value,
            validity="valid",
            ended_at="2026-07-15T08:25:00Z",
        )
        await _insert_session(
            focus_fixture,
            session_id="fs-2",
            level2_work_item_id="l2-a",
            started_at="2026-07-15T09:00:00Z",
            ended_at="2026-07-15T09:25:00Z",
            focused_seconds=large_value,
            validity="valid",
        )

        authority = await _build_authority(focus_fixture)

        with pytest.raises(MutationRuleViolation) as exc_info:
            EffortProjectionCompiler.compute_effort_for_work_item(
                authority, "l2-a",
            )
        assert exc_info.value.details["reason"] == "effort_total_unsafe_integer"


# ---------------------------------------------------------------------------
# Tests: Rebuild produces no fake folder or no-op FocusSession events
# ---------------------------------------------------------------------------

class TestRebuildNoFakeFolderOrNoopSession:
    """Rebuild must only emit WorkItem sync events, never folder or focusSession."""

    @pytest.mark.asyncio
    async def test_rebuild_emits_no_folder_or_session_events(
        self, focus_fixture,
    ) -> None:
        await _seed_catalog(focus_fixture)
        await _insert_session(
            focus_fixture,
            session_id="fs-1",
            level2_work_item_id="l2-a",
            focused_seconds=1500,
            validity="valid",
            ended_at="2026-07-15T08:25:00Z",
        )

        await _rebuild_effort(focus_fixture, work_item_id="l2-a")

        # No folder sync events should be produced.
        folder_events = await focus_fixture.mutation.visible_events(
            entity_type="folder",
        )
        assert len(folder_events) == 0

        # No focusSession sync events (no no-op session update).
        session_events = await focus_fixture.mutation.visible_events(
            entity_type="focusSession",
        )
        assert len(session_events) == 0

        # Only workItem sync events should be produced.
        work_item_events = await focus_fixture.mutation.visible_events(
            entity_type="workItem",
        )
        assert len(work_item_events) == 1
        assert work_item_events[0].entity_id == "l2-a"
        assert work_item_events[0].action == "update"


# ---------------------------------------------------------------------------
# Tests: Rebuild for non-existent WorkItem fails closed
# ---------------------------------------------------------------------------

class TestRebuildMissingWorkItemRejected:
    """Rebuild for a non-existent WorkItem must fail closed."""

    @pytest.mark.asyncio
    async def test_rebuild_nonexistent_work_item_rejected(
        self, focus_fixture,
    ) -> None:
        await _seed_catalog(focus_fixture)

        with pytest.raises(MutationRejectedError) as captured:
            await _rebuild_effort(
                focus_fixture, work_item_id="nonexistent-wi",
            )
        assert captured.value.rejection.code == "not_found"
        assert captured.value.rejection.details["reason"] == "rebuild_target_missing"
