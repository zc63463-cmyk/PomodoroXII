"""Wave 2 Task C — Task Space API smoke over real HTTP routes.

Drives the full workflow through the mounted production routers using a real
ASGI HTTP client (httpx AsyncClient + ASGITransport with the app lifespan):
project → root work item → L2 → L3 → move → transition → note.

This is NOT a compiler/store unit test: every call goes through the real
``/api/v1/*`` routes, auth, space token, idempotency-key handling and the
durable mutation pipeline.
"""

from __future__ import annotations

import pytest

from app.mutation.types import canonical_payload_hash

# Reused helper contracts (mirror the production wire contract).  These are
# intentionally duplicated here so the smoke stands alone as a black-box suite.


async def _setup_space_and_get_headers(client) -> tuple[dict[str, str], str]:
    setup = await client.post(
        "/api/v1/auth/setup", json={"password": "smoke-password-456"}
    )
    assert setup.status_code == 201, setup.text
    login = await client.post(
        "/api/v1/auth/login", json={"password": "smoke-password-456"}
    )
    assert login.status_code == 200, login.text
    master_headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    created = await client.post(
        "/api/v1/spaces",
        json={"name": "Wave2 Smoke Space"},
        headers=master_headers,
    )
    assert created.status_code == 201, created.text
    space_id = created.json()["id"]
    token = await client.post(
        f"/api/v1/spaces/{space_id}/token", headers=master_headers
    )
    assert token.status_code == 200, token.text
    return {"Authorization": f"Bearer {token.json()['space_token']}"}, space_id


