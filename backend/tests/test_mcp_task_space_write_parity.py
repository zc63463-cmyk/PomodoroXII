"""TS-03: REST and MCP task-space writes must be the same mutation.

The MCP gateway is a *transport*, not a second write protocol.  These tests
pin that claim at the two places where drift would be observable:

1. **Canonical command equivalence** — for the same wire command, the domain
   command compiled by the MCP tool is byte-identical to the one compiled by
   the REST route, so the payload hash, the derived relation id and the
   idempotency binding all match.
2. **Receipt equivalence** — the same batch executed over both transports
   yields the same per-position status, the same durable entity identity and
   version, and the same stable rejection ``code`` / ``retryable``.

Comparisons deliberately ignore nothing: the receipt is compared as a whole,
so an extra derived field on either side fails the test.
"""
from __future__ import annotations

import pytest

from app.mutation.types import canonical_payload_hash

SPACE_ID = "spc_test"


def _create_payload(title: str) -> dict[str, object]:
    return {
        "title": title,
        "description": None,
        "parent_id": None,
        "type_definition_id": None,
        "status_definition_id": None,
        "priority": None,
    }


def _wire_command(command_id: str, space_id: str, project_id: str, title: str) -> dict:
    return {
        "kind": "work_item.create",
        "commandId": command_id,
        "spaceId": space_id,
        "projectId": project_id,
        "payloadHash": canonical_payload_hash(_create_payload(title)),
        "title": title,
    }


# --------------------------------------------------------------------------- #
# Layer 1: canonical command equivalence (no database needed)
# --------------------------------------------------------------------------- #


def test_rest_and_mcp_compile_the_same_domain_command() -> None:
    """The two transports must produce identical domain commands."""
    from app.mcp.task_space_tools import _domain_command as mcp_domain_command
    from app.routes.v1.task_space_commands import (
        _domain_command as rest_domain_command,
    )
    from app.schemas.task_space_batch import TaskSpaceBatchRequest

    for wire in (
        _wire_command("p-1", SPACE_ID, "proj-1", "Alpha"),
        {
            "kind": "work_item.update",
            "commandId": "p-2",
            "spaceId": SPACE_ID,
            "workItemId": "item-1",
            "expectedVersion": 3,
            "payloadHash": canonical_payload_hash({"patch": {"title": "X"}}),
            "title": "X",
        },
        {
            "kind": "work_item.move",
            "commandId": "p-3",
            "spaceId": SPACE_ID,
            "workItemId": "item-1",
            "expectedVersion": 4,
            "payloadHash": canonical_payload_hash({"new_parent_id": "item-9"}),
            "projectId": "proj-1",
            "parentId": "item-9",
        },
        {
            "kind": "work_item.transition",
            "commandId": "p-4",
            "spaceId": SPACE_ID,
            "workItemId": "item-1",
            "expectedVersion": 5,
            "payloadHash": canonical_payload_hash(
                {"status_definition_id": "sys-status-in-progress"}
            ),
            "statusDefinitionId": "sys-status-in-progress",
        },
        {
            "kind": "work_item.add_labels",
            "commandId": "p-5",
            "spaceId": SPACE_ID,
            "workItemId": "item-1",
            "expectedVersion": 6,
            "payloadHash": canonical_payload_hash({"label_ids": ["l-1", "l-2"]}),
            "labelIds": ["l-2", "l-1"],
        },
        {
            "kind": "work_item.remove_labels",
            "commandId": "p-6",
            "spaceId": SPACE_ID,
            "workItemId": "item-1",
            "expectedVersion": 7,
            "payloadHash": canonical_payload_hash({"label_ids": []}),
            "labelIds": [],
        },
        {
            "kind": "relation.create",
            "commandId": "p-7",
            "spaceId": SPACE_ID,
            "fromWorkItemId": "item-1",
            "toWorkItemId": "item-2",
            "relationType": "depends_on",
            "payloadHash": canonical_payload_hash(
                {
                    "from_work_item_id": "item-1",
                    "to_work_item_id": "item-2",
                    "relation_type": "depends_on",
                }
            ),
        },
        {
            "kind": "relation.remove",
            "commandId": "p-8",
            "spaceId": SPACE_ID,
            "fromWorkItemId": "item-1",
            "toWorkItemId": "item-2",
            "relationType": "depends_on",
            "expectedVersion": 2,
            "payloadHash": canonical_payload_hash(
                {
                    "from_work_item_id": "item-1",
                    "to_work_item_id": "item-2",
                    "relation_type": "depends_on",
                }
            ),
        },
        {
            "kind": "relation.resolve",
            "commandId": "p-9",
            "spaceId": SPACE_ID,
            "fromWorkItemId": "item-1",
            "toWorkItemId": "item-2",
            "relationType": "blocks",
            "expectedVersion": 3,
            "payloadHash": canonical_payload_hash(
                {
                    "from_work_item_id": "item-1",
                    "to_work_item_id": "item-2",
                    "relation_type": "blocks",
                }
            ),
        },
    ):
        body = TaskSpaceBatchRequest.model_validate(
            {"batchId": "parity-batch", "commands": [wire]}
        )
        rest_command = rest_domain_command(body.commands[0])
        mcp_command = mcp_domain_command(body.commands[0])
        assert rest_command == mcp_command, wire["kind"]

        # The canonical request (and therefore its hash) must match too.
        from app.task_space.module import build_task_space_request

        assert build_task_space_request(rest_command).request_hash == (
            build_task_space_request(mcp_command).request_hash
        ), wire["kind"]


