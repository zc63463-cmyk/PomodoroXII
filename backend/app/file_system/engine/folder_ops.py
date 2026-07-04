"""FolderOpsMixin — 文件夹操作 (CRUD + 移动 + 重命名 + 删除 + 路径).

组合到 FileSystemStorage 后, 通过 self.root / self._lock / self._connect 等
访问 StorageBase 提供的基础设施.

Phase 1: 仅迁移已实现方法 + 4 个 NotImplementedError 桩
Phase 2: 替换 NotImplementedError 为真实实现 (A.1/A.2/A.3/A.4)
"""
from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone
from pathlib import Path

from app.file_system.interfaces import FolderMeta

from .base import _utc_now_iso


class FolderOpsMixin:
    """文件夹操作 Mixin — create/get/move/rename/delete/list/get_path."""

    async def create_folder(self, name: str, parent_id=None, icon="📁", color=None,
                            external_id=None) -> FolderMeta:
        def _do():
            with self._lock, self._file_lock:
                folder_id = external_id if external_id else uuid.uuid4().hex
                now = _utc_now_iso()
                with self._connect() as conn:
                    # ID 透传时检查冲突
                    if external_id:
                        exists = conn.execute(
                            "SELECT 1 FROM folders WHERE id = ?", (external_id,)
                        ).fetchone()
                        if exists:
                            raise ValueError(f"Folder id {external_id} already exists")
                    conn.execute(
                        "INSERT INTO folders (id, name, parent_id, icon, color, "
                        "created_at, updated_at) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?)",
                        (folder_id, name, parent_id, icon, color, now, now),
                    )
                    conn.commit()
                return FolderMeta(
                    id=folder_id, name=name, parent_id=parent_id, icon=icon,
                    color=color, created_at=now, updated_at=now,
                )
        return await asyncio.to_thread(_do)

    async def get_folder(self, folder_id: str) -> FolderMeta:
        def _do():
            with self._lock:
                with self._connect() as conn:
                    row = conn.execute(
                        "SELECT id, name, parent_id, icon, color, sort_order, "
                        "is_system, created_at, updated_at FROM folders WHERE id = ?",
                        (folder_id,),
                    ).fetchone()
            if not row:
                raise KeyError(f"Folder {folder_id} not found")
            return FolderMeta(
                id=row[0], name=row[1], parent_id=row[2], icon=row[3],
                color=row[4], sort_order=row[5], is_system=bool(row[6]),
                created_at=row[7] or "", updated_at=row[8] or "",
            )
        return await asyncio.to_thread(_do)

    async def move_folder(self, folder_id: str, new_parent_id) -> FolderMeta:
        """A.1: 移动文件夹 — 含环形引用检测.

        环形检测: 从 new_parent_id 向上遍历 parent_id, 若遇到 folder_id 则拒绝
        (即 new_parent_id 不能是 folder_id 的子孙或自身).
        若 folder_id 不存在, 抛 KeyError.
        若 new_parent_id 不存在或已 trashed, 抛 KeyError.
        """
        def _do():
            with self._lock, self._file_lock:
                now = _utc_now_iso()
                with self._connect() as conn:
                    row = conn.execute(
                        "SELECT id FROM folders WHERE id = ?", (folder_id,)
                    ).fetchone()
                    if not row:
                        raise KeyError(f"Folder {folder_id} not found")
                    if new_parent_id is not None:
                        parent = conn.execute(
                            "SELECT id FROM folders WHERE id = ? AND trashed_at IS NULL",
                            (new_parent_id,),
                        ).fetchone()
                        if not parent:
                            raise KeyError(f"Folder {new_parent_id} not found or trashed")
                        # 环形引用检测: new_parent_id 不能是 folder_id 的子孙或自身
                        # 等价: 从 new_parent_id 向上遍历, 若遇到 folder_id 则拒绝
                        cursor = new_parent_id
                        while cursor is not None:
                            if cursor == folder_id:
                                raise ValueError(
                                    f"Circular reference: cannot move {folder_id} "
                                    f"into its descendant {new_parent_id}"
                                )
                            up = conn.execute(
                                "SELECT parent_id FROM folders WHERE id = ?", (cursor,)
                            ).fetchone()
                            cursor = up[0] if up else None
                    conn.execute(
                        "UPDATE folders SET parent_id = ?, updated_at = ? WHERE id = ?",
                        (new_parent_id, now, folder_id),
                    )
                    conn.commit()
            return None
        await asyncio.to_thread(_do)
        return await self.get_folder(folder_id)

    async def rename_folder(self, folder_id: str, new_name: str) -> FolderMeta:
        """A.2: 重命名文件夹 — 含同 parent 下唯一性校验.

        若 folder_id 不存在, 抛 KeyError.
        若同 parent 下已存在同名文件夹 (排除自身), 抛 ValueError.
        """
        def _do():
            with self._lock, self._file_lock:
                now = _utc_now_iso()
                with self._connect() as conn:
                    row = conn.execute(
                        "SELECT id, parent_id FROM folders WHERE id = ?", (folder_id,)
                    ).fetchone()
                    if not row:
                        raise KeyError(f"Folder {folder_id} not found")
                    parent_id = row[1]
                    # 同 parent 下唯一性 (排除自身)
                    dup = conn.execute(
                        "SELECT id FROM folders WHERE parent_id IS ? AND name = ? AND id != ?",
                        (parent_id, new_name, folder_id),
                    ).fetchone()
                    if dup:
                        raise ValueError(
                            f"Folder named '{new_name}' already exists in same parent"
                        )
                    conn.execute(
                        "UPDATE folders SET name = ?, updated_at = ? WHERE id = ?",
                        (new_name, now, folder_id),
                    )
                    conn.commit()
            return None  # 实际 FolderMeta 在锁外重新查询返回
        # 先执行更新, 再用 get_folder 复用查询逻辑返回 FolderMeta
        await asyncio.to_thread(_do)
        return await self.get_folder(folder_id)

    async def edit_folder(
        self,
        folder_id: str,
        name: str | None = None,
        icon: str | None = None,
        color: str | None = None,
    ) -> FolderMeta:
        """编辑文件夹元数据 (name/icon/color). 部分更新: 仅更新非 None 字段.

        - name 变化时复用 rename_folder 的同 parent 唯一性校验
        - icon/color 直接覆盖 (允许传 None 显式清空 color, 但 name/icon 不允许 None 时清空)
        - 若 folder_id 不存在, 抛 KeyError
        - 若同 parent 下已存在同名 (排除自身), 抛 ValueError
        """
        def _do():
            with self._lock, self._file_lock:
                now = _utc_now_iso()
                with self._connect() as conn:
                    row = conn.execute(
                        "SELECT id, parent_id, name, icon, color FROM folders WHERE id = ?",
                        (folder_id,),
                    ).fetchone()
                    if not row:
                        raise KeyError(f"Folder {folder_id} not found")
                    parent_id, old_name, old_icon, old_color = row[1], row[2], row[3], row[4]

                    new_name = name if name is not None else old_name
                    new_icon = icon if icon is not None else old_icon
                    # color 约定: None = 不更新 (保持原值); "" = 显式清空
                    new_color = color if color is not None else old_color

                    # name 变化时校验同 parent 唯一性
                    if name is not None and name != old_name:
                        dup = conn.execute(
                            "SELECT id FROM folders WHERE parent_id IS ? AND name = ? AND id != ?",
                            (parent_id, new_name, folder_id),
                        ).fetchone()
                        if dup:
                            raise ValueError(
                                f"Folder named '{new_name}' already exists in same parent"
                            )

                    conn.execute(
                        "UPDATE folders SET name = ?, icon = ?, color = ?, updated_at = ? "
                        "WHERE id = ?",
                        (new_name, new_icon, new_color, now, folder_id),
                    )
                    conn.commit()
            return None
        await asyncio.to_thread(_do)
        return await self.get_folder(folder_id)

    async def delete_folder(self, folder_id: str) -> None:
        """A.3: 递归软删文件夹 — 设置 trashed_at, 子笔记入回收站.

        全部操作在单次锁内完成，消除 TOCTOU 竞态窗口：
        1. 校验 folder_id 存在且非系统文件夹 (is_system=0)
        2. BFS 递归收集所有子孙文件夹 id
        3. 收集该批次文件夹下所有非删除笔记
        4. 在同一锁内逐个将笔记 .md 移到 .trash/ + DB 标记 is_deleted
        5. 标记所有子孙文件夹 trashed_at
        """
        def _do():
            with self._lock, self._file_lock:
                now = _utc_now_iso()
                with self._connect() as conn:
                    row = conn.execute(
                        "SELECT is_system FROM folders WHERE id = ?", (folder_id,)
                    ).fetchone()
                    if not row:
                        raise KeyError(f"Folder {folder_id} not found")
                    if bool(row[0]):
                        raise ValueError(f"Cannot delete system folder {folder_id}")
                    # BFS 递归收集所有子孙文件夹 id
                    to_trash_folders = []
                    queue = [folder_id]
                    while queue:
                        current = queue.pop()
                        to_trash_folders.append(current)
                        children = conn.execute(
                            "SELECT id FROM folders WHERE parent_id = ?", (current,)
                        ).fetchall()
                        queue.extend(c[0] for c in children)
                    # 收集该批次文件夹下所有未删除笔记
                    placeholders = ",".join("?" * len(to_trash_folders))
                    note_rows = conn.execute(
                        f"SELECT note_id, current_path FROM notes WHERE folder_id IN ({placeholders}) "
                        f"AND is_deleted = 0",
                        to_trash_folders,
                    ).fetchall()
                    # 在同一锁内逐个将笔记移到回收站（内联 delete_note 逻辑）
                    for note_row in note_rows:
                        note_id = note_row[0]
                        rel_path = note_row[1]
                        abs_path = self.root / rel_path
                        # Timestamped trash filename to avoid collision
                        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")
                        trash_filename = f"{Path(rel_path).stem}-{timestamp}.md"
                        trash_rel = f".trash/{trash_filename}"
                        trash_path = self.root / trash_rel
                        if abs_path.exists():
                            abs_path.rename(trash_path)
                        conn.execute(
                            "UPDATE notes SET is_deleted = 1, status = ?, current_path = ?, "
                            "updated_at = ? WHERE note_id = ?",
                            ("trashed", trash_rel, now, note_id),
                        )
                    # 标记所有子孙文件夹 trashed_at
                    conn.executemany(
                        "UPDATE folders SET trashed_at = ?, updated_at = ? WHERE id = ?",
                        [(now, now, fid) for fid in to_trash_folders],
                    )
                    conn.commit()
        await asyncio.to_thread(_do)

    async def list_folders(self, parent_id=None) -> list[FolderMeta]:
        """E.3: 列出文件夹, 排除已 trashed 的文件夹."""
        def _do():
            with self._lock:
                with self._connect() as conn:
                    if parent_id is None:
                        rows = conn.execute(
                            "SELECT id, name, parent_id, icon, color, sort_order, "
                            "is_system, created_at, updated_at FROM folders "
                            "WHERE parent_id IS NULL AND trashed_at IS NULL "
                            "ORDER BY sort_order, name"
                        ).fetchall()
                    else:
                        rows = conn.execute(
                            "SELECT id, name, parent_id, icon, color, sort_order, "
                            "is_system, created_at, updated_at FROM folders "
                            "WHERE parent_id = ? AND trashed_at IS NULL "
                            "ORDER BY sort_order, name",
                            (parent_id,),
                        ).fetchall()
            return [
                FolderMeta(
                    id=r[0], name=r[1], parent_id=r[2], icon=r[3],
                    color=r[4], sort_order=r[5], is_system=bool(r[6]),
                    created_at=r[7] or "", updated_at=r[8] or "",
                )
                for r in rows
            ]
        return await asyncio.to_thread(_do)

    async def get_folder_path(self, folder_id: str) -> list[FolderMeta]:
        """A.4: 返回从根到当前文件夹的完整路径 (面包屑导航).

        从 folder_id 开始向上遍历 parent_id, 反转后返回 [根, ..., 当前].
        若 folder_id 不存在, 抛 KeyError.
        """
        def _do():
            chain = []
            current_id = folder_id
            with self._lock, self._connect() as conn:
                while current_id is not None:
                    row = conn.execute(
                        "SELECT id, name, parent_id, icon, color, sort_order, "
                        "is_system, created_at, updated_at FROM folders WHERE id = ?",
                        (current_id,),
                    ).fetchone()
                    if not row:
                        raise KeyError(f"Folder {current_id} not found")
                    chain.append(FolderMeta(
                        id=row[0], name=row[1], parent_id=row[2], icon=row[3],
                        color=row[4], sort_order=row[5], is_system=bool(row[6]),
                        created_at=row[7] or "", updated_at=row[8] or "",
                    ))
                    current_id = row[2]
            chain.reverse()
            return chain
        return await asyncio.to_thread(_do)
