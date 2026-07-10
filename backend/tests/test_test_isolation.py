"""Regression tests for pytest filesystem isolation and deletion safety."""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

from tests import conftest as suite_conftest


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


def test_nodeid_hash_directory_keeps_windows_path_budget(tmp_path: Path):
    """The hashed sandbox component must stay short enough for nested Windows paths."""
    builder = _path_builder()
    path = builder(tmp_path.parent, "tests/" + "very-long-nodeid-" * 30)

    assert len(path.name) <= 41


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


def test_nodeid_builder_rejects_run_root_outside_artifacts_root():
    """A forged run root outside backend/.test-artifacts must be rejected."""
    builder = _path_builder()
    tests_dir = Path(suite_conftest.__file__).resolve().parent
    outside_run_root = tests_dir / "run-00000000000000000000000000000000"

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
    malformed_run_root = suite_conftest._artifacts_root / "not-a-run-root"

    with pytest.raises(RuntimeError, match="invalid test run root"):
        builder(malformed_run_root, "tests/test_escape.py::test_escape")


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
