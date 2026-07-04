"""Pydantic schemas for statistics / analytics responses."""

from pydantic import BaseModel


class FocusStatsResponse(BaseModel):
    """Aggregated focus-session statistics.

    ``by_day`` and ``by_task`` are lists of flat dicts (e.g.
    ``{"date": "2026-07-01", "minutes": 150}``) produced by the stats
    service — kept as ``list[dict]`` so the aggregation SQL can stay
    flexible without a rigid per-row schema.
    """

    total_sessions: int
    total_minutes: int
    by_day: list[dict] = []
    by_task: list[dict] = []

    model_config = {"from_attributes": True}
