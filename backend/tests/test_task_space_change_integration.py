"""TS-03/TS-04 跨客户端集成：写入 → 通知 → 既有同步周期。

这一层验证的是两条真实链路，而不是单元边界：

1. **REST 写入唤醒另一个客户端**：客户端 B 订阅了 Space 变更流，客户端 A 通过
   REST 批量写提交，B 必须收到通知并驱动既有 Sync v2 周期（本测试用「真实可见
   watermark 可被 pull 到」代表该周期）。
2. **独立 MCP factory 写入同样唤醒**：MCP 写工具走自己的 gateway/运行时句柄，
   但必须汇入**同一个** notifier —— 否则「MCP 写入能唤醒客户端」就是空话。

以及丢失/重复语义：通知丢失后重连仍能靠 visible watermark 追平；重复通知只产生
一次有效唤醒；旧 Space 的流不得污染新 Space。

★ 未验证项（不得当作已验证）：真实第二个进程、真实多设备、CI 与部署环境。这里
  的「独立 factory」是**进程内**的独立工厂实例，部署层的多进程 fanout 需要共享
  broker，属于未验证范围。
"""
from __future__ import annotations

import asyncio
import json

import pytest

from app.mutation.types import canonical_payload_hash

STREAM_PATH = "/api/v1/sync/v2/events"


async def _setup(client) -> tuple[str, str, dict[str, str], dict[str, str]]:
    """Create a Space; return (space_id, space_token, space_headers, master_headers)."""
    await client.post("/api/v1/auth/setup", json={"password": "test-password-123"})
    login = await client.post(
        "/api/v1/auth/login", json={"password": "test-password-123"}
    )
    assert login.status_code == 200, login.text
    master_headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    created = await client.post(
        "/api/v1/spaces", json={"name": "TS-04 Cross"}, headers=master_headers
    )
    assert created.status_code == 201, created.text
    space_id = created.json()["id"]
    token_response = await client.post(
        f"/api/v1/spaces/{space_id}/token", headers=master_headers
    )
    assert token_response.status_code == 200, token_response.text
    space_token = token_response.json()["space_token"]
    space_headers = {"Authorization": f"Bearer {space_token}"}
    return space_id, space_token, space_headers, master_headers


async def _create_project(
    client, space_id: str, space_headers: dict[str, str], key: str
) -> str:
    payload = {"key": key, "name": f"{key} Project", "description": None}
    response = await client.post(
        "/api/v1/projects",
        json={
            "commandId": f"{key.lower()}-project",
            "spaceId": space_id,
            "payloadHash": canonical_payload_hash(payload),
            **payload,
        },
        headers={**space_headers, "Idempotency-Key": f"{key.lower()}-project"},
    )
    assert response.status_code in (200, 201), response.text
    return response.json()["value"]["id"]


def _create_command(command_id: str, space_id: str, project_id: str, title: str) -> dict:
    return {
        "kind": "work_item.create",
        "commandId": command_id,
        "spaceId": space_id,
        "projectId": project_id,
        "payloadHash": canonical_payload_hash(
            {
                "title": title,
                "description": None,
                "parent_id": None,
                "type_definition_id": None,
                "status_definition_id": None,
                "priority": None,
            }
        ),
        "title": title,
    }


async def _drive_stream_until_notification(client, space_id, space_headers, app):
    """Subscribe to the SSE stream in-app and return (received, cancel)."""
    from app.sync.notifications import space_change_notifier

    sent: list[dict] = []
    auth = space_headers["Authorization"].encode()
    ready = asyncio.Event()

    async def run() -> None:
        scope = {
            "type": "http",
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": STREAM_PATH,
            "raw_path": STREAM_PATH.encode(),
            "query_string": f"space_id={space_id}".encode(),
            "headers": [(b"authorization", auth)],
            "client": ("127.0.0.1", 1),
            "server": ("t", 80),
            "app": app,
            "root_path": "",
        }

        async def receive() -> dict:
            await asyncio.Event().wait()
            return {"type": "http.disconnect"}

        async def send(message: dict) -> None:
            sent.append(message)

        ready.set()
        await app(scope, receive, send)

    task = asyncio.create_task(run())
    await ready.wait()
    # Wait for the notifier subscription to exist before any write happens.
    for _ in range(400):
        if space_change_notifier.subscriber_count(space_id) > 0:
            break
        await asyncio.sleep(0.05)
    return sent, task


