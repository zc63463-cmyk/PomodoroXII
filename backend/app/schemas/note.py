"""Pydantic schemas for notes.

Key design difference from the source project (06 deficiency #7): the note
*body* lives on the filesystem (a ``.md`` file), so only ``content_hash`` +
``word_count`` are persisted on the DB row. ``NoteCreate`` and ``NoteUpdate``
both accept ``content`` (so the route can write the ``.md`` file), but
``NoteResponse`` deliberately excludes ``content`` — clients reconcile edits
via ``content_hash`` instead of round-tripping the full body.
"""

import json
from typing import Optional

from pydantic import BaseModel, Field, field_validator


class NoteBase(BaseModel):
    """Base fields shared by note schemas (excludes filesystem content)."""

    title: str = Field(default="", max_length=500)
    summary: str = Field(default="", max_length=500)
    tags: list[str] = []
    folder_id: Optional[str] = Field(default=None, max_length=36)
    status: str = Field(default="active", max_length=20)

    @field_validator("tags", mode="before")
    @classmethod
    def parse_tags(cls, v: object) -> list[str]:
        """Parse JSON string to list when loading from ORM."""
        if isinstance(v, str):
            return json.loads(v) if v else []
        return v  # type: ignore[return-value]


class NoteCreate(NoteBase):
    """Schema for creating a new note.

    ``content`` is accepted here so the route can write the body to a ``.md``
    file; it is NOT persisted on the DB row (only content_hash + word_count).
    """

    content: str = Field(default="", max_length=100000)
    id: Optional[str] = Field(default=None, max_length=36)


class NoteUpdate(BaseModel):
    """Schema for updating an existing note.

    ``content`` is accepted so the route can dispatch it to
    ``NoteService.update_content()`` which rewrites the ``.md`` file.
    Metadata fields are persisted on the DB row only.
    """

    title: Optional[str] = Field(default=None, max_length=500)
    content: Optional[str] = Field(default=None, max_length=100000)
    content_hash: Optional[str] = Field(default=None, max_length=64)
    summary: Optional[str] = Field(default=None, max_length=500)
    tags: Optional[list[str]] = None
    folder_id: Optional[str] = Field(default=None, max_length=36)

    @field_validator("tags", mode="before")
    @classmethod
    def parse_tags(cls, v: object) -> object:
        """Parse JSON string to list when arriving from sync push."""
        if isinstance(v, str):
            return json.loads(v) if v else []
        return v


class NoteResponse(NoteBase):
    """Schema for note API responses.

    Excludes ``content`` (lives on the filesystem); exposes ``content_hash``
    and ``word_count`` for integrity checks and display metrics.
    """

    id: str
    content_hash: str = ""
    word_count: int = 0
    trashed_at: Optional[str] = None
    created_at: str
    updated_at: str
    version: int = 1

    model_config = {"from_attributes": True}


class NoteSearchResultItem(BaseModel):
    """Schema for note search results.

    Field-aligned with ``app.file_system.interfaces.SearchResult``.
    """

    note_id: str
    title: str
    folder_id: Optional[str] = None
    excerpt: str = ""
    score: float = 0.0
