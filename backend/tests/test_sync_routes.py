"""Breaking-cutover checks for removed legacy Sync operations."""

from __future__ import annotations

import pytest


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("post", "/api/v1/sync/push"),
        ("get", "/api/v1/sync/pull"),
        ("get", "/api/v1/sync/full"),
        ("get", "/api/v1/sync/status"),
    ],
)
async def test_legacy_sync_operations_are_absent(client, method: str, path: str) -> None:
    response = await getattr(client, method)(path)
    assert response.status_code == 404


async def test_legacy_sync_operations_are_absent_from_openapi(client) -> None:
    paths = (await client.get("/openapi.json")).json()["paths"]
    assert not {
        "/api/v1/sync/push",
        "/api/v1/sync/pull",
        "/api/v1/sync/full",
        "/api/v1/sync/status",
    } & paths.keys()
