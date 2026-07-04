"""Pydantic schemas for tasks."""

import json
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator


class TaskBase(BaseModel):
    """Base fields shared by task schemas.

    The ``tags`` column is stored as a JSON-serialised string in SQLite;
    ``parse_tags`` reverses that when loading from the ORM so callers
    always see a real ``list[str]``.
    """

    title: str = Field(..., max_length=200)
    status: Literal["todo", "in_progress", "done", "archived"] = "todo"
    priority: Literal["low", "medium", "high", "urgent"] = "medium"
    tags: list[str] = []
    description: str = Field(default="", max_length=10000)
    plan: str = Field(default="", max_length=10000)
    completion: str = Field(default="", max_length=10000)
    due_date: Optional[str] = Field(default=None, max_length=32)
    estimated_pomodoros: int = 1

    @field_validator("tags", mode="before")
    @classmethod
    def parse_tags(cls, v: object) -> list[str]:
        """Parse JSON string to list when loading from ORM."""
        if isinstance(v, str):
            return json.loads(v) if v else []
        return v  # type: ignore[return-value]


class TaskCreate(TaskBase):
    """Schema for creating a new task."""

    id: Optional[str] = Field(default=None, max_length=36)


class TaskUpdate(BaseModel):
    """Schema for updating an existing task — all fields optional."""

    title: Optional[str] = Field(default=None, max_length=200)
    status: Optional[Literal["todo", "in_progress", "done", "archived"]] = None
    priority: Optional[Literal["low", "medium", "high", "urgent"]] = None
    tags: Optional[list[str]] = None
    description: Optional[str] = Field(default=None, max_length=10000)
    plan: Optional[str] = Field(default=None, max_length=10000)
    completion: Optional[str] = Field(default=None, max_length=10000)
    due_date: Optional[str] = Field(default=None, max_length=32)
    estimated_pomodoros: Optional[int] = None


class TaskResponse(TaskBase):
    """Schema for task API responses."""

    id: str
    created_at: str
    updated_at: str
    version: int = 1
    actual_pomodoros: int = 0
    archived_at: Optional[str] = None

    model_config = {"from_attributes": True}
