"""BackupService — SQLite 数据库自动备份.

使用 sqlite3.backup() Online Backup API, 不锁库, WAL 兼容.
启动时触发首次备份, 之后每日定时备份, 保留最近 30 天.
"""
from __future__ import annotations

import logging
import os
import sqlite3
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

_KEEP_DAYS = 30
_MAX_BACKUPS = 30


class BackupService:
    """SQLite Online Backup — 不锁库, WAL 兼容."""

    @classmethod
    def create_backup(cls, db_path: Path, backup_dir: Path) -> str | None:
        """创建 index.db 备份. 返回备份文件路径, 失败返回 None."""
        temporary_path: Path | None = None
        backup_path: Path | None = None
        try:
            if not db_path.is_file():
                raise FileNotFoundError(f"database does not exist: {db_path}")

            backup_dir.mkdir(parents=True, exist_ok=True)
            timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S_%f")[:-3]
            unique_id = uuid.uuid4().hex
            backup_path = backup_dir / f"index_{timestamp}_{unique_id}.db"

            fd, temporary_name = tempfile.mkstemp(
                prefix=f".{backup_path.stem}-", suffix=".tmp", dir=backup_dir
            )
            os.close(fd)
            temporary_path = Path(temporary_name)

            source_uri = f"{db_path.resolve().as_uri()}?mode=ro"
            source = sqlite3.connect(source_uri, uri=True)
            try:
                dest = sqlite3.connect(str(temporary_path))
                try:
                    source.backup(dest)
                    result = dest.execute("PRAGMA integrity_check").fetchone()
                    if result != ("ok",):
                        raise sqlite3.DatabaseError(f"integrity_check failed: {result!r}")
                finally:
                    dest.close()
            finally:
                source.close()

            temporary_path.replace(backup_path)
            temporary_path = None
            try:
                cls._cleanup_old_backups(backup_dir)
            except Exception as exc:
                logger.warning("数据库备份已完成，但旧备份清理失败: %s", exc)
            logger.info("数据库备份成功: %s", backup_path.name)
            return str(backup_path)
        except Exception as exc:
            logger.error("数据库备份失败: %s", exc)
            return None
        finally:
            if temporary_path is not None:
                try:
                    temporary_path.unlink(missing_ok=True)
                except OSError as exc:
                    logger.warning("清理失败的数据库备份临时文件失败: %s", exc)

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