def _notification_frames(sent: list[dict]) -> list[dict]:
    """Parse every delivered task_space_changed payload from ASGI messages."""
    payloads: list[dict] = []
    for message in sent:
        if message.get("type") != "http.response.body":
            continue
        body = message.get("body") or b""
        for frame in body.split(b"\n\n"):
            if b"task_space_changed" not in frame:
                continue
            data = frame.split(b"data: ", 1)
            if len(data) != 2:
                continue
            payloads.append(json.loads(data[1].strip()))
    return payloads


@pytest.mark.provisioned_space_storage
async def test_rest_write_wakes_a_subscribed_client(client) -> None:
    """A REST batch commit must notify the subscribed client with a real watermark."""
    space_id, _token, space_headers, _master = await _setup(client)

    from app.sync.notifications import space_change_notifier

    app = client._transport.app  # type: ignore[attr-defined]
    sent, task = await _drive_stream_until_notification(
        client, space_id, space_headers, app
    )
    try:
        assert space_change_notifier.subscriber_count(space_id) > 0

        await _create_project(client, space_id, space_headers, "WAKE")
        # The project write itself is a committed visible change.
        for _ in range(200):
            if _notification_frames(sent):
                break
            await asyncio.sleep(0.05)
        payloads = _notification_frames(sent)
        assert payloads, "no change notification was delivered for the REST write"

        payload = payloads[-1]
        assert set(payload) == {"space_id", "visible_watermark"}
        assert payload["space_id"] == space_id
        watermark = payload["visible_watermark"]
        assert isinstance(watermark, int) and watermark > 0

        # The announced watermark is real: the existing Sync v2 pull path can
        # observe exactly that position, which is what makes the hint both
        # meaningful and safe to lose.
        from starlette.requests import Request

        from app.auth.authority import Principal
        from app.mcp.auth import PomodoroTokenVerifier
        from app.routes.v1.sync_events import read_visible_watermark

        access = await PomodoroTokenVerifier().verify_token(_token)
        assert access is not None
        claims = access.claims
        principal = Principal(
            subject=str(claims["sub"]),
            token_type="space",
            epoch=int(claims["epoch"]),
            expires_at=access.expires_at,
            space_id=str(claims["space_id"]),
        )
        scope = {
            "type": "http",
            "method": "GET",
            "path": STREAM_PATH,
            "headers": [],
            "query_string": b"",
            "app": app,
        }
        current = await read_visible_watermark(
            Request(scope), principal, space_id
        )
        assert current >= watermark
    finally:
        task.cancel()
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=5)
        except (TimeoutError, asyncio.CancelledError):
            pass


@pytest.mark.provisioned_space_storage
async def test_independent_mcp_factory_write_wakes_the_same_subscriber(
    client, monkeypatch
) -> None:
    """The MCP write path must feed the *same* notifier as REST.

    The MCP gateway opens its own runtime handle through its own factory, so
    this asserts the two transports converge on one notification hub rather
    than each having a private one.
    """
    space_id, space_token, space_headers, _master = await _setup(client)

    from app.mcp.auth import PomodoroTokenVerifier
    from app.mutation.types import canonical_payload_hash as hash_payload
    from app.sync.notifications import space_change_notifier

    access = await PomodoroTokenVerifier().verify_token(space_token)
    assert access is not None
    import app.mcp.auth as mcp_auth

    monkeypatch.setattr(mcp_auth, "get_access_token", lambda: access)

    app = client._transport.app  # type: ignore[attr-defined]

    # A second, independent MCP factory instance (still in-process: a real
    # second process is an unverified deployment condition).
    import app.mcp.task_space_tools as module
    from app.mcp.admission import McpWriteAdmission
    from app.mcp.task_space_tools import McpTaskSpaceWriteGateway

    def provider():
        return app.state.runtime_services

    module._gateway_factory = McpTaskSpaceWriteGateway(
        provider, admission=McpWriteAdmission()
    )

    project_id = await _create_project(client, space_id, space_headers, "MCPWAKE")

    sent, task = await _drive_stream_until_notification(
        client, space_id, space_headers, app
    )
    try:
        assert space_change_notifier.subscriber_count(space_id) > 0
        before = len(_notification_frames(sent))

        receipt = await module.execute_task_space_commands(
            batch_id="mcp-wake-batch",
            commands=[
                {
                    "kind": "work_item.create",
                    "commandId": "mcp-wake-item",
                    "spaceId": space_id,
                    "projectId": project_id,
                    "payloadHash": hash_payload(
                        {
                            "title": "MCP Wake",
                            "description": None,
                            "parent_id": None,
                            "type_definition_id": None,
                            "status_definition_id": None,
                            "priority": None,
                        }
                    ),
                    "title": "MCP Wake",
                }
            ],
        )
        assert receipt["acceptedCount"] == 1, receipt

        for _ in range(200):
            if len(_notification_frames(sent)) > before:
                break
            await asyncio.sleep(0.05)
        payloads = _notification_frames(sent)
        assert len(payloads) > before, (
            "an MCP write did not reach the same change notifier as REST"
        )
        assert payloads[-1]["space_id"] == space_id
    finally:
        task.cancel()
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=5)
        except (TimeoutError, asyncio.CancelledError):
            pass


