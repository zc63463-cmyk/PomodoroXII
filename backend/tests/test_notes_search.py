"""Tests for GET /api/v1/notes/search — FTS5 + LIKE fallback search endpoint.

Covers PR-17: full-text search REST endpoint wrapping FileSystem.search /
search_in_folder. Validates title/body matches, short-query LIKE fallback,
folder_id filtering, and 422 on empty / whitespace-only q.
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


async def _create_note(client, headers, title, content, folder_id=None):
    payload = {"title": title, "content": content}
    if folder_id is not None:
        payload["folder_id"] = folder_id
    resp = await client.post("/api/v1/notes", json=payload, headers=headers)
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


# --------------------------------------------------------------------------- #
# Tests
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_search_returns_matching_title(client):
    """search should return notes whose title matches the query."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    await _create_note(client, headers, "Python Basics", "Learning programming")
    await _create_note(client, headers, "Java Intro", "Java is also fun")

    resp = await client.get(
        "/api/v1/notes/search", params={"q": "Python"}, headers=headers
    )
    assert resp.status_code == 200, resp.text
    results = resp.json()
    assert len(results) >= 1
    assert any(r["title"] == "Python Basics" for r in results)


@pytest.mark.asyncio
async def test_search_short_query_uses_like_fallback(client):
    """Queries shorter than 3 characters should use LIKE fallback and still match."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    await _create_note(client, headers, "AB", "AB is short query test")

    resp = await client.get(
        "/api/v1/notes/search", params={"q": "AB"}, headers=headers
    )
    assert resp.status_code == 200, resp.text
    results = resp.json()
    assert len(results) >= 1


@pytest.mark.asyncio
async def test_search_long_query_uses_fts(client):
    """Queries >= 3 characters should use FTS5 and match body content."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    await _create_note(
        client, headers, "FTS Doc", "Python programming language tutorial"
    )

    resp = await client.get(
        "/api/v1/notes/search",
        params={"q": "Python programming"},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    results = resp.json()
    assert len(results) >= 1
    assert any(r["title"] == "FTS Doc" for r in results)


@pytest.mark.asyncio
async def test_search_with_folder_id_returns_200(client):
    """search with folder_id param should be accepted (folder scoping is
    enforced at the FS layer; see test_search_ops.py for coverage)."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    await _create_note(client, headers, "Any", "any content")

    resp = await client.get(
        "/api/v1/notes/search",
        params={"q": "any", "folder_id": "nonexistent-folder"},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    # No notes in a nonexistent folder → empty list.
    assert resp.json() == []


@pytest.mark.asyncio
async def test_search_empty_q_returns_422(client):
    """Empty q should return 422 (FastAPI min_length=1 validation)."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.get(
        "/api/v1/notes/search", params={"q": ""}, headers=headers
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_search_whitespace_q_returns_422(client):
    """Whitespace-only q should return 422 (ValidationError after strip)."""
    space_token, _ = await _get_space_client(client)
    headers = _auth(space_token)
    resp = await client.get(
        "/api/v1/notes/search", params={"q": "   "}, headers=headers
    )
    assert resp.status_code == 422