async def _create_project(client, headers, space_id, command_id, key, name) -> str:
    payload = {"key": key, "name": name, "description": None}
    resp = await client.post(
        "/api/v1/projects",
        json={
            "commandId": command_id,
            "spaceId": space_id,
            "payloadHash": canonical_payload_hash(payload),
            "key": key,
            "name": name,
        },
        headers={**headers, "Idempotency-Key": command_id},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["entityId"]


async def _create_work_item(
    client, headers, space_id, command_id, project_id,
    *, title="Task", parent_id=None,
) -> dict:
    payload = {
        "title": title,
        "description": None,
        "parent_id": parent_id,
        "type_definition_id": None,
        "status_definition_id": None,
        "priority": None,
    }
    resp = await client.post(
        "/api/v1/work-items",
        json={
            "commandId": command_id,
            "spaceId": space_id,
            "projectId": project_id,
            "payloadHash": canonical_payload_hash(payload),
            "title": title,
            "parentId": parent_id,
        },
        headers={**headers, "Idempotency-Key": command_id},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    return {"id": body["entityId"], "version": body["version"], "value": body["value"]}


async def _first_status_id(client, headers, category: str) -> str:
    resp = await client.get("/api/v1/projects/definitions", headers=headers)
    assert resp.status_code == 200, resp.text
    for status in resp.json()["statuses"]:
        if status["category"] == category:
            return str(status["id"])
    raise AssertionError(f"no {category} status seeded")


@pytest.mark.provisioned_space_storage
class TestTaskSpaceApiSmoke:
    async def test_full_workflow_through_real_http(self, client) -> None:
        headers, space_id = await _setup_space_and_get_headers(client)

        # 1. Project
        project_id = await _create_project(
            client, headers, space_id, "smoke-project", "SMK", "Smoke Project"
        )

        # 2. Root work item
        root = await _create_work_item(
            client, headers, space_id, "smoke-root", project_id, title="Root"
        )
        assert root["value"]["depth"] == 1
        assert root["value"]["parentId"] is None
        assert root["value"]["childRank"] == 0

        # 3. L2 child
        l2 = await _create_work_item(
            client, headers, space_id, "smoke-l2", project_id,
            title="Level 2", parent_id=root["id"],
        )
        assert l2["value"]["depth"] == 2
        assert l2["value"]["parentId"] == root["id"]

        # 4. L3 grandchild (legal 3-level tree)
        l3 = await _create_work_item(
            client, headers, space_id, "smoke-l3", project_id,
            title="Level 3", parent_id=l2["id"],
        )
        assert l3["value"]["depth"] == 3

        # 5. List is a stable flat page containing the whole tree with correct
        #    depth/parent projections (order is parent-first + id, not a
        #    topological tree, so assert membership and structure).
        listed = await client.get(
            "/api/v1/work-items",
            params={"projectId": project_id},
            headers=headers,
        )
        assert listed.status_code == 200, listed.text
        items = listed.json()["items"]
        by_id = {item["id"]: item for item in items}
        assert {item["id"] for item in items} >= {root["id"], l2["id"], l3["id"]}
        assert by_id[root["id"]]["depth"] == 1
        assert by_id[root["id"]]["parentId"] is None
        assert by_id[l2["id"]]["depth"] == 2
        assert by_id[l2["id"]]["parentId"] == root["id"]
        assert by_id[l3["id"]]["depth"] == 3
        assert by_id[l3["id"]]["parentId"] == l2["id"]

        # 6. Legal move: move root under itself is invalid; move l3 leaf under
        #    a fresh root sibling is legal and gets the authoritative rank.
        other_root = await _create_work_item(
            client, headers, space_id, "smoke-other-root", project_id, title="Other Root"
        )
        move_payload = {"new_parent_id": other_root["id"]}
        moved = await client.post(
            f"/api/v1/work-items/{l3['id']}/move",
            json={
                "commandId": "smoke-move",
                "spaceId": space_id,
                "expectedVersion": l3["version"],
                "payloadHash": canonical_payload_hash(move_payload),
                "projectId": project_id,
                "parentId": other_root["id"],
            },
            headers={**headers, "Idempotency-Key": "smoke-move"},
        )
        assert moved.status_code == 200, moved.text
        moved_value = moved.json()["value"]
        assert moved_value["parentId"] == other_root["id"]
        assert moved_value["childRank"] == 0  # authoritative max+1 on empty target

        # 7. Transition to completed
        completed_id = await _first_status_id(client, headers, "completed")
        transition_payload = {"status_definition_id": completed_id}
        transitioned = await client.post(
            f"/api/v1/work-items/{l2['id']}/transition",
            json={
                "commandId": "smoke-transition",
                "spaceId": space_id,
                "expectedVersion": l2["version"],
                "payloadHash": canonical_payload_hash(transition_payload),
                "statusDefinitionId": completed_id,
            },
            headers={**headers, "Idempotency-Key": "smoke-transition"},
        )
        assert transitioned.status_code == 200, transitioned.text
        assert transitioned.json()["value"]["statusDefinitionId"] == completed_id
        assert transitioned.json()["value"]["completedAt"] is not None

        # 8. Note replace + read
        note_document = {
            "contentVersion": 1,
            "blocks": [{"type": "paragraph", "blockId": "p1", "text": "Smoke body"}],
        }
        note_payload = {"document": note_document}
        note = await client.put(
            f"/api/v1/work-items/{root['id']}/note",
            json={
                "commandId": "smoke-note",
                "spaceId": space_id,
                "expectedVersion": None,
                "payloadHash": canonical_payload_hash(note_payload),
                "document": note_document,
            },
            headers={**headers, "Idempotency-Key": "smoke-note"},
        )
        assert note.status_code == 200, note.text
        note_read = await client.get(
            f"/api/v1/work-items/{root['id']}/note", headers=headers
        )
        assert note_read.status_code == 200, note_read.text
        assert note_read.json()["document"] == note_document

    async def test_client_supplied_child_rank_is_rejected_422(self, client) -> None:
        headers, space_id = await _setup_space_and_get_headers(client)
        project_id = await _create_project(
            client, headers, space_id, "smoke-422-project", "S42", "422 Project"
        )
        item = await _create_work_item(
            client, headers, space_id, "smoke-422-item", project_id, title="Item"
        )
        move_payload = {"new_parent_id": None}
        resp = await client.post(
            f"/api/v1/work-items/{item['id']}/move",
            json={
                "commandId": "smoke-422-move",
                "spaceId": space_id,
                "expectedVersion": item["version"],
                "payloadHash": canonical_payload_hash(move_payload),
                "projectId": project_id,
                "parentId": None,
                "childRank": 7,
            },
            headers={**headers, "Idempotency-Key": "smoke-422-move"},
        )
        assert resp.status_code == 422, resp.text

    async def test_legacy_tasks_route_is_absent(self, client) -> None:
        headers, space_id = await _setup_space_and_get_headers(client)
        resp = await client.get("/api/v1/tasks", headers=headers)
        assert resp.status_code == 404, resp.text
