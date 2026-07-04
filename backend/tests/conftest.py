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

import hashlib
import importlib
import os
import re
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


def _sanitize_nodeid(nodeid: str) -> str:
    """Create a filesystem-safe directory name from a pytest nodeid.

    The nodeid contains module paths and parametrization values that may
    include characters unsafe for directory names.  We sanitize them and
    append a short hash to avoid collisions between different modules that
    happen to have a test with the same name.
    """
    safe = re.sub(r"[^A-Za-z0-9_-]", "_", nodeid)
    safe = safe.strip("_")
    short_hash = hashlib.sha256(nodeid.encode()).hexdigest()[:16]
    return f"{safe[:80]}_{short_hash}"


@pytest.fixture
def tmp_path(request):  # type: ignore[no-redef]
    """Override pytest's tmp_path to return a per-test directory under tests/.tmp/.

    Trae sandbox blocks os.mkdir() outside the project, but creating
    subdirectories under the existing tests/ directory is allowed.
    We use a dedicated ``tests/.tmp/`` root (never ``tests/<test_name>/``)
    so this fixture cannot collide with real test packages such as
    ``tests/test_file_system``.
    """
    temp_root = _tests_dir / ".tmp"
    temp_root.mkdir(exist_ok=True)
    sanitized = _sanitize_nodeid(request.node.nodeid)
    path = temp_root / sanitized
    path.mkdir(exist_ok=True)
    return path


def _ensure_inside_temp_root(path: Path, temp_root: Path) -> None:
    """Raise if *path* resolves outside the dedicated temp root.

    This guard prevents accidental deletion of real test packages (e.g.
    ``tests/test_file_system``) if the tmp_path override is misconfigured.
    """
    resolved = path.resolve()
    root_resolved = temp_root.resolve()
    # Allow the root itself; any subpath must start with root + sep.
    if resolved == root_resolved:
        return
    prefix = str(root_resolved) + os.sep
    if not str(resolved).startswith(prefix):
        raise RuntimeError(
            f"Refusing to operate on path outside temp root: {resolved} "
            f"(root: {root_resolved})"
        )


@pytest.fixture(autouse=True)
def _isolate_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point all PomodoroXII paths at a per-test temp directory.

    ``tmp_path`` is overridden to ``tests/.tmp/<sanitized_nodeid>/`` so
    each test gets its own filesystem sandbox.  We recreate that directory
    from scratch before every test to ensure no .db files, notes/, or
    spaces/ leak across tests.
    """
    import shutil

    temp_root = _tests_dir / ".tmp"
    _ensure_inside_temp_root(tmp_path, temp_root)
    _ensure_inside_temp_root(temp_root, temp_root)
    if tmp_path.exists():
        shutil.rmtree(tmp_path, ignore_errors=True)
    tmp_path.mkdir(parents=True, exist_ok=True)

    meta_db = tmp_path / "meta.db"
    spaces_dir = tmp_path / "spaces"

    # P2.4 fix follow-up: fs_instance stores its SQLite index DB under
    # tmp_path/index/index.db. Leftover index DBs leak across test runs
    # because the file is opened by aiosqlite and outlives the fixture.
    index_dir = tmp_path / "index"
    if index_dir.exists():
        shutil.rmtree(index_dir, ignore_errors=True)

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
    from app.db.meta_session import close_meta_db, init_meta_db
    from app.space_manager import (
        dispose_space_engine_manager,
        get_space_engine_manager,
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

    from httpx import ASGITransport, AsyncClient

    from app.db.meta_session import close_meta_db, init_meta_db
    from app.main import create_app
    from app.space_manager import dispose_space_engine_manager

    await init_meta_db()
    app = create_app()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        yield ac
    await dispose_space_engine_manager()
    await close_meta_db()


@pytest.fixture(scope="session", autouse=True)
def _cleanup_temp_root() -> None:
    """Clean up the dedicated temp root created by the tmp_path override.

    Each test uses ``tests/.tmp/<sanitized_nodeid>/`` as its temp directory.
    This fixture removes the entire ``tests/.tmp/`` directory after the
    test session.  It never globs ``tests/test_*/`` to avoid deleting real
    test packages such as ``tests/test_file_system``.
    """
    yield
    import shutil

    temp_root = _tests_dir / ".tmp"
    _ensure_inside_temp_root(temp_root, temp_root)
    if temp_root.exists():
        shutil.rmtree(temp_root, ignore_errors=True)
