"""Breaking cutover gate: legacy Task/Session surfaces must be fully removed.

This test proves that the old Task/Session backend authority, API routes,
sync keys, and wire literals have been purged from production code.

Audit evidence in migrations, docs, and tests may retain legacy names, but
production ``app/**/*.py`` must be free of forbidden route/wire literals.
"""
from __future__ import annotations

import ast
import importlib
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.registry import REGISTRY

ROOT = Path(__file__).resolve().parents[1] / "app"
FORBIDDEN_FILES = {
    ROOT / "models" / "task.py",
    ROOT / "models" / "session.py",
    ROOT / "models" / "task_quick_note.py",
    ROOT / "models" / "session_quick_note.py",
    ROOT / "schemas" / "task.py",
    ROOT / "schemas" / "session.py",
    ROOT / "services" / "task.py",
    ROOT / "services" / "session.py",
    ROOT / "routes" / "v1" / "tasks.py",
    ROOT / "routes" / "v1" / "sessions.py",
}
FORBIDDEN_PATHS = (
    "/api/v1/tasks",
    "/api/v1/sessions",
)
FORBIDDEN_WIRE_KEYS = (
    "taskQuickNote",
    "sessionQuickNote",
)
FORBIDDEN_REGISTRY_NAMES = (
    "task",
    "session",
    "task_quick_note",
    "session_quick_note",
)
# Exact removed modules and routes must not appear in production source.  The
# negative lookahead deliberately permits final modules such as
# ``session_revision`` and ``session_command``.
PRODUCTION_SCAN_PATTERN = re.compile(
    r"(?P<module>app\.models\.(?:task(?:_quick_note)?|session(?:_quick_note)?)"
    r"(?![A-Za-z0-9_])|app\.services\.(?:task|session)(?![A-Za-z0-9_]))"
    r"|(?P<route>/api/v1/(?:tasks|sessions)(?![A-Za-z0-9_-]))"
    r"|(?P<wire>taskQuickNote|sessionQuickNote)"
)
WIRE_AUDIT_EVIDENCE = {ROOT / "task_space" / "migration_preflight.py"}


# --------------------------------------------------------------------------- #
# 1. Forbidden files must not exist
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("path", sorted(FORBIDDEN_FILES))
def test_forbidden_file_does_not_exist(path: Path):
    """Legacy model/schema/service/route modules must be deleted."""
    assert not path.exists(), f"Forbidden file still exists: {path}"


def test_task_service_test_deleted():
    """Legacy test_task_service.py must be deleted."""
    test_file = Path(__file__).parent / "test_task_service.py"
    assert not test_file.exists(), "test_task_service.py must be deleted"


# --------------------------------------------------------------------------- #
# 2. Runtime OpenAPI must not contain legacy paths
# --------------------------------------------------------------------------- #


def test_openapi_has_no_legacy_paths():
    """Runtime OpenAPI spec must not contain /api/v1/tasks or /api/v1/sessions."""
    app = create_app()
    client = TestClient(app)
    spec = client.get("/openapi.json").json()
    paths = set(spec.get("paths", {}).keys())
    for forbidden in FORBIDDEN_PATHS:
        # Check exact path and any sub-paths under it.
        matching = [p for p in paths if p == forbidden or p.startswith(forbidden + "/")]
        assert not matching, (
            f"OpenAPI still contains legacy path(s): {matching}"
        )


# --------------------------------------------------------------------------- #
# 3. Registry must not contain legacy entity names or wire keys
# --------------------------------------------------------------------------- #


def test_registry_has_no_legacy_entity_names():
    """REGISTRY must not resolve task/session/task_quick_note/session_quick_note."""
    registered = {spec.name for spec in REGISTRY.list()}
    for name in FORBIDDEN_REGISTRY_NAMES:
        assert name not in registered, (
            f"Legacy entity '{name}' still in REGISTRY"
        )


def test_sync_alias_does_not_resolve_legacy_keys():
    """canonicalize_entity_type must return None for legacy wire keys."""
    from app.services.sync_entity_types import canonicalize_entity_type

    for key in FORBIDDEN_WIRE_KEYS:
        result = canonicalize_entity_type(key)
        assert result is None, (
            f"Legacy wire key '{key}' still resolves to '{result}'"
        )


