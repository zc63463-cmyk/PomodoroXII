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

import asyncio
import hashlib
import importlib
import os
import re
import tempfile
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest

_tests_dir = Path(__file__).resolve().parent
_backend_dir = _tests_dir.parent
_project_root = _backend_dir.parent
_DEFAULT_ARTIFACTS_ROOT = (
    Path(tempfile.gettempdir()) / "pomodoroxii-test-artifacts"
).resolve()
_EXTERNAL_ARTIFACTS_ROOT_PATTERN = re.compile(r"pomodoroxii-test-artifacts\Z", re.IGNORECASE)
_RUN_ROOT_PATTERN = re.compile(r"run-[0-9a-f]{16}\Z")


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line(
        "markers",
        "self_contained_measurement: skip application fixture bootstrap for an isolated probe",
    )
    config.addinivalue_line(
        "markers",
        "provisioned_space_storage: explicitly provision storage for Spaces "
        "created through the test HTTP client",
    )


def _resolve_artifacts_root(configured_root: str | Path | None = None) -> Path:
    """Resolve and approve the dedicated root used for persistent test artifacts.

    New runs default to the OS temporary directory. An environment override must
    resolve outside the source tree, must not be a drive root or home directory,
    and must use the explicit ``pomodoroxii-test-artifacts`` directory name.
    """
    if configured_root is None:
        configured_root = os.environ.get("POMODOROXII_TEST_ARTIFACTS_ROOT")
    if configured_root is None:
        configured_root = _DEFAULT_ARTIFACTS_ROOT

    resolved = Path(configured_root).expanduser().resolve()
    home = Path.home().resolve()
    if resolved == resolved.parent or resolved == home or resolved in home.parents:
        raise RuntimeError(f"Refusing broad test artifacts root: {resolved}")
    if resolved == _project_root or _project_root in resolved.parents:
        raise RuntimeError(f"Refusing test artifacts root inside project source: {resolved}")
    if not _EXTERNAL_ARTIFACTS_ROOT_PATTERN.fullmatch(resolved.name):
        raise RuntimeError(
            "Configured test artifacts root must be a dedicated directory named "
            f"'pomodoroxii-test-artifacts': {resolved}"
        )
    return resolved


_artifacts_root = _resolve_artifacts_root()


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
    return f"{safe[:8]}_{short_hash}"


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
    run_root = _artifacts_root / f"run-{uuid.uuid4().hex[:16]}"
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
    """Create one approved short run root without recursive in-suite cleanup.

    By default artifacts stay under the OS temporary directory in a dedicated
    ``pomodoroxii-test-artifacts`` root. Set ``POMODOROXII_TEST_ARTIFACTS_ROOT``
    to use another external root with the same dedicated directory name.
    Lifecycle cleanup remains the responsibility of CI/workspace tooling.
    """
    return _allocate_run_root()


