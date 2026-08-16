"""Static ownership gates for the converged Sync v2 protocol."""

from __future__ import annotations

import ast
import importlib
import importlib.util
import shutil
import sys
from pathlib import Path

import pytest

from app.sync.operations import SYNC_OPERATIONS

BACKEND_ROOT = Path(__file__).resolve().parents[1]
BACKEND_APP = BACKEND_ROOT / "app"
REPO_ROOT = BACKEND_ROOT.parent


def _module_tree(module_name: str) -> ast.Module:
    module = importlib.import_module(module_name)
    path = Path(module.__file__).resolve()
    return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


def _dotted_name(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = _dotted_name(node.value)
        return f"{parent}.{node.attr}" if parent else node.attr
    return ""


def _imported_names(tree: ast.AST) -> set[str]:
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.asname or alias.name.rsplit(".", 1)[-1] for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            names.update(alias.asname or alias.name for alias in node.names)
    return names


def _imported_modules(tree: ast.AST) -> set[str]:
    modules: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            modules.add(node.module)
    return modules


def _literal_open_modes(tree: ast.AST) -> set[str]:
    modes: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not _dotted_name(node.func).endswith(".open"):
            continue
        if len(node.args) > 2 and isinstance(node.args[2], ast.Constant):
            if isinstance(node.args[2].value, str):
                modes.add(node.args[2].value)
        for keyword in node.keywords:
            if keyword.arg == "mode" and isinstance(keyword.value, ast.Constant):
                if isinstance(keyword.value.value, str):
                    modes.add(keyword.value.value)
    return modes


def _called_names(tree: ast.AST) -> set[str]:
    return {
        node.func.attr if isinstance(node.func, ast.Attribute) else node.func.id
        for node in ast.walk(tree)
        if isinstance(node, ast.Call) and isinstance(node.func, (ast.Attribute, ast.Name))
    }


def _load_authority_gate():
    path = REPO_ROOT / "backend" / "scripts" / "check_backend_authority.py"
    spec = importlib.util.spec_from_file_location("task8_backend_authority", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_sync_adapters_do_not_own_storage_or_commit() -> None:
    forbidden = {
        "app.routes.v1.sync": {"AsyncSession", "record_sync_event", "SpaceEngineManager"},
        "app.mcp.sync_tools": {"AsyncSession", "SyncService", "SpaceEngineManager"},
    }
    for module_name, names in forbidden.items():
        tree = _module_tree(module_name)
        assert not (names & (_imported_names(tree) | _called_names(tree)))
        assert "commit" not in _called_names(tree)


def test_only_protocol_decodes_opaque_cursor_tokens() -> None:
    offenders: set[Path] = set()
    for source in BACKEND_APP.rglob("*.py"):
        tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
                continue
            if node.func.attr == "decode" and _dotted_name(node.func.value).endswith("cursor"):
                offenders.add(source.relative_to(BACKEND_APP))
    assert offenders == {Path("sync/protocol.py")}


def test_protocol_is_transport_neutral_and_runtime_modes_are_public() -> None:
    protocol = _module_tree("app.sync.protocol")
    imported = _imported_modules(protocol) | _imported_names(protocol)
    assert not ({"fastapi", "FastAPI", "FastMCP", "fastmcp"} & imported)
    assert {spec.runtime_mode for spec in SYNC_OPERATIONS} <= {"read", "write"}

    for module_name in ("app.routes.v1.sync", "app.mcp.sync_tools"):
        tree = _module_tree(module_name)
        assert "mutation" not in _literal_open_modes(tree)


def test_runtime_mode_guard_rejects_positional_and_keyword_mutation() -> None:
    positional = ast.parse('scope.open(principal, "space-a", "mutation")')
    keyword = ast.parse('scope.open(principal, "space-a", mode="mutation")')
    assert _literal_open_modes(positional) == {"mutation"}
    assert _literal_open_modes(keyword) == {"mutation"}


def test_transport_import_guard_rejects_aliased_framework_imports() -> None:
    tree = ast.parse("import fastapi as web\nfrom fastmcp import FastMCP as ToolServer\n")
    assert _imported_modules(tree) == {"fastapi", "fastmcp"}


def test_operation_catalog_is_the_exact_rest_and_mcp_surface() -> None:
    expected = {
        "query_operations", "push", "pull", "recover", "ack", "status",
    }
    assert {spec.name for spec in SYNC_OPERATIONS} == expected
    assert len({spec.rest_path for spec in SYNC_OPERATIONS}) == 6
    assert len({spec.mcp_tool for spec in SYNC_OPERATIONS}) == 6

    route_tree = _module_tree("app.routes.v1.sync")
    declared_paths = {
        argument.value
        for node in ast.walk(route_tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr in {"get", "post"}
        for argument in node.args[:1]
        if isinstance(argument, ast.Constant)
        and isinstance(argument.value, str)
        and argument.value.startswith("/v2/")
    }
    assert {f"/api/v1/sync{path}" for path in declared_paths} == {
        spec.rest_path for spec in SYNC_OPERATIONS
    }


def test_backend_authority_gate_covers_sync_route_and_all_outbox_reads(tmp_path: Path) -> None:
    gate = _load_authority_gate()
    app_files, route_files, reads = gate.run_gate(
        BACKEND_APP, (Path("routes/v1/sync.py"),)
    )
    assert app_files > 0
    expected_routes = len(gate.S3_ROUTE_FILES) + 1
    assert route_files == expected_routes == 9
    assert reads > 0

    copied_app = tmp_path / "app"
    shutil.copytree(BACKEND_APP, copied_app)
    (copied_app / "sync" / "unsafe_task8_reader.py").write_text(
        "from sqlalchemy import select\n"
        "from app.models.sync_outbox import SyncOutbox\n"
        "\n"
        "def unsafe(session):\n"
        "    return session.execute(select(SyncOutbox))\n",
        encoding="utf-8",
    )
    with pytest.raises(SystemExit, match="visible predicate"):
        gate.run_gate(copied_app, (Path("routes/v1/sync.py"),))
