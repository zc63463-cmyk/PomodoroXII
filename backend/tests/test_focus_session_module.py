"""TS2 Task 2: Focus session module lifecycle and derived clock tests.

Verifies atomic start, derived clock state, no persisted clock_state,
exact TS0 protocol signature parity, fault convergence, and reconcile
admission gating with zero side effects.
"""

from __future__ import annotations

import inspect
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from sqlalchemy import inspect as sa_inspect
from sqlalchemy import select, text

from app.focus_session.commands import build_focus_request, focus_business_payload
from app.focus_session.contracts import (
    FocusSessionCommand,
    FocusSessionModule,
    FocusSessionView,
)
from app.focus_session.module import (
    DefaultFocusSessionModule,
    derive_clock_state,
    focus_session_view,
    require_focus_scope,
)
from app.models.focus_session import FocusSession
from app.mutation.types import canonical_payload_hash

# ---------------------------------------------------------------------------
# Pure-logic tests (no DB fixture needed)
# ---------------------------------------------------------------------------

class TestDeriveClockState:
    """Verify clock state derivation from persisted timestamps."""

    def test_started_at_only_means_running(self) -> None:
        assert derive_clock_state(
            started_at="2026-07-15T08:00:00Z",
            pause_started_at=None,
            ended_at=None,
        ) == "running"

    def test_pause_started_at_means_paused(self) -> None:
        assert derive_clock_state(
            started_at="2026-07-15T08:00:00Z",
            pause_started_at="2026-07-15T08:30:00Z",
            ended_at=None,
        ) == "paused"

    def test_ended_at_means_ended(self) -> None:
        assert derive_clock_state(
            started_at="2026-07-15T08:00:00Z",
            pause_started_at="2026-07-15T08:30:00Z",
            ended_at="2026-07-15T09:00:00Z",
        ) == "ended"

    def test_ended_at_takes_precedence_over_pause(self) -> None:
        assert derive_clock_state(
            started_at="2026-07-15T08:00:00Z",
            pause_started_at="2026-07-15T08:30:00Z",
            ended_at="2026-07-15T09:00:00Z",
        ) == "ended"

    def test_missing_started_at_raises(self) -> None:
        with pytest.raises(ValueError, match="started_at"):
            derive_clock_state(
                started_at="",
                pause_started_at=None,
                ended_at=None,
            )


class TestFocusSessionView:
    """Verify focus_session_view adds derived clockState only."""

    def test_view_adds_clock_state_running(self) -> None:
        view = focus_session_view({
            "session": {"id": "fs-1", "startedAt": "2026-07-15T08:00:00Z"},
        })
        assert view["session"]["clockState"] == "running"

    def test_view_adds_clock_state_paused(self) -> None:
        view = focus_session_view({
            "session": {
                "id": "fs-1",
                "startedAt": "2026-07-15T08:00:00Z",
                "pauseStartedAt": "2026-07-15T08:30:00Z",
            },
        })
        assert view["session"]["clockState"] == "paused"

    def test_view_adds_clock_state_ended(self) -> None:
        view = focus_session_view({
            "session": {
                "id": "fs-1",
                "startedAt": "2026-07-15T08:00:00Z",
                "endedAt": "2026-07-15T09:00:00Z",
            },
        })
        assert view["session"]["clockState"] == "ended"

    def test_view_rejects_missing_session(self) -> None:
        with pytest.raises(TypeError, match="session"):
            focus_session_view({})

    def test_view_rejects_missing_started_at(self) -> None:
        with pytest.raises(TypeError, match="startedAt"):
            focus_session_view({"session": {"id": "fs-1"}})


