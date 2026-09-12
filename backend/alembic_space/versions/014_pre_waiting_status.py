"""pre_waiting_status_definition_id：工作项的「等待前态」列（读投影事实，不进 sync 白名单）。

Revision ID: space_014_pre_waiting_status
Revises: space_013_relations
Create Date: 2026-09-12

★ 为什么必须写迁移
  space 库由 ``alembic_space/`` 建（与 meta 的 ``alembic/`` 是两套），只加
  ``app/models/work_item.py`` 的列不写迁移 → 所有既有 space 都没有该列，
  症状是"代码看着全对、运行 no such column"（assets 踩过一次同类）。
  配套的 ``task_space/migration_preflight.py`` 的 ``TASK_SPACE_TARGET_HEAD``
  也必须同步改成 ``space_014_pre_waiting_status``，否则启动直接拒绝
  （fleet preflight policy targets a different revision）。

★ 列语义（ADR-0003）
  「最后一次进入类目为 waiting 的状态之前所处的状态」的服务端事实；唯一写入者
  是进入 Waiting 的那次迁移编译。可空：NULL = 无可信前态（绝不猜）。
  只走读投影（pull / full / sync 事件按 ORM 全列模型驱动带出），
  **不进** ``WORK_ITEM_SYNC_FIELDS``（入站 push 仍精确相等校验）。

★ 为什么本迁移破例使用 batch_alter_table（2026-09-12 一次性例外，勿当先例照抄）
  目标：给 work_items 加一列带 ``ForeignKey`` 的列。
  - ``op.add_column`` 带 ``sa.ForeignKey`` 在 SQLite 方言上直接
    ``NotImplementedError: No support for ALTER of constraints in SQLite dialect``；
  - 不重建的原生 ``ALTER TABLE ... ADD COLUMN ... REFERENCES`` 可行，但 SQLite
    无法为 ALTER 加的外键命名 ⇒ 反射 FK 名为 NULL，而 ORM 侧的 naming_convention
    必然生成 ``fk_work_items_pre_waiting_status_definition_id_status_definitions``
    ⇒ 与 ``tests/test_parity_alembic_metadata.py`` 的 schema parity 闸门冲突
    （实测差异仅此一条；试图用 ``sqlalchemy.sql.base._NONE_NAME`` 让 ORM 侧匿名
    在 SQLAlchemy 2.0.51 上不生效）。
  ⇒ 决策（2026-09-12 用户裁决，转为例外）：走 batch copy-and-move 重建。
  破例依据 + 补偿控制：
  - batch 重建在本仓库不是新风险，是既有惯例（001/003/007/009/010/011 共 20+ 处，
    含 sync_outbox / sync_state / tombstones / sessions 等带真实数据的表）；
  - work_items 上没有会被重建静默波及的附属对象（全库触发器只有 notes 的 3 个
    FTS 触发器，无视图；引用 work_items.id 的均为普通 FK，batch 会原样重建）；
  - 重建期间 ``PRAGMA foreign_keys=OFF``（SQLite 12 步流程：连接默认 ON，而
    ``DROP TABLE work_items`` 在有引用行时必须无 FK 强制），重建后恢复；
    关闭失败（事务内 no-op）即报错回滚，绝不带着 ON 硬走；
  - upgrade / downgrade 均在重建前后断言 ``count(*) FROM work_items`` 相等；
  - 重建后执行 ``PRAGMA foreign_key_check``，非空即抛错（同一事务回滚）；
  - 已在真实 space 库副本上预演（2c1b5b92 等 5 个库：行数与 FK 完好）。

★ 幂等
  先 introspect work_items 的列，已存在则跳过 —— 手工补建过的库与全新库都能安全通过
  （与 011 / 013 同款处理）。downgrade 同理 guard 后再重建删列。
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect

# revision identifiers, used by Alembic.
revision: str = "space_014_pre_waiting_status"
down_revision: Union[str, None] = "space_013_relations"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_COLUMN_NAME = "pre_waiting_status_definition_id"


def _work_item_column_names() -> set[str]:
    inspector = inspect(op.get_bind())
    return {column["name"] for column in inspector.get_columns("work_items")}


def _work_item_row_count() -> int:
    bind = op.get_bind()
    return int(bind.exec_driver_sql("SELECT count(*) FROM work_items").scalar() or 0)


def _rebuild_work_items(apply_change) -> None:
    """batch 重建 work_items；重建期间必须 ``PRAGMA foreign_keys=OFF``。

    ★ 2026-09-12 实测（真实库 2c1b5b92 副本）：``sqlite_vfs`` 的所有连接都强制
    ``PRAGMA foreign_keys=ON``（app/runtime/sqlite_vfs.py:578/613），而 SQLite 的
    copy-and-move 第 8 步 ``DROP TABLE work_items`` 在 FK 开启且存在引用行
    （work_item_labels / work_item_notes / relations / focus_session 引用）时必然
    失败：``IntegrityError: FOREIGN KEY constraint failed``。SQLite 官方 12 步
    重建流程要求在重建期间关闭外键，故这里显式切换。
    pragma 在事务内是 no-op —— 切换后立即读回验证；切不掉就直接报错回滚
    （fail-loud，绝不带着 ON 状态硬走）。
    """
    bind = op.get_bind()
    foreign_keys_before = bind.exec_driver_sql("PRAGMA foreign_keys").scalar()
    if foreign_keys_before:
        bind.exec_driver_sql("PRAGMA foreign_keys=OFF")
        if bind.exec_driver_sql("PRAGMA foreign_keys").scalar():
            # ★ 实测：0→head 路径（全新库连跑 001..014）首次关闭会失败 —— 前一个
            #   迁移写入版本表的 UPDATE（DML）留下了未提交事务，而 pragma 在事务内
            #   是 no-op。按 SQLite 12 步流程先结束当前事务再关闭；此时 DB 处于
            #   「结构 = 上一 revision、版本表 = 上一 revision」的一致状态，提交安全。
            if bind.in_transaction():
                bind.commit()
            bind.exec_driver_sql("PRAGMA foreign_keys=OFF")
            if bind.exec_driver_sql("PRAGMA foreign_keys").scalar():
                raise RuntimeError(
                    "space_014 requires PRAGMA foreign_keys=OFF for the work_items "
                    "rebuild but the pragma is a no-op (active transaction)"
                )
    try:
        with op.batch_alter_table("work_items") as batch_op:
            apply_change(batch_op)
    finally:
        if foreign_keys_before:
            # ★ 2026-09-12（D2 收尾时恢复全量门禁）：恢复侧与关闭侧同款处理 ——
            #   重建刚写入 DDL，bind 处于未提交事务，而 **pragma 在事务内是 no-op**：
            #   直接 `PRAGMA foreign_keys=ON` 不会生效（实测：fresh 0→head 升级后
            #   连接的 FK 仍是 OFF，`test_fresh_journal_enforces_fk_unique_and_exact_indexes`
            #   因此红）。先提交再恢复，并读回验证（fail-loud，绝不静默带着 OFF 离开）。
            if bind.in_transaction():
                bind.commit()
            bind.exec_driver_sql("PRAGMA foreign_keys=ON")
            if not bind.exec_driver_sql("PRAGMA foreign_keys").scalar():
                raise RuntimeError(
                    "space_014 could not restore PRAGMA foreign_keys=ON after the rebuild"
                )


def _assert_rebuild_integrity(rows_before: int) -> None:
    """重建后的补偿控制：行数不变 + 外键完整；任一失败即抛错（事务回滚）。

    ``PRAGMA foreign_key_check`` 不带表名 = 全库检查：batch 重建会改写
    work_items 的引用方（work_item_labels / work_item_notes / relations 等均为
    普通 FK），全库检查比只查单表更能兜住重建引入的引用破损。
    """
    rows_after = _work_item_row_count()
    if rows_after != rows_before:
        raise RuntimeError(
            f"space_014 work_items rebuild lost rows: {rows_before} -> {rows_after}"
        )
    violations = op.get_bind().exec_driver_sql("PRAGMA foreign_key_check").fetchall()
    if violations:
        raise RuntimeError(
            f"space_014 foreign_key_check failed after rebuild: {violations[:5]}"
        )


def upgrade() -> None:
    """加列（幂等）：等待前态；batch 重建 + 行数/FK 双守卫（见文件头例外说明）。"""
    if _COLUMN_NAME in _work_item_column_names():
        return
    rows_before = _work_item_row_count()

    def _add_column(batch_op) -> None:
        batch_op.add_column(
            sa.Column(
                _COLUMN_NAME,
                sa.String(36),
                sa.ForeignKey("status_definitions.id"),
                nullable=True,
            )
        )

    _rebuild_work_items(_add_column)
    _assert_rebuild_integrity(rows_before)


def downgrade() -> None:
    """删列（幂等）：同样走 batch 重建（SQLite 不允许 DROP 带 FK 的列）+ 双守卫。"""
    if _COLUMN_NAME not in _work_item_column_names():
        return
    rows_before = _work_item_row_count()

    def _drop_column(batch_op) -> None:
        batch_op.drop_column(_COLUMN_NAME)

    _rebuild_work_items(_drop_column)
    _assert_rebuild_integrity(rows_before)
