"""Offline composition for the Windows-local recovery operator.

This module deliberately does not bootstrap the HTTP runtime: startup runs
migrations and opens application resources, while recovery rehearsal must begin
from an offline data root and use read-only inspection views.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace

from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.db.migrations import MigrationCoordinator
from app.file_system.index_schema import IndexStoreSchema
from app.focus_session.effort_projection import EffortProjectionCompiler
from app.knowledge.consistency import KnowledgeConsistencyChecker
from app.mutation.recovery import MutationRecovery
from app.registry import CATALOG
from app.runtime.leases import RuntimeLeaseCoordinator

from .coordinator import RecoveryCoordinator


@dataclass(frozen=True, slots=True)
class _ReadOnlySpaceView:
    scope: object
    session_factory: async_sessionmaker
    db_path: Path
    notes_dir: Path
    index_db: Path
    catalog_hash: str


class LocalRecoveryService:
    """Own a recovery coordinator and the read-only engines it creates."""

    def __init__(self, active_root: Path) -> None:
        root = Path(active_root).expanduser().absolute()
        self._engines: dict[Path, AsyncEngine] = {}
        leases = RuntimeLeaseCoordinator(
            root,
            coordination_root=root.parent / f".{root.name}.runtime",
        )
        self.coordinator = RecoveryCoordinator(
            lease_coordinator=leases,
            active_root=root,
            catalog=CATALOG,
            meta=SimpleNamespace(db_path=root / "meta.db"),
            effort_projection_compiler=EffortProjectionCompiler,
            recovery_view_factory=self._view,
            migration_coordinator=MigrationCoordinator(),
            index_schema=IndexStoreSchema(),
            knowledge_checker=KnowledgeConsistencyChecker(),
            mutation_recovery_inspector=MutationRecovery(
                catalog=CATALOG,
                interpreter=None,
                projection_executor=None,
            ),
        )

    def _view(self, kind: str, path: Path):
        location = Path(path).expanduser().absolute()
        if kind == "meta":
            return SimpleNamespace(db_path=location)
        if kind != "space":
            raise ValueError(f"unsupported recovery view kind: {kind}")
        root = location if location.is_dir() else location.parent
        database = root / "space.db"
        engine = self._engines.get(database)
        if engine is None:
            url = f"sqlite+aiosqlite:///file:{database.resolve().as_posix()}?mode=ro&uri=true"
            engine = create_async_engine(url, poolclass=NullPool)
            self._engines[database] = engine
        return _ReadOnlySpaceView(
            scope=SimpleNamespace(space_id=root.name),
            session_factory=async_sessionmaker(engine, expire_on_commit=False),
            db_path=database,
            notes_dir=root / "notes",
            index_db=root / "index.db",
            catalog_hash=CATALOG.hash,
        )

    async def aclose(self) -> None:
        for engine in self._engines.values():
            await engine.dispose()
        self._engines.clear()
