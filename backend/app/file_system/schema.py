"""SQLite Schema — 文件系统索引数据库。

使用 SQLAlchemy 2.0 ORM（DeclarativeBase + Mapped）定义表结构，
与 pomodoroxi 的 SQLAlchemy 2.0 ORM 对照。FTS5 虚拟表通过原生 SQL 创建。
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

from sqlalchemy import (
    String, Integer, ForeignKey, UniqueConstraint, Index, create_engine,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.schema import CreateTable


class Base(DeclarativeBase):
    """SQLAlchemy 2.0 基类。"""
    pass


class NoteModel(Base):
    """笔记主表 — note_id 解耦，文件路径只是存储位置。"""
    __tablename__ = "notes"

    note_id: Mapped[str] = mapped_column(String(36), primary_key=True)  # n_+nanoid(12) 或 uuid4.hex (Pomodoroxi 透传)
    title: Mapped[str] = mapped_column(String(500), server_default="")
    current_path: Mapped[str] = mapped_column(String(500), nullable=False)
    content_hash: Mapped[str] = mapped_column(String(64), server_default="")  # SHA-256
    folder_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    level: Mapped[str] = mapped_column(String(2), server_default="L1")  # L1/L2/L3
    status: Mapped[str] = mapped_column(String(20), server_default="active")
    tags: Mapped[str] = mapped_column(String(4000), server_default="[]")  # JSON 数组
    word_count: Mapped[int] = mapped_column(Integer, server_default="0")
    is_deleted: Mapped[bool] = mapped_column(server_default="0")
    # sync 适配层字段 — 供 Pomodoroxi sync 透传, 本项目内部业务逻辑不使用
    summary: Mapped[str] = mapped_column(String(500), server_default="")
    category: Mapped[str | None] = mapped_column(String(200), nullable=True)
    trashed_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[str] = mapped_column(String(32), server_default="")
    updated_at: Mapped[str] = mapped_column(String(32), server_default="")

    __table_args__ = (
        Index("ix_notes_folder_id", "folder_id"),
        Index("ix_notes_level", "level"),
        Index("ix_notes_status", "status"),
        Index("ix_notes_updated_at", "updated_at"),
    )


class FolderModel(Base):
    """文件夹表 — 自引用 parent_id 树形结构。"""
    __tablename__ = "folders"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)  # uuid.uuid4().hex
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    parent_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("folders.id"), nullable=True)
    icon: Mapped[str] = mapped_column(String(50), server_default="📁")
    color: Mapped[str | None] = mapped_column(String(20), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, server_default="0")
    is_system: Mapped[bool] = mapped_column(server_default="0")
    trashed_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[str] = mapped_column(String(32), server_default="")
    updated_at: Mapped[str] = mapped_column(String(32), server_default="")

    __table_args__ = (
        UniqueConstraint("parent_id", "name", name="uq_folder_parent_name"),
        Index("ix_folders_parent_id", "parent_id"),
        Index("ix_folders_trashed_at", "trashed_at"),
    )


class NotePathHistory(Base):
    """笔记路径历史 — 追踪移动/重命名。"""
    __tablename__ = "note_paths"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    note_id: Mapped[str] = mapped_column(String(15), ForeignKey("notes.note_id"), index=True)
    old_path: Mapped[str] = mapped_column(String(500))
    new_path: Mapped[str] = mapped_column(String(500))
    changed_at: Mapped[str] = mapped_column(String(32))
    # index=True on note_id auto-generates ix_note_paths_note_id — no explicit Index needed


class NoteVersion(Base):
    """笔记版本历史 — 轻量，只存哈希+摘要。"""
    __tablename__ = "note_versions"

    version_id: Mapped[str] = mapped_column(String(15), primary_key=True)
    note_id: Mapped[str] = mapped_column(String(15), ForeignKey("notes.note_id"), index=True)
    content_hash: Mapped[str] = mapped_column(String(64))
    change_summary: Mapped[str] = mapped_column(String(500))
    created_at: Mapped[str] = mapped_column(String(32))
    # index=True on note_id auto-generates ix_versions_note_id — no explicit Index needed


class NoteLink(Base):
    """笔记关联 — 知识图谱基础。"""
    __tablename__ = "note_links"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    from_note_id: Mapped[str] = mapped_column(String(15), ForeignKey("notes.note_id"), index=True)
    to_note_id: Mapped[str] = mapped_column(String(15), ForeignKey("notes.note_id"), index=True)
    link_type: Mapped[str] = mapped_column(String(20), default="reference")
    strength: Mapped[float] = mapped_column(default=1.0)
    created_at: Mapped[str] = mapped_column(String(32))

    __table_args__ = (
        UniqueConstraint("from_note_id", "to_note_id", "link_type", name="uq_note_links"),
    )


# FTS5 虚拟表 — 独立存储（content=notes 模式不适用，因为 notes 表无 content 列，正文存在 .md 文件中）
# R7: tokenize='trigram' 支持中文子串匹配 (≥3 字符); 短查询由 search() 走 LIKE 回退
FTS5_CREATE_SQL = """
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    title,
    content,
    tokenize='trigram'
);
"""

FTS5_TRIGGER_INSERT = """
CREATE TRIGGER IF NOT EXISTS notes_fts_insert AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid, title, content) VALUES (new.rowid, new.title, '');
END;
"""

FTS5_TRIGGER_UPDATE = """
CREATE TRIGGER IF NOT EXISTS notes_fts_update AFTER UPDATE ON notes BEGIN
    UPDATE notes_fts SET title = new.title WHERE rowid = new.rowid;