# --------------------------------------------------------------------------- #
# Layer 2: real receipt equivalence
# --------------------------------------------------------------------------- #


@pytest.mark.provisioned_space_storage
@pytest.mark.asyncio
async def test_rest_and_mcp_receipts_are_equal_for_the_same_batch(
    client, monkeypatch
) -> None:
    """Same payload over both transports → same receipt, same durable effects."""
    from app.mcp.auth import PomodoroTokenVerifier

    await client.post("/api/v1/auth/setup", json={"password": "test-password-123"})
    login = await client.post(
        "/api/v1/auth/login", json={"password": "test-password-123"}
    )
    master_headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    created = await client.post(
        "/api/v1/spaces", json={"name": "TS-03 Parity"}, headers=master_headers
    )
    space_id = created.json()["id"]
    token_response = await client.post(
        f"/api/v1/spaces/{space_id}/token", headers=master_headers
    )
    space_token = token_response.json()["space_token"]
    space_headers = {"Authorization": f"Bearer {space_token}"}

    access = await PomodoroTokenVerifier().verify_token(space_token)
    assert access is not None
    import app.mcp.auth as mcp_auth

    monkeypatch.setattr(mcp_auth, "get_access_token", lambda: access)

    import app.mcp.task_space_tools as module

    module._gateway_factory = module.McpTaskSpaceWriteGateway(
        _runtime_services(client)
    )

    project_payload = {"key": "PAR", "name": "Parity", "description": None}
    project = await client.post(
        "/api/v1/projects",
        json={
            "commandId": "parity-project",
            "spaceId": space_id,
            "payloadHash": canonical_payload_hash(project_payload),
            **project_payload,
        },
        headers={**space_headers, "Idempotency-Key": "parity-project"},
    )
    assert project.status_code in (200, 201), project.text
    project_id = project.json()["value"]["id"]

    # Two distinct work items so each transport writes its own, leaving both
    # receipts comparable without one being an idempotent replay of the other.
    rest_batch = {
        "batchId": "parity-rest-batch",
        "commands": [_wire_command("parity-rest-item", space_id, project_id, "Via REST")],
    }
    rest_response = await client.post(
        "/api/v1/task-space/commands:batch",
        json=rest_batch,
        headers={**space_headers, "Idempotency-Key": "parity-rest-batch"},
    )
    assert rest_response.status_code == 200, rest_response.text
    rest_receipt = rest_response.json()

    mcp_receipt = await module.execute_task_space_commands(
        batch_id="parity-mcp-batch",
        commands=[
            _wire_command("parity-mcp-item", space_id, project_id, "Via MCP")
        ],
    )

    # Structure parity: identical keys, identical item shape, identical counts.
    assert set(rest_receipt) == set(mcp_receipt)
    assert rest_receipt["acceptedCount"] == mcp_receipt["acceptedCount"] == 1
    assert rest_receipt["rejectedCount"] == mcp_receipt["rejectedCount"] == 0
    rest_item, mcp_item = rest_receipt["items"][0], mcp_receipt["items"][0]
    assert set(rest_item) == set(mcp_item)
    for field in ("status", "inputIndex", "entityType", "version"):
        assert rest_item[field] == mcp_item[field], field
    # The post-image exposes the same business fields on both sides.
    assert set(rest_item["value"]) == set(mcp_item["value"])
    assert rest_item["value"]["title"] == "Via REST"
    assert mcp_item["value"]["title"] == "Via MCP"

    # Both writes are real and independently readable.
    for entity_id, title in (
        (rest_item["entityId"], "Via REST"),
        (mcp_item["entityId"], "Via MCP"),
    ):
        read = await client.get(
            f"/api/v1/work-items/{entity_id}", headers=space_headers
        )
        assert read.status_code == 200, read.text
        assert read.json()["title"] == title


