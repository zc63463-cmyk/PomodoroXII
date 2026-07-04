"""Structured logging with per-request id context.

A single ``request_id_var`` ContextVar is shared between the middleware
(which sets it) and the JsonFormatter (which reads it). This keeps log
output correlated across concurrent requests without threading it
explicitly through every call site.
"""

from __future__ import annotations

import json
import logging
from contextvars import ContextVar

# Shared with app.middleware — set on each request, read by the formatter.
request_id_var: ContextVar[str] = ContextVar("request_id", default="")


class JsonFormatter(logging.Formatter):
    """Emit log records as single-line JSON objects.

    The schema is intentionally small and stable so it can be ingested by
    external log shippers without further transformation::

        {"ts": "...", "level": "INFO", "logger": "app", "msg": "...", "request_id": "..."}
    """

    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        rid = request_id_var.get()
        if rid:
            payload["request_id"] = rid
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)


def setup_logging(level: int | str = logging.INFO) -> None:
    """Configure root logging with the JSON formatter.

    Idempotent: calling it multiple times replaces the existing handler
    rather than stacking duplicates.
    """
    root = logging.getLogger()
    # Remove any previously installed handlers from this module.
    for handler in list(root.handlers):
        if getattr(handler, "_pomodoroxii_json", False):
            root.removeHandler(handler)

    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    handler._pomodoroxii_json = True  # type: ignore[attr-defined]
    root.addHandler(handler)
    root.setLevel(level)
