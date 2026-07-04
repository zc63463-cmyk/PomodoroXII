"""Tests for app.logging — JsonFormatter and setup_logging."""

from __future__ import annotations

import json
import logging

from app.logging import JsonFormatter, request_id_var, setup_logging


class TestJsonFormatter:
    def test_produces_valid_json(self):
        """format() should return a valid JSON string."""
        formatter = JsonFormatter()
        record = logging.LogRecord(
            name="test.logger",
            level=logging.INFO,
            pathname=__file__,
            lineno=1,
            msg="Hello world",
            args=(),
            exc_info=None,
        )
        output = formatter.format(record)
        parsed = json.loads(output)  # Should not raise
        assert isinstance(parsed, dict)

    def test_includes_core_fields(self):
        """The JSON output should contain ts, level, logger, and msg."""
        formatter = JsonFormatter()
        record = logging.LogRecord(
            name="my.logger",
            level=logging.WARNING,
            pathname=__file__,
            lineno=42,
            msg="Test message",
            args=(),
            exc_info=None,
        )
        parsed = json.loads(formatter.format(record))
        assert "ts" in parsed
        assert parsed["level"] == "WARNING"
        assert parsed["logger"] == "my.logger"
        assert parsed["msg"] == "Test message"

    def test_includes_request_id_when_set(self):
        """When request_id_var is set, the output should include it."""
        formatter = JsonFormatter()
        record = logging.LogRecord(
            name="test",
            level=logging.INFO,
            pathname=__file__,
            lineno=1,
            msg="msg",
            args=(),
            exc_info=None,
        )
        token = request_id_var.set("req-123")
        try:
            parsed = json.loads(formatter.format(record))
        finally:
            request_id_var.reset(token)
        assert parsed.get("request_id") == "req-123"

    def test_omits_request_id_when_empty(self):
        """When request_id_var is empty, the output should not include request_id."""
        # Ensure request_id_var is empty
        token = request_id_var.set("")
        try:
            formatter = JsonFormatter()
            record = logging.LogRecord(
                name="test",
                level=logging.INFO,
                pathname=__file__,
                lineno=1,
                msg="msg",
                args=(),
                exc_info=None,
            )
            parsed = json.loads(formatter.format(record))
        finally:
            request_id_var.reset(token)
        assert "request_id" not in parsed


class TestSetupLogging:
    def test_is_idempotent(self):
        """Calling setup_logging multiple times should not stack handlers."""
        setup_logging()
        setup_logging()
        setup_logging()

        root = logging.getLogger()
        json_handlers = [
            h for h in root.handlers if getattr(h, "_pomodoroxii_json", False)
        ]
        assert len(json_handlers) == 1
