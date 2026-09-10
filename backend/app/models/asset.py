"""SQLAlchemy model for note assets (images, PDFs, attachments).

★ 为什么是 DB_ONLY 而不是 FS_DB_SPLIT
   文件系统里存二进制，DB 里存元数据 —— 看起来像 note 的 FS_DB_SPLIT。
   但 `unit_of_work.py:855` 规定：**FS_DB_SPLIT 实体必须注册 Domain Policy**，
   否则同步入口直接抛 `SpaceRecoveryRequiredError`。S1 阶段还不想动同步，
   所以这里用 DB_ONLY：元数据进 DB，二进制由 AssetService 自己管磁盘，
   绕开 policy 约束。S2 要入同步时再改 storage_type + 补 policy。

★ 为什么元数据不存二进制
   `storage_key` 只存**相对路径**。这样：
   - 同步 payload 极小（S2 时只传元数据）
   - sha256 做 content-addressed 去重，同一文件只存一份
"""

from sqlalchemy import Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.mixins import SyncMixin


class Asset(Base, SyncMixin):
    """Binary asset attached to notes (image / PDF / other allowed types)."""

    __tablename__ = "assets"

    # 原始文件名 —— 仅用于展示，落盘时不用它（防路径遍历 + 重名冲突）
    filename: Mapped[str] = mapped_column(String(255), default="")
    # 规范化的 MIME，如 image/png、application/pdf
    mime: Mapped[str] = mapped_column(String(127), default="application/octet-stream")
    # 字节数
    size: Mapped[int] = mapped_column(Integer, default=0)
    # ★ 内容寻址键：同内容只存一份，跨笔记/跨设备自动去重
    sha256: Mapped[str] = mapped_column(String(64), index=True, default="")
    # 相对 space 根目录的路径，如 assets/ab/abcdef...png
    storage_key: Mapped[str] = mapped_column(String(512), default="")
