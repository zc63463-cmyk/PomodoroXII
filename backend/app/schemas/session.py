"""Pydantic schemas for pomodoro sessions."""

from typing import Literal, Optional

from pydantic import BaseModel, Field


class SessionBase(BaseModel):
    """Base fields shared by session schemas."""

    task_id: Optional[str] = None
    type: Literal["work", "short_break", "long_break", "free", "countdown"]
    duration: int
    completed: bool = False
    plan: str = Field(default="", max_length=5000)
    completion: str = Field(default="", max_length=5000)
    started_at: str
    ended_at: Optional[str] = None
    mood: Optional[Literal["great", "good", "normal", "bad", "terrible"]] = None
    note: str = Field(default="", max_length=5000)
    # Phase 1: enhanced metrics (optional, backward compatible)
    attention_score: Optional[int] = None
    flow_state_detected: Optional[bool] = None
    flow_state_confidence: Optional[float] = None
    interruption_count: Optional[int] = 0
    total_interruption_duration: Optional[int] = 0
    avg_recovery_time: Optional[int] = None
    pause_count: Optional[int] = 0
    total_pause_duration: Optional[int] = 0
    cognitive_mark_summary: Optional[str] = Field(default="", max_length=10000)


class SessionCreate(SessionBase):
    """Schema for creating a new session."""

    id: Optional[str] = None


class SessionUpdate(BaseModel):
    """Schema for updating an existing session."""

    task_id: Optional[str] = None
    type: Optional[
        Literal["work", "short_break", "long_break", "free", "countdown"]
    ] = None
    duration: Optional[int] = None
    completed: Optional[bool] = None
    plan: Optional[str] = Field(default=None, max_length=5000)
    completion: Optional[str] = Field(default=None, max_length=5000)
    started_at: Optional[str] = None
    ended_at: Optional[str] = None
    mood: Optional[Literal["great", "good", "normal", "bad", "terrible"]] = None
    note: Optional[str] = Field(default=None, max_length=5000)
    attention_score: Optional[int] = None
    flow_state_detected: Optional[bool] = None
    flow_state_confidence: Optional[float] = None
    interruption_count: Optional[int] = None
    total_interruption_duration: Optional[int] = None
    avg_recovery_time: Optional[int] = None
    pause_count: Optional[int] = None
    total_pause_duration: Optional[int] = None
    cognitive_mark_summary: Optional[str] = Field(default=None, max_length=10000)


class SessionResponse(SessionBase):
    """Schema for session API responses."""

    id: str
    created_at: str
    updated_at: str
    version: int = 1

    model_config = {"from_attributes": True}
