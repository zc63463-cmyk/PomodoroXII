"""Tests for ``/api/v1/meta/*`` routes (entity registry introspection).

These tests cover the 4 endpoints exposed by ``app.routes.v1.meta``:
- GET /api/v1/meta/health
- GET /api/v1/meta/entities
- GET /api/v1/meta/entities/{entity_type}
- GET /api/v1/meta/entities/{entity_type}/schema

All endpoints require a *master* token; space tokens and missing tokens
must be rejected with 401/403.
"""
from __future__ import annotations

import pytest

# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

async def _get_master_token(client) -> str:
    """Set up admin password and return a fresh master token."""
    await client.post("/api/v1/auth/setup", json={"password": "test123"})
    resp = await client.post(
        "/api/v1/auth/login", json={"password": "test123"}
    )
    return resp.json()["access_token"]


def _master_auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# --------------------------------------------------------------------------- #
# /health
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_meta_health(client):
    """GET /api/v1/meta/health returns registry stats."""
    token = await _get_master_token(client)
    resp = await client.get(
        "/api/v1/meta/health", headers=_master_auth(token)
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["registry_loaded"] is True
    assert body["entity_count"] == 20
    assert body["categories"]["business"] == 14
    assert body["categories"]["sync_infra"] == 3
    assert body["categories"]["meta"] == 2
    assert body["categories"]["setting"] == 1


# --------------------------------------------------------------------------- #
# /entities (list)
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_meta_list_entities(client):
    """GET /api/v1/meta/entities returns all 20 entities."""
    token = await _get_master_token(client)
    resp = await client.get(
        "/api/v1/meta/entities", headers=_master_auth(token)
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 20
    assert len(body["entities"]) == 20
    names = {e["name"] for e in body["entities"]}
    assert "note" in names
    assert "task" in names
    assert "tombstone" in names
    assert "space" in names
    assert "setting" in names


@pytest.mark.asyncio
async def test_meta_list_entities_filter_category(client):
    """GET /api/v1/meta/entities?category=business filters correctly."""
    token = await _get_master_token(client)
    resp = await client.get(
        "/api/v1/meta/entities?category=business",
        headers=_master_auth(token),
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 14
    assert all(e["category"] == "business" for e in body["entities"])

    # sync_infra filter
    resp = await client.get(
        "/api/v1/meta/entities?category=sync_infra",
        headers=_master_auth(token),
    )
    assert resp.status_code == 200
    assert resp.json()["total"] == 3

    # meta filter
    resp = await client.get(
        "/api/v1/meta/entities?category=meta",
        headers=_master_auth(token),
    )
    assert resp.status_code == 200
    assert resp.json()["total"] == 2


@pytest.mark.asyncio
async def test_meta_list_entities_invalid_category_422(client):
    """An unknown category value must return 422."""
    token = await _get_master_token(client)
    resp = await client.get(
        "/api/v1/meta/entities?category=nonexistent",
        headers=_master_auth(token),
    )
    assert resp.status_code == 422


# --------------------------------------------------------------------------- #
# /entities/{entity_type}
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_meta_get_entity(client):
    """GET /api/v1/meta/entities/note returns the full spec."""
    token = await _get_master_token(client)
    resp = await client.get(
        "/api/v1/meta/entities/note", headers=_master_auth(token)
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "note"
    assert body["table_name"] == "notes"
    assert body["storage_type"] == "fs_db_split"
    assert body["category"] == "business"
    assert body["sync_enabled"] is True
    assert body["soft_delete"] is True
    assert body["primary_key"] == "id"
    assert isinstance(body["fields"], list)
    assert len(body["fields"]) > 0
    # Must include SyncMixin fields.
    field_names = {f["name"] for f in body["fields"]}
    assert {"id", "created_at", "updated_at", "version"} <= field_names
    # Must include Note-specific fields.
    assert {"content_hash", "word_count", "trashed_at"} <= field_names


@pytest.mark.asyncio
async def test_meta_get_entity_unknown_404(client):
    """GET /api/v1/meta/entities/nonexistent returns 404."""
    token = await _get_master_token(client)
    resp = await client.get(
        "/api/v1/meta/entities/nonexistent", headers=_master_auth(token)
    )
    assert resp.status_code == 404
    assert resp.json()["error_type"] == "not_found"


# --------------------------------------------------------------------------- #
# /entities/{entity_type}/schema
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_meta_get_entity_schema(client):
    """GET /api/v1/meta/entities/task/schema returns the field schema."""
    token = await _get_master_token(client)
    resp = await client.get(
        "/api/v1/meta/entities/task/schema", headers=_master_auth(token)
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["entity_type"] == "task"
    assert body["table_name"] == "tasks"
    assert body["primary_key"] == "id"
    assert isinstance(body["fields"], list)
    assert len(body["fields"]) > 0
    # Each field dict must have the expected keys.
    f = body["fields"][0]
    assert {
        "name", "type", "nullable", "default",
        "indexed", "unique", "description",
    } <= set(f)


@pytest.mark.asyncio
async def test_meta_get_entity_schema_unknown_404(client):
    """Schema endpoint on an unknown entity returns 404."""
    token = await _get_master_token(client)
    resp = await client.get(
        "/api/v1/meta/entities/nonexistent/schema",
        headers=_master_auth(token),
    )
    assert resp.status_code == 404


# --------------------------------------------------------------------------- #
# Auth guard
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_meta_endpoints_require_master_token(client):
    """All meta endpoints must reject requests without a master token."""
    # No token at all -> 401.
    resp = await client.get("/api/v1/meta/health")
    assert resp.status_code == 401

    resp = await client.get("/api/v1/meta/entities")
    assert resp.status_code == 401

    # Space token must be rejected (403) -- meta is master-only.
    # First get a master token, create a space, issue a space token.
    master = await _get_master_token(client)
    resp = await client.post(
        "/api/v1/spaces",
        json={"name": "TS"},
        headers=_master_auth(master),
    )
    space_id = resp.json()["id"]
    resp = await client.post(
        f"/api/v1/spaces/{space_id}/token",
        headers=_master_auth(master),
    )
    space_token = resp.json()["space_token"]

    resp = await client.get(
        "/api/v1/meta/health",
        headers={"Authorization": f"Bearer {space_token}"},
    )
    assert resp.status_code == 403


# --------------------------------------------------------------------------- #
# P1-2: sync_entity_type / pull_key fields in entity spec
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_meta_serialize_includes_sync_entity_type(client):
    """P1-2: /meta/entities should return sync_entity_type field."""
    token = await _get_master_token(client)
    resp = await client.get(
        "/api/v1/meta/entities", headers=_master_auth(token)
    )
    assert resp.status_code == 200
    data = resp.json()
    # quick_note has sync_entity_type='quickNote'
    qn = next(e for e in data["entities"] if e["name"] == "quick_note")
    assert qn["sync_entity_type"] == "quickNote"
    # task has no explicit sync_entity_type (name == sync_entity_type), None
    task = next(e for e in data["entities"] if e["name"] == "task")
    assert task.get("sync_entity_type") is None


@pytest.mark.asyncio
async def test_meta_serialize_includes_pull_key(client):
    """P1-2: /meta/entities should return pull_key field."""
    token = await _get_master_token(client)
    resp = await client.get(
        "/api/v1/meta/entities", headers=_master_auth(token)
    )
    assert resp.status_code == 200
    data = resp.json()
    qn = next(e for e in data["entities"] if e["name"] == "quick_note")
    assert qn["pull_key"] == "quickNotes"
    task = next(e for e in data["entities"] if e["name"] == "task")
    assert task["pull_key"] == "tasks"
