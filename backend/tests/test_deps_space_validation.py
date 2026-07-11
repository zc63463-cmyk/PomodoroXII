"""Tests for deps.get_space_context (P3.6: space_id existence check)."""
from __future__ import annotations

import pytest
from fastapi.security import HTTPAuthorizationCredentials


@pytest.mark.asyncio
async def test_get_space_context_rejects_nonexistent_space_id(client):
    """A space token payload with a non-existent space_id should be rejected.

    P3.6 makes get_space_context query the meta DB to verify the space_id
    actually points to an existing Space row. Forged tokens (or tokens
    pointing at deleted spaces) must be rejected with AuthenticationError.
    """
    from app.deps import get_space_context
    from app.errors import AuthenticationError

    # Forge a space token payload with a non-existent space_id.
    fake_user = {
        "sub": "admin",
        "type": "space",
        "space_id": "non-existent-space-id-xxx",
    }
    with pytest.raises(AuthenticationError):
        await get_space_context(user=fake_user)


@pytest.mark.asyncio
async def test_get_space_context_accepts_existing_space_id(client):
    """A space token pointing at an existing space should be accepted."""
    from app.deps import get_current_user, get_space_context

    # Issue a real space token via the API.
    resp = await client.post(
        "/api/v1/auth/setup", json={"password": "test-password-123"}
    )
    assert resp.status_code in (200, 201)
    master_token = (
        await client.post(
            "/api/v1/auth/login", json={"password": "test-password-123"}
        )
    ).json()["access_token"]
    headers = {"Authorization": f"Bearer {master_token}"}
    space_id = (
        await client.post(
            "/api/v1/spaces", json={"name": "Real"}, headers=headers
        )
    ).json()["id"]
    space_token = (
        await client.post(
            f"/api/v1/spaces/{space_id}/token", headers=headers
        )
    ).json()["space_token"]

    payload = await get_current_user(
        credentials=HTTPAuthorizationCredentials(scheme="Bearer", credentials=space_token)
    )
    ctx = await get_space_context(user=payload)
    assert ctx["space_id"] == space_id
