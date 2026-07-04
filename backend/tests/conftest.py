"""Shared test fixtures for the PomodoroXII backend test suite.

Each test run uses a throwaway temp directory for the meta DB and per-space
data so nothing ever touches the developer's real ``./data`` folder.

Because many app modules capture the ``settings`` singleton at import time
(``from app.settings import settings``), after reloading ``app.settings``
we also reload the modules that depend on it so they pick up the new
singleton. Modules that do NOT depend on settings (``app.errors``,
``app.logging``) are intentionally NOT reloaded — reloading them would
create duplicate class objects that break ``isinstance`` / exception
matching against the versions other modules already bound.
"""

from __future__ import annotations

import importlib
import os
import tempfile
from pathlib import Path

import pytest

# Trae IDE sandbox blocks Windows O_TEMPORARY flag file creation and
# even plain os.mkdir()/os.open() in temp dirs. We override pytest's
# tmp_path fixture below to return an existing directory, bypassing
# tempfile.mkdtemp() which calls os.mkdir().
_tests_dir = Path(__file__).resolve().parent
tempfile.tempdir = str(_tests_dir)
os.environ["TMP"] = str(_tests_dir)
os.environ["TEMP"] = str(_tests_dir)
os.environ["TMPDIR"] = str(_tests_dir)


@pytest.fixture
def tmp_path():  # type: ignore[no-redef]
    """Override pytest's tmp_path to return the tests/ directory.

    Trae sandbox blocks os.mkdir(), so we cannot create per-test temp
    directories. Tests that need filesystem isolation must use
    monkeypatch to point env vars at in-memory or existing paths,
    rather than relying on tmp_path subdirectories.
    """
    return _tests_dir


@pytest.fixture(autouse=True)
def _isolate_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point all PomodoroXII paths at a per-test temp directory."""
    meta_db = tmp_path / "meta.db"
    spaces_dir = tmp_path / "spaces"

    # P2.4 fix: tmp_path is overridden to tests/ (Trae sandbox workaround),
    # so .db files and spaces/ dir persist across test runs. Delete them
    # before each test to ensure a clean state (otherwise /auth/setup
    # returns 409 Conflict from leftover admin rows).
    import shutil
    for stale_db in tmp_path.glob("*.db"):
        try:
            stale_db.unlink()
        except OSError:
            pass
    if spaces_dir.exists():
        shutil.rmtree(spaces_dir, ignore_errors=True)

    monkeypatch.setenv("POMODOROXII_DATABASE_URL", f"sqlite+aiosqlite:///{meta_db.as_posix()}")
    monkeypatch.setenv("POMODOROXII_SPACES_DATA_DIR", str(spaces_dir))
    monkeypatch.setenv("POMODOROXII_ENVIRONMENT", "development")
    monkeypatch.setenv("POMODOROXII_SECRET_KEY", "test-secret-key-not-for-production-use")

    # Reload only modules that capture the settings singleton at import time,
    # in dependency order so each rebinds to the fresh settings.
    import app.settings as settings_module
    importlib.reload(settings_module)

    # db.base has no settings dep, but models import Base from it; keep order.
    import app.db.base as db_base_module
    importlib.reload(db_base_module)
    import app.db.models.meta as models_meta_module
    # The import above may register tables on the new Base.metadata.
    # Clear them so the subsequent reload can register fresh.
    db_base_module.Base.metadata.clear()
    importlib.reload(models_meta_module)
    import app.db.models as models_module
    importlib.reload(models_module)
    import app.db.session as db_session_module
    importlib.reload(db_session_module)
    import app.db.meta_session as meta_session_module
    importlib.reload(meta_session_module)

    # Phase B: reload business service utilities (time.py has no model deps)
    import app.services.time as services_time_module
    importlib.reload(services_time_module)

    # Phase B: reload business models (registers 18 tables on new Base.metadata)
    # Must purge submodules from sys.modules so they re-import with the new Base.
    import sys
    for key in list(sys.modules.keys()):
        if key.startswith("app.models."):
            del sys.modules[key]
    import app.models as business_models
    importlib.reload(business_models)

    # Phase B: purge service submodules (except time, already reloaded above)
    # so they re-import with the fresh model classes on next use.
    for key in list(sys.modules.keys()):
        if key.startswith("app.services.") and key != "app.services.time":
            del sys.modules[key]

    import app.auth.security as security_module
    importlib.reload(security_module)

    import app.space_manager as space_manager_module
    importlib.reload(space_manager_module)

    # NOTE: app.deps imports app.errors (not reloaded) and app.auth.security
    # (reloaded above). Reload deps so it rebinds security + space_manager.
    import app.deps as deps_module
    importlib.reload(deps_module)

    return tmp_path


@pytest.fixture
async def space_session(_isolate_env: Path):
    """Yield an AsyncSession for a per-test space DB with all tables created.

    The space_manager.get_session() call internally runs
    Base.metadata.create_all (excluding meta tables) on the space engine,
    so all 18 business tables are available.
    """
    from app.db.meta_session import init_meta_db, close_meta_db
    from app.space_manager import (
        get_space_engine_manager,
        dispose_space_engine_manager,
    )

    await init_meta_db()
    manager = get_space_engine_manager()
    session = await manager.get_session("spc_test")
    try:
        yield session
    finally:
        await session.close()
        await dispose_space_engine_manager()
        await close_meta_db()


@pytest.fixture
async def client(_isolate_env: Path):
    """Yield an httpx AsyncClient backed by ASGITransport.

    ASGITransport does not trigger the app's lifespan, so we must
    manually initialise the meta database before creating the app.
    """
    import sys

    # Purge route and main modules so they re-import with the fresh
    # settings / deps / model bindings established by _isolate_env.
    for key in list(sys.modules.keys()):
        if key.startswith("app.routes.") or key == "app.main":
            del sys.modules[key]

    from app.main import create_app
    from app.db.meta_session import init_meta_db, close_meta_db
    from app.space_manager import dispose_space_engine_manager
    from httpx import AsyncClient, ASGITransport

    await init_meta_db()
    app = create_app()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        yield ac
    await dispose_space_engine_manager()
    await close_meta_db()
