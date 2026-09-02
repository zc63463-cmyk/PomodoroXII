"""SQLAlchemy model for notes (lightweight knowledge base with category/search)."""

from sqlalchemy import CheckConstraint, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.mixins import SyncMixin


class Note(Base, SyncMixin):
    """Note model — authoritative row of the only FS_DB_SPLIT entity.

    ``note`` is the one entity registered with ``StorageType.FS_DB_SPLIT``
    (see ``app/registry/builtin.py``). This table is the **authority**: it holds
    metadata plus a ``content_hash`` and a ``word_count``, and deliberately has
    **no** ``content`` column — the Markdown body lives in ``notes/**/*.md``
    under the space's notes directory.

    Two projections are derived from this row and must never be treated as
    authoritative:

    * ``notes/**/*.md`` — the body, with self-describing YAML frontmatter.
    * ``index.db`` — the ``notes`` index row and the ``notes_fts`` FTS5 index.

    Search runs against ``notes_fts`` (FTS5 with ``tokenize='trigram'``, so
    Chinese substrings of three or more characters match); SQL LIKE is only a
    fallback for shorter queries.

    Sync events for this entity still carry the body: it is attached after
    compilation by ``_bind_authoritative_note_event_bodies``, so the absence of
    a ``content`` column here does not starve incremental pull.
    """

    __tablename__ = "notes"

    title: Mapped[str] = mapped_column(String(500), default="")
    content_hash: Mapped[str] = mapped_column(String(64), default="")
    word_count: Mapped[int] = mapped_column(Integer, default=0)
    summary: Mapped[str] = mapped_column(String(500), default="")
    tags: Mapped[str] = mapped_column(String(4000), default="[]")
    category: Mapped[str | None] = mapped_column(
        String(200), nullable=True, index=True
    )
    folder_id: Mapped[str | None] = mapped_column(
        String(36), nullable=True, index=True
    )
    status: Mapped[str] = mapped_column(
        String(20), default="active", index=True
    )  # active | archived
    trashed_at: Mapped[str | None] = mapped_column(
        String(32), nullable=True, index=True
    )

    __table_args__ = (
        CheckConstraint(
            "status IN ('active', 'archived')",
            name="check_note_status",
        ),
    )
