"""Task Space Relation (dependency edge) ORM model.

★ 单边存储 / 双向解释（依赖域合同 D12）
  ``A depends_on B`` ⟺ ``B blocks A``。库里只存一条**规范边**：
  ``from_work_item_id`` 永远是被阻塞方（下游 / 依赖者），
  ``to_work_item_id``   永远是上游 blocker（被依赖者）。
  双视角由查询层投影出来，绝不重复存两条边。

★ relationId 确定性派生（D11 / D15）
  ``relationId = "rel_" + sha256(canonical(space_id, from, to, type))[:32]``
  天然幂等：离线多端各自建同一条逻辑边，收敛后是同一行，不会产生重复。

★ 自环与逻辑唯一
  物理层由 ``relations_no_self_loop`` / ``uq_relations_edge`` 兜底，
  ORM 层同步声明以便 metadata 自省与测试可读。
"""

from sqlalchemy import CheckConstraint, ForeignKey, Index, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.mixins import SyncMixin

# 首版只开放阻塞语义。``relates_to`` 不参与阻塞计算，保留给后续扩展。
BLOCKING_RELATION_TYPES = frozenset({"depends_on", "blocks"})


class Relation(Base, SyncMixin):
    __tablename__ = "relations"
    # ★ 索引必须与 ``alembic_space/versions/013_relations.py`` 的建法**逐列一致**：
    #   `test_fresh_head_matches_selected_metadata_key_attributes` 会逐表比对
    #   「迁移 DDL 的索引集 == Base.metadata 的索引集」。两边都按 (space, 端点)
    #   建复合索引 —— 环检测与派生阻塞都是"按 Space 内的某个端点"扫全表，
    #   单列索引在复合条件下退化。`updated_at` 的索引由 SyncMixin 提供。
    __table_args__ = (
        CheckConstraint(
            "from_work_item_id <> to_work_item_id", name="relations_no_self_loop"
        ),
        UniqueConstraint(
            "space_id", "from_work_item_id", "to_work_item_id", "relation_type",
            name="uq_relations_edge",
        ),
        Index("ix_relations_from", "space_id", "from_work_item_id"),
        Index("ix_relations_to", "space_id", "to_work_item_id"),
    )

    space_id: Mapped[str] = mapped_column(String(36), nullable=False)
    from_work_item_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("work_items.id"), nullable=False
    )
    to_work_item_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("work_items.id"), nullable=False
    )
    relation_type: Mapped[str] = mapped_column(String(20), nullable=False)
