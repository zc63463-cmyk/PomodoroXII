"""Create the isolated meta database schema.

Revision ID: meta_001
Revises:
"""

import sqlalchemy as sa
from alembic import op

revision = "meta_001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "spaces",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("db_path", sa.String(length=500), nullable=False),
        sa.Column("notes_dir", sa.String(length=500), nullable=False),
        sa.Column("is_default", sa.Boolean(), server_default=sa.text("0"), nullable=False),
        sa.Column("created_at", sa.String(length=32), nullable=False),
        sa.Column("updated_at", sa.String(length=32), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_spaces")),
    )
    op.create_table(
        "meta_settings",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("key", sa.String(length=100), nullable=False),
        sa.Column("value", sa.String(length=2000), nullable=True),
        sa.Column("created_at", sa.String(length=32), nullable=False),
        sa.Column("updated_at", sa.String(length=32), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_meta_settings")),
        sa.UniqueConstraint("key", name=op.f("uq_meta_settings_key")),
    )


def downgrade() -> None:
    op.drop_table("meta_settings")
    op.drop_table("spaces")
