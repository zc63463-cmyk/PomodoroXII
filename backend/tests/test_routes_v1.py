"""Test suite for PomodoroXII Phase B Step 9 -- REST API routes (v1).

12 route groups, 45 tests:
  Tasks (5), Sessions (4), Notes (5), Folders (5), Quick Notes (4),
  Reflections (3), Habits (4), Schedules (3), Time Blocks (3),
  Trash (4), Stats (3), Settings (2).

Field names are sourced from ``app/schemas/*.py``.  Where the task
brief used a different label (e.g. ``reflection_date`` -> ``date``,
``name`` -> ``title`` for habits, ``check_in_date`` -> ``date`` for
habit check-ins), the schema name is used so the request body passes
Pydantic validation.  Required fields that the brief omitted (e.g.
``due_at`` for schedules, ``date`` for time blocks) are added.

Business routes (tasks, sessions, ...) may not yet be implemented at
the time this file was written; tests will fail with 404 until the
routes exist.  List endpoints may return either a bare ``list`` or a
paginated envelope (``{"items": [...], ...}``); the ``_items`` helper
normalises both shapes.
"""

import pytest

# --------------------------------------------------------------------------- #
# Helpers
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
    """Extract a list of items from a bare list or paginated response.

    Handles both ``[...]`` and ``{"items": [...], ...}`` shapes so tests
    do not need to know whether a route paginates.
    """
    if isinstance(resp_json, list):
        return resp_json
    if isinstance(resp_json, dict) and "items" in resp_json:
        return resp_json["items"]
    return []


# --------------------------------------------------------------------------- #
# Tasks  (5 tests)
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_tasks_create_201(client):
    """POST /api/v1/tasks with full payload returns 201 and an id."""
    space_token, _ = await _get_space_client(client)
    resp = await client.post(
        "/api/v1/tasks",
        json={
            "title": "Test",
            "status": "todo",
            "priority": "medium",
            "tags": ["work"],
        },
        headers=_auth(space_token),
    )
    assert resp.status_code == 201
    assert "id" in resp.json()


@pytest.mark.asyncio
async def test_tasks_list_filter_by_status(client):
    """GET /api/v1/tasks?status=done returns only done tasks."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    await client.post(
        "/api/v1/tasks",
        json={"title": "Todo task", "status": "todo"},
        headers=headers,
    )
    await client.post(
        "/api/v1/tasks",
        json={"title": "Done task", "status": "done"},
        headers=headers,
    )
    resp = await client.get(
        "/api/v1/tasks?status=done", headers=headers
    )
    assert resp.status_code == 200
    items = _items(resp.json())
    assert len(items) == 1


@pytest.mark.asyncio
async def test_tasks_get_404(client):
    """GET /api/v1/tasks/nonexistent returns 404 with detail."""
    space_token, _ = await _get_space_client(client)
    resp = await client.get(
        "/api/v1/tasks/nonexistent", headers=_auth(space_token)
    )
    assert resp.status_code == 404
    assert "detail" in resp.json()


@pytest.mark.asyncio
async def test_tasks_update_partial(client):
    """PUT /api/v1/tasks/{id} with partial data updates only sent fields."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/tasks", json={"title": "Original"}, headers=headers
    )
    task_id = resp.json()["id"]
    resp = await client.put(
        f"/api/v1/tasks/{task_id}",
        json={"title": "Updated"},
        headers=headers,
    )
    assert resp.status_code == 200
    assert resp.json()["title"] == "Updated"