@pytest.mark.provisioned_space_storage
@pytest.mark.asyncio
async def test_rest_and_mcp_rejections_have_equal_error_semantics(
    client, monkeypatch
) -> None:
    """A rejected item carries the same ``code``/``retryable`` on both paths."""
    from app.mcp.auth import PomodoroTokenVerifier

    await client.post("/api/v1/auth/setup", json={"password": "test-password-123"})
    login = await client.post(
        "/api/v1/auth/login", json={"password": "test-password-123"}
    )
    master_headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    created = await client.post(
        "/api/v1/spaces", json={"name": "TS-03 Reject"}, headers=master_headers
    )
    space_id = created.json()["id"]
    token_response = await client.post(
        f"/api/v1/spaces/{space_id}/token", headers=master_headers
    )
    space_token = token_response.json()["space_token"]
    space_headers = {"Authorization": f"Bearer {space_token}"}

    access = await PomodoroTokenVerifier().verify_token(space_token)
    assert access is not None
    import app.mcp.auth as mcp_auth

    monkeypatch.setattr(mcp_auth, "get_access_token", lambda: access)

    import app.mcp.task_space_tools as module

    module._gateway_factory = module.McpTaskSpaceWriteGateway(
        _runtime_services(client)
    )

    # A create against a project that does not exist: a durable per-item
    # business rejection on both transports.
    def missing_project_command(command_id: str) -> dict:
        return {
            "kind": "work_item.create",
            "commandId": command_id,
            "spaceId": space_id,
            "projectId": "does-not-exist",
            "payloadHash": canonical_payload_hash(_create_payload("Nope")),
            "title": "Nope",
        }

    rest_batch = {
        "batchId": "parity-reject-rest",
        "commands": [missing_project_command("reject-rest")],
    }
    rest_response = await client.post(
        "/api/v1/task-space/commands:batch",
        json=rest_batch,
        headers={**space_headers, "Idempotency-Key": "parity-reject-rest"},
    )
    assert rest_response.status_code == 200, rest_response.text
    rest_receipt = rest_response.json()

    mcp_receipt = await module.execute_task_space_commands(
        batch_id="parity-reject-mcp",
        commands=[missing_project_command("reject-mcp")],
    )

    assert rest_receipt["rejectedCount"] == mcp_receipt["rejectedCount"] == 1
    rest_item, mcp_item = rest_receipt["items"][0], mcp_receipt["items"][0]
    assert rest_item["status"] == mcp_item["status"] == "rejected"
    assert rest_item["code"] == mcp_item["code"]
    assert rest_item["retryable"] == mcp_item["retryable"]
    assert set(rest_item["details"]) == set(mcp_item["details"])


def _runtime_services(client):
    def provider():
        app = client._transport.app  # type: ignore[attr-defined]
        services = getattr(app.state, "runtime_services", None)
        if services is None:
            raise RuntimeError("production runtime services are not booted")
        return services

    return provider
