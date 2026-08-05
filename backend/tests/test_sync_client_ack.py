"""Task 1 schema contracts for durable Sync v2 client/recovery state."""

from __future__ import annotations

import hmac
import sqlite3
from pathlib import Path

import pytest
from alembic import command
from alembic.script import ScriptDirectory

from tests.migrations import alembic_config, run_bound_command


@pytest.mark.parametrize(
    "mutate",
    [
        lambda token: token[:-1] + ("A" if token[-1] != "A" else "B"),
        lambda token: token + ".extra",
        lambda token: token.replace(".", "", 1),
    ],
)
def test_opaque_cursor_tamper_is_safe_and_does_not_leak_sequence(mutate) -> None:
    from app.errors import SyncCursorExpiredError
    from app.sync.cursor import CursorPosition, SyncCursorCodec

    codec = SyncCursorCodec(b"x" * 32)
    token = codec.encode(CursorPosition(42, "c" * 64, "space-a", "client-a", 0))
    with pytest.raises(SyncCursorExpiredError) as raised:
        codec.decode(mutate(token))
    assert raised.value.code == "cursor_expired"
    assert raised.value.details == {"recovery_action": "full_recovery"}
    assert "42" not in raised.value.detail


def test_opaque_cursor_round_trip_handles_period_in_signature(monkeypatch) -> None:
    from app.sync.cursor import CursorPosition, SyncCursorCodec

    signature = b"." + bytes(range(31))
    monkeypatch.setattr(hmac, "digest", lambda *_args: signature)
    codec = SyncCursorCodec(b"x" * 32)
    position = CursorPosition(9, "c" * 64, "space-a", "client-a", 0)
    token = codec.encode(position)
    assert token.count(".") == 1
    assert codec.decode(token) == position


@pytest.mark.asyncio
async def test_ack_is_monotonic_and_idempotent(space_session) -> None:
    from app.models.sync_client import SyncClient
    from app.models.sync_state import SyncState
    from app.sync.clients import SyncClientRegistry
    from app.sync.cursor import CursorPosition

    state = await space_session.get(SyncState, 1)
    assert state is not None
    state.retention_floor = 0
    state.current_cursor = 10
    space_session.add(
        SyncClient(
            client_id="client-a",
            ack_sequence=5,
            catalog_hash="c" * 64,
            registered_at="2026-08-01T00:00:00.000Z",
            last_seen_at="2026-08-01T00:00:00.000Z",
            expires_at="2099-08-01T00:00:00.000Z",
            requires_recovery=False,
            recovery_generation=0,
        )
    )
    await space_session.flush()
    registry = SyncClientRegistry(space_session, "c" * 64, 30)

    accepted = await registry.acknowledge(
        "client-a", CursorPosition(8, "c" * 64, "space-a", "client-a", 0)
    )
    assert accepted.result is not None and accepted.result.accepted is True
    assert accepted.result.requires_recovery is False

    equal = await registry.acknowledge(
        "client-a", CursorPosition(8, "c" * 64, "space-a", "client-a", 0)
    )
    assert equal.result == accepted.result

    backwards = await registry.acknowledge(
        "client-a", CursorPosition(7, "c" * 64, "space-a", "client-a", 0)
    )
    assert backwards.error is not None
    assert backwards.error.code == "cursor_expired"

    future = await registry.acknowledge(
        "client-a", CursorPosition(11, "c" * 64, "space-a", "client-a", 0)
    )
    assert future.error is not None
    assert future.error.code == "cursor_expired"


@pytest.mark.asyncio
async def test_recovery_ack_requires_current_completed_manifest(space_session) -> None:
    from app.models.sync_client import SyncClient
    from app.models.sync_recovery import SyncRecoveryManifest
    from app.models.sync_state import SyncState
    from app.sync.clients import SyncClientRegistry
    from app.sync.cursor import CursorPosition

    state = await space_session.get(SyncState, 1)
    assert state is not None
    state.retention_floor = 0
    state.current_cursor = 12
    space_session.add(
        SyncClient(
            client_id="client-a",
            ack_sequence=0,
            catalog_hash="c" * 64,
            registered_at="2026-08-01T00:00:00.000Z",
            last_seen_at="2026-08-01T00:00:00.000Z",
            expires_at="2099-08-01T00:00:00.000Z",
            requires_recovery=True,
            recovery_generation=1,
            recovery_manifest_token="manifest-a",
            recovery_waterline=9,
            recovery_completed_at="2026-08-01T01:00:00.000Z",
        )
    )
    space_session.add(
        SyncRecoveryManifest(
            token="manifest-a",
            space_id="space-a",
            client_id="client-a",
            generation=1,
            catalog_hash="c" * 64,
            waterline=9,
            total_entities=0,
            total_chunks=0,
            total_uncompressed_bytes=0,
            created_at="2026-08-01T00:00:00.000Z",
            expires_at="2099-08-01T00:00:00.000Z",
            manifest_sha256="d" * 64,
        )
    )
    await space_session.flush()
    registry = SyncClientRegistry(space_session, "c" * 64, 30, space_id="space-a")
    decision = await registry.acknowledge(
        "client-a", CursorPosition(9, "c" * 64, "space-a", "client-a", 1)
    )
    assert decision.result is not None
    assert decision.result.requires_recovery is False

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
        connection.execute(
            "INSERT INTO sync_clients "
            "(client_id, catalog_hash, registered_at, last_seen_at, expires_at) "
            "VALUES ('default-check', 'c', 't', 't', 't')"
        )
        assert connection.execute(
            "SELECT requires_recovery FROM sync_clients WHERE client_id = 'default-check'"
        ).fetchone() == (1,)
        assert connection.execute(
            "SELECT delete_sequence FROM tombstones WHERE entity_id = 'known'"
        ).fetchone() == (3,)
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
        remaining = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        assert {"sync_outbox", "tombstones", "sync_state"} <= remaining
        assert "operation_id" in {
            row[1] for row in connection.execute("PRAGMA table_info(sync_outbox)")
        }
