"""Re-anchor the Meta registry to the current checkout root.

The ``spaces`` table in ``data/meta.db`` stores absolute ``db_path`` /
``notes_dir`` per space. After the whole tree is moved (drive letter change,
new machine, portable drive), those rows still point at the old root and the
backend refuses to start ("registered Space paths do not match the canonical
runtime layout"). This script rewrites exactly those two columns to the
canonical layout under ``--root`` -- the same SQL shape the official
``app.recovery.relocation._rewrite_staged_registry`` uses.

Usage:
    python fix_registry.py --root <repo-root>            # fix (idempotent)
    python fix_registry.py --root <repo-root> --check    # report only
    python fix_registry.py --root <repo-root> --scan-old <old-root-path>

Exit codes: 0 ok / nothing to do; 1 stale (only in --check); 2 error.
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path


def _like_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def scan_old_root(dbs: list[Path], needle: str) -> int:
    """Read-only sweep: report where the old root still appears in the DBs."""
    total = 0
    pattern = f"%{_like_escape(needle)}%"
    for db in dbs:
        if not db.is_file():
            continue
        try:
            conn = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True)
        except sqlite3.Error as exc:
            print(f"  [scan] cannot open {db}: {exc}")
            continue
        try:
            tables = [
                row[0]
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            ]
            for table in tables:
                try:
                    cols = [row[1] for row in conn.execute(f'PRAGMA table_info("{table}")')]
                except sqlite3.Error:
                    continue
                for col in cols:
                    try:
                        n = conn.execute(
                            f'SELECT COUNT(*) FROM "{table}" WHERE "{col}" LIKE ? ESCAPE \'\\\'',
                            (pattern,),
                        ).fetchone()[0]
                    except sqlite3.Error:
                        continue
                    if n:
                        print(f"  [scan] {db.name}:{table}.{col} -> {n} row(s) contain the old root")
                        total += int(n)
        finally:
            conn.close()
    return total


def main() -> int:
    ap = argparse.ArgumentParser(description="Re-anchor Meta registry paths")
    ap.add_argument("--root", required=True, help="repo root (contains data/meta.db)")
    ap.add_argument("--check", action="store_true", help="report only, write nothing")
    ap.add_argument("--scan-old", default="", help="read-only sweep for this old root path")
    args = ap.parse_args()

    root = Path(args.root).resolve()
    meta = root / "data" / "meta.db"
    spaces_root = root / "data" / "spaces"

    if not meta.is_file():
        print(f"ERROR: meta.db not found: {meta}")
        return 2

    if args.scan_old:
        dbs = [meta]
        if spaces_root.is_dir():
            dbs += sorted(spaces_root.glob("*/space.db"))
            dbs += sorted(spaces_root.glob("*/index.db"))
        found = scan_old_root(dbs, args.scan_old)
        print(f"SCAN: {found} cell(s) still reference '{args.scan_old}'")

    changes: list[tuple[str, str, str, str, str]] = []
    try:
        conn = sqlite3.connect(f"file:{meta.as_posix()}?mode=rw", uri=True)
    except sqlite3.Error as exc:
        print(f"ERROR: cannot open meta.db: {exc}")
        return 2

    try:
        rows = conn.execute("SELECT id, db_path, notes_dir FROM spaces ORDER BY id").fetchall()
        for space_id, db_path, notes_dir in rows:
            want_db = str(spaces_root / str(space_id) / "space.db")
            want_notes = str(spaces_root / str(space_id) / "notes")
            if str(db_path) != want_db or str(notes_dir) != want_notes:
                changes.append((str(space_id), str(db_path), want_db, str(notes_dir), want_notes))

        if args.check:
            if changes:
                print(f"REGISTRY STALE: {len(changes)} of {len(rows)} space row(s) need re-anchoring")
                for sid, old_db, want_db, _old_n, _want_n in changes:
                    print(f"  {sid}: {old_db} -> {want_db}")
                return 1
            print(f"REGISTRY OK: {len(rows)} space row(s) already canonical")
            return 0

        if changes:
            with conn:
                for sid, _old_db, want_db, _old_n, want_notes in changes:
                    cur = conn.execute(
                        "UPDATE spaces SET db_path=?, notes_dir=? WHERE id=?",
                        (want_db, want_notes, sid),
                    )
                    if cur.rowcount != 1:
                        print(f"ERROR: unexpected rowcount for space {sid}")
                        return 2
            print(f"REGISTRY UPDATED: {len(changes)} of {len(rows)} space row(s) re-anchored to {spaces_root}")
            for sid, old_db, want_db, _old_n, _want_n in changes:
                print(f"  {sid}: {old_db} -> {want_db}")
        else:
            print(f"REGISTRY OK: {len(rows)} space row(s) already canonical")
    except sqlite3.DatabaseError as exc:
        print(f"ERROR: meta registry unreadable: {exc}")
        return 2
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
