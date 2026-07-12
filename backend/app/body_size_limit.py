"""Enforce request body limits at the ASGI receive boundary."""

from __future__ import annotations

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send


class _RequestBodyError(Exception):
    def __init__(self, status_code: int, error_type: str, detail: str) -> None:
        self.status_code = status_code
        self.error_type = error_type
        self.detail = detail


class BodySizeLimitMiddleware:
    """Reject invalid or oversized bodies without buffering the request stream."""

    def __init__(self, app: ASGIApp, *, max_bytes: int = 10 * 1024 * 1024) -> None:
        if max_bytes < 0:
            raise ValueError("max_bytes must be non-negative")
        self.app = app
        self._max_bytes = max_bytes

    @staticmethod
    def _header_values(scope: Scope, name: bytes) -> list[bytes]:
        return [value for key, value in scope.get("headers", []) if key.lower() == name]

    @classmethod
    def _declared_size(cls, scope: Scope) -> int | None:
        content_lengths = cls._header_values(scope, b"content-length")
        transfer_encodings = cls._header_values(scope, b"transfer-encoding")
        if content_lengths and transfer_encodings:
            raise _RequestBodyError(
                400,
                "invalid_request_framing",
                "Content-Length and Transfer-Encoding cannot be combined",
            )
        if not content_lengths:
            return None
        if len(content_lengths) != 1:
            raise _RequestBodyError(400, "invalid_content_length", "Invalid Content-Length header")
        raw = content_lengths[0]
        if not raw or not raw.isdigit():
            raise _RequestBodyError(400, "invalid_content_length", "Invalid Content-Length header")
        return int(raw)

    async def _error(self, scope: Scope, receive: Receive, send: Send, error: _RequestBodyError) -> None:
        await JSONResponse(
            status_code=error.status_code,
            content={"detail": error.detail, "error_type": error.error_type},
        )(scope, receive, send)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        try:
            declared_size = self._declared_size(scope)
        except _RequestBodyError as error:
            await self._error(scope, receive, send, error)
            return
        if declared_size is not None and declared_size > self._max_bytes:
            await self._error(
                scope,
                receive,
                send,
                _RequestBodyError(
                    413,
                    "request_too_large",
                    f"Request body too large (max {self._max_bytes} bytes)",
                ),
            )
            return

        received = 0
        complete = False
        response_started = False
        detected_error: _RequestBodyError | None = None

        async def limited_receive() -> Message:
            nonlocal complete, detected_error, received
            if complete:
                return {"type": "http.request", "body": b"", "more_body": False}
            try:
                message = await receive()
            except Exception:
                detected_error = _RequestBodyError(
                    400, "invalid_request_body", "Invalid request body"
                )
                complete = True
                return {"type": "http.request", "body": b"", "more_body": False}
            if message["type"] == "http.disconnect":
                detected_error = _RequestBodyError(
                    400, "request_disconnected", "Request disconnected"
                )
                complete = True
                return {"type": "http.request", "body": b"", "more_body": False}
            if message["type"] != "http.request":
                return message

            received += len(message.get("body", b""))
            if received > self._max_bytes:
                detected_error = _RequestBodyError(
                    413,
                    "request_too_large",
                    f"Request body too large (max {self._max_bytes} bytes)",
                )
                complete = True
                return {"type": "http.request", "body": b"", "more_body": False}
            if not message.get("more_body", False):
                complete = True
                if declared_size is not None and received != declared_size:
                    detected_error = _RequestBodyError(
                        400,
                        "content_length_mismatch",
                        "Request body length does not match Content-Length",
                    )
                    return {"type": "http.request", "body": b"", "more_body": False}
            return message

        async def tracked_send(message: Message) -> None:
            nonlocal response_started
            if detected_error is not None:
                return
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        await self.app(scope, limited_receive, tracked_send)
        if detected_error is not None and not response_started:
            await self._error(scope, receive, send, detected_error)
