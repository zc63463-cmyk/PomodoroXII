"""Task 1 schema contracts for durable Sync v2 client/recovery state."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from alembic import command
from alembic.script import ScriptDirectory

from tests.migrations import alembic_config, run_bound_command

SPACE_010 = "space_010_task_space_focus_session"
SPACE_011 = "space_011_sync_clients_streaming"


def _upgrade(path: Path, revision: str) -> None:
    run_bound_command("space", path, command.upgrade, revision)


def _fresh_011(path: Path) -> None:
    _upgrade(path, SPACE_011)


def test_space_011_is_strictly_after_final_task_space_schema() -> None:
    revision = ScriptDirectory.from_config(alembic_config("space")).get_revision(SPACE_011)
    assert revision is not None
    assert revision.down_revision == SPACE_010


def test_space_011_adds_only_s4_columns_and_backfills_provable_tombstones(tmp_path: Path) -> None:
    path = tmp_path / "space.db"
    _upgrade(path, SPACE_010)
    with sqlite3.connect(path) as connection:
        outbox_before = tuple(connection.execute("PRAGMA table_info(sync_outbox)"))
        connection.execute(
            "INSERT INTO sync_outbox "
            "(entity_type, entity_id, action, payload, created_at, visible) "
            "VALUES ('note', 'known', 'delete', '{}', 't', 0)"
        )
        connection.execute(
            "INSERT INTO sync_outbox "
            "(entity_type, entity_id, action, payload, created_at, visible) "
            "VALUES ('note', 'known', 'delete', '{}', 't', 1)"
        )
        connection.execute(
            "INSERT INTO tombstones (entity_type, entity_id, deleted_at) "
            "VALUES ('note', 'known', 't')"
        )
        connection.execute(
            "INSERT INTO tombstones (entity_type, entity_id, deleted_at) "
            "VALUES ('note', 'unmatched', 't')"
        )
        connection.commit()

    _upgrade(path, SPACE_011)

    with sqlite3.connect(path) as connection:
        assert tuple(connection.execute("PRAGMA table_info(sync_outbox)")) == outbox_before
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        assert {"sync_clients", "sync_recovery_manifests", "sync_recovery_chunks"} <= tables
        assert connection.execute(
            "SELECT delete_sequence FROM tombstones WHERE entity_id = 'known'"
        ).fetchone() == (2,)
        assert connection.execute(
            "SELECT delete_sequence FROM tombstones WHERE entity_id = 'unmatched'"
        ).fetchone() == (None,)


def test_space_011_numeric_checks_reject_negative_values(tmp_path: Path) -> None:
    path = tmp_path / "space.db"
    _fresh_011(path)
    with sqlite3.connect(path) as connection:
        connection.executescript(
            """
            INSERT INTO sync_clients
                (client_id, catalog_hash, registered_at, last_seen_at, expires_at)
            VALUES ('client', 'c', 't', 't', 't');
            INSERT INTO sync_recovery_manifests
                (token, space_id, client_id, generation, catalog_hash, waterline,
                 total_entities, total_chunks, total_uncompressed_bytes, created_at,
                 expires_at, manifest_sha256)
            VALUES ('manifest', 'space', 'client', 0, 'c', 0, 0, 1, 1, 't', 't', 'm');
            INSERT INTO sync_recovery_chunks
                (manifest_token, chunk_index, entity_count, uncompressed_bytes,
                 payload_gzip, payload_sha256)
            VALUES ('manifest', 0, 1, 1, X'00', 'p');
            INSERT INTO tombstones (entity_type, entity_id, deleted_at)
            VALUES ('note', 'note', 't');
            """
        )

        def reject(statement: str) -> None:
            connection.execute("SAVEPOINT constraint_probe")
            try:
                with pytest.raises(sqlite3.IntegrityError):
                    connection.execute(statement)
            finally:
                connection.execute("ROLLBACK TO constraint_probe")
                connection.execute("RELEASE constraint_probe")

        for statement in (
            "UPDATE sync_clients SET ack_sequence = -1",
            "UPDATE sync_clients SET recovery_generation = -1",
            "UPDATE sync_clients SET recovery_waterline = -1",
            "UPDATE sync_recovery_manifests SET generation = -1",
            "UPDATE sync_recovery_manifests SET waterline = -1",
            "UPDATE sync_recovery_manifests SET total_entities = -1",
            "UPDATE sync_recovery_manifests SET total_chunks = -1",
            "UPDATE sync_recovery_manifests SET total_uncompressed_bytes = -1",
            "UPDATE sync_recovery_chunks SET chunk_index = -1",
            "UPDATE sync_recovery_chunks SET entity_count = -1",
            "UPDATE sync_recovery_chunks SET uncompressed_bytes = -1",
            "UPDATE tombstones SET delete_sequence = -1",
        ):
            reject(statement)


def test_space_011_downgrade_removes_only_s4_schema(tmp_path: Path) -> None:
    path = tmp_path / "space.db"
    _fresh_011(path)
    run_bound_command("space", path, command.downgrade, SPACE_010)
    with sqlite3.connect(path) as connection:
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        assert not {
            "sync_clients",
            "sync_recovery_manifests",
            "sync_recovery_chunks",
        } & tables
        assert "delete_sequence" not in {
            row[1] for row in connection.execute("PRAGMA table_info(tombstones)")
        }
        assert connection.execute(
            "SELECT version_num FROM alembic_version_space"
        ).fetchone() == (SPACE_010,)
