"""Bidirectional REST/MCP parity and Sync Adapter lifecycle gates."""

from __future__ import annotations

import asyncio
import base64
from contextlib import asynccontextmanager
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastmcp.exceptions import ToolError

from app.auth.authority import Principal
from app.errors import AuthenticationError, ValidationError
from app.mcp.auth import mcp_error_payload
from app.sync.clients import AckResult
from app.sync.contracts import (
    OperationQueryItem,
    OperationQueryResult,
    PullPage,
    PushApplied,
    PushResult,
    RecoveryPage,
    SyncEventInput,
    SyncEventRecord,
    SyncStatusResult,
)
from app.sync.operations import SYNC_OPERATIONS

HASH = "a" * 64
CURSOR = "opaque-cursor-1234"
PAGE_TOKEN = "opaque-page-token"


class _Protocol:
    def __init__(self) -> None:
        terminal = PushResult(
            "batch-a",
            (PushApplied("op-a", "note", "note-a", 1),),
            (),
            (),
        )
        self.query_operations = AsyncMock(
            return_value=OperationQueryResult(
                (OperationQueryItem("op-a", "terminal", "batch-a", terminal),)
            )
        )
        self.push = AsyncMock(return_value=terminal)
        self.pull = AsyncMock(return_value=PullPage((), CURSOR, False, HASH))
        raw = b""
        self.recover = AsyncMock(
            return_value=RecoveryPage(
                None,
                False,
                HASH,
                CURSOR,
                0,
                base64.b64encode(raw).decode("ascii"),
                __import__("hashlib").sha256(raw).hexdigest(),
            )
        )
        self.ack = AsyncMock(return_value=AckResult("client-a", True, False, HASH))
        self.status = AsyncMock(
            return_value=SyncStatusResult(HASH, "client-a", True, False, None, 0, 1, 0)
        )


class _Factory:
    def __init__(self, protocol: _Protocol) -> None:
        self.protocol = protocol
        self.authenticated = 0
        self.opened: list[tuple[str, str]] = []

    async def authenticate(self) -> Principal:
        self.authenticated += 1
        return Principal("test", "trusted_stdio", 0, None)

    @asynccontextmanager
    async def open_authenticated(
        self, *, principal: Principal, space_id: str, operation_name: str
    ):
        assert principal.subject == "test"
        self.opened.append((space_id, operation_name))
        yield self.protocol


def _event() -> dict[str, object]:
    return {
        "entity_type": "note",
        "entity_id": "note-a",
        "action": "create",
        "payload": {"id": "note-a", "title": "A"},
        "expected_version": None,
        "client_updated_at": "2026-08-07T01:00:00.000Z",
        "operation_id": "op-a",
    }


@pytest.mark.asyncio
async def test_sync_operation_catalog_matches_rest_and_mcp() -> None:
    from app.main import app
    from app.mcp.server import mcp

    rest = {
        (path, method.upper())
        for path, operations in app.openapi()["paths"].items()
        for method in operations
        if path.startswith("/api/v1/sync/v2/")
    }
    tools = {tool.name for tool in await mcp.list_tools()}

    assert rest == {(spec.rest_path, spec.rest_method) for spec in SYNC_OPERATIONS}
    assert tools & {spec.mcp_tool for spec in SYNC_OPERATIONS} == {
        spec.mcp_tool for spec in SYNC_OPERATIONS
    }


