"""Add the missing sessions.mood check constraint.

Revision ID: space_007_session_mood_check
Revises: space_006_sync_timestamp_normalize
Create Date: 2026-07-11
"""

from alembic import op

revision = "space_007_session_mood_check"
down_revision = "space_006_sync_timestamp_normalize"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("sessions") as batch_op:
        batch_op.create_check_constraint(
            "check_session_mood",
            "mood IN ('great','good','normal','bad','terrible') OR mood IS NULL",
        )


def downgrade() -> None:
    with op.batch_alter_table("sessions") as batch_op:
        batch_op.drop_constraint("check_session_mood", type_="check")
