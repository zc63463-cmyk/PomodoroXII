"""Alembic env.py - async + Programmatic API (connection sharing)."""
import asyncio
from logging.config import fileConfig
from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config
from alembic import context
from app.db.base import Base
from app.db.models import meta  # noqa: F401
from app.models import *  # noqa: F401, F403

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)
target_metadata = Base.metadata


def include_object(object, name, type_, reflected, compare_to):
    """Filter tables by migration target.

    Meta DB migration (target='meta') only includes ``spaces`` and
    ``meta_settings``; Space DB migration (target='space', default)
    excludes those two meta tables.
    """
    target = config.attributes.get("target", "space")
    if target == "meta":
        return name in ("spaces", "meta_settings")
    return name not in ("spaces", "meta_settings")


def do_run_migrations(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        render_as_batch=True,
        include_object=include_object,
    )
    with context.begin_transaction():
        context.run_migrations()

async def run_async_migrations() -> None:
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section), prefix="sqlalchemy.", poolclass=pool.NullPool)
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()

def run_migrations_online() -> None:
    connectable = config.attributes.get("connection", None)
    if connectable is None:
        asyncio.run(run_async_migrations())
    else:
        do_run_migrations(connectable)

run_migrations_online()
