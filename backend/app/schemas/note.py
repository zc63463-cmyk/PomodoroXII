"""Pydantic schemas for notes.

Key design difference from the source project (06 deficiency #7): the note
*body* lives on the filesystem (a ``.md`` file), so only ``content_hash`` +
``word_count`` are persisted on the DB row. ``NoteCreate`` and ``NoteUpdate``
both accept ``content`` (so the route can write the ``.md`` file), but
``NoteResponse`` deliberately excludes ``content`` — clients reconcile edits
via ``content_hash`` instead of round-tripping the full body.
"""

import json
from typing import Literal, Optional, TypeAlias, get_args

from pydantic import BaseModel, Field, field_validator

# --------------------------------------------------------------------------- #
# ★ 2026-09-11 note.status 枚举值域：单一事实来源。
#   原因：DB CHECK / Pydantic wire schema / 编译器此前各写各的 —— schema 只限
#   长度、sync post-image 编译器不校验值域，于是「草稿」这类越界值会穿过前后端
#   校验，最后撞上 notes 的 CHECK 约束：HTTP 以不可读的 500 收场，并污染该
#   Space 运行时会话（后续合法请求也一并失败）。
#   Literal 是唯一声明：wire schema（创建/更新/响应）直接用它；编译器校验
#   （KnowledgeDomainPolicy，REST 与 sync 共用）从常量派生。
#   models/note.py 的 CHECK SQL 文本由 tests 逐字锁定（本轮不改 DB 迁移）。
#   note 目前没有独立的 contracts 模块，故按约定就近落在本模块。
# --------------------------------------------------------------------------- #

NoteStatusValue: TypeAlias = Literal["active", "archived"]
# 声明顺序即错误详情 allowed 的稳定顺序（get_args 保留声明序）。
NOTE_STATUS_VALUES: tuple[str, ...] = get_args(NoteStatusValue)


def require_note_status(value: object) -> str:
    """Fail closed when status falls outside its closed domain.

    与 ``task_space.contracts.require_enum_value`` 的差异（note.status 是
    NOT NULL 列 + 默认值，而非可空自由字段）：``None`` 不合法 —— 显式传 null
    会在 DB 触发 NOT NULL；「字段缺省」由调用方判断（创建补默认值、更新表示
    不改动），本函数只校验「给了值」的场合。
    """
    if not isinstance(value, str) or value not in NOTE_STATUS_VALUES:
        raise ValueError("invalid_status")
    return value


class NoteBase(BaseModel):
    """Base fields shared by note schemas (excludes filesystem content)."""

    title: str = Field(default="", max_length=500)
    summary: str = Field(default="", max_length=500)
    tags: list[str] = []
    folder_id: Optional[str] = Field(default=None, max_length=36)
    # ★ 2026-09-11：值域与 DB CHECK / 编译器共用 NOTE_STATUS_VALUES —— 越界值
    # 在 wire 层即 422，绝不允许穿到 DB CHECK（那里是 500 且不可读）。
    status: NoteStatusValue = "active"

    @field_validator("tags", mode="before")
    @classmethod
    def parse_tags(cls, v: object) -> list[str]:
        """Parse JSON string to list when loading from ORM."""
        if isinstance(v, str):
            return json.loads(v) if v else []
        return v  # type: ignore[return-value]


class NoteCreate(NoteBase):
    """Schema for creating a new note.

    ``content`` is accepted here so the route can write the body to a ``.md``
    file; it is NOT persisted on the DB row (only content_hash + word_count).
    """

    content: str = Field(default="", max_length=100000)
    id: Optional[str] = Field(default=None, max_length=36)


class NoteUpdate(BaseModel):
    """Schema for the deprecated ``PUT /notes/{id}`` dispatcher.

    ``content`` is accepted so the route can dispatch it to
    ``NoteService.update_content()`` which rewrites the ``.md`` file.
    Metadata fields are persisted on the DB row only.

    Prefer ``PATCH /notes/{id}`` (metadata only) + ``PUT /notes/{id}/content``
    (content only) -- this schema is kept for backward compatibility and will
    be removed in the next major.
    """

    title: Optional[str] = Field(default=None, max_length=500)
    content: Optional[str] = Field(default=None, max_length=100000)
    content_hash: Optional[str] = Field(default=None, max_length=64)
    summary: Optional[str] = Field(default=None, max_length=500)
    tags: Optional[list[str]] = None
    folder_id: Optional[str] = Field(default=None, max_length=36)

    @field_validator("tags", mode="before")
    @classmethod
    def parse_tags(cls, v: object) -> object:
        """Parse JSON string to list when arriving from sync push."""
        if isinstance(v, str):
            return json.loads(v) if v else []
        return v


class NoteMetadataUpdate(BaseModel):
    """Schema for ``PATCH /notes/{id}`` -- metadata only, does NOT write .md.

    Content-managed fields (``content``, ``content_hash``, ``word_count``)
    are intentionally absent: clients must use ``PUT /notes/{id}/content``
    to rewrite the ``.md`` body.
    """

    title: Optional[str] = Field(default=None, max_length=500)
    summary: Optional[str] = Field(default=None, max_length=500)
    tags: Optional[list[str]] = None
    folder_id: Optional[str] = Field(default=None, max_length=36)
    category: Optional[str] = Field(default=None, max_length=200)
    # ★ 2026-09-11：PATCH 的 status 同样收紧到封闭值域（与创建/响应同一常量）。
    # 显式 null 由编译器以稳定领域码拒绝（status 是 NOT NULL 列，不能清空）。
    status: Optional[NoteStatusValue] = None

    @field_validator("tags", mode="before")
    @classmethod
    def parse_tags(cls, v: object) -> object:
        """Parse JSON string to list when arriving from sync push."""
        if isinstance(v, str):
            return json.loads(v) if v else []
        return v


class NoteUpdateContent(BaseModel):
    """Schema for ``PUT /notes/{id}/content`` -- rewrites the .md body.

    Accepts a single ``content`` field. The route also tolerates a
    ``text/plain`` request body (parsed manually via ``Request``).
    """

    content: str = Field(..., max_length=100000)


class NoteResponse(NoteBase):
    """Schema for note API responses.

    Excludes ``content`` (lives on the filesystem); exposes ``content_hash``
    and ``word_count`` for integrity checks and display metrics.
    """

    id: str
    content_hash: str = ""
    word_count: int = 0
    trashed_at: Optional[str] = None
    created_at: str
    updated_at: str
    version: int = 1

    model_config = {"from_attributes": True}


class NoteSearchResultItem(BaseModel):
    """Schema for note search results.

    Field-aligned with ``app.file_system.interfaces.SearchResult``.
    """

    note_id: str
    title: str
    folder_id: Optional[str] = None
    excerpt: str = ""
    score: float = 0.0


class VersionRecordResponse(BaseModel):
    """Schema for note version history entries.

    Field-aligned with ``app.file_system.interfaces.VersionRecord``.
    """

    version_id: str
    note_id: str
    content_hash: str
    changed_at: str
    change_summary: str

    model_config = {"from_attributes": True}
