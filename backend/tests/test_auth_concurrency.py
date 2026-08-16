from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import jwt
import pytest


@pytest.mark.asyncio
async def test_credential_bcrypt_runs_through_to_thread(monkeypatch) -> None:
    from app.auth.authority import CredentialAuthority

    calls: list[tuple[object, tuple[object, ...]]] = []

    async def fake_to_thread(function, *args):
        calls.append((function, args))
        return "$2b$12$" + "x" * 53

    monkeypatch.setattr(asyncio, "to_thread", fake_to_thread)
    await CredentialAuthority.hash_for_storage("test-password-123")
    assert calls and calls[0][1] == ("test-password-123",)


@pytest.mark.asyncio
async def test_concurrent_setup_has_one_created_and_one_stable_conflict(client) -> None:
    responses = await asyncio.gather(*[
        client.post(
            "/api/v1/auth/setup",
            json={"password": "test-password-123"},
        )
        for _ in range(2)
    ])
    assert sorted(response.status_code for response in responses) == [201, 409]
    conflict = next(response for response in responses if response.status_code == 409)
    assert conflict.json() == {
        "detail": "Admin password is already set",
        "error_type": "conflict",
    }


@pytest.mark.asyncio
async def test_epoch_one_is_issued_and_pre_epoch_token_is_rejected(client) -> None:
    from app.settings import settings

    await client.post(
        "/api/v1/auth/setup",
        json={"password": "test-password-123"},
    )
    login = await client.post(
        "/api/v1/auth/login",
        json={"password": "test-password-123"},
    )
    issued = jwt.decode(
        login.json()["access_token"],
        settings.secret_key,
        algorithms=[settings.algorithm],
    )
    assert issued["epoch"] == 1
    legacy = jwt.encode(
        {
            "sub": "admin",
            "type": "master",
            "exp": datetime.now(timezone.utc) + timedelta(hours=1),
        },
        settings.secret_key,
        algorithm=settings.algorithm,
    )
    rejected = await client.get(
        "/api/v1/auth/verify",
        headers={"Authorization": f"Bearer {legacy}"},
    )
    assert rejected.status_code == 401


@pytest.mark.asyncio
async def test_revoke_advances_epoch_and_invalidates_master_and_space_tokens(
    client,
) -> None:
    await client.post(
        "/api/v1/auth/setup",
        json={"password": "test-password-123"},
    )
    login = await client.post(
        "/api/v1/auth/login",
        json={"password": "test-password-123"},
    )
    master = login.json()["access_token"]
    created = await client.post(
        "/api/v1/spaces",
        json={"name": "epoch"},
        headers={"Authorization": f"Bearer {master}"},
    )
    space = await client.post(
        f"/api/v1/spaces/{created.json()['id']}/token",
        headers={"Authorization": f"Bearer {master}"},
    )
    revoked = await client.post(
        "/api/v1/auth/revoke",
        headers={"Authorization": f"Bearer {master}"},
    )
    assert revoked.status_code == 200
    assert revoked.json() == {"message": "Tokens revoked"}
    for token in (master, space.json()["space_token"]):
        response = await client.get(
            "/api/v1/auth/verify",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 401
    relogin = await client.post(
        "/api/v1/auth/login",
        json={"password": "test-password-123"},
    )
    assert relogin.status_code == 200
