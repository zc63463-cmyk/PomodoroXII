"""Pydantic schemas for habit check-ins (daily check-in records)."""

from typing import Optional

from pydantic import BaseModel, Field


class HabitCheckInBase(BaseModel):
    """Base fields shared by habit check-in schemas."""

    habit_id: str = Field(..., max_length=36)
    date: str = Field(..., max_length=10)
    count: int = 1
    note: str = Field(default="", max_length=10000)


class HabitCheckInCreate(HabitCheckInBase):
    """Schema for creating a new habit check-in."""

    id: Optional[str] = None


class HabitCheckInUpdate(BaseModel):
    """Schema for updating an existing habit check-in."""

    habit_id: Optional[str] = Field(default=None, max_length=36)
    date: Optional[str] = Field(default=None, max_length=10)
    count: Optional[int] = None
    note: Optional[str] = Field(default=None, max_length=10000)


class HabitCheckInResponse(HabitCheckInBase):
    """Schema for habit check-in API responses."""

    id: str
    created_at: str
    updated_at: str
    version: int = 1

    model_config = {"from_attributes": True}
