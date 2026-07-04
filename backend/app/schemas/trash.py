"""Pydantic schemas for recycle-bin (trash) items."""

from pydantic import BaseModel


class TrashItemResponse(BaseModel):
    """A single entry in the recycle bin.

    Aggregated view across entity types (notes, quick notes, folders, ...).
    ``entity_type`` identifies the source table; ``entity_id`` is its PK;
    ``title`` is a display label; ``deleted_at`` is the soft-delete timestamp
    (the entity's ``trashed_at`` value).
    """

    entity_type: str
    entity_id: str
    title: str
    deleted_at: str

    model_config = {"from_attributes": True}
