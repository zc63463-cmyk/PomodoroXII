"""Complete MCP Adapter over the transport-neutral Sync v2 protocol."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Callable, Mapping, Sequence
from contextlib import asynccontextmanager
from contextvars import ContextVar
from typing import Annotated, Any

from fastmcp import FastMCP
from fastmcp.exceptions import ToolError
from fastmcp.tools import FunctionTool
from pydantic import (
    Field,
    PrivateAttr,
    StrictInt,
    StrictStr,
)
from pydantic import (
    ValidationError as PydanticValidationError,
)

from app.auth.authority import Principal
from app.errors import AppError, to_wire_json
from app.mcp.auth import (
    _request_id,
    canonical_mcp_errors,
    current_mcp_principal,
    mcp_error_payload,
)
from app.schemas.sync import (
    SyncV2AckResponse,
    SyncV2Event,
    SyncV2EventRecord,
    SyncV2OperationQueryResponse,
    SyncV2PullResponse,
    SyncV2PushResponse,
    SyncV2RecoveryResponse,
    SyncV2StatusResponse,
)
from app.settings import settings
from app.sync.contracts import (
    MAX_SYNC_RECORDS,
    SyncInputError,
    parse_sync_event_batch,
    validate_batch_id,
    validate_client_id,
    validate_cursor_token,
    validate_i_json_graph,
    validate_operation_query_inputs,
    validate_page_token,
    validate_pull_limit,
    validate_sync_push_inputs,
)
from app.sync.operations import SYNC_OPERATION_BY_NAME, sync_input_app_error
from app.sync.protocol import SyncProtocol

RuntimeServicesProvider = Callable[[], Any]
SafeLimit = Annotated[StrictInt, Field(ge=1, le=500)]
Identifier = Annotated[StrictStr, Field(min_length=1, max_length=64)]
OperationIdentifier = Annotated[StrictStr, Field(min_length=1, max_length=128)]
OpaqueToken = Annotated[StrictStr, Field(min_length=16, max_length=2048)]
OperationIdentifiers = Annotated[
    list[OperationIdentifier],
    Field(
        min_length=1,
        max_length=500,
        json_schema_extra={"uniqueItems": True},
    ),
]


class _McpSyncV2Event(SyncV2Event):
    operation_id: OperationIdentifier


class _McpSyncV2EventRecord(SyncV2EventRecord):
    operation_id: OperationIdentifier
    batch_id: OperationIdentifier


class _McpSyncV2PullResponse(SyncV2PullResponse):
    events: list[_McpSyncV2EventRecord] = Field(max_length=MAX_SYNC_RECORDS)


SyncEvents = Annotated[list[_McpSyncV2Event], Field(min_length=1, max_length=500)]

_authenticated_principal: ContextVar[Principal | None] = ContextVar(
    "mcp_sync_authenticated_principal", default=None
)
_active_factory: ContextVar["McpSyncProtocolFactory | None"] = ContextVar(
    "mcp_sync_protocol_factory", default=None
)
_installed_factory: "McpSyncProtocolFactory | None" = None


def _input_error(exc: BaseException) -> AppError:
    if isinstance(exc, SyncInputError):
        return sync_input_app_error(exc)
    return sync_input_app_error(
        SyncInputError("invalid_sync_input", {"reason": str(exc)})
    )


def _validated(function: Callable[[], Any]) -> Any:
    try:
        return function()
    except (SyncInputError, TypeError, ValueError, PydanticValidationError) as exc:
        raise _input_error(exc) from exc


def _validate_identity(space_id: object, client_id: object | None = None) -> None:
    _validated(lambda: validate_client_id(space_id))
    if client_id is not None:
        _validated(lambda: validate_client_id(client_id))


def _event_mapping(value: object) -> Mapping[str, object]:
    if isinstance(value, SyncV2Event):
        return value.model_dump(mode="python")
    if isinstance(value, Mapping):
        return value
    raise SyncInputError("invalid_event")


def _prepare_query(
    space_id: object, client_id: object, operation_ids: object
) -> tuple[str, tuple[str, ...]]:
    _validate_identity(space_id, client_id)
    if not isinstance(operation_ids, Sequence) or isinstance(
        operation_ids, (str, bytes, bytearray)
    ):
        raise _input_error(SyncInputError("invalid_sync_input"))
    return _validated(lambda: validate_operation_query_inputs(client_id, operation_ids))


def _prepare_push(
    space_id: object,
    client_id: object,
    batch_id: object,
    events: object,
) -> tuple[str, str, tuple[Any, ...]]:
    if not isinstance(events, list):
        raise _input_error(SyncInputError("invalid_sync_batch"))
    event_mappings = _validated(lambda: [_event_mapping(event) for event in events])
    _validated(lambda: validate_i_json_graph(event_mappings))
    _validate_identity(space_id, client_id)
    _validated(lambda: validate_batch_id(batch_id))
    parsed = _validated(
        lambda: parse_sync_event_batch(
            {"events": event_mappings},
            max_event_bytes=settings.sync_event_payload_max_bytes,
            max_batch_bytes=settings.sync_canonical_batch_max_bytes,
        )
    )
    return _validated(
        lambda: validate_sync_push_inputs(
            client_id,
            batch_id,
            parsed,
            max_event_bytes=settings.sync_event_payload_max_bytes,
            max_batch_bytes=settings.sync_canonical_batch_max_bytes,
        )
    )


def _prepare_pull(
    space_id: object, client_id: object, cursor: object, limit: object
) -> tuple[str, str | None, int]:
    _validate_identity(space_id, client_id)
    if cursor is not None:
        _validated(lambda: validate_cursor_token(cursor))
    validated_limit = _validated(lambda: validate_pull_limit(limit))
    return client_id, cursor, validated_limit


def _prepare_recover(
    space_id: object, client_id: object, page_token: object
) -> tuple[str, str | None]:
    _validate_identity(space_id, client_id)
    if page_token is not None:
        _validated(lambda: validate_page_token(page_token))
    return client_id, page_token


def _prepare_ack(
    space_id: object, client_id: object, cursor: object
) -> tuple[str, str]:
    _validate_identity(space_id, client_id)
    return client_id, _validated(lambda: validate_cursor_token(cursor))


def _prepare_status(space_id: object, client_id: object) -> str | None:
    _validate_identity(space_id)
    if client_id is not None:
        return _validated(lambda: validate_client_id(client_id))
    return None


def _wire(model: type[Any], value: object) -> dict[str, Any]:
    payload = to_wire_json(value)
    validated = model.model_validate(payload)
    return validated.model_dump(mode="json")


class McpSyncProtocolFactory:
    """Authenticate and open one authorized runtime handle per tool call."""

    def __init__(self, services_provider: RuntimeServicesProvider) -> None:
        self._services_provider = services_provider

    async def authenticate(self) -> Principal:
        return current_mcp_principal()

    @asynccontextmanager
    async def open_authenticated(
        self, *, principal: Principal, space_id: str, operation_name: str
    ) -> AsyncIterator[SyncProtocol]:
        services = self._services_provider()
        spec = SYNC_OPERATION_BY_NAME[operation_name]
        handle = await services.scope.open(principal, space_id, spec.runtime_mode)
        async with handle:
            yield SyncProtocol(
                handle,
                services.mutation_uow,
                catalog=services.catalog,
            )


def _factory() -> McpSyncProtocolFactory:
    active = _active_factory.get()
    if active is not None:
        return active
    if _installed_factory is None:
        raise RuntimeError("MCP Sync protocol factory is not installed")
    return _installed_factory


async def _authenticate(factory: McpSyncProtocolFactory) -> Principal:
    cached = _authenticated_principal.get()
    return cached if cached is not None else await factory.authenticate()


@canonical_mcp_errors
async def sync_query_operations(
    space_id: Identifier,
    client_id: Identifier,
    operation_ids: OperationIdentifiers,
) -> dict[str, Any]:
    factory = _factory()
    principal = await _authenticate(factory)
    validated_client, validated_ids = _prepare_query(
        space_id, client_id, operation_ids
    )
    async with factory.open_authenticated(
        principal=principal, space_id=space_id, operation_name="query_operations"
    ) as protocol:
        return _wire(
            SyncV2OperationQueryResponse,
            await protocol.query_operations(validated_client, validated_ids),
        )


@canonical_mcp_errors
async def sync_push(
    space_id: Identifier,
    client_id: Identifier,
    batch_id: OperationIdentifier,
    events: SyncEvents,
) -> dict[str, Any]:
    factory = _factory()
    principal = await _authenticate(factory)
    validated_client, validated_batch, validated_events = _prepare_push(
        space_id, client_id, batch_id, events
    )
    async with factory.open_authenticated(
        principal=principal, space_id=space_id, operation_name="push"
    ) as protocol:
        return _wire(
            SyncV2PushResponse,
            await protocol.push(validated_client, validated_events, validated_batch),
        )


@canonical_mcp_errors
async def sync_pull(
    space_id: Identifier,
    client_id: Identifier,
    cursor: OpaqueToken | None = None,
    limit: SafeLimit = 500,
) -> dict[str, Any]:
    factory = _factory()
    principal = await _authenticate(factory)
    validated_client, validated_cursor, validated_limit = _prepare_pull(
        space_id, client_id, cursor, limit
    )
    async with factory.open_authenticated(
        principal=principal, space_id=space_id, operation_name="pull"
    ) as protocol:
        return _wire(
            _McpSyncV2PullResponse,
            await protocol.pull(validated_client, validated_cursor, validated_limit),
        )


@canonical_mcp_errors
async def sync_recover(
    space_id: Identifier,
    client_id: Identifier,
    page_token: OpaqueToken | None = None,
) -> dict[str, Any]:
    factory = _factory()
    principal = await _authenticate(factory)
    validated_client, validated_token = _prepare_recover(
        space_id, client_id, page_token
    )
    async with factory.open_authenticated(
        principal=principal, space_id=space_id, operation_name="recover"
    ) as protocol:
        wire = to_wire_json(await protocol.recover(validated_client, validated_token))
        return SyncV2RecoveryResponse.model_validate(
            {
                "payload_jsonl_base64": wire["jsonl_base64"],
                "entity_count": wire["entity_count"],
                "chunk_sha256": wire["sha256"],
                "next_page_token": wire["next_page_token"],
                "has_more": wire["has_more"],
                "catalog_hash": wire["catalog_hash"],
                "waterline_cursor": wire["waterline_cursor"],
            }
        ).model_dump(mode="json")


@canonical_mcp_errors
async def sync_ack(
    space_id: Identifier,
    client_id: Identifier,
    cursor: OpaqueToken,
) -> dict[str, Any]:
    factory = _factory()
    principal = await _authenticate(factory)
    validated_client, validated_cursor = _prepare_ack(
        space_id, client_id, cursor
    )
    async with factory.open_authenticated(
        principal=principal, space_id=space_id, operation_name="ack"
    ) as protocol:
        return _wire(
            SyncV2AckResponse,
            await protocol.ack(validated_client, validated_cursor),
        )


@canonical_mcp_errors
async def get_sync_status(
    space_id: Identifier,
    client_id: Identifier | None = None,
) -> dict[str, Any]:
    factory = _factory()
    principal = await _authenticate(factory)
    validated_client = _prepare_status(space_id, client_id)
    async with factory.open_authenticated(
        principal=principal, space_id=space_id, operation_name="status"
    ) as protocol:
        return _wire(
            SyncV2StatusResponse,
            await protocol.status(validated_client),
        )


_TOOL_KEYS = {
    "sync_query_operations": ({"space_id", "client_id", "operation_ids"}, set()),
    "sync_push": ({"space_id", "client_id", "batch_id", "events"}, set()),
    "sync_pull": ({"space_id", "client_id"}, {"cursor", "limit"}),
    "sync_recover": ({"space_id", "client_id"}, {"page_token"}),
    "sync_ack": ({"space_id", "client_id", "cursor"}, set()),
    "get_sync_status": ({"space_id"}, {"client_id"}),
}


def _exact_tool_keys(tool_name: str, arguments: Mapping[str, object]) -> None:
    required, optional = _TOOL_KEYS[tool_name]
    actual = set(arguments)
    missing = required - actual
    unexpected = actual - required - optional
    if missing or unexpected:
        raise _input_error(
            SyncInputError(
                "invalid_sync_input",
                {"missing": sorted(missing), "unexpected": sorted(unexpected)},
            )
        )


def _prepare_tool(tool_name: str, args: Mapping[str, object]) -> object:
    if tool_name == "sync_push":
        _validated(lambda: validate_i_json_graph(args))
    _exact_tool_keys(tool_name, args)
    if tool_name == "sync_query_operations":
        return _prepare_query(args["space_id"], args["client_id"], args["operation_ids"])
    if tool_name == "sync_push":
        return _prepare_push(
            args["space_id"], args["client_id"], args["batch_id"], args["events"]
        )
    if tool_name == "sync_pull":
        return _prepare_pull(
            args["space_id"],
            args["client_id"],
            args.get("cursor"),
            args.get("limit", 500),
        )
    if tool_name == "sync_recover":
        return _prepare_recover(
            args["space_id"], args["client_id"], args.get("page_token")
        )
    if tool_name == "sync_ack":
        return _prepare_ack(args["space_id"], args["client_id"], args["cursor"])
    return _prepare_status(args["space_id"], args.get("client_id"))

_RESPONSE_BY_TOOL = {
    "sync_query_operations": SyncV2OperationQueryResponse,
    "sync_push": SyncV2PushResponse,
    "sync_pull": _McpSyncV2PullResponse,
    "sync_recover": SyncV2RecoveryResponse,
    "sync_ack": SyncV2AckResponse,
    "get_sync_status": SyncV2StatusResponse,
}


def _response_schema(tool_name: str) -> dict[str, Any]:
    schema = _RESPONSE_BY_TOOL[tool_name].model_json_schema()
    if tool_name == "sync_recover":
        schema["properties"]["entity_count"]["maximum"] = MAX_SYNC_RECORDS
    return schema


class _CanonicalSyncFunctionTool(FunctionTool):
    _protocol_factory: McpSyncProtocolFactory = PrivateAttr()

    async def run(self, arguments: dict[str, Any]):
        factory = self._protocol_factory
        factory_token = _active_factory.set(factory)
        try:
            try:
                principal = await _authenticate(factory)
            except AppError as error:
                payload = mcp_error_payload(error, _request_id())
                raise ToolError(
                    json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
                ) from None
            principal_token = _authenticated_principal.set(principal)
            try:
                try:
                    _prepare_tool(self.name, arguments)
                except AppError as error:
                    payload = mcp_error_payload(error, _request_id())
                    raise ToolError(
                        json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
                    ) from None
                return await super().run(arguments)
            finally:
                _authenticated_principal.reset(principal_token)
        finally:
            _active_factory.reset(factory_token)


def register_sync_tools(
    mcp: FastMCP, protocol_factory: McpSyncProtocolFactory
) -> None:
    """Install exactly the six catalog-owned Sync tools."""
    global _installed_factory
    _installed_factory = protocol_factory
    functions = {
        "sync_query_operations": sync_query_operations,
        "sync_push": sync_push,
        "sync_pull": sync_pull,
        "sync_recover": sync_recover,
        "sync_ack": sync_ack,
        "get_sync_status": get_sync_status,
    }
    expected = {spec.mcp_tool for spec in SYNC_OPERATION_BY_NAME.values()}
    if set(functions) != expected:
        raise RuntimeError("MCP Sync tool set does not match SYNC_OPERATIONS")
    for name, function in functions.items():
        tool = _CanonicalSyncFunctionTool.from_function(
            function,
            name=name,
            output_schema=_response_schema(name),
        )
        tool._protocol_factory = protocol_factory
        mcp.add_tool(tool)


__all__ = [
    "McpSyncProtocolFactory",
    "get_sync_status",
    "register_sync_tools",
    "sync_ack",
    "sync_pull",
    "sync_push",
    "sync_query_operations",
    "sync_recover",
]
