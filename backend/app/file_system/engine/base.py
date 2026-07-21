"""StorageBase — 文件系统存储基类.

提供 __init__, DB 连接, 锁, 原子写入, FTS5 维护, 生命周期管理.
各 Mixin (NoteOpsMixin, FolderOpsMixin, ...) 组合成最终的 FileSystemStorage.
"""
from __future__ import annotations

import asyncio
import errno
import hashlib
import json
import os
import sqlite3
from contextlib import AbstractContextManager, contextmanager, nullcontext
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from threading import RLock
from typing import Protocol, Sequence, assert_never

from filelock import FileLock
from nanoid import generate
from slugify import slugify
from sqlalchemy import create_engine
from sqlalchemy.schema import CreateTable

from app.errors import SpaceRecoveryRequiredError
from app.file_system.interfaces import (
    FencedProjectionExecutor,
    NoteLevel,
    NoteMeta,
    NoteStatus,
    ProjectionAuthoritySnapshot,
)
from app.file_system.schema import (
    FTS5_CREATE_SQL,
    FTS5_TRIGGER_DELETE,
    FTS5_TRIGGER_INSERT,
    FTS5_TRIGGER_UPDATE,
    Base,
    _run_migrations,
)
from app.mutation.types import (
    ContainedProjectionActionField,
    MaterializedProjectionAction,
    ProjectionActionTag,
)
from app.runtime.contained_io import BoundDirectoryHandle
from app.runtime.sqlite_vfs import BoundSQLiteTarget, MaintenanceOptions


class FileSystemProjectionExecutor(FencedProjectionExecutor):
    """Execute only verified, contained actions from the active stage authority."""

    async def apply_forward(
        self, scope, operation_id, command, receipt, *, ordinals=None
    ) -> None:
        stages = scope.mutation_stages
        if stages is None:
            raise SpaceRecoveryRequiredError("Space mutation stages are not active")
        actions = await stages.materialize_side(
            operation_id,
            command.projections,
            image="after",
            ordinals=(
                tuple(range(len(command.projections)))
                if ordinals is None
                else tuple(ordinals)
            ),
            receipt=receipt,
        )
        await self._execute_actions(scope, actions, receipt)

    async def restore_before(
        self, scope, operation_id, command, receipt, *, ordinals=None
    ) -> None:
        stages = scope.mutation_stages
        if stages is None:
            raise SpaceRecoveryRequiredError("Space mutation stages are not active")
        actions = await stages.materialize_side(
            operation_id,
            command.projections,
            image="before",
            ordinals=(
                tuple(reversed(range(len(command.projections))))
                if ordinals is None
                else tuple(ordinals)
            ),
            receipt=receipt,
        )
        await self._execute_actions(scope, actions, receipt)

    async def _execute_actions(
        self, scope, actions: Sequence[MaterializedProjectionAction], receipt
    ) -> None:
        from app.runtime.joined_thread import run_joined_thread

        for action in actions:
            await run_joined_thread(
                lambda: self._apply_one_contained_action(scope, action, receipt)
            )

    def _apply_one_contained_action(
        self, scope, action: MaterializedProjectionAction, receipt
    ) -> None:
        match action.tag:
            case ProjectionActionTag.MARKDOWN_WRITE:
                receipt.assert_current()
                self._apply_markdown_write(scope, action, receipt)
            case ProjectionActionTag.PATH_RENAME:
                receipt.assert_current()
                self._apply_path_rename(scope, action, receipt)
            case ProjectionActionTag.PATH_REMOVE:
                receipt.assert_current()
                self._apply_path_remove(scope, action, receipt)
            case ProjectionActionTag.INDEX_REPLACE:
                receipt.assert_current()
                self._apply_index_replace(scope, action, receipt)
            case ProjectionActionTag.FTS_REPLACE:
                receipt.assert_current()
                self._apply_fts_replace(scope, action, receipt)
            case unreachable:
                assert_never(unreachable)

    def _apply_markdown_write(
        self, scope, action: MaterializedProjectionAction, receipt
    ) -> None:
        scope.file_system._apply_projection_markdown_write(action, receipt)

    def _apply_path_rename(
        self, scope, action: MaterializedProjectionAction, receipt
    ) -> None:
        scope.file_system._apply_projection_path_rename(action, receipt)

    def _apply_path_remove(
        self, scope, action: MaterializedProjectionAction, receipt
    ) -> None:
        scope.file_system._apply_projection_path_remove(action, receipt)

    def _apply_index_replace(
        self, scope, action: MaterializedProjectionAction, receipt
    ) -> None:
        scope.file_system._apply_projection_index_replace(action, receipt)

    def _apply_fts_replace(
        self, scope, action: MaterializedProjectionAction, receipt
    ) -> None:
        scope.file_system._apply_projection_fts_replace(action, receipt)


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _generate_note_id() -> str:
    """n_ + nanoid(12) = 15 chars total."""
    return "n_" + generate(size=12)


