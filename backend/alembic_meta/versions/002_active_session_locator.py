"""Create the ActiveSession coordination schema.

Adds two application-wide singleton tables to the meta database:

- ``active_session_locator``: exactly one row (``singleton_key = 'active'``)
  that owns the currently active focus session.  Mutated through CAS on
  ``ownership_epoch``; the row is never deleted.
- ``active_session_operations``: internal journal of every coordination
  operation (start, heartbeat, pause, resume, end, takeover, …).

Revision ID: meta_002_active_session_locator
Revises: meta_001
"""

import sqlalchemy as sa
from alembic import op

revision = "meta_002_active_session_locator"
down_revision = "meta_001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "active_session_locator",
        sa.Column(
            "singleton_key",
            sa.String(length=16),
            server_default=sa.text("'active'"),
            nullable=False,
        ),
        sa.Column("space_id", sa.String(length=36), nullable=False),
        sa.Column("session_id", sa.String(length=36), nullable=False),
        sa.Column("operation_id", sa.String(length=128), nullable=False),
        sa.Column("state", sa.String(length=20), nullable=False),
        sa.Column("owner_device_id", sa.String(length=64), nullable=False),
        sa.Column("owner_tab_id", sa.String(length=64), nullable=False),
        sa.Column("ownership_epoch", sa.Integer(), nullable=False),
        sa.Column("lease_expires_at", sa.String(length=32), nullable=False),
        sa.Column("updated_at", sa.String(length=32), nullable=False),
        sa.PrimaryKeyConstraint(
            "singleton_key", name=op.f("pk_active_session_locator")
        ),
        sa.CheckConstraint(
            "singleton_key = 'active'", name="single_active_slot"
        ),
        sa.CheckConstraint(
            "state IN ('claiming','active','releasing')", name="state"
        ),
        sa.CheckConstraint(
            "ownership_epoch > 0", name="ownership_epoch_positive"
        ),
    )
    op.create_index(
        "ix_active_session_locator_space_id",
        "active_session_locator",
        ["space_id"],
    )
    op.create_index(
        "ix_active_session_locator_session_id",
        "active_session_locator",
        ["session_id"],
    )
    op.create_index(
        "ix_active_session_locator_operation_id",
        "active_session_locator",
        ["operation_id"],
    )
    op.create_index(
        "ix_active_session_locator_lease_expires_at",
        "active_session_locator",
        ["lease_expires_at"],
    )

    op.create_table(
        "active_session_operations",
        sa.Column("operation_id", sa.String(length=128), nullable=False),
        sa.Column("kind", sa.String(length=40), nullable=False),
        sa.Column("payload_hash", sa.String(length=64), nullable=False),
        sa.Column("intent_json", sa.Text(), nullable=False),
        sa.Column("phase", sa.String(length=32), nullable=False),
        sa.Column("result_descriptor_json", sa.Text(), nullable=True),
        sa.Column("related_operation_id", sa.String(length=128), nullable=True),
        sa.Column("created_at", sa.String(length=32), nullable=False),
        sa.Column("updated_at", sa.String(length=32), nullable=False),
        sa.PrimaryKeyConstraint(
            "operation_id", name=op.f("pk_active_session_operations")
        ),
        sa.CheckConstraint(
            "kind IN ('start','heartbeat','pause','resume','end','takeover',"
            "'update_note','set_current_plan_item','set_completion_draft',"
            "'add_plan_item','remove_plan_item','activate_provisional',"
            "'resolve_activation_conflict')",
            name="active_session_operation_kind",
        ),
        sa.CheckConstraint(
            "phase IN ('prepared','claimed','space_committed',"
            "'awaiting_resolution','transferred','completed','rejected',"
            "'manual_intervention')",
            name="active_session_operation_phase",
        ),
        sa.CheckConstraint(
            "payload_hash NOT GLOB '*[^0-9a-f]*' AND length(payload_hash) = 64",
            name="active_session_operation_hash",
        ),
        sa.CheckConstraint(
            "result_descriptor_json IS NULL OR "
            "length(CAST(result_descriptor_json AS BLOB)) <= 8192",
            name="active_session_operation_result_descriptor_size",
        ),
    )
    op.create_index(
        "ix_active_session_operations_kind",
        "active_session_operations",
        ["kind"],
    )
    op.create_index(
        "ix_active_session_operations_phase",
        "active_session_operations",
        ["phase"],
    )
    op.create_index(
        "ix_active_session_operations_related_operation_id",
        "active_session_operations",
        ["related_operation_id"],
    )


def downgrade() -> None:
    op.drop_table("active_session_operations")
    op.drop_table("active_session_locator")