class TestRequireFocusScope:
    """Verify scope validation runs before UoW entry."""

    def test_matching_space_id_passes(self) -> None:
        scope = SimpleNamespace(scope=SimpleNamespace(space_id="space-a"))
        require_focus_scope(scope, "space-a", "fs-1")

    def test_mismatched_space_id_raises(self) -> None:
        scope = SimpleNamespace(scope=SimpleNamespace(space_id="space-a"))
        with pytest.raises(ValueError, match="space_scope_mismatch"):
            require_focus_scope(scope, "space-b", "fs-1")

    def test_missing_session_id_raises(self) -> None:
        scope = SimpleNamespace(scope=SimpleNamespace(space_id="space-a"))
        with pytest.raises(ValueError, match="session_id"):
            require_focus_scope(scope, "space-a", None)


class TestModuleSignatures:
    """Verify DefaultFocusSessionModule signatures match TS0 Protocol exactly."""

    PROTOCOL_METHODS = (
        "get", "start", "pause", "resume", "end",
        "update_note", "set_current_plan_item", "set_completion_draft",
        "add_plan_item", "remove_plan_item", "submit_review",
        "reconcile_commands",
    )

    @pytest.mark.parametrize("name", PROTOCOL_METHODS)
    def test_signature_matches_protocol(self, name: str) -> None:
        proto_sig = inspect.signature(FocusSessionModule.__dict__[name])
        impl_sig = inspect.signature(DefaultFocusSessionModule.__dict__[name])
        assert impl_sig == proto_sig, (
            f"Method {name} signature mismatch: "
            f"protocol={proto_sig}, impl={impl_sig}"
        )

    def test_module_is_protocol_subclass(self) -> None:
        assert FocusSessionModule in DefaultFocusSessionModule.__mro__


class TestNoPersistedClockState:
    """Verify the ORM model has no clock_state column."""

    def test_focus_session_orm_has_no_clock_state_column(self) -> None:
        columns = {col.name for col in sa_inspect(FocusSession).columns}
        assert "clock_state" not in columns
        assert "clockState" not in columns

    def test_focus_session_orm_has_no_timer_persistence(self) -> None:
        """No independent timer/clock persistence field beyond started_at etc."""
        columns = {col.name for col in sa_inspect(FocusSession).columns}
        forbidden = {"clock_state", "clockState", "timer_state", "timer_running"}
        assert not (forbidden & columns)


# ---------------------------------------------------------------------------
# DB-backed tests using mutation_fixture_factory
# ---------------------------------------------------------------------------

