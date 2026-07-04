"""通用虚拟文件系统接口层。

试验田实现：FileSystemStorage（文件系统存储 .md + SQLite 索引）
pomodoroxi 复用：DBFileSystemStorage（SQLAlchemy DB 存储）
两者共享：相同的接口，前端和 Agent 无感知。
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional
from enum import StrEnum


class NoteStatus(StrEnum):
    ACTIVE = "active"
    ARCHIVED = "archived"
    TRASHED = "trashed"


class NoteLevel(StrEnum):
    L1 = "L1"
    L2 = "L2"
    L3 = "L3"


@dataclass(frozen=True)
class FolderMeta:
    """文件夹元数据 — 与 pomodoroxi 的 Folder 模型对齐。"""
    id: str
    name: str
    parent_id: Optional[str] = None
    icon: str = "📁"
    color: Optional[str] = None
    sort_order: int = 0
    is_system: bool = False
    created_at: str = ""
    updated_at: str = ""


@dataclass(frozen=True)
class NoteMeta:
    """笔记元数据 — 与 pomodoroxi 的 Note 模型对齐。"""
    id: str
    title: str = ""
    folder_id: Optional[str] = None
    level: NoteLevel = NoteLevel.L1
    status: NoteStatus = NoteStatus.ACTIVE
    tags: list[str] = field(default_factory=list)
    content_hash: str = ""
    word_count: int = 0
    created_at: str = ""
    updated_at: str = ""


@dataclass(frozen=True)
class SearchResult:
    """搜索结果。"""
    note_id: str
    title: str
    folder_id: Optional[str]
    excerpt: str
    score: float


@dataclass(frozen=True)
class VersionRecord:
    """版本历史记录（轻量）。"""
    version_id: str
    note_id: str
    content_hash: str
    changed_at: str
    change_summary: str


class FileSystem(ABC):
    """通用虚拟文件系统接口。

    所有方法均为 async，与 pomodoroxi 的 async SQLAlchemy 对齐。
    试验田实现中可通过 asyncio.to_thread() 桥接 sync 文件操作。
    """

    @abstractmethod
    async def init(self) -> None:
        ...

    @abstractmethod
    async def close(self) -> None:
        ...

    @abstractmethod
    async def create_folder(self, name: str, parent_id: Optional[str] = None,
                            icon: str = "📁", color: Optional[str] = None,
                            external_id: Optional[str] = None) -> FolderMeta:
        ...

    @abstractmethod
    async def get_folder(self, folder_id: str) -> FolderMeta:
        ...

    @abstractmethod
    async def move_folder(self, folder_id: str, new_parent_id: Optional[str]) -> FolderMeta:
        ...

    @abstractmethod
    async def rename_folder(self, folder_id: str, new_name: str) -> FolderMeta:
        ...

    @abstractmethod
    async def edit_folder(
        self,
        folder_id: str,
        name: Optional[str] = None,
        icon: Optional[str] = None,
        color: Optional[str] = None,
    ) -> FolderMeta:
        ...

    @abstractmethod
    async def delete_folder(self, folder_id: str) -> None:
        ...

    @abstractmethod
    async def list_folders(self, parent_id: Optional[str] = None) -> list[FolderMeta]:
        ...

    @abstractmethod
    async def get_folder_path(self, folder_id: str) -> list[FolderMeta]:
        ...

    @abstractmethod
    async def create_note(
        self,
        title: str,
        content: str,
        folder_id: Optional[str] = None,
        level: NoteLevel = NoteLevel.L1,
        tags: Optional[list[str]] = None,
        external_id: Optional[str] = None,
    ) -> NoteMeta:
        ...

    @abstractmethod
    async def read_note(self, note_id: str) -> str:
        ...

    @abstractmethod
    async def read_note_meta(self, note_id: str) -> NoteMeta:
        ...

    @abstractmethod
    async def move_note(self, note_id: str, target_folder_id: Optional[str]) -> NoteMeta:
        ...

    @abstractmethod
    async def edit_note(self, note_id: str, content: str) -> NoteMeta:
        ...

    @abstractmethod
    async def edit_note_meta(
        self, note_id: str, title: Optional[str] = None, tags: Optional[list[str]] = None
    ) -> NoteMeta:
        ...

    @abstractmethod
    async def delete_note(self, note_id: str) -> None:
        ...

    @abstractmethod
    async def list_notes(
        self, folder_id: Optional[str] = None, status: Optional[NoteStatus] = None
    ) -> list[NoteMeta]:
        ...

    @abstractmethod
    async def get_note_by_path(self, path: str) -> NoteMeta:
        ...

    @abstractmethod
    async def search(self, query: str, limit: int = 20) -> list[SearchResult]:
        ...

    @abstractmethod
    async def search_in_folder(self, folder_id: str, query: str, limit: int = 20) -> list[SearchResult]:
        ...

    @abstractmethod
    async def list_trash(self) -> list[dict]:
        ...

    @abstractmethod
    async def restore(self, note_id: str) -> NoteMeta:
        ...

    @abstractmethod
    async def purge(self, note_id: str) -> None:
        ...

    @abstractmethod
    async def empty_trash(self) -> int:
        ...

    @abstractmethod
    async def export_to_md(self, note_id: str) -> str:
        ...

    @abstractmethod
    async def import_from_md(self, file_path: str, folder_id: Optional[str] = None) -> NoteMeta:
        ...

    @abstractmethod
    async def export_folder(self, folder_id: str, output_dir: str) -> str:
        ...

    @abstractmethod
    async def list_versions(self, note_id: str) -> list[VersionRecord]:
        ...

    @abstractmethod
    async def get_version(self, note_id: str, version_id: str) -> str:
        ...

    @abstractmethod
    async def check_consistency(self) -> dict:
        ...

    @abstractmethod
    async def repair(self, report: dict) -> dict:
        ...

    @abstractmethod
    async def get_stats(self) -> dict:
        ...
