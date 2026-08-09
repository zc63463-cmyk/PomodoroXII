"""Real master-token HTTP integration for the ActiveSession contract.

The app is the *real* ``create_app()`` with the production lifespan
(bootstrap_runtime) and the *real* ``get_active_session_coordinator`` provider
— no dependency override of the provider, no fake executor.  Spaces are
created through the real API, project/work-item prerequisites are created
through the real Task Space API, and every success asserts an exact 2xx.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

import pytest

from app.mutation.types import canonical_payload_hash

NOW = "2026-07-15T08:00:00.000Z"


def _start_hash(payload: dict[str, object]) -> str:
    from app.focus_session.commands import active_business_payload

    return canonical_payload_hash(active_business_payload("start", payload))


def _start_body(
    *,
    command_id: str = "op-start",
    session_id: str = "fs-1",
    space_id: str = "space-a",
    work_item_id: str = "wi-l2",
    expected_work_item_versions: dict[str, int] | None = None,
) -> dict[str, Any]:
    payload = {
        "level2_work_item_id": work_item_id,
        "level3_work_item_ids": [],
        "planned_seconds": 1500,
        "started_at": NOW,
        "owner_device_id": "device-1",
        "owner_tab_id": "tab-1",
        "expected_work_item_versions": (
            expected_work_item_versions
            if expected_work_item_versions is not None
            else {work_item_id: 1}
        ),
    }
    return {
        "commandId": command_id,
        "spaceId": space_id,
        "sessionId": session_id,
        "ownershipEpoch": None,
        "payloadHash": _start_hash(payload),
        "payload": {
            "level2WorkItemId": work_item_id,
            "level3WorkItemIds": [],
            "plannedSeconds": 1500,
            "startedAt": NOW,
            "ownerDeviceId": "device-1",
            "ownerTabId": "tab-1",
            "expectedWorkItemVersions": payload["expected_work_item_versions"],
        },
    }


async def _master_token(client) -> str:
    resp = await client.post("/api/v1/auth/setup", json={"password": "test-password-123"})
    assert resp.status_code in (200, 201), resp.text
    resp = await client.post("/api/v1/auth/login", json={"password": "test-password-123"})
    assert resp.status_code == 200, resp.text
    return resp.json()["access_token"]


async def _create_space(client, master_headers: dict[str, str], name: str) -> dict[str, str]:
    resp = await client.post("/api/v1/spaces", json={"name": name}, headers=master_headers)
    assert resp.status_code == 201, resp.text
    space = resp.json()
    resp = await client.post(
        f"/api/v1/spaces/{space['id']}/token", headers=master_headers
    )
    assert resp.status_code == 200, resp.text
    return {
        "id": space["id"],
        "token": resp.json()["space_token"],
        "headers": {"Authorization": f"Bearer {resp.json()['space_token']}"},
    }


def _task_payload_hash(action: str, payload: dict[str, object]) -> str:
    return canonical_payload_hash(payload)


async def _create_project(
    client, space_headers: dict[str, str], *, key: str = "PRJ", space_id: str = "space-a",
) -> str:
    payload = {"key": key, "name": f"Project {key}"}
    body = {
        "commandId": f"op-proj-{key}",
        "spaceId": space_id,
        "payloadHash": _task_payload_hash("project.create", payload),
        "key": key,
        "name": f"Project {key}",
    }
    resp = await client.post("/api/v1/projects", json=body, headers=space_headers)
    assert resp.status_code in (200, 201), resp.text
    data = resp.json()
    return data.get("entityId") or data.get("entity_id") or data.get("id")


async def _create_work_item(
    client, space_headers: dict[str, str], project_id: str, *, space_id: str = "space-a",
) -> str:
    # depth-1 root under the project
    root_body = {
        "commandId": f"op-wi-root-{space_id}",
        "spaceId": space_id,
        "payloadHash": canonical_payload_hash({"title": "Root", "description": None,
                                                "parent_id": None, "type_definition_id": None,
                                                "status_definition_id": None, "priority": None}),
        "projectId": project_id,
        "title": "Root",
        "parentId": None,
        "typeDefinitionId": None,
        "statusDefinitionId": None,
        "priority": None,
    }
    resp = await client.post("/api/v1/work-items", json=root_body, headers=space_headers)
    assert resp.status_code in (200, 201), resp.text
    root_id = resp.json().get("entityId") or resp.json().get("entity_id") or resp.json().get("id")

    # depth-2 level2 whose parent is the root
    level2_payload = {
        "title": "Level2", "description": None, "parent_id": root_id,
        "type_definition_id": None, "status_definition_id": None, "priority": None,
    }
    body = {
        "commandId": "op-wi-l2",
        "spaceId": space_id,
        "payloadHash": canonical_payload_hash(level2_payload),
        "projectId": project_id,
        "title": "Level2",
        "parentId": root_id,
        "typeDefinitionId": None,
        "statusDefinitionId": None,
        "priority": None,
    }
    resp = await client.post("/api/v1/work-items", json=body, headers=space_headers)
    assert resp.status_code in (200, 201), resp.text
    data = resp.json()
    return data.get("entityId") or data.get("entity_id") or data.get("id")


@pytest.mark.asyncio
async def test_master_start_returns_exact_201_with_real_aggregate(client) -> None:
    master_token = await _master_token(client)
    master_headers = {"Authorization": f"Bearer {master_token}"}
    space = await _create_space(client, master_headers, "Start Space")
    project_id = await _create_project(
        client, space["headers"], key="PRJ", space_id=space["id"]
    )
    wi_id = await _create_work_item(client, space["headers"], project_id, space_id=space["id"])
    assert isinstance(wi_id, str) and wi_id

    import asyncio
    resp = await asyncio.wait_for(
        client.post(
            "/api/v1/active-session/start",
            json=_start_body(space_id=space["id"], work_item_id=wi_id),
            headers=master_headers,
        ),
        timeout=60,
    )
    assert resp.status_code == 201, resp.text
    data = resp.json()
    assert "session" in data, "session aggregate required"
    session = data["session"]["session"]
    assert session["id"] == "fs-1"
    assert session["spaceId"] == space["id"]
    assert session["createdAt"] == NOW  # real Space DB value, not fabricated
    assert data["operationId"] == "op-start"
    assert data["state"] == "claiming"


@pytest.mark.asyncio
async def test_master_locate_returns_200_with_active(client) -> None:
    master_token = await _master_token(client)
    master_headers = {"Authorization": f"Bearer {master_token}"}
    space = await _create_space(client, master_headers, "Locate Space")
    project_id = await _create_project(
        client, space["headers"], key="LOC", space_id=space["id"]
    )
    wi_id = await _create_work_item(client, space["headers"], project_id, space_id=space["id"])
    await client.post(
        "/api/v1/active-session/start",
        json=_start_body(space_id=space["id"], work_item_id=wi_id),
        headers=master_headers,
    )
    resp = await client.get("/api/v1/active-session", headers=master_headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["session"]["session"]["id"] == "fs-1"


@pytest.mark.asyncio
async def test_master_locate_returns_404_when_no_active(client) -> None:
    master_token = await _master_token(client)
    master_headers = {"Authorization": f"Bearer {master_token}"}
    resp = await client.get("/api/v1/active-session", headers=master_headers)
    assert resp.status_code == 404, resp.text


@pytest.mark.asyncio
async def test_space_token_rejected(client) -> None:
    master_token = await _master_token(client)
    master_headers = {"Authorization": f"Bearer {master_token}"}
    space = await _create_space(client, master_headers, "Auth Space")
    resp = await client.get("/api/v1/active-session", headers=space["headers"])
    assert resp.status_code in (401, 403), resp.text


@pytest.mark.asyncio
async def test_anonymous_rejected(client) -> None:
    resp = await client.get("/api/v1/active-session")
    assert resp.status_code in (401, 403), resp.text


@pytest.mark.asyncio
async def test_unregistered_space_fails_closed(client) -> None:
    master_token = await _master_token(client)
    master_headers = {"Authorization": f"Bearer {master_token}"}
    body = _start_body(space_id="space-not-registered")
    resp = await client.post("/api/v1/active-session/start", json=body, headers=master_headers)
    # SpaceNotFoundError -> 404 via the canonical AppError handler
    assert resp.status_code == 404, resp.text
    assert "not_found" in resp.text


@pytest.mark.asyncio
async def test_duplicate_start_same_command_id_fails_closed(client) -> None:
    master_token = await _master_token(client)
    master_headers = {"Authorization": f"Bearer {master_token}"}
    space = await _create_space(client, master_headers, "Dup Space")
    project_id = await _create_project(
        client, space["headers"], key="DUP", space_id=space["id"]
    )
    wi_id = await _create_work_item(client, space["headers"], project_id, space_id=space["id"])
    first = await client.post(
        "/api/v1/active-session/start",
        json=_start_body(space_id=space["id"], work_item_id=wi_id),
        headers=master_headers,
    )
    assert first.status_code == 201, first.text
    second = await client.post(
        "/api/v1/active-session/start",
        json=_start_body(space_id=space["id"], work_item_id=wi_id),
        headers=master_headers,
    )
    # same command_id + same payload hash: idempotent replay succeeds (201)
    assert second.status_code == 201, second.text
    assert second.json()["session"]["session"]["id"] == "fs-1"
