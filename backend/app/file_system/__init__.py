"""File system rebuild module — note_id-decoupled note storage.

Stage 1: schema (SQLAlchemy 2.0 models + FTS5), interfaces (ABC), models (Pydantic DTOs).
Stage 2: engine (FileSystemStorage implementation).
Stage 3+: API, frontend, MCP, CLI layers.
"""
from app.file_system.interfaces import (
    FileSystem,
    FolderMeta,
    NoteLevel,
    NoteMeta,
    NoteStatus,
    SearchResult,
    VersionRecord,
)
from app.file_system.schema import (
    Base,
    NoteLink,
    NotePathHistory,
    NoteVersion,
    init_database,
)
from app.file_system.schema import (
    FolderModel as FolderORM,
)
from app.file_system.schema import (
    NoteModel as NoteORM,
)

__all__ = [
    "FileSystem",
    "FolderMeta",
    "NoteMeta",
    "NoteStatus",
    "NoteLevel",
    "SearchResult",
    "VersionRecord",
    "Base",
    "NoteORM",
    "FolderORM",
    "NotePathHistory",
    "NoteVersion",
    "NoteLink",
    "init_database",
]
