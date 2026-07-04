"""Integration tests for the registry / meta API.

These tests verify that the registry is properly wired into the running
FastAPI application: the OpenAPI schema advertises the ``meta`` tag,
the 4 endpoints are reachable, and the registry singleton is populated
by the time the app starts handling requests.
"""
from __future__ import annotations

import pytest


async def _get_master_token(client) -> str:
    """Set up admin password and return a fresh master token."""
    await client.post("/api/v1/auth/setup", json={"password": "test123"})
    resp = await client.post(
        "/api/v1/auth/login", json={"password": "test123"}
    )
    return resp.json()["access_token"]


@pytest.mark.asyncio
async def test_meta_openapi_docs_contain_meta_tag(client):
    """The OpenAPI schema must advertise the ``meta`` tag and 4 endpoints.

    FastAPI attaches the ``tags=["meta"]`` argument from
    ``include_router`` to each path operation (not to the top-level
    ``tags`` array, which only appears when ``openapi_tags=`` is passed
    to ``FastAPI()``).  We therefore check the per-operation tags.
    """
    resp = await client.get("/openapi.json")
    assert resp.status_code == 200
    schema = resp.json()

    # All 4 meta endpoints must be present and tagged with "meta".
    paths = schema.get("paths", {})
    expected_paths = {
        "/api/v1/meta/health",
        "/api/v1/meta/entities",
        "/api/v1/meta/entities/{entity_type}",
        "/api/v1/meta/entities/{entity_type}/schema",
    }
    for p in expected_paths:
        assert p in paths, f"OpenAPI missing path {p}"
        get_op = paths[p].get("get")
        assert get_op is not None, f"Path {p} missing GET method"
        op_tags = get_op.get("tags", [])
        assert "meta" in op_tags, (
            f"Path {p} GET operation missing 'meta' tag, got {op_tags}"
        )


@pytest.mark.asyncio
async def test_registry_loaded_in_app(client):
    """The registry singleton is populated when the app handles requests.

    End-to-end sanity check: the app's lifespan/import chain must have
    triggered ``builtin.py`` registration before any request is served.
    """
    token = await _get_master_token(client)
    resp = await client.get(
        "/api/v1/meta/health",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    body = resp.json()
    # If builtin.py never ran, entity_count would be 0.
    assert body["registry_loaded"] is True
    assert body["entity_count"] == 20


@pytest.mark.asyncio
async def test_meta_api_full_roundtrip(client):
    """End-to-end: list -> get -> schema for the 'note' entity.

    Exercises the full stack (route -> service -> registry -> response)
    for the most architecturally significant entity (FS+DB split).
    """
    token = await _get_master_token(client)

    # 1. List entities and find 'note'.
    resp = await client.get(
        "/api/v1/meta/entities",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    names = {e["name"] for e in resp.json()["entities"]}
    assert "note" in names

    # 2. Get the full spec for 'note'.
    resp = await client.get(
        "/api/v1/meta/entities/note",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    spec = resp.json()
    assert spec["storage_type"] == "fs_db_split"
    assert spec["sync_enabled"] is True

    # 3. Get the field schema for 'note'.
    resp = await client.get(
        "/api/v1/meta/entities/note/schema",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    schema = resp.json()
    assert schema["entity_type"] == "note"
    field_names = {f["name"] for f in schema["fields"]}
    assert "content_hash" in field_names
    assert "trashed_at" in field_names


@pytest.mark.asyncio
async def test_meta_api_sync_enabled_and_soft_delete_filters(client):
    """End-to-end: verify sync_enabled + soft_delete flags via the API.

    The 'note' entity must be sync_enabled=True and soft_delete=True,
    while 'task' must be sync_enabled=True and soft_delete=False.
    This guards the Phase C sync dispatch contract.
    """
    token = await _get_master_token(client)

    resp = await client.get(
        "/api/v1/meta/entities/note",
        headers={"Authorization": f"Bearer {token}"},
    )
    note = resp.json()
    assert note["sync_enabled"] is True
    assert note["soft_delete"] is True

    resp = await client.get(
        "/api/v1/meta/entities/task",
        headers={"Authorization": f"Bearer {token}"},
    )
    task = resp.json()
    assert task["sync_enabled"] is True
    assert task["soft_delete"] is False  # P1-1 confirmed: Task has no trashed_at
