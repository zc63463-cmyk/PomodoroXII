"""assets: 笔记资源（图片/PDF）表 —— S1。

Revision ID: space_012_assets
Revises: space_011_sync_clients_streaming
Create Date: 2026-09-06

★ 为什么必须写迁移（而不是只加 model）
  加实体只写 ``app/models/asset.py`` 是不够的：本项目的 space 库是**通过
  alembic 迁移**建的（``alembic_space/``，与 meta 的 ``alembic/`` 是两套），
  ``Base.metadata.create_all`` 只服务于新建/内存场景。不写迁移的话，
  所有既有 space 都没有 assets 表 —— 表现是「代码看着全对，运行
  no such table」，连同步 push 都被带崩
  （``tests/test_sync_cursor_pagination.py`` 就是这个症状）。

★ 该表目前**不参与同步**（``sync_enabled=False``，二进制还没有传输通道），
  所以这里不把它加进 sync 实体的 updated_at 索引规范；S2 接入同步时再补一条。

★ 索引不能省：sha256 是内容寻址去重的查询键，updated_at 供增量扫描。
  注意 ``CreateTable(...).compile()`` 只产生 CREATE TABLE，**不含独立索引** ——
  手工补建的表若漏了 CREATE INDEX，sha256 查询会退化成全表扫描。
"""

from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "space_012_assets"
down_revision: Union[str, None] = "space_011_sync_clients_streaming"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """建 assets 表与两个索引。

    ★★ 必须幂等：本迁移落地前，已有 space 的表是**手工补建**的
    （直接执行 CREATE TABLE IF NOT EXISTS），那些库的 alembic 版本仍停在 011。
    非幂等的 ``op.create_table`` 在它们身上重跑会直接 "table already exists"。
    用 IF NOT EXISTS 可以让「已补建」与「全新」两种库都安全通过。
    """
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS assets (
            -- ★ 列默认值一律走 ORM 的 Python 侧 default（`app/models/asset.py`），
            --   DDL 里**不写 server default**：两侧不一致会被
            --   `test_fresh_head_matches_selected_metadata_key_attributes` 的
            --   「迁移 DDL == Base.metadata」逐列比对抓住（本表曾因此红过）。
            filename VARCHAR(255) NOT NULL,
            mime VARCHAR(127) NOT NULL,
            size INTEGER NOT NULL,
            sha256 VARCHAR(64) NOT NULL,
            storage_key VARCHAR(512) NOT NULL,
            id VARCHAR(36) NOT NULL,
            created_at VARCHAR(32) NOT NULL,
            updated_at VARCHAR(32) NOT NULL,
            version INTEGER NOT NULL,
            CONSTRAINT pk_assets PRIMARY KEY (id)
        )
        """
    )
    # ★ 索引同样不能省：sha256 是内容寻址去重的查询键，updated_at 供增量扫描
    op.execute("CREATE INDEX IF NOT EXISTS ix_assets_sha256 ON assets (sha256)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_assets_updated_at ON assets (updated_at)")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_assets_updated_at")
    op.execute("DROP INDEX IF EXISTS ix_assets_sha256")
    op.execute("DROP TABLE IF EXISTS assets")