@pytest.mark.asyncio
async def test_all_six_mcp_tools_delegate_exact_protocol_arguments(monkeypatch) -> None:
    import app.mcp.sync_tools as sync_tools

    protocol = _Protocol()
    factory = _Factory(protocol)
    monkeypatch.setattr(sync_tools, "_installed_factory", factory)

    query = await sync_tools.sync_query_operations("space-a", "client-a", ["op-a"])
    pushed = await sync_tools.sync_push("space-a", "client-a", "batch-a", [_event()])
    pulled = await sync_tools.sync_pull("space-a", "client-a", CURSOR, 7)
    recovered = await sync_tools.sync_recover("space-a", "client-a", PAGE_TOKEN)
    acked = await sync_tools.sync_ack("space-a", "client-a", CURSOR)
    status = await sync_tools.get_sync_status("space-a", "client-a")

    protocol.query_operations.assert_awaited_once_with("client-a", ("op-a",))
    pushed_event = protocol.push.await_args.args[1][0]
    assert isinstance(pushed_event, SyncEventInput)
    protocol.push.assert_awaited_once_with("client-a", (pushed_event,), "batch-a")
    protocol.pull.assert_awaited_once_with("client-a", CURSOR, 7)
    protocol.recover.assert_awaited_once_with("client-a", PAGE_TOKEN)
    protocol.ack.assert_awaited_once_with("client-a", CURSOR)
    protocol.status.assert_awaited_once_with("client-a")
    assert factory.authenticated == 6
    assert factory.opened == [
        ("space-a", "query_operations"),
        ("space-a", "push"),
        ("space-a", "pull"),
        ("space-a", "recover"),
        ("space-a", "ack"),
        ("space-a", "status"),
    ]
    assert query["items"][0]["result"]["batch_id"] == "batch-a"
    assert pushed["batch_id"] == "batch-a"
    assert pulled["next_cursor"] == CURSOR
    assert recovered["payload_jsonl_base64"] == ""
    assert acked["accepted"] is True
    assert status["catalog_hash"] == HASH


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "operation",
    ["query_operations", "push", "pull", "recover", "ack", "status"],
)
async def test_rest_and_mcp_normalize_each_protocol_result_identically(
    monkeypatch, operation: str
) -> None:
    import app.mcp.sync_tools as sync_tools
    from app.routes.v1.sync import (
        ack_v2,
        pull_v2,
        push_v2,
        query_operations_v2,
        recover_v2,
        status_v2,
    )
    from app.sync.operations import ValidatedSyncCall

    protocol = _Protocol()
    factory = _Factory(protocol)
    monkeypatch.setattr(sync_tools, "_installed_factory", factory)
    event = SyncEventInput.from_mapping(_event())

    if operation == "query_operations":
        call = ValidatedSyncCall(
            "query_operations", "client-a", operation_ids=("op-a",)
        )
        rest = await query_operations_v2(call=call, protocol=protocol)
        mcp_result = await sync_tools.sync_query_operations(
            "space-a", "client-a", ["op-a"]
        )
    elif operation == "push":
        call = ValidatedSyncCall("push", "client-a", "batch-a", (event,))
        rest = await push_v2(call=call, protocol=protocol)
        mcp_result = await sync_tools.sync_push(
            "space-a", "client-a", "batch-a", [_event()]
        )
    elif operation == "pull":
        call = ValidatedSyncCall("pull", "client-a", cursor=CURSOR, limit=7)
        rest = await pull_v2(
            call=call,
            protocol=protocol,
            client_id="client-a",
            cursor=CURSOR,
            limit="7",
        )
        mcp_result = await sync_tools.sync_pull("space-a", "client-a", CURSOR, 7)
    elif operation == "recover":
        call = ValidatedSyncCall("recover", "client-a", page_token=PAGE_TOKEN)
        rest = await recover_v2(
            call=call,
            protocol=protocol,
            client_id="client-a",
            page_token=PAGE_TOKEN,
        )
        mcp_result = await sync_tools.sync_recover(
            "space-a", "client-a", PAGE_TOKEN
        )
    elif operation == "ack":
        call = ValidatedSyncCall("ack", "client-a", cursor=CURSOR)
        rest = await ack_v2(call=call, protocol=protocol)
        mcp_result = await sync_tools.sync_ack("space-a", "client-a", CURSOR)
    else:
        call = ValidatedSyncCall("status", "client-a")
        rest = await status_v2(
            call=call, protocol=protocol, client_id="client-a"
        )
        mcp_result = await sync_tools.get_sync_status(
            "space-a", "client-a"
        )

    assert rest.model_dump(mode="json") == mcp_result


@pytest.mark.asyncio
async def test_operation_query_preserves_compound_child_order_and_full_result(
    monkeypatch,
) -> None:
    import app.mcp.sync_tools as sync_tools
    from app.routes.v1.sync import query_operations_v2
    from app.sync.operations import ValidatedSyncCall

    protocol = _Protocol()
    terminal = PushResult(
        "compound-root",
        (
            PushApplied("child-a", "workItem", "work-a", 2),
            PushApplied("child-b", "workItemNote", "note-b", 3),
        ),
        (),
        (),
    )
    protocol.query_operations.return_value = OperationQueryResult(
        (
            OperationQueryItem("child-a", "terminal", "compound-root", terminal),
            OperationQueryItem("child-b", "terminal", "compound-root", terminal),
        )
    )
    factory = _Factory(protocol)
    monkeypatch.setattr(sync_tools, "_installed_factory", factory)

    result = await sync_tools.sync_query_operations(
        "space-a", "client-a", ["child-a", "child-b"]
    )
    rest = await query_operations_v2(
        call=ValidatedSyncCall(
            "query_operations",
            "client-a",
            operation_ids=("child-a", "child-b"),
        ),
        protocol=protocol,
    )

    assert [item["operation_id"] for item in result["items"]] == [
        "child-a",
        "child-b",
    ]
    assert result["items"][0]["result"] == result["items"][1]["result"]
    assert result["items"][0]["result"]["batch_id"] == "compound-root"
    assert [
        item["operation_id"] for item in result["items"][0]["result"]["applied"]
    ] == ["child-a", "child-b"]
    assert rest.model_dump(mode="json") == result


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "code",
    ["cursor_expired", "version_conflict", "space_storage_missing", "lease_timeout"],
)
async def test_mcp_protocol_errors_use_the_same_canonical_domain_record(
    monkeypatch, code: str
) -> None:
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient

    import app.mcp.sync_tools as sync_tools
    from app.errors import CANONICAL_ERROR_MEDIA_TYPE, register_exception_handlers
    from app.routes.v1.sync import pull_v2
    from app.sync.operations import ValidatedSyncCall

    error = ValidationError("protocol failure", code=code, details={"source": "sync"})
    protocol = _Protocol()
    protocol.pull.side_effect = error
    factory = _Factory(protocol)
    monkeypatch.setattr(sync_tools, "_installed_factory", factory)

    rest_app = FastAPI()
    register_exception_handlers(rest_app)

    @rest_app.get("/probe")
    async def probe():
        return await pull_v2(
            call=ValidatedSyncCall("pull", "client-a", cursor=CURSOR, limit=7),
            protocol=protocol,
            client_id="client-a",
            cursor=CURSOR,
            limit="7",
        )

    async with AsyncClient(
        transport=ASGITransport(app=rest_app), base_url="http://test"
    ) as client:
        rest = await client.get(
            "/probe", headers={"Accept": CANONICAL_ERROR_MEDIA_TYPE}
        )

    with pytest.raises(ToolError) as raised:
        await sync_tools.sync_pull("space-a", "client-a", CURSOR, 7)

    assert rest.status_code == error.status_code
    assert rest.json() == __import__("json").loads(str(raised.value))
    assert rest.json() == mcp_error_payload(error, "")
    assert factory.opened == [("space-a", "pull")]


