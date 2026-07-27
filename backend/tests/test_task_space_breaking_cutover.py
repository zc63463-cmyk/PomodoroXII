"""Breaking cutover gate: legacy Task/Session surfaces must be fully removed.

This test proves that the old Task/Session backend authority, API routes,
sync keys, and wire literals have been purged from production code.

Audit evidence in migrations, docs, and tests may retain legacy names, but
production ``app/**/*.py`` must be free of forbidden route/wire literals.
"""
from __future__ import annotations

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


def test_production_code_has_no_legacy_references():
    """Scan all app/**/*.py files for forbidden legacy patterns.

    Migrations, docs, and tests may retain legacy names as audit evidence,
    but production source under app/ must be free of:
      - app.models.task / app.models.session imports
      - app.services.task / app.services.session imports
      - /api/v1/tasks / /api/v1/sessions route literals
      - taskQuickNote / sessionQuickNote wire keys
    """
    app_dir = Path(__file__).resolve().parents[1] / "app"
    violations: list[str] = []
    for py_file in app_dir.rglob("*.py"):
        try:
            text = py_file.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for line_no, line in enumerate(text.splitlines(), start=1):
            matches = [
                match
                for match in PRODUCTION_SCAN_PATTERN.finditer(line)
                if not (match.lastgroup == "wire" and py_file in WIRE_AUDIT_EVIDENCE)
            ]
            if matches:
                rel = py_file.relative_to(app_dir.parent)
                violations.append(f"{rel}:{line_no}: {line.strip()}")
    if violations:
        pytest.fail(
            "Legacy Task/Session production reference remains:\n"
            + "\n".join(violations)
        )


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
