"""Deterministically populate the backend N-1 certification fixture."""

from __future__ import annotations

import importlib
import json
import os
import sys
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sqlalchemy import func, select

SUBJECT_SHA = "1e4f0fc6d82ce6203f4bada0e84b518b16fcd97f"
NOTE_BODIES = {
    "note_cert_a": "# Certification Note A\n\nDeterministic body A.\n",
    "note_cert_b": "# Certification Note B\n\nDeterministic body B.\n",
}


@dataclass(frozen=True, slots=True)
class FixtureReceipt:
    space_id: str
    meta_db: Path
    space_db: Path
    index_db: Path
    entity_counts: dict[str, int]
    note_bodies: dict[str, str]
    sync_waterline: int


_ENVIRONMENT_KEYS = (
    "POMODOROXII_DATABASE_URL",
    "POMODOROXII_SPACES_DATA_DIR",
    "POMODOROXII_ENVIRONMENT",
    "POMODOROXII_SECRET_KEY",
)
_MISSING = object()


@contextmanager
def _fixture_environment(values: Mapping[str, str]) -> Iterator[None]:
    previous = {key: os.environ.get(key, _MISSING) for key in _ENVIRONMENT_KEYS}
    os.environ.update(values)
    try:
        yield
    finally:
        for key, value in previous.items():
            if value is _MISSING:
                os.environ.pop(key, None)
            else:
                assert isinstance(value, str)
                os.environ[key] = value


def _reload_settings_graph() -> None:
    """Reload the settings-dependent graph in tests/conftest.py order."""
    import app.settings as settings_module

    importlib.reload(settings_module)

    for key in list(sys.modules):
        if key == "app.db.models" or key.startswith("app.db.models."):
            del sys.modules[key]

    import app.db.base as db_base_module

    importlib.reload(db_base_module)
    import app.db.metadata as db_metadata_module
    import app.db.models.meta as models_meta_module  # noqa: F401

    importlib.reload(db_metadata_module)
    import app.db.session as db_session_module

    importlib.reload(db_session_module)
    import app.db.meta_session as meta_session_module

    importlib.reload(meta_session_module)

    import app.services.time as services_time_module

    importlib.reload(services_time_module)

    for key in list(sys.modules):
        if key.startswith("app.models."):
            del sys.modules[key]
    import app.models as business_models

    importlib.reload(business_models)

    for key in list(sys.modules):
        if key.startswith("app.services.") and key != "app.services.time":
            del sys.modules[key]

    import app.auth.security as security_module

    importlib.reload(security_module)
    import app.space_manager as space_manager_module

    importlib.reload(space_manager_module)
    import app.deps as deps_module

    importlib.reload(deps_module)


async def _close_fixture_resources(
    *,
    file_system: Any,
    space_session: Any,
    dispose_space_engines: Any,
    close_meta_db: Any,
) -> None:
    """Close every fixture resource even when an earlier close fails."""
    try:
        if file_system is not None:
            await file_system.close()
    finally:
        try:
            if space_session is not None:
                await space_session.close()
        finally:
            try:
                await dispose_space_engines()
            finally:
                await close_meta_db()


