"""Pydantic schemas for habits (habit streak chain feature)."""

import json
from typing import Optional

from pydantic import BaseModel, Field, field_validator


class HabitBase(BaseModel):
    """Base fields shared by habit schemas.

    ``rest_days`` is a JSON-serialised array of weekday ints (0=Sunday ...
    6=Saturday) in SQLite; ``parse_rest_days`` reverses that when loading
    from the ORM so callers always see a real ``list[int]``.
    """

    title: str = Field(..., max_length=500)
    description: str = Field(default="", max_length=10000)
    color: str = Field(default="#7F77DD", max_length=20)
    icon: str = Field(default="✅", max_length=20)
    target_count: int = 1
    rest_day_protection: bool = False
    rest_days: list[int] = Field(default_factory=list)
    sort_order: int = 0
    archived: bool = False

    @field_validator("rest_days", mode="before")
    @classmethod
    def parse_rest_days(cls, v: object) -> list[int]:
        """Parse JSON string to list when loading from ORM."""
        if isinstance(v, str):
            return json.loads(v) if v else []
        if v is None:
            return []
        return v  # type: ignore[return-value]


class HabitCreate(HabitBase):
    """Schema for creating a new habit."""

    id: Optional[str] = None


class HabitUpdate(BaseModel):
    """Schema for updating an existing habit."""

    title: Optional[str] = Field(default=None, max_length=500)
    description: Optional[str] = Field(default=None, max_length=10000)
    color: Optional[str] = Field(default=None, max_length=20)
    icon: Optional[str] = Field(default=None, max_length=20)
    target_count: Optional[int] = None
    rest_day_protection: Optional[bool] = None
    rest_days: Optional[list[int]] = None
    sort_order: Optional[int] = None
    archived: Optional[bool] = None

    @field_validator("rest_days", mode="before")
    @classmethod
    def parse_rest_days(cls, v: object) -> list[int] | None:
        """Parse JSON string to list when the value arrives serialized."""
        if v is None:
            return None
        if isinstance(v, str):
            return json.loads(v) if v else []
        return v  # type: ignore[return-value]


class HabitResponse(HabitBase):
    """Schema for habit API responses."""

    id: str
    created_at: str
    updated_at: str
    version: int = 1

    model_config = {"from_attributes": True}
