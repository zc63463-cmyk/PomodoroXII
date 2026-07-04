"""FileSystemStorage — 文件系统存储实现 (Mixin 组合).

由 8 个 Mixin 组合而成, 每个 Mixin 负责一类操作:
- StorageBase: __init__, DB 连接, 锁, 原子写入, FTS5 维护, 生命周期
- NoteOpsMixin: create/read/move/edit/delete/list notes
- FolderOpsMixin: create/get/move/rename/delete/list folders + get_folder_path
- SearchOpsMixin: FTS5 search + LIKE fallback + search_in_folder
- TrashOpsMixin: list_trash/restore/purge/empty_trash
- VersionOpsMixin: list_versions + get_version (Phase 2)
- ExportOpsMixin: export_to_md/import_from_md + export_folder (Phase 2)
- ConsistencyOpsMixin: check_consistency/repair/get_stats

外部导入路径不变: `from app.file_system.engine import FileSystemStorage`
"""
from __future__ import annotations

from app.file_system.interfaces import FileSystem
from .base import StorageBase
from .note_ops import NoteOpsMixin
from .folder_ops import FolderOpsMixin
from .search_ops import SearchOpsMixin
from .trash_ops import TrashOpsMixin
from .version_ops import VersionOpsMixin
from .export_ops import ExportOpsMixin
from .consistency_ops import ConsistencyOpsMixin


class FileSystemStorage(
    StorageBase,
    NoteOpsMixin,
    FolderOpsMixin,
    SearchOpsMixin,
    TrashOpsMixin,
    VersionOpsMixin,
    ExportOpsMixin,
    ConsistencyOpsMixin,
    FileSystem,
):
    """文件系统存储 — .md 文件 + SQLite 索引 + FTS5 全文搜索.

    由 8 个 Mixin 组合而成, 三层锁: RLock → FileLock → SQLite 事务.
    note_id 解耦: note_id 是唯一标识, 文件路径只是存储位置.
    """
    pass


__all__ = ["FileSystemStorage"]
