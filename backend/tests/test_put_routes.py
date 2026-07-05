"""Tests for PUT /{id} routes on sessions, habits, schedules, time_blocks,
and reflections (PR-19).

Each entity follows the same pattern: create → put (partial update) → get
verify → put on nonexistent id returns 404.
"""
from __future__ import annotations

import pytest

# --------------------------------------------------------------------------- #
# Helpers (mirrors test_routes_v1.py style)
# --------------------------------------------------------------------------- #

async def _get_space_client(client):
    """Set up admin password, log in, create a space, issue a space token."""
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
    return {"Authorization": f"Bearer {space_token}"}


# --------------------------------------------------------------------------- #
# Sessions
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_session_update_partial(client):
    """PUT /api/v1/sessions/{id} updates fields and returns 200."""
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
    sid = resp.json()["id"]
    resp = await client.put(
        f"/api/v1/sessions/{sid}",
        json={"duration": 30, "completed": True},
        headers=headers,
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["duration"] == 30
    assert data["completed"] is True

    resp = await client.get(f"/api/v1/sessions/{sid}", headers=headers)
    assert resp.json()["duration"] == 30


@pytest.mark.asyncio
async def test_session_update_404(client):
    """PUT /api/v1/sessions/{nonexistent} returns 404."""
    space_token, _ = await _get_space_client(client)
    resp = await client.put(
        "/api/v1/sessions/nonexistent",
        json={"duration": 30},
        headers=_auth(space_token),
    )
    assert resp.status_code == 404


# --------------------------------------------------------------------------- #
# Habits
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_habit_update_partial(client):
    """PUT /api/v1/habits/{id} updates fields and returns 200."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/habits",
        json={"title": "Exercise"},
        headers=headers,
    )
    hid = resp.json()["id"]
    resp = await client.put(
        f"/api/v1/habits/{hid}",
        json={"title": "Daily Exercise", "target_count": 3},
        headers=headers,
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["title"] == "Daily Exercise"
    assert data["target_count"] == 3


@pytest.mark.asyncio
async def test_habit_update_404(client):
    """PUT /api/v1/habits/{nonexistent} returns 404."""
    space_token, _ = await _get_space_client(client)
    resp = await client.put(
        "/api/v1/habits/nonexistent",
        json={"title": "X"},
        headers=_auth(space_token),
    )
    assert resp.status_code == 404


# --------------------------------------------------------------------------- #
# Schedules
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_schedule_update_partial(client):
    """PUT /api/v1/schedules/{id} updates fields and returns 200."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/schedules",
        json={"title": "Meeting", "due_at": "2026-01-01T10:00:00Z"},
        headers=headers,
    )
    sid = resp.json()["id"]
    resp = await client.put(
        f"/api/v1/schedules/{sid}",
        json={"title": "Updated Meeting", "priority": "high"},
        headers=headers,
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["title"] == "Updated Meeting"
    assert data["priority"] == "high"


@pytest.mark.asyncio
async def test_schedule_update_404(client):
    """PUT /api/v1/schedules/{nonexistent} returns 404."""
    space_token, _ = await _get_space_client(client)
    resp = await client.put(
        "/api/v1/schedules/nonexistent",
        json={"title": "X"},
        headers=_auth(space_token),
    )
    assert resp.status_code == 404


# --------------------------------------------------------------------------- #
# Time Blocks
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_time_block_update_partial(client):
    """PUT /api/v1/time-blocks/{id} updates fields and returns 200."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/time-blocks",
        json={
            "title": "Focus",
            "date": "2026-01-01",
            "start_time": "09:00",
            "end_time": "10:00",
        },
        headers=headers,
    )
    tid = resp.json()["id"]
    resp = await client.put(
        f"/api/v1/time-blocks/{tid}",
        json={"title": "Deep Focus", "status": "completed"},
        headers=headers,
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["title"] == "Deep Focus"
    assert data["status"] == "completed"


@pytest.mark.asyncio
async def test_time_block_update_404(client):
    """PUT /api/v1/time-blocks/{nonexistent} returns 404."""
    space_token, _ = await _get_space_client(client)
    resp = await client.put(
        "/api/v1/time-blocks/nonexistent",
        json={"title": "X"},
        headers=_auth(space_token),
    )
    assert resp.status_code == 404


# --------------------------------------------------------------------------- #
# Reflections
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_reflection_update_partial(client):
    """PUT /api/v1/reflections/{id} updates fields and returns 200."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.post(
        "/api/v1/reflections",
        json={"date": "2026-01-01", "content": "Good day"},
        headers=headers,
    )
    rid = resp.json()["id"]
    resp = await client.put(
        f"/api/v1/reflections/{rid}",
        json={"content": "Great day", "mood": "great"},
        headers=headers,
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["content"] == "Great day"
    assert data["mood"] == "great"


@pytest.mark.asyncio
async def test_reflection_update_404(client):
    """PUT /api/v1/reflections/{nonexistent} returns 404."""
    space_token, _ = await _get_space_client(client)
    resp = await client.put(
        "/api/v1/reflections/nonexistent",
        json={"content": "X"},
        headers=_auth(space_token),
    )
    assert resp.status_code == 404
