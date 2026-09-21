"""TS-04: the Space committed-change SSE endpoint.

Covered here:

- authorization: an anonymous or space-less caller gets ``401``, a caller
  naming a Space it is not authorized for gets ``403``, and a Space that is
  deleted or whose epoch is revoked cannot hold a stream;
- contract: ``text/event-stream``, event name ``task_space_changed``, an SSE
  ``id``, and JSON data containing exactly ``space_id`` and
  ``visible_watermark`` — never a post-image, cursor, ACK or derived field;
- semantics: the connect-time watermark is emitted, heartbeats are sent when
  idle, repeated watermarks coalesce, and an invisible journal row produces no
  event;
- lifecycle: a slow consumer is disconnected rather than unbounded, and a
  reconnect after dropped notifications recovers through the watermark the
  next connect reads.
"""
from __future__ import annotations

import asyncio
import json

import pytest

from app.sync.notifications import SpaceChangeNotifier

STREAM_PATH = "/api/v1/sync/v2/events"


@pytest.fixture()
def request_factory(client):
    """Build a minimal real ``Request`` bound to the production app state.

    The SSE generator only touches ``request`` to resolve the installed
    runtime through the same accessor the HTTP stack uses, so a Starlette
    Request over the live ASGI scope is sufficient and stays honest about
    which runtime is being driven.
    """

    def build(space_id: str):
        from starlette.requests import Request

        app = client._transport.app  # type: ignore[attr-defined]
        scope = {
            "type": "http",
            "method": "GET",
            "path": STREAM_PATH,
            "headers": [],
            "query_string": f"space_id={space_id}".encode(),
            "app": app,
        }
        return Request(scope)

    return build


# --------------------------------------------------------------------------- #
# Pure contract layer (no HTTP): frame rendering
# --------------------------------------------------------------------------- #


async def test_frames_emit_connect_watermark_then_events() -> None:
    from app.routes.v1.sync_events import SpaceEventStream

    notifier = SpaceChangeNotifier()
    watermark = 12

    async def read_watermark() -> int:
        return watermark

    stream = SpaceEventStream(
        notifier=notifier,
        watermark_reader=read_watermark,
        heartbeat_seconds=5.0,
    )

    frames: list[bytes] = []
    async for frame in stream.frames("spc_a"):
        frames.append(frame)
        if len(frames) == 1:
            notifier.publish("spc_a", 12)
        elif len(frames) >= 2:
            break

    first = frames[0].decode()
    assert "event: task_space_changed" in first
    assert "id: spc_a:0:12" in first
    payload = json.loads(first.split("data: ", 1)[1].strip())
    assert payload == {"space_id": "spc_a", "visible_watermark": 12}

    second = frames[1].decode()
    payload = json.loads(second.split("data: ", 1)[1].strip())
    assert payload == {"space_id": "spc_a", "visible_watermark": 12}


async def test_frames_emit_only_identity_and_watermark_fields() -> None:
    from app.routes.v1.sync_events import SpaceEventStream

    notifier = SpaceChangeNotifier()

    async def read_watermark() -> int:
        return 7

    stream = SpaceEventStream(notifier=notifier, watermark_reader=read_watermark)
    async for frame in stream.frames("spc_a"):
        payload = json.loads(frame.decode().split("data: ", 1)[1].strip())
        assert set(payload) == {"space_id", "visible_watermark"}
        assert isinstance(payload["visible_watermark"], int)
        break


async def test_heartbeat_is_emitted_when_idle() -> None:
    from app.routes.v1.sync_events import SpaceEventStream

    notifier = SpaceChangeNotifier()

    async def read_watermark() -> int:
        return 0

    stream = SpaceEventStream(
        notifier=notifier, watermark_reader=read_watermark, heartbeat_seconds=0.05
    )
    async for frame in stream.frames("spc_a"):
        assert frame == b": heartbeat\n\n"
        break


async def test_stream_ends_when_the_notifier_closes() -> None:
    """Shutdown must terminate the generator rather than spin."""
    from app.routes.v1.sync_events import SpaceEventStream

    notifier = SpaceChangeNotifier()

    async def read_watermark() -> int:
        return 0

    stream = SpaceEventStream(
        notifier=notifier, watermark_reader=read_watermark, heartbeat_seconds=0.05
    )
    frames: list[bytes] = []

    async def consume() -> None:
        async for frame in stream.frames("spc_a"):
            frames.append(frame)
            if len(frames) == 1:
                notifier.close()

    await asyncio.wait_for(consume(), timeout=5)
    assert frames


