"""Pydantic schemas for schedules (calendar events with completion status)."""

from typing import Literal, Optional

from pydantic import BaseModel, Field


class ScheduleBase(BaseModel):
    """Base fields shared by schedule schemas."""

    title: str = Field(..., max_length=500)
    due_at: str
    completed_at: Optional[str] = None
    priority: Literal["high", "medium", "low"] = "medium"
    color: str = Field(default="#3b82f6", max_length=20)
    all_day: bool = False
    start_time: Optional[str] = None
    end_time: Optional[str] = None


class ScheduleCreate(ScheduleBase):
    """Schema for creating a new schedule."""

    id: Optional[str] = None


class ScheduleUpdate(BaseModel):
    """Schema for updating an existing schedule."""

    title: Optional[str] = Field(default=None, max_length=500)
    due_at: Optional[str] = None
    completed_at: Optional[str] = None
    priority: Optional[Literal["high", "medium", "low"]] = None
    color: Optional[str] = Field(default=None, max_length=20)
    all_day: Optional[bool] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None


class ScheduleResponse(ScheduleBase):
    """Schema for schedule API responses."""

    id: str
    created_at: str
    updated_at: str
    version: int = 1

    model_config = {"from_attributes": True}
