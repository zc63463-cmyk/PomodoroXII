"""VersionOpsMixin — 版本历史 (列表 + 获取内容).

组合到 FileSystemStorage 后, 通过 self.root / self._lock / self._connect 等
访问 StorageBase 提供的基础设施.

Phase 1: 仅迁移 list_versions 实现 + get_version 桩
Phase 2 (A.5): 实现 get_version + edit_note 备份机制 (用 .meta/version_backups/)
"""
from __future__ import annotations

import asyncio

from app.file_system.interfaces import VersionRecord


class VersionOpsMixin:
    """版本历史操作 Mixin — list_versions / get_version."""

    async def list_versions(self, note_id: str) -> list[VersionRecord]:
        def _do():
            with self._lock:
                with self._connect() as conn:
                    rows = conn.execute(
                        "SELECT version_id, note_id, content_hash, change_summary, created_at "
                        "FROM note_versions WHERE note_id = ? ORDER BY created_at DESC",
                        (note_id,),
                    ).fetchall()
            return [
                VersionRecord(
                    version_id=r[0], note_id=r[1], content_hash=r[2],
                    change_summary=r[3] or "", changed_at=r[4] or "",
                )
                for r in rows
            ]
        return await asyncio.to_thread(_do)

    async def get_version(self, note_id: str, version_id: str) -> str:
        """A.5: 从 .meta/version_backups/{version_id}.md 读取版本备份内容.

        校验: version_id 必须属于指定 note_id, 否则 KeyError.
        """
        def _do():
            with self._lock:
                with self._connect() as conn:
                    row = conn.execute(
                        "SELECT version_id FROM note_versions "
                        "WHERE version_id = ? AND note_id = ?",
                        (version_id, note_id),
                    ).fetchone()
            if not row:
                raise KeyError(f"Version {version_id} not found for note {note_id}")
            backup_path = self.root / ".meta" / "version_backups" / f"{version_id}.md"
            if not backup_path.exists():
                raise FileNotFoundError(f"Version backup missing: {backup_path}")
            return backup_path.read_text(encoding="utf-8")
        return await asyncio.to_thread(_do)
