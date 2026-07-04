"""Integration tests for PomodoroXII Phase B Step 10.

End-to-end flows that chain multiple API calls together, plus
architectural gate tests (no FastAPI in services, route count).

Tests:
  1. test_full_lifecycle_space_token_task_session_stats
  2. test_note_saga_end_to_end_consistency
  3. test_cascade_folder_delete_integration
  4. test_gate_services_do_not_import_fastapi
  5. test_gate_all_v1_routes_registered
"""

import pytest


# --------------------------------------------------------------------------- #
# Helpers (self-contained, same pattern as test_routes_v1.py)
# --------------------------------------------------------------------------- #

async def _get_space_client(client):
    """Set up admin password, log in, create a space, issue a space token.

    Returns ``(space_token, space_id)``.
    """
    await client.post("/api/v1/auth/setup", json={"password": "test123"})
    resp = await client.post(
        "/api/v1/auth/login", json={"password": "test123"}
    )
    master_token = resp.json()["access_token"]
    resp = await client.post(
        "/api/v1/spaces",
        json={"name": "Test Space"},
        headers={"Authorization": f"Bearer {master_token}"},
    )
    space_id = resp.json()["id"]
    resp = await client.post(
        f"/api/v1/spaces/{space_id}/token",
        headers={"Authorization": f"Bearer {master_token}"},
    )
    space_token = resp.json()["space_token"]
    return space_token, space_id


def _auth(space_token: str) -> dict:
    """Return the Authorization header dict for a space token."""
    return {"Authorization": f"Bearer {space_token}"}


def _items(resp_json):
    """Extract a list of items from a bare list or paginated response."""
    if isinstance(resp_json, list):
        return resp_json
    if isinstance(resp_json, dict) and "items" in resp_json:
        return resp_json["items"]
    return []


# --------------------------------------------------------------------------- #
# Test 1: Full lifecycle
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_full_lifecycle_space_token_task_session_stats(client):
    """Full lifecycle: setup -> login -> create_space -> issue_token ->
    create_task -> create_session -> stats_overview -> delete_task ->
    trash_list_shows_tombstone.
    """
    # 1. Setup + login -> master token
    await client.post("/api/v1/auth/setup", json={"password": "test123"})
    resp = await client.post(
        "/api/v1/auth/login", json={"password": "test123"}
    )
    master_token = resp.json()["access_token"]
    master_headers = {"Authorization": f"Bearer {master_token}"}

    # 2. Create space + issue space token
    resp = await client.post(
        "/api/v1/spaces",
        json={"name": "Lifecycle Space"},
        headers=master_headers,
    )
    assert resp.status_code == 201
    space_id = resp.json()["id"]

    resp = await client.post(
        f"/api/v1/spaces/{space_id}/token", headers=master_headers
    )
    space_token = resp.json()["space_token"]
    headers = {"Authorization": f"Bearer {space_token}"}

    # 3. Create task
    resp = await client.post(
        "/api/v1/tasks",
        json={"title": "Lifecycle task", "status": "todo"},
        headers=headers,
    )
    assert resp.status_code == 201
    task_id = resp.json()["id"]

    # 4. Create session
    resp = await client.post(
        "/api/v1/sessions",
        json={
            "type": "work",
            "duration": 25,
            "completed": True,
            "started_at": "2026-01-01T10:00:00Z",
        },
        headers=headers,
    )
    assert resp.status_code == 201

    # 5. Stats overview (should reflect the session)
    resp = await client.get("/api/v1/stats/overview", headers=headers)
    assert resp.status_code == 200
    assert isinstance(resp.json(), dict)

    # 6. Delete task
    resp = await client.delete(f"/api/v1/tasks/{task_id}", headers=headers)
    assert resp.status_code == 200

    # 7. Trash list shows the tombstone
    resp = await client.get("/api/v1/trash", headers=headers)
    assert resp.status_code == 200
    items = _items(resp.json())
    assert len(items) >= 1
    task_entries = [i for i in items if i.get("entity_type") == "task"]
    assert len(task_entries) >= 1


# --------------------------------------------------------------------------- #
# Test 2: Note saga end-to-end consistency
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_note_saga_end_to_end_consistency(client):
    """Note saga: create -> get_meta -> get_content -> update_content ->
    hash_changed -> delete -> 404.
    """
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)

    # 1. Create note (writes .md + inserts DB row)
    resp = await client.post(
        "/api/v1/notes",
        json={"title": "Saga Note", "content": "Original content"},
        headers=headers,
    )
    assert resp.status_code == 201
    note_id = resp.json()["id"]
    original_hash = resp.json()["content_hash"]
    assert "content" not in resp.json()

    # 2. Get metadata (no content body)
    resp = await client.get(f"/api/v1/notes/{note_id}", headers=headers)
    assert resp.status_code == 200
    assert "content" not in resp.json()
    assert "content_hash" in resp.json()

    # 3. Get content (reads .md file)
    resp = await client.get(f"/api/v1/notes/{note_id}/content", headers=headers)
    assert resp.status_code == 200
    assert "Original content" in resp.text

    # 4. Update content -> hash changes
    resp = await client.put(
        f"/api/v1/notes/{note_id}",
        json={"content": "Updated content"},
        headers=headers,
    )
    assert resp.status_code == 200
    new_hash = resp.json()["content_hash"]
    assert new_hash != original_hash

    # 5. Delete (removes .md + DB row + tombstone)
    resp = await client.delete(f"/api/v1/notes/{note_id}", headers=headers)
    assert resp.status_code == 200

    # 6. Get after delete -> 404
    resp = await client.get(f"/api/v1/notes/{note_id}", headers=headers)
    assert resp.status_code == 404


