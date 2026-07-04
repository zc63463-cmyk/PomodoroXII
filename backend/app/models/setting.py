"""SQLAlchemy model for application settings."""

from app.services.time import utc_now_iso

from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Setting(Base):
    """Setting model for key-value configuration storage.

    Note: this model intentionally does NOT inherit ``SyncMixin``. Settings
    are keyed by a natural string key (not a UUID), and only ``updated_at``
    is tracked (no ``version`` column is needed for key-value config rows).
    """

    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String, primary_key=True)
    value: Mapped[str] = mapped_column(String)
    updated_at: Mapped[str] = mapped_column(
        String, default=utc_now_iso
    )