def _make_filename(note_id: str, title: str) -> str:
    """生成笔记文件名: <note_id>-<slug>.md"""
    slug = slugify(title, max_length=30) or "untitled"
    return f"{note_id}-{slug}.md"


class WindowsPathTooLongError(OSError):
    """A filesystem operation exceeded the traditional Windows path limit."""


def _is_windows_path_too_long_error(exc: OSError, path: Path) -> bool:
    """Return whether *exc* and *path* indicate a Windows path-length limit."""
    if os.name != "nt":
        return False
    winerror = getattr(exc, "winerror", None)
    return exc.errno == errno.ENAMETOOLONG or winerror == 206


def _logical_path(value: str) -> PurePosixPath:
    if not value or "\\" in value or ":" in value:
        raise ValueError("note storage path must be normalized and relative")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError("note storage path must be normalized and relative")
    return path


def _atomic_write_path(path: Path, content: str) -> None:
    temp_path = path.parent / f".{path.name}.tmp"
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temp_path.write_text(content, encoding="utf-8")
        os.replace(str(temp_path), str(path))
    except OSError as exc:
        try:
            temp_path.unlink(missing_ok=True)
        except OSError:
            pass
        diagnostic_path = temp_path if len(str(temp_path)) >= len(str(path)) else path
        if _is_windows_path_too_long_error(exc, diagnostic_path):
            raise WindowsPathTooLongError(
                "Atomic write failed because the Windows path is too long: "
                f"target={path} (target length={len(str(path))}, "
                f"temporary length={len(str(temp_path))}). Enable Windows long path "
                "support or shorten the space/test data directory."
            ) from exc
        raise


class _NotesAuthority(Protocol):
    def atomic_write(self, relative_name: str, content: str) -> None: ...
    def exists(self, relative_name: str) -> bool: ...
    def read_text(self, relative_name: str) -> str: ...
    def rename(self, source: str, destination: str) -> None: ...
    def unlink(self, relative_name: str) -> None: ...
    def ensure_directory(self, relative_name: str) -> None: ...
    def iter_markdown(self, relative_name: str) -> list[str]: ...
    def close(self) -> None: ...


class _PathNotesAuthority:
    def __init__(self, root: Path) -> None:
        self.root = root

    def _path(self, relative_name: str) -> Path:
        return self.root.joinpath(*_logical_path(relative_name).parts)

    def atomic_write(self, relative_name: str, content: str) -> None:
        _atomic_write_path(self._path(relative_name), content)

    def exists(self, relative_name: str) -> bool:
        return self._path(relative_name).is_file()

    def read_text(self, relative_name: str) -> str:
        return self._path(relative_name).read_text(encoding="utf-8")

    def rename(self, source: str, destination: str) -> None:
        source_path = self._path(source)
        destination_path = self._path(destination)
        destination_path.parent.mkdir(parents=True, exist_ok=True)
        source_path.rename(destination_path)

    def unlink(self, relative_name: str) -> None:
        self._path(relative_name).unlink()

    def ensure_directory(self, relative_name: str) -> None:
        self._path(relative_name).mkdir(parents=True, exist_ok=True)

    def iter_markdown(self, relative_name: str) -> list[str]:
        root = self._path(relative_name)
        if not root.is_dir():
            return []
        return [
            path.relative_to(self.root).as_posix()
            for path in root.rglob("*.md")
            if path.is_file()
        ]

    def close(self) -> None:
        return None