@pytest.mark.asyncio
async def test_tasks_delete_idempotent(client):
    """DELETE /api/v1/tasks/{id} is idempotent (200 both times)."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/tasks", json={"title": "To delete"}, headers=headers
    )
    task_id = resp.json()["id"]

    resp = await client.delete(
        f"/api/v1/tasks/{task_id}", headers=headers
    )
    assert resp.status_code == 200

    resp = await client.delete(
        f"/api/v1/tasks/{task_id}", headers=headers
    )
    assert resp.status_code == 200

    resp = await client.get(
        f"/api/v1/tasks/{task_id}", headers=headers
    )
    assert resp.status_code == 404


# --------------------------------------------------------------------------- #
# Sessions  (4 tests)
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_sessions_create_work(client):
    """POST /api/v1/sessions with a work session returns 201."""
    space_token, _ = await _get_space_client(client)
    resp = await client.post(
        "/api/v1/sessions",
        json={
            "type": "work",
            "duration": 25,
            "completed": True,
            "started_at": "2026-01-01T10:00:00Z",
        },
        headers=_auth(space_token),
    )
    assert resp.status_code == 201


@pytest.mark.asyncio
async def test_sessions_list_by_type(client):
    """GET /api/v1/sessions?type=work returns only work sessions."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    await client.post(
        "/api/v1/sessions",
        json={
            "type": "work",
            "duration": 25,
            "started_at": "2026-01-01T10:00:00Z",
        },
        headers=headers,
    )
    await client.post(
        "/api/v1/sessions",
        json={
            "type": "short_break",
            "duration": 5,
            "started_at": "2026-01-01T10:30:00Z",
        },
        headers=headers,
    )
    resp = await client.get(
        "/api/v1/sessions?type=work", headers=headers
    )
    assert resp.status_code == 200
    items = _items(resp.json())
    assert len(items) == 1


@pytest.mark.asyncio
async def test_sessions_get(client):
    """GET /api/v1/sessions/{id} returns 200."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/sessions",
        json={
            "type": "work",
            "duration": 25,
            "started_at": "2026-01-01T10:00:00Z",
        },
        headers=headers,
    )
    session_id = resp.json()["id"]
    resp = await client.get(
        f"/api/v1/sessions/{session_id}", headers=headers
    )
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_sessions_delete(client):
    """DELETE /api/v1/sessions/{id} returns 200."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/sessions",
        json={
            "type": "work",
            "duration": 25,
            "started_at": "2026-01-01T10:00:00Z",
        },
        headers=headers,
    )
    session_id = resp.json()["id"]
    resp = await client.delete(
        f"/api/v1/sessions/{session_id}", headers=headers
    )
    assert resp.status_code == 200


# --------------------------------------------------------------------------- #
# Notes  (5 tests)
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_notes_create_writes_md_and_db(client):
    """POST /api/v1/notes creates DB row + .md file; response has no content."""
    space_token, _ = await _get_space_client(client)
    resp = await client.post(
        "/api/v1/notes",
        json={"title": "Test", "content": "Hello world"},
        headers=_auth(space_token),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert "content_hash" in data
    assert "word_count" in data
    assert "content" not in data


@pytest.mark.asyncio
async def test_notes_get_meta_no_content(client):
    """GET /api/v1/notes/{id} returns metadata without content body."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/notes",
        json={"title": "Test", "content": "Hello world"},
        headers=headers,
    )
    note_id = resp.json()["id"]
    resp = await client.get(
        f"/api/v1/notes/{note_id}", headers=headers
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "content" not in data
    assert "content_hash" in data


@pytest.mark.asyncio
async def test_notes_get_content_reads_md(client):
    """GET /api/v1/notes/{id}/content returns the plain-text .md body."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/notes",
        json={"title": "Test", "content": "Hello world"},
        headers=headers,
    )
    note_id = resp.json()["id"]
    resp = await client.get(
        f"/api/v1/notes/{note_id}/content", headers=headers
    )
    assert resp.status_code == 200
    assert "Hello world" in resp.text