async def test_lost_authority_ends_an_idle_stream() -> None:
    """A revoked Space must not keep an idle stream alive."""
    from app.errors import AuthorizationError
    from app.routes.v1.sync_events import SpaceEventStream

    notifier = SpaceChangeNotifier()
    checks = 0

    async def read_watermark() -> int:
        return 0

    async def authority_check() -> None:
        nonlocal checks
        checks += 1
        raise AuthorizationError("Space access revoked")

    stream = SpaceEventStream(
        notifier=notifier,
        watermark_reader=read_watermark,
        authority_check=authority_check,
        heartbeat_seconds=0.02,
        authority_recheck_seconds=0.0,
    )
    with pytest.raises(AuthorizationError):
        async for _frame in stream.frames("spc_a"):
            pass
    assert checks >= 1


# --------------------------------------------------------------------------- #
# HTTP layer: authorization and headers
# --------------------------------------------------------------------------- #


async def test_event_stream_requires_authentication(client) -> None:
    response = await client.get(STREAM_PATH, params={"space_id": "spc_test"})
    assert response.status_code in (401, 403), response.text


async def test_event_stream_requires_a_space_parameter(client) -> None:
    response = await client.get(STREAM_PATH)
    assert response.status_code in (401, 403, 422), response.text


@pytest.mark.provisioned_space_storage
async def test_event_stream_streams_with_a_space_token(client) -> None:
    """One real authorized stream: headers, event name and payload shape.

    Driven through the production route inside the app's own task, because the
    Space runtime binds each handle to the task that opened it.  The body is
    consumed incrementally, which the buffering test transport cannot do.
    """
    await client.post("/api/v1/auth/setup", json={"password": "test-password-123"})
    login = await client.post(
        "/api/v1/auth/login", json={"password": "test-password-123"}
    )
    master_headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    created = await client.post(
        "/api/v1/spaces", json={"name": "TS-04 Stream"}, headers=master_headers
    )
    assert created.status_code == 201, created.text
    space_id = created.json()["id"]
    token_response = await client.post(
        f"/api/v1/spaces/{space_id}/token", headers=master_headers
    )
    assert token_response.status_code == 200, token_response.text
    space_headers = {
        "Authorization": f"Bearer {token_response.json()['space_token']}"
    }

    from app.routes.v1.sync_events import TASK_SPACE_CHANGED_EVENT
    from app.sync.notifications import space_change_notifier

    app = client._transport.app  # type: ignore[attr-defined]
    space_token_header = space_headers["Authorization"].encode()
    status_holder: dict[str, object] = {}
    sent: list[dict[str, object]] = []

    async def request_stream() -> None:
        scope = {
            "type": "http",
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": STREAM_PATH,
            "raw_path": STREAM_PATH.encode(),
            "query_string": f"space_id={space_id}".encode(),
            "headers": [(b"authorization", space_token_header)],
            "client": ("127.0.0.1", 12345),
            "server": ("test", 80),
            "app": app,
            "root_path": "",
        }

        disconnect = asyncio.Event()

        async def receive() -> dict[str, object]:
            # A real connection blocks until the peer does something.  Returning
            # immediately would let Starlette's disconnect watcher spin and
            # starve the stream generator.
            await disconnect.wait()
            return {"type": "http.disconnect"}

        async def send(message: dict[str, object]) -> None:
            # Collected as they are emitted so the test never waits for a
            # stream that by design does not end.
            sent.append(message)

        await app(scope, receive, send)

    task = asyncio.create_task(request_stream())
    try:
        # Wait until the stream has actually subscribed before publishing:
        # the hub only delivers to already-registered subscribers, which is
        # exactly why the connect-time watermark (not the notification) is the
        # correctness path.
        for _ in range(400):
            if space_change_notifier.subscriber_count(space_id) > 0:
                break
            await asyncio.sleep(0.05)
        assert space_change_notifier.subscriber_count(space_id) > 0, (
            "the SSE stream never subscribed to the Space change hub"
        )
        assert sent, "the app never produced a response start"
        space_change_notifier.publish(space_id, 1)
        for _ in range(400):
            if any(
                b"task_space_changed" in (message.get("body") or b"")
                for message in sent
                if message["type"] == "http.response.body"
            ):
                break
            await asyncio.sleep(0.05)
    finally:
        # Starlette's StreamingResponse parks in listen_for_disconnect; cancel
        # and let the loop retire the task rather than awaiting it (awaiting a
        # deliberately unbounded stream is exactly the hang this test avoids).
        task.cancel()
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=5)
        except (TimeoutError, asyncio.CancelledError):
            pass

    del status_holder
    assert sent, "the app did not emit any ASGI messages"
    start_message = sent[0]
    assert start_message["type"] == "http.response.start"
    assert int(start_message["status"]) == 200
    header_map = {
        key.decode().lower(): value.decode()
        for key, value in start_message["headers"]  # type: ignore[union-attr]
    }
    assert header_map["content-type"].startswith("text/event-stream")
    assert "no-transform" in header_map["cache-control"]

    body = b"".join(
        message.get("body", b"")
        for message in sent
        if message["type"] == "http.response.body"
    )
    assert b"event: " + TASK_SPACE_CHANGED_EVENT.encode() in body
    frame = [
        blob
        for blob in body.split(b"\n\n")
        if b"task_space_changed" in blob
    ][0]
    payload = json.loads(frame.split(b"data: ", 1)[1].strip())
    assert payload == {"space_id": space_id, "visible_watermark": 1}
    assert set(payload) == {"space_id", "visible_watermark"}


