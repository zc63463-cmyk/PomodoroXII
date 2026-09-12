"""relation_resolution：依赖边的「解除确认」两列（服务端自持，唯一写入者 = ResolveDependency）。

Revision ID: space_015_relation_resolution
Revises: space_014_pre_waiting_status
Create Date: 2026-09-12

★ 为什么必须写迁移
  space 库由 ``alembic_space/`` 建（与 meta 的 ``alembic/`` 是两套），只加
  ``app/models/relation.py`` 的列不写迁移 → 所有既有 space 都没有该列，
  症状是"代码看着全对、运行 no such column"（assets 踩过一次同类）。
  配套的 ``task_space/migration_preflight.py`` 的 ``TASK_SPACE_TARGET_HEAD``
  也必须同步改成 ``space_015_relation_resolution``，否则启动直接拒绝
  （fleet preflight policy targets a different revision）。

★ 列语义（ADR-0004 / 依赖域合同修订版 §3.4 + §4.2）
  合同要求「cancelled 不是完成，不能自动解除依赖；它产生
  ``broken_requires_resolution``」，确认后才算 satisfied。确认是**显式用户事实**，
  不能由状态变化或同步重放隐式生成 ⇒ 必须落库两列：
  - ``resolution``：'confirmed_not_required' | NULL（字符串而非布尔 —— 未来可能
    引入其它 resolution 取值，Q2 已裁决）。
  - ``resolved_at``：服务端单调时钟戳（防伪；外部 schema extra="forbid" 拒收
    调用方自带时间戳）。
  关系的三态（satisfied / broken_requires_resolution / open）是纯派生，
  **绝不落库**（queries.py 的既有红线），落库的只有这两列。

★ 为什么本迁移不用 batch_alter_table（014 的例外不适用于此）
  014 走 batch copy-and-move 的唯一原因是给列加**具名 FK**（SQLite 无法为
  ALTER 加的外键命名 ⇒ 与 ORM 命名约定的 parity 冲突）。本迁移的两列：
  - 均为 nullable、无 FK、无索引、无 CHECK、无 server default；
  - SQLite 3.35+ 原生 ``ALTER TABLE ... ADD COLUMN`` / ``DROP COLUMN`` 均支持
    （实测运行环境 SQLite 3.53.1）。
  ⇒ 原生 ALTER 就够，不做重建；既避免重写带数据的关系表，也不再破例。

★ 幂等
  先 introspect relations 的列，已存在则跳过 —— 手工补建过的库与全新库都能安全
  通过（与 011 / 013 / 014 同款处理）。downgrade 同理 guard 后再删列。
"""

from typing import Sequence, Union

from alembic import op
from sqlalchemy import inspect

# revision identifiers, used by Alembic.
revision: str = "space_015_relation_resolution"
down_revision: Union[str, None] = "space_014_pre_waiting_status"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_COLUMNS = (
    ("resolution", "VARCHAR(64)"),
    ("resolved_at", "VARCHAR(32)"),
)


def _relation_column_names() -> set[str]:
    inspector = inspect(op.get_bind())
    return {column["name"] for column in inspector.get_columns("relations")}


def upgrade() -> None:
    """加两列（幂等）：解除确认。原生 ALTER；已存在即跳过。"""
    existing = _relation_column_names()
    for name, ddl_type in _COLUMNS:
        if name in existing:
            continue
        op.execute(f"ALTER TABLE relations ADD COLUMN {name} {ddl_type}")


def downgrade() -> None:
    """删两列（幂等）：同样原生 ALTER DROP COLUMN；已不存在即跳过。"""
    existing = _relation_column_names()
    for name, _ in _COLUMNS:
        if name not in existing:
            continue
        op.execute(f"ALTER TABLE relations DROP COLUMN {name}")
