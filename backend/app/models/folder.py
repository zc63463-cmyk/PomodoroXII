"""SQLAlchemy model for folders (self-referencing virtual file system hierarchy).

Folders organize Notes and QuickNotes into a tree structure. Each folder
references an optional parent_id (None = root-level). A UniqueConstraint
on (parent_id, name) prevents duplicate folder names within the same
parent directory.

Soft delete is implemented via trashed_at — when set, the folder is in
the recycle bin and excluded from normal listings. The TRASH_TTL_DAYS
constant in routes/trash.py controls automatic cleanup (independent of
the sync tombstone TTL).
"""

from sqlalchemy import Boolean, String, Integer, UniqueConstraint, Index, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.mixins import SyncMixin


class Folder(Base, SyncMixin):
    """Folder model for the virtual file system.

    Self-referencing parent_id supports unlimited nesting depth. The
    UniqueConstraint("parent_id", "name") enforces no duplicate names
    within the same directory — mirroring real filesystem semantics.

    Note: SQLite treats NULL as distinct, so the UniqueConstraint alone
    does not catch duplicate root-level folders (parent_id IS NULL).
    The partial index ``uq_folder_root_name`` fills this gap.
    """

    __tablename__ = "folders"

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    parent_id: Mapped[str | None] = mapped_column(
        String(36), nullable=True, index=True
    )
    icon: Mapped[str | None] = mapped_column(
        String(50), nullable=True, default="📁"
    )
    color: Mapped[str | None] = mapped_column(String(20), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    is_system: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False, server_default=text("0")
    )
    trashed_at: Mapped[str | None] = mapped_column(
        String(32), nullable=True, index=True
    )

    __table_args__ = (
        UniqueConstraint("parent_id", "name", name="uq_folder_parent_name"),
        # Partial unique index for root-level folders (parent_id IS NULL).
        # SQLite treats NULL as distinct, so UniqueConstraint doesn't catch
        # duplicates when parent_id is NULL. This partial index fills the gap.
        Index(
            "uq_folder_root_name",
            "name",
            unique=True,
            sqlite_where=text("parent_id IS NULL"),
        ),
    )
