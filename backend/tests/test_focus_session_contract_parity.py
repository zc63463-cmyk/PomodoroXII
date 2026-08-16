"""Regression tests for the FocusSession aggregate and reconciliation seam."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from app.errors import AppError
from app.focus_session.commands import focus_business_payload
from app.focus_session.contracts import FocusSessionCommand, FocusSessionView
from app.focus_session.module import DefaultFocusSessionModule
from app.focus_session.policy import (
    _to_camel_attribution,
    _to_camel_context,
    _to_camel_outcome,
    _to_camel_plan,
    _to_camel_session,
)
from app.focus_session.query import _work_item_snapshot
from app.mutation.types import canonical_payload_hash
from app.schemas.focus_session import FocusSessionAggregateResponse


def _valid_aggregate() -> dict[str, object]:
    timestamp = "2026-08-04T08:00:00.000Z"
    return {
        "session": {
            "id": "session-1",
            "spaceId": "space-1",
            "createdAt": timestamp,
            "updatedAt": timestamp,
            "version": 1,
            "sessionRevision": 1,
            "startedAt": timestamp,
            "endedAt": None,
            "pauseStartedAt": None,
            "plannedSeconds": 1500,
            "grossSeconds": 0,
            "pausedSeconds": 0,
            "breakSeconds": 0,
            "focusedSeconds": 0,
            "timerCompletion": None,
            "validity": "pending",
            "validityReason": None,
            "overallProgress": None,
            "mood": None,
            "sessionNote": "",
            "reviewState": "not_required",
            "ownershipState": "authoritative",
        },
        "context": {
            "id": "context-1",
            "spaceId": "space-1",
            "createdAt": timestamp,
            "updatedAt": timestamp,
            "version": 1,
            "sessionId": "session-1",
            "projectId": "project-1",
            "level2WorkItemId": "level2-1",
            "projectTitleSnapshot": "Project",
            "level2TitleSnapshot": "Level 2",
            "level2ParentIdSnapshot": None,
            "level2StatusDefinitionIdSnapshot": "sys-status-in-progress",
            "level2VersionSnapshot": 2,
            "level2EffortLowerSecondsSnapshot": 600,
            "level2EffortUpperSecondsSnapshot": 1800,
            "linkedAt": timestamp,
            "linkMethod": "explicit",
        },
        "attribution": {
            "id": "attribution-1",
            "spaceId": "space-1",
            "createdAt": timestamp,
            "updatedAt": timestamp,
            "version": 1,
            "sessionId": "session-1",
            "revision": 1,
            "projectId": "project-1",
            "level2WorkItemId": "level2-1",
            "reason": None,
            "correctedFromRevision": None,
            "effective": True,
        },
        "plan": [{
            "id": "plan-1",
            "spaceId": "space-1",
            "createdAt": timestamp,
            "updatedAt": timestamp,
            "version": 1,
            "sessionId": "session-1",
            "workItemId": "level3-1",
            "titleSnapshot": "Level 3",
            "level2WorkItemIdSnapshot": "level2-1",
            "workItemVersionSnapshot": 3,
            "planRank": 0,
            "source": "before_start",
            "addedAt": timestamp,
            "removedAt": None,
            "removalReason": None,
            "currentDuringSession": True,
            "completionDraft": False,
        }],
        "outcomes": [],
        "commandEnvelopes": [],
        "commandReceipts": [],
    }


def test_focus_session_response_rejects_legacy_snapshot_shape() -> None:
    legacy = _valid_aggregate()
    context = dict(legacy["context"])
    context.pop("projectTitleSnapshot")
    context["titleSnapshot"] = "legacy"
    legacy["context"] = context
    with pytest.raises(ValidationError):
        FocusSessionAggregateResponse.model_validate(legacy)


def test_focus_session_response_requires_one_effective_attribution() -> None:
    legacy = _valid_aggregate()
    legacy["attribution"] = [legacy["attribution"]]
    with pytest.raises(ValidationError):
        FocusSessionAggregateResponse.model_validate(legacy)


def test_policy_projectors_match_strict_aggregate_vocabulary() -> None:
    timestamp = "2026-08-04T08:00:00.000Z"
    session = _to_camel_session({
        "id": "session-1",
        "created_at": timestamp,
        "updated_at": timestamp,
        "version": 1,
        "session_revision": 1,
        "started_at": timestamp,
        "ended_at": None,
        "pause_started_at": None,
        "planned_seconds": 1,
        "gross_seconds": 0,
        "paused_seconds": 0,
        "break_seconds": 0,
        "focused_seconds": 0,
        "timer_completion": None,
        "validity": "pending",
        "validity_reason": None,
        "overall_progress": None,
        "mood": None,
        "session_note": "",
        "review_state": "not_required",
        "ownership_state": "authoritative",
    }, "space-1")
    context = _to_camel_context({
        "id": "context-1",
        "created_at": timestamp,
        "updated_at": timestamp,
        "version": 1,
        "session_id": "session-1",
        "project_id": "project-1",
        "level2_work_item_id": "level2-1",
        "title_snapshot": "Level 2",
        "parent_snapshot": None,
        "estimate_snapshot": "1800",
        "status_snapshot": "sys-status-in-progress",
        "structure_snapshot": '{"project":{"name":"Project"},"level2":{"id":"level2-1","title":"Level 2","parent_id":null,"status_definition_id":"sys-status-in-progress","version":2,"effort_estimate_lower_seconds":600,"effort_estimate_upper_seconds":1800}}',
        "linked_at": timestamp,
        "link_method": "manual",
    }, "space-1")
    attribution = _to_camel_attribution({
        "id": "attribution-1", "created_at": timestamp, "updated_at": timestamp,
        "version": 1, "session_id": "session-1", "revision": 1,
        "project_id": "project-1", "level2_work_item_id": "level2-1",
        "reason": None, "corrected_from_revision": None, "effective": True,
    }, "space-1")
    plan = _to_camel_plan({
        "id": "plan-1", "created_at": timestamp, "updated_at": timestamp,
        "version": 1, "session_id": "session-1", "work_item_id": "level3-1",
        "title_snapshot": "Level 3", "level2_snapshot": "level2-1",
        "plan_rank": 0, "source": "before_start", "added_at": timestamp,
        "removed_at": None, "removal_reason": None,
        "current_during_session": True, "completion_draft": False,
    }, "space-1", {"level2":{"id":"level2-1"},"plan":{"level3-1":{"parent_id":"level2-1","version":3}}})
    outcome = _to_camel_outcome({
        "id": "outcome-1", "created_at": timestamp, "updated_at": timestamp,
        "version": 1, "session_id": "session-1", "session_revision": 2,
        "revision": 1, "corrected_from_revision": None, "effective": True,
        "work_item_id": "level3-1", "touched": True, "result": "progressed",
        "persona": "legacy", "execution_persona": "ox",
        "persona_switched": False, "persona_note": None, "state_command": "none",
        "command_id": None, "reviewed_at": timestamp,
    }, "space-1")

    assert session["spaceId"] == "space-1"
    assert context["projectTitleSnapshot"] == "Project"
    assert context["level2VersionSnapshot"] == 2
    assert attribution["spaceId"] == "space-1"
    assert plan["workItemVersionSnapshot"] == 3
    assert "persona" not in outcome
    assert outcome["executionPersona"] == "ox"


def test_malformed_frozen_context_snapshot_fails_closed_without_live_fallback() -> None:
    context = SimpleNamespace(
        structure_snapshot="{\"level2\":{\"title\":\"old\"}}",
        title_snapshot="live title",
        parent_snapshot=None,
        status_snapshot="status-live",
        level2_work_item_id="level2-1",
    )
    with pytest.raises(AppError) as captured:
        _work_item_snapshot(context, SimpleNamespace(name="Live"), project=SimpleNamespace(name="Project"))
    assert captured.value.code == "active_session_recovery_required"
    assert captured.value.details["reason"] == "invalid_frozen_work_item_snapshot"



@pytest.mark.asyncio
async def test_reconcile_module_delegates_closed_admission_to_reconciler() -> None:
    payload = {
        "command_ids": ["envelope-1"],
        "replay_safe": True,
        "abandon_command_ids": [],
        "decision_at": None,
    }
    command = FocusSessionCommand(
        command_id="root-1",
        space_id="space-1",
        session_id="session-1",
        ownership_epoch=None,
        payload_hash=canonical_payload_hash(
            focus_business_payload("reconcile_commands", payload)
        ),
        payload=payload,
    )

    class FakeUow:
        async def execute(self, scope, request, operation_id):
            return SimpleNamespace(value={
                "ordered_command_ids": ["envelope-1"],
                "decisions": {
                    "envelope-1": {
                        "kind": "observe",
                        "receipt_state": "pending",
                    },
                },
            })

    class FakeQuery:
        async def load(self, scope, session_id):
            return {"session": {
                "id": session_id,
                "startedAt": "2026-08-04T08:00:00.000Z",
                "pauseStartedAt": None,
                "endedAt": None,
            }}

    class FakeReconciler:
        def __init__(self) -> None:
            self.calls = []

        async def reconcile(self, scope, command, *, admission):
            self.calls.append((scope, command, admission))
            return FocusSessionView(value={"session": {
                "id": command.session_id,
                "startedAt": "2026-08-04T08:00:00.000Z",
                "pauseStartedAt": None,
                "endedAt": None,
            }})

    reconciler = FakeReconciler()
    module = DefaultFocusSessionModule(
        uow=FakeUow(), query=FakeQuery(), reconciler=reconciler,
    )
    scope = SimpleNamespace(scope=SimpleNamespace(space_id="space-1"))
    result = await module.reconcile_commands(scope, command)

    assert result.value["session"]["id"] == "session-1"
    assert reconciler.calls[0][2]["ordered_command_ids"] == ["envelope-1"]
