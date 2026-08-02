"""P2-1: Verify all list endpoints return PaginatedResponse envelope.

Each test creates a few rows then asserts the response JSON has the
shape ``{"items": [...], "total": N, "limit": ..., "offset": ..., "has_more": ...}``
as defined by ``app.schemas.common.PaginatedResponse``.

11 tests covering 11 list endpoints across 10 route files:
  tasks, notes, folders, sessions, schedules, time_blocks,
  reflections, quick_notes, habits (list_habits + list_check_ins), trash.
"""

import pytest

pytestmark = pytest.mark.provisioned_space_storage


async def _get_space_client(client):
    """Set up admin password, log in, create a space, issue a space token."""
    await client.post("/api/v1/auth/setup", json={"password": "test-password-123"})
    resp = await client.post(
        "/api/v1/auth/login", json={"password": "test-password-123"}
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
    return {"Authorization": f"Bearer {space_token}"}


def _assert_paginated_envelope(data: dict, expected_total: int) -> None:
    """Assert the response matches PaginatedResponse schema."""
    assert isinstance(data, dict), f"Expected dict, got {type(data).__name__}"
    assert "items" in data, "Missing 'items' field"
    assert "total" in data, "Missing 'total' field"
    assert "limit" in data, "Missing 'limit' field"
    assert "offset" in data, "Missing 'offset' field"
    assert "has_more" in data, "Missing 'has_more' field"
    assert isinstance(data["items"], list), "'items' must be a list"
    assert isinstance(data["total"], int), "'total' must be int"
    assert isinstance(data["has_more"], bool), "'has_more' must be bool"
    assert data["total"] == expected_total, (
        f"Expected total={expected_total}, got {data['total']}"
    )


# --------------------------------------------------------------------------- #
# Tasks
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_list_tasks_returns_paginated_envelope(client):
    """GET /api/v1/tasks returns PaginatedResponse envelope."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    for i in range(3):
        await client.post(
            "/api/v1/tasks",
            json={"title": f"Task-{i}", "status": "todo"},
            headers=headers,
        )
    resp = await client.get("/api/v1/tasks", headers=headers)
    assert resp.status_code == 200
    _assert_paginated_envelope(resp.json(), expected_total=3)


# --------------------------------------------------------------------------- #
# Notes
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_list_notes_returns_paginated_envelope(client):
    """GET /api/v1/notes returns PaginatedResponse envelope."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    for i in range(2):
        await client.post(
            "/api/v1/notes",
            json={"title": f"Note-{i}", "content": f"Body {i}"},
            headers=headers,
        )
    resp = await client.get("/api/v1/notes", headers=headers)
    assert resp.status_code == 200
    _assert_paginated_envelope(resp.json(), expected_total=2)


# --------------------------------------------------------------------------- #
# Folders
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_list_folders_returns_paginated_envelope(client):
    """GET /api/v1/folders returns PaginatedResponse envelope."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    for i in range(2):
        await client.post(
            "/api/v1/folders",
            json={"name": f"Folder-{i}"},
            headers=headers,
        )
    resp = await client.get("/api/v1/folders", headers=headers)
    assert resp.status_code == 200
    _assert_paginated_envelope(resp.json(), expected_total=2)


# --------------------------------------------------------------------------- #
# Sessions
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_list_sessions_returns_paginated_envelope(client):
    """GET /api/v1/sessions returns PaginatedResponse envelope."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    for i in range(3):
        await client.post(
            "/api/v1/sessions",
            json={
                "type": "work",
                "started_at": f"2026-07-04T0{i}:00:00Z",
                "duration": 1500,
            },
            headers=headers,
        )
    resp = await client.get("/api/v1/sessions", headers=headers)
    assert resp.status_code == 200
    _assert_paginated_envelope(resp.json(), expected_total=3)


# --------------------------------------------------------------------------- #
# Schedules
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_list_schedules_returns_paginated_envelope(client):
    """GET /api/v1/schedules returns PaginatedResponse envelope."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    # Note: schedules only returns upcoming (incomplete, due >= now).
    future = "2099-12-31T23:59:59Z"
    for i in range(2):
        await client.post(
            "/api/v1/schedules",
            json={"title": f"Sch-{i}", "due_at": future},
            headers=headers,
        )
    resp = await client.get("/api/v1/schedules", headers=headers)
    assert resp.status_code == 200
    _assert_paginated_envelope(resp.json(), expected_total=2)


# --------------------------------------------------------------------------- #
# Time Blocks
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_list_time_blocks_returns_paginated_envelope(client):
    """GET /api/v1/time-blocks returns PaginatedResponse envelope."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    for i in range(2):
        await client.post(
            "/api/v1/time-blocks",
            json={
                "title": f"TB-{i}",
                "date": "2026-07-04",
                "start_time": f"0{i}:00:00",
                "end_time": f"0{i}:30:00",
            },
            headers=headers,
        )
    resp = await client.get("/api/v1/time-blocks", headers=headers)
    assert resp.status_code == 200
    _assert_paginated_envelope(resp.json(), expected_total=2)


# --------------------------------------------------------------------------- #
# Reflections
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_list_reflections_returns_paginated_envelope(client):
    """GET /api/v1/reflections returns PaginatedResponse envelope."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    for i in range(2):
        await client.post(
            "/api/v1/reflections",
            json={"date": f"2026-07-0{i}", "content": f"Reflection {i}"},
            headers=headers,
        )
    resp = await client.get("/api/v1/reflections", headers=headers)
    assert resp.status_code == 200
    _assert_paginated_envelope(resp.json(), expected_total=2)


# --------------------------------------------------------------------------- #
# Quick Notes
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_list_quick_notes_returns_paginated_envelope(client):
    """GET /api/v1/quick-notes returns PaginatedResponse envelope."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    for i in range(3):
        await client.post(
            "/api/v1/quick-notes",
            json={"content": f"Quick note {i}"},
            headers=headers,
        )
    resp = await client.get("/api/v1/quick-notes", headers=headers)
    assert resp.status_code == 200
    _assert_paginated_envelope(resp.json(), expected_total=3)


# --------------------------------------------------------------------------- #
# Habits
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_list_habits_returns_paginated_envelope(client):
    """GET /api/v1/habits returns PaginatedResponse envelope."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    for i in range(2):
        await client.post(
            "/api/v1/habits",
            json={"title": f"Habit-{i}"},
            headers=headers,
        )
    resp = await client.get("/api/v1/habits", headers=headers)
    assert resp.status_code == 200
    _assert_paginated_envelope(resp.json(), expected_total=2)


@pytest.mark.asyncio
async def test_list_habit_check_ins_returns_paginated_envelope(client):
    """GET /api/v1/habits/{id}/check-ins returns PaginatedResponse envelope."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/habits",
        json={"title": "Habit"},
        headers=headers,
    )
    habit_id = resp.json()["id"]
    for i in range(2):
        await client.post(
            f"/api/v1/habits/{habit_id}/check-ins",
            json={"habit_id": habit_id, "date": f"2026-07-0{i + 1}"},
            headers=headers,
        )
    resp = await client.get(
        f"/api/v1/habits/{habit_id}/check-ins", headers=headers
    )
    assert resp.status_code == 200
    _assert_paginated_envelope(resp.json(), expected_total=2)