@pytest.mark.asyncio
async def test_fastmcp_tool_run_accepts_structured_push_and_delegates(monkeypatch) -> None:
    import app.mcp.sync_tools as sync_tools
    from app.mcp.server import mcp

    protocol = _Protocol()
    factory = _Factory(protocol)
    monkeypatch.setattr(sync_tools, "_installed_factory", factory)
    tool = await mcp.get_tool("sync_push")
    monkeypatch.setattr(tool, "_protocol_factory", factory)

    result = await tool.run(
        {
            "space_id": "space-a",
            "client_id": "client-a",
            "batch_id": "batch-a",
            "events": [_event()],
        }
    )

    assert result.structured_content["batch_id"] == "batch-a"
    assert factory.authenticated == 1
    assert factory.opened == [("space-a", "push")]
    protocol.push.assert_awaited_once()


@pytest.mark.asyncio
async def test_registered_servers_keep_their_own_protocol_factory() -> None:
    from fastmcp import FastMCP

    from app.mcp.sync_tools import register_sync_tools

    first_protocol = _Protocol()
    second_protocol = _Protocol()
    first_factory = _Factory(first_protocol)
    second_factory = _Factory(second_protocol)
    first = FastMCP("first")
    second = FastMCP("second")
    register_sync_tools(first, first_factory)
    register_sync_tools(second, second_factory)

    await (await first.get_tool("get_sync_status")).run(
        {"space_id": "space-a", "client_id": "client-a"}
    )
    await (await second.get_tool("get_sync_status")).run(
        {"space_id": "space-b", "client_id": "client-b"}
    )

    assert first_factory.opened == [("space-a", "status")]
    assert second_factory.opened == [("space-b", "status")]


@pytest.mark.asyncio
async def test_fastmcp_push_accepts_shared_printable_ascii_operation_ids(
    monkeypatch,
) -> None:
    import app.mcp.sync_tools as sync_tools
    from app.mcp.server import mcp

    protocol = _Protocol()
    factory = _Factory(protocol)
    monkeypatch.setattr(sync_tools, "_installed_factory", factory)
    tool = await mcp.get_tool("sync_push")
    monkeypatch.setattr(tool, "_protocol_factory", factory)
    event = {**_event(), "operation_id": "op!a"}

    await tool.run(
        {
            "space_id": "space-a",
            "client_id": "client-a",
            "batch_id": "batch!a",
            "events": [event],
        }
    )

    protocol.push.assert_awaited_once()
    assert protocol.push.await_args.args[1][0].operation_id == "op!a"
    assert protocol.push.await_args.args[2] == "batch!a"


@pytest.mark.asyncio
async def test_fastmcp_pull_accepts_shared_printable_ascii_operation_ids(
    monkeypatch,
) -> None:
    import app.mcp.sync_tools as sync_tools

    protocol = _Protocol()
    protocol.pull.return_value = PullPage(
        (
            SyncEventRecord(
                "op!a",
                "batch!a",
                "note",
                "note-a",
                "create",
                {"id": "note-a", "title": "A"},
                1,
                "2026-08-07T01:00:00.000Z",
            ),
        ),
        CURSOR,
        False,
        HASH,
    )
    factory = _Factory(protocol)
    monkeypatch.setattr(sync_tools, "_installed_factory", factory)

    result = await sync_tools.sync_pull("space-a", "client-a", None, 100)

    assert result["events"][0]["operation_id"] == "op!a"
    assert result["events"][0]["batch_id"] == "batch!a"


