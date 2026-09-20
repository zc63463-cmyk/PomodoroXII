"""session_type：focus_sessions 的「番茄钟模式」列（双体系兼容的事实维度）。

Revision ID: space_016_focus_session_type
Revises: space_015_relation_resolution
Create Date: 2026-09-16

★ 为什么必须写迁移
  space 库由 ``alembic_space/`` 建（与 meta 的 ``alembic/`` 是两套），只加
  ``app/models/focus_session.py`` 的列不写迁移 → 所有既有 space 都没有该列，
  症状是"代码看着全对、运行 no such column"。配套的
  ``task_space/migration_preflight.py`` 的 ``TASK_SPACE_TARGET_HEAD``
  也必须同步改成 ``space_016_focus_session_type``，否则启动直接拒绝
  （fleet preflight policy targets a different revision）。

★ 列语义（双体系兼容设计 2026-09-16）
  ``work`` / ``free`` / ``countdown`` = 投入型会话；``short_break`` /
  ``long_break`` = 休息型会话（focused_seconds 恒 0、免复盘、不进计划）。
  默认 ``work``：所有存量行（本列出现之前创建的会话）按"工作会话"解释，
  与旧口径（唯一形态就是工作会话）逐字一致，不是猜测。

★ 为什么本迁移**不**加 CHECK 约束（刻意，不是遗漏）
  1. 目标表 focus_sessions 被 5 张表以 FK 引用（session_task_contexts /
     session_command_envelopes / session_attribution_revisions /
     session_work_item_plans / session_work_item_outcomes），在 SQLite 上加
     CHECK 需要 batch copy-and-move 重建整表 + 期间关闭外键 —— 为一条枚举
     约束对 5 个真实库做整表重建，风险/收益不成比例（014 的破例有明确理由：
     必须加带 FK 的列；本列没有那个约束）。
  2. 既有先例：同表的 ``timer_completion`` / ``overall_progress`` 两个枚举列
     也没有 DB 级 CHECK，靠 policy + wire schema 双重校验。
  3. 本列的闭环校验点有三处，全部 fail-closed：
     ``policy._require_session_type``（REST 启动 / 离线快照 / sync create &
     update）、Pydantic ``Literal``（入站 schema）、zod ``enum``（前端契约）。

★ 幂等
  先 introspect focus_sessions 的列，已存在则跳过 —— 手工补建过的库与全新库
  都能安全通过（与 011 / 013 / 014 / 015 同款处理）。downgrade 同理 guard。
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect

# revision identifiers, used by Alembic.
revision: str = "space_016_focus_session_type"
down_revision: Union[str, None] = "space_015_relation_resolution"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_COLUMN_NAME = "session_type"


def _focus_session_column_names() -> set[str]:
    inspector = inspect(op.get_bind())
    return {column["name"] for column in inspector.get_columns("focus_sessions")}


def upgrade() -> None:
    """加列（幂等）：番茄钟模式；原生 ALTER ADD COLUMN，存量行取默认 'work'。"""
    if _COLUMN_NAME in _focus_session_column_names():
        return
    op.add_column(
        "focus_sessions",
        sa.Column(
            _COLUMN_NAME,
            sa.String(32),
            nullable=False,
            server_default="work",
        ),
    )


def downgrade() -> None:
    """删列（幂等）：已不存在即跳过（SQLite 3.35+ 原生 DROP COLUMN）。"""
    if _COLUMN_NAME not in _focus_session_column_names():
        return
    op.drop_column("focus_sessions", _COLUMN_NAME)
