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
import tokenize
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
# references the legacy name".  Only the four string nodes in the exact,
# closed constant definition are exempt.  References to the constant do not
# contain forbidden literals and need no broader expression-level exemption.
# Any other occurrence of a legacy name anywhere under app/ is a violation.
_NEGATIVE_DEFINITION_PATH = Path("recovery/coordinator.py")
_NEGATIVE_DEFINITION_NAME = "FORBIDDEN_LEGACY_CATALOG_TYPES"
_NEGATIVE_DEFINITION_VALUES = frozenset(
    {"task", "session", "taskQuickNote", "sessionQuickNote"}
)


def _negative_definition_spans(source: str) -> set[tuple[int, int, int]]:
    """Return exact source spans for the closed constant's string nodes."""
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return set()
    definitions = [
        node
        for node in tree.body
        if isinstance(node, ast.Assign)
        and len(node.targets) == 1
        and isinstance(node.targets[0], ast.Name)
        and node.targets[0].id == _NEGATIVE_DEFINITION_NAME
    ]
    if len(definitions) != 1:
        return set()
    value = definitions[0].value
    if not (
        isinstance(value, ast.Call)
        and isinstance(value.func, ast.Name)
        and value.func.id == "frozenset"
        and len(value.args) == 1
        and not value.keywords
        and isinstance(value.args[0], ast.Set)
    ):
        return set()
    elements = value.args[0].elts
    if len(elements) != len(_NEGATIVE_DEFINITION_VALUES) or {
        element.value
        for element in elements
        if isinstance(element, ast.Constant) and isinstance(element.value, str)
    } != _NEGATIVE_DEFINITION_VALUES:
        return set()
    return {
        (element.lineno, element.col_offset, element.end_col_offset)
        for element in elements
        if isinstance(element, ast.Constant) and element.end_col_offset is not None
    }


def _scan_for_legacy_references(app_dir: Path) -> list[str]:
    violations: list[str] = []
    for py_file in app_dir.rglob("*.py"):
        try:
            with tokenize.open(py_file) as source:
                text = source.read()
        except (OSError, SyntaxError, UnicodeDecodeError):
            rel = py_file.relative_to(app_dir.parent)
            violations.append(f"{rel}: source is unreadable or undecodable")
            continue
        try:
            relative = py_file.relative_to(app_dir).as_posix()
        except ValueError:
            relative = ""
        allowed_spans = (
            _negative_definition_spans(text)
            if relative == _NEGATIVE_DEFINITION_PATH.as_posix()
            else set()
        )
        for line_no, line in enumerate(text.splitlines(), start=1):
            matches = [
                match
                for match in PRODUCTION_SCAN_PATTERN.finditer(line)
                if not (match.lastgroup == "wire" and py_file in WIRE_AUDIT_EVIDENCE)
            ]
            if not matches:
                continue
            matches = [
                match
                for match in matches
                if not any(
                    line_no == allowed_line
                    and allowed_start <= match.start()
                    and match.end() <= allowed_end
                    for allowed_line, allowed_start, allowed_end in allowed_spans
                )
            ]
            if not matches:
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
    four-value ``FORBIDDEN_LEGACY_CATALOG_TYPES`` definition in the recovery
    coordinator.  Its consumers reference the constant without repeating the
    forbidden literals.
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


@pytest.mark.parametrize(
    "positive_use",
    (
        'EXPORTED = FORBIDDEN_LEGACY_CATALOG_TYPES | {"taskQuickNote"}\n',
        'ENABLED = FORBIDDEN_LEGACY_CATALOG_TYPES == {"taskQuickNote"}\n',
        'EXPORTED = FORBIDDEN_LEGACY_CATALOG_TYPES.intersection({"taskQuickNote"})\n',
        'if FORBIDDEN_LEGACY_CATALOG_TYPES & {"taskQuickNote"}:\n'
        '    publish()\n',
    ),
)
def test_scan_rejects_positive_use_of_forbidden_catalog_set(
    tmp_path: Path,
    positive_use: str,
) -> None:
    violations = _scan_dir(
        tmp_path,
        {
            "recovery/coordinator.py": (
                'FORBIDDEN_LEGACY_CATALOG_TYPES = frozenset(\n'
                '    {"task", "session", "taskQuickNote", "sessionQuickNote"}\n'
                ')\n'
                + positive_use
            )
        },
    )
    assert violations


def test_scan_rejects_extra_literal_on_forbidden_set_definition_line(
    tmp_path: Path,
) -> None:
    violations = _scan_dir(
        tmp_path,
        {
            "recovery/coordinator.py": (
                'FORBIDDEN_LEGACY_CATALOG_TYPES = frozenset({"task", "session", '
                '"taskQuickNote", "sessionQuickNote"}); ROUTE = "/api/v1/tasks"\n'
            )
        },
    )
    assert any("coordinator.py:1:" in item for item in violations)


def test_scan_rejects_forbidden_set_definition_outside_recovery_coordinator(
    tmp_path: Path,
) -> None:
    violations = _scan_dir(
        tmp_path,
        {
            "export.py": (
                'FORBIDDEN_LEGACY_CATALOG_TYPES = frozenset(\n'
                '    {"task", "session", "taskQuickNote", "sessionQuickNote"}\n'
                ')\n'
            )
        },
    )
    assert violations


def test_scan_reads_pep263_encoded_source_instead_of_skipping_it(
    tmp_path: Path,
) -> None:
    app_dir = tmp_path / "app"
    app_dir.mkdir()
    source = app_dir / "latin1.py"
    source.write_bytes(
        '# coding: latin-1\nROUTE = "/api/v1/tasks"  # caf\xe9\n'.encode("latin-1")
    )

    violations = _scan_for_legacy_references(app_dir)

    assert any("latin1.py:2:" in item for item in violations)


def test_scan_reports_unreadable_source_as_a_violation(
    tmp_path: Path,
    monkeypatch,
) -> None:
    app_dir = tmp_path / "app"
    app_dir.mkdir()
    source = app_dir / "unreadable.py"
    source.write_text("value = 1\n", encoding="utf-8")
    original_open = tokenize.open

    def fail_for_source(path):
        if Path(path) == source:
            raise OSError("denied")
        return original_open(path)

    monkeypatch.setattr(tokenize, "open", fail_for_source)

    assert _scan_for_legacy_references(app_dir) == [
        "app\\unreadable.py: source is unreadable or undecodable"
    ]


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
