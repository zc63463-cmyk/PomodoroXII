"""NoteOpsMixin — 笔记操作 (CRUD + 移动 + 编辑).

组合到 FileSystemStorage 后, 通过 self.root / self._lock / self._connect 等
访问 StorageBase 提供的基础设施.
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path

from nanoid import generate

from app.file_system.interfaces import NoteMeta, NoteStatus, NoteLevel
from app.file_system.frontmatter import wrap_with_frontmatter, strip_frontmatter
from .base import _utc_now_iso, _sha256, _generate_note_id, _make_filename


class NoteOpsMixin:
    """笔记操作 Mixin — create/read/move/edit/delete/list."""

    async def create_note(
        self,
        title: str,
        content: str,
        folder_id=None,
        level: NoteLevel = NoteLevel.L1,
        tags=None,
        external_id=None,
    ) -> NoteMeta:
        if tags is None:
            tags = []

        def _do():
            with self._lock, self._file_lock:
                # 验证 folder_id 存在且未 trashed (防止路径遍历攻击 + E.2 trashed 校验)
                if folder_id is not None:
                    with self._connect() as conn:
                        row = conn.execute(
                            "SELECT id FROM folders WHERE id = ? AND trashed_at IS NULL",
                            (folder_id,),
                        ).fetchone()
                    if not row:
                        # 区分: 存在但 trashed vs 完全不存在
                        with self._connect() as conn:
                            exist = conn.execute(
                                "SELECT id FROM folders WHERE id = ?", (folder_id,)
                            ).fetchone()
                        if exist:
                            raise ValueError(f"Folder {folder_id} is trashed")
                        raise ValueError(f"Folder {folder_id} does not exist")
                # ID 透传: 使用 external_id 或生成新 n_+nanoid
                note_id = external_id if external_id else _generate_note_id()
                if external_id:
                    with self._connect() as conn:
                        exists = conn.execute(
                            "SELECT 1 FROM notes WHERE note_id = ?", (external_id,)
                        ).fetchone()
                        if exists:
                            raise ValueError(f"Note id {external_id} already exists")
                now = _utc_now_iso()
                # B.3: 用 _note_path 推导 abs_path (单点更新路径策略)
                abs_path = self._note_path(note_id, title, folder_id)
                # rel_path 用于 DB 写入 (POSIX 风格, 与 _note_path 内部逻辑等价)
                filename = _make_filename(note_id, title)
                if folder_id is None:
                    rel_path = f"notes/{filename}"
                else:
                    rel_path = f"notes/{folder_id}/{filename}"
                content_hash = _sha256(content)
                tags_json = json.dumps(tags, ensure_ascii=False)
                word_count = len(content.split())

                # Write .md file with YAML frontmatter (self-describing)
                fm_meta = {
                    "id": note_id,
                    "title": title,
                    "tags": tags,
                    "folder_id": folder_id,
                    "content_hash": f"sha256:{content_hash[:16]}",
                    "created_at": now,
                    "updated_at": now,
                }
                self._atomic_write(abs_path, wrap_with_frontmatter(fm_meta, content))

                # Insert DB row (FTS5 trigger fires automatically)
                with self._connect() as conn:
                    conn.execute(
                        "INSERT INTO notes (note_id, title, current_path, content_hash, "
                        "folder_id, level, status, tags, word_count, is_deleted, "
                        "created_at, updated_at) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (note_id, title, rel_path, content_hash,
                         folder_id, level.value, "active", tags_json,
                         word_count, 0, now, now),
                    )
                    # Update FTS5 content with actual note text
                    self._update_fts_content(conn, note_id, content)
                    conn.commit()

                return NoteMeta(
                    id=note_id, title=title, folder_id=folder_id, level=level,
                    status=NoteStatus.ACTIVE, tags=tags, content_hash=content_hash,
                    word_count=word_count, created_at=now, updated_at=now,
                )
        return await asyncio.to_thread(_do)

    async def read_note(self, note_id: str) -> str:
        def _do():
            with self._lock:
                with self._connect() as conn:
                    # R5: 软删除笔记不可读
                    row = conn.execute(
                        "SELECT current_path FROM notes WHERE note_id = ? AND is_deleted = 0",
                        (note_id,)
                    ).fetchone()
            if not row:
                raise KeyError(f"Note {note_id} not found")
            path = self.root / row[0]
            if not path.exists():
                raise FileNotFoundError(f"Note file missing: {path}")
            raw = path.read_text(encoding="utf-8")
            # Strip YAML frontmatter for backward compatibility (callers
            # expect raw markdown content, not frontmatter metadata).
            return strip_frontmatter(raw)
        return await asyncio.to_thread(_do)

    async def read_notes_batch(self, note_ids: list[str]) -> list[str | None]:
        """Batch read note contents, preserving input order. IO count = 2."""
        if not note_ids:
            return []
        def _do():
            with self._lock:
                with self._connect() as conn:
                    conn.row_factory = __import__("sqlite3").Row
                    placeholders = ",".join("?" * len(note_ids))
                    rows = conn.execute(
                        f"SELECT note_id, current_path FROM notes "
                        f"WHERE note_id IN ({placeholders}) AND is_deleted = 0",
                        note_ids,
                    ).fetchall()
                    path_map = {row["note_id"]: row["current_path"] for row in rows}
            results = []
            for nid in note_ids:
                rel_path = path_map.get(nid)
                if rel_path is None:
                    results.append(None)
                    continue
                abs_path = self.root / rel_path
                if abs_path.exists():
                    raw = abs_path.read_text(encoding="utf-8")
                    results.append(strip_frontmatter(raw))
                else:
                    results.append(None)
            return results
        return await asyncio.to_thread(_do)

    async def read_note_meta(self, note_id: str) -> NoteMeta:
        def _do():
            with self._lock:
                with self._connect() as conn:
                    conn.row_factory = __import__("sqlite3").Row
                    # R5: 软删除笔记不可读
                    row = conn.execute(
                        "SELECT * FROM notes WHERE note_id = ? AND is_deleted = 0",
                        (note_id,)
                    ).fetchone()
            if not row:
                raise KeyError(f"Note {note_id} not found")
            return self._row_to_note_meta(row)
        return await asyncio.to_thread(_do)

    async def move_note(self, note_id: str, target_folder_id) -> NoteMeta:
        def _do():
            with self._lock, self._file_lock:
                # 验证目标文件夹存在 (防止路径遍历攻击)
                if target_folder_id is not None:
                    with self._connect() as conn:
                        folder_row = conn.execute(
                            "SELECT id FROM folders WHERE id = ?", (target_folder_id,)
                        ).fetchone()
                    if not folder_row:
                        raise KeyError(f"Folder {target_folder_id} not found")
                now = _utc_now_iso()
                with self._connect() as conn:
                    conn.row_factory = __import__("sqlite3").Row
                    # R5: 软删除笔记不可移动
                    row = conn.execute(
                        "SELECT * FROM notes WHERE note_id = ? AND is_deleted = 0",
                        (note_id,)
                    ).fetchone()
                    if not row:
                        raise KeyError(f"Note {note_id} not found")
                    old_path = row["current_path"]
                    filename = Path(old_path).name
                    # Compute new path based on target_folder_id
                    if target_folder_id is None:
                        new_rel_path = f"notes/{filename}"
                    else:
                        new_rel_path = f"notes/{target_folder_id}/{filename}"
                    # Move file on disk
                    old_abs = self.root / old_path
                    new_abs = self.root / new_rel_path
                    if old_abs.exists() and old_abs != new_abs:
                        new_abs.parent.mkdir(parents=True, exist_ok=True)
                        old_abs.rename(new_abs)
                    # Update DB: folder_id AND current_path
                    conn.execute(
                        "UPDATE notes SET folder_id = ?, current_path = ?, updated_at = ? "
                        "WHERE note_id = ?",
                        (target_folder_id, new_rel_path, now, note_id),
                    )
                    # Record path history with correct new_path
                    conn.execute(
                        "INSERT INTO note_paths (note_id, old_path, new_path, changed_at) "
                        "VALUES (?, ?, ?, ?)",
                        (note_id, old_path, new_rel_path, now),
                    )
                    conn.commit()
                    # Re-read updated row
                    row = conn.execute(
                        "SELECT * FROM notes WHERE note_id = ?", (note_id,)
                    ).fetchone()
                return self._row_to_note_meta(row)
        return await asyncio.to_thread(_do)

    async def edit_note(self, note_id: str, content: str) -> NoteMeta:
        def _do():
            with self._lock, self._file_lock:
                now = _utc_now_iso()
                new_hash = _sha256(content)
                word_count = len(content.split())
                with self._connect() as conn:
                    conn.row_factory = __import__("sqlite3").Row
                    # R5: 软删除笔记不可编辑
                    row = conn.execute(
                        "SELECT * FROM notes WHERE note_id = ? AND is_deleted = 0",
                        (note_id,)
                    ).fetchone()
                    if not row:
                        raise KeyError(f"Note {note_id} not found")
                    old_hash = row["content_hash"]
                    abs_path = self.root / row["current_path"]

                    # A.5: 若内容变化, 先备份旧内容到 .meta/version_backups/
                    if old_hash != new_hash:
                        version_id = "v_" + generate(size=12)
                        # 读旧内容 (在 _atomic_write 覆盖之前)
                        old_content = ""
                        if abs_path.exists():
                            old_content = abs_path.read_text(encoding="utf-8")
                        backup_dir = self.root / ".meta" / "version_backups"
                        backup_path = backup_dir / f"{version_id}.md"
                        self._atomic_write(backup_path, old_content)

                    # Write new content with updated frontmatter (atomic)
                    fm_meta = {
                        "id": note_id,
                        "title": row["title"],
                        "tags": json.loads(row["tags"]) if row["tags"] else [],
                        "folder_id": row["folder_id"],
                        "content_hash": f"sha256:{new_hash[:16]}",
                        "created_at": row["created_at"],
                        "updated_at": now,
                    }
                    self._atomic_write(abs_path, wrap_with_frontmatter(fm_meta, content))

                    # Update DB row
                    conn.execute(
                        "UPDATE notes SET content_hash = ?, word_count = ?, "
                        "updated_at = ? WHERE note_id = ?",
                        (new_hash, word_count, now, note_id),
                    )
                    # Update FTS5 content
                    self._update_fts_content(conn, note_id, content)

                    # Record version (only if content actually changed)
                    if old_hash != new_hash:
                        conn.execute(
                            "INSERT INTO note_versions (version_id, note_id, content_hash, "
                            "change_summary, created_at) VALUES (?, ?, ?, ?, ?)",
                            (version_id, note_id, old_hash, "edit", now),
                        )

                    conn.commit()
                    row = conn.execute(
                        "SELECT * FROM notes WHERE note_id = ?", (note_id,)
                    ).fetchone()
                return self._row_to_note_meta(row)
        return await asyncio.to_thread(_do)

    async def edit_note_meta(self, note_id: str, title=None, tags=None) -> NoteMeta:
        def _do():
            with self._lock, self._file_lock:
                now = _utc_now_iso()
                with self._connect() as conn:
                    conn.row_factory = __import__("sqlite3").Row
                    row = conn.execute(
                        "SELECT * FROM notes WHERE note_id = ?", (note_id,)
                    ).fetchone()
                    if not row:
                        raise KeyError(f"Note {note_id} not found")
                    updates = []
                    params = []
                    if title is not None:
                        old_title = row["title"]
                        old_path = row["current_path"]
                        # E.1: 若 title 真正变化, 触发文件重命名 + 路径历史
                        if old_title != title:
                            new_filename = _make_filename(note_id, title)
                            old_abs = self.root / old_path
                            # 保留原 folder 目录 (notes 或 notes/<folder_id>)
                            folder_part = str(Path(old_path).parent).replace("\\", "/")
                            new_rel_path = f"{folder_part}/{new_filename}"
                            new_abs = self.root / new_rel_path
                            if old_abs.exists() and old_abs != new_abs:
                                new_abs.parent.mkdir(parents=True, exist_ok=True)
                                old_abs.rename(new_abs)
                            updates.append("current_path = ?")
                            params.append(new_rel_path)
                            # 记录路径历史
                            conn.execute(
                                "INSERT INTO note_paths (note_id, old_path, new_path, changed_at) "
                                "VALUES (?, ?, ?, ?)",
                                (note_id, old_path, new_rel_path, now),
                            )
                        updates.append("title = ?")
                        params.append(title)
                    if tags is not None:
                        updates.append("tags = ?")
                        params.append(json.dumps(tags, ensure_ascii=False))
                    if updates:
                        updates.append("updated_at = ?")
                        params.append(now)
                        params.append(note_id)
                        conn.execute(
                            f"UPDATE notes SET {', '.join(updates)} WHERE note_id = ?",
                            params,
                        )
                        if title is not None:
                            conn.execute(
                                "UPDATE notes_fts SET title = ? WHERE rowid = "
                                "(SELECT rowid FROM notes WHERE note_id = ?)",
                                (title, note_id),
                            )
                        conn.commit()
                    row = conn.execute(
                        "SELECT * FROM notes WHERE note_id = ?", (note_id,)
                    ).fetchone()
                return self._row_to_note_meta(row)
        return await asyncio.to_thread(_do)

    async def delete_note(self, note_id: str) -> None:
        def _do():
            with self._lock, self._file_lock:
                now = _utc_now_iso()
                with self._connect() as conn:
                    row = conn.execute(
                        "SELECT current_path FROM notes WHERE note_id = ?", (note_id,)
                    ).fetchone()
                    if not row:
                        raise KeyError(f"Note {note_id} not found")
                    rel_path = row[0]
                    abs_path = self.root / rel_path
                    # Timestamped trash filename to avoid collision on repeated deletes
                    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")
                    trash_filename = f"{Path(rel_path).stem}-{timestamp}.md"
                    trash_rel = f".trash/{trash_filename}"
                    trash_path = self.root / trash_rel
                    if abs_path.exists():
                        abs_path.rename(trash_path)
                    # Update current_path to point to trash location + mark deleted
                    conn.execute(
                        "UPDATE notes SET is_deleted = 1, status = ?, current_path = ?, "
                        "updated_at = ? WHERE note_id = ?",
                        ("trashed", trash_rel, now, note_id),
                    )
                    conn.commit()
        await asyncio.to_thread(_do)

    async def list_notes(self, folder_id=None, status=None) -> list[NoteMeta]:
        def _do():
            with self._lock:
                with self._connect() as conn:
                    conn.row_factory = __import__("sqlite3").Row
                    query = "SELECT * FROM notes WHERE is_deleted = 0"
                    params = []
                    if folder_id is not None:
                        query += " AND folder_id = ?"
                        params.append(folder_id)
                    if status is not None:
                        query += " AND status = ?"
                        params.append(status.value)
                    query += " ORDER BY updated_at DESC"
                    rows = conn.execute(query, params).fetchall()
            return [self._row_to_note_meta(r) for r in rows]
        return await asyncio.to_thread(_do)

    async def get_note_by_path(self, path: str) -> NoteMeta:
        def _do():
            with self._lock:
                with self._connect() as conn:
                    conn.row_factory = __import__("sqlite3").Row
                    row = conn.execute(
                        "SELECT * FROM notes WHERE current_path = ?", (path,)
                    ).fetchone()
            if not row:
                raise KeyError(f"Note at path {path} not found")
            return self._row_to_note_meta(row)
        return await asyncio.to_thread(_do)
