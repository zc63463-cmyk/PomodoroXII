"""Alembic environment for per-space databases only."""

from logging.config import fileConfig

from alembic import context
from sqlalchemy import inspect
from sqlalchemy.engine import Connection

from app.db.metadata import get_space_metadata

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = get_space_metadata()
SPACE_TABLES = frozenset(target_metadata.tables)
META_TABLES = {"meta_settings", "spaces"}


def _assert_safe_schema(connection: Connection) -> None:
    tables = set(inspect(connection).get_table_names())
    version_table = config.get_main_option("version_table")
    if version_table in tables:
        return
    if "alembic_version" in tables or tables & META_TABLES:
        raise RuntimeError(
            "legacy or mixed database detected; explicit dual-chain adoption is required"
        )
    if tables == SPACE_TABLES and config.attributes.get("allow_legacy_adoption"):
        return
    if tables & SPACE_TABLES:
        raise RuntimeError(
            "legacy space schema detected; explicit dual-chain adoption is required"
        )
    if tables - SPACE_TABLES:
        raise RuntimeError(
            "legacy or mixed database detected; explicit dual-chain adoption is required"
        )


def _include_object(object_, name, type_, reflected, compare_to):
    return type_ != "table" or name in SPACE_TABLES


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


def run_migrations_online() -> None:
    adapter = config.attributes.get("maintenance_adapter")
    if adapter is None:
        raise RuntimeError("Alembic requires an authority-bound maintenance adapter")
    adapter.run(do_run_migrations)


run_migrations_online()
