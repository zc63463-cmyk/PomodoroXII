"""Declarative base with a consistent naming convention.

A shared ``NAMING_CONVENTION`` makes implicit constraints (indexes,
unique constraints, foreign keys) deterministic across spaces and
migrations, so Alembic autogenerate diffs stay stable.
"""

from __future__ import annotations

from sqlalchemy import MetaData
from sqlalchemy.orm import DeclarativeBase

NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    """Base class for all ORM models (meta + per-space)."""

    metadata = MetaData(naming_convention=NAMING_CONVENTION)