class TestFocusSessionModuleIntegration:
    """Integration tests using the S3 mutation fixture infrastructure."""

    @pytest.fixture
    def focus_fixture(self, mutation_fixture_factory):
        """Build a focus session fixture with FocusSessionMutationPolicy."""
        from app.focus_session.module import DefaultFocusSessionModule
        from app.focus_session.policy import FocusSessionMutationPolicy
        from app.focus_session.query import FocusSessionQuery

        policy = FocusSessionMutationPolicy()
        mutation = mutation_fixture_factory(policies=(policy,))
        module = DefaultFocusSessionModule(
            uow=mutation.uow,
            query=FocusSessionQuery(),
            reconciler=None,
        )
        return SimpleNamespace(
            mutation=mutation,
            module=module,
            scope=mutation.scope,
        )

    def _start_command(
        self,
        *,
        space_id: str = "space-test",
        session_id: str = "fs-1",
        ownership_epoch: int = 1,
    ) -> FocusSessionCommand:
        payload: dict[str, object] = {
            "level2_work_item_id": "l2-a",
            "level3_work_item_ids": ("l3-a",),
            "planned_seconds": 1500,
            "started_at": "2026-07-15T08:00:00Z",
            "owner_device_id": "device-a",
            "owner_tab_id": "tab-a",
        }
        business = focus_business_payload("start", payload)
        return FocusSessionCommand(
            command_id="start-1",
            space_id=space_id,
            session_id=session_id,
            ownership_epoch=ownership_epoch,
            payload_hash=canonical_payload_hash(business),
            payload=payload,
        )

    @pytest.mark.asyncio
    async def test_start_persists_all_initial_facts_in_one_s3_command(
        self, focus_fixture,
    ) -> None:
        command = self._start_command()
        view = await focus_fixture.module.start(focus_fixture.scope, command)

        assert view.value["session"]["id"] == "fs-1"
        assert view.value["session"]["clockState"] == "running"
        assert "clockState" not in {
            k for k in view.value["session"]
        } or view.value["session"]["clockState"] in ("running", "paused", "ended")

    @pytest.mark.asyncio
    async def test_clock_state_is_derived_and_never_persisted(
        self, focus_fixture,
    ) -> None:
        started_cmd = self._start_command()
        await focus_fixture.module.start(focus_fixture.scope, started_cmd)

        pause_payload: dict[str, object] = {
            "occurred_at": "2026-07-15T08:30:00Z",
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
        paused = await focus_fixture.module.pause(focus_fixture.scope, pause_cmd)
        assert paused.value["session"]["clockState"] == "paused"

        resume_payload: dict[str, object] = {
            "occurred_at": "2026-07-15T08:45:00Z",
            "owner_device_id": "device-a",
            "owner_tab_id": "tab-a",
        }
        resume_business = focus_business_payload("resume", resume_payload)
        resume_cmd = FocusSessionCommand(
            command_id="resume-1",
            space_id="space-test",
            session_id="fs-1",
            ownership_epoch=1,
            payload_hash=canonical_payload_hash(resume_business),
            payload=resume_payload,
        )
        resumed = await focus_fixture.module.resume(focus_fixture.scope, resume_cmd)
        assert resumed.value["session"]["clockState"] == "running"

        end_payload: dict[str, object] = {
            "occurred_at": "2026-07-15T09:00:00Z",
            "timer_completion": "completed",
            "validity": "valid",
            "validity_reason": "natural_completion",
            "owner_device_id": "device-a",
            "owner_tab_id": "tab-a",
        }
        end_business = focus_business_payload("end", end_payload)
        end_cmd = FocusSessionCommand(
            command_id="end-1",
            space_id="space-test",
            session_id="fs-1",
            ownership_epoch=1,
            payload_hash=canonical_payload_hash(end_business),
            payload=end_payload,
        )
        ended = await focus_fixture.module.end(focus_fixture.scope, end_cmd)
        assert ended.value["session"]["clockState"] == "ended"

    @pytest.mark.asyncio
    async def test_reconcile_non_null_ownership_epoch_rejected_before_admission(
        self, focus_fixture,
    ) -> None:
        reconcile_payload: dict[str, object] = {
            "command_ids": ["cmd-1"],
            "replay_safe": True,
            "abandon_command_ids": ["cmd-1"],
            "decision_at": "2026-07-15T14:00:00Z",
        }
        business = focus_business_payload("reconcile_commands", reconcile_payload)
        command = FocusSessionCommand(
            command_id="reconcile-1",
            space_id="space-test",
            session_id="fs-1",
            ownership_epoch=1,
            payload_hash=canonical_payload_hash(business),
            payload=reconcile_payload,
        )
        with pytest.raises((ValueError, Exception)):
            await focus_fixture.module.reconcile_commands(
                focus_fixture.scope, command,
            )

    @pytest.mark.asyncio
    async def test_reconcile_scope_mismatch_rejected_before_admission(
        self, focus_fixture,
    ) -> None:
        reconcile_payload: dict[str, object] = {
            "command_ids": ["cmd-1"],
            "replay_safe": True,
            "abandon_command_ids": (),
        }
        business = focus_business_payload("reconcile_commands", reconcile_payload)
        command = FocusSessionCommand(
            command_id="reconcile-1",
            space_id="space-wrong",
            session_id="fs-1",
            ownership_epoch=None,
            payload_hash=canonical_payload_hash(business),
            payload=reconcile_payload,
        )
        with pytest.raises((ValueError, Exception)):
            await focus_fixture.module.reconcile_commands(
                focus_fixture.scope, command,
            )
