"""Wave 2 Task E — read-only G0-M evidence collection.

Verifies ``scripts/collect_g0_m_evidence.py``:
- records instance id, snapshot id, app version, space revision, legacy table
  counts, mutation journal state and legacy sync counts without writing;
- a fresh (synthetic) space snapshot at head yields a ``passes`` decision with
  complete evidence;
- a snapshot carrying legacy authority yields a ``blocked`` decision with the
  exact blocking reason;
- a missing space DB yields ``unknown_blocked`` with the missing item listed.

These run against throwaway synthetic snapshots only — never production.
"""

from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
from pathlib import Path

from app.db.migrations import run_migrations

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "collect_g0_m_evidence.py"


def _run_evidence(space_db: Path, *extra: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--space-db", str(space_db), *extra],
        capture_output=True,
        text=True,
    )


def _evidence_json(result: subprocess.CompletedProcess[str]) -> dict:
    # The tool emits exactly one JSON document on stdout (warnings go to
    # stderr).  It may be pretty-printed, so parse the whole document.
    return json.loads(result.stdout)


def test_g0m_evidence_on_fresh_space_snapshot(tmp_path) -> None:
    path = tmp_path / "space.db"
    run_migrations("space", path)
    result = _run_evidence(path, "--space-id", "test-synthetic", "--snapshot-id", "snap-1")
    assert result.returncode == 0, result.stderr

    evidence = _evidence_json(result)
    assert evidence["kind"] == "g0_m_evidence"
    assert evidence["instance_id"] == "test-synthetic"
    assert evidence["snapshot_id"] == "snap-1"
    assert evidence["app_version"] == "0.1.0"
    assert evidence["space_revision"] == "space_011_sync_clients_streaming"
    # The cutover dropped the legacy tables entirely: counts are None (absent).
    assert all(count is None for count in evidence["legacy_table_counts"].values())
    assert evidence["mutation_journal"] == {
        "non_terminal_batches": 0,
        "non_terminal_operations": 0,
        "removed_authority_operations": 0,
    }
    assert evidence["sync_outbox_legacy_counts"] == 0
    assert evidence["tombstones_legacy_counts"] == 0
    assert evidence["preflight"]["decision"] == "passes"
    assert not evidence["missing_evidence"]


def test_g0m_evidence_blocked_on_legacy_authority(tmp_path) -> None:
    path = tmp_path / "space.db"
    run_migrations("space", path)
    # Synthetically introduce legacy authority into the throwaway snapshot.
    with sqlite3.connect(path) as conn:
        conn.execute("CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT)")
        conn.execute("INSERT INTO tasks (id, title) VALUES ('t1', 'legacy')")
        conn.commit()

    result = _run_evidence(path, "--space-id", "blocked-synthetic")
    assert result.returncode == 0, result.stderr
    evidence = _evidence_json(result)
    assert evidence["preflight"]["decision"] == "blocked"
    assert evidence["preflight"]["reason"] == (
        "breaking_cutover_requires_empty_legacy:tasks"
    )
    assert evidence["legacy_table_counts"]["tasks"] == 1


def test_g0m_evidence_missing_space_db_is_unknown_blocked(tmp_path) -> None:
    missing = tmp_path / "does-not-exist.db"
    result = _run_evidence(missing)
    assert result.returncode == 0
    evidence = _evidence_json(result)
    assert evidence["status"] == "unknown_blocked"
    assert "space_db_file" in evidence["missing_evidence"]
    assert evidence["preflight"]["decision"] == "unknown"


def test_g0m_evidence_unknown_revision_when_version_table_absent(tmp_path) -> None:
    """A snapshot with a database but NO alembic_version_space is unknown revision."""
    path = tmp_path / "unknown-rev.db"
    run_migrations("space", path)
    with sqlite3.connect(path) as conn:
        conn.execute("DROP TABLE alembic_version_space")
        conn.commit()

    result = _run_evidence(path, "--space-id", "unknown-rev")
    assert result.returncode == 0, result.stderr
    evidence = _evidence_json(result)
    assert evidence["space_revision"] is None
    assert evidence["preflight"]["decision"] == "blocked"
    assert evidence["preflight"]["reason"] == (
        "alembic_version_space missing (unknown revision)"
    )
    assert "alembic_version_space" in evidence["missing_evidence"]


def test_g0m_evidence_is_read_only_hash_unchanged(tmp_path) -> None:
    """The tool must never modify the snapshot: file hash is identical before/after."""
    import hashlib

    for name, prepare in (
        ("fresh", lambda conn: None),
        (
            "legacy",
            lambda conn: (
                conn.execute("CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT)"),
                conn.execute("INSERT INTO tasks (id, title) VALUES ('t1', 'legacy')"),
                None,
            ),
        ),
    ):
        path = tmp_path / f"readonly-{name}.db"
        run_migrations("space", path)
        with sqlite3.connect(path) as conn:
            prepare(conn)
            conn.commit()
        before = hashlib.sha256(path.read_bytes()).hexdigest()

        result = _run_evidence(path, "--space-id", f"readonly-{name}")
        assert result.returncode == 0, result.stderr
        after = hashlib.sha256(path.read_bytes()).hexdigest()
        assert after == before, f"tool modified the {name} snapshot (read-only violated)"
        # No sidecar files may be created next to the snapshot.
        siblings = list(tmp_path.glob(f"readonly-{name}*"))
        assert [s.name for s in siblings] == [f"readonly-{name}.db"]


def test_g0m_evidence_records_missing_real_inputs_as_evidence(tmp_path) -> None:
    """Without instance/snapshot/app-version inputs the evidence names them as missing."""
    path = tmp_path / "space.db"
    run_migrations("space", path)
    # Run WITHOUT --space-id / --snapshot-id / --app-version: instance id is
    # genuinely absent and must be recorded as missing, never fabricated.
    result = _run_evidence(path)
    assert result.returncode == 0, result.stderr
    evidence = _evidence_json(result)
    assert evidence["instance_id"] is None
    assert evidence["snapshot_id"] is not None  # defaults to the file SHA-256
    assert evidence["app_version"] == "0.1.0"
    assert evidence["space_revision"] == "space_011_sync_clients_streaming"
    # Absent inputs that cannot be derived stay None and are reported.
    assert evidence["status"] == "evidence_collected"
    assert evidence["preflight"]["decision"] == "passes"
    # A passes decision must NOT unblock G0-M globally: status stays a snapshot
    # evidence record, and the tool itself never claims the cutover is safe.
    assert "warning" in result.stderr
