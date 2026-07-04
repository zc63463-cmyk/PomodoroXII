"""Pydantic schemas for reflections."""

import json
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator


class ReflectionBase(BaseModel):
    """Base fields shared by reflection schemas.

    Several fields (``related_task_ids``, ``tags``, ``sections``,
    ``auto_linked_session_ids``) are JSON-serialised strings in SQLite; the
    validators below reverse that when loading from the ORM.
    """

    date: str = Field(..., max_length=10)
    content: str = Field(default="", max_length=50000)
    mood: Optional[Literal["great", "good", "normal", "bad", "terrible"]] = None
    related_task_ids: list[str] = []
    tags: list[str] = []
    # Phase 2 extensions: structured reflection + auto-linking
    sections: list[dict] = []
    is_structured: bool = False
    auto_linked_session_ids: list[str] = []

    @field_validator("related_task_ids", "tags", mode="before")
    @classmethod
    def parse_json_list(cls, v: object) -> list[str]:
        """Parse JSON string to list when loading from ORM."""
        if isinstance(v, str):
            return json.loads(v) if v else []
        return v  # type: ignore[return-value]

    @field_validator("sections", "auto_linked_session_ids", mode="before")
    @classmethod
    def parse_json_array_field(cls, v: object) -> list:
        """Parse JSON string to list when loading from ORM."""
        if isinstance(v, str):
            return json.loads(v) if v else []
        return v  # type: ignore[return-value]


class ReflectionCreate(ReflectionBase):
    """Schema for creating a new reflection."""

    id: Optional[str] = None


class ReflectionUpdate(BaseModel):
    """Schema for updating an existing reflection."""

    date: Optional[str] = Field(default=None, max_length=10)
    content: Optional[str] = Field(default=None, max_length=50000)
    mood: Optional[Literal["great", "good", "normal", "bad", "terrible"]] = None
    related_task_ids: Optional[list[str]] = None
    tags: Optional[list[str]] = None
    sections: Optional[list[dict]] = None
    is_structured: Optional[bool] = None
    auto_linked_session_ids: Optional[list[str]] = None


class ReflectionResponse(ReflectionBase):
    """Schema for reflection API responses."""

    id: str
    created_at: str
    updated_at: str
    version: int = 1

    model_config = {"from_attributes": True}
