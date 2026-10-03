"""due_at：工作项的「截止日期」列（本单最小闭环的第一步，不进 sync 白名单）。

Revision ID: space_018_due_at
Revises: space_017_status_dual_axis
Create Date: 2026-10-03

★ 为什么必须写迁移
  space 库由 ``alembic_space/`` 建（与 meta 的 ``alembic/`` 是两套），只加
  ``app/models/work_item.py`` 的列不写迁移 → 所有既有 space 都没有该列，
  症状是"代码看着全对、运行 no such column"（014 的 docstring 记录过 assets
  的同类事故）。配套的 ``task_space/migration_preflight.py`` 的
  ``TASK_SPACE_TARGET_HEAD`` 也必须同步改成 ``space_018_due_at``，否则启动
  直接拒绝（fleet preflight policy targets a different revision；
  016/017 的 docstring 记录了 assets 与 status 各踩过一次）。

★ 为什么是纯 ADD COLUMN（对比 014 / 017 的重建成本）
  ``due_at`` 是无 ForeignKey、无 CHECK、无 UQ 的可空标量列：
  - SQLite 原生 ``ALTER TABLE ... ADD COLUMN`` 即可完成，**不需要**
    ``batch_alter_table`` copy-and-move 重建整表（014 是因为要加带 FK 的列、
    017 是因为要改 CHECK / 删表级 UQ —— SQLite 都不支持原地变更）；
  - 不重建 ⇒ 不走 SQLite 12 步流程，也就完全不涉及
    ``PRAGMA foreign_keys`` 的关闭/恢复（014:74-119 与 017:180-226 的
    全部额外成本在本迁移为零）；
  - ADD COLUMN 常量默认值之外不会改写任何既有行，行数天然不变。

★ 列语义（本单裁决，勿顺手扩大）
  用户诉求是「任务什么时候要」⇒ 一个截止时间点即可。与既有的
  ``completion_window_* / review_point / hard_deadline`` 等 DORMANT 柔性
  计划字段（真实数据 0 使用）**无关**：本迁移只补最基础且证据最强的一个，
  不激活那 8 个字段。可空：NULL = 无截止（大多数任务没有）。
  值域不做 DB 级 CHECK（与同族 ``hard_deadline`` 等一致，值域校验在
  schema/编译器层做，避免未来放宽口径时再重建表）。

★ 与同步协议的关系（重要，防误读）
  本迁移只落 DB 列 + ORM + FieldSpec + 行形状管线；``due_at``
  **不在** ``WORK_ITEM_SYNC_FIELDS``（入站 push 精确相等校验照旧，携带即拒）。
  出站 pull / sync 事件按 ORM 全列模型驱动自然带出（只出不进）。
  进白名单（路径 3）是下一工单的事。

★ 幂等
  先 introspect ``work_items`` 的列，已存在则跳过 —— 手工补建过的库与全新库
  都能安全通过（与 011 / 013 / 014 同款处理）。downgrade 同理 guard 后
  原生 ``DROP COLUMN``（SQLite >= 3.35 支持；本仓实测 3.53.1。该列无索引、
  无 FK 引用，不受 DROP COLUMN 限制项约束）。
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect

# revision identifiers, used by Alembic.
revision: str = "space_018_due_at"
down_revision: Union[str, None] = "space_017_status_dual_axis"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_COLUMN_NAME = "due_at"


def _work_item_column_names() -> set[str]:
    inspector = inspect(op.get_bind())
    return {column["name"] for column in inspector.get_columns("work_items")}


def upgrade() -> None:
    """加列（幂等）：纯 ADD COLUMN，无重建、无 PRAGMA 开关。"""
    if _COLUMN_NAME in _work_item_column_names():
        return
    op.add_column("work_items", sa.Column(_COLUMN_NAME, sa.String(32), nullable=True))
    # 补偿校验（017 惯例）：列确实存在 + 全库外键完好。
    # 纯 ADD COLUMN 理论上不可能引入 FK 破损，但校验成本极低、
    # 比事后排查便宜得多。
    if _COLUMN_NAME not in _work_item_column_names():
        raise RuntimeError(
            "space_018_due_at reported success but the column is missing"
        )
    violations = op.get_bind().exec_driver_sql("PRAGMA foreign_key_check").fetchall()
    if violations:
        raise RuntimeError(
            f"space_018_due_at left FK violations: {violations[:5]}"
        )


def downgrade() -> None:
    """删列（幂等）：SQLite 原生 DROP COLUMN（该列无索引/FK 引用）。"""
    if _COLUMN_NAME not in _work_item_column_names():
        return
    op.drop_column("work_items", _COLUMN_NAME)
