"""TrashOpsMixin — 回收站操作 (列表 / 恢复 / 清除 / 清空).

组合到 FileSystemStorage 后, 通过 self.root / self._lock / self._connect 等
访问 StorageBase 提供的基础设施.

B3: restore 只允许恢复已软删除的笔记 (is_deleted=1)
R4: purge 只允许清除已软删除的笔记
R2: empty_trash 清理 note_links 避免孤儿外键引用
"""
from __future__ import annotations

import asyncio
from pathlib import Path

from app.file_system.interfaces import NoteMeta
from .base import _utc_now_iso


class TrashOpsMixin:
    """回收站操作 Mixin — list_trash / restore / purge / empty_trash."""

    async def list_trash(self) -> list[dict]:
        def _do():
            with self._lock:
                with self._connect() as conn:
                    conn.row_factory = __import__("sqlite3").Row
                    rows = conn.execute(
                        "SELECT note_id, title, current_path, updated_at "
                        "FROM notes WHERE is_deleted = 1 ORDER BY updated_at DESC"
                    ).fetchall()
            return [
                {"note_id": r["note_id"], "title": r["title"],
                 "path": r["current_path"], "deleted_at": r["updated_at"]}
                for r in rows
            ]
        return await asyncio.to_thread(_do)

    async def restore(self, note_id: str) -> NoteMeta:
        def _do():
            with self._lock, self._file_lock:
                now = _utc_now_iso()
                with self._connect() as conn:
                    conn.row_factory = __import__("sqlite3").Row
                    # B3: 只允许恢复已软删除的笔记
                    row = conn.execute(
                        "SELECT * FROM notes WHERE note_id = ? AND is_deleted = 1",
                        (note_id,),
                    ).fetchone()
                    if not row:
                        exist = conn.execute(
                            "SELECT 1 FROM notes WHERE note_id = ?", (note_id,)
                        ).fetchone()
                        if exist:
                            raise ValueError(f"Note {note_id} is not trashed")
                        raise KeyError(f"Note {note_id} not found")
                    # current_path now points to trash location (set by delete_note)
                    trash_rel = row["current_path"]
                    trash_path = self.root / trash_rel
                    folder_id = row["folder_id"]
                    # Restore path uses the timestamped filename from trash (unique)
                    filename = Path(trash_rel).name
                    if folder_id is None:
                        new_rel = f"notes/{filename}"
                    else:
                        new_rel = f"notes/{folder_id}/{filename}"
                    notes_path = self.root / new_rel
                    # Don't overwrite — if target exists, raise error (caller handles)
                    if notes_path.exists():
                        raise FileExistsError(
                            f"Cannot restore: target path already exists: {notes_path}"
                        )
                    if trash_path.exists():
                        notes_path.parent.mkdir(parents=True, exist_ok=True)
                        trash_path.rename(notes_path)
                    conn.execute(
                        "UPDATE notes SET is_deleted = 0, status = ?, current_path = ?, "
                        "updated_at = ? WHERE note_id = ?",
                        ("active", new_rel, now, note_id),
                    )
                    conn.commit()
                    row = conn.execute(
                        "SELECT * FROM notes WHERE note_id = ?", (note_id,)
                    ).fetchone()
                return self._row_to_note_meta(row)
        return await asyncio.to_thread(_do)

    async def purge(self, note_id: str) -> None:
        def _do():
            with self._lock, self._file_lock:
                with self._connect() as conn:
                    # R4: 只允许清除已软删除的笔记
                    row = conn.execute(
                        "SELECT current_path FROM notes WHERE note_id = ? AND is_deleted = 1",
                        (note_id,)
                    ).fetchone()
                    if not row:
                        exist = conn.execute(
                            "SELECT 1 FROM notes WHERE note_id = ?", (note_id,)
                        ).fetchone()
                        if exist:
                            raise ValueError(f"Note {note_id} is not trashed")
                        raise KeyError(f"Note {note_id} not found")
                    # Delete file from .trash/
                    trash_name = Path(row[0]).name
                    trash_path = self.root / ".trash" / trash_name
                    if trash_path.exists():
                        trash_path.unlink()
                    # Delete child tables first (FK references notes.note_id)
                    conn.execute("DELETE FROM note_paths WHERE note_id = ?", (note_id,))
                    conn.execute("DELETE FROM note_versions WHERE note_id = ?", (note_id,))
                    conn.execute("DELETE FROM note_links WHERE from_note_id = ? OR to_note_id = ?",
                                 (note_id, note_id))
                    # Delete parent last
                    conn.execute("DELETE FROM notes WHERE note_id = ?", (note_id,))
                    conn.commit()
        await asyncio.to_thread(_do)

    async def empty_trash(self) -> int:
        def _do():
            with self._lock, self._file_lock:
                with self._connect() as conn:
                    rows = conn.execute(
                        "SELECT note_id FROM notes WHERE is_deleted = 1"
                    ).fetchall()
                    for r in rows:
                        note_id = r[0]
                        # Delete from .trash/
                        trash_row = conn.execute(
                            "SELECT current_path FROM notes WHERE note_id = ?", (note_id,)
                        ).fetchone()
                        if trash_row:
                            trash_path = self.root / ".trash" / Path(trash_row[0]).name
                            if trash_path.exists():
                                trash_path.unlink()
                        # Delete child tables first (FK references notes.note_id)
                        conn.execute("DELETE FROM note_paths WHERE note_id = ?", (note_id,))
                        conn.execute("DELETE FROM note_versions WHERE note_id = ?", (note_id,))
                        # R2: 清理 note_links 避免孤儿外键引用
                        conn.execute(
                            "DELETE FROM note_links WHERE from_note_id = ? OR to_note_id = ?",
                            (note_id, note_id),
                        )
                        # Delete parent last
                        conn.execute("DELETE FROM notes WHERE note_id = ?", (note_id,))
                    conn.commit()
                    return len(rows)
        return await asyncio.to_thread(_do)