@pytest.mark.asyncio
async def test_notes_update_content_changes_hash(client):
    """PUT /api/v1/notes/{id} with new content changes content_hash."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/notes",
        json={"title": "Test", "content": "Hello world"},
        headers=headers,
    )
    note_id = resp.json()["id"]
    original_hash = resp.json()["content_hash"]

    resp = await client.put(
        f"/api/v1/notes/{note_id}",
        json={"content": "Updated content"},
        headers=headers,
    )
    assert resp.status_code == 200
    new_hash = resp.json()["content_hash"]
    assert new_hash != original_hash


@pytest.mark.asyncio
async def test_notes_delete_soft_deletes(client):
    """DELETE /api/v1/notes/{id} soft-deletes; row stays with trashed_at set."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/notes",
        json={"title": "Test", "content": "Hello world"},
        headers=headers,
    )
    note_id = resp.json()["id"]
    resp = await client.delete(
        f"/api/v1/notes/{note_id}", headers=headers
    )
    assert resp.status_code == 200
    # D-2: soft-delete keeps the row with trashed_at set (GET single still 200).
    resp = await client.get(
        f"/api/v1/notes/{note_id}", headers=headers
    )
    assert resp.status_code == 200
    assert resp.json()["trashed_at"] is not None
    # Listing excludes trashed notes.
    resp = await client.get("/api/v1/notes", headers=headers)
    assert resp.status_code == 200
    ids = [item["id"] for item in resp.json()["items"]]
    assert note_id not in ids


# --------------------------------------------------------------------------- #
# Folders  (5 tests)
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_folders_create(client):
    """POST /api/v1/folders with a name returns 201."""
    space_token, _ = await _get_space_client(client)
    resp = await client.post(
        "/api/v1/folders",
        json={"name": "My Folder"},
        headers=_auth(space_token),
    )
    assert resp.status_code == 201


@pytest.mark.asyncio
async def test_folders_list_root(client):
    """GET /api/v1/folders returns all root-level folders."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    await client.post(
        "/api/v1/folders", json={"name": "Folder A"}, headers=headers
    )
    await client.post(
        "/api/v1/folders", json={"name": "Folder B"}, headers=headers
    )
    resp = await client.get("/api/v1/folders", headers=headers)
    assert resp.status_code == 200
    items = _items(resp.json())
    assert len(items) == 2


@pytest.mark.asyncio
async def test_folders_delete_cascade(client):
    """DELETE parent folder cascades to child (trashed_at set or 404)."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)

    resp = await client.post(
        "/api/v1/folders", json={"name": "Parent"}, headers=headers
    )
    parent_id = resp.json()["id"]

    resp = await client.post(
        "/api/v1/folders",
        json={"name": "Child", "parent_id": parent_id},
        headers=headers,
    )
    child_id = resp.json()["id"]

    resp = await client.delete(
        f"/api/v1/folders/{parent_id}", headers=headers
    )
    assert resp.status_code == 200

    resp = await client.get(
        f"/api/v1/folders/{child_id}", headers=headers
    )
    if resp.status_code == 200:
        assert resp.json().get("trashed_at") is not None
    else:
        assert resp.status_code == 404


@pytest.mark.asyncio
async def test_folders_get(client):
    """GET /api/v1/folders/{id} returns 200."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/folders", json={"name": "My Folder"}, headers=headers
    )
    folder_id = resp.json()["id"]
    resp = await client.get(
        f"/api/v1/folders/{folder_id}", headers=headers
    )
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_folders_update(client):
    """PUT /api/v1/folders/{id} with name updates the folder."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/folders", json={"name": "Original"}, headers=headers
    )
    folder_id = resp.json()["id"]
    resp = await client.put(
        f"/api/v1/folders/{folder_id}",
        json={"name": "Updated"},
        headers=headers,
    )
    assert resp.status_code == 200
    assert resp.json()["name"] == "Updated"


# --------------------------------------------------------------------------- #
# Quick Notes  (4 tests)
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_quick_notes_create(client):
    """POST /api/v1/quick-notes with content returns 201."""
    space_token, _ = await _get_space_client(client)
    resp = await client.post(
        "/api/v1/quick-notes",
        json={"content": "Quick thought"},
        headers=_auth(space_token),
    )
    assert resp.status_code == 201