# --------------------------------------------------------------------------- #
# Trash
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_list_trash_returns_paginated_envelope(client):
    """GET /api/v1/trash returns PaginatedResponse envelope."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    # Create a note then soft-delete it via PUT (trashed_at).
    # Actually, soft-delete happens via the folder cascade or trash endpoints.
    # Simpler: create a quick note, then delete it (which creates a tombstone).
    create_resp = await client.post(
        "/api/v1/quick-notes",
        json={"content": "To be deleted"},
        headers=headers,
    )
    qn_id = create_resp.json()["id"]
    # DELETE on quick_note creates a tombstone (hard delete for quick_note?
    # Actually the trash.py shows quick_note uses trashed_at via restore).
    # Use trash purge to ensure an entry appears in tombstones.
    await client.delete(
        f"/api/v1/trash/quick_note/{qn_id}", headers=headers
    )
    resp = await client.get("/api/v1/trash", headers=headers)
    assert resp.status_code == 200
    data = resp.json()
    # Trash may include tombstones + trashed items; total >= 1.
    _assert_paginated_envelope(data, expected_total=len(data["items"]))
    assert data["total"] >= 1, "Expected at least one trashed item"


# --------------------------------------------------------------------------- #
# Stable tie ordering
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_pagination_is_stable_with_tied_sort_keys(client):
    """Pagination returns items in stable deterministic order when sort keys collide.

    Creates 5 schedules sharing the same due_at, then paginates with
    per_page=2.  IDs must appear in ascending order across all pages,
    and the same order must be reproducible across repeated requests.
    """
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    future = "2099-12-31T23:59:59Z"
    created_ids: list[str] = []
    for i in range(5):
        resp = await client.post(
            "/api/v1/schedules",
            json={"title": f"Tie-{i}", "due_at": future},
            headers=headers,
        )
        assert resp.status_code == 201
        created_ids.append(resp.json()["id"])

    # First pass: collect all IDs in page order.
    seen_ids: list[str] = []
    page = 1
    while True:
        resp = await client.get(
            f"/api/v1/schedules?page={page}&per_page=2",
            headers=headers,
        )
        assert resp.status_code == 200
        data = resp.json()
        _assert_paginated_envelope(data, expected_total=5)
        seen_ids.extend(item["id"] for item in data["items"])
        if not data["has_more"]:
            break
        page += 1
        assert page <= 20, "Pagination loop detected"

    # All items present, no duplicates.
    assert len(seen_ids) == 5
    assert set(seen_ids) == set(created_ids)

    # IDs must be in ascending order (stable tiebreaker: primary_key ASC).
    assert seen_ids == sorted(seen_ids), (
        f"IDs not in ascending order: {seen_ids}"
    )

    # Second pass: re-request page 1 and verify same order (reproducible).
    resp = await client.get(
        "/api/v1/schedules?page=1&per_page=2", headers=headers
    )
    assert resp.status_code == 200
    page1_ids = [item["id"] for item in resp.json()["items"]]
    assert page1_ids == seen_ids[:2], (
        f"Page 1 not reproducible: {page1_ids} vs {seen_ids[:2]}"
    )
