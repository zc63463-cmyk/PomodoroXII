"""ExportOpsMixin — 导入导出 (单笔记 + 批量文件夹).

组合到 FileSystemStorage 后, 通过 self.root / self._lock / self._connect 等
访问 StorageBase 提供的基础设施.

Phase 1: 仅迁移 export_to_md / import_from_md 实现 + export_folder 桩
Phase 2 (A.6): 实现 export_folder — 递归收集笔记打包为 ZIP
"""
from __future__ import annotations

import asyncio
import json
import zipfile
from pathlib import Path

from app.file_system.interfaces import NoteMeta

from .base import _utc_now_iso


class ExportOpsMixin:
    """导入导出操作 Mixin — export_to_md / import_from_md / export_folder."""

    async def export_to_md(self, note_id: str) -> str:
        return await self.read_note(note_id)

    async def import_from_md(self, file_path: str, folder_id=None) -> NoteMeta:
        def _do():
            path = Path(file_path)
            title = path.stem
            content = path.read_text(encoding="utf-8")
            return content, title
        content, title = await asyncio.to_thread(_do)
        return await self.create_note(title=title, content=content, folder_id=folder_id)

    async def export_folder(self, folder_id: str, output_dir: str) -> str:
        """A.6: 递归收集文件夹下所有笔记打包为 ZIP.

        返回: 生成的 ZIP 文件绝对路径.
        ZIP 结构:
          - manifest.json  (folder 元数据 + 笔记清单)
          - notes/<filename>.md  (按原文件名扁平化)
        校验: folder_id 不存在或已 trashed → KeyError.
        """
        def _collect():
            with self._lock, self._connect() as conn:
                conn.row_factory = __import__("sqlite3").Row
                folder = conn.execute(
                    "SELECT id, name FROM folders WHERE id = ? AND trashed_at IS NULL",
                    (folder_id,),
                ).fetchone()
                if not folder:
                    raise KeyError(f"Folder {folder_id} not found or trashed")
                # BFS 递归收集所有子孙文件夹 id
                folder_ids = [folder_id]
                queue = [folder_id]
                while queue:
                    cur = queue.pop()
                    children = conn.execute(
                        "SELECT id FROM folders WHERE parent_id = ? AND trashed_at IS NULL",
                        (cur,),
                    ).fetchall()
                    queue.extend(c[0] for c in children)
                    folder_ids.extend(c[0] for c in children)
                # 收集这些文件夹下的所有非删除笔记
                placeholders = ",".join("?" * len(folder_ids))
                notes = conn.execute(
                    f"SELECT note_id, title, current_path FROM notes "
                    f"WHERE folder_id IN ({placeholders}) AND is_deleted = 0",
                    folder_ids,
                ).fetchall()
            return folder, notes

        folder, notes = await asyncio.to_thread(_collect)
        # 在锁外构建 ZIP (避免长时间持锁)
        def _build_zip():
            out = Path(output_dir)
            out.mkdir(parents=True, exist_ok=True)
            zip_path = out / f"{folder['name']}-{folder_id[:8]}.zip"
            with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
                manifest = {
                    "folder_id": folder_id,
                    "folder_name": folder["name"],
                    "exported_at": _utc_now_iso(),
                    "notes": [],
                }
                for n in notes:
                    abs_path = self.root / n["current_path"]
                    content = abs_path.read_text(encoding="utf-8") if abs_path.exists() else ""
                    arcname = f"notes/{Path(n['current_path']).name}"
                    zf.writestr(arcname, content)
                    manifest["notes"].append({
                        "note_id": n["note_id"],
                        "title": n["title"],
                        "filename": Path(n["current_path"]).name,
                    })
                zf.writestr(
                    "manifest.json",
                    json.dumps(manifest, ensure_ascii=False, indent=2),
                )
            return str(zip_path)
        return await asyncio.to_thread(_build_zip)
