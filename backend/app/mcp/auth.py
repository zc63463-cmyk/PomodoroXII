"""FastMCP authentication and canonical error adapters."""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from functools import wraps
from typing import Any, ParamSpec, TypeVar

from fastmcp.exceptions import ToolError
from fastmcp.server.auth import AccessToken, TokenVerifier
from fastmcp.server.dependencies import get_access_token, get_http_headers

from app.auth.authority import Principal, verify_with_fresh_meta_session
from app.errors import AppError, AuthenticationError, to_wire_json
from app.logging import request_id_var

P = ParamSpec("P")
R = TypeVar("R")


class PomodoroTokenVerifier(TokenVerifier):
    """Verify bearer tokens against the current persisted credential epoch."""

    async def verify_token(self, token: str) -> AccessToken | None:
        try:
            principal = await verify_with_fresh_meta_session(
                token,
                required_scope=None,
            )
        except AppError:
            return None
        scopes = (
            ["master"]
            if principal.token_type == "master"
            else [f"space:{principal.space_id}"]
        )
        return AccessToken(
            token=token,
            client_id=principal.subject,
            subject=principal.subject,
            scopes=scopes,
            expires_at=principal.expires_at,
            claims={
                "sub": principal.subject,
                "type": principal.token_type,
                "space_id": principal.space_id,
                "epoch": principal.epoch,
            },
        )


@dataclass(frozen=True, slots=True)
class TransportAdapterState:
    trusted_stdio: bool = False


_transport_state: ContextVar[TransportAdapterState] = ContextVar(
    "mcp_transport_state",
    default=TransportAdapterState(),
)


@contextmanager
def trusted_stdio_context() -> Iterator[None]:
    """Enable the explicitly trusted local principal for one call context."""

    token = _transport_state.set(TransportAdapterState(trusted_stdio=True))
    try:
        yield
    finally:
        _transport_state.reset(token)


def current_mcp_principal() -> Principal:
    """Return the transport-authenticated principal without reading tool args."""

    if _transport_state.get().trusted_stdio:
        return Principal(
            subject="trusted-stdio",
            token_type="trusted_stdio",
            epoch=0,
            expires_at=None,
        )

    access = get_access_token()
    if access is None:
        raise AuthenticationError("MCP authentication required")
    claims = access.claims
    subject = claims.get("sub")
    token_type = claims.get("type")
    epoch = claims.get("epoch")
    if not isinstance(subject, str) or not subject:
        raise AuthenticationError("Invalid MCP access claims")
    if token_type not in {"master", "space"} or type(epoch) is not int:
        raise AuthenticationError("Invalid MCP access claims")
    space_id = claims.get("space_id")
    if token_type == "space" and (not isinstance(space_id, str) or not space_id):
        raise AuthenticationError("Invalid MCP access claims")
    return Principal(
        subject=subject,
        token_type=token_type,
        epoch=epoch,
        expires_at=access.expires_at,
        space_id=space_id if token_type == "space" else None,
    )


def mcp_error_payload(error: AppError, request_id: str) -> dict[str, Any]:
    """Serialize an application error through the shared recursive owner."""

    payload = to_wire_json(error.to_domain_record(request_id))
    if not isinstance(payload, dict):
        raise TypeError("MCP error payload must be an object")
    return payload


def _request_id() -> str:
    headers = get_http_headers(include={"x-request-id"})
    return headers.get("x-request-id") or request_id_var.get()


def canonical_mcp_errors(
    function: Callable[P, Awaitable[R]],
) -> Callable[P, Awaitable[R]]:
    """Map domain failures to stable JSON ToolError messages."""

    @wraps(function)
    async def wrapped(*args: P.args, **kwargs: P.kwargs) -> R:
        try:
            return await function(*args, **kwargs)
        except AppError as error:
            payload = mcp_error_payload(error, _request_id())
            raise ToolError(
                json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
            ) from None

    return wrapped