def test_legacy_registry_names_raise_keyerror():
    """REGISTRY.get must raise KeyError for legacy entity names."""
    for name in FORBIDDEN_REGISTRY_NAMES:
        with pytest.raises(KeyError):
            REGISTRY.get(name)


# --------------------------------------------------------------------------- #
# 4. Production app/**/*.py must not contain forbidden literals
# --------------------------------------------------------------------------- #


# The recovery coordinator keeps a closed, immutable set of the four old
# catalog type names purely as negative rejection evidence.  The scanner must
# distinguish "this is a rejection of a legacy catalog" from "production code
# references the legacy name".  We therefore allow, via AST semantics only:
#   - the definition of FORBIDDEN_LEGACY_CATALOG_TYPES itself;
#   - expressions that reference it and are structurally rejection-shaped
#     (set intersection, set difference, membership, subset/disjoint calls,
#     or equality/ordering comparisons).
# Any other occurrence of a legacy name anywhere under app/ is a violation.
_NEGATIVE_NAMES = frozenset(
    {
        "FORBIDDEN_LEGACY_CATALOG_TYPES",
    }
)
_NEGATIVE_CALL_NAMES = frozenset(
    {
        "issubset",
        "isdisjoint",
        "intersection",
        "difference",
        "symmetric_difference",
    }
)


def _is_negative_expression(node: ast.AST) -> bool:
    """True when the node is a structural rejection of its subjects."""
    if isinstance(node, ast.BinOp):
        return isinstance(
            node.op,
            (
                ast.BitAnd,
                ast.BitOr,
                ast.Sub,
                ast.Lt,
                ast.LtE,
                ast.Gt,
                ast.GtE,
                ast.Eq,
                ast.NotEq,
            ),
        )
    if isinstance(node, ast.Compare):
        return all(isinstance(op, (ast.In, ast.NotIn, ast.Eq, ast.NotEq)) for op in node.ops)
    if isinstance(node, ast.Call):
        func = node.func
        name = func.id if isinstance(func, ast.Name) else (
            func.attr if isinstance(func, ast.Attribute) else ""
        )
        return name in _NEGATIVE_CALL_NAMES
    return False


def _negative_rejection_lines(source: str) -> set[int]:
    """Line numbers allowed as closed negative rejection evidence."""
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return set()
    allowed: set[int] = set()

    def span(node: ast.AST) -> set[int]:
        return set(range(node.lineno, (getattr(node, "end_lineno", None) or node.lineno) + 1))

    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id in _NEGATIVE_NAMES
            for target in node.targets
        ):
            allowed |= span(node)
    for node in ast.walk(tree):
        if not isinstance(node, (ast.BinOp, ast.Compare, ast.Call)):
            continue
        if not any(
            isinstance(child, ast.Name) and child.id in _NEGATIVE_NAMES
            for child in ast.walk(node)
        ):
            continue
        if _is_negative_expression(node):
            allowed |= span(node)
    return allowed


def _scan_for_legacy_references(app_dir: Path) -> list[str]:
    violations: list[str] = []
    for py_file in app_dir.rglob("*.py"):
        try:
            text = py_file.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        allowed_lines = _negative_rejection_lines(text)
        for line_no, line in enumerate(text.splitlines(), start=1):
            matches = [
                match
                for match in PRODUCTION_SCAN_PATTERN.finditer(line)
                if not (match.lastgroup == "wire" and py_file in WIRE_AUDIT_EVIDENCE)
            ]
            if not matches:
                continue
            if line_no in allowed_lines:
                continue
            rel = py_file.relative_to(app_dir.parent)
            violations.append(f"{rel}:{line_no}: {line.strip()}")
    return violations