@pytest.mark.provisioned_space_storage
async def test_reconnect_recovers_via_the_visible_watermark(client) -> None:
    """Losing every notification is safe: a reconnect learns the watermark.

    The stream is never subscribed while the writes happen, so the client
    provably missed them; the connect-time watermark read is what closes the
    gap through the ordinary Sync v2 path.
    """
    space_id, space_token, space_headers, _master = await _setup(client)
    project_id = await _create_project(client, space_id, space_headers, "LOSS")

    from starlette.requests import Request

    from app.auth.authority import Principal
    from app.mcp.auth import PomodoroTokenVerifier
    from app.routes.v1.sync_events import read_visible_watermark
    from app.sync.notifications import space_change_notifier

    assert space_change_notifier.subscriber_count(space_id) == 0

    access = await PomodoroTokenVerifier().verify_token(space_token)
    claims = access.claims
    principal = Principal(
        subject=str(claims["sub"]),
        token_type="space",
        epoch=int(claims["epoch"]),
        expires_at=access.expires_at,
        space_id=str(claims["space_id"]),
    )
    app = client._transport.app  # type: ignore[attr-defined]
    scope = {
        "type": "http",
        "method": "GET",
        "path": STREAM_PATH,
        "headers": [],
        "query_string": b"",
        "app": app,
    }

    before = await read_visible_watermark(Request(scope), principal, space_id)
    assert before > 0, "the project write should already be a visible ledger event"

    # More writes while nobody is subscribed: these notifications are lost.
    await client.post(
        "/api/v1/task-space/commands:batch",
        json={
            "batchId": "loss-batch",
            "commands": [
                _create_command("loss-item", space_id, project_id, "Missed")
            ],
        },
        headers={**space_headers, "Idempotency-Key": "loss-batch"},
    )

    after = await read_visible_watermark(Request(scope), principal, space_id)
    assert after > before, "the missed write must still advance the visible watermark"


@pytest.mark.provisioned_space_storage
async def test_duplicate_watermarks_collapse_to_one_effective_wakeup(client) -> None:
    """Repeated hints for the same position produce one notification, not many."""
    space_id, _token, space_headers, _master = await _setup(client)

    from app.sync.notifications import SpaceChangeNotifier

    notifier = SpaceChangeNotifier()
    delivered = 0

    async with notifier.subscribe(space_id) as stream:
        assert notifier.publish(space_id, 5) == 1
        # The same commit announced twice (e.g. two workers observing it) must
        # not produce a second wakeup.
        assert notifier.publish(space_id, 5) == 0
        assert notifier.publish(space_id, 5) == 0
        assert (await anext(stream)).visible_watermark == 5
        delivered += 1
    assert delivered == 1
    del space_headers


async def test_a_closed_stream_cannot_wake_a_switched_space() -> None:
    """The client-side fence: after the authority token is released the old
    stream's late notification must not drive the new Space's sync."""
    from app.sync.notifications import SpaceChangeNotifier

    notifier = SpaceChangeNotifier()
    old_space, new_space = "spc_old", "spc_new"

    async with notifier.subscribe(new_space) as new_stream:
        # The old Space's subscriber is gone (its stream was closed), so a
        # publish there reaches nobody and the new Space stays silent.
        assert notifier.publish(old_space, 42) == 0

        async def expect_silence() -> None:
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(anext(new_stream), timeout=0.2)

        await expect_silence()
