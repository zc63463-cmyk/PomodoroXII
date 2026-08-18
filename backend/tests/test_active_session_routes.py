"""Real-provider HTTP contract tests for the ActiveSession wire layer.

Every request goes through the *real* ``create_app()`` lifespan and the *real*
``get_active_session_coordinator`` provider (no dependency overrides).  These
tests focus on the activate-provisional pair wire matrix and idempotency-key
binding; the start/locate/auth success paths live in
``test_active_session_http_integration.py``.
"""

from __future__ import annotations

import sqlite3
from typing import Any

import pytest

from app.mutation.types import canonical_payload_hash

NOW = "2026-07-15T08:00:00.000Z"


def _start_hash(payload: dict[str, object]) -> str:
    from app.focus_session.commands import active_business_payload

    return canonical_payload_hash(active_business_payload("start", payload))


def _activate_hash(payload: dict[str, object]) -> str:
    from app.focus_session.commands import active_business_payload

    return canonical_payload_hash(active_business_payload("activate_provisional", payload))


def _activate_snapshot() -> dict[str, Any]:
    return {
        "session": {
            "sessionRevision": 1,
            "startedAt": NOW,
            "plannedSeconds": 1500,
            "grossSeconds": 0,
            "pausedSeconds": 0,
            "breakSeconds": 0,
            "focusedSeconds": 0,
            "validity": "pending",
            "reviewState": "not_required",
            "ownershipState": "local_provisional",
            "sessionNote": "",
        },
        "context": {
            "projectId": "project-1",
            "projectTitleSnapshot": "Project",
            "level2WorkItemId": "wi-l2",
            "level2TitleSnapshot": "WorkItem",
            "level2StatusDefinitionIdSnapshot": "complete",
            "level2VersionSnapshot": 1,
            "linkedAt": NOW,
            "linkMethod": "explicit",
        },
        "plan": [],
    }


def _activate_body(pair: dict[str, Any], *, session_id: str = "fs-1") -> dict[str, Any]:
    snake_payload = {
        "pair": {
            "active": {"space_id": pair["active"]["spaceId"], "session_id": pair["active"]["sessionId"]},
            "candidate": {"space_id": pair["candidate"]["spaceId"], "session_id": pair["candidate"]["sessionId"]},
        },
        "cached_at": NOW,
        "cached_ownership_epoch": 1,
        "owner_device_id": "device-1",
        "owner_tab_id": "tab-1",
        "snapshot": {
            "session": {
                "session_revision": 1, "started_at": NOW, "planned_seconds": 1500,
                "gross_seconds": 0, "paused_seconds": 0, "break_seconds": 0,
                "focused_seconds": 0, "validity": "pending", "review_state": "not_required",
                "ownership_state": "local_provisional", "session_note": "",
            },
            "context": {
                "project_id": "project-1", "project_title_snapshot": "Project",
                "level2_work_item_id": "wi-l2", "level2_title_snapshot": "WorkItem",
                "level2_status_definition_id_snapshot": "complete",
                "level2_version_snapshot": 1, "linked_at": NOW, "link_method": "explicit",
            },
            "plan": [],
        },
        "expected_work_item_versions": {"wi-l2": 1},
    }
    return {
        "commandId": "op-conflict",
        "spaceId": pair["active"]["spaceId"],
        "sessionId": session_id,
        "ownershipEpoch": None,
        "payloadHash": _activate_hash(snake_payload),
        "payload": {
            "pair": pair,
            "cachedAt": NOW,
            "cachedOwnershipEpoch": 1,
            "ownerDeviceId": "device-1",
            "ownerTabId": "tab-1",
            "snapshot": _activate_snapshot(),
            "expectedWorkItemVersions": {"wi-l2": 1},
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
    return {"id": space["id"], "headers": {"Authorization": f"Bearer {resp.json()['space_token']}"}}


async def _create_project(client, space_headers: dict[str, str], *, space_id: str, key: str) -> str:
    body = {
        "commandId": f"op-proj-{key}",
        "spaceId": space_id,
        "payloadHash": canonical_payload_hash({"key": key, "name": f"Project {key}", "description": None}),
        "key": key,
        "name": f"Project {key}",
    }
    resp = await client.post("/api/v1/projects", json=body, headers=space_headers)
    assert resp.status_code in (200, 201), resp.text
    data = resp.json()
    return data.get("entityId") or data.get("entity_id") or data.get("id")


async def _create_work_item(client, space_headers: dict[str, str], project_id: str, *, space_id: str) -> str:
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


async def _provision(
    client, master_headers: dict[str, str], name: str, key: str,
) -> tuple[dict[str, str], str]:
    space = await _create_space(client, master_headers, name)
    project_id = await _create_project(client, space["headers"], space_id=space["id"], key=key)
    wi_id = await _create_work_item(client, space["headers"], project_id, space_id=space["id"])
    return space, wi_id


def _seed_second_session(space_id: str, session_id: str) -> None:
    """Seed the candidate Session row (a provisional session on another Space)
    directly in the real Space SQLite DB — the realistic shape of a
    provisional candidate on another device."""
    from app.settings import settings

    db_path = settings.space_db_path(space_id)
    with sqlite3.connect(str(db_path)) as conn:
        conn.execute(
            "INSERT OR IGNORE INTO focus_sessions "
            "(id, session_revision, started_at, planned_seconds, gross_seconds, "
            "paused_seconds, break_seconds, focused_seconds, validity, review_state, "
            "ownership_state, session_note, version, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (session_id, 1, NOW, 1500, 0, 0, 0, 0, "pending", "not_required",
             "activation_conflict", "", 1, NOW, NOW),
        )
        conn.execute(
            "INSERT OR IGNORE INTO session_task_contexts "
            "(id, session_id, project_id, level2_work_item_id, title_snapshot, "
            "structure_snapshot, linked_at, link_method, version, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (f"ctx-{session_id}", session_id, "project-1", "wi-l2", "WorkItem",
             '{"project":{"id":"project-1","name":"Project"},"level2":{"id":"wi-l2",'
             '"title":"WorkItem","parent_id":null,"status_definition_id":"complete",'
             '"version":1,"effort_estimate_lower_seconds":null,'
             '"effort_estimate_upper_seconds":null},"plan":{}}',
             NOW, "manual", 1, NOW, NOW),
        )
        conn.execute(
            "INSERT OR IGNORE INTO session_attribution_revisions "
            "(id, session_id, revision, project_id, level2_work_item_id, reason, "
            "corrected_from_revision, effective, version, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (f"attr-{session_id}-1", session_id, 1, "project-1", "wi-l2",
             None, None, 1, 1, NOW, NOW),
        )
        conn.commit()