@pytest.fixture
def tmp_path(request: pytest.FixtureRequest, test_run_root: Path) -> Path:  # type: ignore[no-redef]
    """Return a fresh nodeid-hashed directory under the current run root.

    The run root is allocated below the dedicated OS temporary artifacts root.
    Neither this fixture nor session teardown recursively deletes it;
    CI/workspace lifecycle tooling owns eventual cleanup.
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
    request: pytest.FixtureRequest,
    monkeypatch: pytest.MonkeyPatch,
) -> Path:
    """Point all PomodoroXII paths at the current test's unique sandbox.

    The directory is newly created from a nodeid hash below a run-scoped root,
    so isolation does not depend on deleting leftovers from earlier tests.
    """
    if request.node.get_closest_marker("self_contained_measurement") is not None:
        return tmp_path

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

    # db.base has no settings dep, but models import its bases; keep order.
    # Purge model modules before reloading the bases so every ORM class is
    # registered exactly once on the fresh registries. Reloading a model module
    # in place leaves its previous class in SQLAlchemy's string lookup table.
    import sys

    for key in list(sys.modules.keys()):
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

    # Phase B: reload business service utilities (time.py has no model deps)
    import app.services.time as services_time_module
    importlib.reload(services_time_module)

    # Phase B: reload business models (registers all tables on new Base.metadata)
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

    # The production catalog intentionally keeps its startup-frozen model
    # identities. Tests replace the ORM graph per case, so rebind only the
    # test-local sync registry to those fresh classes without replacing CATALOG.
    import app.registry.sync_registry as sync_registry_module

    production_catalog = sync_registry_module.CATALOG
    fresh_models: dict[str, type] = {}
    for spec in production_catalog.list_sync_enabled():
        model_path = spec.model_path
        module_name, _, class_name = model_path.rpartition(".")
        fresh_models[spec.name] = getattr(
            importlib.import_module(module_name), class_name
        )

    class _TestSyncCatalog:
        def list_sync_enabled(self):
            return production_catalog.list_sync_enabled()

        def model_for(self, name: str):
            return fresh_models[name]

    monkeypatch.setattr(sync_registry_module, "CATALOG", _TestSyncCatalog())

    import app.auth.security as security_module
    importlib.reload(security_module)

    import app.space_manager as space_manager_module
    importlib.reload(space_manager_module)

    # Test setup owns fixture creation; production init_meta_db only opens a
    # database that the runtime migration coordinator has already prepared.
    if request.node.name != "test_missing_bound_store_never_creates_companion":
        from app.db.migrations import run_migrations

        run_migrations("meta", settings_module.settings.meta_db_path)

    # Legacy MCP unit tests explicitly install a runtime without entering the
    # process bootstrap. Adapt that test-only entrypoint to the same immutable
    # RuntimeServices shape; production uses install_mcp_runtime_services.
    import app.mcp.server as mcp_server
    from app.runtime.bootstrap import _FreshAuthorizedSpaceScope

    def install_test_runtime(runtime) -> None:
        if runtime is None:
            mcp_server._installed_runtime_services = None
            mcp_server._installed_space_runtime = None
            return
        mcp_server._installed_runtime_services = SimpleNamespace(
            runtime=runtime,
            scope=_FreshAuthorizedSpaceScope(runtime),
            executor=SimpleNamespace(),
            credential_verifier=None,
            catalog=None,
        )
        mcp_server._installed_space_runtime = runtime

    monkeypatch.setattr(mcp_server, "install_space_runtime", install_test_runtime)

    # NOTE: app.deps imports app.errors (not reloaded) and app.auth.security
    # (reloaded above). Reload deps so it rebinds security + space_manager.
    import app.deps as deps_module
    importlib.reload(deps_module)

    return tmp_path


@pytest.fixture
async def space_session(_isolate_env: Path):
    """Yield an AsyncSession for a per-test space DB with all tables created.

    The test fixture directly runs
    Base.metadata.create_all (excluding meta tables) on the space engine,
    so all 18 business tables are available.
    """
    from app.db.meta_session import close_meta_db, init_meta_db
    from app.db.migrations import run_migrations
    from app.db.session import create_engine, create_session_factory

    await init_meta_db()
    from app.settings import settings

    database = settings.space_db_path("spc_test")
    database.parent.mkdir(parents=True, exist_ok=True)
    await asyncio.to_thread(run_migrations, "space", database)
    engine = create_engine(
        f"sqlite+aiosqlite:///{database.as_posix()}", echo=settings.debug
    )
    session = create_session_factory(engine)()
    try:
        yield session
    finally:
        await session.close()
        await engine.dispose()
        await close_meta_db()


@pytest.fixture
def space_storage_provisioner(_isolate_env: Path):
    """Return an explicit, sandbox-bound Space storage provisioner."""

    async def provision(space_id: str) -> None:
        from app.db.migrations import run_migrations
        from app.runtime.joined_thread import run_joined_thread
        from app.settings import settings

        parent = settings.spaces_data_dir / space_id
        _ensure_inside_temp_root(parent, _isolate_env)
        database = settings.space_db_path(space_id)
        notes = settings.space_notes_dir(space_id)
        index = parent / "index.db"
        if not parent.is_dir() or not notes.is_dir():
            raise RuntimeError("registered test Space directories are missing")
        if database.exists() or index.exists():
            raise RuntimeError("registered test Space storage already exists")

        created = [
            database,
            database.with_name(f"{database.name}-wal"),
            database.with_name(f"{database.name}-shm"),
            database.with_name(f"{database.name}-journal"),
            index,
            index.with_name(f"{index.name}-wal"),
            index.with_name(f"{index.name}-shm"),
            index.with_name(f"{index.name}-journal"),
        ]
        try:
            await run_joined_thread(lambda: run_migrations("space", database))

            def create_index() -> None:
                import sqlite3

                connection = sqlite3.connect(index)
                connection.close()

            await run_joined_thread(create_index)
        except BaseException:
            for path in reversed(created):
                if path.is_file():
                    path.unlink()
            raise

    return provision


@pytest.fixture
async def client(
    _isolate_env: Path,
    request: pytest.FixtureRequest,
    space_storage_provisioner,
):
    """Yield an httpx AsyncClient backed by ASGITransport.

    ASGITransport does not trigger the app's lifespan, so the fixture
    enters the application lifespan explicitly.
    """
    import sys

    # Purge route and main modules so they re-import with the fresh
    # settings / deps / model bindings established by _isolate_env.
    for key in list(sys.modules.keys()):
        if key.startswith("app.routes.") or key == "app.main":
            del sys.modules[key]

    from httpx import ASGITransport, AsyncClient

    from app.main import create_app
    from app.settings import settings

    app = create_app()
    provision_storage = (
        request.node.get_closest_marker("provisioned_space_storage") is not None
    )

    async def provision_created_space(response) -> None:
        if (
            provision_storage
            and response.request.method == "POST"
            and response.request.url.path == "/api/v1/spaces"
            and response.status_code == 201
        ):
            await response.aread()
            space_id = response.json()["id"]
            if not (
                settings.space_db_path(space_id).exists()
                and settings.space_notes_dir(space_id).exists()
                and (settings.spaces_data_dir / space_id / "index.db").exists()
            ):
                await space_storage_provisioner(space_id)

    async with app.router.lifespan_context(app):
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
            event_hooks={"response": [provision_created_space]},
        ) as ac:
            yield ac


# -- S3 mutation fixture factory for TS1 Task Space tests ---------------------

from sqlalchemy.ext.asyncio import async_sessionmaker

from app.commands.entity import EntityCommand
from app.registry import CATALOG
from app.task_space.compiler import TaskSpaceCompiler
from app.task_space.module import DefaultTaskSpaceCommandModule
from app.task_space.queries import DefaultTaskSpaceQueryModule
from tests.mutation_fixture import MutationFixture, build_mutation_fixture
from tests.task_space_fixture import FrozenClock, TaskSpaceFixture


@pytest.fixture
def mutation_fixture_factory(space_session, tmp_path):
    """Return a factory that constructs mutation fixtures with given policies."""

    sessions = async_sessionmaker(space_session.bind, expire_on_commit=False)
    stage_root = tmp_path / "stages"
    projection_root = tmp_path / "projection"
    database_path = Path(str(space_session.bind.url.database))
    fixtures: list[MutationFixture] = []

    def factory(*, policies: tuple = ()) -> MutationFixture:
        fixture = build_mutation_fixture(
            sessions=sessions,
            catalog=CATALOG,
            policies=policies,
            stage_root=stage_root,
            projection_root=projection_root,
            database_path=database_path,
        )
        fixtures.append(fixture)
        return fixture

    yield factory

    for fixture in reversed(fixtures):
        fixture.close()


@pytest.fixture
async def task_space_fixture(mutation_fixture_factory):
    clock = FrozenClock()
    policy = TaskSpaceCompiler(clock.now_iso_ms)
    mutation = mutation_fixture_factory(policies=(policy,))
    fixture = TaskSpaceFixture(
        mutation=mutation,
        clock=clock,
        module=DefaultTaskSpaceCommandModule(mutation.uow),
        queries=DefaultTaskSpaceQueryModule(),
        entity_commands=EntityCommand(mutation.catalog),
    )
    try:
        yield fixture
    finally:
        fixture.mutation.close()