class _BoundNotesAuthority:
    def __init__(self, handle: BoundDirectoryHandle) -> None:
        self._handle = handle

    @staticmethod
    def _translate(relative_name: str) -> str:
        parts = list(_logical_path(relative_name).parts)
        if parts[0] == "notes":
            parts.pop(0)
        if not parts:
            raise ValueError("note storage path cannot name the authority root")
        return "/".join(parts)

    def atomic_write(self, relative_name: str, content: str) -> None:
        self._handle._atomic_write_relative(
            self._translate(relative_name), content.encode("utf-8")
        )

    def exists(self, relative_name: str) -> bool:
        return self._handle._relative_file_exists(self._translate(relative_name))

    def read_text(self, relative_name: str) -> str:
        with self._handle._open_relative_no_follow(
            self._translate(relative_name), os.O_RDONLY
        ) as child:
            return child.read().decode("utf-8")

    def rename(self, source: str, destination: str) -> None:
        self._handle._rename_relative(
            self._translate(source), self._translate(destination)
        )

    def unlink(self, relative_name: str) -> None:
        self._handle._unlink_relative(self._translate(relative_name))

    def ensure_directory(self, relative_name: str) -> None:
        if relative_name == "notes":
            return
        self._handle._mkdir_relative(self._translate(relative_name))

    def iter_markdown(self, relative_name: str) -> list[str]:
        translated = "" if relative_name == "notes" else self._translate(relative_name)
        prefix = "notes" if relative_name == "notes" else relative_name
        names = self._handle._iter_relative_files(translated, suffix=".md")
        if relative_name == "notes":
            names = [
                name
                for name in names
                if name.split("/", 1)[0] not in {".meta", ".trash"}
            ]
        return [
            f"{prefix.rstrip('/')}/{name}"
            for name in names
        ]

    def close(self) -> None:
        self._handle._close()


class _IndexAuthority(Protocol):
    def connect(self) -> AbstractContextManager[sqlite3.Connection]: ...
    async def close(self) -> None: ...


class _PathIndexAuthority:
    def __init__(self, index_db: Path) -> None:
        self.path = index_db

    @contextmanager
    def connect(self):
        connection = sqlite3.connect(str(self.path), timeout=30.0)
        try:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA busy_timeout=5000")
            connection.execute("PRAGMA foreign_keys=ON")
            yield connection
        finally:
            connection.close()

    async def close(self) -> None:
        return None


class _BoundIndexAuthority:
    def __init__(self, target: BoundSQLiteTarget) -> None:
        self._target = target

    def connect(self) -> AbstractContextManager[sqlite3.Connection]:
        return self._target.open_maintenance(
            MaintenanceOptions(read_only=False, busy_timeout_ms=5000)
        )

    async def close(self) -> None:
        await self._target.aclose()


def _initialize_database(connection: sqlite3.Connection) -> None:
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA synchronous=NORMAL")
    connection.execute("PRAGMA busy_timeout=5000")
    connection.execute("PRAGMA foreign_keys=ON")
    engine = create_engine("sqlite:///:memory:", echo=False)
    try:
        Base.metadata.create_all(engine)
        for table in Base.metadata.sorted_tables:
            ddl = str(
                CreateTable(table, if_not_exists=True).compile(dialect=engine.dialect)
            )
            connection.execute(ddl)
        _run_migrations(connection)
        connection.execute(FTS5_CREATE_SQL)
        connection.execute(FTS5_TRIGGER_INSERT)
        connection.execute(FTS5_TRIGGER_UPDATE)
        connection.execute(FTS5_TRIGGER_DELETE)
        connection.commit()
    finally:
        engine.dispose()


