"""Shared fixtures for file_system subsystem tests."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.file_system.api import get_file_system
from app.file_system.interfaces import FileSystem


@pytest.fixture
async def fs_instance(tmp_path: Path) -> FileSystem:
    """Create and initialise a FileSystemStorage instance for testing.

    Uses tmp_path so each test gets an isolated directory.
    """
    root_dir = tmp_path / "notes"
    index_db = tmp_path / "index" / "index.db"
    fs = await get_file_system(root_dir=root_dir, index_db=index_db)
    yield fs
    await fs.close()
