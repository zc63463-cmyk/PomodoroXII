"""StorageBase — 文件系统存储基类.

提供 __init__, DB 连接, 锁, 原子写入, FTS5 维护, 生命周期管理.
各 Mixin (NoteOpsMixin, FolderOpsMixin, ...) 组合成最终的 FileSystemStorage.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock

from filelock import FileLock
from nanoid import generate
from slugify import slugify

from app.file_system.interfaces import (
    NoteLevel,
    NoteMeta,
    NoteStatus,
)
from app.file_system.schema import (
    FTS5_CREATE_SQL,
    FTS5_TRIGGER_DELETE,
    FTS5_TRIGGER_INSERT,
    FTS5_TRIGGER_UPDATE,
    init_database,
)


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _generate_note_id() -> str:
    """n_ + nanoid(12) = 15 chars total."""
    return "n_" + generate(size=12)


def _make_filename(note_id: str, title: str) -> str:
    """生成笔记文件名: <note_id>-<slug>.md"""
    slug = slugify(title, max_length=30) or "untitled"
    return f"{note_id}-{slug}.md"


class StorageBase:
    """文件系统存储基类 — .md + SQLite + FTS5.

    提供 DB 连接, 锁, 原子写入, FTS5 维护等基础设施.
    具体操作由各 Mixin 实现, 组合成 FileSystemStorage.
    """

    def __init__(self, root_dir: Path, index_db: Path):
        self.root = Path(root_dir).resolve()
        self.index_db = Path(index_db).resolve()
        self._lock = RLock()
        self._file_lock = FileLock(str(self.index_db) + ".lock")
        self._engine = None

    # ─── DB helpers ──────────────────────────────────────

    def _connect(self) -> sqlite3.Connection:
        """Open a sqlite3 connection (caller manages lifecycle)."""
        conn = sqlite3.connect(str(self.index_db), timeout=30.0)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def _note_path(self, note_id: str, title: str = "", folder_id=None) -> Path:
        """Return the .md file path for a note_id.

        If title is provided, returns the path for a new note with that title.
        If title is empty, looks up the current path from DB.
        """
        # Look up the current path from DB if title not provided
        if not title:
            with self._connect() as conn:
                row = conn.execute(
                    "SELECT title, current_path FROM notes WHERE note_id = ?", (note_id,)
                ).fetchone()
            if row:
                return self.root / row[1]
            raise KeyError(f"Note {note_id} not found")
        filename = _make_filename(note_id, title)
        if folder_id is None:
            return self.root / "notes" / filename
        return self.root / "notes" / folder_id / filename

    def _row_to_note_meta(self, row: sqlite3.Row) -> NoteMeta:
        """Convert a DB row to NoteMeta."""
        tags_raw = row["tags"] or "[]"
        try:
            tags = json.loads(tags_raw) if tags_raw else []
        except json.JSONDecodeError:
            tags = []
        return NoteMeta(
            id=row["note_id"],
            title=row["title"] or "",
            folder_id=row["folder_id"],
            level=NoteLevel(row["level"]) if row["level"] else NoteLevel.L1,
            status=NoteStatus(row["status"]) if row["status"] else NoteStatus.ACTIVE,
            tags=tags,
            content_hash=row["content_hash"] or "",
            word_count=row["word_count"] or 0,
            created_at=row["created_at"] or "",
            updated_at=row["updated_at"] or "",
        )

    # ─── Atomic write ────────────────────────────────────

    def _atomic_write(self, path: Path, content: str) -> None:
        """原子写入：先写临时文件，再 os.replace 覆盖。"""
        path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = path.parent / f".{path.name}.tmp"
        try:
            temp_path.write_text(content, encoding="utf-8")
            os.replace(str(temp_path), str(path))
        except Exception:
            if temp_path.exists():
                temp_path.unlink()
            raise

    def _update_fts_content(self, conn: sqlite3.Connection, note_id: str, content: str) -> None:
        """Update the FTS5 content column for a note."""
        conn.execute(
            "UPDATE notes_fts SET content = ? WHERE rowid = "
            "(SELECT rowid FROM notes WHERE note_id = ?)",
            (content, note_id),
        )

    # ─── Lifecycle ───────────────────────────────────────

    async def init(self) -> None:
        def _do():
            (self.root / "notes").mkdir(parents=True, exist_ok=True)
            (self.root / ".trash").mkdir(parents=True, exist_ok=True)
            (self.root / ".meta").mkdir(parents=True, exist_ok=True)
            init_database(self.index_db)
            # R7: 升级到 trigram tokenizer 时重建 FTS5 索引并从 .md 文件回填正文
            self._rebuild_fts5_if_needed()
        await asyncio.to_thread(_do)

    def _rebuild_fts5_if_needed(self) -> None:
        """R7: 如果 FTS5 表使用旧 tokenizer (非 trigram), 重建索引并从 .md 文件回填正文.

        升级路径: 旧库的 notes_fts 用默认 unicode61 tokenizer, 且 content 列可能为空
        (触发器只在 INSERT 时塞空字符串, 正文由 _update_fts_content 单独写入).
        重建后用 trigram tokenizer, 并从 .md 文件读取正文回填, 保证正文搜索可用.
        """
        with self._connect() as conn:
            row = conn.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='notes_fts'"
            ).fetchone()
            if not row:
                return
            create_sql = row[0] or ""
            if 'trigram' in create_sql.lower():
                return
            # 旧 tokenizer — 重建
            conn.execute("DROP TABLE IF EXISTS notes_fts")
            conn.execute(FTS5_CREATE_SQL)
            # DROP TABLE 会连带删除 FTS5 触发器, 必须重建 (使用 IF NOT EXISTS 保证幂等)
            conn.execute(FTS5_TRIGGER_INSERT)
            conn.execute(FTS5_TRIGGER_UPDATE)
            conn.execute(FTS5_TRIGGER_DELETE)
            # 从 .md 文件读取正文回填 (rowid 对齐 notes 表)
            rows = conn.execute(
                "SELECT rowid, title, current_path FROM notes WHERE is_deleted = 0"
            ).fetchall()
            for rowid, title, current_path in rows:
                content = ""
                if current_path:
                    p = self.root / current_path
                    if p.exists():
                        content = p.read_text(encoding="utf-8")
                conn.execute(
                    "INSERT INTO notes_fts (rowid, title, content) VALUES (?, ?, ?)",
                    (rowid, title, content),
                )
            conn.commit()

    async def close(self) -> None:
        # No persistent resources to clean up (connections are per-operation)
        pass