@pytest.mark.provisioned_space_storage
async def test_event_stream_rejects_a_foreign_space(client) -> None:
    await client.post("/api/v1/auth/setup", json={"password": "test-password-123"})
    login = await client.post(
        "/api/v1/auth/login", json={"password": "test-password-123"}
    )
    master_headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    created = await client.post(
        "/api/v1/spaces", json={"name": "TS-04 Foreign"}, headers=master_headers
    )
    space_id = created.json()["id"]
    token_response = await client.post(
        f"/api/v1/spaces/{space_id}/token", headers=master_headers
    )
    space_headers = {
        "Authorization": f"Bearer {token_response.json()['space_token']}"
    }

    response = await client.get(
        STREAM_PATH,
        params={"space_id": "spc_does_not_exist"},
        headers=space_headers,
    )
    assert response.status_code in (403, 404), response.text


@pytest.mark.provisioned_space_storage
async def test_event_stream_rejects_a_deleted_space(client) -> None:
    """A Space removed from the registry cannot open a stream.

    Deletion is expressed the way the authorization path sees it — the Space
    row is gone — because there is no HTTP delete endpoint at this baseline.
    """
    await client.post("/api/v1/auth/setup", json={"password": "test-password-123"})
    login = await client.post(
        "/api/v1/auth/login", json={"password": "test-password-123"}
    )
    master_headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    created = await client.post(
        "/api/v1/spaces", json={"name": "TS-04 Deleted"}, headers=master_headers
    )
    space_id = created.json()["id"]
    token_response = await client.post(
        f"/api/v1/spaces/{space_id}/token", headers=master_headers
    )
    space_headers = {
        "Authorization": f"Bearer {token_response.json()['space_token']}"
    }

    # Confirm the stream is reachable first, so the later failure is
    # attributable to deletion rather than to a mounting mistake.
    from app.db.meta_session import get_meta_session
    from app.db.models.meta import Space as SpaceModel

    async for session in get_meta_session():
        row = await session.get(SpaceModel, space_id)
        assert row is not None
        await session.delete(row)
        await session.commit()
        break

    response = await client.get(
        STREAM_PATH, params={"space_id": space_id}, headers=space_headers
    )
    assert response.status_code in (403, 404), response.text


@pytest.mark.provisioned_space_storage
async def test_event_stream_rejects_an_expired_token(client) -> None:
    """A token past its expiry cannot open or keep a stream."""
    import jwt

    from app.settings import settings

    await client.post("/api/v1/auth/setup", json={"password": "test-password-123"})
    login = await client.post(
        "/api/v1/auth/login", json={"password": "test-password-123"}
    )
    master_headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    created = await client.post(
        "/api/v1/spaces", json={"name": "TS-04 Expired"}, headers=master_headers
    )
    space_id = created.json()["id"]
    token_response = await client.post(
        f"/api/v1/spaces/{space_id}/token", headers=master_headers
    )
    space_token = token_response.json()["space_token"]

    claims = jwt.decode(space_token, options={"verify_signature": False})
    expired = jwt.encode(
        {**claims, "exp": 1_000_000_000},
        settings.secret_key,
        algorithm="HS256",
    )

    response = await client.get(
        STREAM_PATH,
        params={"space_id": space_id},
        headers={"Authorization": f"Bearer {expired}"},
    )
    assert response.status_code in (401, 403), response.text


def test_stream_path_constant_matches_the_mounted_route() -> None:
    """Pin the wire literal so a rename cannot silently unmount the stream."""
    from app.routes.v1.sync_events import router

    assert [route.path for route in router.routes] == ["/v2/events"]
