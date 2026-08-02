"""Reject the retired combined Alembic environment."""

raise RuntimeError(
    "Legacy combined Alembic environment is disabled. "
    "Use `alembic -n alembic:meta upgrade head` for meta.db or "
    "`alembic -n alembic:space upgrade head` for a Space database."
)
