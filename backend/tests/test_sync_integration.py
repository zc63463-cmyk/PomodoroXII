"""End-to-end Sync v2 integration tests across HTTP, protocol, and storage."""

from __future__ import annotations

import base64
import json
import uuid

import pytest

pytestmark = pytest.mark.provisioned_space_storage


async def _setup_sync_client(client, client_id: str = "integration-client"):
    setup = await client.post("/api/v1/auth/setup", json={"password": "test-password-123"})
    assert setup.status_code in (200, 201)
    login = await client.post("/api/v1/auth/login", json={"password": "test-password-123"})
    master = {"Authorization": f"Bearer {login.json()['access_token']}"}
    created = await client.post(
        "/api/v1/spaces", json={"name": "Integration Space"}, headers=master
    )
    token = await client.post(
        f"/api/v1/spaces/{created.json()['id']}/token", headers=master
    )
    headers = {"Authorization": f"Bearer {token.json()['space_token']}"}

    recovery = await client.get(
        "/api/v1/sync/v2/recover", params={"client_id": client_id}, headers=headers
    )
    assert recovery.status_code == 200, recovery.text
    page = recovery.json()
    while page["has_more"]:
        recovery = await client.get(
            "/api/v1/sync/v2/recover",
            params={"client_id": client_id, "page_token": page["next_page_token"]},
            headers=headers,
        )
        assert recovery.status_code == 200, recovery.text
        page = recovery.json()
    acknowledged = await client.post(
        "/api/v1/sync/v2/ack",
        json={"client_id": client_id, "cursor": page["waterline_cursor"]},
        headers=headers,
    )
    assert acknowledged.status_code == 200, acknowledged.text
    return headers, client_id


def _make_event(
    *,
    entity_type: str = "habit",
    action: str = "create",
    entity_id: str | None = None,
    payload: dict | None = None,
    expected_version: int | None = None,
    client_updated_at: str = "2026-07-16T10:00:00.000Z",
) -> dict:
    return {
        "entity_type": entity_type,
        "entity_id": entity_id or uuid.uuid4().hex,
        "action": action,
        "payload": payload or {},
        "expected_version": expected_version,
        "client_updated_at": client_updated_at,
        "operation_id": f"op-{uuid.uuid4().hex}",
    }


async def _push(client, headers, client_id: str, events, *, batch_id: str | None = None):
    """推送一批事件。batch_id 不传则新生成 —— 重放必须显式传回原 batch_id。"""
    response = await _push_raw(
        client,
        headers,
        client_id,
        events,
        batch_id=batch_id or f"batch-{uuid.uuid4().hex}",
    )
    assert response.status_code == 200, response.text
    return response.json()


async def _push_raw(client, headers, client_id: str, events, *, batch_id: str):
    """不断言状态码，供需要检查 409 等拒绝响应的用例使用。"""
    return await client.post(
        "/api/v1/sync/v2/push",
        json={"client_id": client_id, "batch_id": batch_id, "events": events},
        headers=headers,
    )