@pytest.mark.asyncio
@pytest.mark.parametrize("bad_value", [True, "7", 2**53])
@pytest.mark.parametrize("response_kind", ["version", "status_count", "recovery_count"])
async def test_fastmcp_invalid_protocol_response_is_not_reported_as_client_input(
    monkeypatch, bad_value: object, response_kind: str
) -> None:
    from pydantic import ValidationError as PydanticValidationError

    import app.mcp.sync_tools as sync_tools
    from app.errors import to_wire_json
    from app.mcp.server import mcp

    protocol = _Protocol()
    if response_kind == "version":
        record = SyncEventRecord(
            "op-a",
            "batch-a",
            "note",
            "note-a",
            "create",
            {"id": "note-a", "title": "A"},
            1,
            "2026-08-07T01:00:00.000Z",
        )
        response = to_wire_json(PullPage((record,), CURSOR, False, HASH))
        response["events"][0]["version"] = bad_value
        protocol.pull.return_value = response
        tool_name = "sync_pull"
        arguments = _pull_tool_arguments()
    elif response_kind == "status_count":
        response = to_wire_json(
            SyncStatusResult(HASH, "client-a", True, False, None, 0, 1, 0)
        )
        response["visible_event_count"] = bad_value
        protocol.status.return_value = response
        tool_name = "get_sync_status"
        arguments = {"space_id": "space-a", "client_id": "client-a"}
    else:
        response = to_wire_json(protocol.recover.return_value)
        response["entity_count"] = bad_value
        protocol.recover.return_value = response
        tool_name = "sync_recover"
        arguments = {
            "space_id": "space-a",
            "client_id": "client-a",
            "page_token": PAGE_TOKEN,
        }

    factory = _Factory(protocol)
    monkeypatch.setattr(sync_tools, "_installed_factory", factory)
    tool = await mcp.get_tool(tool_name)
    monkeypatch.setattr(tool, "_protocol_factory", factory)

    with pytest.raises(PydanticValidationError):
        await tool.run(arguments)

    assert factory.opened != []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "arguments",
    [
        {"space_id": "space-a", "client_id": "client-a"},
        {
            "space_id": "space-a",
            "client_id": "client-a",
            "operation_ids": ["op-a"],
            "unexpected": True,
        },
    ],
)
async def test_fastmcp_top_level_shape_errors_are_stable_before_open(
    monkeypatch, arguments: dict[str, object]
) -> None:
    import app.mcp.sync_tools as sync_tools
    from app.mcp.server import mcp

    factory = _Factory(_Protocol())
    monkeypatch.setattr(sync_tools, "_installed_factory", factory)
    tool = await mcp.get_tool("sync_query_operations")
    monkeypatch.setattr(tool, "_protocol_factory", factory)

    with pytest.raises(ToolError) as raised:
        await tool.run(arguments)

    payload = __import__("json").loads(str(raised.value))
    expected = (
        {"missing": ["operation_ids"], "unexpected": []}
        if "operation_ids" not in arguments
        else {"missing": [], "unexpected": ["unexpected"]}
    )
    assert payload["code"] == "invalid_sync_input"
    assert payload["details"] == expected
    assert factory.authenticated == 1
    assert factory.opened == []


class _AuthenticationFailureFactory(_Factory):
    async def authenticate(self) -> Principal:
        self.authenticated += 1
        raise AuthenticationError("MCP authentication required")


@pytest.mark.asyncio
async def test_fastmcp_authentication_failure_precedes_validation_and_opens_nothing(
    monkeypatch,
) -> None:
    import app.mcp.sync_tools as sync_tools
    from app.mcp.server import mcp

    factory = _AuthenticationFailureFactory(_Protocol())
    monkeypatch.setattr(sync_tools, "_installed_factory", factory)
    tool = await mcp.get_tool("sync_pull")
    monkeypatch.setattr(tool, "_protocol_factory", factory)

    with pytest.raises(ToolError) as raised:
        await tool.run(
            {
                "space_id": " ",
                "client_id": " ",
                "cursor": "short",
                "limit": True,
            }
        )

    assert '"code":"auth_required"' in str(raised.value)
    assert "invalid_sync_input" not in str(raised.value)
    assert factory.authenticated == 1
    assert factory.opened == []


def _tool_case(
    tool_name: str, arguments: dict[str, object]
) -> tuple[str, dict[str, object]]:
    return tool_name, arguments


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("tool_name", "arguments"),
    [
        _tool_case(
            "sync_query_operations",
            {"space_id": "space-a", "client_id": "client-a", "operation_ids": []},
        ),
        _tool_case(
            "sync_query_operations",
            {
                "space_id": "space-a",
                "client_id": "client-a",
                "operation_ids": ["op-a", "op-a"],
            },
        ),
        _tool_case(
            "sync_query_operations",
            {
                "space_id": "space-a",
                "client_id": "client-a",
                "operation_ids": [f"op-{index}" for index in range(501)],
            },
        ),
        *[
            _tool_case(
                "sync_pull",
                {
                    "space_id": "space-a",
                    "client_id": "client-a",
                    "cursor": None,
                    "limit": bad_limit,
                },
            )
            for bad_limit in (True, "7", 2**53)
        ],
        _tool_case(
            "sync_ack",
            {
                "space_id": "space-a",
                "client_id": "client-a",
                "cursor": "x" * 2049,
            },
        ),
        _tool_case(
            "sync_recover",
            {
                "space_id": "space-a",
                "client_id": "client-a",
                "page_token": "x" * 2049,
            },
        ),
        _tool_case(
            "sync_query_operations",
            {
                "space_id": "space-a",
                "client_id": "client-a",
                "operation_ids": ["operation-一"],
            },
        ),
        _tool_case(
            "sync_query_operations",
            {
                "space_id": "space-a",
                "client_id": "client-a",
                "operation_ids": ["operation id"],
            },
        ),
        _tool_case(
            "sync_push",
            {
                "space_id": "space-a",
                "client_id": "client-a",
                "batch_id": "batch-a",
                "events": "[]",
            },
        ),
        *[
            _tool_case(
                "sync_push",
                {
                    "space_id": "space-a",
                    "client_id": "client-a",
                    "batch_id": "batch-a",
                    "events": [{**_event(), "payload": bad_payload}],
                },
            )
            for bad_payload in (
                {"unsafe": 2**53},
                {"nonfinite": float("nan")},
                {"surrogate": "\ud800"},
                {1: "non-string-key"},
                {"bytes": b"bytes"},
                {"datetime": datetime(2026, 8, 7)},
                {"object": object()},
            )
        ],
        *[
            _tool_case(
                "sync_push",
                {
                    "space_id": "space-a",
                    "client_id": "client-a",
                    "batch_id": "batch-a",
                    "events": [{**_event(), "expected_version": bad_version}],
                },
            )
            for bad_version in (True, "7", 2**53)
        ],
    ],
)
async def test_fastmcp_invalid_inputs_authenticate_then_open_zero_handles(
    monkeypatch, tool_name: str, arguments: dict[str, object]
) -> None:
    import app.mcp.sync_tools as sync_tools
    from app.mcp.server import mcp

    factory = _Factory(_Protocol())
    monkeypatch.setattr(sync_tools, "_installed_factory", factory)
    tool = await mcp.get_tool(tool_name)
    monkeypatch.setattr(tool, "_protocol_factory", factory)

    with pytest.raises(ToolError) as raised:
        await tool.run(arguments)

    payload = __import__("json").loads(str(raised.value))
    assert set(payload) == {"code", "message", "retryable", "request_id", "details"}
    assert factory.authenticated == 1
    assert factory.opened == []


