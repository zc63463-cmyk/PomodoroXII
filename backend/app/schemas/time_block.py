"""Pydantic schemas for time blocks (time blocking feature)."""

from typing import Literal, Optional

from pydantic import BaseModel, Field


class TimeBlockBase(BaseModel):
    """Base fields shared by time block schemas."""

    task_id: Optional[str] = None
    title: str = Field(default="", max_length=500)
    date: str
    start_time: str
    end_time: str
    planned_duration: int = 0
    actual_duration: int = 0
    block_type: Literal["work", "short_break", "long_break"] = "work"
    status: Literal["planned", "in_progress", "completed", "skipped"] = "planned"
    sort_order: int = 0


class TimeBlockCreate(TimeBlockBase):
    """Schema for creating a new time block."""

    id: Optional[str] = None


class TimeBlockUpdate(BaseModel):
    """Schema for updating an existing time block."""

    task_id: Optional[str] = None
    title: Optional[str] = Field(default=None, max_length=500)
    date: Optional[str] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    planned_duration: Optional[int] = None
    actual_duration: Optional[int] = None
    block_type: Optional[Literal["work", "short_break", "long_break"]] = None
    status: Optional[
        Literal["planned", "in_progress", "completed", "skipped"]
    ] = None
    sort_order: Optional[int] = None


class TimeBlockResponse(TimeBlockBase):
    """Schema for time block API responses."""

    id: str
    created_at: str
    updated_at: str
    version: int = 1

    model_config = {"from_attributes": True}
