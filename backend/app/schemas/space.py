"""Pydantic response schemas for meta-level Space routes."""

from pydantic import BaseModel


class SpaceResponse(BaseModel):
    """Public metadata for one registered space."""

    id: str
    name: str
    db_path: str
    notes_dir: str
    is_default: bool
    created_at: str
    updated_at: str


class SpaceTokenResponse(BaseModel):
    """Space-scoped bearer token response."""

    space_token: str
    token_type: str
