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
import uuid
from pathlib import Path

import pytest

_tests_dir = Path(__file__).resolve().parent
_artifacts_root = (_tests_dir.parent / ".test-artifacts").resolve()
_RUN_ROOT_PATTERN = re.compile(r"run-[0-9a-f]{32}\Z")


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
    return f"{safe[:24]}_{short_hash}"


def _validate_run_root(run_root: Path) -> Path:
    """Return a canonical approved run root or reject malformed/escaped paths."""
    resolved = run_root.resolve()
    _ensure_inside_temp_root(resolved, _artifacts_root)
    if resolved.parent != _artifacts_root or not _RUN_ROOT_PATTERN.fullmatch(resolved.name):
        raise RuntimeError(f"Refusing to use invalid test run root: {resolved}")
    return resolved


def _allocate_run_root() -> Path:
    """Create a unique run root directly below the approved artifacts directory."""
    _artifacts_root.mkdir(parents=True, exist_ok=True)
    run_root = _artifacts_root / f"run-{uuid.uuid4().hex}"
    run_root.mkdir(parents=False, exist_ok=False)
    return _validate_run_root(run_root)


def _test_path_for_nodeid(run_root: Path, nodeid: str) -> Path:
    """Return the unique per-test sandbox path for *nodeid* within *run_root*."""
    approved_run_root = _validate_run_root(run_root)
    path = approved_run_root / _sanitize_nodeid(nodeid)
    _ensure_inside_temp_root(path, approved_run_root)
    return path


@pytest.fixture(scope="session")
def test_run_root() -> Path:
    """Create one repository-local run root without recursive in-suite cleanup.

    The Windows/Trae environment cannot reliably create deeply nested FileSystem
    test files under the standard OS temp directory. A unique backend-local root
    preserves isolation while leaving lifecycle cleanup to CI/workspace tooling.
    """
    return _allocate_run_root()


@pytest.fixture
def tmp_path(request: pytest.FixtureRequest, test_run_root: Path) -> Path:  # type: ignore[no-redef]
    """Return a fresh nodeid-hashed directory under the current run root.

    The run root is allocated below ``backend/.test-artifacts`` for Windows path
    compatibility. Neither this fixture nor session teardown recursively deletes
    it; CI/workspace lifecycle tooling owns eventual cleanup.
    """
    path = _test_path_for_nodeid(test_run_root, request.node.nodeid)
    path.mkdir(parents=False, exist_ok=False)
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
def _isolate_env(
    tmp_path: Path,
    test_run_root: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Path:
    """Point all PomodoroXII paths at the current test's unique sandbox.

    The directory is newly created from a nodeid hash below a run-scoped root,
    so isolation does not depend on deleting leftovers from earlier tests.
    """
    _ensure_inside_temp_root(tmp_path, test_run_root)

    meta_db = tmp_path / "meta.db"
    spaces_dir = tmp_path / "spaces"

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
