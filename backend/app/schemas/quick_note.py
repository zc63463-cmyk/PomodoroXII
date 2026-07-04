"""Pydantic schemas for quick notes."""

import json
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator


class QuickNoteBase(BaseModel):
    """Base fields shared by quick note schemas."""

    content: str = Field(default="", max_length=50000)
    mood: Optional[
        Literal["normal", "happy", "sad", "tired", "excited", "calm"]
    ] = None
    tags: list[str] = []
    pinned: bool = False
    archived_at: Optional[str] = None
    archive_file_path: Optional[str] = None
    folder_id: Optional[str] = Field(default=None, max_length=36)
    trashed_at: Optional[str] = None
    migrated_to_note_id: Optional[str] = Field(default=None, max_length=36)
    session_id: Optional[str] = None

    @field_validator("tags", mode="before")
    @classmethod
    def parse_tags(cls, v: object) -> list[str]:
        """Parse JSON string to list when loading from ORM."""
        if isinstance(v, str):
            return json.loads(v) if v else []
        return v  # type: ignore[return-value]


class QuickNoteCreate(QuickNoteBase):
    """Schema for creating a new quick note."""

    id: Optional[str] = None


class QuickNoteUpdate(BaseModel):
    """Schema for updating an existing quick note."""

    content: Optional[str] = Field(default=None, max_length=50000)
    mood: Optional[
        Literal["normal", "happy", "sad", "tired", "excited", "calm"]
    ] = None
    tags: Optional[list[str]] = None
    pinned: Optional[bool] = None
    archived_at: Optional[str] = None
    folder_id: Optional[str] = Field(default=None, max_length=36)
    trashed_at: Optional[str] = None
    migrated_to_note_id: Optional[str] = Field(default=None, max_length=36)
    session_id: Optional[str] = None

    @field_validator("tags", mode="before")
    @classmethod
    def parse_tags(cls, v: object) -> object:
        """Parse JSON string to list when arriving from sync push."""
        if isinstance(v, str):
            return json.loads(v) if v else []
        return v


class QuickNoteResponse(QuickNoteBase):
    """Schema for quick note API responses."""

    id: str
    created_at: str
    updated_at: str
    version: int = 1

    model_config = {"from_attributes": True}