# --------------------------------------------------------------------------- #
# Test 3: Cascade folder delete integration
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_cascade_folder_delete_integration(client):
    """Cascade: root/child/grandchild folders + note -> DELETE root ->
    all folders trashed + note unfiled (folder_id=None).

    The note is created without ``folder_id`` (so the .md file goes to the
    space root directory, which always exists on disk), then ``folder_id``
    is set via PUT (metadata-only update — no filesystem interaction).
    This avoids the file system layer's directory-existence check while
    still testing the cascade's ``folder_id`` clearing behaviour.
    """
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)

    # 1. Create root -> child -> grandchild
    resp = await client.post(
        "/api/v1/folders", json={"name": "Root"}, headers=headers
    )
    assert resp.status_code == 201
    root_id = resp.json()["id"]

    resp = await client.post(
        "/api/v1/folders",
        json={"name": "Child", "parent_id": root_id},
        headers=headers,
    )
    assert resp.status_code == 201
    child_id = resp.json()["id"]

    resp = await client.post(
        "/api/v1/folders",
        json={"name": "Grandchild", "parent_id": child_id},
        headers=headers,
    )
    assert resp.status_code == 201
    grandchild_id = resp.json()["id"]

    # 2. Create note without folder_id (file goes to space root on disk)
    resp = await client.post(
        "/api/v1/notes",
        json={"title": "Nested Note", "content": "data"},
        headers=headers,
    )
    assert resp.status_code == 201
    note_id = resp.json()["id"]

    # 3. Set folder_id via PUT (metadata-only, no filesystem check)
    resp = await client.put(
        f"/api/v1/notes/{note_id}",
        json={"folder_id": grandchild_id},
        headers=headers,
    )
    assert resp.status_code == 200
    assert resp.json().get("folder_id") == grandchild_id

    # 4. Delete root -> cascade soft-delete
    resp = await client.delete(f"/api/v1/folders/{root_id}", headers=headers)
    assert resp.status_code == 200

    # 5. All folders trashed (trashed_at set) or 404
    for fid in (root_id, child_id, grandchild_id):
        resp = await client.get(f"/api/v1/folders/{fid}", headers=headers)
        if resp.status_code == 200:
            assert resp.json().get("trashed_at") is not None
        else:
            assert resp.status_code == 404

    # 6. Note is unfiled (folder_id cleared to None by cascade)
    resp = await client.get(f"/api/v1/notes/{note_id}", headers=headers)
    assert resp.status_code == 200
    assert resp.json().get("folder_id") is None


# --------------------------------------------------------------------------- #
# Test 4: Gate — services must not import FastAPI
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_gate_services_do_not_import_fastapi(client):
    """Gate: no service module imports FastAPI (MCP reservation).

    Uses AST scanning to detect ``import fastapi`` or
    ``from fastapi import ...`` statements in all ``app/services/*.py``
    files.  String literals and comments are not flagged.
    """
    import ast
    from pathlib import Path

    services_dir = Path(__file__).resolve().parent.parent / "app" / "services"
    violations: list[str] = []

    for py_file in sorted(services_dir.glob("*.py")):
        if py_file.name == "__init__.py":
            continue
        tree = ast.parse(
            py_file.read_text(encoding="utf-8"), filename=str(py_file)
        )
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name == "fastapi" or alias.name.startswith("fastapi."):
                        violations.append(py_file.name)
            elif isinstance(node, ast.ImportFrom):
                if node.module and (
                    node.module == "fastapi"
                    or node.module.startswith("fastapi.")
                ):
                    violations.append(py_file.name)

    assert not violations, (
        f"Services must not import FastAPI (MCP reservation). "
        f"Violations: {violations}"
    )


# --------------------------------------------------------------------------- #
# Test 5: Gate — all v1 routes registered
# --------------------------------------------------------------------------- #

def _count_v1_operations(app) -> int:
    """Count registered v1 HTTP operations via OpenAPI (nested routers included)."""
    return sum(
        len(methods)
        for path, methods in app.openapi()["paths"].items()
        if path.startswith("/api/v1")
    )


@pytest.mark.asyncio
async def test_gate_all_v1_routes_registered(client):
    """Gate: at least 40 v1 routes registered in the app."""
    from app.main import create_app

    app = create_app()
    v1_count = _count_v1_operations(app)
    assert v1_count >= 40, (
        f"Only {v1_count} v1 routes registered (expected >= 40)"
    )