@pytest.mark.asyncio
async def test_fastmcp_push_validates_non_string_top_level_key_before_key_set_logic(
    monkeypatch,
) -> None:
    import json

    import app.mcp.sync_tools as sync_tools
    from app.mcp.server import mcp

    factory = _Factory(_Protocol())
    monkeypatch.setattr(sync_tools, "_installed_factory", factory)
    tool = await mcp.get_tool("sync_push")
    monkeypatch.setattr(tool, "_protocol_factory", factory)

    arguments = {
        "space_id": "space-a",
        "client_id": "client-a",
        "batch_id": "batch-a",
        "events": [_event()],
        1: "non-string-top-level-key",
    }
    with pytest.raises(ToolError) as raised:
        await tool.run(arguments)

    assert json.loads(str(raised.value))["code"] == "non_string_object_key"
    assert factory.authenticated == 1
    assert factory.opened == []


def _sized_event(index: int, filler_size: int) -> SyncEventInput:
    return SyncEventInput.from_mapping(
        {
            **_event(),
            "entity_id": f"note-{index}",
            "operation_id": f"op-{index}",
            "payload": {"blob": "x" * filler_size},
        }
    )


def _event_at_exact_size(index: int, target: int) -> SyncEventInput:
    from app.sync.contracts import canonical_sync_event_bytes

    low, high = 0, target
    while low <= high:
        middle = (low + high) // 2
        candidate = _sized_event(index, middle)
        size = len(canonical_sync_event_bytes(candidate))
        if size == target:
            return candidate
        if size < target:
            low = middle + 1
        else:
            high = middle - 1
    raise AssertionError(f"no event encodes to {target} bytes")