def test_production_code_has_no_legacy_references():
    """Scan all app/**/*.py files for forbidden legacy patterns.

    Migrations, docs, and tests may retain legacy names as audit evidence,
    but production source under app/ must be free of:
      - app.models.task / app.models.session imports
      - app.services.task / app.services.session imports
      - /api/v1/tasks / /api/v1/sessions route literals
      - taskQuickNote / sessionQuickNote wire keys

    The only exception is closed negative rejection evidence: the
    ``FORBIDDEN_LEGACY_CATALOG_TYPES`` definition in the recovery coordinator
    and expressions that use it to reject/intersect/invalidate a catalog.
    """
    app_dir = Path(__file__).resolve().parents[1] / "app"
    violations = _scan_for_legacy_references(app_dir)
    if violations:
        pytest.fail(
            "Legacy Task/Session production reference remains:\n"
            + "\n".join(violations)
        )


def _scan_dir(tmp_path: Path, files: dict[str, str]) -> list[str]:
    """Write a throwaway app/ tree and return scanner violations."""
    app_dir = tmp_path / "app"
    for relative, content in files.items():
        target = app_dir / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    return _scan_for_legacy_references(app_dir)


def test_scan_rejects_legacy_import(tmp_path: Path) -> None:
    violations = _scan_dir(
        tmp_path,
        {
            "service.py": (
                "import app.models.task\n"
                "def f(): return 1\n"
            )
        },
    )
    assert any("service.py:1:" in item for item in violations)


def test_scan_rejects_legacy_route_literal(tmp_path: Path) -> None:
    violations = _scan_dir(
        tmp_path,
        {
            "router.py": (
                'ROUTE = "/api/v1/tasks"\n'
            )
        },
    )
    assert any("router.py:1:" in item for item in violations)


def test_scan_rejects_legacy_wire_key(tmp_path: Path) -> None:
    violations = _scan_dir(
        tmp_path,
        {
            "wire.py": (
                'payload = {"taskQuickNote": "x"}\n'
            )
        },
    )
    assert any("wire.py:1:" in item for item in violations)


def test_scan_rejects_legacy_plain_assignment(tmp_path: Path) -> None:
    violations = _scan_dir(
        tmp_path,
        {
            "names.py": (
                'value = "taskQuickNote"\n'
            )
        },
    )
    assert any("names.py:1:" in item for item in violations)


def test_scan_allows_closed_forbidden_catalog_rejection(tmp_path: Path) -> None:
    violations = _scan_dir(
        tmp_path,
        {
            "recovery/coordinator.py": (
                'FORBIDDEN_LEGACY_CATALOG_TYPES = frozenset(\n'
                '    {"task", "session", "taskQuickNote", "sessionQuickNote"}\n'
                ')\n'
                '\n'
                'def verify(types):\n'
                '    if FORBIDDEN_LEGACY_CATALOG_TYPES & set(types):\n'
                '        raise ValueError("legacy catalog")\n'
                '    return True\n'
            )
        },
    )
    assert violations == []


def test_scan_rejects_non_negative_use_in_allowlisted_module(
    tmp_path: Path,
) -> None:
    violations = _scan_dir(
        tmp_path,
        {
            "recovery/coordinator.py": (
                'FORBIDDEN_LEGACY_CATALOG_TYPES = frozenset(\n'
                '    {"task", "session", "taskQuickNote", "sessionQuickNote"}\n'
                ')\n'
                '\n'
                'def inspect():\n'
                '    return "taskQuickNote"\n'
            )
        },
    )
    assert any("coordinator.py:6:" in item for item in violations)


def test_scan_rejects_fifth_unlisted_legacy_string(tmp_path: Path) -> None:
    violations = _scan_dir(
        tmp_path,
        {
            "recovery/coordinator.py": (
                'FORBIDDEN_LEGACY_CATALOG_TYPES = frozenset(\n'
                '    {"task", "session", "taskQuickNote", "sessionQuickNote"}\n'
                ')\n'
                '\n'
                'LEGACY_EXTRA = {"sessionQuickNote"}\n'
            )
        },
    )
    assert any("coordinator.py:5:" in item for item in violations)


def test_legacy_models_not_importable():
    """Legacy model modules must not be importable."""
    for module_name in (
        "app.models.task",
        "app.models.session",
        "app.models.task_quick_note",
        "app.models.session_quick_note",
        "app.services.task",
        "app.services.session",
        "app.schemas.task",
        "app.schemas.session",
    ):
        with pytest.raises((ModuleNotFoundError, FileNotFoundError, ImportError)):
            importlib.import_module(module_name)
