"""Entity metadata data classes for the PomodoroXII registry.

This module is pure data: no FastAPI imports, no SQLAlchemy imports,
no commit calls.  It defines the vocabulary used by ``app.registry``
to describe every ORM entity in a way that can be consumed by:

- Phase C ``SyncService`` (to dispatch FS+DB split vs DB-only writes)
- ``trash.py`` (to discover which entities support soft-delete)
- ``routes.v1.meta`` (to expose schema introspection over HTTP)
- External projects (via the ``/api/v1/meta/*`` endpoints)

The dataclasses are frozen so that registered specs are immutable once
the process loads the registry singleton.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class StorageType(str, Enum):
    """How an entity's data is physically stored."""

    DB_ONLY = "db_only"           # Pure DB table (task, session, folder, ...)
    FS_DB_SPLIT = "fs_db_split"   # FS holds content + DB holds meta (only note)
    SYSTEM = "system"             # System table (tombstone, sync_outbox, sync_audit_log)


class EntityCategory(str, Enum):
    """Business categorisation of an entity."""

    BUSINESS = "business"         # First-class business entity (sync-eligible)
    SYNC_INFRA = "sync_infra"     # Sync infrastructure table
    META = "meta"                 # Meta-layer table (spaces, meta_settings)
    SETTING = "setting"           # Per-space settings table


@dataclass(frozen=True)
class FieldSpec:
    """Metadata for a single ORM column."""

    name: str
    type: str                     # string|integer|datetime|json|text|boolean
    nullable: bool
    default: Any = None
    indexed: bool = False
    unique: bool = False
    description: str = ""


@dataclass(frozen=True)
class EntitySpec:
    """Full metadata specification for an ORM entity.

    Instances are registered into the global ``REGISTRY`` singleton by
    ``app.registry.builtin`` at import time.
    """

    name: str                     # entity_type, e.g. "note"
    model_path: str               # fully-qualified ORM path, e.g. "app.models.note.Note"
    table_name: str               # SQL table name, e.g. "notes"
    storage_type: StorageType
    category: EntityCategory
    sync_enabled: bool            # participates in Phase C sync
    soft_delete: bool             # supports trashed_at soft-delete column
    fields: tuple[FieldSpec, ...]
    primary_key: str = "id"
    description: str = ""
    # P1.2 + P2.1: sync protocol metadata.
    # sync_entity_type uses camelCase for legacy client compatibility
    # (e.g. "quickNote", "timeBlock"); effective_sync_entity_type falls
    # back to `name` when None.
    sync_entity_type: str | None = None
    pull_key: str | None = None
    # P2.1: routing / service / schema metadata (future scaffold use).
    route_prefix: str | None = None
    service_path: str | None = None
    schema_module: str | None = None
    schema_prefix: str | None = None
    # P2.1: delete strategy. hard_tombstone = default (Task-like);
    # soft_delete = trashed_at column; cascade_soft_delete = Folder;
    # fs_saga = Note (FS+DB split with saga compensation).
    delete_strategy: str = "hard_tombstone"
    # P2.1: feature flags for scaffold / introspection.
    route_enabled: bool = False
    mcp_schema_enabled: bool = True

    @property
    def field_names(self) -> tuple[str, ...]:
        """Return the ordered tuple of field names."""
        return tuple(f.name for f in self.fields)

    @property
    def effective_sync_entity_type(self) -> str:
        """sync_entity_type or fallback to name (snake_case default)."""
        return self.sync_entity_type or self.name

    @property
    def effective_pull_key(self) -> str:
        """pull_key or fallback to name + 's' (simple plural).

        Note: this naive pluralisation only works for regular cases
        (task→tasks, habit→habits). Entities with irregular plurals
        must declare pull_key explicitly in builtin.py.
        """
        return self.pull_key or (self.name + "s")
