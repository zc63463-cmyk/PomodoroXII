"""Pydantic schemas for memo comments (小记评论)."""

from typing import Optional

from pydantic import BaseModel, Field


class MemoCommentBase(BaseModel):
    """Base fields shared by memo comment schemas."""

    note_id: str = Field(..., max_length=36)
    content: str = Field(default="", max_length=10000)


class MemoCommentCreate(MemoCommentBase):
    """Schema for creating a new memo comment."""

    id: Optional[str] = None


class MemoCommentUpdate(BaseModel):
    """Schema for updating an existing memo comment."""

    note_id: Optional[str] = Field(default=None, max_length=36)
    content: Optional[str] = Field(default=None, max_length=10000)


class MemoCommentResponse(MemoCommentBase):
    """Schema for memo comment API responses."""

    id: str
    created_at: str
    updated_at: str
    version: int = 1

    model_config = {"from_attributes": True}
