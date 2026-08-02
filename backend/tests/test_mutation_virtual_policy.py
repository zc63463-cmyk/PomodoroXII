from __future__ import annotations

import pytest

from app.errors import SpaceRecoveryRequiredError
from app.mutation.types import (
    DbMutationPlan,
    MutationCommand,
    MutationRequest,
    SyncEventPlan,
)
from app.mutation.unit_of_work import _validate_compiled_command
from app.registry import CATALOG

PROJECT_ROW = {
    "id": "virtual-project",
    "key": "VP",
    "name": "Virtual policy",
    "description": None,
    "next_work_item_number": 1,
    "rank": 0,
    "default_status_definition_id": "sys-status-not-started",
    "default_type_definition_id": "sys-type-work-item",
    "archived_at": None,
    "created_at": "2026-01-01T00:00:00.000Z",
    "updated_at": "2026-01-01T00:00:00.000Z",
    "version": 1,
}


def _virtual_project_command(*, request_name: str = "virtual.CreateProject") -> MutationCommand:
    request = MutationRequest.from_payload(
        name=request_name,
        entity_type="virtual",
        entity_id="virtual-command",
        payload={"space_id": "space-test"},
        expected_version=None,
    )
    return MutationCommand.from_effects(
        request=request,
        db_plans=(
            DbMutationPlan(
                "projects",
                {"id": PROJECT_ROW["id"]},
                "insert",
                None,
                None,
                PROJECT_ROW,
            ),
        ),
        projections=(),
        sync_events=(
            SyncEventPlan(
                "project",
                str(PROJECT_ROW["id"]),
                "create",
                PROJECT_ROW,
                1,
                str(PROJECT_ROW["created_at"]),
            ),
        ),
        result_value=PROJECT_ROW,
    )


def test_compiled_command_accepts_namespaced_virtual_policy_intent() -> None:
    _validate_compiled_command(_virtual_project_command(), CATALOG)


def test_compiled_command_rejects_unknown_entity_action_as_virtual_intent() -> None:
    with pytest.raises(
        SpaceRecoveryRequiredError,
        match="outside the compiled catalog",
    ):
        _validate_compiled_command(
            _virtual_project_command(request_name="entity.create"),
            CATALOG,
        )