async def _setup_conflict(client, master_headers: dict[str, str]) -> tuple[dict[str, str], dict[str, str]]:
    """space-a carries the active provisional Session (fs-1), space-b the
    candidate provisional Session (fs-2).  activate-provisional claims the
    global slot itself — no start precedes it."""
    space_a, _wi_a = await _provision(client, master_headers, "Pair A", "PAA")
    space_b, _wi_b = await _provision(client, master_headers, "Pair B", "PAB")
    _seed_second_session(space_a["id"], "fs-1")
    _seed_second_session(space_b["id"], "fs-2")
    return space_a, space_b


@pytest.mark.asyncio
async def test_activate_valid_pair_returns_exact_200(client) -> None:
    master_token = await _master_token(client)
    master_headers = {"Authorization": f"Bearer {master_token}"}
    space_a, space_b = await _setup_conflict(client, master_headers)
    pair = {
        "active": {"spaceId": space_a["id"], "sessionId": "fs-1"},
        "candidate": {"spaceId": space_b["id"], "sessionId": "fs-2"},
    }
    resp = await client.post(
        "/api/v1/active-session/activate-provisional",
        json=_activate_body(pair),
        headers=master_headers,
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["kind"] == "activation_conflict"
    assert data["active"]["session"]["session"]["id"] == "fs-1"
    assert data["candidate"]["session"]["session"]["id"] == "fs-2"


@pytest.mark.asyncio
async def test_activate_missing_pair_rejected(client) -> None:
    master_token = await _master_token(client)
    master_headers = {"Authorization": f"Bearer {master_token}"}
    space_a, space_b = await _setup_conflict(client, master_headers)
    body = _activate_body({
        "active": {"spaceId": space_a["id"], "sessionId": "fs-1"},
        "candidate": {"spaceId": space_b["id"], "sessionId": "fs-2"},
    })
    del body["payload"]["pair"]
    resp = await client.post(
        "/api/v1/active-session/activate-provisional", json=body, headers=master_headers
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_activate_identical_pair_sides_rejected(client) -> None:
    master_token = await _master_token(client)
    master_headers = {"Authorization": f"Bearer {master_token}"}
    space_a, _space_b = await _setup_conflict(client, master_headers)
    body = _activate_body({
        "active": {"spaceId": space_a["id"], "sessionId": "fs-1"},
        "candidate": {"spaceId": space_a["id"], "sessionId": "fs-1"},
    })
    resp = await client.post(
        "/api/v1/active-session/activate-provisional", json=body, headers=master_headers
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_activate_anchor_mismatch_rejected(client) -> None:
    master_token = await _master_token(client)
    master_headers = {"Authorization": f"Bearer {master_token}"}
    space_a, space_b = await _setup_conflict(client, master_headers)
    body = _activate_body({
        "active": {"spaceId": "space-other", "sessionId": "fs-other"},
        "candidate": {"spaceId": space_b["id"], "sessionId": "fs-2"},
    })
    resp = await client.post(
        "/api/v1/active-session/activate-provisional", json=body, headers=master_headers
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_activate_invalid_identity_rejected(client) -> None:
    master_token = await _master_token(client)
    master_headers = {"Authorization": f"Bearer {master_token}"}
    space_a, _space_b = await _setup_conflict(client, master_headers)
    body = _activate_body({
        "active": {"spaceId": space_a["id"], "sessionId": "fs-1"},
        "candidate": {"spaceId": "not a valid id!", "sessionId": "fs-2"},
    })
    resp = await client.post(
        "/api/v1/active-session/activate-provisional", json=body, headers=master_headers
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_idempotency_key_mismatch_rejected(client) -> None:
    master_token = await _master_token(client)
    master_headers = {"Authorization": f"Bearer {master_token}"}
    await _provision(client, master_headers, "Idem Space", "IDM")
    body = {
        "commandId": "op-start",
        "spaceId": "space-a",
        "sessionId": "fs-1",
        "ownershipEpoch": None,
        "payloadHash": _start_hash(
            {
                "level2_work_item_id": "wi-l2", "level3_work_item_ids": [],
                "planned_seconds": 1500, "started_at": NOW,
                "owner_device_id": "device-1", "owner_tab_id": "tab-1",
                "expected_work_item_versions": {"wi-l2": 1},
            }
        ),
        "payload": {
            "level2WorkItemId": "wi-l2", "level3WorkItemIds": [],
            "plannedSeconds": 1500, "startedAt": NOW,
            "ownerDeviceId": "device-1", "ownerTabId": "tab-1",
            "expectedWorkItemVersions": {"wi-l2": 1},
        },
    }
    resp = await client.post(
        "/api/v1/active-session/start",
        json=body,
        headers={**master_headers, "Idempotency-Key": "op-other"},
    )
    assert resp.status_code in (400, 409, 422), resp.text