@pytest.mark.asyncio
async def test_rest_and_mcp_push_share_event_and_batch_byte_boundaries(
    client, monkeypatch
) -> None:
    import json

    import app.mcp.sync_tools as sync_tools
    from app.errors import CANONICAL_ERROR_MEDIA_TYPE, to_wire_json
    from app.logging import request_id_var
    from app.settings import settings
    from app.sync.contracts import canonical_sync_batch_bytes
    from app.sync.operations import validate_push_call

    protocol = _Protocol()
    factory = _Factory(protocol)
    monkeypatch.setattr(sync_tools, "_installed_factory", factory)
    exact = _event_at_exact_size(500, settings.sync_event_payload_max_bytes)
    exact_wire = to_wire_json(exact)
    exact_body = json.dumps(
        {"client_id": "client-a", "batch_id": "batch-a", "events": [exact_wire]},
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")

    await sync_tools.sync_push("space-a", "client-a", "batch-a", [exact_wire])
    validated_rest_call = validate_push_call(
        exact_body,
        max_body_bytes=settings.request_body_max_bytes,
        max_event_bytes=settings.sync_event_payload_max_bytes,
        max_batch_bytes=settings.sync_canonical_batch_max_bytes,
    )
    assert validated_rest_call.events == (exact,)
    protocol.push.assert_awaited_once()
    rest_exact = await client.post(
        "/api/v1/sync/v2/push",
        json={"client_id": "client-a", "batch_id": "batch-a", "events": [exact_wire]},
    )
    assert rest_exact.status_code == 401
    assert factory.opened == [("space-a", "push")]

    oversized = _sized_event(500, len(exact.payload["blob"]) + 1)
    factory.opened.clear()
    protocol.push.reset_mock()
    request_id = "req-sync-byte-boundary"
    request_id_token = request_id_var.set(request_id)
    try:
        with pytest.raises(ToolError) as mcp_event_error:
            await sync_tools.sync_push(
                "space-a", "client-a", "batch-a", [to_wire_json(oversized)]
            )
    finally:
        request_id_var.reset(request_id_token)
    rest_event_error = await client.post(
        "/api/v1/sync/v2/push",
        json={
            "client_id": "client-a",
            "batch_id": "batch-a",
            "events": [to_wire_json(oversized)],
        },
        headers={
            "Accept": CANONICAL_ERROR_MEDIA_TYPE,
            "X-Request-ID": request_id,
        },
    )
    mcp_event_record = json.loads(str(mcp_event_error.value))
    assert set(mcp_event_record) == {
        "code",
        "message",
        "retryable",
        "request_id",
        "details",
    }
    assert rest_event_error.json() == mcp_event_record
    assert factory.opened == []
    protocol.push.assert_not_awaited()

    filler = settings.sync_canonical_batch_max_bytes // 500
    aggregate = tuple(_sized_event(index, filler) for index in range(500))
    while len(canonical_sync_batch_bytes(aggregate)) <= (
        settings.sync_canonical_batch_max_bytes
    ):
        filler += 1
        aggregate = tuple(_sized_event(index, filler) for index in range(500))
    assert all(
        len(__import__("app.sync.contracts", fromlist=["canonical_sync_event_bytes"]).canonical_sync_event_bytes(event))
        <= settings.sync_event_payload_max_bytes
        for event in aggregate
    )
    aggregate_wire = [to_wire_json(event) for event in aggregate]
    request_id_token = request_id_var.set(request_id)
    try:
        with pytest.raises(ToolError) as mcp_batch_error:
            await sync_tools.sync_push(
                "space-a", "client-a", "batch-a", aggregate_wire
            )
    finally:
        request_id_var.reset(request_id_token)
    rest_batch_error = await client.post(
        "/api/v1/sync/v2/push",
        json={
            "client_id": "client-a",
            "batch_id": "batch-a",
            "events": aggregate_wire,
        },
        headers={
            "Accept": CANONICAL_ERROR_MEDIA_TYPE,
            "X-Request-ID": request_id,
        },
    )
    mcp_batch_record = json.loads(str(mcp_batch_error.value))
    assert set(mcp_batch_record) == {
        "code",
        "message",
        "retryable",
        "request_id",
        "details",
    }
    assert rest_batch_error.json() == mcp_batch_record
    assert factory.opened == []
    protocol.push.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "bad_payload",
    [
        {"bad": 2**53},
        {"bad": float("inf")},
        {"bad": b"bytes"},
        {1: "non-string-key"},
    ],
)
async def test_mcp_push_rejects_non_i_json_after_auth_before_open(
    monkeypatch, bad_payload: object
) -> None:
    import app.mcp.sync_tools as sync_tools

    factory = _Factory(_Protocol())
    monkeypatch.setattr(sync_tools, "_installed_factory", factory)
    event = _event()
    event["payload"] = bad_payload

    with pytest.raises(ToolError):
        await sync_tools.sync_push("space-a", "client-a", "batch-a", [event])

    assert factory.authenticated == 1
    assert factory.opened == []


class _Handle:
    def __init__(self, close_error: BaseException | None = None) -> None:
        self.closed = 0
        self.active = False
        self.close_error = close_error

    async def aclose(self) -> None:
        self.closed += 1
        self.active = False
        if self.close_error is not None:
            raise BaseExceptionGroup("cleanup", [self.close_error])

    async def __aenter__(self):
        self.active = True
        return self

    async def __aexit__(self, exc_type, exc, traceback) -> bool:
        try:
            await self.aclose()
        except BaseExceptionGroup as cleanup:
            if exc is not None:
                raise BaseExceptionGroup("body and cleanup", [exc, *cleanup.exceptions])
            raise
        return False


async def _invoke_sync_tool(sync_tools, operation_name: str):
    if operation_name == "query_operations":
        return await sync_tools.sync_query_operations(
            "space-a", "client-a", ["op-a"]
        )
    if operation_name == "push":
        return await sync_tools.sync_push(
            "space-a", "client-a", "batch-a", [_event()]
        )
    if operation_name == "pull":
        return await sync_tools.sync_pull("space-a", "client-a", CURSOR, 7)
    if operation_name == "recover":
        return await sync_tools.sync_recover("space-a", "client-a", PAGE_TOKEN)
    if operation_name == "ack":
        return await sync_tools.sync_ack("space-a", "client-a", CURSOR)
    return await sync_tools.get_sync_status("space-a", "client-a")


_PROTOCOL_METHOD = {
    "query_operations": "query_operations",
    "push": "push",
    "pull": "pull",
    "recover": "recover",
    "ack": "ack",
    "status": "status",
}


def _install_real_factory_with_fake_protocol(monkeypatch, protocol, handle):
    import app.mcp.sync_tools as sync_tools

    services = SimpleNamespace(
        scope=SimpleNamespace(open=AsyncMock(return_value=handle)),
        mutation_uow=object(),
        catalog=object(),
    )
    factory = sync_tools.McpSyncProtocolFactory(lambda: services)
    monkeypatch.setattr(factory, "authenticate", AsyncMock(return_value=Principal("test", "trusted_stdio", 0, None)))
    monkeypatch.setattr(sync_tools, "_installed_factory", factory)
    monkeypatch.setattr(sync_tools, "SyncProtocol", lambda *_args, **_kwargs: protocol)
    return sync_tools, services


