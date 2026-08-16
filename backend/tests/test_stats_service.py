"""Tests for StatsService -- habit_summary, schedule_summary, note_summary.

All model imports happen INSIDE test functions to avoid stale references
after conftest's per-test module reload.
"""

from __future__ import annotations