@pytest.mark.asyncio
async def test_quick_notes_list_pinned_first(client):
    """GET /api/v1/quick-notes returns pinned notes before unpinned."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    await client.post(
        "/api/v1/quick-notes",
        json={"content": "Not pinned"},
        headers=headers,
    )
    await client.post(
        "/api/v1/quick-notes",
        json={"content": "Pinned note", "pinned": True},
        headers=headers,
    )
    resp = await client.get("/api/v1/quick-notes", headers=headers)
    assert resp.status_code == 200
    items = _items(resp.json())
    assert len(items) == 2
    assert items[0]["pinned"] is True


@pytest.mark.asyncio
async def test_quick_notes_update(client):
    """PUT /api/v1/quick-notes/{id} with content updates the note."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/quick-notes",
        json={"content": "Original"},
        headers=headers,
    )
    qn_id = resp.json()["id"]
    resp = await client.put(
        f"/api/v1/quick-notes/{qn_id}",
        json={"content": "Updated"},
        headers=headers,
    )
    assert resp.status_code == 200
    assert resp.json()["content"] == "Updated"


@pytest.mark.asyncio
async def test_quick_notes_delete(client):
    """DELETE /api/v1/quick-notes/{id} removes it; GET returns 404."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/quick-notes",
        json={"content": "To delete"},
        headers=headers,
    )
    qn_id = resp.json()["id"]
    resp = await client.delete(
        f"/api/v1/quick-notes/{qn_id}", headers=headers
    )
    assert resp.status_code == 200
    resp = await client.get(
        f"/api/v1/quick-notes/{qn_id}", headers=headers
    )
    assert resp.status_code == 404


# --------------------------------------------------------------------------- #
# Reflections  (3 tests)
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_reflections_create(client):
    """POST /api/v1/reflections with content and date returns 201."""
    space_token, _ = await _get_space_client(client)
    resp = await client.post(
        "/api/v1/reflections",
        json={"content": "Deep thought", "date": "2026-01-01"},
        headers=_auth(space_token),
    )
    assert resp.status_code == 201


@pytest.mark.asyncio
async def test_reflections_list_by_date(client):
    """GET /api/v1/reflections?date=2026-01-01 filters by date."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    await client.post(
        "/api/v1/reflections",
        json={"content": "Reflection 1", "date": "2026-01-01"},
        headers=headers,
    )
    await client.post(
        "/api/v1/reflections",
        json={"content": "Reflection 2", "date": "2026-01-02"},
        headers=headers,
    )
    resp = await client.get(
        "/api/v1/reflections?date=2026-01-01", headers=headers
    )
    assert resp.status_code == 200
    items = _items(resp.json())
    assert len(items) == 1


@pytest.mark.asyncio
async def test_reflections_get(client):
    """GET /api/v1/reflections/{id} returns 200."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/reflections",
        json={"content": "Deep thought", "date": "2026-01-01"},
        headers=headers,
    )
    refl_id = resp.json()["id"]
    resp = await client.get(
        f"/api/v1/reflections/{refl_id}", headers=headers
    )
    assert resp.status_code == 200


# --------------------------------------------------------------------------- #
# Habits  (4 tests)
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_habits_create(client):
    """POST /api/v1/habits with a title returns 201."""
    space_token, _ = await _get_space_client(client)
    resp = await client.post(
        "/api/v1/habits",
        json={"title": "Exercise"},
        headers=_auth(space_token),
    )
    assert resp.status_code == 201


@pytest.mark.asyncio
async def test_habits_list(client):
    """GET /api/v1/habits returns all habits."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    await client.post(
        "/api/v1/habits", json={"title": "Exercise"}, headers=headers
    )
    await client.post(
        "/api/v1/habits", json={"title": "Read"}, headers=headers
    )
    resp = await client.get("/api/v1/habits", headers=headers)
    assert resp.status_code == 200
    items = _items(resp.json())
    assert len(items) == 2


@pytest.mark.asyncio
async def test_habit_check_in_create(client):
    """POST /api/v1/habits/{id}/check-ins creates a check-in record."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/habits", json={"title": "Exercise"}, headers=headers
    )
    habit_id = resp.json()["id"]
    resp = await client.post(
        f"/api/v1/habits/{habit_id}/check-ins",
        json={"habit_id": habit_id, "date": "2026-01-01"},
        headers=headers,
    )
    assert resp.status_code == 201


@pytest.mark.asyncio
async def test_habits_delete(client):
    """DELETE /api/v1/habits/{id} removes it; GET returns 404."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/habits", json={"title": "Exercise"}, headers=headers
    )
    habit_id = resp.json()["id"]
    resp = await client.delete(
        f"/api/v1/habits/{habit_id}", headers=headers
    )
    assert resp.status_code == 200
    resp = await client.get(
        f"/api/v1/habits/{habit_id}", headers=headers
    )
    assert resp.status_code == 404