@pytest.mark.asyncio
@pytest.mark.parametrize("operation_name", list(_PROTOCOL_METHOD))
async def test_each_mcp_tool_closes_runtime_handle_once_on_success(
    monkeypatch, operation_name: str
) -> None:
    protocol = _Protocol()
    handle = _Handle()
    sync_tools, _services = _install_real_factory_with_fake_protocol(
        monkeypatch, protocol, handle
    )

    await _invoke_sync_tool(sync_tools, operation_name)

    assert handle.closed == 1
    assert handle.active is False


@pytest.mark.asyncio
@pytest.mark.parametrize("operation_name", list(_PROTOCOL_METHOD))
async def test_each_mcp_tool_closes_runtime_handle_once_on_protocol_error(
    monkeypatch, operation_name: str
) -> None:
    protocol = _Protocol()
    getattr(protocol, _PROTOCOL_METHOD[operation_name]).side_effect = ValidationError(
        "body"
    )
    handle = _Handle()
    sync_tools, _services = _install_real_factory_with_fake_protocol(
        monkeypatch, protocol, handle
    )

    with pytest.raises(ToolError):
        await _invoke_sync_tool(sync_tools, operation_name)

    assert handle.closed == 1
    assert handle.active is False


@pytest.mark.asyncio
@pytest.mark.parametrize("operation_name", list(_PROTOCOL_METHOD))
async def test_each_mcp_tool_cancellation_waits_for_open_then_closes_once(
    monkeypatch, operation_name: str
) -> None:
    protocol = _Protocol()
    entered = asyncio.Event()

    async def blocked(*_args, **_kwargs):
        entered.set()
        await asyncio.Event().wait()

    getattr(protocol, _PROTOCOL_METHOD[operation_name]).side_effect = blocked
    handle = _Handle()
    sync_tools, _services = _install_real_factory_with_fake_protocol(
        monkeypatch, protocol, handle
    )
    task = asyncio.create_task(_invoke_sync_tool(sync_tools, operation_name))
    await entered.wait()
    assert handle.active is True

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert handle.closed == 1
    assert handle.active is False


@pytest.mark.asyncio
@pytest.mark.parametrize("primary", [ValidationError("body"), asyncio.CancelledError()])
async def test_mcp_body_and_handle_cleanup_failure_preserve_primary_order(
    monkeypatch, primary
) -> None:
    protocol = _Protocol()
    protocol.pull.side_effect = primary
    cleanup = RuntimeError("close")
    handle = _Handle(cleanup)
    sync_tools, _services = _install_real_factory_with_fake_protocol(
        monkeypatch, protocol, handle
    )

    with pytest.raises(BaseExceptionGroup) as raised:
        await _invoke_sync_tool(sync_tools, "pull")

    assert raised.value.exceptions == (primary, cleanup)
    assert handle.closed == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "operation_name",
    ["query_operations", "push", "pull", "recover", "ack", "status"],
)
@pytest.mark.parametrize("primary", [None, ValidationError("body"), asyncio.CancelledError()])
async def test_protocol_factory_closes_handle_once_on_all_body_paths(
    operation_name: str, primary
) -> None:
    from app.mcp.sync_tools import McpSyncProtocolFactory

    handle = _Handle()
    services = SimpleNamespace(
        scope=SimpleNamespace(open=AsyncMock(return_value=handle)),
        mutation_uow=object(),
        catalog=object(),
    )
    factory = McpSyncProtocolFactory(lambda: services)
    principal = Principal("test", "trusted_stdio", 0, None)

    if primary is None:
        async with factory.open_authenticated(
            principal=principal, space_id="space-a", operation_name=operation_name
        ):
            pass
    else:
        with pytest.raises(type(primary)):
            async with factory.open_authenticated(
                principal=principal, space_id="space-a", operation_name=operation_name
            ):
                raise primary

    assert handle.closed == 1
    expected_mode = "read" if operation_name == "status" else "write"
    services.scope.open.assert_awaited_once_with(principal, "space-a", expected_mode)


@pytest.mark.asyncio
@pytest.mark.parametrize("primary", [ValidationError("body"), asyncio.CancelledError()])
async def test_protocol_factory_preserves_primary_before_cleanup_failure(primary) -> None:
    from app.mcp.sync_tools import McpSyncProtocolFactory

    cleanup = RuntimeError("close")
    handle = _Handle(cleanup)
    services = SimpleNamespace(
        scope=SimpleNamespace(open=AsyncMock(return_value=handle)),
        mutation_uow=object(),
        catalog=object(),
    )
    factory = McpSyncProtocolFactory(lambda: services)

    with pytest.raises(BaseExceptionGroup) as raised:
        async with factory.open_authenticated(
            principal=Principal("test", "trusted_stdio", 0, None),
            space_id="space-a",
            operation_name="pull",
        ):
            raise primary

    assert raised.value.exceptions == (primary, cleanup)
    assert handle.closed == 1


