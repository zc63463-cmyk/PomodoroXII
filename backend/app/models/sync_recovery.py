"""Durable full-recovery manifests and bounded compressed chunks."""

from sqlalchemy import CheckConstraint, ForeignKey, Integer, LargeBinary, String
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql.elements import conv

from app.db.base import Base


class SyncRecoveryManifest(Base):
    """Immutable metadata for one client recovery generation."""

    __tablename__ = "sync_recovery_manifests"
    __table_args__ = (
        CheckConstraint(
            "generation >= 0",
            name=conv("ck_sync_manifest_generation_nonnegative"),
        ),
        CheckConstraint(
            "waterline >= 0",
            name=conv("ck_sync_manifest_waterline_nonnegative"),
        ),
        CheckConstraint(
            "total_entities >= 0",
            name=conv("ck_sync_manifest_entities_nonnegative"),
        ),
        CheckConstraint(
            "total_chunks >= 0",
            name=conv("ck_sync_manifest_chunks_nonnegative"),
        ),
        CheckConstraint(
            "total_uncompressed_bytes >= 0",
            name=conv("ck_sync_manifest_bytes_nonnegative"),
        ),
    )

    token: Mapped[str] = mapped_column(String(64), primary_key=True)
    space_id: Mapped[str] = mapped_column(String(64), nullable=False)
    client_id: Mapped[str] = mapped_column(String(64), nullable=False)
    generation: Mapped[int] = mapped_column(Integer, nullable=False)
    catalog_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    waterline: Mapped[int] = mapped_column(Integer, nullable=False)
    total_entities: Mapped[int] = mapped_column(Integer, nullable=False)
    total_chunks: Mapped[int] = mapped_column(Integer, nullable=False)
    total_uncompressed_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[str] = mapped_column(String(32), nullable=False)
    expires_at: Mapped[str] = mapped_column(String(32), nullable=False)
    manifest_sha256: Mapped[str] = mapped_column(String(64), nullable=False)


class SyncRecoveryChunk(Base):
    """One bounded gzip payload belonging to a recovery manifest."""

    __tablename__ = "sync_recovery_chunks"
    __table_args__ = (
        CheckConstraint(
            "chunk_index >= 0",
            name=conv("ck_sync_chunk_index_nonnegative"),
        ),
        CheckConstraint(
            "entity_count BETWEEN 1 AND 500",
            name=conv("ck_sync_chunk_entities"),
        ),
        CheckConstraint(
            "uncompressed_bytes BETWEEN 1 AND 8388608",
            name=conv("ck_sync_chunk_bytes"),
        ),
    )

    manifest_token: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("sync_recovery_manifests.token", ondelete="CASCADE"),
        primary_key=True,
        nullable=False,
    )
    chunk_index: Mapped[int] = mapped_column(Integer, primary_key=True)
    entity_count: Mapped[int] = mapped_column(Integer, nullable=False)
    uncompressed_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    payload_gzip: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    payload_sha256: Mapped[str] = mapped_column(String(64), nullable=False)


__all__ = ["SyncRecoveryChunk", "SyncRecoveryManifest"]
