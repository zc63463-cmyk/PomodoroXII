"""Read-only G0-M evidence collection for the Task Space breaking cutover.

G0-M remains ``unknown_blocked``: this tool only RECORDS evidence about a
given space database snapshot.  It NEVER connects to production, NEVER
modifies the database (opened ``mode=ro``), NEVER imports data, and NEVER
rewrites migration ``010_task_space_focus_session``.

Absence of records is recorded as absence of evidence, never as proof that
a migration was not published or executed.

Evidence recorded per instance/snapshot:
- instance id (space id) and snapshot id (defaults to the snapshot file SHA-256)
- app version (project version by default; override with --app-version)
- space revision (``alembic_version_space`` head)
- legacy table counts (tasks, sessions, task_quick_notes, session_quick_notes)
- mutation journal state (non-terminal batches/operations; removed-authority
  references inside mutation_operations JSON columns)
- sync_outbox / tombstones legacy entity counts
- preflight decision (blocked reason, passes, or unknown if evidence is missing)

The decision logic mirrors ``app.task_space.migration_preflight`` but records
evidence instead of raising.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import tomllib
from pathlib import Path

LEGACY_TABLES = ("tasks", "sessions", "task_quick_notes", "session_quick_notes")
LEGACY_ENTITY_TYPES = (
    "task",
    "session",
    "taskQuickNote",
    "sessionQuickNote",
    "task_quick_note",
    "session_quick_note",
)
SAFE_TERMINALS = ("FINALIZED", "ABORTED", "COMPENSATED")
REMOVED_AUTHORITY = frozenset((*LEGACY_ENTITY_TYPES, *LEGACY_TABLES))


def _backend_version() -> str:
    pyproject = Path(__file__).resolve().parents[1] / "pyproject.toml"
    with pyproject.open("rb") as handle:
        return str(tomllib.load(handle)["project"]["version"])


def _contains_removed_authority(value: object) -> bool:
    if isinstance(value, str):
        return value in REMOVED_AUTHORITY
    if isinstance(value, dict):
        return any(
            _contains_removed_authority(key) or _contains_removed_authority(item)
            for key, item in value.items()
        )
    if isinstance(value, (list, tuple)):
        return any(_contains_removed_authority(item) for item in value)
    return False


def _count(conn: sqlite3.Connection, statement: str, parameters: tuple = ()) -> int:
    row = conn.execute(statement, parameters).fetchone()
    return int(row[0]) if row and row[0] is not None else 0


def _scan_mutation_operations(conn: sqlite3.Connection) -> int:
    """Count mutation_operations whose JSON columns reference removed authority."""
    columns = (
        "command_json",
        "expected_versions_json",
        "projection_set_json",
        "db_before_json",
        "db_after_json",
        "result_json",
    )
    try:
        rows = conn.execute(
            f"SELECT {', '.join(columns)} FROM mutation_operations"
        ).fetchall()
    except sqlite3.OperationalError:
        return -1  # table absent -> not evaluable
    count = 0
    for row in rows:
        for raw in row:
            if raw is None:
                continue
            try:
                value = json.loads(raw)
            except (TypeError, ValueError):
                count += 1  # invalid JSON is itself evidence of a blocking state
                continue
            if _contains_removed_authority(value):
                count += 1
    return count


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--space-db", required=True, type=Path)
    parser.add_argument("--space-id", default=None, help="instance id (space id)")
    parser.add_argument("--snapshot-id", default=None, help="snapshot id (default: file SHA-256)")
    parser.add_argument("--app-version", default=None)
    args = parser.parse_args()

    db_path = args.space_db.resolve()
    missing: list[str] = []
    if not db_path.is_file():
        missing.append("space_db_file")

    snapshot_id = args.snapshot_id or (
        hashlib.sha256(db_path.read_bytes()).hexdigest() if db_path.is_file() else None
    )
    app_version = args.app_version or _backend_version()

    evidence: dict[str, object] = {
        "kind": "g0_m_evidence",
        "status": "unknown_blocked",
        "instance_id": args.space_id,
        "snapshot_id": snapshot_id,
        "snapshot_path": str(db_path),
        "app_version": app_version,
        "space_revision": None,
        "legacy_table_counts": {name: None for name in LEGACY_TABLES},
        "mutation_journal": {
            "non_terminal_batches": None,
            "non_terminal_operations": None,
            "removed_authority_operations": None,
        },
        "sync_outbox_legacy_counts": None,
        "tombstones_legacy_counts": None,
        "preflight": {"decision": "unknown", "reason": "missing_evidence"},
        "missing_evidence": missing,
    }

    if not db_path.is_file():
        print(json.dumps(evidence, ensure_ascii=False, indent=2))
        return 0

    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        try:
            row = conn.execute(
                "SELECT version_num FROM alembic_version_space LIMIT 1"
            ).fetchone()
            evidence["space_revision"] = row["version_num"] if row else None
        except sqlite3.OperationalError:
            evidence["missing_evidence"].append("alembic_version_space")

        for table in LEGACY_TABLES:
            try:
                evidence["legacy_table_counts"][table] = _count(
                    conn, f'SELECT COUNT(*) FROM "{table}"'
                )
            except sqlite3.OperationalError:
                evidence["legacy_table_counts"][table] = None

        try:
            marks = ",".join("?" for _ in SAFE_TERMINALS)
            evidence["mutation_journal"]["non_terminal_batches"] = _count(
                conn,
                f"SELECT COUNT(*) FROM mutation_batches "
                f"WHERE state NOT IN ({marks})",
                SAFE_TERMINALS,
            )
            evidence["mutation_journal"]["non_terminal_operations"] = _count(
                conn,
                f"SELECT COUNT(*) FROM mutation_operations "
                f"WHERE state NOT IN ({marks})",
                SAFE_TERMINALS,
            )
            evidence["mutation_journal"]["removed_authority_operations"] = (
                _scan_mutation_operations(conn)
            )
        except sqlite3.OperationalError:
            evidence["missing_evidence"].append("mutation_journal")

        try:
            marks = ",".join("?" for _ in LEGACY_ENTITY_TYPES)
            evidence["sync_outbox_legacy_counts"] = _count(
                conn,
                f"SELECT COUNT(*) FROM sync_outbox "
                f"WHERE entity_type IN ({marks})",
                LEGACY_ENTITY_TYPES,
            )
            evidence["tombstones_legacy_counts"] = _count(
                conn,
                f"SELECT COUNT(*) FROM tombstones "
                f"WHERE entity_type IN ({marks})",
                LEGACY_ENTITY_TYPES,
            )
        except sqlite3.OperationalError:
            evidence["missing_evidence"].append("sync_legacy_queries")
    finally:
        conn.close()

    # Decide the preflight outcome from the recorded evidence.
    reason: str | None = None
    if not db_path.is_file():
        reason = "space_db_file missing"
    elif evidence["space_revision"] is None:
        reason = "alembic_version_space missing (unknown revision)"
    else:
        for table in LEGACY_TABLES:
            count = evidence["legacy_table_counts"].get(table)
            if count is None:
                continue
            if count > 0:
                reason = f"breaking_cutover_requires_empty_legacy:{table}"
                break
        if reason is None:
            for key in ("non_terminal_batches", "non_terminal_operations"):
                value = evidence["mutation_journal"][key]
                if value is not None and value > 0:
                    reason = "breaking_cutover_requires_clean_mutation_journal"
                    break
        if reason is None:
            removed_ops = evidence["mutation_journal"]["removed_authority_operations"]
            if removed_ops is not None and removed_ops > 0:
                reason = "breaking_cutover_requires_empty_legacy:mutation_journal"
        if reason is None:
            for label in ("sync_outbox_legacy_counts", "tombstones_legacy_counts"):
                value = evidence[label]
                if value is not None and value > 0:
                    reason = f"breaking_cutover_requires_empty_legacy:{label}"
                    break

    if reason is not None:
        evidence["preflight"] = {"decision": "blocked", "reason": reason}
    elif evidence["missing_evidence"]:
        evidence["preflight"] = {"decision": "unknown", "reason": "missing_evidence"}
    else:
        evidence["preflight"] = {"decision": "passes", "reason": None}
        evidence["status"] = "evidence_collected"
        # A passes decision is evidence about THIS snapshot only; it must not
        # be extrapolated to any other instance.
        print(
            json.dumps(
                {
                    "warning": (
                        "passes is evidence for this snapshot only; it does not "
                        "prove the cutover never blocked elsewhere, and absent "
                        "records must not be read as 'migration never ran'."
                    )
                },
                ensure_ascii=False,
            ),
            file=__import__("sys").stderr,
        )

    print(json.dumps(evidence, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
