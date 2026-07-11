"""Alembic environment for the meta database only."""

import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy import inspect, pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config

from app.db.metadata import get_meta_metadata

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = get_meta_metadata()
META_TABLES = frozenset(target_metadata.tables)
SPACE_MARKER_TABLES = {"tasks", "notes", "sessions", "folders"}


def _assert_safe_schema(connection: Connection) -> None:
    tables = set(inspect(connection).get_table_names())
    version_table = config.get_main_option("version_table")
    if version_table in tables:
        return
    if "alembic_version" in tables or tables & SPACE_MARKER_TABLES:
        raise RuntimeError(
            "legacy or mixed database detected; explicit dual-chain adoption is required"
        )
    unexpected = tables - META_TABLES
    if unexpected:
        raise RuntimeError(
            "legacy or mixed database detected; explicit dual-chain adoption is required"
        )
    if tables == META_TABLES and config.attributes.get("allow_legacy_adoption"):
        return
    if tables & META_TABLES:
        raise RuntimeError(
            "legacy meta schema detected; explicit dual-chain adoption is required"
        )


def _include_object(object_, name, type_, reflected, compare_to):
    return type_ != "table" or name in META_TABLES


def do_run_migrations(connection: Connection) -> None:
    _assert_safe_schema(connection)
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        render_as_batch=True,
        include_object=_include_object,
        version_table=config.get_main_option("version_table"),
    )
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


def run_migrations_online() -> None:
    connection = config.attributes.get("connection")
    if connection is None:
        asyncio.run(run_async_migrations())
    else:
        do_run_migrations(connection)


run_migrations_online()
