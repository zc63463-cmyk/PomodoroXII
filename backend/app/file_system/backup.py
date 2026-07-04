"""BackupService — SQLite 数据库自动备份.

使用 sqlite3.backup() Online Backup API, 不锁库, WAL 兼容.
启动时触发首次备份, 之后每日定时备份, 保留最近 30 天.
"""
from __future__ import annotations

import sqlite3
import time
import logging
from pathlib import Path
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

_KEEP_DAYS = 30
_MAX_BACKUPS = 30


class BackupService:
    """SQLite Online Backup — 不锁库, WAL 兼容."""

    @classmethod
    def create_backup(cls, db_path: Path, backup_dir: Path) -> str | None:
        """创建 index.db 备份. 返回备份文件路径, 失败返回 None."""
        try:
            backup_dir.mkdir(parents=True, exist_ok=True)
            timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
            backup_path = backup_dir / f"index_{timestamp}.db"

            source = sqlite3.connect(str(db_path))
            dest = sqlite3.connect(str(backup_path))
            source.backup(dest)
            dest.close()
            source.close()

            cls._cleanup_old_backups(backup_dir)
            logger.info("数据库备份成功: %s", backup_path.name)
            return str(backup_path)
        except Exception as exc:
            logger.error("数据库备份失败: %s", exc)
            return None

    @classmethod
    def _cleanup_old_backups(cls, backup_dir: Path) -> None:
        """清理超过 30 天的备份, 且总数不超过 _MAX_BACKUPS."""
        backups = sorted(
            backup_dir.glob("index_*.db"),
            key=lambda f: f.stat().st_mtime,
            reverse=True,
        )
        # 按时间清理
        cutoff = time.time() - (_KEEP_DAYS * 86400)
        for f in backups:
            if f.stat().st_mtime < cutoff:
                f.unlink()
                logger.info("清理过期备份: %s", f.name)
        # 按数量清理
        for f in backups[_MAX_BACKUPS:]:
            if f.exists():
                f.unlink()
                logger.info("清理多余备份: %s", f.name)
