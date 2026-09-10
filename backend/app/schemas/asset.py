"""Pydantic wire schema for the note-asset entity.

★ 为什么单独成模块
  门禁 `tests/test_parity_registry_schemas.py` 要求每个 BUSINESS 实体都有可导入的
  ``app.schemas.<name>`` 模块，并导出 ``<Name>Response``。``asset`` 于
  `registry/builtin.py:464` 登记为 BUSINESS（DB_ONLY / sync_enabled=False），
  因此必须有本模块 —— 此前一直缺，parity 门禁长期红着两项。

★ 为什么响应里没有 storage_key 之外的路径信息
  ``storage_key`` 是**相对** space 根目录的路径（如 ``assets/ab/abcd….png``）。
  它不能直接当 URL 用；客户端必须经 ``/assets/{id}/content`` 取流，由服务端做
  路径拼接与越权校验。把绝对路径放进 wire 会同时泄露宿主机布局并诱导客户端绕过校验。
"""
from __future__ import annotations

from pydantic import Field

from app.schemas.task_space import WireResponseModel


class AssetResponse(WireResponseModel):
    """One stored binary asset's metadata (never the bytes)."""

    id: str
    filename: str
    mime: str
    size: int = Field(ge=0)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    storage_key: str
    created_at: str
    updated_at: str
    version: int = Field(ge=1)


class AssetPageResponse(WireResponseModel):
    items: list[AssetResponse]
    next_cursor: str | None