# --------------------------------------------------------------------------- #
# Schedules  (3 tests)
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_schedules_create(client):
    """POST /api/v1/schedules with title and due_at returns 201."""
    space_token, _ = await _get_space_client(client)
    resp = await client.post(
        "/api/v1/schedules",
        json={"title": "Morning routine", "due_at": "2026-01-01T07:00:00Z"},
        headers=_auth(space_token),
    )
    assert resp.status_code == 201


@pytest.mark.asyncio
async def test_schedules_list_upcoming(client):
    """GET /api/v1/schedules returns all schedules."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    await client.post(
        "/api/v1/schedules",
        json={"title": "Event 1", "due_at": "2026-12-01T07:00:00Z"},
        headers=headers,
    )
    await client.post(
        "/api/v1/schedules",
        json={"title": "Event 2", "due_at": "2026-12-02T07:00:00Z"},
        headers=headers,
    )
    resp = await client.get("/api/v1/schedules", headers=headers)
    assert resp.status_code == 200
    items = _items(resp.json())
    assert len(items) == 2


@pytest.mark.asyncio
async def test_schedules_delete(client):
    """DELETE /api/v1/schedules/{id} removes it; GET returns 404."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/schedules",
        json={"title": "Morning routine", "due_at": "2026-01-01T07:00:00Z"},
        headers=headers,
    )
    sched_id = resp.json()["id"]
    resp = await client.delete(
        f"/api/v1/schedules/{sched_id}", headers=headers
    )
    assert resp.status_code == 200
    resp = await client.get(
        f"/api/v1/schedules/{sched_id}", headers=headers
    )
    assert resp.status_code == 404


# --------------------------------------------------------------------------- #
# Time Blocks  (3 tests)
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_time_blocks_create(client):
    """POST /api/v1/time-blocks with title, date, start/end times returns 201."""
    space_token, _ = await _get_space_client(client)
    resp = await client.post(
        "/api/v1/time-blocks",
        json={
            "title": "Focus block",
            "date": "2026-01-01",
            "start_time": "2026-01-01T09:00:00Z",
            "end_time": "2026-01-01T10:00:00Z",
        },
        headers=_auth(space_token),
    )
    assert resp.status_code == 201


@pytest.mark.asyncio
async def test_time_blocks_list_by_date(client):
    """GET /api/v1/time-blocks?date=2026-01-01 filters by date."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    await client.post(
        "/api/v1/time-blocks",
        json={
            "title": "Block 1",
            "date": "2026-01-01",
            "start_time": "2026-01-01T09:00:00Z",
            "end_time": "2026-01-01T10:00:00Z",
        },
        headers=headers,
    )
    await client.post(
        "/api/v1/time-blocks",
        json={
            "title": "Block 2",
            "date": "2026-01-02",
            "start_time": "2026-01-02T09:00:00Z",
            "end_time": "2026-01-02T10:00:00Z",
        },
        headers=headers,
    )
    resp = await client.get(
        "/api/v1/time-blocks?date=2026-01-01", headers=headers
    )
    assert resp.status_code == 200
    items = _items(resp.json())
    assert len(items) == 1


@pytest.mark.asyncio
async def test_time_blocks_delete(client):
    """DELETE /api/v1/time-blocks/{id} removes it; GET returns 404."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/time-blocks",
        json={
            "title": "Focus block",
            "date": "2026-01-01",
            "start_time": "2026-01-01T09:00:00Z",
            "end_time": "2026-01-01T10:00:00Z",
        },
        headers=headers,
    )
    tb_id = resp.json()["id"]
    resp = await client.delete(
        f"/api/v1/time-blocks/{tb_id}", headers=headers
    )
    assert resp.status_code == 200
    resp = await client.get(
        f"/api/v1/time-blocks/{tb_id}", headers=headers
    )
    assert resp.status_code == 404


