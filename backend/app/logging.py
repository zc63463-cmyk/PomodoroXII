"""Structured logging with per-request id context and optional JSONL sink.

A single ``request_id_var`` ContextVar is shared between the middleware
(which sets it) and the JsonFormatter (which reads it). This keeps log
output correlated across concurrent requests without threading it
explicitly through every call site.

When ``settings.structured_log_path`` is configured, log records are also
mirrored to that file as parseable JSONL.  The parent directory must already
exist (it is never auto-created), records are redacted of absolute paths,
tokens, secrets and passwords, and ``close_structured_logging()`` performs an
ordered flush + fsync for shutdown.
"""

from __future__ import annotations

import json
import logging
import os
import re
from contextvars import ContextVar
from pathlib import Path

# Shared with app.middleware — set on each request, read by the formatter.
request_id_var: ContextVar[str] = ContextVar("request_id", default="")

# Absolute Windows/Unix path; used to redact data-root and file paths.
_ABS_PATH = re.compile(
    r"(?<![A-Za-z0-9])(?:(?:[A-Za-z]:[\\/])|/)[^\s\"']+"
)
# key=value pairs for secrets; value redacted but key preserved.
_AUTHORIZATION_VALUE = re.compile(
    r'''(["']?\bauthorization["']?\s*[=:]\s*)'''
    r'''(?:"[^"]*"|'[^']*'|(?:(?:bearer|basic)\s+)?[^\s,;}]+)''',
    re.IGNORECASE,
)
_SECRET_PAIR = re.compile(
    r"(\b(?:token|password|secret|api[_-]?key)\s*[=:]\s*)\S+",
    re.IGNORECASE,
)
# A base64url 43-char token (operations token shape) anywhere in text.
_BARE_TOKEN = re.compile(r"\b[A-Za-z0-9_-]{43}\b")


def _redact(text: str) -> str:
    """Redact paths, tokens, secrets and passwords from a log message."""
    from app.settings import settings

    root = str(settings.data_root.expanduser().resolve()).replace("\\", "/")
    redacted = text.replace(root, "<data_root>")
    redacted = _AUTHORIZATION_VALUE.sub(lambda m: m.group(1) + "<redacted>", redacted)
    redacted = _SECRET_PAIR.sub(lambda m: m.group(1) + "<redacted>", redacted)
    redacted = _BARE_TOKEN.sub("<redacted>", redacted)
    # Only replace remaining absolute paths (data root handled above).
    redacted = _ABS_PATH.sub("<path>", redacted)
    return redacted


class JsonFormatter(logging.Formatter):
    """Emit log records as single-line JSON objects.

    The schema is intentionally small and stable so it can be ingested by
    external log shippers without further transformation::

        {"ts": "...", "level": "INFO", "logger": "app", "msg": "...", "request_id": "..."}

    When ``redact`` is enabled (the structured file sink) messages and
    exception text are sanitised of absolute paths, tokens, secrets and
    passwords before serialisation.
    """

    def __init__(self, *, redact: bool = False) -> None:
        super().__init__()
        self._redact = redact

    def format(self, record: logging.LogRecord) -> str:
        message = record.getMessage()
        if self._redact:
            message = _redact(message)
        payload = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S"),
            "level": record.levelname,
            "logger": record.name,
            "msg": message,
        }
        rid = request_id_var.get()
        if rid:
            payload["request_id"] = _redact(rid) if self._redact else rid
        if record.exc_info:
            exc = self.formatException(record.exc_info)
            payload["exc"] = _redact(exc) if self._redact else exc
        return json.dumps(payload, ensure_ascii=False)


_structured_handler: logging.Handler | None = None


def _detach_and_close(handler: logging.Handler, *, durable: bool) -> None:
    root = logging.getLogger()
    root.removeHandler(handler)
    try:
        handler.flush()
        if durable:
            stream = getattr(handler, "stream", None)
            if stream is not None and hasattr(stream, "fileno"):
                try:
                    os.fsync(stream.fileno())
                except (OSError, ValueError):
                    pass
    finally:
        handler.close()


def setup_logging(level: int | str = logging.INFO) -> None:
    """Configure root logging with the JSON formatter and optional JSONL sink.

    Idempotent: calling it multiple times replaces the existing handlers
    rather than stacking duplicates.  When ``settings.structured_log_path``
    is set, the file's parent directory must already exist; otherwise a
    ``ValueError`` is raised (no arbitrary parent creation).
    """
    root = logging.getLogger()
    # Remove any previously installed handlers from this module.
    for handler in list(root.handlers):
        if getattr(handler, "_pomodoroxii_json", False) or getattr(
            handler, "_pomodoroxii_structured", False
        ):
            _detach_and_close(
                handler,
                durable=bool(getattr(handler, "_pomodoroxii_structured", False)),
            )

    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    handler._pomodoroxii_json = True  # type: ignore[attr-defined]
    root.addHandler(handler)
    root.setLevel(level)

    global _structured_handler
    _structured_handler = None
    from app.settings import settings

    if settings.structured_log_path is None:
        return
    path = Path(settings.structured_log_path).expanduser()
    parent = path.parent if str(path.parent) else Path(".")
    if not parent.is_dir():
        raise ValueError(
            "POMODOROXII_STRUCTURED_LOG_PATH parent directory must already exist"
        )
    file_handler = logging.FileHandler(path, encoding="utf-8")
    file_handler.setFormatter(JsonFormatter(redact=True))
    file_handler._pomodoroxii_structured = True  # type: ignore[attr-defined]
    root.addHandler(file_handler)
    _structured_handler = file_handler


def close_structured_logging() -> None:
    """Flush and fsync the structured JSONL sink (ordered shutdown)."""
    global _structured_handler
    handler = _structured_handler
    if handler is None:
        return
    _structured_handler = None
    try:
        _detach_and_close(handler, durable=True)
    except (OSError, ValueError):
        pass
