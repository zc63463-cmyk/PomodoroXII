"""relations: 工作项依赖域（Relation）表 —— 任务空间第二阶段。

Revision ID: space_013_relations
Revises: space_012_assets
Create Date: 2026-09-08

★ 为什么必须写迁移
  space 库由 ``alembic_space/`` 建（与 meta 的 ``alembic/`` 是两套），只加
  ``app/models/relation.py`` 不写迁移 → 所有既有 space 都没有 relations 表，
  症状是"代码看着全对、运行 no such table"（assets 已踩过一次）。

★ 单边存储 / 双向解释（依赖域合同 D12）
  库里只存一条规范边：``from_work_item_id`` 永远是被阻塞方（下游），
  ``to_work_item_id`` 永远是上游 blocker。``A depends_on B`` 与
  ``B blocks A`` 是同一条边，查询时提供双视角投影。

★ 约束
  - ``relations_no_self_loop``：物理禁止自环（A -> A）。
  - ``uq_relations_edge``：逻辑唯一（space, from, to, type），与确定性
    ``relationId`` 一起保证离线多端独立建边能自动收敛、不产生重复行。

★ 索引不能省：环检测与派生阻塞都要按 from/to 双向扫描整张边表，
  ix_relations_updated_at 供同步增量扫描。
  注意 ``CreateTable(...).compile()`` 只产生 CREATE TABLE，**不含独立索引**。
"""

from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "space_013_relations"
down_revision: Union[str, None] = "space_012_assets"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """建 relations 表（含两个约束）与三个索引。

    ★★ 幂等：用 IF NOT EXISTS，让"手工补建过的库"与"全新库"都能安全通过
    （与 012_assets 同款处理）。
    """
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS relations (
            id VARCHAR(36) NOT NULL,
            space_id VARCHAR(36) NOT NULL,
            from_work_item_id VARCHAR(36) NOT NULL,
            to_work_item_id VARCHAR(36) NOT NULL,
            relation_type VARCHAR(20) NOT NULL,
            created_at VARCHAR(32) NOT NULL,
            updated_at VARCHAR(32) NOT NULL,
            -- ★ 不写 server default：`SyncMixin` 只提供 Python 侧 default，
            --   两侧必须逐列一致（见 012_assets.py 的同类说明）。
            version INTEGER NOT NULL,
            CONSTRAINT pk_relations PRIMARY KEY (id),
            CONSTRAINT relations_no_self_loop CHECK (from_work_item_id <> to_work_item_id),
            CONSTRAINT uq_relations_edge UNIQUE (space_id, from_work_item_id, to_work_item_id, relation_type),
            CONSTRAINT fk_relations_from_work_item FOREIGN KEY(from_work_item_id) REFERENCES work_items (id),
            CONSTRAINT fk_relations_to_work_item FOREIGN KEY(to_work_item_id) REFERENCES work_items (id)
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_relations_from ON relations (space_id, from_work_item_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_relations_to ON relations (space_id, to_work_item_id)"
    )
    op.execute("CREATE INDEX IF NOT EXISTS ix_relations_updated_at ON relations (updated_at)")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_relations_updated_at")
    op.execute("DROP INDEX IF EXISTS ix_relations_to")
    op.execute("DROP INDEX IF EXISTS ix_relations_from")
    op.execute("DROP TABLE IF EXISTS relations")