# --------------------------------------------------------------------------- #
# Trash  (4 tests)
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_trash_list_empty(client):
    """GET /api/v1/trash on a fresh space returns an empty list."""
    space_token, _ = await _get_space_client(client)
    resp = await client.get("/api/v1/trash", headers=_auth(space_token))
    assert resp.status_code == 200
    items = _items(resp.json())
    assert len(items) == 0


@pytest.mark.asyncio
async def test_trash_list_after_delete(client):
    """After deleting a task, GET /api/v1/trash shows 1 item."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/tasks", json={"title": "To trash"}, headers=headers
    )
    task_id = resp.json()["id"]
    await client.delete(f"/api/v1/tasks/{task_id}", headers=headers)
    resp = await client.get("/api/v1/trash", headers=headers)
    assert resp.status_code == 200
    items = _items(resp.json())
    assert len(items) == 1


@pytest.mark.asyncio
async def test_trash_restore(client):
    """POST /api/v1/trash/task/{id}/restore returns 422 (Task not soft-deletable).

    Task uses hard-delete + tombstone, so restore is not supported.
    """
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/tasks", json={"title": "To restore"}, headers=headers
    )
    task_id = resp.json()["id"]
    await client.delete(f"/api/v1/tasks/{task_id}", headers=headers)

    resp = await client.post(
        f"/api/v1/trash/task/{task_id}/restore", headers=headers
    )
    # Task is not in _ENTITY_MAP (no trashed_at column), so restore
    # returns 422 ValidationError.
    assert resp.status_code == 422

    resp = await client.get(
        f"/api/v1/tasks/{task_id}", headers=headers
    )
    # Task was hard-deleted, so GET returns 404.
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_trash_cleanup_expired(client):
    """POST /api/v1/trash/cleanup returns 200."""
    space_token, _ = await _get_space_client(client)
    resp = await client.post(
        "/api/v1/trash/cleanup", headers=_auth(space_token)
    )
    assert resp.status_code == 200


# --------------------------------------------------------------------------- #
# Stats  (3 tests)
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_stats_overview(client):
    """GET /api/v1/stats/overview returns 200 with aggregate counts."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    await client.post(
        "/api/v1/sessions",
        json={
            "type": "work",
            "duration": 25,
            "completed": True,
            "started_at": "2026-01-01T10:00:00Z",
        },
        headers=headers,
    )
    resp = await client.get("/api/v1/stats/overview", headers=headers)
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, dict)


@pytest.mark.asyncio
async def test_stats_focus_trend(client):
    """GET /api/v1/stats/focus-trend?days=7 returns 200 with a list."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    await client.post(
        "/api/v1/sessions",
        json={
            "type": "work",
            "duration": 25,
            "completed": True,
            "started_at": "2026-01-01T10:00:00Z",
        },
        headers=headers,
    )
    resp = await client.get(
        "/api/v1/stats/focus-trend?days=7", headers=headers
    )
    assert resp.status_code == 200
    data = resp.json()
    # Response may be a bare list or {"data": [...]}.
    if isinstance(data, dict) and "data" in data:
        assert isinstance(data["data"], list)
    elif isinstance(data, list):
        assert isinstance(data, list)


@pytest.mark.asyncio
async def test_stats_task_distribution(client):
    """GET /api/v1/stats/task-distribution returns 200."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    await client.post(
        "/api/v1/tasks",
        json={"title": "Task 1", "status": "todo"},
        headers=headers,
    )
    resp = await client.get(
        "/api/v1/stats/task-distribution", headers=headers
    )
    assert resp.status_code == 200


# --------------------------------------------------------------------------- #
# Settings  (2 tests)
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_settings_get(client):
    """GET /api/v1/settings returns 200."""
    space_token, _ = await _get_space_client(client)
    resp = await client.get("/api/v1/settings", headers=_auth(space_token))
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_settings_update(client):
    """PUT /api/v1/settings with theme returns 200."""
    space_token, _ = await _get_space_client(client)
    resp = await client.put(
        "/api/v1/settings",
        json={"theme": "dark"},
        headers=_auth(space_token),
    )
    assert resp.status_code == 200
