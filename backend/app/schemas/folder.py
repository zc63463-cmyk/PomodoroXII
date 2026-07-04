"""Pydantic schemas for folders (virtual file system hierarchy).

``FolderCreate`` is intentionally minimal (name + parent_id); ``FolderResponse``
exposes every persisted column so the client can render the full tree. The
unique constraint on (parent_id, name) is enforced at the DB layer; Pydantic
only validates field types/lengths here.
"""

from typing import Optional

from pydantic import BaseModel, Field


class FolderCreate(BaseModel):
    """Schema for creating a new folder."""

    name: str = Field(..., max_length=200)
    parent_id: Optional[str] = Field(default=None, max_length=36)
    id: Optional[str] = Field(default=None, max_length=36)


class FolderUpdate(BaseModel):
    """Schema for updating an existing folder — all fields optional."""

    name: Optional[str] = Field(default=None, max_length=200)
    parent_id: Optional[str] = Field(default=None, max_length=36)


class FolderResponse(BaseModel):
    """Schema for folder API responses — exposes all persisted columns."""

    id: str
    name: str
    parent_id: Optional[str] = None
    icon: Optional[str] = None
    color: Optional[str] = None
    sort_order: int = 0
    is_system: bool = False
    trashed_at: Optional[str] = None
    created_at: str
    updated_at: str
    version: int = 1

    model_config = {"from_attributes": True}
