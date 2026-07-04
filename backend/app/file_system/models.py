"""Pydantic v2 DTOs for API serialization.

Mirror the SQLAlchemy ORM models in schema.py.
ConfigDict(from_attributes=True) enables construction from ORM instances:
    NoteModel.model_validate(orm_note)

Note: schema.NoteModel (ORM) uses tags=String("[]") (JSON string).
This DTO exposes tags as list[str] with a before-validator that parses JSON.
"""
from __future__ import annotations

import json
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator


class NoteModel(BaseModel):
    """笔记 DTO — 对应 schema.NoteModel ORM。"""
    model_config = ConfigDict(from_attributes=True)

    note_id: str
    title: str = ""
    current_path: str = ""
    content_hash: str = ""
    folder_id: Optional[str] = None
    level: str = "L1"
    status: str = "active"
    tags: list[str] = Field(default_factory=list)
    word_count: int = 0
    is_deleted: bool = False
    created_at: str = ""
    updated_at: str = ""

    @field_validator("tags", mode="before")
    @classmethod
    def _parse_tags(cls, v):
        """Accept list (direct) or JSON string (from ORM)."""
        if isinstance(v, str):
            try:
                return json.loads(v)
            except json.JSONDecodeError:
                return []
        return v


class FolderModel(BaseModel):
    """文件夹 DTO — 对应 schema.FolderModel ORM。"""
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    parent_id: Optional[str] = None
    icon: str = "📁"
    color: Optional[str] = None
    sort_order: int = 0
    is_system: bool = False
    trashed_at: Optional[str] = None
    created_at: str = ""
    updated_at: str = ""
