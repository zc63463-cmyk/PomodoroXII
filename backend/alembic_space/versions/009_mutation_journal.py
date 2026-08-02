"""Add the durable mutation journal and ledger visibility columns."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import context, op

from app.mutation.types import MUTATION_STATES, STEP_STATES

revision = "space_009_mutation_journal"
down_revision = "space_008_sync_retention_snapshot"
branch_labels = None
depends_on = None

_MUTATION_STATE_SQL = ",".join(repr(value) for value in MUTATION_STATES)
_STEP_STATE_SQL = ",".join(repr(value) for value in STEP_STATES)


def upgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    existing_tables = set(inspector.get_table_names())
    expected_tables = {
        "mutation_batches",
        "mutation_operations",
        "mutation_steps",
    }
    expected_outbox_columns = {"operation_id", "batch_id", "version", "visible"}
    outbox_columns = {column["name"] for column in inspector.get_columns("sync_outbox")}
    outbox_checks = {
        constraint["name"] for constraint in inspector.get_check_constraints("sync_outbox")
    }
    sync_state_checks = {
        constraint["name"] for constraint in inspector.get_check_constraints("sync_state")
    }
    index_names = {
        index["name"]
        for table_name in (*expected_tables, "sync_outbox")
        if table_name in existing_tables
        for index in inspector.get_indexes(table_name)
    }
    expected_indexes = {
        "ix_mutation_batches_state",
        "ix_mutation_operations_batch_id",
        "ix_mutation_operations_state",
        "ix_mutation_steps_operation_id",
        "ix_sync_outbox_operation_id",
        "ix_sync_outbox_batch_id",
        "ix_sync_outbox_visible",
    }
    expected_checks = {
        "ck_sync_outbox_version_nonnegative",
        "ck_sync_state_floor_cursor",
    }
    footprint_present = bool(
        existing_tables & expected_tables
        or outbox_columns & expected_outbox_columns
        or outbox_checks & expected_checks
        or sync_state_checks & expected_checks
        or index_names & expected_indexes
    )
    legacy_adoption = bool(context.get_context().config.attributes.get("allow_legacy_adoption"))
    complete_legacy_footprint = (
        expected_tables <= existing_tables
        and expected_outbox_columns <= outbox_columns
        and "ck_sync_outbox_version_nonnegative" in outbox_checks
        and "ck_sync_state_floor_cursor" in sync_state_checks
        and expected_indexes <= index_names
    )
    if legacy_adoption:
        if not complete_legacy_footprint:
            raise RuntimeError("legacy schema has incomplete mutation journal footprint")
    elif footprint_present:
        raise RuntimeError("managed schema has unexpected mutation journal footprint")
    invalid = connection.execute(
        sa.text(
            "SELECT id, retention_floor, current_cursor FROM sync_state "
            "WHERE retention_floor < 0 OR current_cursor < 0 "
            "OR retention_floor > current_cursor LIMIT 1"
        )
    ).first()
    if invalid is not None:
        raise RuntimeError("legacy sync_state violates floor/cursor invariant")

    if not legacy_adoption:
        op.create_table(
            "mutation_batches",
            sa.Column("batch_id", sa.String(128), primary_key=True),
            sa.Column("command_hash", sa.String(64), nullable=False),
            sa.Column("state", sa.String(24), nullable=False),
            sa.Column("accepted_count", sa.Integer, nullable=False, server_default=sa.text("0")),
            sa.Column("result_json", sa.Text, nullable=True),
            sa.Column("created_at", sa.String(32), nullable=False),
            sa.Column("updated_at", sa.String(32), nullable=False),
            sa.CheckConstraint(
                f"state IN ({_MUTATION_STATE_SQL})",
                name=op.f("ck_mutation_batches_state"),
            ),
            sa.CheckConstraint(
                "accepted_count >= 0",
                name=op.f("ck_mutation_batches_accepted_count_nonnegative"),
            ),
        )
        op.create_index(op.f("ix_mutation_batches_state"), "mutation_batches", ["state"])
        op.create_table(
            "mutation_operations",
            sa.Column("operation_id", sa.String(128), primary_key=True),
            sa.Column("batch_id", sa.String(128), nullable=False),
            sa.Column("sequence", sa.Integer, nullable=False),
            sa.Column("command_hash", sa.String(64), nullable=False),
            sa.Column("command_json", sa.Text, nullable=False),
            sa.Column("expected_versions_json", sa.Text, nullable=False),
            sa.Column("projection_set_json", sa.Text, nullable=False),
            sa.Column("db_before_json", sa.Text, nullable=True),
            sa.Column("db_after_json", sa.Text, nullable=True),
            sa.Column("manifest_sha256", sa.String(64), nullable=True),
            sa.Column("state", sa.String(24), nullable=False),
            sa.Column("result_json", sa.Text, nullable=True),
            sa.Column("error_code", sa.String(64), nullable=True),
            sa.Column("created_at", sa.String(32), nullable=False),
            sa.Column("updated_at", sa.String(32), nullable=False),
            sa.ForeignKeyConstraint(["batch_id"], ["mutation_batches.batch_id"]),
            sa.UniqueConstraint(
                "batch_id",
                "sequence",
                name=op.f("uq_mutation_operation_sequence"),
            ),
            sa.CheckConstraint(
                f"state IN ({_MUTATION_STATE_SQL})",
                name=op.f("ck_mutation_operations_state"),
            ),
            sa.CheckConstraint(
                "sequence >= 0",
                name=op.f("ck_mutation_operations_sequence_nonnegative"),
            ),
        )
        op.create_index(
            op.f("ix_mutation_operations_batch_id"),
            "mutation_operations",
            ["batch_id"],
        )
        op.create_index(
            op.f("ix_mutation_operations_state"),
            "mutation_operations",
            ["state"],
        )
        op.create_table(
            "mutation_steps",
            sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
            sa.Column("operation_id", sa.String(128), nullable=False),
            sa.Column("ordinal", sa.Integer, nullable=False),
            sa.Column("name", sa.String(64), nullable=False),
            sa.Column("store", sa.String(32), nullable=False),
            sa.Column("target", sa.String(1000), nullable=False),
            sa.Column("before_hash", sa.String(64), nullable=True),
            sa.Column("after_hash", sa.String(64), nullable=True),
            sa.Column("applied_hash", sa.String(64), nullable=True),
            sa.Column("state", sa.String(16), nullable=False),
            sa.ForeignKeyConstraint(["operation_id"], ["mutation_operations.operation_id"]),
            sa.UniqueConstraint("operation_id", "ordinal", name=op.f("uq_mutation_step_ordinal")),
            sa.CheckConstraint(
                f"state IN ({_STEP_STATE_SQL})",
                name=op.f("ck_mutation_steps_state"),
            ),
            sa.CheckConstraint(
                "ordinal >= 0",
                name=op.f("ck_mutation_steps_ordinal_nonnegative"),
            ),
        )
        op.create_index(
            op.f("ix_mutation_steps_operation_id"),
            "mutation_steps",
            ["operation_id"],
        )

        with op.batch_alter_table("sync_outbox") as batch:
            batch.add_column(sa.Column("operation_id", sa.String(128), nullable=True))
            batch.add_column(sa.Column("batch_id", sa.String(128), nullable=True))
            batch.add_column(sa.Column("version", sa.Integer, nullable=True))
            batch.add_column(
                sa.Column(
                    "visible",
                    sa.Boolean,
                    nullable=False,
                    server_default=sa.text("0"),
                )
            )
            batch.create_check_constraint(
                batch.f("ck_sync_outbox_version_nonnegative"),
                "version IS NULL OR version >= 0",
            )
        op.create_index(op.f("ix_sync_outbox_operation_id"), "sync_outbox", ["operation_id"])
        op.create_index(op.f("ix_sync_outbox_batch_id"), "sync_outbox", ["batch_id"])
        op.create_index(op.f("ix_sync_outbox_visible"), "sync_outbox", ["visible"])
    connection.execute(sa.text("UPDATE sync_outbox SET visible=1 WHERE visible=0"))

    if not legacy_adoption:
        with op.batch_alter_table("sync_state") as batch:
            batch.create_check_constraint(
                batch.f("ck_sync_state_floor_cursor"),
                "retention_floor >= 0 AND current_cursor >= retention_floor",
            )


def downgrade() -> None:
    with op.batch_alter_table("sync_state") as batch:
        batch.drop_constraint("floor_cursor", type_="check")
    op.drop_index("ix_sync_outbox_visible", table_name="sync_outbox")
    op.drop_index("ix_sync_outbox_batch_id", table_name="sync_outbox")
    op.drop_index("ix_sync_outbox_operation_id", table_name="sync_outbox")
    with op.batch_alter_table("sync_outbox") as batch:
        batch.drop_constraint("version_nonnegative", type_="check")
        batch.drop_column("visible")
        batch.drop_column("version")
        batch.drop_column("batch_id")
        batch.drop_column("operation_id")
    op.drop_index("ix_mutation_steps_operation_id", table_name="mutation_steps")
    op.drop_index("ix_mutation_operations_state", table_name="mutation_operations")
    op.drop_index("ix_mutation_operations_batch_id", table_name="mutation_operations")
    op.drop_index("ix_mutation_batches_state", table_name="mutation_batches")
    op.drop_table("mutation_steps")
    op.drop_table("mutation_operations")
    op.drop_table("mutation_batches")
