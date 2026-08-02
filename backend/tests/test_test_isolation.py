"""Regression tests for pytest filesystem isolation and deletion safety."""

from __future__ import annotations

import ast
import asyncio
import threading
import uuid
from pathlib import Path

import pytest

from tests import conftest as suite_conftest


async def _registered_space_token(client) -> tuple[str, str]:
    await client.post(
        "/api/v1/auth/setup", json={"password": "test-password-123"}
    )
    login = await client.post(
        "/api/v1/auth/login", json={"password": "test-password-123"}
    )
    master_token = login.json()["access_token"]
    headers = {"Authorization": f"Bearer {master_token}"}
    created = await client.post(
        "/api/v1/spaces", json={"name": "Fixture Space"}, headers=headers
    )
    space_id = created.json()["id"]
    issued = await client.post(
        f"/api/v1/spaces/{space_id}/token", headers=headers
    )
    return issued.json()["space_token"], space_id


async def _missing_registered_space_token(client) -> tuple[str, str]:
    await client.post(
        "/api/v1/auth/setup", json={"password": "test-password-123"}
    )
    login = await client.post(
        "/api/v1/auth/login", json={"password": "test-password-123"}
    )
    master_token = login.json()["access_token"]
    space_id = f"spc_missing_{uuid.uuid4().hex}"
    from app.db.meta_session import get_meta_session
    from app.db.models.meta import Space
    from app.settings import settings

    settings.spaces_data_dir.mkdir(parents=True, exist_ok=True)
    (settings.spaces_data_dir / space_id).mkdir()
    async for session in get_meta_session():
        session.add(
            Space(
                id=space_id,
                name="Missing Fixture Space",
                db_path=str(settings.space_db_path(space_id)),
                notes_dir=str(settings.space_notes_dir(space_id)),
            )
        )
        await session.commit()
        break
    issued = await client.post(
        f"/api/v1/spaces/{space_id}/token",
        headers={"Authorization": f"Bearer {master_token}"},
    )
    return issued.json()["space_token"], space_id


def _path_builder():
    builder = getattr(suite_conftest, "_test_path_for_nodeid", None)
    assert callable(builder), "conftest must expose a nodeid-to-test-directory builder"
    return builder


def _run_root_allocator():
    allocator = getattr(suite_conftest, "_allocate_run_root", None)
    assert callable(allocator), "conftest must expose a safe run-root allocator"
    return allocator


def test_different_nodeids_use_different_test_directories(tmp_path: Path):
    """Different pytest nodeids must never resolve to the same test sandbox."""
    builder = _path_builder()
    run_root = tmp_path.parent

    first = builder(run_root, "tests/test_alpha.py::test_same_name")
    second = builder(run_root, "tests/test_beta.py::test_same_name")

    assert first != second


def test_nodeid_mapping_is_stable_and_keeps_windows_path_budget(tmp_path: Path):
    """Nodeid mapping must be stable and leave room for nested Windows paths."""
    builder = _path_builder()
    nodeid = "tests/" + "very-long-nodeid-" * 30

    first = builder(tmp_path.parent, nodeid)
    second = builder(tmp_path.parent, nodeid)
    representative_suffix = Path("spaces") / "spc_123456789012" / "notes" / (
        "n_" + "x" * 12 + "-title.md"
    )

    assert first == second
    assert len(first.name) <= 25
    assert len(str(Path(first.name) / representative_suffix)) <= 85


def test_test_directory_is_nested_under_single_run_root(tmp_path: Path):
    """Per-test directories must live below a run-scoped root outside tests/."""
    tests_dir = Path(suite_conftest.__file__).resolve().parent

    assert tests_dir not in tmp_path.resolve().parents
    assert tmp_path.parent.name.startswith("run-")
    assert tmp_path.parent.parent.exists()


def test_path_escape_guard_rejects_paths_outside_run_root(tmp_path: Path):
    """The deletion/path guard must continue rejecting traversal outside the run root."""
    run_root = tmp_path.parent
    escaped_path = run_root.parent / "outside-test-sandbox"

    with pytest.raises(RuntimeError, match="outside temp root"):
        suite_conftest._ensure_inside_temp_root(escaped_path, run_root)