END;
"""

FTS5_TRIGGER_DELETE = """
CREATE TRIGGER IF NOT EXISTS notes_fts_delete AFTER DELETE ON notes BEGIN
    DELETE FROM notes_fts WHERE rowid = old.rowid;
END;
"""


def _migrate_notes_columns(conn: sqlite3.Connection) -> None:
    """为存量 notes 表添加 sync 适配层新增列 (幂等).

    SQLite 的 ALTER TABLE ADD COLUMN 在列已存在时会报错, 需先检查 pragma table_info.
    """
    existing_cols = {
        row[1] for row in conn.execute("PRAGMA table_info(notes)").fetchall()
    }
    new_columns = [
        ("summary", "TEXT NOT NULL DEFAULT ''"),
        ("category", "TEXT"),
        ("trashed_at", "TEXT"),
    ]
    for col_name, col_def in new_columns:
        if col_name not in existing_cols:
            conn.execute(f"ALTER TABLE notes ADD COLUMN {col_name} {col_def}")


# ─── 版本化迁移 ────────────────────────────────────────

_SCHEMA_VERSION_LATEST = 1


def _get_schema_version(conn: sqlite3.Connection) -> int:
    """读取当前 schema 版本, 无版本表时返回 0."""
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT)"
    )
    row = conn.execute(
        "SELECT value FROM schema_meta WHERE key = 'version'"
    ).fetchone()
    return int(row[0]) if row else 0


def _set_schema_version(conn: sqlite3.Connection, version: int) -> None:
    conn.execute(
        "INSERT INTO schema_meta (key, value) VALUES ('version', ?) "
        "ON CONFLICT(key) DO UPDATE SET value = ?",
        (str(version), str(version)),
    )


def _migrate_to_v1(conn: sqlite3.Connection) -> None:
    """v0 → v1: 基线版本 — 归入现有列迁移 + sync_audit_log 表."""
    _migrate_notes_columns(conn)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS sync_audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_type TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            action TEXT NOT NULL,
            client_time TEXT,
            server_time TEXT,
            applied INTEGER DEFAULT 1,
            conflict_reason TEXT
        )
    """)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS ix_sync_audit_entity "
        "ON sync_audit_log(entity_type, entity_id)"
    )


_MIGRATIONS = {
    1: _migrate_to_v1,
}


def _run_migrations(conn: sqlite3.Connection) -> None:
    """执行从当前版本到最新版本的迁移."""
    current = _get_schema_version(conn)
    for version in range(current + 1, _SCHEMA_VERSION_LATEST + 1):
        migration_fn = _MIGRATIONS.get(version)
        if migration_fn:
            migration_fn(conn)
            _set_schema_version(conn, version)


def init_database(db_path: Path) -> None:
    """初始化数据库：创建表 + 索引 + FTS5。幂等。"""
    db_path.parent.mkdir(parents=True, exist_ok=True)

    # Windows 路径含中文时, SQLAlchemy 的 sqlite:///{path} URL 解析会失败
    # (sqlite3.OperationalError: unable to open database file).
    # 解决方案: 全部使用 sqlite3 原生连接, 通过 Base.metadata.ddl 生成 DDL 再执行.
    with sqlite3.connect(str(db_path)) as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("PRAGMA foreign_keys=ON")

        # 使用 SQLAlchemy DDL 生成 CREATE TABLE 语句 (兼容 ORM 定义)
        # 创建临时内存数据库来获取 DDL (不依赖文件系统路径)
        engine = create_engine("sqlite:///:memory:", echo=False)
        Base.metadata.create_all(engine)
        # 将表定义导出为 SQL 并在真实数据库上执行
        for table in Base.metadata.sorted_tables:
            ddl = str(CreateTable(table, if_not_exists=True).compile(dialect=engine.dialect))
            conn.execute(ddl)
            # CREATE TABLE 已包含内联 INDEX/UNIQUE 约束; 单独 INDEX (via Index()) 在 create_all 中已创建
            # SQLAlchemy ORM 的 Index() 通过 sorted_tables 关联, 但 Base.metadata 没有顶层 indexes 属性
            # 所以无需额外处理; 索引由 CREATE TABLE 内的 UNIQUE/INDEX 子句创建.

        # ---- 版本化迁移 (替代旧的 _migrate_notes_columns 直接调用) ----
        _run_migrations(conn)

    # 原生 SQL 创建 FTS5（SQLAlchemy 不支持）
    with sqlite3.connect(str(db_path)) as conn:
        conn.execute(FTS5_CREATE_SQL)
        conn.execute(FTS5_TRIGGER_INSERT)
        conn.execute(FTS5_TRIGGER_UPDATE)
        conn.execute(FTS5_TRIGGER_DELETE)

    engine.dispose()
