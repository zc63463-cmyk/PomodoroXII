"""Metadata providers for the independent Meta and Space schemas."""

from __future__ import annotations

from sqlalchemy import MetaData

from app.db.base import MetaBase, SpaceBase


def get_meta_metadata() -> MetaData:
    from app.db.models import meta  # noqa: F401

    return MetaBase.metadata


def get_space_metadata() -> MetaData:
    import app.models  # noqa: F401

    return SpaceBase.metadata
