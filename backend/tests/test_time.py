"""Tests for app.services.time — UTC timestamp helpers."""

from __future__ import annotations


class TestUtcNowIso:
    def test_has_z_suffix(self):
        """utc_now_iso should return a timestamp ending with Z."""
        from app.services.time import utc_now_iso

        ts = utc_now_iso()
        assert ts.endswith("Z"), f"Expected Z suffix, got: {ts}"
        assert "+" not in ts, f"Expected no timezone offset, got: {ts}"

    def test_seconds_precision(self):
        """utc_now_iso should return seconds precision (no microseconds)."""
        from app.services.time import utc_now_iso

        ts = utc_now_iso()
        # Format: 2026-07-02T10:30:45Z
        time_part = ts.split("T")[1].rstrip("Z")
        assert len(time_part) == 8, f"Expected HH:MM:SS (8 chars), got: {time_part}"
        assert "." not in time_part, f"Expected no microseconds, got: {time_part}"

    def test_utc_now_returns_timezone_aware(self):
        """utc_now should return a timezone-aware datetime."""
        from datetime import timezone
        from app.services.time import utc_now

        dt = utc_now()
        assert dt.tzinfo is not None, "Expected timezone-aware datetime"

    def test_utc_now_iso_ms_has_milliseconds(self):
        """utc_now_iso_ms should include milliseconds."""
        from app.services.time import utc_now_iso_ms

        ts = utc_now_iso_ms()
        assert ts.endswith("Z"), f"Expected Z suffix, got: {ts}"
        time_part = ts.split("T")[1].rstrip("Z")
        assert "." in time_part, f"Expected microseconds, got: {time_part}"