def test_default_artifacts_root_is_dedicated_and_outside_repository(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("POMODOROXII_TEST_ARTIFACTS_ROOT", raising=False)

    resolved = suite_conftest._resolve_artifacts_root()

    assert resolved.name == "pomodoroxii-test-artifacts"
    assert resolved != suite_conftest._project_root
    assert suite_conftest._project_root not in resolved.parents


def test_default_artifacts_root_rejects_source_tree(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("POMODOROXII_TEST_ARTIFACTS_ROOT", raising=False)
    unsafe_default = suite_conftest._project_root / "pomodoroxii-test-artifacts"
    monkeypatch.setattr(suite_conftest, "_DEFAULT_ARTIFACTS_ROOT", unsafe_default)

    with pytest.raises(RuntimeError, match="inside project source"):
        suite_conftest._resolve_artifacts_root()


def test_existing_repository_artifacts_are_not_cleanup_targets() -> None:
    source = Path(suite_conftest.__file__).read_text(encoding="utf-8")
    assert "backend/.test-artifacts" not in source
    assert "pytest-of-" not in source


def test_configured_artifacts_root_is_normalized(monkeypatch: pytest.MonkeyPatch):
    configured = (
        suite_conftest._project_root.parent
        / "external-test-root"
        / ".."
        / "pomodoroxii-test-artifacts"
    )
    monkeypatch.setenv("POMODOROXII_TEST_ARTIFACTS_ROOT", str(configured))

    resolved = suite_conftest._resolve_artifacts_root()

    assert resolved == configured.resolve()


@pytest.mark.parametrize(
    "configured",
    [
        Path(suite_conftest.__file__).resolve().parents[2],
        Path(suite_conftest.__file__).resolve().parents[1],
        Path.home(),
        Path.home().anchor,
    ],
)
def test_configured_artifacts_root_rejects_broad_or_source_paths(configured: Path):
    with pytest.raises(RuntimeError, match="Refusing"):
        suite_conftest._resolve_artifacts_root(configured)


def test_configured_artifacts_root_requires_dedicated_name():
    configured = suite_conftest._project_root.parent / "artifacts"

    with pytest.raises(RuntimeError, match="dedicated directory"):
        suite_conftest._resolve_artifacts_root(configured)


def test_nodeid_builder_rejects_run_root_outside_artifacts_root():
    """A forged run root outside backend/.test-artifacts must be rejected."""
    builder = _path_builder()
    tests_dir = Path(suite_conftest.__file__).resolve().parent
    outside_run_root = tests_dir / "run-0000000000000000"

    with pytest.raises(RuntimeError, match="outside temp root"):
        builder(outside_run_root, "tests/test_escape.py::test_escape")


def test_nodeid_builder_rejects_artifacts_root_as_run_root():
    """Tests must never write directly into the shared artifacts root."""
    builder = _path_builder()

    with pytest.raises(RuntimeError, match="invalid test run root"):
        builder(suite_conftest._artifacts_root, "tests/test_escape.py::test_escape")


def test_nodeid_builder_rejects_malformed_run_root_name():
    """Only allocator-shaped run roots may host per-test sandboxes."""
    builder = _path_builder()
    malformed_run_root = suite_conftest._artifacts_root / "run-000000000000000g"

    with pytest.raises(RuntimeError, match="invalid test run root"):
        builder(malformed_run_root, "tests/test_escape.py::test_escape")


def test_nodeid_builder_rejects_nested_run_root():
    builder = _path_builder()
    nested_run_root = (
        suite_conftest._artifacts_root
        / "container"
        / "run-0000000000000000"
    )

    with pytest.raises(RuntimeError, match="invalid test run root"):
        builder(nested_run_root, "tests/test_escape.py::test_escape")


def test_run_root_allocator_creates_unique_roots_under_artifacts_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """Every allocation must create a distinct run root within the approved base."""
    allocator = _run_root_allocator()
    artifacts_root = tmp_path / "artifacts"
    monkeypatch.setattr(suite_conftest, "_artifacts_root", artifacts_root)

    first = allocator()
    second = allocator()

    assert first != second
    assert first.parent == artifacts_root.resolve()
    assert second.parent == artifacts_root.resolve()
    assert first.is_dir()
    assert second.is_dir()
    assert first.name.startswith("run-")
    assert second.name.startswith("run-")


def test_fixture_source_does_not_recursively_delete_test_directories():
    """Suite fixtures must not recursively delete run roots or per-test directories."""
    source_path = Path(suite_conftest.__file__).resolve()
    tree = ast.parse(source_path.read_text(encoding="utf-8"))
    recursive_delete_calls = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and (
            (isinstance(node.func, ast.Attribute) and node.func.attr == "rmtree")
            or (isinstance(node.func, ast.Name) and node.func.id == "rmtree")
        )
    ]

    assert recursive_delete_calls == []


def test_same_named_database_starts_absent_in_first_test(tmp_path: Path):
    """A same-named database created here must remain local to this test sandbox."""
    database = tmp_path / "shared-name.db"

    assert not database.exists()
    database.write_text("first-test", encoding="utf-8")
    assert database.read_text(encoding="utf-8") == "first-test"


def test_same_named_database_does_not_leak_into_second_test(tmp_path: Path):
    """A second test receives a fresh sandbox even when it uses the same filename."""
    database = tmp_path / "shared-name.db"

    assert not database.exists()
    database.write_text("second-test", encoding="utf-8")
    assert database.read_text(encoding="utf-8") == "second-test"


def test_real_file_system_test_package_is_preserved(tmp_path: Path):
    """Starting an isolated test must never remove the real tests/test_file_system package."""
    tests_dir = Path(suite_conftest.__file__).resolve().parent
    package_dir = tests_dir / "test_file_system"

    assert tmp_path.exists()
    assert package_dir.is_dir()
    assert (package_dir / "conftest.py").is_file()
    assert (package_dir / "test_note_ops.py").is_file()


@pytest.mark.asyncio
@pytest.mark.provisioned_space_storage
async def test_opt_in_storage_fixture_provisions_registered_space(client) -> None:
    token, space_id = await _registered_space_token(client)

    response = await client.post(
        "/api/v1/notes",
        json={"title": "Provisioned note", "content": "fixture probe"},
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 201, response.text
    from app.settings import settings

    parent = settings.spaces_data_dir / space_id
    assert (parent / "space.db").is_file()
    assert (parent / "index.db").is_file()
    assert (parent / "notes").is_dir()


@pytest.mark.asyncio
async def test_unmarked_client_keeps_registered_space_missing(client) -> None:
    token, space_id = await _missing_registered_space_token(client)

    response = await client.post(
        "/api/v1/notes",
        json={"title": "Missing store", "content": "fixture probe"},
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 503, response.text
    assert response.headers["X-PomodoroXII-Error-Code"] == "space_storage_missing"
    from app.settings import settings

    parent = settings.spaces_data_dir / space_id
    assert not (parent / "space.db").exists()
    assert not (parent / "index.db").exists()


@pytest.mark.asyncio
async def test_cancelled_storage_provisioning_joins_worker_before_cleanup(
    monkeypatch: pytest.MonkeyPatch,
    space_storage_provisioner,
) -> None:
    from app.db import migrations
    from app.settings import settings

    space_id = "spc_cancelled_provision"
    parent = settings.spaces_data_dir / space_id
    settings.space_notes_dir(space_id).mkdir(parents=True)
    database = settings.space_db_path(space_id)
    started = threading.Event()
    release = threading.Event()
    finished = threading.Event()

    def cancelled_migration(_scope: str, target: Path) -> None:
        target.write_bytes(b"partial")
        started.set()
        assert release.wait(timeout=5)
        target.write_bytes(b"late worker write")
        finished.set()

    monkeypatch.setattr(migrations, "run_migrations", cancelled_migration)
    operation = asyncio.create_task(space_storage_provisioner(space_id))
    assert await asyncio.to_thread(started.wait, 5)

    operation.cancel("cancel provisioning")
    await asyncio.sleep(0)
    release.set()
    with pytest.raises(asyncio.CancelledError, match="cancel provisioning"):
        await operation
    assert await asyncio.to_thread(finished.wait, 5)

    assert parent.is_dir()
    assert settings.space_notes_dir(space_id).is_dir()
    assert not database.exists()
    assert not (parent / "index.db").exists()