async def _pull(
    client,
    headers,
    client_id: str,
    *,
    cursor: str | None = None,
    limit: int = 100,
    scope: str = "",
):
    params = {"client_id": client_id, "limit": str(limit)}
    if cursor is not None:
        params["cursor"] = cursor
    if scope:
        params["scope"] = scope
    response = await client.get("/api/v1/sync/v2/pull", params=params, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


async def test_full_sync_roundtrip_create_pull(client):
    headers, client_id = await _setup_sync_client(client)
    entity_id = uuid.uuid4().hex
    await _push(
        client,
        headers,
        client_id,
        [_make_event(entity_id=entity_id, payload={"id": entity_id, "title": "Roundtrip"})],
    )

    first = await _pull(client, headers, client_id)
    assert entity_id in {event["entity_id"] for event in first["events"]}
    assert first["next_cursor"]
    second = await _pull(client, headers, client_id, cursor=first["next_cursor"])
    assert entity_id not in {event["entity_id"] for event in second["events"]}


async def test_quick_note_sync_roundtrip_preserves_array_tags(client):
    headers, client_id = await _setup_sync_client(client)
    entity_id = uuid.uuid4().hex
    created = await _push(
        client,
        headers,
        client_id,
        [
            _make_event(
                entity_type="quickNote",
                entity_id=entity_id,
                payload={"id": entity_id, "content": "Synced", "tags": ["sync", "multi-device"]},
            )
        ],
    )
    assert created["errors"] == []
    updated = await _push(
        client,
        headers,
        client_id,
        [
            _make_event(
                entity_type="quickNote",
                entity_id=entity_id,
                action="update",
                expected_version=1,
                payload={"content": "Updated", "tags": ["synced"]},
                client_updated_at="2026-07-16T12:00:00.000Z",
            )
        ],
    )
    assert updated["errors"] == []
    pulled = await _pull(client, headers, client_id)
    update = next(
        event
        for event in pulled["events"]
        if event["entity_id"] == entity_id and event["action"] == "update"
    )
    assert update["payload"]["content"] == "Updated"
    assert update["payload"]["tags"] == ["synced"]


async def test_full_sync_roundtrip_update_lww(client):
    headers, client_id = await _setup_sync_client(client)
    entity_id = uuid.uuid4().hex
    await _push(
        client,
        headers,
        client_id,
        [_make_event(entity_id=entity_id, payload={"id": entity_id, "title": "Original"})],
    )
    updated = await _push(
        client,
        headers,
        client_id,
        [
            _make_event(
                entity_id=entity_id,
                action="update",
                expected_version=0,
                payload={"title": "Updated Title"},
                client_updated_at="2026-07-16T12:00:00.000Z",
            )
        ],
    )
    assert updated["applied"][0]["resolution"] == "remote"


async def test_sync_roundtrip_delete_via_habit_route_creates_tombstone(client):
    headers, client_id = await _setup_sync_client(client)
    entity_id = uuid.uuid4().hex
    await _push(
        client,
        headers,
        client_id,
        [_make_event(entity_id=entity_id, payload={"id": entity_id, "title": "Delete"})],
    )
    deleted = await client.delete(f"/api/v1/habits/{entity_id}", headers=headers)
    assert deleted.status_code in (200, 204)
    pulled = await _pull(client, headers, client_id)
    assert any(
        event["entity_id"] == entity_id and event["action"] == "delete"
        for event in pulled["events"]
    )


async def test_sync_roundtrip_delete_via_push_writes_tombstone(client):
    headers, client_id = await _setup_sync_client(client)
    entity_id = uuid.uuid4().hex
    await _push(
        client,
        headers,
        client_id,
        [_make_event(entity_id=entity_id, payload={"id": entity_id, "title": "Delete"})],
    )
    deleted = await _push(
        client,
        headers,
        client_id,
        [_make_event(entity_id=entity_id, action="delete", expected_version=1)],
    )
    assert deleted["errors"] == []
    assert deleted["applied"][0]["entity_id"] == entity_id


async def test_sync_status_reflects_visible_events(client):
    headers, client_id = await _setup_sync_client(client)
    await _push(
        client,
        headers,
        client_id,
        [
            _make_event(entity_id=f"status-habit-{index}", payload={"id": f"status-habit-{index}", "title": f"S{index}"})
            for index in range(3)
        ],
    )
    response = await client.get(
        "/api/v1/sync/v2/status", params={"client_id": client_id}, headers=headers
    )
    assert response.status_code == 200
    assert response.json()["visible_event_count"] >= 3
    assert response.json()["registered"] is True


async def test_new_client_recovery_excludes_deleted_entities(client):
    headers, _client_id = await _setup_sync_client(client)
    tombstone_ids = []
    for index in range(2):
        created = await client.post(
            "/api/v1/habits", json={"title": f"Tombstone {index}"}, headers=headers
        )
        assert created.status_code == 201, created.text
        entity_id = created.json()["id"]
        deleted = await client.delete(f"/api/v1/habits/{entity_id}", headers=headers)
        assert deleted.status_code in (200, 204)
        tombstone_ids.append(entity_id)

    recovery_client = "recovery-client"
    page_token = None
    records = []
    while True:
        params = {"client_id": recovery_client}
        if page_token is not None:
            params["page_token"] = page_token
        response = await client.get("/api/v1/sync/v2/recover", params=params, headers=headers)
        assert response.status_code == 200, response.text
        page = response.json()
        decoded = base64.b64decode(page["payload_jsonl_base64"])
        records.extend(json.loads(line) for line in decoded.splitlines())
        if not page["has_more"]:
            break
        page_token = page["next_page_token"]
    recovered_ids = {
        record["entity_id"]
        for record in records
        if record.get("entity_type") == "habit"
    }
    assert set(tombstone_ids).isdisjoint(recovered_ids)


async def test_sync_handles_mixed_batch(client):
    headers, client_id = await _setup_sync_client(client)
    update_id, delete_id = uuid.uuid4().hex, uuid.uuid4().hex
    await _push(
        client,
        headers,
        client_id,
        [
            _make_event(entity_id=update_id, payload={"id": update_id, "title": "Update"}),
            _make_event(entity_id=delete_id, payload={"id": delete_id, "title": "Delete"}),
        ],
    )
    new_id = uuid.uuid4().hex
    result = await _push(
        client,
        headers,
        client_id,
        [
            _make_event(entity_id=update_id, action="update", expected_version=1, payload={"title": "Updated"}),
            _make_event(entity_id=delete_id, action="delete", expected_version=1),
            _make_event(entity_id=new_id, payload={"id": new_id, "title": "New"}),
        ],
    )
    assert len(result["applied"]) == 3
    assert result["errors"] == []


async def test_sync_push_unknown_entity_returns_error(client):
    headers, client_id = await _setup_sync_client(client)
    result = await _push(
        client,
        headers,
        client_id,
        [_make_event(entity_type="invalidEntity", entity_id="x", payload={"id": "x"})],
    )
    assert len(result["errors"]) == 1
    assert result["errors"][0]["entity_type"] == "invalidEntity"


async def test_sync_pagination_uses_opaque_cursor(client):
    headers, client_id = await _setup_sync_client(client)
    await _push(
        client,
        headers,
        client_id,
        [
            _make_event(entity_id=f"page-{index}", payload={"id": f"page-{index}", "title": f"Page {index}"})
            for index in range(5)
        ],
    )
    first = await _pull(client, headers, client_id, limit=2)
    assert first["has_more"] is True
    assert len(first["events"]) == 2
    assert isinstance(first["next_cursor"], str)
    assert not first["next_cursor"].isdigit()
    second = await _pull(client, headers, client_id, cursor=first["next_cursor"], limit=2)
    assert {item["operation_id"] for item in first["events"]}.isdisjoint(
        {item["operation_id"] for item in second["events"]}
    )


async def test_sync_push_rejects_stale_update_with_lww_conflict(client):
    headers, client_id = await _setup_sync_client(client)
    entity_id = uuid.uuid4().hex
    await _push(
        client,
        headers,
        client_id,
        [
            _make_event(
                entity_id=entity_id,
                payload={"id": entity_id, "title": "Original"},
                client_updated_at="2026-07-16T12:00:00.000Z",
            )
        ],
    )
    stale = await _push(
        client,
        headers,
        client_id,
        [
            _make_event(
                entity_id=entity_id,
                action="update",
                expected_version=0,
                payload={"title": "Stale"},
                client_updated_at="2026-07-16T10:00:00.000Z",
            )
        ],
    )
    assert stale["conflicts"][0]["resolution"] == "local"
    # QN-S8b: the conflict carries the authoritative remote post-image and
    # version so accept-remote can converge immediately without a re-pull.
    conflict = stale["conflicts"][0]
    assert conflict["code"] == "version_conflict"
    assert conflict["version"] == 1
    assert conflict["snapshot"]["id"] == entity_id
    assert conflict["snapshot"]["title"] == "Original"
    assert conflict["snapshot"]["version"] == 1
    assert conflict["details"]["entityId"] == entity_id


async def test_pull_scope_returns_only_that_scope(client):
    """★ 按作用域订阅：只返回该作用域内的实体类型。

    这里只推一条 habit（属 planning），用「订阅 planning 拿得到、
    订阅 notes 拿不到」来证明过滤生效 —— 比推两个实体更聚焦，
    也避开了各实体 payload 必填字段的差异。
    """
    headers, client_id = await _setup_sync_client(client)
    habit_id = uuid.uuid4().hex
    await _push(
        client,
        headers,
        client_id,
        [
            _make_event(
                entity_id=habit_id,
                payload={"id": habit_id, "title": "Habit"},
            )
        ],
    )

    # planning 含 habit
    planning = await _pull(client, headers, client_id, scope="planning")
    assert {event["entity_type"] for event in planning["events"]} == {"habit"}

    # notes 不含 habit → 空页，但游标照常签发（不报错）
    notes = await _pull(client, headers, client_id, scope="notes")
    assert notes["events"] == []

    # 不带 scope → 全量，与加作用域之前的行为一致
    everything = await _pull(client, headers, client_id)
    assert {event["entity_type"] for event in everything["events"]} == {"habit"}


async def test_cursor_bound_to_one_scope_is_rejected_elsewhere(client):
    """★ 作用域与游标是绑定的：拿 planning 的游标去拉 notes 必须被拒。

    否则就会出现「越过未订阅事件且无法找回」的静默丢数据
    （见《同步作用域切片-实施方案》第 1 节）。
    """
    headers, client_id = await _setup_sync_client(client)
    habit_id = uuid.uuid4().hex
    await _push(
        client,
        headers,
        client_id,
        [
            _make_event(
                entity_type="habit",
                entity_id=habit_id,
                payload={"id": habit_id, "title": "Habit"},
            )
        ],
    )

    planning = await _pull(client, headers, client_id, scope="planning")
    planning_cursor = planning["next_cursor"]
    assert planning_cursor

    # 同一个游标换到别的作用域 → 要求重新全量恢复（而不是悄悄返回错误数据）
    cross = await client.get(
        "/api/v1/sync/v2/pull",
        params={"client_id": client_id, "cursor": planning_cursor, "scope": "notes"},
        headers=headers,
    )
    assert cross.status_code == 409, cross.text
    assert cross.json()["error_type"] == "sync_cursor_expired", cross.text

    # 但用在它自己的作用域上是正常的（已消费完 → 空页）
    again = await _pull(
        client, headers, client_id, cursor=planning_cursor, scope="planning"
    )
    assert again["events"] == []


async def test_cursor_advances_without_duplicates_for_tied_timestamps(client):
    headers, client_id = await _setup_sync_client(client)
    entity_ids = [uuid.uuid4().hex for _ in range(3)]
    await _push(
        client,
        headers,
        client_id,
        [
            _make_event(
                entity_id=entity_id,
                payload={"id": entity_id, "title": f"Tie {index}"},
                client_updated_at="2026-07-16T10:00:00.000Z",
            )
            for index, entity_id in enumerate(entity_ids)
        ],
    )
    first = await _pull(client, headers, client_id, limit=2)
    second = await _pull(client, headers, client_id, cursor=first["next_cursor"], limit=2)
    returned_ids = [event["entity_id"] for event in (*first["events"], *second["events"])]
    assert set(returned_ids) == set(entity_ids)
    assert len(returned_ids) == len(set(returned_ids))


async def test_push_replay_with_same_batch_id_writes_ledger_once(client):
    """★ 持据重放（相同 batch_id + 相同 operation_id）：账本只写一次。

    这是「客户端推送后未收到应答 → 重放」的正确性基础。服务端按 batch_id
    找回既有批次 receipt，校验请求哈希一致后**返回原结果**，而不是再写一遍
    账本 —— 否则一次网络抖动就会让实体 version 自增、下游收到重复事件。

    ★ 关键：幂等键是 **batch_id**，不是单个 operation_id。见下一条测试。
    """
    headers, client_id = await _setup_sync_client(client)
    entity_id = uuid.uuid4().hex
    batch_id = f"batch-replay-{uuid.uuid4().hex}"

    event = _make_event(entity_id=entity_id, payload={"id": entity_id, "title": "Replay"})

    first = await _push(client, headers, client_id, [event], batch_id=batch_id)
    assert first["applied"], first
    assert not first["errors"], first

    baseline = await _pull(client, headers, client_id)
    created = [item for item in baseline["events"] if item["entity_id"] == entity_id]
    assert len(created) == 1, baseline

    # 完全相同的批次再推一次 —— 模拟客户端没收到应答而持据重放
    replay = await _push(client, headers, client_id, [dict(event)], batch_id=batch_id)
    assert replay["applied"], replay
    assert not replay["errors"], replay

    # 重放后不应产生新的账本事件，实体版本也不应前进
    after = await _pull(client, headers, client_id, cursor=baseline["next_cursor"])
    assert [item for item in after["events"] if item["entity_id"] == entity_id] == [], after
    assert {item["version"] for item in created} == {1}, created


async def test_push_same_operation_id_under_different_batch_is_rejected(client):
    """★ 同一 operation_id 挂到**不同** batch_id → 409 idempotency_conflict。

    这不是缺陷，是有意的防误用：一个 operation_id 只能属于一个批次。
    若允许它跨批次漂移，重放就会变成「同一操作被两个批次各写一次」，
    幂等键形同虚设。客户端重放必须复用原 batch_id（见 createPendingPushBatchAfterUnknown）。
    """
    headers, client_id = await _setup_sync_client(client)
    entity_id = uuid.uuid4().hex
    operation_id = f"op-bound-{uuid.uuid4().hex}"
    first_batch = f"batch-first-{uuid.uuid4().hex}"
    second_batch = f"batch-second-{uuid.uuid4().hex}"

    event = _make_event(entity_id=entity_id, payload={"id": entity_id, "title": "Bound"})
    event["operation_id"] = operation_id

    created = await _push(client, headers, client_id, [event], batch_id=first_batch)
    assert created["applied"], created

    # 同一个 operation_id、换一个 batch_id → 必须被拒绝
    replay = await _push_raw(
        client, headers, client_id, [dict(event)], batch_id=second_batch
    )
    assert replay.status_code == 409, replay.text
    assert replay.json()["error_type"] == "conflict", replay.text

    # 拒绝不应影响已写入的数据
    pulled = await _pull(client, headers, client_id)
    matches = [item for item in pulled["events"] if item["entity_id"] == entity_id]
    assert len(matches) == 1, pulled


async def test_push_replay_after_intervening_mutation_keeps_single_ledger_entry(client):
    """★ 重放发生在「实体已被后续操作改过」之后，也不能新增账本条目。

    比上一条更苛刻：重放时实体已经到 version 2，若服务端把重放当成一次
    新的 create，就会把 title 打回 "Original"（数据倒退）。
    """
    headers, client_id = await _setup_sync_client(client)
    entity_id = uuid.uuid4().hex
    create_batch = f"batch-create-{uuid.uuid4().hex}"

    create_event = _make_event(
        entity_id=entity_id, payload={"id": entity_id, "title": "Original"}
    )
    await _push(client, headers, client_id, [create_event], batch_id=create_batch)

    # 一次真实的后续变更（新批次）
    update_event = _make_event(
        entity_id=entity_id,
        action="update",
        payload={"id": entity_id, "title": "Updated"},
        expected_version=1,
        client_updated_at="2026-07-16T11:00:00.000Z",
    )
    update_push = await _push(client, headers, client_id, [update_event])
    assert update_push["applied"], update_push

    baseline = await _pull(client, headers, client_id)

    # 此时重放最初那条 create（相同 batch_id）—— 不该新增账本，也不该回退数据
    replay = await _push(client, headers, client_id, [dict(create_event)], batch_id=create_batch)
    assert not replay["errors"], replay

    after = await _pull(client, headers, client_id, cursor=baseline["next_cursor"])
    assert [item for item in after["events"] if item["entity_id"] == entity_id] == [], after