async def _install_tool_with_real_runtime_handle(
    tmp_path, monkeypatch, protocol, *, file_system=None
):
    import app.mcp.sync_tools as sync_tools
    from app.mcp.server import mcp
    from app.runtime.leases import LeaseMode, RuntimeLeaseCoordinator
    from app.runtime.space import SpaceRuntime, SpaceRuntimeHandle

    leases = RuntimeLeaseCoordinator(tmp_path / "mcp-runtime")
    runtime = SpaceRuntime(
        leases=leases,
        engines=SimpleNamespace(),
        migrations=SimpleNamespace(),
        index_schema=SimpleNamespace(),
    )
    opened: dict[str, object] = {"close_calls": 0}

    async def open_handle(_principal, space_id: str, _mode: str):
        global_lease = await leases.acquire_global(
            LeaseMode.SHARED, "mcp-sync-test", 2
        )
        space_lease = await leases.acquire_spaces(
            [space_id], LeaseMode.EXCLUSIVE, "mcp-sync-test", 2
        )
        handle = SpaceRuntimeHandle(
            SimpleNamespace(space_id=space_id),
            None,
            file_system,
            global_lease,
            space_lease,
            True,
            True,
            space_lease.fence,
            runtime,
        )
        original_aclose = handle.aclose

        async def counted_aclose() -> None:
            opened["close_calls"] = int(opened["close_calls"]) + 1
            await original_aclose()

        handle.aclose = counted_aclose  # type: ignore[method-assign]
        opened.update(
            handle=handle,
            global_lease=global_lease,
            space_lease=space_lease,
        )
        return handle

    services = SimpleNamespace(
        scope=SimpleNamespace(open=AsyncMock(side_effect=open_handle)),
        mutation_uow=object(),
        catalog=object(),
    )
    factory = sync_tools.McpSyncProtocolFactory(lambda: services)
    monkeypatch.setattr(
        factory,
        "authenticate",
        AsyncMock(return_value=Principal("test", "trusted_stdio", 0, None)),
    )
    monkeypatch.setattr(sync_tools, "SyncProtocol", lambda *_args, **_kwargs: protocol)
    tool = await mcp.get_tool("sync_pull")
    monkeypatch.setattr(tool, "_protocol_factory", factory)
    return tool, leases, opened


def _pull_tool_arguments() -> dict[str, object]:
    return {
        "space_id": "space-a",
        "client_id": "client-a",
        "cursor": CURSOR,
        "limit": 7,
    }


@pytest.mark.asyncio
async def test_real_space_runtime_handle_releases_leases_after_mcp_success(
    tmp_path, monkeypatch
) -> None:
    protocol = _Protocol()
    tool, leases, opened = await _install_tool_with_real_runtime_handle(
        tmp_path, monkeypatch, protocol
    )

    await tool.run(_pull_tool_arguments())

    assert opened["close_calls"] == 1
    assert opened["space_lease"]._released is True
    assert opened["global_lease"]._released is True
    assert leases.has_pending_cleanups_for_current_task() is False


@pytest.mark.asyncio
async def test_real_space_runtime_handle_releases_leases_after_mcp_app_error(
    tmp_path, monkeypatch
) -> None:
    protocol = _Protocol()
    protocol.pull.side_effect = ValidationError("body")
    tool, leases, opened = await _install_tool_with_real_runtime_handle(
        tmp_path, monkeypatch, protocol
    )

    with pytest.raises(ToolError):
        await tool.run(_pull_tool_arguments())

    assert opened["close_calls"] == 1
    assert opened["space_lease"]._released is True
    assert opened["global_lease"]._released is True
    assert leases.has_pending_cleanups_for_current_task() is False


@pytest.mark.asyncio
async def test_real_space_runtime_handle_releases_leases_after_event_driven_cancel(
    tmp_path, monkeypatch
) -> None:
    protocol = _Protocol()
    entered = asyncio.Event()

    async def blocked(*_args, **_kwargs):
        entered.set()
        await asyncio.Event().wait()

    protocol.pull.side_effect = blocked
    tool, _leases, opened = await _install_tool_with_real_runtime_handle(
        tmp_path, monkeypatch, protocol
    )
    task = asyncio.create_task(tool.run(_pull_tool_arguments()))
    await entered.wait()

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert opened["close_calls"] == 1
    assert opened["space_lease"]._released is True
    assert opened["global_lease"]._released is True


class _FailOnceFileSystem:
    def __init__(self) -> None:
        self.attempts = 0

    async def close(self) -> None:
        self.attempts += 1
        if self.attempts == 1:
            raise OSError("close failed")


@pytest.mark.asyncio
@pytest.mark.parametrize("primary", [ValidationError("body"), asyncio.CancelledError()])
async def test_real_space_runtime_cleanup_retry_preserves_primary_and_releases_leases(
    tmp_path, monkeypatch, primary
) -> None:
    protocol = _Protocol()
    protocol.pull.side_effect = primary
    file_system = _FailOnceFileSystem()
    tool, leases, opened = await _install_tool_with_real_runtime_handle(
        tmp_path, monkeypatch, protocol, file_system=file_system
    )

    with pytest.raises(BaseExceptionGroup) as raised:
        await tool.run(_pull_tool_arguments())

    assert raised.value.exceptions[0] is primary
    assert isinstance(raised.value.exceptions[1], OSError)
    assert opened["close_calls"] == 1
    assert opened["space_lease"]._released is False
    assert opened["global_lease"]._released is False
    assert leases.has_pending_cleanups_for_current_task() is True

    assert await leases.retry_pending_cleanups_for_current_task() == ()
    assert opened["close_calls"] == 2
    assert leases.has_pending_cleanups_for_current_task() is False
    assert opened["space_lease"]._released is True
    assert opened["global_lease"]._released is True
