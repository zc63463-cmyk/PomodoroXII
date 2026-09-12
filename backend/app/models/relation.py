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
        # ★ 名字必须让「命名约定解析后的结果」与迁移 DDL 完全一致
        #   （`test_parity_alembic_metadata` 逐约束比对）：
        #   ck 的模板是 `ck_%(table_name)s_%(constraint_name)s`，
        #   所以这里给 `self_loop`、最终落成 `ck_relations_self_loop`。
        CheckConstraint(
            "from_work_item_id <> to_work_item_id", name="self_loop"
        ),
        UniqueConstraint(
            "space_id", "from_work_item_id", "to_work_item_id", "relation_type",
            name="uq_relations_edge",
        ),
        # ★ 外键名显式给出：不给名字时约定会拼成
        #   `fk_relations_from_work_item_id_work_items`，与迁移里的短名不符。
        Index("ix_relations_from", "space_id", "from_work_item_id"),
        Index("ix_relations_to", "space_id", "to_work_item_id"),
    )

    space_id: Mapped[str] = mapped_column(String(36), nullable=False)
    from_work_item_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("work_items.id", name="fk_relations_from_work_item"),
        nullable=False,
    )
    to_work_item_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("work_items.id", name="fk_relations_to_work_item"),
        nullable=False,
    )
    relation_type: Mapped[str] = mapped_column(String(20), nullable=False)
    # ★ 2026-09-12（D2 / ADR-0004）：依赖解除确认 —— 服务端自持的两列（唯一写入者
    #   是 ResolveDependency 命令的编译）。
    #   - `resolution`：目前唯一合法值 `"confirmed_not_required"`（显式用户事实）；
    #     NULL = 未确认。用字符串而不是布尔（未来可能引入其它 resolution 取值）。
    #   - `resolved_at`：服务端单调时钟戳（防伪；不接受调用方自带时间戳）。
    #   注意：关系的**三态**（satisfied / broken_requires_resolution / open）是纯派生，
    #   绝不落库 —— 落库的只有这两列。
    resolution: Mapped[str | None] = mapped_column(String(64))
    resolved_at: Mapped[str | None] = mapped_column(String(32))