class StorageBase:
    """文件系统存储基类 — .md + SQLite + FTS5.

    提供 DB 连接, 锁, 原子写入, FTS5 维护等基础设施.
    具体操作由各 Mixin 实现, 组合成 FileSystemStorage.
    """

    def __init__(self, root_dir: Path, index_db: Path):
        self.root = Path(root_dir).resolve()
        self.index_db = Path(index_db).resolve()
        self._notes: _NotesAuthority = _PathNotesAuthority(self.root)
        self._index: _IndexAuthority = _PathIndexAuthority(self.index_db)
        self._storage_mode = "path"
        self._lock = RLock()
        self._file_lock = FileLock(str(self.index_db) + ".lock")
        self._engine = None

    @classmethod
    def from_bound_handles(
        cls,
        notes_handle: BoundDirectoryHandle,
        index_target: BoundSQLiteTarget,
    ):
        instance = object.__new__(cls)
        instance._notes = _BoundNotesAuthority(notes_handle)
        instance._index = _BoundIndexAuthority(index_target)
        instance._storage_mode = "contained"
        instance._lock = RLock()
        instance._file_lock = nullcontext()
        instance._engine = None
        return instance

    # ─── DB helpers ──────────────────────────────────────

    def _connect(self) -> AbstractContextManager[sqlite3.Connection]:
        return self._index.connect()

    @staticmethod
    def _note_relative(note_id: str, title: str, folder_id=None) -> str:
        filename = _make_filename(note_id, title)
        if folder_id is None:
            return f"notes/{filename}"
        return f"notes/{folder_id}/{filename}"

    def _note_path(self, note_id: str, title: str = "", folder_id=None) -> Path:
        """Return the .md file path for a note_id.

        If title is provided, returns the path for a new note with that title.
        If title is empty, looks up the current path from DB.
        """
        # Look up the current path from DB if title not provided
        if not title:
            with self._connect() as conn:
                row = conn.execute(
                    "SELECT title, current_path FROM notes WHERE note_id = ?", (note_id,)
                ).fetchone()
            if row:
                return self.root / row[1]
            raise KeyError(f"Note {note_id} not found")
        relative = self._note_relative(note_id, title, folder_id)
        if self._storage_mode != "path":
            raise RuntimeError("contained storage does not expose host paths")
        return self.root.joinpath(*PurePosixPath(relative).parts)

    def _row_to_note_meta(self, row: sqlite3.Row) -> NoteMeta:
        """Convert a DB row to NoteMeta."""
        tags_raw = row["tags"] or "[]"
        try:
            tags = json.loads(tags_raw) if tags_raw else []
        except json.JSONDecodeError:
            tags = []
        return NoteMeta(
            id=row["note_id"],
            title=row["title"] or "",
            folder_id=row["folder_id"],
            level=NoteLevel(row["level"]) if row["level"] else NoteLevel.L1,
            status=NoteStatus(row["status"]) if row["status"] else NoteStatus.ACTIVE,
            tags=tags,
            content_hash=row["content_hash"] or "",
            word_count=row["word_count"] or 0,
            created_at=row["created_at"] or "",
            updated_at=row["updated_at"] or "",
        )

    # ─── Atomic write ────────────────────────────────────

    def _atomic_write(self, path: str | Path, content: str) -> None:
        if isinstance(path, Path):
            if self._storage_mode != "path":
                raise RuntimeError("contained storage rejected host Path")
            _atomic_write_path(path, content)
            return
        self._notes.atomic_write(path, content)

    def _file_exists(self, relative_name: str) -> bool:
        return self._notes.exists(relative_name)

    def _read_text(self, relative_name: str) -> str:
        return self._notes.read_text(relative_name)

    def _rename_file(self, source: str, destination: str) -> None:
        self._notes.rename(source, destination)

    def _unlink_file(self, relative_name: str) -> None:
        self._notes.unlink(relative_name)

    def _ensure_directory(self, relative_name: str) -> None:
        self._notes.ensure_directory(relative_name)

    def _iter_markdown(self, relative_name: str = "notes") -> list[str]:
        return self._notes.iter_markdown(relative_name)

    async def snapshot_projection_authority(self) -> ProjectionAuthoritySnapshot:
        from app.runtime.joined_thread import run_joined_thread

        return await run_joined_thread(self._snapshot_projection_authority_sync)

    @staticmethod
    def _canonical_projection_blob(value: object) -> bytes:
        return json.dumps(
            value,
            ensure_ascii=True,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("ascii")

    def _snapshot_projection_authority_sync(self) -> ProjectionAuthoritySnapshot:
        markdown = {
            relative: self._read_text(relative).encode("utf-8")
            for relative in self._iter_markdown()
        }
        index: dict[str, bytes] = {}
        fts: dict[str, bytes] = {}
        with self._connect() as connection:
            for table in Base.metadata.sorted_tables:
                primary_keys = tuple(column.name for column in table.primary_key)
                if len(primary_keys) != 1:
                    raise RuntimeError("projection authority requires one index primary key")
                primary_key = primary_keys[0]
                columns = tuple(column.name for column in table.columns)
                quoted_columns = ",".join(f'"{column}"' for column in columns)
                rows = connection.execute(
                    f'SELECT {quoted_columns} FROM "{table.name}"'
                ).fetchall()
                primary_index = columns.index(primary_key)
                for values in rows:
                    identity = str(values[primary_index])
                    target = ContainedProjectionActionField(
                        f"index/{table.name}/{primary_key}/{identity}"
                    )
                    index[str(target)] = self._canonical_projection_blob(
                        {"row": dict(zip(columns, values, strict=True))}
                    )
            for note_id, title, content in connection.execute(
                "SELECT notes.note_id, notes_fts.title, notes_fts.content "
                "FROM notes_fts JOIN notes ON notes_fts.rowid = notes.rowid"
            ).fetchall():
                target = ContainedProjectionActionField(f"fts/{note_id}")
                fts[str(target)] = self._canonical_projection_blob(
                    {"content": content or "", "title": title or ""}
                )
        return ProjectionAuthoritySnapshot(markdown, index, fts)

    def _update_fts_content(self, conn: sqlite3.Connection, note_id: str, content: str) -> None:
        """Update the FTS5 content column for a note."""
        conn.execute(
            "UPDATE notes_fts SET content = ? WHERE rowid = "
            "(SELECT rowid FROM notes WHERE note_id = ?)",
            (content, note_id),
        )

    @staticmethod
    def _projection_payload(action: MaterializedProjectionAction) -> dict[str, object]:
        if action.blob is None:
            raise ValueError("projection action requires a JSON payload")
        try:
            payload = json.loads(action.blob)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("projection action payload is not canonical JSON") from exc
        if not isinstance(payload, dict):
            raise ValueError("projection action payload must be a JSON object")
        canonical = json.dumps(
            payload,
            ensure_ascii=True,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("ascii")
        if canonical != action.blob:
            raise ValueError("projection action payload is not canonical JSON")
        return payload

    def _apply_projection_markdown_write(
        self, action: MaterializedProjectionAction, receipt
    ) -> None:
        if action.blob is None:
            raise ValueError("markdown write requires bytes")
        try:
            content = action.blob.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ValueError("markdown projection must be UTF-8") from exc
        receipt.assert_current()
        self._atomic_write(str(action.target), content)

    def _apply_projection_path_rename(
        self, action: MaterializedProjectionAction, receipt
    ) -> None:
        if action.source is None:
            raise ValueError("path rename requires a source")
        source = str(action.source)
        target = str(action.target)
        if not self._file_exists(source):
            if self._file_exists(target):
                return
            raise FileNotFoundError(source)
        receipt.assert_current()
        self._rename_file(source, target)

    def _apply_projection_path_remove(
        self, action: MaterializedProjectionAction, receipt
    ) -> None:
        target = str(action.target)
        if self._file_exists(target):
            receipt.assert_current()
            self._unlink_file(target)

    def _index_projection_identity(
        self, action: MaterializedProjectionAction
    ) -> tuple[object, str, str]:
        parts = str(action.target).split("/")
        if len(parts) != 4 or parts[0] != "index":
            raise ValueError("index target must be index/<table>/<primary-key>/<value>")
        _prefix, table_name, primary_key, identity = parts
        table = Base.metadata.tables.get(table_name)
        if table is None or tuple(column.name for column in table.primary_key) != (primary_key,):
            raise ValueError("index target is not owned by the index schema")
        return table, primary_key, identity

    def _apply_projection_index_replace(
        self, action: MaterializedProjectionAction, receipt
    ) -> None:
        table, primary_key, identity = self._index_projection_identity(action)
        quoted_table = f'"{table.name}"'
        quoted_primary_key = f'"{primary_key}"'
        with self._connect() as connection:
            if action.blob is None:
                receipt.assert_current()
                connection.execute(
                    f"DELETE FROM {quoted_table} WHERE {quoted_primary_key} = ?",
                    (identity,),
                )
                receipt.assert_current()
                connection.commit()
                return
            payload = self._projection_payload(action)
            if set(payload) != {"row"} or not isinstance(payload["row"], dict):
                raise ValueError("index projection payload must contain one complete row")
            row = payload["row"]
            columns = tuple(column.name for column in table.columns)
            if set(row) != set(columns) or str(row[primary_key]) != identity:
                raise ValueError("index projection row does not match its target")
            quoted_columns = ",".join(f'"{column}"' for column in columns)
            placeholders = ",".join("?" for _column in columns)
            updates = ",".join(
                f'"{column}"=excluded."{column}"'
                for column in columns
                if column != primary_key
            )
            receipt.assert_current()
            connection.execute(
                f"INSERT INTO {quoted_table} ({quoted_columns}) VALUES ({placeholders}) "
                f"ON CONFLICT ({quoted_primary_key}) DO UPDATE SET {updates}",
                tuple(row[column] for column in columns),
            )
            receipt.assert_current()
            connection.commit()

    def _apply_projection_fts_replace(
        self, action: MaterializedProjectionAction, receipt
    ) -> None:
        parts = str(action.target).split("/")
        if len(parts) != 2 or parts[0] != "fts":
            raise ValueError("FTS target must be fts/<note-id>")
        note_id = parts[1]
        with self._connect() as connection:
            row = connection.execute(
                "SELECT rowid FROM notes WHERE note_id = ?", (note_id,)
            ).fetchone()
            if row is None:
                if action.blob is None:
                    return
                raise KeyError(f"Note {note_id} not found")
            rowid = row[0]
            receipt.assert_current()
            connection.execute("DELETE FROM notes_fts WHERE rowid = ?", (rowid,))
            if action.blob is not None:
                payload = self._projection_payload(action)
                if set(payload) != {"content", "title"} or not all(
                    isinstance(payload[key], str) for key in payload
                ):
                    raise ValueError("FTS projection payload is invalid")
                receipt.assert_current()
                connection.execute(
                    "INSERT INTO notes_fts(rowid, title, content) VALUES (?, ?, ?)",
                    (rowid, payload["title"], payload["content"]),
                )
            receipt.assert_current()
            connection.commit()

    # ─── Lifecycle ───────────────────────────────────────

    async def init(self) -> None:
        def _do():
            self._ensure_directory("notes")
            self._ensure_directory(".trash")
            self._ensure_directory(".meta")
            self._ensure_directory(".meta/version_backups")
            with self._connect() as connection:
                _initialize_database(connection)
            # R7: 升级到 trigram tokenizer 时重建 FTS5 索引并从 .md 文件回填正文
            self._rebuild_fts5_if_needed()
        await asyncio.to_thread(_do)

    def _rebuild_fts5_if_needed(self) -> None:
        """R7: 如果 FTS5 表使用旧 tokenizer (非 trigram), 重建索引并从 .md 文件回填正文.

        升级路径: 旧库的 notes_fts 用默认 unicode61 tokenizer, 且 content 列可能为空
        (触发器只在 INSERT 时塞空字符串, 正文由 _update_fts_content 单独写入).
        重建后用 trigram tokenizer, 并从 .md 文件读取正文回填, 保证正文搜索可用.
        """
        with self._connect() as conn:
            row = conn.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='notes_fts'"
            ).fetchone()
            if not row:
                return
            create_sql = row[0] or ""
            if 'trigram' in create_sql.lower():
                return
            # 旧 tokenizer — 重建
            conn.execute("DROP TABLE IF EXISTS notes_fts")
            conn.execute(FTS5_CREATE_SQL)
            # DROP TABLE 会连带删除 FTS5 触发器, 必须重建 (使用 IF NOT EXISTS 保证幂等)
            conn.execute(FTS5_TRIGGER_INSERT)
            conn.execute(FTS5_TRIGGER_UPDATE)
            conn.execute(FTS5_TRIGGER_DELETE)
            # 从 .md 文件读取正文回填 (rowid 对齐 notes 表)
            rows = conn.execute(
                "SELECT rowid, title, current_path FROM notes WHERE is_deleted = 0"
            ).fetchall()
            for rowid, title, current_path in rows:
                content = ""
                if current_path:
                    if self._file_exists(current_path):
                        content = self._read_text(current_path)
                conn.execute(
                    "INSERT INTO notes_fts (rowid, title, content) VALUES (?, ?, ?)",
                    (rowid, title, content),
                )
            conn.commit()

    async def close(self) -> None:
        self._notes.close()
        await self._index.close()
