"""ConsistencyOpsMixin — 一致性检查与修复 + 统计.

组合到 FileSystemStorage 后, 通过 self.root / self._lock / self._connect 等
访问 StorageBase 提供的基础设施.

Phase 1: 迁移 check_consistency / repair / get_stats 实现
Phase 3 (C.2): check_consistency 追加 content_hash 验证 (hash_mismatches 字段)
"""
from __future__ import annotations

import asyncio
from pathlib import Path

from .base import _utc_now_iso, _generate_note_id, _sha256


class ConsistencyOpsMixin:
    """一致性操作 Mixin — check_consistency / repair / get_stats."""

    async def check_consistency(self) -> dict:
        def _do():
            with self._lock:
                with self._connect() as conn:
                    conn.row_factory = __import__("sqlite3").Row
                    # All active (non-deleted) notes in DB
                    db_rows = conn.execute(
                        "SELECT note_id, current_path, content_hash FROM notes WHERE is_deleted = 0"
                    ).fetchall()
                    missing_files = []
                    hash_mismatches = []
                    for row in db_rows:
                        abs_path = self.root / row["current_path"]
                        if not abs_path.exists():
                            missing_files.append(row["note_id"])
                            continue
                        # C.2: 校验文件内容哈希与 DB content_hash 一致
                        actual_hash = _sha256(abs_path.read_text(encoding="utf-8"))
                        if actual_hash != row["content_hash"]:
                            hash_mismatches.append(row["note_id"])
                    # All .md files in notes/ dir
                    notes_dir = self.root / "notes"
                    orphan_files = []
                    if notes_dir.exists():
                        db_paths = {row["current_path"] for row in db_rows}
                        for md_file in notes_dir.rglob("*.md"):
                            rel = str(md_file.relative_to(self.root)).replace("\\", "/")
                            if rel not in db_paths:
                                orphan_files.append(rel)
                    return {
                        "missing_files": missing_files,
                        "orphan_files": orphan_files,
                        "hash_mismatches": hash_mismatches,
                        "total_notes": len(db_rows),
                        "total_files": len(list(notes_dir.rglob("*.md"))) if notes_dir.exists() else 0,
                    }
        return await asyncio.to_thread(_do)

    async def repair(self, report: dict) -> dict:
        def _do():
            with self._lock, self._file_lock:
                now = _utc_now_iso()
                fixed = {"marked_deleted": 0, "added_to_index": 0}
                with self._connect() as conn:
                    for note_id in report.get("missing_files", []):
                        conn.execute(
                            "UPDATE notes SET is_deleted = 1, status = ?, updated_at = ? "
                            "WHERE note_id = ?",
                            ("trashed", now, note_id),
                        )
                        fixed["marked_deleted"] += 1
                    for path in report.get("orphan_files", []):
                        # Create a minimal index entry for orphan files
                        note_id = _generate_note_id()
                        title = Path(path).stem
                        # Read orphan file content for FTS5 indexing
                        abs_file = self.root / path
                        content = abs_file.read_text(encoding="utf-8") if abs_file.exists() else ""
                        conn.execute(
                            "INSERT INTO notes (note_id, title, current_path, created_at, updated_at) "
                            "VALUES (?, ?, ?, ?, ?)",
                            (note_id, title, path, now, now),
                        )
                        self._update_fts_content(conn, note_id, content)
                        fixed["added_to_index"] += 1
                    # C.2: 修复 hash 不一致 — 用文件实际内容重算 hash 写回 DB
                    for note_id in report.get("hash_mismatches", []):
                        row = conn.execute(
                            "SELECT current_path FROM notes WHERE note_id = ?", (note_id,)
                        ).fetchone()
                        if row:
                            abs_path = self.root / row[0]
                            if abs_path.exists():
                                new_hash = _sha256(abs_path.read_text(encoding="utf-8"))
                                conn.execute(
                                    "UPDATE notes SET content_hash = ?, updated_at = ? "
                                    "WHERE note_id = ?",
                                    (new_hash, now, note_id),
                                )
                                fixed["hash_repaired"] = fixed.get("hash_repaired", 0) + 1
                    conn.commit()
                return fixed
        return await asyncio.to_thread(_do)

    # ─── Stats ───────────────────────────────────────────

    async def get_stats(self) -> dict:
        def _do():
            with self._lock:
                with self._connect() as conn:
                    total = conn.execute(
                        "SELECT COUNT(*) FROM notes WHERE is_deleted = 0"
                    ).fetchone()[0]
                    deleted = conn.execute(
                        "SELECT COUNT(*) FROM notes WHERE is_deleted = 1"
                    ).fetchone()[0]
                    folders = conn.execute("SELECT COUNT(*) FROM folders").fetchone()[0]
                    return {"total_notes": total, "deleted_notes": deleted, "total_folders": folders}
        return await asyncio.to_thread(_do)
