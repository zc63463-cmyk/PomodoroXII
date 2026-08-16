"""FastAPI dependency injection — FileSystem instance factory."""
from __future__ import annotations

import asyncio
from dataclasses import asdict
from enum import Enum
from pathlib import Path

from app.file_system.engine import FileSystemStorage
from app.file_system.interfaces import FileSystem
from app.runtime.contained_io import ContainedSpaceOpens

_init_lock = asyncio.Lock()

async def get_file_system(root_dir: Path, index_db: Path) -> FileSystem:
    """Create and initialize a FileSystem instance."""
    root_dir.mkdir(parents=True, exist_ok=True)
    index_db.parent.mkdir(parents=True, exist_ok=True)
    fs = FileSystemStorage(root_dir=root_dir, index_db=index_db)
    await fs.init()
    return fs


async def open_contained_file_system(opens: ContainedSpaceOpens) -> FileSystem:
    """Open the production file system from transferred opaque authorities."""
    notes_handle, index_target = opens.take_file_system_handles()
    file_system = FileSystemStorage.from_bound_handles(notes_handle, index_target)
    try:
        await file_system.init()
    except BaseException:
        await file_system.close()
        raise
    return file_system


async def open_existing_file_system(opens: ContainedSpaceOpens) -> FileSystem:
    """Open and verify an existing contained store without creating it."""
    if not isinstance(opens, ContainedSpaceOpens):
        raise TypeError("open_existing_file_system requires ContainedSpaceOpens")
    from app.file_system.index_schema import IndexStoreSchema

    index_status = IndexStoreSchema().verify_open(opens.index_target)
    if not index_status.valid:
        raise RuntimeError("index schema is not valid")
    notes_handle, index_target = opens.take_file_system_handles()
    return FileSystemStorage.from_bound_handles(notes_handle, index_target)


async def provision_file_system(root_dir: Path, index_db: Path) -> FileSystem:
    """Create a fresh path-backed store for isolated provisioning only."""
    root_dir.mkdir(parents=True, exist_ok=False)
    index_db.parent.mkdir(parents=True, exist_ok=True)
    file_system = FileSystemStorage(root_dir=root_dir, index_db=index_db)
    await file_system.init()
    return file_system

def serialize(obj) -> dict:
    """Convert a dataclass to a JSON-serializable dict."""
    d = asdict(obj)
    return {k: (v.value if isinstance(v, Enum) else v) for k, v in d.items()}
