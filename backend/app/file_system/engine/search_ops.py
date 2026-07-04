"""SearchOpsMixin — 全文搜索 (FTS5 trigram + LIKE 回退).

组合到 FileSystemStorage 后, 通过 self._lock / self._connect 等
访问 StorageBase 提供的基础设施.

B4: trigram 要求 ≥3 字符, 短查询走 LIKE 回退
R6: 双引号包裹强制短语搜索, 内部双引号双写转义防注入
"""
from __future__ import annotations

import asyncio

from app.file_system.interfaces import SearchResult


class SearchOpsMixin:
    """搜索操作 Mixin — search / search_in_folder."""

    async def search(self, query: str, limit: int = 20) -> list[SearchResult]:
        def _do():
            q = query.strip()
            if not q:
                return []
            with self._lock:
                with self._connect() as conn:
                    if len(q) < 3:
                        # B4: trigram 要求 ≥3 字符, 短查询走 LIKE 回退 (标题或正文命中)
                        like = f"%{q}%"
                        rows = conn.execute(
                            "SELECT n.note_id, n.title, n.folder_id, "
                            "'' as excerpt, 0.0 as score "
                            "FROM notes n WHERE n.is_deleted = 0 AND "
                            "(n.title LIKE ? OR EXISTS ("
                            "SELECT 1 FROM notes_fts f WHERE f.rowid = n.rowid AND f.content LIKE ?)) "
                            "ORDER BY n.updated_at DESC LIMIT ?",
                            (like, like, limit),
                        ).fetchall()
                    else:
                        # R6: 双引号包裹强制短语搜索, 内部双引号双写转义防注入
                        fts_query = '"' + q.replace('"', '""') + '"'
                        rows = conn.execute(
                            "SELECT n.note_id, n.title, n.folder_id, "
                            "snippet(notes_fts, 1, '...', '...', '...', 20) as excerpt, "
                            "-bm25(notes_fts) as score "
                            "FROM notes_fts "
                            "JOIN notes n ON notes_fts.rowid = n.rowid "
                            "WHERE notes_fts MATCH ? AND n.is_deleted = 0 "
                            "ORDER BY score DESC LIMIT ?",
                            (fts_query, limit),
                        ).fetchall()
            return [
                SearchResult(
                    note_id=r[0], title=r[1] or "", folder_id=r[2],
                    excerpt=r[3] or "", score=float(r[4]) if r[4] is not None else 0.0,
                )
                for r in rows
            ]
        return await asyncio.to_thread(_do)

    async def search_in_folder(self, folder_id: str, query: str, limit: int = 20) -> list[SearchResult]:
        def _do():
            q = query.strip()
            if not q:
                return []
            with self._lock:
                with self._connect() as conn:
                    if len(q) < 3:
                        # B4: trigram 要求 ≥3 字符, 短查询走 LIKE 回退
                        like = f"%{q}%"
                        rows = conn.execute(
                            "SELECT n.note_id, n.title, n.folder_id, "
                            "'' as excerpt, 0.0 as score "
                            "FROM notes n WHERE n.is_deleted = 0 AND n.folder_id = ? AND "
                            "(n.title LIKE ? OR EXISTS ("
                            "SELECT 1 FROM notes_fts f WHERE f.rowid = n.rowid AND f.content LIKE ?)) "
                            "ORDER BY n.updated_at DESC LIMIT ?",
                            (folder_id, like, like, limit),
                        ).fetchall()
                    else:
                        # R6: 双引号包裹强制短语搜索, 内部双引号双写转义防注入
                        fts_query = '"' + q.replace('"', '""') + '"'
                        rows = conn.execute(
                            "SELECT n.note_id, n.title, n.folder_id, "
                            "snippet(notes_fts, 1, '...', '...', '...', 20) as excerpt, "
                            "-bm25(notes_fts) as score "
                            "FROM notes_fts "
                            "JOIN notes n ON notes_fts.rowid = n.rowid "
                            "WHERE notes_fts MATCH ? AND n.is_deleted = 0 AND n.folder_id = ? "
                            "ORDER BY score DESC LIMIT ?",
                            (fts_query, folder_id, limit),
                        ).fetchall()
            return [
                SearchResult(
                    note_id=r[0], title=r[1] or "", folder_id=r[2],
                    excerpt=r[3] or "", score=float(r[4]) if r[4] is not None else 0.0,
                )
                for r in rows
            ]
        return await asyncio.to_thread(_do)
