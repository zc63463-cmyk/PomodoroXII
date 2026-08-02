"""Add execution_persona, persona_switched, persona_note to session_work_item_outcomes."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "space_011_outcome_persona_fields"
down_revision = "space_010_task_space_focus_session"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("session_work_item_outcomes") as batch_op:
        batch_op.add_column(sa.Column("execution_persona", sa.String(32), nullable=True))
        batch_op.add_column(sa.Column("persona_switched", sa.Boolean, nullable=True))
        batch_op.add_column(sa.Column("persona_note", sa.String(500), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("session_work_item_outcomes") as batch_op:
        batch_op.drop_column("persona_note")
        batch_op.drop_column("persona_switched")
        batch_op.drop_column("execution_persona")
