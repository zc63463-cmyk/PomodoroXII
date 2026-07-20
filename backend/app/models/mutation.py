"""ORM mappings for the durable mutation journal."""

from sqlalchemy import (
    CheckConstraint,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.mutation.types import MUTATION_STATES, STEP_STATES, MutationState, StepState
from app.services.time import utc_now_iso


class MutationBatch(Base):
    __tablename__ = "mutation_batches"
    __table_args__ = (
        CheckConstraint(
            f"state IN ({','.join(repr(value) for value in MUTATION_STATES)})",
            name="state",
        ),
        CheckConstraint(
            "accepted_count >= 0",
            name="accepted_count_nonnegative",
        ),
        Index("ix_mutation_batches_state", "state"),
    )

    batch_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    command_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    state: Mapped[MutationState] = mapped_column(String(24), nullable=False)
    accepted_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    result_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[str] = mapped_column(String(32), default=utc_now_iso, nullable=False)
    updated_at: Mapped[str] = mapped_column(String(32), default=utc_now_iso, nullable=False)


class MutationOperation(Base):
    __tablename__ = "mutation_operations"
    __table_args__ = (
        UniqueConstraint("batch_id", "sequence", name="uq_mutation_operation_sequence"),
        CheckConstraint(
            f"state IN ({','.join(repr(value) for value in MUTATION_STATES)})",
            name="state",
        ),
        CheckConstraint("sequence >= 0", name="sequence_nonnegative"),
        Index("ix_mutation_operations_batch_id", "batch_id"),
        Index("ix_mutation_operations_state", "state"),
    )

    operation_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    batch_id: Mapped[str] = mapped_column(
        String(128), ForeignKey("mutation_batches.batch_id"), nullable=False
    )
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    command_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    command_json: Mapped[str] = mapped_column(Text, nullable=False)
    expected_versions_json: Mapped[str] = mapped_column(Text, nullable=False)
    projection_set_json: Mapped[str] = mapped_column(Text, nullable=False)
    db_before_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    db_after_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    manifest_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    state: Mapped[MutationState] = mapped_column(String(24), nullable=False)
    result_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[str] = mapped_column(String(32), default=utc_now_iso, nullable=False)
    updated_at: Mapped[str] = mapped_column(String(32), default=utc_now_iso, nullable=False)


class MutationStep(Base):
    __tablename__ = "mutation_steps"
    __table_args__ = (
        UniqueConstraint("operation_id", "ordinal", name="uq_mutation_step_ordinal"),
        CheckConstraint(
            f"state IN ({','.join(repr(value) for value in STEP_STATES)})",
            name="state",
        ),
        CheckConstraint("ordinal >= 0", name="ordinal_nonnegative"),
        Index("ix_mutation_steps_operation_id", "operation_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    operation_id: Mapped[str] = mapped_column(
        String(128), ForeignKey("mutation_operations.operation_id"), nullable=False
    )
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    store: Mapped[str] = mapped_column(String(32), nullable=False)
    target: Mapped[str] = mapped_column(String(1000), nullable=False)
    before_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    after_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    applied_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    state: Mapped[StepState] = mapped_column(String(16), nullable=False)