async def populate_fixture(
    data_root: Path,
    manifest_path: Path,
) -> FixtureReceipt:
    manifest = json.loads(manifest_path.resolve(strict=True).read_text(encoding="utf-8"))
    if manifest.get("subject_sha") != SUBJECT_SHA:
        raise AssertionError("N-1 fixture subject SHA does not match the locked baseline")

    data_root = data_root.expanduser().resolve(strict=False)
    if data_root.exists():
        raise FileExistsError(f"fixture data root already exists: {data_root}")

    space_id = str(manifest["space_id"])
    fixed_timestamp = str(manifest["fixed_timestamp"])
    meta_db = data_root / "meta.db"
    spaces_dir = data_root / "spaces"
    space_root = spaces_dir / space_id
    space_db = space_root / "space.db"
    notes_dir = space_root / "notes"
    index_db = space_root / "index.db"
    environment = {
        "POMODOROXII_DATABASE_URL": f"sqlite+aiosqlite:///{meta_db.as_posix()}",
        "POMODOROXII_SPACES_DATA_DIR": str(spaces_dir),
        "POMODOROXII_ENVIRONMENT": "development",
        "POMODOROXII_SECRET_KEY": (
            "n-minus-one-fixture-secret-key-95001-not-for-production-use"
        ),
    }

    receipt: FixtureReceipt | None = None
    try:
        with _fixture_environment(environment):
            _reload_settings_graph()

            from app.db.meta_session import (
                close_meta_db,
                get_meta_session_factory,
                init_meta_db,
            )
            from app.db.models.meta import Space
            from app.file_system.api import get_file_system
            from app.file_system.interfaces import FileSystem
            from app.models.note import Note
            from app.models.quick_note import QuickNote
            from app.models.task import Task
            from app.services.note import NoteService
            from app.services.sync_outbox import get_current_cursor, record_sync_event
            from app.space_manager import (
                dispose_space_engine_manager,
                get_space_engine_manager,
            )

            space_session: Any = None
            file_system: FileSystem | None = None
            try:
                await init_meta_db()
                meta_factory = get_meta_session_factory()
                async with meta_factory() as meta_session:
                    meta_session.add(
                        Space(
                            id=space_id,
                            name="N-1 Certification Fixture",
                            db_path=str(space_db),
                            notes_dir=str(notes_dir),
                            is_default=True,
                            created_at=fixed_timestamp,
                            updated_at=fixed_timestamp,
                        )
                    )
                    await meta_session.commit()

                manager = get_space_engine_manager()
                space_session = await manager.get_session(space_id, db_path=space_db)
                file_system = await get_file_system(notes_dir, index_db)

                task = Task(
                    id="task_cert",
                    title="N-1 task",
                    created_at=fixed_timestamp,
                    updated_at=fixed_timestamp,
                )
                space_session.add(task)
                await space_session.flush()
                await record_sync_event(
                    space_session,
                    entity_type="task",
                    entity_id=task.id,
                    action="create",
                    payload={
                        "id": task.id,
                        "title": task.title,
                        "updated_at": task.updated_at,
                    },
                )

                quick_note = QuickNote(
                    id="quick_cert",
                    content="N-1 quick note",
                    tags="[]",
                    created_at=fixed_timestamp,
                    updated_at=fixed_timestamp,
                )
                space_session.add(quick_note)
                await space_session.flush()
                await record_sync_event(
                    space_session,
                    entity_type="quick_note",
                    entity_id=quick_note.id,
                    action="create",
                    payload={
                        "id": quick_note.id,
                        "content": quick_note.content,
                        "tags": quick_note.tags,
                        "updated_at": quick_note.updated_at,
                    },
                )

                note_service = NoteService(space_session, file_system)
                for note_id, body in NOTE_BODIES.items():
                    await note_service.create(
                        {
                            "id": note_id,
                            "title": f"Certification Note {note_id[-1].upper()}",
                            "content": body,
                            "tags": [],
                            "created_at": fixed_timestamp,
                            "updated_at": fixed_timestamp,
                        }
                    )

                await space_session.commit()

                entity_counts = {
                    "tasks": int(
                        await space_session.scalar(select(func.count()).select_from(Task))
                        or 0
                    ),
                    "quick_notes": int(
                        await space_session.scalar(
                            select(func.count()).select_from(QuickNote)
                        )
                        or 0
                    ),
                    "notes": int(
                        await space_session.scalar(select(func.count()).select_from(Note))
                        or 0
                    ),
                }
                note_bodies = {
                    note_id: await file_system.read_note(note_id)
                    for note_id in NOTE_BODIES
                }
                receipt = FixtureReceipt(
                    space_id=space_id,
                    meta_db=meta_db,
                    space_db=space_db,
                    index_db=index_db,
                    entity_counts=entity_counts,
                    note_bodies=note_bodies,
                    sync_waterline=await get_current_cursor(space_session),
                )
            finally:
                await _close_fixture_resources(
                    file_system=file_system,
                    space_session=space_session,
                    dispose_space_engines=dispose_space_engine_manager,
                    close_meta_db=close_meta_db,
                )
    finally:
        _reload_settings_graph()

    if receipt is None:
        raise RuntimeError("fixture population completed without a receipt")
    return receipt
