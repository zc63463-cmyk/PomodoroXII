"""TS2 Task 3: Focus session revisions, review outcomes, and command envelopes.

RED-phase tests for attribution correction (append-only), review commits that
materialise outcomes and envelopes before Task Space dispatch, nonterminal
session rejection, fail-closed validation, state_command=none envelope
suppression, complete/cancel payload-hash formula, corrected-outcome revision
appending, and WorkItem isolation from plan mutations.

These tests exercise the full S3 MutationUnitOfWork backed by SQLite.
The review/outcome/envelope functionality is not yet implemented -- the
tests are expected to FAIL until the policy is extended.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.errors import MutationRejectedError
from app.focus_session.commands import build_focus_request, focus_business_payload
from app.focus_session.contracts import FocusSessionCommand
from app.focus_session.module import DefaultFocusSessionModule
from app.focus_session.policy import FocusSessionMutationPolicy
from app.focus_session.query import FocusSessionQuery
from app.mutation.types import canonical_payload_hash
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
    mutation = mutation_fixture_factory(policies=(policy,))
    module = DefaultFocusSessionModule(
        uow=mutation.uow,
        query=FocusSessionQuery(),
        reconciler=None,
    )
    return SimpleNamespace(
        mutation=mutation,
        policy=policy,
        module=module,
        scope=mutation.scope,
        uow=mutation.uow,
    )


# ---------------------------------------------------------------------------
# Catalog seeding helper
# ---------------------------------------------------------------------------

async def _seed_catalog(
    fixture,
    *,
    project_id: str = "proj-1",
    extra_l2_ids: tuple[str, ...] = (),
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
        session.add(WorkItem(
            id="l2-a",
            project_id=project_id,
            display_key="TEST-1",
            title="Level 2 Item A",
            type_definition_id="type-task",
            status_definition_id="status-todo",
            parent_id=None,
            version=1,
        ))
        for l2_id in extra_l2_ids:
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
        session.add(WorkItem(
            id="l3-a",
            project_id=project_id,
            display_key="TEST-2",
            title="Level 3 Item A",
            type_definition_id="type-task",
            status_definition_id="status-todo",
            parent_id="l2-a",
            version=1,
        ))
        await session.commit()


# ---------------------------------------------------------------------------
# Command builders
# ---------------------------------------------------------------------------

def _start_command(
    *,
    command_id: str = "start-1",
    session_id: str = "fs-1",
    level2_id: str = "l2-a",
    l3_ids: tuple[str, ...] = ("l3-a",),
    ownership_epoch: int = 1,
) -> FocusSessionCommand:
    payload: dict[str, object] = {
        "level2_work_item_id": level2_id,
        "level3_work_item_ids": l3_ids,
        "planned_seconds": 1500,
        "started_at": "2026-07-15T08:00:00Z",
        "owner_device_id": "device-a",
        "owner_tab_id": "tab-a",
    }
    business = focus_business_payload("start", payload)
    return FocusSessionCommand(
        command_id=command_id,
        space_id="space-test",
        session_id=session_id,
        ownership_epoch=ownership_epoch,
        payload_hash=canonical_payload_hash(business),
        payload=payload,
    )


def _end_command(
    *,
    command_id: str = "end-1",
    session_id: str = "fs-1",
    expected_version: int = 1,
    occurred_at: str = "2026-07-15T08:25:00Z",
    validity: str = "valid",
    ownership_epoch: int = 1,
) -> FocusSessionCommand:
    payload: dict[str, object] = {
        "occurred_at": occurred_at,
        "expected_version": expected_version,
        "timer_completion": "completed",
        "validity": validity,
        "validity_reason": "natural_completion",
        "owner_device_id": "device-a",
        "owner_tab_id": "tab-a",
    }
    business = focus_business_payload("end", payload)
    return FocusSessionCommand(
        command_id=command_id,
        space_id="space-test",
        session_id=session_id,
        ownership_epoch=ownership_epoch,
        payload_hash=canonical_payload_hash(business),
        payload=payload,
    )


def _review_command(
    *,
    command_id: str = "review-1",
    session_id: str = "fs-1",
    expected_version: int = 2,
    reviewed_at: str = "2026-07-15T08:30:00Z",
    review_state: str = "completed",
    validity: str = "valid",
    outcomes: tuple[dict[str, object], ...] = (),
) -> FocusSessionCommand:
    payload: dict[str, object] = {
        "reviewed_at": reviewed_at,
        "review_state": review_state,
        "validity": validity,
        "validity_reason": "natural_completion",
        "outcomes": outcomes,
        "expected_version": expected_version,
    }
    business = focus_business_payload("submit_review", payload)
    return FocusSessionCommand(
        command_id=command_id,
        space_id="space-test",
        session_id=session_id,
        ownership_epoch=None,
        payload_hash=canonical_payload_hash(business),
        payload=payload,
    )


def _correct_attribution_command(
    *,
    command_id: str = "correct-attr-1",
    session_id: str = "fs-1",
    level2_work_item_id: str = "l2-b",
    occurred_at: str = "2026-07-15T09:00:00Z",
) -> FocusSessionCommand:
    payload: dict[str, object] = {
        "occurred_at": occurred_at,
        "level2_work_item_id": level2_work_item_id,
        "owner_device_id": "device-a",
        "owner_tab_id": "tab-a",
    }
    business = focus_business_payload("correct_attribution", payload)
    return FocusSessionCommand(
        command_id=command_id,
        space_id="space-test",
        session_id=session_id,
        ownership_epoch=None,
        payload_hash=canonical_payload_hash(business),
        payload=payload,
    )


def _set_current_plan_command(
    *,
    command_id: str = "set-current-1",
    session_id: str = "fs-1",
    ownership_epoch: int = 1,
    work_item_id: str | None = None,
    expected_plan_versions: dict[str, int] | None = None,
) -> FocusSessionCommand:
    payload: dict[str, object] = {
        "owner_device_id": "device-a",
        "owner_tab_id": "tab-a",
        "work_item_id": work_item_id,
    }
    if expected_plan_versions is not None:
        payload["expected_plan_versions"] = expected_plan_versions
    business = focus_business_payload("set_current_plan_item", payload)
    return FocusSessionCommand(
        command_id=command_id,
        space_id="space-test",
        session_id=session_id,
        ownership_epoch=ownership_epoch,
        payload_hash=canonical_payload_hash(business),
        payload=payload,
    )


def _set_completion_draft_command(
    *,
    command_id: str = "set-draft-1",
    session_id: str = "fs-1",
    ownership_epoch: int = 1,
    plan_item_id: str = "plan-fs-1-l3-a",
    completion_draft: bool = True,
    expected_plan_version: int = 1,
) -> FocusSessionCommand:
    payload: dict[str, object] = {
        "owner_device_id": "device-a",
        "owner_tab_id": "tab-a",
        "plan_item_id": plan_item_id,
        "completion_draft": completion_draft,
        "expected_plan_version": expected_plan_version,
    }
    business = focus_business_payload("set_completion_draft", payload)
    return FocusSessionCommand(
        command_id=command_id,
        space_id="space-test",
        session_id=session_id,
        ownership_epoch=ownership_epoch,
        payload_hash=canonical_payload_hash(business),
        payload=payload,
    )


# ---------------------------------------------------------------------------
# Lifecycle helpers
# ---------------------------------------------------------------------------

async def _start_session(fixture, *, session_id="fs-1", level2_id="l2-a"):
    """Start a session and return the resulting view."""
    command = _start_command(session_id=session_id, level2_id=level2_id)
    return await fixture.module.start(fixture.scope, command)


async def _end_session(
    fixture, *, session_id="fs-1", expected_version=1,
    validity="valid", occurred_at="2026-07-15T08:25:00Z",
):
    """End a session and return the resulting view."""
    command = _end_command(
        session_id=session_id,
        expected_version=expected_version,
        validity=validity,
        occurred_at=occurred_at,
    )
    return await fixture.module.end(fixture.scope, command)


async def _submit_review(
    fixture, *, session_id="fs-1", expected_version=2,
    outcomes=(), reviewed_at="2026-07-15T08:30:00Z",
    review_state="completed", validity="valid",
    command_id="review-1",
):
    """Submit a review and return the resulting view."""
    command = _review_command(
        command_id=command_id,
        session_id=session_id,
        expected_version=expected_version,
        outcomes=outcomes,
        reviewed_at=reviewed_at,
        review_state=review_state,
        validity=validity,
    )
    return await fixture.module.submit_review(fixture.scope, command)


async def _correct_attribution(
    fixture, *, session_id="fs-1", level2_work_item_id="l2-b",
    occurred_at="2026-07-15T09:00:00Z", command_id="correct-attr-1",
):
    """Execute a correct_attribution command through the UoW."""
    command = _correct_attribution_command(
        command_id=command_id,
        session_id=session_id,
        level2_work_item_id=level2_work_item_id,
        occurred_at=occurred_at,
    )
    request = build_focus_request("correct_attribution", command)
    return await fixture.uow.execute(fixture.scope, request, command.command_id)


# ---------------------------------------------------------------------------
# Tests: Attribution correction append-only
# ---------------------------------------------------------------------------

class TestAttributionCorrectionAppendOnly:
    """Attribution correction appends a new revision; old revision stays visible."""

    @pytest.mark.asyncio
    async def test_correct_attribution_appends_new_effective_revision(
        self, focus_fixture,
    ) -> None:
        from app.models.session_revision import SessionAttributionRevision

        await _seed_catalog(focus_fixture, extra_l2_ids=("l2-b",))
        await _start_session(focus_fixture, level2_id="l2-a")
        await _end_session(focus_fixture, expected_version=1)

        await _correct_attribution(
            focus_fixture, level2_work_item_id="l2-b",
        )

        async with focus_fixture.scope.session_factory() as session:
            revisions = (
                await session.execute(
                    select(SessionAttributionRevision)
                    .where(SessionAttributionRevision.session_id == "fs-1")
                    .order_by(SessionAttributionRevision.revision)
                )
            ).scalars().all()

        assert len(revisions) == 2
        old, new = revisions
        assert old.revision == 1
        assert old.effective is False
        assert old.level2_work_item_id == "l2-a"
        assert new.revision == 2
        assert new.effective is True
        assert new.level2_work_item_id == "l2-b"
        assert new.corrected_from_revision == 1

    @pytest.mark.asyncio
    async def test_session_task_context_unch_after_attribution_correction(
        self, focus_fixture,
    ) -> None:
        from app.models.focus_session import SessionTaskContext

        await _seed_catalog(focus_fixture, extra_l2_ids=("l2-b",))
        await _start_session(focus_fixture, level2_id="l2-a")
        await _end_session(focus_fixture, expected_version=1)

        await _correct_attribution(
            focus_fixture, level2_work_item_id="l2-b",
        )

        async with focus_fixture.scope.session_factory() as session:
            ctx = (
                await session.execute(
                    select(SessionTaskContext).where(
                        SessionTaskContext.session_id == "fs-1"
                    )
                )
            ).scalar_one()

        assert ctx.level2_work_item_id == "l2-a"


# ---------------------------------------------------------------------------
# Tests: Review commits before dispatch
# ---------------------------------------------------------------------------

class TestReviewCommitsBeforeDispatch:
    """Review materialises outcomes and envelopes; no Task Space dispatch."""

    @pytest.mark.asyncio
    async def test_review_sets_review_state_and_creates_outcomes(
        self, focus_fixture,
    ) -> None:
        from app.models.focus_session import FocusSession
        from app.models.session_revision import SessionWorkItemOutcome

        await _seed_catalog(focus_fixture)
        await _start_session(focus_fixture)
        await _end_session(focus_fixture, expected_version=1)

        outcomes = (
            {
                "work_item_id": "l3-a",
                "touched": True,
                "result": "completed",
                "persona": "ox",
                "state_command": "complete",
                "expected_work_item_version": 1,
            },
        )
        view = await _submit_review(
            focus_fixture, expected_version=2, outcomes=outcomes,
        )

        assert view.value["session"]["reviewState"] == "completed"
        assert view.value["session"]["validity"] == "valid"

        async with focus_fixture.scope.session_factory() as session:
            fs = (
                await session.execute(
                    select(FocusSession).where(FocusSession.id == "fs-1")
                )
            ).scalar_one()
            assert fs.review_state == "completed"

            outcome_rows = (
                await session.execute(
                    select(SessionWorkItemOutcome)
                    .where(SessionWorkItemOutcome.session_id == "fs-1")
                    .order_by(SessionWorkItemOutcome.work_item_id)
                )
            ).scalars().all()

        assert len(outcome_rows) == 1
        outcome = outcome_rows[0]
        assert outcome.work_item_id == "l3-a"
        assert outcome.result == "completed"
        assert outcome.state_command == "complete"
        assert outcome.effective is True
        assert outcome.revision == 1

    @pytest.mark.asyncio
    async def test_review_creates_envelope_ids_for_state_commands(
        self, focus_fixture,
    ) -> None:
        from app.models.session_command import SessionCommandEnvelope

        await _seed_catalog(focus_fixture)
        await _start_session(focus_fixture)
        await _end_session(focus_fixture, expected_version=1)

        outcomes = (
            {
                "work_item_id": "l3-a",
                "touched": True,
                "result": "completed",
                "persona": "ox",
                "state_command": "complete",
                "expected_work_item_version": 1,
            },
        )
        await _submit_review(focus_fixture, expected_version=2, outcomes=outcomes)

        async with focus_fixture.scope.session_factory() as session:
            envelopes = (
                await session.execute(
                    select(SessionCommandEnvelope)
                    .where(SessionCommandEnvelope.session_id == "fs-1")
                )
            ).scalars().all()

        assert len(envelopes) == 1
        env = envelopes[0]
        assert env.target_transition == "complete"
        assert env.work_item_id == "l3-a"
        assert env.session_id == "fs-1"
        assert env.space_id == "space-test"

    @pytest.mark.asyncio
    async def test_review_does_not_dispatch_to_task_space(
        self, focus_fixture,
    ) -> None:
        """Review must not dispatch the recorded Outcome to Task Space.

        The same S3 command may legitimately emit the WorkItem effort
        projection for the level-2 target; that is not a Task Space state
        transition and must not touch the reviewed level-3 item.
        """
        from app.models.work_item import WorkItem

        await _seed_catalog(focus_fixture)
        await _start_session(focus_fixture)
        await _end_session(focus_fixture, expected_version=1)

        outcomes = (
            {
                "work_item_id": "l3-a",
                "touched": True,
                "result": "completed",
                "persona": "ox",
                "state_command": "complete",
                "expected_work_item_version": 1,
            },
        )
        await _submit_review(focus_fixture, expected_version=2, outcomes=outcomes)

        async with focus_fixture.scope.session_factory() as session:
            l3 = (
                await session.execute(
                    select(WorkItem).where(WorkItem.id == "l3-a")
                )
            ).scalar_one()
        # WorkItem must be untouched by review
        assert l3.version == 1
        assert l3.status_definition_id == "status-todo"

        # The only WorkItem event is the authoritative effort projection for
        # the level-2 target.  No event may transition the reviewed level-3
        # item as part of review materialization.
        events = await focus_fixture.mutation.visible_events(
            entity_type="workItem",
        )
        assert len(events) == 1
        assert events[0].entity_id == "l2-a"
        assert events[0].payload["effort_actual_seconds"] == 1500


# ---------------------------------------------------------------------------
# Tests: Nonterminal session review rejected
# ---------------------------------------------------------------------------

class TestNonterminalSessionReviewRejected:
    """Running and paused sessions are rejected for review with zero side effects."""

    @pytest.mark.asyncio
    async def test_running_session_review_rejected(self, focus_fixture) -> None:
        from app.models.session_revision import SessionWorkItemOutcome

        await _seed_catalog(focus_fixture)
        await _start_session(focus_fixture)

        outcomes = (
            {
                "work_item_id": "l3-a",
                "touched": True,
                "result": "completed",
                "persona": "ox",
                "state_command": "none",
                "expected_work_item_version": 1,
            },
        )
        command = _review_command(
            expected_version=1, outcomes=outcomes,
        )
        with pytest.raises(MutationRejectedError) as captured:
            await focus_fixture.module.submit_review(focus_fixture.scope, command)
        assert captured.value.rejection.code == "version_conflict"
        assert captured.value.rejection.details["reason"] == "session_not_ended"

        async with focus_fixture.scope.session_factory() as session:
            outcome_rows = (
                await session.execute(
                    select(SessionWorkItemOutcome).where(
                        SessionWorkItemOutcome.session_id == "fs-1"
                    )
                )
            ).scalars().all()
        assert len(outcome_rows) == 0

    @pytest.mark.asyncio
    async def test_paused_session_review_rejected(self, focus_fixture) -> None:
        from app.models.session_revision import SessionWorkItemOutcome

        await _seed_catalog(focus_fixture)
        await _start_session(focus_fixture)

        pause_payload: dict[str, object] = {
            "occurred_at": "2026-07-15T08:10:00Z",
            "expected_version": 1,
            "owner_device_id": "device-a",
            "owner_tab_id": "tab-a",
        }
        pause_business = focus_business_payload("pause", pause_payload)
        pause_cmd = FocusSessionCommand(
            command_id="pause-1",
            space_id="space-test",
            session_id="fs-1",
            ownership_epoch=1,
            payload_hash=canonical_payload_hash(pause_business),
            payload=pause_payload,
        )
        await focus_fixture.module.pause(focus_fixture.scope, pause_cmd)

        outcomes = (
            {
                "work_item_id": "l3-a",
                "touched": False,
                "result": "untouched",
                "state_command": "none",
                "expected_work_item_version": 1,
            },
        )
        command = _review_command(
            expected_version=2, outcomes=outcomes,
        )
        with pytest.raises(MutationRejectedError) as captured:
            await focus_fixture.module.submit_review(focus_fixture.scope, command)
        assert captured.value.rejection.code == "version_conflict"
        assert captured.value.rejection.details["reason"] == "session_not_ended"

        async with focus_fixture.scope.session_factory() as session:
            outcome_rows = (
                await session.execute(
                    select(SessionWorkItemOutcome).where(
                        SessionWorkItemOutcome.session_id == "fs-1"
                    )
                )
            ).scalars().all()
        assert len(outcome_rows) == 0


# ---------------------------------------------------------------------------
# Tests: Invalid outcome / unknown plan item / version mismatch fail-closed
# ---------------------------------------------------------------------------

class TestReviewFailClosed:
    """Invalid review inputs are rejected with MutationRejectedError."""

    @pytest.mark.asyncio
    async def test_unknown_plan_item_in_outcome_rejected(
        self, focus_fixture,
    ) -> None:
        await _seed_catalog(focus_fixture)
        await _start_session(focus_fixture)
        await _end_session(focus_fixture, expected_version=1)

        outcomes = (
            {
                "work_item_id": "l3-nonexistent",
                "touched": True,
                "result": "completed",
                "state_command": "none",
                "expected_work_item_version": 1,
            },
        )
        command = _review_command(
            expected_version=2, outcomes=outcomes,
        )
        with pytest.raises(MutationRejectedError) as captured:
            await focus_fixture.module.submit_review(focus_fixture.scope, command)
        assert captured.value.rejection.code in (
            "not_found", "work_item_structure_changed",
        )

    @pytest.mark.asyncio
    async def test_version_mismatch_on_review_rejected(
        self, focus_fixture,
    ) -> None:
        await _seed_catalog(focus_fixture)
        await _start_session(focus_fixture)
        await _end_session(focus_fixture, expected_version=1)

        command = _review_command(expected_version=99)
        with pytest.raises(MutationRejectedError) as captured:
            await focus_fixture.module.submit_review(focus_fixture.scope, command)
        assert captured.value.rejection.code == "version_conflict"

    @pytest.mark.asyncio
    async def test_invalid_result_value_rejected(self, focus_fixture) -> None:
        await _seed_catalog(focus_fixture)
        await _start_session(focus_fixture)
        await _end_session(focus_fixture, expected_version=1)

        outcomes = (
            {
                "work_item_id": "l3-a",
                "touched": True,
                "result": "bogus_result",
                "state_command": "none",
                "expected_work_item_version": 1,
            },
        )
        command = _review_command(
            expected_version=2, outcomes=outcomes,
        )
        with pytest.raises(MutationRejectedError) as captured:
            await focus_fixture.module.submit_review(focus_fixture.scope, command)
        assert captured.value.rejection.code == "work_item_structure_changed"
        assert captured.value.rejection.details["reason"] == "invalid_result"


# ---------------------------------------------------------------------------
# Tests: state_command=none creates no envelope
# ---------------------------------------------------------------------------

class TestStateCommandNoneNoEnvelope:
    """Outcome with state_command='none' must not produce a SessionCommandEnvelope."""

    @pytest.mark.asyncio
    async def test_none_outcome_creates_no_envelope(self, focus_fixture) -> None:
        from app.models.session_command import SessionCommandEnvelope
        from app.models.session_revision import SessionWorkItemOutcome

        await _seed_catalog(focus_fixture)
        await _start_session(focus_fixture)
        await _end_session(focus_fixture, expected_version=1)

        outcomes = (
            {
                "work_item_id": "l3-a",
                "touched": False,
                "result": "untouched",
                "state_command": "none",
                "expected_work_item_version": 1,
            },
        )
        await _submit_review(focus_fixture, expected_version=2, outcomes=outcomes)

        async with focus_fixture.scope.session_factory() as session:
            envelopes = (
                await session.execute(
                    select(SessionCommandEnvelope).where(
                        SessionCommandEnvelope.session_id == "fs-1"
                    )
                )
            ).scalars().all()
            outcome_rows = (
                await session.execute(
                    select(SessionWorkItemOutcome).where(
                        SessionWorkItemOutcome.session_id == "fs-1"
                    )
                )
            ).scalars().all()

        assert len(envelopes) == 0
        assert len(outcome_rows) == 1
        assert outcome_rows[0].state_command == "none"


# ---------------------------------------------------------------------------
# Tests: complete/cancel envelope uses correct status_definition_id hash
# ---------------------------------------------------------------------------

class TestEnvelopePayloadHash:
    """Envelope payload_hash must equal canonical_payload_hash of status_definition_id."""

    @pytest.mark.asyncio
    async def test_complete_envelope_hash_uses_completed_status_id(
        self, focus_fixture,
    ) -> None:
        from app.models.session_command import SessionCommandEnvelope

        await _seed_catalog(focus_fixture)
        await _start_session(focus_fixture)
        await _end_session(focus_fixture, expected_version=1)

        outcomes = (
            {
                "work_item_id": "l3-a",
                "touched": True,
                "result": "completed",
                "persona": "ox",
                "state_command": "complete",
                "expected_work_item_version": 1,
            },
        )
        await _submit_review(focus_fixture, expected_version=2, outcomes=outcomes)

        async with focus_fixture.scope.session_factory() as session:
            envelopes = (
                await session.execute(
                    select(SessionCommandEnvelope).where(
                        SessionCommandEnvelope.session_id == "fs-1"
                    )
                )
            ).scalars().all()

        assert len(envelopes) == 1
        env = envelopes[0]
        assert env.target_transition == "complete"
        expected_hash = canonical_payload_hash(
            {"status_definition_id": "status-done"}
        )
        assert env.payload_hash == expected_hash

    @pytest.mark.asyncio
    async def test_cancel_envelope_hash_uses_cancelled_status_id(
        self, focus_fixture,
    ) -> None:
        from app.models.session_command import SessionCommandEnvelope

        await _seed_catalog(focus_fixture)
        await _start_session(focus_fixture)
        await _end_session(focus_fixture, expected_version=1)

        outcomes = (
            {
                "work_item_id": "l3-a",
                "touched": True,
                "result": "cancelled",
                "persona": "pig",
                "state_command": "cancel",
                "expected_work_item_version": 1,
            },
        )
        await _submit_review(focus_fixture, expected_version=2, outcomes=outcomes)

        async with focus_fixture.scope.session_factory() as session:
            envelopes = (
                await session.execute(
                    select(SessionCommandEnvelope).where(
                        SessionCommandEnvelope.session_id == "fs-1"
                    )
                )
            ).scalars().all()

        assert len(envelopes) == 1
        env = envelopes[0]
        assert env.target_transition == "cancel"
        expected_hash = canonical_payload_hash(
            {"status_definition_id": "status-cancelled"}
        )
        assert env.payload_hash == expected_hash

    @pytest.mark.asyncio
    async def test_mixed_complete_and_none_outcomes_create_one_envelope(
        self, focus_fixture,
    ) -> None:
        from app.models.session_command import SessionCommandEnvelope

        await _seed_catalog(focus_fixture)
        await _start_session(focus_fixture)
        await _end_session(focus_fixture, expected_version=1)

        outcomes = (
            {
                "work_item_id": "l3-a",
                "touched": True,
                "result": "completed",
                "persona": "ox",
                "state_command": "complete",
                "expected_work_item_version": 1,
            },
            {
                "work_item_id": "l3-a",
                "touched": False,
                "result": "untouched",
                "state_command": "none",
                "expected_work_item_version": 1,
            },
        )
        await _submit_review(focus_fixture, expected_version=2, outcomes=outcomes)

        async with focus_fixture.scope.session_factory() as session:
            envelopes = (
                await session.execute(
                    select(SessionCommandEnvelope).where(
                        SessionCommandEnvelope.session_id == "fs-1"
                    )
                )
            ).scalars().all()

        # Only the "complete" outcome produces an envelope
        assert len(envelopes) == 1
        assert envelopes[0].target_transition == "complete"


# ---------------------------------------------------------------------------
# Tests: Corrected outcome appends new revision
# ---------------------------------------------------------------------------

class TestCorrectedOutcomeAppendsRevision:
    """Second review with corrected outcome appends a revision; old envelope remains."""

    @pytest.mark.asyncio
    async def test_corrected_outcome_appends_revision_and_preserves_envelope(
        self, focus_fixture,
    ) -> None:
        from app.models.session_command import SessionCommandEnvelope
        from app.models.session_revision import SessionWorkItemOutcome

        await _seed_catalog(focus_fixture)
        await _start_session(focus_fixture)
        await _end_session(focus_fixture, expected_version=1)

        first_outcomes = (
            {
                "work_item_id": "l3-a",
                "touched": True,
                "result": "progressed",
                "persona": "ox",
                "state_command": "none",
                "expected_work_item_version": 1,
            },
        )
        await _submit_review(
            focus_fixture, expected_version=2, outcomes=first_outcomes,
            command_id="review-1",
        )

        # The review advances the session version; second review uses version 3
        second_outcomes = (
            {
                "work_item_id": "l3-a",
                "touched": True,
                "result": "completed",
                "persona": "ox",
                "state_command": "complete",
                "expected_work_item_version": 1,
                "corrected_from_revision": 1,
            },
        )
        await _submit_review(
            focus_fixture, expected_version=3, outcomes=second_outcomes,
            reviewed_at="2026-07-15T08:31:00Z",
            command_id="review-2",
        )

        async with focus_fixture.scope.session_factory() as session:
            outcome_rows = (
                await session.execute(
                    select(SessionWorkItemOutcome)
                    .where(SessionWorkItemOutcome.session_id == "fs-1")
                    .where(SessionWorkItemOutcome.work_item_id == "l3-a")
                    .order_by(SessionWorkItemOutcome.revision)
                )
            ).scalars().all()
            envelopes = (
                await session.execute(
                    select(SessionCommandEnvelope).where(
                        SessionCommandEnvelope.session_id == "fs-1"
                    )
                )
            ).scalars().all()

        assert len(outcome_rows) == 2
        old, new = outcome_rows
        assert old.revision == 1
        assert old.effective is False
        assert old.result == "progressed"
        assert new.revision == 2
        assert new.effective is True
        assert new.result == "completed"
        assert new.state_command == "complete"
        assert new.corrected_from_revision == 1

        # The envelope from the corrected (effective) outcome exists
        assert len(envelopes) == 1
        assert envelopes[0].target_transition == "complete"


# ---------------------------------------------------------------------------
# Tests: Plan current/completion_draft changes don't mutate WorkItem
# ---------------------------------------------------------------------------

class TestPlanChangesDoNotMutateWorkItem:
    """Plan mutations (current, completion_draft) must never modify work_item rows."""

    @pytest.mark.asyncio
    async def test_set_current_plan_item_does_not_mutate_work_item(
        self, focus_fixture,
    ) -> None:
        from app.models.work_item import WorkItem

        await _seed_catalog(focus_fixture)
        await _start_session(focus_fixture)

        command = _set_current_plan_command(
            work_item_id=None,
            expected_plan_versions={"plan-fs-1-l3-a": 1},
        )
        await focus_fixture.module.set_current_plan_item(
            focus_fixture.scope, command,
        )

        async with focus_fixture.scope.session_factory() as session:
            l3 = (
                await session.execute(
                    select(WorkItem).where(WorkItem.id == "l3-a")
                )
            ).scalar_one()

        assert l3.version == 1
        assert l3.status_definition_id == "status-todo"

    @pytest.mark.asyncio
    async def test_set_completion_draft_does_not_mutate_work_item(
        self, focus_fixture,
    ) -> None:
        from app.models.work_item import WorkItem

        await _seed_catalog(focus_fixture)
        await _start_session(focus_fixture)

        command = _set_completion_draft_command(
            plan_item_id="plan-fs-1-l3-a",
            completion_draft=True,
            expected_plan_version=1,
        )
        await focus_fixture.module.set_completion_draft(
            focus_fixture.scope, command,
        )

        async with focus_fixture.scope.session_factory() as session:
            l3 = (
                await session.execute(
                    select(WorkItem).where(WorkItem.id == "l3-a")
                )
            ).scalar_one()

        assert l3.version == 1
        assert l3.status_definition_id == "status-todo"

    @pytest.mark.asyncio
    async def test_plan_changes_produce_no_work_item_sync_events(
        self, focus_fixture,
    ) -> None:
        await _seed_catalog(focus_fixture)
        await _start_session(focus_fixture)

        command = _set_current_plan_command(
            work_item_id=None,
            expected_plan_versions={"plan-fs-1-l3-a": 1},
        )
        await focus_fixture.module.set_current_plan_item(
            focus_fixture.scope, command,
        )

        events = await focus_fixture.mutation.visible_events(
            entity_type="workItem",
        )
        assert len(events) == 0


# ---------------------------------------------------------------------------
# Tests: Terminal local_provisional review promotion
# ---------------------------------------------------------------------------

class TestTerminalProvisionalReviewPromotion:
    """A terminal local_provisional session is promoted to authoritative on valid review.

    A pending local_provisional session contributes zero effort.  Once a
    valid review adjudicates it, ownership_state flips to authoritative and
    the WorkItem effort_actual_seconds is projected from focused_seconds.
    A subsequent invalid correction zeroes the effort again.
    """

    @pytest.mark.asyncio
    async def test_provisional_session_promoted_and_effort_projected(
        self, focus_fixture,
    ) -> None:
        from app.models.focus_session import FocusSession
        from app.models.work_item import WorkItem

        await _seed_catalog(focus_fixture)
        await _start_session(focus_fixture, level2_id="l2-a")
        # End with validity="pending".  The normal end command leaves
        # ownership_state="authoritative", so flip it to
        # "local_provisional" directly to model a terminal provisional
        # session awaiting adjudication.
        await _end_session(focus_fixture, expected_version=1, validity="pending")

        async with focus_fixture.scope.session_factory() as session:
            fs = (
                await session.execute(
                    select(FocusSession).where(FocusSession.id == "fs-1")
                )
            ).scalar_one()
            fs.ownership_state = "local_provisional"
            await session.commit()

        # A valid review promotes the provisional session to authoritative.
        await _submit_review(
            focus_fixture,
            expected_version=2,
            validity="valid",
            reviewed_at="2026-07-15T08:30:00Z",
            command_id="review-1",
        )

        async with focus_fixture.scope.session_factory() as session:
            fs = (
                await session.execute(
                    select(FocusSession).where(FocusSession.id == "fs-1")
                )
            ).scalar_one()
            l2 = (
                await session.execute(
                    select(WorkItem).where(WorkItem.id == "l2-a")
                )
            ).scalar_one()

        assert fs.ownership_state == "authoritative"
        assert fs.validity == "valid"
        assert fs.focused_seconds > 0
        assert l2.effort_actual_seconds == fs.focused_seconds

        # A subsequent invalid correction (new command_id) zeroes the effort.
        await _submit_review(
            focus_fixture,
            expected_version=3,
            validity="invalid",
            reviewed_at="2026-07-15T08:35:00Z",
            command_id="review-2",
        )

        async with focus_fixture.scope.session_factory() as session:
            l2 = (
                await session.execute(
                    select(WorkItem).where(WorkItem.id == "l2-a")
                )
            ).scalar_one()

        assert l2.effort_actual_seconds == 0


# ---------------------------------------------------------------------------
# Tests: Review timestamp monotonicity
# ---------------------------------------------------------------------------

class TestReviewTimestampMonotonicity:
    """Review timestamps must be strictly monotonic and never regress below ended_at."""

    @pytest.mark.asyncio
    async def test_same_reviewed_at_rejected_as_not_monotonic(
        self, focus_fixture,
    ) -> None:
        await _seed_catalog(focus_fixture)
        await _start_session(focus_fixture)
        await _end_session(focus_fixture, expected_version=1)

        # First review succeeds at 08:30.
        await _submit_review(
            focus_fixture,
            expected_version=2,
            reviewed_at="2026-07-15T08:30:00Z",
            command_id="review-1",
        )

        # Second review with the same reviewed_at is not strictly later than
        # the recorded review timestamp.
        with pytest.raises(MutationRejectedError) as captured:
            await _submit_review(
                focus_fixture,
                expected_version=3,
                reviewed_at="2026-07-15T08:30:00Z",
                command_id="review-2",
            )
        assert captured.value.rejection.code == "version_conflict"
        reason = captured.value.rejection.details.get("reason", "")
        assert reason in ("review_time_not_monotonic", "review_time_regression")

    @pytest.mark.asyncio
    async def test_reviewed_at_earlier_than_ended_at_rejected(
        self, focus_fixture,
    ) -> None:
        await _seed_catalog(focus_fixture)
        await _start_session(focus_fixture)
        await _end_session(
            focus_fixture, expected_version=1, occurred_at="2026-07-15T08:25:00Z",
        )

        # reviewed_at (08:20) is earlier than ended_at (08:25).
        with pytest.raises(MutationRejectedError) as captured:
            await _submit_review(
                focus_fixture,
                expected_version=2,
                reviewed_at="2026-07-15T08:20:00Z",
                command_id="review-1",
            )
        assert captured.value.rejection.code == "version_conflict"
        assert (
            captured.value.rejection.details.get("reason") == "review_time_regression"
        )


# ---------------------------------------------------------------------------
# Tests: Review idempotent replay
# ---------------------------------------------------------------------------

class TestReviewIdempotentReplay:
    """Replaying the same review command_id returns the original result without duplicates."""

    @pytest.mark.asyncio
    async def test_replay_same_command_returns_existing_state(
        self, focus_fixture,
    ) -> None:
        from app.models.session_command import SessionCommandEnvelope
        from app.models.session_revision import SessionWorkItemOutcome

        await _seed_catalog(focus_fixture)
        await _start_session(focus_fixture)
        await _end_session(focus_fixture, expected_version=1)

        outcomes = (
            {
                "work_item_id": "l3-a",
                "touched": True,
                "result": "progressed",
                "persona": "ox",
                "state_command": "none",
                "expected_work_item_version": 1,
            },
        )
        first = await _submit_review(
            focus_fixture,
            expected_version=2,
            outcomes=outcomes,
            reviewed_at="2026-07-15T08:30:00Z",
            command_id="review-1",
        )
        assert first.value["session"]["reviewState"] == "completed"

        # Replay the exact same command (same command_id + reviewed_at + payload).
        second = await _submit_review(
            focus_fixture,
            expected_version=2,
            outcomes=outcomes,
            reviewed_at="2026-07-15T08:30:00Z",
            command_id="review-1",
        )
        assert second.value["session"]["reviewState"] == "completed"

        async with focus_fixture.scope.session_factory() as session:
            outcome_rows = (
                await session.execute(
                    select(SessionWorkItemOutcome).where(
                        SessionWorkItemOutcome.session_id == "fs-1"
                    )
                )
            ).scalars().all()
            envelopes = (
                await session.execute(
                    select(SessionCommandEnvelope).where(
                        SessionCommandEnvelope.session_id == "fs-1"
                    )
                )
            ).scalars().all()

        # No duplicate outcomes or envelopes were created by the replay.
        assert len(outcome_rows) == 1
        assert len(envelopes) == 0


# ---------------------------------------------------------------------------
# Tests: replay_safe fails closed without a Task Space policy
# ---------------------------------------------------------------------------

class TestReplaySafeBlocksWhenNoPolicy:
    """When replay_safe has no Task Space policy source, state_command reviews fail closed.

    _resolve_replay_safe raises MutationRuleViolation (a RuntimeError subclass)
    which the UoW surfaces as MutationRejectedError.  Until a Task Space
    declaration path is added, any outcome carrying state_command=complete or
    cancel must be rejected with ``missing_task_space_replay_safe_policy``.
    """

    @pytest.mark.asyncio
    async def test_complete_outcome_blocks_without_replay_safe_policy(
        self, focus_fixture,
    ) -> None:
        # Exercise the fail-closed path explicitly.  The shared fixture uses
        # the real Task Space declaration so the normal envelope tests can
        # succeed; removing it here models a miscomposed server.
        focus_fixture.policy._replay_safe_policy = None
        await _seed_catalog(focus_fixture)
        await _start_session(focus_fixture)
        await _end_session(focus_fixture, expected_version=1)

        outcomes = (
            {
                "work_item_id": "l3-a",
                "touched": True,
                "result": "completed",
                "persona": "ox",
                "state_command": "complete",
                "expected_work_item_version": 1,
            },
        )
        with pytest.raises(MutationRejectedError) as captured:
            await _submit_review(
                focus_fixture,
                expected_version=2,
                outcomes=outcomes,
                reviewed_at="2026-07-15T08:30:00Z",
                command_id="review-1",
            )
        assert captured.value.rejection.code == "work_item_structure_changed"
        assert (
            captured.value.rejection.details.get("reason")
            == "missing_task_space_replay_safe_policy"
        )
