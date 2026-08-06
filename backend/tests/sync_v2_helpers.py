"""Shared HTTP helpers for Sync v2 integration tests."""

from __future__ import annotations

import base64
import json
import uuid
from collections.abc import Mapping, Sequence
from typing import Any


def make_sync_v2_event(
    *,
    entity_type: str,
    entity_id: str,
    action: str,
    payload: Mapping[str, Any] | None = None,
    expected_version: int | None = None,
    client_updated_at: str = "2026-07-16T10:00:00.000Z",
) -> dict[str, Any]:
    return {
        "entity_type": entity_type,
        "entity_id": entity_id,
        "action": action,
        "payload": dict(payload or {}),
        "expected_version": expected_version,
        "client_updated_at": client_updated_at,
        "operation_id": f"op-{uuid.uuid4().hex}",
    }


async def recover_sync_v2(client, headers, client_id: str) -> tuple[list[dict[str, Any]], str]:
    records: list[dict[str, Any]] = []
    page_token: str | None = None
    while True:
        params = {"client_id": client_id}
        if page_token is not None:
            params["page_token"] = page_token
        response = await client.get(
            "/api/v1/sync/v2/recover", params=params, headers=headers
        )
        assert response.status_code == 200, response.text
        page = response.json()
        decoded = base64.b64decode(page["payload_jsonl_base64"], validate=True)
        records.extend(json.loads(line) for line in decoded.splitlines())
        if not page["has_more"]:
            return records, page["waterline_cursor"]
        page_token = page["next_page_token"]


async def ready_sync_v2_client(
    client, headers, *, client_id: str | None = None
) -> str:
    client_id = client_id or f"test-client-{uuid.uuid4().hex}"
    _records, waterline_cursor = await recover_sync_v2(client, headers, client_id)
    response = await client.post(
        "/api/v1/sync/v2/ack",
        json={"client_id": client_id, "cursor": waterline_cursor},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    return client_id


async def push_sync_v2(
    client,
    headers,
    client_id: str,
    events: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    response = await client.post(
        "/api/v1/sync/v2/push",
        json={
            "client_id": client_id,
            "batch_id": f"batch-{uuid.uuid4().hex}",
            "events": [dict(event) for event in events],
        },
        headers=headers,
    )
    assert response.status_code == 200, response.text
    return response.json()


async def pull_sync_v2(
    client,
    headers,
    client_id: str,
    *,
    cursor: str | None = None,
    limit: int = 100,
) -> dict[str, Any]:
    params = {"client_id": client_id, "limit": str(limit)}
    if cursor is not None:
        params["cursor"] = cursor
    response = await client.get(
        "/api/v1/sync/v2/pull", params=params, headers=headers
    )
    assert response.status_code == 200, response.text
    return response.json()
